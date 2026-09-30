/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p98-checker-noreg.test.mjs)
 *
 * [WO 20260930-moderole ②] 마스터: "체커는 번호만 매기는 기능인 거지" / "체커는 사진을 등록하지
 *  않을 거야". CHECKER 계열 핀(SoT: PinSeries.seriesOf)에 사진이 붙는 모든 경로를 막는다:
 *  ① PinActionPop 핀 패널(등록 섹션 #pap-bottom 숨김) ② 구식 첨부 폼(20_App.editPin, CHECKER는
 *  PinActionPop 으로 위임) ③ 사진 폴더 일괄 매칭·시각 자동 매칭(35_PhotoBatch, 항상 360/content
 *  계열만 대상) ④ 오프라인 복귀 "연결하기" 배너(32_Offline, 360 계열만 카운트) ⑤ 좌측 도구·모바일
 *  도크의 사진 등록 계열 버튼(20_App._syncRegModeButtons, CHECKER 모드에서 숨김).
 *
 * 실 소스를 vm 에 그대로 평가(목 아님) — 01b_PinSeries.js + 27_PinActionPop.js + 35_PhotoBatch.js
 * + 32_Offline.js + 20_App.js. 뮤테이션 각각 EXIT=1 확인 후 원복.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const seriesSrc = rd("public/js/modules/01b_PinSeries.js");
const papSrc = rd("public/js/modules/27_PinActionPop.js");
const pbSrc = rd("public/js/modules/35_PhotoBatch.js");
const offlineSrc = rd("public/js/modules/32_Offline.js");
const appSrc = rd("public/js/modules/20_App.js");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };
const mutate = (src, needle, repl, name) => {
  const out = src.replace(needle, repl);
  if (out === src) throw new Error("뮤테이션 대상 문자열을 찾지 못함: " + name);
  return out;
};

/* ── 최소 DOM 목(p73/p91 과 동일 패턴) ── */
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
    contains: (c) => set.has(c), _set: set
  };
}
function makeEl(tag) {
  const el = {
    tagName: tag || "div", style: {}, dataset: {}, title: "", value: "", disabled: false, type: "",
    _text: "", _html: "", _children: [],
    appendChild(c) { this._children.push(c); return c; },
    setAttribute(k, v) { this.dataset["attr_" + k] = String(v); },
    addEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    focus() {}, click() {},
    firstElementChild: null,
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
  return {
    registry,
    document: {
      getElementById: (id) => (registry[id] = registry[id] || makeEl()),
      createElement: (t) => makeEl(t),
      querySelectorAll: () => [], addEventListener() {}, body: makeEl()
    }
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * ① PinActionPop.open() — CHECKER 핀은 #pap-bottom(등록 섹션) 숨김, 360 핀은 표시
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[① PinActionPop.open() — CHECKER 계열은 등록 섹션(#pap-bottom) 숨김]");
function runPap(src, pins) {
  const { document, registry } = makeDoc();
  registry["pin-action-pop"] = makeEl(); // el must exist for open() to proceed
  const State = { pins, mode: "designer", regMode: "checkboard" };
  const App = { pinHasContent: () => false, pinHasMedia: () => false };
  const UI = { escapeHtml: (s) => String(s) };
  const Auth = { isDesigner: true };
  const sandbox = { console, document, JSON, Map, Set, window: {}, State, App, UI, Auth };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(seriesSrc + "\n" + src + "\n;globalThis.__PAP = PinActionPop;", sandbox);
  return { PAP: sandbox.__PAP, registry };
}
{
  const pins = [
    { id: "chk1", page: 1, x: 10, y: 10, checkboard: true, label: "1" },
    { id: "p3601", page: 1, x: 20, y: 20, label: "P1" } // checkboard 없음 = content(360) 계열
  ];
  const { PAP, registry } = runPap(papSrc, pins);
  PAP.open("chk1");
  ok(registry["pap-bottom"].classList.contains("hidden"), "①-1 CHECKER 핀(chk1) → #pap-bottom 숨김");
  PAP.open("p3601");
  ok(!registry["pap-bottom"].classList.contains("hidden"), "①-2 360 핀(p3601) → #pap-bottom 표시(회귀 없음)");
}
{
  console.log("\n[뮤테이션①] #pap-bottom 게이트 제거 → ①-1 이 실패해야 함");
  const needle = 'if (bottom) bottom.classList.toggle("hidden", isChecker);';
  const mut = mutate(papSrc, needle, "/* removed */", "①");
  const pins = [{ id: "chk1", page: 1, x: 10, y: 10, checkboard: true, label: "1" }];
  const { PAP, registry } = runPap(mut, pins);
  PAP.open("chk1");
  ok(!registry["pap-bottom"].classList.contains("hidden"), "뮤테이션 적용 시 ①-1 이 깨짐(CHECKER 핀인데도 등록 섹션이 보임)");
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 35_PhotoBatch — 항상 360(content) 계열만 대상(_defaultRange/openTimeMatch)
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[③ 35_PhotoBatch._defaultRange()/openTimeMatch() — CHECKER 모드에서도 항상 content 계열]");
function runPB(src) {
  const { document, registry } = makeDoc();
  const State = { pins: [], pdfPage: 1, regMode: "checkboard" };
  const Auth = { isDesigner: true, requireDesigner: (fn) => fn() };
  const Prompt = { toast() {} };
  const sandbox = { console, document, JSON, Map, Set, window: {}, State, Auth, Prompt };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(seriesSrc + "\n" + src + "\n;globalThis.__PB = PhotoBatch;", sandbox);
  return { PB: sandbox.__PB, registry, State };
}
{
  const { PB, State } = runPB(pbSrc);
  State.regMode = "checkboard";
  ok(PB._defaultRange().series === "content", "③-1 State.regMode='checkboard' 여도 _defaultRange().series === 'content'");
  State.regMode = "photo";
  ok(PB._defaultRange().series === "content", "③-2 State.regMode='photo' → _defaultRange().series === 'content'(회귀 없음)");
}
{
  const { PB, registry, State } = runPB(pbSrc);
  State.regMode = "checkboard";
  registry["photobatch-modal"] = makeEl();
  registry["photobatch-title"] = makeEl();
  PB.openTimeMatch();
  ok(PB._tm.series === "content", "③-3 openTimeMatch() State.regMode='checkboard' 여도 series === 'content'");
}
{
  console.log("\n[뮤테이션③] _defaultRange() 가 CHECKER 모드일 때 checkboard 계열을 고르도록 되돌림 → ③-1 이 실패해야 함");
  const needle = 'const series = "content";\n      const list = this._pinList(State.pins, State.pdfPage || 1, series);\n      return { start: list.length ? list[0].no : 1, end: list.length ? list[list.length - 1].no : 1, series: series };\n    },';
  const mut = mutate(pbSrc, needle,
    'const series = (typeof State !== "undefined" && State.regMode === "checkboard") ? "checkboard" : "content";\n      const list = this._pinList(State.pins, State.pdfPage || 1, series);\n      return { start: list.length ? list[0].no : 1, end: list.length ? list[list.length - 1].no : 1, series: series };\n    },',
    "③");
  const { PB, State } = runPB(mut);
  State.regMode = "checkboard";
  ok(PB._defaultRange().series !== "content", "뮤테이션 적용 시 ③-1 이 깨짐(CHECKER 모드에서 checkboard 계열을 대상으로 삼음)");
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 32_Offline 재접속 배너 — 360(content) 계열 핀만 카운트
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[④ 32_Offline 재접속 배너 — CHECKER 핀은 '촬영한 360 사진 연결' 대상에서 제외]");
function runOffline(src) {
  const { document, registry } = makeDoc();
  document.body = makeEl();
  const now = Date.now();
  const State = {
    pins: [
      { id: "chk1", page: 1, x: 1, y: 1, checkboard: true, label: "1", createdAt: now + 100 }, // 오프라인 중 생성(CHECKER)
      { id: "p3601", page: 1, x: 2, y: 2, label: "P1", createdAt: now + 200 } // 오프라인 중 생성(360)
    ]
  };
  let bannerPinCount = null;
  const sandbox = {
    console, document, JSON, Map, Set, window: { addEventListener() {}, removeEventListener() {} },
    navigator: { onLine: true }, State,
    setTimeout: () => 0, clearTimeout() {}
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(seriesSrc + "\n" + src +
    "\n;globalThis.__Offline = Offline; globalThis.__onGoOnline = _onGoOnline; globalThis.__setOfflineStart = (t) => { _offlineSessionStartAt = t; };" +
    "\nglobalThis.__showReconnectBanner_orig = _showReconnectBanner;" +
    "\n_showReconnectBanner = function(n) { globalThis.__bannerPinCount = n; };", sandbox);
  sandbox.__setOfflineStart(now);
  sandbox.__onGoOnline();
  return { bannerPinCount: sandbox.__bannerPinCount };
}
{
  const { bannerPinCount } = runOffline(offlineSrc);
  ok(bannerPinCount === 1, "④-1 오프라인 중 생성 핀 2개(CHECKER 1·360 1) 중 배너 카운트는 360 계열 1개만 — 실제 " + bannerPinCount);
}
{
  console.log("\n[뮤테이션④] 계열 필터 제거(전부 카운트) → ④-1 이 실패해야 함");
  const needle = 'const createdDuring = pins.filter((p) => {\n        const t = (typeof PinSeries !== "undefined" && PinSeries.createdAt) ? PinSeries.createdAt(p) : null;\n        if (!Number.isFinite(t) || t < since) return false;\n        return (typeof PinSeries !== "undefined" && PinSeries.seriesOf) ? PinSeries.seriesOf(p) !== "checkboard" : true;\n      });';
  const mut = mutate(offlineSrc, needle,
    'const createdDuring = pins.filter((p) => {\n        const t = (typeof PinSeries !== "undefined" && PinSeries.createdAt) ? PinSeries.createdAt(p) : null;\n        return Number.isFinite(t) && t >= since;\n      });', "④");
  const { bannerPinCount } = runOffline(mut);
  ok(bannerPinCount !== 1, "뮤테이션 적용 시 ④-1 이 깨짐(CHECKER 핀까지 카운트 — 실제 " + bannerPinCount + ")");
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 20_App.editPin() — CHECKER 핀은 구식 첨부 폼을 열지 않고 PinActionPop 으로 위임
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[② 20_App.editPin() — CHECKER 핀은 PinActionPop 으로 위임(구식 첨부 폼 미오픈)]");
function runApp(src) {
  const { document, registry } = makeDoc();
  const State = {
    pins: [
      { id: "chk1", page: 1, x: 1, y: 1, checkboard: true, label: "1" },
      { id: "p3601", page: 1, x: 2, y: 2, label: "P1" }
    ],
    placing: false, editingPinId: "unset", regMode: "checkboard"
  };
  const papCalls = [];
  const PinActionPop = { open: (id) => papCalls.push(id) };
  const UI = { $: (id) => document.getElementById(id), disable() {}, renderPinList() {}, renderPinsOnMap() {} };
  const MapCtrl = { flyTo() {} };
  const sandbox = { console, document, JSON, Map, Set, window: {}, State, PinActionPop, UI, MapCtrl, setTimeout: () => 0 };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(seriesSrc + "\n" + src + "\n;globalThis.__App = App;", sandbox);
  sandbox.__App._openPinForm = () => {}; // 무거운 폼 오픈 로직은 이 테스트 범위 밖(뒤 단계 스텁)
  return { App: sandbox.__App, State, papCalls };
}
{
  const { App, State, papCalls } = runApp(appSrc);
  App.editPin("chk1");
  ok(papCalls.join() === "chk1" && State.editingPinId === "unset",
    "②-1 CHECKER 핀 editPin → PinActionPop.open('chk1') 위임, 구식 폼 경로 미진입(editingPinId 그대로) — papCalls=" + papCalls.join());
  App.editPin("p3601");
  ok(papCalls.join() === "chk1" && State.editingPinId === "p3601",
    "②-2 360 핀 editPin → 기존 구식 폼 경로 그대로 진입(회귀 없음, editingPinId=p3601) — papCalls=" + papCalls.join());
}
{
  console.log("\n[뮤테이션②] CHECKER 위임 가드 제거 → ②-1 이 실패해야 함");
  const needle = `      const isChecker = (typeof PinSeries !== "undefined" && PinSeries.seriesOf) ? PinSeries.seriesOf(pin) === "checkboard" : false;
      if (isChecker) {
        if (typeof PinActionPop !== "undefined" && PinActionPop.open) PinActionPop.open(id);
        return;
      }
      // 다른 모드 정리`;
  const mut = mutate(appSrc, needle, "      // 다른 모드 정리", "②");
  const { App, State, papCalls } = runApp(mut);
  App.editPin("chk1");
  ok(!(papCalls.join() === "chk1" && State.editingPinId === "unset"),
    "뮤테이션 적용 시 ②-1 이 깨짐(CHECKER 핀도 구식 첨부 폼 경로로 들어감) — papCalls=" + papCalls.join() + " editingPinId=" + State.editingPinId);
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 20_App._syncRegModeButtons() — CHECKER 모드에서 사진 등록 계열 도구 숨김
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[⑤ 20_App._syncRegModeButtons() — CHECKER 모드는 사진 등록 도구(폴더매칭·THETA인입·모바일도크) 숨김]");
function runSync(src) {
  const { document, registry } = makeDoc();
  ["btn-photobatch", "btn-theta-intake", "mdock-photobatch"].forEach((id) => { registry[id] = makeEl(); });
  const State = { regMode: "checkboard" };
  const UI = { $: (id) => document.getElementById(id) };
  const sandbox = { console, document, JSON, Map, Set, window: {}, State, UI };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(seriesSrc + "\n" + src + "\n;globalThis.__App = App;", sandbox);
  return { App: sandbox.__App, registry, State };
}
{
  const { App, registry, State } = runSync(appSrc);
  State.regMode = "checkboard";
  App._syncRegModeButtons();
  ok(registry["btn-photobatch"].classList.contains("hidden")
    && registry["btn-theta-intake"].classList.contains("hidden")
    && registry["mdock-photobatch"].classList.contains("hidden"),
    "⑤-1 CHECKER 모드 → 사진 폴더매칭·THETA 인입·모바일 도크 사진등록 전부 숨김");
  State.regMode = "photo";
  App._syncRegModeButtons();
  ok(!registry["btn-photobatch"].classList.contains("hidden")
    && !registry["btn-theta-intake"].classList.contains("hidden")
    && !registry["mdock-photobatch"].classList.contains("hidden"),
    "⑤-2 360 모드 → 다시 표시(회귀 없음)");
}
{
  console.log("\n[뮤테이션⑤] CHECKER 숨김 게이트 제거 → ⑤-1 이 실패해야 함");
  const needle = `      const isChecker = State.regMode === "checkboard";
      ["btn-photobatch", "btn-theta-intake", "mdock-photobatch"].forEach((id) => {
        const b = UI.$(id);
        if (b) b.classList.toggle("hidden", isChecker);
      });`;
  const mut = mutate(appSrc, needle, "", "⑤");
  const { App, registry, State } = runSync(mut);
  State.regMode = "checkboard";
  App._syncRegModeButtons();
  ok(!registry["btn-photobatch"].classList.contains("hidden"),
    "뮤테이션 적용 시 ⑤-1 이 깨짐(CHECKER 모드인데도 사진 폴더매칭 버튼이 보임)");
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
