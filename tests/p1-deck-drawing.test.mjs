/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p1-deck-drawing.test.mjs)
 *
 * P1  : "구역을 등록하면 반드시 도면이 등록되어야 한다"
 *       → 도면 파일 선택을 취소하면 구역 POST 자체가 일어나면 안 된다.
 * P0-2: 뷰어→편집모드 전환/기존 배포본 표시만으로 dirty(저장 *)가 켜지면 안 된다.
 *
 * 실제 모듈 소스(public/js/modules/*.js)를 그대로 평가해 검사한다(목 구현 아님).
 * 각 검사에는 뮤테이션(수정 무력화) 케이스가 붙어 있어, 고친 코드를 되돌리면 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, "public/js/modules", f), "utf8");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ────────────────────────────────────────────────────────────
 * P1 — Projects.createDeck()
 * ──────────────────────────────────────────────────────────── */
function makeProjects(projectsSrc, { pickResult }) {
  const calls = { post: 0, getDecks: 0, pick: 0, loadDrawing: [] };
  const el = () => ({
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, dataset: {}, textContent: "", click() { calls.uploadClick = (calls.uploadClick || 0) + 1; },
    innerHTML: "", addEventListener() {}, appendChild() {}, querySelector: () => el()
  });
  const decksOnServer = [];
  const sandbox = {
    console,
    alert: (m) => { calls.alert = m; },
    confirm: () => true,
    document: { getElementById: () => null, createElement: () => el(), body: { appendChild() {} } },
    Auth: { headers: () => ({}), isDesigner: true },
    Prompt: { ask: async () => ({ value: "TEST ZONE" }), toast: (t) => { calls.toast = t; } },
    UI: { renderTree() {} },
    State: { mode: "designer" },
    App: {
      _pickDrawingFile: async () => { calls.pick++; return pickResult; },
      _loadDrawing: async (f) => { calls.loadDrawing.push(f); },
      _refreshUnsavedDecks() {}, isDeckUnsaved: () => false
    },
    fetch: async (url, opt) => {
      const method = (opt && opt.method) || "GET";
      if (method === "POST" && /\/decks$/.test(url)) {
        calls.post++;
        const d = { id: "deck_new", name: "TEST ZONE", project_id: "p1" };
        decksOnServer.push(d);
        return { ok: true, json: async () => d };
      }
      if (method === "GET" && /\/decks$/.test(url)) {
        calls.getDecks++;
        return { ok: true, json: async () => ({ data: decksOnServer.slice() }) };
      }
      return { ok: true, json: async () => ({}) };
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(projectsSrc + "\n;globalThis.__P = Projects;", sandbox);
  const P = sandbox.__P;
  P.currentProject = { id: "p1", name: "PRJ" };
  P.decks = [];
  return { P, calls };
}

async function p1Suite(label, projectsSrc, expect) {
  console.log("\n[" + label + "]");
  // ① 파일 선택 취소 → 구역이 만들어지면 안 된다
  {
    const { P, calls } = makeProjects(projectsSrc, { pickResult: null });
    const r = await P.createDeck();
    ok(calls.post === expect.cancelPost, `취소 시 구역 POST 횟수 = ${calls.post} (기대 ${expect.cancelPost})`);
    ok((r === null) === expect.cancelReturnsNull, `취소 시 반환 null = ${r === null}`);
  }
  // ② 파일 선택 성공 → 구역 POST 1회 + 그 파일로 도면 로드
  {
    const file = { name: "deck.pdf", type: "application/pdf" };
    const { P, calls } = makeProjects(projectsSrc, { pickResult: file });
    const r = await P.createDeck();
    ok(calls.post === 1, `정상 흐름 구역 POST 1회 (실제 ${calls.post})`);
    ok(!!r && r.id === "deck_new", "정상 흐름 생성된 구역 반환");
    ok(calls.loadDrawing.length === expect.okLoads && calls.loadDrawing[0] === (expect.okLoads ? file : undefined),
      `정상 흐름 선택 파일로 _loadDrawing 호출 = ${calls.loadDrawing.length}`);
  }
  // ③ ensureDeck 자동생성(askDrawing:false) → 파일창 없이 생성(무한루프 방지)
  {
    const { P, calls } = makeProjects(projectsSrc, { pickResult: null });
    const r = await P.ensureDeck();
    ok(calls.pick === 0, `ensureDeck 파일창 호출 0회 (실제 ${calls.pick})`);
    ok(!!r && calls.post === 1, "ensureDeck 자동 구역 생성 1회");
    ok(calls.loadDrawing.length === 0, "ensureDeck 도면 로드 안 함");
  }
}

/* ────────────────────────────────────────────────────────────
 * P0-2 — App._showMapViewport() 는 dirty 를 세우지 않는다
 * ──────────────────────────────────────────────────────────── */
function runShowMapViewport(appSrc) {
  const marks = { dirty: 0 };
  const el = () => ({ classList: { add() {}, remove() {}, toggle() {} }, style: {}, textContent: "", innerHTML: "" });
  const sandbox = {
    console,
    State: { mode: "designer", autoSaveDepId: null, pan: {}, zoom: 1, pdfPage: 1 },
    UI: {
      $: () => el(), toggle() {}, text() {}, renderPinsOnMap() {}, renderPinList() {},
      updatePdfPagination() {}, updateRotationLabel() {}, renderPdfThumbs() {}, showScreen() {}
    },
    MapCtrl: { applyTransform() {} },
    document: { body: { classList: { add() {}, remove() {}, toggle() {} } }, getElementById: () => null,
      documentElement: { style: { setProperty() {} } }, querySelectorAll: () => [] },
    setTimeout, clearTimeout, navigator: { onLine: true }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appSrc + "\n;globalThis.__A = App;", sandbox);
  const A = sandbox.__A;
  A._markDirty = () => { marks.dirty++; };
  A._showMapViewport();
  return marks;
}

/* ── 실행 ── */
const projectsSrc = src("31_Projects.js");
const appSrc = src("20_App.js");

await p1Suite("P1 현재 코드 (강제 적용)", projectsSrc,
  { cancelPost: 0, cancelReturnsNull: true, okLoads: 1 });

// 뮤테이션: 취소 가드를 무력화하면 '도면없음' 구역이 다시 생겨야 한다(=위 검사가 깨져야 정상)
const mutated = projectsSrc.replace(
  'if (!picked) {',
  'if (false) {'
);
if (mutated === projectsSrc) { console.log("\n[뮤테이션] 앵커 없음 — 실패"); failed++; }
else {
  console.log("\n[P1 뮤테이션 — 취소 가드 무력화 → 갭 재현되어야 함]");
  const { P, calls } = makeProjects(mutated, { pickResult: null });
  const r = await P.createDeck();
  ok(calls.post === 1 && r !== null, `무력화 시 '도면없음' 구역 생성 재현 (POST ${calls.post})`);
}

console.log("\n[P0-2 현재 코드 — 표시만으로 dirty 금지]");
{
  const m = runShowMapViewport(appSrc);
  ok(m.dirty === 0, `_showMapViewport() 의 _markDirty 호출 = ${m.dirty} (기대 0)`);
}
{
  // 뮤테이션: 제거했던 dirty 블록을 되돌리면 false-dirty 가 재현되어야 한다
  const mutApp = appSrc.replace(
    "      UI.renderPdfThumbs();\n      // [P0-2 false-dirty 수정]",
    "      UI.renderPdfThumbs();\n      if (State.mode === \"designer\" && !State.autoSaveDepId) { this._markDirty(); }\n      // [P0-2 false-dirty 수정]"
  );
  console.log("[P0-2 뮤테이션 — dirty 블록 복원 → false-dirty 재현되어야 함]");
  if (mutApp === appSrc) { ok(false, "뮤테이션 앵커 없음"); }
  else { const m = runShowMapViewport(mutApp); ok(m.dirty === 1, `무력화 시 false-dirty 재현 (_markDirty ${m.dirty})`); }
}

console.log("\n" + (failed ? "FAILED " + failed : "ALL PASS"));
process.exit(failed ? 1 : 0);
