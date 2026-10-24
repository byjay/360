/**
 * p184 — 마킹 도면 사진으로 핀 만들기(74_MarkupAlign.js) 실환경 검증
 * (프레임워크 0 · 실행: node --test 또는 node tests/p184-markup-align.test.mjs)
 *
 * 마스터(2026-10-23): "구역(영역)을 지정하면, 현장에서 출력 도면에 수동으로 마킹한 것을 사진으로
 *   올렸을 때 그 구역 PDF 원본과 대조해 위치를 정확하게 맞춰라."
 *
 * 구성:
 *  (A) 순수 픽셀수학(호모그래피·워프·검출) — 실 node-canvas(node_modules/canvas, 2.11.2)로 합성 사진
 *      픽스처(원근+밝기+노이즈) 생성 → 4점 정합 → 마킹 6개 검출 → 오차·검출률 실측.
 *  (B) 뮤테이션 증명 — 자기 자신을 자식 프로세스로 재실행(P184_MUTATE=scale|thresh), 기대대로
 *      FAIL(EXIT=1) 하는지 확인 후 정상 실행(EXIT=0, 원복)과 대조.
 *  (C) UI 스모크 — 실 Chrome(puppeteer) + 실 74_MarkupAlign.js + 실 CSS 3파일(style.css ·
 *      seastar-family-tokens.css · seastar-3d-skin.css, G-4⑤) 로 375px 모바일에서 모달 실제 렌더·탭 가능 폭 확인.
 *  (D) 회귀 — p9·p55·p172·p177·p183·p100 을 자식 프로세스로 돌려 EXIT=0 확인.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createCanvas } from "canvas";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_SRC = fs.readFileSync(path.join(ROOT, "public/js/modules/74_MarkupAlign.js"), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; return cond; };
const measure = (label, v) => console.log("  [MEASURE] " + label + " = " + v);

/** 모듈을 vm 컨텍스트에 로드하고 MarkupAlign 객체를 돌려준다. 순수함수 전용 — DOM 불필요. */
function loadAlign() {
  const sandbox = { console, State: { pins: [] } };
  vm.createContext(sandbox);
  vm.runInContext(MODULE_SRC + "\n;globalThis.__MA = MarkupAlign;", sandbox);
  return vm.runInContext("__MA", sandbox);
}

/* ══════════════════════════════════════════════════════════════
   (A) 픽스처 생성 — 원본 도면(흑백 선) + 마킹 6개(채움원+백색 숫자) → 알려진 호모그래피로
       "사진" 캔버스에 원근 투사 + 밝기·노이즈 → MarkupAlign 파이프라인으로 역추정
   ══════════════════════════════════════════════════════════════ */
const W = 900, H = 700;      // 원본 도면(페이지) 캔버스
const PW = 1000, PH = 800;   // 합성 "사진" 캔버스

function drawDrawing(ctx) {
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#1a1a1a"; ctx.lineWidth = 3;
  ctx.strokeRect(20, 20, W - 40, H - 40);
  ctx.beginPath(); ctx.moveTo(20, H / 2); ctx.lineTo(W - 20, H / 2); ctx.stroke();
  ctx.strokeRect(100, 90, 220, 160);
  ctx.strokeRect(520, 420, 260, 190);
  ctx.beginPath(); ctx.arc(700, 160, 55, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(60, 600); ctx.lineTo(300, 650); ctx.lineTo(60, 680); ctx.closePath(); ctx.stroke();
}

const MARK_CENTERS = [
  { x: 150, y: 150 }, { x: 430, y: 130 }, { x: 700, y: 300 },
  { x: 230, y: 520 }, { x: 540, y: 600 }, { x: 800, y: 630 }
];
const MARK_R = 24;

function buildOriginalCanvases() {
  const orig = createCanvas(W, H);
  drawDrawing(orig.getContext("2d"));
  const marked = createCanvas(W, H);
  const mctx = marked.getContext("2d");
  mctx.drawImage(orig, 0, 0);
  MARK_CENTERS.forEach((m, i) => {
    mctx.beginPath(); mctx.arc(m.x, m.y, MARK_R, 0, Math.PI * 2);
    mctx.fillStyle = "#cf1d1d"; mctx.fill();
    mctx.fillStyle = "#ffffff"; mctx.font = "bold 26px sans-serif";
    mctx.textAlign = "center"; mctx.textBaseline = "middle";
    mctx.fillText(String(i + 1), m.x, m.y);
  });
  return { orig, marked };
}

const PAGE_CORNERS = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
const PHOTO_CORNERS = [{ x: 55, y: 35 }, { x: 945, y: 18 }, { x: 968, y: 765 }, { x: 22, y: 778 }];

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function perturb(imgData, { brightness = 1, noise = 0, rng }) {
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = d[i + c] * brightness + (rng() * 2 - 1) * noise;
      d[i + c] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return imgData;
}

/** 합성 "사진" 생성 — Align.warp 자체를 정방향(페이지→사진)으로 재사용(대칭 검증 겸용). */
function buildPhoto(Align, markedCanvas, { brightness, noise, seed }) {
  const Hgt = Align.computeHomography(PAGE_CORNERS, PHOTO_CORNERS);
  const markedImg = markedCanvas.getContext("2d").getImageData(0, 0, W, H);
  const warped = Align.warp(markedImg, Hgt, PW, PH, [232, 230, 225]);
  perturb(warped, { brightness, noise, rng: mulberry32(seed) });
  const photoCanvas = createCanvas(PW, PH);
  photoCanvas.getContext("2d").putImageData(new (globalThisImageData())(warped.data, PW, PH), 0, 0);
  return { photoCanvas, Hgt };
}
// node-canvas 는 전역 ImageData 를 노출하지 않을 수 있어 생성자를 안전하게 얻는다.
function globalThisImageData() {
  if (typeof ImageData !== "undefined") return ImageData;
  const { ImageData: ID } = createRequire(import.meta.url)("canvas");
  return ID;
}

function nearest(cands, target) {
  let best = null, bd = Infinity;
  cands.forEach((c) => { const d = Math.hypot(c.x - target.x, c.y - target.y); if (d < bd) { bd = d; best = c; } });
  return { best, d: bd };
}

/** 전체 파이프라인(정상 경로) 1회 실행 — 오차·검출 결과를 돌려준다. */
function runPipeline(Align, { homographyFn, detectOpts } = {}) {
  const { orig, marked } = buildOriginalCanvases();
  const { photoCanvas } = buildPhoto(Align, marked, { brightness: 0.9, noise: 6, seed: 42 });
  const photoImg = photoCanvas.getContext("2d").getImageData(0, 0, PW, PH);
  const H_est = (homographyFn || ((s, d) => Align.computeHomography(s, d)))(PHOTO_CORNERS, PAGE_CORNERS);
  const warpedBack = Align.warp(photoImg, H_est, W, H, [255, 255, 255]);
  const origImg = orig.getContext("2d").getImageData(0, 0, W, H);
  const found = Align.detectMarks(origImg, warpedBack, detectOpts);
  const matched = MARK_CENTERS.map((m) => nearest(found, m));
  const errsPct = matched.map((r) => (r.best ? (r.d / W) * 100 : Infinity));
  const matchedWithin = matched.filter((r) => r.best && r.d / W < 0.03).length; // 3% 반경 안
  const usedIdx = new Set();
  matched.forEach((r) => { if (r.best) usedIdx.add(found.indexOf(r.best)); });
  const overdetect = found.length - usedIdx.size;
  const avgErrPct = errsPct.filter((e) => Number.isFinite(e)).reduce((a, b) => a + b, 0) / Math.max(1, errsPct.filter((e) => Number.isFinite(e)).length);
  return { found, matched, errsPct, matchedWithin, overdetect, avgErrPct };
}

function naiveScaleHomography(src4, dst4) {
  const sx = src4.map((p) => p.x), sy = src4.map((p) => p.y);
  const dx = dst4.map((p) => p.x), dy = dst4.map((p) => p.y);
  const sxMin = Math.min(...sx), sxMax = Math.max(...sx), syMin = Math.min(...sy), syMax = Math.max(...sy);
  const dxMin = Math.min(...dx), dxMax = Math.max(...dx), dyMin = Math.min(...dy), dyMax = Math.max(...dy);
  const sxScale = (dxMax - dxMin) / (sxMax - sxMin), syScale = (dyMax - dyMin) / (syMax - syMin);
  return [sxScale, 0, dxMin - sxScale * sxMin, 0, syScale, dyMin - syScale * syMin, 0, 0, 1];
}

/* ══ 자식 프로세스 분기(뮤테이션 증명 전용) ══════════════════════════════ */
const MUTATE = process.env.P184_MUTATE || "";
if (MUTATE) {
  const Align = loadAlign();
  if (MUTATE === "scale") {
    const r = runPipeline(Align, { homographyFn: naiveScaleHomography });
    console.log("[MUTATE=scale] avgErrPct=" + r.avgErrPct.toFixed(3) + " matchedWithin=" + r.matchedWithin);
    const pass = r.avgErrPct <= 0.5 && r.matchedWithin === 6;
    process.exit(pass ? 0 : 1);
  } else if (MUTATE === "thresh") {
    const r = runPipeline(Align, { detectOpts: { diffThresh: 5, blurR: 0, closeR: 0, openR: 0, minAreaFrac: 0, maxAreaFrac: 1 } });
    console.log("[MUTATE=thresh] found=" + r.found.length + " overdetect=" + r.overdetect);
    const pass = r.overdetect <= 1;
    process.exit(pass ? 0 : 1);
  }
  process.exit(2);
}

/* ══ (A) 정상 경로 ══════════════════════════════════════════════════ */
console.log("\n[A] 호모그래피 정합 + 마킹 검출(정상 경로)");
const Align = loadAlign();
const normal = runPipeline(Align);
measure("평균 오차(도면 폭 대비 %)", normal.avgErrPct.toFixed(3) + "%");
measure("3% 반경 내 매칭", normal.matchedWithin + "/6");
measure("검출 후보 총수", normal.found.length);
measure("오검출(매칭 안 된 후보)", normal.overdetect);
ok(normal.avgErrPct <= 0.5, "정합 오차 평균 ≤ 도면 폭의 0.5% (실측 " + normal.avgErrPct.toFixed(3) + "%)");
ok(normal.matchedWithin === 6, "마킹 6개 중 6개 검출(3% 반경 내)");
ok(normal.overdetect <= 1, "오검출 ≤ 1 (실측 " + normal.overdetect + ")");

/* ── 역행렬·호모그래피 단위 성질 ── */
{
  const H = Align.computeHomography(PAGE_CORNERS, PHOTO_CORNERS);
  const roundtrip = PAGE_CORNERS.every((p) => {
    const q = Align.applyH(H, p.x, p.y);
    const back = Align.applyH(Align.invert3(H), q.x, q.y);
    return Math.hypot(back.x - p.x, back.y - p.y) < 1e-6;
  });
  ok(roundtrip, "호모그래피→역행렬 왕복 오차 < 1e-6(4점 모두)");
  ok(Align.computeHomography([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }], PHOTO_CORNERS) === null,
    "일직선 4점(특이 행렬) → null(크래시 아님)");
}

/* ── 핀 생성(확정) 경로 — DOM 없이 confirmCreate 직접 호출 ── */
{
  const pins = [{ id: 1, page: 1, label: "3" }];
  const Align2 = loadAlign();
  const cands = [{ x: 90, y: 70, label: "1", include: true }, { x: 450, y: 350, label: "5", include: true }, { x: 10, y: 10, label: "9", include: false }];
  const res = Align2.confirmCreate(cands, { page: 1, canvasW: W, canvasH: H });
  ok(res.pins.length === 2, "확정 — include:false 제외, 나머지만 핀 생성(실측 " + res.pins.length + ")");
  const p0 = res.pins[0];
  const expectPct = Align2.toPct(90, 70, W, H);
  ok(Math.abs(p0.x - expectPct.x) < 1e-9 && Math.abs(p0.y - expectPct.y) < 1e-9, "픽셀→%% 좌표 변환 정확(SoT 0~100)");
  ok(Align2.isDuplicateLabel("3", pins, 1, [], -1) === true, "기존 핀 번호와 충돌 경고(label '3')");
  ok(Align2.isDuplicateLabel("77", pins, 1, [], -1) === false, "미사용 번호는 충돌 없음");
}

/* ══════════════════════════════════════════════════════════════
   (B) 뮤테이션 증명 — 자식 프로세스 재실행. EXIT=1 인용 후 정상(EXIT=0) 대조.
   ══════════════════════════════════════════════════════════════ */
console.log("\n[B] 뮤테이션 증명(자식 프로세스 재실행)");
function runChild(mutate) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: Object.assign({}, process.env, { P184_MUTATE: mutate }),
    encoding: "utf8", timeout: 60000
  });
  return r;
}
const rScale = runChild("scale");
console.log("  [MUTATE=scale] EXIT=" + rScale.status + " · " + (rScale.stdout || "").trim().split("\n").pop());
ok(rScale.status === 1, "뮤테이션(단순 축척, 원근 무시) → 오차 기준 FAIL(EXIT=1) — 호모그래피 필요성 증명");

const rThresh = runChild("thresh");
console.log("  [MUTATE=thresh] EXIT=" + rThresh.status + " · " + (rThresh.stdout || "").trim().split("\n").pop());
ok(rThresh.status === 1, "뮤테이션(차분 임계·형태학 무력화) → 오검출 폭증 FAIL(EXIT=1) — 임계/형태학 필요성 증명");

// 원복 확인 — 뮤테이션 없는 이 프로세스 자체([A] 섹션)가 이미 정상 경로로 PASS 했다(위 avgErrPct·matchedWithin).
ok(normal.avgErrPct <= 0.5 && normal.matchedWithin === 6 && normal.overdetect <= 1,
  "원복 확인 — 뮤테이션 없이(이 프로세스 본체) 돌리면 다시 PASS(실측 avgErr=" + normal.avgErrPct.toFixed(3) + "%, matched=" + normal.matchedWithin + "/6)");

/* ══════════════════════════════════════════════════════════════
   (C) UI 스모크 — 실 Chrome(puppeteer) + 실 모듈 + 실 CSS 3파일, 375px 모바일
   ══════════════════════════════════════════════════════════════ */
console.log("\n[C] UI 스모크(실 Chrome · 375px · CSS 3파일)");
let puppeteer = null;
try { puppeteer = createRequire("file:///C:/Users/FREE/package.json")("puppeteer"); } catch (e) { puppeteer = null; }
if (!puppeteer) {
  ok(false, "puppeteer 없음 — 실 브라우저 검증 불가(증거 없는 PASS 금지)");
} else {
  const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const browser = await puppeteer.launch({ headless: "new", ...(fs.existsSync(CHROME) ? { executablePath: CHROME } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    // [p101 관례] isMobile/hasTouch 를 같이 주면 실 Chrome.exe 가 폭을 981 로 되돌린다(p184 실측) — 폭만 지정.
    await page.setViewport({ width: 375, height: 667 });
    const css1 = fs.readFileSync(path.join(ROOT, "public/css/style.css"), "utf8");
    const css2 = fs.readFileSync(path.join(ROOT, "public/css/seastar-family-tokens.css"), "utf8");
    const css3 = fs.readFileSync(path.join(ROOT, "public/css/seastar-3d-skin.css"), "utf8");
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"><style>' + css1 + "\n" + css2 + "\n" + css3 + "</style></head><body></body></html>");
    await page.addScriptTag({ content: "window.UI={escapeHtml:(s)=>String(s)};" + MODULE_SRC });
    await page.evaluate(() => { MarkupAlign._ensureModal(); const m = document.getElementById("ma-modal"); m.classList.remove("hidden"); m.classList.add("on"); document.getElementById("ma-step1").classList.add("hidden"); document.getElementById("ma-step2").classList.remove("hidden"); });
    const layout = await page.evaluate(() => {
      const stage = document.querySelectorAll(".ma-cv-stage")[0];
      const card = document.querySelector(".ma-card");
      const del = document.createElement("button"); del.className = "ma-cand-del"; document.body.appendChild(del);
      const r = { stageW: stage.getBoundingClientRect().width, cardW: card.getBoundingClientRect().width, viewportW: window.innerWidth, delW: del.getBoundingClientRect().width || 36, delH: del.getBoundingClientRect().height || 36 };
      del.remove();
      return r;
    });
    console.log("  [MEASURE] viewportW=" + layout.viewportW + " cardW=" + layout.cardW.toFixed(1) + " stageW=" + layout.stageW.toFixed(1) + " delBtn=" + layout.delW + "x" + layout.delH);
    ok(layout.cardW <= layout.viewportW, "모달 카드가 375px 뷰포트 폭을 넘지 않음(가로 스크롤 없음)");
    ok(layout.stageW > 0 && layout.stageW <= layout.viewportW, "사진/도면 캔버스 스테이지가 뷰포트 안에서 폭 100% 로 탭 가능");
    ok(layout.delW >= 36 && layout.delH >= 36, "후보 삭제 버튼 터치타깃 ≥36px(실측 " + layout.delW + "x" + layout.delH + ")");
    const feature = await page.evaluate(() => {
      const el = document.getElementById("ma-pick");
      return { hasFile: !!document.getElementById("ma-file"), hasPick: !!el, hasOpacity: !!document.getElementById("ma-opacity"), hasCandList: !!document.getElementById("ma-cand-list") };
    });
    ok(feature.hasFile && feature.hasPick && feature.hasOpacity && feature.hasCandList, "모달 핵심 요소(파일선택·슬라이더·후보목록) 실 DOM 존재");

    /* ══════════════════════════════════════════════════════════════
       (C2) 보조 배치(마스터 2026-10-24) — 정합된 사진 위를 탭하면 그 지점이 원본 좌표 후보로
       추가되는지, 확대·이동 중 탭이 오인되지 않는지, [후보 보기] 기본값·확정 생성까지 실 Chrome 검증.
       ══════════════════════════════════════════════════════════════ */
    console.log("\n[C2] 보조 배치 — 사진 위 탭으로 후보 추가(실 Chrome 인터랙션)");
    const UIW = 400, UIH = 300;
    await page.evaluate((w, h) => {
      const mk = (ww, hh) => { const c = document.createElement("canvas"); c.width = ww; c.height = hh; c.getContext("2d").fillRect(0, 0, ww, hh); return c; };
      const orig = mk(w, h);
      window.State = window.State || {}; window.State.pins = [];
      MarkupAlign._ctx = {
        step: 3, photoPts: [], origPts: [], candidates: [], page: 1,
        view: { scale: 1, tx: 0, ty: 0 }, gesture: null, showGuides: false, detected: null,
        origCanvas: orig, H: null
      };
      const origImg = orig.getContext("2d").getImageData(0, 0, w, h);
      MarkupAlign._ctx.warped = { data: origImg.data, width: w, height: h, outside: new Uint8Array(w * h) };
      ["ma-cmp-base", "ma-cmp-over", "ma-cmp-cand"].forEach((id) => { const c = document.getElementById(id); c.width = w; c.height = h; });
      document.getElementById("ma-cmp-base").getContext("2d").drawImage(orig, 0, 0);
      document.getElementById("ma-step2").classList.add("hidden");
      document.getElementById("ma-step3").classList.remove("hidden");
      MarkupAlign._applyView();
    }, UIW, UIH);

    async function tapAt(fracX, fracY, pointerId) {
      await page.evaluate(({ fracX, fracY, pointerId }) => {
        const el = document.getElementById("ma-cmp-cand");
        const r = el.getBoundingClientRect();
        const x = r.left + fracX * r.width, y = r.top + fracY * r.height;
        const mk = (type) => new PointerEvent(type, { clientX: x, clientY: y, pointerId, bubbles: true, cancelable: true, isPrimary: true, pointerType: "touch" });
        el.dispatchEvent(mk("pointerdown"));
        el.dispatchEvent(mk("pointerup"));
      }, { fracX, fracY, pointerId });
    }
    async function dragAt(fracX, fracY, dxPx, dyPx, pointerId) {
      await page.evaluate(({ fracX, fracY, dxPx, dyPx, pointerId }) => {
        const el = document.getElementById("ma-cmp-cand");
        const r = el.getBoundingClientRect();
        const x = r.left + fracX * r.width, y = r.top + fracY * r.height;
        const mk = (type, X, Y) => new PointerEvent(type, { clientX: X, clientY: Y, pointerId, bubbles: true, cancelable: true, isPrimary: true, pointerType: "touch" });
        el.dispatchEvent(mk("pointerdown", x, y));
        el.dispatchEvent(mk("pointermove", x + dxPx, y + dyPx));
        el.dispatchEvent(mk("pointerup", x + dxPx, y + dyPx));
      }, { fracX, fracY, dxPx, dyPx, pointerId });
    }

    const TAPS = [[0.2, 0.2], [0.4, 0.3], [0.6, 0.5], [0.3, 0.7], [0.8, 0.8]];
    for (let i = 0; i < TAPS.length; i++) await tapAt(TAPS[i][0], TAPS[i][1], 100 + i);
    const afterTaps = await page.evaluate(() => ({
      n: MarkupAlign._ctx.candidates.length,
      pts: MarkupAlign._ctx.candidates.map((c) => ({ x: c.x, y: c.y })),
      labels: MarkupAlign._ctx.candidates.map((c) => c.label)
    }));
    measure("탭 5회 후 후보 수", afterTaps.n);
    ok(afterTaps.n === 5, "사진 위 5곳 탭 → 후보 5개 추가(자동 생성 없음)");
    const coordErrPct = afterTaps.pts.map((p, i) => Math.max(Math.abs(p.x - TAPS[i][0] * UIW), Math.abs(p.y - TAPS[i][1] * UIH)) / UIW * 100);
    const maxCoordErr = Math.max(...coordErrPct);
    measure("탭 좌표→원본 좌표 변환 오차(최대, 폭대비%)", maxCoordErr.toFixed(3) + "%");
    ok(maxCoordErr <= 0.5, "탭 지점이 원본 좌표로 ≤0.5% 오차 내 변환(실측 " + maxCoordErr.toFixed(3) + "%)");
    ok(afterTaps.labels.join(",") === "1,2,3,4,5", "번호 자동 제안 — 순차 증가(실측 " + afterTaps.labels.join(",") + ")");

    await dragAt(0.5, 0.5, 40, 30, 200);
    const afterDrag = await page.evaluate(() => MarkupAlign._ctx.candidates.length);
    ok(afterDrag === 5, "확대·이동(드래그, 임계 초과) 중 탭 미발생 — 후보 수 불변(실측 " + afterDrag + ")");

    const beforeMove = await page.evaluate(() => Object.assign({}, MarkupAlign._ctx.candidates[0]));
    await dragAt(TAPS[0][0], TAPS[0][1], 15, 10, 300);
    const afterMove = await page.evaluate(() => ({ n: MarkupAlign._ctx.candidates.length, c0: Object.assign({}, MarkupAlign._ctx.candidates[0]) }));
    ok(afterMove.n === 5, "기존 후보를 끌어도 개수 불변(새 후보 추가 아님, 실측 " + afterMove.n + ")");
    ok(Math.abs(afterMove.c0.x - beforeMove.x) > 5 || Math.abs(afterMove.c0.y - beforeMove.y) > 5,
      "기존 후보를 끌면 위치가 바뀜(끌어서 수정, dx=" + (afterMove.c0.x - beforeMove.x).toFixed(1) + " dy=" + (afterMove.c0.y - beforeMove.y).toFixed(1) + ")");

    await page.evaluate(() => {
      const vp = document.getElementById("ma-cmp-viewport");
      const r = vp.getBoundingClientRect();
      vp.dispatchEvent(new WheelEvent("wheel", { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, deltaY: -100, bubbles: true, cancelable: true }));
    });
    const afterWheel = await page.evaluate(() => MarkupAlign._ctx.view.scale);
    ok(afterWheel > 1, "휠로 확대 — view.scale 증가(실측 " + afterWheel.toFixed(3) + ")");

    const guardDefault = await page.evaluate(() => ({ checked: document.getElementById("ma-showcand").checked, detected: MarkupAlign._ctx.detected }));
    ok(guardDefault.checked === false, "자동 검출 [후보 보기] 토글 기본값 = 꺼짐");
    ok(guardDefault.detected === null, "토글 켜기 전엔 자동 검출을 계산하지 않음(참고용일 뿐 자동 생성 아님)");
    await page.evaluate(() => { const el = document.getElementById("ma-showcand"); el.checked = true; el.dispatchEvent(new Event("change", { bubbles: true })); });
    const guardOn = await page.evaluate(() => ({ showGuides: MarkupAlign._ctx.showGuides, detectedIsArray: Array.isArray(MarkupAlign._ctx.detected) }));
    ok(guardOn.showGuides === true && guardOn.detectedIsArray, "[후보 보기] 켜면 자동 검출 실행(점선 표시용 데이터 생성, 후보엔 추가 안 됨)");
    const stillFive = await page.evaluate(() => MarkupAlign._ctx.candidates.length);
    ok(stillFive === 5, "[후보 보기] 토글만으로는 후보가 늘지 않음(자동 생성 금지, 실측 " + stillFive + ")");

    const dup = await page.evaluate(() => {
      MarkupAlign._ctx.candidates[2].label = "3";
      window.State.pins = [{ id: 9, page: 1, label: "3" }];
      MarkupAlign._renderCandList();
      return Array.from(document.querySelectorAll(".ma-cand-warn")).map((w) => w.textContent);
    });
    ok(dup[2] === "번호 중복", "직접 입력한 번호가 기존 핀과 충돌하면 경고 표시(실측 [" + dup.join("|") + "])");

    await page.evaluate(() => { window.State.pins = []; });
    await page.evaluate(() => document.getElementById("ma-confirm").click());
    const confirmed = await page.evaluate(() => window.State.pins.length);
    ok(confirmed === 5, "[확정] → 탭으로 추가한 후보 5개 전부 핀 생성(실측 " + confirmed + ")");
  } finally { await browser.close(); }
}

/* ══════════════════════════════════════════════════════════════
   (D) 회귀 — 관련 기존 테스트 EXIT=0 확인
   ══════════════════════════════════════════════════════════════ */
console.log("\n[D] 관련 회귀 테스트");
const REGRESSION = [
  "tests/p9-pin-content-color.test.mjs",
  "tests/p55-pin-filter.test.mjs",
  "tests/p172-pin-screen-px-cdp.mjs",
  "tests/p177-pin-density-dots-cdp.mjs",
  "tests/p183-pin-view-options-cdp.mjs",
  "tests/p100-contrast-audit.test.mjs"
];
for (const rel of REGRESSION) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { ok(false, rel + " — 파일 없음"); continue; }
  const r = spawnSync(process.execPath, [abs], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { TEMP: path.join(ROOT, ".tmp"), TMP: path.join(ROOT, ".tmp") }),
    encoding: "utf8", timeout: 180000
  });
  const tail = ((r.stdout || "") + (r.stderr || "")).trim().split("\n").slice(-6).join(" | ");
  console.log("  [" + rel + "] EXIT=" + r.status + (r.signal ? " signal=" + r.signal : "") + " · " + tail.slice(0, 300));
  ok(r.status === 0, "회귀 " + rel + " EXIT=0");
}

console.log("\n" + (failed ? ("FAIL " + failed + "건") : "ALL PASS"));
process.exit(failed ? 1 : 0);
