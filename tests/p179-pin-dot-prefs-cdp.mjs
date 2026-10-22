/**
 * p179 — WO 20261022-pinprefs: 점(dot) 마커에 기존 환경설정(PinSizePrefs 크기 슬라이더·PinLabelPrefs
 * 번호 옵션)을 연결 (실 Chrome, CDP, tests/_lib/real-map-page.mjs 하니스 재사용 — p177 과 같은 패턴).
 *
 * [재현] 지휘자 실측(이번 발주서 인용): 7cafcbb(pindots) 이후 기본 마커가 점으로 바뀌면서
 *   · PinSizePrefs(23c_PinSizePrefs.js) 크기 슬라이더는 teardrop 경로(pinScreenPx)에서만 쓰이고
 *     점 지름(PIN_DOT_MIN/MAX_PX 고정값)에는 적용되지 않음 — 설정이 점에 효과 없음.
 *   · PinLabelPrefs(always/hidden/auto)는 teardrop 번호(pin-num-off)만 토글하고, 점 안 번호
 *     (dot-show-num, 10_MapCtrl.js _applyPinDotSizesNow)는 지름 임계값(PIN_DOT_NUM_MIN_PX)만 보고
 *     라벨 옵션을 무시 — hidden 인데 점이 크면 번호가 보이고, always 인데 점이 작으면 안 보임.
 *
 * 검증:
 *  (i)   PinSizePrefs 슬라이더(기준px 20~48) 를 바꾸면 희소(sparse, 상한 적용) 점 지름이 비례 변화.
 *  (ii)  밀집(20px 간격) 구역은 슬라이더 MIN/기본/MAX 전부에서 겹침 0쌍 유지.
 *  (iii) PinLabelPrefs: hidden → 큰(희소) 점도 번호 숨김 / always → 초밀집(작은) 점도 번호 표시 +
 *        글자 ≥ 9px(가독) / auto → 기존 지름 임계값 규칙.
 *  (iv)  설정 UI(PinSizePrefs.initSlider/PinLabelPrefs.initToggle) 런타임 주입 — 슬라이더 조작 즉시
 *        반영(마커 재생성 없이), localStorage 에 저장되고 리로드 후에도 유지.
 *
 * 실행: CHROME_PATH=... TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p179-pin-dot-prefs-cdp.mjs
 * 뮤테이션(반드시 EXIT=1):
 *   P179_MUT=nofactor → _applyPinSizePrefs 가 설정 배율(factor)을 무시 → (i) 비례 변화가 깨짐
 *   P179_MUT=nolabel  → _applyPinDotSizesNow 의 번호표시 판정이 PinLabelPrefs 를 무시 →
 *                        (iii) hidden/always 가 모두 auto 규칙으로 돌아가 깨짐
 */
import { openRealMap } from "./_lib/real-map-page.mjs";

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; return cond; };

const MUT = process.env.P179_MUT || "";

// 같은 밀집/희소/초밀집 배치(p177 과 동일 비율, 핀 수는 속도를 위해 축소 — 기존 테스트가 겹침 증명을
// 이미 600개로 했으므로 여기선 "비례 변화"·"라벨" 검증에 집중).
const dense = []; // 10×10 = 100개, 1% 간격(≈20px 화면)
for (let iy = 0; iy < 10; iy++) for (let ix = 0; ix < 10; ix++) dense.push({ id: "d" + iy + "_" + ix, x: 10 + ix, y: 10 + iy, page: 1 });
const sparse = [{ id: "s0", x: 60, y: 80, page: 1 }, { id: "s1", x: 70, y: 80, page: 1 }]; // 멀리 떨어짐 → 상한(MAX) 적용
const tiny = [ // 초밀집(p177 과 동일 간격) — 바닥(MIN) 근접
  { id: "t0", x: 5.0, y: 50, page: 1 },
  { id: "t1", x: 5.4, y: 50, page: 1 },
];
const PINS = [...dense, ...sparse, ...tiny];

const PROBE179 = String.raw`(function(){
  var P = window.__P179 = {};
  P.dot = function(id){
    var m = document.querySelector('#pins-layer > .pin-marker[data-id="' + id + '"]');
    var d = m && m.querySelector('.pin-dot');
    if (!d) return null;
    var r = d.getBoundingClientRect();
    var num = m.querySelector('.pin-dot-num');
    return { w: r.width, showNum: m.classList.contains('dot-show-num'), numFontPx: num ? parseFloat(getComputedStyle(num).fontSize) : null };
  };
  P.overlaps = function(ids){
    var pts = ids.map(function(id){
      var m = document.querySelector('#pins-layer > .pin-marker[data-id="' + id + '"]');
      var r = m.querySelector('.pin-dot').getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width };
    });
    var n = 0;
    for (var i = 0; i < pts.length; i++) for (var j = i + 1; j < pts.length; j++) {
      var a = pts[i], b = pts[j];
      var d = Math.hypot(a.cx - b.cx, a.cy - b.cy);
      if (d < (a.w + b.w) / 2 - 0.5) n++;
    }
    return n;
  };
  // [WO 20261022-pinprefs 추가 §3] 실 index.html 의 #settings-modal 골격(#settings-loggedin >
  // #settings-designer-actions > #chk-leader360) 축소 재현 — settingsDisplayPrefsHost() 가 찾는
  // #settings-loggedin 이 이 harness 의 viewportBlock() 슬라이스엔 없어 직접 만든다.
  P.injectSettingsAnchor = function(){
    if (document.getElementById('settings-loggedin')) return;
    var inner = document.createElement('div');
    inner.id = 'settings-loggedin';
    var actions = document.createElement('div');
    actions.id = 'settings-designer-actions';
    actions.innerHTML = '<label class="settings-leader-toggle-row" for="chk-leader360"><input id="chk-leader360" type="checkbox" /></label>';
    inner.appendChild(actions);
    document.body.appendChild(inner);
  };
})();`;

const mutate = (name, src) => {
  if (!MUT || name !== "10_MapCtrl.js") return src;
  if (MUT === "nofactor") {
    const needle = "      this.PIN_DOT_MIN_PX = origMinPx * factor;\n      this.PIN_DOT_MAX_PX = origMaxPx * factor;";
    if (!src.includes(needle)) { console.log("FAIL 뮤테이션 대상 없음(nofactor)"); process.exit(2); }
    return src.replace(needle, "      this.PIN_DOT_MIN_PX = origMinPx;\n      this.PIN_DOT_MAX_PX = origMaxPx;");
  }
  if (MUT === "nolabel") {
    const needle = 'const showNum = labelMode === "hidden" ? false : labelMode === "always" ? true : (diam >= numMinPx);';
    if (!src.includes(needle)) { console.log("FAIL 뮤테이션 대상 없음(nolabel)"); process.exit(2); }
    return src.replace(needle, "const showNum = diam >= numMinPx;");
  }
  console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2);
};

const page = await openRealMap({ width: 1280, height: 800, canvas: { w: 2000, h: 1500 }, mutate });
const ev = page.ev;
try {
  await ev(`__M.pins(${JSON.stringify(PINS)}, { noFocus: true })`);
  await ev(`__M.zoom(1)`);
  await ev(PROBE179);
  await ev("__P179.injectSettingsAnchor()");
  await new Promise((r) => setTimeout(r, 300));

  // ── (iv) 설정 UI 런타임 주입 ──
  await ev("PinSizePrefs.initSlider()");
  await ev("PinLabelPrefs.initToggle()");
  const sliderExists = await ev('!!document.getElementById("pinsize-slider")');
  const toggleBtnCount = await ev('document.querySelectorAll("[data-pinlabel-opt]").length');
  ok(sliderExists === true, "(iv) 핀 크기 슬라이더(#pinsize-slider) 런타임 주입됨");
  ok(toggleBtnCount === 3, `(iv) 번호 표시 3단 버튼 주입됨(실측 ${toggleBtnCount}개)`);

  const DEFAULT_PX = 30, MIN_PX = 20, MAX_PX = 48; // PinSizePrefs._toPx(DEFAULT/MIN/MAX)
  const setSliderPx = async (px) => {
    await ev(`(function(){ var s = document.getElementById('pinsize-slider'); s.value = String(${px}); s.dispatchEvent(new Event('input')); })()`);
    await new Promise((r) => setTimeout(r, 250)); // _applyPinDotSizes 는 rAF 로 1프레임 묶임
  };

  // ── (i) 희소 핀 지름이 슬라이더(factor)에 비례 ──
  await setSliderPx(DEFAULT_PX);
  const sparseDefault = await ev('__P179.dot("s0")');
  await setSliderPx(MIN_PX);
  const sparseMin = await ev('__P179.dot("s0")');
  await setSliderPx(MAX_PX);
  const sparseMax = await ev('__P179.dot("s0")');
  console.log(`  [실측] 희소 점 지름: MIN(${MIN_PX}px 슬라이더)=${sparseMin.w.toFixed(2)} 기본(${DEFAULT_PX}px)=${sparseDefault.w.toFixed(2)} MAX(${MAX_PX}px)=${sparseMax.w.toFixed(2)}`);
  const expMinRatio = MIN_PX / DEFAULT_PX, expMaxRatio = MAX_PX / DEFAULT_PX;
  const tol = 0.15; // 격자 버킷 탐색 오차 허용
  ok(Math.abs(sparseMin.w / sparseDefault.w - expMinRatio) < tol, `(i) MIN 슬라이더 비율 ≈ ${expMinRatio.toFixed(3)} (실측 ${(sparseMin.w / sparseDefault.w).toFixed(3)})`);
  ok(Math.abs(sparseMax.w / sparseDefault.w - expMaxRatio) < tol, `(i) MAX 슬라이더 비율 ≈ ${expMaxRatio.toFixed(3)} (실측 ${(sparseMax.w / sparseDefault.w).toFixed(3)})`);
  ok(sparseMax.w > sparseDefault.w && sparseDefault.w > sparseMin.w, "(i) 슬라이더를 올리면 점이 커지고 내리면 작아짐(단조성)");

  // ── (ii) 밀집(20px 간격) 구역은 세 설정 전부에서 겹침 0쌍 ──
  const denseIds = dense.map((p) => p.id);
  await setSliderPx(MIN_PX);
  const ovMin = await ev(`__P179.overlaps(${JSON.stringify(denseIds)})`);
  await setSliderPx(DEFAULT_PX);
  const ovDefault = await ev(`__P179.overlaps(${JSON.stringify(denseIds)})`);
  await setSliderPx(MAX_PX);
  const ovMax = await ev(`__P179.overlaps(${JSON.stringify(denseIds)})`);
  ok(ovMin === 0, `(ii) MIN 슬라이더에서 밀집 구역 겹침 0쌍(실측 ${ovMin})`);
  ok(ovDefault === 0, `(ii) 기본 슬라이더에서 밀집 구역 겹침 0쌍(실측 ${ovDefault})`);
  ok(ovMax === 0, `(ii) MAX 슬라이더에서 밀집 구역(20px 간격) 겹침 0쌍(실측 ${ovMax})`);
  // 참고(발주 §1 명시 허용 범위): 초밀집(≈8px 간격) 쌍은 MAX 슬라이더에서 바닥(MIN×factor)이
  // 이웃거리를 넘어 겹칠 수 있다 — 보고용 측정(단언 아님, 발주서 "사용자가 더 크게 원하면... 보고").
  const ovTinyAtMax = await ev('__P179.overlaps(["t0","t1"])');
  console.log(`  [보고] 초밀집(≈8px 간격) 쌍 MAX 슬라이더 겹침: ${ovTinyAtMax === 1 ? "겹침(허용된 트레이드오프, 발주 §1)" : "겹침 없음"} (실측 overlaps=${ovTinyAtMax})`);
  await setSliderPx(DEFAULT_PX); // 이후 라벨 테스트는 기본 크기 기준

  // ── (iii) PinLabelPrefs 가 점 번호 표시를 지배 ──
  const clickOpt = (val) => ev(`(function(){ document.querySelector('[data-pinlabel-opt="${val}"]').click(); })()`);
  // auto(기본) — 큰(희소) 점은 번호 표시, 초밀집 점은 숨김(기존 규칙)
  await clickOpt("auto");
  await new Promise((r) => setTimeout(r, 200));
  const autoSparse = await ev('__P179.dot("s0")');
  const autoTiny = await ev('__P179.dot("t0")');
  ok(autoSparse.showNum === true, "(iii) auto: 희소(큰) 점은 번호 표시");
  ok(autoTiny.showNum === false, "(iii) auto: 초밀집(작은) 점은 번호 숨김(기존 규칙)");

  // hidden — 큰 점도 번호 숨김
  await clickOpt("hidden");
  await new Promise((r) => setTimeout(r, 200));
  const hiddenSparse = await ev('__P179.dot("s0")');
  ok(hiddenSparse.showNum === false, "(iii) hidden: 큰(희소) 점도 번호 숨김");

  // always — 초밀집 점도 번호 표시 + 글자 ≥ 9px
  await clickOpt("always");
  await new Promise((r) => setTimeout(r, 200));
  const alwaysTiny = await ev('__P179.dot("t0")');
  ok(alwaysTiny.showNum === true, "(iii) always: 초밀집(작은) 점도 번호 표시");
  ok(alwaysTiny.numFontPx != null && alwaysTiny.numFontPx >= 9, `(iii) always: 번호 글자 ≥ 9px(실측 ${alwaysTiny.numFontPx}px)`);

  // ── (iv) 즉시 반영 + localStorage 저장 + 리로드 후 유지 ──
  await setSliderPx(MAX_PX); // 저장값: 크기=MAX, 라벨=always(바로 위에서 클릭)
  const storedBeforeReload = await ev('({ size: PinSizePrefs.get(), label: PinLabelPrefs.get() })');
  const href = await ev("location.href");
  await page.send("Page.navigate", { url: href });
  let loaded = false;
  for (let i = 0; i < 60 && !loaded; i++) {
    try { loaded = (await ev('typeof window.__T')) === "object"; } catch (e) {}
    if (!loaded) await new Promise((r) => setTimeout(r, 150));
  }
  ok(loaded, "(iv) 리로드 후 모듈 재로드 확인");
  const storedAfterReload = await ev('({ size: PinSizePrefs.get(), label: PinLabelPrefs.get() })');
  ok(storedAfterReload.size === storedBeforeReload.size, `(iv) 리로드 후 크기 설정 유지(배율 ${storedAfterReload.size} === ${storedBeforeReload.size})`);
  ok(storedAfterReload.label === storedBeforeReload.label, `(iv) 리로드 후 번호 옵션 유지("${storedAfterReload.label}" === "${storedBeforeReload.label}")`);
} finally {
  await page.close();
}

console.log(MUT ? `\n[MUT=${MUT}] 의도적 되돌림 — 위 단언 중 일부는 반드시 FAIL 이어야 정상` : "");
console.log(failed ? `\n❌ p179 ${failed}건 FAIL` : "\n✅ p179 전체 PASS");
process.exit(failed ? 1 : 0);
