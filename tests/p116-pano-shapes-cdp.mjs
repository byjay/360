// [WO 20261001-panoshapes] 360 사진 안 도형(사각형·원) + 리더선 + 라벨 + 첨부 배지 — 헤드리스 Chrome(CDP) 실측.
// public/index.html + 실제 CSS 3종 + "지금 이 순간의" public/js/modules/* 소스(p112 패턴 재사용)를
// 그대로 로드해, PanoViewer.Shapes.render()가 실제로 그리는 SVG(외곽선+리더선+화살촉)와 HTML 라벨
// (이름/노트/첨부배지)을 .tmp/fixpanoshape/ 에 스크린샷으로 남긴다. THREE/WebGL 텍스처 파이프라인은
// p112-pano-dive-cdp.mjs 와 동일 관례로 재현하지 않는다(이 하네스의 검증 대상은 DOM/CSS 레이어).
import { spawn } from "child_process";
import WebSocket from "ws";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const REPO_PUBLIC = path.join(__dirname, "..", "public");
const MODULES_DIR = path.join(REPO_PUBLIC, "js", "modules");
const TMP_ROOT = path.join(__dirname, "..", ".tmp"); // 🔴 CLAUDE.md §G-5 — 프로젝트 안 .tmp 고정
const SHOT_DIR = path.join(TMP_ROOT, "fixpanoshape");

if (!fs.existsSync(CHROME)) {
  console.log("[SKIP] Chrome 실행파일을 찾지 못함(" + CHROME + ") — CDP 실측 생략(p112 와 동일 관례)");
  process.exit(0);
}
fs.mkdirSync(SHOT_DIR, { recursive: true });

function buildBundle() {
  const manifest = fs.readFileSync(path.join(MODULES_DIR, "_manifest.txt"), "utf8").trim().split(/\r?\n/);
  return manifest.map((f) => fs.readFileSync(path.join(MODULES_DIR, f), "utf8")).join("\n");
}
function exposeForTest(bundle) {
  const idx = bundle.lastIndexOf("})();");
  if (idx === -1) return bundle;
  const inject = "\n  try { window.__T_PanoViewer = PanoViewer; window.__T_App = App; window.__T_State = State; window.__T_Auth = Auth; } catch (e) {}\n";
  return bundle.slice(0, idx) + inject + bundle.slice(idx);
}
function makeServeDir(bundleContent) {
  const dir = path.join(TMP_ROOT, "p116-serve-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(path.join(dir, "js"), { recursive: true });
  fs.writeFileSync(path.join(dir, "js", "main.js"), bundleContent);
  return dir;
}
function serveStatic(overlayDir) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    if (p === "/sw.js") { res.writeHead(404); res.end("nf"); return; }
    const overlayFull = path.join(overlayDir, p);
    const realFull = path.join(REPO_PUBLIC, p);
    const full = (p === "/js/main.js") ? overlayFull : realFull;
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); res.end("nf"); return; }
      const ext = path.extname(full);
      const ct = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript" }[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": ct });
      res.end(data);
    });
  });
  return listenSafePort(server, "127.0.0.1");
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function readDevToolsPort(profileDir) {
  const file = path.join(profileDir, "DevToolsActivePort");
  for (let i = 0; i < 40; i++) {
    try {
      const txt = fs.readFileSync(file, "utf8");
      const port = parseInt(txt.split("\n")[0].trim(), 10);
      if (port > 0) return port;
    } catch (e) {}
    await wait(150);
  }
  throw new Error("DevToolsActivePort 파일을 찾지 못함(" + file + ")");
}
async function getWsUrl(port) {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/json/list`, (r) => {
          let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => resolve(JSON.parse(d)));
        }).on("error", reject);
      });
      const page = list.find((t) => t.type === "page");
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (e) {}
    await wait(250);
  }
  throw new Error("chrome devtools not up");
}
let idc = 0;
function send(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++idc;
    const handler = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id === id) {
        ws.removeListener("message", handler);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const SETUP_JS = `
  (function(){
    document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
    document.getElementById('screen-app').classList.add('active');
    document.body.classList.remove('role-viewer');
    document.body.classList.add('role-designer');
    var gate = document.getElementById('login-gate');
    if (gate) { gate.classList.remove('on'); gate.classList.add('hidden'); }
    window.__T_State.mode = 'designer';
    window.__T_Auth.isDesigner = true;
    var PV = window.__T_PanoViewer;
    var ov = document.getElementById('pano-overlay');
    ov.classList.remove('hidden');
    document.getElementById('pano-canvas').classList.remove('hidden');
    document.getElementById('pano-controls').classList.remove('hidden');
    var canvas = document.getElementById('pano-canvas');
    PV.canvas = canvas; PV.camera = {}; PV.renderer = {};
    PV.open = true;
    PV.S = { lon: 0, lat: 0, fov: 75, dragging: false, lx: 0, ly: 0, autoRotate: false, roll: 0 };
    var rect = { id: 'sh-rect', type: 'rect', kind: 'defect', label: 'FW PUMP NO.1', note: '용접부 균열 — 재검사 필요',
      lon1: -14, lat1: -8, lon2: 14, lat2: 8, equipMark: false, attachments: [] };
    var circle = { id: 'sh-circle', type: 'circle', kind: 'equip', label: 'VALVE V-203', note: '설치 위치',
      lon: 45, lat: 5, radiusDeg: 9, equipMark: true,
      attachments: [{ id: 'a1', url: '/api/r2/object/assets/stub.png', name: 'photo.png', kind: 'image' }] };
    PV._currentPin = { id: 't1', spots: [rect, circle] };
    PV.renderSpots(PV._currentPin.spots);
    return 'ok';
  })();
`;

async function run() {
  const bundle = exposeForTest(buildBundle());
  const overlayDir = makeServeDir(bundle);
  const server = await serveStatic(overlayDir);
  const sitePort = server.address().port;
  const profileDir = path.join(TMP_ROOT, "cdp-p116-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--window-size=1024,768",
    "about:blank",
  ], { stdio: "ignore" });
  let failed = 0;
  const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };
  try {
    await wait(800);
    const port = await readDevToolsPort(profileDir);
    const wsUrl = await getWsUrl(port);
    const ws = new WebSocket(wsUrl);
    await new Promise((r) => ws.on("open", r));
    await send(ws, "Page.enable");
    await send(ws, "Emulation.setDeviceMetricsOverride", { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
    const loadFired = new Promise((resolve) => {
      const h = (raw) => { const msg = JSON.parse(raw); if (msg.method === "Page.loadEventFired") { ws.removeListener("message", h); resolve(); } };
      ws.on("message", h);
    });
    await send(ws, "Page.navigate", { url: `http://127.0.0.1:${sitePort}/index.html` });
    await loadFired;
    await wait(400);
    const setupRes = await send(ws, "Runtime.evaluate", { expression: SETUP_JS, returnByValue: true, awaitPromise: false });
    if (setupRes.result && setupRes.result.subtype === "error") throw new Error("setup 실패: " + JSON.stringify(setupRes));
    ok(setupRes.result && setupRes.result.value === "ok", "데스크톱(1024px) — 설정 스크립트 실행 성공(사각형+원 2개 렌더)");
    await wait(200);

    // 데스크톱 1024px — 사각형+리더선+라벨, 원+첨부배지
    const shot1 = await send(ws, "Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOT_DIR, "desktop-1024-rect-circle.png"), Buffer.from(shot1.data, "base64"));
    console.log("  saved: " + path.join(SHOT_DIR, "desktop-1024-rect-circle.png"));

    // 도형 라벨 DOM 실측 — 이름/노트/첨부배지 텍스트가 실제로 존재하는지
    const domCheckExpr = `JSON.stringify({
      labels: Array.prototype.map.call(document.querySelectorAll('.pano-shape-label'), function(l){ return l.textContent; }),
      svgOutlines: document.querySelectorAll('.pano-shape-outline').length,
      svgLeaders: document.querySelectorAll('.pano-shape-leader').length,
      attBadge: document.querySelectorAll('.psl-att-badge').length,
      equipIcon: document.querySelectorAll('.psl-equip-ic').length
    })`;
    const domR = await send(ws, "Runtime.evaluate", { expression: domCheckExpr, returnByValue: true });
    const dom = JSON.parse(domR.result.value);
    console.log("  DOM 실측:", JSON.stringify(dom));
    ok(dom.labels.length === 2, "라벨 DOM 2개 생성(사각형+원)");
    ok(dom.labels.some((t) => t.includes("FW PUMP NO.1")), "사각형 라벨에 이름(FW PUMP NO.1) 표시");
    ok(dom.labels.some((t) => t.includes("VALVE V-203")), "원 라벨에 이름(VALVE V-203) 표시");
    ok(dom.svgOutlines >= 2, "SVG 외곽선(사각형/원) 2개 이상 생성 — 실측 " + dom.svgOutlines);
    ok(dom.svgLeaders >= 2, "SVG 리더선 2개 이상 생성 — 실측 " + dom.svgLeaders);
    ok(dom.attBadge >= 1, "첨부 배지(📎) 1개 이상 — 실측 " + dom.attBadge);
    ok(dom.equipIcon >= 1, "장비 설치 위치 아이콘(⚙) 1개 이상 — 실측 " + dom.equipIcon);

    // 목록 패널 — 탭 열어 캡처
    await send(ws, "Runtime.evaluate", { expression: "document.getElementById('pano-spot-list').classList.remove('hidden'); window.__T_App.renderSpotList();", returnByValue: true });
    await wait(150);
    const shot2 = await send(ws, "Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOT_DIR, "desktop-1024-spotlist.png"), Buffer.from(shot2.data, "base64"));
    console.log("  saved: " + path.join(SHOT_DIR, "desktop-1024-spotlist.png"));
    const listHtmlR = await send(ws, "Runtime.evaluate", { expression: "document.getElementById('pano-spot-list-body').innerHTML", returnByValue: true });
    ok(/▭/.test(listHtmlR.result.value) && /◯/.test(listHtmlR.result.value), "목록에 사각형(▭)·원(◯) 아이콘 표시");

    // 375px 모바일
    await send(ws, "Emulation.setDeviceMetricsOverride", { width: 375, height: 760, deviceScaleFactor: 2, mobile: true });
    await wait(200);
    const shot3 = await send(ws, "Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOT_DIR, "mobile-375.png"), Buffer.from(shot3.data, "base64"));
    console.log("  saved: " + path.join(SHOT_DIR, "mobile-375.png"));

    // ── 뮤테이션 1건: Shapes.render를 호출하지 않으면(=기능 제거) 라벨 DOM이 0개여야 함
    ws.close();
    chrome.kill();
    await wait(300);
    const pvSrc = fs.readFileSync(path.join(MODULES_DIR, "06_PanoViewer.js"), "utf8");
    const needle = "if (this.Shapes && this.Shapes.render) this.Shapes.render(this, this._spots);";
    const mutatedSrc = pvSrc.replace(needle, "/* removed for mutation test */");
    if (mutatedSrc === pvSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함"); failed++; }
    else {
      const manifest = fs.readFileSync(path.join(MODULES_DIR, "_manifest.txt"), "utf8").trim().split(/\r?\n/);
      const mutBundle = exposeForTest(manifest.map((f) => f === "06_PanoViewer.js" ? mutatedSrc : fs.readFileSync(path.join(MODULES_DIR, f), "utf8")).join("\n"));
      const overlayDir2 = makeServeDir(mutBundle);
      const server2 = await serveStatic(overlayDir2);
      const port2 = server2.address().port;
      const profileDir2 = path.join(TMP_ROOT, "cdp-p116-mut-" + Date.now());
      const chrome2 = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profileDir2}`, "--window-size=1024,768", "about:blank"], { stdio: "ignore" });
      try {
        await wait(800);
        const devPort2 = await readDevToolsPort(profileDir2);
        const wsUrl2 = await getWsUrl(devPort2);
        const ws2 = new WebSocket(wsUrl2);
        await new Promise((r) => ws2.on("open", r));
        await send(ws2, "Page.enable");
        const loadFired2 = new Promise((resolve) => {
          const h = (raw) => { const msg = JSON.parse(raw); if (msg.method === "Page.loadEventFired") { ws2.removeListener("message", h); resolve(); } };
          ws2.on("message", h);
        });
        await send(ws2, "Page.navigate", { url: `http://127.0.0.1:${port2}/index.html` });
        await loadFired2;
        await wait(400);
        await send(ws2, "Runtime.evaluate", { expression: SETUP_JS, returnByValue: true });
        await wait(150);
        const domR2 = await send(ws2, "Runtime.evaluate", { expression: "document.querySelectorAll('.pano-shape-label').length", returnByValue: true });
        ok(domR2.result.value === 0, "뮤테이션(Shapes.render 호출 제거) 적용 시 라벨 DOM이 0개로 뒤집힘(테스트 실효성 증명)");
        ws2.close();
      } finally { chrome2.kill(); server2.close(); }
    }
  } finally {
    try { chrome.kill(); } catch (e) {}
    server.close();
  }
  console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED") + " — 스크린샷: " + SHOT_DIR);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error("ERROR", e); process.exit(1); });
