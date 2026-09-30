/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p92-hubcard-fit-and-mobile-hint.test.mjs)
 *
 * [재현] 지휘자 실측(라이브 8aa2c162):
 *  1) 허브 카드를 클릭해 도면을 열면(App.openApp→loadLatestDeployment, 트리 구역/영역·openOriginal
 *     과 달리 31_Projects._applyDeckCropView 를 거치지 않는 유일한 진입점) zoom=1/pan=0(identity)
 *     그대로 남아 도면 왼쪽 위 여백부터 보인다(100%, "비어 보임").
 *  2) 모바일 375px 360 뷰어 하단 힌트에 데스크톱 힌트(.hint-mouse-only)와 터치 힌트
 *     (.hint-touch-only)가 동시에 보이고 좌우로 잘린다 — 근본원인: `.pano-hint span`
 *     (특이도 0,1,1)이 `.hint-mouse-only`/`.hint-touch-only`(0,1,0)보다 항상 이겨
 *     display:none 을 무력화한다(순서 무관, 특이도로 결정).
 *
 * Part A — 실 Chrome(puppeteer) + 실제 public/js/modules 전체 번들 + 실제 index.html/CSS 3종.
 *   App.openApp("viewer", {project}) 직접 호출(허브 카드 클릭이 호출하는 것과 동일한 진입점) →
 *   화면 맞춤(zoom) 여부 실측 + 데스크톱 스크린샷.
 * Part B — 실 Chrome, 3개 CSS 파일을 그대로 로드한 최소 마크업(index.html 의 #pano-hint 그대로)에
 *   pointer:coarse 에뮬레이션 + 375px 뷰포트로 실제 computed style 측정 + 스크린샷.
 * 뮤테이션 — 소스를 메모리에서만 되돌려 각 검사가 실패함을 증명(파일 미변경).
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "public");
const ARTIFACT_DIR = path.join(ROOT, ".tmp", "fixfit");
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODS = fs.readFileSync(path.join(PUB, "js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
function buildBundle(mutate = (f, s) => s) {
  let b = MODS.map((f) => mutate(f, fs.readFileSync(path.join(PUB, "js/modules", f), "utf8").replace(/\r\n/g, "\n"))).join("\n");
  const cut = b.lastIndexOf("})();");
  return b.slice(0, cut) + "\nwindow.__T = { MapCtrl, App, Projects, State, PDF };\n" + b.slice(cut);
}
const DRAWING = "data:image/jpeg;base64," + fs.readFileSync(path.join(PUB, "images/pano-sample.jpg")).toString("base64");
const DECKS = [
  { id: "dkRoot", project_id: "prjT", name: "floor", parent_id: null, deployment_id: "depRoot", crop: null, page: 1, deleted: 0 },
];
const CT = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/json" };
async function serve(bundle) {
  const json = (res, o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  const server = http.createServer(async (req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    if (u === "/sw.js") { res.writeHead(404); res.end(); return; }
    if (u === "/js/main.js") { res.writeHead(200, { "content-type": "application/javascript" }); res.end(bundle); return; }
    if (u === "/api/auth/auto-entry") return json(res, { token: "tokT", kind: "viewer" });
    if (u === "/api/auth/me") return json(res, { authenticated: true, email: "auto@test.local", name: "auto", role: "viewer", auto: true });
    if (u === "/api/auth/config") return json(res, { google_client_id: "", demo_login: false });
    if (u === "/api/tenant/resolve") return json(res, { matched: false });
    if (u === "/api/projects") return json(res, { data: [{ id: "prjT", name: "tes", created_at: 1, published: false }] });
    if (u === "/api/projects/prjT/decks") return json(res, { data: DECKS });
    const m = u.match(/^\/tables\/deployments\/(.+)$/);
    if (m && req.method === "GET") {
      await sleep(120);
      return json(res, { id: m[1], title: m[1], file_name: "floor.pdf", pages_data: JSON.stringify([DRAWING]), pins: "[]", zones: "[]", annotations: "[]", version: 1, source_meta: null });
    }
    if (u.startsWith("/api/") || u.startsWith("/tables/")) return json(res, { data: [], settings: {}, value: {} });
    const f = path.join(PUB, u === "/" ? "index.html" : u);
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "content-type": CT[path.extname(f)] || "application/octet-stream" }); res.end(fs.readFileSync(f));
  });
  await listenSafePort(server, "127.0.0.1");
  return server;
}
let puppeteer = null;
try { puppeteer = createRequire("file:///C:/Users/FREE/package.json")("puppeteer"); } catch (e) { puppeteer = null; }
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
let browser = null;
if (puppeteer) {
  browser = await puppeteer.launch({ headless: "new", ...(fs.existsSync(CHROME) ? { executablePath: CHROME } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}

/** Part A — 허브 카드 클릭과 동일한 진입점(App.openApp)으로 도면을 열고 화면 맞춤 여부 실측 */
async function partA(label, bundle, shot) {
  console.log("\n[" + label + "]");
  if (!browser) { ok(false, "puppeteer 를 로드할 수 없다 — 실 브라우저 검증 불가"); return; }
  const server = await serve(bundle);
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto("http://127.0.0.1:" + server.address().port + "/", { waitUntil: "load" });
    await page.waitForFunction(() => !!(window.__T && window.__T.App && window.__T.App.openApp), { timeout: 15000 });
    await page.evaluate(() => window.__T.App.openApp("viewer", { project: { id: "prjT", name: "tes" } }));
    await page.waitForFunction(() => window.__T.State.fileType === "image", { timeout: 15000 });
    await sleep(1200);   // 이미지 onload → _showMapViewport → fit 애니메이션(380ms) 정착 대기
    const r = await page.evaluate(() => {
      const { MapCtrl, State } = window.__T;
      const vw = MapCtrl.viewport.clientWidth, vh = MapCtrl.viewport.clientHeight;
      const cw = MapCtrl.transform.offsetWidth, ch = MapCtrl.transform.offsetHeight;
      const sw = cw * State.zoom, sh = ch * State.zoom;
      return { transform: getComputedStyle(MapCtrl.transform).transform, zoom: State.zoom, pan: { ...State.pan }, vw, vh, cw, ch,
        fitMax: Math.max(sw / vw, sh / vh) };
    });
    console.log("  " + JSON.stringify(r));
    if (shot) await page.screenshot({ path: path.join(ARTIFACT_DIR, shot) });
    // 화면 맞춤(MapCtrl.fit, pad .92)이 적용됐으면 긴 변 기준 채움 비율이 대략 92% 근방(≤100%) —
    // 버그(identity) 상태는 zoom=1 & pan={0,0} 그대로라 fitMax 가 이와 전혀 다르게 나온다(도면 원본이 캔버스보다 큼).
    ok(r.transform !== "matrix(1, 0, 0, 1, 0, 0)" || (r.pan.x !== 0 || r.pan.y !== 0), `identity(zoom=1,pan=0,0) 아님 — 맞춤 적용됨 :: ${JSON.stringify(r)}`);
    ok(r.fitMax > 0.5 && r.fitMax <= 1.01, `화면 맞춤 비율 fitMax=${r.fitMax.toFixed(3)} (0.5~1.01 기대, pad .92)`);
  } finally { await page.close(); server.close(); }
}

console.log("=== 회귀: 허브 카드(App.openApp→loadLatestDeployment) 진입 시 화면 맞춤 — 실 Chrome ===");
await partA("A. 정상 번들", buildBundle(), "desktop-hubcard-open.png");

/* ══════════════════════════ Part B · 모바일 360 힌트 — 실 CSS 캐스케이드 ══════════════════════════ */
const HINT_HTML = fs.readFileSync(path.join(PUB, "index.html"), "utf8").match(/<div id="pano-hint"[\s\S]*?<\/div>/);
async function serveHintFixture(cssOverride) {
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    if (u === "/fixture.html") {
      const html = `<!doctype html><html><head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="stylesheet" href="/css/style.css">
        <link rel="stylesheet" href="/css/seastar-family-tokens.css">
        <link rel="stylesheet" href="/css/seastar-3d-skin.css">
        </head><body>${HINT_HTML[0].replace("hidden", "")}</body></html>`;
      res.writeHead(200, { "content-type": "text/html" }); res.end(html); return;
    }
    const f = path.join(PUB, u);
    if (!f.startsWith(PUB) || !fs.existsSync(f)) { res.writeHead(404); res.end("nf"); return; }
    let body = fs.readFileSync(f);
    if (cssOverride && u === "/css/style.css") body = Buffer.from(cssOverride(body.toString("utf8")), "utf8");
    res.writeHead(200, { "content-type": CT[path.extname(f)] || "application/octet-stream" }); res.end(body);
  });
  await listenSafePort(server, "127.0.0.1");
  return server;
}
async function partB(label, cssOverride, shot) {
  console.log("\n[" + label + "]");
  if (!browser) { ok(false, "puppeteer 를 로드할 수 없다"); return; }
  ok(!!HINT_HTML, "index.html 에서 #pano-hint 마크업 추출됨");
  if (!HINT_HTML) return;
  const server = await serveHintFixture(cssOverride);
  const page = await browser.newPage();
  try {
    // puppeteer Page#emulateMediaFeatures 는 pointer 를 지원하지 않는다(허용 목록:
    // prefers-color-scheme/prefers-reduced-motion/color-gamut, CDP Emulation.setEmulatedMedia
    // 직접 호출도 이 Chrome 빌드에선 pointer 를 반영하지 않음 — 실측 확인). isMobile+hasTouch
    // 뷰포트(실기기 에뮬레이션)는 Chrome이 자동으로 pointer:coarse 를 매긴다(실측 확인).
    await page.setViewport({ width: 375, height: 200, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.goto("http://127.0.0.1:" + server.address().port + "/fixture.html", { waitUntil: "load" });
    const r = await page.evaluate(() => {
      const mouse = document.querySelector(".hint-mouse-only");
      const touch = document.querySelector(".hint-touch-only");
      const hint = document.getElementById("pano-hint");
      const hr = hint.getBoundingClientRect();
      return {
        mouseDisplay: getComputedStyle(mouse).display,
        touchDisplay: getComputedStyle(touch).display,
        left: hr.left, right: hr.right, vw: window.innerWidth,
      };
    });
    console.log("  " + JSON.stringify(r));
    if (shot) await page.screenshot({ path: path.join(ARTIFACT_DIR, shot) });
    ok(r.mouseDisplay === "none", `pointer:coarse(터치) → .hint-mouse-only display=none (실제: ${r.mouseDisplay})`);
    ok(r.touchDisplay !== "none", `pointer:coarse(터치) → .hint-touch-only display≠none (실제: ${r.touchDisplay})`);
    ok(r.left >= -1 && r.right <= r.vw + 1, `375px 뷰포트 안에 들어옴(잘리지 않음) left=${r.left.toFixed(1)} right=${r.right.toFixed(1)} vw=${r.vw}`);
  } finally { await page.close(); server.close(); }
}
console.log("\n=== 회귀: 모바일 360 힌트 — 실 CSS 캐스케이드(pointer:coarse, 375px) ===");
await partB("B. 정상 CSS", null, "mobile-pano-hint.png");

/* ══════════════════════════ 뮤테이션(메모리에서만) ══════════════════════════ */
async function mutateA(label, needle, repl) {
  const appSrc = fs.readFileSync(path.join(PUB, "js/modules/20_App.js"), "utf8").replace(/\r\n/g, "\n");
  const hit = appSrc.includes(needle);
  ok(hit, label + " — 대상 존재");
  if (!hit) return;
  const before = failed;
  const logs = []; const orig = console.log; console.log = (...a) => logs.push(a.join(" "));
  try {
    await partA("MUT " + label, buildBundle((f, s) => (f === "20_App.js" ? s.replace(needle, repl) : s)));
  } catch (e) { failed++; logs.push("  FAIL(throw) " + e.message); }
  console.log = orig;
  const caught = failed > before; failed = before;
  ok(caught, label + (caught ? " → 실패함(실효성 증명)" : " → 🔴 잡지 못함"));
}
async function mutateB(label, needle, repl) {
  const cssSrc = fs.readFileSync(path.join(PUB, "css/style.css"), "utf8");
  const hit = cssSrc.includes(needle);
  ok(hit, label + " — 대상 존재");
  if (!hit) return;
  const before = failed;
  const logs = []; const orig = console.log; console.log = (...a) => logs.push(a.join(" "));
  try {
    await partB("MUT " + label, (s) => s.replace(needle, repl));
  } catch (e) { failed++; logs.push("  FAIL(throw) " + e.message); }
  console.log = orig;
  const caught = failed > before; failed = before;
  ok(caught, label + (caught ? " → 실패함(실효성 증명)" : " → 🔴 잡지 못함"));
}
console.log("\n[뮤테이션]");
if (browser) {
  await mutateA("M1 loadLatestDeployment 의 fit 호출 제거",
    'try { if (typeof PDF !== "undefined" && PDF.setDeckCrop) PDF.setDeckCrop(null); } catch (e) {}\n          try { if (typeof MapCtrl !== "undefined" && MapCtrl.fit) MapCtrl.fit(); } catch (e) {}',
    "");
  await mutateB("M2 .pano-hint 특이도 수정 되돌리기(근본원인 재현)",
    ".pano-hint .hint-touch-only { display: none; }\n@media (pointer: coarse) {\n  .pano-hint .hint-mouse-only { display: none; }\n  .pano-hint .hint-touch-only { display: inline-flex; }\n}",
    ".hint-touch-only { display: none; }\n@media (pointer: coarse) {\n  .hint-mouse-only { display: none; }\n  .hint-touch-only { display: inline-flex; }\n}");
}

if (browser) await browser.close();
console.log("\n" + (failed ? `❌ FAIL: ${failed}건` : "✅ ALL PASS"));
process.exit(failed ? 1 : 0);
