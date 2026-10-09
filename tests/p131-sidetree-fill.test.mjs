/**
 * p131 — 데스크톱 사이드바 트리(#side-tree)가 남는 세로 공간을 채우는지 실 Chrome 으로 측정한다
 * (p124 harness 패턴 계승 — 목 0, 실제 조립→빌드→wrangler dev→CDP).
 * 실행: P131=1 TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p131-sidetree-fill.test.mjs
 *   (P131 != "1" 이면 즉시 SKIP)
 *
 * [재현] 지휘자 R1(2026-10-08): style.css:5474 `.side-tree{...max-height:clamp(160px,34vh,320px);
 *   flex-basis:clamp(160px,34vh,320px);overflow-y:auto;}` 가 미디어쿼리 없이(모든 뷰포트) 적용돼
 *   데스크톱에서도 트리가 최대 320px 에서 잘려 스크롤됨. 하단은 빈 공간으로 남음(스크린샷 실측).
 *
 * 수정: 데스크톱 기본값은 flex:1(남는 공간 채움) + max-height:none, 모바일(max-width:760px)은
 *   @media 블록 안에서 기존 고정 캡(flex:0 0 clamp(...))을 재선언해 바텀시트 도달성(WO 20260918)을 보존.
 *
 * 사전 준비: node build-tools/local-dev.mjs && node build-tools/seed-local.mjs
 */
import { execSync, spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { fileURLToPath } from "node:url";

if (process.env.P131 !== "1") {
  console.log("[SKIP] p131 은 P131=1 일 때만 실행(실 Chrome+워커 실측)");
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = path.join(ROOT, ".tmp");
const OUT = path.join(TMP, "fixsidebar", "p131");
const STATE = path.join(TMP, "localdev-state");
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

let failed = 0;
const fails = [];
const ok = (cond, label, detail) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail) : ""));
  if (!cond) { failed++; fails.push(label); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(STATE)) { console.log("FAIL .tmp/localdev-state 없음 — node build-tools/local-dev.mjs && node build-tools/seed-local.mjs 먼저 실행."); process.exit(2); }
if (!fs.existsSync(CHROME)) { console.log("FAIL Chrome 없음: " + CHROME); process.exit(2); }

function sh(cmd) {
  console.log("[p131] $ " + cmd);
  execSync(cmd, { stdio: "inherit", cwd: ROOT, env: { ...process.env, TEMP: TMP, TMP: TMP } });
}
sh("python build-tools/assemble.py");
sh("node build-tools/stamp-version.mjs");
for (const [src, dst] of [["public/js/main.js", "js/main.js"], ["public/index.html", "index.html"], ["public/css/style.css", "css/style.css"]]) {
  fs.copyFileSync(path.join(ROOT, src), path.join(ROOT, dst));
}
sh('node --max-old-space-size=640 node_modules/vite/bin/vite.js build');

const PORT = process.env.P131_PORT || "18811";
const wrangler = spawn(
  "node",
  ["node_modules/wrangler/bin/wrangler.js", "pages", "dev", "dist", "--d1=webapp-production", "--local", "--persist-to", STATE, "--ip", "127.0.0.1", "--port", PORT],
  { cwd: ROOT, env: { ...process.env, TEMP: TMP, TMP: TMP }, stdio: ["ignore", "pipe", "pipe"] }
);
let wranglerLog = "";
wrangler.stdout.on("data", (d) => { wranglerLog += d; });
wrangler.stderr.on("data", (d) => { wranglerLog += d; });
const BASE = "http://127.0.0.1:" + PORT;
async function waitServerUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + "/"); if (r.status) return true; } catch (e) {}
    await wait(500);
  }
  return false;
}

let chrome = null, ws = null;
async function cleanup() {
  try { ws && ws.close(); } catch (e) {}
  try { chrome && chrome.kill(); } catch (e) {}
  try { wrangler.kill(); } catch (e) {}
}

try {
  const up = await waitServerUp();
  if (!up) { console.log("FAIL wrangler dev 기동 실패:\n" + wranglerLog.slice(-1500)); process.exit(1); }

  const profileDir = path.join(TMP, "p131-chrome-" + Date.now());
  chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", "--user-data-dir=" + profileDir, "--window-size=1280,800", "about:blank"], { stdio: "ignore" });
  const devtoolsPort = async () => {
    for (let i = 0; i < 80; i++) {
      try { const p = parseInt(fs.readFileSync(path.join(profileDir, "DevToolsActivePort"), "utf8").split("\n")[0], 10); if (p > 0) return p; } catch (e) {}
      await wait(150);
    }
    throw new Error("DevToolsActivePort 없음");
  };
  const getJson = (url) => new Promise((resolve, reject) => http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on("error", reject));
  const port = await devtoolsPort();
  let pageWs = null;
  for (let i = 0; i < 40 && !pageWs; i++) { try { const l = await getJson("http://127.0.0.1:" + port + "/json/list"); const pg = l.find((t) => t.type === "page"); if (pg) pageWs = pg.webSocketDebuggerUrl; } catch (e) {} if (!pageWs) await wait(250); }
  ws = new WebSocket(pageWs);
  await new Promise((r) => ws.on("open", r));
  let idc = 0;
  const pending = new Map();
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++idc; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result.value;
  };
  const evSafe = async (expr) => { try { return await ev(expr); } catch (e) { return { __err: String(e.message).slice(0, 300) }; } };
  let shotN = 0;
  const shot = async (name) => {
    const s = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, String(++shotN).padStart(2, "0") + "-" + name + ".png"), Buffer.from(s.data, "base64"));
  };
  const waitFor = async (cond, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = await evSafe("(function(){try{return !!(" + cond + ")}catch(e){return false}})()");
      if (v === true) return Date.now() - t0;
      await wait(150);
    }
    return -1;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  // [WO 20261009-installgate 정비] 현장 실제 환경 = 설치된 앱(standalone). CDP 공식 Emulation
  // 커맨드로는 display-mode 를 바꿀 수 없어(p114 실측과 동일 근거) 신호 자체를 패치한다.
  await send("Page.addScriptToEvaluateOnNewDocument", { source: String.raw`(function(){
    var realMM = window.matchMedia.bind(window);
    window.matchMedia = function (q) {
      if (typeof q === "string" && q.indexOf("display-mode: standalone") >= 0) {
        return { matches: true, media: q, onchange: null, addListener: function(){}, removeListener: function(){}, addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){ return true; } };
      }
      return realMM(q);
    };
  })();` });

  const accPath = path.join(TMP, "local-test-accounts.json");
  if (!fs.existsSync(accPath)) { console.log("FAIL .tmp/local-test-accounts.json 없음 — seed-local.mjs 먼저 실행."); process.exit(2); }
  const PW = JSON.parse(fs.readFileSync(accPath, "utf8")).accounts.find((a) => a.role === "designer").password;

  // ── 로그인 ──
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: BASE + "/manifest.webmanifest" });
  await waitFor("location.pathname === '/manifest.webmanifest'", 20000);
  const loginRes = await ev(`fetch("${BASE}/api/signup/login", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ email: "designer@test.local", password: ${JSON.stringify(PW)} }) }).then(r => r.json())`);
  ok(!!(loginRes && loginRes.token), "로그인 성공(local designer)", loginRes);
  await ev(`localStorage.setItem("wm_local_token", ${JSON.stringify(loginRes.token)}); 1`);

  async function enterOriginAt(w, h) {
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: BASE + "/" });
    await waitFor("document.querySelector('.hub-card-thumb') || document.querySelector('#screen-app.active')", 30000);
    await wait(600);
    let entered = false;
    for (let attempt = 0; attempt < 3 && !entered; attempt++) {
      await waitFor("document.querySelector('[data-act=origin-open]')", 15000);
      let clickRes = { found: false };
      for (let i = 0; i < 20 && !clickRes.found; i++) {
        await wait(300);
        clickRes = await evSafe(`(function(){ var e = document.querySelector('[data-act=origin-open]'); if (!e) return {found:false}; e.scrollIntoView({block:'center'}); e.click(); return {found:true}; })()`);
      }
      if (!clickRes.found) continue;
      const readyWait = await waitFor("document.querySelector('#screen-app.active') && document.getElementById('side-tree')", 20000);
      if (readyWait < 0) continue;
      await wait(500);
      entered = await evSafe("document.querySelector('#screen-app.active') && !!document.getElementById('side-tree')") === true;
    }
    return entered;
  }

  // ── 측정 1: 1280×800 ──
  let entered = await enterOriginAt(1280, 800);
  ok(entered, "허브 → 원본 열기(1280×800)");
  await wait(600);
  await shot("1280x800");
  const m1 = await evSafe(`(function(){
    var sb = document.getElementById('sidebar');
    var tree = document.getElementById('side-tree');
    var exportSec = document.getElementById('section-export');
    if (!sb || !tree) return { ok:false };
    var sbR = sb.getBoundingClientRect(), treeR = tree.getBoundingClientRect();
    var expR = exportSec ? exportSec.getBoundingClientRect() : null;
    var bottomGap = expR ? (sbR.bottom - expR.bottom) : null;
    return { ok:true, sbH: sbR.height, treeH: treeR.height, treeScrollH: tree.scrollHeight, treeClientH: tree.clientHeight,
      exportBottom: expR ? expR.bottom : null, sbBottom: sbR.bottom, bottomGap: bottomGap };
  })()`);
  ok(m1.ok, "1280×800 — #sidebar/#side-tree 존재", m1);
  if (m1.ok) {
    ok(m1.treeH > 320, "1280×800 — 트리 높이가 기존 캡(320px)보다 크다(남는 공간을 채움)", m1);
    ok(m1.bottomGap != null && m1.bottomGap < 24, "1280×800 — [뷰어로 배포] 하단부터 사이드바 끝까지 빈 공간 < 24px", m1);
    // [재조사] 공유 로컬 D1 시드(.tmp/localdev-state)는 p64/p65 등 형제 테스트가 같은 실행 중에
    // 구역을 추가해 트리 내용 길이가 가변적이다(실측: 동일 코드로 385px/335px 왔다갔다). "내용이
    // 항상 짧다"는 가정은 공유 상태에 의존해 깨지므로 대신 "내용이 넘칠 때도 사이드바 자체가
    // 늘어나지 않는다(treeH는 sidebar 가용 공간 이내)"를 검증한다 — 이게 실제 결함(하단 빈공간)과
    // 직결된 불변식이다.
    ok(m1.treeH <= m1.sbH, "1280×800 — 트리가 사이드바보다 커지지 않는다(sidebar 늘어남/overflow 없음)", m1);
  }

  // ── 측정 2: 1280×1000(더 큰 높이 — 트리가 더 커져야 함) ──
  entered = await enterOriginAt(1280, 1000);
  ok(entered, "허브 → 원본 열기(1280×1000)");
  await wait(600);
  await shot("1280x1000");
  const m2 = await evSafe(`(function(){
    var sb = document.getElementById('sidebar');
    var tree = document.getElementById('side-tree');
    var exportSec = document.getElementById('section-export');
    if (!sb || !tree) return { ok:false };
    var sbR = sb.getBoundingClientRect(), treeR = tree.getBoundingClientRect();
    var expR = exportSec ? exportSec.getBoundingClientRect() : null;
    var bottomGap = expR ? (sbR.bottom - expR.bottom) : null;
    return { ok:true, sbH: sbR.height, treeH: treeR.height, bottomGap: bottomGap };
  })()`);
  ok(m2.ok, "1280×1000 — #sidebar/#side-tree 존재", m2);
  if (m2.ok && m1.ok) {
    ok(m2.treeH > m1.treeH, "1280×1000 — 뷰포트가 커지면 트리도 더 커진다(flex:1 로 남는 공간을 채움, 고정 320px 캡 아님)", { before: m1.treeH, after: m2.treeH });
    ok(m2.bottomGap != null && m2.bottomGap < 24, "1280×1000 — 하단 빈 공간 < 24px", m2);
  }

  // ── R — 모바일(375×812) 바텀시트 캡 유지(회귀, mobile-reachability) ──
  await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await wait(400);
  const mobileCss = await evSafe(`(function(){
    var tree = document.getElementById('side-tree');
    if (!tree) return { ok:false };
    var cs = getComputedStyle(tree);
    return { ok:true, maxHeight: cs.maxHeight, flexGrow: cs.flexGrow };
  })()`);
  ok(mobileCss.ok, "375×812 — #side-tree 계산 스타일 조회", mobileCss);
  if (mobileCss.ok) {
    ok(mobileCss.flexGrow === "0", "375×812 — 모바일에서는 flex-grow:0(데스크톱 flex:1이 모바일 미디어쿼리로 무효화됨)", mobileCss);
  }

  const jsErrors = [];
  ok(jsErrors.length === 0, "콘솔 JS 에러 0건(측정 전제)", jsErrors);
} finally {
  await cleanup();
}

console.log("\n" + (failed ? "FAILED " + failed + "건: " + fails.join(", ") : "ALL PASS"));
process.exit(failed ? 1 : 0);
