/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p71-crop-as-page.test.mjs)
 *
 * 대상: 마스터 지시 "구역을 지정하면 지정한 부분만 새로운 페이지로 만들어 크게".
 *
 * 근본원인: 구역(crop)을 열면 MapCtrl.fitZone 이 카메라만 확대할 뿐, 원본 페이지 전체가
 * 계속 렌더돼 크롭 바깥이 보이고(팬하면 바깥으로 빠져나감), "화면 맞춤(F)"을 누르면
 * 원본 전체로 돌아간다(10_MapCtrl.js fit()).
 *
 * 채택: crop 이 활성인 동안 MapCtrl 에 "페이지 경계"(_cropBoundary)를 두고,
 *  · 바깥 클리핑: transform 에 clip-path:inset() (로컬 레이아웃 박스 기준 % → pan/zoom 과 무관)
 *  · 최소 배율/팬 범위: 경계가 뷰포트를 항상 덮도록(cover) applyTransform() 매 호출마다 강제
 *  · fit() 리다이렉트: 경계 활성 시 원본 전체 대신 경계를 화면에 꽉 채움
 *  단일 진입점은 PDF.setDeckCrop(crop) → MapCtrl.setCropBoundary(crop) (31_Projects.js 무변경).
 *
 * 실제 모듈 소스(02_PDF.js / 10_MapCtrl.js)를 그대로 vm 에 평가해 검사한다(목 구현 아님).
 * 뮤테이션 3건이 붙어 있어, 고친 코드를 되돌리면 해당 검사가 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const pdfSrc = rd("public/js/modules/02_PDF.js");
const mapSrc = rd("public/js/modules/10_MapCtrl.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};
const near = (a, b, eps = 1e-2) => Math.abs(a - b) <= eps;

/** PDF + MapCtrl 을 한 샌드박스에 평가 → { PDF, MapCtrl, State, viewport, transform } */
function load(pdfS = pdfSrc, mapS = mapSrc) {
  const State = { zoom: 1, pan: { x: 0, y: 0 }, isoView: false, isoDir: 0, mode: "designer", fileType: "pdf", pdfDoc: null, srcPdfDoc: null };
  const viewport = { clientWidth: 375, clientHeight: 812, style: {} };
  const transform = { offsetWidth: 2384, offsetHeight: 1684, style: {}, children: [] };
  const sandbox = {
    console, State, Math, JSON, Promise, setTimeout, clearTimeout,
    document: { getElementById: () => null, createElement: () => ({ style: {}, getContext: () => null }) },
    navigator: { userAgent: "node", platform: "", maxTouchPoints: 0 },
    performance: { now: () => 0 }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(pdfS + "\n" + mapS + "\n;globalThis.__PDF = PDF; globalThis.__MAP = MapCtrl;", sandbox);
  const PDF = sandbox.__PDF, MapCtrl = sandbox.__MAP;
  MapCtrl.init(viewport, transform);
  return { PDF, MapCtrl, State, viewport, transform };
}

const CROP_PCT = { x: 10, y: 20, w: 40, h: 30 }; // % 단위(deck.crop 저장 형식) — p20 과 동일 샘플

/* ══════════════════════════════════════════════════════════════════
 * 1. 경계 설정 → 클리핑 적용(바깥 숨김)
 * ══════════════════════════════════════════════════════════════════ */
function suite1(label, ctx) {
  console.log("\n[" + label + " · ① 클리핑]");
  ctx.PDF.setDeckCrop(CROP_PCT);
  ok(ctx.MapCtrl._cropBoundary && near(ctx.MapCtrl._cropBoundary.x, 10) && near(ctx.MapCtrl._cropBoundary.w, 40),
    "PDF.setDeckCrop → MapCtrl._cropBoundary 동기화");
  ok(typeof ctx.transform.style.clipPath === "string" && ctx.transform.style.clipPath.includes("inset("),
    `transform.style.clipPath = "${ctx.transform.style.clipPath}" (inset() 적용)`);
}

/* ══════════════════════════════════════════════════════════════════
 * 2. 최소 배율 = 경계 cover 배율(패딩 없이 화면을 꽉 채움) — applyTransform 이 강제
 * ══════════════════════════════════════════════════════════════════ */
function suite2(label, ctx) {
  console.log("\n[" + label + " · ② 최소 배율 강제]");
  ctx.PDF.setDeckCrop(CROP_PCT);
  ctx.State.zoom = 1; ctx.State.pan = { x: 0, y: 0 }; // 원본 전체 보기 상태에서 진입했다고 가정
  ctx.MapCtrl.applyTransform();
  const cw = ctx.transform.offsetWidth, ch = ctx.transform.offsetHeight;
  const vw = ctx.viewport.clientWidth, vh = ctx.viewport.clientHeight;
  const expectMinZ = ctx.MapCtrl.computeCoverZoom(CROP_PCT, vw, vh, cw, ch);
  ok(near(ctx.State.zoom, expectMinZ, 1e-6), `applyTransform 후 State.zoom=${ctx.State.zoom.toFixed(4)} = cover 배율 ${expectMinZ.toFixed(4)} (원본 zoom=1 이 그보다 낮았음)`);
  // 경계가 화면을 짧은 변 기준 100% 덮는지(요구 ⓐ≥90%, 실제론 정확히 100%=cover)
  const zoneWScreen = (CROP_PCT.w / 100) * cw * ctx.State.zoom;
  const zoneHScreen = (CROP_PCT.h / 100) * ch * ctx.State.zoom;
  ok(zoneWScreen >= vw - 0.5 && zoneHScreen >= vh - 0.5, `경계 화면 크기 ${zoneWScreen.toFixed(1)}x${zoneHScreen.toFixed(1)} >= 뷰포트 ${vw}x${vh} (바깥 노출 0)`);
}

/* ══════════════════════════════════════════════════════════════════
 * 3. 팬 clamp — 경계 밖으로 못 나감
 * ══════════════════════════════════════════════════════════════════ */
function suite3(label, ctx) {
  console.log("\n[" + label + " · ③ 팬 경계]");
  ctx.PDF.setDeckCrop(CROP_PCT);
  ctx.State.zoom = 1; ctx.State.pan = { x: 99999, y: -99999 }; // 극단값 시도(드래그로 바깥 이탈 시도 흉내)
  ctx.MapCtrl.applyTransform();
  const cw = ctx.transform.offsetWidth, ch = ctx.transform.offsetHeight;
  const vw = ctx.viewport.clientWidth, vh = ctx.viewport.clientHeight;
  const z = ctx.State.zoom;
  const x0 = (CROP_PCT.x / 100) * cw, y0 = (CROP_PCT.y / 100) * ch;
  const w0 = (CROP_PCT.w / 100) * cw, h0 = (CROP_PCT.h / 100) * ch;
  const cropLeftScreen = ctx.State.pan.x + z * x0;
  const cropRightScreen = ctx.State.pan.x + z * (x0 + w0);
  const cropTopScreen = ctx.State.pan.y + z * y0;
  const cropBottomScreen = ctx.State.pan.y + z * (y0 + h0);
  ok(cropLeftScreen <= 0.5 && cropRightScreen >= vw - 0.5, `가로: 경계 화면범위[${cropLeftScreen.toFixed(1)},${cropRightScreen.toFixed(1)}] 가 뷰포트[0,${vw}] 를 덮음`);
  ok(cropTopScreen <= 0.5 && cropBottomScreen >= vh - 0.5, `세로: 경계 화면범위[${cropTopScreen.toFixed(1)},${cropBottomScreen.toFixed(1)}] 가 뷰포트[0,${vh}] 를 덮음`);
}

/* ══════════════════════════════════════════════════════════════════
 * 4. fit()(F) 이 경계 활성 시 원본 전체가 아니라 경계로 리다이렉트
 * ══════════════════════════════════════════════════════════════════ */
function suite4(label, ctx) {
  console.log("\n[" + label + " · ④ F=경계 맞춤]");
  ctx.PDF.setDeckCrop(CROP_PCT);
  let captured = null;
  const orig = ctx.MapCtrl._animateTo;
  ctx.MapCtrl._animateTo = (to) => { captured = to; };
  ctx.MapCtrl.fit();
  ctx.MapCtrl._animateTo = orig;
  const cw = ctx.transform.offsetWidth, ch = ctx.transform.offsetHeight;
  const vw = ctx.viewport.clientWidth, vh = ctx.viewport.clientHeight;
  const expectZ = ctx.MapCtrl.computeCoverZoom(CROP_PCT, vw, vh, cw, ch);
  ok(!!captured && near(captured.z, expectZ, 1e-6), `fit() → _animateTo({z:${captured && captured.z.toFixed(4)}}) = 경계 cover 배율 ${expectZ.toFixed(4)} (원본 전체 아님)`);
}

/* ══════════════════════════════════════════════════════════════════
 * 5. 크롭 없는 도면 → 경계 해제(종전 동작, 회귀 0)
 * ══════════════════════════════════════════════════════════════════ */
function suite5(label, ctx) {
  console.log("\n[" + label + " · ⑤ 경계 해제(회귀 0)]");
  ctx.PDF.setDeckCrop(CROP_PCT);
  ok(!!ctx.MapCtrl._cropBoundary, "사전조건: 경계 활성");
  ctx.PDF.setDeckCrop(null);
  ok(ctx.MapCtrl._cropBoundary === null, "PDF.setDeckCrop(null) → MapCtrl._cropBoundary 해제");
  ok(ctx.transform.style.clipPath === "", `clip-path 해제됨 = "${ctx.transform.style.clipPath}"`);
  ctx.State.zoom = 0.5; ctx.State.pan = { x: 12345, y: -6789 };
  ctx.MapCtrl.applyTransform();
  ok(ctx.State.zoom === 0.5, "경계 없으면 applyTransform 이 zoom 을 건드리지 않음(종전 동작)");
  ok(ctx.State.pan.x === 12345 && ctx.State.pan.y === -6789, "경계 없으면 applyTransform 이 pan 을 건드리지 않음(종전 동작)");
}

/* ══════════════════════════════════════════════════════════════════
 * 6. ISO 뷰에서는 경계 강제를 건너뜀(화면좌표 산식이 달라 대상 외)
 * ══════════════════════════════════════════════════════════════════ */
function suite6(label, ctx) {
  console.log("\n[" + label + " · ⑥ ISO 예외]");
  ctx.PDF.setDeckCrop(CROP_PCT);
  ctx.State.isoView = true;
  ctx.State.zoom = 0.5; ctx.State.pan = { x: 0, y: 0 };
  ctx.MapCtrl.applyTransform();
  ok(ctx.State.zoom === 0.5, "ISO 뷰에서는 zoom 강제 안 함(0.5 그대로)");
  ctx.State.isoView = false;
}

/* ══════════════════════════════════════════════════════════════════
 * 7. 새 문서/페이지 로드(renderPage) 시에도 경계 해제(setDeckCrop 우회 경로, 누출 방지)
 * ══════════════════════════════════════════════════════════════════ */
function suite7(label, ctx) {
  console.log("\n[" + label + " · ⑦ renderPage 경계 해제]");
  ok(/this\._renderState\.deckCrop = null;\s*\n\s*\/\/ \[WO 20260928-crop\][\s\S]*?MapCtrl\.setCropBoundary\(null\)/.test(pdfSrc),
    "renderPage 의 직접 초기화(setDeckCrop 우회)에도 MapCtrl.setCropBoundary(null) 동반");
}

console.log("=== 회귀: 구역을 '새 페이지'로 표시(경계 클리핑 + 줌/팬 제한 + F=경계맞춤) ===");
{
  const ctx = load();
  suite1("정상", ctx);
  suite2("정상", ctx);
  suite3("정상", ctx);
  suite4("정상", ctx);
  suite5("정상", ctx);
  suite6("정상", ctx);
  suite7("정상", ctx);
}

/* ══════════════════════════════════════════════════════════════════
 * 뮤테이션 3건 — 되돌리면 각각 실패해야 한다(파일은 미변경, in-memory 뮤테이션)
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션 M1] 클리핑 제거(_applyBoundaryClip 무동작) → ①실패해야 함");
{
  const mut = mapSrc.replace(
    '    _applyBoundaryClip(b) {\n      if (!this.transform) return;\n      const top    = Math.max(0, Math.min(100, b.y));\n      const left   = Math.max(0, Math.min(100, b.x));\n      const right  = Math.max(0, Math.min(100, 100 - b.x - b.w));\n      const bottom = Math.max(0, Math.min(100, 100 - b.y - b.h));\n      try { this.transform.style.clipPath = `inset(${top}% ${right}% ${bottom}% ${left}%)`; } catch (e) {}\n    },',
    '    _applyBoundaryClip(b) { /* removed */ },'
  );
  ok(mut !== mapSrc, "M1 문자열 치환 적중(소스와 정확히 일치)");
  const ctx = load(pdfSrc, mut);
  ctx.PDF.setDeckCrop(CROP_PCT);
  const broke1 = !(typeof ctx.transform.style.clipPath === "string" && ctx.transform.style.clipPath.includes("inset("));
  ok(broke1, `① 실패 재현: clip-path = "${ctx.transform.style.clipPath}" (inset 없음 = 바깥이 다시 보임)`);
}

console.log("\n[뮤테이션 M2] 팬 clamp 제거(clampPanToBoundary 항등화) → ③실패해야 함");
{
  const mut = mapSrc.replace(
    /    clampPanToBoundary\(pan, zoom, bbox, cw, ch, vw, vh\) \{[\s\S]*?\n    \},/,
    "    clampPanToBoundary(pan, zoom, bbox, cw, ch, vw, vh) { return pan; },"
  );
  ok(mut !== mapSrc, "M2 문자열 치환 적중(소스와 정확히 일치)");
  const ctx = load(pdfSrc, mut);
  ctx.PDF.setDeckCrop(CROP_PCT);
  ctx.State.zoom = 1; ctx.State.pan = { x: 99999, y: -99999 };
  ctx.MapCtrl.applyTransform();
  const vw = ctx.viewport.clientWidth;
  const broke3 = ctx.State.pan.x === 99999; // clamp 가 제거되면 극단값이 그대로 남음 → 경계가 화면 밖으로 빠짐
  ok(broke3, `③ 실패 재현: pan.x=${ctx.State.pan.x} 그대로(clamp 미적용, 경계가 화면 밖으로 이탈)`);
}

console.log("\n[뮤테이션 M3] 경계 해제 누락(setCropBoundary(null) 이 _cropBoundary 를 안 지움) → ⑤실패해야 함");
{
  const mut = mapSrc.replace(
    '    setCropBoundary(crop) {\n      if (!crop || !(crop.w > 0) || !(crop.h > 0)) {\n        this._cropBoundary = null;\n        this._boundaryFitZoom = null;\n        this._clearBoundaryClip();\n        return null;\n      }',
    '    setCropBoundary(crop) {\n      if (!crop || !(crop.w > 0) || !(crop.h > 0)) {\n        return null;\n      }'
  );
  ok(mut !== mapSrc, "M3 문자열 치환 적중(소스와 정확히 일치)");
  const ctx = load(pdfSrc, mut);
  ctx.PDF.setDeckCrop(CROP_PCT);
  ctx.PDF.setDeckCrop(null);
  const broke5 = ctx.MapCtrl._cropBoundary !== null; // 해제됐어야 하는데 남아있음 → 다른 도면이 잘려 보임
  ok(broke5, `⑤ 실패 재현: setDeckCrop(null) 후에도 _cropBoundary=${JSON.stringify(ctx.MapCtrl._cropBoundary)} (해제 안 됨 → 누출)`);
}

console.log("\n" + (failed ? `❌ FAIL: ${failed}건` : "✅ ALL PASS"));
process.exit(failed ? 1 : 0);
