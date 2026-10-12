// [WO 20261011-viewmode / 지휘자 재발주 2026-10-11] 뷰어 매뉴얼용 실 캡처 — 실 Chrome(CDP) + 실 workerd(Miniflare) + 실 D1/R2.
//   목 0. 모드별(checker/360) 열람 링크를 실제로 발급해 그 링크로 들어가 실제 화면을 찍는다.
//   PC(1280x900)·휴대폰(375x812, 모바일 UA·터치·DPR3) 두 판 모두 찍는다.
//   360 캡처는 텍스처 로드 완료(pano-loading 숨김)를 기다리고, 찍기 직전 document.getAnimations().forEach(a=>a.finish())
//   로 CSS 전환(클립패스 다이브 애니메이션 등)을 강제 종료한 뒤 캡처한다 — 중간 프레임이 찍히는 결함 방지.
// 실행(먼저 dist/_worker.js 가 있어야 한다 — npm run js:assemble && npm run stamp && npm run build:vite):
//   TEMP=<repo>\.tmp TMP=<repo>\.tmp node build-tools/capture-viewer-manual.mjs
// 출력: public/manual/img/{checker,360}/{pc,mobile}/NN-name.png + public/manual/img/install/*.png + .tmp/manual-capture-manifest.json
// 🔴 CLAUDE.md §G-5 — C: 금지, 서버 포트는 8799·8800 피함(safe-listen).
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Miniflare } from "miniflare";
import { listenSafePort } from "../tests/_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const IMG_OUT = path.join(ROOT, "public", "manual", "img");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const MANIFEST_PATH = path.join(ROOT, ".tmp", "manual-capture-manifest.json");
for (const m of ["checker", "360"]) for (const bp of ["pc", "mobile"]) fs.mkdirSync(path.join(IMG_OUT, m, bp), { recursive: true });
fs.mkdirSync(path.join(IMG_OUT, "install"), { recursive: true });

if (!fs.existsSync(path.join(DIST, "_worker.js"))) {
  console.log("FAIL dist/_worker.js 없음 — 먼저: npm run js:assemble && npm run stamp && npm run build:vite");
  process.exit(1);
}
if (!fs.existsSync(CHROME)) { console.log("FAIL Chrome 없음: " + CHROME); process.exit(1); }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const CT = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript", ".mjs": "application/javascript", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
function readDist(pathname) {
  let p = decodeURIComponent(pathname);
  if (p.endsWith("/")) p += "index.html";
  const full = path.join(DIST, p);
  if (!full.startsWith(DIST) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  return { body: fs.readFileSync(full), ct: CT[path.extname(full).toLowerCase()] || "application/octet-stream" };
}
const ROUTES = JSON.parse(fs.readFileSync(path.join(DIST, "_routes.json"), "utf8"));
const globRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
const EXCLUDE = (ROUTES.exclude || []).map(globRe);
/** [p114 exposeForTest 관례 재사용] 앱이 IIFE 라 State/App/PanoViewer 등이 전역이 아니다 — 캡처 스크립트의
 *  Runtime.evaluate 는 window 스코프만 보이므로, 메모리상 응답에만 1줄 주입한다(실 파일 불변·커밋 無). */
function exposeForCapture(bundle) {
  const idx = bundle.lastIndexOf("})();");
  if (idx === -1) return bundle;
  const names = ["State", "App", "UI", "Auth", "PanoViewer", "Coverage", "Requests", "QrPrint", "PinSeries", "Prompt", "TimeLapse", "Compare", "InstallGate"];
  const obj = names.map((n) => n + ": (typeof " + n + " !== 'undefined' ? " + n + " : null)").join(", ");
  return bundle.slice(0, idx) + "\n  try { window.__CAP = { " + obj + " }; } catch (e) { window.__CAP_ERR = String(e); }\n" + bundle.slice(idx);
}

const mf = new Miniflare({
  modules: true, scriptPath: path.join(DIST, "_worker.js"),
  compatibilityDate: "2025-05-01", compatibilityFlags: ["nodejs_compat"],
  d1Databases: { DB: "manual-" + Date.now() }, r2Buckets: { R2: "manualr2-" + Date.now() },
  bindings: { DEMO_LOGIN: "0", SUPER_ADMIN_EMAIL: "designssir@gmail.com", SUPER_ADMIN_EMAILS: "designssir@gmail.com" },
  serviceBindings: {
    ASSETS: async (req) => {
      const u = new URL(req.url);
      const f = readDist(u.pathname);
      if (!f) return new Response("Not Found", { status: 404 });
      return new Response(f.body, { status: 200, headers: { "Content-Type": f.ct } });
    },
  },
});
const db = await mf.getD1Database("DB");
const r2 = await mf.getR2Bucket("R2");
const MIG_DIR = path.join(ROOT, "migrations");
for (const f of fs.readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()) {
  const stmts = fs.readFileSync(path.join(MIG_DIR, f), "utf8").replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  for (const st of stmts) { try { await db.exec(st); } catch (e) {} }
}
const run = (q, a = []) => db.prepare(q).bind(...a).run();

let BASE = "";
const proxy = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, BASE);
    if (EXCLUDE.some((re) => re.test(u.pathname))) {
      const f = readDist(u.pathname);
      if (!f) { res.writeHead(404); res.end("nf"); return; }
      let body = f.body;
      if (u.pathname === "/js/main.js") body = Buffer.from(exposeForCapture(body.toString("utf8")));
      res.writeHead(200, { "Content-Type": f.ct, "Cache-Control": "no-cache" }); res.end(body); return;
    }
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = {}; for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
    const r = await mf.dispatchFetch(BASE + req.url, { method: req.method, headers, body: (req.method === "GET" || req.method === "HEAD") ? undefined : body, redirect: "manual" });
    const buf = Buffer.from(await r.arrayBuffer());
    const outH = {}; r.headers.forEach((v, k) => { if (k !== "content-length" && k !== "transfer-encoding" && k !== "content-encoding") outH[k] = v; });
    res.writeHead(r.status, outH); res.end(buf);
  } catch (e) { try { res.writeHead(500); res.end(String(e && e.message)); } catch (e2) {} }
});
await listenSafePort(proxy, "127.0.0.1");
BASE = "http://127.0.0.1:" + proxy.address().port;
console.log("[server] " + BASE);

/* ══ 시드 — 소유자 디자이너 · 프로젝트(배포) · 도면 · 혼합 핀(체커+360, 360 한 곳은 사진 이력 2장) · 요청 글 ══ */
const OWNER = "manual-owner@seastar.test";
const TOKEN = "local-manual-" + Date.now().toString(36);
const now0 = Date.now();
await run("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, '매뉴얼', 'seed', ?, ?, 0)", [OWNER, now0, now0]);
await run("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, '매뉴얼', 'x', 'h', 's', 1, ?, ?, 0)", [OWNER, now0, now0]);
await run("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOKEN, OWNER, now0, now0 + 8.64e7]);
const api = async (method, url, body) => {
  const r = await mf.dispatchFetch(BASE + url, { method, headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" }, body: body == null ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
};

const DRAWING_PNG = path.join(ROOT, ".tmp", "manualassets", "drawing.png");
const PANO_JPG = path.join(ROOT, "public", "samples", "pano-test-1.jpg");
const PANO_JPG2 = path.join(ROOT, "public", "samples", "pano-test-2.jpg");
const PAGE_KEY = "assets/manual-ga.png", PANO_KEY = "assets/manual-pano.jpg", PANO_KEY2 = "assets/manual-pano2.jpg";
const toAB = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
await r2.put(PAGE_KEY, toAB(fs.readFileSync(DRAWING_PNG)), { httpMetadata: { contentType: "image/png" } });
await r2.put(PANO_KEY, toAB(fs.readFileSync(PANO_JPG)), { httpMetadata: { contentType: "image/jpeg" } });
await r2.put(PANO_KEY2, toAB(fs.readFileSync(PANO_JPG2)), { httpMetadata: { contentType: "image/jpeg" } });
const PAGE_URL = "/api/r2/object/" + PAGE_KEY;

const PRJ = "prj_manual_demo";
await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted, published, published_by) VALUES (?, '매뉴얼 캡처용 프로젝트', '', ?, ?, ?, 0, 1, ?)", [PRJ, OWNER, now0, now0, OWNER]);
const IMG_ID = "img_manual_demo", IMG_ID2 = "img_manual_demo2";
await run("INSERT INTO pano_images (id, name, image_data, created_at, updated_at, deleted, tenant_id) VALUES (?, '360샘플', ?, ?, ?, 0, 'tnt_default')", [IMG_ID, "/api/r2/object/" + PANO_KEY, now0, now0]);
await run("INSERT INTO pano_images (id, name, image_data, created_at, updated_at, deleted, tenant_id) VALUES (?, '360샘플(이전)', ?, ?, ?, 0, 'tnt_default')", [IMG_ID2, "/api/r2/object/" + PANO_KEY2, now0 - 86400000 * 30, now0 - 86400000 * 30]);
const DAY = 86400000;
const pins = [
  { id: "p1", x: 18, y: 20, page: 1, checkboard: true, no: 1, label: "1번 점검구" },
  { id: "p2", x: 38, y: 24, page: 1, checkboard: true, no: 2, label: "2번 소화기함" },
  { id: "p3", x: 62, y: 22, page: 1, checkboard: true, no: 3, label: "3번 배관 밸브" },
  {
    id: "p4", x: 26, y: 72, page: 1, imageId: IMG_ID, imageUrl: "/api/r2/object/" + PANO_KEY, label: "D구역 선수부 360", shotAt: now0,
    timeline: [
      { id: "tl0", label: "1차(지난달)", imageId: IMG_ID2, imageUrl: "/api/r2/object/" + PANO_KEY2, shotAt: now0 - 30 * DAY },
      { id: "tl1", label: "2차(최신)", imageId: IMG_ID, imageUrl: "/api/r2/object/" + PANO_KEY, shotAt: now0 },
    ],
  },
  { id: "p5", x: 70, y: 70, page: 1, imageId: IMG_ID, imageUrl: "/api/r2/object/" + PANO_KEY, label: "E구역 선미부 360", shotAt: now0 },
];
const DEP = "dep_manual_demo";
await run("INSERT INTO deployments (id, title, file_name, pages_data, pins, zones, annotations, created_at, updated_at, deleted, version, project_id, tenant_id) VALUES (?, 'GA 매뉴얼', 'ga.png', ?, ?, '[]', '[]', ?, ?, 0, 1, ?, 'tnt_default')",
  [DEP, JSON.stringify([PAGE_URL]), JSON.stringify(pins), now0, now0, PRJ]);
await run("INSERT INTO decks (id, project_id, name, deployment_id, created_at, updated_at, deleted) VALUES ('dk_manual_demo', ?, '원본', ?, ?, ?, 0)", [PRJ, DEP, now0, now0]);
await run("UPDATE projects SET original_deployment_id = ? WHERE id = ?", [DEP, PRJ]);
await run("INSERT INTO pin_notes (id, deployment_id, pin_id, pin_label, body, status, author, author_email, author_role, created_at, updated_at, deleted, kind) VALUES ('note_manual_1', ?, 'p1', '1', '배관 부식 확인 필요합니다', 'open', '현장', ?, 'viewer', ?, ?, 0, 'request')", [DEP, "field@seastar.test", now0, now0]);

const lkC = await api("POST", "/api/view-links", { dep_id: DEP, mode: "checker" });
const lk3 = await api("POST", "/api/view-links", { dep_id: DEP, mode: "360" });
if (lkC.status !== 200 || lk3.status !== 200) { console.log("FAIL 링크 발급 실패", lkC, lk3); process.exit(1); }
const urlFor = (lkId) => BASE + "/?mode=viewer&d=" + DEP + "&lk=" + lkId.j.id;

/* ══ Chrome + CDP ══ */
const profileDir = path.join(ROOT, ".tmp", "manual-chrome-" + Date.now());
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", "--user-data-dir=" + profileDir, "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
async function devtoolsPort() {
  for (let i = 0; i < 80; i++) {
    try { const p = parseInt(fs.readFileSync(path.join(profileDir, "DevToolsActivePort"), "utf8").split("\n")[0], 10); if (p > 0) return p; } catch (e) {}
    await wait(150);
  }
  throw new Error("DevToolsActivePort 없음");
}
const getJson = (url) => new Promise((resolve, reject) => http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on("error", reject));
const port = await devtoolsPort();
let pageWs = null;
for (let i = 0; i < 40 && !pageWs; i++) { try { const l = await getJson("http://127.0.0.1:" + port + "/json/list"); const pg = l.find((t) => t.type === "page"); if (pg) pageWs = pg.webSocketDebuggerUrl; } catch (e) {} if (!pageWs) await wait(250); }
const ws = new WebSocket(pageWs);
await new Promise((r) => ws.on("open", r));
let idc = 0;
const pending = new Map();
ws.on("message", (raw) => { const msg = JSON.parse(raw); if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); } });
// 🔴 CDP 호출은 전부 15s 상한 — 응답 없는 호출(예: 대화상자에 막힌 페이지) 하나가 스크립트 전체를 영구 정지시키지 않게 한다.
const send = (method, params = {}) => {
  const id = ++idc;
  return Promise.race([
    new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }),
    new Promise((_, rej) => setTimeout(() => { pending.delete(id); rej(new Error("CDP timeout 15s: " + method)); }, 15000)),
  ]);
};
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");

const ev = async (expression) => {
  const r = await Promise.race([send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }), new Promise((_, rej) => setTimeout(() => rej(new Error("eval timeout: " + expression.slice(0, 60))), 20000))]);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text || "";
    throw new Error("eval failed @ " + expression.slice(0, 60) + " :: " + String(desc).slice(0, 500));
  }
  return r.result.value;
};
const evSafe = async (e) => { try { return await ev(e); } catch (er) { return { __err: String(er.message) }; } };
const waitFor = async (cond, timeout = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await evSafe("(function(){try{return !!(" + cond + ")}catch(e){return false}})()") === true) return true; await wait(150); }
  return false;
};
/** [지휘자 발견 2026-10-12] 38b_InstallGate.js — 로그인 사용자 대상 강제 설치 게이트인데
 *  shouldGate() 의 Auth.user 판정이 익명 열람 토큰(auto+readonly)에도 걸린다(/api/auth/me 가
 *  _auto 토큰도 authenticated:true 로 응답 — 설계 주석의 "비로그인=Auth.user 없음" 가정이 깨짐).
 *  실제 프로덕션 버그로 추정되나 이 WO 범위 밖 — 전체 화면을 가려 캡처가 안 돼 아래로 우회만 한다.
 *  (별도 보고 필요: 익명 공유 링크 모바일 방문자가 전부 강제 설치 화면에 막힐 수 있다) */
const navigate = async (url) => {
  await send("Page.navigate", { url }); await wait(600); await waitFor("document.readyState === 'complete'", 10000);
  await evSafe("window.__CAP && window.__CAP.InstallGate && window.__CAP.InstallGate.hide && window.__CAP.InstallGate.hide()");
};
/** [지휘자 지시] 찍기 직전 — 진행 중 CSS 전환·애니메이션을 강제 종료(중간 프레임 방지) */
const finishAnimations = () => evSafe("document.getAnimations().forEach(function(a){try{a.finish()}catch(e){}}); 1");

const CALLOUT_JS = `(function(items){
  var old = document.getElementById('__manual_cal'); if (old) old.remove();
  var host = document.createElement('div'); host.id = '__manual_cal';
  host.style.cssText = 'position:fixed;inset:0;z-index:999999;pointer-events:none';
  items.forEach(function(it){
    var el = it.sel ? document.querySelector(it.sel) : null;
    var x = it.x, y = it.y;
    if (el) { var r = el.getBoundingClientRect(); x = r.left + r.width/2; y = r.top + r.height/2; }
    if (x == null) return;
    var dot = document.createElement('div');
    dot.style.cssText = 'position:absolute;left:'+(x-15)+'px;top:'+(y-15)+'px;width:30px;height:30px;border-radius:50%;background:#dc2626;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;font-family:sans-serif;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.5)';
    dot.textContent = String(it.n);
    host.appendChild(dot);
  });
  document.body.appendChild(host);
})`;
const callout = async (items) => { await ev(CALLOUT_JS + "(" + JSON.stringify(items) + ")"); };
const clearCallout = async () => { await evSafe("(function(){var o=document.getElementById('__manual_cal');if(o)o.remove()})()"); };

let shotN = {};
const shot = async (mode, bp, name, calloutItems) => {
  await finishAnimations();
  if (calloutItems) await callout(calloutItems);
  await wait(120);
  const s = await send("Page.captureScreenshot", { format: "png" });
  if (calloutItems) await clearCallout();
  const key = mode + "/" + bp;
  shotN[key] = (shotN[key] || 0) + 1;
  const fname = String(shotN[key]).padStart(2, "0") + "-" + name + ".png";
  const dir = path.join(IMG_OUT, mode, bp);
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, fname);
  fs.writeFileSync(full, Buffer.from(s.data, "base64"));
  return { file: "img/" + mode + "/" + bp + "/" + fname, bytes: fs.statSync(full).size, at: new Date().toISOString() };
};

const setViewportPC = () => send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
const setViewportMobile = () => send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 3, mobile: true });
const setMobileUA = () => send("Network.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36", platform: "Android" });
const setDesktopUA = () => send("Network.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36", platform: "Win32" });
const tap = async (x, y) => { await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, radiusX: 4, radiusY: 4, force: 1, id: 1 }] }); await wait(40); await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); };
const dragMouse = async (x0, y0, x1, y1, steps) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", buttons: 1 });
  for (let i = 1; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps, y = y0 + ((y1 - y0) * i) / steps;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    await wait(16);
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y: y1, button: "left", buttons: 0 });
};

const manifest = { generatedAt: new Date().toISOString(), checker: { pc: [], mobile: [] }, "360": { pc: [], mobile: [] }, install: [] };
const watchdog = setTimeout(() => { console.log("WATCHDOG 260s 초과 — 강제 종료"); try { chrome.kill(); } catch (e) {} process.exit(1); }, 260000);
/** 한 단계가 멈춰도(응답 없는 CDP 호출 등) 전체를 막지 않도록 — 실패해도 기록만 남기고 다음 단계로 진행 */
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout " + ms + "ms: " + label)), ms))]);
const safeStep = async (label, fn) => {
  console.log("[step] " + label);
  try { await withTimeout(fn(), 20000, label); } catch (e) { console.log("  [skip] " + label + " :: " + String(e && e.message).slice(0, 150)); }
};

/** [재현·수정] 뷰어 화면엔 설계자용 pap-card/pap-view 가 없다 — 11_UI.js 1806행 핀 클릭 핸들러는
 *  뷰어에서 App.onPinTap(pin) 을 부른다: 1탭 = focusPinIso(확대), **같은 핀 2탭째라야** 미디어 있으면
 *  App.openPano(pin), 없으면(CHECKER) Requests.openViewer({pin,noMedia:true}) 가 열린다(20_App.js:3151-3159).
 *  클릭 좌표 시뮬레이션 대신 그 실제 함수를 직접 호출한다 — 같은 코드 경로·같은 렌더링, 더 안정적. */
async function openPanoByPinId(pinId) {
  await ev("var C=window.__CAP; var p=(C.State.pins||[]).find(function(x){return x.id==='" + pinId + "'}); if (p) C.App.openPano(p);");
  const loaded = await waitFor("document.getElementById('pano-canvas') && !document.getElementById('pano-canvas').classList.contains('hidden')", 12000);
  await wait(300);
  return loaded;
}
async function openRequestFormByPinId(pinId) {
  await ev("var C=window.__CAP; var p=(C.State.pins||[]).find(function(x){return x.id==='" + pinId + "'}); if (p && C.Requests) C.Requests.openViewer({ pin: p, noMedia: true });");
  await wait(500);
}
async function closePano() {
  await evSafe("document.getElementById('btn-pano-close') && document.getElementById('btn-pano-close').click()");
  await wait(400);
}
async function closeRequestForm() {
  await evSafe("window.__CAP && window.__CAP.Requests && window.__CAP.Requests.closePanel && window.__CAP.Requests.closePanel()");
  await wait(300);
}

/** ══ 공용 플로우 — mode('checker'|'360') × bp('pc'|'mobile') ══ */
async function runChecker(bp) {
  await navigate(urlFor(lkC));
  await waitFor("document.querySelectorAll('.pin-marker').length > 0", 12000);
  manifest.checker[bp].push(await shot("checker", bp, "entry", [{ sel: ".pin-marker", n: 1 }]));
  await ev("document.getElementById('tq-menu') && document.getElementById('tq-menu').click()");
  await wait(400);
  manifest.checker[bp].push(await shot("checker", bp, "sidebar-tree", [{ sel: "#side-toolbar, .side-toolbar", n: 1 }]));
  await ev("document.getElementById('tq-menu') && document.getElementById('tq-menu').click()");
  await wait(300);
  manifest.checker[bp].push(await shot("checker", bp, "checker-pins", [{ sel: ".pin-marker", n: 1 }]));
  // 1탭 — 포커스+확대(App.focusPinIso, 11_UI.js 마커 클릭 핸들러 1탭째 동작)
  await ev("var m = document.querySelector('.pin-marker[data-id=\\'p1\\']'); if (m) m.click();");
  await wait(500);
  manifest.checker[bp].push(await shot("checker", bp, "pin-focused", [{ sel: ".pin-marker[data-id='p1']", n: 1 }]));
  // 요청·질문 폼 — CHECKER(미디어 없음) 핀의 실제 2탭째 동작을 App.onPinTap 과 동일한 함수로 직접 재현
  await openRequestFormByPinId("p1");
  manifest.checker[bp].push(await shot("checker", bp, "request-form", []));
  await closeRequestForm();
  if (bp === "pc") {
    await ev("document.getElementById('btn-allpins') ? document.getElementById('btn-allpins').click() : (typeof AllPins !== 'undefined' && AllPins.open && AllPins.open())");
    await wait(500);
    manifest.checker[bp].push(await shot("checker", bp, "pin-list", [{ sel: "#allpins-list, #allpins-drawer", n: 1 }]));
    await ev("document.getElementById('btn-allpins-close') && document.getElementById('btn-allpins-close').click()");
    await wait(300);
  }
  await ev("document.querySelector('[data-help-toggle]') && document.querySelector('[data-help-toggle]').click()");
  await wait(400);
  manifest.checker[bp].push(await shot("checker", bp, "help-mode", [{ sel: "[data-help-toggle]", n: 1 }]));
  await ev("document.querySelector('[data-help-toggle]') && document.querySelector('[data-help-toggle].active, [data-help-toggle]') && document.querySelector('[data-help-toggle]').click()");
}

async function run360(bp) {
  await navigate(urlFor(lk3));
  await waitFor("document.querySelectorAll('.pin-marker').length > 0", 12000);
  manifest["360"][bp].push(await shot("360", bp, "entry", [{ sel: ".pin-marker", n: 1 }]));
  manifest["360"][bp].push(await shot("360", bp, "pano-pins", [{ sel: ".pin-marker", n: 1 }]));

  // 1탭 — 포커스+확대
  await ev("var m = document.querySelector('.pin-marker[data-id=\\'p4\\']'); if (m) m.click();");
  await wait(500);
  manifest["360"][bp].push(await shot("360", bp, "pin-focused", [{ sel: ".pin-marker[data-id='p4']", n: 1 }]));

  // 360 뷰어 열기(App.openPano 직접 호출 — 실 2탭 동작과 동일 함수) — 텍스처 로드 완료를 기다린다
  const ok = await openPanoByPinId("p4");
  if (ok) {
    manifest["360"][bp].push(await shot("360", bp, "pano-viewer", []));
    // 드래그(둘러보기)
    const cx = bp === "pc" ? 640 : 187, cy = bp === "pc" ? 450 : 400;
    await dragMouse(cx, cy, cx - 160, cy - 40, 10);
    await wait(250);
    manifest["360"][bp].push(await shot("360", bp, "pano-drag", []));
    // 확대(휠)
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: cx, y: cy, deltaX: 0, deltaY: -200 });
    await wait(250);
    manifest["360"][bp].push(await shot("360", bp, "pano-zoom", [{ sel: "#pano-radar", n: 1 }]));
    // 자동 회전
    await ev("window.__CAP && window.__CAP.PanoViewer && window.__CAP.PanoViewer.toggleAuto && window.__CAP.PanoViewer.toggleAuto()");
    await wait(700);
    manifest["360"][bp].push(await shot("360", bp, "pano-autorotate", []));
    await evSafe("window.__CAP && window.__CAP.PanoViewer && window.__CAP.PanoViewer.S && window.__CAP.PanoViewer.S.autoRotate && window.__CAP.PanoViewer.toggleAuto()");
    // 사진 이력(시점 바) — p4 는 timeline 2개를 시드했다
    const hasTl = await waitFor("document.getElementById('pano-timeline') && !document.getElementById('pano-timeline').classList.contains('hidden')", 4000);
    if (hasTl) {
      manifest["360"][bp].push(await shot("360", bp, "photo-history", [{ sel: "#tl-chips", n: 1 }]));
      const hasCmp = await evSafe("document.getElementById('btn-tl-compare') && !document.getElementById('btn-tl-compare').classList.contains('hidden')");
      if (hasCmp === true) {
        await ev("document.getElementById('btn-tl-compare') && document.getElementById('btn-tl-compare').click()");
        const cmpOpen = await waitFor("document.getElementById('pano-compare-360') && !document.getElementById('pano-compare-360').classList.contains('hidden')", 6000);
        if (cmpOpen) {
          await wait(500);
          manifest["360"][bp].push(await shot("360", bp, "pano-compare", []));
          await evSafe("document.getElementById('btn-cmp360-close') && document.getElementById('btn-cmp360-close').click()");
          await wait(300);
        }
      }
    }
    // 이전/다음(파노 간 이동)
    const hasNav = await waitFor("document.getElementById('pano-nav') && !document.getElementById('pano-nav').classList.contains('hidden')", 2000);
    if (hasNav) {
      await ev("document.getElementById('btn-pano-next') && document.getElementById('btn-pano-next').click()");
      await waitFor("document.getElementById('pano-canvas') && !document.getElementById('pano-canvas').classList.contains('hidden')", 8000);
      await wait(400);
      manifest["360"][bp].push(await shot("360", bp, "pano-nav-next", [{ sel: "#pano-nav", n: 1 }]));
    }
    await closePano();
  } else {
    manifest["360"][bp].push(await shot("360", bp, "pano-viewer-loading", []));
    await closePano();
  }

  // 촬영 현황(Coverage)
  const covOn = await evSafe("window.__CAP && window.__CAP.Coverage ? (window.__CAP.Coverage.toggle(true), true) : false");
  if (covOn === true) {
    await wait(500);
    manifest["360"][bp].push(await shot("360", bp, "coverage-status", [{ sel: "#cov-toggle", n: 1 }]));
    await evSafe("window.__CAP && window.__CAP.Coverage && window.__CAP.Coverage.toggle(false)");
  }

  await ev("document.querySelector('[data-help-toggle]') && document.querySelector('[data-help-toggle]').click()");
  await wait(400);
  manifest["360"][bp].push(await shot("360", bp, "help-mode", [{ sel: "[data-help-toggle]", n: 1 }]));
}

/** 한 패스가 도중에 실패해도(응답 없는 CDP 호출 등) 나머지 패스는 계속 진행 — 부분 산출물이라도 남긴다. */
const guarded = async (label, fn) => { console.log("[pass] " + label + " 시작"); try { await fn(); console.log("[pass] " + label + " 완료"); } catch (e) { console.log("[pass] " + label + " 실패 :: " + String(e && e.message).slice(0, 600)); } };

/* ══ PC 패스 ══ */
await setViewportPC(); await setDesktopUA();
await guarded("checker/pc", () => runChecker("pc"));
await guarded("360/pc", () => run360("pc"));

/* ══ 모바일 패스(375×812, DPR3, 터치, 모바일 UA) ══ */
await setViewportMobile(); await setMobileUA();
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await guarded("checker/mobile", () => runChecker("mobile"));
await guarded("360/mobile", () => run360("mobile"));
await setViewportPC(); await setDesktopUA();

/* ══ 오프라인 보관 · 앱 설치(PWA) — 실제 배너 컴포넌트를 강제 노출해 캡처(조직적 트리거 경로가 없어 banner.hidden 해제로 노출) ══ */
await guarded("install/pwa-banner", async () => {
  await navigate(urlFor(lkC));
  await waitFor("document.querySelectorAll('.pin-marker').length > 0", 10000);
  await setViewportMobile();
  await ev("var b=document.getElementById('pwa-install-banner'); if(b) b.classList.remove('hidden');");
  await wait(300);
  manifest.install.push(await shot("install", "mobile", "pwa-banner", [{ sel: "#pwa-install-banner", n: 1 }]));
  await evSafe("var b=document.getElementById('pwa-install-banner'); if(b) b.classList.add('hidden');");
  await setViewportPC();
});
// APK 설치 안내 5단계 — 지휘자 지시대로 .tmp/fixapk/ 기존 실 캡처(375 안드로이드 설치 가이드) 재사용
{
  const FIXAPK = path.join(ROOT, ".tmp", "fixapk");
  const steps = [
    ["step1-download.png", "apk-1-download"],
    ["step2-blocker.png", "apk-2-blocker"],
    ["step3-unknown.png", "apk-3-unknown-source"],
    ["step4-protect.png", "apk-4-protect"],
    ["step5-done.png", "apk-5-done"],
  ];
  for (const [src, name] of steps) {
    const srcPath = path.join(FIXAPK, src);
    if (!fs.existsSync(srcPath)) continue;
    const destName = String(manifest.install.length + 1).padStart(2, "0") + "-" + name + ".png";
    fs.copyFileSync(srcPath, path.join(IMG_OUT, "install", destName));
    manifest.install.push({ file: "img/install/" + destName, bytes: fs.statSync(srcPath).size, at: new Date().toISOString(), reused: true });
  }
}

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
console.log("[manifest] " + MANIFEST_PATH);
console.log("checker pc=" + manifest.checker.pc.length + " mobile=" + manifest.checker.mobile.length +
  " / 360 pc=" + manifest["360"].pc.length + " mobile=" + manifest["360"].mobile.length +
  " / install=" + manifest.install.length);

clearTimeout(watchdog);
try { chrome.kill(); } catch (e) {}
try { ws.close(); } catch (e) {}
proxy.close();
await mf.dispose();
process.exit(0);
