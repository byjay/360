/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p98-checker-noreg.test.mjs)
 *
 * 🔴 [WO 20261015-numunify — 의미 반전(G-4⑧ 전·후 대조)] 파일명은 이력 보존을 위해 유지한다.
 *  종전(WO 20260930-moderole ②) 계약: "CHECKER 핀에 사진이 붙는 모든 경로를 막는다"(①③④⑤ 차단).
 *  새 계약(마스터 2026-10-15): "체크 모드와 360 모드 번호를 하나로 합치고 … 체크보드 모드에서 번호만 일괄적으로
 *  찍고 나서 사진폴더 … 바로 그 위치에 360도 사진이 일괄적으로" → CHECKER 핀에도 사진 등록 경로가 **열려 있다**.
 *  단 "클릭 시 사진창은 안 뜬다"(② 20_App.editPin 위임)는 **유지**한다(설계 §5 #2 — 해제 과잉 방지 가드).
 *
 *   항목 | 종전 기대                          | 새 기대
 *   ①   | CHECKER 핀 → #pap-bottom 숨김       | 표시(+#pap-ai 표시)
 *   ③   | _defaultRange/openTimeMatch=content | "all"(체커 포함) · autoConnectPin(체커) 허용
 *   ④   | 오프라인 배너 = 360 핀만 카운트     | 전 핀 카운트
 *   ②   | editPin(체커) → PinActionPop 위임   | 동일(🔒 유지)
 *   ⑤   | CHECKER 모드 → 사진 도구 숨김       | 표시
 *  뮤테이션 = 각 게이트를 **복구**(①③③-4④⑤) 또는 유지 가드 제거(②) → 해당 검사가 FAIL(테스트 안에서 단언).
 *
 * 실 소스를 vm 에 그대로 평가(목 아님) — 01b_PinSeries.js + 27_PinActionPop.js + 35_PhotoBatch.js
 * + 32_Offline.js + 20_App.js.
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
 * ① PinActionPop.open() — CHECKER 핀도 등록 섹션(#pap-bottom)·AI(#pap-ai) 표시(차단 해제)
 *    전·후: 종전 ①-1 "CHECKER 핀 → #pap-bottom 숨김" → 새 "CHECKER 핀 → #pap-bottom 표시(앞 상태 hidden 이어도 해제)"
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[① PinActionPop.open() — CHECKER 핀도 등록 섹션(#pap-bottom) 표시]");
function runPap(src, pins) {
  const { document, registry } = makeDoc();
  registry["pin-action-pop"] = makeEl(); // el must exist for open() to proceed
  registry["pap-bottom"] = makeEl(); registry["pap-ai"] = makeEl();
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
const PINS_PAP = () => [
  { id: "chk1", page: 1, x: 10, y: 10, checkboard: true, label: "1" },
  { id: "p3601", page: 1, x: 20, y: 20, label: "2" } // checkboard 없음 = content(360) 계열
];
{
  const { PAP, registry } = runPap(papSrc, PINS_PAP());
  registry["pap-bottom"].classList.add("hidden");   // 앞 상태가 숨김이어도(종전 체커 패널) 열면 풀려야 한다
  registry["pap-ai"].classList.add("hidden");
  PAP.open("chk1");
  ok(!registry["pap-bottom"].classList.contains("hidden"), "①-1 CHECKER 핀(chk1) → #pap-bottom 표시(사진 재등록 경로 열림)");
  ok(!registry["pap-ai"].classList.contains("hidden"), "①-1b CHECKER 핀(chk1) → #pap-ai 표시(AI 분석 경로 열림)");
  PAP.open("p3601");
  ok(!registry["pap-bottom"].classList.contains("hidden"), "①-2 360 핀(p3601) → #pap-bottom 표시(회귀 없음)");
}
{
  console.log("\n[뮤테이션①] #pap-bottom CHECKER 게이트 복구 → ①-1 이 실패해야 함");
  const mut = mutate(papSrc, 'if (bottom) bottom.classList.remove("hidden");', 'if (bottom) bottom.classList.toggle("hidden", !!pin.checkboard);', "①");
  const { PAP, registry } = runPap(mut, PINS_PAP());
  PAP.open("chk1");
  ok(registry["pap-bottom"].classList.contains("hidden"), "뮤테이션 적용 시 ①-1 이 깨짐(CHECKER 핀 등록 섹션이 다시 숨음)");
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 35_PhotoBatch — 범위 = 페이지 전 핀("all"), 체커 핀 자동 연결 허용
 *    전·후: 종전 series==="content"(CHECKER 제외) · autoConnectPin(체커) early-return → 새 "all" · 체커 핀도 _pendingAutoPin
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[③ 35_PhotoBatch — _defaultRange()/openTimeMatch() 페이지 전 핀 · autoConnectPin 체커 허용]");
function runPB(src, pins) {
  const { document, registry } = makeDoc();
  const State = { pins: pins || [], pdfPage: 1, regMode: "checkboard" };
  const Auth = { isDesigner: true, requireDesigner: (fn) => fn() };
  const Prompt = { toast() {} };
  const sandbox = { console, document, JSON, Map, Set, window: {}, State, Auth, Prompt };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(seriesSrc + "\n" + src + "\n;globalThis.__PB = PhotoBatch;", sandbox);
  return { PB: sandbox.__PB, registry, State };
}
const PINS_PB = () => [
  { id: "chk1", page: 1, x: 1, y: 1, checkboard: true, label: "1" },
  { id: "chk2", page: 1, x: 2, y: 2, checkboard: true, label: "2" },
  { id: "p3", page: 1, x: 3, y: 3, label: "3" }
];
{
  const { PB, State } = runPB(pbSrc, PINS_PB());
  State.regMode = "checkboard";
  const r1 = PB._defaultRange();
  ok(r1.series === "all" && r1.start === 1 && r1.end === 3, "③-1 CHECKER 모드 → _defaultRange() = all · 1~3(체커 핀 포함) — " + JSON.stringify(r1));
  State.regMode = "photo";
  ok(PB._defaultRange().series === "all", "③-2 360 모드 → _defaultRange().series === 'all'(모드 무관)");
}
{
  const { PB, registry, State } = runPB(pbSrc, PINS_PB());
  State.regMode = "checkboard";
  registry["photobatch-modal"] = makeEl();
  registry["photobatch-title"] = makeEl();
  PB.openTimeMatch();
  ok(PB._tm.series === "all", "③-3 openTimeMatch() CHECKER 모드 → series === 'all'");
}
{
  const { PB, State } = runPB(pbSrc, PINS_PB());
  PB.autoConnectPin(State.pins[0]);
  ok(PB._pendingAutoPin === State.pins[0], "③-4 autoConnectPin(체커 핀) → 대기 핀으로 잡힘(early-return 해제)");
}
{
  console.log("\n[뮤테이션③] _defaultRange() 를 옛 content 고정으로 되돌림 → ③-1 이 실패해야 함");
  const mut = mutate(pbSrc, 'const series = "all";\n      const list = this._pinList(State.pins, State.pdfPage || 1, series);',
    'const series = "content";\n      const list = this._pinList(State.pins, State.pdfPage || 1, series);', "③");
  const { PB } = runPB(mut, PINS_PB());
  const r = PB._defaultRange();
  ok(!(r.series === "all" && r.start === 1 && r.end === 3), "뮤테이션 적용 시 ③-1 이 깨짐(체커 핀이 범위에서 빠짐) — " + JSON.stringify(r));
}
{
  console.log("\n[뮤테이션③-4] autoConnectPin 체커 early-return 복구 → ③-4 가 실패해야 함");
  const mut = mutate(pbSrc, "      if (!pin) return;\n      // [WO 20261015-numunify] CHECKER 핀 early-return 해제",
    "      if (!pin) return;\n      if (PinSeries.seriesOf(pin) === \"checkboard\") return;\n      // [WO 20261015-numunify] CHECKER 핀 early-return 해제", "③-4");
  const { PB, State } = runPB(mut, PINS_PB());
  PB.autoConnectPin(State.pins[0]);
  ok(PB._pendingAutoPin !== State.pins[0], "뮤테이션 적용 시 ③-4 가 깨짐(체커 핀 자동 연결 차단)");
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 32_Offline 재접속 배너 — 오프라인 중 만든 핀 전부(계열 무관)
 *    전·후: 종전 2개 중 360 1개만 카운트 → 새 2개(체커 핀도 사진 일괄 대상)
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[④ 32_Offline 재접속 배너 — CHECKER 핀도 '촬영한 360 사진 연결' 대상]");
function runOffline(src) {
  const { document, registry } = makeDoc();
  document.body = makeEl();
  const now = Date.now();
  const State = {
    pins: [
      { id: "chk1", page: 1, x: 1, y: 1, checkboard: true, label: "1", createdAt: now + 100 }, // 오프라인 중 생성(CHECKER)
      { id: "p3601", page: 1, x: 2, y: 2, label: "2", createdAt: now + 200 },                 // 오프라인 중 생성(360)
      { id: "old", page: 1, x: 3, y: 3, label: "3", createdAt: now - 5000 }                   // 오프라인 전 생성 — 제외
    ]
  };
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
  ok(bannerPinCount === 2, "④-1 오프라인 중 생성 핀 2개(CHECKER 1·360 1) 전부 카운트(오프라인 전 핀 제외) — 실제 " + bannerPinCount);
}
{
  console.log("\n[뮤테이션④] 계열 필터 복구(360 만 카운트) → ④-1 이 실패해야 함");
  const mut = mutate(offlineSrc, "        return Number.isFinite(t) && t >= since;\n",
    "        if (!Number.isFinite(t) || t < since) return false;\n        return PinSeries.seriesOf(p) !== \"checkboard\";\n", "④");
  const { bannerPinCount } = runOffline(mut);
  ok(bannerPinCount !== 2, "뮤테이션 적용 시 ④-1 이 깨짐(CHECKER 핀 제외 — 실제 " + bannerPinCount + ")");
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 🔒 유지 가드 — 20_App.editPin(): CHECKER 핀은 구식 첨부 폼(사진창)을 열지 않고 PinActionPop 으로 위임
 *    (설계 §5 #2 — "클릭 시 사진창 안 뜸" 축. 해제 과잉 방지) — 전·후 동일
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[② 🔒 20_App.editPin() — CHECKER 핀은 PinActionPop 으로 위임(구식 첨부 폼 미오픈, 유지)]");
function runApp(src) {
  const { document, registry } = makeDoc();
  const State = {
    pins: [
      { id: "chk1", page: 1, x: 1, y: 1, checkboard: true, label: "1" },
      { id: "p3601", page: 1, x: 2, y: 2, label: "2" }
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
 * ⑤ 20_App._syncRegModeButtons() — CHECKER 모드에서도 사진 등록 도구 표시(숨김 해제)
 *    전·후: 종전 ⑤-1 "CHECKER 모드 → 전부 숨김" → 새 "CHECKER 모드 → 전부 표시(앞 상태 hidden 이어도 해제)"
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[⑤ 20_App._syncRegModeButtons() — CHECKER 모드도 사진 등록 도구(폴더매칭·THETA인입·모바일도크) 표시]");
function runSync(src) {
  const { document, registry } = makeDoc();
  ["btn-photobatch", "btn-theta-intake", "mdock-photobatch"].forEach((id) => { registry[id] = makeEl(); registry[id].classList.add("hidden"); });
  const State = { regMode: "checkboard" };
  const UI = { $: (id) => document.getElementById(id) };
  const sandbox = { console, document, JSON, Map, Set, window: {}, State, UI };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(seriesSrc + "\n" + src + "\n;globalThis.__App = App;", sandbox);
  return { App: sandbox.__App, registry, State };
}
const allShown = (r) => ["btn-photobatch", "btn-theta-intake", "mdock-photobatch"].every((id) => !r[id].classList.contains("hidden"));
{
  const { App, registry, State } = runSync(appSrc);
  State.regMode = "checkboard";
  App._syncRegModeButtons();
  ok(allShown(registry), "⑤-1 CHECKER 모드 → 사진 폴더매칭·THETA 인입·모바일 도크 사진등록 전부 표시");
  State.regMode = "photo";
  App._syncRegModeButtons();
  ok(allShown(registry), "⑤-2 360 모드 → 표시(회귀 없음)");
}
{
  console.log("\n[뮤테이션⑤] CHECKER 숨김 게이트 복구 → ⑤-1 이 실패해야 함");
  const mut = mutate(appSrc, '        if (b) b.classList.remove("hidden");\n      });',
    '        if (b) b.classList.toggle("hidden", State.regMode === "checkboard");\n      });', "⑤");
  const { App, registry, State } = runSync(mut);
  State.regMode = "checkboard";
  App._syncRegModeButtons();
  ok(!allShown(registry), "뮤테이션 적용 시 ⑤-1 이 깨짐(CHECKER 모드에서 사진 폴더매칭 버튼이 다시 숨음)");
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
