#!/usr/bin/env node
/**
 * markup-eval.mjs — p184 마킹 도면(74_MarkupAlign.js) 실사진 실측 평가(측정 전용, 앱 코드 미수정)
 *
 * WO 20261024-markupeval: 현장 마킹 사진(.tmp/markup-samples/s5.jpg) vs 원본 PDF 1p 렌더를
 * 74_MarkupAlign.js 의 computeHomography/warp/detectMarks 를 그대로 호출(재구현 금지)해
 * 4점 정합 오차·검출 recall/precision·실패유형을 실측한다.
 *
 * 입력(.tmp/markup-eval/ 아래, 커밋 대상 아님):
 *   orig_p1.png        — PDF.js(legacy build)+node-canvas 로 렌더한 원본 FLOOR 도면 1p
 *   points.json         — 4점 정합 좌표(사람이 이미지를 보고 식별, 근거 memo 포함) + 잔차 검증용 독립 눈금점
 *   truth-photo.json     — 사람이 사진에서 판독한 마킹 점(사진 픽셀 좌표)
 *
 * 출력(.tmp/markup-eval/ 아래):
 *   overlay.png, warped.png  — 정합 결과 시각 확인
 *   truth.json            — truth-photo.json 을 호모그래피로 원본 좌표계에 투영
 *   detected.json          — detectMarks() 결과(원본 좌표계, 픽셀)
 *   result.png            — 정답(초록)·검출(빨강)·매칭(선) 시각 증거
 *   report.json           — recall/precision/실패유형/처리시간 수치
 *
 * 사용: node build-tools/markup-eval.mjs
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage, ImageData } from "canvas";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVAL = path.join(ROOT, ".tmp/markup-eval");
const MODULE_SRC = fs.readFileSync(path.join(ROOT, "public/js/modules/74_MarkupAlign.js"), "utf8").replace(/\r\n/g, "\n");

function loadAlign() {
  const sandbox = { console, State: { pins: [] } };
  vm.createContext(sandbox);
  vm.runInContext(MODULE_SRC + "\n;globalThis.__MA = MarkupAlign;", sandbox);
  return vm.runInContext("__MA", sandbox);
}

async function getImageData(file) {
  const img = await loadImage(file);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height);
}

function nearestMatch(cands, target, usedSet) {
  let best = -1, bd = Infinity;
  cands.forEach((c, i) => {
    if (usedSet.has(i)) return;
    const d = Math.hypot(c.x - target.x, c.y - target.y);
    if (d < bd) { bd = d; best = i; }
  });
  return { idx: best, d: bd };
}

async function main() {
  const t0 = Date.now();
  const Align = loadAlign();

  /* ── 1) 4점 정합 호모그래피 ── */
  const pts = JSON.parse(fs.readFileSync(path.join(EVAL, "points.json"), "utf8"));
  const photoPts = pts.pairs.map((p) => ({ x: p.photo[0], y: p.photo[1] }));
  const origPts = pts.pairs.map((p) => ({ x: p.orig[0], y: p.orig[1] }));
  const H = Align.computeHomography(photoPts, origPts);
  if (!H) throw new Error("호모그래피 계산 실패(4점 특이)");

  const W = pts.origSize.w, Hh = pts.origSize.h;

  /* ── 2) 잔차(독립 눈금점) ── */
  const residuals = pts.residualCheckPoints.pairs.map((r) => {
    const mapped = Align.applyH(H, r.photo[0], r.photo[1]);
    const d = Math.hypot(mapped.x - r.orig[0], mapped.y - r.orig[1]);
    return { label: r.label, errPx: d, errPctOfW: (d / W) * 100 };
  });
  const avgResidualPctW = residuals.reduce((a, b) => a + b.errPctOfW, 0) / residuals.length;

  /* ── 3) 워프 + 오버레이 ── */
  const photoImg = await getImageData(path.join(ROOT, ".tmp/markup-samples/s5.jpg"));
  const warped = Align.warp(photoImg, H, W, Hh, [255, 255, 255]);
  if (!warped) throw new Error("워프 실패");
  const warpedCanvas = createCanvas(W, Hh);
  warpedCanvas.getContext("2d").putImageData(new ImageData(warped.data, W, Hh), 0, 0);
  fs.writeFileSync(path.join(EVAL, "warped.png"), warpedCanvas.toBuffer("image/png"));

  const origImgData = await getImageData(path.join(EVAL, "orig_p1.png"));
  const origCanvas = createCanvas(W, Hh);
  origCanvas.getContext("2d").putImageData(origImgData, 0, 0);

  const overlay = createCanvas(W, Hh);
  const octx = overlay.getContext("2d");
  octx.drawImage(origCanvas, 0, 0);
  octx.globalAlpha = 0.5;
  octx.drawImage(warpedCanvas, 0, 0);
  octx.globalAlpha = 1;
  fs.writeFileSync(path.join(EVAL, "overlay.png"), overlay.toBuffer("image/png"));

  /* ── 4) 정답 투영(사진 좌표 → 원본 좌표) ── */
  const truthPhoto = JSON.parse(fs.readFileSync(path.join(EVAL, "truth-photo.json"), "utf8"));
  const truth = truthPhoto.items.map((it) => {
    const m = Align.applyH(H, it.photo[0], it.photo[1]);
    return { x: m.x, y: m.y, label: it.label, type: it.type };
  });
  fs.writeFileSync(path.join(EVAL, "truth.json"), JSON.stringify(truth, null, 2));

  /* ── 5) 검출(detectMarks 그대로 호출) ── */
  const tDetectStart = Date.now();
  const detected = Align.detectMarks(origImgData, warped);
  const detectMs = Date.now() - tDetectStart;
  fs.writeFileSync(path.join(EVAL, "detected.json"), JSON.stringify(detected, null, 2));

  /* ── 6) 매칭(반경 = 도면 폭의 2%, 1:1) ── */
  const radius = W * 0.02;
  const usedDetected = new Set();
  const matches = [];
  const missed = [];
  truth.forEach((t) => {
    const { idx, d } = nearestMatch(detected, t, usedDetected);
    if (idx >= 0 && d <= radius) { usedDetected.add(idx); matches.push({ truth: t, detected: detected[idx], d }); }
    else missed.push(t);
  });
  const falsePositives = detected.filter((_, i) => !usedDetected.has(i));
  const recall = truth.length ? matches.length / truth.length : 0;
  const precision = detected.length ? matches.length / detected.length : 0;

  /* ── 7) 실패 유형 분류(단순 휴리스틱 — 좌표 기반) ── */
  const missedByType = {};
  missed.forEach((m) => { missedByType[m.type] = (missedByType[m.type] || 0) + 1; });
  const fpNote = `오검출 ${falsePositives.length}건 — 좌표는 detected.json 참조(그림자/접힘/형광펜/손글씨 노트 여부는 result.png 육안 확인 필요)`;

  /* ── 8) 시각 증거 ── */
  const resultCanvas = createCanvas(W, Hh);
  const rctx = resultCanvas.getContext("2d");
  rctx.drawImage(origCanvas, 0, 0);
  matches.forEach((m) => {
    rctx.strokeStyle = "#999"; rctx.lineWidth = 1.5;
    rctx.beginPath(); rctx.moveTo(m.truth.x, m.truth.y); rctx.lineTo(m.detected.x, m.detected.y); rctx.stroke();
  });
  truth.forEach((t) => {
    rctx.beginPath(); rctx.arc(t.x, t.y, 14, 0, Math.PI * 2);
    rctx.strokeStyle = "#16a34a"; rctx.lineWidth = 3; rctx.stroke();
  });
  detected.forEach((d) => {
    rctx.beginPath(); rctx.arc(d.x, d.y, 10, 0, Math.PI * 2);
    rctx.strokeStyle = "#dc2626"; rctx.lineWidth = 3; rctx.stroke();
  });
  fs.writeFileSync(path.join(EVAL, "result.png"), resultCanvas.toBuffer("image/png"));

  /* ── 9) 보고서 ── */
  const totalMs = Date.now() - t0;
  const report = {
    alignErrPctOfDrawingWidth: Number(avgResidualPctW.toFixed(3)),
    residuals,
    truthCount: truth.length,
    detectedCount: detected.length,
    matchedCount: matches.length,
    recall: Number(recall.toFixed(3)),
    precision: Number(precision.toFixed(3)),
    missedCount: missed.length,
    missedByType,
    falsePositiveCount: falsePositives.length,
    fpNote,
    detectMs,
    totalMs
  };
  fs.writeFileSync(path.join(EVAL, "report.json"), JSON.stringify(report, null, 2));

  console.log("=== markup-eval 결과 ===");
  console.log(`정합 오차(독립 눈금점 평균) = ${report.alignErrPctOfDrawingWidth}% of 도면폭`);
  residuals.forEach((r) => console.log(`  - ${r.label}: ${r.errPx.toFixed(1)}px (${r.errPctOfW.toFixed(3)}%)`));
  console.log(`정답 ${report.truthCount} / 검출 ${report.detectedCount} / 매칭 ${report.matchedCount}`);
  console.log(`recall=${report.recall} precision=${report.precision}`);
  console.log(`missed=${report.missedCount} (유형별 ${JSON.stringify(missedByType)})`);
  console.log(`오검출=${report.falsePositiveCount}`);
  console.log(`detect ${detectMs}ms / total ${totalMs}ms`);
}

main().catch((e) => { console.error(e); process.exit(1); });
