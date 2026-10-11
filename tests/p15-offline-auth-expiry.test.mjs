/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p15-offline-auth-expiry.test.mjs)
 *
 * 결함: 재연결 자동 업로드(SyncQueue.flush / App._flushDirtyDrafts)가 401/403(토큰 만료)
 * 로 실패해도 다른 일시 오류(500/timeout)와 똑같이 "조용히" 재시도만 했다. 화면엔 "동기화 중"
 * 배지만 보여, 사용자는 다 올라간 줄 알고 앱을 닫을 수 있었다(조용한 실패 = 최악, 전역 CLAUDE.md §10).
 *
 * 근본원인: 두 flush 경로 모두 `if (!res.ok) continue/break;` 로 실패 종류를 구분하지 않음.
 *
 * 수정(공유 지점 — 로직 복붙 금지, §G-2-5):
 *  - Auth.authExpired() (22_Auth.js) 신설 — 세션당 1회만 토스트 + 기존 로그인 게이트(_openGate) 재사용.
 *  - Auth.refresh() 성공 시(재로그인 완료) _expired/_authExpiredNotified 리셋 + SyncQueue._onReconnect() 재개.
 *  - App._flushDirtyDrafts(20_App.js) 와 SyncQueue.flush(05_SyncQueue.js) 는 401/403 일 때만 Auth.authExpired() 호출.
 *  - 32_Offline.js updateNetBadge() — Auth._expired 이면 "인증 필요" 배지(온라인/오프라인보다 우선 판정).
 *
 * 검증 항목:
 *  ① 401 응답 시 큐(SyncQueue)/드래프트(App dirty)가 보존된다(제거/클린 마킹 안 됨)
 *  ② 사용자 안내(토스트+게이트)가 세션당 1회만 뜬다(재시도 3회에도 1회)
 *  ③ 재로그인 성공(Auth.refresh 재인증) 후 SyncQueue._onReconnect() 로 자동 이어서 업로드
 *  ④ 일반 네트워크 오류(500/예외)는 종전대로 조용히 재시도(Auth.authExpired 호출 없음)
 *  ⑤ 배지가 "인증 필요" 상태를 표시(온라인 중이어도 최우선 판정)
 *
 * 실제 모듈 소스(22_Auth.js, 05_SyncQueue.js, 20_App.js, 32_Offline.js)를 문자열 브레이스-밸런싱으로
 * 발췌해 vm 에 그대로 평가한다(목 구현 아님 — 소스 그대로). 뮤테이션 3건으로 테스트 실효성을 증명한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const authSrc = rd("public/js/modules/22_Auth.js");
const syncSrc = rd("public/js/modules/05_SyncQueue.js");
const appSrc = rd("public/js/modules/20_App.js");
const offlineSrc = rd("public/js/modules/32_Offline.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 브레이스-밸런싱 발췌: needle 부터 매칭되는 닫는 중괄호까지 원문 그대로 잘라낸다 ── */
function extractBalanced(src, needle) {
  const start = src.indexOf(needle);
  if (start < 0) throw new Error("needle not found: " + needle);
  const braceStart = src.indexOf("{", start);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

/* ── 최소 DOM 목(mock) — p10/p12/p13 과 동일 패턴 ── */
function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => x && set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    // [WO 20261006-photolink] updateNetBadge 가 classList.toggle/setAttribute 를 쓴다 —
    //   실 DOM 에는 항상 있는 API 라 제품 코드를 방어적으로 감싸지 않고 목을 보강한다
    //   (c67ce74 "p50 가짜 DOM 에 insertBefore/firstChild 보강" 과 같은 처리).
    toggle: (c, on) => { if (on === undefined ? !set.has(c) : !!on) set.add(c); else set.delete(c); },
    contains: (c) => set.has(c),
    _set: set
  };
}
function makeEl() {
  const el = { _text: "", _attrs: {} };
  Object.defineProperty(el, "textContent", { get() { return this._text; }, set(v) { this._text = v == null ? "" : String(v); } });
  el.classList = makeClassList();
  el.setAttribute = (k, v) => { el._attrs[k] = String(v); };
  el.getAttribute = (k) => (k in el._attrs ? el._attrs[k] : null);
  el.removeAttribute = (k) => { delete el._attrs[k]; };
  return el;
}
function makeDoc(ids) {
  const registry = {};
  ids.forEach((id) => { registry[id] = makeEl(); });
  return { getElementById: (id) => registry[id] || null, registry };
}

/* ══════════════════════════════════════════════════════════════════
 * ①②④ SyncQueue.flush() — 401/403 vs 일반 오류(500/예외) 구분
 * ══════════════════════════════════════════════════════════════════ */
/** [WO 20260930-403] Auth.classifyWriteFailure 실 소스(22_Auth.js) 그대로 발췌 — 판정 로직을
 *  테스트가 다시 구현하지 않는다(§G-2-5, 로직 복붙 금지는 테스트에도 적용). */
function classifyBlock() { return extractBalanced(authSrc, "async classifyWriteFailure(res) {"); }

function makeSyncQueueSandbox() {
  const fullSrc = syncSrc;
  const sqSrc = fullSrc.slice(0, fullSrc.indexOf("\n  };") + 5);
  const toasts = [];
  const gates = [];
  const authExpiredCalls = [];
  const writeDeniedCalls = [];
  const AuthSrc = "({ headers() { return {}; }, authExpired() { __authExpiredCalls.push(1); }, " +
    "writeDenied(kind) { __writeDeniedCalls.push(kind); }, " + classifyBlock() + " })";
  const Prompt = { toast: (m) => toasts.push(m) };
  const storage = {};
  const localStorage = {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; }
  };
  const navigator = { onLine: true };
  let fetchImpl = async () => ({ ok: true, json: async () => ({ results: [] }) });
  const fetchMock = (...args) => fetchImpl(...args);
  const sandbox = {
    console, Prompt, localStorage, navigator, window: {},
    fetch: fetchMock, indexedDB: undefined, JSON, Object, Array, Set, Promise, Date, Math,
    __authExpiredCalls: authExpiredCalls, __writeDeniedCalls: writeDeniedCalls
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext("const Auth = " + AuthSrc + ";\n" + sqSrc + "\n;globalThis.__SQ = SyncQueue;", sandbox);
  return {
    SQ: sandbox.__SQ,
    toasts, authExpiredCalls, writeDeniedCalls,
    setFetch: (fn) => { fetchImpl = fn; }
  };
}

console.log("\n[①④ SyncQueue.flush — 401 시 큐 보존 + Auth.authExpired 호출 / 500 시 종전대로 조용히]");
{
  // 401 케이스
  const { SQ, authExpiredCalls, setFetch } = makeSyncQueueSandbox();
  await SQ.enqueue({ kind: "image", name: "a.jpg", image_data: "d1" });
  setFetch(async () => ({ ok: false, status: 401 }));
  const r = await SQ.flush();
  ok(authExpiredCalls.length === 1, "① 401 → Auth.authExpired() 1회 호출: " + authExpiredCalls.length);
  ok((await SQ.all()).length === 1, "① 401 → 큐 op 보존(제거 안 됨), 실제 " + (await SQ.all()).length + "건");
  ok(r.failed === 1, "① flush 결과 failed=1 (성공으로 위장 안 함)");
}
{
  // 500 케이스 — 종전대로 조용히(안내 없음)
  const { SQ, authExpiredCalls, setFetch } = makeSyncQueueSandbox();
  await SQ.enqueue({ kind: "image", name: "b.jpg", image_data: "d2" });
  setFetch(async () => ({ ok: false, status: 500 }));
  await SQ.flush();
  ok(authExpiredCalls.length === 0, "④ 500 → Auth.authExpired() 호출 없음(조용히 재시도)");
  ok((await SQ.all()).length === 1, "④ 500 → 큐 op 보존(기존 동작 불변)");
}
{
  // 네트워크 예외(timeout 등) — 종전대로 조용히
  const { SQ, authExpiredCalls, setFetch } = makeSyncQueueSandbox();
  await SQ.enqueue({ kind: "image", name: "c.jpg", image_data: "d3" });
  setFetch(async () => { throw new Error("timeout"); });
  await SQ.flush();
  ok(authExpiredCalls.length === 0, "④ 네트워크 예외 → Auth.authExpired() 호출 없음");
  ok((await SQ.all()).length === 1, "④ 네트워크 예외 → 큐 op 보존");
}
{
  // [WO 20260930-403] /api/sync/batch 의 403(requireDesigner 발 — 'designer login required')은
  //   classifyWriteFailure 가 '만료'로 판정한다(그 엔드포인트엔 프로젝트 스코프 403이 없다) — 회귀 없음 증명.
  const { SQ, authExpiredCalls, writeDeniedCalls, setFetch } = makeSyncQueueSandbox();
  await SQ.enqueue({ kind: "image", name: "d.jpg", image_data: "d4" });
  setFetch(async () => ({ ok: false, status: 403, clone() { return this; }, json: async () => ({ error: "forbidden — designer login required" }) }));
  await SQ.flush();
  ok(authExpiredCalls.length === 1, "SyncQueue 403('designer login required') → Auth.authExpired() 1회(회귀 없음): " + authExpiredCalls.length);
  ok(writeDeniedCalls.length === 0, "SyncQueue 403('designer login required') → Auth.writeDenied() 호출 안 함: " + writeDeniedCalls.length);
}

/* ══════════════════════════════════════════════════════════════════
 * ②  Auth.authExpired() — 세션당 1회만 안내(재시도 3회에도 1회)
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[② Auth.authExpired — 세션당 1회만 토스트+게이트]");
function makeAuthExpiredSandbox(src) {
  const block = extractBalanced(src, "authExpired() {");
  const objSrc = "const __authTest = { _expired: false, _authExpiredNotified: false, " +
    "_openGate() { __gateCalls++; }, " + block + " };\n" +
    "globalThis.__authTest = __authTest;";
  const toasts = [];
  let gateCalls = 0;
  const Prompt = { toast: (m) => toasts.push(m) };
  const sandbox = { console, Prompt, __gateCalls: 0 };
  vm.createContext(sandbox);
  vm.runInContext("var __gateCalls = 0;\n" + objSrc, sandbox);
  return { authTest: sandbox.__authTest, toasts, getGateCalls: () => sandbox.__gateCalls };
}
{
  const { authTest, toasts, getGateCalls } = makeAuthExpiredSandbox(authSrc);
  authTest.authExpired();
  authTest.authExpired();
  authTest.authExpired();
  ok(toasts.length === 1, "② authExpired() 3회 호출 → 토스트 1회만: " + JSON.stringify(toasts));
  ok(getGateCalls() === 1, "② authExpired() 3회 호출 → 로그인 게이트 오픈 1회만: " + getGateCalls());
  ok(authTest._expired === true, "② _expired 플래그는 매번 true 유지(배지 판정용)");
}

/* ══════════════════════════════════════════════════════════════════
 * ③ Auth.refresh() 재인증 성공 → 만료 리셋 + SyncQueue._onReconnect() 재개
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[③ Auth.refresh 재인증 성공 → 자동 재개]");
function makeAuthRefreshSandbox(src, authResp) {
  const block = extractBalanced(src, "async refresh() {");
  const objSrc =
    "const __authTest = {\n" +
    "  _expired: true, _authExpiredNotified: true, _offline: false,\n" +
    "  headers() { return {}; },\n" +
    "  _applyUi() {},\n" +
    "  _saveAuthCache() {},\n" +
    "  _clearAuthCache() {},\n" +
    "  _loadAuthCache() { return null; },\n" +
    "  _hasLocalToken() { return false; },\n" +
    "  idToken: 'tok',\n" +
    "  " + block + "\n" +
    "};\nglobalThis.__authTest = __authTest;";
  const reconnectCalls = [];
  const SyncQueue = { _onReconnect() { reconnectCalls.push(1); } };
  const sandbox = {
    console, SyncQueue, window: {},
    fetch: async () => ({ json: async () => authResp })
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(objSrc, sandbox);
  return { authTest: sandbox.__authTest, reconnectCalls };
}
{
  const { authTest, reconnectCalls } = makeAuthRefreshSandbox(authSrc, { authenticated: true, email: "a@b.com", role: "designer" });
  await authTest.refresh();
  ok(authTest._expired === false, "③ 재인증 성공 → _expired 리셋");
  ok(authTest._authExpiredNotified === false, "③ 재인증 성공 → _authExpiredNotified 리셋(다음 만료 때 다시 안내 가능)");
  ok(reconnectCalls.length === 1, "③ 재인증 성공 → SyncQueue._onReconnect() 1회 호출(자동 재개)");
}

/* ══════════════════════════════════════════════════════════════════
 * ① App._flushDirtyDrafts — 401 시 draft 보존(clean 마킹 안 됨) + Auth.authExpired 호출
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[① App._flushDirtyDrafts — 401 시 draft 보존]");
function makeFlushDraftsSandbox(patchRes) {
  const block = extractBalanced(appSrc, "async _flushDirtyDrafts() {");
  // [WO 20260928-pinloss] _flushDirtyDrafts 가 충돌 규칙 단일 출처(_draftVsServer)를 호출하게 됐다 —
  //   하네스에도 **실 소스**를 그대로 싣는다(스텁 아님). 이 블록의 assertion 은 한 줄도 바꾸지 않았다.
  // [WO 20261010-offmatrix] _draftVsServer 가 주석 병합(srvAnnos → _mergeAnnos)을 받게 됐다 — 시그니처 needle 만 갱신 · 실 소스 그대로 · assertion 무변경.
  const ruleBlock = extractBalanced(appSrc, "_draftVsServer(d, srvPins, srvZones, srvVer, srvAnnos) {");
  // [WO 20260929-lossless] _flushDirtyDrafts 가 원본 PDF(_draftSource)·R2 페이지 업로드(_uploadPagesToR2)를
  //   거치게 됐다 — 같은 원칙으로 **실 소스**를 싣는다(스텁 아님). assertion 은 한 줄도 바꾸지 않았다.
  // [WO 20260929-bulkdel] _draftVsServer 가 핀 병합 단일 출처(_mergePins)를, flush 가 _pinIds 를 쓰게 됐다 —
  //   같은 원칙으로 **실 소스**를 싣는다(스텁 아님). assertion 은 한 줄도 바꾸지 않았다.
  const srcBlocks = ["async _draftSource(d) {", "_isPdfBytes(ab) {", "async _uploadSourcePdf(ab) {", "_sourceMetaJson(url, pages) {", "async _uploadPagesToR2(pagesData) {",
    // [WP1·H8] _mergePins/_draftVsServer 가 tombstone 필터 SoT(_live)를 쓰게 됐다 — 같은 원칙으로 실 소스. assertion 무변경.
    "_pinIds(arr) {", "_live(arr) {", "_mergePins(srvPins, localPins, baseIds, tombIds) {",
    // [WO 20260930-numdup] _mergePins 가 동시 생성 번호 재채번(_renumberConcurrent)을 부르게 됐다 — 같은 원칙으로 실 소스. assertion 무변경.
    "_renumberConcurrent(pins, baseIds, srvPins) {",
    // [WO 20260930-lww] _mergePins 가 병합 결과를 수정 감지 기준으로 기록(_pinsSeen)하게 됐다 — 같은 원칙으로 실 소스. assertion 무변경.
    "_pinsSeen(arr) {",
    // [WO 20261010-offmatrix] _draftVsServer 가 주석 병합 SoT(_mergeAnnos)를 부른다 — 같은 원칙으로 실 소스. assertion 무변경.
    "_mergeAnnos(srvAnnos, localAnnos, tombIds) {"]
    .map((h) => "  " + extractBalanced(appSrc, h) + ",\n").join("");
  const objSrc = "const __appTest = {\n" +
    "  _deckIdOfKey() { return 'deck1'; },\n" +
    // [WO 20260930-WP3 B5] _flushDirtyDrafts 가 this._projectIdOfKey(key) 를 부른다(68897c5) —
    // 이 하네스에도 스텁을 실어야 한다(없으면 TypeError 가 바깥 catch 에 조용히 먹혀 fetch 자체가
    // 한 번도 안 나가는 채 테스트가 항상 "실패"로 보였다 — 발견/수정, §G-2-5 조용한 실패 금지).
    "  _projectIdOfKey() { return null; },\n" +
    "  _mergeById(a, b) { return (a || []).concat(b || []); },\n" +
    "  " + ruleBlock + ",\n" +
    srcBlocks +
    "  _markDeckUnsaved() {},\n" +
    "  _draftKey() { return 'noproj::nodeck'; },\n" +
    "  _setSaveIndicator() {},\n" +
    "  _linkDeckDeployment: async () => null,\n" +
    "  " + block + "\n" +
    "};\nglobalThis.__appTest = __appTest;";
  const authExpiredCalls = [];
  const writeDeniedCalls = [];
  const savedDrafts = [];
  const draft = { dirty: true, pages: ["p1"], depId: "dep1", pins: [], zones: [], annotations: [], fileName: "도면" };
  const SyncQueue = {
    allDraftKeys: async () => ["noproj::nodeck"],
    loadDraft: async () => draft,
    saveDraft: async (k, d) => { savedDrafts.push({ k, d: Object.assign({}, d) }); }
  };
  const AuthSrc = "({ headers() { return {}; }, authExpired() { __authExpiredCalls.push(1); }, " +
    "writeDenied(kind) { __writeDeniedCalls.push(kind); }, " + classifyBlock() + " })";
  let call = 0;
  const fetchMock = async (url, opts) => {
    call++;
    if (opts && opts.method === "PATCH") return patchRes;
    return { ok: true, json: async () => ({ version: 1, pins: "[]", zones: "[]" }) }; // baseVer GET
  };
  const sandbox = {
    console, SyncQueue, navigator: { onLine: true }, fetch: fetchMock, window: {}, JSON, Object,
    __authExpiredCalls: authExpiredCalls, __writeDeniedCalls: writeDeniedCalls
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext("const Auth = " + AuthSrc + ";\n" + objSrc, sandbox);
  return { appTest: sandbox.__appTest, authExpiredCalls, writeDeniedCalls, savedDrafts, draft, callCount: () => call };
}
{
  const { appTest, authExpiredCalls, savedDrafts, draft } = makeFlushDraftsSandbox({ ok: false, status: 401 });
  await appTest._flushDirtyDrafts();
  ok(authExpiredCalls.length === 1, "① PATCH 401 → Auth.authExpired() 1회 호출");
  ok(savedDrafts.length === 0, "① PATCH 401 → draft 를 clean(dirty:false)으로 저장하지 않음(그대로 보존)");
  ok(draft.dirty === true, "① 원본 draft.dirty 플래그도 그대로(참조 오염 없음)");
}
{
  // 정상 케이스(회귀 없음) — 200 응답이면 draft 가 clean 저장된다
  const { appTest, savedDrafts } = makeFlushDraftsSandbox({ ok: true, status: 200, json: async () => ({ id: "dep1", version: 2 }) });
  await appTest._flushDirtyDrafts();
  ok(savedDrafts.length === 1 && savedDrafts[0].d.dirty === false, "① 정상(200) 흐름은 여전히 draft clean 저장(회귀 없음)");
}

/* ══════════════════════════════════════════════════════════════════
 * ⑥ App._flushDirtyDrafts — 403(프로젝트 권한없음)은 만료가 아니라 '권한없음'으로 분류된다
 *    (WP3 B5 deploymentWriteDenied 재현 — 68897c5 opus 팀 보고: 정상 권한거부가 재로그인 창을 띄웠다)
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[⑥ App._flushDirtyDrafts — 403(프로젝트 비멤버) → authExpired 아님, writeDenied + draft 보존 + 재시도 중단]");
{
  const denyRes = {
    ok: false, status: 403,
    json: async () => ({ error: "forbidden — not a designer of this project" }),
    clone() { return this; }
  };
  const { appTest, authExpiredCalls, writeDeniedCalls, savedDrafts, draft, callCount } = makeFlushDraftsSandbox(denyRes);
  await appTest._flushDirtyDrafts();
  ok(authExpiredCalls.length === 0, "⑥ 403(프로젝트 권한없음) → Auth.authExpired() 호출 안 함(오인 재로그인 방지): " + authExpiredCalls.length);
  ok(writeDeniedCalls.length === 1 && writeDeniedCalls[0] === "denied", "⑥ Auth.writeDenied('denied') 1회 호출: " + JSON.stringify(writeDeniedCalls));
  ok(savedDrafts.length === 1 && savedDrafts[0].d.writeDenied === true, "⑥ draft 가 writeDenied:true 로 저장됨(삭제 안 됨, 보존): " + JSON.stringify(savedDrafts[0] && savedDrafts[0].d.writeDenied));
  ok(draft.dirty === true, "⑥ draft.dirty 는 그대로(데이터 보존, 삭제/클린 마킹 안 됨)");
  const before = callCount();
  await appTest._flushDirtyDrafts();               // 재호출 — writeDenied 표시된 draft 는 재시도하지 않아야 함
  ok(callCount() === before, "⑥ writeDenied 표시 후 재호출 시 추가 fetch 없음(무한 재시도 금지): " + before + " → " + callCount());
}
console.log("\n[⑥-b App._flushDirtyDrafts — 409(프로젝트 삭제) → authExpired 아님, writeDenied('conflict')]");
{
  const conflictRes = {
    ok: false, status: 409,
    json: async () => ({ error: "conflict — project deleted; deployment is read-only" }),
    clone() { return this; }
  };
  const { appTest, authExpiredCalls, writeDeniedCalls, savedDrafts } = makeFlushDraftsSandbox(conflictRes);
  await appTest._flushDirtyDrafts();
  ok(authExpiredCalls.length === 0, "⑥-b 409 → Auth.authExpired() 호출 안 함: " + authExpiredCalls.length);
  ok(writeDeniedCalls.length === 1 && writeDeniedCalls[0] === "conflict", "⑥-b Auth.writeDenied('conflict') 1회 호출: " + JSON.stringify(writeDeniedCalls));
  ok(savedDrafts.length === 1 && savedDrafts[0].d.writeDenied === true, "⑥-b draft 도 writeDenied:true 로 보존");
}

/* ══════════════════════════════════════════════════════════════════
 * ⑤ 32_Offline.js updateNetBadge — Auth._expired → "인증 필요" (온라인/오프라인보다 우선)
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[⑤ updateNetBadge — 인증 필요 배지]");
function makeBadgeSandbox(offlineSrcArg) {
  // [WO 20261010-offmatrix] updateNetBadge 가 대기 건수 단일 판정(pendingTotal)을 쓰게 됐다 — 실 소스를 함께 싣는다. assertion 무변경.
  const block = extractBalanced(offlineSrcArg, "async function pendingTotal() {") + "\n" + extractBalanced(offlineSrcArg, "async function updateNetBadge() {");
  const { getElementById, registry } = makeDoc(["net-badge", "net-text", "net-q"]);
  const document = { getElementById };
  let count = 0;
  const SyncQueue = { count: async () => count, allDraftKeys: async () => [], loadDraft: async () => null };
  const Auth = { _expired: false };
  const navigator = { onLine: true };
  const sandbox = {
    console, document, SyncQueue, Auth, navigator, window: {},
    _curDepId: () => null
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(block + "\n;globalThis.__updateNetBadge = updateNetBadge;", sandbox);
  return {
    run: sandbox.__updateNetBadge, registry,
    setExpired: (v) => { Auth._expired = v; },
    setOnline: (v) => { navigator.onLine = v; },
    setCount: (n) => { count = n; }
  };
}
{
  const { run, registry, setExpired, setOnline, setCount } = makeBadgeSandbox(offlineSrc);
  setExpired(true); setOnline(true); setCount(2);
  await run();
  ok(registry["net-text"].textContent === "인증 필요", "⑤ 온라인+만료 → 배지 텍스트 '인증 필요': " + registry["net-text"].textContent);
  ok(registry["net-badge"].classList.contains("show"), "⑤ 배지 show 클래스 켜짐");
  ok(registry["net-q"].textContent === "2", "⑤ 대기 건수(2) 표시 유지");
}
{
  // 회귀: 만료 아니고 오프라인이면 기존처럼 "오프라인"
  const { run, registry, setExpired, setOnline, setCount } = makeBadgeSandbox(offlineSrc);
  setExpired(false); setOnline(false); setCount(1);
  await run();
  ok(registry["net-text"].textContent === "오프라인", "⑤ 회귀: 미만료+오프라인 → '오프라인' 그대로: " + registry["net-text"].textContent);
}
{
  // 회귀: 만료 아니고 온라인+대기0 → 배지 숨김
  const { run, registry, setExpired, setOnline, setCount } = makeBadgeSandbox(offlineSrc);
  setExpired(false); setOnline(true); setCount(0);
  await run();
  ok(!registry["net-badge"].classList.contains("show"), "⑤ 회귀: 미만료+온라인+대기0 → 배지 숨김 그대로");
}

/* ══════════════════════════════════════════════════════════════════
 * 뮤테이션 증명 3건
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션1] SyncQueue.flush 의 401 감지 분기를 제거 → ①(Auth.authExpired 호출)이 실패해야 함");
{
  // [WO 20260930-403] 판정이 공유 지점(Auth.classifyWriteFailure)으로 이관됐다 — 뮤테이션 대상도
  // 그 결과를 소비하는 분기(kind === "expired")로 옮긴다(§G-2-5, 판정 로직 자체는 22_Auth.js 쪽에서 검증).
  const needle = 'if (kind === "expired") {';
  if (syncSrc.indexOf(needle) < 0) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mutatedSyncSrc = syncSrc.replace(needle, "if (false) {");
    const fullSrc = mutatedSyncSrc;
    const sqSrc = fullSrc.slice(0, fullSrc.indexOf("\n  };") + 5);
    const authExpiredCalls = [];
    const AuthSrc = "({ headers() { return {}; }, authExpired() { __authExpiredCalls.push(1); }, " +
      "writeDenied() {}, " + classifyBlock() + " })";
    const storage = {};
    const localStorage = { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); }, removeItem: (k) => { delete storage[k]; } };
    const sandbox = {
      console, Prompt: { toast() {} }, localStorage, navigator: { onLine: true }, window: {},
      fetch: async () => ({ ok: false, status: 401 }), JSON, Object, Array, Set, Promise, Date, Math,
      __authExpiredCalls: authExpiredCalls
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext("const Auth = " + AuthSrc + ";\n" + sqSrc + "\n;globalThis.__SQ = SyncQueue;", sandbox);
    await sandbox.__SQ.enqueue({ kind: "image", name: "m.jpg", image_data: "d" });
    await sandbox.__SQ.flush();
    const mutFailed = authExpiredCalls.length !== 1;
    console.log((mutFailed ? "  PASS(예상대로 실패 재현) " : "  FAIL(뮤테이션에도 통과 — 테스트가 가짜) ") + "authExpiredCalls=" + authExpiredCalls.length);
    if (!mutFailed) failed++;
  }
}

console.log("\n[뮤테이션2] Auth.authExpired 의 1회 제한 가드 제거 → ②(토스트 1회)가 실패해야 함");
{
  const needle = "if (this._authExpiredNotified) return;";
  if (authSrc.indexOf(needle) < 0) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mutatedAuthSrc = authSrc.replace(needle, "/* removed */");
    const { authTest, toasts } = makeAuthExpiredSandbox(mutatedAuthSrc);
    authTest.authExpired(); authTest.authExpired(); authTest.authExpired();
    const mutFailed = toasts.length !== 1;
    console.log((mutFailed ? "  PASS(예상대로 실패 재현) " : "  FAIL(뮤테이션에도 통과 — 테스트가 가짜) ") + "toasts=" + toasts.length);
    if (!mutFailed) failed++;
  }
}

console.log("\n[뮤테이션3] Auth.refresh 의 재개 배선(SyncQueue._onReconnect 호출) 제거 → ③이 실패해야 함");
{
  const needle = 'try { if (typeof SyncQueue !== "undefined" && SyncQueue._onReconnect) SyncQueue._onReconnect(); } catch (e) {}';
  if (authSrc.indexOf(needle) < 0) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mutatedAuthSrc = authSrc.replace(needle, "/* removed */");
    const { authTest, reconnectCalls } = makeAuthRefreshSandbox(mutatedAuthSrc, { authenticated: true, email: "a@b.com", role: "designer" });
    await authTest.refresh();
    const mutFailed = reconnectCalls.length !== 1;
    console.log((mutFailed ? "  PASS(예상대로 실패 재현) " : "  FAIL(뮤테이션에도 통과 — 테스트가 가짜) ") + "reconnectCalls=" + reconnectCalls.length);
    if (!mutFailed) failed++;
  }
}

console.log(failed === 0 ? "\n전체 PASS" : `\n${failed}건 FAIL`);
process.exit(failed === 0 ? 0 : 1);
