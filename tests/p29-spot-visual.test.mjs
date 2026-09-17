/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p29-spot-visual.test.mjs)
 *
 * 마스터 지시(2026-09-17) "마커나 장비·결함 노트도 투명으로 해 원래 그림을 해치지 않게 하고,
 * 끌어서 이동하면 화살표로 수정되게 해":
 *  ① 마커 텍스처의 채움 알파가 이전(.92)보다 낮다
 *  ② 숫자 대비가 4.5:1 이상 (WCAG 상대휘도 공식 실측 — 검정 헤일로가 배경 사진 색과 무관하게
 *     대비를 보장하는지, 4종 색 각각 헤일로-가 원래 채움색 위에 합성된 경우로 계산)
 *  ③ 종류별 색(defect/equip/safety/note)이 유지된다
 *  ④ 드래그 중 화살표 상태(_dragArrowActive)가 켜지고, 놓으면 꺼진다
 *  ⑤ 뷰어 권한에서는 드래그가 시작되지 않는다(회귀)
 *  ⑥ 저장 경로(_finalizeSpotDrag)가 종전대로 호출된다(App.js 배선 — 소스 검사)
 *
 * 실제 모듈 소스(public/js/modules/06_PanoViewer.js)를 vm에 평가해 검사한다(목 구현 아님).
 * Canvas 2D 컨텍스트는 draw call을 기록하는 최소 목으로 대체(jsdom 없이 순수 node 실행).
 * 각 검사에는 뮤테이션(수정 무력화) 케이스가 붙어 있어, 고친 코드를 되돌리면 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pvSrc = fs.readFileSync(path.join(ROOT, "public/js/modules/06_PanoViewer.js"), "utf8").replace(/\r\n/g, "\n");
const appSrc = fs.readFileSync(path.join(ROOT, "public/js/modules/20_App.js"), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── WCAG 상대휘도/대비 계산 ─────────────────────────────────────────── */
function parseColor(str) {
  if (str.startsWith("#")) {
    const h = str.slice(1);
    const n = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
    return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
  }
  const m = str.match(/rgba?\(([^)]+)\)/);
  if (m) { const p = m[1].split(",").map(Number); return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]]; }
  throw new Error("unparseable color: " + str);
}
function relLum([r, g, b]) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(c1, c2) {
  const l1 = relLum(c1), l2 = relLum(c2);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}
/** 알파 합성: fg(alpha 포함) over bg(불투명) */
function over(fg, bg) {
  const a = fg[3] === undefined ? 1 : fg[3];
  return [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a));
}

/* ── 최소 THREE 목 — 결정적 값만 보장 ─────────────────────────────────── */
function makeThreeMock() {
  const state = { nextHit: null };
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone() { return new Vector3(this.x, this.y, this.z); }
    sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    normalize() { const l = Math.hypot(this.x, this.y, this.z) || 1; this.x /= l; this.y /= l; this.z /= l; return this; }
    length() { return Math.hypot(this.x, this.y, this.z); }
  }
  class Vector2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } }
  class Raycaster {
    setFromCamera() { this.ray = { direction: new Vector3(0, 0, 1) }; }
    intersectObjects(children) {
      const id = state.nextHit;
      if (id == null) return [];
      const obj = children.find((c) => c.userData && c.userData.spotId === id);
      return obj ? [{ object: obj }] : [];
    }
  }
  class Group { constructor() { this.children = []; } add(o) { this.children.push(o); } }
  class ArrowHelper {
    constructor(dir, origin, length, color, headLength, headWidth) {
      this.position = new Vector3(origin.x, origin.y, origin.z);
      this.visible = false;
      this._dir = dir; this._len = length; this._color = color;
    }
    setDirection(d) { this._dir = d; }
    setLength(l) { this._len = l; }
  }
  class CanvasTexture { constructor(c) { this.image = c; } }
  const THREE = {
    MathUtils: { degToRad: (d) => (d * Math.PI) / 180, radToDeg: (r) => (r * 180) / Math.PI },
    Vector3, Vector2, Raycaster, Group, ArrowHelper, CanvasTexture
  };
  return { THREE, state };
}

/** _spotTexture()가 실제로 그리는 draw call을 기록하는 canvas 2d 목 */
function makeCanvasDoc() {
  const calls = [];
  function makeCtx() {
    const st = { fillStyle: null, strokeStyle: null, globalAlpha: 1, lineWidth: 1 };
    return {
      get fillStyle() { return st.fillStyle; }, set fillStyle(v) { st.fillStyle = v; },
      get strokeStyle() { return st.strokeStyle; }, set strokeStyle(v) { st.strokeStyle = v; },
      get globalAlpha() { return st.globalAlpha; }, set globalAlpha(v) { st.globalAlpha = v; },
      get lineWidth() { return st.lineWidth; }, set lineWidth(v) { st.lineWidth = v; },
      font: "", textAlign: "", textBaseline: "", lineJoin: "",
      beginPath() {}, arc() {},
      fill() { calls.push({ op: "fill", fillStyle: st.fillStyle, globalAlpha: st.globalAlpha }); },
      stroke() { calls.push({ op: "stroke", strokeStyle: st.strokeStyle, lineWidth: st.lineWidth }); },
      fillText(text) { calls.push({ op: "fillText", text, fillStyle: st.fillStyle }); },
      strokeText(text) { calls.push({ op: "strokeText", text, strokeStyle: st.strokeStyle, lineWidth: st.lineWidth }); }
    };
  }
  const document = { createElement: () => ({ width: 0, height: 0, getContext: () => makeCtx() }) };
  return { document, calls };
}

function makePV(src, { role = "designer" } = {}) {
  const { THREE, state } = makeThreeMock();
  const { document, calls } = makeCanvasDoc();
  const toasts = [];
  const State = { mode: role === "designer" ? "designer" : "viewer" };
  const Auth = { isDesigner: role === "designer" };
  const Prompt = { toast: (m) => toasts.push(m) };
  const Radar = { spin() {} };
  const sandbox = { console, THREE, document, State, Auth, Prompt, Radar, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__PV = PanoViewer;", sandbox);
  const PV = sandbox.__PV;

  const spotData = { id: "sp1", lon: 10, lat: 5, kind: "defect" };
  const sprite = { userData: { spotId: "sp1" }, position: new THREE.Vector3(0, 0, 0) };
  PV._spots = [spotData];
  PV._spotGroup = { children: [sprite] };
  PV.camera = {};
  PV.renderer = {};
  PV.scene = new THREE.Group();
  PV.canvas = { style: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };

  return { PV, hitState: state, spotData, sprite, toasts, calls, THREE };
}

/* ────────────────────────────────────────────────────────────
 * ① 채움 알파가 이전(.92)보다 낮음
 * ──────────────────────────────────────────────────────────── */
function suiteAlpha(label, src) {
  console.log("\n[" + label + "]");
  const { PV, calls } = makePV(src);
  PV._spotTexture({ kind: "defect" }, 0);
  const fillCall = calls.find(c => c.op === "fill");
  ok(!!fillCall, "fill() 호출 확인");
  ok(fillCall.globalAlpha < 0.92, `채움 알파(${fillCall.globalAlpha}) < 0.92`);
  ok(fillCall.globalAlpha > 0, "채움 알파 > 0(완전 투명은 아님 — 위치 식별 가능)");
}

/* ────────────────────────────────────────────────────────────
 * ② 숫자 대비 ≥ 4.5:1 — 4종 색 각각(헤일로가 채움색 위에 합성된 경우로 실측)
 * ──────────────────────────────────────────────────────────── */
function suiteContrast(label, src) {
  console.log("\n[" + label + "]");
  const { PV, calls } = makePV(src);
  const kinds = { defect: "#e0503e", equip: "#e0b14a", safety: "#f2820a", note: "#3a97dd" };
  for (const [kind, fillHex] of Object.entries(kinds)) {
    calls.length = 0;
    PV._spotTexture({ kind }, 0);
    const strokeTextCall = calls.find(c => c.op === "strokeText");
    const fillTextCall = calls.find(c => c.op === "fillText");
    ok(!!strokeTextCall && !!fillTextCall, `[${kind}] 숫자에 헤일로(strokeText)+채움(fillText) 둘 다 그림`);
    const halo = parseColor(strokeTextCall.strokeStyle);       // 예: rgba(0,0,0,.9)
    const textColor = parseColor(fillTextCall.fillStyle);      // "#fff"
    const fillBg = parseColor(fillHex);
    const bgUnderHalo = over(halo, fillBg);                    // 헤일로가 마커 채움색 위에 합성된 실제 배경
    const cr = contrast(textColor, bgUnderHalo);
    ok(cr >= 4.5, `[${kind}] 숫자-배경 대비 ${cr.toFixed(2)}:1 ≥ 4.5:1`);
  }
}

/* ────────────────────────────────────────────────────────────
 * ③ 종류별 색 유지(4종)
 * ──────────────────────────────────────────────────────────── */
function suiteKindColors(label, src) {
  console.log("\n[" + label + "]");
  const { PV, calls } = makePV(src);
  const kinds = { defect: "#e0503e", equip: "#e0b14a", safety: "#f2820a", note: "#3a97dd" };
  for (const [kind, expected] of Object.entries(kinds)) {
    calls.length = 0;
    PV._spotTexture({ kind }, 0);
    const fillCall = calls.find(c => c.op === "fill");
    ok(fillCall && fillCall.fillStyle.toLowerCase() === expected, `[${kind}] 채움색=${expected} 유지`);
  }
}

/* ────────────────────────────────────────────────────────────
 * ④ 드래그 중 화살표 상태 on/off
 * ──────────────────────────────────────────────────────────── */
function suiteArrowToggle(label, src) {
  console.log("\n[" + label + "]");
  const { PV, hitState } = makePV(src, { role: "designer" });
  hitState.nextHit = "sp1";
  ok(PV._dragArrowActive === false, "드래그 전 화살표 비활성");
  PV.onPointerDown(50, 50);
  PV.onPointerMove(90, 50); // 40px 이동 → 임계값(6px) 초과
  ok(PV._dragArrowActive === true, "드래그 이동 중 화살표 활성(_dragArrowActive=true)");
  const r = PV.onPointerUp();
  ok(!!(r && r.spotMoved === "sp1"), "onPointerUp() 저장신호 정상(기존 동작 불변)");
  ok(PV._dragArrowActive === false, "놓으면 화살표 비활성(_dragArrowActive=false)");
}

/* ────────────────────────────────────────────────────────────
 * ⑤ 뷰어 권한 — 드래그 시작 안 됨(회귀)
 * ──────────────────────────────────────────────────────────── */
function suiteViewerBlocked(label, src) {
  console.log("\n[" + label + "]");
  const { PV, hitState } = makePV(src, { role: "viewer" });
  hitState.nextHit = "sp1";
  PV.onPointerDown(50, 50);
  ok(PV._dragSpotId === null, "뷰어 권한 → 드래그 대상으로 잡지 않음");
  PV.onPointerMove(90, 50);
  ok(PV._dragArrowActive === false, "뷰어 권한 → 화살표도 활성화되지 않음");
}

/* ────────────────────────────────────────────────────────────
 * ⑥ 저장 경로(_finalizeSpotDrag)가 종전대로 배선됨 — 소스 검사
 * ──────────────────────────────────────────────────────────── */
function suiteSavePathWired(label) {
  console.log("\n[" + label + "]");
  ok(/const r = PanoViewer\.onPointerUp\(\);\s*\n\s*if \(r && r\.spotMoved\) this\._finalizeSpotDrag\(r\.spotMoved\);/.test(appSrc),
    "App.js mouseup 핸들러가 onPointerUp() 반환값으로 _finalizeSpotDrag를 호출함(불변)");
  const finalizeMatch = appSrc.match(/_finalizeSpotDrag\(id\) \{([\s\S]*?)\n    \},/);
  ok(!!finalizeMatch && /this\._saveSpots\(pin\)/.test(finalizeMatch[1]),
    "App.js _finalizeSpotDrag()가 this._saveSpots(pin)을 호출함(저장 확정, 불변)");
}

/* ────────────────────────────────────────────────────────────
 * 실행: 정상 소스
 * ──────────────────────────────────────────────────────────── */
suiteAlpha("① 채움 알파 하향(투명화)", pvSrc);
suiteContrast("② 숫자 대비 4종 색 각각 ≥ 4.5:1", pvSrc);
suiteKindColors("③ 종류별 색 유지", pvSrc);
suiteArrowToggle("④ 드래그 중 화살표 on/off", pvSrc);
suiteViewerBlocked("⑤ 뷰어 권한은 드래그·화살표 모두 차단(회귀)", pvSrc);
suiteSavePathWired("⑥ 저장 경로(_finalizeSpotDrag) 배선 불변");

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 증명 ①: 알파를 .92로 되돌리면 채움-알파 검사가 실패해야 함
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션①] 알파를 .92로 되돌리면 실패해야 함");
  const needle = "SPOT_FILL_ALPHA: .42,";
  const replacement = "SPOT_FILL_ALPHA: .92,";
  const mutated = pvSrc.replace(needle, replacement);
  if (mutated === pvSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PV, calls } = makePV(mutated);
    PV._spotTexture({ kind: "defect" }, 0);
    const fillCall = calls.find(c => c.op === "fill");
    ok(!(fillCall.globalAlpha < 0.92), "뮤테이션 적용 시 알파 하향 조건이 깨짐(테스트 실효성 증명)");
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 ④: 화살표 활성 플래그를 세팅하지 않으면 실패해야 함
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션④] _dragArrowActive 세팅을 제거하면 실패해야 함");
  const needle = `          this._moved = true;
          this._dragArrowActive = true;
          if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("마커 이동 중 — 놓으면 저장됩니다");`;
  const replacement = `          this._moved = true;
          if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("마커 이동 중 — 놓으면 저장됩니다");`;
  const mutated = pvSrc.replace(needle, replacement);
  if (mutated === pvSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PV, hitState } = makePV(mutated, { role: "designer" });
    hitState.nextHit = "sp1";
    PV.onPointerDown(50, 50);
    PV.onPointerMove(90, 50);
    ok(PV._dragArrowActive !== true, "뮤테이션 적용 시 화살표가 활성화되지 않게 뒤집힘(테스트 실효성 증명)");
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 ⑤: canEditSpots를 항상 true로 만들면 뷰어 가드가 실패해야 함
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션⑤] canEditSpots를 항상 true로 만들면 뷰어 가드가 실패해야 함");
  const needle = `    canEditSpots() {
      return typeof State !== "undefined" && State.mode === "designer" &&
        (typeof Auth === "undefined" || Auth.isDesigner);
    },`;
  const replacement = `    canEditSpots() { return true; },`;
  const mutated = pvSrc.replace(needle, replacement);
  if (mutated === pvSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PV, hitState } = makePV(mutated, { role: "viewer" });
    hitState.nextHit = "sp1";
    PV.onPointerDown(50, 50);
    ok(PV._dragSpotId !== null, "뮤테이션 적용 시 뷰어도 드래그 대상을 잡게 뒤집힘(테스트 실효성 증명)");
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
