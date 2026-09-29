/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p12-pin-type-place.test.mjs)
 *
 * 마스터 지시(2026-09-03): "핀을 종류별로 박는거 부터 구현해"
 *  → 배치 전 종류(아이콘)를 골라 연속 배치 내내 유지 + 종류별 필터 칩(kind 칩과 공존).
 *
 *  ① 배치 모드(체크보드 연속 배치)에서 종류를 고르면 그 종류로 핀이 생성된다
 *  ② 고른 종류가 연속 배치에서 유지된다(매번 재선택 불필요)
 *  ③ 종류 미선택 시 기본 number 로 종전과 동일(pin.icon 필드 자체 생략 — 하위호환)
 *  ④ 종류 필터가 도면 마커(11_UI)·미니맵 점(07_Radar) 양쪽에 동일 적용된다
 *  ⑤ 종류 필터를 켜도 번호(PinSeries.numbers)가 재계산되지 않는다
 *  ⑥ kind 칩(계열)과 종류 칩(아이콘)이 함께(AND) 동작한다
 *
 * 실제 모듈 소스(01b_PinSeries.js / 11_UI.js / 07_Radar.js / 20_App.js / 23b_PinIcons.js)를
 * 그대로 vm 에 평가해 검사한다(목 구현 아님). ①④에는 뮤테이션(수정 무력화) 케이스가 붙어 있어,
 * 고친 코드를 되돌리면 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const seriesSrc = rd("public/js/modules/01b_PinSeries.js");
const uiSrc     = rd("public/js/modules/11_UI.js");
const radarSrc  = rd("public/js/modules/07_Radar.js");
const appSrc    = rd("public/js/modules/20_App.js");
const iconsSrc  = rd("public/js/modules/23b_PinIcons.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 최소 DOM 목(mock) — p4/p8 과 동일 패턴 ─────────────────────── */
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
function makeEl(tag) {
  const el = {
    tagName: tag || "div", style: {}, dataset: {}, title: "", value: "", disabled: false,
    _text: "", _html: "", _children: [], _handlers: {},
    appendChild(c) { this._children.push(c); return c; },
    setAttribute(k, v) { this.dataset["attr_" + k] = String(v); },
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    click() { (this._handlers.click || []).forEach((fn) => fn({})); },
    focus() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
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
function makeDoc() {
  const registry = {};
  const document = {
    getElementById: (id) => (registry[id] = registry[id] || makeEl()),
    createElement: (t) => makeEl(t),
    querySelectorAll: () => [],
    addEventListener() {}
  };
  return { document, registry };
}
const makeLocalStorage = () => {
  const store = {};
  return { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, _store: store };
};
/** _placeCheckboardPin 은 pin.id = Date.now() 로 채번한다 — 같은 tick 충돌 방지(p8 패턴 그대로). */
function makeSeqDate() {
  let t = 2000000;
  class SeqDate extends Date { static now() { return t++; } }
  return SeqDate;
}
const AppMock = {
  pinHasContent(pin) {
    return !!(pin && (pin.imageId || pin.imageUrl || pin.videoId ||
      pin.note || (pin.attachments && pin.attachments.length) || pin.has3D));
  }
};

/** 가벼운 App 환경(p8 makeLightEnv 그대로) — _placeCheckboardPin 로직만 검증 */
function makeLightApp(pins, appSource) {
  const { document, registry } = makeDoc();
  const State = { checkboard: true, mode: "designer", pdfPage: 1, pins: pins || [], checkboardStart: {}, activePin: null, pendingIcon: "number" };
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
  vm.runInContext(seriesSrc + "\n" + (appSource || appSrc) + "\n;globalThis.__App = App;", sandbox);
  return { App: sandbox.__App, State, registry };
}

/** 도면 마커 렌더(11_UI.renderPinsOnMap) 실행 → { id: no/kind/icon } (p4 패턴 + PinIcons 주입) */
function runUI(pins, page = 1) {
  const { document, registry } = makeDoc();
  const State = { pins, pdfPage: page, mode: "viewer", activePin: null, zoneView: null, zones: [] };
  const sandbox = { console, document, State, localStorage: makeLocalStorage(), App: AppMock, JSON, Map, Set };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(iconsSrc + "\n" + seriesSrc + "\n" + uiSrc + "\n;globalThis.__UI = UI; globalThis.__PS = PinSeries;", sandbox);
  sandbox.__UI.renderPinsOnMap();
  const markers = registry["pins-layer"]._children;
  const nums = {}, kinds = {};
  markers.forEach((m) => { nums[m.dataset.id] = String(m.dataset.no); kinds[m.dataset.id] = m.dataset.kind; });
  return { nums, kinds, markers, registry, PS: sandbox.__PS };
}

/** 미니맵 점 렌더(07_Radar.update) 실행 → { id: no } (p4 패턴, radarSrc 는 인자로 주입 가능 — 뮤테이션용) */
function runRadar(pins, radarSource, page = 1) {
  const { document, registry } = makeDoc();
  const State = { pins, pdfPage: page, mode: "viewer", viewerPages: ["p1.jpg"], zones: [] };
  const sandbox = { console, document, State, localStorage: makeLocalStorage(), App: AppMock, JSON, Map, Set };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(iconsSrc + "\n" + seriesSrc + "\n" + (radarSource || radarSrc) + "\n;globalThis.__R = Radar; globalThis.__PS = PinSeries;", sandbox);
  sandbox.__R.update(pins[0]);
  const dots = registry["pano-radar-pins"]._children;
  const nums = {};
  dots.forEach((d) => { nums[d.dataset.id] = String(d._children[0] && d._children[0]._text); });
  return { nums, dots, registry, PS: sandbox.__PS };
}

/* 필터 축 픽스처: kind(계열) × icon(종류) 두 축이 겹치는 5개
   n1: content/number   n2: empty/number   cam1: content/camera360   cam2: empty/camera360   warn1: checkboard/warning */
const FIXTURE_ICON = () => [
  { id: "n1",    page: 1, x: 5,  y: 5,  imageId: "i1" },
  { id: "n2",    page: 1, x: 10, y: 10 },
  { id: "cam1",  page: 1, x: 15, y: 15, imageId: "i2", icon: "camera360" },
  { id: "cam2",  page: 1, x: 20, y: 20, icon: "camera360" },
  { id: "warn1", page: 1, x: 25, y: 25, checkboard: true, icon: "warning" }
];

/* ══════════════════════════════════════════════════════════════
 * ①②③ 배치 전 종류 선택 → 그 종류로 연속 배치, 미선택 시 기본 number
 * ══════════════════════════════════════════════════════════════ */
{
  const { App, State } = makeLightApp();
  State.pendingIcon = "camera360"; // 배치 전 종류 선택(마스터 요구 UI가 State.pendingIcon 을 설정)
  App._placeCheckboardPin({ x: 1, y: 1 });
  App._placeCheckboardPin({ x: 2, y: 2 });
  ok(State.pins[0].icon === "camera360" && State.pins[1].icon === "camera360",
    "①② 종류를 고르고 연속 배치 → 두 핀 모두 icon=camera360 유지 → " + JSON.stringify(State.pins.map(p => p.icon)));

  // ③ 종류 미선택(기본 number) — 종전과 동일하게 pin.icon 필드 자체가 생기지 않는다(하위호환)
  const { App: App2, State: State2 } = makeLightApp();
  App2._placeCheckboardPin({ x: 3, y: 3 });
  ok(State2.pins[0].icon === undefined,
    "③ 종류 미선택 시 기본 number → pin.icon 미설정(종전과 동일) → icon=" + State2.pins[0].icon);
}

console.log("\n[뮤테이션①] 선택 종류 전달(_placeCheckboardPin 의 pin.icon 대입)을 제거하면 ①이 실패해야 함");
{
  const needle = 'if (State.pendingIcon && State.pendingIcon !== "number") pin.icon = State.pendingIcon;\n      State.pins.push(pin);';
  const mutated = appSrc.replace(needle, "State.pins.push(pin);");
  if (mutated === appSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { App, State } = makeLightApp([], mutated);
    State.pendingIcon = "camera360";
    App._placeCheckboardPin({ x: 1, y: 1 });
    ok(State.pins[0].icon !== "camera360",
      `뮤테이션 적용 시 선택 종류가 전달되지 않아 깨짐(테스트 실효성 증명) → icon=${State.pins[0].icon}`);
  }
}

/* ══════════════════════════════════════════════════════════════
 * ④⑤ 종류 필터 — 도면·미니맵 양쪽 동일 적용 + 번호 재계산 안 됨
 * ══════════════════════════════════════════════════════════════ */
{
  console.log("\n[④⑤ 종류 필터]");
  const pins = FIXTURE_ICON();
  const before = runUI(pins);
  ok(Object.keys(before.nums).length === 5, "필터 전 도면 마커 5개 전부 렌더 → " + Object.keys(before.nums).length);

  // camera360 만 숨김 — PS 상태는 vm 인스턴스별 독립이므로 새 환경에서 직접 적용
  const uiAfter = (() => {
    const { document, registry } = makeDoc();
    const State = { pins, pdfPage: 1, mode: "viewer", activePin: null, zoneView: null, zones: [] };
    const sandbox = { console, document, State, localStorage: makeLocalStorage(), App: AppMock, JSON, Map, Set };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(iconsSrc + "\n" + seriesSrc + "\n" + uiSrc + "\n;globalThis.__UI = UI; globalThis.__PS = PinSeries;", sandbox);
    sandbox.__PS.toggleIconFilter("camera360", Object.keys(sandbox.__PS.iconCounts(pins, 1)));
    sandbox.__UI.renderPinsOnMap();
    const markers = registry["pins-layer"]._children;
    const nums = {};
    markers.forEach((m) => { nums[m.dataset.id] = String(m.dataset.no); });
    return { nums, PS: sandbox.__PS, registry };
  })();
  const shownUI = Object.keys(uiAfter.nums).sort();
  ok(shownUI.join(",") === "n1,n2,warn1", "④ 도면: camera360 숨김 → 표시 = [" + shownUI.join(",") + "] (기대 n1,n2,warn1)");

  // 미니맵도 같은 필터 적용(같은 정본 함수 PinSeries.isVisible 공유)
  const radarAfter = (() => {
    const { document, registry } = makeDoc();
    const State = { pins, pdfPage: 1, mode: "viewer", viewerPages: ["p1.jpg"], zones: [] };
    const sandbox = { console, document, State, localStorage: makeLocalStorage(), App: AppMock, JSON, Map, Set };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(iconsSrc + "\n" + seriesSrc + "\n" + radarSrc + "\n;globalThis.__R = Radar; globalThis.__PS = PinSeries;", sandbox);
    sandbox.__PS.toggleIconFilter("camera360", Object.keys(sandbox.__PS.iconCounts(pins, 1)));
    sandbox.__R.update(pins[0]);
    const dots = registry["pano-radar-pins"]._children;
    const nums = {};
    dots.forEach((d) => { nums[d.dataset.id] = String(d._children[0] && d._children[0]._text); });
    return { nums };
  })();
  const shownR = Object.keys(radarAfter.nums).sort();
  ok(shownR.join(",") === "n1,n2,warn1", "④ 미니맵: camera360 숨김 → 표시 = [" + shownR.join(",") + "] (도면과 동일해야 함)");

  // ⑤ 번호 재계산 금지 — 필터 전/후 n1,n2,warn1 번호가 같아야 한다
  ok(before.nums.n1 === uiAfter.nums.n1 && before.nums.n2 === uiAfter.nums.n2 && before.nums.warn1 === uiAfter.nums.warn1,
    `⑤ 필터 후에도 번호 불변 → n1 ${before.nums.n1}→${uiAfter.nums.n1}, n2 ${before.nums.n2}→${uiAfter.nums.n2}, warn1 ${before.nums.warn1}→${uiAfter.nums.warn1}`);
}

console.log("\n[뮤테이션④] 미니맵(07_Radar)이 종류 필터를 건너뛰고 계열 필터만 확인하면 ④가 실패해야 함");
{
  const needle = "if (p.id !== pin.id && !PinSeries.isVisible(p)) return;";
  const mutatedRadar = radarSrc.replace(needle, "if (p.id !== pin.id && !(PinSeries.filter()[PinSeries.kindOf(p)])) return;");
  if (mutatedRadar === radarSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const pins = FIXTURE_ICON();
    const { document, registry } = makeDoc();
    const State = { pins, pdfPage: 1, mode: "viewer", viewerPages: ["p1.jpg"], zones: [] };
    const sandbox = { console, document, State, localStorage: makeLocalStorage(), App: AppMock, JSON, Map, Set };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(iconsSrc + "\n" + seriesSrc + "\n" + mutatedRadar + "\n;globalThis.__R = Radar; globalThis.__PS = PinSeries;", sandbox);
    sandbox.__PS.toggleIconFilter("camera360", Object.keys(sandbox.__PS.iconCounts(pins, 1)));
    sandbox.__R.update(pins[0]);
    const dots = registry["pano-radar-pins"]._children;
    const ids = dots.map(d => d.dataset.id).sort();
    // 정상이면 cam1/cam2 는 숨겨져 n1,n2,warn1 만 보여야 한다. 뮤테이션은 이를 어겨야(cam 포함) 실효성 증명.
    ok(ids.join(",") !== "n1,n2,warn1",
      `뮤테이션 적용 시 미니맵이 종류 필터를 무시해 도면과 어긋남(테스트 실효성 증명) → 미니맵 표시 = [${ids.join(",")}]`);
  }
}

/* ══════════════════════════════════════════════════════════════
 * ⑥ [WO 20260929 addendum, 지휘자 정정] 계열(seriesOf: CHECKER/360) 필터 × 종류(아이콘) 필터가
 * 함수 레벨에서는 여전히 AND 로 동작하지만("핀 아이콘 기능 자체는 유지"), UI 필터 바는 마스터
 * 지시로 CHECKER/360 2칩만 남고 kind(3종) 칩·아이콘 필터 칩 그룹은 제거됐다
 * ("그냥 체크보드랑 360모드랑 2개 해 ... 내가 시킨 것만 하고").
 * ══════════════════════════════════════════════════════════════ */
{
  console.log("\n[⑥ CHECKER/360 계열 필터 × 종류(아이콘) 필터 AND 동작 — 아이콘 필터 칩 UI는 제거]");
  const pins = FIXTURE_ICON();
  const { document, registry } = makeDoc();
  const State = { pins, pdfPage: 1, mode: "viewer", activePin: null, zoneView: null, zones: [] };
  const sandbox = { console, document, State, localStorage: makeLocalStorage(), App: AppMock, JSON, Map, Set };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(iconsSrc + "\n" + seriesSrc + "\n" + uiSrc + "\n;globalThis.__UI = UI; globalThis.__PS = PinSeries;", sandbox);
  const PS = sandbox.__PS;
  // 계열: checkboard 숨김 — warn1(checkboard)이 빠진다. n2(empty 부류)는 이제 content 계열이라 남는다.
  PS._filter = { checkboard: false, content: true };
  // icon: number 만 숨김 — n1(content/number)·n2(content/number 기본값)가 빠진다.
  PS.toggleIconFilter("number", Object.keys(PS.iconCounts(pins, 1)));
  sandbox.__UI.renderPinsOnMap();
  const markers = registry["pins-layer"]._children;
  const shown = markers.map(m => m.dataset.id).sort();
  // 기대: n1(계열ok/icon 숨김→제외), n2(계열ok/icon 숨김→제외), cam1(계열ok/icon ok→표시),
  //       cam2(계열ok/icon ok→표시), warn1(계열 숨김→제외)
  ok(shown.join(",") === "cam1,cam2",
    "⑥ 계열(체크보드 숨김) × 종류(number 숨김) AND 적용 → 표시 = [" + shown.join(",") + "] (기대 cam1,cam2)");

  // 칩 바에는 이제 CHECKER/360 계열 칩 2종만 — 아이콘 필터 칩 그룹은 렌더되지 않는다.
  const bar = registry["pin-filter-bar"];
  ok(/data-series="content"/.test(bar.innerHTML) && /data-series="checkboard"/.test(bar.innerHTML),
    "⑥ CHECKER/360 계열 칩 2종만 렌더됨");
  ok(!/data-icon=/.test(bar.innerHTML),
    "⑥ [WO 20260929 addendum] 아이콘 종류 필터 칩은 더 이상 렌더되지 않음(UI 제거 — 기능(PS.toggleIconFilter)은 API로 유지)");
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
