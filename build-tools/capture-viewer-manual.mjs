// [WO 20261011-viewmode] 뷰어 매뉴얼용 실 캡처 — 실 Chrome(CDP) + 실 workerd(Miniflare) + 실 D1/R2.
//   목 0. 모드별(checker/360) 열람 링크를 실제로 발급해 그 링크로 들어가 실제 화면을 찍는다.
// 실행(먼저 dist/_worker.js 가 있어야 한다 — npm run js:assemble && npm run stamp && npm run build:vite):
//   TEMP=<repo>\.tmp TMP=<repo>\.tmp node build-tools/capture-viewer-manual.mjs
// 출력: public/manual/img/{checker,360}/NN-name.png + .tmp/manual-capture-manifest.json
// 🔴 CLAUDE.md §G-5 — C: 금지, 서버 포트는 8799·8800 피함(safe-listen).
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Miniflare } from "miniflare";
import { listenSafePort } from "../tests/_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const IMG_OUT = path.join(ROOT, "public", "manual", "img");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const MANIFEST_PATH = path.join(ROOT, ".tmp", "manual-capture-manifest.json");
fs.mkdirSync(path.join(IMG_OUT, "checker"), { recursive: true });
fs.mkdirSync(path.join(IMG_OUT, "360"), { recursive: true });

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
      res.writeHead(200, { "Content-Type": f.ct }); res.end(f.body); return;
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

/* ══ 시드 — 소유자 디자이너 · 프로젝트(배포) · 도면 · 혼합 핀(체커+360) · 요청 글 ══ */
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
const PAGE_KEY = "assets/manual-ga.png", PANO_KEY = "assets/manual-pano.jpg";
const toAB = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
await r2.put(PAGE_KEY, toAB(fs.readFileSync(DRAWING_PNG)), { httpMetadata: { contentType: "image/png" } });
await r2.put(PANO_KEY, toAB(fs.readFileSync(PANO_JPG)), { httpMetadata: { contentType: "image/jpeg" } });
const PAGE_URL = "/api/r2/object/" + PAGE_KEY;

const PRJ = "prj_manual_demo";
await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted, published, published_by) VALUES (?, '매뉴얼 캡처용 프로젝트', '', ?, ?, ?, 0, 1, ?)", [PRJ, OWNER, now0, now0, OWNER]);
const IMG_ID = "img_manual_demo";
await run("INSERT INTO pano_images (id, name, image_data, created_at, updated_at, deleted, tenant_id) VALUES (?, '360샘플', ?, ?, ?, 0, 'tnt_default')", [IMG_ID, "/api/r2/object/" + PANO_KEY, now0, now0]);
const pins = [
  { id: "p1", x: 18, y: 20, page: 1, checkboard: true, no: 1, label: "1번 점검구" },
  { id: "p2", x: 38, y: 24, page: 1, checkboard: true, no: 2, label: "2번 소화기함" },
  { id: "p3", x: 62, y: 22, page: 1, checkboard: true, no: 3, label: "3번 배관 밸브" },
  { id: "p4", x: 26, y: 72, page: 1, imageId: IMG_ID, imageUrl: "/api/r2/object/" + PANO_KEY, label: "D구역 선수부 360" },
  { id: "p5", x: 70, y: 70, page: 1, imageId: IMG_ID, imageUrl: "/api/r2/object/" + PANO_KEY, label: "E구역 선미부 360" },
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

/* ══ Chrome + CDP (PC 1280x900) ══ */
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
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++idc; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

const ev = async (expression) => {
  const r = await Promise.race([send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }), new Promise((_, rej) => setTimeout(() => rej(new Error("eval timeout: " + expression.slice(0, 60))), 20000))]);
  if (r.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
};
const evSafe = async (e) => { try { return await ev(e); } catch (er) { return { __err: String(er.message) }; } };
const waitFor = async (cond, timeout = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await evSafe("(function(){try{return !!(" + cond + ")}catch(e){return false}})()") === true) return true; await wait(150); }
  return false;
};
const navigate = async (url) => { await send("Page.navigate", { url }); await wait(600); await waitFor("document.readyState === 'complete'", 10000); };

/** 콜아웃(번호 원) 주입 — selector 배열의 중심에 숫자 원을 그린다. 찍은 뒤 제거는 호출부가 한다. */
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
const shot = async (mode, name, calloutItems) => {
  if (calloutItems) await callout(calloutItems);
  await wait(150);
  const s = await send("Page.captureScreenshot", { format: "png" });
  if (calloutItems) await clearCallout();
  shotN[mode] = (shotN[mode] || 0) + 1;
  const fname = String(shotN[mode]).padStart(2, "0") + "-" + name + ".png";
  const full = path.join(IMG_OUT, mode, fname);
  fs.writeFileSync(full, Buffer.from(s.data, "base64"));
  return { file: "img/" + mode + "/" + fname, bytes: fs.statSync(full).size, at: new Date().toISOString() };
};

const manifest = { generatedAt: new Date().toISOString(), breakpoint: "1280x900(PC)", checker: [], ["360"]: [] };

/* ══ CHECKER 트랙 ══ */
{
  await navigate(urlFor(lkC));
  await waitFor("window.__T || true", 3000);
  await waitFor("document.querySelectorAll('.pin-marker').length > 0", 12000);
  manifest.checker.push(await shot("checker", "entry", [{ sel: ".pin-marker", n: 1 }]));
  await ev("document.getElementById('tq-menu') && document.getElementById('tq-menu').click()");
  await wait(400);
  manifest.checker.push(await shot("checker", "sidebar-tree", [{ sel: "#side-toolbar, #project-tree, .side-toolbar", n: 1 }]));
  await ev("document.getElementById('tq-menu') && document.getElementById('tq-menu').click()");
  await wait(300);
  const markers = await evSafe("document.querySelectorAll('.pin-marker').length");
  manifest.checker.push(await shot("checker", "checker-pins", [{ sel: ".pin-marker", n: 1 }]));
  await ev("var m = document.querySelector('.pin-marker[data-id=\\'p1\\']'); if (m) m.click();");
  await wait(500);
  manifest.checker.push(await shot("checker", "pin-popup", [{ sel: "#pap-card", n: 1 }]));
  await ev("document.getElementById('pap-close') && document.getElementById('pap-close').click()");
  await wait(300);
  await ev("document.getElementById('btn-allpins') ? document.getElementById('btn-allpins').click() : (typeof AllPins !== 'undefined' && AllPins.open && AllPins.open())");
  await wait(500);
  manifest.checker.push(await shot("checker", "pin-list", [{ sel: "#allpins-list, #allpins-drawer", n: 1 }]));
  await ev("document.getElementById('btn-allpins-close') && document.getElementById('btn-allpins-close').click()");
  await wait(300);
  await ev("document.querySelector('[data-help-toggle]') && document.querySelector('[data-help-toggle]').click()");
  await wait(400);
  manifest.checker.push(await shot("checker", "help-mode", [{ sel: "[data-help-toggle]", n: 1 }]));
}

/* ══ 360 트랙 ══ */
{
  await navigate(urlFor(lk3));
  await waitFor("window.__T || true", 3000);
  await waitFor("document.querySelectorAll('.pin-marker').length > 0", 12000);
  manifest["360"].push(await shot("360", "entry", [{ sel: ".pin-marker", n: 1 }]));
  const has360 = await evSafe("document.querySelectorAll('.pin-marker').length");
  manifest["360"].push(await shot("360", "pano-pins", [{ sel: ".pin-marker", n: 1 }]));
  await ev("var m = document.querySelector('.pin-marker[data-id=\\'p4\\']'); if (m) m.click();");
  await wait(600);
  manifest["360"].push(await shot("360", "pin-popup-360", [{ sel: "#pap-card", n: 1 }]));
  await ev("var b = document.getElementById('pap-view'); if (b) b.click();");
  await wait(900);
  manifest["360"].push(await shot("360", "pano-viewer", [{ x: 640, y: 450, n: 1 }]));
  await ev("document.getElementById('pap-close') && document.getElementById('pap-close').click()");
  await wait(300);
  await ev("document.querySelector('[data-help-toggle]') && document.querySelector('[data-help-toggle]').click()");
  await wait(400);
  manifest["360"].push(await shot("360", "help-mode", [{ sel: "[data-help-toggle]", n: 1 }]));
}

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
console.log("[manifest] " + MANIFEST_PATH);
console.log("checker shots: " + manifest.checker.length + " / 360 shots: " + manifest["360"].length);

try { chrome.kill(); } catch (e) {}
try { ws.close(); } catch (e) {}
proxy.close();
await mf.dispose();
process.exit(0);
