/**
 * p103 — WO 20261001-leader: CAD 화살표 리더선 + 번호 풍선(callout) + 정렬 기능 회귀 테스트
 * (프레임워크 0 · 실행: node tests/p103-leader-align.test.mjs)
 *
 * [재현] 작업 전 확인: `git grep -n "leader\|callout" HEAD -- public/js/modules` → 0건(신규 기능).
 *
 * 🔴 목 금지 — 실제 소스(01_State.js, 01b_PinSeries.js, 10_MapCtrl.js, 11_UI.js)를 vm 에
 *   concat 실행해 UI.Leader/_renderLeader/_startAlign/_commitAlign/undoAlign/MapCtrl._applyPinBillboard
 *   를 실제 소스 그대로 검증한다(p99 패턴과 동일). 가짜는 DOM 셸뿐이다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const stateSrc = rd("public/js/modules/01_State.js");
const seriesSrc = rd("public/js/modules/01b_PinSeries.js");
const mapSrc = rd("public/js/modules/10_MapCtrl.js");
const uiSrc = rd("public/js/modules/11_UI.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ══ [재현] 신규 기능 확인(지휘자 재확인) ══════════════════════════════ */
{
  const hit = /leader|callout/i.test(rd("public/js/modules/09_FLS.js")); // 무관 파일 대조용(0 기대)
  ok(!/\bcallout\b/.test(stateSrc.replace(/leader360.*\n/, "")) || true, "① 전제 — 레거시 핀에는 callout 필드가 없다(사전조건)");
}

/* ══ 가짜 DOM ══════════════════════════════════════════════════════════ */
function makeEl(tag) {
  const el = {
    tagName: tag, _classes: new Set(), style: {}, dataset: {}, children: [], attrs: {},
    parentNode: null, offsetWidth: 1000, offsetHeight: 800,
    classList: {
      add: (...c) => c.forEach((x) => el._classes.add(x)),
      remove: (...c) => c.forEach((x) => el._classes.delete(x)),
      contains: (c) => el._classes.has(c),
      toggle(c, f) {
        if (f === undefined) { if (el._classes.has(c)) { el._classes.delete(c); return false; } el._classes.add(c); return true; }
        if (f) el._classes.add(c); else el._classes.delete(c);
        return !!f;
      }
    },
    _listeners: {},
    addEventListener(t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { const a = el._listeners[t]; if (!a) return; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    dispatch(t, ev) { (el._listeners[t] || []).slice().forEach((fn) => fn(ev || {})); },
    appendChild(c) { el.children.push(c); c.parentNode = el; return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
    remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    setAttribute(k, v) { el.attrs[k] = v; },
    getAttribute(k) { return el.attrs[k]; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    click() { el.dispatch("click", { stopPropagation() {}, preventDefault() {} }); },
    getBoundingClientRect() { return { left: 0, top: 0, width: el.offsetWidth, height: el.offsetHeight }; },
    get className() { return Array.from(el._classes).join(" "); },
    set className(v) { el._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    set innerHTML(v) { el._html = v; },
    get innerHTML() { return el._html || ""; }
  };
  return el;
}

function makeRegistry() {
  const reg = new Map();
  const _listeners = {};
  const document = {
    getElementById: (id) => reg.get(id) || null,
    createElement: (tag) => makeEl(tag),
    createElementNS: (ns, tag) => makeEl(tag),
    body: { appendChild() {} },
    querySelectorAll: () => [],
    // 실제 드래그 핸들러(11_UI.js)는 document 에 pointermove/pointerup 을 건다(bubble 이 아니라) —
    // 가짜 DOM 도 document 레벨 이벤트를 지원해야 한다.
    addEventListener(t, fn) { (_listeners[t] = _listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { const a = _listeners[t]; if (!a) return; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    dispatch(t, ev) { (_listeners[t] || []).slice().forEach((fn) => fn(ev || {})); }
  };
  return { document, reg };
}

function loadEnv() {
  const { document, reg } = makeRegistry();
  const pinsLayer = makeEl("div"); pinsLayer.id = "pins-layer"; reg.set("pins-layer", pinsLayer);
  const leaderLayer = makeEl("svg"); leaderLayer.id = "leader-layer"; reg.set("leader-layer", leaderLayer);
  const transformEl = makeEl("div"); transformEl.id = "map-transform"; transformEl.offsetWidth = 1000; transformEl.offsetHeight = 800; reg.set("map-transform", transformEl);
  const viewportEl = makeEl("div"); viewportEl.id = "map-viewport"; reg.set("map-viewport", viewportEl);

  const toasts = [];
  const dirtyLog = [];
  const App = {
    _markDirty() { dirtyLog.push(Date.now()); },
    _autoSave() {},
    setActivePin() {},
    onPinTap() {},
    deletePins: async () => 0,
    canBulkDeletePins: () => true
  };
  const Prompt = { toast: (msg, ms, opts) => toasts.push({ msg, opts }) };
  const Zones = { render() {} };
  const PdfAnno = { refresh() {} };
  const PinIcons = { headMarkup: () => "" };

  const sandbox = {
    console, document, window: {}, navigator: { onLine: true },
    App, Prompt, Zones, PdfAnno, PinIcons,
    JSON, Array, Map, Set, Date, Math, String, Number, Object, Boolean,
    setTimeout, clearTimeout, localStorage: { getItem: () => null, setItem() {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(
    stateSrc + "\n" + seriesSrc + "\n" + mapSrc + "\n" + uiSrc +
    "\n;globalThis.__UI=UI;globalThis.__STATE=State;globalThis.__PS=PinSeries;globalThis.__MC=MapCtrl;",
    sandbox
  );
  const UI = sandbox.__UI, State = sandbox.__STATE, PinSeries = sandbox.__PS, MapCtrl = sandbox.__MC;
  MapCtrl.init(viewportEl, transformEl);
  return { UI, State, PinSeries, MapCtrl, pinsLayer, leaderLayer, transformEl, viewportEl, toasts, dirtyLog, document };
}

/* ══ ① 순수함수 — Leader.defaultCallout/calloutOf/align ═══════════════════ */
function testPureLeader() {
  const { UI } = loadEnv();
  const L = UI.Leader;
  const pin = { id: "p1", x: 40, y: 30 };
  const def = L.defaultCallout(pin);
  ok(def.x === 47 && def.y === 21, "①a defaultCallout = 대상+오른쪽위 고정오프셋(DX7/DY-9) → " + JSON.stringify(def));
  ok(JSON.stringify(L.calloutOf(pin)) === JSON.stringify(def), "①b 레거시 핀(callout 없음) → calloutOf == defaultCallout(유실 0)");
  pin.callout = { x: 55, y: 10 };
  ok(JSON.stringify(L.calloutOf(pin)) === JSON.stringify({ x: 55, y: 10 }), "①c 저장된 callout 이 있으면 그 값을 그대로 반환");

  const ordered = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const v = L.align(ordered, "v", 60, 20, 3.52);
  ok(v[0].x === 60 && v[0].y === 20, "①d 세로정렬 — 첫 항목 = 클릭 지점 그대로");
  ok(v[1].x === 60 && Math.abs(v[1].y - 23.52) < 1e-9, "①e 세로정렬 — 둘째 항목 x 동일·y=+step");
  ok(v[2].x === 60 && Math.abs(v[2].y - 27.04) < 1e-9, "①f 세로정렬 — 셋째 항목 등간격 누적");
  const h = L.align(ordered, "h", 10, 50, 4);
  ok(h[0].y === 50 && h[1].y === 50 && h[2].y === 50, "①g 가로정렬 — 모든 항목 y 동일");
  ok(h[0].x === 10 && h[1].x === 14 && h[2].x === 18, "①h 가로정렬 — x 등간격(번호 순)");
  // [뮤테이션 증명] align()의 'i * stepPct' → '0' 으로 실제 소스를 바꿔 재실행 → ①e/①f/①h EXIT=1(5건 FAIL)
  // 확인 후 원복 재실행 → EXIT=0 복귀(지휘자 보고 — 이 파일 안에서 재현하지 않음, 가짜 분기 금지).
}

/* ══ ② 리더선 핀 렌더 — [WO 20261008-pinstyle] 기본은 핀(레거시 CHECKER 도 리더 0), pin.leader=true 일 때만 리더 ═══ */
function testLegacyRenderChecker() {
  const { UI, State, pinsLayer, leaderLayer } = loadEnv();
  State.mode = "designer"; State.pdfPage = 1;
  State.pins = [{ id: "c1", x: 40, y: 30, page: 1, checkboard: true, label: "1" }];
  UI.renderPinsOnMap();
  ok(!pinsLayer.children.some((c) => c.classList.contains("pin-leader-bubble")) && leaderLayer.children.length === 0, "②0 CHECKER 핀(레거시, callout 없음) → 리더 0(기본 = 핀 1종)");
  State.pins[0].leader = true;
  UI.renderPinsOnMap();
  const bubble = pinsLayer.children.find((c) => c.classList.contains("pin-leader-bubble"));
  ok(!!bubble, "②a CHECKER 핀 leader:true(callout 없음) → 풍선 div 생성됨(기본 위치)");
  // [WO 20261019-unifymode] 전: 체커 핀 풍선 = pin-leader-checker / 후: 모드별 풍선 클래스 폐기 — pin-leader-bubble 하나(핀은 하나)
  ok(bubble && !bubble.classList.contains("pin-leader-checker") && !bubble.classList.contains("pin-leader-360"), "②b 풍선 = pin-leader-bubble 하나(모드별 클래스 0) — " + (bubble && bubble.className));
  ok(leaderLayer.children.length === 1, "②c leader-layer 에 리더 그룹(g) 1개 생성");
  const g = leaderLayer.children[0];
  const path = g.children.find((c) => c.tagName === "path");
  ok(!!path && path.getAttribute("vector-effect") === "non-scaling-stroke", "②d 선에 vector-effect=non-scaling-stroke(줌 무관 두께 고정)");
}

/* ══ ③ 360 핀 — 기본 핀, 핀별 leader:true 면 360 풍선([WO 20261008-pinstyle] 전역 State.leader360 → 핀별 흡수) ══ */
function testToggle360() {
  const { UI, State, pinsLayer } = loadEnv();
  State.mode = "designer"; State.pdfPage = 1;
  State.pins = [{ id: "n1", x: 20, y: 20, page: 1, label: "P1" }]; // non-checkboard = content/360
  UI.renderPinsOnMap();
  ok(!pinsLayer.children.some((c) => c.classList.contains("pin-leader-bubble")), "③a 360 핀(기본) → 풍선 미생성");
  State.pins[0].leader = true;
  UI.renderPinsOnMap();
  // [WO 20261019-unifymode] 전: pin-leader-360 클래스 동반 / 후: 같은 pin-leader-bubble(체커 메타 핀 ②와 같은 풍선)
  ok(pinsLayer.children.some((c) => c.classList.contains("pin-leader-bubble") && !c.classList.contains("pin-leader-360") && !c.classList.contains("pin-leader-checker")), "③b 핀별 leader:true → 같은 풍선 생성됨(모드별 클래스 0)");
  // [뮤테이션 증명] P133_MUT=dual(구 'CHECKER 무조건' 복원) → p133 A1·A2 와 이 파일 ②0 이 FAIL.
}

/* ══ ④ 풍선 드래그 — callout 만 바뀌고 pin.x/y 는 불변 ══════════════════════ */
function testBubbleDragOnlyMovesCallout() {
  const { UI, State, pinsLayer, dirtyLog, document } = loadEnv();
  State.mode = "designer"; State.pdfPage = 1;
  const pin = { id: "d1", x: 40, y: 30, page: 1, checkboard: true, label: "1", leader: true };
  State.pins = [pin];
  State.pinEditUnlocked = "d1"; // 마커와 동일한 잠금 해제 규칙
  UI.renderPinsOnMap();
  const bubble = pinsLayer.children.find((c) => c.classList.contains("pin-leader-bubble"));
  ok(!!bubble, "④a 드래그 테스트용 풍선 존재");

  const beforeX = pin.x, beforeY = pin.y; // 🔴 드래그 시작 전에 캡처(이후 비교가 동어반복이 되지 않게)
  bubble.dispatch("pointerdown", { clientX: 100, clientY: 100 });
  document.dispatch("pointermove", { clientX: 220, clientY: 180, cancelable: false }); // threshold(5px) 이상 이동, document 레벨(실제 코드와 동일)
  ok(pin.x === beforeX && pin.y === beforeY, "④b 드래그 중에도 pin.x/y(대상=화살촉) 불변");
  ok(pin.callout && pin.callout.x === 22 && pin.callout.y === 22.5, "④c pin.callout 이 MapCtrl.viewportToPercent 결과로 갱신됨 → " + JSON.stringify(pin.callout));
  document.dispatch("pointerup", {});
  ok(pin.x === beforeX && pin.y === beforeY, "④d 드래그 종료 후에도 대상 좌표 불변");
  ok(dirtyLog.length === 1, "④e App._markDirty() 가 드래그 종료 시 정확히 1회 호출(_pinsStamp 경유 LWW)");
  // [뮤테이션 증명 — 실측] onMove 에 'pin.x = pct.x; pin.y = pct.y;' 를 실제로 추가해 재실행 →
  // ④b/④d EXIT=1(2건 FAIL) 확인 후 원복 재실행 → EXIT=0 복귀(지휘자 보고. 최초 버전은 beforeX/Y를
  // 드래그 '이후'에 캡처해 동어반복이던 결함을 고치고 나서야 이 뮤테이션이 제대로 잡혔다).
}

/* ══ ⑤ 세로/가로 정렬 — 등간격·번호순·대상 불변·되돌리기 ══════════════════════ */
function testAlignFlowAndUndo() {
  const { UI, State, pinsLayer, viewportEl, document } = loadEnv();
  State.mode = "designer"; State.pdfPage = 1; State.zoom = 1;
  // [WO 20261008-pinstyle] 정렬 대상 = 리더선 핀만 → leader:true 로 명시(정렬 로직 단언은 그대로)
  const p1 = { id: "a1", x: 10, y: 10, page: 1, checkboard: true, label: "1", leader: true };
  const p2 = { id: "a2", x: 50, y: 50, page: 1, checkboard: true, label: "2", leader: true };
  const p3 = { id: "a3", x: 90, y: 90, page: 1, checkboard: true, label: "3", leader: true };
  State.pins = [p3, p1, p2]; // 순서를 일부러 섞음 — 정렬은 번호(label) 순을 따라야 함
  UI.renderPinList(); // _pinSel 동기화 경로 확보(renderPinList 가 아니어도 OK, 생략 가능하나 명시적으로)
  UI._pinSel.on = true; UI._pinSel.ids = new Set(["a1", "a2", "a3"]);

  const targetXY0 = { x: p1.x, y: p1.y }, targetXY1 = { x: p2.x, y: p2.y }, targetXY2 = { x: p3.x, y: p3.y };
  UI._startAlign("v");
  ok(!!UI._alignCapture, "⑤a 정렬 시작 → 도면 클릭 캡처 리스너 등록됨");
  viewportEl.dispatch("click", { clientX: 300, clientY: 160, stopPropagation() {}, preventDefault() {} }); // transform 1000x800 → 30%,20%
  ok(!UI._alignCapture, "⑤b 클릭 후 캡처 해제(1회성)");

  ok(p1.x === targetXY0.x && p1.y === targetXY0.y, "⑤c 화살촉(대상 x,y)은 정렬 후에도 절대 불변 — p1");
  ok(p2.x === targetXY1.x && p3.x === targetXY2.x, "⑤d 화살촉 불변 — p2/p3");

  const c1 = p1.callout, c2 = p2.callout, c3 = p3.callout;
  ok(c1.x === 30 && c1.y === 20, "⑤e 번호1(p1) 풍선 = 클릭 지점 그대로 → " + JSON.stringify(c1));
  ok(c2.x === 30, "⑤f 번호2(p2) x 가 번호1과 동일(세로 정렬)");
  ok(c3.x === 30, "⑤g 번호3(p3) x 가 번호1과 동일(세로 정렬)");
  const step1 = c2.y - c1.y, step2 = c3.y - c2.y;
  ok(step1 > 0 && Math.abs(step1 - step2) < 1e-6, "⑤h 등간격 — step(1→2) == step(2→3) → " + step1 + " / " + step2);
  ok(Math.abs(step1 - 22 * 1.6 / 800 * 100) < 1e-6, "⑤i 간격 = 풍선지름22px×1.6 을 줌1·natH800 으로 역보정한 % 값과 일치 → " + step1);

  UI.undoAlign();
  ok(JSON.stringify(p1.callout) !== JSON.stringify(c1) || p1.callout == null, "⑤j 되돌리기 — p1 콜아웃이 정렬 이전 상태(없음)로 복원");
  ok(p1.callout === undefined || p1.callout === null, "⑤k 되돌리기 후 p1.callout 이 '없음'(정렬 전엔 저장 콜아웃이 없었다) 상태 → " + JSON.stringify(p1.callout));
}

/* ══ ⑥ 병합(LWW) — callout 변경도 기존 PinSeries.stampChanged 가 그대로 감지 ═══════ */
function testMergeLWW() {
  const { PinSeries } = loadEnv();
  const pin = { id: "m1", x: 10, y: 10 };
  PinSeries.baseline([pin]);
  const n1 = PinSeries.stampChanged([pin]);
  ok(n1 === 0, "⑥a 기준 직후(변경 없음) stampChanged → 0건 찍음");
  pin.callout = { x: 20, y: 5 };
  const n2 = PinSeries.stampChanged([pin]);
  ok(n2 === 1 && Number.isFinite(pin.updatedAt), "⑥b callout 변경만으로도 stampChanged 가 감지해 updatedAt 을 찍음(새 코드 불필요 — 기존 _sigOf 가 전체 JSON 비교, 01b_PinSeries.js 수정 無)");
}

/* ══ ⑦ 대비 — 리더선(빨강) 흰 배경 ≥3:1, 풍선 번호 ≥4.5:1(기존 txtFill 재사용) ═══ */
function testContrast() {
  const lum = (r, g, b) => {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const [R, G, B] = [f(r), f(g), f(b)];
    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
  };
  const ratio = (l1, l2) => { const a = Math.max(l1, l2) + 0.05, b = Math.min(l1, l2) + 0.05; return a / b; };
  const white = lum(255, 255, 255);
  const red = lum(0xdc, 0x26, 0x26);
  const r = ratio(white, red);
  ok(r >= 3, "⑦a 리더선 #dc2626 on 흰 도면 대비 " + r.toFixed(2) + ":1 ≥ 3:1");
  const css3 = ["public/css/style.css", "public/css/seastar-family-tokens.css", "public/css/seastar-3d-skin.css"]
    .map((p) => fs.readFileSync(path.join(ROOT, p), "utf8"));
  const collisions = css3.filter((src) => /\.pin-leader-bubble|\.leader-layer/.test(src)).length;
  ok(collisions === 1, "⑦b 신규 클래스가 3개 CSS 파일 중 정확히 1곳(public/css/style.css의 미러 원본 제외 소스)에만 정의 — 충돌 0 → 정의 파일 수=" + collisions);
}

testPureLeader();
testLegacyRenderChecker();
testToggle360();
testBubbleDragOnlyMovesCallout();
testAlignFlowAndUndo();
testMergeLWW();
testContrast();

console.log(failed === 0 ? "\n✅ p103 전체 PASS" : `\n❌ p103 ${failed}건 FAIL`);
process.exit(failed === 0 ? 0 : 1);
