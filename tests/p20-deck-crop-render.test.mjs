/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p20-deck-crop-render.test.mjs)
 *
 * 대상: WORK_ORDER_20260917_crop.md — "구역 표시 = 크롭 영역만 렌더(원본 비파괴)".
 * 마스터 지시: "구역 등록 시 PDF 대형에서 선택한 영역만 나오게 ... 확대해서 적용" /
 * "PDF 원본은 유지한 채 영역을 그것만 보여주는 기능이 있으면 되겠지".
 *
 * 근본원인(WO 기록): deck.crop 은 저장되지만 구역 선택 시 MapCtrl.fitZone 으로 카메라만
 * 확대해 전체 페이지가 렌더되고 픽셀 예산을 전체가 나눠 쓴다. A1/A0 는 첫 렌더부터 캔버스
 * 상한(02_PDF.js clampScale)에 닿아 확대해도 선명해지지 않는다(5996a22 실측).
 *
 * 채택: 비파괴 표시 한정 — 원본 PDF·pages_data·핀 저장 형식은 그대로 두고, 기존
 * PDF.renderCrop(5996a22)이 그릴 대상을 "현재 보이는 영역" 대신 "구역 크롭"으로 고정한다
 * (PDF.setDeckCrop/_cropRenderRect, 신규). 핀 표시좌표 변환(MapCtrl.pageToDeckCropPct /
 * deckCropPctToPage, 신규)은 순수 함수로 구현·검증하되, 현재 구조(카메라 줌 · 풀페이지 레이아웃
 * 불변)에서는 핀이 이미 정확히 표시되므로 실사용 배선은 보류했다([지휘자 판단] — 최종 보고 참조).
 *
 * 실제 모듈 소스(02_PDF.js / 10_MapCtrl.js / 31_Projects.js)를 그대로 vm 에 평가해 검사한다
 * (목 구현 아님). 뮤테이션 4건이 붙어 있어, 고친 코드를 되돌리면 해당 검사가 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const pdfSrc = rd("public/js/modules/02_PDF.js");
const mapSrc = rd("public/js/modules/10_MapCtrl.js");
const projectsSrc = rd("public/js/modules/31_Projects.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};
const near = (a, b, eps = 1e-2) => Math.abs(a - b) <= eps;

/* 뷰포트에서 보이는 영역을 흉내내는 고정 스텁(=구버전 폴백을 식별할 "가짜 현재 화면") */
const FAKE_VISIBLE = { x: 0.2, y: 0.1, w: 0.5, h: 0.6 };

/** PDF + MapCtrl 을 한 샌드박스에 평가 → { PDF, MapCtrl } (visibleDrawingRect 는 스텁으로 교체) */
function load(pdfS = pdfSrc, mapS = mapSrc) {
  const State = { zoom: 1, pan: { x: 0, y: 0 }, isoView: false, isoDir: 0, mode: "designer", fileType: "pdf" };
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
  MapCtrl.visibleDrawingRect = () => FAKE_VISIBLE; // 실제 DOM 없이 "종전 동작"을 식별 가능하게 스텁
  return { PDF, MapCtrl };
}

const A1 = { w: 2384, h: 1684 }; // 씨스타 대표 도면 규격(p11과 동일)
const CROP_PCT = { x: 10, y: 20, w: 40, h: 30 }; // % 단위(deck.crop 저장 형식)

/* ══════════════════════════════════════════════════════════════════
 * 1. 크롭 있는 구역 → 렌더 대상이 크롭 영역(전체 페이지·현재화면 아님)
 * ══════════════════════════════════════════════════════════════════ */
function suite1(label, PDF) {
  console.log("\n[" + label + " · ① 렌더 대상 = 크롭 영역]");
  PDF.setDeckCrop(CROP_PCT);
  const rect = PDF._cropRenderRect();
  ok(!!rect && near(rect.x, 0.10) && near(rect.y, 0.20) && near(rect.w, 0.40) && near(rect.h, 0.30),
    `_cropRenderRect() = ${JSON.stringify(rect)} (기대 {x:.1,y:.2,w:.4,h:.3})`);
  ok(!(rect.x === FAKE_VISIBLE.x && rect.w === FAKE_VISIBLE.w), "현재 보이는 영역(FAKE_VISIBLE)이 아니라 구역 크롭을 대상으로 함");
}

/* ══════════════════════════════════════════════════════════════════
 * 2. 같은 픽셀 예산에서 크롭 렌더의 유효 해상도가 전체 렌더보다 높다
 * ══════════════════════════════════════════════════════════════════ */
function suite2(label, PDF) {
  console.log("\n[" + label + " · ② 유효 해상도 비교]");
  const cap = PDF.CANVAS_PX_DESKTOP;
  PDF.setDeckCrop(CROP_PCT);
  const cropRect = PDF._cropRenderRect();
  const w0 = cropRect.w * A1.w, h0 = cropRect.h * A1.h;
  const rsCrop = PDF.clampScale(99, w0, h0, cap, PDF.MAX_SIDE_HARD);
  PDF.setDeckCrop(null);
  const fullRect = PDF._cropRenderRect(); // 폴백(FAKE_VISIBLE) — 크롭 없을 때 "전체/현재화면" 기준
  const wF = fullRect.w * A1.w, hF = fullRect.h * A1.h;
  const rsFull = PDF.clampScale(99, wF, hF, cap, PDF.MAX_SIDE_HARD);
  // 면적비 = (FAKE_VISIBLE 0.5*0.6) / (crop 0.4*0.3) = 2.5 → 배율비 = sqrt(2.5) ≈ 1.58
  ok(rsCrop > rsFull * 1.3, `크롭 배율 ${rsCrop.toFixed(2)} > 전체 배율 ${rsFull.toFixed(2)} × 1.3 (같은 픽셀 예산, 면적↓ → 배율↑)`);
}

/* ══════════════════════════════════════════════════════════════════
 * 3. 핀 좌표 변환: 페이지 기준 % → 크롭 기준 표시 %
 * ══════════════════════════════════════════════════════════════════ */
function suite3(label, MapCtrl) {
  console.log("\n[" + label + " · ③ 좌표 변환]");
  // pin 이 크롭 중앙(30,35) → crop{x:10,y:20,w:40,h:30} 기준 (30-10)/40*100=50, (35-20)/30*100=50
  const r = MapCtrl.pageToDeckCropPct(30, 35, CROP_PCT);
  ok(!!r && near(r.x, 50) && near(r.y, 50), `pageToDeckCropPct(30,35) = ${JSON.stringify(r)} (기대 {x:50,y:50})`);
  // crop 없으면 항등(변환 없음 = 종전 동작)
  const id = MapCtrl.pageToDeckCropPct(30, 35, null);
  ok(id.x === 30 && id.y === 35, "crop 없으면 항등 변환(종전 페이지 기준 그대로)");
}

/* ══════════════════════════════════════════════════════════════════
 * 4. 왕복 변환: 크롭 화면에서 찍은 핀이 페이지 기준 %로 원래 위치와 일치
 * ══════════════════════════════════════════════════════════════════ */
function suite4(label, MapCtrl) {
  console.log("\n[" + label + " · ④ 왕복 변환(배치 역변환)]");
  const samples = [[30, 35], [10, 20], [50, 50], [22.5, 33.333]];
  for (const [px, py] of samples) {
    const disp = MapCtrl.pageToDeckCropPct(px, py, CROP_PCT);
    const back = MapCtrl.deckCropPctToPage(disp.x, disp.y, CROP_PCT);
    ok(near(back.x, px, 0.01) && near(back.y, py, 0.01),
      `(${px},${py}) → 표시(${disp.x.toFixed(2)},${disp.y.toFixed(2)}) → 역변환(${back.x.toFixed(3)},${back.y.toFixed(3)}) 오차≤0.01%`);
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 5. 크롭 밖의 핀은 표시되지 않는다(null)
 * ══════════════════════════════════════════════════════════════════ */
function suite5(label, MapCtrl) {
  console.log("\n[" + label + " · ⑤ 크롭 밖 핀 제외]");
  ok(MapCtrl.pageToDeckCropPct(5, 35, CROP_PCT) === null, "crop.x(10) 왼쪽 → null");
  ok(MapCtrl.pageToDeckCropPct(60, 35, CROP_PCT) === null, "crop.x+w(50) 오른쪽 → null");
  ok(MapCtrl.pageToDeckCropPct(30, 5, CROP_PCT) === null, "crop.y(20) 위 → null");
  ok(MapCtrl.pageToDeckCropPct(30, 60, CROP_PCT) === null, "crop.y+h(50) 아래 → null");
  ok(MapCtrl.pageToDeckCropPct(10, 20, CROP_PCT) !== null, "경계(좌상단)는 포함");
}

/* ══════════════════════════════════════════════════════════════════
 * 6. crop NULL 구역은 종전대로 전체 페이지(=현재 화면 폴백) 렌더
 * ══════════════════════════════════════════════════════════════════ */
function suite6(label, PDF) {
  console.log("\n[" + label + " · ⑥ crop NULL 폴백(종전 동작)]");
  PDF.setDeckCrop(null);
  const rect = PDF._cropRenderRect();
  ok(rect === FAKE_VISIBLE, "_cropRenderRect() 이 MapCtrl.visibleDrawingRect() 그대로(종전 폴백)");
  const snap = PDF.deckSnapshotRect(null, A1.w, A1.h);
  ok(snap.x0 === 0 && snap.y0 === 0 && snap.w0 === A1.w && snap.h0 === A1.h,
    `deckSnapshotRect(null) = ${JSON.stringify(snap)} (전체 페이지)`);
}

/* ══════════════════════════════════════════════════════════════════
 * 7. 비파괴 증명 — 원본 pages_data·핀 저장값 변경 없음
 * ══════════════════════════════════════════════════════════════════ */
function suite7(label, PDF, MapCtrl) {
  console.log("\n[" + label + " · ⑦ 비파괴 증명]");
  const cropCopy = Object.freeze({ x: 10, y: 20, w: 40, h: 30 });
  ok(!!PDF.deckCropToFraction(cropCopy), "deckCropToFraction 이 Object.freeze 된 입력에도 예외 없이 동작(입력 변경 안 함)");
  const pin = { x: 30, y: 35 };
  MapCtrl.pageToDeckCropPct(pin.x, pin.y, CROP_PCT);
  ok(pin.x === 30 && pin.y === 35, "pageToDeckCropPct 호출 후 pin 원본 객체 불변");
  // snapshotAllPages 시그니처/본문 불변 — 크롭 인자 추가 없음(스냅샷 생성 로직 미변경)
  ok(/async snapshotAllPages\(pdfDoc, maxDim = 4096, quality = 0\.92\)/.test(pdfSrc),
    "snapshotAllPages 시그니처 불변(크롭 파라미터 추가 없음 = pages_data 생성 로직 무변경)");
  ok(/SOFT_LIMIT/.test(pdfSrc), "snapshotAllPages 본문의 SOFT_LIMIT 강등 루프 그대로 존재(재작성 아님)");
  ok(!/pages_data/.test(pdfSrc) && !/pages_data/.test(mapSrc), "02_PDF.js/10_MapCtrl.js 어디서도 pages_data 를 직접 쓰지 않음(저장 경로 미접촉)");
}

/* ══════════════════════════════════════════════════════════════════
 * 배선 — selectDeck 이 PDF.setDeckCrop 을 호출한다(정적 소스 검사, p17 과 동일 패턴)
 * ══════════════════════════════════════════════════════════════════ */
function suiteWiring(label, src) {
  console.log("\n[" + label + " · 배선]");
  ok(/PDF\.setDeckCrop\(d\.crop \|\| null\)/.test(src), "selectDeck 이 PDF.setDeckCrop(d.crop||null) 호출 — 구역 진입마다 렌더 대상 고정/해제");
}

console.log("=== 회귀: 구역 표시 = 크롭 영역만 렌더 ===");
{
  const { PDF, MapCtrl } = load();
  suite1("정상", PDF);
  suite2("정상", PDF);
  suite3("정상", MapCtrl);
  suite4("정상", MapCtrl);
  suite5("정상", MapCtrl);
  suite6("정상", PDF);
  suite7("정상", PDF, MapCtrl);
  suiteWiring("정상", projectsSrc);
}

/* ══════════════════════════════════════════════════════════════════
 * 뮤테이션 4건 — 되돌리면 각각 실패해야 한다(확인 후 원복 = 파일 미변경, in-memory 뮤테이션)
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션 M1] 크롭 렌더 → 전체 렌더 환원(_cropRenderRect 이 deckCrop 무시) → ①②실패해야 함");
{
  const mut = pdfSrc.replace(
    "    _cropRenderRect() {\n      const st = this._renderState;\n      if (st.deckCrop) return st.deckCrop;\n      return (typeof MapCtrl !== \"undefined\" && MapCtrl.visibleDrawingRect)\n        ? MapCtrl.visibleDrawingRect() : null;\n    },",
    "    _cropRenderRect() {\n      return (typeof MapCtrl !== \"undefined\" && MapCtrl.visibleDrawingRect) ? MapCtrl.visibleDrawingRect() : null;\n    },"
  );
  ok(mut !== pdfSrc, "M1 문자열 치환 적중(소스와 정확히 일치)");
  const { PDF } = load(mut, mapSrc);
  PDF.setDeckCrop(CROP_PCT);
  const rect = PDF._cropRenderRect();
  const broke1 = !(rect.x === 0.10 && rect.w === 0.40); // 이제 FAKE_VISIBLE 이 나와야 함
  ok(broke1, "① 실패 재현: _cropRenderRect() 가 이제 크롭이 아니라 FAKE_VISIBLE 을 반환");
}

console.log("\n[뮤테이션 M2] 좌표 변환 제거(pageToDeckCropPct 항등화) → ③실패해야 함");
{
  const mut = mapSrc.replace(
    "    pageToDeckCropPct(x, y, crop) {\n      if (!crop || !(crop.w > 0) || !(crop.h > 0)) return { x, y };\n      if (x < crop.x || x > crop.x + crop.w || y < crop.y || y > crop.y + crop.h) return null;\n      return { x: (x - crop.x) / crop.w * 100, y: (y - crop.y) / crop.h * 100 };\n    },",
    "    pageToDeckCropPct(x, y, crop) { return { x, y }; },"
  );
  ok(mut !== mapSrc, "M2 문자열 치환 적중(소스와 정확히 일치)");
  const { MapCtrl } = load(pdfSrc, mut);
  const r = MapCtrl.pageToDeckCropPct(30, 35, CROP_PCT);
  const broke3 = !(near(r.x, 50) && near(r.y, 50)); // 항등이면 30,35 그대로 → 50,50 아님
  ok(broke3, `③ 실패 재현: pageToDeckCropPct(30,35) = ${JSON.stringify(r)} (기대와 불일치)`);
}

console.log("\n[뮤테이션 M3] 역변환 제거(deckCropPctToPage 항등화) → ④실패해야 함");
{
  const mut = mapSrc.replace(
    "    deckCropPctToPage(x, y, crop) {\n      if (!crop || !(crop.w > 0) || !(crop.h > 0)) return { x, y };\n      return { x: crop.x + (x / 100) * crop.w, y: crop.y + (y / 100) * crop.h };\n    },",
    "    deckCropPctToPage(x, y, crop) { return { x, y }; },"
  );
  ok(mut !== mapSrc, "M3 문자열 치환 적중(소스와 정확히 일치)");
  const { MapCtrl } = load(pdfSrc, mut);
  const disp = MapCtrl.pageToDeckCropPct(30, 35, CROP_PCT); // {x:50,y:50}
  const back = MapCtrl.deckCropPctToPage(disp.x, disp.y, CROP_PCT); // 항등이면 50,50 (원래 30,35 아님)
  const broke4 = !(near(back.x, 30, 0.01) && near(back.y, 35, 0.01));
  ok(broke4, `④ 실패 재현: 왕복 결과 ${JSON.stringify(back)} ≠ 원래(30,35)`);
}

console.log("\n[뮤테이션 M4] NULL 폴백 제거(_cropRenderRect 이 항상 크롭 강제) → ⑥실패해야 함");
{
  const mut = pdfSrc.replace(
    "    _cropRenderRect() {\n      const st = this._renderState;\n      if (st.deckCrop) return st.deckCrop;\n      return (typeof MapCtrl !== \"undefined\" && MapCtrl.visibleDrawingRect)\n        ? MapCtrl.visibleDrawingRect() : null;\n    },",
    "    _cropRenderRect() {\n      const st = this._renderState;\n      return st.deckCrop || { x: 0, y: 0, w: 1, h: 1 };\n    },"
  );
  ok(mut !== pdfSrc, "M4 문자열 치환 적중(소스와 정확히 일치)");
  const { PDF } = load(mut, mapSrc);
  PDF.setDeckCrop(null);
  const rect = PDF._cropRenderRect();
  const broke6 = rect !== FAKE_VISIBLE; // 종전 폴백(MapCtrl.visibleDrawingRect)을 안 씀
  ok(broke6, `⑥ 실패 재현: crop NULL 인데 _cropRenderRect() = ${JSON.stringify(rect)} (MapCtrl 폴백 아님)`);
}

console.log("\n" + (failed ? `❌ FAIL: ${failed}건` : "✅ ALL PASS"));
process.exit(failed ? 1 : 0);
