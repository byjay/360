/**
 * p133 — WO 20261008-pinstyle: 핀 표현 1종(기본 핀, 핀별 리더선) · 이행 판정 · 정렬 대상 · 화살촉 역스케일 ·
 *   [포인트] 버튼 자동시작 확인(R5) · CHECKER 사진 안내 배너(R4).
 * 실행: node tests/p133-pinstyle.test.mjs
 * 뮤테이션(실제 소스를 바꿔 같은 단언을 다시 돌린다 — 반드시 EXIT=1):
 *   P133_MUT=dual|nohide|noinv|stroke|alignall|autotoggle|touchstart|nonote|noctx|ctxinput|nofab|r7|r8|r8css|r9|labelsmall|nolabeloff|numtextclass node tests/p133-pinstyle.test.mjs
 *
 * [L] WO 20261019-pinscale3-label(마스터 "라벨이 약 8px 이면 같은 결함이다") — 맞춤 상태에서
 *   번호 배지 글자 높이가 ≥11px(1~2자리)·≥10px(3자리+, §3 바닥)가 되는지 UI._numberBadgeGeom() 값을
 *   실측 변환식(height_px ≈ fs × 0.625 × pinScreenScale()/PIN_SCALE, .tmp/probe-label.mjs 라이브 CDP로
 *   잰 상수)으로 검증. P133_MUT=labelsmall 로 구 리터럴(13/9)로 되돌리면 반드시 EXIT=1.
 *
 * [M] WO 20261019-pinscale4(마스터 "핀 숫자가 보여도 되고 안 보여도 돼 — 옵션으로 선택할 수 있게")
 *   [재현] 99dbf1b 실측(지휘자 발주서 인용): 바닥 20/24px 가 맞춤(30px)보다 더 축소해도 버텨, 핀
 *   머리가 상대적으로 커져 보였고, 번호 표시 옵션은 0개(항상 켜짐)였다. 채택: 바닥을 8/10px(점)로
 *   낮추고(PIN_MIN_PX_MOUSE/TOUCH), PinLabelPrefs(23c_PinSizePrefs.js) 3상태(always/auto/hidden)를
 *   추가 — auto 는 화면 핀 높이 <MapCtrl.LABEL_HIDE_PX(16px) 면 #pins-layer.pin-num-off 로 번호만
 *   숨긴다(머리는 남음). P133_MUT=nolabeloff(토글 제거)·numtextclass(번호 텍스트 클래스 1곳 제거)
 *   로 되돌리면 반드시 EXIT=1.
 *
 * [재현] 0b4d262(라이브) CDP 실측(.tmp/fixpinstyle/r4-*-0b4d262-report.json):
 *   R1 CHECKER 핀 2개 = 마커 표시 + 리더 g 2 + 풍선 2(동시 두 표현) · 1280 zoom .41 화살촉 15.6px/풍선 30.8px,
 *      375 zoom .14 5.5px/14.2px(비율 .51 vs .39 — 줌 따라 변함)
 *   R5 360 세그먼트 → [포인트] → 도면 탭 = placing=false, 파일 선택창 0(375·1280 동일)
 * 🔴 목 금지 — 실제 소스(01_State·01b_PinSeries·10_MapCtrl·11_UI·20_App)를 vm 에 그대로 실행. 가짜는 DOM 셸뿐.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MUT = process.env.P133_MUT || "";
const MUTS = {
  // R1 되돌림: 리더선을 핀별 선택이 아니라 CHECKER 면 무조건(구 동작) — 두 표현 동시
  dual: ["11_UI.js", "if (this.Leader.wants(pin) && leaderLayer", "if ((this.Leader.wants(pin) || meta.series === \"checkboard\") && leaderLayer"],
  // R1 되돌림: 리더선을 그려도 마커를 숨기지 않음
  nohide: ["11_UI.js", "marker.style.display = \"none\";", "void 0;"],
  // R3 되돌림: 화살촉이 풍선 역스케일(inv)을 받지 않음
  noinv: ["11_UI.js", "const k = (inv > 0 ? inv : 1);", "const k = 2 / (zoom > 0 ? zoom : 1);"],
  // R3 되돌림(선): 0b4d262 처럼 고정 굵기 1.6(자연 px) — 줌 따라 화면 굵기가 변한다
  stroke: ["11_UI.js", "const strokePx = Math.max(this.LINE_MIN_PX / z, this.LINE_PX * k);", "const strokePx = 1.6 + 0 * z;"],
  // 정렬 대상 = 리더선 핀만 → 되돌림(범위 전체)
  alignall: ["11_UI.js", "return this._alignScopePins().filter((p) => this.Leader.wants(p));", "return this._alignScopePins();"],
  // R5 되돌림: [포인트] 버튼이 자동 시작된 배치를 끈다(구 토글)
  autotoggle: ["20_App.js", "if (State.placing && State._placingAuto) {", "if (false) {"],
  // R4 되돌림(모바일): touchstart 에서 바로 배치(사용자 활성화 밖 → 선택창 막힘)
  touchstart: ["20_App.js", "this._placeTouch = { x: t.clientX, y: t.clientY };", "this._handlePlaceClick({ clientX: t.clientX, clientY: t.clientY });"],
  // R2 되돌림: 우클릭을 가로채지 않음(브라우저 메뉴)
  noctx: ["11_UI.js", "      if (!tg) return false;\n      if (e.preventDefault) e.preventDefault();", "      return false;"],
  // R2 되돌림: 입력창도 앱 메뉴로 가로챔(붙여넣기 불가)
  ctxinput: ["11_UI.js", "if (!e || this._isEditable(e.target)) return false;", "if (!e) return false;"],
  // FAB 가림 되돌림: 팝업이 ?·✉ 버튼 영역을 피하지 않음
  nofab: ["11_UI.js", ".filter((a) => a.left < left + w && a.right > left); // 가로로 겹치는 것만", ".filter(() => false);"],
  // R7 되돌림: 전역 role 만(프로젝트 designer 멤버 무시)
  r7: ["22_Auth.js", ' || this.projectRole === "designer"; },', '; },'],
  // R9 되돌림: 포인트 모드 진입 시 리스트 패널을 접지 않음
  r9: ["20_App.js", "            PinGrid.setCollapsed(true);\n", ""],
  // R8 되돌림: 편집 중에도 윤곽 라벨이 클릭을 삼킴
  r8: ["46_DeckOutline.js", "if (this._editActive()) return; e.stopPropagation(); this._goto", "e.stopPropagation(); this._goto"],
  // R8 CSS 되돌림: 형제 관계를 모르는 죽은 선택자
  r8css: ["style.css", "#map-area:has(> #crosshair-overlay:not(.hidden)) .deck-outline-label", "#map-viewport:has(#crosshair-overlay:not(.hidden)) .deck-outline-label"],
  // R4 되돌림: CHECKER 배너에 사진 안내 없음
  nonote: ["20_App.js", "if (State.regMode === \"checkboard\") return this.CHECKER_PHOTO_NOTE;", "if (State.regMode === \"checkboard\") return \"도면 위 원하는 위치를 클릭하세요\";"],
  // [WO 20261019-pinscale3-label] 되돌림: 번호 배지 폰트를 구 리터럴(길이<3→13, 길이>=3→9)로 — 맞춤
  // 상태 라벨 높이가 다시 ~8px 로 떨어진다(마스터 "라벨이 약 8px 이면 같은 결함").
  labelsmall: ["11_UI.js",
    "if (len <= 1) return { fs: 20, rx: 8.6, ry: 8.6 };   // 맞춤 상태 ≈12px(목표 12~13 충족)\n      if (len === 2) return { fs: 18, rx: 13.4, ry: 8.6 }; // ≈11.25px(≥11 충족), 폭 확보로 원판 확장\n      return { fs: 16, rx: 17.6, ry: 8.6 };                // 3자+ ≈10.5px(§3 바닥 10px 충족), 원판 최대폭",
    "if (len <= 1) return { fs: 13, rx: 8.6, ry: 8.6 };\n      if (len === 2) return { fs: 13, rx: 8.6, ry: 8.6 };\n      return { fs: 9, rx: 8.6, ry: 8.6 };"],
  // [WO 20261019-pinscale4] 되돌림: #pins-layer.pin-num-off 토글 자체를 제거 — "자동" 옵션에서
  // 작은 핀의 번호를 숨기는 기능이 완전히 무효화된다(CSS 규칙은 남아도 클래스가 절대 안 붙음).
  nolabeloff: ["10_MapCtrl.js", 'layer.classList.toggle("pin-num-off", !!hideLabel);', 'void hideLabel; /* [MUT nolabeloff] 토글 제거 */'],
  // [WO 20261019-pinscale4] 되돌림: 번호 <text> 에 pin-num-text 클래스가 안 붙음(첫 등장 1곳만) —
  // CSS #pins-layer.pin-num-off .pin-num-text{display:none} 가 그 핀의 번호를 못 찾아 숨기지 못한다.
  numtextclass: ["11_UI.js", 'class="pin-num-text" x="18" y="15.4"', 'x="18" y="15.4"'],
};
if (MUT && !MUTS[MUT]) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }
const rd = (p) => {
  let s = fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
  if (MUT && p.endsWith(MUTS[MUT][0])) {
    if (!s.includes(MUTS[MUT][1])) { console.log("FAIL 뮤테이션 대상 없음: " + MUT); process.exit(2); }
    s = s.replace(MUTS[MUT][1], MUTS[MUT][2]);
    console.log("[MUT] " + MUT + " 적용");
  }
  return s;
};
const M = (f) => rd("public/js/modules/" + f);
const stateSrc = M("01_State.js"), seriesSrc = M("01b_PinSeries.js"), mapSrc = M("10_MapCtrl.js"), uiSrc = M("11_UI.js"), appSrc = M("20_App.js"), pinSizeSrc = M("23c_PinSizePrefs.js");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };

/* ══ 가짜 DOM(셸) ══ */
function makeEl(tag) {
  const el = {
    tagName: tag, _classes: new Set(), style: {}, dataset: {}, children: [], attrs: {}, parentNode: null,
    offsetWidth: 1000, offsetHeight: 800, _listeners: {},
    classList: {
      add: (...c) => c.forEach((x) => el._classes.add(x)),
      remove: (...c) => c.forEach((x) => el._classes.delete(x)),
      contains: (c) => el._classes.has(c),
      toggle(c, f) { if (f === undefined) f = !el._classes.has(c); if (f) el._classes.add(c); else el._classes.delete(c); return !!f; }
    },
    addEventListener(t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { const a = el._listeners[t]; if (a && a.indexOf(fn) >= 0) a.splice(a.indexOf(fn), 1); },
    dispatch(t, ev) { (el._listeners[t] || []).slice().forEach((fn) => fn(ev || {})); },
    appendChild(c) { el.children.push(c); c.parentNode = el; return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return el.attrs[k]; },
    querySelector(sel) { const c = sel.replace(/^\./, ""); const walk = (n) => { for (const k of n.children) { if (k._classes.has(c) || (k.attrs.class || "").split(" ").includes(c)) return k; const r = walk(k); if (r) return r; } return null; }; return walk(el); },
    querySelectorAll() { return []; },
    click() { el.dispatch("click", { stopPropagation() {}, preventDefault() {} }); },
    getBoundingClientRect() { return { left: 0, top: 0, width: el.offsetWidth, height: el.offsetHeight }; },
    get className() { return Array.from(el._classes).join(" "); },
    set className(v) { el._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    set innerHTML(v) { el._html = v; if (v === "") el.children = []; },
    get innerHTML() { return el._html || ""; },
    _text: "",
    get textContent() { return el._text; }, set textContent(v) { el._text = String(v); }
  };
  return el;
}
function uiEnv(opts) {
  opts = opts || {};
  const reg = new Map();
  const document = {
    getElementById: (id) => reg.get(id) || null,
    createElement: (t) => makeEl(t),
    body: { appendChild() {} }, querySelectorAll: () => [], querySelector: () => null,
    addEventListener() {}, removeEventListener() {}
  };
  if (!opts.noNS) document.createElementNS = (ns, t) => makeEl(t);
  const add = (id, tag) => { const e = makeEl(tag || "div"); e.id = id; reg.set(id, e); return e; };
  const pinsLayer = add("pins-layer"), leaderLayer = add("leader-layer", "svg"), tr = add("map-transform"), vp = add("map-viewport");
  const toasts = [], dirty = [];
  const App = { _markDirty() { dirty.push(1); }, _autoSave() {}, setActivePin() {}, onPinTap() {}, deletePins: async () => 0, canBulkDeletePins: () => true };
  // [WO 20261019-pinscale4] 상태형 localStorage — PinSizePrefs/PinLabelPrefs 의 get/set 라운드트립을
  // 실제로 검증하려면 getItem 이 setItem 한 값을 돌려줘야 한다(종전 getItem:()=>null 은 그걸 못 봄).
  const lsStore = new Map();
  const sandbox = {
    console, document, window: {}, navigator: { onLine: true }, App,
    Prompt: { toast: (m) => toasts.push(m) }, Zones: { render() {} }, PdfAnno: { refresh() {} }, PinIcons: { headMarkup: () => "" },
    JSON, Array, Map, Set, Date, Math, String, Number, Object, Boolean, setTimeout, clearTimeout,
    localStorage: { getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null), setItem: (k, v) => lsStore.set(k, String(v)), removeItem: (k) => lsStore.delete(k) },
    requestAnimationFrame: (f) => f()
  };
  vm.createContext(sandbox);
  vm.runInContext(stateSrc + "\n" + seriesSrc + "\n" + mapSrc + "\n" + uiSrc + "\n" + pinSizeSrc + "\n;globalThis.__UI=UI;globalThis.__S=State;globalThis.__MC=MapCtrl;globalThis.__PLP=PinLabelPrefs;globalThis.__PSP=PinSizePrefs;", sandbox);
  const UI = sandbox.__UI, State = sandbox.__S, MapCtrl = sandbox.__MC, PinLabelPrefs = sandbox.__PLP;
  MapCtrl.init(vp, tr);
  State.mode = "designer"; State.pdfPage = 1; State.zoom = 1;
  return { UI, State, MapCtrl, PinLabelPrefs, pinsLayer, leaderLayer, tr, vp, toasts, dirty };
}
const markers = (L) => L.children.filter((c) => c._classes.has("pin-marker"));
const bubbles = (L) => L.children.filter((c) => c._classes.has("pin-leader-bubble"));
const shown = (m) => m.style.display !== "none";

console.log("[A] 핀 표현 1종 — 기본 핀, 리더선은 핀별 선택일 때만(그때 마커 숨김)");
{
  const { UI, State, pinsLayer, leaderLayer } = uiEnv();
  State.pins = [{ id: "c1", x: 40, y: 30, page: 1, checkboard: true, label: "1" }, { id: "n1", x: 60, y: 50, page: 1, label: "P1" }];
  UI.renderPinsOnMap();
  ok(leaderLayer.children.length === 0, "A1 기본(레거시 CHECKER·360, callout 없음) → leader-layer 요소 0개 (" + leaderLayer.children.length + ")");
  ok(bubbles(pinsLayer).length === 0 && markers(pinsLayer).every(shown) && markers(pinsLayer).length === 2, "A2 풍선 0 · 마커 2 모두 표시");
  State.pins[0].leader = true;
  UI.renderPinsOnMap();
  const m0 = markers(pinsLayer).find((m) => m.dataset.id === "c1"), m1 = markers(pinsLayer).find((m) => m.dataset.id === "n1");
  ok(leaderLayer.children.length === 1 && bubbles(pinsLayer).length === 1, "A3 leader:true → 리더 g 1 + 풍선 1");
  ok(m0 && !shown(m0) && m0._classes.has("pin-as-leader"), "A4 leader:true 핀의 마커는 숨김(두 표현 동시 0)");
  ok(m1 && shown(m1), "A5 다른 핀(leader 없음)은 마커 그대로");
  State.pins[0].leader = false; State.pins[0].callout = { x: 70, y: 10 };
  UI.renderPinsOnMap();
  ok(leaderLayer.children.length === 0 && markers(pinsLayer).every(shown), "A6 leader:false 는 callout 이 있어도 핀으로 표시");
}
{
  const { UI, State, pinsLayer } = uiEnv({ noNS: true });
  State.pins = [{ id: "c1", x: 40, y: 30, page: 1, checkboard: true, label: "1", leader: true }];
  UI.renderPinsOnMap();
  ok(markers(pinsLayer).length === 1 && shown(markers(pinsLayer)[0]), "A7 리더를 그릴 수 없는 환경이면 마커를 숨기지 않는다(핀 소실 0)");
}

console.log("\n[B] 이행 판정 SoT — Leader.wants 경계");
{
  const { UI } = uiEnv();
  const W = (p) => UI.Leader.wants(p);
  ok(W(null) === false && W({}) === false, "B1 null/빈 핀 → false");
  ok(W({ checkboard: true, x: 1, y: 1 }) === false, "B2 레거시 CHECKER(callout 없음 = 사용자가 옮긴 기록 없음) → false(핀)");
  ok(W({ checkboard: true, callout: { x: 5, y: 6 } }) === true, "B3 레거시 CHECKER + 저장된 callout(정렬·드래그 기록) → true(리더선)");
  ok(W({ callout: { x: 5, y: 6 } }) === true, "B4 360 핀도 callout 기록이 있으면 true(구 leader360 ON 에서 옮긴 핀)");
  ok(W({ callout: { x: NaN, y: 6 } }) === false && W({ callout: { x: "5", y: 6 } }) === false && W({ callout: null }) === false, "B5 callout 이 유한수 쌍이 아니면 false");
  ok(W({ leader: false, callout: { x: 5, y: 6 } }) === false, "B6 명시 leader:false 가 이행 규칙보다 우선");
  ok(W({ leader: true }) === true, "B7 명시 leader:true(callout 없음) → true(기본 위치)");
  ok(W({ leader: "true" }) === false, "B8 boolean 이 아닌 leader 값은 무시(이행 규칙 적용)");
}

console.log("\n[C] 정렬 대상 = 리더선 핀만");
{
  const { UI, State, toasts } = uiEnv();
  State.regMode = "checkboard";
  State.pins = [1, 2, 3].map((i) => ({ id: "a" + i, x: i * 10, y: i * 10, page: 1, checkboard: true, label: String(i) }));
  UI._startAlign("v");
  ok(toasts[toasts.length - 1] === "리더선 핀이 없습니다 — 핀 우클릭 > 리더선으로 표시" && !UI._alignCapture, "C1 리더선 핀 0개 → 안내 문구 그대로 + 캡처 시작 안 함");
  State.pins[0].leader = true; State.pins[2].leader = true;
  const cand = UI._alignCandidatePins().map((p) => p.id).join(",");
  ok(cand === "a1,a3", "C2 후보 = 리더선 핀만(번호순) → " + cand);
  UI._pinSel.on = true; UI._pinSel.ids = new Set(["a1", "a2"]);
  const cand2 = UI._alignCandidatePins().map((p) => p.id).join(",");
  ok(cand2 === "a1", "C3 선택에 핀 표현 핀이 섞여도 리더선 핀만 → " + cand2);
  UI._startAlign("v");
  ok(/2개 이상/.test(toasts[toasts.length - 1]) && !UI._alignCapture, "C4 리더선 1개 → 2개 이상 안내");
}

console.log("\n[D] 화살촉 역스케일 — 배율 0.15·1·4 에서 화살촉/풍선 비율 일정 + 방향 = 선 방향");
{
  const { UI, State, MapCtrl, leaderLayer, tr } = uiEnv();
  tr.offsetWidth = 2400; tr.offsetHeight = 1200; // 비정방(=viewBox 100x100 의 x·y 배율이 다름)
  State.pins = [{ id: "c1", x: 40, y: 50, page: 1, checkboard: true, label: "1", leader: true, callout: { x: 55, y: 30 } }];
  const ratios = [], dirs = [];
  for (const z of [0.15, 1, 4]) {
    State.zoom = z;
    UI.renderPinsOnMap();
    const g = leaderLayer.children[0];
    const arrow = g.children.find((c) => c.attrs.class === "pin-leader-arrow");
    const pts = arrow.attrs.points.split(" ").map((s) => s.split(",").map(Number)).map(([x, y]) => [x * 24, y * 12]); // % → 자연 px
    const [tip, b1, b2] = pts;
    const mid = [(b1[0] + b2[0]) / 2, (b1[1] + b2[1]) / 2];
    const lenScreen = Math.hypot(mid[0] - tip[0], mid[1] - tip[1]) * z;
    const bubbleScreen = UI.Leader.BUBBLE_DIAM_PX * MapCtrl.pinScreenScale() * z;
    ratios.push(lenScreen / bubbleScreen);
    // 선의 첫 선분 방향(대상 → 랜딩 시작점) 과 화살촉(촉 → 밑변 중점) 방향
    const d = g.children.find((c) => c.attrs.class === "pin-leader-line").attrs.d.split(/[ ML]+/).filter(Boolean).map(Number);
    const lv = [(d[2] - d[0]) * 24, (d[3] - d[1]) * 12], av = [mid[0] - tip[0], mid[1] - tip[1]];
    dirs.push((lv[0] * av[0] + lv[1] * av[1]) / (Math.hypot(...lv) * Math.hypot(...av)));
  }
  const spread = Math.max(...ratios) - Math.min(...ratios);
  ok(spread < 1e-6, "D1 화살촉/풍선 화면 비율 = " + ratios.map((r) => r.toFixed(4)).join(" / ") + " (배율 0.15·1·4 동일)");
  ok(dirs.every((c) => c > 0.9999), "D2 화살촉 방향 = 선 끝 방향(cos " + dirs.map((c) => c.toFixed(4)).join(", ") + ")");
  // refreshLeaders(줌 변경 경로) — DOM 재생성 없이 같은 기하로 갱신
  State.zoom = 1; UI.renderPinsOnMap();
  const arrow = leaderLayer.children[0].children.find((c) => c.attrs.class === "pin-leader-arrow");
  const at1 = arrow.attrs.points;
  State.zoom = 4; UI.refreshLeaders();
  ok(arrow.attrs.points !== at1 && leaderLayer.children[0].children.includes(arrow), "D3 줌 변경 → refreshLeaders 가 같은 요소의 화살촉을 다시 계산");
  const line = leaderLayer.children[0].children.find((c) => c.attrs.class === "pin-leader-line");
  ok(line.attrs["vector-effect"] === "non-scaling-stroke", "D4 선 = non-scaling-stroke(viewBox 비정방 왜곡 없음)");
  // 화면 선 굵기 = stroke-width × zoom(조상 CSS scale) — 풍선과 같은 비율, 화면 1px 하한
  const sw = {};
  for (const z of [0.15, 1, 4]) { State.zoom = z; UI.refreshLeaders(); sw[z] = { screen: +line.attrs["stroke-width"] * z, bubble: UI.Leader.BUBBLE_DIAM_PX * MapCtrl.pinScreenScale() * z }; }
  // [WO 20261016-pinscale2 재도입 이후 — R3 수정] b0d24ad 가 PIN_MAX_PX(48px 상한)를 되살리고
  // PIN_SCALE 을 2→0.75 로 낮췄다. 풍선(MapCtrl.pinScreenScale, 상한 clamp)과 선(Leader.geometry
  // strokePx, 화면 1px 절대 하한 LINE_MIN_PX/z)은 서로 다른 종류의 clamp 를 쓰므로 하한이 걸리는
  // 구간(z=1: 1.2×0.75=0.9 < 1px 하한)에서는 "비율 불변"이 더 이상 참이 아니다(실측: r1=0.0606 ≠
  // r4=0.0545 — 옛 단언은 거짓 전제였다, PIN_SCALE 2→0.75 변경으로 z=1 이 하한 구간에 처음 들어감).
  // 진짜 SoT는 Leader.geometry() 의 strokePx 공식 자체이므로, 그 공식을 그대로 재계산해 기대값을
  // 만들고 렌더된 실제 선 굵기와 직접 비교한다(더 이상 비율 가정에 의존하지 않음).
  for (const z of [0.15, 1, 4]) {
    const inv = (() => { const sv = State.zoom; State.zoom = z; const v = MapCtrl.pinScreenScale(); State.zoom = sv; return v; })();
    const expStrokePx = Math.max(UI.Leader.LINE_MIN_PX / z, UI.Leader.LINE_PX * inv);
    // geo.strokePx 는 렌더 시 .toFixed(2) 로 속성에 저장된다(11_UI.js _renderLeaderLineOnly) —
    // 같은 반올림을 거쳐야 부동소수 오차 없이 정확히 일치한다.
    const expScreen = Number(expStrokePx.toFixed(2)) * z;
    ok(Math.abs(sw[z].screen - expScreen) < 1e-6,
      "D5 zoom=" + z + " 선 굵기 화면값 = Leader.geometry strokePx 공식과 일치(실제 " + sw[z].screen.toFixed(4) + "px / 기대 " + expScreen.toFixed(4) + "px)");
  }
  ok(Object.values(sw).every((s) => s.screen >= 0.999), "D6 화면 선 굵기 ≥1px(0.15배 " + sw[0.15].screen.toFixed(2) + "px)");
}

console.log("\n[E] 일괄 켜기/끄기(설정·전체 기능 메뉴) — 핀별 데이터 pin.leader");
{
  const { UI, State, leaderLayer, dirty } = uiEnv();
  State.regMode = "checkboard";
  State.pins = [{ id: "e1", x: 10, y: 10, page: 1, checkboard: true, label: "1" }, { id: "e2", x: 20, y: 20, page: 1, checkboard: true, label: "2" }, { id: "e3", x: 30, y: 30, page: 1, label: "P1" }];
  const n = UI.bulkLeader(true);
  ok(n === 2 && State.pins[0].leader === true && State.pins[1].leader === true && State.pins[2].leader === undefined, "E1 일괄 켜기 = 현재 모드(CHECKER) 범위만 → 2개");
  ok(leaderLayer.children.length === 2 && dirty.length >= 1, "E2 리더 2개 렌더 + 미저장 표시(LWW 경로)");
  UI.bulkLeader(false);
  ok(leaderLayer.children.length === 0 && State.pins[0].leader === false, "E3 일괄 끄기 → leader:false, 리더 0");
}

console.log("\n[F] R5 — 모드 진입이 켠 배치를 [포인트] 첫 누름이 끄지 않는다 · R4 CHECKER 배너");
function appEnv(opt) {
  opt = opt || {};
  const reg = {};
  const el = () => { const e = makeEl("div"); return e; };
  const msg = el();
  const document = {
    getElementById: (id) => (reg[id] = reg[id] || el()), createElement: () => el(), querySelectorAll: () => [], addEventListener() {},
    querySelector: (s) => (s === "#crosshair-overlay .crosshair-msg" ? msg : s === '#mobile-dock [data-act="place"]' ? (reg.__fab = reg.__fab || el()) : null)
  };
  const State = { placing: false, checkboard: true, regMode: "photo", mode: "designer", pdfPage: 1, pins: [], zoom: 1 };
  const calls = { picker: 0, auto: 0 };
  const UI = { $: (id) => document.getElementById(id), hide(id) { document.getElementById(id).classList.add("hidden"); }, show() {}, text() {}, val() { return ""; }, clearVal() {}, renderPinList() {}, renderPinsOnMap() {} };
  const toasts = [];
  const sandbox = {
    console, document, window: { addEventListener() {}, matchMedia: (q) => ({ matches: !!opt.mobile && /max-width: 760px/.test(q) }) }, State, UI, Prompt: { toast: (m) => toasts.push(m) },
    MapCtrl: { viewportToPercent: () => ({ x: 10, y: 10 }), flyTo() {}, _applyIso() {} },
    PhotoBatch: { autoConnectPin: () => { calls.auto++; } },
    JSON, Array, Map, Set, Date, Math, setTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(seriesSrc + "\n" + appSrc + "\n;globalThis.__App = App;", sandbox);
  const App = sandbox.__App;
  App._updateSyncBadge = () => {}; App._autoSave = () => {}; App._updateCheckboardQuickStatus = () => {};
  App._openPinMediaPicker = () => { calls.picker++; };
  App.__setPinGrid = (pg) => { sandbox.PinGrid = pg; }; // 테스트 셸 — 협력 모듈 주입
  return { App, State, reg, msg, calls, toasts };
}
{
  const { App, State, reg, calls } = appEnv();
  App._autoStartPlacing();
  ok(State.placing === true && State._placingAuto === true, "F1 360 진입 자동 시작 → placing ON(자동 표시)");
  ok(reg["btn-quickpoint"].classList.contains("active") && reg.__fab.classList.contains("active"), "F2 자동 시작도 [포인트] 버튼(사이드·모바일 FAB) 활성 표시");
  App._onPlaceButton();
  ok(State.placing === true, "F3 🔴 [포인트] 첫 누름 = 켜기 확인(끄지 않음) — 0b4d262 은 여기서 OFF");
  App._handlePlaceClick({ clientX: 5, clientY: 5 });
  ok(State.pins.length === 1 && calls.auto === 1, "F4 이어서 도면 탭 → 번호 핀 1 + 사진 선택(autoConnectPin) 1회");
  App._onPlaceButton();
  ok(State.placing === false, "F5 두 번째 누름은 종전대로 끈다");
  App._onPlaceButton();
  ok(State.placing === true && !State._placingAuto, "F6 꺼진 상태에서 누르면 켠다(사용자 시작)");
}
{
  const { App, State, msg } = appEnv();
  State.regMode = "checkboard";
  App._autoStartPlacing();
  ok(/CHECKER: 번호만 · 사진은 폴더 일괄로/.test(msg.textContent), "F7 CHECKER 배치 배너 = \"" + msg.textContent + "\"");   // [WO 20261015-numunify] 문구 갱신(종전 "사진은 360 모드에서")
  State.regMode = "photo"; App._syncPlacingUi();
  ok(/^360:/.test(msg.textContent) && !/CHECKER/.test(msg.textContent), "F8 360 배너 = \"" + msg.textContent + "\"");
  ok(msg.textContent.length <= 26, "F9 배너는 nowrap — 375px 안(26자 이하) → " + msg.textContent.length);
}
{
  // R4 모바일 — 배치는 touchend(사용자 활성화 이벤트)에서. touchstart 에서 배치하면 사진 선택창이 막힌다(CDP 375 재현).
  const { App, State, calls } = appEnv();
  State.placing = true; State.regMode = "photo";
  const ev = (x, y, n) => ({ preventDefault() {}, cancelable: true, touches: n ? [{ clientX: x, clientY: y }] : [], changedTouches: [{ clientX: x, clientY: y }] });
  App._placeTouchStart(ev(50, 60, 1));
  ok(State.pins.length === 0 && calls.auto === 0, "F11 touchstart 만으로는 배치·선택창 없음(활성화 이벤트가 아님)");
  ok(App._placeTouchEnd(ev(53, 62, 0)) === true && State.pins.length === 1 && calls.auto === 1, "F12 touchend(이동 <12px) → 번호 핀 1 + 사진 선택 1(같은 이벤트 안)");
  App._placeTouchStart(ev(50, 60, 1));
  App._placeTouchEnd(ev(90, 60, 0));
  ok(State.pins.length === 1, "F13 40px 끌고 뗀 것은 탭이 아님 → 배치 안 함");
  const touchStartSrc = appSrc.slice(appSrc.indexOf('vp.addEventListener("touchstart"'), appSrc.indexOf('vp.addEventListener("touchmove"'));
  ok(/this\._placeTouchStart\(e\)/.test(touchStartSrc) && !/_handlePlaceClick|_handlePlaceTouch/.test(touchStartSrc), "F14 지도 touchstart 핸들러는 위치 기억만(_placeTouchStart) — 배치 호출 없음");
}
{
  const hub = rd("public/js/modules/12_ProjectHub.js");
  const i = hub.indexOf("async openProjectAtDeck(");
  const body = hub.slice(i, hub.indexOf("closeModeSelect()", i));
  ok(/App\._autoStartPlacing\(\)/.test(body) && !/if \(deckId == null\) return;/.test(body), "F10 허브 잎 진입도 같은 모드면 자동 시작(구역 없는 경로 포함)");
}

console.log("\n[G] 우클릭 = 앱 메뉴 · 권한 비활성+사유 · 입력창 제외 · 팝업 위치(FAB 회피)");
// 실제 45_FeatureMenu 를 같은 컨텍스트에 올린다(항목 재사용 SoT 검증용). 가짜 = DOM 셸 · Auth 역할 · FAB 사각형뿐.
function uiEnvCtx(role, fabs) {
  const reg = new Map();
  const body = makeEl("body");
  const document = {
    getElementById: (id) => reg.get(id) || null, createElement: (t) => makeEl(t), createElementNS: (ns, t) => makeEl(t),
    body, querySelectorAll: (s) => (s.indexOf("data-help-toggle") >= 0 ? (fabs || []) : []), querySelector: () => null,
    addEventListener() {}, removeEventListener() {}, activeElement: null
  };
  const add = (id, tag) => { const e = makeEl(tag || "div"); e.id = id; reg.set(id, e); return e; };
  const pinsLayer = add("pins-layer"), leaderLayer = add("leader-layer", "svg"), tr = add("map-transform"), vp = add("map-viewport");
  vp.contains = () => false; // 셸 — 지도 안 대상은 테스트가 지정
  const toasts = [];
  const App = { _markDirty() {}, _autoSave() {}, setActivePin() {}, onPinTap() {}, deletePin() {}, deletePins: async () => 0, canBulkDeletePins: () => true };
  const sandbox = {
    console, document, window: { innerWidth: 375, innerHeight: 812 }, navigator: { onLine: true }, App,
    Auth: role === "designer" ? { isDesigner: true, user: { email: "d@x" } } : { isDesigner: false, user: { email: "v@x" } },
    Projects: { decks: [], currentProject: { id: "p" } },
    Prompt: { toast: (m) => toasts.push(m) }, Zones: { render() {} }, PdfAnno: { refresh() {} }, PinIcons: { headMarkup: () => "" },
    JSON, Array, Map, Set, Date, Math, String, Number, Object, Boolean, setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem() {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(stateSrc + "\n" + seriesSrc + "\n" + mapSrc + "\n" + uiSrc + "\n" + M("45_FeatureMenu.js") + "\n;globalThis.__UI=UI;globalThis.__S=State;globalThis.__MC=MapCtrl;", sandbox);
  const UI = sandbox.__UI, State = sandbox.__S;
  sandbox.__MC.init(vp, tr);
  State.mode = role === "designer" ? "designer" : "viewer"; State.pdfPage = 1; State.zoom = 1; State.regMode = "checkboard";
  return { UI, State, vp, toasts, document };
}
const labels = (items) => items.map((i) => i.label);
const reasonOf = (items, re) => { const it = items.find((i) => re.test(i.label)); return it ? (it.reason || "") : null; };
{
  const D = uiEnvCtx("designer"), V = uiEnvCtx("viewer");
  const pin = { id: "g1", x: 30, y: 40, page: 1, checkboard: true, label: "1" };
  D.State.pins = [pin]; V.State.pins = [pin];
  const di = D.UI.pinCtxItems(pin), vi = V.UI.pinCtxItems(pin);
  const want = ["열기", "수정(라벨·번호)", "리더선으로 표시", "선택에 추가(정렬·삭제용)", "복사(좌표)", "QR 위치 태그", "AI 분석", "삭제"];
  ok(want.every((w) => labels(di).includes(w)), "G1 핀 메뉴 항목 = " + labels(di).join(" · "));
  ok(labels(di).some((l) => /정렬/.test(l)), "G2 핀 메뉴에 정렬 ↕/↔(전체 기능 메뉴 항목 재사용)");
  ok(reasonOf(di, /^수정/) === "" && reasonOf(di, /^리더선/) === "" && reasonOf(di, /^삭제/) === "", "G3 디자이너 = 편집 항목 사용 가능");
  ok(reasonOf(vi, /^열기/) === "" && /디자이너\(편집\) 전용/.test(reasonOf(vi, /^수정/)) && /디자이너\(편집\) 전용/.test(reasonOf(vi, /^삭제/)) && /디자이너\(편집\) 전용/.test(reasonOf(vi, /^리더선/)), "G4 열람자 = 열기만 활성, 편집 항목은 비활성 + 사유(숨김 0 — 항목 수 " + vi.length + "=" + di.length + ")");
  ok(vi.length === di.length, "G5 열람자도 항목을 숨기지 않는다");
  ok(/CHECKER 는 사진을 등록하지 않습니다/.test(reasonOf(di, /^AI 분석/)), "G6 CHECKER 핀 AI 분석 = 비활성 + 사유");
  const dm = D.UI.mapCtxItems({ x: 10, y: 10 }, { x: 1, y: 1 }), vm2 = V.UI.mapCtxItems({ x: 10, y: 10 }, { x: 1, y: 1 });
  ok(["여기에 핀 추가(CHECKER)", "붙여넣기", "정렬 시작 ↕", "정렬 시작 ↔", "화면 맞춤", "촬영 현황 보기 켜기/끄기", "전체 기능 메뉴 열기"].every((w) => labels(dm).includes(w)), "G7 빈 도면 메뉴 = " + labels(dm).join(" · "));
  ok(/복사한 포인트가 없습니다/.test(reasonOf(dm, /^붙여넣기/)), "G8 붙여넣기 = 복사한 핀이 없으면 비활성 + 사유");
  D.UI.copyPin(pin);
  ok(reasonOf(D.UI.mapCtxItems({ x: 10, y: 10 }, { x: 1, y: 1 }), /^붙여넣기/) === "", "G9 핀 복사 후 붙여넣기 활성");
  ok(/디자이너\(편집\) 전용/.test(reasonOf(vm2, /^여기에 핀 추가/)) && labels(vm2).includes("요청·질문 보내기"), "G10 열람자 빈 도면 = 핀 추가 비활성+사유 · 요청·질문 항목 있음");
}
{
  const D = uiEnvCtx("designer");
  const pin = { id: "g2", x: 30, y: 40, page: 1, checkboard: true, label: "1" };
  D.State.pins = [pin];
  let prevented = 0;
  const marker = { dataset: { id: "g2" }, closest: (s) => (/\.pin-marker/.test(s) ? marker : null) };
  const ok1 = D.UI.openCtxMenu({ target: marker, clientX: 50, clientY: 60, preventDefault() { prevented++; } });
  const pop = D.UI._treePop && D.UI._treePop.pop;
  ok(ok1 === true && prevented === 1 && pop && pop.children.some((c) => /리더선으로 표시/.test(c.innerHTML)), "G11 핀 우클릭 → preventDefault + 앱 메뉴(리더선으로 표시 포함)");
  const input = { closest: (s) => (/input/.test(s) ? input : null) };
  D.vp.contains = (t) => t === input; // 도면 위 입력창(주석 텍스트 등)이라도 브라우저 메뉴
  prevented = 0; D.UI.closeTreeMenu();
  const ok2 = D.UI.openCtxMenu({ target: input, clientX: 5, clientY: 5, preventDefault() { prevented++; } });
  ok(ok2 === false && prevented === 0 && !D.UI._treePop, "G12 입력창 우클릭 → 브라우저 메뉴 유지(preventDefault 0)");
  let clicked = 0;
  const more = { click() { clicked++; } };
  const node = { closest: (s) => (/#side-tree/.test(s) ? node : null), querySelector: (s) => (s === ".tree-more" ? more : null) };
  prevented = 0;
  ok(D.UI.openCtxMenu({ target: node, clientX: 5, clientY: 5, preventDefault() { prevented++; } }) === true && clicked === 1 && prevented === 1, "G13 트리 노드 우클릭 → 그 노드의 ⋯ 메뉴(기존 정의) 그대로");
  const mapT = { closest: () => null };
  D.vp.contains = (t) => t === mapT;
  prevented = 0;
  ok(D.UI.openCtxMenu({ target: mapT, clientX: 100, clientY: 80, preventDefault() { prevented++; } }) === true && prevented === 1 && D.UI._treePop.pop.children.some((c) => /여기에 핀 추가/.test(c.innerHTML)), "G14 빈 도면 우클릭 → 도면 메뉴");
  const other = { closest: () => null };
  prevented = 0; D.UI.closeTreeMenu();
  // [WO 20261010-backctx] 마스터 "오른쪽 마우스는 브라우저 속성이 아니라 앱 자체 기능이" — G15 를 뒤집었다(종전: 밖 = 브라우저 메뉴).
  ok(D.UI.openCtxMenu({ target: other, clientX: 1, clientY: 1, preventDefault() { prevented++; } }) === true && prevented === 1
    && D.UI._treePop.pop.children.some((c) => /뒤로\(이전 화면\)/.test(c.innerHTML)) && D.UI._treePop.pop.children.some((c) => /Shift\+우클릭/.test(c.textContent || c.innerHTML || "")),
    "G15 도면·핀·트리 밖도 앱 메뉴(전체 기능 SoT 부분집합 + [뒤로] + 하단 'Shift+우클릭' 안내)");
  prevented = 0; D.UI.closeTreeMenu();
  ok(D.UI.openCtxMenu({ target: other, shiftKey: true, clientX: 1, clientY: 1, preventDefault() { prevented++; } }) === false && prevented === 0 && !D.UI._treePop, "G15b Shift+우클릭 → 브라우저 메뉴(탈출구)");
  const card = { classList: { contains: (c) => c === "hub-card-locked" ? false : false }, querySelector: (s) => (/data-act="(info|dl|members|del)"/.test(s) ? { click() {} } : null), closest: () => null };
  card.closest = (s) => (/hub-card/.test(s) ? card : null);
  prevented = 0;
  ok(D.UI.openCtxMenu({ target: card, clientX: 9, clientY: 9, preventDefault() { prevented++; } }) === true && prevented === 1, "G15c 허브 카드 우클릭 → 앱 메뉴");
  const hi = D.UI.hubCardCtxItems(card);
  ok(["열기", "프로젝트 정보", "프로젝트 이름 변경", "멤버 관리", "오프라인 보관(다운로드)", "공유 주소 복사", "QR 위치 태그", "프로젝트 삭제"].every((w) => labels(hi).includes(w))
    && reasonOf(hi, /^멤버 관리/) === "" && /소유자·관리자 전용/.test(reasonOf(hi, /^프로젝트 이름 변경/)), "G15d 허브 카드 항목 = 카드 버튼 위임 · 버튼 없으면 비활성+사유(숨김 0)");
}
{
  // 팝업 위치(데스크톱 경로 — 모바일 ≤760 은 CSS 바텀시트가 SoT) — 좌하단 FAB(?·✉ 16·64,652 40×40, 0b4d262 실측 좌표)
  const fab = (x) => ({ getBoundingClientRect: () => ({ left: x, top: 652, right: x + 40, bottom: 692, width: 40, height: 40 }) });
  const D = uiEnvCtx("designer", [fab(16), fab(64)]);
  const pop = makeEl("div"); pop.offsetWidth = 280; pop.offsetHeight = 134;
  const r = D.UI.placePopup(pop, { left: 30, top: 584, bottom: 608 });
  const ov = (t) => t < 692 && t + 134 > 652;
  ok(!ov(r.top) && r.top >= 8 && r.top + 134 <= 812 - 8, "G16 앵커 아래가 FAB 와 겹치면 위로(top " + r.top + ") — FAB 숨김 0");
  const big = makeEl("div"); big.offsetWidth = 280; big.offsetHeight = 900;
  const r2 = D.UI.placePopup(big, { left: 30, top: 300, bottom: 320 });
  ok(r2.top >= 8 && big.style.overflowY === "auto" && parseFloat(big.style.maxHeight) <= 652 - 4 - r2.top, "G17 화면보다 큰 메뉴 = 화면·FAB 위로 줄이고 스크롤(넘침 0)");
  const r3 = D.UI.placePopup(pop, { left: 360, top: 100, bottom: 100 });
  ok(r3.left + 280 <= 375 - 8 + 0.001, "G18 오른쪽 끝 = 화면 안으로 보정(left " + r3.left + ")");
}
{
  // 모바일 — CSS 바텀시트 + body:has(.tree-pop) FAB 상향 규칙이 SoT(정적 대조: 3개 CSS 중 style.css 한 곳)
  const css = rd("public/css/style.css");
  const m = css.match(/body:has\(#screen-app\.active\):has\(\.tree-pop\) \[data-help-inquiry-toggle\] \{\s*bottom: calc\(60vh \+ var\(--mdock-h\)/);
  ok(!!m, "G19 메뉴 열림 동안 ?·✉ 를 시트(60vh) 위로 — 편집화면 규칙(ID 특정도)보다 강한 선택자");
  const fam = rd("public/css/seastar-family-tokens.css") + rd("public/css/seastar-3d-skin.css");
  ok(!/tree-pop|data-help-toggle/.test(fam), "G20 다른 CSS 2개에 .tree-pop/FAB 위치 덮어쓰기 없음");
}

console.log("\n[H] R7 프로젝트 단위 편집 권한 · R8 윤곽 라벨 통과 · R9 리스트 패널 접기 · 오른쪽 버튼 배치 0");
{
  // 실제 22_Auth.js — 전역 viewer + 이 프로젝트 designer 멤버(서버 deploymentWriteDenied 는 쓰기 허용)
  const sb = { console, window: {}, document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, setTimeout, clearTimeout, JSON, Date, Math };
  vm.createContext(sb);
  vm.runInContext(M("22_Auth.js") + "\n;globalThis.__A = Auth;", sb);
  const A = sb.__A;
  A.role = "viewer"; A.projectRole = null;
  ok(A.isDesigner === false, "H1 전역 viewer · 프로젝트 밖 → 편집 불가");
  A.projectRole = "designer";
  ok(A.isDesigner === true, "H2 🔴 전역 viewer + 이 프로젝트 designer 멤버 → 편집 가능(0b4d262: 편집 화면 진입 0·메뉴 51개 비활성)");
  A.projectRole = "viewer";
  ok(A.isDesigner === false, "H3 프로젝트 viewer 멤버 → 편집 불가(권한 상승 없음)");
  A.role = "designer"; A.projectRole = null;
  ok(A.isDesigner === true, "H4 전역 designer → 종전대로 편집 가능");
  const hub = rd("public/js/modules/12_ProjectHub.js");
  const open = hub.slice(hub.indexOf("    async open() {"), hub.indexOf("    async load() {"));
  ok(/Auth\.setProjectContext\(null\)/.test(open), "H5 허브(프로젝트 밖)로 오면 프로젝트 역할을 비운다(남의 프로젝트 권한 잔존 0)");
}
{
  const dk = rd("public/js/modules/46_DeckOutline.js");
  ok(/addEventListener\("click", \(e\) => \{ if \(this\._editActive\(\)\) return; e\.stopPropagation\(\); this\._goto/.test(dk), "H6 R8 윤곽 라벨 클릭 = 편집 도구 켜짐이면 통과(전파 차단·이동 0)");
  const md = appSrc.slice(appSrc.indexOf('vp.addEventListener("mousedown"'), appSrc.indexOf('vp.addEventListener("mousedown"') + 900);
  const css = rd("public/css/style.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const html = rd("public/index.html");
  const sib = html.indexOf('id="crosshair-overlay"') > html.indexOf('id="map-viewport"') && /id="map-viewport"[\s\S]*?\n      <\/div>[\s\S]*?id="crosshair-overlay"/.test(html);
  ok(sib && !/#map-viewport:has\(#crosshair-overlay:not\(\.hidden\)\) \.deck-outline-label/.test(css) && /#map-area:has\(> #crosshair-overlay:not\(\.hidden\)\) \.deck-outline-label/.test(css),
    "H6b R8 근본 — crosshair 는 map-viewport 의 형제 → 배치 중 윤곽 라벨 통과 규칙을 공통 부모 #map-area 기준으로");
  ok(md.indexOf("if (e.button === 2) return;") > 0 && md.indexOf("if (e.button === 2) return;") < md.indexOf("this._handlePlaceClick(e)"), "H7 오른쪽 버튼 mousedown 은 배치하지 않는다(앱 메뉴 전용)");
}
{
  const { App, State } = appEnv({ mobile: true });
  const PG = { collapsed: false, setCollapsed(v) { this.collapsed = !!v; } };
  App.__setPinGrid(PG);
  State.regMode = "photo";
  App._togglePlacing();
  ok(State.placing === true && PG.collapsed === true, "H8 R9 모바일 포인트 모드 진입 → 리스트 패널 접힘(숨김 아님 — 다시 열기 그대로)");
}

console.log("\n[L] 번호 배지 가독성(WO 20261019-pinscale3-label) — 맞춤 상태 라벨 bbox 높이");
{
  const { UI, MapCtrl, State } = uiEnv();
  State.zoom = 1; // 이 하니스는 viewport.clientWidth 가 없어 computeFitZoom()→null→폴백 1
                  // (p159 와 동일 전제) → pinScreenScale()=PIN_SCALE = "맞춤 상태"와 동일 비율.
  // [실측] 라이브 CDP(.tmp/probe-label.mjs, 실제 public/css/style.css + Segoe UI Bold 로드,
  // --pin-scale 0.75 적용 후 getBoundingClientRect)로 잰 변환 상수: height_px ≈ fontSize(viewBox
  // 단위) × 0.625 × (pinScreenScale()/MapCtrl.PIN_SCALE). 실측 원값: fs13→8.25px, fs18→11.25px,
  // fs20→12px, fs22→13.5px(기울기 0.6136~0.6346, 평균 0.625 채택).
  const K = 0.625;
  const heightPx = (label) => UI._numberBadgeGeom(label).fs * K * (MapCtrl.pinScreenScale() / MapCtrl.PIN_SCALE);
  const h1 = heightPx("1"), h2 = heightPx("12"), h3 = heightPx("123"), hA = heightPx("A12");
  ok(h1 >= 11, `L1 1자리 "1" 맞춤 상태 라벨 높이=${h1.toFixed(2)}px ≥11px(목표 12~13) — 마스터 재현(종전 fs13→8.25px)`);
  ok(h2 >= 11, `L2 2자리 "12" 맞춤 상태 라벨 높이=${h2.toFixed(2)}px ≥11px`);
  ok(h3 >= 10, `L3 3자리 "123" 맞춤 상태 라벨 높이=${h3.toFixed(2)}px ≥10px(바닥, §3 긴 라벨은 줄이되 바닥 10px)`);
  ok(hA >= 10, `L4 접두사 "A12" 맞춤 상태 라벨 높이=${hA.toFixed(2)}px ≥10px(바닥)`);
  // [비례] 맞춤의 1.3배로 확대하면 라벨도 정확히 1.3배 커진다(마커 전체 --pin-scale 공유 — 추가
  // 코드 없이 구조적 보장. 1.3배는 PIN_MAX_PX 상한(ceil, zoom≈1.87배부터 clamp)에 안 걸리는 구간).
  State.zoom = 1.3;
  const h1x13 = heightPx("1");
  ok(Math.abs(h1x13 - h1 * 1.3) < 1e-6, `L5 zoom=맞춤×1.3 → "1" 라벨 높이=${h1x13.toFixed(3)}px = 맞춤×1.3=${(h1 * 1.3).toFixed(3)}px(비례 확인)`);
}

console.log("\n[M] WO 20261019-pinscale4 — 핀 번호 표시 옵션(항상/자동/숨김) + 작을 때 자동 숨김");
{
  // M1~M4: PinLabelPrefs 3상태 SoT (localStorage 라운드트립 포함)
  const { PinLabelPrefs } = uiEnv();
  ok(PinLabelPrefs.get() === "auto", `M1 기본값 = auto (${PinLabelPrefs.get()})`);
  PinLabelPrefs.set("hidden");
  ok(PinLabelPrefs.get() === "hidden" && PinLabelPrefs.shouldHide(999) === true, "M2 hidden → 아무리 커도(999px) 항상 숨김");
  PinLabelPrefs.set("always");
  ok(PinLabelPrefs.get() === "always" && PinLabelPrefs.shouldHide(1) === false, "M3 always → 아무리 작아도(1px) 항상 표시");
  PinLabelPrefs.set("auto");
  ok(PinLabelPrefs.shouldHide(20) === false && PinLabelPrefs.shouldHide(10) === true, "M4 auto → LABEL_HIDE_PX(16) 기준 20px 표시/10px 숨김");
}
{
  // M5~M7: renderPinsOnMap() 이 실제로 번호 <text> 에 pin-num-text 클래스를 붙이는가(CSS 가 잡을 대상).
  const { UI, State, pinsLayer } = uiEnv();
  State.regMode = "checkboard"; // simplifiedCheckboard 템플릿(1902행, 번호 텍스트가 2곳 중 하나) 경로를 실제로 태운다
  State.pins = [{ id: "m1", x: 10, y: 10, page: 1, checkboard: true, label: "1" }, { id: "m2", x: 20, y: 20, page: 1, label: "P1" }];
  UI.renderPinsOnMap();
  const html = pinsLayer.children.map((m) => m.innerHTML).join("");
  const n = (html.match(/class="pin-num-text"/g) || []).length;
  ok(n === 2, `M5 CHECKER·360 핀 둘 다 번호 <text> 에 pin-num-text 클래스(실제 ${n}/2) — CSS #pins-layer.pin-num-off 가 잡을 대상`);
}
{
  // M6~M8: _applyPinBillboard() 가 매 줌마다 #pins-layer 에 pin-num-off 를 실제로 토글하는가(auto).
  const { MapCtrl, State, PinLabelPrefs, pinsLayer } = uiEnv();
  PinLabelPrefs.set("auto");
  State.zoom = 0.667; // px≈20(≥16) — fitZoom 폴백 1 전제(§L 과 동일)
  MapCtrl._applyPinBillboard();
  ok(!pinsLayer.classList.contains("pin-num-off"), `M6 px≈20(≥16) → pin-num-off 없음(번호 표시)`);
  State.zoom = 0.333; // px≈10(<16)
  MapCtrl._applyPinBillboard();
  ok(pinsLayer.classList.contains("pin-num-off"), `M7 px≈10(<16) → pin-num-off 붙음(번호 숨김, 머리는 그대로)`);
  PinLabelPrefs.set("always");
  MapCtrl._applyPinBillboard(); // 같은 zoom(px≈10)이어도 always 면 절대 안 숨김
  ok(!pinsLayer.classList.contains("pin-num-off"), `M8 같은 px≈10 이어도 always → pin-num-off 없음(옵션이 auto 판정보다 우선)`);
}
{
  // M9: 핀 바닥(점) — 맞춤보다 더 축소해도 "점"(8px, 종전 20px)까지 계속 작아진다(마스터 "핀 머리가
  //  너무 크게 보이지 않게"). fitZoom 폴백 1 이라 effZoom=zoom — zoom 을 아주 작게 주면 바닥에 닿는다.
  const { MapCtrl, State } = uiEnv();
  State.zoom = 0.0001;
  const px = MapCtrl.pinScreenScale() * MapCtrl.PIN_NATIVE_PX;
  ok(Math.abs(px - MapCtrl.PIN_MIN_PX_MOUSE) < 1e-6 && MapCtrl.PIN_MIN_PX_MOUSE <= 10, `M9 극저 zoom → 바닥 ${px.toFixed(2)}px = PIN_MIN_PX_MOUSE(${MapCtrl.PIN_MIN_PX_MOUSE}, ≤10 — 종전 20px 에서 완화)`);
}

console.log(failed === 0 ? "\n✅ p133 전체 PASS" : `\n❌ p133 ${failed}건 FAIL`);
process.exit(failed === 0 ? 0 : 1);
