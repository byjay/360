/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p92-pin-bulk-delete.test.mjs)
 *
 * 마스터 지시(2026-09-29): "관리자는 핀 일괄삭제 가능하게 해" + 대기 항목 createdAt 명시 저장.
 *
 * 근본원인(삭제 부활 — 단건 삭제에도 있던 결함, 일괄삭제가 같은 경로를 타므로 함께 고침):
 *   _mergeById(서버본, 내 로컬) 는 "서버에만 있는 항목 보존" 규칙이다. 그래서
 *   ① 내가 지운 핀 — 서버가 더 새로우면(409 충돌 / draft 기준 버전 다름) 서버본의 그 핀이 되살아났고
 *   ② 남이 지운 핀 — 내 로컬에 남은 옛 핀이 409 병합으로 서버에 다시 올라갔다.
 * 조치: 20_App._mergePins(병합 단일 출처) = _mergeById 결과에서 (a) 내 tombstone (b) 내가 알던 서버 기준 id 중
 *   지금 서버본에 없는 id 를 뺀다. tombstone/기준 id 는 draft 에도 실린다(_draftPinMeta).
 *
 * 실제 모듈 소스(20_App.js · 11_UI.js · 01b_PinSeries.js)를 vm 에 그대로 평가한다(목은 DOM/네트워크 경계만).
 * 뮤테이션: P92_APP_SRC / P92_UI_SRC 로 변형 소스를 주입하면 해당 케이스가 FAIL → EXIT=1.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const fromEnv = (k, p) => (process.env[k] ? fs.readFileSync(process.env[k], "utf8").replace(/\r\n/g, "\n") : rd(p));
const appSrc = fromEnv("P92_APP_SRC", "public/js/modules/20_App.js");
const uiSrc = fromEnv("P92_UI_SRC", "public/js/modules/11_UI.js");
const seriesSrc = rd("public/js/modules/01b_PinSeries.js");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const ids = (arr) => (arr || []).map((p) => String(p.id)).sort().join(",");

/* ── 20_App 환경(p77 과 같은 패턴 — DOM/네트워크 경계만 스텁) ───────────────────────── */
function anyEl() {
  const store = {};
  const fn = function () { return proxy; };
  const proxy = new Proxy(fn, {
    get(t, k) {
      if (k in store) return store[k];
      if (k === Symbol.toPrimitive) return () => "";
      if (k === "then") return undefined;
      if (k === "contains") return () => false;
      return proxy;
    },
    set(t, k, v) { store[k] = v; return true; },
    apply() { return proxy; },
  });
  return proxy;
}
function makeApp({ fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) }), drafts = {}, admin = true, mode = "designer", online = true, confirmAns = true } = {}) {
  const els = {};
  const img = () => ({ _src: "", onload: null, onerror: null, complete: false, naturalWidth: 0, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, set src(v) { this._src = v; }, get src() { return this._src; } });
  const document = {
    getElementById: (id) => (els[id] = els[id] || (id === "map-image" ? img() : anyEl())),
    querySelector: () => null, querySelectorAll: () => [],
    body: anyEl(), documentElement: anyEl(), addEventListener() {},
  };
  const deck = { id: "dckM", name: "ㅁ", deployment_id: "dep1" };
  const calls = { confirm: [], toast: [], oplog: [], persist: 0, renderList: 0 };
  const State = {
    pins: [], zones: [], annotations: [], checkboardStart: {}, pdfPage: 1, mode,
    fileType: "image", pinTombstones: {}, pinBaseIds: null,
    reset() { this.pins = []; this.zones = []; this.annotations = []; this.fileType = null; this.pinTombstones = {}; this.pinBaseIds = null; },
  };
  const sandbox = {
    console, document, window: { addEventListener() {} }, navigator: { onLine: online }, location: { search: "" },
    State,
    UI: { $: (id) => document.getElementById(id), text() {}, toggle() {}, hide() {}, show() {}, showScreen() {},
      renderPinsOnMap() {}, renderPinList() { calls.renderList++; }, updatePdfPagination() {} },
    Projects: { currentProject: { id: "prjX", name: "tes" }, currentDeck: deck, decks: [deck], load: async () => {}, loadDecks: async () => {}, _renderDecks() {} },
    SyncQueue: {
      loadDraft: async (k) => (drafts[k] ? JSON.parse(JSON.stringify(drafts[k])) : null),
      saveDraft: async (k, d) => { drafts[k] = JSON.parse(JSON.stringify(d)); },
      allDraftKeys: async () => Object.keys(drafts),
    },
    Auth: { headers: () => ({}), r2: (u) => u, isDesigner: true, isAdmin: admin, readonly: false },
    Prompt: { toast(m) { calls.toast.push(m); }, confirm: async (t, m) => { calls.confirm.push(m); return confirmAns; } },
    OpLog: { recordCurrent: async (e, a, id) => { calls.oplog.push([e, a, id]); } },
    persistLocalDeployment: async () => { calls.persist++; },
    _revokeVideoBlob() {}, Zones: { refreshPinLinks() {} },
    MapCtrl: { applyTransform() {}, fit() {} }, Log: { push() {} },
    PinSeries: { preferredMode: () => "designer", setPreferredMode() {}, nextSeriesNo: () => 1 },
    fetch: fetchImpl, URLSearchParams, AbortController,
    setTimeout: (f, ms) => (ms && ms >= 1000 ? 0 : setTimeout(f, ms)), clearTimeout,
    JSON, Array, Map, Set, Date, Promise, Object, Number, String,
  };
  vm.createContext(sandbox);
  vm.runInContext(appSrc + "\n;globalThis.__App = App;", sandbox);
  const App = sandbox.__App;
  App._markDeckUnsaved = () => {};
  App._snapshotPages = async () => ["data:image/png;base64,x"];
  App._draftSrcFields = async () => ({});
  App._closePinForm = () => {};
  App._setSaveIndicator = () => {};
  return { App, State, calls, drafts, sandbox };
}
const KEY = "prjX::dckM";
const P = (id) => ({ id, x: 10, y: 10, page: 1, label: String(id) });
const res = (status, j) => ({ ok: status >= 200 && status < 300, status, json: async () => j });

/* ══ A. 권한 · 확인 대화상자 ══ */
{
  console.log("\n[A. 권한 = Auth.isAdmin · Prompt.confirm(개수 명시)]");
  const a = makeApp({ admin: false });
  a.State.pins = [P(1), P(2), P(3)];
  const n = await a.App.deletePins([1, 2]);
  ok(n === 0 && a.State.pins.length === 3 && a.calls.confirm.length === 0, "A 비관리자 → 0개 삭제, 확인창도 안 뜸");
  const v = makeApp({ admin: true, mode: "viewer" });
  v.State.pins = [P(1), P(2)];
  ok((await v.App.deletePins([1, 2])) === 0 && v.State.pins.length === 2, "A 관리자라도 뷰어 모드(저장 경로 없음) → 0개");
  const c = makeApp({ confirmAns: false });
  c.State.pins = [P(1), P(2), P(3)];
  ok((await c.App.deletePins([1, 2, 3])) === 0 && c.State.pins.length === 3, "A 확인 취소 → 삭제 없음");
  ok(/포인트 3개/.test(c.calls.confirm[0] || ""), "A 확인 문구에 개수(3개) 명시 — " + JSON.stringify(c.calls.confirm[0]));
  const g = makeApp();
  g.State.pins = [P(1), P(2), P(3)];
  const n2 = await g.App.deletePins([1, 3, 999]);
  ok(n2 === 2 && ids(g.State.pins) === "2", "A 관리자 → 요청 id 중 실재하는 2개만 삭제");
  ok(g.State.pinTombstones["1"] && g.State.pinTombstones["3"], "A 삭제 핀은 tombstone 기록");
}

/* ══ B. 오프라인 — 단건과 같은 OpLog 경로(핀마다 delete op) + 로컬 스냅샷 ══ */
{
  console.log("\n[B. 오프라인 OpLog 재사용]");
  const o = makeApp({ online: false });
  o.State.pins = [P(1), P(2), P(3)];
  await o.App.deletePins([1, 2]);
  await tick();
  ok(JSON.stringify(o.calls.oplog) === JSON.stringify([["pin", "delete", 1], ["pin", "delete", 2]]), "B 핀마다 OpLog delete op — " + JSON.stringify(o.calls.oplog));
  ok(o.calls.persist === 1, "B persistLocalDeployment 1회");
  const s = makeApp();
  s.State.pins = [P(7), P(8)];
  await s.App.deletePin(7);
  ok(s.State.pinTombstones["7"] && ids(s.State.pins) === "8", "B 단건 deletePin 도 같은 경로(_removePins) — tombstone 기록");
}

/* ══ C. 내가 일괄삭제 → 저장 전 다른 사용자가 저장(서버 더 새로움) → draft 복원/업로드에서 부활 금지 ══ */
{
  console.log("\n[C. 오프라인 draft × 서버 더 새로움(_draftVsServer)]");
  const drafts = {};
  const a = makeApp({ drafts });
  a.State.pins = [P(1), P(2), P(3)]; a.State.pinBaseIds = ["1", "2", "3"];
  a.State.autoSaveDepId = "dep1"; a.State.depVersion = 5;
  await a.App.deletePins([2, 3]);
  await tick();
  const d = drafts[KEY];
  ok(d && ids(d.pins) === "1", "C draft 에 남은 핀 1개");
  ok(d && JSON.stringify((d.deletedPins || []).slice().sort()) === '["2","3"]', "C draft 에 tombstone(deletedPins) 저장 — " + JSON.stringify(d && d.deletedPins));
  // 다른 사용자가 핀 4 를 추가해 서버 v6 = [1,2,3,4]
  const srvDep = { id: "dep1", version: 6, pins: JSON.stringify([P(1), P(2), P(3), P(4)]), zones: "[]", pages_data: JSON.stringify(["/api/r2/object/a.png"]), file_name: "A.pdf" };
  const b = makeApp({ drafts, fetchImpl: async () => res(200, srvDep) });
  await b.App.loadDeckDrawing("dep1");
  ok(ids(b.State.pins) === "1,4", "C 재로드: 지운 2·3 부활 없음 + 남이 추가한 4 보존 → [" + ids(b.State.pins) + "]");
  const m = b.App._draftVsServer(d, [P(1), P(2), P(3), P(4)], [], 6);
  ok(ids(m.pins) === "1,4", "C 온라인 업로드(_flushDirtyDrafts 와 같은 규칙) → [" + ids(m.pins) + "]");
  ok(b.State.pinTombstones["2"] && b.State.pinTombstones["3"], "C 복원 후에도 tombstone 유지(다음 409 병합 대비)");
}

/* ══ D. 409 충돌 병합(_mergeConflict) — 내 삭제·남의 삭제 둘 다 부활 금지 ══ */
{
  console.log("\n[D. 409 충돌 병합]");
  const mk = (current) => {
    const sent = [];
    let n = 0;
    const fetchImpl = async (u, o) => {
      if (o && o.method === "PATCH") { sent.push(JSON.parse(o.body)); n++; return n === 1 ? res(409, { current }) : res(200, { version: 8 }); }
      return res(200, {});
    };
    return { sent, fetchImpl };
  };
  // D1 내가 2·3 을 일괄삭제 → 그 사이 C 가 9 를 추가해 v6 저장 → 내 저장 409
  {
    const t = mk({ pins: JSON.stringify([P(1), P(2), P(3), P(9)]), zones: "[]", version: 6 });
    const a = makeApp({ fetchImpl: t.fetchImpl });
    a.State.pins = [P(1), P(2), P(3)]; a.State.pinBaseIds = ["1", "2", "3"]; a.State.depVersion = 5; a.State.autoSaveDepId = "dep1";
    await a.App.deletePins([2, 3]);
    const r = await a.App._patchDeployment("dep1", () => ({ pins: JSON.stringify(a.State.pins) }));
    const retried = t.sent[1] ? JSON.parse(t.sent[1].pins) : [];
    ok(r.ok && ids(retried) === "1,9", "D1 내 삭제: 재시도 본문 = [1,9](2·3 부활 없음) → [" + ids(retried) + "]");
    ok(JSON.stringify(a.State.pinBaseIds.slice().sort()) === '["1","9"]', "D1 저장 성공 → 기준 id = 보낸 핀");
  }
  // D2 관리자 A 가 2 를 삭제해 v6 저장 → 옛 핀 2 를 든 B 가 새 핀 5 를 저장하려다 409
  {
    const t = mk({ pins: JSON.stringify([P(1)]), zones: "[]", version: 6 });
    const b = makeApp({ fetchImpl: t.fetchImpl });
    b.State.pins = [P(1), P(2), P(5)]; b.State.pinBaseIds = ["1", "2"]; b.State.depVersion = 5; b.State.autoSaveDepId = "dep1";
    await b.App._patchDeployment("dep1", () => ({ pins: JSON.stringify(b.State.pins) }));
    const retried = t.sent[1] ? JSON.parse(t.sent[1].pins) : [];
    ok(ids(retried) === "1,5", "D2 남의 삭제: B 의 병합이 2 를 되살리지 않음 + B 의 새 핀 5 보존 → [" + ids(retried) + "]");
  }
}

/* ══ E. 안전 경계 — 기준을 모르면 추정 삭제 금지(유실 0 쪽) ══ */
{
  console.log("\n[E. 안전 경계]");
  const { App } = makeApp();
  ok(ids(App._mergePins([P(1), P(2)], [P(1)], null, [])) === "1,2", "E 기준 id 모름(null) + tombstone 없음 → 서버 전용 핀 보존(종전 규칙)");
  ok(ids(App._mergePins(null, [P(1), P(2)], ["1", "2", "3"], [])) === "1,2", "E 서버본 미수신(비배열) → 기준 규칙 미적용(로컬 핀 전부 보존)");
  ok(ids(App._mergePins([P(1), P(2), P(3)], [P(1), P(3), P(6)], ["1", "2", "3"], [])) === "1,2,3,6",
    "E 기준에 있고 서버에도 있는데 로컬에만 없는 핀(tombstone 없음)은 추정으로 지우지 않음");
}

/* ══ F. createdAt 명시 저장 — 생성 지점 3곳 + PinSeries.createdAt 이 명시 필드를 우선 ══ */
{
  console.log("\n[F. createdAt]");
  const a = makeApp();
  a.App._checkboardStart = () => 1; a.App._pinAuthor = () => null; a.App._updateCheckboardQuickStatus = () => {}; a.App._updateSyncBadge = () => {};
  a.sandbox.PinGrid = { render() {} };
  const pin = a.App._placeCheckboardPin({ x: 5, y: 5 });
  ok(pin && Number.isFinite(pin.createdAt) && pin.createdAt === pin.id, "F _placeCheckboardPin: createdAt 명시 저장(= id 시각)");
  // 나머지 두 생성 지점(_confirmPinInstant · 폼 신규 np)은 DOM/업로드 의존이 커 소스 구조로 확인:
  //   핀 객체 리터럴이 id 와 같은 시각 변수로 createdAt 을 함께 싣는가 + id:Date.now() 단독 리터럴 0건
  const lits = appSrc.match(/id: (_now\d)\b[^}]*/g) || [];
  const paired = lits.filter((s) => { const v = s.match(/id: (_now\d)/)[1]; return new RegExp("createdAt: " + v + "\\b").test(s); });
  ok(lits.length >= 3 && paired.length === lits.length, `F 생성 지점 ${lits.length}곳 모두 createdAt 동반(${paired.length}/${lits.length})`);
  ok(!/\bid: Date\.now\(\)/.test(appSrc), "F id: Date.now() 단독 핀 리터럴 0건");
  const ps = {};
  vm.createContext(ps);
  vm.runInContext(seriesSrc + "\n;globalThis.__PS = PinSeries;", ps);
  ok(ps.__PS.createdAt({ id: 1790000000000, createdAt: 1790000000123 }) === 1790000000123, "F PinSeries.createdAt: 명시 필드 우선(35_PhotoBatch._pinTime → 시각 매칭이 이 값을 씀)");
  ok(ps.__PS.createdAt({ id: 1790000000000 }) === 1790000000000, "F 폴백: 필드 없는 옛 핀은 id 파생 유지");
}

/* ══ G. UI(11_UI.js) — 관리자 전용 도구, 선택 → 선택 삭제 N개, 구역 전체 삭제, 트리 즉시 갱신 ══ */
function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => x && set.add(x)), remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle(c, force) { if (force === undefined) { if (set.has(c)) { set.delete(c); return false; } set.add(c); return true; } if (force) set.add(c); else set.delete(c); return !!force; },
    contains: (c) => set.has(c), _set: set,
  };
}
function makeEl(tag) {
  const el = {
    tagName: tag || "div", style: {}, dataset: {}, title: "", value: "", disabled: false, checked: false, type: "",
    _text: "", _html: "", _children: [], _handlers: {}, _attrs: {},
    appendChild(c) { this._children.push(c); return c; },
    insertBefore(c, ref) { const i = this._children.indexOf(ref); if (i < 0) this._children.push(c); else this._children.splice(i, 0, c); return c; },
    get firstChild() { return this._children[0] || null; },
    insertAdjacentHTML(pos, h) { this._html = h + this._html; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    querySelector() { return makeEl("button"); }, querySelectorAll() { return []; }, closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
  };
  Object.defineProperty(el, "textContent", { get() { return this._text; }, set(v) { this._text = v == null ? "" : String(v); } });
  Object.defineProperty(el, "innerHTML", { get() { return this._html; }, set(v) { this._html = String(v); if (v === "") this._children = []; } });
  Object.defineProperty(el, "className", {
    get() { return Array.from(this.classList._set).join(" "); },
    set(v) { this.classList = makeClassList(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c)); },
  });
  el.classList = makeClassList();
  return el;
}
const has = (el, cls) => new RegExp("(^| )" + cls + "( |$)").test(el.className || "");
const walk = (el, out = []) => { (el._children || []).forEach((c) => { out.push(c); walk(c, out); }); return out; };
const click = async (el) => { for (const f of (el._handlers.click || [])) await f({ stopPropagation() {}, target: { closest: () => null } }); };
function makeUIEnv({ admin }) {
  const registry = {};
  const document = { getElementById: (id) => (registry[id] = registry[id] || makeEl()), createElement: (t) => makeEl(t), querySelectorAll: () => [], addEventListener() {} };
  const deck = { id: "d1", name: "ㅁ", deployment_id: "dep1", parent_id: null };
  const State = { mode: "designer", pdfPage: 1, pdfPages: 1, currentDeploymentId: "dep1", activePin: null, zones: [], pins: [P(1), P(2), P(3)] };
  const deleted = [];
  const App = {
    canBulkDeletePins: () => admin,
    deletePins: async (arr, opts) => { deleted.push({ ids: arr.map(String), opts: opts || null }); State.pins = State.pins.filter((p) => !arr.map(String).includes(String(p.id))); return arr.length; },
    deletePin() {}, editPin() {}, focusPin() {}, pinHasContent: () => false,
  };
  const sandbox = { console, document, JSON, Map, Set, State, App, Projects: { decks: [deck], currentProject: { id: "prj1", name: "tes" }, currentDeck: deck, selectDeck() {} }, Zones: { _contains: () => false, focus() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(seriesSrc + "\n" + uiSrc + "\n;globalThis.__UI = UI;", sandbox);
  return { UI: sandbox.__UI, registry, State, deleted };
}
{
  console.log("\n[G. UI — 11_UI.js]");
  const nv = makeUIEnv({ admin: false });
  nv.UI.renderPinList();
  const nvAll = walk(nv.registry["pin-list"]).concat(walk(nv.registry["side-tree"]));
  ok(!nvAll.some((e) => has(e, "pin-bulk-bar") || has(e, "tree-pin-bulk")), "G 비관리자: 일괄삭제 도구 DOM 없음");

  const u = makeUIEnv({ admin: true });
  u.UI.renderPinList();
  const bar = () => walk(u.registry["pin-list"]).find((e) => has(e, "pin-bulk-bar"));
  ok(!!bar() && bar()._children.some((b) => b.textContent === "선택"), "G 관리자: 핀 목록 맨 위 [선택]");
  const treeBulk = () => walk(u.registry["side-tree"]).find((e) => has(e, "tree-pin-bulk"));
  const scopeBtn = () => treeBulk() && treeBulk()._children.find((b) => has(b, "pin-bulk-scope"));
  // [WO 20260930-moderole] 🔴 일괄삭제 범위 버튼이 이제 모드 잎(CHECKER/360) 안에 있다 — 이
  // 픽스처 핀(P())은 전부 360(content) 계열이라 "이 구역 360 핀 전체 삭제" 로 나온다(다른 모드
  // 핀까지 지우지 않는다는 걸 라벨로 드러냄, 의도된 변경).
  ok(!!scopeBtn() && /이 구역 360 핀 전체 삭제 \(3\)/.test(scopeBtn().textContent), "G 트리 구역 노드: [이 구역 360 핀 전체 삭제 (3)] — " + (scopeBtn() && scopeBtn().textContent));

  u.UI.setPinSelectMode(true);
  const items = walk(u.registry["pin-list"]).filter((e) => has(e, "pin-item"));
  ok(items.length === 3 && items.every((it) => it._children.some((c) => has(c, "pin-sel"))), "G 선택 모드: 목록 핀마다 체크박스");
  await click(items[0]);
  const treePins = walk(u.registry["side-tree"]).filter((e) => has(e, "tree-node-pin"));
  const tp3 = treePins.find((n) => />3</.test(n._html));
  ok(treePins.length === 3 && treePins.every((n) => "aria-pressed" in n._attrs), "G 선택 모드: 트리 핀 노드도 선택 상태(aria-pressed)");
  await click(tp3);   // 트리에서 핀 3 선택 → 목록과 같은 선택 상태(SoT)
  const delBtn = bar()._children.find((b) => has(b, "pin-bulk-del"));
  ok(delBtn && delBtn.textContent === "선택 삭제 2개" && !delBtn.disabled, "G 목록·트리 선택 공유 → [선택 삭제 2개] — " + (delBtn && delBtn.textContent));
  await click(delBtn); await tick();
  ok(u.deleted[0] && u.deleted[0].ids.slice().sort().join(",") === "1,3", "G [선택 삭제] → App.deletePins([1,3]) — " + JSON.stringify(u.deleted[0]));
  ok(!u.UI._pinSel.on && u.UI._pinSel.ids.size === 0, "G 삭제 후 선택 모드 종료·선택 비움");

  await click(scopeBtn()); await tick();
  ok(u.deleted[1] && u.deleted[1].ids.join(",") === "2" && u.deleted[1].opts && u.deleted[1].opts.scopeLabel === "이 구역 360", "G [이 구역 360 핀 전체 삭제] → 남은 핀 전부 + scopeLabel");
  // 마지막 핀까지 지운 뒤 트리에 옛 핀이 남지 않는다(종전: renderPinList 조기 return 이 renderTree 를 건너뜀)
  ok(u.State.pins.length === 0 && walk(u.registry["side-tree"]).filter((e) => has(e, "tree-node-pin")).length === 0, "G 전부 삭제 → 트리 핀 노드 0개(즉시 갱신)");
}

console.log(failed ? `\n${failed} FAIL` : "\nALL PASS");
process.exit(failed ? 1 : 0);
