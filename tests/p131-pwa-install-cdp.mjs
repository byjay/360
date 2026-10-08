// [WO 20261008-pwadesktop] PC(Chrome/Edge) PWA 설치 — "설치 준비 중" 무한 대기 회귀 테스트.
// 헤드리스 Chrome(CDP, p112 패턴 재사용)으로 public/js/modules/38_Install.js 를 실제 브라우저에서 구동한다.
// Chrome 미존재 시 SKIP(기존 -cdp.mjs 관례 — node --test 기본 글롭에는 안 걸림, 수동 실행 전용).
import { spawn } from "child_process";
import WebSocket from "ws";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const REPO_ROOT = path.join(__dirname, "..");
const MODULE_FILE = path.join(REPO_ROOT, "public", "js", "modules", "38_Install.js");
const TMP_ROOT = path.join(REPO_ROOT, ".tmp"); // 🔴 CLAUDE.md §G-5
const SHOT_DIR = path.join(TMP_ROOT, "fixinstall");
const HARNESS = path.join(TMP_ROOT, "fixinstall", "harness.html");

if (!fs.existsSync(CHROME)) {
  console.log("[SKIP] Chrome 실행파일을 찾지 못함(" + CHROME + ") — CDP 실측 생략(p112 관례와 동일)");
  process.exit(0);
}
fs.mkdirSync(SHOT_DIR, { recursive: true });

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
function serveStatic(moduleSrc) {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/38_Install.js") { res.writeHead(200, { "Content-Type": "application/javascript" }); res.end(moduleSrc); return; }
    if (p === "/" || p === "/harness.html") {
      fs.readFile(HARNESS, (err, data) => { if (err) { res.writeHead(404); res.end("nf"); return; } res.writeHead(200, { "Content-Type": "text/html" }); res.end(data); });
      return;
    }
    res.writeHead(404); res.end("nf");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
async function readDevToolsPort(profileDir) {
  const file = path.join(profileDir, "DevToolsActivePort");
  for (let i = 0; i < 60; i++) {
    try { const txt = fs.readFileSync(file, "utf8"); const port = parseInt(txt.split("\n")[0].trim(), 10); if (port > 0) return port; } catch (e) {}
    await wait(150);
  }
  throw new Error("DevToolsActivePort not found");
}
async function getWsUrl(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/json/list`, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => resolve(JSON.parse(d))); }).on("error", reject);
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
    const handler = (raw) => { const msg = JSON.parse(raw); if (msg.id === id) { ws.removeListener("message", handler); if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result); } };
    ws.on("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function withPage(sitePort, urlPath, fn) {
  const profileDir = path.join(TMP_ROOT, "cdp-p131-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
  try {
    await wait(800);
    const port = await readDevToolsPort(profileDir);
    const wsUrl = await getWsUrl(port);
    const ws = new WebSocket(wsUrl);
    await new Promise((r) => ws.on("open", r));
    await send(ws, "Page.enable");
    await send(ws, "Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const loadFired = new Promise((resolve) => { const h = (raw) => { const msg = JSON.parse(raw); if (msg.method === "Page.loadEventFired") { ws.removeListener("message", h); resolve(); } }; ws.on("message", h); });
    await send(ws, "Page.navigate", { url: `http://127.0.0.1:${sitePort}${urlPath}` });
    await loadFired;
    await wait(200);
    const result = await fn(ws);
    ws.close();
    return result;
  } finally { chrome.kill(); }
}
async function evalJson(ws, expr) {
  const r = await send(ws, "Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("eval failed: " + JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function shot(ws, name) {
  const s = await send(ws, "Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(SHOT_DIR, name + ".png"), Buffer.from(s.data, "base64"));
}

const STATE_EXPR = `JSON.stringify({
  btnHidden: document.getElementById('pwa-install-accept').classList.contains('hidden'),
  btnDisabled: document.getElementById('pwa-install-accept').disabled,
  btnText: document.getElementById('pwa-install-accept').textContent,
  sub: document.getElementById('pwa-install-sub').textContent,
  iosHidden: document.getElementById('pwa-install-ios').classList.contains('hidden'),
  fabExists: !!document.getElementById('pwa-install-btn')
})`;

async function run(moduleSrc) {
  const server = await serveStatic(moduleSrc);
  const port = server.address().port;
  const results = {};
  try {
    // S1: 데스크톱(Chrome 헤드리스 자체 UA), prompt 없음 — 타임아웃 전/후 비교 + FAB·배너 SoT 일치
    results.s1 = await withPage(port, "/harness.html", async (ws) => {
      await evalJson(ws, "JSON.stringify(Install.showBanner(true))"); // 타임아웃 전 — "준비 중"
      const before = JSON.parse(await evalJson(ws, STATE_EXPR));
      await shot(ws, "s1-before-timeout");
      await wait(5600); // PROMPT_TIMEOUT_MS(5000) 초과
      await evalJson(ws, "JSON.stringify(Install.showBanner(true))");
      const afterBanner = JSON.parse(await evalJson(ws, STATE_EXPR));
      await shot(ws, "s1-after-timeout-banner");
      // FAB 클릭(SoT 동일 경로인지 확인) — hide() 후 클릭해 재오픈 상태를 본다
      await evalJson(ws, "Install.hide(); document.getElementById('pwa-install-btn').click(); 'ok'");
      await wait(50);
      const afterFab = JSON.parse(await evalJson(ws, STATE_EXPR));
      await shot(ws, "s1-after-timeout-fab");
      return { before, afterBanner, afterFab };
    });

    // S2: beforeinstallprompt 가 타임아웃 전에 도착 — 설치 버튼 활성화, FAB 클릭 시 prompt() 호출(SoT: accept 경로)
    results.s2 = await withPage(port, "/harness.html", async (ws) => {
      await wait(500);
      await evalJson(ws, "window.__fireBeforeInstallPrompt(); 'ok'");
      await wait(50);
      await evalJson(ws, "JSON.stringify(Install.showBanner(true))");
      const ready = JSON.parse(await evalJson(ws, STATE_EXPR));
      await shot(ws, "s2-ready");
      await evalJson(ws, "document.getElementById('pwa-install-btn').click(); 'ok'");
      await wait(50);
      const promptCalled = await evalJson(ws, "JSON.stringify(!!window.__promptCalled)");
      return { ready, promptCalled: JSON.parse(promptCalled) };
    });

    // S3: standalone=1 — 설치됨 판정, 배너/FAB 모두 비노출
    results.s3 = await withPage(port, "/harness.html?standalone=1", async (ws) => {
      const fabExists = JSON.parse(await evalJson(ws, "JSON.stringify(!!document.getElementById('pwa-install-btn'))"));
      const bannerOk = JSON.parse(await evalJson(ws, "JSON.stringify(Install.showBanner(true))"));
      const alreadyReason = await evalJson(ws, "Install.alreadyInstalledReason()");
      await shot(ws, "s3-standalone");
      return { fabExists, bannerOk, alreadyReason };
    });

    // S4: iOS UA — 처음부터 안내 전용(타임아웃 대기 없이 즉시)
    results.s4 = await withPage(port, "/harness.html?ios=1", async (ws) => {
      await evalJson(ws, "JSON.stringify(Install.showBanner(true))");
      const st = JSON.parse(await evalJson(ws, STATE_EXPR));
      await shot(ws, "s4-ios");
      return st;
    });
  } finally { server.close(); }
  return results;
}

(async () => {
  const moduleSrc = fs.readFileSync(MODULE_FILE, "utf8");
  console.log("[CDP] 정상 소스 — 시나리오 4종 실행");
  const r = await run(moduleSrc);
  console.log(JSON.stringify(r, null, 2));

  let fail = 0;
  const check = (name, cond) => { if (!cond) { console.log("  FAIL " + name); fail = 1; } else console.log("  PASS " + name); };

  check("S1 타임아웃 전: 버튼 비활성+준비중 문구", r.s1.before.btnDisabled === true && /준비 중/.test(r.s1.before.btnText));
  check("S1 타임아웃 후(배너): 버튼 숨김 + 안내문구(설치 아이콘 또는 메뉴)", r.s1.afterBanner.btnHidden === true && /설치 아이콘|앱 설치/.test(r.s1.afterBanner.sub));
  check("S1 FAB 클릭도 동일 안내문구(SoT 일치)", r.s1.afterFab.sub === r.s1.afterBanner.sub && r.s1.afterFab.btnHidden === true);
  check("S2 prompt 도착: 버튼 활성+설치 문구", r.s2.ready.btnDisabled === false && r.s2.ready.btnText === "설치");
  check("S2 FAB 클릭 → accept() 경로로 prompt() 호출", r.s2.promptCalled === true);
  check("S3 standalone: FAB 미생성 + 배너 거부 + 이미설치 사유", r.s3.fabExists === false && r.s3.bannerOk === false && r.s3.alreadyReason === "이미 설치됨");
  check("S4 iOS: 버튼 숨김 + ios 안내 노출", r.s4.btnHidden === true && r.s4.iosHidden === false);

  // ── 뮤테이션: _promptTimedOut 을 세팅하는 라인을 무력화하면 S1 타임아웃-후 가드가 깨져야 한다 ──
  const needle = "this._promptTimedOut = true; this._applyScreenVisibility();";
  const mutated = moduleSrc.replace(needle, "/* mutated: no-op */ this._applyScreenVisibility();");
  if (mutated === moduleSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); fail = 1; }
  else {
    console.log("\n[CDP][뮤테이션] 타임아웃 플래그 세팅 제거 — 타임아웃 후에도 '준비 중' 문구가 그대로 남아야 함(=가드 제거 시 버그가 재현되어야 테스트가 유효)");
    const mr = await run(mutated);
    const stillWaiting = mr.s1.afterBanner.btnText === "설치 준비 중" && mr.s1.afterBanner.btnDisabled === true && mr.s1.afterBanner.btnHidden === false;
    if (stillWaiting) console.log("  PASS(뮤테이션 효과 확인) — 가드 제거 시 무한 '준비 중' 재현됨 → 테스트가 실효성 있음");
    else { console.log("  FAIL 뮤테이션을 넣어도 무한대기가 재현되지 않음(테스트가 실효성 없음) actual sub=" + mr.s1.afterBanner.sub); fail = 1; }
  }

  console.log("\n" + (fail ? "FAILED" : "ALL PASS") + " — 스크린샷: " + SHOT_DIR);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
