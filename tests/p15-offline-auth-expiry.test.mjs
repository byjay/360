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
    contains: (c) => set.has(c),
    _set: set
  };
}
function makeEl() {
  const el = { _text: "" };
  Object.defineProperty(el, "textContent", { get() { return this._text; }, set(v) { this._text = v == null ? "" : String(v); } });
  el.classList = makeClassList();
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
function makeSyncQueueSandbox() {
  const fullSrc = syncSrc;
  const sqSrc = fullSrc.slice(0, fullSrc.indexOf("\n  };") + 5);
  const toasts = [];
  const gates = [];
  const authExpiredCalls = [];
  const Auth = {
    headers() { return {}; },
    authExpired() { authExpiredCalls.push(1); }
  };
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
    console, Auth, Prompt, localStorage, navigator, window: {},
    fetch: fetchMock, indexedDB: undefined, JSON, Object, Array, Set, Promise, Date, Math
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(sqSrc + "\n;globalThis.__SQ = SyncQueue;", sandbox);
  return {
    SQ: sandbox.__SQ,
    toasts, authExpiredCalls,
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
  const ruleBlock = extractBalanced(appSrc, "_draftVsServer(d, srvPins, srvZones, srvVer) {");
  const objSrc = "const __appTest = {\n" +
    "  _deckIdOfKey() { return 'deck1'; },\n" +
    "  _mergeById(a, b) { return (a || []).concat(b || []); },\n" +
    "  " + ruleBlock + ",\n" +
    "  _markDeckUnsaved() {},\n" +
    "  _draftKey() { return 'noproj::nodeck'; },\n" +
    "  _setSaveIndicator() {},\n" +
    "  _linkDeckDeployment: async () => null,\n" +
    "  " + block + "\n" +
    "};\nglobalThis.__appTest = __appTest;";
  const authExpiredCalls = [];
  const savedDrafts = [];
  const draft = { dirty: true, pages: ["p1"], depId: "dep1", pins: [], zones: [], annotations: [], fileName: "도면" };
  const SyncQueue = {
    allDraftKeys: async () => ["noproj::nodeck"],
    loadDraft: async () => draft,
    saveDraft: async (k, d) => { savedDrafts.push({ k, d: Object.assign({}, d) }); }
  };
  const Auth = { headers: () => ({}), authExpired: () => authExpiredCalls.push(1) };
  let call = 0;
  const fetchMock = async (url, opts) => {
    call++;
    if (opts && opts.method === "PATCH") return patchRes;
    return { ok: true, json: async () => ({ version: 1, pins: "[]", zones: "[]" }) }; // baseVer GET
  };
  const sandbox = { console, SyncQueue, Auth, navigator: { onLine: true }, fetch: fetchMock, window: {}, JSON, Object };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(objSrc, sandbox);
  return { appTest: sandbox.__appTest, authExpiredCalls, savedDrafts, draft };
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
 * ⑤ 32_Offline.js updateNetBadge — Auth._expired → "인증 필요" (온라인/오프라인보다 우선)
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[⑤ updateNetBadge — 인증 필요 배지]");
function makeBadgeSandbox(offlineSrcArg) {
  const block = extractBalanced(offlineSrcArg, "async function updateNetBadge() {");
  const { getElementById, registry } = makeDoc(["net-badge", "net-text", "net-q"]);
  const document = { getElementById };
  let count = 0;
  const SyncQueue = { count: async () => count };
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
  const needle = 'if ((res.status === 401 || res.status === 403) && typeof Auth !== "undefined" && Auth.authExpired) Auth.authExpired();';
  if (syncSrc.indexOf(needle) < 0) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mutatedSyncSrc = syncSrc.replace(needle, "/* removed */");
    const fullSrc = mutatedSyncSrc;
    const sqSrc = fullSrc.slice(0, fullSrc.indexOf("\n  };") + 5);
    const authExpiredCalls = [];
    const Auth = { headers: () => ({}), authExpired: () => authExpiredCalls.push(1) };
    const storage = {};
    const localStorage = { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); }, removeItem: (k) => { delete storage[k]; } };
    const sandbox = { console, Auth, Prompt: { toast() {} }, localStorage, navigator: { onLine: true }, window: {}, fetch: async () => ({ ok: false, status: 401 }), JSON, Object, Array, Set, Promise, Date, Math };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(sqSrc + "\n;globalThis.__SQ = SyncQueue;", sandbox);
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
