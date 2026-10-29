#!/usr/bin/env node
/**
 * markup-ink-eval.mjs — p184 마킹 도면 "잉크 채도 덩어리" 1단계 가설 실측(측정 전용, 앱 코드 미수정)
 *
 * 배경(마스터 2026-10-30): 사진 전체 차분 검출(markup-eval.mjs) recall 22%, 타일 OCR 번호 일치 0%.
 * 새 가설 — 펜 잉크(빨강/파랑)는 인쇄선(검정/회색)보다 채도가 훨씬 높으니, 사진 전체를 뒤지지 말고
 * "채도 기반 잉크 덩어리"를 먼저 뽑아 그 주변 작은 조각만 다음 단계(OCR)에 넘기면 후보가 줄고 정확해진다.
 * 이번 스크립트는 1단계(순수 이미지 처리)만: 비전 모델 호출 없음, OCR 없음.
 *
 * 재사용(74_MarkupAlign.js, 재구현 금지): boxBlur, closeMask, connectedComponents, computeHomography, applyH.
 * 모듈 자체 주석(p184 실측)의 교훈을 따른다: "원시 채도는 흰 배경의 랜덤 노이즈에도 쉽게 0.3 을 넘는다"
 * → RGB 채널을 먼저 블러한 뒤 채도/색상(hue)을 계산한다(Align.toSatBlurred 와 동일 원리, hue 는 자체 계산).
 *
 * 입력(.tmp/, 커밋 대상 아님):
 *   .tmp/markup-samples/s5.jpg    — 현장 마킹 사진(raw pixel 4032x1816, EXIF 미반영 — node-canvas 기준)
 *   .tmp/markup-eval/points.json   — 4점 호모그래피 정합 좌표(photo→orig)
 *   .tmp/markup-eval/truth.json    — 정답 36개(원본 좌표계, markup-eval.mjs 가 투영해 둔 것)
 *
 * 출력(.tmp/markup-ink/, 커밋 대상 아님):
 *   blobs.json   — 덩어리 bbox/중심/면적/색 + 임계값 등 메타(재현성)
 *   blobs.png    — 사진 위에 덩어리 상자 시각화
 *   report.json  — 후보 포함률·덩어리 수·오검출 수·숫자 크기 추정·소요시간
 *
 * 사용: node build-tools/markup-ink-eval.mjs
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "canvas";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLES = path.join(ROOT, ".tmp/markup-samples");
const EVAL = path.join(ROOT, ".tmp/markup-eval");
const OUT = path.join(ROOT, ".tmp/markup-ink");
const MODULE_SRC = fs.readFileSync(path.join(ROOT, "public/js/modules/74_MarkupAlign.js"), "utf8").replace(/\r\n/g, "\n");

function loadAlign() {
  const sandbox = { console, State: { pins: [] } };
  vm.createContext(sandbox);
  vm.runInContext(MODULE_SRC + "\n;globalThis.__MA = MarkupAlign;", sandbox);
  return vm.runInContext("__MA", sandbox);
}

/* ══ 조정 가능한 상수(전부 이름 붙여 주석 — 매직넘버 없음) ══════════════════════════════ */
const BLUR_R = 2;                 // Align.BLUR_R(=2)과 동일 — RGB 채널을 먼저 블러해 센서노이즈가
                                   // 채도를 끌어올리는 현상을 막는다(모듈 자체 주석 p184 실측).
const INK_SAT_MARGIN_MULTIPLIER = 6; // 임계 = 배경 채도 중앙값 + 이 배수 * MAD(로버스트 표준편차 추정).
                                   // MAD*1.4826 ≈ 표준편차이므로 6*MAD ≈ 4σ 바깥만 "배경이 아님"으로 간주.
const SAT_THRESHOLD_FLOOR = 0.15; // 배경이 극히 균일해 MAD≈0 이면 임계가 과민해지는 것을 막는 하한
                                   // (참고: Align.SAT_THRESH=0.32 는 "저해상도 워프본" 기준이라 다른 값).
const MIN_VALUE_FOR_INK = 40;     // 밝기(0~255, 블러 후 RGB 최대값) 하한 — 너무 어두운 그림자/저조도
                                   // 영역은 hue 계산이 불안정해 오검출을 만든다(채도만으론 못 거름).
const RED_HUE_HI = 25;            // 빨강 잉크 hue(0~360) — 0 을 중심으로 ±margin(랩어라운드 처리)
const RED_HUE_LO_WRAP = 335;
const BLUE_HUE_LO = 195;          // 파랑 잉크 hue — 청록~남색
const BLUE_HUE_HI = 255;
const GREEN_HUE_LO = 65;          // 형광 초록(하이라이터) hue — 명시적으로 제외
const GREEN_HUE_HI = 170;
const CLOSE_R = 3;                // 닫힘(팽창→침식) 반경 — Align.CLOSE_R(=3, 워프본 3570px 기준)과
                                   // 동일값을 원본 해상도(4032px, 같은 스케일대)에 그대로 적용.
const MIN_BLOB_AREA_PX = 20;      // 닫힘 후 최소 연결성분 면적(px²) — JPEG 노이즈 산발 제거용 경험치.
const MATCH_RADIUS_FRAC = 0.03;   // 정답 매칭 반경 = 원본 도면 폭의 3%(발주 지정값).
const TOP_N_FOR_SIZE_ESTIMATE = 10; // 숫자 한 개 크기 추정에 쓸 상위(면적 큰) 덩어리 개수.

function hueOf(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d === 0) return 0;
  let h;
  if (mx === r) h = 60 * (((g - b) / d) % 6);
  else if (mx === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  return h;
}
function isRedHue(h) { return h <= RED_HUE_HI || h >= RED_HUE_LO_WRAP; }
function isBlueHue(h) { return h >= BLUE_HUE_LO && h <= BLUE_HUE_HI; }
function isGreenHue(h) { return h >= GREEN_HUE_LO && h <= GREEN_HUE_HI; }

function median(sortedArr) {
  const n = sortedArr.length;
  return n % 2 ? sortedArr[(n - 1) / 2] : (sortedArr[n / 2 - 1] + sortedArr[n / 2]) / 2;
}

async function main() {
  const t0 = Date.now();
  fs.mkdirSync(OUT, { recursive: true });
  const Align = loadAlign();

  /* ── 1) 사진 로드(raw pixel, EXIF 미반영) ── */
  const img = await loadImage(path.join(SAMPLES, "s5.jpg"));
  const w = img.width, h = img.height;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const photoImg = ctx.getImageData(0, 0, w, h);
  const data = photoImg.data;
  const n = w * h;

  /* ── 2) RGB 채널 분리 + 블러(Align.boxBlur 재사용) ── */
  const rc = new Float32Array(n), gc = new Float32Array(n), bc = new Float32Array(n);
  for (let p = 0, o = 0; o < n; p += 4, o++) { rc[o] = data[p]; gc[o] = data[p + 1]; bc[o] = data[p + 2]; }
  const rb = Align.boxBlur(rc, w, h, BLUR_R);
  const gb = Align.boxBlur(gc, w, h, BLUR_R);
  const bb = Align.boxBlur(bc, w, h, BLUR_R);

  /* ── 3) 채도/명도/색상(hue) 계산 ── */
  const sat = new Float32Array(n);
  const val = new Float32Array(n);
  const hue = new Float32Array(n);
  for (let o = 0; o < n; o++) {
    const r = rb[o], g = gb[o], b = bb[o];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    sat[o] = mx === 0 ? 0 : (mx - mn) / mx;
    val[o] = mx;
    hue[o] = hueOf(r, g, b);
  }

  /* ── 4) 배경 채도 통계(중앙값 + MAD) → 임계 파생 ── */
  const satSorted = sat.slice();
  satSorted.sort();
  const satBgMedian = median(satSorted);
  const absDev = new Float32Array(n);
  for (let o = 0; o < n; o++) absDev[o] = Math.abs(sat[o] - satBgMedian);
  absDev.sort();
  const satBgMad = median(absDev);
  const satThreshold = Math.max(satBgMedian + INK_SAT_MARGIN_MULTIPLIER * satBgMad, SAT_THRESHOLD_FLOOR);

  /* ── 5) 잉크 마스크(빨강/파랑) — 형광 초록은 명시적으로 제외, 카운트만 집계 ── */
  const redRaw = new Uint8Array(n), blueRaw = new Uint8Array(n);
  let greenExcludedCount = 0, rawInkPixelCount = 0;
  for (let o = 0; o < n; o++) {
    if (sat[o] < satThreshold || val[o] < MIN_VALUE_FOR_INK) continue;
    const hu = hue[o];
    if (isGreenHue(hu)) { greenExcludedCount++; continue; }
    if (isRedHue(hu)) { redRaw[o] = 1; rawInkPixelCount++; }
    else if (isBlueHue(hu)) { blueRaw[o] = 1; rawInkPixelCount++; }
  }

  /* ── 6) 닫힘(형태학) → 연결 성분(Align 재사용) ── */
  const inkRaw = new Uint8Array(n);
  for (let o = 0; o < n; o++) inkRaw[o] = (redRaw[o] || blueRaw[o]) ? 1 : 0;
  const inkClosed = Align.closeMask(inkRaw, w, h, CLOSE_R);
  let closedInkPixelCount = 0;
  for (let o = 0; o < n; o++) closedInkPixelCount += inkClosed[o];
  const comps = Align.connectedComponents(inkClosed, w, h);

  /* ── 7) 최소 면적 필터 + 색 다수결(닫힘 전 원시 red/blue 픽셀로 투표) ── */
  const blobs = comps
    .filter((c) => c.area >= MIN_BLOB_AREA_PX)
    .map((c, i) => {
      let redCount = 0, blueCount = 0;
      for (let y = c.minY; y <= c.maxY; y++) {
        const rowBase = y * w;
        for (let x = c.minX; x <= c.maxX; x++) {
          const o = rowBase + x;
          if (redRaw[o]) redCount++;
          else if (blueRaw[o]) blueCount++;
        }
      }
      return {
        id: i,
        bbox: { minX: c.minX, minY: c.minY, maxX: c.maxX, maxY: c.maxY, w: c.w, h: c.h },
        cx: c.cx, cy: c.cy, area: c.area,
        color: redCount >= blueCount ? "red" : "blue",
        redCount, blueCount
      };
    });

  /* ── 8) blobs.json ── */
  const meta = {
    imageSize: { w, h },
    blurR: BLUR_R,
    satBgMedian: Number(satBgMedian.toFixed(4)),
    satBgMad: Number(satBgMad.toFixed(4)),
    satThreshold: Number(satThreshold.toFixed(4)),
    minValueForInk: MIN_VALUE_FOR_INK,
    hueRanges: {
      red: [[0, RED_HUE_HI], [RED_HUE_LO_WRAP, 360]],
      blue: [BLUE_HUE_LO, BLUE_HUE_HI],
      greenExcluded: [GREEN_HUE_LO, GREEN_HUE_HI]
    },
    closeR: CLOSE_R,
    minBlobAreaPx: MIN_BLOB_AREA_PX,
    rawInkPixelCount,
    closedInkPixelCount,
    greenExcludedPixelCount: greenExcludedCount,
    componentsBeforeAreaFilter: comps.length
  };
  fs.writeFileSync(path.join(OUT, "blobs.json"), JSON.stringify({ meta, blobs }, null, 2));

  /* ── 9) blobs.png — 사진 위에 덩어리 상자 시각화 ── */
  const visCanvas = createCanvas(w, h);
  const vctx = visCanvas.getContext("2d");
  vctx.drawImage(img, 0, 0);
  blobs.forEach((b) => {
    vctx.strokeStyle = b.color === "red" ? "#ff2d2d" : "#2d6bff";
    vctx.lineWidth = 3;
    vctx.strokeRect(b.bbox.minX, b.bbox.minY, b.bbox.w, b.bbox.h);
  });
  fs.writeFileSync(path.join(OUT, "blobs.png"), visCanvas.toBuffer("image/png"));

  /* ── 10) 호모그래피 투영(photo → orig, Align 재사용) + 정답 매칭 ── */
  const pts = JSON.parse(fs.readFileSync(path.join(EVAL, "points.json"), "utf8"));
  const photoPts = pts.pairs.map((p) => ({ x: p.photo[0], y: p.photo[1] }));
  const origPts = pts.pairs.map((p) => ({ x: p.orig[0], y: p.orig[1] }));
  const H = Align.computeHomography(photoPts, origPts);
  if (!H) throw new Error("호모그래피 계산 실패(4점 특이)");
  const origW = pts.origSize.w;

  const truth = JSON.parse(fs.readFileSync(path.join(EVAL, "truth.json"), "utf8"));
  const blobsOrig = blobs.map((b) => {
    const m = Align.applyH(H, b.cx, b.cy);
    return { ...b, origX: m ? m.x : null, origY: m ? m.y : null };
  }).filter((b) => b.origX != null);

  const matchRadius = origW * MATCH_RADIUS_FRAC;
  let matchedTruthCount = 0;
  const unmatchedTruth = [];
  truth.forEach((t) => {
    const near = blobsOrig.some((b) => Math.hypot(b.origX - t.x, b.origY - t.y) <= matchRadius);
    if (near) matchedTruthCount++; else unmatchedTruth.push(t.label);
  });
  const candidateInclusionRate = truth.length ? matchedTruthCount / truth.length : 0;

  const usedByTruth = new Set();
  blobsOrig.forEach((b, i) => {
    const near = truth.some((t) => Math.hypot(b.origX - t.x, b.origY - t.y) <= matchRadius);
    if (near) usedByTruth.add(i);
  });
  const blobsWithoutNearbyTruth = blobsOrig.length - usedByTruth.size;

  /* ── 11) 덩어리 크기 분포 + 숫자 크기 추정(면적 상위 N개 평균 높이) ── */
  const areas = blobs.map((b) => b.area).sort((a, b) => a - b);
  const areaStats = areas.length ? {
    min: areas[0], max: areas[areas.length - 1],
    median: median(areas),
    mean: Number((areas.reduce((a, b) => a + b, 0) / areas.length).toFixed(1))
  } : null;
  const topBySize = blobs.slice().sort((a, b) => b.area - a.area).slice(0, TOP_N_FOR_SIZE_ESTIMATE);
  const digitHeightEstimatePx = topBySize.length
    ? Number((topBySize.reduce((a, b) => a + b.bbox.h, 0) / topBySize.length).toFixed(1))
    : null;

  /* ── 12) report.json ── */
  const totalMs = Date.now() - t0;
  const report = {
    truthCount: truth.length,
    blobCount: blobsOrig.length,
    candidateInclusionRate: Number(candidateInclusionRate.toFixed(3)),
    matchedTruthCount,
    unmatchedTruthCount: unmatchedTruth.length,
    unmatchedTruthLabels: unmatchedTruth,
    blobsWithoutNearbyTruth,
    matchRadiusPx: Number(matchRadius.toFixed(1)),
    matchRadiusFracOfOrigW: MATCH_RADIUS_FRAC,
    areaStats,
    digitHeightEstimatePx,
    topNForSizeEstimate: TOP_N_FOR_SIZE_ESTIMATE,
    satThreshold: meta.satThreshold,
    satBgMedian: meta.satBgMedian,
    satBgMad: meta.satBgMad,
    greenExcludedPixelCount: greenExcludedCount,
    totalMs
  };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));

  console.log("=== markup-ink-eval 결과 ===");
  console.log(`배경 채도 중앙값=${meta.satBgMedian} MAD=${meta.satBgMad} → 임계=${meta.satThreshold}`);
  console.log(`덩어리(면적필터 후) = ${report.blobCount} (면적필터 전 성분 ${meta.componentsBeforeAreaFilter})`);
  console.log(`정답 ${report.truthCount}개 중 근처에 덩어리 있음 = ${report.matchedTruthCount} (후보포함률=${report.candidateInclusionRate})`);
  console.log(`정답 없는 덩어리(오검출) = ${report.blobsWithoutNearbyTruth}`);
  console.log(`면적 분포: ${JSON.stringify(report.areaStats)}`);
  console.log(`숫자 크기 추정(상위${TOP_N_FOR_SIZE_ESTIMATE}개 평균 높이) = ${report.digitHeightEstimatePx}px`);
  console.log(`형광초록 제외 픽셀 = ${greenExcludedCount}`);
  console.log(`total ${totalMs}ms`);
}

main().catch((e) => { console.error(e); process.exit(1); });
