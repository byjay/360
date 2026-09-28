/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p79-regmode-3way.test.mjs)
 *
 * 발주서(WO 20260929, 마스터 원문 + 지휘자 정정):
 *  "체크보드는 핀만 생성하는거고 뷰모드와 체크보드모드로 구현해 … 사진 등록 모드는
 *   핀을 생성하는 순간 바로 사진을 등록하게 하라는 거지. 체크 보드는 그냥 다른 거
 *   아무 반응 없이 그냥 클릭하는 곳에서 번호만 있는 핀만 생성이 되게 해라고. 핀을
 *   클릭했을 때 번호 수정이나 뭔가 등록은 가능하게 해줘."
 *
 * 정본 동작표:
 *   | 동작        | 체크보드                         | 사진 등록                          |
 *   | 빈 곳 클릭   | 번호 핀만(폼·팝업·파일창·확인창 없음) | 핀 생성 즉시 파일창(동기), 취소해도 핀 유지 |
 *   | 기존 핀 클릭 | 패널(PinActionPop) 열림(번호수정 가능) | 패널 열림(파일창 아님)              |
 *   보기(view) 모드는 생성 없음 — 배치 진입 자체가 막힌다.
 *
 * 실제 모듈 소스(20_App.js / 11_UI.js / 01b_PinSeries.js)를 그대로 vm 에 평가해 검사한다
 * (목 구현 아님). 뮤테이션 3건 — 되돌리면 반드시 실패한다.
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
  const State = { pins: [{ id: "p1", x: 10, y: 10, page: 1, label: "1", checkboard: true }], pdfPage: 1, mode: "designer", regMode, editMode: !!editMode, activePin: null, zoneView: null, zones: [], pinEditUnlocked: null, placing: false, isoView: false };
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

console.log(failed ? `\n총 ${failed}건 실패` : "\n전부 통과");
process.exit(failed ? 1 : 0);
