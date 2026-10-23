// p187 — REA "detaches-task" 20곳(흘려보낸 비동기 작업) 판정 중 실제로 (C) 미처리 결함이었던
// 12_ProjectHub.js._copyInviteLink 수정 검증.
//
// 판정 과정 기록(다른 18곳은 (A)/(B) — 수정 불필요, 지휘자 보고 참조):
//  · 05_SyncQueue.js:18 _emit() — 처음엔 count() 가 IndexedDB 실패로 reject 할 수 있다고 보고 .catch
//    를 추가했으나, 실측(이 테스트의 초안)에서 _open()(05_SyncQueue.js:64) 이 이미
//    `.catch(() => null)` 로 모든 open 실패를 흡수해 count() 는 **절대 reject 하지 않음**을 확인
//    → (A) 로 재분류하고 불필요한 변경을 되돌렸다(변경 0).
//  · 12_ProjectHub.js._copyInviteLink — clipboard.writeText 실패를 .catch(()=>{}) 로 삼켜 복사도
//    안 되고 알림도 없었다(형제 _copyDeployUrl 은 execCommand 폴백+알림이 있는데 여기만 없던 불일치,
//    진짜 (C)). _copyDeployUrlFallback(SoT) 재사용으로 통일.
//
// 헤드리스 Chrome(CDP, p185 패턴 재사용) — 실제 모듈 소스 그대로, clipboard API 만 거부 Promise로
// 스텁(모킹 아님 — 외부 I/O 경계만 대체. execCommand 는 실 구현을 그대로 호출해 실제 복사 여부를 본다).
//
// 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p187-detached-promises.test.mjs
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP_ROOT = path.join(ROOT, ".tmp"); // CLAUDE.md §G-5
const MODULES_DIR = path.join(ROOT, "public", "js", "modules");
const REPO_PUBLIC = path.join(ROOT, "public");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, label, d) => { console.log((c ? "  PASS " : "  FAIL ") + label + (d != null ? " :: " + JSON.stringify(d).slice(0, 400) : "")); if (!c) failed++; };
const watchdog = setTimeout(() => { console.log("\nWATCHDOG — 180s 초과 → FAIL"); process.exit(1); }, 180000);

function buildBundle(overrides = {}) {
  const manifest = fs.readFileSync(path.join(MODULES_DIR, "_manifest.txt"), "utf8").trim().split(/\r?\n/);
  return manifest.map((f) => (overrides[f] != null ? overrides[f] : fs.readFileSync(path.join(MODULES_DIR, f), "utf8"))).join("\n");
}
function exposeForTest(bundle) {
  const idx = bundle.lastIndexOf("})();");
  if (idx === -1) return bundle;
  const inject = "\n  try { window.__T_ProjectHub=ProjectHub; window.__T_Auth=Auth; window.__T_UI=UI; window.__T_State=State; } catch (e) {}\n";
  return bundle.slice(0, idx) + inject + bundle.slice(idx);
}
function makeServeDir(bundleJs) {
  const dir = path.join(TMP_ROOT, "p187-serve-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(path.join(dir, "js"), { recursive: true });
  fs.writeFileSync(path.join(dir, "js", "main.js"), bundleJs);
  return dir;
}
async function serveStatic(overlayDir) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    if (p === "/sw.js") { res.writeHead(404); res.end("nf"); return; }
    const overlayFull = path.join(overlayDir, p);
    const realFull = path.join(REPO_PUBLIC, p);
    const full = fs.existsSync(overlayFull) ? overlayFull : realFull;
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
async function readDevToolsPort(profileDir) {
  for (let i = 0; i < 60; i++) {
    try { const port = parseInt(fs.readFileSync(path.join(profileDir, "DevToolsActivePort"), "utf8").split("\n")[0], 10); if (port > 0) return port; } catch (e) {}
    await wait(150);
  }
  throw new Error("DevToolsActivePort 없음");
}
async function getWsUrl(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await new Promise((res, rej) => http.get(`http://127.0.0.1:${port}/json/list`, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(JSON.parse(d))); }).on("error", rej));
      const pg = list.find((t) => t.type === "page");
      if (pg && pg.webSocketDebuggerUrl) return pg.webSocketDebuggerUrl;
    } catch (e) {}
    await wait(200);
  }
  throw new Error("chrome devtools not up");
}
let idc = 0;
function send(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++idc;
    const h = (raw) => { const m = JSON.parse(raw); if (m.id === id) { ws.removeListener("message", h); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } };
    ws.on("message", h);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function ev(ws, expr) {
  const r = await send(ws, "Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result.value;
}
async function runSession(bundleJs, setupExpr, testFn) {
  const overlayDir = makeServeDir(bundleJs);
  const server = await serveStatic(overlayDir);
  const sitePort = server.address().port;
  const profileDir = path.join(TMP_ROOT, "cdp-p187-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "--window-size=1024,900", "about:blank"], { stdio: "ignore" });
  try {
    const port = await readDevToolsPort(profileDir);
    const wsUrl = await getWsUrl(port);
    const ws = new WebSocket(wsUrl);
    await new Promise((r) => ws.on("open", r));
    await send(ws, "Page.enable");
    await send(ws, "Emulation.setDeviceMetricsOverride", { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
    const loadFired = new Promise((resolve) => { const h = (raw) => { const m = JSON.parse(raw); if (m.method === "Page.loadEventFired") { ws.removeListener("message", h); resolve(); } }; ws.on("message", h); });
    await send(ws, "Page.navigate", { url: `http://127.0.0.1:${sitePort}/index.html` });
    await loadFired;
    await wait(300);
    const setupOut = await ev(ws, setupExpr);
    if (setupOut !== "ok") throw new Error("setup 실패: " + JSON.stringify(setupOut));
    await testFn(ws);
  } finally {
    try { chrome.kill(); } catch (e) {}
    server.close();
  }
}

/* ══════════════════════════════════════════════════════════════
   R1 — ProjectHub._copyInviteLink: clipboard.writeText 거부 시 execCommand 폴백 + 알림 + unhandledrejection 0
   ══════════════════════════════════════════════════════════════ */
const R1_SETUP = `(function(){
  window.__unhandled = [];
  window.addEventListener('unhandledrejection', function(e){ window.__unhandled.push(String(e.reason)); });
  document.querySelectorAll('.screen').forEach(function(s){ s.classList.remove('active'); });
  document.getElementById('screen-app').classList.add('active');
  window.__T_Auth.user = { email:'t@t.com', name:'t' };
  var inp = document.getElementById('pm-invite-link');
  inp.value = 'https://scan.seastar.work/invite/abc123';
  window.__execCalls = 0;
  var origExec = document.execCommand.bind(document);
  document.execCommand = function(cmd){ if (cmd === 'copy') window.__execCalls++; return origExec(cmd); };
  // navigator.clipboard.writeText 를 항상 거부하는 스텁으로 교체(핵심 I/O 경계만 대체).
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: function(){ return Promise.reject(new Error('STUB_CLIPBOARD_DENIED')); } }, configurable: true });
  return 'ok';
})();`;

async function r1Check(ws, expectFallback) {
  await ev(ws, `(function(){ document.getElementById('wm-toast-host') && document.getElementById('wm-toast-host').remove(); window.__T_ProjectHub._copyInviteLink(); })(); 1`);
  await wait(300);
  const r = await ev(ws, `(function(){
    var host = document.getElementById('wm-toast-host');
    var toastText = host ? host.textContent : '';
    return { unhandled: window.__unhandled, execCalls: window.__execCalls, toastText: toastText };
  })()`);
  if (expectFallback) {
    ok(r.unhandled.length === 0, "R1 — clipboard.writeText reject 시 unhandledrejection 0", r);
    ok(r.execCalls > 0, "R1 — execCommand('copy') 폴백이 실제로 호출됨(조용한 실패 아님)", r);
    ok(r.toastText.indexOf("초대 링크를 복사했습니다") >= 0, "R1 — 폴백 성공 후 사용자에게 복사 완료 알림", r);
  } else {
    ok(r.execCalls === 0 && r.toastText.indexOf("초대 링크를 복사했습니다") < 0, "R1 뮤테이션 — 폴백 제거 시 복사도 알림도 없음(결함 재현)", r);
  }
}

/* ══════════════════════════════════════════════════════════════
   R2 [WO 20261023-followups3 F3] — 11_UI.copyPin: done=true 를 클립보드 결과 확인 "전"에
   세팅해 실패해도 "복사됨"이라 오안내하던 결함. 성공 시에만 "복사됨", 실패 시
   12_ProjectHub._copyDeployUrlFallback(SoT) 로 execCommand 폴백 + 정직한 안내.
   ══════════════════════════════════════════════════════════════ */
const R2_SETUP = `(function(){
  window.__unhandled = [];
  window.addEventListener('unhandledrejection', function(e){ window.__unhandled.push(String(e.reason)); });
  document.querySelectorAll('.screen').forEach(function(s){ s.classList.remove('active'); });
  document.getElementById('screen-app').classList.add('active');
  window.__T_Auth.user = { email:'t@t.com', name:'t' };
  window.__T_State.pins = [{ id:'r2p1', x:10, y:10, page:1, label:'1' }];
  window.__execCalls = 0;
  // 🔴 headless Chrome 의 실제 execCommand('copy') 반환값은 포커스·보안 컨텍스트에 따라 들쑥날쑥하다
  // (실측: 이 환경은 항상 false) — 우리 코드의 copied===true/false 분기 자체를 검증하는 게 목적이라
  // navigator.clipboard 와 같은 방식(외부 I/O 경계만 대체)으로 반환값을 직접 통제한다.
  document.execCommand = function(cmd){ if (cmd === 'copy') { window.__execCalls++; return !window.__execFail; } return false; };
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: function(){ return Promise.reject(new Error('STUB_CLIPBOARD_DENIED')); } }, configurable: true });
  return 'ok';
})();`;

async function r2Check(ws, mode) {
  if (mode === "execfail") await ev(ws, "window.__execFail = true; 1");
  await ev(ws, `(function(){ document.getElementById('wm-toast-host') && document.getElementById('wm-toast-host').remove(); window.__T_UI.copyPin(window.__T_State.pins[0]); })(); 1`);
  await wait(300);
  const r = await ev(ws, `(function(){
    var host = document.getElementById('wm-toast-host');
    return { unhandled: window.__unhandled, execCalls: window.__execCalls, toastText: host ? host.textContent : '' };
  })()`);
  if (mode === "fallback-ok") {
    ok(r.unhandled.length === 0, "R2 — clipboard.writeText reject 시 unhandledrejection 0", r);
    ok(r.execCalls > 0, "R2 — execCommand('copy') 폴백이 실제로 호출됨", r);
    ok(r.toastText.indexOf("복사됨") >= 0, "R2 — 폴백(execCommand) 성공 시에만 '복사됨' 안내", r);
  } else if (mode === "execfail") {
    ok(r.toastText.indexOf("복사됨") < 0, "R2 — execCommand 폴백도 실패하면 '복사됨'이라 오안내하지 않는다", r);
    ok(r.toastText.indexOf("복사 실패") >= 0, "R2 — 폴백도 실패 시 정직한 실패 안내('복사 실패')", r);
  } else { // mutation — 구 동작(done=true 를 확인 전에 세팅)
    ok(r.toastText.indexOf("복사됨") >= 0, "R2 뮤테이션 — done=true 를 결과 확인 전에 세팅하면 실패해도 '복사됨'(결함 재현)", r);
  }
}

/* ══════════════════════════════════════════════════════════════
   메인
   ══════════════════════════════════════════════════════════════ */
async function main() {
  if (!fs.existsSync(CHROME)) { console.log("FAIL Chrome 없음: " + CHROME); process.exit(2); }
  fs.mkdirSync(TMP_ROOT, { recursive: true });

  console.log("\n[R1] ProjectHub._copyInviteLink — 수정본(원본 소스)");
  await runSession(exposeForTest(buildBundle()), R1_SETUP, (ws) => r1Check(ws, true));

  console.log("\n[R1] 뮤테이션 — 폴백 호출 제거(과거 .catch(()=>{}) 로 되돌림)");
  {
    const src = fs.readFileSync(path.join(MODULES_DIR, "12_ProjectHub.js"), "utf8");
    const needle = `navigator.clipboard.writeText(inp.value).then(done).catch(() => this._copyDeployUrlFallback(inp.value, done)); return; }\n      } catch (e) {}\n      this._copyDeployUrlFallback(inp.value, done);`;
    if (src.indexOf(needle) < 0) { ok(false, "R1 뮤테이션 대상 문자열 없음(소스 변경됨 — 재확인 필요)"); }
    else {
      const mutated = src.replace(needle, `navigator.clipboard.writeText(inp.value).then(done).catch(() => {}); return; }\n      } catch (e) {}`);
      await runSession(exposeForTest(buildBundle({ "12_ProjectHub.js": mutated })), R1_SETUP, (ws) => r1Check(ws, false));
    }
  }

  console.log("\n[R2] 11_UI.copyPin — 수정본(원본 소스), clipboard reject → execCommand 폴백 성공");
  await runSession(exposeForTest(buildBundle()), R2_SETUP, (ws) => r2Check(ws, "fallback-ok"));

  console.log("\n[R2] 11_UI.copyPin — 수정본, clipboard reject + execCommand 도 실패 → 정직한 실패 안내");
  await runSession(exposeForTest(buildBundle()), R2_SETUP, (ws) => r2Check(ws, "execfail"));

  console.log("\n[R2] 뮤테이션 — done=true 를 클립보드 결과 확인 전에 세팅(구 동작으로 되돌림)");
  {
    const src = fs.readFileSync(path.join(MODULES_DIR, "11_UI.js"), "utf8");
    const needle = `      try {
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt).then(done).catch(fallback); return txt; }
      } catch (e) {}
      fallback();
      return txt;`;
    if (src.indexOf(needle) < 0) { ok(false, "R2 뮤테이션 대상 문자열 없음(소스 변경됨 — 재확인 필요)"); }
    else {
      const mutated = src.replace(needle, `      let __d = false;
      try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt).catch(() => {}); __d = true; } } catch (e) {}
      Prompt.toast((__d ? "복사됨 — " : "복사(앱 안) — ") + txt);
      return txt;`);
      await runSession(exposeForTest(buildBundle({ "11_UI.js": mutated })), R2_SETUP, (ws) => r2Check(ws, "mutation"));
    }
  }

  clearTimeout(watchdog);
  console.log("\n" + (failed ? "FAIL " + failed : "ALL PASS"));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("ERROR", e && e.stack || e); process.exit(1); });
