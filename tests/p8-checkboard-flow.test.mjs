/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p8-checkboard-flow.test.mjs)
 *
 * 대상: 사이드바 툴레일 "포인트" 버튼 → 체크보드 순차 배치 → "사진 폴더 연동" 원클릭 흐름
 * (마스터 요청 2026-09-03: "이걸로 클릭만 하면 체크보드로 핀만 차례대로 박히고
 *  사진 폴더 일괄연동하는거 구현해")
 *
 *  ① 포인트 버튼(#btn-quickpoint) 클릭 소비 로직(App._quickCheckboardEntry)이
 *     꺼져있으면 #btn-checkboard-enter 로, 켜져있으면 #btn-place 로 위임한다
 *  ② 연속 클릭 시 번호가 1씩 증가한다(시작번호 반영, PinSeries.nextCheckboardNo 그대로 재사용)
 *  ③ 범위(시작~마지막)는 PinSeries 정본에서 파생한다(자체 채번 금지)
 *  ④ 🔴 [WO 20261015-numunify 계약 반전] CHECKER 모드에서 찍은 핀도 PhotoBatch 대상이다(마스터: "체크보드
 *     모드에서 번호만 일괄적으로 찍고 나서 사진폴더 … 일괄적으로"). #btn-photobatch 는 페이지 전 핀("all")으로
 *     열리고 방금 찍은 체커 핀 2개가 범위에 든다. 전·후 대조: 종전 {series:"content",1~1} → 새 {series:"all", 첫 핀~둘째 핀}.
 *  ⑤ 기존 진입 경로 2개(#btn-checkboard-enter 단독, #btn-photobatch 단독)와
 *     신규 버튼 1개(#btn-quickpoint)가 모두 바인딩된다
 *
 * 실제 모듈 소스(01b_PinSeries.js / 35_PhotoBatch.js / 20_App.js)를 그대로 vm 에 평가해 검사한다
 * (목 구현 아님). #btn-checkboard-enter 실클릭은 App.openApp()(네트워크·전체화면 전환)까지 타므로
 * 이번 검증 범위 밖 — 대신 위임이 "그 버튼을 향해 발생했는지"를 스파이로 검증한다.
 * ③④ 에는 뮤테이션(수정 무력화) 케이스가 붙어 있어, 고친 코드를 되돌리면 실패한다.
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

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 최소 DOM 목(mock) — p4-pin-series.test.mjs 패턴 + click() 디스패치 추가 ── */
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
  const el = {
    style: {}, dataset: {}, title: "", value: "", disabled: false,
    _text: "", _html: "", _handlers: {},
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    click() { (this._handlers.click || []).forEach((fn) => fn({})); },
    focus() {},
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  Object.defineProperty(el, "textContent", { get() { return this._text; }, set(v) { this._text = v == null ? "" : String(v); } });
  el.classList = makeClassList();
  return el;
}
/** _placeCheckboardPin 은 pin.id = Date.now() 로 채번한다. 같은 tick 안에서 여러 번 호출하면
 *  (이 테스트처럼 반복문으로 연속 배치) 밀리초가 겹쳐 id 가 중복될 수 있어 PinSeries.numbers() 의
 *  Map 키가 충돌한다 — 실사용(사람이 클릭)에서는 안 나는 문제지만 테스트 결정성을 위해 고정한다. */
function makeSeqDate() {
  let t = 1000000;
  class SeqDate extends Date { static now() { return t++; } }
  return SeqDate;
}
function makeDoc() {
  const registry = {};
  const document = {
    getElementById: (id) => (registry[id] = registry[id] || makeEl()),
    createElement: () => makeEl(),
    querySelectorAll: () => [],
    addEventListener() {}
  };
  return { document, registry };
}

/** 가벼운 환경 — App 메서드를 직접 호출해 로직만 검증(_bindSidebar/openApp 실행 없음). */
function makeLightEnv(pins) {
  const { document, registry } = makeDoc();
  const State = { checkboard: false, mode: "designer", pdfPage: 1, pins: pins || [], checkboardStart: {}, activePin: null };
  const UI = {
    $: (id) => document.getElementById(id),
    hide(id) { const e = document.getElementById(id); if (e) e.classList.add("hidden"); },
    text(id, t) { const e = document.getElementById(id); if (e) e.textContent = t; },
    val(id) { const e = document.getElementById(id); return e ? e.value : ""; },
    clearVal(id) { const e = document.getElementById(id); if (e) e.value = ""; },
    togglePinList() {}, renderPinList() {}, renderPinsOnMap() {}
  };
  const sandbox = { console, document, window: { addEventListener() {} }, navigator: { onLine: true }, SyncQueue: { count: () => Promise.resolve(0) }, State, UI, Prompt: { toast() {} }, JSON, Array, Map, Set, Date: makeSeqDate() };
  vm.createContext(sandbox);
  vm.runInContext(seriesSrc + "\n" + appSrc + "\n;globalThis.__App = App; globalThis.__PS = PinSeries;", sandbox);
  return { App: sandbox.__App, State, registry, PS: sandbox.__PS };
}

/** 전체 환경 — 실제 _bindSidebar()+PhotoBatch.init() 를 돌려 버튼 바인딩 자체를 검증.
 *  🔴 #btn-checkboard-enter/#btn-place 는 절대 .click() 하지 않는다(App.openApp() 로 이어져
 *  네트워크/전체화면 전환까지 타므로 이번 유닛 검증 범위 밖). */
function makeFullEnv(pins) {
  const { document, registry } = makeDoc();
  const State = { checkboard: false, mode: "designer", pdfPage: 1, pins: pins || [], checkboardStart: {}, activePin: null };
  const UI = {
    $: (id) => document.getElementById(id),
    hide(id) { const e = document.getElementById(id); if (e) e.classList.add("hidden"); },
    text(id, t) { const e = document.getElementById(id); if (e) e.textContent = t; },
    val(id) { const e = document.getElementById(id); return e ? e.value : ""; },
    clearVal(id) { const e = document.getElementById(id); if (e) e.value = ""; },
    togglePinList() {}, renderPinList() {}, renderPinsOnMap() {}
  };
  const sandbox = { console, document, window: { addEventListener() {} }, navigator: { onLine: true }, SyncQueue: { count: () => Promise.resolve(0) }, State, UI, Prompt: { toast() {} }, JSON, Array, Map, Set, Date: makeSeqDate() };
  vm.createContext(sandbox);
  vm.runInContext(
    seriesSrc + "\n" + pbSrc + "\n" + appSrc +
    "\n;globalThis.__App = App; globalThis.__PB = PhotoBatch;",
    sandbox
  );
  const App = sandbox.__App, PB = sandbox.__PB;
  PB.init();           // #btn-photobatch 단독 진입(기존 경로2) 바인딩
  App._bindSidebar();  // 퀵포인트·사진폴더연동·#btn-checkboard-enter(기존 경로1) 바인딩
  const photoBatchCalls = [];
  PB.open = (range) => photoBatchCalls.push(range); // 실제 모달 DOM 없이 호출만 가로채 검증
  return { App, State, registry, photoBatchCalls };
}

/* ══ ① #btn-quickpoint 의 위임 로직: 꺼짐→편집 진입(지금 구역의 등록 방식), 켜짐→배치 재개 ══
 * 🔴 [WO 20261019-unifymode] 계약 변경 — 전: 꺼짐 → #btn-checkboard-enter 클릭(무조건 CHECKER).
 *   후: 꺼짐 → App._setRegMode(PinSeries.preferredMode(), {persist:false}) — 사용자가 이 구역에 고른 등록 방식을 덮어쓰지 않는다
 *   (기본 = 번호 먼저 → "checkboard", 이 구역이 [바로 사진]이면 "photo"). 켜짐 → #btn-place(불변). */
{
  const { App, State, registry, PS } = makeLightEnv();
  let cbClicked = false, placeClicked = false;
  const cbEnterEl = registry["btn-checkboard-enter"] = registry["btn-checkboard-enter"] || makeEl();
  const btnPlaceEl = registry["btn-place"] = registry["btn-place"] || makeEl();
  cbEnterEl.addEventListener("click", () => { cbClicked = true; State.checkboard = true; });
  btnPlaceEl.addEventListener("click", () => { placeClicked = true; });
  const calls = [];
  App._setRegMode = (m, o) => { calls.push([m, o && o.persist]); State.checkboard = true; State.regMode = m; };   // openApp(화면 전환)은 이 유닛 범위 밖 — 호출 인자만 본다

  App._quickCheckboardEntry(); // State.checkboard === false, 저장값 없음 = 기본(번호 먼저)
  ok(calls.length === 1 && calls[0][0] === "checkboard" && calls[0][1] === false && !cbClicked, "① 꺼진 상태 + 기본 → _setRegMode('checkboard', persist:false)(구 CHECKER 버튼 위임 아님) → " + JSON.stringify(calls));

  App._quickCheckboardEntry(); // 이제 State.checkboard === true
  ok(placeClicked === true, "① 이미 편집 중이면 두번째 호출은 #btn-place 로 위임(배치 재개)");

  State.checkboard = false; calls.length = 0;
  PS.setRegMethod("each");   // 이 구역 = [바로 사진]
  App._quickCheckboardEntry();
  ok(calls.length === 1 && calls[0][0] === "photo" && !cbClicked, "① 이 구역이 [바로 사진]이면 진입도 'photo'(구: 무조건 CHECKER 로 덮어씀) → " + JSON.stringify(calls));
}

/* ══ ②③ 연속 클릭 시 번호 1씩 증가 + 범위는 PinSeries 정본에서 파생 ══════ */
{
  const { App, State, registry } = makeLightEnv();
  State.checkboard = true;
  // [WO 20261001-startno] 시작번호 SoT 가 배포본 State.checkboardStart(페이지·전원 공유) → 내 대역 + 직접 입력 하한
  //   (App._setCheckboardStart)로 바뀌었다. 픽스처만 정본 진입점으로 옮기고 기대값(5,6,7)은 그대로.
  App._setCheckboardStart(1, 5, "checkboard"); // 시작번호 5
  App._placeCheckboardPin({ x: 10, y: 10 });
  App._placeCheckboardPin({ x: 20, y: 20 });
  App._placeCheckboardPin({ x: 30, y: 30 });
  const labels = State.pins.map((p) => p.label);
  ok(labels.join(",") === "5,6,7", "② 연속 클릭 시 번호가 시작번호(5)부터 1씩 증가 → " + labels.join(","));

  // ③ [WO 20261001-startno] 구 _checkboardQuickRange()(페이지 전체 최소~최대)는 유일 호출부가 대역 문구로 바뀌어 삭제됐다.
  //   전: "범위가 numbers() 파생값(label=50)을 따른다" · 후: 상태 문구의 "다음" 이 내 대역 안 정본(nextInBand)을 따른다 —
  //   label=50 이면 다음 51, 다른 대역 핀(250)이 있어도 251 이 아니다.
  State.pins[2].label = "50";
  State.pins.push({ id: 99, page: 1, checkboard: true, label: "250" });
  App._updateCheckboardQuickStatus(1);
  const hintEl = registry["place-hint"];
  ok(/다음 51번/.test(hintEl.textContent) && /대역 1–100/.test(hintEl.textContent),
    "③ 상태 문구 = 내 대역(1–100) 안 다음 번호 51(다른 대역 250 무시) → " + JSON.stringify(hintEl.textContent));

  console.log("\n[뮤테이션③] 상태 문구가 대역을 무시하고 페이지 전체 최댓값+1 로 세면 실패해야 함");
  const needle = "const nx = PinSeries.nextInBand(State.pins, pg, series, this._numBand(), this._checkboardStart(pg, series));";
  const mutated = appSrc.replace(needle, "const nx = PinSeries.nextInBand(State.pins, pg, series, PinSeries.bandOf(Math.max(0, ...State.pins.map(p => parseInt(p.label, 10) || 0)) + 1), 0);");
  if (mutated === appSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { document, registry: regM } = makeDoc();
    const StateM = { checkboard: true, mode: "designer", pdfPage: 1, pins: JSON.parse(JSON.stringify(State.pins)), checkboardStart: {} };
    const UIm = { $: (id) => document.getElementById(id), hide() {}, text() {}, togglePinList() {}, renderPinList() {}, renderPinsOnMap() {} };
    const sandboxM = { console, document, window: { addEventListener() {} }, State: StateM, UI: UIm, Prompt: { toast() {} }, JSON, Array, Map, Set, Math, parseInt, Date: makeSeqDate() };
    vm.createContext(sandboxM);
    vm.runInContext(seriesSrc + "\n" + mutated + "\n;globalThis.__App = App;", sandboxM);
    sandboxM.__App._updateCheckboardQuickStatus(1);
    const hM = regM["place-hint"];
    ok(!/다음 51번/.test(hM.textContent), `뮤테이션 적용 시 대역 밖 번호를 다음으로 안내(테스트 실효성 증명) → ${JSON.stringify(hM.textContent)}`);
  }
}

/* ══ ④ [WO 20260930-moderole 재정정] 마스터: "체커는 사진을 등록하지 않을 거야" — CHECKER
 *  모드에서 방금 찍은 핀은 checkboard 계열이라 PhotoBatch 의 대상이 아니다. #btn-photobatch 는
 *  이제 CHECKER 모드에서 화면에서도 숨겨지지만(20_App._syncRegModeButtons), 그 버튼을 직접
 *  .click() 해도(방어적 확인) PhotoBatch 는 항상 content(360) 계열로 열리고, CHECKER 핀만 있는
 *  상태이므로 대상 0건(기본 범위 1~1)이다 — 구 기대(checkboard 범위로 열림)는 폐기됐다. */
{
  const { document, registry } = makeDoc();
  const State = { checkboard: false, regMode: "checkboard", mode: "designer", pdfPage: 1, pins: [], checkboardStart: {}, activePin: null };
  const UI = {
    $: (id) => document.getElementById(id),
    hide(id) { const e = document.getElementById(id); if (e) e.classList.add("hidden"); },
    text(id, t) { const e = document.getElementById(id); if (e) e.textContent = t; },
    val(id) { const e = document.getElementById(id); return e ? e.value : ""; },
    clearVal(id) { const e = document.getElementById(id); if (e) e.value = ""; },
    togglePinList() {}, renderPinList() {}, renderPinsOnMap() {}
  };
  const sandbox = { console, document, window: { addEventListener() {} }, navigator: { onLine: true }, SyncQueue: { count: () => Promise.resolve(0) }, State, UI, Prompt: { toast() {} }, requestAnimationFrame: (cb) => cb(), JSON, Array, Map, Set, Date: makeSeqDate() };
  vm.createContext(sandbox);
  vm.runInContext(
    seriesSrc + "\n" + pbSrc + "\n" + appSrc + "\n;globalThis.__App = App; globalThis.__PB = PhotoBatch;",
    sandbox
  );
  const App = sandbox.__App, PB = sandbox.__PB;
  PB.init();
  App._bindSidebar();
  State.checkboard = true;
  State.checkboardStart = { checkboard: { 1: 10 } };
  App._placeCheckboardPin({ x: 1, y: 1 });
  App._placeCheckboardPin({ x: 2, y: 2 });
  registry["btn-photobatch"].click(); // 단독 진입(범위 인자 없음) — _defaultRange() 는 페이지 전 핀("all")
  const n0 = parseInt(State.pins[0].label, 10), n1 = parseInt(State.pins[1].label, 10);
  ok(PB._range.series === "all" && PB._range.start === n0 && PB._range.end === n1 && n1 === n0 + 1,
    "④ CHECKER 모드에서 #btn-photobatch 클릭 → 방금 찍은 CHECKER 핀 2개가 범위(" + n0 + "~" + n1 + ")에 듦 → " + JSON.stringify(PB._range));

  // [WO 20261015-numunify] 뮤테이션 방향 갱신 — 옛 "content 고정"(체커 핀 제외)으로 되돌리면 ④가 깨져야 한다
  console.log("\n[뮤테이션④] _defaultRange() 를 옛 content 고정으로 되돌리면 실패해야 함");
  const needle = 'const series = "all";';
  const mutated = pbSrc.replace(needle, 'const series = "content";');
  if (mutated === pbSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { document: docM, registry: regM } = makeDoc();
    const StateM = { checkboard: true, regMode: "checkboard", mode: "designer", pdfPage: 1, pins: [], checkboardStart: { checkboard: { 1: 10 } } };
    const UIm = { $: (id) => docM.getElementById(id), hide() {}, text() {}, val(id) { const e = docM.getElementById(id); return e ? e.value : ""; }, clearVal(id) { const e = docM.getElementById(id); if (e) e.value = ""; }, togglePinList() {}, renderPinList() {}, renderPinsOnMap() {} };
    const sandboxM = { console, document: docM, window: { addEventListener() {} }, navigator: { onLine: true }, SyncQueue: { count: () => Promise.resolve(0) }, State: StateM, UI: UIm, Prompt: { toast() {} }, requestAnimationFrame: (cb) => cb(), JSON, Array, Map, Set, Date: makeSeqDate() };
    vm.createContext(sandboxM);
    vm.runInContext(seriesSrc + "\n" + mutated + "\n" + appSrc + "\n;globalThis.__App = App; globalThis.__PB = PhotoBatch;", sandboxM);
    sandboxM.__PB.init();
    sandboxM.__App._bindSidebar();
    sandboxM.__App._placeCheckboardPin({ x: 1, y: 1 });
    regM["btn-photobatch"].click();
    ok(sandboxM.__PB._range.series === "content",
      `뮤테이션 적용 시 CHECKER 핀이 범위에서 빠져 ④가 깨짐(구 동작 재현, 테스트 실효성 증명) → ${sandboxM.__PB._range.series}`);
  }
}

/* ══ ⑤ 기존 진입 경로 2개 + 새 진입점 2개가 모두 바인딩된다(실클릭 없이 구조만 확인) ══ */
{
  const { registry } = makeFullEnv();
  ok((registry["btn-checkboard-enter"]._handlers.click || []).length >= 1,
    "⑤ 기존 경로1 — #btn-checkboard-enter 단독 진입 핸들러가 여전히 바인딩됨");
  ok((registry["btn-photobatch"]._handlers.click || []).length >= 1,
    "⑤ 기존 경로2 — #btn-photobatch 단독 진입 핸들러가 여전히 바인딩됨(35_PhotoBatch.js init())");
  ok((registry["btn-quickpoint"]._handlers.click || []).length >= 1,
    "⑤ 신규 — #btn-quickpoint(사이드바 툴레일 '포인트') 핸들러가 바인딩됨");
  // [WO 20260918] 구 #btn-checkboard-photobatch('사진 폴더 연동' 전용 지름길) 은 렌더 고아라
  // 제거됐다 — #btn-photobatch 가 모드 인지형으로 바뀌며 동일 기능을 흡수했다(④ 참조).
}

console.log(failed ? `\n총 ${failed}건 실패` : "\n전부 통과");
process.exit(failed ? 1 : 0);
