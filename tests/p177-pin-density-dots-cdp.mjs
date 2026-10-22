/**
 * p177 — WO 20261022-pindots: 핀 기본 마커를 "점"(밀도 기반 지름)으로 바꾼다(실 Chrome, CDP,
 * tests/_lib/real-map-page.mjs 하니스 재사용 — p159 와 같은 패턴, 목 0: 실제 모듈 + 실 CSS).
 *
 * [재현] 마스터 "도면에 비해서 핀 크기가 너무 커서 도면을 다 가린다" — 지휘자 실측(scan.seastar.work
 *   main.js?v=ac4c31536c): PIN_MIN_PX_TOUCH/MOUSE 20~24px 바닥 + 화면고정 px 방식이 핀 "밀도"(핀 간
 *   거리)를 전혀 보지 않아, 촘촘한 도면에서 핀 머리끼리 겹쳐 도면을 덮는다(공통 CLAUDE.md 발주서 인용).
 *
 * 검증:
 *  (i)   맞춤 상태에서 점끼리 겹침 0쌍 (밀집 600 + 희소 10 + 초밀집 2 — 뮤테이션(고정 28px)이 (ii) 10%
 *        상한도 넘기도록 밀집 수를 150→600 으로 늘렸다, 아래 (ii) 주석 참조)
 *  (ii)  점들이 덮는 면적 / 페이지 면적 ≤ 10% — 구 방식(모든 핀을 teardrop 머리 px 로 가정) 수치도
 *        함께 출력해 전/후 비교
 *  (iii) 희소 핀은 최대 28px(PIN_DOT_MAX_PX)까지
 *  (iv)  선택(.focused)한 핀은 teardrop 머리(.pin-pin) 표시
 *  (v)   초밀집(바닥 6px) 점도 탭(elementFromPoint)으로 선택됨
 *  (vi)  점 배경색 vs 흰 도면 대비 ≥ 3:1(UI 요소)
 *
 * 실행: CHROME_PATH=... TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p177-pin-density-dots-cdp.mjs
 *       P177_SHOT=1 → .tmp/p177/before.png(구 teardrop 가정 그대로 두면 안 쓰임) · after.png(점 모드) 저장
 * 뮤테이션(반드시 EXIT=1): P177_MUT=fixed28 → 밀도 계산(_computePinDotPx)을 "항상 28px"로 되돌림
 *   → (i) 겹침, (ii) 면적%가 모두 깨져야 한다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openRealMap } from "./_lib/real-map-page.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; return cond; };

const MUT = process.env.P177_MUT || "";

// ── 핀 배치(% 단위, 페이지 기준) — canvas 2000×1500 CSS px, zoom=1 이면 1% = 20px 화면 ──
const dense = []; // 30×20 = 600개, 1% 간격(≈20px 화면) — 개수는 (ii) 뮤테이션 민감도를 위해 늘림(위 주석)
for (let iy = 0; iy < 20; iy++) for (let ix = 0; ix < 30; ix++) dense.push({ id: "d" + iy + "_" + ix, x: 10 + ix, y: 10 + iy, page: 1 });
const sparse = []; // 10개, 5% 간격(≈100px) + 밀집 군집과 멀리 떨어짐
for (let i = 0; i < 10; i++) sparse.push({ id: "s" + i, x: 50 + i * 4, y: 80, page: 1 });
const tiny = [ // 초밀집 2개(간격 ≈8px, 0.8×8=6.4px — 바닥(6px) 근접이지만 클램프로 "올려지지"는
  // 않게(§WO 20261022-pindots 겹침 방지 증명은 클램프가 작동한 쌍끼리는 보장하지 않음 — 0.4px
  // 간격으로 뒀다가 t0·t1 자기들끼리 겹치는 걸 실측해 수정, 이제 0.8×d=6.4 ≥ 반지름합 과 떨어짐).
  { id: "t0", x: 5.0, y: 50, page: 1 },
  { id: "t1", x: 5.4, y: 50, page: 1 },
];
const PINS = [...dense, ...sparse, ...tiny];

const PROBE177 = String.raw`(function(){
  var P = window.__P177 = {};
  P.dots = function(){
    return Array.from(document.querySelectorAll('#pins-layer > .pin-marker')).map(function(m){
      var d = m.querySelector('.pin-dot');
      var r = d.getBoundingClientRect();
      return { id: m.dataset.id, cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height, showNum: m.classList.contains('dot-show-num') };
    });
  };
  P.visible = function(id, sel){
    var m = document.querySelector('#pins-layer > .pin-marker[data-id="' + id + '"]');
    if (!m) return null;
    var el = m.querySelector(sel);
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  P.tapAt = function(x, y){
    var el = document.elementFromPoint(x, y);
    var m = el && el.closest ? el.closest('.pin-marker') : null;
    return m ? m.dataset.id : null;
  };
  P.dotColor = function(id){
    var m = document.querySelector('#pins-layer > .pin-marker[data-id="' + id + '"]');
    var d = m && m.querySelector('.pin-dot');
    return d ? getComputedStyle(d).backgroundColor : null;
  };
  P.pageRect = function(){ var t = document.getElementById('map-transform'); var r = t.getBoundingClientRect(); return { w: r.width, h: r.height }; };
})();`;

/** sRGB 상대휘도(WCAG) → 대비비(흰 #fff 기준). */
const relLum = (r, g, b) => {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrastVsWhite = (rgbStr) => {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(rgbStr || "");
  if (!m) return null;
  const L = relLum(+m[1], +m[2], +m[3]);
  return (1.05) / (L + 0.05); // (Lwhite(1)+0.05)/(L+0.05)
};

const mutate = (name, src) => {
  if (!MUT || name !== "10_MapCtrl.js") return src;
  if (MUT === "fixed28") {
    // 밀도(최근접 이웃 거리) 기반 클램프를 버리고 "항상 상한(28px)" 고정값으로 되돌린다 —
    // 겹침 방지 증명(10_MapCtrl.js pinScreenScale 위 주석)이 성립하지 않게 만드는 최소 변경.
    const needle = "const diam = (best === Infinity)\n          ? this.PIN_DOT_MAX_PX\n          : Math.min(this.PIN_DOT_MAX_PX, Math.max(this.PIN_DOT_MIN_PX, best * this.PIN_DOT_RATIO));";
    if (!src.includes(needle)) { console.log("FAIL 뮤테이션 대상 없음(fixed28)"); process.exit(2); }
    return src.replace(needle, "const diam = this.PIN_DOT_MAX_PX;");
  }
  console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2);
};

const page = await openRealMap({ width: 1280, height: 800, canvas: { w: 2000, h: 1500 }, mutate });
const ev = page.ev;
try {
  await ev(`__M.pins(${JSON.stringify(PINS)}, { noFocus: true })`);
  await ev(`__M.zoom(1)`);
  await ev(PROBE177);
  await new Promise((r) => setTimeout(r, 400)); // _applyPinDotSizes 는 rAF 로 1프레임 묶임 — 반영 대기

  const dots = await ev("__P177.dots()");
  const page_ = await ev("__P177.pageRect()");
  ok(dots.length === PINS.length, `핀 ${PINS.length}개 전부 점(.pin-dot) 렌더(실측 ${dots.length})`);

  // (i) 겹침 쌍 — 두 점의 중심거리 < (반지름 합) - 허용오차(0.5px, 서브픽셀 라운딩)
  let overlaps = 0;
  for (let i = 0; i < dots.length; i++) for (let j = i + 1; j < dots.length; j++) {
    const a = dots[i], b = dots[j];
    const d = Math.hypot(a.cx - b.cx, a.cy - b.cy);
    const sumR = (a.w + b.w) / 2;
    if (d < sumR - 0.5) overlaps++;
  }
  ok(overlaps === 0, `(i) 점끼리 겹침 0쌍 (실측 ${overlaps}쌍)`);

  // (ii) 면적% — 새 방식 vs 구 방식(모든 핀을 "맞춤 teardrop px" 지름으로 가정) 비교 출력
  const areaAfter = dots.reduce((s, d) => s + Math.PI * (d.w / 2) * (d.h / 2), 0);
  const pageArea = page_.w * page_.h;
  const pctAfter = (areaAfter / pageArea) * 100;
  const oldHeadPx = await ev("__T.MapCtrl.pinScreenPx()"); // 구 방식(테두롭 항상) 가정 지름
  const areaBefore = PINS.length * Math.PI * (oldHeadPx / 2) * (oldHeadPx / 2);
  const pctBefore = (areaBefore / pageArea) * 100;
  console.log(`  [비교] 구 방식(teardrop ${oldHeadPx.toFixed(1)}px 고정) 덮는 면적 ≈ ${pctBefore.toFixed(2)}% · 새 방식(밀도 점) ≈ ${pctAfter.toFixed(2)}%`);
  ok(pctAfter <= 10, `(ii) 새 방식 면적 ≤ 10% (실측 ${pctAfter.toFixed(2)}%)`);
  ok(pctAfter < pctBefore, `(ii) 새 방식이 구 방식보다 도면을 덜 가림 (${pctAfter.toFixed(2)}% < ${pctBefore.toFixed(2)}%)`);

  // (iii) 희소 핀(sparse) 지름 ≈ PIN_DOT_MAX_PX(28px)
  const maxPx = await ev("__T.MapCtrl.PIN_DOT_MAX_PX");
  const sparseDots = dots.filter((d) => sparse.some((p) => p.id === d.id));
  const sparseMin = Math.min(...sparseDots.map((d) => d.w));
  ok(sparseMin >= maxPx - 1, `(iii) 희소 핀 지름 ≈ 상한 ${maxPx}px (최소 실측 ${sparseMin.toFixed(2)}px)`);

  // (iv) 선택(.focused)한 핀은 teardrop 표시 — 점은 숨김
  const pickId = dense[0].id;
  await ev(`(function(){ var m = document.querySelector('#pins-layer > .pin-marker[data-id="${pickId}"]'); m.classList.add('focused'); return 1; })()`);
  await new Promise((r) => setTimeout(r, 120));
  const teardropShown = await ev(`__P177.visible(${JSON.stringify(pickId)}, '.pin-pin')`);
  const dotHiddenNow = await ev(`__P177.visible(${JSON.stringify(pickId)}, '.pin-dot')`);
  ok(teardropShown === true, `(iv) 선택한 핀 = teardrop(.pin-pin) 표시`);
  ok(dotHiddenNow === false, `(iv) 선택한 핀 = 점(.pin-dot) 숨김(두 표현 동시 노출 금지)`);
  await ev(`(function(){ var m = document.querySelector('#pins-layer > .pin-marker[data-id="${pickId}"]'); m.classList.remove('focused'); return 1; })()`);

  // (v) 초밀집(바닥 6px) 점도 탭으로 선택됨
  const tinyDot = dots.find((d) => d.id === "t0");
  ok(tinyDot.w <= 9, `(v) 초밀집 핀 지름 = 바닥 근접(실측 ${tinyDot.w.toFixed(2)}px, 바닥 6px)`);
  const tapHit = await ev(`__P177.tapAt(${tinyDot.cx}, ${tinyDot.cy})`);
  ok(tapHit === "t0" || tapHit === "t1", `(v) 초밀집 점(지름 ${tinyDot.w.toFixed(1)}px) 중심 탭 = 핀 선택(실측 hit=${tapHit})`);

  // (vi) 점 배경색 vs 흰 도면 대비 ≥ 3:1
  const col = await ev(`__P177.dotColor(${JSON.stringify(dense[0].id)})`);
  const cr = contrastVsWhite(col);
  ok(cr != null && cr >= 3, `(vi) 점 배경(${col}) vs 흰 배경 대비 ≥ 3:1 (실측 ${cr == null ? "?" : cr.toFixed(2)}:1)`);

  if (process.env.P177_SHOT) {
    const dir = path.join(ROOT, ".tmp", "p177");
    fs.mkdirSync(dir, { recursive: true });
    const shot = async (file) => {
      const s = await page.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(dir, file), Buffer.from(s.data, "base64"));
    };
    await shot("after-dots.png");
    await ev(`(function(){ Array.from(document.querySelectorAll('#pins-layer > .pin-marker')).forEach(function(m){ m.classList.add('focused'); }); return 1; })()`);
    await new Promise((r) => setTimeout(r, 200));
    await shot("before-teardrop-forced.png"); // 비교용: 전부 teardrop(구 방식과 같은 가시 밀도)
  }
} finally {
  await page.close();
}

console.log(MUT ? `\n[MUT=${MUT}] 의도적 되돌림 — 위 단언 중 (i)·(ii) 는 반드시 FAIL 이어야 정상` : "");
console.log(failed ? `\n❌ p177 ${failed}건 FAIL` : "\n✅ p177 전체 PASS");
process.exit(failed ? 1 : 0);
