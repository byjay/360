/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p159-pin-scale.test.mjs)
 *
 * 대상: 마스터 지시(2026-10-16) "핀이 너무 커지는 거 아니니" — WO 20261016-pinscale2.
 * 선행 정책(WO 20261016-pinscale, "도면과 완전 비례 + 최소 크기 보장")이 상한을 없앤 결과
 * zoom=16 에서 화면 1280px(핀 하나가 도면을 가림)까지 커지는 문제를 고친다.
 *
 * [재현] 교체 전(커밋 5e4ce97, 지휘자 발주서 인용, 10_MapCtrl.js:382-399 구 코드):
 *   PIN_SCALE=2, PIN_NATIVE_PX=40, 상한 없음(Math.max(raw, floor)).
 *   화면px = 40×scale → zoom 1→80px, zoom 4→320px, zoom 16→1280px. 판정: 확대하면 핀이 도면을 가린다.
 *
 * 근본원인(1차): "완전 비례"는 하한만 두고 상한을 폐기해, 과도줌에서 핀이 무한히 커진다.
 * 채택(1차): 기준배율 2→0.75(zoom=1 화면 약 30px, 기존 80px 대비 축소) + 절대 px 상한(PIN_MAX_PX) +
 * 1~상한 구간은 여전히 비례. 선(동선·주석, lineScreenScale)도 같은 원칙(비율 상한).
 *
 * ── WO 20261019-pinscale3 (마스터 "핀이, 포인트가 너무 크기가 작아서 안 보여. 전체 비율을 봐,
 *    너무 작게 만들어 버렸어") ──
 * [재현] 실제 도면을 화면 맞춤으로 열면 zoom≈0.16(큰 PDF, 지휘자 라이브 실측) — 1차 정책의 기준인
 * "zoom=1"은 이 상태에서 전혀 쓰이지 않는다: raw=0.75×0.16×40≈4.8px 가 바닥(옛 14px)에 깔려 핀이
 * 거의 안 보였다. 근본원인(2차): 기준을 "zoom=1"(절대 배율)로 잡은 것 자체가 틀렸다 — 실제 화면에서
 * zoom 값은 도면 크기·창 크기에 따라 천차만별이라, "화면 맞춤 상태"를 기준으로 잡아야 한다.
 * 채택(2차): 분모를 "화면 맞춤 배율"(MapCtrl.computeFitZoom(), fit()·_fitBoundary() 와 동일 공식,
 * §G-2-5 단일 진입점)로 바꾼다 — effZoom = (zoom/fitZoom) × scaleRef. fitZoom 을 모르면(로드 전·
 * 테스트 환경처럼 content 크기가 없음) 1 로 폴백(= 1차 정책과 동일 수식, 아래 ①~⑤·⑥b·⑦·⑧이
 * 전부 이 폴백 경로를 타므로 숫자 그대로 보존됨 — PIN_SCALE=0.75 는 "맞춤 상태 기준 30px"로 재해석).
 * 바닥/상한 px 도 20/56(터치 24)로 올림(기존 14~48) — fitZoom 기준에서도 축소·과도줌 보호가
 * 충분하도록. 구역 "경계"(크롭 보기, _cropBoundary)는 fitZoom 자체가 computeCoverZoom 으로 그
 * 경계의 확대비를 이미 반영하므로 scaleRef 를 또 곱하면 이중보정(⑥, nofit 뮤테이션이 증명) —
 * 경계 없는 벡터복사 구역(scaleRef<1, crop=null)만 scaleRef 를 유지한다(⑥b, 변경 없음).
 *
 * ── WO 20261019-pinscale4 (마스터 "너무 줌 아웃 했을 때는 핀 머리가 너무 크게 보이지 않게끔")──
 * [재현] 99dbf1b(지휘자 발주서 인용): 맞춤 30px·2배 확대 56px·0.5배 축소에서 바닥(20/24px) 고정 —
 * 맞춤보다 더 축소해도 핀이 20~24px 에 멈춰, 도면은 작아지는데 핀 머리만 상대적으로 커져 보였다.
 * 채택(3차): 바닥을 PIN_MIN_PX_MOUSE/TOUCH 20/24→8/10px(점)로 낮춰 맞춤 아래 구간도 계속 비례
 * 축소되게 한다(§9 전·후). 탭 영역은 더는 이 바닥에 얹혀가지 않고 style.css .pin-marker::after
 * 역스케일(scale(calc(1/var(--pin-scale))))로 별도 보장 — 핀이 8px 로 작아져도 44px 그대로 눌린다.
 * 번호는 LABEL_HIDE_PX(16px) 밑이면(옵션 auto) 숨기고 머리(색 점)만 남긴다(11_UI.js·p133 §M 검증).
 *
 * ── WO 20261019-pinpx (지휘자: "두 보고가 충돌 — 실제 화면 px 로 판정") ──
 * [재현] ae36a91, tests/p172-pin-screen-px-cdp.mjs(실 번들 + 실 ga.pdf + 실 Chrome): #pins-layer 는
 *   #map-transform(scale(State.zoom)) 의 자손인데 pinScreenScale() 이 "화면 배율"을 그대로 --pin-scale 로
 *   넣어, 실제 화면 px = zoom × pinScreenScale() × 40 — 큰 PDF(fitZoom 0.125) 맞춤 3.76px(사양 30px).
 *   이 테스트의 옛 구조(vm 에서 pinScreenScale()×40 을 "화면px"라 부르며 검사)는 상위 scale 중첩을
 *   원리적으로 볼 수 없어 결함을 통과시켰다(99dbf1b 보고의 측정 스크립트도 #pins-layer 를 transform
 *   바깥에 둬 같은 맹점).
 * 채택: 모든 px 단언을 실 Chrome getBoundingClientRect(상위 transform 포함)로 바꾼다 —
 *   tests/_lib/real-map-page.mjs(CSS 3종 + public/index.html #map-viewport 원문 + 실제 모듈).
 *   전·후 대조: ①~⑨ 의 "pinScreenScale()×PIN_NATIVE_PX"(함수값) → 머리 svg 실측 높이,
 *   ⑦ lineScreenScale 비율 → 동선/주석 선 실측 화면 두께, ⑩(신규) 탭 패드 hit-test.
 * 뮤테이션 — 고친 부분을 되돌리면 반드시 EXIT=1 (대상 문자열 없으면 EXIT=2):
 *   P159_MUT=nocancel     → pinScreenScale 의 상위 scale(zoom) 상쇄 제거
 *   P159_MUT=nolinecancel → lineScreenScale 의 상위 scale(zoom) 상쇄 제거
 *   P159_MUT=noceil       → 핀 상한(Math.min(px, PIN_MAX_PX)) 제거
 *   P159_MUT=nofloor      → 핀 하한(Math.max(raw, minPx)) 제거
 *   P159_MUT=nolinecap    → 선 상한(LINE_MAX_RATIO) 제거
 *   P159_MUT=nocrop       → 구역 보정(scaleRef) 무시
 *   P159_MUT=nofit        → fitZoom 나누기 제거(zoom 직접 기준)
 *   P159_MUT=notapk       → 탭 패드 역스케일 인자를 종전 --pin-scale 값으로 되돌림
 *   P159_MUT=nominzoom    → [재현 R4] 줌 하한을 fitZoom 기반에서 고정 MIN_ZOOM(0.2)으로 되돌림
 *                           (맞춤 fitZoom < 0.2 인 큰 PDF에서 [축소]가 오히려 확대로 역행하는 회귀)
 */
import { openRealMap } from "./_lib/real-map-page.mjs";

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};
const near = (a, b, eps) => a != null && Math.abs(a - b) <= eps;

const MUT = process.env.P159_MUT || "";
const MUTS = {
  nocancel: ["10_MapCtrl.js", "return this.pinScreenPx() / this.PIN_NATIVE_PX / this.parentScale();", "return this.pinScreenPx() / this.PIN_NATIVE_PX;"],
  nolinecancel: ["10_MapCtrl.js", "return this.lineScreenRatio(minRatio) / this.parentScale() / this.svgUnitPx(svg);", "return this.lineScreenRatio(minRatio) / this.svgUnitPx(svg);"],
  noceil: ["10_MapCtrl.js", "return Math.min(px, this.PIN_MAX_PX);   // 상한", "return px;"],
  nofloor: ["10_MapCtrl.js", "const px = Math.max(raw, minPx);        // 하한(점)", "const px = raw;"],
  nolinecap: ["10_MapCtrl.js", "return Math.min(Math.max(effZoom, floor), this.LINE_MAX_RATIO);", "return Math.max(effZoom, floor);"],
  nocrop: ["10_MapCtrl.js", "const scaleRef = this._cropBoundary ? 1 : (this._pinScaleRef || 1);", "const scaleRef = 1;"],
  nofit: ["10_MapCtrl.js", "return (zoom / fitZoom) * scaleRef;", "return zoom * scaleRef;"],
  notapk: ["10_MapCtrl.js", 'layer.style.setProperty("--pin-screen-k", (px / this.PIN_NATIVE_PX).toFixed(4));', 'layer.style.setProperty("--pin-screen-k", inv.toFixed(4));'],
  nominzoom: ["10_MapCtrl.js", "return (fitZoom > 0) ? Math.min(this.MIN_ZOOM, fitZoom * 0.25) : this.MIN_ZOOM;", "return this.MIN_ZOOM;"],
};
if (MUT && !MUTS[MUT]) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }
let mutHit = !MUT;
const mutate = (name, src) => {
  if (!MUT || MUTS[MUT][0] !== name) return src;
  if (!src.includes(MUTS[MUT][1])) { console.log("FAIL 뮤테이션 대상 없음(" + MUT + "): " + MUTS[MUT][1]); process.exit(2); }
  mutHit = true;
  return src.replace(MUTS[MUT][1], MUTS[MUT][2]);
};

// 큰 도면(CSS 8000×6000) — 1280×800 데스크톱(마우스) 맞춤 fitZoom = min(1280/8000, 800/6000)×0.92 ≈ 0.1227
// (<0.15, 실 ga.pdf 맞춤 0.125 와 같은 자릿수 — p172 실측)
const page = await openRealMap({ width: 1280, height: 800, canvas: { w: 8000, h: 6000 }, mutate });
if (!mutHit) { console.log("FAIL 뮤테이션 미적용: " + MUT); process.exit(2); }
const ev = page.ev;
const PINS = [
  { id: "a", x: 44, y: 46, page: 1, label: "1", checkboard: true },
  { id: "b", x: 50, y: 50, page: 1, label: "2", checkboard: true },
  { id: "c", x: 56, y: 54, page: 1, label: "3", checkboard: true },
];
const head = async (z) => { await ev(`__M.zoom(${z})`); return ev("__M.head()"); };
try {
  await ev(`__M.pins(${JSON.stringify(PINS)})`);
  const fitZ = await ev("__M.fit()");
  const want = (f) => Math.min(56, Math.max(8, 30 * f)); // 사양: 맞춤 30 · 비례 · 하한 8(마우스) · 상한 56

  console.log("\n[⑨ 큰 도면 맞춤 — computeFitZoom() = fit() 공식]");
  const expFit = Math.min(1280 / 8000, 800 / 6000) * 0.92;
  ok(near(fitZ, expFit, 1e-6) && fitZ < 0.15, `fitZoom=${fitZ.toFixed(4)} = min(vw/w,vh/h)×0.92=${expFit.toFixed(4)} (<0.15)`);

  console.log("\n[① 머리 실측 높이 ∈ [8, 56] — 맞춤 ×0.05/0.5/1/2/4/16]");
  for (const f of [0.05, 0.5, 1, 2, 4, 16]) { const h = await head(fitZ * f); ok(h >= 8 - 0.05 && h <= 56 + 0.05, `맞춤×${f} 머리=${h}px ∈ [8, 56]`); }

  console.log("\n[② 맞춤 ≈ 30px (실측)]");
  const h1 = await head(fitZ);
  ok(near(h1, 30, 0.5), `맞춤 머리=${h1}px ≈ 30px`);

  console.log("\n[③ 맞춤~상한 구간 비례 (실측)]");
  const h15 = await head(fitZ * 1.5);
  ok(near(h15, 45, 0.5), `맞춤×1.5 머리=${h15}px ≈ 45px(=30×1.5)`);

  console.log("\n[④ 하한 8px (실측)]");
  const hT = await head(fitZ * 0.05);
  ok(near(hT, 8, 0.1), `맞춤×0.05 머리=${hT}px = 하한 8px`);

  console.log("\n[⑤ 상한 56px (실측)]");
  const h4 = await head(fitZ * 4), h16 = await head(fitZ * 16);
  ok(near(h4, 56, 0.1), `맞춤×4 머리=${h4}px = 상한 56px`);
  ok(near(h16, 56, 0.1), `맞춤×16 머리=${h16}px = 상한 56px`);

  console.log("\n[⑧ 맞춤×0.03~16 스윕 — 실측 = min(56, max(8, 30×f))]");
  let sweepOk = true;
  for (let f = 0.03; f <= 16; f *= 1.37) { const h = await head(fitZ * f); if (!near(h, want(f), 0.15)) { sweepOk = false; console.log(`    ×${f.toFixed(3)} 실측 ${h} 기대 ${want(f).toFixed(2)}`); } }
  ok(sweepOk, "스윕 전 구간 실측 머리 높이 = 사양 곡선");

  console.log("\n[⑨b 번호 숨김(auto) — 16px 미만 (실측 display)]");
  await ev(`__M.zoom(${fitZ})`);
  const lf = await ev("__M.label('a')");
  ok(!(await ev("__M.numOff()")) && lf && lf.display !== "none", `맞춤(30px) 번호 표시 (display=${lf && lf.display})`);
  await ev(`__M.zoom(${fitZ * 0.5})`);
  const lh = await ev("__M.label('a')");
  ok((await ev("__M.numOff()")) && lh && lh.display === "none", `맞춤×0.5(15px) 번호 숨김 (display=${lh && lh.display})`);

  console.log("\n[⑦ 동선·주석 선 실측 화면 두께 — 맞춤 1.5 · 하한 1.2(40%) · 상한 3]");
  for (const [f, w] of [[1, 1.5], [0.05, 1.2], [4, 3]]) {
    await ev(`__M.zoom(${fitZ * f})`);
    const r = await ev("__M.line('routes-svg','route-line-halo')"), a = await ev("__M.line('anno-svg','anno-pen-line')");
    ok(near(r, w, 0.2), `맞춤×${f} 동선 halo(3px) 화면=${r}px ≈ ${w}px`);
    ok(near(a, w, 0.2), `맞춤×${f} 주석 펜(3px) 화면=${a}px ≈ ${w}px`);
  }

  console.log("\n[⑩ 탭 패드 44px — 하한(8px) 핀 머리 옆 15px 도 그 핀]");
  await ev(`__M.zoom(${fitZ * 0.05})`);
  // 하한 배율에선 도면 폭이 ~49px 라 핀 3개의 패드가 겹친다 → 어느 핀이든(DOM 뒤 핀이 위). 맞춤에선 서로 떨어져 "그 핀".
  const tp = await ev("__M.tapSide(15, true)");
  ok(tp === true, `하한 핀(폭 6px) 머리 중심 옆 15px hit-test = 핀 (${tp})`);
  await ev(`__M.zoom(${fitZ})`);
  const tpf = await ev("__M.tapSide(15)");
  ok(tpf === true, `맞춤 핀(폭 22.5px) 머리 중심 옆 15px hit-test = 그 핀 (${tpf})`);

  console.log("\n[⑥ 구역(crop 창=경계) — 경계 맞춤 = 30px, ×2 = 56px (실측)]");
  await ev("__T.PDF.setDeckCrop({ x: 10, y: 20, w: 25, h: 25 }, 0.25); 1");
  const zFit = await ev("__M.fit()");
  ok(zFit > fitZ, `사전조건: 경계 fitZoom=${zFit && zFit.toFixed(4)} > 원본 ${fitZ.toFixed(4)}`);
  const hz1 = await head(zFit), hz2 = await head(zFit * 2);
  ok(near(hz1, 30, 0.5), `구역 맞춤 머리=${hz1}px = 30px (원본 맞춤과 동일)`);
  ok(near(hz2, 56, 0.1), `구역 맞춤×2 머리=${hz2}px = 상한 56px`);

  console.log("\n[⑥b 벡터 복사 구역(crop 없음, scaleRef=0.1) — 원본 대비 10배 그린 페이지]");
  await ev("__T.PDF.setDeckCrop(null, 0.1); 1");
  const zv = await ev("__M.fit()");
  const hv = await head(zv * 10);
  ok(near(hv, 30, 0.5), `벡터 복사 zoom=맞춤×10 머리=${hv}px = 30px (원본 맞춤과 동일)`);
  await ev("__T.PDF.setDeckCrop(null, 1); 1");

  console.log("\n[⑪ 재현 R4 — fitZoom < MIN_ZOOM(0.2) 인 큰 도면에서 [축소]가 더 작아져야 한다(역행 금지)]");
  const fitZ3 = await ev("__T.MapCtrl.computeFitZoom()");
  ok(fitZ3 < 0.2, `사전조건: 이 캔버스(8000×6000) fitZoom=${fitZ3.toFixed(4)} < 0.2(고정 MIN_ZOOM) — ga.pdf 와 같은 자릿수`);
  await ev(`__M.zoom(${fitZ3})`);
  const z1 = await ev("__T.MapCtrl.zoomBy(0.5); __T.State.zoom");
  ok(z1 < fitZ3, `맞춤 상태에서 [축소](×0.5) → zoom=${z1.toFixed(4)} < 맞춤 ${fitZ3.toFixed(4)} (역행 아님)`);
  ok(near(z1, fitZ3 * 0.5, 1e-6), `축소 1회 결과 = 맞춤×0.5 = ${(fitZ3 * 0.5).toFixed(4)} (실측 ${z1.toFixed(4)})`);
  await ev(`__M.zoom(${fitZ3})`);
  const z2 = await ev("__T.MapCtrl.zoomBy(0.1); __T.State.zoom");
  ok(z2 < fitZ3, `맞춤 상태에서 [축소](×0.1, 하한 진입) → zoom=${z2.toFixed(4)} < 맞춤 ${fitZ3.toFixed(4)} (역행 아님)`);
  ok(near(z2, fitZ3 * 0.25, 1e-6), `하한 = 맞춤×0.25 = ${(fitZ3 * 0.25).toFixed(4)} (실측 ${z2.toFixed(4)})`);
} finally {
  await page.close();
}

console.log(MUT ? `\n[MUT=${MUT}] 의도적 되돌림 — 위 단언 중 최소 1개는 FAIL 이어야 정상` : "");
console.log(failed ? `\n❌ p159 ${failed}건 FAIL` : "\n✅ p159 전체 PASS");
process.exit(failed ? 1 : 0);
