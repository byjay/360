/**
 * p183 — WO 20261023-pinviewopt: 핀 "보기 옵션" 정리(실 Chrome, CDP, real-map-page.mjs 하니스
 * 재사용 — p177/p179 와 같은 패턴).
 *
 * [재현] 발주서 인용: 23c_PinSizePrefs.js:58 크기 슬라이더(20~48px)·:148 번호 표시(always/auto/hidden)는
 *   있었지만 "핀 모양"(물방울 vs 점) 선택 옵션이 없었다(7cafcbb 이후 점이 기본, 선택/호버/방금배치만
 *   물방울로 자동 결정 — 10_MapCtrl.js _applyPinDotSizes, style.css .pin-dot). 리더선도 데이터 SoT
 *   (pin.leader, 11_UI.js UI.Leader.wants)만 있고 "보기 전용" 토글이 없었다.
 *
 * 검증:
 *  (0)  설정 UI 런타임 주입: 핀 모양 3버튼·번호 3버튼·크기 슬라이더(min=8,max=48,step=1)+프리셋 3+초기화
 *       ·리더선 표시 2버튼.
 *  (1)  핀 모양 강제 — auto(기본, 비선택)는 점 / pin(강제)은 호버·선택 없이도 항상 물방울 /
 *       dot(강제)는 force-pin(선택 강조) 클래스가 있어도 항상 점.
 *  (2)  모양×번호 4조합(핀+번호, 핀만, 점+번호, 점만) — 모양과 번호가 서로 독립적으로 동작.
 *  (3)  크기 — 프리셋([작게]=8px/[보통]=30px/[크게]=48px)이 슬라이더 값과 실제 지름에 반영,
 *       [초기화]가 기본값(30px)로 되돌림.
 *  (4)  리더선 "보기" 토글 — 켬(기본)이면 pin.leader=true 인 핀이 풍선(.pin-leader-bubble)으로,
 *       끔이면 같은 핀이 보통 마커로 그려지되 데이터(State.pins 의 pin.leader)는 불변.
 *
 * 실행: CHROME_PATH=... TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p183-pin-view-options-cdp.mjs
 * 뮤테이션(반드시 EXIT=1):
 *   P183_MUT=noshape    → 10_MapCtrl.js 의 shape-pin/shape-dot 클래스 토글 제거 → (1) 깨짐
 *   P183_MUT=noleaderoff→ 11_UI.js 가 PinLeaderViewPrefs "끔"을 무시(구 조건으로 되돌림) → (4) 깨짐
 *   P183_MUT=minfixed   → 23c_PinSizePrefs.js MIN 을 0.5(20px)로 되돌림 → (0)/(3) 깨짐
 */
import { openRealMap, DEFAULT_MODULES } from "./_lib/real-map-page.mjs";

let failed = 0;
const ok = (cond, label, d) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (d !== undefined ? " :: " + JSON.stringify(d) : "")); if (!cond) failed++; return cond; };

const MUT = process.env.P183_MUT || "";

const MUTS = {
  noshape: {
    file: "10_MapCtrl.js",
    needle: '      if (layer.classList) {\n        const shapeMode = (typeof PinShapePrefs !== "undefined" && PinShapePrefs.get) ? PinShapePrefs.get() : "auto";\n        layer.classList.toggle("shape-pin", shapeMode === "pin");\n        layer.classList.toggle("shape-dot", shapeMode === "dot");\n      }\n',
    to: "",
  },
  noleaderoff: {
    file: "11_UI.js",
    needle: 'if (this.Leader.wants(pin) && (typeof PinLeaderViewPrefs === "undefined" || PinLeaderViewPrefs.get() !== "off") && leaderLayer',
    to: "if (this.Leader.wants(pin) && leaderLayer",
  },
  minfixed: {
    file: "23c_PinSizePrefs.js",
    needle: "MIN: 0.2,        // 기준px 8(=8/40)",
    to: "MIN: 0.5,        // 기준px 20(=20/40)",
  },
};
if (MUT && !MUTS[MUT]) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }

const mutate = (name, src) => {
  if (!MUT || MUTS[MUT].file !== name) return src;
  const { needle, to } = MUTS[MUT];
  if (!src.includes(needle)) { console.log("FAIL 뮤테이션 대상 없음(" + MUT + ")"); process.exit(2); }
  return src.replace(needle, to);
};

// [p179 와 동일] settingsDisplayPrefsHost()가 찾는 #settings-loggedin 뼈대 + 리더선 디자이너 행
// (index.html 2436~2469 축소 재현 — 실 라벨 구조 label.settings-leader-toggle-row[for=chk-leader360]).
const PROBE183 = String.raw`(function(){
  var P = window.__P183 = {};
  P.injectSettingsAnchor = function(){
    if (document.getElementById('settings-loggedin')) return;
    var inner = document.createElement('div');
    inner.id = 'settings-loggedin';
    var actions = document.createElement('div');
    actions.id = 'settings-designer-actions';
    actions.innerHTML = '<label class="settings-leader-toggle-row" for="chk-leader360" style="margin-top:10px;">' +
      '<input id="chk-leader360" type="checkbox" /><span>선택한 포인트를 리더선으로 표시</span></label>';
    inner.appendChild(actions);
    document.body.appendChild(inner);
  };
  P.markerState = function(id){
    var m = document.querySelector('#pins-layer > .pin-marker[data-id="' + id + '"]');
    if (!m) return null;
    var dot = m.querySelector('.pin-dot'), pin = m.querySelector('.pin-pin');
    return {
      dotVisible: !!dot && getComputedStyle(dot).display !== 'none',
      pinVisible: !!pin && getComputedStyle(pin).display !== 'none',
      showNum: m.classList.contains('dot-show-num'),
      numOff: document.getElementById('pins-layer').classList.contains('pin-num-off'),
      markerDisplay: getComputedStyle(m).display,
      dotWidth: dot ? dot.getBoundingClientRect().width : null
    };
  };
  P.bubbleExists = function(id){ return !!document.querySelector('.pin-leader-bubble[data-id="' + id + '"]'); };
})();`;

const page = await openRealMap({
  width: 1280, height: 800, canvas: { w: 2000, h: 1500 }, mutate,
  modules: [...DEFAULT_MODULES, "24_Settings.js"],
});
const ev = page.ev;
try {
  await ev(PROBE183);
  await ev("__P183.injectSettingsAnchor()");

  // ── (0) 설정 UI 런타임 주입 ──
  await ev("PinShapePrefs.initToggle(); PinLabelPrefs.initToggle(); PinSizePrefs.initSlider(); PinLeaderViewPrefs.initToggle();");
  const shapeBtns = await ev('document.querySelectorAll("[data-pinshape-opt]").length');
  const labelBtns = await ev('document.querySelectorAll("[data-pinlabel-opt]").length');
  const leaderBtns = await ev('document.querySelectorAll("[data-leaderview-opt]").length');
  const sliderAttrs = await ev('(function(){ var s=document.getElementById("pinsize-slider"); return s ? { min:s.min, max:s.max, step:s.step } : null; })()');
  const presetBtns = await ev('document.querySelectorAll("[data-pinsize-preset]").length');
  const resetBtn = await ev('!!document.getElementById("pinsize-reset")');
  ok(shapeBtns === 3, `(0) 핀 모양 3버튼 주입(실측 ${shapeBtns})`);
  ok(labelBtns === 3, `(0) 번호 표시 3버튼 주입(실측 ${labelBtns})`);
  ok(leaderBtns === 2, `(0) 리더선 표시 2버튼 주입(실측 ${leaderBtns})`);
  ok(!!sliderAttrs && sliderAttrs.min === "8" && sliderAttrs.max === "48" && sliderAttrs.step === "1", "(0) 크기 슬라이더 min=8/max=48/step=1", sliderAttrs);
  ok(presetBtns === 3, `(0) 크기 프리셋 3버튼 주입(실측 ${presetBtns})`);
  ok(resetBtn === true, "(0) 크기 초기화 버튼 주입");

  // ── (1) 핀 모양 강제 ──
  const PINS1 = [{ id: "a", x: 50, y: 50, page: 1 }];
  await ev(`__M.pins(${JSON.stringify(PINS1)}, { noFocus: true })`);
  await ev('PinShapePrefs.set("auto")');
  await ev("MapCtrl.applyTransform()");
  let st = await ev('__P183.markerState("a")');
  ok(st.dotVisible === true && st.pinVisible === false, "(1) auto(기본, 비선택) → 점만 보임", st);

  await ev('PinShapePrefs.set("pin")');
  await ev("MapCtrl.applyTransform()");
  st = await ev('__P183.markerState("a")');
  ok(st.pinVisible === true && st.dotVisible === false, "(1) pin(강제) → 호버·선택 없이도 항상 물방울", st);

  await ev('PinShapePrefs.set("dot")');
  await ev(`(function(){ document.querySelector('#pins-layer > .pin-marker[data-id="a"]').classList.add("force-pin"); })()`);
  await ev("MapCtrl.applyTransform()");
  st = await ev('__P183.markerState("a")');
  ok(st.dotVisible === true && st.pinVisible === false, "(1) dot(강제) → force-pin(선택 강조) 있어도 항상 점", st);
  await ev(`(function(){ document.querySelector('#pins-layer > .pin-marker[data-id="a"]').classList.remove("force-pin"); })()`);

  // ── (2) 모양×번호 4조합 (초밀집 1개 핀 → auto 라벨 규칙과 무관하게 always/hidden 직접 확인) ──
  const combos = [
    ["pin", "always", { pinVisible: true, dotVisible: false, showNum: true }],
    ["pin", "hidden", { pinVisible: true, dotVisible: false, showNum: false }],
    ["dot", "always", { pinVisible: false, dotVisible: true, showNum: true }],
    ["dot", "hidden", { pinVisible: false, dotVisible: true, showNum: false }],
  ];
  for (const [shape, label, exp] of combos) {
    await ev(`PinShapePrefs.set("${shape}"); (function(){ document.querySelector('[data-pinlabel-opt="${label}"]').click(); })();`);
    await new Promise((r) => setTimeout(r, 200));
    const s = await ev('__P183.markerState("a")');
    ok(s.pinVisible === exp.pinVisible && s.dotVisible === exp.dotVisible && s.showNum === exp.showNum,
      `(2) 조합 모양=${shape} 번호=${label} → ${JSON.stringify(exp)}`, s);
  }
  await ev('(function(){ document.querySelector(\'[data-pinlabel-opt="auto"]\').click(); PinShapePrefs.set("auto"); })()');

  // ── (3) 크기 프리셋/초기화 ──
  const sparse2 = [{ id: "s0", x: 20, y: 20, page: 1 }, { id: "s1", x: 80, y: 80, page: 1 }];
  await ev(`__M.pins(${JSON.stringify(sparse2)}, { noFocus: true })`);
  const clickPreset = async (px) => { await ev(`(function(){ document.querySelector('[data-pinsize-preset="${px}"]').click(); })()`); await new Promise((r) => setTimeout(r, 250)); };
  await clickPreset(8);
  const smallSlider = await ev('document.getElementById("pinsize-slider").value');
  const smallDiam = (await ev('__P183.markerState("s0")')).dotWidth;
  ok(smallSlider === "8", `(3) [작게] 프리셋 → 슬라이더 8px(실측 ${smallSlider})`);

  await clickPreset(48);
  const largeSlider = await ev('document.getElementById("pinsize-slider").value');
  const largeDiam = (await ev('__P183.markerState("s0")')).dotWidth;
  ok(largeSlider === "48", `(3) [크게] 프리셋 → 슬라이더 48px(실측 ${largeSlider})`);
  ok(largeDiam > smallDiam, `(3) [크게] 점 지름 > [작게] 점 지름(실측 ${largeDiam} > ${smallDiam})`);

  await clickPreset(30);
  const medSlider = await ev('document.getElementById("pinsize-slider").value');
  ok(medSlider === "30", `(3) [보통] 프리셋 → 슬라이더 30px(실측 ${medSlider})`);

  await ev(`(function(){ document.getElementById('pinsize-slider').value = '8'; document.getElementById('pinsize-slider').dispatchEvent(new Event('input')); })()`);
  await new Promise((r) => setTimeout(r, 200));
  await ev(`(function(){ document.getElementById('pinsize-reset').click(); })()`);
  await new Promise((r) => setTimeout(r, 200));
  const afterReset = await ev('document.getElementById("pinsize-slider").value');
  ok(afterReset === "30", `(3) [초기화] → 슬라이더 기본값(30px)로 복귀(실측 ${afterReset})`);

  // ── (4) 리더선 "보기" 토글 ──
  const withLeader = [{ id: "L1", x: 30, y: 30, page: 1, leader: true }];
  await ev(`__M.pins(${JSON.stringify(withLeader)}, { noFocus: true })`);
  await ev('PinLeaderViewPrefs.set("on")');
  await ev("UI.renderPinsOnMap()");
  let onBubble = await ev('__P183.bubbleExists("L1")');
  let onMarker = await ev('__P183.markerState("L1")');
  let onData = await ev('State.pins.find(function(p){return p.id==="L1";}).leader');
  ok(onBubble === true && onMarker.markerDisplay === "none" && onData === true, "(4) 켬(기본) → 풍선으로 그림, 마커 숨김, 데이터 leader=true", { onBubble, onMarker, onData });

  await ev(`(function(){ document.querySelector('[data-leaderview-opt="off"]').click(); })()`);
  await new Promise((r) => setTimeout(r, 200));
  let offBubble = await ev('__P183.bubbleExists("L1")');
  let offMarker = await ev('__P183.markerState("L1")');
  let offData = await ev('State.pins.find(function(p){return p.id==="L1";}).leader');
  ok(offBubble === false && offMarker.markerDisplay !== "none" && offData === true, "(4) 끔 → 보통 마커로 그림(풍선 없음), 데이터 leader=true 불변(보기 전용)", { offBubble, offMarker, offData });

  await ev(`(function(){ document.querySelector('[data-leaderview-opt="on"]').click(); })()`);
  await new Promise((r) => setTimeout(r, 200));
  let backBubble = await ev('__P183.bubbleExists("L1")');
  ok(backBubble === true, "(4) 다시 켬 → 풍선 복귀(데이터 불변, 화면만 반응)");

  // ── §4a: 디자이너 전용 일괄 리더선 행 — 같은 '보기 설정' 호스트로 이동(구조만, 이벤트 보존) ──
  await ev("Settings._moveLeaderDesignerRowIntoDisplayPrefs()");
  const movedRow = await ev(`(function(){
    var host = document.getElementById('settings-display-prefs');
    var row = document.getElementById('settings-leader-designer-row');
    var chk = document.getElementById('chk-leader360');
    return { inHost: !!(host && row && host.contains(row)), chkInRow: !!(row && row.contains(chk)), chkCount: document.querySelectorAll('#chk-leader360').length };
  })()`);
  ok(movedRow.inHost === true && movedRow.chkInRow === true && movedRow.chkCount === 1, "(§4a) 리더선 일괄 토글 행이 '보기 설정' 호스트 안으로 이동(노드 1개, 중복 생성 없음)", movedRow);
} finally {
  await page.close();
}

console.log(MUT ? `\n[MUT=${MUT}] 의도적 되돌림 — 위 단언 중 일부는 반드시 FAIL 이어야 정상` : "");
console.log(failed ? `\n❌ p183 ${failed}건 FAIL` : "\n✅ p183 전체 PASS");
process.exit(failed ? 1 : 0);
