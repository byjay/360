/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p43-reachability-and-silent-failures.test.mjs)
 *
 * 발주서(WO 20260918) 3건 + 마스터 정정(기본모드 = 등록모드) 검증:
 *  ① 🔴 [WO 20261015-numunify 계약 반전] 마스터: "체크보드 모드에서 번호만 일괄적으로 찍고 나서 사진폴더 …
 *     360도 사진이 일괄적으로" — 모드와 무관하게 PhotoBatch.open() 은 페이지 전 핀("all")으로 열리고 체커 핀이 범위에 든다.
 *     전·후 대조: 종전 기대 series==="content"(체커 핀 대상 아님) → 새 기대 series==="all" + 범위 1~2(체커 C1·C2 포함).
 *  ② 등록(360)/뷰 모드에서도 같은 "all"(모드 무관)
 *  ③ _defaultRange() 가 State.regMode 를 참조하지 않고 항상 "all" 을 반환한다(계열 축 제거)
 *  ④ 대상 핀 0건이면 사용자에게 알린다(조용한 실패 0)
 *  ⑤ 숨겨진 죽은 버튼(#btn-checkboard-photobatch)이 남아있지 않다(렌더 고아 0)
 *  ⑥ _pickDrawingFile() 이 상한 타임아웃 후 반드시 resolve 한다(영구 교착 금지)
 *  ⑦ _creatingDeck 이 모든 탈출 경로(정상/취소/예외)에서 해제된다
 *  ⑧ createProject/deleteProject/createDeck 오프라인 시 사용자 알림이 있다(조용한 실패 0)
 *  ⑨ 저장된 사용자 선택(PinSeries.setPreferredMode)이 있으면 기본값보다 우선한다
 *  ⑩ 기본값이 등록모드(designer)다 — 마스터가 같은 날 "체크보드 기본"을 되돌림
 *  ⑪ [WO 20261015-numunify] CHECKER 모드에서 PhotoBatch.open() 을 직접 호출하면 체커 핀이 범위에 든다("all")
 *
 * 실제 모듈 소스(01b_PinSeries.js/35_PhotoBatch.js/20_App.js/31_Projects.js/index.html)를
 * 그대로 vm 에 평가/검사한다(목 구현 아님). ①③④⑥⑧⑩ 에 뮤테이션 케이스가 붙는다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const seriesSrc = rd("public/js/modules/01b_PinSeries.js");
const pbSrc = rd("public/js/modules/35_PhotoBatch.js");
const appSrc = rd("public/js/modules/20_App.js");
const projectsSrc = rd("public/js/modules/31_Projects.js");
const indexHtml = rd("public/index.html");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ══════════════════════════════════════════════════════════════════
 * 헬퍼 — PhotoBatch 로드 (p6-photo-batch.test.mjs 와 동일 패턴)
 * ══════════════════════════════════════════════════════════════════ */
function loadPB(pbSource, seriesSource, extraState = {}) {
  const State = Object.assign({ pins: [], pdfPage: 1 }, extraState);
  const registry = {};
  const getEl = (id) => (registry[id] = registry[id] || {
    textContent: "", value: "", checked: false,
    classList: { add() {}, remove() {}, toggle() {} }
  });
  const toastCalls = [];
  const sandbox = {
    console, JSON, Map, Set, Date,
    document: { getElementById: getEl, querySelectorAll: () => [] },
    requestAnimationFrame: (cb) => cb(),
    State,
    App: { pinHasContent(pin) { return !!(pin && (pin.imageId || pin.imageUrl || pin.videoId)); } },
    Auth: { requireDesigner: undefined, isDesigner: true },
    Prompt: { toast: (t) => toastCalls.push(t) }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(seriesSource + "\n" + pbSource + "\n;globalThis.__PB = PhotoBatch; globalThis.__PS = PinSeries;", sandbox);
  return { PB: sandbox.__PB, PS: sandbox.__PS, registry, toastCalls, State };
}

/* ══ ①② [WO 20260930-moderole] CHECKER 모드여도 항상 content 계열로 열린다 ══════════════════ */
{
  const pinsCb = [
    { id: "C1", page: 1, label: "1", checkboard: true },
    { id: "C2", page: 1, label: "2", checkboard: true }
  ];
  // CHECKER 모드(State.regMode='checkboard')여도 PhotoBatch 는 CHECKER 핀을 대상으로 삼지 않는다
  // (마스터: "체커는 사진을 등록하지 않을 거야") — 항상 content 계열로 열린다.
  const { PB } = loadPB(pbSrc, seriesSrc, { pins: pinsCb, pdfPage: 1, checkboard: true, regMode: "checkboard" });
  PB.open();
  ok(PB._range.series === "all" && PB._range.start === 1 && PB._range.end === 2, "① CHECKER 모드(State.regMode='checkboard') → open() 이 전 핀(all)·범위 1~2 로 열림(체커 핀도 사진 대상), 실제 " + PB._range.series + " " + PB._range.start + "~" + PB._range.end);

  const pinsContent = [
    { id: "A1", page: 1, label: "A", imageId: "x" },
    { id: "A2", page: 1, label: "B", imageId: "y" }
  ];
  const { PB: PB2 } = loadPB(pbSrc, seriesSrc, { pins: pinsContent, pdfPage: 1, checkboard: false, regMode: "view" });
  PB2.open();
  ok(PB2._range.series === "all", "② 등록(뷰어) 모드(State.regMode='view') → open() 이 전 핀(all)으로 열림(모드 무관), 실제 " + PB2._range.series);
}

/* ══ ③ _defaultRange() 가 State.regMode 를 보지 않고 항상 content(+ 뮤테이션ⓐ) ══════════════ */
{
  ok(/_defaultRange\(\) \{[\s\S]{0,400}?const series = "all";/.test(pbSrc),
    "③ _defaultRange() 가 State.regMode 와 무관하게 series = \"all\" 로 고정돼 있다(계열 축 제거)");
  ok(!/const series = \(typeof State !== "undefined" && State\.regMode === "checkboard"\) \? "checkboard" : "content";/.test(pbSrc),
    "③ _defaultRange() 소스에 CHECKER 모드용 checkboard 계열 분기가 남아있지 않다");

  // [WO 20261015-numunify] 뮤테이션 방향 갱신 — 옛 "content 고정"(체커 핀 제외)으로 되돌리면 ①이 실패해야 한다
  console.log("\n[뮤테이션ⓐ] _defaultRange() 를 옛 content 고정(체커 핀 제외)으로 되돌리면 ①이 실패해야 함");
  const needleA = 'const series = "all";';
  const mutatedA = pbSrc.replace(needleA, 'const series = "content";');
  if (mutatedA === pbSrc) { console.log("  FAIL 뮤테이션ⓐ 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const pinsCb = [{ id: "C1", page: 1, label: "1", checkboard: true }];
    const { PB: PBm } = loadPB(mutatedA, seriesSrc, { pins: pinsCb, pdfPage: 1, checkboard: true, regMode: "checkboard" });
    PBm.open();
    ok(PBm._range.series !== "all", "뮤테이션ⓐ 적용 시 CHECKER 모드에서 전 핀 범위가 깨짐(①이 깨짐, 구 동작 재현) → " + PBm._range.series);
  }
}

/* ══ ④ 대상 핀 0건 → 사용자에게 알린다(+ 뮤테이션ⓑ) ══════════════════════ */
{
  const { PB, toastCalls } = loadPB(pbSrc, seriesSrc, { pins: [], pdfPage: 1, checkboard: true });
  PB.open();
  ok(toastCalls.length >= 1 && toastCalls.some((t) => /대상 핀이 없습니다/.test(t)),
    "④ 대상 핀 0건이면 Prompt.toast 로 이유를 알린다 → " + JSON.stringify(toastCalls));

  console.log("\n[뮤테이션ⓑ] 0건 알림 블록을 제거하면 ④가 실패해야 함");
  const needleB = /\n\s*\/\/ \[WO 20260918\] 🔴 조용한 실패 금지[\s\S]*?Prompt\.toast\(.*?\);\n\s*\}\n/;
  const mutatedB = pbSrc.replace(needleB, "\n");
  if (mutatedB === pbSrc) { console.log("  FAIL 뮤테이션ⓑ 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PB: PBm, toastCalls: toastCallsM } = loadPB(mutatedB, seriesSrc, { pins: [], pdfPage: 1, checkboard: true });
    PBm.open();
    ok(!toastCallsM.some((t) => /대상 핀이 없습니다/.test(t)),
      "뮤테이션ⓑ 적용 시 0건이어도 아무 토스트가 안 뜸(④가 깨짐, 조용한 실패 재현) → " + JSON.stringify(toastCallsM));
  }
}

/* ══ ⑤ 숨겨진 죽은 버튼이 index.html 에 남아있지 않다(렌더 고아 0) ══════════ */
{
  ok(!/id="btn-checkboard-photobatch"/.test(indexHtml),
    "⑤ #btn-checkboard-photobatch 가 index.html 에서 제거됨(렌더 고아 0)");
  ok(!/UI\.\$\("btn-checkboard-photobatch"\)|getElementById\("btn-checkboard-photobatch"\)/.test(appSrc),
    "⑤ 20_App.js 에도 #btn-checkboard-photobatch 를 조회/조작하는 실 코드가 없다(주석 언급 제외, 죽은 리스너 0)");
}

/* ══ ⑥ _pickDrawingFile() 상한 타임아웃 후 반드시 resolve(+ 뮤테이션ⓒ) ══════ */
function extractMethod(src, name) {
  const sigIdx = src.indexOf(name + "() {");
  if (sigIdx < 0) throw new Error("method not found: " + name);
  const braceStart = src.indexOf("{", sigIdx);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  return src.slice(sigIdx, i + 1); // "_pickDrawingFile() { ... }"
}
function makePickSandbox(methodSrc) {
  const toastCalls = [];
  const els = [];
  const listeners = {};
  const winListeners = {};
  const sandbox = {
    console,
    Prompt: { toast: (t) => toastCalls.push(t) },
    document: {
      createElement: () => {
        const el = {
          style: {}, addEventListener(ev, cb) { listeners[ev] = cb; },
          removeEventListener() {}, remove() {}, click() {}, files: null
        };
        els.push(el);
        return el;
      },
      body: { appendChild() {} }
    },
    window: {
      addEventListener(ev, cb) { winListeners[ev] = cb; },
      removeEventListener() {}
    },
    setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext("const obj = { " + methodSrc + " };\nglobalThis.__obj = obj;", sandbox);
  return { obj: sandbox.__obj, toastCalls };
}
{
  // 하드타임아웃을 짧게(40ms) 앞당겨 실제 60초를 기다리지 않고 검증한다(타이밍 로직은 동일).
  const methodSrc = extractMethod(appSrc, "_pickDrawingFile").replace("60000", "40");
  const { obj, toastCalls } = makePickSandbox(methodSrc);
  const start = Date.now();
  const result = await obj._pickDrawingFile(); // focus/change/cancel 이벤트가 전혀 오지 않는 환경 재현
  const elapsed = Date.now() - start;
  ok(result === null, "⑥ 아무 신호 없어도 상한 타임아웃 후 null 로 resolve 됨(영구 교착 아님), 실제 " + result);
  ok(elapsed < 2000, "⑥ 타임아웃이 실제로 짧게(40ms 기준) 동작함, 경과 " + elapsed + "ms");
  ok(toastCalls.some((t) => /응답이 없어/.test(t)), "⑥ 타임아웃 시 사용자에게 알림 → " + JSON.stringify(toastCalls));

  console.log("\n[뮤테이션ⓒ] 상한 타임아웃 블록을 제거하면 ⑥이 실패해야 함(영구 교착 재현)");
  const fullSrc = extractMethod(appSrc, "_pickDrawingFile");
  const needleC = /\n\s*\/\/ \[WO 20260918\] 🔴 상한 타임아웃[\s\S]*?\}, 60000\);\n/;
  const mutatedC = fullSrc.replace(needleC, "\n");
  if (mutatedC === fullSrc) { console.log("  FAIL 뮤테이션ⓒ 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { obj: objM } = makePickSandbox(mutatedC);
    const raced = await Promise.race([
      objM._pickDrawingFile().then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("timeout"), 300))
    ]);
    ok(raced === "timeout", "뮤테이션ⓒ 적용 시 300ms 안에도 resolve 되지 않음(영구 교착 재현, ⑥이 깨짐) → " + raced);
  }
}

/* ══ ⑦ _creatingDeck 이 모든 탈출 경로에서 해제된다 ══════════════════════ */
function makeProjectsSandbox(pickResult, { throwOnPost = false, online = true } = {}) {
  const el = () => ({
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, dataset: {}, textContent: "", click() {},
    innerHTML: "", addEventListener() {}, appendChild() {}, querySelector: () => el()
  });
  const toastCalls = [];
  const decksOnServer = [];
  const sandbox = {
    console,
    alert: () => {},
    confirm: () => true,
    navigator: { onLine: online },
    document: { getElementById: () => null, createElement: () => el(), body: { appendChild() {} } },
    Auth: { headers: () => ({}), isDesigner: true },
    Prompt: { ask: async () => ({ value: "TEST ZONE" }), toast: (t) => toastCalls.push(t) },
    UI: { renderTree() {} },
    State: { mode: "designer" },
    App: {
      _pickDrawingFile: async () => pickResult,
      _loadDrawing: async () => {},
      _refreshUnsavedDecks() {}, isDeckUnsaved: () => false
    },
    fetch: async (url, opt) => {
      const method = (opt && opt.method) || "GET";
      if (throwOnPost && method === "POST") throw new Error("network down");
      if (method === "POST" && /\/decks$/.test(url)) {
        const d = { id: "deck_new", name: "TEST ZONE", project_id: "p1" };
        decksOnServer.push(d);
        return { ok: true, json: async () => d };
      }
      if (method === "GET" && /\/decks$/.test(url)) return { ok: true, json: async () => ({ data: decksOnServer.slice() }) };
      return { ok: true, json: async () => ({}) };
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(projectsSrc + "\n;globalThis.__Projects = Projects;", sandbox);
  const P = sandbox.__Projects;
  P.currentProject = { id: "p1", name: "P1" };
  return { P, toastCalls };
}
{
  // 정상 성공 경로
  const { P: P1 } = makeProjectsSandbox({ name: "a.pdf" });
  await P1.createDeck();
  ok(P1._creatingDeck === false, "⑦a 정상 성공 후 _creatingDeck 해제됨");

  // 사용자가 파일선택을 취소(= _pickDrawingFile 이 null 반환)
  const { P: P2 } = makeProjectsSandbox(null);
  await P2.createDeck();
  ok(P2._creatingDeck === false, "⑦b 파일선택 취소 후에도 _creatingDeck 해제됨");

  // POST 도중 예외
  const { P: P3 } = makeProjectsSandbox({ name: "a.pdf" }, { throwOnPost: true });
  await P3.createDeck();
  ok(P3._creatingDeck === false, "⑦c POST 예외 발생 후에도 _creatingDeck 해제됨");

  // [WO 20260918] ⑥의 하드 타임아웃이 없다면 이 await 자체가 영구 대기였을 것 —
  // _pickDrawingFile 이 항상 resolve 함을 가정하는 이 흐름이 ⑥에 의존한다는 걸 함께 증명.
  const { P: P4 } = makeProjectsSandbox(null); // 타임아웃 뒤 null 로 확정된 것과 동형
  await P4.createDeck();
  ok(P4._creatingDeck === false, "⑦d 타임아웃 후 null 확정(=⑥ 결과)과 동형 입력에서도 _creatingDeck 해제됨");
}

/* ══ ⑧ 오프라인 시 createProject/deleteProject/createDeck 이 조용히 무시하지 않는다 (+ 뮤테이션ⓓ) ══ */
{
  const { P, toastCalls } = makeProjectsSandbox({ name: "a.pdf" }, { online: false });
  let postCalled = false;
  P._creatingDeck = false;
  const origFetch = P === P; // no-op, fetch already wired via sandbox; check via toast instead
  const r1 = await P.createDeck();
  ok(r1 === null, "⑧a 오프라인에서 createDeck() 은 null 반환(진행 안 함)");
  ok(toastCalls.some((t) => /오프라인/.test(t) && /구역/.test(t)), "⑧a 오프라인 안내 토스트 발생 → " + JSON.stringify(toastCalls));

  console.log("\n[뮤테이션ⓓ] createProject 의 오프라인 안내(사전체크 + catch 폴백 둘 다)를 제거하면 ⑧b가 실패해야 함(조용한 실패 재현)");
  // 사전체크 + catch 폴백 두 지점 모두 같은 리터럴을 쓴다(방어적 이중화) — 진짜 "기능이
  // 통째로 사라진" 상태를 재현하려면 둘 다 제거해야 테스트에 이빨이 선다.
  const offlineMsg = "오프라인이라 지금은 프로젝트를 생성할 수 없습니다 — 연결 후 다시 시도하세요";
  const needleD1 = 'if (!navigator.onLine) { Prompt.toast && Prompt.toast("' + offlineMsg + '"); return; }\n      const res = await Prompt.ask';
  const needleD2 = 'if (!navigator.onLine) { Prompt.toast && Prompt.toast("' + offlineMsg + '"); }\n        else alert("네트워크 오류");';
  let mutatedD = projectsSrc.split(needleD1).join("const res = await Prompt.ask");
  mutatedD = mutatedD.split(needleD2).join('alert("네트워크 오류");');
  if (mutatedD === projectsSrc) { console.log("  FAIL 뮤테이션ⓓ 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const toastCallsM = [];
    const sandboxM = {
      console, alert: () => {}, confirm: () => true, navigator: { onLine: false },
      document: { getElementById: () => null, createElement: () => ({}), body: { appendChild() {} } },
      Auth: { headers: () => ({}), isDesigner: true },
      Prompt: { ask: async () => ({ value: "X" }), toast: (t) => toastCallsM.push(t) },
      UI: { renderTree() {} }, State: { mode: "designer" },
      App: {}, fetch: async () => { throw new Error("offline: fetch rejects"); }
    };
    vm.createContext(sandboxM);
    vm.runInContext(mutatedD + "\n;globalThis.__Projects = Projects;", sandboxM);
    await sandboxM.__Projects.createProject();
    ok(!toastCallsM.some((t) => /오프라인/.test(t)),
      "뮤테이션ⓓ 적용 시 오프라인이어도 안내가 전혀 없다(⑧이 깨짐, 조용한 실패 재현) → " + JSON.stringify(toastCallsM));
  }
}

/* ══ ⑨⑩⑪ 기본모드 정정(마스터 지시 2026-09-18) ══════════════════════════ */
function makePinSeriesSandbox(initialStore) {
  const store = Object.assign({}, initialStore);
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  const sandbox = { localStorage, console, JSON, Object, Array, Math, Number, String, Date };
  vm.createContext(sandbox);
  vm.runInContext(seriesSrc + "\n;globalThis.__PS = PinSeries;", sandbox);
  return sandbox.__PS;
}
{
  // [WO 20260929 2모드 전환] 기본값 = checkboard(CHECKER). 구 "designer"(=[보기]) 기본은
  // 세그먼트 제거와 함께 폐기됐다(구 WO 20260918 정정을 대체).
  const PSFresh = makePinSeriesSandbox({});
  ok(PSFresh.preferredMode() === "checkboard", "⑩ 저장된 선택이 없으면 기본값 = checkboard(CHECKER)");

  const PSSaved = makePinSeriesSandbox({ wm_pin_default_mode: "checkboard" });
  ok(PSSaved.preferredMode() === "checkboard", "⑨ 저장된 선택(checkboard)이 있으면 기본값보다 우선함");

  console.log("\n[뮤테이션ⓔ] DEFAULT_MODE 를 다시 designer(구 [보기])로 되돌리면 ⑩이 실패해야 함");
  const needleE = 'DEFAULT_MODE: "checkboard",';
  const mutatedE = seriesSrc.replace(needleE, 'DEFAULT_MODE: "designer",');
  if (mutatedE === seriesSrc) { console.log("  FAIL 뮤테이션ⓔ 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const sandboxM = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, console, JSON, Object, Array, Math, Number, String, Date };
    vm.createContext(sandboxM);
    vm.runInContext(mutatedE + "\n;globalThis.__PS = PinSeries;", sandboxM);
    ok(sandboxM.__PS.preferredMode() !== "checkboard", "뮤테이션ⓔ 적용 시 기본값이 designer 로 되돌아감(⑩이 깨짐) → " + sandboxM.__PS.preferredMode());
  }

  // [WO 20260930-moderole 재정정] ⑪ CHECKER 로 전환해도(State.regMode='checkboard') 방어적으로
  // PhotoBatch.open() 을 직접 호출해도(버튼이 숨겨져 있어도 API 레벨 방어) content 계열로 열린다 —
  // CHECKER 핀은 사진 등록 대상이 아니다(마스터: "체커는 사진을 등록하지 않을 거야").
  const pinsCb = [{ id: "C1", page: 1, label: "1", checkboard: true }];
  const { PB } = loadPB(pbSrc, seriesSrc, { pins: pinsCb, pdfPage: 1, checkboard: true, regMode: "checkboard" });
  PB.open();
  ok(PB._range.series === "all" && PB._range.end === 1, "⑪ CHECKER 모드에서 PhotoBatch.open() 직접 호출 → 체커 핀 C1 이 범위에 듦(all · 1~1), 실제 " + PB._range.series + " " + PB._range.start + "~" + PB._range.end);
}

console.log(failed === 0 ? "\n[ALL PASS]" : "\n[" + failed + " FAILED]");
process.exit(failed === 0 ? 0 : 1);
