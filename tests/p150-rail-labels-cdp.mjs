/**
 * p150 — 세로 아이콘 레일(#side-toolbar) 글자 라벨 + 호버/포커스 설명 풍선 (실 Chrome, CDP 실측)
 * (프레임워크 0 · 실행: node tests/p150-rail-labels-cdp.mjs)
 *
 * [재현] R1 (지휘자 CDP 실측, 발주서 동일): #side-toolbar .stb-btn 11개 전부 textLen=0,
 *   근본원인 style.css `.side-toolbar .stb-group::before{content:none}`(데스크톱 ≥761px).
 *   이 파일이 그 재현 겸 회귀 테스트다.
 *   [WO 20261016-routeminimap] R2 — "동선" 레일 버튼(data-deleg="btn-route-draw") 1개 추가로
 *   11→12개(index.html "영역" 그룹, RailLabels.LABELS 11_UI.js 에 라벨 등록).
 *
 * 검증:
 *   ① 버튼 12개 전부 .stb-label 텍스트 길이 > 0
 *   ② hover 시 .stb-tip 풍선이 보이고 텍스트가 data-rail-desc(옛 title)와 일치
 *   ③ 라벨 색 대비 >= 4.5:1 (실 computed style 로 계산)
 *   ④ 뮤테이션 모드(P150_MUTATE=1): .stb-label 강제 숨김 -> ①이 다시 실패해야 한다
 *      (이 스크립트는 뮤테이션 모드에서 항상 EXIT=1 — 호출 측이 stdout 의 FAIL 유무로 판정).
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "public");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };

const MUTATE = process.env.P150_MUTATE === "1";

function buildBundle() {
  const MODS = fs.readFileSync(path.join(PUB, "js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  let b = MODS.map((f) => fs.readFileSync(path.join(PUB, "js/modules", f), "utf8").replace(/\r\n/g, "\n")).join("\n");
  if (MUTATE) {
    // 뮤테이션: RailLabels 초기화 자체를 무력화 — 원래 버그(라벨 0) 상태를 재현한다.
    const marker = 'document.addEventListener("DOMContentLoaded", () => RailLabels.init());';
    if (!b.includes(marker)) throw new Error("뮤테이션 지점을 찾지 못함 — 테스트가 소스와 어긋남");
    b = b.replace(marker, "/* MUTATED: RailLabels.init() 호출 제거 */");
  }
  const cut = b.lastIndexOf("})();");
  return b.slice(0, cut) + "\nwindow.__T = { App, State, UI };\n" + b.slice(cut);
}

function buildCss() {
  return fs.readFileSync(path.join(PUB, "css/style.css"), "utf8");
}

const CT = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".svg": "image/svg+xml" };
const json = (res, o, st) => { res.writeHead(st || 200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
const bundle = buildBundle();
const cssContent = buildCss();
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/js/main.js") { res.writeHead(200, { "content-type": "application/javascript" }); res.end(bundle); return; }
  if (u === "/css/style.css") { res.writeHead(200, { "content-type": "text/css" }); res.end(cssContent); return; }
  if (u === "/api/auth/auto-entry") return json(res, { token: "tokT", kind: "designer" });
  if (u === "/api/auth/me") return json(res, { authenticated: true, email: "auto@test.local", name: "auto", role: "super", auto: true });
  if (u === "/api/auth/config") return json(res, { google_client_id: "", demo_login: false });
  if (u === "/api/tenant/resolve") return json(res, { matched: false });
  if (u === "/api/projects") return json(res, { data: [] });
  if (u.startsWith("/api/") || u.startsWith("/tables/")) return json(res, { data: [], settings: {}, value: {} });
  const f = path.join(PUB, u === "/" ? "index.html" : u);
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "content-type": CT[path.extname(f)] || "application/octet-stream" }); res.end(fs.readFileSync(f));
});
await listenSafePort(server, "127.0.0.1");
const port = server.address().port;

let puppeteer = null;
try { puppeteer = createRequire("file:///C:/Users/FREE/package.json")("puppeteer"); } catch (e) { puppeteer = null; }
if (!puppeteer) { ok(false, "puppeteer 없음 - 실 브라우저 검증 불가(증거 없는 PASS 금지)"); process.exit(1); }
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const browser = await puppeteer.launch({ headless: "new", ...(fs.existsSync(CHROME) ? { executablePath: CHROME } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 120000 });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "load" });
await page.waitForFunction(() => window.__T, { timeout: 20000 });
await page.evaluate(() => sessionStorage.setItem("wm_id_token", "tokT"));
await page.reload({ waitUntil: "load" });
await page.waitForFunction(() => window.__T, { timeout: 20000 });
await new Promise((r) => setTimeout(r, 800));

const labelInfo = await page.evaluate(() => {
  const rail = document.getElementById("side-toolbar");
  if (!rail) return { error: "no #side-toolbar" };
  const btns = Array.from(rail.querySelectorAll(".stb-btn"));
  return btns.map((b) => {
    const span = b.querySelector(".stb-label");
    return { id: b.id || b.dataset.deleg || null, labelLen: span ? span.textContent.trim().length : 0, hasDesc: !!b.getAttribute("data-rail-desc") };
  });
});
ok(!labelInfo.error, "#side-toolbar 존재 :: " + JSON.stringify(labelInfo.error || "ok"));
if (!labelInfo.error) {
  // 12→13개: 64a44ce 가 [카메라](btn-theta-osc) 레일 버튼을 추가했다.
  ok(labelInfo.length === 13, "버튼 13개 :: count=" + labelInfo.length);
  const zeroLen = labelInfo.filter((r) => r.labelLen === 0);
  ok(zeroLen.length === 0, "① 12개 전부 라벨 텍스트 길이 > 0 :: zeroLenCount=" + zeroLen.length + (zeroLen.length ? (" ids=" + zeroLen.map((r) => r.id).join(",")) : ""));
  const noDesc = labelInfo.filter((r) => !r.hasDesc);
  ok(noDesc.length === 0, "data-rail-desc(옛 title) 보존 확인 :: noDescCount=" + noDesc.length);
}

if (MUTATE) {
  await browser.close();
  server.close();
  console.log(failed > 0 ? ("뮤테이션 확인: " + failed + "건 FAIL (의도된 결과)") : "뮤테이션인데 FAIL 0건 - 테스트가 무효함");
  process.exit(1);
}

const hoverResult = await page.evaluate(async () => {
  const btn = document.querySelector("[data-deleg=\"btn-zone-rect\"]");
  if (!btn) return { error: "btn-zone-rect 없음" };
  const desc = btn.getAttribute("data-rail-desc");
  btn.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
  await new Promise((r) => setTimeout(r, 50));
  const tip = document.querySelector(".stb-tip");
  const visible = !!(tip && tip.offsetWidth > 0 && tip.offsetHeight > 0 && getComputedStyle(tip).display !== "none");
  const text = tip ? tip.textContent : null;
  btn.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
  await new Promise((r) => setTimeout(r, 150));
  const tipAfterLeave = document.querySelector(".stb-tip");
  return { desc: desc, visible: visible, text: text, matches: text === desc, removedAfterLeave: !tipAfterLeave };
});
ok(!hoverResult.error, "btn-zone-rect 탐색 :: " + JSON.stringify(hoverResult.error || "ok"));
if (!hoverResult.error) {
  ok(hoverResult.visible, "② hover 시 .stb-tip 풍선 visible");
  ok(hoverResult.matches, "② 풍선 텍스트 = data-rail-desc :: text=" + JSON.stringify(hoverResult.text) + " desc=" + JSON.stringify(hoverResult.desc));
  ok(hoverResult.removedAfterLeave, "② mouseleave 후 풍선 제거");
}

const contrastResult = await page.evaluate(() => {
  function parseColor(s) { const m = String(s).match(/rgba?\(([^)]+)\)/); if (!m) return null; const a = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: a[0], g: a[1], b: a[2], a: a.length > 3 ? a[3] : 1 }; }
  function over(f, b) { return { r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a) }; }
  function L(c) { const f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); }
  function ratio(fg, bg) { const fgo = over(fg, bg); const a = L(fgo), b = L(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); }
  const span = document.querySelector("#side-toolbar .stb-label");
  if (!span) return { error: "no .stb-label" };
  const cs = getComputedStyle(span);
  const fg = parseColor(cs.color);
  let bgEl = span, bg = null;
  while (bgEl) { const c = parseColor(getComputedStyle(bgEl).backgroundColor); if (c && c.a > 0) { bg = c; break; } bgEl = bgEl.parentElement; }
  if (!bg) bg = { r: 255, g: 255, b: 255 };
  const r = ratio(fg, bg);
  const fs2 = parseFloat(cs.fontSize) || 9;
  const large = fs2 >= 24;
  return { ratio: +r.toFixed(2), threshold: large ? 3.0 : 4.5, color: cs.color, bg: "rgb(" + bg.r + "," + bg.g + "," + bg.b + ")", fontSize: fs2 };
});
ok(!contrastResult.error, ".stb-label 존재(대비 측정 대상) :: " + JSON.stringify(contrastResult.error || "ok"));
if (!contrastResult.error) {
  ok(contrastResult.ratio >= contrastResult.threshold, "③ 라벨 대비 >=" + contrastResult.threshold + ":1 :: 실측=" + contrastResult.ratio + " color=" + contrastResult.color + " bg=" + contrastResult.bg + " fontSize=" + contrastResult.fontSize);
}

await browser.close();
server.close();
console.log("");
console.log(failed === 0 ? "전체 PASS" : (failed + "건 FAIL"));
process.exit(failed === 0 ? 0 : 1);
