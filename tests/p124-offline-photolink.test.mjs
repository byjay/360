/**
 * p124 — 오프라인 360 사진 → 온라인 복귀 업로드/연결 회귀 (프레임워크 0 · 실행: node tests/p124-offline-photolink.test.mjs)
 *
 * [재현] 지휘자 재현 p114 "360 사진이 서버에 올라가 핀에 연결됨(pendingOpId 해소)" FAIL
 *   → {"pins":1,"photoPins":[],"panoImagesRows":0}
 *   deep-reasoner 실측(실 Chrome CDP · HEAD 추출본 .tmp/hfA · P114_EXPLORE):
 *     POST /api/sync/batch 1,730,345B st=200 **21,162ms** (Fast 3G 업로드 84KB/s)
 *     → srvPhoto=1 · pano_images=1 · doneMs=24,597ms  ⇒ 제품 업로드 경로는 정상.
 *     p114 는 1,625ms 에 관측 루프를 빠져나와(빈 배열 every() = vacuous true) 12.6s 째 측정했다.
 *   같은 실측에서 드러난 **제품 결함 3건**을 이 파일이 지킨다(아래 A1~A4).
 *
 * 🔴 목 금지 원칙 — 실제 소스(05_SyncQueue.js / 20_App.js / 32_Offline.js)를 그대로 vm 에
 *   평가해 검증한다. fetch/localStorage/document 만 메모리 대역(node 에 없는 플랫폼 API —
 *   p102·p121 과 같은 경계).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const syncSrc = rd("public/js/modules/05_SyncQueue.js");
const appSrc = rd("public/js/modules/20_App.js");
const offlineSrc = rd("public/js/modules/32_Offline.js");

let failed = 0;
const ok = (cond, label, detail) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label + (!cond && detail !== undefined ? " :: " + JSON.stringify(detail) : ""));
  if (!cond) failed++;
};

/* ── 메모리 localStorage (SyncQueue 의 IDB 미지원 폴백 경로를 쓴다) ── */
function makeLS() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key(i) { return Array.from(m.keys())[i]; },
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
    _map: m
  };
}

/** 05_SyncQueue.js 를 실제 소스 그대로 평가한 샌드박스. */
function makeSync(src, opts) {
  opts = opts || {};
  const toasts = [];
  const localStorage = makeLS();
  const calls = { refresh: 0, flushDirtyDrafts: 0, flushOpLogs: 0, onSyncDone: 0 };
  const Auth = {
    _offlineOnly: !!opts.offlineOnly,
    idToken: "tok",
    headers: () => ({ "Content-Type": "application/json" }),
    canServerWrite() { return !this._offlineOnly && !!this.idToken; },
    // 서버 재검증 성공 = _offlineOnly 해제(실 구현 22_Auth.js:388 과 같은 효과)
    async refresh() { calls.refresh++; if (opts.refreshFixes !== false) this._offlineOnly = false; },
    async classifyWriteFailure() { return null; }
  };
  const App = {
    async _onSyncDone(r) { calls.onSyncDone++; calls.lastMap = r && r.map; },
    async _flushDirtyDrafts() { calls.flushDirtyDrafts++; if (opts.draftThrows) throw new Error("PATCH 실패(테스트)"); },
    async _flushOpLogs() { calls.flushOpLogs++; }
  };
  const serverOps = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse((init && init.body) || "{}");
    if (opts.batchStatus && opts.batchStatus !== 200) return { ok: false, status: opts.batchStatus, json: async () => ({}) };
    const results = (body.ops || []).map((o) => (opts.opFails
      ? { opId: o.opId, ok: false, permanent: false, error: "D1 일시오류(테스트)" }
      : { opId: o.opId, ok: true, id: "img_" + o.opId }));
    results.forEach((r) => { if (r.ok) serverOps.push(r.id); });
    return { ok: true, status: 200, json: async () => ({ ok: true, results }) };
  };
  const sandbox = {
    console, localStorage, Auth, App,
    Prompt: { toast: (m) => toasts.push(String(m)) },
    navigator: { onLine: true },
    window: {},                       // indexedDB 없음 → localStorage 폴백 경로
    fetch: fetchImpl, setTimeout, Promise, JSON, Date, Math
  };
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__SQ = SyncQueue;", sandbox);
  return { SQ: sandbox.__SQ, toasts, Auth, calls, serverOps, localStorage };
}

/* ══ A1. 오프라인 검증자 상태(_offlineOnly)로 복귀해도 사진이 올라간다 ══
   근본원인: flush() 는 canServerWrite()==false 면 업로드를 건너뛴다. 그런데 _offlineOnly 를
   푸는 유일한 지점은 Auth.refresh() 이고, "online" 리스너 4곳(05_SyncQueue:352 ·
   20_App:63,4096 · 32_Offline:406) 중 refresh() 를 부르는 곳이 **하나도 없다**(grep 전수) →
   사진 큐가 영구 차단되고 배지는 "동기화 중 N" 만 띄웠다(핀은 _flushDirtyDrafts 로 올라가므로
   "핀은 보이는데 360 사진만 연결 안 됨"). */
async function A1(src) {
  console.log("\n[A1] 오프라인 검증자 상태로 온라인 복귀 → 서버 재검증 후 사진 업로드");
  const { SQ, Auth, serverOps, calls } = makeSync(src, { offlineOnly: true });
  await SQ.enqueue({ kind: "image", name: "p1", image_data: "data:image/jpeg;base64,AAA" });
  ok(Auth.canServerWrite() === false, "전제: 오프라인 검증자 상태라 서버 쓰기 금지");
  await SQ._onReconnect();
  ok(calls.refresh === 1, "온라인 복귀 시 서버 재검증(Auth.refresh) 1회", calls);
  ok(serverOps.length === 1, "재검증 후 사진 op 가 서버에 업로드됨", { serverOps, queue: await SQ.count() });
  ok((await SQ.count()) === 0, "업로드 성공분은 큐에서 제거됨", await SQ.count());
  ok(calls.onSyncDone === 1 && calls.lastMap && Object.keys(calls.lastMap).length === 1,
    "pendingOpId → 서버 imageId 치환(App._onSyncDone)이 map 과 함께 호출됨", calls.lastMap);
}

/* ══ A2. 조용한 실패 금지 — 못 올렸으면 사용자에게 보인다 ══ */
async function A2(src) {
  console.log("\n[A2] 업로드 실패 → _lastSyncError + 토스트(조용한 실패 금지)");
  {
    const { SQ, toasts } = makeSync(src, { opFails: true });
    await SQ.enqueue({ kind: "image", name: "p1", image_data: "data:image/jpeg;base64,AAA" });
    await SQ._onReconnect();
    ok(!!SQ._lastSyncError, "실패 시 SyncQueue._lastSyncError 가 세워진다(배지 판정 SoT)", SQ._lastSyncError);
    ok(toasts.some((t) => /동기화 실패/.test(t)), "실패 사실을 토스트로 알린다", toasts);
    ok(!toasts.some((t) => /동기화 완료|업로드 완료/.test(t)), "실패인데 '완료'라고 보고하지 않는다", toasts);
    ok((await SQ.count()) === 1, "실패분은 큐에 보존(데이터 유실 0)", await SQ.count());
  }
  {
    const { SQ, toasts } = makeSync(src, { offlineOnly: true, refreshFixes: false });
    await SQ.enqueue({ kind: "image", name: "p1", image_data: "data:image/jpeg;base64,AAA" });
    await SQ._onReconnect();
    ok(/인증/.test(String(SQ._lastSyncError || "")), "재검증 실패(여전히 오프라인 인증)도 사유가 남는다", SQ._lastSyncError);
    ok(toasts.some((t) => /동기화 실패/.test(t)), "재인증 필요 사실을 토스트로 알린다", toasts);
  }
  {
    const { SQ, toasts } = makeSync(src, { draftThrows: true });
    await SQ.enqueue({ kind: "image", name: "p1", image_data: "data:image/jpeg;base64,AAA" });
    await SQ._onReconnect();
    ok(/도면 저장/.test(String(SQ._lastSyncError || "")), "도면 draft 반영 예외도 삼키지 않는다", SQ._lastSyncError);
  }
  {
    const { SQ, toasts } = makeSync(src, {});
    await SQ.enqueue({ kind: "image", name: "p1", image_data: "data:image/jpeg;base64,AAA" });
    await SQ._onReconnect();
    ok(SQ._lastSyncError === null, "성공하면 실패 사유는 비워진다(배지가 '동기화 중'으로 돌아간다)", SQ._lastSyncError);
    ok(toasts.some((t) => /동기화 완료/.test(t)), "성공 시 완료 안내", toasts);
  }
}

/* ══ A3. 사진 고아 차단 — 오프라인 번들 스냅샷(pins 가 **문자열**)도 치환된다 ══ */
function makeApp(src) {
  const store = {};
  const SyncQueue = {
    async allDraftKeys() { return Object.keys(store); },
    async loadDraft(k) { return store[k] !== undefined ? JSON.parse(JSON.stringify(store[k])) : null; },
    async saveDraft(k, v) { store[k] = JSON.parse(JSON.stringify(v)); return true; }
  };
  const State = { pins: [], zones: [], annotations: [] };
  const sandbox = { console, State, SyncQueue, Cloud: { _cache: {} }, UI: {}, setTimeout, Promise, JSON, Date, Math };
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__App = App;", sandbox);
  return { App: sandbox.__App, store, State };
}
async function A3(src) {
  console.log("\n[A3] 동기화 후 로컬 보관본 전부에서 죽은 pendingOpId 가 사라진다(사진 고아 차단)");
  const { App, store } = makeApp(src);
  const OP = "op123";
  store["prj1::deck1"] = { dirty: true, pages: ["data:,x"], pins: [{ id: 1, pendingOpId: OP, pendingSync: true }] };
  // 🔴 32_Offline.persistLocalDeployment 가 쓰는 번들 스냅샷 = 서버 행 모양이라 pins 가 JSON 문자열
  store["bundle:dep:dep1"] = { id: "dep1", pins: JSON.stringify([{ id: 1, pendingOpId: OP, pendingSync: true }]), zones: "[]" };
  store["oplog:dep1"] = [{ opId: "o1", entity: "pin", action: "upsert", id: 1, data: { id: 1, pendingOpId: OP } }];
  // 사진 교체 이력(PhotoNaming.pushHistory)에 적립된 pendingOpId
  store["prj1::deck2"] = { dirty: true, pages: ["data:,x"], pins: [{ id: 2, timeline: [{ id: "tl1", pendingOpId: OP }] }] };

  const n = await App._applySyncMapToDrafts({ [OP]: "img_srv" });
  const pinsOf = (k) => { const d = store[k]; return Array.isArray(d && d.pins) ? d.pins : JSON.parse((d && d.pins) || "[]"); };
  ok(n === 4, "보관본 4종(도면 draft · 번들 스냅샷 · op 로그 · 이력) 전부 치환", n);
  ok(pinsOf("prj1::deck1")[0].imageId === "img_srv" && !pinsOf("prj1::deck1")[0].pendingOpId, "도면 draft 치환", pinsOf("prj1::deck1"));
  ok(typeof store["bundle:dep:dep1"].pins === "string", "번들 스냅샷의 pins 는 문자열 형태를 유지(모양 불변)");
  ok(pinsOf("bundle:dep:dep1")[0].imageId === "img_srv" && !pinsOf("bundle:dep:dep1")[0].pendingOpId,
    "🔴 번들 스냅샷(bundle:dep, 문자열 pins)도 치환 — 오프라인 재진입 시 사진 고아 차단", pinsOf("bundle:dep:dep1"));
  ok(store["oplog:dep1"][0].data.imageId === "img_srv" && !store["oplog:dep1"][0].data.pendingOpId,
    "op 로그 replay 본문도 치환(죽은 opId 를 서버에 쓰지 않는다)", store["oplog:dep1"]);
  ok(store["prj1::deck2"].pins[0].timeline[0].imageId === "img_srv" && !store["prj1::deck2"].pins[0].timeline[0].pendingOpId,
    "사진 교체 이력(timeline)도 치환", store["prj1::deck2"].pins[0].timeline);
}

/* ══ A4. 배지가 실패를 '동기화 중'으로 위장하지 않는다 ══ */
async function A4(src) {
  console.log("\n[A4] net-badge — 동기화 실패를 '동기화 중'으로 위장하지 않는다");
  const el = { cls: new Set(), attrs: {}, classList: null };
  el.classList = {
    add: (...c) => c.forEach((x) => el.cls.add(x)),
    remove: (...c) => c.forEach((x) => el.cls.delete(x)),
    toggle: (c, on) => { if (on) el.cls.add(c); else el.cls.delete(c); },
    contains: (c) => el.cls.has(c)
  };
  el.setAttribute = (k, v) => { el.attrs[k] = v; };
  el.removeAttribute = (k) => { delete el.attrs[k]; };
  const text = { textContent: "" }, q = { textContent: "" };
  const nodes = { "net-badge": el, "net-text": text, "net-q": q };
  const SyncQueue = { _lastSyncError: null, async count() { return 2; }, onChange() {} };
  const sandbox = {
    console, SyncQueue,
    State: { autoSaveDepId: "dep1" },
    App: {},
    Auth: { _expired: false },
    Projects: { currentProject: { id: "p1" }, currentDeck: null },
    Prompt: null, PhotoBatch: null, PinSeries: null, Notes: null, UI: null, Zones: null, Cloud: { _cache: {} },
    document: { getElementById: (id) => nodes[id] || null, createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {}, style: {} }) },
    navigator: { onLine: true }, window: { addEventListener() {} },
    setInterval: () => 0, setTimeout, Promise, JSON, Date, Math, fetch: async () => ({ ok: false, status: 500, json: async () => ({}) })
  };
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__Offline = Offline;", sandbox);
  const Offline = sandbox.__Offline;

  await Offline.updateNetBadge();
  ok(text.textContent === "동기화 중" && el.cls.has("syncing"), "실패 이력 없음 → '동기화 중'", text.textContent);

  SyncQueue._lastSyncError = "360 사진·첨부 1건을 올리지 못했습니다 — 대기에 보관됨(자동 재시도)";
  await Offline.updateNetBadge();
  ok(text.textContent === "동기화 실패", "실패 이력 있음 → '동기화 실패'로 표시", text.textContent);
  ok(!el.cls.has("syncing"), "'진행 중' 파란 상태를 쓰지 않는다(기존 빨강 재사용)", Array.from(el.cls));
  ok(/360 사진/.test(String(el.attrs.title || "")), "사유를 title 로 노출", el.attrs.title);
}

/* ══ A5. 오프라인 재진입 뒤 첫 서버 병합에서 내 오프라인 핀이 살아남는다 ══
   [재현] 지휘자 재현 p114 "서버 핀 수 = 로컬 핀 수" FAIL {"local":1,"server":25} +
     deep-reasoner .tmp/xbase 결정론 재현(실 Chrome CDP · HEAD 추출본 .tmp/hfC):
       온라인 1핀 저장(pinBaseIds=1) → 오프라인 2핀 추가(3핀, base=1)
       → 오프라인 새로고침·재진입에서 **base 가 3 으로 바뀜**(loadDeckDrawing 이 번들 사본을
         "서버가 아는 목록"으로 기록, 20_App.js:4639)
       → 온라인 복귀 첫 병합(_mergeConflict → _mergePins (b) base∧¬srv)에서 화면 3핀 → **1핀**
         (서버에는 25핀이 멀쩡히 올라간 상태로 화면만 1핀).
   근본수정: ① 번들 사본이면 기준 = null(판정 불가) ② _applyDirtyDraft 가 draft 가 기억한
     진짜 서버 기준(d.basePinIds)을 되돌린다(형제 _restoreDraftLocal 과 통일). */
function makeMergeApp(src) {
  const State = { pins: [], zones: [], annotations: [], pinBaseIds: null, pinTombstones: {}, depVersion: 0, autoSaveDepId: "dep1" };
  const sandbox = { console, State, JSON, Date, Math, Promise, setTimeout,
                    UI: { renderPinList() {}, renderPinsOnMap() {} }, SyncQueue: { async saveDraft() { return true; } } };
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__App = App;", sandbox);
  const App = sandbox.__App;
  App._markDirty = () => {};            // DOM 의존 — 이 테스트의 관심사(병합 기준)가 아니다
  App._markDeckUnsaved = () => {};
  return { App, State };
}
async function A5(src) {
  console.log("\n[A5] 오프라인 재진입 → 서버 병합에 내 오프라인 핀 유실 0");
  const P1 = { id: "p1", label: "1" }, P2 = { id: "p2", label: "2" }, P3 = { id: "p3", label: "3" };
  const { App, State } = makeMergeApp(src);

  // 오프라인 재진입 직후 상태: 번들 사본(내 미동기화 핀 포함)이 화면에 올라오고,
  //   로더가 그 목록을 병합 기준으로 적어 둔 상황(= 버그 당시 실측값 base=3)
  State.pins = [P1, P2, P3];
  State.pinBaseIds = App._pinIds(State.pins);
  ok(State.pinBaseIds.length === 3, "전제: 로더가 번들 사본 3핀을 기준으로 적어 둔 상태(실측 재현)");

  // draft 는 "내가 알던 서버 핀 목록 = p1" 을 정확히 기억하고 있다
  const draft = { dirty: true, pages: ["data:,x"], pins: [P1, P2, P3], zones: [], basePinIds: ["p1"], baseVer: 1, deletedPins: [] };
  App._applyDirtyDraft(draft, "prj1::deck1", 2);
  ok(JSON.stringify(State.pinBaseIds) === JSON.stringify(["p1"]),
    "draft 가 기억한 진짜 서버 기준(basePinIds)으로 되돌린다", State.pinBaseIds);

  // 남이 저장해 version 이 올라간 서버본(핀은 여전히 p1 하나) → 라이브폴 1틱과 같은 경로
  App._mergeConflict({ pins: JSON.stringify([P1]), zones: "[]", version: 3 });
  ok(State.pins.length === 3, "서버 병합 후에도 내 오프라인 핀 3개 보존(유실 0)", App._pinIds(State.pins));
  ok(JSON.stringify(App._pinIds(State.pins).sort()) === JSON.stringify(["p1", "p2", "p3"]), "보존된 id 가 그대로", App._pinIds(State.pins));
}

/* ══ A6. 기준이 '모름'(null)이면 지우지 않고, 진짜 서버목록이면 지운다(규칙 자체는 불변) ══ */
async function A6(src) {
  console.log("\n[A6] _mergePins 기준 판정 — null=판정 불가 / 실제 서버목록=삭제 반영");
  const { App } = makeMergeApp(src);
  const srv = [{ id: "p1" }], local = [{ id: "p1" }, { id: "p2" }, { id: "p3" }];
  ok(App._mergePins(srv, local, null, []).length === 3, "기준 null → '남이 지웠다' 판정 생략(내 핀 보존)");
  ok(App._mergePins(srv, local, ["p1", "p2", "p3"], []).length === 1, "기준이 진짜 서버목록 → 남이 지운 핀은 반영(기존 규칙 불변)");
  // 형제 로더 2곳 전수 — 번들 사본을 기준으로 쓰지 않는다
  const guarded = (src.match(/State\.pinBaseIds = (?:dep|latest)FromBundle \? null : this\._pinIds\(State\.pins\);/g) || []).length;
  const bare = (src.match(/State\.pinBaseIds = this\._pinIds\(State\.pins\);/g) || []).length;
  ok(guarded === 2 && bare === 0, "로더 2곳 모두 번들 사본 가드 적용(무가드 0건) — guarded=" + guarded + " bare=" + bare);
}

/* ══ 뮤테이션 — 고친 부분을 되돌리면 해당 단언이 FAIL 해야 한다 ══ */
function mutSyncRemoveReauth(src) {
  const needle = `        if (r && r.offlineAuth && typeof Auth !== "undefined" && Auth.refresh) {`;
  if (src.indexOf(needle) < 0) throw new Error("뮤테이션 대상(offlineAuth 재검증) 없음 — 소스 변경?");
  return src.replace(needle, `        if (false && r && r.offlineAuth && typeof Auth !== "undefined" && Auth.refresh) {`);
}
function mutSyncRemoveNotify(src) {
  const needle = `        this.noteSyncResult(r, errs);`;
  if (src.indexOf(needle) < 0) throw new Error("뮤테이션 대상(noteSyncResult 호출) 없음 — 소스 변경?");
  return src.replace(needle, `        if (r && (r.uploaded > 0) && typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("온라인 복구 — 오프라인 변경 " + r.uploaded + "건 동기화 완료");`);
}
function mutAppArrayOnly(src) {
  const needle = `        if (!d) continue;
        let changed = false;
        if (Array.isArray(d.pins)) {`;
  if (src.indexOf(needle) < 0) throw new Error("뮤테이션 대상(_applySyncMapToDrafts 분기) 없음 — 소스 변경?");
  return src.replace(needle, `        if (!d || !Array.isArray(d.pins)) continue;
        let changed = false;
        if (Array.isArray(d.pins)) {`);
}
function mutAppDropBaseRestore(src) {
  const needle = `      if (Array.isArray(d.basePinIds)) State.pinBaseIds = d.basePinIds.map(String);`;
  if (src.indexOf(needle) < 0) throw new Error("뮤테이션 대상(_applyDirtyDraft basePinIds 복원) 없음 — 소스 변경?");
  return src.replace(needle, "      /* 제거됨(뮤테이션) */");
}
function mutAppBundleBaseline(src) {
  const needle = `        State.pinBaseIds = depFromBundle ? null : this._pinIds(State.pins);`;
  if (src.indexOf(needle) < 0) throw new Error("뮤테이션 대상(번들 가드) 없음 — 소스 변경?");
  return src.replace(needle, `        State.pinBaseIds = this._pinIds(State.pins);`);
}
function mutOfflineBadge(src) {
  const needle = `      if (text) text.textContent = syncErr ? "동기화 실패" : "동기화 중";`;
  if (src.indexOf(needle) < 0) throw new Error("뮤테이션 대상(배지 문구) 없음 — 소스 변경?");
  return src.replace(needle, `      if (text) text.textContent = "동기화 중";`);
}

(async () => {
  const MUT = process.env.P124_MUT || "";
  const S = MUT === "reauth" ? mutSyncRemoveReauth(syncSrc) : MUT === "notify" ? mutSyncRemoveNotify(syncSrc) : syncSrc;
  const A = MUT === "arrayonly" ? mutAppArrayOnly(appSrc)
    : MUT === "baserestore" ? mutAppDropBaseRestore(appSrc)
    : MUT === "bundlebase" ? mutAppBundleBaseline(appSrc) : appSrc;
  const O = MUT === "badge" ? mutOfflineBadge(offlineSrc) : offlineSrc;
  if (MUT) console.log("[뮤테이션] " + MUT + " — 해당 단언이 FAIL 해야 정상");

  await A1(S);
  await A2(S);
  await A3(A);
  await A4(O);
  await A5(A);
  await A6(A);

  console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.log("ERROR " + (e && e.stack || e)); process.exit(1); });
