/**
 * p66 — 구역 없이 로드된 도면에서도 "기존 도면에서 영역 지정"이 활성돼야 한다
 * (프레임워크 0 · 실행: node tests/p66-region-source-enabled.test.mjs)
 *
 * 마스터 실사고(2026-09-28, 스크린샷): 프로덕션에서 도면이 화면에 로드돼 있는데도
 * "기존 도면에서 영역 지정" 버튼이 비활성으로 나왔다 — "현재 도면: ㅁ" 이 보이는데도.
 *
 * 근본원인: WO 20260928 이 "도면 등록 ≠ 구역 생성"을 분리하면서 _canExtractFromLoadedDrawing()
 * 의 활성 조건에 `decks.length === 0`(구역이 아예 없을 때만) 이라는 옛 전제를 남겼다.
 * 실제로는 "이미 다른 구역이 있는 프로젝트에서, 아직 저장 전인 도면을 화면에 띄워 놓고
 * 새 구역을 만들려는" 훨씬 흔한 경우가 이 조건에 걸려 비활성이 됐다 — 구역 개수는
 * "화면에 도면이 로드돼 있는가"와 무관한 사실인데 같은 판정에 섞여 있었다.
 *
 * 검증:
 *   ① 도면 로드됨 + 구역 0개 → "기존 도면에서 영역 지정" 활성
 *   ① ' 도면 로드됨 + 구역 N개(이미 존재, currentDeck 은 deployment_id 없음) → 활성(회귀가 아니라 이번 수정의 핵심)
 *   ② 그 경로가 createDeckFromLoadedDrawing 으로 위임
 *   ③ 도면이 구역에 묶인 경우(currentDeck.deployment_id 있음) → extractRegionAsDeck 본경로 유지(회귀)
 *   ④ 도면이 아예 없을 때만 비활성 + 정확한 이유 문구(옛 "구역을 열어야" 문구 아님)
 *   ⑤ 분기 조건이 단일 함수(SoT) — _chooseDeckSource·extractRegionAsDeck 모두 _canExtractFromLoadedDrawing() 호출,
 *     그 함수 자체엔 decks.length 판정이 없다(중복 판정 0)
 *   ⑥ 옛 문구("도면이 등록된 구역을 열어야")가 코드·HTML 어디에도 없다
 *   ⑦ "현재 도면" 라벨이 구역 이름이 아니라 도면 파일명(State.fileName)을 우선한다
 *
 * 🔴 뮤테이션 3건: ⓐ decks.length 조건 복원 → ①' 실패 · ⓑ 위임 분기 제거 → ② 실패 ·
 *   ⓒ 판정을 두 곳(_chooseDeckSource 안에 별도 decks.length 체크)으로 분리 → ⑤ 실패
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

const PROJECTS_SRC = rd("public/js/modules/31_Projects.js");
const INDEX_HTML = rd("public/index.html");

/* ══ DOM 스텁 — id 별로 상태를 유지하는 최소 엘리먼트 ══ */
function makeEl(id) {
  const classes = new Set();
  return {
    id,
    _classes: classes,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    style: {},
    dataset: {},
    disabled: false,
    textContent: "",
    onclick: null,
    setAttribute() {},
    addEventListener() {},
    appendChild() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function makeClient({ decks, currentDeck, fileType, fileName }) {
  const calls = { toasts: [], ensureDeploymentCalls: 0, postBodies: [], createDeckFromLoadedDrawingCalled: 0 };
  const elMap = new Map();
  const el = (id) => { if (!elMap.has(id)) elMap.set(id, makeEl(id)); return elMap.get(id); };
  // deck-source-modal 마크업이 실제로 존재해야 "구버전 폴백"(무조건 upload)로 새지 않는다.
  const DSM_IDS = ["deck-source-modal", "dsm-btn-region", "dsm-btn-upload", "dsm-region-reason", "dsm-sub", "dsm-backdrop", "dsm-cancel"];
  DSM_IDS.forEach(el);

  const sandbox = {
    console, JSON, Math, Date, Set, Map, Promise, Object, Array, String, Number, Boolean, setTimeout, requestAnimationFrame: (fn) => fn(),
    navigator: { onLine: true },
    document: { getElementById: (id) => el(id) },
    Auth: { headers: () => ({}), isDesigner: true },
    Prompt: { ask: async () => ({ value: "" }), toast: (m) => calls.toasts.push(String(m)) },
    State: { fileType, fileName, pdfPage: 1 },
    Zones: undefined,
    App: {
      _closeSidebarSheet() {},
      _ensureDrawingDeployment: async () => { calls.ensureDeploymentCalls++; return "dep_new"; },
      _pendingDeckLink: null,
    },
    fetch: async (url, opt) => {
      const body = JSON.parse((opt && opt.body) || "{}");
      calls.postBodies.push({ url, body });
      return { ok: true, json: async () => ({ id: "dck_new", name: body.name, deployment_id: body.deployment_id, parent_id: body.parent_id }) };
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(PROJECTS_SRC + "\n;globalThis.__P = Projects;", sandbox);
  const P = sandbox.__P;
  P.currentProject = { id: "prj_1" };
  P.decks = decks;
  P.currentDeck = currentDeck;
  // _pickDeckCrop 은 Zones 를 가로채는데, 여기선 Zones 가 undefined → 즉시 null 반환(취소) 경로다.
  // createDeckFromLoadedDrawing/extractRegionAsDeck 자체 분기(위임 여부)만 보면 되므로
  // crop 을 opts 로 직접 주입해 드래그 UI 를 건너뛴다.
  const origCreateFromLoaded = P.createDeckFromLoadedDrawing.bind(P);
  P.createDeckFromLoadedDrawing = async (opts) => { calls.createDeckFromLoadedDrawingCalled++; return origCreateFromLoaded(opts); };
  return { P, calls, el };
}

/* ① 도면 로드됨 + 구역 0개 → 활성 */
{
  const { P, el } = makeClient({ decks: [], currentDeck: null, fileType: "pdf", fileName: "A.pdf" });
  P._chooseDeckSource(); // 동기 부분만 확인 — 클릭 대기 상태로 남음(취소로 정리)
  ok(el("dsm-btn-region").disabled === false, "① 도면 로드 + 구역 0개 → 활성");
  el("dsm-cancel").onclick();
}

/* ①' 도면 로드됨 + 구역 N개(이미 존재, currentDeck 은 deployment_id 없음) → 활성 — 이번 수정의 핵심 */
{
  const existing = { id: "dck_x", name: "ㅁ", deployment_id: null };
  const { P, el } = makeClient({ decks: [existing], currentDeck: existing, fileType: "image", fileName: "새도면.png" });
  P._chooseDeckSource();
  ok(el("dsm-btn-region").disabled === false, "①' 도면 로드 + 구역 있음(미저장) → 활성(회귀 아님, 이번 수정 핵심)");
  ok(el("dsm-sub").textContent === "현재 도면: 새도면.png", "⑦ '현재 도면' 라벨이 도면 파일명을 보여준다(구역 이름 'ㅁ' 아님)");
  el("dsm-cancel").onclick();
}

/* ② 그 경로가 createDeckFromLoadedDrawing 으로 위임 */
{
  const existing = { id: "dck_x", name: "ㅁ", deployment_id: null };
  const { P, calls } = makeClient({ decks: [existing], currentDeck: existing, fileType: "image", fileName: "새도면.png" });
  const crop = { x: 10, y: 10, w: 30, h: 30 };
  const res = await P.extractRegionAsDeck({ name: "새 영역", crop });
  ok(calls.createDeckFromLoadedDrawingCalled === 1, "② extractRegionAsDeck 이 createDeckFromLoadedDrawing 으로 위임");
  ok(calls.ensureDeploymentCalls === 1, "② 위임 경로가 App._ensureDrawingDeployment 를 호출(새 배포본 확정)");
  ok(res && res.parent_id === null, "② 생성된 구역이 루트(parent_id null)로 POST 됨");
}

/* ③ 도면이 구역에 묶인 경우 → extractRegionAsDeck 본경로 유지(회귀) */
{
  const boundDeck = { id: "dck_bound", name: "본체", deployment_id: "dep_old", page: 1 };
  const { P, calls } = makeClient({ decks: [boundDeck], currentDeck: boundDeck, fileType: "pdf", fileName: "본체.pdf" });
  const crop = { x: 5, y: 5, w: 20, h: 20 };
  const res = await P.extractRegionAsDeck({ name: "영역2", crop });
  ok(calls.createDeckFromLoadedDrawingCalled === 0, "③ 이미 저장된 도면(currentDeck.deployment_id 有)은 위임하지 않는다(회귀)");
  ok(calls.ensureDeploymentCalls === 0, "③ 새 배포본을 만들지 않고 기존 deployment_id 재사용");
  ok(res && res.deployment_id === "dep_old", "③ 생성된 영역이 원본과 같은 deployment_id 를 가리킨다");
}

/* ④ 도면이 아예 없을 때만 비활성 + 정확한 이유 문구 */
{
  const { P, el } = makeClient({ decks: [], currentDeck: null, fileType: null, fileName: null });
  P._chooseDeckSource();
  ok(el("dsm-btn-region").disabled === true, "④ 도면이 아예 없으면 비활성");
  ok(!el("dsm-region-reason").classList.contains("hidden"), "④ 비활성 이유 문구가 보인다");
  el("dsm-cancel").onclick();

  const { P: P2 } = makeClient({ decks: [], currentDeck: null, fileType: null, fileName: null });
  const res2 = await P2.extractRegionAsDeck({ name: "x", crop: { x: 0, y: 0, w: 10, h: 10 } });
  ok(res2 === null, "④ 도면 없음 → extractRegionAsDeck 도 거부");
}

/* ⑤ 분기 조건 SoT — _canExtractFromLoadedDrawing 자체엔 decks.length 판정이 없다 */
{
  const fnSrc = (() => {
    const m = PROJECTS_SRC.match(/_canExtractFromLoadedDrawing\(\)\s*\{[\s\S]*?\n    \},/);
    return m ? m[0] : "";
  })();
  ok(fnSrc.length > 0, "⑤ _canExtractFromLoadedDrawing 함수를 소스에서 찾음");
  ok(!/decks/.test(fnSrc), "⑤ _canExtractFromLoadedDrawing 내부에 decks 관련 판정이 없다(SoT)");
  const callSites = (PROJECTS_SRC.match(/this\._canExtractFromLoadedDrawing\(\)/g) || []).length;
  ok(callSites === 2, "⑤ _chooseDeckSource·extractRegionAsDeck 두 곳 모두 같은 판정 함수를 호출(중복 판정 0)");
}

/* ⑥ 옛 문구 부재 */
{
  ok(!/도면이 등록된 구역을 열어야/.test(PROJECTS_SRC), "⑥ 31_Projects.js 에 옛 비활성 문구 없음");
  ok(!/도면이 등록된 구역을 여세요/.test(PROJECTS_SRC), "⑥ 31_Projects.js 에 옛 안내 토스트 문구 없음");
  ok(!/도면이 등록된 구역을 열어야/.test(INDEX_HTML), "⑥ index.html 에 옛 비활성 문구 없음");
}

/* ══ 뮤테이션 3건 — 되돌리면 반드시 실패해야 한다(§G-2-3) ══ */
console.log("\n-- 뮤테이션 증명 --");
function runMutated(mutatedSrc, scenario) {
  const sandbox = {
    console, JSON, Math, Date, Set, Map, Promise, Object, Array, String, Number, Boolean, setTimeout, requestAnimationFrame: (fn) => fn(),
    navigator: { onLine: true },
    document: { getElementById: () => makeEl("x") },
    Auth: { headers: () => ({}), isDesigner: true },
    Prompt: { ask: async () => ({ value: "" }), toast: () => {} },
    State: { fileType: "pdf", fileName: "A.pdf", pdfPage: 1 },
    Zones: undefined,
    App: { _closeSidebarSheet() {}, _ensureDrawingDeployment: async () => "dep_new", _pendingDeckLink: null },
    fetch: async () => ({ ok: true, json: async () => ({ id: "d", parent_id: null }) }),
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(mutatedSrc + "\n;globalThis.__P = Projects;", sandbox);
  return sandbox.__P;
}

// ⓐ decks.length 조건 복원
{
  const mutated = PROJECTS_SRC.replace(
    "return !!(this.currentProject\n        && typeof State !== \"undefined\" && !!State.fileType);",
    "return !!(this.currentProject && !(this.decks || []).length\n        && typeof State !== \"undefined\" && !!State.fileType);"
  );
  ok(mutated !== PROJECTS_SRC, "ⓐ 뮤테이션 패치 적용됨(문자열 매치 확인)");
  const P = runMutated(mutated);
  P.currentProject = { id: "p" }; P.decks = [{ id: "d1", deployment_id: null }]; P.currentDeck = P.decks[0];
  const disabled = P._canExtractFromLoadedDrawing() === false;
  ok(disabled, "ⓐ [뮤테이션] decks.length 조건 복원 시 ①' 이 다시 비활성 판정으로 실패");
}

// ⓑ 위임 분기 제거
{
  const mutated = PROJECTS_SRC.replace(
    'if (this._canExtractFromLoadedDrawing()) return await this.createDeckFromLoadedDrawing(opts);',
    '/* 위임 제거됨(뮤테이션) */'
  );
  ok(mutated !== PROJECTS_SRC, "ⓑ 뮤테이션 패치 적용됨(문자열 매치 확인)");
  const P = runMutated(mutated);
  P.currentProject = { id: "p" };
  const existing = { id: "d1", name: "ㅁ", deployment_id: null };
  P.decks = [existing]; P.currentDeck = existing;
  const res = await P.extractRegionAsDeck({ name: "n", crop: { x: 1, y: 1, w: 5, h: 5 } });
  ok(res === null, "ⓑ [뮤테이션] 위임 분기 제거 시 영역 생성이 실패(② 검증 무력화 확인)");
}

// ⓒ 판정을 두 곳으로 분리(SoT 위반)
{
  const mutated = PROJECTS_SRC.replace(
    'const canExtract = !!(this.currentDeck && this.currentDeck.deployment_id) || this._canExtractFromLoadedDrawing();',
    'const canExtract = !!(this.currentDeck && this.currentDeck.deployment_id) || !!(typeof State !== "undefined" && State.fileType);'
  );
  ok(mutated !== PROJECTS_SRC, "ⓒ 뮤테이션 패치 적용됨(문자열 매치 확인)");
  const callSites = (mutated.match(/this\._canExtractFromLoadedDrawing\(\)/g) || []).length;
  ok(callSites === 1, "ⓒ [뮤테이션] SoT 위반 — 판정이 두 곳으로 갈라져 ⑤ 실패(호출 지점 1개로 줄어듦)");
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
