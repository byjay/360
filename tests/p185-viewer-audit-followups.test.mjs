// p185 — 뷰어 감사 후속 3건(R4 보기설정 슬라이더 재동기화 · R5 모바일 360 하단 컨트롤 겹침/레이더
// 중앙 차단 · R6 /api/app-settings 비밀키 누수 차단). 헤드리스 Chrome(CDP, R4/R5, p116 정적서빙
// 패턴 재사용) + 실 wrangler dev+실 D1(R6, p179b 패턴 재사용) — 실제 모듈 소스/실제 서버 그대로.
//
// [재현] .tmp/viewer-audit/scn5.log(R4 afterReloadOpen.slider="30" vs 저장값 44px) ·
//        .tmp/viewer-audit/scn10-2.log(R5 bottomStack 겹침·radar rect 가 화면 중앙 포함) —
//        발주서(지휘자 실측) 원문 그대로.
// R6: GET /api/app-settings?scope=* 가 로그인만 되면 auto_entry_secret(src/index.tsx:123, 서버
//     서명 비밀키) 등 *_secret/*_key/*token* 패턴 skey 를 노출할 수 있었다(값이 JSON 이 아니라
//     우연히 비노출일 뿐 — 저장 형식이 바뀌면 샌다).
//
// 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p185-viewer-audit-followups.test.mjs
import { execSync, spawn } from "node:child_process";
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
const watchdog = setTimeout(() => { console.log("\nWATCHDOG — 480s 초과 → FAIL"); process.exit(1); }, 480000);

/* ══════════════════════════════════════════════════════════════
   공용 — 정적 서빙 Chrome CDP 하니스(p116-pano-shapes-cdp.mjs 패턴, R4/R5 전용)
   ══════════════════════════════════════════════════════════════ */
function buildBundle(overrides = {}) {
  const manifest = fs.readFileSync(path.join(MODULES_DIR, "_manifest.txt"), "utf8").trim().split(/\r?\n/);
  return manifest.map((f) => (overrides[f] != null ? overrides[f] : fs.readFileSync(path.join(MODULES_DIR, f), "utf8"))).join("\n");
}
function exposeForTest(bundle) {
  const idx = bundle.lastIndexOf("})();");
  if (idx === -1) return bundle;
  const inject = "\n  try { window.__T_PanoViewer=PanoViewer; window.__T_App=App; window.__T_State=State; window.__T_Auth=Auth; " +
    "window.__T_Settings=Settings; window.__T_Projects=Projects; window.__T_TimeLapse=TimeLapse; window.__T_Radar=Radar; } catch (e) {}\n";
  return bundle.slice(0, idx) + inject + bundle.slice(idx);
}
function makeServeDir(bundleJs, extra = {}) {
  const dir = path.join(TMP_ROOT, "p185-serve-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(path.join(dir, "js"), { recursive: true });
  fs.writeFileSync(path.join(dir, "js", "main.js"), bundleJs);
  for (const [rel, content] of Object.entries(extra)) {
    const fp = path.join(dir, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
  }
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
/** 서빙 디렉토리를 띄우고 setup 식을 실행한 뒤 testFn(ws)을 돌리는 1회성 Chrome 세션. */
async function runSession(bundleJs, extraFiles, setupExpr, testFn) {
  const overlayDir = makeServeDir(bundleJs, extraFiles);
  const server = await serveStatic(overlayDir);
  const sitePort = server.address().port;
  const profileDir = path.join(TMP_ROOT, "cdp-p185-" + Date.now() + "-" + Math.random().toString(36).slice(2));
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
   R4 — 보기 설정(크기/번호/모양/리더선) 재동기화
   ══════════════════════════════════════════════════════════════ */
const R4_SETUP = `(function(){
  document.querySelectorAll('.screen').forEach(function(s){ s.classList.remove('active'); });
  document.getElementById('screen-app').classList.add('active');
  window.__T_Auth.user = { email:'t@t.com', name:'t' };
  window.__T_Auth.role = 'viewer';
  window.__T_Projects.currentProject = { id: 'proj_r4test' };
  window.__T_Settings.init();
  window.__T_Settings.open();
  return 'ok';
})();`;

async function r4Check(ws, expectSync) {
  const init = await ev(ws, `(function(){ var s=document.getElementById('pinsize-slider'); return s ? s.value : null; })()`);
  ok(init === "30", "R4 준비 — 슬라이더 기본값 30px", { init });
  // 저장값을 44px(배율 1.1)로 바꾸고, DOM은 일부러 30으로 되돌려(생성 시점에 굳은 상태를 재현) 패널 재오픈
  await ev(ws, `(function(){
    localStorage.setItem('wm_pinsize_proj_r4test', '1.1');
    localStorage.setItem('wm_pinlabel_proj_r4test', 'hidden');
    document.getElementById('pinsize-slider').value = '30';
    document.getElementById('pinsize-val').textContent = '30px';
  })()`);
  await ev(ws, `window.__T_Settings.open(); 1`);
  await wait(150);
  const after = await ev(ws, `(function(){
    return { slider: document.getElementById('pinsize-slider').value,
             val: document.getElementById('pinsize-val').textContent,
             hiddenPressed: document.querySelector('[data-pinlabel-opt="hidden"]').getAttribute('aria-pressed'),
             alwaysPressed: document.querySelector('[data-pinlabel-opt="always"]').getAttribute('aria-pressed') };
  })()`);
  if (expectSync) {
    ok(after.slider === "44" && after.val === "44px", "R4 — 새로고침·설정 재오픈 후 슬라이더가 저장값(44px)로 재동기화", after);
    ok(after.hiddenPressed === "true" && after.alwaysPressed === "false", "R4 — 번호 표시 옵션도 같은 함수로 재동기화(hidden 선택 표시)", after);
  } else {
    ok(after.slider === "30", "R4 뮤테이션 — 재동기화 호출 제거 시 슬라이더가 여전히 30px(결함 재현)", after);
  }
}

/* ══════════════════════════════════════════════════════════════
   R5a — 모바일(375×812) 하단 컨트롤 3종 겹침 0
   R5b — 레이더 모바일 기본 접힘(화면 중앙 미차단)
   ══════════════════════════════════════════════════════════════ */
const R5_SETUP = `(function(){
  document.querySelectorAll('.screen').forEach(function(s){ s.classList.remove('active'); });
  document.getElementById('screen-app').classList.add('active');
  document.body.classList.remove('role-viewer'); document.body.classList.add('role-designer');
  var PV = window.__T_PanoViewer;
  document.getElementById('pano-overlay').classList.remove('hidden');
  document.getElementById('pano-canvas').classList.remove('hidden');
  PV.canvas = document.getElementById('pano-canvas'); PV.camera = {}; PV.renderer = {};
  PV.open = true;
  PV.S = { lon: 0, lat: 0, fov: 75, dragging: false, lx: 0, ly: 0, autoRotate: false, roll: 0 };
  document.getElementById('pano-nav').classList.remove('hidden');
  window.__T_TimeLapse.setPin({ id: 'pin1', timeline: [ { id: 'a', label: 'A' }, { id: 'b', label: 'B' } ] });
  return 'ok';
})();`;

async function r5aCheck(ws, expectFixed) {
  await send(ws, "Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await wait(250);
  const r = await ev(ws, `(function(){
    function rect(id){ var e=document.getElementById(id); if(!e) return null; var r=e.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom }; }
    function overlap(a,b){ if(!a||!b) return -1; var ix = Math.max(0, Math.min(a.right,b.right)-Math.max(a.left,b.left)); var iy = Math.max(0, Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)); return ix*iy; }
    var toggle = rect('btn-pano-tools-toggle'), tl = rect('pano-timeline'), nav = rect('pano-nav');
    return { toggle: toggle, tl: tl, nav: nav,
             ovToggleNav: overlap(toggle, nav), ovToggleTl: overlap(toggle, tl), ovNavTl: overlap(nav, tl) };
  })()`);
  if (expectFixed) {
    ok(r.ovToggleNav === 0, "R5a — 도구 토글 ↔ 하단 네비 겹침 0", r);
    ok(r.ovToggleTl === 0, "R5a — 도구 토글 ↔ 시점 타임라인 겹침 0", r);
    ok(r.ovNavTl === 0, "R5a — 하단 네비 ↔ 시점 타임라인 겹침 0", r);
  } else {
    ok(r.ovToggleNav > 0 || r.ovToggleTl > 0 || r.ovNavTl > 0, "R5a 뮤테이션 — bottom 되돌리면 겹침 재현(결함 재현)", r);
  }
}
async function r5bCheck(ws, expectCollapsed) {
  await send(ws, "Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await wait(150);
  const r = await ev(ws, `(function(){
    var box = document.getElementById('pano-radar');
    box.classList.remove('hidden', 'collapsed');
    document.getElementById('pano-radar-map').style.height = '200px'; // 실제 이미지 로드 대신 높이 고정(결정론적 측정)
    window.__T_Radar._bindChromeOnce(box);
    var rect = box.getBoundingClientRect();
    var cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    var coversCenter = rect.left <= cx && cx <= rect.right && rect.top <= cy && cy <= rect.bottom;
    return { collapsed: box.classList.contains('collapsed'), rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, coversCenter: coversCenter, cx: cx, cy: cy };
  })()`);
  if (expectCollapsed) {
    ok(r.collapsed === true, "R5b — 모바일(375px) 좁은 화면에서 미니맵 기본 접힘", r);
    ok(r.coversCenter === false, "R5b — 접힘 상태라 화면 중앙(드래그 회전 지점)을 가리지 않음", r);
  } else {
    ok(r.collapsed === false, "R5b 뮤테이션 — 기본 접힘 로직 제거 시 'collapsed' 클래스 미부착(결함 재현)", r);
  }
}
async function r5bDesktopRegression(ws) {
  await send(ws, "Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await wait(150);
  const r = await ev(ws, `(function(){
    var box = document.getElementById('pano-radar');
    box.classList.remove('hidden', 'collapsed');
    window.__T_Radar._mobileCollapseInited = false; // 새 viewport 재판정 허용(테스트 전용 리셋)
    window.__T_Radar._bindChromeOnce(box);
    return { collapsed: box.classList.contains('collapsed'), large: box.classList.contains('pano-radar-large') };
  })()`);
  ok(r.collapsed === false, "R5b 회귀 — 데스크톱(1280px)은 기본 접힘 적용 안 됨(회귀 0)", r);
  ok(r.large === true, "R5b 회귀 — 데스크톱 기본 확대(wm-radar-large) 그대로 유지", r);
}

/* ══════════════════════════════════════════════════════════════
   R6 — GET /api/app-settings 비밀키 누수 차단 (실 wrangler dev + 실 D1)
   ══════════════════════════════════════════════════════════════ */
async function runR6(mutate) {
  const TMP = TMP_ROOT;
  const STATE_SRC = path.join(TMP, "localdev-state");
  if (!fs.existsSync(STATE_SRC)) { ok(false, "R6 준비 — .tmp/localdev-state 없음(사전 node build-tools/local-dev.mjs 필요)"); return; }
  const OUT = path.join(TMP, "p185-r6" + (mutate ? "-mut" : ""));
  const WORK = path.join(OUT, "work");
  const STATE = path.join(OUT, "state");
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  for (const f of ["public", "src", "migrations"]) fs.cpSync(path.join(ROOT, f), path.join(WORK, f), { recursive: true, filter: (s) => !/[\\/]public[\\/]js[\\/]main\.js$/.test(s) });
  for (const f of ["vite.config.ts", "package.json", "tsconfig.json", "wrangler.jsonc"]) fs.copyFileSync(path.join(ROOT, f), path.join(WORK, f));
  {
    const wj = path.join(WORK, "wrangler.jsonc");
    const txt = fs.readFileSync(wj, "utf8").replace(/,(\s*\/\/[^\r\n]*)*\s*"ai"\s*:\s*\{[^}]*\}/, "");
    fs.writeFileSync(wj, txt);
  }
  if (mutate) {
    const fp = path.join(WORK, "src/index.tsx");
    const src = fs.readFileSync(fp, "utf8");
    const needle1 = `      if (isSensitiveAppSettingsKey(key)) return c.json({ scope, key, value: {}, updated_at: 0 })\n`;
    const needle2 = `      if (isSensitiveAppSettingsKey(r.skey)) return\n`;
    if (src.indexOf(needle1) < 0 || src.indexOf(needle2) < 0) { ok(false, "R6 뮤테이션 대상 문자열 없음(소스 변경됨 — 재확인 필요)"); return; }
    fs.writeFileSync(fp, src.replace(needle1, "").replace(needle2, ""));
    console.log("[MUT] R6 — isSensitiveAppSettingsKey 필터 호출 2곳 제거");
  }
  const man = fs.readFileSync(path.join(WORK, "public/js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  fs.writeFileSync(path.join(WORK, "public/js/main.js"), man.map((f) => fs.readFileSync(path.join(WORK, "public/js/modules", f), "utf8")).join("\n"));
  const env = { ...process.env, TEMP: TMP, TMP };
  const NM = path.join(ROOT, "node_modules");
  execSync(`node --max-old-space-size=640 "${path.join(NM, "vite/bin/vite.js")}" build`, { cwd: WORK, env, stdio: "pipe" });
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.cpSync(STATE_SRC, STATE, { recursive: true });
  const wr = (args) => execSync(`node "${path.join(NM, "wrangler/bin/wrangler.js")}" ${args}`, { cwd: WORK, env, stdio: "pipe" });
  for (const mf of fs.readdirSync(path.join(WORK, "migrations")).filter((f) => /^\d+_.*\.sql$/.test(f) && f >= "0042")) {
    try { wr(`d1 execute webapp-production --local --persist-to "${STATE}" --file "migrations/${mf}"`); } catch (e) {}
  }
  const PORT = String(18900 + (mutate ? 1 : 0));
  const wrangler = spawn("node", [path.join(NM, "wrangler/bin/wrangler.js"), "pages", "dev", "dist", "--d1=webapp-production", "--local", "--persist-to", STATE, "--ip", "127.0.0.1", "--port", PORT], { cwd: WORK, env, stdio: ["ignore", "pipe", "pipe"] });
  let wlog = ""; wrangler.stdout.on("data", (d) => (wlog += d)); wrangler.stderr.on("data", (d) => (wlog += d));
  const BASE = "http://127.0.0.1:" + PORT;
  async function api(method, url, body, tok) {
    const r = await fetch(BASE + url, { method, redirect: "manual", headers: Object.assign({ "Content-Type": "application/json" }, tok ? { Authorization: "Bearer " + tok } : {}), body: body == null ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch (e) {}
    return { s: r.status, j, text };
  }
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) { try { const r = await fetch(BASE + "/manifest.webmanifest"); up = !!r.status; } catch (e) {} if (!up) await wait(500); }
    if (!up) { ok(false, "R6 — wrangler 기동 실패", wlog.slice(-800)); return; }

    const acc = JSON.parse(fs.readFileSync(path.join(TMP, "local-test-accounts.json"), "utf8")).accounts;
    const sup = acc.find((a) => a.role === "super") || acc[0];
    const sTok = (await api("POST", "/api/signup/login", { email: sup.email, password: sup.password })).j.token;
    ok(!!sTok, "R6 준비 — 로컬 계정 로그인", { hasTok: !!sTok });
    if (!sTok) return;

    // auto_entry_secret 행 보장(mint 가 1회 자동생성 — p149/p179b 와 동일 경로)
    await api("POST", "/api/auth/auto-entry", { kind: "viewer" });

    const byKey = await api("GET", "/api/app-settings?scope=*&key=auto_entry_secret", null, sTok);
    const list = await api("GET", "/api/app-settings?scope=*", null, sTok);
    const byKeyEmpty = !byKey.j || !byKey.j.value || Object.keys(byKey.j.value).length === 0;
    const listHasSecretKey = !!(list.j && list.j.settings && Object.prototype.hasOwnProperty.call(list.j.settings, "auto_entry_secret"));
    if (!mutate) {
      ok(byKey.s === 200 && byKeyEmpty, "R6 — key=auto_entry_secret 단건 조회는 항상 빈 값", { s: byKey.s, value: byKey.j && byKey.j.value });
      ok(list.s === 200 && listHasSecretKey === false, "R6 — scope=* 목록에 auto_entry_secret 행 미포함", { keys: list.j && Object.keys(list.j.settings || {}) });
    } else {
      ok(listHasSecretKey === true, "R6 뮤테이션 — 필터 제거 시 scope=* 목록에 auto_entry_secret 행 노출(결함 재현)", { keys: list.j && Object.keys(list.j.settings || {}) });
    }
  } finally {
    try { wrangler.kill(); } catch (e) {}
  }
}

/* ══════════════════════════════════════════════════════════════
   메인 — 순서: R4(원본→뮤테이션) → R5a/R5b(원본→뮤테이션) → R6(원본→뮤테이션)
   ══════════════════════════════════════════════════════════════ */
async function main() {
  if (!fs.existsSync(CHROME)) { console.log("FAIL Chrome 없음: " + CHROME); process.exit(2); }
  fs.mkdirSync(TMP_ROOT, { recursive: true });

  console.log("\n[R4] 보기 설정 재동기화 — 원본");
  await runSession(exposeForTest(buildBundle()), {}, R4_SETUP, (ws) => r4Check(ws, true));

  console.log("\n[R4] 뮤테이션 — syncDisplayPrefsControls() 호출 제거");
  {
    const src = fs.readFileSync(path.join(MODULES_DIR, "24_Settings.js"), "utf8");
    const needleRe = /[ \t]*if \(typeof syncDisplayPrefsControls === "function"\) syncDisplayPrefsControls\(\);\r?\n/;
    if (!needleRe.test(src)) { ok(false, "R4 뮤테이션 대상 문자열 없음"); }
    else {
      const mutated = src.replace(needleRe, "      // [MUT] 재동기화 호출 제거\n");
      await runSession(exposeForTest(buildBundle({ "24_Settings.js": mutated })), {}, R4_SETUP, (ws) => r4Check(ws, false));
    }
  }

  console.log("\n[R5a/R5b] 모바일 하단 컨트롤 겹침 0 · 레이더 기본 접힘 — 원본");
  await runSession(exposeForTest(buildBundle()), {}, R5_SETUP, async (ws) => { await r5aCheck(ws, true); await r5bCheck(ws, true); await r5bDesktopRegression(ws); });

  console.log("\n[R5a] 뮤테이션 — CSS bottom 되돌림(도구 토글·타임라인)");
  {
    const css = fs.readFileSync(path.join(REPO_PUBLIC, "css", "style.css"), "utf8");
    const n1 = `position: absolute; bottom: 84px; left: 50%; transform: translateX(-50%);`;
    const n2 = `.pano-timeline { max-width: 94vw; bottom: 128px; }`;
    if (css.indexOf(n1) < 0 || css.indexOf(n2) < 0) { ok(false, "R5a 뮤테이션 대상 CSS 문자열 없음"); }
    else {
      const mutatedCss = css.replace(n1, "position: absolute; bottom: var(--pano-controls-bottom); left: 50%; transform: translateX(-50%);")
                             .replace(n2, ".pano-timeline { max-width: 94vw; bottom: 70px; }");
      await runSession(exposeForTest(buildBundle()), { "css/style.css": mutatedCss }, R5_SETUP, (ws) => r5aCheck(ws, false));
    }
  }

  console.log("\n[R5b] 뮤테이션 — 모바일 기본 접힘 로직 제거");
  {
    const src = fs.readFileSync(path.join(MODULES_DIR, "07_Radar.js"), "utf8");
    const needle = `            box.classList.add("collapsed");\n`;
    if (src.indexOf(needle) < 0) { ok(false, "R5b 뮤테이션 대상 문자열 없음"); }
    else {
      const mutated = src.replace(needle, "            // [MUT] 기본 접힘 제거\n");
      await runSession(exposeForTest(buildBundle({ "07_Radar.js": mutated })), {}, R5_SETUP, (ws) => r5bCheck(ws, false));
    }
  }

  console.log("\n[R6] app-settings 비밀키 필터 — 원본");
  await runR6(false);
  console.log("\n[R6] 뮤테이션 — 필터 호출 제거");
  await runR6(true);

  clearTimeout(watchdog);
  console.log("\n" + (failed ? "FAIL " + failed : "ALL PASS"));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("ERROR", e && e.stack || e); process.exit(1); });
