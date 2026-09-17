/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p24-first-screen-hub.test.mjs)
 *
 * 대상: 마스터 지시(2026-09-17) — "첫 화면은 무조건 프로젝트 선택이 나오게 해"
 *
 * 실측(재조사 금지 대상, 이번 세션에서 확인):
 *  - 진입 분기 99_footer.js:25~52 는 이미 `?d=` 유무만으로 뷰어/그 외를 가른다(요구 1·2 충족,
 *    커밋 0c85da6 이후 상태). 별도 수정 불필요 — 회귀만 고정.
 *  - localStorage/sessionStorage 기반 "마지막 프로젝트 자동복귀" 경로는 grep 결과 없음(없음 확인).
 *  - 있었던 자동복귀 경로: 12_ProjectHub.js open() 안의 AUTO_DESIGNER_ENTRY 자동입장 블록
 *    (2026-08-31 도입) — 프로젝트 목록 중 서버가 최신순으로 준 list[0]으로 허브를 건너뛰고
 *    바로 진입시켰다. 이번 작업으로 이 블록을 제거했다(공유 지점 1곳, 호출부 없음 → grep 확인).
 *
 * 검증 항목:
 *  ① 파라미터 없음 → ProjectHub.open() 호출(뷰어 아님) — 99_footer.js
 *  ② `?d=dep_xxx` → 뷰어 진입(회귀 없음, 배포 링크 보존) — 99_footer.js
 *  ③ `?mode=viewer` 단독 → ProjectHub.open() 호출(뷰어 아님, 커밋 0c85da6 유지) — 99_footer.js
 *  ④ 프로젝트 0개 → render() 가 hub-empty 를 정상 노출(크래시 없음) — 12_ProjectHub.js render()
 *  ⑤ open() 호출 시 프로젝트가 있고 Auth.isDesigner=true 여도 openProject 로 자동 진입하지 않는다
 *     (옛 AUTO_DESIGNER_ENTRY 자동입장 블록 제거 확인) — 12_ProjectHub.js open()
 *
 * 뮤테이션 2건으로 테스트 실효성 증명(끝부분).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const footerSrc = rd("public/js/modules/99_footer.js");
const hubSrc = rd("public/js/modules/12_ProjectHub.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

function extractBetween(src, startNeedle, endNeedle) {
  const s = src.indexOf(startNeedle);
  if (s < 0) throw new Error("start needle not found: " + startNeedle);
  const e = src.indexOf(endNeedle, s);
  if (e < 0) throw new Error("end needle not found: " + endNeedle);
  return src.slice(s, e);
}

/* ══════════════════════════════════════════════════════════════════
 * ①~③ — 99_footer.js 진입 분기 (회귀 고정, 소스 변경 없음)
 * ══════════════════════════════════════════════════════════════════ */
const entrySnippet = extractBetween(
  footerSrc,
  "const params  = new URLSearchParams(location.search);",
  "/* ── 360° 테스트 훅"
);

async function runEntry(search) {
  const calls = [];
  const State = { viewerLocked: false };
  const App = { openApp: (mode) => calls.push("openApp:" + mode) };
  const Auth = { isDesigner: false, requireDesigner: () => { calls.push("requireDesigner"); } };
  const ProjectHub = { open: () => calls.push("ProjectHub.open") };
  const Projects = { currentProject: null };
  const fetch = async () => { throw new Error("no tenant (test env)"); };
  const PanoViewer = { loadMedia() { calls.push("PanoViewer.loadMedia"); } };
  const sandbox = { console, State, App, Auth, ProjectHub, Projects, fetch, PanoViewer, location: { search }, URLSearchParams, decodeURIComponent };
  vm.createContext(sandbox);
  await vm.runInContext(`(async () => { ${entrySnippet} })()`, sandbox);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return { calls, State };
}

{
  const { calls, State } = await runEntry("");
  ok(calls.includes("ProjectHub.open") && !calls.includes("openApp:viewer") && State.viewerLocked === false,
    "① 파라미터 없음 → ProjectHub.open() (뷰어 아님) → " + JSON.stringify(calls));
}
{
  const { calls, State } = await runEntry("?d=dep_xxx");
  ok(calls.includes("openApp:viewer") && State.viewerLocked === true,
    "② ?d=dep_xxx → 뷰어 진입 + viewerLocked=true (배포 링크 보존) → " + JSON.stringify(calls));
}
{
  const { calls, State } = await runEntry("?mode=viewer");
  ok(calls.includes("ProjectHub.open") && !calls.includes("openApp:viewer") && State.viewerLocked === false,
    "③ ?mode=viewer 단독 → ProjectHub.open() (뷰어 아님) → " + JSON.stringify(calls));
}

/* ══════════════════════════════════════════════════════════════════
 * ④ — 12_ProjectHub.js render() : 프로젝트 0개 → 빈 상태
 * ══════════════════════════════════════════════════════════════════ */
const RENDER_START = 'const grid  = document.getElementById("hub-grid");';
const RENDER_END = '\n      empty && empty.classList.add("hidden");';
const renderEmptySnippet = extractBetween(hubSrc, RENDER_START, RENDER_END);

function makeClassList() {
  const set = new Set();
  return { add: (...c) => c.forEach((x) => x && set.add(x)), remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle(c, force) { if (force === undefined) { if (set.has(c)) { set.delete(c); return false; } set.add(c); return true; } if (force) set.add(c); else set.delete(c); return !!force; },
    contains: (c) => set.has(c) };
}
function makeEl() { return { classList: makeClassList(), _text: "", get textContent() { return this._text; }, set textContent(v) { this._text = v; }, innerHTML: "" }; }

function runRenderEmpty(isDesigner) {
  const registry = { "hub-grid": makeEl(), "hub-empty": makeEl(), "hub-btn-new": makeEl(), "hub-empty-hint": makeEl() };
  const document = { getElementById: (id) => registry[id] || null };
  const Auth = { isDesigner };
  const mockThis = { list: [] };
  const sandbox = { console, document, Auth, mockThis };
  vm.createContext(sandbox);
  vm.runInContext(`(function() { ${renderEmptySnippet} }).call(mockThis)`, sandbox);
  return registry;
}

{
  const reg = runRenderEmpty(true);
  ok(!reg["hub-empty"].classList.contains("hidden") && reg["hub-grid"].innerHTML === "",
    "④ 프로젝트 0개 → hub-empty 노출 + hub-grid 비움(크래시 없음)");
}

/* ══════════════════════════════════════════════════════════════════
 * ⑤ — 12_ProjectHub.js open() : 자동입장(허브 건너뛰기) 제거 확인
 * ══════════════════════════════════════════════════════════════════ */
const OPEN_START = 'UI.showScreen("screen-projects");';
const OPEN_END = '\n    },\n\n    async load() {';
const openSnippet = extractBetween(hubSrc, OPEN_START, OPEN_END);

async function runOpen(snippet) {
  const calls = [];
  const UI = { showScreen: (id) => calls.push("showScreen:" + id) };
  const Auth = { isDesigner: true, _applyUi() { calls.push("Auth._applyUi"); }, _renderHubSignin() { calls.push("Auth._renderHubSignin"); } };
  const AUTO_DESIGNER_ENTRY = true;
  const mockThis = {
    list: [{ id: "p1", name: "Project One" }],
    _autoEntered: false,
    load: async function () { calls.push("load"); this.list = [{ id: "p1", name: "Project One" }]; },
    openProject: function (p) { calls.push("openProject:" + p.id); }
  };
  const sandbox = { console, UI, Auth, AUTO_DESIGNER_ENTRY, mockThis };
  vm.createContext(sandbox);
  await vm.runInContext(`(async function() { ${snippet}\n }).call(mockThis)`, sandbox);
  return calls;
}

{
  const calls = await runOpen(openSnippet);
  ok(!calls.some((c) => c.startsWith("openProject")),
    "⑤ open() 호출 시 프로젝트가 있어도 자동으로 openProject() 진입하지 않는다(허브 유지) → " + JSON.stringify(calls));
}

console.log("\n[뮤테이션 M1] depId 분기를 제거하면 케이스②가 실패해야 함");
{
  const mutatedFooter = footerSrc.replace(
    'if (depId) {\n      // [마스터 2026-09-13] 뷰어는 배포 링크(?d=배포ID) 전용 — mode=viewer 단독은 디자이너로 보낸다.\n      State.viewerLocked = true;\n      App.openApp("viewer");\n    } else if (urlMode === "designer") {',
    'if (false) {\n      State.viewerLocked = true;\n      App.openApp("viewer");\n    } else if (urlMode === "designer") {'
  );
  if (mutatedFooter === footerSrc) { console.log("  FAIL M1 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mSnippet = extractBetween(mutatedFooter, "const params  = new URLSearchParams(location.search);", "/* ── 360° 테스트 훅");
    const calls = [];
    const State = { viewerLocked: false };
    const App = { openApp: (mode) => calls.push("openApp:" + mode) };
    const Auth = { isDesigner: false, requireDesigner: () => {} };
    const ProjectHub = { open: () => calls.push("ProjectHub.open") };
    const Projects = { currentProject: null };
    const fetch = async () => { throw new Error("no tenant"); };
    const PanoViewer = { loadMedia() {} };
    const sandbox = { console, State, App, Auth, ProjectHub, Projects, fetch, PanoViewer, location: { search: "?d=dep_xxx" }, URLSearchParams, decodeURIComponent };
    vm.createContext(sandbox);
    await vm.runInContext(`(async () => { ${mSnippet} })()`, sandbox);
    await new Promise((r) => setImmediate(r));
    ok(!calls.includes("openApp:viewer"), "뮤테이션 M1 적용 시 케이스②가 다시 깨짐(테스트 실효성 증명) → " + JSON.stringify(calls));
  }
}

console.log("\n[뮤테이션 M2] 제거했던 AUTO_DESIGNER_ENTRY 자동입장 블록을 되살리면 케이스⑤가 실패해야 함");
{
  const restoredBlock = openSnippet +
    '\n      if (typeof AUTO_DESIGNER_ENTRY !== "undefined" && AUTO_DESIGNER_ENTRY && !this._autoEntered && this.list.length > 0 && Auth.isDesigner) {\n        this._autoEntered = true;\n        this.openProject(this.list[0]);\n      }';
  const calls = await runOpen(restoredBlock);
  ok(calls.some((c) => c.startsWith("openProject")),
    "뮤테이션 M2 적용 시 케이스⑤가 다시 깨짐(자동입장 부활 → 허브 건너뜀, 테스트 실효성 증명) → " + JSON.stringify(calls));
}

console.log(failed === 0 ? "\n전체 PASS" : `\n${failed}건 FAIL`);
process.exit(failed === 0 ? 0 : 1);
