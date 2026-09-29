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
 *  ④ [WO 20260918 갱신] 구 전용 지름길(#btn-checkboard-photobatch) 은 렌더 고아라 제거됐다.
 *     대신 #btn-photobatch(단독 진입)가 State.checkboard 를 참조해 방금 찍은 체크보드
 *     범위로 자동으로 열린다(35_PhotoBatch.js _defaultRange, 하드코딩 제거).
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
  vm.runInContext(seriesSrc + "\n" + appSrc + "\n;globalThis.__App = App;", sandbox);
  return { App: sandbox.__App, State, registry };
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

/* ══ ① #btn-quickpoint 의 위임 로직: 꺼짐→체크보드 진입, 켜짐→배치 재개 ══ */
{
  const { App, State, registry } = makeLightEnv();
  let cbClicked = false, placeClicked = false;
  // getElementById 는 지연 생성이므로 먼저 강제 생성한 뒤 스파이 핸들러를 붙인다(makeDoc 과 동일한 makeEl 재사용).
  const cbEnterEl = registry["btn-checkboard-enter"] = registry["btn-checkboard-enter"] || makeEl();
  const btnPlaceEl = registry["btn-place"] = registry["btn-place"] || makeEl();
  cbEnterEl.addEventListener("click", () => { cbClicked = true; State.checkboard = true; });
  btnPlaceEl.addEventListener("click", () => { placeClicked = true; });

  App._quickCheckboardEntry(); // State.checkboard === false
  ok(cbClicked === true && State.checkboard === true, "① 꺼진 상태에서 호출 → #btn-checkboard-enter 로 위임(체크보드 진입)");

  App._quickCheckboardEntry(); // 이제 State.checkboard === true
  ok(placeClicked === true, "① 이미 체크보드면 두번째 호출은 #btn-place 로 위임(배치 재개)");
}

/* ══ ②③ 연속 클릭 시 번호 1씩 증가 + 범위는 PinSeries 정본에서 파생 ══════ */
{
  const { App, State } = makeLightEnv();
  State.checkboard = true;
  // [WO 20260929 addendum] State.checkboardStart 형식이 계열별 중첩으로 바뀌었다(App._normalizeCheckboardStart).
  State.checkboardStart = { checkboard: { 1: 5 } }; // 시작번호 5
  App._placeCheckboardPin({ x: 10, y: 10 });
  App._placeCheckboardPin({ x: 20, y: 20 });
  App._placeCheckboardPin({ x: 30, y: 30 });
  const labels = State.pins.map((p) => p.label);
  ok(labels.join(",") === "5,6,7", "② 연속 클릭 시 번호가 시작번호(5)부터 1씩 증가 → " + labels.join(","));

  // ③ 범위는 PinSeries.numbers() 파생값(label 우선)을 그대로 반영해야 한다.
  State.pins[2].label = "50"; // SoT=PinSeries 이므로 범위가 이 값을 따라가야 정상
  const range = App._checkboardQuickRange(1);
  ok(range.start === 5 && range.end === 50,
    "③ 범위(시작~마지막)가 PinSeries.numbers() 파생값을 그대로 따름 → " + JSON.stringify(range));

  console.log("\n[뮤테이션③] _checkboardQuickRange 가 PinSeries 를 우회해 자체 순번(인덱스)으로 세면 실패해야 함");
  const needle = `        const info = map.get(p.id);
        if (!info) return;
        if (start === null || info.no < start) start = info.no;
        if (end === null || info.no > end) end = info.no;`;
  const mutated = appSrc.replace(needle,
    `        idx++;
        if (start === null || idx < start) start = idx;
        if (end === null || idx > end) end = idx;`
  ).replace(
    "let start = null, end = null;",
    "let start = null, end = null, idx = 0;"
  );
  if (mutated === appSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { document } = makeDoc();
    const StateM = { checkboard: true, mode: "designer", pdfPage: 1, pins: JSON.parse(JSON.stringify(State.pins)), checkboardStart: { checkboard: { 1: 5 } } };
    const UIm = { $: (id) => document.getElementById(id), hide() {}, text() {}, togglePinList() {}, renderPinList() {}, renderPinsOnMap() {} };
    const sandboxM = { console, document, window: { addEventListener() {} }, State: StateM, UI: UIm, Prompt: { toast() {} }, JSON, Array, Map, Set, Date: makeSeqDate() };
    vm.createContext(sandboxM);
    vm.runInContext(seriesSrc + "\n" + mutated + "\n;globalThis.__App = App;", sandboxM);
    const rangeM = sandboxM.__App._checkboardQuickRange(1);
    ok(rangeM.end !== 50, `뮤테이션 적용 시 정본(label=50)을 무시하고 자체 인덱스로 계산해 깨짐(테스트 실효성 증명) → end=${rangeM.end}`);
  }
}

/* ══ ④ [WO 20260918 갱신] 체크보드 모드에서 #btn-photobatch(단독 진입, 사이드 툴바 "사진" 그룹)를
 *  눌러도 방금 찍은 체크보드 범위로 열린다 — 구 전용 지름길(#btn-checkboard-photobatch) 은
 *  렌더 고아라 제거됐고(style.css:4914 영구 hidden + 새 toolbar 위임 대상 없음), 대체 경로는
 *  35_PhotoBatch.js _defaultRange() 가 State.checkboard 를 참조해 series 를 자동 선택하는 것이다. */
{
  const { document, registry } = makeDoc();
  // [WO 20260929 addendum] State.checkboard(불리언)만으로는 계열을 못 가른다 — 35_PhotoBatch.js
  // _defaultRange() 가 이제 State.regMode 를 본다(§10 SoT, 20_App.js _placeCheckboardPin 과 동일).
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
  registry["btn-photobatch"].click(); // 단독 진입(범위 인자 없음) — _defaultRange() 가 현재 모드를 봐야 함
  ok(PB._range.series === "checkboard" && PB._range.start === 10 && PB._range.end === 11,
    "④ 체크보드 모드에서 #btn-photobatch 클릭 → PhotoBatch 가 방금 찍은 체크보드 범위(10~11)로 열림 → " + JSON.stringify(PB._range));

  console.log("\n[뮤테이션④] _defaultRange() 가 다시 series=\"content\" 로 고정되면 실패해야 함");
  const needle = 'const series = (typeof State !== "undefined" && State.regMode === "checkboard") ? "checkboard" : "content";';
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
    ok(sandboxM.__PB._range.series !== "checkboard",
      `뮤테이션 적용 시 체크보드 모드에서도 content 로 고정돼 깨짐(테스트 실효성 증명) → ${sandboxM.__PB._range.series}`);
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
