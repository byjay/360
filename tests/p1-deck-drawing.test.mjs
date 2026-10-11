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
    navigator: { onLine: true },
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
  // ③ 🔴 [WO 20260928·마스터 확정 — 정책 반전] 구역 자동생성 금지.
  //    옛 ensureDeck() 은 구역이 0개면 이름을 묻지 않고 "구역 1" 자동 이름으로 구역을 만들어
  //    "도면 등록 = 구역 생성" 을 강제했다. 마스터 원문("프로젝트에 처음 도면 등록 시에는 그냥
  //    등록만 해")에 따라 그 API 자체가 사라져야 한다. 이전 버전의 ③은 사라진 정책을 검사하고
  //    있었으므로 **반전된 계약**으로 대체한다(삭제 아님 — 되돌아오면 잡힌다).
  {
    const { P, calls } = makeProjects(projectsSrc, { pickResult: null });
    ok(typeof P.ensureDeck === "undefined", `③ 자동생성 API ensureDeck() 제거됨 (실제 ${typeof P.ensureDeck})`);
    ok(!/"구역 1"/.test(projectsSrc), "③ '구역 1' 자동 이름 하드코딩 0건");
    ok(calls.post === 0, `③ 아무 호출 없이 구역이 만들어지지 않음 (POST ${calls.post})`);
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

/* ────────────────────────────────────────────────────────────
 * P4 — App._deployToViewer() 구역↔배포본 정합
 *   (a) 프로젝트/구역 컨텍스트가 없으면 /tables/deployments POST 에 도달하면 안 된다(고아 배포본 금지)
 *   (b) 배포 후 반드시  구역.deployment_id === State.autoSaveDepId  (불변식)
 *   (c) 기존 배포본이 있으면 배포는 새 배포본을 만들지 않는다(PATCH 만)
 * ──────────────────────────────────────────────────────────── */
function runDeploy(appSrc, { deck, autoSaveDepId }) {
  const calls = { post: 0, patch: 0, link: [], alerts: [], status: "" };
  const cl = () => ({ add() {}, remove() {}, toggle() {}, contains: () => false });
  const statusEl = { classList: cl(), textContent: "", innerHTML: "" };
  const btnEl = { classList: cl(), disabled: false, textContent: "", innerHTML: "" };
  const sandbox = {
    console, setTimeout, clearTimeout,
    navigator: { onLine: true },
    alert: (m) => { calls.alerts.push(m); },
    location: { origin: "https://scan360.pages.dev", pathname: "/" },
    State: {
      mode: "designer", pins: [{ id: "p1", x: 1, y: 2 }], zones: [], annotations: [],
      fileType: "image", fileName: "d.png", pdfPages: 1, viewerPages: null,
      autoSaveDepId, currentDeploymentId: autoSaveDepId, depVersion: 0
    },
    UI: { $: (id) => (id === "btn-deploy" ? btnEl : id === "deploy-status" ? statusEl : { classList: cl(), style: {}, textContent: "", innerHTML: "" }) },
    Auth: { headers: () => ({}), idToken: "t", user: { email: "a@b.c" }, isDesigner: true },
    Prompt: { toast: (t) => { calls.toast = t; } },
    Log: { push() {} },
    Zones: { serialize: () => "[]" },
    Projects: { currentProject: deck ? { id: "prj1" } : null, currentDeck: deck, _renderDecks() {}, decks: deck ? [deck] : [] },
    document: { getElementById: () => null, createElement: () => ({ classList: cl(), style: {} }), body: { appendChild() {}, removeChild() {} } },
    fetch: async (url, opt) => {
      const method = (opt && opt.method) || "GET";
      if (method === "POST" && /\/tables\/deployments$/.test(url)) {
        calls.post++;
        return { ok: true, status: 200, json: async () => ({ id: "dep_new", version: 1 }) };
      }
      if (method === "PATCH" && /\/tables\/deployments\//.test(url)) {
        calls.patch++;
        return { ok: true, status: 200, json: async () => ({ id: "dep_old", version: 1 }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appSrc + "\n;globalThis.__A = App;", sandbox);
  const A = sandbox.__A;
  // 리프(I/O) 헬퍼만 대체 — 검사 대상인 _deployToViewer / _saveNow / _createInitialSave /
  // _patchDeployment / _buildSavePayload 는 실제 소스 그대로 돈다.
  // [WO 20261011-viewmode 회귀수정] _pickDeployMode 는 실 DOM 모달(사용자 클릭 대기)이다 — 이
  // 최소 sandbox 에는 모달 UI가 없다(지휘자 재현: TypeError modal.setAttribute is not a function).
  // 다른 리프 I/O와 같은 방식으로 대체(둘다/null 선택 = 종전 동작과 동일한 범위).
  A._pickDeployMode   = async () => null;
  A._snapshotPages    = async () => ["data:image/jpeg;base64,AAAA"];
  A._uploadPagesToR2  = async (p) => p;
  A._saveDraftLocal   = async () => {};
  A._markDraftClean   = async () => {};
  A._setSaveIndicator = (s) => { calls.status = s; };
  A._updateSaveBtn    = () => {};
  A._markDeckUnsaved  = () => {};
  A._deckIdOfKey      = () => null;
  A._draftKey         = () => "prj1::deck1";
  A._linkDeckDeployment = async (deckId, depId) => { calls.link.push([deckId, depId]); return true; };
  return A._deployToViewer().then(() => ({ calls, State: sandbox.State, deck }));
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

console.log("\n[P4 배포↔구역 정합 — 현재 코드]");
{
  // (a) 컨텍스트(프로젝트+구역) 없음 → 고아 배포본 POST 금지
  const { calls } = await runDeploy(appSrc, { deck: null, autoSaveDepId: null });
  ok(calls.post === 0, `컨텍스트 없는 배포의 deployments POST = ${calls.post} (기대 0)`);
  ok(calls.patch === 0, `컨텍스트 없는 배포의 PATCH = ${calls.patch} (기대 0)`);
  ok(calls.status === "error", `저장 인디케이터 = ${calls.status} (기대 error)`);
}
{
  // (b)+(c) 구역에 이미 배포본이 있음 → 새 POST 없이 PATCH, 그리고 구역이 작업본 ID 를 가리킨다
  const deck = { id: "deck1", name: "ZONE A", deployment_id: "dep_stale" };
  const { calls, State } = await runDeploy(appSrc, { deck, autoSaveDepId: "dep_old" });
  ok(calls.post === 0, `기존 배포본 재배포 시 새 POST = ${calls.post} (기대 0 — 중복 배포본 금지)`);
  ok(calls.patch === 1, `기존 배포본 PATCH = ${calls.patch} (기대 1)`);
  ok(State.autoSaveDepId === "dep_old", `작업본 ID 유지 = ${State.autoSaveDepId}`);
  ok(String(deck.deployment_id) === String(State.autoSaveDepId),
    `[불변식] 구역.deployment_id(${deck.deployment_id}) === autoSaveDepId(${State.autoSaveDepId})`);
  ok(calls.link.length === 1 && calls.link[0][1] === "dep_old", `서버 재연결 PUT 발행 = ${JSON.stringify(calls.link)}`);
}
{
  // 신규(컨텍스트 있음) → POST 1회 + 구역 연결
  const deck = { id: "deck1", name: "ZONE A", deployment_id: null };
  const { calls, State } = await runDeploy(appSrc, { deck, autoSaveDepId: null });
  ok(calls.post === 1, `신규 배포 POST = ${calls.post} (기대 1)`);
  ok(String(deck.deployment_id) === String(State.autoSaveDepId) && State.autoSaveDepId === "dep_new",
    `[불변식] 신규 구역.deployment_id(${deck.deployment_id}) === autoSaveDepId(${State.autoSaveDepId})`);
}

{
  // 뮤테이션 ①: 배포가 _saveNow 를 우회해 직접 POST 하던 옛 경로로 되돌리면
  //   컨텍스트 없는 배포에서 고아 배포본이 다시 생겨야 한다.
  const mutApp = appSrc.replace(
    "        const saved = await this._saveNow({ now: true, withPages: true });",
    "        const saved = await fetch('/tables/deployments', { method: 'POST', headers: Auth.headers(), body: '{}' }).then(r => r.json()).then(r => { State.autoSaveDepId = r.id; return true; });"
  );
  console.log("\n[P4 뮤테이션① — 배포 전용 POST 경로 복원 → 고아 배포본 재현되어야 함]");
  if (mutApp === appSrc) { ok(false, "뮤테이션① 앵커 없음"); }
  else {
    const { calls } = await runDeploy(mutApp, { deck: null, autoSaveDepId: null });
    ok(calls.post === 1, `무력화 시 고아 배포본 POST 재현 (POST ${calls.post})`);
  }
}
{
  // 뮤테이션 ②: 불변식 재연결 블록의 '다르면 재연결' 조건을 옛 '비어있을 때만 연결'로 되돌리면
  //   구역이 옛(stale) ID 를 계속 가리켜 불변식이 깨져야 한다.
  const mutApp = appSrc.replace(
    'if (cd && String(cd.deployment_id || "") !== String(depId)) {',
    'if (cd && !cd.deployment_id) {'
  );
  console.log("[P4 뮤테이션② — 재연결 가드를 '비어있을 때만'으로 되돌림 → 불변식 깨져야 함]");
  if (mutApp === appSrc) { ok(false, "뮤테이션② 앵커 없음"); }
  else {
    const deck = { id: "deck1", name: "ZONE A", deployment_id: "dep_stale" };
    const { State } = await runDeploy(mutApp, { deck, autoSaveDepId: "dep_old" });
    ok(String(deck.deployment_id) !== String(State.autoSaveDepId),
      `무력화 시 stale 링크 재현 (deck=${deck.deployment_id}, autoSave=${State.autoSaveDepId})`);
  }
}

console.log("\n" + (failed ? "FAILED " + failed : "ALL PASS"));
process.exit(failed ? 1 : 0);
