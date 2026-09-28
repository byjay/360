/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p77-draft-pin-restore.test.mjs)
 *
 * 마스터 신고: 체크보드로 핀 6개를 찍었는데 서버 DB 엔 0개 / "번호가 안 보인다" / "핀이 삭제 안 돼".
 * 지휘자 라이브 재현(94b4ed24): 체크보드 핀 1개 → 모드 전환 → 핀 클릭 → 핀이 지도·트리에서 사라짐,
 *   제목이 도면 파일명으로 바뀜, '미저장' 배지는 남음. IndexedDB draft 엔 핀이 있는데 화면엔 없다.
 *
 * 근본원인(로컬 wrangler + 헤드리스 Chrome 실클릭 재현):
 *   ① 모드 전환(편집↔체크보드)이 App.openApp → loadLatestDeployment 를 다시 돌려 "프로젝트의 첫 구역"
 *      서버본으로 State.pins 를 갈아엎었다(보던 구역이 바뀌고 방금 찍은 핀이 사라짐).
 *   ② 서버본 로더(loadDeckDrawing / loadLatestDeployment)가 같은 구역의 dirty draft(저장 안 한 작업분)를
 *      무시했다 → '미저장' 배지만 뜨고 핀은 서버본(0개). 이어서 '저장'하면 빈 목록이 draft 를 덮어 영구 소실.
 *   ③ 두 로더가 동시에 돌면(허브 구역 클릭 = openApp 자동 로드 + selectDeck) 늦게 도착한 쪽이 State 를 덮었다.
 *
 * 실제 모듈 소스(public/js/modules/20_App.js)를 vm 에 그대로 평가한다(목은 DOM/네트워크 경계만).
 * 뮤테이션: 각 수정(① keepDrawing ② _applyDirtyDraft ③ _isCurrentLoad)을 되돌리면 해당 케이스가 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const appSrc = process.env.P77_APP_SRC ? fs.readFileSync(process.env.P77_APP_SRC, "utf8").replace(/\r\n/g, "\n") : rd("public/js/modules/20_App.js");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };
const tick = () => new Promise((r) => setTimeout(r, 0));

/* 어떤 속성/메서드 호출도 받아주는 DOM 요소 스텁(openApp 처럼 DOM 을 많이 만지는 경로용). */
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

function makeEnv({ fetchImpl, drafts = {}, project = { id: "prjX", name: "tes" }, deck = { id: "dckM", name: "ㅁ", deployment_id: "dep1" } } = {}) {
  const els = {};
  const img = () => ({ _src: "", onload: null, onerror: null, complete: false, naturalWidth: 0, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, set src(v) { this._src = v; }, get src() { return this._src; } });
  const document = {
    getElementById: (id) => (els[id] = els[id] || (id === "map-image" ? img() : anyEl())),
    querySelector: () => null, querySelectorAll: () => [],
    body: anyEl(), documentElement: anyEl(), addEventListener() {},
  };
  const saved = [];
  const calls = { loadLatest: 0, renderPinsOnMap: 0, unsaved: [] };
  const State = {
    pins: [], zones: [], annotations: [], checkboardStart: {}, pdfPage: 1, mode: "designer",
    fileType: null, reset() { this.pins = []; this.zones = []; this.annotations = []; this.fileType = null; },
  };
  const UI = {
    $: (id) => document.getElementById(id), text() {}, toggle() {}, hide() {}, show() {}, showScreen() {},
    renderPinsOnMap() { calls.renderPinsOnMap++; }, renderPinList() {}, updatePdfPagination() {},
  };
  const Projects = {
    currentProject: project, currentDeck: deck, decks: [deck],
    load: async () => {}, loadDecks: async () => {}, _renderDecks() {},
  };
  const SyncQueue = {
    loadDraft: async (k) => (drafts[k] ? JSON.parse(JSON.stringify(drafts[k])) : null),
    saveDraft: async (k, d) => { saved.push({ k, d: JSON.parse(JSON.stringify(d)) }); drafts[k] = d; },
    allDraftKeys: async () => Object.keys(drafts),
  };
  const sandbox = {
    console, document, window: { addEventListener() {} }, navigator: { onLine: true }, location: { search: "" },
    State, UI, Projects, SyncQueue,
    Auth: { headers: () => ({}), r2: (u) => u, isDesigner: true },
    Prompt: { toast() {} }, MapCtrl: { applyTransform() {}, fit() {} }, Log: { push() {} },
    PinSeries: { preferredMode: () => "designer", setPreferredMode() {} },
    fetch: fetchImpl, URLSearchParams, AbortController,
    setTimeout: (f, ms) => (ms && ms >= 1000 ? 0 : setTimeout(f, ms)), clearTimeout,
    JSON, Array, Map, Set, Date, Promise, Object, Number, String,
  };
  vm.createContext(sandbox);
  vm.runInContext(appSrc + "\n;globalThis.__App = App;", sandbox);
  const App = sandbox.__App;
  App._markDeckUnsaved = (id, on) => calls.unsaved.push([id, on]);
  return { App, State, Projects, calls, saved, drafts, els, sandbox };
}

const KEY = "prjX::dckM";
const DRAFT_PIN = { id: 1790590833695, x: 6.76, y: 39.43, page: 1, label: "1", checkboard: true };
const depJson = (over = {}) => Object.assign({ id: "dep1", version: 3, pins: "[]", zones: "[]", pages_data: JSON.stringify(["/api/r2/object/a.png"]), file_name: "ARCTIC.pdf" }, over);
const okRes = (j) => ({ ok: true, status: 200, json: async () => j });

/* ══ ① 구역 (재)로드 — 서버본 핀 0개 + dirty draft 핀 1개 → draft 핀이 화면(State)에 복원된다 ══ */
{
  const drafts = { [KEY]: { pins: [DRAFT_PIN], zones: [], pages: ["x"], depId: "dep1", baseVer: 3, dirty: true } };
  const { App, State, calls } = makeEnv({ drafts, fetchImpl: async () => okRes(depJson()) });
  await App.loadDeckDrawing("dep1");
  ok(State.pins.length === 1 && State.pins[0].id === DRAFT_PIN.id, "① loadDeckDrawing: dirty draft 핀 복원(서버 0개여도 1개)");
  ok(App._dirty === true, "① 복원 후 저장 버튼 활성(_dirty) — 서버엔 아직 없다");
  ok(calls.unsaved.some(([id, on]) => id === "dckM" && on === true), "① 구역 '미저장' 배지 유지");
}
/* 형제 로더 — 프로젝트 재진입(loadLatestDeployment) 경로도 같은 규칙 */
{
  const drafts = { [KEY]: { pins: [DRAFT_PIN], zones: [], pages: ["x"], depId: "dep1", baseVer: 3, dirty: true } };
  const fetchImpl = async (u) => String(u).includes("/decks") ? okRes({ data: [{ id: "dckM", deployment_id: "dep1" }] }) : okRes(depJson());
  const { App, State } = makeEnv({ drafts, fetchImpl });
  await App.loadLatestDeployment({ id: "prjX", name: "tes" });
  ok(State.pins.length === 1 && State.pins[0].id === DRAFT_PIN.id, "① loadLatestDeployment(재진입): dirty draft 핀 복원");
}
/* 경계: clean draft / 다른 배포본의 draft 는 얹지 않는다(엉뚱한 도면에 핀 이식 금지) */
{
  const drafts = { [KEY]: { pins: [DRAFT_PIN], pages: ["x"], depId: "depOTHER", dirty: true } };
  const { App, State } = makeEnv({ drafts, fetchImpl: async () => okRes(depJson()) });
  await App.loadDeckDrawing("dep1");
  ok(State.pins.length === 0, "① 경계: 다른 배포본 기준 draft 는 복원 안 함");
  const e2 = makeEnv({ drafts: { [KEY]: { pins: [DRAFT_PIN], pages: ["x"], depId: "dep1", dirty: false } }, fetchImpl: async () => okRes(depJson()) });
  await e2.App.loadDeckDrawing("dep1");
  ok(e2.State.pins.length === 0, "① 경계: 이미 서버 반영된(clean) draft 는 서버본 우선");
}

/* ══ ② 충돌 규칙(_draftVsServer) — 화면 복원과 온라인 업로드가 같은 규칙 ══ */
{
  const { App } = makeEnv({ fetchImpl: async () => okRes({}) });
  const srv = [{ id: 1, label: "A" }, { id: 2, label: "B" }];
  const d = { pins: [{ id: 1, label: "A2" }], zones: [], baseVer: 5 };
  const same = App._draftVsServer(d, srv, [], 5);
  ok(same.pins.length === 1 && same.pins[0].label === "A2", "② 같은 서버 버전 → draft 그대로(로컬에서 지운 핀 2 가 되살아나지 않음)");
  const newer = App._draftVsServer(d, srv, [], 6);
  ok(newer.pins.length === 2 && newer.pins.find((p) => p.id === 1).label === "A2", "② 서버가 더 새로움 → id 병합(서버 전용 핀 보존 + 같은 id 는 draft 우선)");
  const legacy = App._draftVsServer({ pins: [{ id: 9 }] }, srv, [], 5);
  ok(legacy.pins.length === 3, "② 기준 버전 모름(구버전 draft) → 병합(유실 0 쪽으로)");
}

/* ══ ③ 복원 후 '저장' — 서버 PATCH 와 로컬 draft 모두 draft 핀을 담는다(빈 목록으로 덮어쓰기 금지) ══ */
{
  const drafts = { [KEY]: { pins: [DRAFT_PIN], zones: [], pages: ["x"], depId: "dep1", baseVer: 3, dirty: true } };
  const patches = [];
  const fetchImpl = async (u, o) => {
    if (o && o.method === "PATCH") { patches.push(JSON.parse(o.body)); return okRes({ id: "dep1", version: 4 }); }
    return okRes(depJson());
  };
  const { App, State, saved } = makeEnv({ drafts, fetchImpl });
  await App.loadDeckDrawing("dep1");
  App._snapshotPages = async () => ["data:image/png;base64,x"];
  App._buildSourceMeta = async () => null;
  const r = await App._saveNow({ now: true });
  ok(r === true, "③ 저장 성공");
  const sentPins = patches.length ? JSON.parse(patches[0].pins || "[]") : [];
  ok(sentPins.some((p) => p.id === DRAFT_PIN.id), "③ 서버 PATCH 본문에 draft 핀 포함");
  const lastDraft = saved.filter((s) => s.k === KEY).pop();
  ok(!!lastDraft && lastDraft.d.pins.some((p) => p.id === DRAFT_PIN.id), "③ 로컬 draft 도 핀 보존(0개로 덮이지 않음)");
  ok(State.pins.length === 1, "③ 저장 후 화면 핀 1개 유지");
}

/* ══ ④ 동시 로드 — 먼저 시작한 로드(openApp 자동)가 늦게 도착해도 나중 로드(selectDeck) 결과를 덮지 못한다 ══ */
{
  let releaseSlow;
  const slow = new Promise((r) => { releaseSlow = r; });
  const fetchImpl = async (u) => {
    if (String(u).includes("/decks")) return okRes({ data: [{ id: "dckA", deployment_id: "depA" }] });
    if (String(u).includes("depA")) { await slow; return okRes(depJson({ id: "depA", pins: JSON.stringify([{ id: 77 }]), file_name: "FIRST.pdf" })); }
    return okRes(depJson({ pins: JSON.stringify([{ id: 5 }]) }));
  };
  const { App, State, Projects } = makeEnv({ fetchImpl });
  const first = App.loadLatestDeployment({ id: "prjX", name: "tes" });   // openApp 가 await 없이 띄운 로드
  await tick(); await tick();
  Projects.currentDeck = { id: "dckM", name: "ㅁ", deployment_id: "dep1" };
  await App.loadDeckDrawing("dep1");                                       // 사용자가 연 구역
  releaseSlow(); await first; await tick();
  ok(State.pins.length === 1 && State.pins[0].id === 5, "④ 늦게 도착한 첫 로드가 State.pins 를 덮지 않음");
  ok(Projects.currentDeck.id === "dckM", "④ 현재 구역도 빼앗기지 않음");
}

/* ══ ⑤ 모드 전환(편집↔체크보드)은 도면을 다시 불러오지 않는다 ══ */
{
  const { App, State, calls } = makeEnv({ fetchImpl: async () => okRes({}) });
  App.loadLatestDeployment = async () => { calls.loadLatest++; State.pins = []; };
  App._checkboardStart = () => 1; App._updateCheckboardQuickStatus = () => {}; App._renderIconPicker = () => {};
  App._closePinForm = () => {}; App._flushDeckLinkQueue = () => {};
  State.fileType = "image"; State.pins = [DRAFT_PIN];
  App.openApp("checkboard", { project: { id: "prjX", name: "tes" }, keepDrawing: true });
  App.openApp("designer", { project: { id: "prjX", name: "tes" }, keepDrawing: true });
  ok(calls.loadLatest === 0 && State.pins.length === 1, "⑤ keepDrawing 전환: 재로드 0회 · 핀 유지");
  App.openApp("designer", { project: { id: "prjX", name: "tes" } });
  ok(calls.loadLatest === 1, "⑤ 프로젝트 진입(keepDrawing 없음)은 종전대로 로드");
  // 전환 버튼 호출부가 실제로 keepDrawing 을 넘기는지(위 동작이 버튼 경로에 연결돼 있는지)
  const toggleCall = /const next = State\.checkboard \? "designer" : "checkboard";[\s\S]{0,400}?App\.openApp\(next, \{[^}]*keepDrawing: true/.test(appSrc);
  ok(toggleCall, "⑤ 체크보드 전환 버튼(toggleCheckboard)이 keepDrawing:true 로 openApp 호출");
}

/* ══ ⑥ 복원된 핀 삭제 — Prompt.confirm 모달: 취소면 유지, 확인이면 화면·draft 에서 모두 제거 ══ */
{
  const drafts = { [KEY]: { pins: [DRAFT_PIN], zones: [], pages: ["x"], depId: "dep1", baseVer: 3, dirty: true } };
  const { App, State, saved, sandbox } = makeEnv({ drafts, fetchImpl: async () => okRes(depJson()) });
  await App.loadDeckDrawing("dep1");
  App._snapshotPages = async () => ["data:image/png;base64,x"];
  App._closePinForm = () => {};
  let answer = false; const asked = [];
  sandbox.Prompt = { toast() {}, confirm: async (t) => { asked.push(t); return answer; } };
  const r1 = await App.deletePin(DRAFT_PIN.id);
  ok(r1 === false && State.pins.length === 1 && asked[0] === "포인트 삭제", "⑥ 취소 → '포인트 삭제' 모달이 떴고 핀 유지");
  answer = true;
  const r2 = await App.deletePin(DRAFT_PIN.id);
  await tick(); await tick();
  const lastDraft = saved.filter((x) => x.k === KEY).pop();
  ok(r2 === true && State.pins.length === 0, "⑥ 확인 → 화면(State) 에서 제거");
  ok(!!lastDraft && lastDraft.d.pins.length === 0 && lastDraft.d.dirty === true, "⑥ 확인 → draft 에서도 제거(dirty — 저장 대기)");
}

console.log(failed ? `\n${failed} FAIL` : "\nALL PASS");
process.exit(failed ? 1 : 0);
