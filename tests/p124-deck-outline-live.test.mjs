/**
 * p124 — 46_DeckOutline(구역 윤곽) 실측(수정 전 FAIL 예상, 실 Chrome). p118(가짜 DOM/vm)이 못 잡는
 * 실제 레이아웃·겹침·CSS 캐스케이드를 real headless Chrome 으로 잡는다(CLAUDE.md §G-2-3 — 목 0).
 * 실행: P124=1 TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p124-deck-outline-live.test.mjs
 *   (P124 != "1" 이면 즉시 SKIP)
 *
 * [재현] 지휘자 R1~R3(2026-10-06): .deck-outline-layer 의 자식은 라벨 버튼 하나뿐(사각형은 형제
 *   #deck-outline-svg 안에 있다 — p118 이 못 잡은 이유: vm 가짜 DOM이라 실제 페인트/겹침을 모른다),
 *   라벨이 사각형 top 변 전체를 덮어 핀 4·5 를 가림, B구역 진입 후 CHECKER 칩이 크롭 밖 핀까지
 *   합친 전체(5)를 보여줌(트리 SoT 미사용).
 *
 * 사전 준비(이 테스트가 직접 수행하지 않음 — §G-5, 무거운 시드/마이그레이션 반복 방지):
 *   node build-tools/local-dev.mjs && node build-tools/seed-local.mjs
 *   (.tmp/localdev-state 의 D1 에 proj_localseed/B구역(crop 27.5,35,22.5,30)/CHECKER 핀 5개가 이미 있다)
 * 이 테스트는 "현재 작업트리"의 public/js/modules·css 를 조립→빌드해 .tmp/p124/dist 를 새로 만들고
 * (git archive 아님 — 커밋 전 코드도 그대로 검증), 그 dist 를 기존 .tmp/localdev-state(D1/R2, 불변)에
 * 물려 wrangler pages dev 로 띄운다.
 */
import { execSync, spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { fileURLToPath } from "node:url";

if (process.env.P124 !== "1") {
  console.log("[SKIP] p124 는 P124=1 일 때만 실행(실 Chrome+워커 실측, 수십 초 소요)");
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = path.join(ROOT, ".tmp");
const OUT = path.join(TMP, "fixoutline2", "p124");
const WORK = path.join(TMP, "p124-dist-src"); // 조립용 임시 사본(작업트리 직접 오염 금지)
const STATE = path.join(TMP, "localdev-state"); // 기존 시드 재사용(불변 — 이 테스트는 쓰지 않음)
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

let failed = 0;
const fails = [];
const ok = (cond, label, detail) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail) : ""));
  if (!cond) { failed++; fails.push(label); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(STATE)) {
  console.log("FAIL .tmp/localdev-state 없음 — 먼저 node build-tools/local-dev.mjs && node build-tools/seed-local.mjs 를 실행하세요.");
  process.exit(2);
}
if (!fs.existsSync(CHROME)) { console.log("FAIL Chrome 없음: " + CHROME); process.exit(2); }

// ── ① 현재 작업트리를 그대로(격리 복사 없이, 커밋 전 코드 그대로) assemble→stamp→vite build ──
function sh(cmd) {
  console.log("[p124] $ " + cmd);
  execSync(cmd, { stdio: "inherit", cwd: ROOT, env: { ...process.env, TEMP: TMP, TMP: TMP } });
}
sh("python build-tools/assemble.py");
sh("node build-tools/stamp-version.mjs");
for (const [src, dst] of [["public/js/main.js", "js/main.js"], ["public/index.html", "index.html"], ["public/css/style.css", "css/style.css"]]) {
  fs.copyFileSync(path.join(ROOT, src), path.join(ROOT, dst));
}
sh('node --max-old-space-size=640 node_modules/vite/bin/vite.js build');

// ── ② wrangler pages dev — 기존 시드 D1(.tmp/localdev-state) + 방금 빌드한 dist ──
const PORT = process.env.P124_PORT || "18799";
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

  // ── ③ Chrome + CDP ──
  const profileDir = path.join(TMP, "p124-chrome-" + Date.now());
  chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", "--user-data-dir=" + profileDir, "--window-size=375,812", "about:blank"], { stdio: "ignore" });
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
  const consoleLog = [];
  const navLog = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); return; }
    if (msg.method === "Runtime.consoleAPICalled" && (msg.params.type === "error")) consoleLog.push(msg.params.args.map((a) => a.value || a.description || "").join(" ").slice(0, 300));
    if (msg.method === "Runtime.exceptionThrown") consoleLog.push("EXC: " + JSON.stringify(msg.params.exceptionDetails).slice(0, 400));
    if (msg.method === "Page.frameNavigated" && !msg.params.frame.parentId) navLog.push({ t: Date.now(), url: msg.params.frame.url, type: msg.params.type });
    if (msg.method === "Page.loadEventFired") navLog.push({ t: Date.now(), load: true });
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
  await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });

  // ── 로그인(로컬 세션, designer) ──
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

  // ── 원본(메인) 열기 ── [견고화] 허브 첫 진입 후 ~2s 안에 문서 전체가 "/" 로 1회 더
  // frameNavigated 되는 배경 재진입(이 모듈과 무관 — 세션/PWA 초기화 경로의 기존 동작으로 추정,
  // 실측 NAV_LOG 로 매 실행 재현)이 있어, 그 재진입과 경합하면 "진입 직후"에 잰 단언이 허상 FAIL
  // 을 낸다. 클릭→핀 로딩까지 **전체를 최대 3회 재시도**해 경합을 흡수한다(개별 waitFor 늘리기로는
  // 해결 안 됨 — 재진입 자체가 DOM 을 통째로 새로 만든다).
  let entered = false;
  for (let attempt = 0; attempt < 3 && !entered; attempt++) {
    await waitFor("document.querySelector('[data-act=origin-open]')", 15000);
    let clickRes = { found: false };
    for (let i = 0; i < 20 && !clickRes.found; i++) {
      await wait(300);
      clickRes = await evSafe(`(function(){ var e = document.querySelector('[data-act=origin-open]'); if (!e) return {found:false}; e.scrollIntoView({block:'center'}); e.click(); return {found:true}; })()`);
    }
    if (!clickRes.found) continue;
    await waitFor("document.querySelector('#screen-app.active')", 20000);
    const pinsWait = await waitFor("document.querySelectorAll('.pin-marker').length > 0", 8000);
    if (pinsWait < 0) continue; // 배경 재진입에 휩쓸림 — 허브로 돌아갔을 수 있다, 다음 attempt 에서 재시도
    await wait(400);
    const stillIn = await evSafe("document.querySelector('#screen-app.active') && document.querySelectorAll('.pin-marker').length > 0");
    if (stillIn === true) entered = true;
  }
  ok(entered, "허브 → 원본(메인 PDF) 열기 → 핀 로딩 완료(배경 재진입 경합 흡수, 최대 3회 재시도)");
  // [견고화] 핀이 막 나타난 시점엔 리더선·맵 핏(zoom/pan) 애니메이션이 아직 안착 중일 수 있어
  // _placeLabels() 의 getBoundingClientRect() 겹침 판정이 과도기 프레임을 잴 수 있다(실측: 간헐
  // FAIL, 겹침 값이 "배치 안 함" 뮤테이션과 동일 크기로 재현 — 과도기 스냅샷 추정). 레이아웃이
  // 안정된 뒤(연속 2회 동일 rect) 측정한다.
  let prevRect = null, settleCount = 0;
  for (let i = 0; i < 20 && settleCount < 2; i++) {
    const r = await evSafe("(function(){ var b=document.querySelector('.deck-outline-label'); if(!b) return null; var x=b.getBoundingClientRect(); return [x.x,x.y,x.width,x.height].join(','); })()");
    if (r && r === prevRect) settleCount++; else settleCount = 0;
    prevRect = r;
    await wait(200);
  }
  await shot("main");

  // ── R1: 윤곽 사각형 — 실제 DOM 존재 + 기하(crop% × 도면 px) 일치 ──
  const outline = await evSafe(`(function(){
    var svg = document.getElementById('deck-outline-svg');
    var rect = svg ? svg.querySelector('rect.deck-outline-shape') : null;
    if (!rect) return { rectExists: false };
    var bb = rect.getBoundingClientRect(), svgBox = svg.getBoundingClientRect();
    var cs = getComputedStyle(rect);
    return { rectExists: true, x: +rect.getAttribute('x'), y: +rect.getAttribute('y'), w: +rect.getAttribute('width'), h: +rect.getAttribute('height'),
      bb: { x: bb.x, y: bb.y, w: bb.width, h: bb.height }, svgBox: { x: svgBox.x, y: svgBox.y, w: svgBox.width, h: svgBox.height },
      dasharray: cs.strokeDasharray, strokeColor: cs.stroke };
  })()`);
  ok(outline.rectExists, "R1 — #deck-outline-svg 안에 rect.deck-outline-shape 가 실제로 존재한다(p118 가짜 DOM이 못 본 것)", outline);
  if (outline.rectExists) {
    ok(Math.abs(outline.x - 27.5) < 0.01 && Math.abs(outline.y - 35) < 0.01 && Math.abs(outline.w - 22.5) < 0.01 && Math.abs(outline.h - 30) < 0.01,
      "R1 — crop% 그대로(x27.5,y35,w22.5,h30) 반영", outline);
    const expW = outline.svgBox.w * (outline.w / 100), expH = outline.svgBox.h * (outline.h / 100);
    ok(Math.abs(outline.bb.w - expW) < 2 && Math.abs(outline.bb.h - expH) < 2,
      "R1 — 화면 px 크기 = 도면 영역 × crop%(허수아비 0 사이즈 아님)", { bb: outline.bb, expW, expH });
    ok(/\d/.test(outline.dasharray) && outline.dasharray !== "none", "R1 — 점선(stroke-dasharray) 적용 확인", outline.dasharray);
  }

  // ── R2: 라벨 × 핀 마커 겹침 면적 = 0 ──
  const overlap = await evSafe(`(function(){
    var btn = document.querySelector('.deck-outline-label');
    if (!btn) return { labelExists: false };
    var r = btn.getBoundingClientRect();
    var pins = Array.from(document.querySelectorAll('.pin-marker')).map(function(p){ return p.getBoundingClientRect(); });
    var overlapArea = function(a,b){ var w = Math.min(a.right,b.right)-Math.max(a.left,b.left); var h = Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top); return (w>0&&h>0)?w*h:0; };
    var total = pins.reduce(function(s,p){ return s+overlapArea(r,p); }, 0);
    return { labelExists: true, totalOverlap: total, pinCount: pins.length };
  })()`);
  ok(overlap.labelExists, "R2 — 윤곽 라벨 버튼 존재", overlap);
  ok(overlap.labelExists && overlap.totalOverlap === 0, "R2 — 라벨 × 핀 마커(.pin-marker) 겹침 면적 = 0", overlap);

  // ── 메인(크롭 없는 A구역-1영역) 칩 = 5(비크롭 구역은 영향 없음, 회귀 확인) ──
  const mainChip = await evSafe(`(function(){ var el = document.querySelector('#pin-filter-bar .pinfilter-chip.pf-checkboard .zpager-cnt'); return el ? el.textContent : null; })()`);
  ok(mainChip === "5", "회귀 — 크롭 없는 구역(A구역-1영역)의 CHECKER 칩은 그대로 5(전체)", mainChip);

  // ── R3: B구역 진입 → 칩 = 2(크롭 안 핀만, SoT: Projects.pinsForDeck) ──
  const enter = await evSafe(`(function(){ var b = document.querySelector('.deck-outline-label'); if (!b) return {found:false}; b.click(); return {found:true}; })()`);
  ok(enter.found, "라벨 클릭 → B구역 진입");
  await wait(1000);
  await shot("inside-b");
  const after = await evSafe(`(function(){
    var chip = document.querySelector('#pin-filter-bar .pinfilter-chip.pf-checkboard .zpager-cnt');
    var treeLeaf = document.querySelector('.tree-node-mode-leaf.active .tree-cnt');
    var markers = document.querySelectorAll('.pin-marker').length;
    return { chip: chip ? chip.textContent : null, treeLeaf: treeLeaf ? treeLeaf.textContent : null, markers: markers };
  })()`);
  ok(after.chip === "2", "R3 — B구역(crop) 진입 후 필터 칩 = 2(크롭 안 핀만)", after);
  ok(after.treeLeaf === "2", "R3 — 트리 모드잎 칩도 동일 SoT로 2(필터칩과 일치)", after);
  ok(after.markers === 5, "R3 — 핀 마커 자체는 숨기지 않는다(5개 그대로, 카운트만 scoping)", after);

  const jsErrors = consoleLog.filter((e) => !/favicon/i.test(e));
  ok(jsErrors.length === 0, "콘솔 JS 에러 0건", jsErrors);
} finally {
  await cleanup();
}

console.log("\n" + (failed ? "FAILED " + failed + "건: " + fails.join(", ") : "ALL PASS"));
process.exit(failed ? 1 : 0);
