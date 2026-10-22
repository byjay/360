/**
 * p114 — 모바일 현장 흐름 실측 (측정 전용 · 결함 측정용, 수정 전 FAIL 예상)
 * 실행: P114=1 P114_ROOT=.tmp/fm114 TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p114-mobile-field-flow.test.mjs
 *   (P114 != "1" 이면 즉시 SKIP — 전 스위트를 깨지 않는다)
 *
 * 마스터: "모바일 형태로 테스트도 해. 모바일에서 가장 빠르게 오프라인에서 작업 후 온라인에서 업데이트
 *          가능하게 하고, 창 안 가리고 빠르게 진행 가능하게"
 *
 * 환경(목 0):
 *  - 서버 = P114_ROOT/dist/_worker.js(vite 빌드 산출물 그대로) → Miniflare(workerd) + 실 D1(migrations 전부) + 실 R2
 *  - 정적 = P114_ROOT/dist (Pages _routes.json exclude 규칙대로 Node 프록시가 직접 서빙, 나머지는 워커로)
 *  - 브라우저 = 실 Chrome 헤드리스(CDP) 375x812 · DPR 3 · 터치 · 모바일 UA · CPU 4배 감속 · Fast 3G / 오프라인
 *  - 오프라인 = 페이지 Network.emulateNetworkConditions(offline) + 프록시가 소켓을 끊음(SW 의 네트워크 요청도 실패)
 *
 * 단언(FAIL) = 명백한 결함만: 작업 유실 · 동기화 불일치 · 지도 탭 가림.  속도는 기록만(.tmp/fixmobile2/report.json).
 */
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Miniflare } from "miniflare";
import { listenSafePort } from "./_lib/safe-listen.mjs";

if (process.env.P114 !== "1") {
  console.log("[SKIP] p114 는 P114=1 일 때만 실행(실 Chrome+워커 모바일 실측, 수 분 소요)");
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_ROOT = path.resolve(ROOT, process.env.P114_ROOT || ".");
const DIST = path.join(APP_ROOT, "dist");
const OUT = path.join(ROOT, ".tmp", process.env.P114_OUT || "fixmobile2"); // 🔴 CLAUDE.md §G-5 — 프로젝트 안 .tmp 고정 (P114_OUT = EXPLORE 산출 폴더, 예 p146 → fixoffmatrix)
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
fs.mkdirSync(OUT, { recursive: true });

let failed = 0;
const fails = [];
const ok = (cond, label, detail) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail) : ""));
  if (!cond) { failed++; fails.push({ label, detail: detail == null ? null : detail }); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { meta: {}, steps: [], defects: [], occlusion: {}, touchTargets: [], timings: {}, assertions: fails };
const step = (name, data) => { const s = Object.assign({ name }, data); report.steps.push(s); console.log("[STEP] " + name + " " + JSON.stringify(data)); return s; };
const saveReport = () => fs.writeFileSync(path.join(OUT, process.env.P114_MUT ? "report-mut-" + process.env.P114_MUT + ".json" : "report.json"), JSON.stringify(report, null, 1));
const watchdog = setTimeout(() => { console.log("\nWATCHDOG 1800s 초과 → FAIL"); report.watchdog = true; saveReport(); process.exit(1); }, 1800000);

if (!fs.existsSync(CHROME)) { console.log("FAIL Chrome 없음: " + CHROME); process.exit(1); }
if (!fs.existsSync(path.join(DIST, "_worker.js"))) { console.log("FAIL 빌드 산출물 없음: " + DIST + "/_worker.js (P114_ROOT 에서 assemble→stamp→vite build 먼저)"); process.exit(1); }

/* ══ 입력 자산: 도면(ga.pdf 1페이지 래스터) · 360 사진 ══ */
const DRAWING_PNG = path.join(OUT, "ga-p1.png");
if (!fs.existsSync(DRAWING_PNG)) {
  const r = spawnSync("python", ["-c", "import fitz,sys;d=fitz.open(sys.argv[1]);p=d[0];z=2400/max(p.rect.width,p.rect.height);p.get_pixmap(matrix=fitz.Matrix(z,z)).save(sys.argv[2])", path.join(ROOT, ".tmp", "ga.pdf"), DRAWING_PNG], { encoding: "utf8" });
  if (r.status !== 0 || !fs.existsSync(DRAWING_PNG)) { console.log("FAIL 도면 PNG 생성 실패(.tmp/ga.pdf + PyMuPDF): " + (r.stderr || "").slice(-300)); process.exit(1); }
}
const PANO_JPG = path.join(APP_ROOT, "public", "samples", "pano-test-1.jpg");
if (!fs.existsSync(PANO_JPG)) { console.log("FAIL 360 테스트 사진 없음: " + PANO_JPG); process.exit(1); }

const sha10 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 10);
report.meta = {
  mutation: process.env.P114_MUT || null,
  appRoot: APP_ROOT, dist: DIST, at: new Date().toISOString(),
  commit: (spawnSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout || "").trim(),
  workerSha: sha10(path.join(DIST, "_worker.js")), mainJsSha: sha10(path.join(DIST, "js", "main.js")),
  device: "375x812 DPR3 touch mobileUA CPUx4", net: "Fast3G(562.5ms, 180KB/s↓, 84KB/s↑) / offline",
};

/* ══ 서버: 실 워커 + 실 D1/R2 ══ */
const MIG_DIR = path.join(APP_ROOT, "migrations");
const MIGS = fs.readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
const stmtsOf = (file) => fs.readFileSync(path.join(MIG_DIR, file), "utf8").replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
const ROUTES = JSON.parse(fs.readFileSync(path.join(DIST, "_routes.json"), "utf8"));
const globRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
const EXCLUDE = (ROUTES.exclude || []).map(globRe);
const CT = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript", ".mjs": "application/javascript", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".pdf": "application/pdf", ".ply": "application/octet-stream" };
function readDist(pathname) {
  let p = decodeURIComponent(pathname);
  if (p.endsWith("/")) p += "index.html";
  const full = path.join(DIST, p);
  if (!full.startsWith(DIST) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  return { body: fs.readFileSync(full), ct: CT[path.extname(full).toLowerCase()] || "application/octet-stream" };
}
function exposeForTest(bundle) {
  const idx = bundle.lastIndexOf("})();");
  if (idx === -1) return bundle;
  return bundle.slice(0, idx) + "\n  try { window.__T = { State, App, SyncQueue, PinSeries, MapCtrl, UI, Auth: (typeof Auth !== \"undefined\" ? Auth : null), OfflineBundle: (typeof OfflineBundle !== \"undefined\" ? OfflineBundle : null), ProjectHub: (typeof ProjectHub !== \"undefined\" ? ProjectHub : null), OpLog: (typeof OpLog !== \"undefined\" ? OpLog : null), PhotoBatch: (typeof PhotoBatch !== \"undefined\" ? PhotoBatch : null), PinActionPop: (typeof PinActionPop !== \"undefined\" ? PinActionPop : null), PdfAnno: (typeof PdfAnno !== \"undefined\" ? PdfAnno : null), Notes: (typeof Notes !== \"undefined\" ? Notes : null), Zones: (typeof Zones !== \"undefined\" ? Zones : null), Requests: (typeof Requests !== \"undefined\" ? Requests : null), ThetaIntake: (typeof ThetaIntake !== \"undefined\" ? ThetaIntake : null), FieldCapture: (typeof FieldCapture !== \"undefined\" ? FieldCapture : null), GPS: (typeof GPS !== \"undefined\" ? GPS : null), PanoViewer: (typeof PanoViewer !== \"undefined\" ? PanoViewer : null), Prompt: (typeof Prompt !== \"undefined\" ? Prompt : null), Projects: (typeof Projects !== \"undefined\" ? Projects : null), Cloud: (typeof Cloud !== \"undefined\" ? Cloud : null), PinPurge: (typeof PinPurge !== \"undefined\" ? PinPurge : null), Revision: (typeof Revision !== \"undefined\" ? Revision : null), Report: (typeof Report !== \"undefined\" ? Report : null), Delivery: (typeof Delivery !== \"undefined\" ? Delivery : null), Offline: (typeof Offline !== \"undefined\" ? Offline : null), CompanyAuth: (typeof CompanyAuth !== \"undefined\" ? CompanyAuth : null), Coverage: (typeof Coverage !== \"undefined\" ? Coverage : null) }; } catch (e) { window.__T_err = String(e); }\n" + bundle.slice(idx);
}
/** 뮤테이션 증명용(P114_MUT) — 단언이 진짜 결함을 잡는지 확인. 대상 문자열이 없으면 EXIT=2. */
const MUTS = {
  // 로컬 보관(draft) 공유 함수 _saveDraftLocal 을 무력화 → 오프라인 새로고침 후 핀 유실 → "유실 0" 단언이 FAIL 해야 한다
  lose: ["    async _saveDraftLocal(pages) {", "    async _saveDraftLocal(pages) { return false;"],
  // 배포본 PATCH(_patchDeployment — 자동저장·draft 반영 공통 관문)를 "성공한 척"만 하게 → "서버 핀 수 = 로컬 핀 수" 단언이 FAIL 해야 한다
  //   (a7a7bb0 부터 온라인 자동저장이 따로 있어 _flushDirtyDrafts 만 끄면 서버 반영이 여전히 일어난다 — 실측)
  //   서버로 가는 두 관문을 함께 막는다: 자동저장·수동저장(_patchDeployment) + 재연결 draft 반영(_flushDirtyDrafts)
  nosync: [["    async _patchDeployment(depId, buildBody) {", "    async _patchDeployment(depId, buildBody) { return { ok: true };"], ["    async _flushDirtyDrafts() {", "    async _flushDirtyDrafts() { return;"]],
  // 지도 중앙을 덮는 고정 레이어를 띄운다 → "[가림] 도면 중앙·네 모서리" 단언이 FAIL 해야 한다
  cover: ["\n})();", "\n  document.addEventListener('DOMContentLoaded', function(){ var d = document.createElement('div'); d.id = 'p114-mut-cover'; d.style.cssText = 'position:fixed;left:30%;top:35%;width:40%;height:30%;z-index:99999;background:rgba(255,0,0,.35)'; document.body.appendChild(d); });\n})();"],
};
const MUT = process.env.P114_MUT || "";
if (MUT && !MUTS[MUT]) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }
function mutate(bundle) {
  if (!MUT) return bundle;
  const pairs = Array.isArray(MUTS[MUT][0]) ? MUTS[MUT] : [MUTS[MUT]];
  for (const [from, to] of pairs) {
    const idx = MUT === "cover" ? bundle.lastIndexOf(from) : bundle.indexOf(from);
    if (idx < 0) { console.log("  FAIL 뮤테이션 대상 문자열 없음: " + MUT + " :: " + from.trim()); process.exit(2); }
    bundle = bundle.slice(0, idx) + to + bundle.slice(idx + from.length);
  }
  return bundle;
}
const isShell = (p) => p === "/" || p === "/sw.js" || p === "/manifest.webmanifest" || /\.(html|css|js)$/i.test(p);

const mf = new Miniflare({
  modules: true, scriptPath: path.join(DIST, "_worker.js"),
  compatibilityDate: "2025-05-01", compatibilityFlags: ["nodejs_compat"],
  d1Databases: { DB: "p114-" + Date.now() }, r2Buckets: { R2: "p114r2-" + Date.now() },
  bindings: { DEMO_LOGIN: "0", SUPER_ADMIN_EMAIL: "designssir@gmail.com", SUPER_ADMIN_EMAILS: "designssir@gmail.com", FIREBASE_PROJECT_ID: "sedmsys", PRIMARY_DOMAIN: "scan.seastar.work" },
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
for (const f of MIGS) for (const st of stmtsOf(f)) { try { await db.exec(st); } catch (e) { /* 중복 ALTER 등은 운영과 동일하게 무시 */ } }

/* ══ 프록시(브라우저가 보는 단일 오리진) — offline 플래그면 소켓을 끊는다 ══ */
const net = { offline: false, requests: 0, refused: 0, api: [] };
let BASE = "";
const proxy = http.createServer(async (req, res) => {
  const tIn = Date.now(); // 요청 도착 시각(업로드 본문 수신 전) — 응답 시각과 구분
  net.requests++;
  if (net.offline) { net.refused++; req.socket.destroy(); return; }
  try {
    const u = new URL(req.url, BASE);
    if (EXCLUDE.some((re) => re.test(u.pathname))) {
      const f = readDist(u.pathname);
      if (!f) { res.writeHead(404); res.end("nf"); return; }
      // 측정 전용 노출: 번들이 IIFE 라 State/App/SyncQueue 가 전역이 아니다 — 메모리상 응답에만 1줄 주입(p112 exposeForTest 동일 관례, 실 파일 불변)
      if (u.pathname === "/js/main.js") f.body = Buffer.from(mutate(exposeForTest(f.body.toString("utf8"))));
      const h = { "Content-Type": f.ct };
      if (isShell(u.pathname)) h["Cache-Control"] = "no-cache";
      res.writeHead(200, h); res.end(f.body); return;
    }
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = {}; for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
    const t0 = Date.now();
    const r = await mf.dispatchFetch(BASE + req.url, { method: req.method, headers, body: (req.method === "GET" || req.method === "HEAD") ? undefined : body, redirect: "manual" });
    const buf = Buffer.from(await r.arrayBuffer());
    if (/^\/(api|tables)\//.test(u.pathname)) net.api.push({ t: Date.now(), tIn, m: req.method, p: u.pathname, s: r.status, ms: Date.now() - t0, inBytes: body ? body.length : 0 });
    const outH = {}; r.headers.forEach((v, k) => { if (k !== "content-length" && k !== "transfer-encoding" && k !== "content-encoding") outH[k] = v; });
    res.writeHead(r.status, outH); res.end(buf);
  } catch (e) {
    try { res.writeHead(500); res.end(String(e && e.message)); } catch (e2) {}
  }
});
await listenSafePort(proxy, "127.0.0.1");
BASE = "http://127.0.0.1:" + proxy.address().port;
report.meta.base = BASE;

/* ══ 시드: 디자이너(로컬 세션) · 프로젝트 · 도면 배포본 · 구역 ══ */
const DESIGNER = "field@seastar.test";
const TOKEN = "local-p114-" + Date.now().toString(36);
const now0 = Date.now();
const run = (q, a = []) => db.prepare(q).bind(...a).run();
await run("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)", [DESIGNER, "현장", "designssir@gmail.com", now0, now0]);
await run("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)", [DESIGNER, "현장", "seastar.test", "x", "y", now0, now0]);
await run("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOKEN, DESIGNER, now0, now0 + 8.64e7]);
const api = async (method, url, body) => {
  const r = await mf.dispatchFetch(BASE + url, { method, headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" }, body: body == null ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
};
const PRJ = "prj_p114";
await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)", [PRJ, "현장 모바일 P114", "", DESIGNER, now0, now0]);
const PAGE_KEY = "assets/p114-ga-p1.png";
const _png = fs.readFileSync(DRAWING_PNG);
await r2.put(PAGE_KEY, _png.buffer.slice(_png.byteOffset, _png.byteOffset + _png.byteLength), { httpMetadata: { contentType: "image/png" } });
const PAGE_URL = "/api/r2/object/" + PAGE_KEY;
const ZONE = { id: "z_p114", page: 1, label: "화물창", color: "#e11d48", pinIds: [], note: "", shape: "rect", x: 42, y: 25, w: 16, h: 50 };
const dep = await api("POST", "/tables/deployments", { title: "GA", file_name: "GA.pdf", project_id: PRJ, pins: "[]", zones: JSON.stringify([ZONE]), pages_data: JSON.stringify([PAGE_URL]), drawing_data: PAGE_URL });
ok(dep.status < 300 && dep.j && dep.j.id, "시드: 배포본 생성", dep);
const DEP_ID = dep.j && dep.j.id;
const deck = await api("POST", "/api/projects/" + PRJ + "/decks", { name: "MAIN DECK", deployment_id: DEP_ID, page: 1 });
ok(deck.status < 300 && deck.j, "시드: 구역 생성", deck);
const DECK_ID = deck.j && (deck.j.id || (deck.j.data && deck.j.data.id));
report.meta.seed = { project: PRJ, deployment: DEP_ID, deck: DECK_ID, zone: ZONE };
const srvDep = async () => (await api("GET", "/tables/deployments/" + DEP_ID)).j || {};
const srvPins = async () => { try { return JSON.parse((await srvDep()).pins || "[]"); } catch (e) { return []; } };

/* ══ Chrome + CDP ══ */
const profileDir = path.join(ROOT, ".tmp", "p114-chrome-" + Date.now());
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", "--user-data-dir=" + profileDir, "--window-size=375,812", "about:blank"], { stdio: "ignore" });
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
const evHandlers = [];
ws.on("message", (raw) => {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); return; }
  if (msg.method) evHandlers.forEach((h) => { try { h(msg); } catch (e) {} });
});
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++idc; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const onceEvent = (name, timeout = 30000) => new Promise((resolve, reject) => {
  const to = setTimeout(() => { evHandlers.splice(evHandlers.indexOf(h), 1); reject(new Error("timeout " + name)); }, timeout);
  const h = (m) => { if (m.method === name) { clearTimeout(to); evHandlers.splice(evHandlers.indexOf(h), 1); resolve(m.params); } };
  evHandlers.push(h);
});
const consoleLog = [];
const loads = []; // Page.loadEventFired 시각(강제 리로드 탐지)
const dialogs = []; // 네이티브 대화상자(beforeunload/alert/confirm) — 기록 후 "확인/나가기"로 처리(사용자가 새로고침을 강행하는 상황)
evHandlers.push((m) => {
  if (m.method !== "Page.javascriptDialogOpening") return;
  dialogs.push({ t: Date.now(), type: m.params.type, message: String(m.params.message || "").slice(0, 200) });
  send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
});
evHandlers.push((m) => { if (m.method === "Page.loadEventFired") loads.push(Date.now()); });
evHandlers.push((m) => {
  if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "warning")) consoleLog.push(m.params.type + ": " + m.params.args.map((a) => a.value || a.description || "").join(" ").slice(0, 300));
  if (m.method === "Runtime.exceptionThrown") consoleLog.push("EXC: " + JSON.stringify(m.params.exceptionDetails && (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text)).slice(0, 400));
});
const ev = async (expr) => {
  // 페이지 쪽 Promise 가 영영 안 끝나도(IDB 막힘·새로고침 중) 하니스가 멈추지 않게 20s 상한
  const r = await Promise.race([send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }), new Promise((_, rej) => setTimeout(() => rej(new Error("eval timeout 20s: " + expr.slice(0, 80))), 20000))]);
  if (r.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result.value;
};
const evSafe = async (expr) => { try { return await ev(expr); } catch (e) { return { __err: String(e.message).slice(0, 300) }; } };
let shotN = 0;
const shot = async (name) => {
  const s = await send("Page.captureScreenshot", { format: "png" });
  const f = path.join(OUT, (process.env.P114_MUT ? "mut-" + process.env.P114_MUT + "-" : "") + String(++shotN).padStart(2, "0") + "-" + name + ".png");
  fs.writeFileSync(f, Buffer.from(s.data, "base64"));
  return path.basename(f);
};
const FAST3G = { offline: false, latency: 562.5, downloadThroughput: 180000, uploadThroughput: 84375 };
const setNet = async (mode) => {
  net.offline = mode === "offline";
  await send("Network.emulateNetworkConditions", mode === "offline" ? { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } : FAST3G);
};
const tap = async (x, y) => {
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, radiusX: 4, radiusY: 4, force: 1, id: 1 }] });
  await wait(40);
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};
/** 페이지 안에서 조건식이 참이 될 때까지 폴링(rAF/50ms) — 경과 ms 반환, 시간초과면 -1 */
const waitFor = async (cond, timeout = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await evSafe("(function(){try{return !!(" + cond + ")}catch(e){return false}})()");
    if (v === true) return Date.now() - t0;
    await wait(100);
  }
  return -1;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("DOM.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 3, mobile: true, screenWidth: 375, screenHeight: 812 });
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36", platform: "Android" });
await send("Emulation.setCPUThrottlingRate", { rate: 4 });
// [WO 20261009-installgate 정비] 현장 사용자의 실제 환경 = "설치된 앱(standalone)". CDP에는
// display-mode 를 직접 바꾸는 공식 Emulation 커맨드가 없다(Emulation.setEmulatedMedia 의
// features 는 prefers-color-scheme 류만 지원 — 실측: display-mode 지정 시 무시되고 matchMedia
// 는 그대로 false, --app= 런치 플래그도 헤드리스에서는 반영 안 됨, 2026-10-09 지휘자 지시로 실측).
// 그래서 38_Install.js/38b_InstallGate.js 가 실제로 읽는 신호(window.matchMedia
// '(display-mode: standalone)')를 새 문서마다(새로고침 포함) 패치한다 — 기능 플래그를 꺼서
// 피하지 않고, 앱이 보는 신호 자체를 "설치됨"으로 만든다(기존 UA·뷰포트 오버라이드와 동일 성격).
await send("Page.addScriptToEvaluateOnNewDocument", { source: String.raw`(function(){
  var realMM = window.matchMedia.bind(window);
  window.matchMedia = function (q) {
    if (typeof q === "string" && q.indexOf("display-mode: standalone") >= 0) {
      return { matches: true, media: q, onchange: null, addListener: function(){}, removeListener: function(){}, addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){ return true; } };
    }
    return realMM(q);
  };
})();` });
await send("Page.setInterceptFileChooserDialog", { enabled: true });

export { };
globalThis.__P114 = { ok, step, report, saveReport, ev, evSafe, shot, setNet, tap, waitFor, send, onceEvent, net, api, srvPins, srvDep, BASE, TOKEN, DEP_ID, DECK_ID, PRJ, OUT, PANO_JPG, consoleLog, wait, db, r2, mf, loads, dialogs, cdpPort: port, DESIGNER, evHandlers, run };

try {
  if (process.env.P114_EXPLORE) await (await import("file:///" + path.resolve(process.env.P114_EXPLORE).replace(/\\/g, "/"))).default(globalThis.__P114);
  else await runScenario(globalThis.__P114);
} catch (e) {
  console.log("ERROR " + (e && e.stack || e));
  ok(false, "시나리오 실행 중 예외", String(e && e.message));
} finally {
  report.dialogs = dialogs;
  report.console = consoleLog.slice(-60);
  report.apiLog = net.api.slice(-200);
  saveReport();
  clearTimeout(watchdog);
  try { ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
  try { proxy.close(); } catch (e) {}
  try { await mf.dispose(); } catch (e) {}
}
console.log("\n" + (failed ? "FAILED " + failed + "건" : "ALL PASS") + " — report: " + path.join(OUT, process.env.P114_MUT ? "report-mut-" + process.env.P114_MUT + ".json" : "report.json"));
process.exit(failed ? 1 : 0);

/* ══ 시나리오 ══ */

/** 페이지 안 측정 라이브러리 — 새 문서마다(새로고침 포함) 자동 주입. 앱 동작은 바꾸지 않는다(관찰만). */
function mLib() { return String.raw`(function(){
  if (window.__M) return;
  var M = window.__M = { taps: [], seen: {}, paint: {} };
  window.addEventListener('touchstart', function(e){ var t = e.touches && e.touches[0]; M.taps.push({ t: performance.now(), x: t && t.clientX, y: t && t.clientY, target: M.label(e.target) }); }, true);
  M.label = function(el){ if (!el || !el.tagName) return String(el); var c = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.'); return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (c ? '.' + c : ''); };
  M.mv = function(){ return document.getElementById('map-viewport'); };
  M.inMap = function(el){ var mv = M.mv(); return !!(el && mv && mv.contains(el)); };
  /* 지도 뷰포트 안에 붙은 UI(배너·버튼 등) — 터치는 뷰포트 핸들러로 가지만 도면을 시각적으로 덮는다 */
  M.chrome = function(el){ if (!el || !el.closest) return false; if (el.closest('.pin-marker')) return false; return !!el.closest('button,a,input,select,textarea,[role=status],[role=dialog],[role=toolbar],#src-link-bar'); };
  M.visible = function(el){ var r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; var cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05; };
  /* [WO 20261022-offlinephoto] 7cafcbb(pindots) 이후 평면 마커 기본 = 점(.pin-dot, absolute) · .pin-pin display:none →
   *  .pin-marker 박스가 0x0 이라 M.visible(marker) 가 거의 전부 false(실측 markerSelfHit.visible 21→1, "핀 패널" mk.none).
   *  핀 마커의 탭 기준 = 보이는 점(.pin-dot) 중심 = 핀 좌표(p177 P.dots 와 같은 기준). 점이 안 보이면(선택/호버/드롭 teardrop·ISO) 종전대로 마커 박스. */
  M.tgtRect = function(e){ if (e.classList && e.classList.contains('pin-marker')) { var d = e.querySelector('.pin-dot'); if (d && M.visible(d)) return d.getBoundingClientRect(); } return e.getBoundingClientRect(); };
  M.tgtVisible = function(e){ if (e.classList && e.classList.contains('pin-marker')) { var d = e.querySelector('.pin-dot'); if (d && M.visible(d)) { var cs = getComputedStyle(e); return cs.visibility !== 'hidden' && +cs.opacity > 0.05; } } return M.visible(e); };
  M.rect = function(el){ var r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
  M.scan = function(){ var now = performance.now(); document.querySelectorAll('.pin-marker[data-id]').forEach(function(m){ var id = m.getAttribute('data-id'); if (!(id in M.seen)) { M.seen[id] = now; requestAnimationFrame(function(){ M.paint[id] = performance.now(); }); } }); };
  function startObs(){ if (M._obs || !document.body) return; M.scan(); M._obs = new MutationObserver(M.scan); M._obs.observe(document.body, { childList: true, subtree: true }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObs); else startObs();
  M.mapRect = function(){ var a = document.getElementById('map-area'); var r = (a && a.getBoundingClientRect().width > 0 ? a : M.mv()).getBoundingClientRect(); var vh = window.innerHeight, vw = window.innerWidth; return { x: Math.max(0, r.left), y: Math.max(0, r.top), r: Math.min(vw, r.right), b: Math.min(vh, r.bottom) }; };
  /* 지도 위를 덮는 오버레이의 최상위 조상(지도를 품지 않는 가장 바깥 positioned 요소) */
  M.root = function(el){ var mv = M.mv(), root = null; for (var n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) { if (mv && n.contains(mv)) break; var p = getComputedStyle(n).position; if (p === 'fixed' || p === 'absolute' || p === 'sticky') root = n; } return root || el; };
  /* 실제 가림 = 지도 영역 격자점 중 elementFromPoint 가 지도(#map-viewport 하위)가 아닌 비율 */
  M.occlusion = function(step){ step = step || 8; var R = M.mapRect(), tot = 0, cov = 0, vis = 0, by = {}; for (var y = R.y + step / 2; y < R.b; y += step) for (var x = R.x + step / 2; x < R.r; x += step) { tot++; var h = document.elementFromPoint(x, y); if (!h) continue; if (M.inMap(h) && !M.chrome(h)) continue; vis++; if (M.inMap(h)) { var k0 = M.label(M.root(h)) + ' (뷰포트 안·터치는 통과)'; by[k0] = (by[k0] || 0) + 1; continue; } cov++; var k = M.label(M.root(h)); by[k] = (by[k] || 0) + 1; } var list = Object.keys(by).map(function(k){ return { el: k, pct: +(100 * by[k] / tot).toFixed(2) }; }).sort(function(a, b){ return b.pct - a.pct; }); return { mapRect: R, points: tot, pct: tot ? +(100 * cov / tot).toFixed(2) : 0, visualPct: tot ? +(100 * vis / tot).toFixed(2) : 0, by: list }; };
  /* 고정·플로팅 요소 목록(bbox) + 지도 영역 대비 bbox 가림 % + 서로 겹침 쌍 */
  M.overlays = function(){ var mv = M.mv(), R = M.mapRect(), mapA = Math.max(1, (R.r - R.x) * (R.b - R.y)); var c = []; document.querySelectorAll('body *').forEach(function(el){ if (mv && (mv.contains(el) || el.contains(mv))) return; var cs = getComputedStyle(el); var pos = cs.position; if (!(pos === 'fixed' || pos === 'sticky' || (pos === 'absolute' && cs.zIndex !== 'auto'))) return; if (!M.visible(el)) return; var r = el.getBoundingClientRect(); if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return; c.push(el); }); var top = c.filter(function(el){ return !c.some(function(o){ return o !== el && o.contains(el); }); }); var out = top.map(function(el){ var r = el.getBoundingClientRect(); var ix = Math.max(0, Math.min(r.right, R.r) - Math.max(r.left, R.x)), iy = Math.max(0, Math.min(r.bottom, R.b) - Math.max(r.top, R.y)); return { el: M.label(el), rect: M.rect(el), z: getComputedStyle(el).zIndex, pe: getComputedStyle(el).pointerEvents, mapPct: +(100 * ix * iy / mapA).toFixed(2), text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40), _el: el }; }); var pairs = []; for (var i = 0; i < out.length; i++) for (var j = i + 1; j < out.length; j++) { var a = out[i]._el.getBoundingClientRect(), b = out[j]._el.getBoundingClientRect(); var w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); if (w > 2 && h > 2 && w * h >= 25) pairs.push({ a: out[i].el, b: out[j].el, area: Math.round(w * h) }); } out.forEach(function(o){ delete o._el; }); return { list: out.sort(function(a, b){ return b.mapPct - a.mapPct; }), pairs: pairs.sort(function(a, b){ return b.area - a.area; }) }; };
  /* 도면 위 탭 대상 5점(중앙 + 네 모서리 10% 안쪽)이 지도로 가는가 */
  M.drawingRect = function(){ var c = [document.getElementById('map-image'), document.getElementById('pdf-canvas')].filter(function(e){ return e && M.visible(e); })[0]; if (!c) return null; var r = c.getBoundingClientRect(), R = M.mapRect(); var x = Math.max(r.left, R.x), y = Math.max(r.top, R.y), rr = Math.min(r.right, R.r), b = Math.min(r.bottom, R.b); if (rr <= x || b <= y) return null; return { x: x, y: y, w: rr - x, h: b - y }; };
  M.targets = function(){ var d = M.drawingRect(); if (!d) return { drawing: null, points: [] }; var pts = [['center', .5, .5], ['tl', .1, .1], ['tr', .9, .1], ['bl', .1, .9], ['br', .9, .9]]; return { drawing: d, points: pts.map(function(p){ var x = d.x + d.w * p[1], y = d.y + d.h * p[2]; var h = document.elementFromPoint(x, y); return { name: p[0], x: Math.round(x), y: Math.round(y), onMap: M.inMap(h) && !M.chrome(h), touchReachesMap: M.inMap(h), hit: h ? M.label(M.root(h)) : null }; }) }; };
  M.small = function(){ var out = []; document.querySelectorAll('button, a[href], [role=button], input:not([type=hidden]), select, .pin-marker, .mdock-chip, .regmode-btn').forEach(function(el){ if (!M.visible(el)) return; var r = el.getBoundingClientRect(); if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return; if (r.width < 32 || r.height < 32) { var h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); if (!h || !(el === h || el.contains(h) || h.contains(el))) return; out.push({ el: M.label(el), w: Math.round(r.width), h: Math.round(r.height), text: (el.getAttribute('aria-label') || el.innerText || el.title || '').trim().replace(/\s+/g, ' ').slice(0, 30) }); } }); return out; };
  M.hit = function(x, y){ var h = document.elementFromPoint(x, y); return { onMap: M.inMap(h), chrome: M.chrome(h), hit: h ? M.label(M.root(h)) : null, leaf: h ? M.label(h) : null }; };
  M.center = function(sel){ var e = document.querySelector(sel); if (!e || !M.visible(e)) return null; var r = e.getBoundingClientRect(); var x = r.left + r.width / 2, y = r.top + r.height / 2; var h = document.elementFromPoint(x, y); return { x: x, y: y, w: r.width, h: r.height, hitOk: !!h && (h === e || e.contains(h)), hit: h ? M.label(M.root(h)) : null }; };
})();`; }

/* ══ 시나리오 ══ */
async function runScenario(P) {
  const { ev, evSafe, shot, send, BASE, TOKEN, step, tap, waitFor, loads } = P;
  let navigator_offline = false;
  const setNet = async (m) => { navigator_offline = m === "offline"; await P.setNet(m); };
  await send("Page.addScriptToEvaluateOnNewDocument", { source: mLib() });
  const T = report.timings;
  const shots = report.shots = [];
  const snap = async (label) => {
    // 측정 직전 애니메이션 강제 종료(CLAUDE.md G-4 ④) — 전환 중간값을 재지 않게
    await evSafe("document.getAnimations && document.getAnimations().forEach(function(a){ try { a.finish(); } catch (e) {} }); 1");
    const occ = await evSafe("__M.occlusion(8)");
    const ovl = await evSafe("__M.overlays()");
    const tg = await evSafe("__M.targets()");
    const file = await shot(label);
    shots.push(file);
    report.occlusion[label] = { occlusion: occ, overlays: ovl, targets: tg, shot: file };
    const blocked = (tg && tg.points || []).filter((p) => !p.onMap);
    console.log(`[OCC] ${label}: 가림(터치차단) ${occ && occ.pct}% · 시각가림 ${occ && occ.visualPct}% · 오버레이 ${ovl && ovl.list && ovl.list.length}개 · 겹침쌍 ${ovl && ovl.pairs && ovl.pairs.length} · 탭대상 가림 ${blocked.length}/${(tg && tg.points || []).length} ${blocked.map((b) => b.name + "→" + b.hit).join(", ")}`);
    return { occ, ovl, tg, blocked };
  };
  const defect = (prio, title, evidence, cause) => { report.defects.push({ prio, title, evidence, cause: cause || null }); console.log(`[DEFECT ${prio}] ${title} :: ${JSON.stringify(evidence).slice(0, 300)}`); };
  // [WO 20261002-gap] 두 사각형의 교차 면적(px²) — 0 이면 겹침 없음.
  const ovArea = (a, b) => { if (!a || !b) return 0; const ox = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)); const oy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)); return ox * oy; };
  const S = (expr) => evSafe("(function(){ var S = window.__T && __T.State; if (!S) return null; return (" + expr + "); })()");
  const tapSel = async (sel, label, quiet) => {
    const c = await evSafe(`__M.center(${JSON.stringify(sel)})`);
    if (!c || c.__err) { console.log("  [tapSel] 없음/비가시: " + sel); return null; }
    if (!c.hitOk && !quiet) defect("P1", `${label || sel} 버튼이 다른 요소에 가려 탭이 엉뚱한 곳으로 감`, c);
    await tap(c.x, c.y);
    return c;
  };
  const openLeaf = async (label) => {
    const has = await waitFor("document.querySelector('.hub-tree-deck[data-act=deck-open]')", navigator_offline ? 5000 : 30000);
    if (has < 0) {
      // 오프라인 허브는 카드 아래 구역 트리가 없다 → 카드 자체를 탭(기존 진입 openProject)
      report.offlineHubNoTree = true;
      if (!report.cardNameProbe) {
        // 카드 이름을 탭하면 프로젝트가 열리는가? (오프라인 허브는 트리가 없어 카드가 유일한 진입점)
        await evSafe("(function(){ var e = document.querySelector('.hub-card-name'); e && e.scrollIntoView({ block: 'center' }); return 1; })()");
        await P.wait(400);
        // 이름 "글자" 위를 탭(블록 중심이 아니라 텍스트 노드 중심 — 사용자가 누르는 곳)
        const nt = await evSafe("(function(){ var e = document.querySelector('.hub-card-name'); var tn = e && Array.from(e.childNodes).filter(function(n){ return n.nodeType === 3 && n.textContent.trim(); })[0]; if (!tn) return null; var rg = document.createRange(); rg.selectNodeContents(tn); var r = rg.getBoundingClientRect(); var x = r.left + r.width / 2, y = r.top + r.height / 2; var h = document.elementFromPoint(x, y); var rb = e.querySelector('.hub-card-rename'); var rr = rb ? rb.getBoundingClientRect() : null; return { x: x, y: y, hit: h ? __M.label(h) : null, renameBtn: rr ? { x: Math.round(rr.left), w: Math.round(rr.width), h: Math.round(rr.height), gapFromText: Math.round(rr.left - r.right) } : null }; })()");
        report.cardNameText = nt;
        if (nt && nt.x) await tap(nt.x, nt.y); else await tapSel(".hub-card-name", label + " — 카드 이름", true);
        await P.wait(1200);
        const dlg = await evSafe("(function(){ var b = Array.from(document.querySelectorAll('button')).filter(function(x){ return __M.visible(x) && (x.innerText||'').trim() === '취소'; })[0]; var t = Array.from(document.querySelectorAll('h1,h2,h3,h4,[class*=title]')).filter(function(x){ return __M.visible(x) && /이름 변경/.test(x.innerText||''); })[0]; if (b) b.setAttribute('data-p114', 'cancel'); return { renameDialog: !!t, cancel: !!b, appOpened: !!document.querySelector('#screen-app.active') }; })()");
        if (dlg && report.cardNameText) dlg.tapAt = report.cardNameText;
        report.cardNameProbe = dlg || { err: true };
        if (dlg && dlg.renameDialog) {
          defect("P1", "오프라인 허브에서 카드의 프로젝트 이름 글자를 탭하면 프로젝트가 열리지 않고 '프로젝트 이름 변경' 창이 뜸 — 오프라인엔 구역 트리(CHECKER/360 잎)도 없어 현장 진입 동선이 막힘", dlg, "bb4f3b6(projectinfo) 이름 변경 진입이 .hub-card-name 탭에 걸림(추정 — 12_ProjectHub.js 카드 렌더 재조사)");
          await tapSel("[data-p114=cancel]", "이름 변경 취소", true);
          await P.wait(600);
        }
        if (dlg && dlg.appOpened) return true;
      }
      await evSafe("(function(){ var e = document.querySelector('.hub-card-thumb'); e && e.scrollIntoView({ block: 'center' }); return 1; })()");
      await P.wait(400);
      return tapSel(".hub-card-thumb", label + " — 카드 썸네일(트리 없음)");
    }
    await evSafe("(function(){ var e = document.querySelector('.hub-tree-deck[data-act=deck-open]'); e && e.scrollIntoView({ block: 'center' }); return 1; })()");
    await P.wait(400);
    return tapSel(".hub-tree-deck[data-act=deck-open]", label);
  };
  /** [WO 20261022-offlinephoto] 사진 핀 = 4단계에서 "바로 사진" 방식으로 탭해 사진을 고른 **그 핀(ID)**.
   *  0b716e2(unifymode) 이후 새 핀에 pin.checkboard 를 쓰지 않으므로 종전 판정 `!p.checkboard` 는 번호 핀 24개까지
   *  "사진 핀" 으로 세어 동기화 완료(syncDone)·사진 연결 단언이 영영 성립하지 않았다(제품은 연결 완료 — 실측 report.json). */
  let photoPinId = null;
  const localState = () => S("{ pins: S.pins.length, ids: S.pins.map(function(p){ return String(p.id); }), pend: S.pins.filter(function(p){ return p.pendingOpId || (p.attachments||[]).some(function(a){ return a.pendingOpId; }); }).length, photo: S.pins.filter(function(p){ return String(p.id) === " + JSON.stringify(String(photoPinId)) + "; }).map(function(p){ return { id: String(p.id), imageId: p.imageId || null, imageUrl: p.imageUrl || null, pendingOpId: p.pendingOpId || null }; }), dep: S.autoSaveDepId, ver: S.depVersion, dirty: !!(__T.App && __T.App._dirty), regMode: S.regMode, placing: S.placing, drawn: !!__M.drawingRect() }");
  const queueCount = () => evSafe("(window.__T && __T.SyncQueue && __T.SyncQueue.count) ? __T.SyncQueue.count() : -1");
  const TREE_INFO = "(function(){ var t = document.getElementById('side-tree'); return { decks: t ? t.querySelectorAll('.tree-node-deck,[data-deck-id]').length : -1, text: t ? (t.innerText||'').replace(/\\s+/g,' ').slice(0, 200) : null }; })()";
  const drawnExpr = "window.__M && __M.drawingRect() && ((document.getElementById('map-image')||{}).complete !== false)";

  /* ── 1. 콜드 로드 (Fast 3G) ── */
  await setNet("fast3g");
  // 로그인 = 같은 오리진 localStorage 에 로컬 세션 토큰(실 D1 local_sessions 행). 오리진을 열려고 manifest 를 먼저 연다.
  await send("Page.navigate", { url: BASE + "/manifest.webmanifest" });
  await waitFor("location.pathname === '/manifest.webmanifest'", 60000);
  await ev(`localStorage.setItem("wm_local_token", ${JSON.stringify(TOKEN)}); 1`);
  const t0 = Date.now(); const n0 = loads.length;
  await send("Page.navigate", { url: BASE + "/" });
  while (loads.length === n0 && Date.now() - t0 < 120000) await P.wait(100);
  T.coldLoadEventMs = Date.now() - t0;
  const paint = await evSafe("(function(){ var o = {}; performance.getEntriesByType('paint').forEach(function(e){ o[e.name] = Math.round(e.startTime); }); return o; })()");
  T.coldFirstContentfulPaintMs = paint && paint["first-contentful-paint"];
  const hubR = await waitFor("document.querySelector('.hub-tree-deck[data-act=deck-open]')", 90000);
  T.coldHubReadyMs = hubR < 0 ? -1 : Date.now() - t0;
  // SW 설치 완료(제어권 + 앱셸 캐시 채움) 확인 — 안 되면 오프라인 재진입 측정이 무의미하다
  const swCtl = await waitFor("navigator.serviceWorker && navigator.serviceWorker.controller", 90000);
  T.swControlMs = swCtl < 0 ? -1 : Date.now() - t0;
  await evSafe("(function(){ window.__swc = false; caches.keys().then(function(k){ return Promise.all(k.map(function(n){ return caches.open(n).then(function(c){ return c.keys(); }); })); }).then(function(a){ window.__swc = [].concat.apply([], a).some(function(r){ return r.url.indexOf('/js/main.js') >= 0; }); }); return 1; })()");
  let swCached = -1;
  for (let i = 0; i < 60 && swCached < 0; i++) {
    swCached = await waitFor("window.__swc === true", 1500);
    if (swCached < 0) await evSafe("(function(){ caches.keys().then(function(k){ return Promise.all(k.map(function(n){ return caches.open(n).then(function(c){ return c.keys(); }); })); }).then(function(a){ window.__swc = [].concat.apply([], a).some(function(r){ return r.url.indexOf('/js/main.js') >= 0; }); }); return 1; })()");
  }
  T.swShellCachedMs = swCached < 0 ? -1 : Date.now() - t0;
  await P.wait(2500); // controllerchange 강제 새로고침이 있으면 이 사이에 일어난다
  T.coldLoadsDuringFirstVisit = loads.filter((x) => x >= t0).map((x) => x - t0);
  if (T.coldLoadsDuringFirstVisit.length > 1) defect("P2", "첫 방문 중 SW 설치 직후 페이지가 강제 새로고침됨(controllerchange → location.reload) — Fast 3G 에서 화면이 한 번 더 통째로 다시 뜬다", { loadsAtMs: T.coldLoadsDuringFirstVisit }, "public/index.html:1322-1326 (첫 설치 clients.claim 에도 controllerchange 발생)");
  await waitFor("document.querySelector('.hub-tree-deck[data-act=deck-open]')", 60000);
  await P.wait(800);
  await snap("cold-hub");
  report.touchTargetsHub = (await evSafe("__M.small()")) || [];
  ok(swCtl >= 0 && swCached >= 0, "SW 제어권 + 앱셸 캐시(오프라인 재진입 전제)", { swCtl, swCached });
  // 1-b. "다운로드" 없이 오프라인 새로고침하면? (현장에서 다운로드를 잊은 경우)
  await setNet("offline");
  await P.wait(800);
  { const tr = Date.now(); const nr = loads.length;
    await send("Page.reload", { ignoreCache: false });
    while (loads.length === nr && Date.now() - tr < 60000) await P.wait(100);
    await waitFor("window.__T && document.getElementById('screen-projects')", 20000);
    const leafOk = await waitFor("document.querySelector('.hub-tree-deck[data-act=deck-open]')", 8000);
    T.offlineNoDownloadHub = { ms: Date.now() - tr, leafVisible: leafOk >= 0, cards: await evSafe("document.querySelectorAll('[data-act=deck-open]').length"), text: await evSafe("(document.querySelector('#screen-projects')||document.body).innerText.replace(/\s+/g,' ').slice(0,160)") };
    await snap("offline-no-download-hub");
    if (leafOk < 0) defect("P1", "프로젝트 [다운로드]를 누르지 않고 오프라인이 되면, 새로고침 시 허브가 '등록된 프로젝트가 없습니다'로 비어 방금 보던 도면도 못 연다(자동 오프라인 보관 없음)", T.offlineNoDownloadHub, "12_ProjectHub.js load() 오프라인 폴백 = OfflineBundle 다운로드분만 · 열었던 구역 자동 보관 없음");
  }
  await setNet("fast3g");
  { const tr = Date.now(); const nr = loads.length;
    await send("Page.reload", { ignoreCache: false });
    while (loads.length === nr && Date.now() - tr < 120000) await P.wait(100);
    const hb = await waitFor("document.querySelector('.hub-tree-deck[data-act=deck-open]')", 90000);
    T.warmReloadHubMs = hb < 0 ? -1 : Date.now() - tr; // SW 캐시가 있는 재방문(Fast 3G)
  }
  // 1-c. 프로젝트 카드 [다운로드](오프라인 번들) — 의도된 현장 준비 절차
  await evSafe("(function(){ var l = document.querySelector('[data-dl-label]'); var b = l && l.closest('button'); if (b) { b.setAttribute('data-p114', 'dl'); b.scrollIntoView({ block: 'center' }); } return !!b; })()");
  await P.wait(400);
  const tDl = Date.now();
  const dlBtn = await tapSel("[data-p114=dl]", "프로젝트 다운로드");
  // 완료 판정 = 앱 자신의 무결성 검증(OfflineBundle.verify — SoT). 버튼 라벨은 따로 대조한다.
  let dlDone = -1;
  for (let i = 0; i < 180 && dlDone < 0; i++) {
    const v = await evSafe("Promise.race([__T.OfflineBundle.verify(" + JSON.stringify(P.PRJ) + ").then(function(v){ return !!(v && v.ok); }), new Promise(function(r){ setTimeout(function(){ r(false); }, 3000); })])");
    if (v === true) dlDone = Date.now() - tDl; else await P.wait(500);
  }
  T.offlineDownloadMs = dlDone;
  const lblOk = await waitFor("Array.from(document.querySelectorAll('[data-dl-label]')).some(function(l){ return /저장됨/.test(l.textContent) && l.closest('button').classList.contains('is-dl-done'); })", 8000);
  T.offlineDownloadLabelShownMs = lblOk < 0 ? -1 : Date.now() - tDl;
  if (dlDone >= 0 && lblOk < 0) defect("P2", "프로젝트 [다운로드]가 실제로는 완료(verify ok)됐는데 카드 버튼이 계속 '다운로드'로 남음 — 현장 사용자가 저장됐는지 알 수 없어 다시 누르게 됨", { verifyMs: dlDone }, "12_ProjectHub.js downloadProject() finally → _refreshDlState(btnEl) — 다운로드 중 허브 재렌더로 btnEl 이 DOM 에서 떨어져 새 카드 버튼은 갱신 안 됨(추정)");
  T.offlineDownloadState = await evSafe("Promise.race([Promise.all([__T.OfflineBundle ? __T.OfflineBundle.verify(" + JSON.stringify(P.PRJ) + ") : null, __T.SyncQueue.allDraftKeys()]).then(function(a){ return { verify: a[0], keys: a[1] }; }), new Promise(function(r){ setTimeout(function(){ r('IDB TIMEOUT 8s'); }, 8000); })])");
  T.offlineDownloadLabel = await evSafe("Array.from(document.querySelectorAll('[data-dl-label]')).map(function(l){ var b = l.closest('button'); return l.textContent + '|' + (b && b.className) + '|' + (b && b.title) + '|connected=' + document.body.contains(l); })");
  console.log("  [download] " + JSON.stringify({ ms: T.offlineDownloadMs, state: T.offlineDownloadState, label: T.offlineDownloadLabel }).slice(0, 600));
  ok(!!dlBtn && dlDone >= 0, "온라인: 프로젝트 [다운로드] → '저장됨'", { ms: T.offlineDownloadMs });
  await snap("online-downloaded-hub");
  // 프로젝트 → 도면 표시(화면 맞춤)까지: 허브 카드 트리의 CHECKER 잎을 실제 터치로 탭
  const t1 = Date.now();
  // [WO 20261019-unifymode] 허브 모드 잎(CHECKER/360) 폐기 — 진입 = 허브 카드 트리의 구역 행(같은 openProjectAtDeck 경로). 배치는 아래 도크 [포인트] 탭으로 켠다(종전에도 꺼져 있으면 탭).
  const leaf = await openLeaf("허브 구역 행");
  const td = await waitFor(drawnExpr + " && __T.State.zoom > 0", 90000);
  T.openDrawingMs = td < 0 ? -1 : Date.now() - t1;
  ok(!!leaf && td >= 0, "온라인: 허브 → 도면 표시", { leaf, td });
  await P.wait(1500);
  T.coldTotalToDrawingMs = Date.now() - t0;
  await snap("online-drawing");
  // [WO 20261002-gap] 🔴 모바일 겹침 회귀 검사(마스터 "숨기지 마" — 역할 표시는 그대로, 위치만 분리):
  //   ① 도움말(?)/개발자 문의(✉) FAB vs 핀 필터 칩 바(#pin-filter-bar) — 실측 결함 3850px² 유사.
  //   ② 구역 페이저(#zone-pager) vs 번호대역 띠(#regmode-start-wrap, 모바일 고정) — 실측 3850px².
  //   핀/구역 없이도 재현 가능해야 하므로 각 요소를 강제로 보여 측정한 뒤 원상복구한다(부작용 0).
  {
    const fabOv = await evSafe(`(function(){
      function r(sel){ var el = document.querySelector(sel); if (!el) return null; var b = el.getBoundingClientRect(); return { top:b.top, bottom:b.bottom, left:b.left, right:b.right }; }
      var bar = document.getElementById('pin-filter-bar'); var wasHidden = bar && bar.classList.contains('hidden');
      if (bar) bar.classList.remove('hidden');
      var out = { help: r('[data-help-toggle]'), inquiry: r('[data-help-inquiry-toggle]'), filterBar: r('#pin-filter-bar') };
      if (bar && wasHidden) bar.classList.add('hidden');
      return out;
    })()`);
    const helpOv = ovArea(fabOv && fabOv.help, fabOv && fabOv.filterBar);
    const inquiryOv = ovArea(fabOv && fabOv.inquiry, fabOv && fabOv.filterBar);
    report.mobileOverlap = { fabOv, helpOv, inquiryOv };
    ok(helpOv === 0, "[WO20261002-gap] 도움말(?) FAB × 핀 필터 칩 바 겹침 0", { helpOv, fabOv });
    ok(inquiryOv === 0, "[WO20261002-gap] 개발자 문의(✉) FAB × 핀 필터 칩 바 겹침 0", { inquiryOv, fabOv });

    const zpOv = await evSafe(`(function(){
      function r(el){ if (!el) return null; var b = el.getBoundingClientRect(); return { top:b.top, bottom:b.bottom, left:b.left, right:b.right }; }
      var bar = document.getElementById('zone-pager'); if (!bar) return null;
      var hadHidden = bar.classList.contains('hidden'), hadVisible = bar.classList.contains('pager-visible'), prevHtml = bar.innerHTML;
      bar.classList.remove('hidden'); bar.classList.add('pager-visible');
      bar.innerHTML = '<button class="zpager-tab active">전체 도면</button><button class="zpager-tab">테스트 구역</button>';
      if (window.__T && __T.App && __T.App._positionZonePager) __T.App._positionZonePager(bar, null);
      var out = { zone: r(bar), band: r(document.getElementById('regmode-start-wrap')) };
      if (hadHidden) bar.classList.add('hidden'); if (!hadVisible) bar.classList.remove('pager-visible'); bar.innerHTML = prevHtml;
      return out;
    })()`);
    const zoneOv = ovArea(zpOv && zpOv.zone, zpOv && zpOv.band);
    report.mobileOverlap.zpOv = zpOv; report.mobileOverlap.zoneOv = zoneOv;
    ok(zoneOv === 0, "[WO20261002-gap] 구역 페이저(#zone-pager) × 번호대역 띠(#regmode-start-wrap) 겹침 0", { zoneOv, zpOv });
  }
  if (process.env.P114_STOP === "drawing") { assertOcclusion(); return; }
  // [a7a7bb0 검증] 온라인 편집 → 서버 반영: 도크 [포인트] → 도면 탭 1회 → 서버 배포본 pins 에 그 핀이 보일 때까지(Fast 3G)
  {
    if (!(await S("S.placing"))) await tapSel("#mobile-dock [data-act=place]", "도크 포인트(온라인)");
    await P.wait(600);
    const dO = await evSafe("__M.drawingRect()");
    const before = await S("S.pins.map(function(p){ return String(p.id); })");
    const tE = Date.now();
    await tap(Math.round(dO.x + dO.w * 0.08), Math.round(dO.y + dO.h * 0.5));
    const newId = await (async () => { for (let i = 0; i < 30; i++) { const ids = await S("S.pins.map(function(p){ return String(p.id); })"); const n = (ids || []).filter((x) => (before || []).indexOf(x) < 0); if (n.length) return n[0]; await P.wait(100); } return null; })();
    let srvMs = -1;
    while (newId && Date.now() - tE < 15000) { const sp = await P.srvPins(); if (sp.some((p) => String(p.id) === newId)) { srvMs = Date.now() - tE; break; } await P.wait(150); }
    T.onlineEditToServerMs = srvMs;
    T.onlineEditSaveState = await evSafe("(function(){ var b = document.getElementById('btn-save'); return { dirty: !!(__T.App && __T.App._dirty), btn: b ? (b.innerText||'').trim() : null }; })()");
    await P.wait(3000);
    T.onlineEditSaveStateLater = await evSafe("(function(){ var b = document.getElementById('btn-save'); return { dirty: !!(__T.App && __T.App._dirty), btn: b ? (b.innerText||'').trim() : null }; })()");
    step("online-edit-autosave", { newId, srvMs, atReflect: T.onlineEditSaveState, plus3s: T.onlineEditSaveStateLater });
    if (srvMs >= 0 && T.onlineEditSaveStateLater && T.onlineEditSaveStateLater.dirty) defect("P2", "온라인 자동 저장으로 서버 반영이 끝났는데 3초 뒤에도 화면은 '저장 *'(미저장) — 자동 저장이 저장 표시를 정리하지 않음", { srvMs, state: T.onlineEditSaveStateLater }, "20_App.js _runAutoSync(4954~) 성공 후 _dirty/저장 버튼 갱신 누락(추정)");
    ok(!!newId && srvMs >= 0 && srvMs <= 3000, "[a7a7bb0] 온라인 편집(핀 1개) → 3초 안에 서버 반영(Fast 3G)", { newId, srvMs });
    // 배치 모드는 그대로 두면 다음 단계(오프라인 새로고침)가 초기화한다
  }
  // 비교 기준: 온라인 메뉴 트리의 구역 노드 수(오프라인과 대조)
  await tapSel("#mobile-dock [data-act=menu]", "도크 메뉴(온라인)");
  await waitFor("document.body.classList.contains('sidebar-open')", 5000);
  await P.wait(800);
  T.onlineTree = await evSafe(TREE_INFO);
  await snap("online-menu-open");
  await tap(187, 120);
  await waitFor("!document.body.classList.contains('sidebar-open')", 5000);
  await P.wait(500);
  report.touchTargets = (await evSafe("__M.small()")) || [];

  /* ── 2. 오프라인 전환 + 새로고침 ── */
  T.pinsBeforeOffline = await S("S.pins.map(function(p){ return String(p.id); })");
  await setNet("offline");
  await P.wait(1200);
  const tOff = Date.now(); const nOff = loads.length;
  await send("Page.reload", { ignoreCache: false });
  while (loads.length === nOff && Date.now() - tOff < 60000) await P.wait(100);
  T.offlineReloadLoadEventMs = loads.length > nOff ? Date.now() - tOff : -1;
  const shellUp = await waitFor("window.__T && document.getElementById('screen-app')", 30000);
  T.offlineShellMs = shellUp < 0 ? -1 : Date.now() - tOff;
  ok(shellUp >= 0, "오프라인 새로고침: 앱셸(SW 캐시) 표시", { T: T.offlineShellMs });
  // 작업하던 도면으로 바로 돌아오는가? 아니면 허브에서 다시 열어야 하는가
  let offDrawn = await waitFor(drawnExpr, 15000);
  T.offlineAutoResumeDrawing = offDrawn >= 0;
  if (offDrawn < 0) {
    defect("P2", "오프라인 새로고침 후 작업하던 도면으로 자동 복귀하지 않음(허브에서 다시 열어야 함 — 탭 2회 추가)", await evSafe("({ screens: Array.from(document.querySelectorAll('.screen.active')).map(function(s){ return s.id; }) })"));
    await openLeaf("허브 CHECKER 잎(오프라인)");
    offDrawn = await waitFor(drawnExpr + " && __T.State.zoom > 0", 30000);
  }
  T.offlineToDrawingMs = offDrawn < 0 ? -1 : Date.now() - tOff;
  const offTree = await evSafe("document.querySelectorAll('#side-tree .tree-node').length");
  ok(offDrawn >= 0, "오프라인 새로고침: 도면 표시(SW/미디어 캐시)", { T: T.offlineToDrawingMs });
  T.pinsAfterOfflineOpen = await S("S.pins.map(function(p){ return String(p.id); })");
  { const miss = (T.pinsBeforeOffline || []).filter((id) => (T.pinsAfterOfflineOpen || []).indexOf(id) < 0);
    T.pinsMissingOffline = miss;
    if (miss.length) defect("P2", "온라인에서 만든 핀(자동 저장으로 서버 반영 완료) " + miss.length + "개가 오프라인 새로고침 후 화면에서 사라짐 — 오프라인은 [다운로드] 시점 번들로 열려 그 뒤 온라인 작업이 안 보임(온라인 복귀 후 다시 나타나는지는 7단계 서버=로컬 대조)", { missing: miss, before: (T.pinsBeforeOffline || []).length, after: (T.pinsAfterOfflineOpen || []).length }, "32_Offline.js OfflineBundle — 다운로드 후 온라인 저장분을 번들(bundle:dep:)에 갱신하지 않음(추정)"); }
  step("offline-reload", { shellMs: T.offlineShellMs, drawingMs: T.offlineToDrawingMs, treeNodes: offTree, autoResume: T.offlineAutoResumeDrawing });
  await P.wait(1000);
  await snap("offline-drawing");
  const badge = await evSafe("(function(){ var b = document.getElementById('net-badge'); return b ? { visible: __M.visible(b), text: (b.innerText||'').trim(), rect: __M.rect(b) } : null; })()");
  report.offlineBadge = badge;
  if (!badge || !badge.visible) defect("P3", "오프라인 배지(#net-badge)가 지도 화면에 안 보임 — 현장에서 지금 오프라인인지 알 수 없음", badge);

  if (offDrawn < 0) { console.log("  [중단] 오프라인에서 도면을 못 열어 3~7단계 측정 불가"); return; }
  /* ── 3. 오프라인 CHECKER 핀 20개(사람 속도 600ms × 10 + 빠른 속도 250ms × 10) ── */
  // 핀치 줌(실제 2손가락 터치) — 도면을 키워 20개 위치가 서로 겹치지 않게
  const d0 = await evSafe("__M.drawingRect()");
  const cx = Math.round(d0.x + d0.w / 2) - 60, cy = Math.round(d0.y + d0.h / 2);
  const pinchBefore = await evSafe(`(function(){ var p = __T.MapCtrl.viewportToPercent(${cx}, ${cy}); return { pct: p, zoom: __T.State.zoom }; })()`);
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx - 20, y: cy, id: 1 }, { x: cx + 20, y: cy, id: 2 }] });
  for (let k = 1; k <= 8; k++) { await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx - 20 - k * 8, y: cy, id: 1 }, { x: cx + 20 + k * 8, y: cy, id: 2 }] }); await P.wait(30); }
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await P.wait(800);
  T.zoomAfterPinch = await S("S.zoom");
  {
    const pa = await evSafe(`(function(){ var p = __T.MapCtrl.viewportToPercent(${cx}, ${cy}); var img = document.getElementById('map-image'); var r = img ? img.getBoundingClientRect() : null; return { pct: p, zoom: __T.State.zoom, drawW: r ? r.width : null, drawH: r ? r.height : null }; })()`);
    const b = pinchBefore && pinchBefore.pct, a = pa && pa.pct;
    if (b && a && pa.drawW) {
      const dxPct = Math.abs(a.x - b.x), dyPct = Math.abs(a.y - b.y);
      T.pinchCenter = { at: { x: cx, y: cy }, zoom: [pinchBefore.zoom, pa.zoom], dPct: { x: +dxPct.toFixed(3), y: +dyPct.toFixed(3) }, dPx: { x: +(dxPct * pa.drawW / 100).toFixed(1), y: +(dyPct * pa.drawH / 100).toFixed(1) } };
    } else T.pinchCenter = { err: "좌표 읽기 실패", pinchBefore, pa };
    step("pinch-center", T.pinchCenter);
    ok(!!(T.pinchCenter.dPct && T.pinchCenter.dPct.x < 1 && T.pinchCenter.dPct.y < 1) && pa.zoom > pinchBefore.zoom, "[a7a7bb0] 핀치 줌: 손가락 중점 아래 도면 지점 이동 < 1%(p115 계약)", T.pinchCenter);
  }
  // 배치 시작 = 도크 [포인트] 탭(이미 배치 중이면 그대로)
  T.placingBeforeDock = await S("S.placing");
  if (!T.placingBeforeDock) await tapSel("#mobile-dock [data-act=place]", "도크 포인트");
  await P.wait(600);
  const placing = await S("S.placing");
  ok(placing === true, "도크 [포인트] 탭 → 배치 모드", { placing, regMode: await S("S.regMode") });
  await snap("offline-placing-ready");
  const dr = await evSafe("__M.drawingRect()");
  const grid = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) grid.push({ x: Math.round(dr.x + dr.w * (0.1 + c * 0.2)), y: Math.round(dr.y + dr.h * (0.14 + r * 0.24)) });
  const placeRun = async (label, gap, pts) => {
    const before = await S("S.pins.length");
    const blocked = [], chromeHits = [];
    const seenBefore = await evSafe("Object.keys(__M.seen)");
    const tapIdx = await evSafe("__M.taps.length");
    const tStart = Date.now();
    for (let i = 0; i < pts.length; i++) {
      const target = tStart + i * gap;
      const now = Date.now(); if (target > now) await P.wait(target - now);
      const h = await evSafe(`__M.hit(${pts[i].x}, ${pts[i].y})`);
      if (!h || !h.onMap) blocked.push({ i, pt: pts[i], hit: h && h.hit, leaf: h && h.leaf });
      else if (h.chrome) chromeHits.push({ i, pt: pts[i], hit: h.hit, leaf: h.leaf });
      await tap(pts[i].x, pts[i].y);
    }
    const tapWall = Date.now() - tStart;
    await P.wait(2000);
    const after = await S("S.pins.length");
    const lat = await evSafe(`(function(){ var taps = __M.taps.slice(${tapIdx}); var before = ${JSON.stringify(seenBefore || [])}; var ids = Object.keys(__M.seen).filter(function(k){ return before.indexOf(k) < 0; }).sort(function(a, b){ return __M.seen[a] - __M.seen[b]; }); return ids.map(function(id, i){ var t = taps[i]; return t ? Math.round((__M.paint[id] || __M.seen[id]) - t.t) : null; }); })()`);
    const L = (Array.isArray(lat) ? lat : []).filter((x) => x != null).sort((a, b) => a - b);
    const q = (p) => L.length ? L[Math.min(L.length - 1, Math.floor(p * L.length))] : null;
    const res = { gapMs: gap, taps: pts.length, created: after - before, blockedTaps: blocked.length, blocked, tapsOnOverlayInsideViewport: chromeHits, latencyMs: { p50: q(0.5), p95: q(0.95), max: L.length ? L[L.length - 1] : null, all: lat }, tapWallMs: tapWall };
    T["place_" + label] = res;
    step("place-" + label, { gap, created: res.created, blocked: res.blockedTaps, p50: res.latencyMs.p50, p95: res.latencyMs.p95 });
    ok(res.blockedTaps === 0, `오프라인 CHECKER 연속 탭(${gap}ms): 다음 탭 위치가 다른 UI 에 가리지 않음`, blocked.slice(0, 3));
    ok(res.created === pts.length, `오프라인 CHECKER 연속 탭(${gap}ms): 탭 ${pts.length}회 = 핀 ${pts.length}개 생성`, { created: res.created });
    return res;
  };
  await placeRun("human600", 600, grid.slice(0, 10));
  await snap("offline-after-10pins");
  await placeRun("fast250", 250, grid.slice(10, 20));
  const badgeNum = async () => { await P.wait(3500); /* updateNetBadge 3초 주기 */ return evSafe("(function(){ var b = document.getElementById('net-badge'); var t = b ? (b.innerText || '') : ''; var m = t.match(/(\\d+)/); return { text: t.replace(/\\s+/g, ' ').trim(), n: m ? +m[1] : null, visible: b ? __M.visible(b) : false }; })()"); };
  T.badgeAfter20Pins = await badgeNum();
  ok(!!T.badgeAfter20Pins && T.badgeAfter20Pins.n >= 1, "[a7a7bb0] 오프라인 CHECKER 20핀 후 대기 배지 ≥ 1(dirty draft 반영)", T.badgeAfter20Pins);
  // 🔴 [WO 20261006-oplog] 오프라인 CHECKER 핀마다 oplog upsert — 도면 draft PATCH 가 실패해도 /ops 로 올라가는 두 번째 운반체.
  //   (HEAD 19daa4a 실측: 4탭 → oplog 0건. 공유 지점 persistLocalDeployment → OpLog.recordPinDelta 로 수정)
  {
    const srvNow = (await P.srvPins()).map((p) => String(p.id));
    T.oplogAfter20Pins = await evSafe("__T.SyncQueue.loadDraft('oplog:' + __T.State.autoSaveDepId).then(function(o){ var ids = {}; (o||[]).forEach(function(x){ if (x && x.entity === 'pin' && x.action === 'upsert') ids[String(x.id)] = 1; }); return { ops: (o||[]).length, pins: __T.State.pins.map(function(p){ return String(p.id); }), opPins: Object.keys(ids) }; })");
    const o = T.oplogAfter20Pins || {};
    const offlineIds = (o.pins || []).filter((id) => srvNow.indexOf(id) < 0);
    const uncovered = offlineIds.filter((id) => (o.opPins || []).indexOf(id) < 0);
    ok(offlineIds.length >= 20 && uncovered.length === 0, "[WO20261006-oplog] 오프라인 CHECKER 핀 전부 oplog: 기록(핀마다 ≥ 1)", { offline: offlineIds.length, ops: o.ops, uncovered: uncovered.length, sample: uncovered.slice(0, 3) });
  }
  await snap("offline-after-20pins");
  // 핀 번호(배지)가 다른 핀의 리더선 풍선·마커에 가려 안 보이거나 탭이 엉뚱한 핀으로 가는가(66px 간격 격자)
  T.markerSelfHit = await evSafe("(function(){ var ms = Array.from(document.querySelectorAll('.pin-marker[data-id]')).filter(function(e){ return __M.tgtVisible(e); }); var bad = []; ms.forEach(function(m){ var r = __M.tgtRect(m); var h = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2); var mine = h && (m.contains(h) || h.closest('.pin-marker') === m); if (!mine) bad.push({ id: m.getAttribute('data-id'), no: m.getAttribute('data-no'), hit: h ? __M.label(h.closest('.pin-leader-bubble,.pin-marker') || h) : null }); }); return { visible: ms.length, coveredOrStolen: bad.length, sample: bad.slice(0, 6) }; })()");
  if (T.markerSelfHit && T.markerSelfHit.coveredOrStolen > 0) defect("P2", "CHECKER 핀 " + T.markerSelfHit.coveredOrStolen + "/" + T.markerSelfHit.visible + "개의 마커 중심을 다른 요소(이웃 핀의 리더선 번호풍선 등)가 덮음 — 번호가 겹쳐 안 보이고 탭하면 다른 핀이 열림", T.markerSelfHit, "11_UI.js _renderLeader(1072~) CHECKER 리더선 기본 ON — 풍선 오프셋이 이웃 핀 위치와 충돌(66px 간격 실측)");
  // [a7a7bb0 검증] 영역 경계 탭 통과 — 경계선(왼쪽·위쪽)·안쪽 점을 "기존 핀·풍선에서 가장 먼" 위치로 골라 탭
  {
    const zr = await evSafe("(function(){ var z = document.querySelector('.zone-shape[data-zone=z_p114]'); if (!z) return null; var r = z.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()");
    const res = [];
    if (zr) {
      const pick = async (name, cands) => evSafe("(function(){ var R = __M.mapRect(); var obs = Array.from(document.querySelectorAll('.pin-marker[data-id], .pin-leader-bubble')).filter(function(e){ return __M.tgtVisible(e); }).map(function(e){ var r = __M.tgtRect(e); return { x: r.left + r.width/2, y: r.top + r.height/2 }; }); var best = null; " + JSON.stringify(cands) + ".forEach(function(c){ if (c.x < 4 || c.x > innerWidth - 4 || c.y < R.y + 40 || c.y > R.b - 110) return; var h = document.elementFromPoint(c.x, c.y); if (h && h.closest && h.closest('.pin-marker,.pin-leader-bubble,button')) return; var d = obs.reduce(function(m, o){ return Math.min(m, Math.hypot(o.x - c.x, o.y - c.y)); }, 1e9); if (!best || d > best.d) best = { x: Math.round(c.x), y: Math.round(c.y), d: Math.round(d), hit: h ? __M.label(h) : null }; }); return best ? Object.assign({ name: " + JSON.stringify(name) + " }, best) : { name: " + JSON.stringify(name) + ", skipped: '후보 없음(화면 밖/핀 위)' }; })()");
      const steps = Array.from({ length: 19 }, (_, i) => 0.05 + i * 0.05);
      const pts = [
        await pick("왼쪽 경계선", steps.map((t) => ({ x: zr.x + 1, y: zr.y + zr.h * t }))),
        await pick("위쪽 경계선", steps.map((t) => ({ x: zr.x + zr.w * t, y: zr.y + 1 }))),
        await pick("영역 안쪽", steps.flatMap((t) => [0.2, 0.5, 0.8].map((u) => ({ x: zr.x + zr.w * u, y: zr.y + zr.h * t })))),
      ];
      for (const pt of pts) {
        if (!pt || pt.skipped || pt.__err) { res.push(pt); continue; }
        const n0 = await S("S.pins.length");
        await tap(pt.x, pt.y);
        await P.wait(700);
        const n1 = await S("S.pins.length");
        const pap = await evSafe("(function(){ var p = document.getElementById('pin-action-pop'); return !!p && !p.classList.contains('hidden') && __M.visible(p); })()");
        res.push(Object.assign({ created: n1 - n0, panelOpened: pap === true }, pt));
        if (pap === true) { await tapSel("#pap-close", "핀 패널 닫기(영역 탭 뒤)", true); await P.wait(500); }
      }
    }
    T.zoneEdgeTaps = { zone: zr, taps: res };
    step("zone-edge-taps", res.map((r) => r && (r.name + ":" + (r.skipped || r.created) + (r.hit ? "@" + r.hit : ""))));
    const tested = res.filter((r) => r && !r.skipped && !r.__err);
    ok(!!zr && tested.length >= 2 && tested.every((r) => r.created === 1), "[a7a7bb0] 배치 모드에서 영역 경계·안쪽 탭 → 핀 1개씩 생성(탭 통과)", T.zoneEdgeTaps);
  }

  /* ── 4. 오프라인 360 핀 1개 + 사진 선택 → 자동 연결 ── */
  await tapSel("#btn-regmode-photo", "상단 360 모드");
  await P.wait(800);
  if (!(await S("S.placing"))) { await tapSel("#mobile-dock [data-act=place]", "도크 포인트(360)"); await P.wait(600); }
  const regPhoto = await S("{ regMode: S.regMode, placing: S.placing }");
  const d2 = await evSafe("__M.drawingRect()");
  const pp = { x: Math.round(d2.x + d2.w * 0.5), y: Math.round(d2.y + d2.h * 0.03 + 4) };
  const hp = await evSafe(`__M.hit(${pp.x}, ${pp.y})`);
  const idsBeforePhoto = await S("S.pins.map(function(p){ return String(p.id); })");
  const chooser = P.onceEvent("Page.fileChooserOpened", 15000).catch(() => null);
  const tP = Date.now();
  await tap(pp.x, pp.y);
  const fc = await chooser;
  T.photoChooserOpenMs = fc ? Date.now() - tP : -1;
  ok(!!fc, "오프라인 360 핀 탭 → 사진 선택창 즉시 열림", { regPhoto, hit: hp });
  if (fc) {
    await snap("offline-360-chooser-open");
    await send("DOM.setFileInputFiles", { files: [P.PANO_JPG], backendNodeId: fc.backendNodeId });
    const tSel = Date.now();
    // 사진 핀 = 이 탭으로 새로 생긴 핀(ID) — 정확히 1개여야 한다(0/2개면 사진 핀 미식별 → 아래 연결 단언 FAIL)
    const newIds = ((await S("S.pins.map(function(p){ return String(p.id); })")) || []).filter((id) => (idsBeforePhoto || []).indexOf(id) < 0);
    photoPinId = newIds.length === 1 ? newIds[0] : null;
    const pidJ = JSON.stringify(String(photoPinId));
    const linked = photoPinId ? await waitFor("__T.State.pins.some(function(p){ return String(p.id) === " + pidJ + " && (p.pendingOpId || p.imageId || p.imageUrl); })", 60000) : -1;
    T.photoLinkMs = linked < 0 ? -1 : Date.now() - tSel;
    const photoPin = await S("({ newIds: " + JSON.stringify(newIds) + ", pin: S.pins.filter(function(p){ return String(p.id) === " + pidJ + "; }).map(function(p){ return { id: String(p.id), pendingOpId: p.pendingOpId || null, imageId: p.imageId || null, imageUrl: p.imageUrl || null }; }) })");
    ok(linked >= 0, "오프라인 360 사진 → 핀 자동 연결(큐 보관)", photoPin);
  }
  T.queueAfterPhoto = await queueCount();
  T.badgeAfterPhoto = await badgeNum();
  ok(!!T.badgeAfterPhoto && T.badgeAfterPhoto.n >= 2, "[a7a7bb0] 360 사진 후 대기 배지 = 사진 큐 1 + dirty draft 1 이상", { badge: T.badgeAfterPhoto, queue: T.queueAfterPhoto });
  await P.wait(500);
  await snap("offline-360-photo");

  /* ── 5. 오프라인: 번호 대역 메뉴 · 핀 패널 · 구역 열기 ── */
  const ui = report.uiOps = {};
  // 사진 연결 직후 뜨는 안내 토스트가 얼마나 오래 지도를 덮는가
  { const tt = Date.now();
    const gone = await waitFor("!Array.from(document.querySelectorAll('body *')).some(function(e){ return e.children.length < 6 && /pano-test-1\\.jpg/.test(e.textContent || '') && __M.visible(e) && !__M.inMap(e); })", 20000);
    ui.photoToastLingerMs = gone < 0 ? ">20000" : Date.now() - tt;
  }
  // 360 모드는 CHECKER 핀을 숨긴다(모드 = 작업공간) — 다시 CHECKER 로
  await tapSel("#btn-regmode-checkboard", "상단 CHECKER 모드");
  await P.wait(800);
  ui.checkerVisibleMarkers = await evSafe("Array.from(document.querySelectorAll('.pin-marker[data-id]')).filter(function(e){ return __M.tgtVisible(e); }).length");
  const nbOpenExpr = "document.getElementById('btn-numband').getAttribute('aria-expanded') === 'true'";
  let t5 = Date.now();
  const nbBtn = await tapSel("#btn-numband", "번호 대역 버튼");
  const nbOpen = await waitFor(nbOpenExpr, 5000);
  ui.numbandOpenMs = nbOpen < 0 ? -1 : Date.now() - t5;
  await P.wait(300);
  await snap("offline-numband-open");
  // 닫기: 시트 안 닫기 버튼 → 없으면 시트 밖 탭 → 그래도 안 되면 Escape(모바일엔 없음)
  const pinsBeforeNbClose = await S("S.pins.length");
  t5 = Date.now();
  const nbClose = await evSafe("(function(){ var s = document.getElementById('numband-sheet'); if (!s) return null; var c = Array.from(s.querySelectorAll('button')).filter(function(b){ return __M.visible(b) && /닫기|취소|×|✕/.test((b.getAttribute('aria-label')||'') + (b.innerText||'')); })[0]; if (c) { c.setAttribute('data-p114', 'nbclose'); return 'button'; } return 'none'; })()");
  if (nbClose === "button") await tapSel("[data-p114=nbclose]", "번호 대역 시트 닫기", true);
  else await tap(187, 110);
  let nbClosed = await waitFor("!(" + nbOpenExpr + ")", 3000);
  ui.numbandCloseBy = nbClosed >= 0 ? (nbClose === "button" ? "시트 닫기 버튼" : "시트 밖 탭") : null;
  if (nbClosed < 0) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    nbClosed = await waitFor("!(" + nbOpenExpr + ")", 3000);
    ui.numbandCloseBy = nbClosed >= 0 ? "Escape(모바일엔 없음)" : "닫히지 않음";
  }
  ui.numbandCloseMs = nbClosed < 0 ? -1 : Date.now() - t5;
  ui.numbandClosePinsCreated = (await S("S.pins.length")) - pinsBeforeNbClose;
  ok(!!nbBtn && nbOpen >= 0 && nbClosed >= 0, "오프라인 번호 대역 메뉴 열고 닫기", { open: ui.numbandOpenMs, close: ui.numbandCloseMs, by: ui.numbandCloseBy });
  ok(ui.numbandClosePinsCreated === 0, "번호 대역 메뉴 닫기 탭이 핀을 만들지 않음", ui.numbandClosePinsCreated);
  // 핀 패널(CHECKER 마커 탭 → PinActionPop → 닫기)
  const mk = await evSafe("(function(){ var R = __M.mapRect(); var m = Array.from(document.querySelectorAll('.pin-marker[data-id]')).filter(function(e){ if (!__M.tgtVisible(e)) return false; var r = __M.tgtRect(e); var x = r.left + r.width/2, y = r.top + r.height/2; var h = document.elementFromPoint(x, y); return y > R.y && y < R.b && h && (e.contains(h) || h.closest('.pin-marker') === e); }); var e = m[0]; if (!e) return { none: true, total: document.querySelectorAll('.pin-marker[data-id]').length }; var r = __M.tgtRect(e); return { id: e.getAttribute('data-id'), x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height }; })()");
  const pinsBeforePanel = await S("S.pins.length");
  const papOpenExpr = "(function(){ var p = document.getElementById('pin-action-pop'); return !!p && !p.classList.contains('hidden') && __M.visible(p); })()";
  t5 = Date.now();
  if (mk && !mk.none) await tap(mk.x, mk.y);
  const papOpen = await waitFor(papOpenExpr, 5000);
  ui.pinPanelOpenMs = papOpen < 0 ? -1 : Date.now() - t5;
  ui.pinPanelTapCreatedPin = (await S("S.pins.length")) - pinsBeforePanel;
  await P.wait(300);
  if (papOpen >= 0) await snap("offline-pin-panel-open");
  t5 = Date.now();
  if (papOpen >= 0) await tapSel("#pap-close", "핀 패널 닫기");
  const papClosed = await waitFor("!" + papOpenExpr, 5000);
  ui.pinPanelCloseMs = papClosed < 0 ? -1 : Date.now() - t5;
  ok(!!mk && !mk.none && papOpen >= 0 && papClosed >= 0, "오프라인 핀 패널 열고 닫기", { mk, open: ui.pinPanelOpenMs, close: ui.pinPanelCloseMs });
  ok(ui.pinPanelTapCreatedPin === 0, "배치 모드에서 기존 핀 탭은 새 핀을 만들지 않음", ui.pinPanelTapCreatedPin);
  // 구역 열기(도크 [메뉴] → 사이드 트리의 구역 노드)
  t5 = Date.now();
  await tapSel("#mobile-dock [data-act=menu]", "도크 메뉴");
  const sbOpen = await waitFor("document.body.classList.contains('sidebar-open')", 5000);
  ui.menuOpenMs = sbOpen < 0 ? -1 : Date.now() - t5;
  // 구역 노드가 늦게 그려질 수 있다 — 6초까지 기다린 뒤 판정(간헐 여부는 waitedMs 로 기록)
  ui.offlineTreeWaitMs = await waitFor("document.querySelectorAll('#side-tree .tree-node-deck,#side-tree [data-deck-id]').length > 0", 6000);
  ui.offlineTree = await evSafe(TREE_INFO);
  await snap("offline-menu-open");
  report.touchTargetsMenu = (await evSafe("__M.small()")) || [];
  if (!ui.offlineTree || ui.offlineTree.decks < 1) defect("P1", "오프라인 메뉴 트리에 구역(MAIN DECK) 노드가 없음 — 다운로드한 프로젝트인데도 오프라인에서 구역 전환 불가('영역 지정해 구역 만들기' 빈 안내만)", { offline: ui.offlineTree, online: T.onlineTree }, "31_Projects.js loadDecks() 오프라인 폴백(OfflineLoad.decks) 미사용 추정 — 재조사 필요");
  let deckNode = null;
  const pinsBeforeMenuClose = await S("S.pins.length");
  if (ui.offlineTree && ui.offlineTree.decks > 0) {
    await evSafe("(function(){ var e = document.querySelector('#side-tree .tree-node-deck, #side-tree [data-deck-id]'); e && e.scrollIntoView({ block: 'center' }); return 1; })()");
    await P.wait(300);
    t5 = Date.now();
    deckNode = await tapSel("#side-tree .tree-node-deck, #side-tree [data-deck-id]", "트리 구역 노드");
    const back = await waitFor(drawnExpr + " && !document.body.classList.contains('sidebar-open')", 15000);
    ui.zoneOpenMs = back < 0 ? -1 : Date.now() - t5;
  }
  ui.zoneOpenSidebarStillOpen = await evSafe("document.body.classList.contains('sidebar-open')");
  if (ui.zoneOpenSidebarStillOpen === true) {
    if (deckNode) defect("P2", "구역 노드를 탭해도 사이드시트가 열린 채 남아 지도를 가림(한 번 더 닫아야 함)", { zoneOpenMs: ui.zoneOpenMs });
    // 닫기 = 시트 밖 백드롭 탭(도크 [메뉴]는 백드롭에 덮여 있다 — 실측)
    await tap(187, 120);
    const mc = await waitFor("!document.body.classList.contains('sidebar-open')", 5000);
    ui.menuCloseBy = mc >= 0 ? "백드롭 탭" : "닫히지 않음";
  }
  ui.menuClosePinsCreated = (await S("S.pins.length")) - pinsBeforeMenuClose;
  ok(ui.menuClosePinsCreated === 0, "메뉴 닫기(백드롭 탭)가 핀을 만들지 않음", ui.menuClosePinsCreated);
  ok(!!deckNode && ui.zoneOpenMs >= 0, "오프라인 구역 열기 → 도면 다시 표시", { zoneOpenMs: ui.zoneOpenMs, tree: ui.offlineTree });
  await waitFor(drawnExpr, 10000);
  await P.wait(800);
  ui.afterZone = await localState();
  await snap("offline-after-zone");

  /* ── 6. 오프라인 새로고침 2회 → 작업 유실 0 ── */
  const beforeReload = await localState();
  const qBefore = await queueCount();
  const reloads = [];
  for (let k = 1; k <= 2; k++) {
    const tr = Date.now(); const nr = loads.length;
    await send("Page.reload", { ignoreCache: false });
    while (loads.length === nr && Date.now() - tr < 60000) await P.wait(100);
    let dd = await waitFor(drawnExpr + " && __T.State.pins.length > 0", 15000);
    if (dd < 0) { await openLeaf("허브 CHECKER 잎(오프라인 재진입 " + k + ")"); dd = await waitFor(drawnExpr + " && __T.State.pins.length > 0", 30000); }
    await P.wait(1500);
    const st = await localState();
    reloads.push({ k, ms: Date.now() - tr, drawn: dd >= 0, pins: st && st.pins, queue: await queueCount(), dialogs: P.dialogs.filter((d) => d.t >= tr).map((d) => d.type + ':' + d.message) });
    step("offline-reload-" + k, reloads[reloads.length - 1]);
  }
  T.offlineReloads = reloads;
  const bu = reloads.filter((r) => (r.dialogs || []).some((d) => /^beforeunload/.test(d)));
  if (bu.length) defect("P3", "오프라인에서 새로고침하면 브라우저 '사이트에서 나가시겠습니까?' 확인창이 뜸 — 작업은 이미 로컬 보관돼 있는데(새로고침 후 유실 0 실측) 현장 사용자를 멈추게 함", bu.map((r) => ({ k: r.k, dialogs: r.dialogs })), "20_App.js:703-705 beforeunload 가 App._dirty(서버 미반영)만 보고 경고 — 로컬 draft 보관 여부는 안 봄");
  const afterReload = await localState();
  const lost = (beforeReload && afterReload && beforeReload.ids && afterReload.ids) ? beforeReload.ids.filter((id) => afterReload.ids.indexOf(id) < 0) : ["상태 읽기 실패"];
  ok(lost.length === 0 && afterReload && afterReload.pins === beforeReload.pins, "오프라인 새로고침 2회 후 핀 유실 0", { before: beforeReload && beforeReload.pins, after: afterReload && afterReload.pins, lost });
  const qAfter = await queueCount();
  ok(typeof qAfter === "number" && qAfter >= qBefore, "오프라인 새로고침 2회 후 사진 큐 보존", { qBefore, qAfter });
  await snap("offline-after-2-reloads");
  if (process.env.P114_STOP === "reload") { assertOcclusion(); return; }

  /* ── 7. 온라인 복귀 → 자동 동기화 ── */
  /** 🔴 [지휘자 재현 2026-10-06] 사진 연결 판정의 **단일 규칙** — 아래 루프 탈출 조건과 최종
   *  단언(photoOk)이 같은 함수를 쓴다(§G-2-5). 종전엔 루프가 `sp.filter(!checkboard).every(...)`
   *  만 봤는데 **빈 배열의 every() 는 vacuous true** 라, "서버에 사진 핀이 아직 0개" 인 순간에도
   *  photoDone=true 가 됐다 → 업로드가 끝나기 전(실측: Fast 3G 에서 1.73MB base64 = 21.2s,
   *  POST /api/sync/batch 200) 1.6s 에 루프를 빠져나와 종료 12.6s 뒤 측정 → "360 사진이 서버에
   *  올라가 핀에 연결됨" 이 측정 조기 종료 때문에 FAIL 했다(제품은 24.6s 에 연결 완료 — 실측). */
  /*  [WO 20261022-offlinephoto] 대상 = 사진을 고른 그 핀(ID) — 서버에 있고 imageId/imageUrl 보유 + pendingOpId 해소.
   *  추가로 서버 핀 전체에 pendingOpId 잔존 0(번호 핀 쪽 미해소 큐 참조도 놓치지 않게). 사진 핀 미식별(null) = false(vacuous 금지). */
  const srvPhotoLinked = (pins) => {
    const ph = photoPinId ? pins.filter((p) => String(p.id) === String(photoPinId)) : [];
    return ph.length === 1 && ph.every((p) => (p.imageId || p.imageUrl) && !p.pendingOpId) && pins.every((p) => !p.pendingOpId);
  };
  const apiIdx = P.net.api.length;
  const tOn = Date.now();
  await setNet("fast3g");
  const blockSamples = [];
  let syncDone = -1, firstReq = -1, blockShot = null, firstBatch = -1, syncStart = -1;
  const authProbe = [];
  while (Date.now() - tOn < 240000) {
    if (firstReq < 0 && P.net.api.length > apiIdx) firstReq = P.net.api[apiIdx].tIn - tOn;
    const c = await evSafe("(function(){ var d = __M.drawingRect(); if (!d) return { onMap: false, hit: 'no-drawing' }; return __M.hit(d.x + d.w/2, d.y + d.h/2); })()");
    if (c && !c.onMap) { blockSamples.push({ t: Date.now() - tOn, hit: c.hit, leaf: c.leaf }); if (!blockShot) blockShot = await shot("online-sync-blocked"); }
    const lsNow = await localState();
    if (authProbe.length < 8) authProbe.push(Object.assign({ t: Date.now() - tOn }, await evSafe("({ onLine: navigator.onLine, canServerWrite: !!(__T.Auth && __T.Auth.canServerWrite && __T.Auth.canServerWrite()), authOffline: !!(__T.Auth && __T.Auth._offline), offlineOnly: !!(__T.Auth && __T.Auth._offlineOnly), expired: !!(__T.Auth && __T.Auth._expired), syncing: !!__T.SyncQueue._syncing, reconnecting: !!__T.SyncQueue._reconnecting })")));
    if (syncStart < 0 && authProbe.length && authProbe[authProbe.length - 1].syncing) syncStart = authProbe[authProbe.length - 1].t;
    if (syncStart < 0) { const st = await evSafe("!!(__T.SyncQueue._syncing || __T.SyncQueue._reconnecting)"); if (st === true) syncStart = Date.now() - tOn; }
    if (firstBatch < 0) { const b = P.net.api.slice(apiIdx).find((a) => a.p === "/api/sync/batch"); if (b) firstBatch = b.tIn - tOn; }
    if (lsNow && lsNow.pend === 0) {
      const sp = await P.srvPins();
      const ids = sp.map((p) => String(p.id));
      const photoDone = srvPhotoLinked(sp);
      if (sp.length === lsNow.pins && lsNow.ids.every((id) => ids.indexOf(id) >= 0) && photoDone) { syncDone = Date.now() - tOn; break; }
    }
    await P.wait(300);
  }
  T.syncFirstRequestMs = firstReq;
  T.syncStartMs = syncStart; // SyncQueue._syncing/_reconnecting 이 처음 켜진 시각(페이지 안 실측)
  T.syncFirstUploadMs = firstBatch; // 프록시가 업로드 요청을 받은 시각(본문 전송 완료 시점)
  T.syncAuthProbe = authProbe;
  T.syncDoneMs = syncDone;
  T.syncBlockSamples = blockSamples.slice(0, 20);
  const syncApi = P.net.api.slice(apiIdx);
  T.syncApiCalls = syncApi.filter((a) => a.m !== "GET" || a.p.indexOf("/requests") < 0).map((a) => `${a.m} ${a.p} ${a.s} ${a.inBytes}B 도착@${a.tIn - tOn}ms 응답@${a.t - tOn}ms`).slice(0, 40);
  T.syncUploadBytes = syncApi.reduce((n, a) => n + (a.inBytes || 0), 0);
  const drawingBytes = fs.statSync(DRAWING_PNG).size;
  const reup = syncApi.filter((a) => a.p === "/api/r2/upload" && a.inBytes === drawingBytes);
  if (reup.length) defect("P3", "온라인 복귀 동기화 때 바뀌지 않은 도면 이미지(" + drawingBytes + "B)를 R2 에 다시 올림 — Fast 3G 에서 수 초 낭비 + R2 중복 객체", reup.map((a) => `${a.m} ${a.p} ${a.inBytes}B`), "05_SyncQueue._onReconnect → App._flushDirtyDrafts 가 pages 를 재업로드(추정)");
  step("online-sync", { firstReq, syncDone, blockedSamples: blockSamples.length, calls: syncApi.length });
  const onSnap = await snap("online-after-sync");
  const lsEnd = await localState();
  const sp = await P.srvPins();
  const srvIds = sp.map((p) => String(p.id));
  ok(syncDone >= 0, "온라인 복귀 후 자동 동기화 완료(사용자 조작 없이, 240s 안)", { firstReq, local: lsEnd && lsEnd.pins, server: sp.length, pend: lsEnd && lsEnd.pend });
  // 동기화가 끝났는데도 화면이 "저장 *"(미저장)로 남는가 — 5초 더 기다린 뒤 판정
  await P.wait(5000);
  T.afterSyncSaveState = await evSafe("(function(){ var b = document.getElementById('btn-save'); return { dirty: !!(__T.App && __T.App._dirty), btn: b ? { visible: __M.visible(b), text: (b.innerText||'').trim(), cls: b.className } : null, syncBadge: (document.getElementById('sync-badge')||{}).innerText || null, netBadge: (document.getElementById('net-badge')||{}).innerText || null }; })()");
  await P.wait(6000);
  T.afterSyncBadgeLater = await evSafe("(function(){ var b = document.getElementById('net-badge'); return b ? { text: (b.innerText||'').replace(/\s+/g,' ').trim(), visible: __M.visible(b) } : null; })()");
  if (syncDone >= 0 && T.afterSyncBadgeLater && T.afterSyncBadgeLater.visible && /\d/.test(T.afterSyncBadgeLater.text)) defect("P3", "동기화 완료(서버=로컬) 11초 뒤에도 대기 배지가 남음: '" + T.afterSyncBadgeLater.text + "'", { badge: T.afterSyncBadgeLater, syncDoneMs: syncDone }, "32_Offline.js updateNetBadge — App._countDirtyDrafts 가 서버 반영 끝난 draft 를 계속 셈(추정)");
  if (syncDone >= 0 && T.afterSyncSaveState && T.afterSyncSaveState.dirty) defect("P2", "서버 동기화가 끝났는데(서버 핀 = 로컬 핀, 사진 연결) 화면은 계속 '저장 *'(미저장) — 현장 사용자가 다시 저장을 누르거나 불안해함", T.afterSyncSaveState, "05_SyncQueue._onReconnect → App._flushDirtyDrafts 가 서버 반영 후 App._dirty/저장 버튼을 정리하지 않음(추정)");
  if (syncStart < 0 || syncStart > 5000) defect("P2", "온라인 복귀 후 동기화가 5초 안에 시작하지 않음(" + syncStart + "ms)", { syncStart, probe: authProbe }, "20_App.js:61-64 online → +600ms SyncQueue._onReconnect");
  ok(!!lsEnd && sp.length === lsEnd.pins && lsEnd.ids.every((id) => srvIds.indexOf(id) >= 0), "서버 핀 수 = 로컬 핀 수(ID 일치)", { local: lsEnd && lsEnd.pins, server: sp.length, missing: lsEnd && lsEnd.ids ? lsEnd.ids.filter((id) => srvIds.indexOf(id) < 0) : null });
  const srvPhoto = sp.filter((p) => String(p.id) === String(photoPinId));
  const pano = await P.db.prepare("SELECT COUNT(*) AS n FROM pano_images").first().catch(() => ({ n: -1 }));
  const r2list = await P.r2.list().catch(() => ({ objects: [] }));
  report.serverAfterSync = { pins: sp.length, photoPinId, srvPendingOpIds: sp.filter((p) => p.pendingOpId).length, photoPins: srvPhoto.map((p) => ({ id: String(p.id), imageId: p.imageId || null, imageUrl: p.imageUrl || null, pendingOpId: p.pendingOpId || null })), panoImagesRows: pano && pano.n, r2Keys: (r2list.objects || []).map((o) => o.key + " " + o.size + "B") };
  const photoOk = srvPhotoLinked(sp);   // 루프 탈출 조건과 같은 단일 규칙(§G-2-5)
  ok(photoOk, "360 사진이 서버에 올라가 핀에 연결됨(pendingOpId 해소)", report.serverAfterSync);
  ok(blockSamples.length === 0, "동기화 중 도면 중앙이 다른 UI 로 막히지 않음", blockSamples.slice(0, 5));
  T.coverAfterSyncPct = onSnap.occ && onSnap.occ.pct;

  assertOcclusion();
}

/** 가림 판정(지도 화면 전 단계) — 도면 중앙·네 모서리 탭이 지도에 닿아야 한다 */
function assertOcclusion() {
  for (const [label, o] of Object.entries(report.occlusion)) {
    if (label === "cold-hub") continue; // 허브는 지도 화면이 아님
    if (/numband-open|pin-panel-open|menu-open|chooser-open/.test(label)) continue; // 사용자가 의도적으로 연 패널 — 기록만
    const bl = (o.targets && o.targets.points || []).filter((p) => !p.onMap);
    ok(bl.length === 0, `[가림] ${label}: 도면 중앙·네 모서리 탭이 지도에 닿음`, bl);
  }
}
