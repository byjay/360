/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p79-regmode-3way.test.mjs)
 *
 * [WO 20260929 2모드 전환] 마스터 원문: "모드는 360과 CHECKER" / "배포하고 모드
 *  360 CHECKER로 바꿔". [보기](view) 세그먼트 버튼을 제거하고 CHECKER(checkboard)·
 *  360(photo) 2모드만 디자이너 UI에서 선택 가능하게 한다. 기본 진입 모드 = CHECKER.
 *  regMode 내부 값 "view"는 여전히 존재할 수 있으나(방어적 가드) 어떤 UI 버튼도
 *  더 이상 그 값으로 전환을 호출하지 않는다 — 기존 저장값(구 "designer")은
 *  진입 시 checkboard 로 정규화한다.
 *
 * 원 발주서(WO 20260929 최초, 지휘자 정정) 동작표 — 이하 그대로 유지:
 *   | 동작        | 체크보드(CHECKER)                | 사진 등록(360)                    |
 *   | 빈 곳 클릭   | 번호 핀만(폼·팝업·파일창·확인창 없음) | 핀 생성 즉시 파일창(동기), 취소해도 핀 유지 |
 *   | 기존 핀 클릭 | 패널(PinActionPop) 열림(번호수정 가능) | 패널 열림(파일창 아님)              |
 *
 * 섹션 A/B/C: 20_App.js·11_UI.js의 regMode 분기 로직(내부적으로 "view" 값도 여전히
 *   유효하게 처리해야 함 — 방어적 가드 회귀 방지). 섹션 D~G: 2모드 전환 자체
 *   ([보기] 버튼 DOM 제거·기본모드 CHECKER·저장값 정규화·뷰어 권한 가드·표기 통일).
 *
 * 실제 모듈 소스(20_App.js / 11_UI.js / 01b_PinSeries.js / index.html)를 그대로 vm 에
 * 평가하거나 정적 검사한다(목 구현 아님). 뮤테이션 5건 — 되돌리면 반드시 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const appSrc = rd("public/js/modules/20_App.js");
const uiSrc = rd("public/js/modules/11_UI.js");
const seriesSrc = rd("public/js/modules/01b_PinSeries.js");
const htmlSrc = rd("public/index.html");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ══════════════════════════════════════════════════════════════
   섹션 A — 20_App.js: _togglePlacing 가드 + _handlePlaceClick 라우팅
   ══════════════════════════════════════════════════════════════ */
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
  };
}
function makeEl() {
  const el = {
    style: {}, dataset: {}, title: "", value: "", disabled: false, _text: "", _handlers: {},
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    click() { (this._handlers.click || []).forEach((fn) => fn({})); },
    focus() {}, querySelector() { return null; }, querySelectorAll() { return []; }
  };
  Object.defineProperty(el, "textContent", { get() { return this._text; }, set(v) { this._text = v == null ? "" : String(v); } });
  el.classList = makeClassList();
  return el;
}
function makeDoc() {
  const registry = {};
  return { registry, document: { getElementById: (id) => (registry[id] = registry[id] || makeEl()), createElement: () => makeEl(), querySelectorAll: () => [], addEventListener() {} } };
}
function makeAppSandbox() {
  const { document, registry } = makeDoc();
  const calls = { placeCheckboardPin: [], openPinMediaPicker: [], viewportToPercent: [] };
  const State = { placing: false, checkboard: false, regMode: "view", mode: "designer", pdfPage: 1, pins: [] };
  const UI = {
    $: (id) => document.getElementById(id),
    hide(id) { const e = document.getElementById(id); if (e) e.classList.add("hidden"); },
    show(id) { const e = document.getElementById(id); if (e) e.classList.remove("hidden"); },
    text() {}, val() { return ""; }, clearVal() {}, togglePinList() {}, renderPinList() {}, renderPinsOnMap() {}
  };
  const toasts = [];
  const Prompt = { toast: (m) => toasts.push(m) };
  const MapCtrl = {
    viewportToPercent: (x, y) => { calls.viewportToPercent.push([x, y]); return { x: 10, y: 10 }; },
    flyTo() {}, _applyIso() {}
  };
  const sandbox = { console, document, window: { addEventListener() {} }, State, UI, Prompt, MapCtrl, JSON, Array, Map, Set, Date, setTimeout };
  vm.createContext(sandbox);
  vm.runInContext(seriesSrc + "\n" + appSrc + "\n;globalThis.__App = App;", sandbox);
  const App = sandbox.__App;
  // 실제 _placeCheckboardPin/_openPinMediaPicker 를 스파이로 감싼다(원본 로직은 그대로 실행).
  const origPlace = App._placeCheckboardPin.bind(App);
  App._placeCheckboardPin = (...a) => { calls.placeCheckboardPin.push(a); return origPlace(...a); };
  const origPicker = App._openPinMediaPicker.bind(App);
  App._openPinMediaPicker = (...a) => { calls.openPinMediaPicker.push(a); return origPicker(...a); };
  App._updateSyncBadge = () => {}; App._autoSave = () => {};
  return { App, State, UI, registry, calls, toasts };
}

console.log("[A1] 보기(view) 모드 — _togglePlacing() 이 배치 진입을 막는다(단일 관문)");
{
  const { App, State, toasts } = makeAppSandbox();
  State.regMode = "view";
  App._togglePlacing();
  ok(State.placing === false, "view 모드에서 배치 모드가 켜지지 않음");
  ok(toasts.length === 1, "이유를 토스트로 알림(조용한 무시 금지) → " + JSON.stringify(toasts));
}

console.log("\n[A2] 체크보드 모드 — 빈 곳 클릭 = 번호 핀만(파일창 호출 없음)");
{
  const { App, State, calls } = makeAppSandbox();
  State.regMode = "checkboard"; State.placing = true;
  App._handlePlaceClick({ clientX: 1, clientY: 1 });
  ok(calls.placeCheckboardPin.length === 1, "_placeCheckboardPin 1회 호출");
  ok(calls.openPinMediaPicker.length === 0, "_openPinMediaPicker 호출 없음(다른 반응 없음)");
  ok(State.pins.length === 1 && State.pins[0].label === "1", "번호 핀 1개 생성");
  ok(State.placing === true, "배치모드 유지(연속 찍기)");
}

console.log("\n[A3] 사진 등록 모드 — 빈 곳 클릭 = 핀 생성 즉시 파일창(동기)");
{
  const { App, State, calls } = makeAppSandbox();
  State.regMode = "photo"; State.placing = true;
  App._handlePlaceClick({ clientX: 1, clientY: 1 });
  ok(calls.placeCheckboardPin.length === 1, "_placeCheckboardPin 1회 호출");
  ok(calls.openPinMediaPicker.length === 1, "_openPinMediaPicker 1회 호출(동기, 같은 클릭 안에서)");
  ok(calls.openPinMediaPicker[0][0].id === State.pins[0].id, "_openPinMediaPicker 에 방금 만든 핀이 그대로 전달됨");
}

console.log("\n[뮤테이션A] 체크보드 분기에서도 _openPinMediaPicker 를 호출하도록 되돌리면 — 실패해야 함");
{
  const needle = "      if (State.regMode === \"checkboard\") {\n        this._placeCheckboardPin(pct);\n        return;";
  if (!appSrc.includes(needle.split("\n")[0])) { console.log("  FAIL 뮤테이션A 대상 못 찾음(소스 변경?)"); failed++; }
  else {
    const mutated = appSrc.replace(
      "      if (State.regMode === \"checkboard\") {\n        this._placeCheckboardPin(pct);\n        return; // placing 유지(다음 클릭도 번호 핀). 종료는 '＋ 번호 핀 찍기' 토글로.\n      }",
      "      if (State.regMode === \"checkboard\") {\n        const p = this._placeCheckboardPin(pct);\n        this._openPinMediaPicker(p);\n        return;\n      }"
    );
    if (mutated === appSrc) { console.log("  FAIL 뮤테이션A 치환 실패(needle 불일치)"); failed++; }
    else {
      const { document: docM } = makeDoc();
      const StateM = { placing: true, checkboard: true, regMode: "checkboard", mode: "designer", pdfPage: 1, pins: [], checkboardStart: {} };
      const UIm = { $: (id) => docM.getElementById(id), hide() {}, show() {}, text() {}, val() { return ""; }, clearVal() {}, togglePinList() {}, renderPinList() {}, renderPinsOnMap() {} };
      const sandboxM = { console, document: docM, window: { addEventListener() {} }, State: StateM, UI: UIm, Prompt: { toast() {} }, MapCtrl: { viewportToPercent: () => ({ x: 1, y: 1 }) }, JSON, Array, Map, Set, Date, setTimeout };
      vm.createContext(sandboxM);
      vm.runInContext(seriesSrc + "\n" + mutated + "\n;globalThis.__App = App;", sandboxM);
      const AppM = sandboxM.__App;
      AppM._updateSyncBadge = () => {}; AppM._autoSave = () => {};
      let pickerCalled = 0;
      const origPicker = AppM._openPinMediaPicker.bind(AppM);
      AppM._openPinMediaPicker = (...a) => { pickerCalled++; return origPicker(...a); };
      AppM._handlePlaceClick({ clientX: 1, clientY: 1 });
      ok(pickerCalled === 1, "뮤테이션 적용 시 체크보드에서도 파일창이 열림(A2가 깨짐을 증명) → " + pickerCalled + "회");
    }
  }
}

/* ══════════════════════════════════════════════════════════════
   섹션 B — 11_UI.js: 기존 핀 클릭 라우팅(패널 vs 보기) + 화면 리셋 방지
   ══════════════════════════════════════════════════════════════ */
function makeUiEl(tag) {
  const el = {
    tagName: tag || "div", style: {}, dataset: {}, title: "", value: "", disabled: false,
    _text: "", _html: "", _children: [], _handlers: {},
    appendChild(c) { this._children.push(c); return c; },
    setAttribute(k, v) { this.dataset["attr_" + k] = String(v); },
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
  };
  Object.defineProperty(el, "textContent", { get() { return this._text; }, set(v) { this._text = v == null ? "" : String(v); } });
  Object.defineProperty(el, "innerHTML", { get() { return this._html; }, set(v) { this._html = String(v); if (v === "") this._children = []; } });
  Object.defineProperty(el, "className", {
    get() { return Array.from(this.classList._set).join(" "); },
    set(v) { this.classList = makeClassList(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c)); }
  });
  el.classList = makeClassList();
  return el;
}
function makeUiDoc() {
  const registry = {};
  return { registry, document: { getElementById: (id) => (registry[id] = registry[id] || makeUiEl()), createElement: (t) => makeUiEl(t), querySelectorAll: () => [], addEventListener() {} } };
}
const makeLocalStorage = () => { const store = {}; return { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } }; };

function makeUiEnv(regMode, editMode) {
  const { document, registry } = makeUiDoc();
  const calls = { setActivePin: [], onPinTap: [], panOpen: [] };
  // [WO 20260930-fixmode] 모드 = 작업공간 — 360(photo) 모드엔 360 핀만 보인다. 그 모드의 "기존 핀"은 360 계열이어야
  // 클릭 라우팅을 검사할 수 있다(종전 fixture 는 모든 모드에서 CHECKER 핀 — 이제 360 모드에선 렌더되지 않는다).
  const State = { pins: [{ id: "p1", x: 10, y: 10, page: 1, label: "1", checkboard: regMode !== "photo" }], pdfPage: 1, mode: "designer", regMode, editMode: !!editMode, activePin: null, zoneView: null, zones: [], pinEditUnlocked: null, placing: false, isoView: false };
  const App = { setActivePin: (id) => calls.setActivePin.push(id), onPinTap: (p) => calls.onPinTap.push(p), pinHasContent: () => false };
  const PinActionPop = { open: (id) => calls.panOpen.push(id) };
  const sandbox = { console, document, State, localStorage: makeLocalStorage(), App, PinActionPop, JSON, Map, Set };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(seriesSrc + "\n" + uiSrc + "\n;globalThis.__UI = UI;", sandbox);
  sandbox.__UI.renderPinsOnMap();
  const marker = registry["pins-layer"]._children[0];
  return { marker, calls, registry };
}

console.log("\n[B1] 체크보드 모드 — 기존 핀 클릭 → 패널(PinActionPop) 열림, onPinTap(화면 리셋) 없음");
{
  const { marker, calls } = makeUiEnv("checkboard", false);
  marker._handlers.click.forEach((fn) => fn({ stopPropagation() {} }));
  ok(calls.panOpen.length === 1 && calls.panOpen[0] === "p1", "PinActionPop.open('p1') 호출됨");
  ok(calls.onPinTap.length === 0, "App.onPinTap 호출 없음(화면 줌/ISO 리셋 없음)");
}

console.log("\n[B2] 사진 등록 모드 — 기존 핀 클릭 → 패널 열림(파일창 아님)");
{
  const { marker, calls } = makeUiEnv("photo", false);
  marker._handlers.click.forEach((fn) => fn({ stopPropagation() {} }));
  ok(calls.panOpen.length === 1 && calls.panOpen[0] === "p1", "PinActionPop.open('p1') 호출됨");
  ok(calls.onPinTap.length === 0, "App.onPinTap 호출 없음");
}

console.log("\n[B3] 보기 모드 — 기존 핀 클릭 → 기존 보기(onPinTap), 패널 아님");
{
  const { marker, calls } = makeUiEnv("view", false);
  marker._handlers.click.forEach((fn) => fn({ stopPropagation() {} }));
  ok(calls.onPinTap.length === 1, "App.onPinTap 호출됨(기존 보기)");
  ok(calls.panOpen.length === 0, "PinActionPop.open 호출 없음");
}

console.log("\n[뮤테이션B] 체크보드/사진 모드 판정을 지우면(State.editMode 만 확인) — B1이 실패해야 함");
{
  const needle = "const wantsPanel = State.editMode || State.regMode === \"checkboard\" || State.regMode === \"photo\";";
  if (!uiSrc.includes(needle)) { console.log("  FAIL 뮤테이션B 대상 못 찾음(소스 변경?)"); failed++; }
  else {
    const mutated = uiSrc.replace(needle, "const wantsPanel = State.editMode;");
    const { document: docM, registry: regM } = makeUiDoc();
    const StateM = { pins: [{ id: "p1", x: 10, y: 10, page: 1, label: "1", checkboard: true }], pdfPage: 1, mode: "designer", regMode: "checkboard", editMode: false, activePin: null, zoneView: null, zones: [], pinEditUnlocked: null, placing: false, isoView: false };
    const callsM = { onPinTap: [] };
    const AppM = { setActivePin() {}, onPinTap: (p) => callsM.onPinTap.push(p), pinHasContent: () => false };
    const sandboxM = { console, document: docM, State: StateM, localStorage: makeLocalStorage(), App: AppM, PinActionPop: { open() {} }, JSON, Map, Set };
    sandboxM.window = sandboxM;
    vm.createContext(sandboxM);
    vm.runInContext(seriesSrc + "\n" + mutated + "\n;globalThis.__UI = UI;", sandboxM);
    sandboxM.__UI.renderPinsOnMap();
    const markerM = regM["pins-layer"]._children[0];
    markerM._handlers.click.forEach((fn) => fn({ stopPropagation() {} }));
    ok(callsM.onPinTap.length === 1, "뮤테이션 적용 시 체크보드에서 핀 클릭이 onPinTap(화면 리셋)으로 샘 → " + callsM.onPinTap.length + "회");
  }
}

/* ══════════════════════════════════════════════════════════════
   섹션 C — 11_UI.js: 체크보드 모드 렌더 = 번호만(장식 최소화)
   ══════════════════════════════════════════════════════════════ */
function runRender(regMode, pins) {
  const { document, registry } = makeUiDoc();
  const State = { pins, pdfPage: 1, mode: "viewer", regMode, activePin: null, zoneView: null, zones: [] };
  const App = { pinHasContent: () => false };
  const sandbox = { console, document, State, localStorage: makeLocalStorage(), App, JSON, Map, Set };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(seriesSrc + "\n" + uiSrc + "\n;globalThis.__UI = UI;", sandbox);
  sandbox.__UI.renderPinsOnMap();
  return registry["pins-layer"]._children;
}

console.log("\n[C1] 체크보드 모드 — 체크보드 핀은 번호만(펄스·그라디언트 장식 없음)");
{
  const markers = runRender("checkboard", [{ id: "p1", x: 5, y: 5, page: 1, label: "3", checkboard: true }]);
  const html = markers[0]._html;
  ok(!/pin-pulse/.test(html), "pin-pulse 없음");
  ok(!/pgbody/.test(html), "그라디언트(defs) 없음 — 단순 도형만");
  ok(/>3</.test(html), "번호(3)는 그대로 표시됨 → " + html.replace(/\s+/g, " ").slice(0, 160));
}

console.log("\n[C2] 체크보드 모드에서도 콘텐츠(일반) 핀은 기존 장식 유지");
{
  const markers = runRender("checkboard", [{ id: "p2", x: 5, y: 5, page: 1, label: "위치A" }]);
  const html = markers[0]._html;
  ok(/pgbody/.test(html), "일반 핀은 그라디언트(defs) 유지 → 간소화는 체크보드 핀 전용");
}

console.log("\n[C3] 사진등록·보기 모드에서는 체크보드 핀도 기존 표시(간소화 아님)");
{
  const markers = runRender("photo", [{ id: "p1", x: 5, y: 5, page: 1, label: "3", checkboard: true }]);
  const html = markers[0]._html;
  ok(/pgbody/.test(html), "photo 모드에서는 체크보드 핀도 기존 장식 그대로");
}

/* ══════════════════════════════════════════════════════════════
   섹션 D — index.html: [보기] 세그먼트 버튼 완전 제거 + CHECKER/360 표기
   ══════════════════════════════════════════════════════════════ */
console.log("\n[D1] index.html — [보기] 세그먼트 버튼 DOM에 없음, CHECKER/360 라벨");
{
  ok(!/id="btn-regmode-view"/.test(htmlSrc), "btn-regmode-view 요소 없음");
  ok(/<button id="btn-regmode-checkboard"[^>]*>CHECKER<\/button>/.test(htmlSrc), "체크보드 버튼 라벨=CHECKER");
  ok(/<button id="btn-regmode-photo"[^>]*>360<\/button>/.test(htmlSrc), "사진등록 버튼 라벨=360");
}

console.log("\n[뮤테이션C] [보기] 버튼을 세그먼트에 되살리면 — D1이 실패해야 함");
{
  const needle = '<button id="btn-regmode-checkboard" class="regmode-btn" type="button" title="CHECKER — 도면 클릭 시 번호 핀만 생성">CHECKER</button>';
  if (!htmlSrc.includes(needle)) { console.log("  FAIL 뮤테이션C 대상 못 찾음(소스 변경?)"); failed++; }
  else {
    const mutated = htmlSrc.replace(needle,
      '<button id="btn-regmode-view" class="regmode-btn" type="button">보기</button>\n      ' + needle);
    const stillPasses = !/id="btn-regmode-view"/.test(mutated);
    ok(stillPasses === false, "뮤테이션 적용 시 btn-regmode-view 가 되살아나 D1 무결성이 깨짐을 증명");
  }
}

/* ══════════════════════════════════════════════════════════════
   섹션 E — 01b_PinSeries.js: 기본 진입 모드 = CHECKER, 구 저장값 정규화
   ══════════════════════════════════════════════════════════════ */
function makeSeriesSandbox(src, storedValue) {
  const store = {};
  if (storedValue !== undefined) store["wm_pin_default_mode"] = storedValue;
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  const sandbox = { console, localStorage, JSON };
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__PinSeries = PinSeries;", sandbox);
  return sandbox.__PinSeries;
}

console.log("\n[E1] PinSeries.preferredMode() — 저장값 없음 → 기본값 CHECKER");
{
  const PS = makeSeriesSandbox(seriesSrc, undefined);
  ok(PS.preferredMode() === "checkboard", "기본 진입 모드 = checkboard(CHECKER) → " + PS.preferredMode());
}

console.log("\n[E2] PinSeries.preferredMode() — 구 저장값 'designer'(구 [보기]) → checkboard 로 정규화");
{
  const PS = makeSeriesSandbox(seriesSrc, "designer");
  ok(PS.preferredMode() === "checkboard", "정규화됨 → " + PS.preferredMode());
}

console.log("\n[뮤테이션D] DEFAULT_MODE 를 'view' 로 되돌리면 — E1이 실패해야 함");
{
  const needle = 'DEFAULT_MODE: "checkboard",';
  if (!seriesSrc.includes(needle)) { console.log("  FAIL 뮤테이션D 대상 못 찾음(소스 변경?)"); failed++; }
  else {
    const mutated = seriesSrc.replace(needle, 'DEFAULT_MODE: "view",');
    const PSm = makeSeriesSandbox(mutated, undefined);
    ok(PSm.preferredMode() !== "checkboard", "뮤테이션 적용 시 기본값이 'view' 로 샘(E1이 깨짐을 증명) → " + PSm.preferredMode());
  }
}

/* ══════════════════════════════════════════════════════════════
   섹션 F — 20_App.js: _setRegMode 뷰어 권한 가드(생성 모드 전환 불가) 회귀 방지
   ══════════════════════════════════════════════════════════════ */
/** _setRegMode 만 좁게 검사하는 경량 샌드박스 — openApp()은 스파이로 대체해 부작용(document.body 등
 *  전체 렌더 체인)을 실행하지 않는다. 가드 자체(뷰어 진입 차단)만 정밀 검사. */
function makeRegModeGuardSandbox(src, initialMode) {
  const { document } = makeDoc();
  const State = { placing: false, checkboard: false, regMode: "view", mode: initialMode, pdfPage: 1, pins: [] };
  const openAppCalls = [];
  const sandbox = { console, document, window: { addEventListener() {} }, State, UI: { $: () => null }, Prompt: { toast() {} }, MapCtrl: { viewportToPercent: () => ({ x: 1, y: 1 }) }, JSON, Array, Map, Set, Date, setTimeout };
  vm.createContext(sandbox);
  vm.runInContext(seriesSrc + "\n" + src + "\n;globalThis.__App = App;", sandbox);
  const App = sandbox.__App;
  App.openApp = (...a) => { openAppCalls.push(a); };
  App._togglePlacing = () => {};
  return { App, State, openAppCalls };
}

console.log("\n[F1] _setRegMode — State.mode !== 'designer'(뷰어) 이면 openApp 호출 없이 무시");
{
  const { App, State, openAppCalls } = makeRegModeGuardSandbox(appSrc, "viewer");
  App._setRegMode("checkboard");
  ok(openAppCalls.length === 0, "뷰어에서 _setRegMode 호출 시 openApp 미호출 → " + openAppCalls.length + "회");
  ok(State.regMode === "view", "regMode 도 불변 → " + State.regMode);
}

console.log("\n[뮤테이션E] 뷰어 가드를 지우면 — F1이 실패해야 함");
{
  const needle = 'if (State.mode !== "designer") return; // 편집 화면 전용(뷰어 앱에는 세그먼트가 없음)';
  if (!appSrc.includes(needle)) { console.log("  FAIL 뮤테이션E 대상 못 찾음(소스 변경?)"); failed++; }
  else {
    const mutated = appSrc.replace(needle, "// guard removed");
    const { App, openAppCalls } = makeRegModeGuardSandbox(mutated, "viewer");
    App._setRegMode("checkboard");
    ok(openAppCalls.length > 0, "뮤테이션 적용 시 뷰어에서도 openApp 이 호출됨(F1이 깨짐을 증명) → " + openAppCalls.length + "회");
  }
}

/* ══════════════════════════════════════════════════════════════
   섹션 G — 사용자 노출 문자열 표기 통일: "체크보드"→CHECKER, "사진 등록"→360
   (데이터 개념어 "체크보드 핀"/"체크보드 계열"/placeholder 예시는 허용 목록 — 대상 아님)
   ══════════════════════════════════════════════════════════════ */
console.log("\n[G1] 세그먼트/설정 블록/필터칩/도움말 — 구 모드 명칭 잔존 0");
{
  ok(!/<span class="checkboard-menu-title">체크보드<\/span>/.test(htmlSrc), "메뉴 타이틀 '체크보드' 문자열 없음(CHECKER로 교체됨)");
  ok(/<span class="checkboard-menu-title">CHECKER<\/span>/.test(htmlSrc), "메뉴 타이틀 = CHECKER");
  // [WO 20261001-startno] 전: <label for="settings-checkboard-start">CHECKER 시작 번호 · 후: 시작번호 입력이 번호 대역 시트로
  //   일원화되어 블록 제목은 모드 공통 "번호 대역"(CHECKER·360 같은 대역) — 구 모드 명칭 잔존 0 취지는 아래 줄이 그대로 본다.
  ok(/<span id="settings-checkboard-start-label"[^>]*>번호 대역<\/span>/.test(htmlSrc), "설정 블록 제목(정적 기본값) = 번호 대역(모드 공통)");
  ok(!/<label[^>]*>체크보드 시작 번호<\/label>/.test(htmlSrc), "구 표기 라벨 '체크보드 시작 번호' 없음(주석 언급은 허용)");
  ok(/checkboard: "CHECKER"/.test(seriesSrc), "핀 필터 칩 라벨(PinSeries.LABELS.checkboard) = CHECKER");
  ok(!appSrc.includes('"체크보드 모드"'), "20_App.js 문자열 리터럴 '체크보드 모드' 잔존 0");
  ok(!appSrc.includes('"사진 등록 모드"'), "20_App.js 문자열 리터럴 '사진 등록 모드' 잔존 0");
  const helpSrc = rd("public/js/modules/36_Help.js");
  ok(helpSrc.includes('"CHECKER 모드 — 버튼 한 번으로'), "36_Help.js checkerboard 도움말 = CHECKER 모드");
  ok(!helpSrc.includes('"체크보드 모드 — 버튼 한 번으로'), "36_Help.js 구 표기 없음");
}

console.log(failed ? `\n총 ${failed}건 실패` : "\n전부 통과");
process.exit(failed ? 1 : 0);
