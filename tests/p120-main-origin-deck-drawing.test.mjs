/**
 * p120 — WO 20261002-allmenu §5: 메인 PDF 원본 노드 항상 표시 + 구역별 도면 등록/교체 + 메인 교체(소유자·super, 확인창)
 * (프레임워크 0 · 실행: node tests/p120-main-origin-deck-drawing.test.mjs)
 *
 * [재현] 지휘자 R2: 375px 허브 카드 클릭 → 트리 "구역이 없습니다." + 원본 노드 없음
 *   (11_UI.js early return `if (!proj) { host.innerHTML = …; return; }` 가 원본 노드보다 먼저) → FAIL.
 *   offline2 팀은 타이밍 재현 실패[Uncertain] → 타이밍 무관하게 구조로 막았는지(proj 없음/decks 0) 검사한다.
 *
 * 🔴 목 금지 — 11_UI.js·12_ProjectHub.js·20_App.js 실제 소스를 vm 에 실행. 가짜는 DOM 셸·네트워크(fetch)·
 *   파일 선택창(_pickDrawingFile)·스냅샷 경계뿐(p92/p77 과 같은 경계).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const uiSrc = rd("public/js/modules/11_UI.js");
const hubSrc = rd("public/js/modules/12_ProjectHub.js");
const appSrc = rd("public/js/modules/20_App.js");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };

/* ── 최소 DOM(p115 패턴) ── */
function makeEl(tag) {
  const set = new Set();
  const el = {
    tagName: tag || "div", style: {}, dataset: {}, title: "", _html: "", _children: [], _handlers: {}, attrs: {},
    classList: { add: (...c) => c.forEach((x) => x && set.add(x)), remove: (...c) => c.forEach((x) => set.delete(x)), contains: (c) => set.has(c),
      toggle(c, f) { if (f === undefined) { if (set.has(c)) { set.delete(c); return false; } set.add(c); return true; } if (f) set.add(c); else set.delete(c); return !!f; } },
    appendChild(c) { this._children.push(c); c.parentNode = this; return c; },
    removeChild(c) { const i = this._children.indexOf(c); if (i >= 0) this._children.splice(i, 1); return c; },
    insertAdjacentHTML(pos, h) { this._html += h; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); },
    querySelector() { return null; }, querySelectorAll() { return []; }, contains() { return false; },
    getBoundingClientRect() { return { left: 10, top: 10, bottom: 40, right: 40, width: 30, height: 30 }; },
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; this._children = []; },
    get textContent() { return this._text || this._html.replace(/<[^>]+>/g, ""); }, set textContent(v) { this._text = String(v); },
  };
  Object.defineProperty(el, "className", { get() { return Array.from(set).join(" "); }, set(v) { set.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => set.add(c)); } });
  return el;
}
const findAll = (node, cls) => { let out = []; (node._children || []).forEach((c) => { if (c.classList && c.classList.contains(cls)) out.push(c); out = out.concat(findAll(c, cls)); }); return out; };

function loadUI(ctx) {
  const host = makeEl("div");
  const body = makeEl("body");
  const doc = { createElement: (t) => makeEl(t), getElementById: (id) => (id === "side-tree" ? host : null), body, addEventListener() {}, removeEventListener() {} };
  const sandbox = Object.assign({ document: doc, console, setTimeout, App: {}, PinSeries: {}, RegionMerge: undefined, Requests: undefined }, ctx);
  vm.createContext(sandbox);
  vm.runInContext(uiSrc + "\nthis.UI = UI;", sandbox);
  return { UI: sandbox.UI, host, body, sandbox };
}
// pickOriginalDeck/pickMainOrOpen — 31_Projects.js 실제 함수 본문을 그대로 꺼내 쓴다(SoT 재사용, 사본 금지)
const projSrc = rd("public/js/modules/31_Projects.js");
const pickSrc = (() => { const i = projSrc.indexOf("    pickOriginalDeck(decks, project) {"); const j = projSrc.indexOf("\n    },", i); return projSrc.slice(i + 4, j + 6); })();
const pickMainOrOpenSrc = (() => { const i = projSrc.indexOf("    pickMainOrOpen(decks, project) {"); const j = projSrc.indexOf("\n    },", i); return projSrc.slice(i + 4, j + 6); })();
function makeProjects(o, State) {
  const P = Object.assign({ currentProject: null, currentDeck: null, decks: [], list: [], openOriginal() { P._opened = true; }, setOriginalToCurrent() {}, selectDeck: async (d) => { P.currentDeck = d; } }, o);
  P.pickOriginalDeck = new Function("UI", "return ({" + pickSrc + "}).pickOriginalDeck;")(undefined).bind(P);
  // [WO 20261106-originfallback] pickMainOrOpen 은 소스에서 바깥 스코프 State 를 참조한다 — "State" 를
  // 팩토리 매개변수로 선언해 호출부가 넘긴 실제 State(없으면 빈 객체)로 닫는다(UI 트릭과 같은 방식).
  P.pickMainOrOpen = new Function("State", "return ({" + pickMainOrOpenSrc + "}).pickMainOrOpen;")(State || {}).bind(P);
  return P;
}

/* ══ A. R2 — 원본 노드는 어떤 상태에서도 최상단에 ══ */
console.log("\n[A. 원본 노드 항상 표시 — 실제 11_UI.renderTree]");
{
  // A1: 허브 카드 클릭 직후 — currentProject 아직 null, decks 0, State.currentProjectId 만 있음(타이밍 창)
  const Projects = makeProjects({ list: [{ id: "prjR", name: "알파호", original_deployment_id: "depM", can_manage_members: true }] });
  const State = { mode: "designer", pdfPage: 1, pdfPages: 1, pins: [], zones: [], currentProjectId: "prjR", currentProjectName: "알파호" };
  const { UI, host } = loadUI({ State, Projects });
  UI.renderTree();
  const first = host._children[0];
  const pj = findAll(host, "tree-node-project")[0];
  ok(!!pj && /알파호/.test(pj.innerHTML), "A1 currentProject=null 이어도 State.currentProjectId 로 프로젝트 노드를 그린다");
  const on = findAll(host, "tree-node-origin");
  ok(on.length === 1, "A2 원본 노드 1개");
  const pw = first;
  const afterHead = pw && pw._children && pw._children.find((c) => !c.classList.contains("tree-node-project"));
  ok(!!afterHead && afterHead.classList.contains("tree-node-origin"), "A3 원본 노드 = 프로젝트 바로 아래 첫 줄");
}
{
  // A4: 프로젝트 정보가 전혀 없음(열람자 링크·오프라인) + decks 0 — 종전 early return 경로
  const Projects = makeProjects({});
  const State = { mode: "viewer", pdfPage: 1, pdfPages: 1, pins: [], zones: [], currentDeploymentId: "depV", fileName: "GA.pdf" };
  const { UI, host } = loadUI({ State, Projects });
  UI.renderTree();
  ok(host._children[0] && host._children[0].classList.contains("tree-node-origin"), "A4 proj 없음 + 구역 0 → 원본 노드가 '구역이 없습니다' 보다 먼저");
  ok(/GA\.pdf/.test(host._children[0].innerHTML), "A5 표시 근거 = 지금 열린 도면 이름(지어내지 않음) → " + host._children[0].textContent);
  ok(/구역이 없습니다/.test(host.innerHTML) && host._children.length === 1, "A6 안내 문구 유지(종전 마크업 그대로) + 원본 노드 1개만 추가");
}
{
  // A7: proj 없음 + 구역 있음 → 원본이 구역보다 위
  const Projects = makeProjects({ decks: [{ id: "d1", name: "구역1", deployment_id: "depM", parent_id: null }] });
  const State = { mode: "viewer", pdfPage: 1, pdfPages: 1, pins: [], zones: [] };
  const { UI, host } = loadUI({ State, Projects });
  UI.renderTree();
  ok(host._children[0] && host._children[0].classList.contains("tree-node-origin") && host._children[1] && host._children[1].classList.contains("tree-deck"), "A7 proj 없음 + 구역 있음 → 원본 노드가 구역 위");
}

/* ══ B. 원본 ⋯ 메뉴 — 메인 교체는 숨기지 않고 권한 없으면 비활성 + 사유 ══ */
console.log("\n[B. 원본 ⋯ 메뉴 · 구역 출처 표시]");
{
  const proj = { id: "prjB", name: "베타", original_deployment_id: "depM", can_manage_members: false };
  const decks = [
    { id: "dM", name: "메인", deployment_id: "depM", parent_id: null, crop: null },
    { id: "dW", name: "창구역", deployment_id: "depM", parent_id: null, crop: { x: 10, y: 10, w: 20, h: 20 }, page: 1 },
    { id: "dO", name: "별도구역", deployment_id: "depO", deployment_file_name: "deck.pdf", parent_id: null, crop: null },
    { id: "dN", name: "빈구역", deployment_id: null, parent_id: null }
  ];
  const Projects = makeProjects({ currentProject: proj, decks });
  const State = { mode: "designer", pdfPage: 1, pdfPages: 1, pins: [], zones: [] };
  const Auth = { isDesigner: true, readonly: false, isSuper: false };
  const { UI, host } = loadUI({ State, Projects, Auth });
  UI.renderTree();
  const items = UI.originMenuItems(proj, Projects.pickOriginalDeck(decks, proj));
  const rep = items.find((i) => i.label === "메인 도면 교체");
  ok(!!rep && rep.reason === "소유자·관리자 전용", "B1 비소유 디자이너 → [메인 도면 교체] 항목은 있고 사유 '소유자·관리자 전용'");
  proj.can_manage_members = true;
  const rep2 = UI.originMenuItems(proj, Projects.pickOriginalDeck(decks, proj)).find((i) => i.label === "메인 도면 교체");
  ok(!!rep2 && !rep2.reason, "B2 소유자 → 활성");
  const src = (id) => UI.deckSourceOf(decks.find((d) => d.id === id), "depM", decks);
  ok(src("dW").label === "잘라옴" && src("dO").label === "별도 등록 · deck.pdf" && src("dM").kind === "main" && src("dN").kind === "none",
    "B3 출처: 창=잘라옴 · 별도=별도 등록 · 파일명 · 메인=main · 미등록=none");
  const heads = findAll(host, "tree-node-deck").map((h) => h.innerHTML);
  ok(heads.some((h) => /tree-src-crop[^>]*>잘라옴/.test(h)) && heads.some((h) => /tree-src-own[^>]*>별도 등록 · deck\.pdf/.test(h)), "B5 트리 구역 행에 출처 꼬리표가 실제로 그려진다");
  ok(heads.every((h) => /class="tree-more"/.test(h)), "B6 모든 구역 행에 ⋯ 메뉴");
  const dm = UI.deckMenuItems(decks[1], "depM").find((i) => !i.info);
  ok(dm.label === "이 구역 도면 따로 등록" && !dm.reason, "B7 창 구역 ⋯ → [이 구역 도면 따로 등록] 활성");
  State.mode = "viewer";
  const dv = UI.deckMenuItems(decks[2], "depM").find((i) => !i.info);
  ok(dv.label === "도면 교체" && /디자이너\(편집\) 전용/.test(dv.reason), "B8 열람 화면 → 항목은 남기고 비활성 + 사유");
  // ⋯ 팝오버: 비활성 항목 클릭 → 실행 안 됨
  let ran = 0;
  const pop = UI.openTreeMenu(makeEl("span"), "t", [{ label: "x", reason: "소유자·관리자 전용", run: () => ran++ }]);
  const b = pop._children.find((c) => c.classList.contains("tree-pop-item"));
  b._handlers.click[0]({ stopPropagation() {} });
  ok(ran === 0 && b.attrs["aria-disabled"] === "true" && /소유자·관리자 전용/.test(b.innerHTML), "B9 팝오버 비활성 항목 = 사유 글자 표시 + 클릭해도 실행 0");
  UI.closeTreeMenu();
}

/* ══ C. 허브 카드 — 원본 줄 항상 ══ */
console.log("\n[C. 허브 카드 원본 줄 — 실제 12_ProjectHub._renderDeckTreeHtml]");
{
  const { UI } = loadUI({ State: {}, Projects: makeProjects({}) });
  const sb = { console, UI, PinSeries: { DECK_MODES: [] }, document: { getElementById: () => null }, window: {}, location: { hostname: "x", protocol: "https:", origin: "https://x" } };
  vm.createContext(sb);
  vm.runInContext(hubSrc + "\nthis.ProjectHub = ProjectHub;", sb);
  const H = sb.ProjectHub;
  const p = { id: "prjC", name: "c", original_deployment_id: "depM" };
  H._deckTreeCache = {};
  const undef = H._renderDeckTreeHtml(p);
  H._deckTreeCache.prjC = [];
  const empty = H._renderDeckTreeHtml(p);
  H._deckTreeCache.prjC = [{ id: "d1", name: "구역1", deployment_id: "depM", parent_id: null }];
  const full = H._renderDeckTreeHtml(p);
  const firstIsOrigin = (h) => /^<div class="hub-card-tree"><div class="hub-tree-origin"/.test(h);
  ok(firstIsOrigin(undef) && !/구역 없음/.test(undef), "C1 구역 목록 로딩 전(캐시 없음) → 원본 줄만(‘구역 없음’ 단정 안 함)");
  ok(firstIsOrigin(empty) && /구역 없음/.test(empty), "C2 구역 0개 → 원본 줄 + 구역 없음");
  ok(firstIsOrigin(full) && /hub-tree-deck/.test(full), "C3 구역 있음 → 원본 줄이 구역 위");
  ok(/메인 PDF/.test(full) && /미지정/.test(H._renderDeckTreeHtml({ id: "q", name: "q" })), "C4 표시 근거 = original_deployment_id(없으면 미지정)");
}

/* ══ D. 등록 계획(SoT) + 실제 _loadDrawing → _afterDrawingLoaded → 저장 연결 ══ */
console.log("\n[D. 20_App 등록 계획 — 메인 불변 · 구역 별도 · 메인 교체]");
function anyEl() {
  const store = {};
  const fn = function () { return proxy; };
  const proxy = new Proxy(fn, { get(t, k) { if (k in store) return store[k]; if (k === Symbol.toPrimitive) return () => ""; if (k === "then") return undefined; if (k === "contains") return () => false; return proxy; }, set(t, k, v) { store[k] = v; return true; }, apply() { return proxy; } });
  return proxy;
}
function makeApp({ decks, proj, currentDeck, owner = true, confirmAns = true, curDep = null }) {
  const els = {};
  const { UI: realUI } = loadUI({ State: {}, Projects: makeProjects({}) });
  const calls = { toast: [], confirm: [], fetch: [], picked: 0 };
  const State = { pins: [], zones: [], annotations: [], pdfPage: 1, mode: "designer", fileType: "image", pinTombstones: {}, pinBaseIds: null, currentDeploymentId: curDep, depVersion: 7,
    reset() { this.pins = []; this.zones = []; this.fileType = null; this.pinTombstones = {}; this.pinBaseIds = null; this.autoSaveDepId = null; this.depVersion = 0; } };
  const Projects = makeProjects({ currentProject: proj, decks, currentDeck }, State);
  const uiStub = new Proxy({ $: (id) => (els[id] = els[id] || anyEl()), deckSourceOf: realUI.deckSourceOf.bind(realUI) }, { get(t, k) { return k in t ? t[k] : () => {}; } });
  const sandbox = {
    console, window: { addEventListener() {} }, navigator: { onLine: true }, location: { search: "" },
    document: { getElementById: (id) => (els[id] = els[id] || anyEl()), querySelector: () => null, querySelectorAll: () => [], body: anyEl(), addEventListener() {} },
    State, UI: uiStub, Projects,
    Auth: { headers: () => ({}), isDesigner: true, readonly: false, isSuper: false },
    Prompt: { toast(m) { calls.toast.push(m); }, confirm: async (t, m) => { calls.confirm.push(t); return confirmAns; } },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} }, Log: { push() {} }, MapCtrl: { applyTransform() {}, fit() {} }, Zones: { render() {} },
    fetch: async (u, o) => { calls.fetch.push({ u, o }); return { ok: true, status: 200, json: async () => ({}) }; },
    setTimeout: (f, ms) => (ms && ms >= 1000 ? 0 : setTimeout(f, ms)), clearTimeout, JSON, Array, Map, Set, Date, Promise, Object, Number, String,
  };
  vm.createContext(sandbox);
  vm.runInContext(appSrc + "\n;globalThis.__App = App;", sandbox);
  const App = sandbox.__App;
  Object.assign(App, { _snapshotPages: async () => ["data:x"], _saveDraftLocal: async () => {}, _pruneDraftSources() {}, _closePinForm() {}, _setSaveIndicator() {}, _markDirty() {}, _openSidebarSheet() {}, _releasePdfDocs() {} });
  App._pickDrawingFile = async () => { calls.picked++; return { name: "new.png", type: "image/png" }; };
  proj.can_manage_members = owner;
  return { App, State, Projects, calls };
}
const MAIN = "depM";
const mkDecks = () => [
  { id: "dM", name: "메인", deployment_id: MAIN, parent_id: null, crop: null },
  { id: "dW", name: "창구역", deployment_id: MAIN, parent_id: null, crop: { x: 10, y: 10, w: 20, h: 20 }, page: 1, src_dep_id: null },
  { id: "dO", name: "별도구역", deployment_id: "depO", parent_id: null, crop: null }
];
{
  const decks = mkDecks();
  const { App } = makeApp({ decks, proj: { id: "p", original_deployment_id: MAIN }, currentDeck: null });
  ok(App._drawingPlan(decks[1], null).mode === "separate", "D1 창(crop·메인 공유) 구역 → separate(새 배포본, 메인 불변)");
  ok(App._drawingPlan(decks[2], null).mode === "replace", "D2 자기 도면 구역 → replace(그 구역 배포본)");
  ok(!!App._drawingPlan(decks[0], null).blocked, "D3 메인 자신(루트·전체) 구역에 일반 업로드 → 차단(메인 교체는 원본 ⋯ 로만)");
  ok(App._drawingPlan({ id: "x", deployment_id: null }, null).mode === "link", "D4 도면 없는 구역 → link");
}
{
  // D5: 창 구역에서 실제 업로드 → 메인 PATCH 금지, 저장 시 새 배포본 + 그 구역에 crop/src 해제 PUT
  const decks = mkDecks();
  const { App, State, calls } = makeApp({ decks, proj: { id: "p", original_deployment_id: MAIN }, currentDeck: decks[1], curDep: MAIN });
  await App._loadDrawing({ name: "z.png", type: "image/png" });
  await App._afterDrawingLoaded();
  ok(State.autoSaveDepId == null, "D5 창 구역 업로드 → autoSaveDepId 비움(메인 배포본 PATCH 안 함) → " + State.autoSaveDepId);
  ok(App._pendingDeckLink && App._pendingDeckLink.deckId === "dW" && App._pendingDeckLink.detach === true, "D6 저장 시 새 배포본을 이 구역에 연결 + detach");
  App._createInitialSave = async () => { State.autoSaveDepId = "depNEW"; };
  App._refreshUnsavedDecks = () => {}; App._markDeckUnsaved = () => {}; App._updateSaveBtn = () => {};
  await App._saveNow({ silent: true });
  const put = calls.fetch.find((f) => /\/api\/decks\/dW$/.test(f.u));
  const body = put ? JSON.parse(put.o.body) : {};
  ok(put && body.deployment_id === "depNEW" && body.crop === null && body.page === null && body.src_dep_id === null && body.src_page === null && body.src_crop === null,
    "D7 PUT /api/decks/dW = {deployment_id:depNEW, crop/page/src_* = null} → " + JSON.stringify(body));
  ok(!calls.fetch.some((f) => /deployments\/depM/.test(f.u)), "D8 메인 배포본(depM)으로 가는 요청 0건");
  ok(decks[1].crop === null && decks[1].deployment_id === "depNEW", "D9 로컬 구역 객체도 같은 상태(창 해제 + 새 배포본)");
}
{
  // D10: 메인 교체 — 비소유자는 확인창·파일창 모두 열지 않는다
  const decks = mkDecks();
  const { App, calls } = makeApp({ decks, proj: { id: "p", original_deployment_id: MAIN }, currentDeck: decks[0], owner: false, curDep: MAIN });
  await App.registerDrawingFor({ kind: "main" });
  ok(calls.confirm.length === 0 && calls.picked === 0 && calls.toast.some((t) => /소유자·관리자 전용/.test(t)), "D10 비소유자 [메인 도면 교체] → 확인창·파일창 0, 사유 토스트");
}
{
  // D11: 소유자 — 확인창 취소면 파일창 0 / 확인 → 메인 PATCH 대상 + 핀 이어받기
  const decks = mkDecks();
  const c1 = makeApp({ decks, proj: { id: "p", original_deployment_id: MAIN }, currentDeck: null, owner: true, confirmAns: false, curDep: MAIN });
  await c1.App.registerDrawingFor({ kind: "main" });
  ok(c1.calls.confirm[0] === "메인 도면 교체" && c1.calls.picked === 0, "D11 소유자 → 확인창('메인 도면 교체') 먼저, 취소하면 파일창 0");
  const c2 = makeApp({ decks: mkDecks(), proj: { id: "p", original_deployment_id: MAIN }, currentDeck: null, owner: true, confirmAns: true, curDep: MAIN });
  c2.State.pins = [{ id: 1, x: 5, y: 5, page: 1 }];
  await c2.App.registerDrawingFor({ kind: "main" });
  await c2.App._afterDrawingLoaded();
  ok(c2.calls.picked === 1 && c2.State.autoSaveDepId === MAIN, "D12 확인 → 파일 선택 → 저장 대상 = 메인 배포본(depM) PATCH");
  ok(c2.State.pins.length === 1 && c2.State.depVersion === 7, "D13 메인 교체 후에도 기존 포인트·버전 이어받음(State.reset 이 비운 것 복원)");
}

console.log(failed ? `\nFAIL ${failed}` : "\nALL PASS");
process.exit(failed ? 1 : 0);
