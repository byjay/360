/**
 * p130-cdp — WO 20261008-comparesync: 360 동기 비교 실측(실 Chrome, 실 wrangler dev + D1, 실 WebGL).
 * p124(tests/p124-deck-outline-live.test.mjs)와 동일한 전체 스택(assemble→stamp→vite build→wrangler
 * pages dev(기존 .tmp/localdev-state 시드)→headless Chrome CDP)을 그대로 재사용한다(§G-2-3 목 0).
 * 실행: P130=1 TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p130-compare-sync-cdp.mjs
 *   (P130 != "1" 이면 즉시 SKIP)
 *
 * 사전 준비: node build-tools/local-dev.mjs && node build-tools/seed-local.mjs
 *   (핀1 = panoIds[0] 현재 + timeline[panoIds[1]] 과거 1건 → TimeLapse._shots.length===2,
 *    "⇄ 분할비교" → window.__wm.CompareSync.open() 이 360 동기 비교로 실제로 열릴 조건)
 *
 * 측정: 좌측 캔버스를 실제 CDP 마우스 드래그로 돌리면 우측 yaw/pitch/fov 가 같은 값으로 따라오는지
 *   (오차 ε), [동기화 끄기] 중엔 독립, 다시 켜면 그 순간의 오프셋을 유지하는지, close() 후
 *   window.__wm.CompareSync._left/_right 가 완전히 null(= WebGL dispose, 누수 0)인지를 수치로 확인한다.
 */
import { execSync, spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { fileURLToPath } from "node:url";

if (process.env.P130 !== "1") {
  console.log("[SKIP] p130-cdp 는 P130=1 일 때만 실행(실 Chrome+워커 실측, 수십 초 소요)");
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = path.join(ROOT, ".tmp");
const OUT = path.join(TMP, "fixcompare");
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

if (!fs.existsSync(STATE)) { console.log("FAIL .tmp/localdev-state 없음 — 먼저 node build-tools/local-dev.mjs && node build-tools/seed-local.mjs 를 실행하세요."); process.exit(2); }
if (!fs.existsSync(CHROME)) { console.log("FAIL Chrome 없음: " + CHROME); process.exit(2); }

function sh(cmd) {
  console.log("[p130-cdp] $ " + cmd);
  execSync(cmd, { stdio: "inherit", cwd: ROOT, env: { ...process.env, TEMP: TMP, TMP: TMP } });
}
sh("python build-tools/assemble.py");
sh("node build-tools/stamp-version.mjs");
for (const [src, dst] of [["public/js/main.js", "js/main.js"], ["public/index.html", "index.html"], ["public/css/style.css", "css/style.css"]]) {
  fs.copyFileSync(path.join(ROOT, src), path.join(ROOT, dst));
}
sh('node --max-old-space-size=640 node_modules/vite/bin/vite.js build');

const PORT = process.env.P130_PORT || "18812";
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
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + "/"); if (r.status) return true; } catch (e) {} await wait(500); }
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

  const profileDir = path.join(TMP, "p130-chrome-" + Date.now());
  chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", "--user-data-dir=" + profileDir, "--window-size=375,812", "about:blank"], { stdio: "ignore" });
  const devtoolsPort = async () => {
    for (let i = 0; i < 80; i++) { try { const p = parseInt(fs.readFileSync(path.join(profileDir, "DevToolsActivePort"), "utf8").split("\n")[0], 10); if (p > 0) return p; } catch (e) {} await wait(150); }
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
  const consoleLog = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); return; }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") consoleLog.push(msg.params.args.map((a) => a.value || a.description || "").join(" ").slice(0, 300));
    if (msg.method === "Runtime.exceptionThrown") consoleLog.push("EXC: " + JSON.stringify(msg.params.exceptionDetails).slice(0, 400));
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++idc; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result.value;
  };
  const evSafe = async (expr) => { try { return await ev(expr); } catch (e) { return { __err: String(e.message).slice(0, 300) }; } };
  let shotN = 0;
  const shot = async (name) => { const s = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, String(++shotN).padStart(2, "0") + "-" + name + ".png"), Buffer.from(s.data, "base64")); };
  const waitFor = async (cond, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = await evSafe("(function(){try{return !!(" + cond + ")}catch(e){return false}})()"); if (v === true) return Date.now() - t0; await wait(150); }
    return -1;
  };
  const mouseDrag = async (x0, y0, x1, y1, steps = 6) => {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", buttons: 1 });
    for (let i = 1; i <= steps; i++) {
      const x = x0 + (x1 - x0) * (i / steps), y = y0 + (y1 - y0) * (i / steps);
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
      await wait(16);
    }
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y: y1, button: "left", buttons: 0 });
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
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
  if (!fs.existsSync(accPath)) { console.log("FAIL .tmp/local-test-accounts.json 없음 — seed-local.mjs 를 먼저 실행하세요."); process.exit(2); }
  const PW = JSON.parse(fs.readFileSync(accPath, "utf8")).accounts.find((a) => a.role === "designer").password;
  await send("Page.navigate", { url: BASE + "/manifest.webmanifest" });
  await waitFor("location.pathname === '/manifest.webmanifest'", 20000);
  const loginRes = await ev(`fetch("${BASE}/api/signup/login", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ email: "designer@test.local", password: ${JSON.stringify(PW)} }) }).then(r => r.json())`);
  ok(!!(loginRes && loginRes.token), "로그인 성공(local designer)", loginRes);
  await ev(`localStorage.setItem("wm_local_token", ${JSON.stringify(loginRes.token)}); 1`);

  await send("Page.navigate", { url: BASE + "/" });
  await waitFor("document.querySelector('.hub-card-thumb') || document.querySelector('#screen-app.active')", 30000);
  await wait(600);

  // ── 허브 → "로컬 테스트 프로젝트" 카드의 원본(메인 PDF) 열기 ──
  // [실측 2026-10-08] 공유 .tmp/localdev-state D1 에는 여러 팀의 시드 프로젝트가 누적돼 있어
  // document.querySelector('[data-act=origin-open]')(스코프 없음)가 proj_localseed 가 아닌
  // 엉뚱한(핀 0개) 프로젝트의 origin-open을 집는다(실측: pinMarkers=0 고정) — 카드 이름으로
  // 스코프를 좁혀 정확한 카드 안의 origin-open만 클릭한다.
  const FIND_ORIGIN = `(function(){
    var cards = Array.from(document.querySelectorAll('.hub-card'));
    var card = cards.find(function(c){ var n = c.querySelector('.hub-card-name'); return n && n.textContent.indexOf('로컬 테스트 프로젝트') === 0; });
    return card ? card.querySelector('[data-act=origin-open]') : null;
  })()`;
  let entered = false;
  for (let attempt = 0; attempt < 3 && !entered; attempt++) {
    await waitFor(FIND_ORIGIN, 15000);
    let clickRes = { found: false };
    for (let i = 0; i < 20 && !clickRes.found; i++) {
      await wait(300);
      clickRes = await evSafe(`(function(){ var e = ${FIND_ORIGIN}; if (!e) return {found:false}; e.scrollIntoView({block:'center'}); e.click(); return {found:true}; })()`);
    }
    if (!clickRes.found) continue;
    const readyWait = await waitFor("document.querySelectorAll('.pin-marker').length > 0 && window.__wm && window.__wm.State && Array.isArray(window.__wm.State.pins)", 10000);
    if (readyWait < 0) continue;
    await wait(400);
    const stillIn = await evSafe("document.querySelector('#screen-app.active') && document.querySelectorAll('.pin-marker').length > 0");
    if (stillIn !== true) continue;
    entered = true;
  }
  ok(entered, "허브 → 원본(메인 PDF) 열기 → 핀 로딩 완료");
  if (!entered) {
    await shot("debug-not-entered");
    const dbg = await evSafe(`({
      url: location.href,
      hasOriginBtn: !!document.querySelector('[data-act=origin-open]'),
      hasHubThumb: !!document.querySelector('.hub-card-thumb'),
      screenAppActive: !!document.querySelector('#screen-app.active'),
      pinMarkers: document.querySelectorAll('.pin-marker').length,
      hasWm: typeof window.__wm !== 'undefined',
      bodyLen: document.body ? document.body.innerHTML.length : -1,
      title: document.title
    })`);
    console.log("  DEBUG not-entered: " + JSON.stringify(dbg));
    for (let i = 0; i < 10; i++) {
      await wait(1000);
      const c = await evSafe("document.querySelectorAll('.pin-marker').length");
      const m = await evSafe("(window.__wm && window.__wm.State) ? (window.__wm.State.pins||[]).length : -1");
      console.log("  DEBUG poll t=" + (i + 1) + "s pinMarkers=" + c + " State.pins=" + m);
    }
    await shot("debug-after-poll");
  }

  // ── 타임라인(2개 시점)이 있는 360 핀을 찾아 App.openPano()로 연다(test hook __wm, 실제 함수 그대로 호출) ──
  // [재현 2026-10-08 — 지휘자 보고] 이 셰어드 .tmp/localdev-state 환경은 p124 주석이 기록한 "배경
  //   재진입"(문서 전체가 조용히 '/' 로 재 frameNavigated 되는 현상)이 허브 진입 직후뿐 아니라,
  //   Cloud.fetchImage(느린 D1 cold read, 수십 초)로 360 이미지가 로드되는 동안에도 발생함을
  //   이번 실측으로 추가 확인했다 — window.__openPanoCalls 마커(이 블록 이전 버전에서 주입)가
  //   이미지 로드 후 undefined 로 관측되어(= window 객체 자체가 교체됨) TimeLapse._shots 가
  //   2 → 0 으로 리셋되는 근본원인이 CompareSync 가 아니라 이 환경의 재진입임을 확정했다.
  //   markerCheck 로 재진입 여부만 가볍게 검출해 보고한다(발생 시 SKIP 사유를 남기고 종료).
  await ev("window.__p130Marker = { wm: window.__wm, t: Date.now() }; 1");
  await ev(`(function(){
    window.__setPinCalls = [];
    var TL = window.__wm.TimeLapse;
    var origSetPin = TL.setPin.bind(TL);
    TL.setPin = function(pin){
      window.__setPinCalls.push({ id: pin && pin.id, hasTimeline: !!(pin && pin.timeline && pin.timeline.length), t: Date.now(), stack: new Error().stack.split('\\n').slice(1,5).join(' | ') });
      return origSetPin(pin);
    };
    1;
  })()`);
  const openRes = await evSafe(`(function(){
    var pin = (window.__wm.State.pins || []).find(function(p){ return Array.isArray(p.timeline) && p.timeline.length > 0; });
    if (!pin) return { found: false };
    window.__wm.App.openPano(pin);
    return { found: true, pinId: pin.id };
  })()`);
  ok(openRes && openRes.found, "타임라인 2시점 핀 발견 + App.openPano() 호출", openRes);
  const panoReady = await waitFor("document.getElementById('pano-canvas') && !document.getElementById('pano-canvas').classList.contains('hidden')", 45000);
  ok(panoReady >= 0, "360 뷰어(단일) 로딩 완료");
  const reentryCheck = await evSafe("({ sameWm: window.__p130Marker && window.__p130Marker.wm === window.__wm, shotsNow: window.__wm.TimeLapse._shots.length })");
  if (reentryCheck && reentryCheck.sameWm === false) {
    console.log("  [SKIP 사유] 배경 재진입 감지(window 교체) — CompareSync 결함이 아니라 이 로컬 dev 환경의 기존 불안정성(p124 주석과 동일 현상). R1~R4 수치 검증은 재진입 없는 세션에서 재실행 필요.");
  } else if (reentryCheck) {
    console.log("  재진입 미감지, shots=" + reentryCheck.shotsNow);
  }
  if (panoReady < 0) {
    const dbg2 = await evSafe(`({
      hasTHREE: typeof THREE !== 'undefined',
      panoLoadingHidden: document.getElementById('pano-loading') ? document.getElementById('pano-loading').classList.contains('hidden') : null,
      panoErrorHidden: document.getElementById('pano-error') ? document.getElementById('pano-error').classList.contains('hidden') : null,
      panoErrorMsg: document.querySelector('#pano-error .pano-error-msg') ? document.querySelector('#pano-error .pano-error-msg').textContent : null,
      panoCanvasHidden: document.getElementById('pano-canvas') ? document.getElementById('pano-canvas').classList.contains('hidden') : null,
      rendererExists: window.__wm && window.__wm.PanoViewer ? !!window.__wm.PanoViewer.renderer : null
    })`);
    console.log("  DEBUG pano-load: " + JSON.stringify(dbg2));
    await shot("debug-pano-load");
  }
  await wait(300);

  // ── [재현 2026-10-08] 이 공유 .tmp/localdev-state 환경은 p124 주석의 "배경 재진입"과 같은 계열의
  //   불안정성으로, pano 이미지 로딩(느린 D1 cold read) 직후 ~300ms 사이에 TimeLapse._shots 가
  //   조용히 2→0 으로 리셋되는 경우가 실측됐다(window.__wm 자체 ID 는 유지 — SPA 내부 상태 재계산으로
  //   추정, CompareSync 와 무관). 클릭 직전 다시 한 번 shots 를 확인해 사라졌으면 핀을 다시 열어
  //   최대 2회 재시도한다(p124 의 whole-flow retry 관례와 동일 취지).
  let shotsOk = false;
  for (let attempt = 0; attempt < 3 && !shotsOk; attempt++) {
    const n = await evSafe("window.__wm.TimeLapse._shots.length");
    if (n === 2) { shotsOk = true; break; }
    console.log("  [재시도 " + attempt + "] 클릭 직전 shots=" + n + " (기대 2) — 핀을 다시 연다");
    await evSafe(`(function(){
      var pin = (window.__wm.State.pins || []).find(function(p){ return Array.isArray(p.timeline) && p.timeline.length > 0; });
      if (pin) window.__wm.App.openPano(pin);
    })()`);
    await waitFor("document.getElementById('pano-canvas') && !document.getElementById('pano-canvas').classList.contains('hidden')", 45000);
    await wait(300);
  }
  ok(shotsOk, "클릭 직전 TimeLapse._shots===2 유지(재시도 포함) — 환경 불안정성(p124 계열)을 재시도로 흡수");
  if (!shotsOk) {
    console.log("  [SKIP 사유] 3회 재시도에도 TimeLapse._shots 가 2로 안정화되지 않음 — 이 로컬 dev 환경(공유 .tmp/localdev-state)의 사전 존재 불안정성. CompareSync 자체는 p130-compare-sync.test.mjs(vm, 실소스, 뮤테이션 증명 17/17 PASS)로 검증됨. R1~R4 수치 검증은 이 세션에서 생략한다.");
  }

  // ── "⇄ 분할비교" 클릭 → 360 동기 비교(기본 모드)가 실제로 열리는지 ──
  const clickCompare = await evSafe(`(function(){ var b = document.getElementById('btn-tl-compare'); if(!b) return {found:false}; b.click(); return {found:true}; })()`);
  ok(clickCompare && clickCompare.found, "⇄ 분할비교 버튼 클릭");
  const cmp360Ready = await waitFor("document.getElementById('pano-compare-360') && !document.getElementById('pano-compare-360').classList.contains('hidden') && window.__wm.CompareSync && window.__wm.CompareSync._left && window.__wm.CompareSync._right", 45000);
  ok(cmp360Ready >= 0, "360 동기 비교 오버레이 열림(window.__wm.CompareSync._left/_right 둘 다 생성 — 평면 모드로 대체되지 않음)", { cmp360Ready });
  if (cmp360Ready < 0) {
    const dbg3 = await evSafe(`({
      hasOverlay: !!document.getElementById('pano-compare-360'),
      overlayHidden: document.getElementById('pano-compare-360') ? document.getElementById('pano-compare-360').classList.contains('hidden') : null,
      hasCS: !!window.__wm.CompareSync,
      csBusy: window.__wm.CompareSync ? window.__wm.CompareSync._busy : null,
      csLeft: window.__wm.CompareSync ? !!window.__wm.CompareSync._left : null,
      hasMultiple: window.__wm.TimeLapse ? window.__wm.TimeLapse.hasMultiple() : null,
      shotsLen: window.__wm.TimeLapse ? window.__wm.TimeLapse._shots.length : null,
      hasCanvasA: !!document.getElementById('cmp360-canvas-a'),
      hasCreateCore: window.__wm.PanoViewer ? typeof window.__wm.PanoViewer.createViewerCore : null
    })`);
    console.log("  DEBUG cmp360: " + JSON.stringify(dbg3));
    const openDirect = await evSafe("window.__wm.CompareSync.open().then(r => ({ result: r, left: !!window.__wm.CompareSync._left, right: !!window.__wm.CompareSync._right }))");
    console.log("  DEBUG openDirect: " + JSON.stringify(openDirect));
    await shot("debug-cmp360");
  }
  await wait(400);
  await shot("375-open");

  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await ev("window.dispatchEvent(new Event('resize')); 1");
  await wait(400);
  await shot("1280-open");
  await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await ev("window.dispatchEvent(new Event('resize')); 1");
  await wait(300);

  // ── R1: 좌측 캔버스를 실제 마우스 드래그로 돌리면 우측이 같은 값으로 따라온다(오차 수치) ──
  const rectA = await evSafe("(function(){ var r = document.getElementById('cmp360-canvas-a').getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}; })()");
  await mouseDrag(rectA.x, rectA.y, rectA.x - 60, rectA.y + 20);
  await wait(200);
  const sync1 = await evSafe("(function(){ var l=window.__wm.CompareSync._left.S, r=window.__wm.CompareSync._right.S; return { lLon:l.lon, lLat:l.lat, lFov:l.fov, rLon:r.lon, rLat:r.lat, rFov:r.fov, diffLon: Math.abs(l.lon-r.lon), diffLat: Math.abs(l.lat-r.lat) }; })()");
  ok(Math.abs(sync1.lLon) > 0.5, "R1 — 드래그가 실제로 좌측 yaw를 바꿨다(0이 아님)", sync1);
  ok(sync1.diffLon < 0.01 && sync1.diffLat < 0.01, "R1 — 동기화 ON: 우측 yaw/pitch가 좌측과 거의 동일(오차<0.01)", sync1);
  await shot("375-synced");

  // ── R2: [동기화 끄기] → 한쪽만 드래그해도 다른 쪽은 그대로(독립) ──
  await evSafe("(function(){ document.getElementById('btn-cmp360-sync').click(); return 1; })()");
  const syncOffState = await evSafe("window.__wm.CompareSync._sync");
  ok(syncOffState === false, "R2 — [동기화 끄기] 토글 → _sync=false");
  const beforeRight = await evSafe("Object.assign({}, window.__wm.CompareSync._right.S)");
  const rectB = await evSafe("(function(){ var r = document.getElementById('cmp360-canvas-b').getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}; })()");
  await mouseDrag(rectB.x, rectB.y, rectB.x + 80, rectB.y);
  await wait(200);
  const afterDragOff = await evSafe("({ left: Object.assign({}, window.__wm.CompareSync._left.S), right: Object.assign({}, window.__wm.CompareSync._right.S) })");
  ok(Math.abs((afterDragOff?.left?.lon ?? NaN) - sync1.lLon) < 0.01, "R2 — 끈 상태에서 우측만 드래그해도 좌측은 변화 없음(독립)", { before: sync1.lLon, after: afterDragOff?.left?.lon, raw: afterDragOff });
  ok(Math.abs((afterDragOff?.right?.lon ?? NaN) - (beforeRight?.lon ?? NaN)) > 0.5, "R2 — 우측은 독립적으로 회전했다", { afterDragOff, beforeRight });
  await shot("375-unsynced");

  // ── R3: 다시 켜면 "그 순간의" yaw 차이를 오프셋으로 유지 ──
  await evSafe("(function(){ document.getElementById('btn-cmp360-sync').click(); return 1; })()");
  const offsetAfterOn = await evSafe("window.__wm.CompareSync._offsetLon");
  const expectOffset = (afterDragOff?.right?.lon ?? NaN) - (afterDragOff?.left?.lon ?? NaN);
  ok(Math.abs(offsetAfterOn - expectOffset) < 0.01, "R3 — 다시 켤 때 그 순간 차이를 오프셋으로 고정", { offsetAfterOn, expectOffset });
  const leftBefore2 = await evSafe("window.__wm.CompareSync._left.S.lon");
  await mouseDrag(rectA.x, rectA.y, rectA.x + 30, rectA.y);
  await wait(200);
  const afterReDrag = await evSafe("({ left: window.__wm.CompareSync._left.S.lon, right: window.__wm.CompareSync._right.S.lon, offset: window.__wm.CompareSync._offsetLon })");
  ok(Math.abs(((afterReDrag?.left ?? NaN) + (afterReDrag?.offset ?? NaN)) - (afterReDrag?.right ?? NaN)) < 0.01, "R3 — 오프셋 유지한 채로 계속 동기화됨(right = left + offset)", afterReDrag);
  await shot("375-offset-resynced");

  // ── R4: close() → WebGL 컨텍스트 2개 완전 dispose(누수 0) ──
  const closeRes = await evSafe("(function(){ var b=document.getElementById('btn-cmp360-close'); if(!b) return {found:false}; b.click(); return {found:true}; })()");
  ok(closeRes && closeRes.found, "✕ 비교 종료 클릭");
  await wait(300);
  const afterClose = await evSafe("({ left: window.__wm.CompareSync._left, right: window.__wm.CompareSync._right, hidden: document.getElementById('pano-compare-360').classList.contains('hidden') })");
  ok(afterClose.left === null && afterClose.right === null, "R4 — close() 후 window.__wm.CompareSync._left/_right 둘 다 null(dispose 완료, 누수 0)", afterClose);
  ok(afterClose.hidden === true, "R4 — 오버레이 hidden");

  const jsErrors = consoleLog.filter((e) => !/favicon/i.test(e));
  ok(jsErrors.length === 0, "콘솔 JS 에러 0건", jsErrors);
} finally {
  await cleanup();
}

console.log("\n" + (failed ? "FAILED " + failed + "건: " + fails.join(", ") : "ALL PASS"));
process.exit(failed ? 1 : 0);
