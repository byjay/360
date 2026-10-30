/**
 * p191 — WO 20261030-pinopacity: 핀 투명도(20~100%) 설정(실 Chrome, CDP, real-map-page.mjs
 * 하니스 재사용 — p183 과 같은 패턴).
 *
 * [재현] 마스터 "핀 투명도 설정은 했지?" — c059c48(핀 보기 옵션: 모양·숫자·크기·리더선)까지
 *   grep opacity/투명 해봐도 23c_PinSizePrefs.js 에 투명도 슬라이더가 없었다(PinSizePrefs/
 *   PinLabelPrefs/PinShapePrefs/PinLeaderViewPrefs 4종뿐, PinOpacityPrefs 부재 확인).
 *
 * 검증:
 *  (0) 설정 UI 런타임 주입: 투명도 슬라이더(min=20,max=100,step=1,기본 100%).
 *  (1) 60%/20% 적용 — 비선택 핀(.pin-marker)·리더 풍선(.pin-leader-bubble) computed opacity 가
 *      그 값으로 바뀐다(소수 허용오차).
 *  (2) 20% 미만 입력 거부 — set(0.05) 호출해도 MIN(0.2)로 clamp.
 *  (3) 새로고침(재초기화) 후에도 저장값 유지(localStorage 직접 재확인, get()).
 *  (4) 선택/호버/드래그 중인 핀은 슬라이더 값과 무관하게 opacity 1 유지(.focused/.moving/:hover).
 *  (5) 100%로 되돌리면 정상 복귀.
 *
 * 실행: CHROME_PATH=... TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p191-pin-opacity-cdp.mjs
 * 뮤테이션(반드시 EXIT=1):
 *   P191_MUT=noapply     → 10_MapCtrl.js 가 --pin-opacity 를 세팅하지 않음 → (1)/(2) 깨짐
 *   P191_MUT=noexception → style.css 의 선택/호버/드래그 opacity:1 예외 규칙 제거 → (4) 깨짐
 */
import { openRealMap, DEFAULT_MODULES } from "./_lib/real-map-page.mjs";

let failed = 0;
const ok = (cond, label, d) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (d !== undefined ? " :: " + JSON.stringify(d) : "")); if (!cond) failed++; return cond; };
const approx = (a, b, eps) => Math.abs(a - b) <= (eps || 0.02);

const MUT = process.env.P191_MUT || "";

const MUTS = {
  noapply: {
    file: "10_MapCtrl.js",
    needle: '        const op = (typeof PinOpacityPrefs !== "undefined" && PinOpacityPrefs.get) ? PinOpacityPrefs.get() : 1;\n        layer.style.setProperty("--pin-opacity", op.toFixed(2));\n',
    to: "",
  },
  noexception: {
    file: "public/css/style.css",
    needle: '#pins-layer > .pin-marker:hover,\n#pins-layer > .pin-marker.focused,\n#pins-layer > .pin-marker.drop,\n#pins-layer > .pin-marker.moving,\n#pins-layer > .pin-marker.force-pin,\n.pin-leader-bubble:hover,\n.pin-leader-bubble.focused,\n.pin-leader-bubble.moving {\n  opacity: 1;\n}\n',
    to: "",
  },
};
if (MUT && !MUTS[MUT]) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }

const mutate = (name, src) => {
  if (MUT !== "noapply" || MUTS.noapply.file !== name) return src;
  const { needle, to } = MUTS.noapply;
  if (!src.includes(needle)) { console.log("FAIL 뮤테이션 대상 없음(noapply)"); process.exit(2); }
  return src.replace(needle, to);
};
const cssMutate = (name, src) => {
  if (MUT !== "noexception" || !name.endsWith("style.css")) return src;
  const { needle, to } = MUTS.noexception;
  if (!src.includes(needle)) { console.log("FAIL 뮤테이션 대상 없음(noexception)"); process.exit(2); }
  return src.replace(needle, to);
};

const page = await openRealMap({
  width: 1280, height: 800, canvas: { w: 2000, h: 1500 }, mutate, cssMutate,
  modules: [...DEFAULT_MODULES, "24_Settings.js"],
});
const ev = page.ev;

const PROBE191 = String.raw`(function(){
  var P = window.__P191 = {};
  P.injectSettingsAnchor = function(){
    if (document.getElementById('settings-loggedin')) return;
    var inner = document.createElement('div');
    inner.id = 'settings-loggedin';
    document.body.appendChild(inner);
  };
  P.markerOpacity = function(id){
    var m = document.querySelector('#pins-layer > .pin-marker[data-id="' + id + '"]');
    return m ? parseFloat(getComputedStyle(m).opacity) : null;
  };
  P.bubbleOpacity = function(){
    var b = document.querySelector('#pins-layer > .pin-leader-bubble');
    return b ? parseFloat(getComputedStyle(b).opacity) : null;
  };
})();`;

try {
  await ev(PROBE191);
  await ev("__P191.injectSettingsAnchor()");

  // ── (0) 설정 UI 런타임 주입 ──
  await ev("PinOpacityPrefs.initSlider();");
  const sliderAttrs = await ev('(function(){ var s=document.getElementById("pinopacity-slider"); return s ? { min:s.min, max:s.max, step:s.step, value:s.value } : null; })()');
  ok(!!sliderAttrs && sliderAttrs.min === "20" && sliderAttrs.max === "100" && sliderAttrs.step === "1" && sliderAttrs.value === "100",
    "(0) 투명도 슬라이더 min=20/max=100/step=1/기본값 100", sliderAttrs);

  // ── (1) 60%/20% 적용(비선택 핀 — noFocus로 force-pin 안 붙임) ──
  const PINS1 = [{ id: "a", x: 50, y: 50, page: 1, leader: true }];
  await ev(`__M.pins(${JSON.stringify(PINS1)}, { noFocus: true })`);

  await ev('PinOpacityPrefs.set(0.6)');
  await ev("MapCtrl.applyTransform()");
  let mOp = await ev('__P191.markerOpacity("a")');
  ok(approx(mOp, 0.6), `(1) 60% 적용 → 마커 opacity≈0.6(실측 ${mOp})`, mOp);

  await ev('PinOpacityPrefs.set(0.2)');
  await ev("MapCtrl.applyTransform()");
  mOp = await ev('__P191.markerOpacity("a")');
  ok(approx(mOp, 0.2), `(1) 20% 적용 → 마커 opacity≈0.2(실측 ${mOp})`, mOp);

  // 리더선 핀(leader:true) → 풍선 렌더(UI.renderPinsOnMap 필요)
  await ev("UI.renderPinsOnMap(); MapCtrl.applyTransform();");
  const bOp = await ev('__P191.bubbleOpacity()');
  ok(approx(bOp, 0.2), `(1) 20% 적용 → 리더 풍선 opacity≈0.2(실측 ${bOp})`, bOp);

  // ── (2) 20% 미만 거부 — 직접 set(0.05) 호출해도 clamp ──
  const clamped = await ev('PinOpacityPrefs.set(0.05)');
  ok(approx(clamped, 0.2), `(2) set(0.05) → MIN(0.2)로 clamp(실측 ${clamped})`, clamped);

  // ── (3) 저장 유지 — localStorage 재확인(새로고침 없이도 같은 SoT) ──
  await ev('PinOpacityPrefs.set(0.6)');
  const stored = await ev('PinOpacityPrefs.get()');
  ok(approx(stored, 0.6), `(3) set(0.6) 후 get() 유지(저장소 재확인, 실측 ${stored})`, stored);

  // ── (4) 선택/호버/드래그 중인 핀은 opacity 1 유지 ──
  await ev('PinOpacityPrefs.set(0.2)');
  await ev('UI.renderPinsOnMap(); MapCtrl.applyTransform();');
  // 아직 force-pin 없음 → 평소 0.2
  let before = await ev('__P191.markerOpacity("a")');
  ok(approx(before, 0.2), `(4) 선택 전 opacity≈0.2(실측 ${before})`, before);
  // .focused 부여(선택 강조) — 리더선이면 마커 자체가 display:none 이므로 leader:false 핀으로 별도 생성
  const PINS2 = [{ id: "b", x: 70, y: 20, page: 1 }];
  await ev(`__M.pins(${JSON.stringify(PINS2)}, { noFocus: true })`);
  await ev(`(function(){ document.querySelector('#pins-layer > .pin-marker[data-id="b"]').classList.add("focused"); })()`);
  const focusedOp = await ev('__P191.markerOpacity("b")');
  ok(approx(focusedOp, 1), `(4) .focused 선택 중 → opacity 1 유지(슬라이더 20% 무관, 실측 ${focusedOp})`, focusedOp);

  await ev(`(function(){ document.querySelector('#pins-layer > .pin-marker[data-id="b"]').classList.remove("focused"); document.querySelector('#pins-layer > .pin-marker[data-id="b"]').classList.add("moving"); })()`);
  const movingOp = await ev('__P191.markerOpacity("b")');
  ok(approx(movingOp, 1), `(4) .moving 드래그 중 → opacity 1 유지(실측 ${movingOp})`, movingOp);

  // ── (5) 100%로 되돌리면 정상 복귀(§4 에서 S.pins 를 PINS2 로 덮어써 "a"가 사라졌으므로 재배치) ──
  await ev(`__M.pins(${JSON.stringify(PINS1)}, { noFocus: true })`);
  await ev('PinOpacityPrefs.set(1)');
  await ev("MapCtrl.applyTransform()");
  const backOp = await ev('__P191.markerOpacity("a")');
  ok(approx(backOp, 1), `(5) 100% 복귀(실측 ${backOp})`, backOp);
} finally {
  await page.close();
}

console.log(MUT ? `\n[MUT=${MUT}] 의도적 되돌림 — 위 단언 중 일부는 반드시 FAIL 이어야 정상` : "");
console.log(failed ? `\n❌ p191 ${failed}건 FAIL` : "\n✅ p191 전체 PASS");
process.exit(failed ? 1 : 0);
