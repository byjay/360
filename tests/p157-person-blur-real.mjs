/**
 * p157-person-blur-real — WO 20261019-personblur-r2 (실 Chrome · 실 TF.js/COCO-SSD 모델 · 실 62_PersonBlur.js)
 * 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p157-person-blur-real.mjs
 * (네트워크 필요 — jsdelivr CDN 에서 tf.js/coco-ssd 모델을 1회 받는다. 오프라인이면 스킵하지 말고
 *  FAIL + 사유를 남긴다 — 증거 없는 PASS 금지)
 *
 * 마스터 제공 실제 기관실/갑판 360 사진(.tmp/pb/p1~p10.jpg, 5376×2688) 중 사람이 있는 p1·p8·p9·p10
 * 과 사람이 없는(기계류 오탐만 있던) p2·p5·p7 을 지휘자가 width=2048 로 축소해
 * tests/fixtures/pb/ 에 커밋(원본은 마스터 제공 민감 사진일 수 있어 저해상도본만 저장).
 *
 * 지휘자 실측(10장 합계, 사람 4명) 기준:
 *   개선 설정(mobilenet_v2, 수평 띠 28~78%, 10조각, 겹침25%, 점수 0.6) → 정답 4/4, 오탐 0.
 *   현재(옛) 설정(lite, 전체 높이, 5조각, 점수 0.5) → 정답 3/4, 오탐 4.
 *
 * 검증: p1/p8/p9/p10 각각 사람 1명(중심 ±3%) · 0.6 이상 오탐 0(p2/p5/p7 포함 전체) ·
 *   겹침 구간 중복(0.31/0.33, 0.60/0.62 류)이 IoU 병합으로 1개로 합쳐짐(= auto 박스 정확히 1개).
 * 뮤테이션: P157R_MUT=legacy → lite_mobilenet_v2 + fullHeight + 5조각/0.5 로 되돌리면 적어도
 *   하나(p1 등 실측상 전체높이·lite 조합에서 놓친 사례)는 미탐 → EXIT=1.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIX = path.join(ROOT, "tests/fixtures/pb");

let failed = 0;
const ok = (cond, label, detail) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null ? " :: " + JSON.stringify(detail).slice(0, 300) : "")); if (!cond) failed++; };

const EXPECT = {
  p1: { x: 0.508, y: 0.526 },
  p8: { x: 0.33, y: null },
  p9: { x: 0.615, y: null },
  p10: { x: 0.62, y: null }
};
const NO_PERSON = ["p2", "p5", "p7"];
const ALL = [...Object.keys(EXPECT), ...NO_PERSON];

for (const n of ALL) {
  if (!fs.existsSync(path.join(FIX, n + ".jpg"))) { console.log("FAIL fixture 없음: " + n + ".jpg"); process.exit(2); }
}

const MUT = process.env.P157R_MUT || "";
const detectOpts = MUT === "legacy"
  ? { sliceCount: 5, overlapFrac: 0.12, confidence: 0.5, fullHeight: true }
  : {};   // 기본값(= 62_PersonBlur.js 의 R2 상수) 그대로 사용
const base = MUT === "legacy" ? "lite_mobilenet_v2" : "mobilenet_v2";

let puppeteer = null;
try { puppeteer = createRequire("file:///C:/Users/FREE/package.json")("puppeteer"); } catch (e) { puppeteer = null; }
if (!puppeteer) { ok(false, "puppeteer 없음 — 실 브라우저 검증 불가(증거 없는 PASS 금지)"); process.exit(1); }
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const browser = await puppeteer.launch({ headless: "new", ...(fs.existsSync(CHROME) ? { executablePath: CHROME } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 180000 });

const PB_SRC = fs.readFileSync(path.join(ROOT, "public/js/modules/62_PersonBlur.js"), "utf8");

try {
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e && e.message)));
  await page.goto("about:blank", { waitUntil: "load" });
  await page.addScriptTag({ url: "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.11.0/dist/tf.min.js" });
  await page.addScriptTag({ url: "https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js" });
  await page.addScriptTag({ content: PB_SRC + "\nwindow.__PB = PersonBlur;" });
  await page.waitForFunction(() => !!(window.cocoSsd && window.__PB), { timeout: 20000 });

  const t0 = Date.now();
  await page.evaluate(async (b) => { window.__model = await window.cocoSsd.load({ base: b }); }, base);
  const loadMs = Date.now() - t0;
  console.log("  [모델 로드] base=" + base + " " + loadMs + "ms");
  await page.evaluate(() => { window.__PB.setDetector(async (c) => { const p = await window.__model.detect(c, 20, 0.2); return p.map((x) => ({ class: x.class, score: x.score, bbox: x.bbox })); }); });

  const results = {};
  for (const n of ALL) {
    const dataUrl = "data:image/jpeg;base64," + fs.readFileSync(path.join(FIX, n + ".jpg")).toString("base64");
    const r = await page.evaluate(async (src, opts) => {
      const img = new Image(); img.src = src; await img.decode();
      const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      const res = await window.__PB.detectPersons(c, opts);
      return { auto: res.auto, review: res.review, W: c.width, H: c.height };
    }, dataUrl, detectOpts);
    results[n] = r;
    console.log("  [" + n + "] auto=" + r.auto.length + " review=" + r.review.length + " " + JSON.stringify(r.auto.map((b) => ({ x: +(b.x / r.W).toFixed(3), y: +(b.y / r.H).toFixed(3), w: +(b.width / r.W).toFixed(3), score: +b.score.toFixed(2) }))));
  }

  for (const n of Object.keys(EXPECT)) {
    const r = results[n];
    ok(r.auto.length === 1, n + " auto 박스 정확히 1개(겹침 중복 IoU 병합 포함)", r.auto);
    if (r.auto.length) {
      const b = r.auto[0];
      const cx = (b.x + b.width / 2) / r.W, cy = (b.y + b.height / 2) / r.H;
      const exp = EXPECT[n];
      ok(Math.abs(cx - exp.x) <= 0.03, n + " 중심 x ±3% (" + exp.x + ")", { cx, exp: exp.x });
      if (exp.y != null) ok(Math.abs(cy - exp.y) <= 0.03, n + " 중심 y ±3% (" + exp.y + ")", { cy, exp: exp.y });
    }
  }
  for (const n of NO_PERSON) {
    ok(results[n].auto.length === 0, n + " 오탐 0(0.6 이상 auto 박스 없음)", results[n].auto);
  }
  const totalAuto = ALL.reduce((s, n) => s + results[n].auto.length, 0);
  ok(totalAuto === Object.keys(EXPECT).length, "10장 합계 auto 박스 수 = 정답 인원수(" + Object.keys(EXPECT).length + ") — 오탐/중복 0", totalAuto);

  ok(errs.length === 0, "페이지 런타임 오류 0건", errs);
} catch (e) {
  console.log("FAIL 예외: " + (e && e.stack || e));
  failed++;
} finally {
  await browser.close();
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
