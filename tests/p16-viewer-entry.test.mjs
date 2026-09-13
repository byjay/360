/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p16-viewer-entry.test.mjs)
 *
 * 대상: WORK_ORDER_20260913.md — "무조건 디자이너 모드로 하고 배포 시에 만든 링크로만
 * 뷰어는 접근이 가능하게 해" (마스터 2026-09-13)
 *
 * 결함: `?mode=viewer` 단독(배포본 ID 없음)으로도 뷰어가 열렸다(99_footer.js 진입 조건이
 * `urlMode === "viewer" || depId`). 또 디자이너 모드 안에서 "뷰어로"(#btn-exit-edit) 버튼으로
 * 배포 링크 없이도 뷰어에 갈 수 있었다.
 *
 * 수정(공유 지점):
 *  - 99_footer.js DOMContentLoaded 진입 분기 — 뷰어 진입 조건을 `depId` 유무만으로 좁힘.
 *  - 20_App.js openApp() — #btn-exit-edit 를 모드 무관 항상 숨김(exitEdit() 자체는 유지).
 *
 * 검증 항목(작업지시서 그대로):
 *  ① `?d=dep_xxx` → 뷰어 진입 + viewerLocked=true (기존 배포 링크 보존)
 *  ② `?mode=viewer&d=dep_xxx` → 뷰어 진입 (현행 배포 링크 형식 그대로)
 *  ③ `?mode=viewer` 단독 → 디자이너 진입(뷰어 아님)
 *  ④ 파라미터 없음 → 디자이너 진입
 *  ⑤ 디자이너 모드에서 #btn-exit-edit 가 숨겨져 있다
 *  ⑥ viewerLocked=true 상태의 기존 동작(홈 버튼 숨김)이 변하지 않았다
 *
 * 실제 모듈 소스(99_footer.js / 20_App.js)를 문자열로 발췌해 vm 에 그대로 평가한다
 * (목 구현 아님). 뮤테이션 3건으로 테스트 실효성을 증명한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const footerSrc = rd("public/js/modules/99_footer.js");
const appSrc = rd("public/js/modules/20_App.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 발췌 유틸: start 문자열부터 end 문자열 직전까지, 원문 그대로 잘라낸다 ── */
function extractBetween(src, startNeedle, endNeedle) {
  const s = src.indexOf(startNeedle);
  if (s < 0) throw new Error("start needle not found: " + startNeedle);
  const e = src.indexOf(endNeedle, s);
  if (e < 0) throw new Error("end needle not found: " + endNeedle);
  return src.slice(s, e);
}

/* ══════════════════════════════════════════════════════════════════
 * ①~④ — 99_footer.js 진입 분기(URL → viewer/designer 라우팅)
 * ══════════════════════════════════════════════════════════════════ */
const entrySnippet = extractBetween(
  footerSrc,
  'const params  = new URLSearchParams(location.search);',
  '/* ── 360° 테스트 훅'
);

/** 진입 분기를 실행하고 결과(App.openApp 호출 여부/모드, ProjectHub.open 호출 여부)를 반환. */
async function runEntry(search) {
  const calls = [];
  const State = { viewerLocked: false };
  const App = { openApp: (mode) => calls.push("openApp:" + mode) };
  const Auth = { isDesigner: false, requireDesigner: (cb) => { calls.push("requireDesigner"); } };
  const ProjectHub = { open: () => calls.push("ProjectHub.open") };
  const Projects = { currentProject: null };
  // 서브도메인 매칭 없음(테스트 환경) → tenant fetch 는 항상 실패 처리(운영 기본 흐름과 동일하게 catch 로 흡수).
  const fetch = async () => { throw new Error("no tenant (test env)"); };
  const PanoViewer = { loadMedia() { calls.push("PanoViewer.loadMedia"); } };

  const sandbox = {
    console, State, App, Auth, ProjectHub, Projects, fetch, PanoViewer,
    location: { search }, URLSearchParams, decodeURIComponent
  };
  vm.createContext(sandbox);
  const wrapped = `(async () => { ${entrySnippet} })()`;
  await vm.runInContext(wrapped, sandbox);
  // else 분기의 tenant-resolve 는 fire-and-forget async IIFE — 마이크로태스크를 몇 tick 흘려보내 완료를 기다린다.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return { calls, State };
}

{
  const { calls, State } = await runEntry("?d=dep_xxx");
  ok(calls.includes("openApp:viewer") && State.viewerLocked === true,
    "① ?d=dep_xxx → 뷰어 진입 + viewerLocked=true (기존 배포 링크 보존) → " + JSON.stringify(calls));
}
{
  const { calls, State } = await runEntry("?mode=viewer&d=dep_xxx");
  ok(calls.includes("openApp:viewer") && State.viewerLocked === true,
    "② ?mode=viewer&d=dep_xxx → 뷰어 진입(현행 배포 링크 형식 그대로) → " + JSON.stringify(calls));
}
{
  const { calls, State } = await runEntry("?mode=viewer");
  ok(!calls.includes("openApp:viewer") && calls.includes("ProjectHub.open") && State.viewerLocked === false,
    "③ ?mode=viewer 단독 → 디자이너 진입(뷰어 아님) → " + JSON.stringify(calls));
}
{
  const { calls, State } = await runEntry("");
  ok(!calls.includes("openApp:viewer") && calls.includes("ProjectHub.open") && State.viewerLocked === false,
    "④ 파라미터 없음 → 디자이너 진입 → " + JSON.stringify(calls));
}

console.log("\n[뮤테이션 M1] 조건을 urlMode===\"viewer\"||depId 로 되돌리면 케이스③이 실패해야 함");
{
  const mutatedFooter = footerSrc.replace(
    'if (depId) {',
    'if (urlMode === "viewer" || depId) {'
  );
  if (mutatedFooter === footerSrc) { console.log("  FAIL M1 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mSnippet = extractBetween(mutatedFooter, 'const params  = new URLSearchParams(location.search);', '/* ── 360° 테스트 훅');
    const calls = [];
    const State = { viewerLocked: false };
    const App = { openApp: (mode) => calls.push("openApp:" + mode) };
    const Auth = { isDesigner: false, requireDesigner: () => {} };
    const ProjectHub = { open: () => calls.push("ProjectHub.open") };
    const Projects = { currentProject: null };
    const fetch = async () => { throw new Error("no tenant"); };
    const PanoViewer = { loadMedia() {} };
    const sandbox = { console, State, App, Auth, ProjectHub, Projects, fetch, PanoViewer, location: { search: "?mode=viewer" }, URLSearchParams, decodeURIComponent };
    vm.createContext(sandbox);
    await vm.runInContext(`(async () => { ${mSnippet} })()`, sandbox);
    ok(calls.includes("openApp:viewer"), "뮤테이션 M1 적용 시 케이스③이 다시 깨짐(테스트 실효성 증명) → " + JSON.stringify(calls));
  }
}

console.log("\n[뮤테이션 M2] depId 분기를 제거하면 케이스①·②가 실패해야 함");
{
  const mutatedFooter = footerSrc.replace(
    'if (depId) {\n      // [마스터 2026-09-13] 뷰어는 배포 링크(?d=배포ID) 전용 — mode=viewer 단독은 디자이너로 보낸다.\n      State.viewerLocked = true;\n      App.openApp("viewer");\n    } else if (urlMode === "designer") {',
    'if (false) {\n      State.viewerLocked = true;\n      App.openApp("viewer");\n    } else if (urlMode === "designer") {'
  );
  if (mutatedFooter === footerSrc) { console.log("  FAIL M2 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mSnippet = extractBetween(mutatedFooter, 'const params  = new URLSearchParams(location.search);', '/* ── 360° 테스트 훅');
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
    ok(!calls.includes("openApp:viewer"), "뮤테이션 M2 적용 시 케이스①이 다시 깨짐(테스트 실효성 증명) → " + JSON.stringify(calls));
  }
}

/* ══════════════════════════════════════════════════════════════════
 * ⑤⑥ — 20_App.js openApp() 의 topbar 버튼 노출 블록
 * ══════════════════════════════════════════════════════════════════ */
function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => x && set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle(c, force) {
      if (force === undefined) { if (set.has(c)) { set.delete(c); return false; } set.add(c); return true; }
      if (force) set.add(c); else set.delete(c);
      return !!force;
    },
    contains: (c) => set.has(c),
    _set: set
  };
}
function makeEl() {
  const el = { style: {}, _text: "" };
  Object.defineProperty(el, "textContent", { get() { return this._text; }, set(v) { this._text = v == null ? "" : String(v); } });
  el.classList = makeClassList();
  return el;
}
function makeUI() {
  const registry = {};
  const get = (id) => (registry[id] = registry[id] || makeEl());
  return { UI: { $: get }, registry };
}

const TOPBAR_START = 'if (!isDesigner) {\n        // 뷰어 전용 링크(?mode=viewer)로 진입한 경우 홈 버튼도 숨긴다.';
const TOPBAR_END = 'if (opts.project && opts.project.name) {';
const topbarSnippet = extractBetween(appSrc, TOPBAR_START, TOPBAR_END);

function runTopbarBlock(isDesigner, viewerLocked, authIsDesigner) {
  const { UI, registry } = makeUI();
  const State = { viewerLocked };
  const Auth = { isDesigner: authIsDesigner };
  const sandbox = { console, UI, State, Auth, isDesigner };
  vm.createContext(sandbox);
  vm.runInContext(`(() => { ${topbarSnippet} })()`, sandbox);
  return registry;
}

{
  const registryDesigner = runTopbarBlock(true, false, true);
  ok(registryDesigner["btn-exit-edit"].classList.contains("hidden") === true,
    "⑤ 디자이너 모드에서도 #btn-exit-edit 가 숨겨져 있다(뷰어는 배포 링크 전용)");

  const registryViewer = runTopbarBlock(false, false, false);
  ok(registryViewer["btn-exit-edit"].classList.contains("hidden") === true,
    "⑤ 뷰어 모드에서도 #btn-exit-edit 가 숨겨져 있다");
}
{
  const registryLocked = runTopbarBlock(false, true, false);
  ok(registryLocked["btn-back"].style.display === "none",
    "⑥ viewerLocked=true 이면 기존대로 홈(#btn-back) 버튼이 숨는다(회귀 없음)");

  const registryUnlocked = runTopbarBlock(false, false, false);
  ok(registryUnlocked["btn-back"].style.display !== "none",
    "⑥ viewerLocked=false 이면 홈 버튼이 종전대로 노출된다(회귀 없음)");
}

console.log("\n[뮤테이션 M3] #btn-exit-edit 숨김 로직을 제거하면 케이스⑤가 실패해야 함");
{
  const mutatedApp = appSrc.replace(
    'const btnExit = UI.$("btn-exit-edit");\n      if (btnExit) btnExit.classList.add("hidden");',
    'const btnExit = UI.$("btn-exit-edit");'
  );
  if (mutatedApp === appSrc) { console.log("  FAIL M3 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mSnippet = extractBetween(mutatedApp, TOPBAR_START, TOPBAR_END);
    const { UI, registry } = makeUI();
    const State = { viewerLocked: false };
    const Auth = { isDesigner: true };
    const sandbox = { console, UI, State, Auth, isDesigner: true };
    vm.createContext(sandbox);
    vm.runInContext(`(() => { ${mSnippet} })()`, sandbox);
    ok(registry["btn-exit-edit"].classList.contains("hidden") === false,
      "뮤테이션 M3 적용 시 케이스⑤가 다시 깨짐(테스트 실효성 증명, 기본값 hidden 클래스 없음)");
  }
}

console.log(failed === 0 ? "\n전체 PASS" : `\n${failed}건 FAIL`);
process.exit(failed === 0 ? 0 : 1);
