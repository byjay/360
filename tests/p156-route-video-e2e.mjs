/**
 * p156-e2e — 360 동영상 동선(WO 20261016-routevideo-e2e) 실 Chrome · 실 워커 · 목 0.
 *   [재이식] 원본 worktree(4e1b93b, agent-a41ea3de095f35cf0)의 playwright 버전을 main 구조
 *   (63_RouteDraw.js·06_PanoViewer.js·/v/<token>)에 맞춰 CDP(p144/p149 와 동일 격리 패턴)로 재작성했다.
 *   worktree 는 63_RouteDraw.js 가 없다(main 에만 존재 — 7ea6786 재이식) — API 는 동일(Routes.*·State.routes).
 *
 * 시나리오: 360 모드[동선 그리기] → 점 3개 → 완료 → 소형 webm 업로드(실 디코드 가능 — 가짜 바이트 금지)
 *   → 새로고침 후 복원 → 클릭 재생 → 진행률↔위치점 → 동선 중간 클릭 탐색(Range 206)
 *   → 열람 링크(/v/<token>)에서 재생 가능 · 그리기(편집) 0.
 *
 * 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p156-route-video-e2e.mjs
 *   뮤테이션: P156_MUT=viewerdraw|range206 → 격리 사본만 고쳐 빌드, EXIT=1 이어야 한다.
 * 사전: .tmp/localdev-state (node build-tools/local-dev.mjs && node build-tools/seed-local.mjs)
 */
import { execSync, spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { ensureVideoFixture } from "./_lib/video-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = path.join(ROOT, ".tmp");
const MUT = process.env.P156_MUT || "";
const OUT = path.join(TMP, "p156" + (MUT ? "-mut-" + MUT : ""));
const WORK = path.join(OUT, "work");
const STATE_SRC = path.join(TMP, "localdev-state");
const STATE = path.join(OUT, "state");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const NM = path.join(ROOT, "node_modules");
const PID = "proj_localseed";
let failed = 0;
const ok = (c, label, d) => { console.log((c ? "  PASS " : "  FAIL ") + label + (d != null ? " :: " + JSON.stringify(d).slice(0, 500) : "")); if (!c) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
if (!fs.existsSync(STATE_SRC)) { console.log("FAIL .tmp/localdev-state 없음 — 먼저 node build-tools/local-dev.mjs && node build-tools/seed-local.mjs"); process.exit(2); }
if (!fs.existsSync(CHROME)) { console.log("FAIL Chrome 없음: " + CHROME); process.exit(2); }
const watchdog = setTimeout(() => { console.log("\nWATCHDOG — 300s 초과 → FAIL"); process.exit(1); }, 300000);

/* ── 뮤테이션(격리 사본만) — 고친 줄을 되돌리면 이 테스트가 FAIL 해야 한다 ── */
const MUTS = {
  // 63_RouteDraw.toggleDraw() 의 isDesigner() 가드를 지우면 열람자도 그리기 모드에 들어간다.
  viewerdraw: ["public/js/modules/63_RouteDraw.js", "if (!this.isDesigner()) return;\n      if (State.drawingRoute)", "if (State.drawingRoute)"],
  // 서버 Range 응답을 206→200으로 바꾸면 <video> 탐색(Range 지원)이 깨진다.
  range206: ["src/index.tsx", "return new Response(obj.body, { status: 206, headers })", "return new Response(obj.body, { status: 200, headers })"],
};
if (MUT && !MUTS[MUT]) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }

// ── 격리 빌드(작업트리 모듈 → WORK, 메인 트리 파일 0 터치) + 상태 사본(마이그레이션 보강) ──
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
for (const f of ["public", "src", "migrations"]) fs.cpSync(path.join(ROOT, f), path.join(WORK, f), { recursive: true, filter: (s) => !/[\\/]public[\\/]js[\\/]main\.js$/.test(s) });
for (const f of ["vite.config.ts", "package.json", "tsconfig.json", "wrangler.jsonc"]) fs.copyFileSync(path.join(ROOT, f), path.join(WORK, f));
{
  const wj = path.join(WORK, "wrangler.jsonc");
  const txt = fs.readFileSync(wj, "utf8").replace(/,(\s*\/\/[^\r\n]*)*\s*"ai"\s*:\s*\{[^}]*\}/, "");
  if (/"ai"\s*:/.test(txt)) { console.log("FAIL 격리 사본 AI 바인딩 제거 실패"); process.exit(2); }
  fs.writeFileSync(wj, txt);
}
if (MUT) {
  const [file, from, to] = MUTS[MUT];
  const fp = path.join(WORK, file);
  const src = fs.readFileSync(fp, "utf8").replace(/\r\n/g, "\n");
  if (src.indexOf(from) < 0) { console.log("  FAIL 뮤테이션 대상 문자열 없음: " + MUT); process.exit(2); }
  fs.writeFileSync(fp, src.replace(from, to));
  console.log("[MUT] " + MUT + " — " + file + " 의 고친 줄을 되돌림");
}
const man = fs.readFileSync(path.join(WORK, "public/js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
if (!man.includes("63_RouteDraw.js")) { console.log("FAIL _manifest.txt 에 63_RouteDraw.js 없음"); process.exit(2); }
fs.writeFileSync(path.join(WORK, "public/js/main.js"), man.map((f) => fs.readFileSync(path.join(WORK, "public/js/modules", f), "utf8")).join("\n"));
const env = { ...process.env, TEMP: TMP, TMP: TMP };
execSync(`node --max-old-space-size=640 "${path.join(NM, "vite/bin/vite.js")}" build`, { cwd: WORK, env, stdio: "pipe" });
fs.rmSync(STATE, { recursive: true, force: true });
fs.cpSync(STATE_SRC, STATE, { recursive: true });
const wr = (args) => execSync(`node "${path.join(NM, "wrangler/bin/wrangler.js")}" ${args}`, { cwd: WORK, env, stdio: "pipe" });
for (const mf of fs.readdirSync(path.join(WORK, "migrations")).filter((f) => /^\d+_.*\.sql$/.test(f) && f >= "0042")) {
  try { wr(`d1 execute webapp-production --local --persist-to "${STATE}" --file "migrations/${mf}"`); } catch (e) { /* ALTER 중복 = 이미 적용 */ }
}

const PORT = process.env.P156_PORT || "18856";
const wrangler = spawn("node", [path.join(NM, "wrangler/bin/wrangler.js"), "pages", "dev", "dist", "--d1=webapp-production", "--local", "--persist-to", STATE, "--ip", "127.0.0.1", "--port", PORT],
  { cwd: WORK, env, stdio: ["ignore", "pipe", "pipe"] });
let wlog = ""; wrangler.stdout.on("data", (d) => (wlog += d)); wrangler.stderr.on("data", (d) => (wlog += d));
const BASE = "http://127.0.0.1:" + PORT;
let chrome = null; const sockets = [];
async function cleanup() { sockets.forEach((s) => { try { s.close(); } catch (e) {} }); try { chrome && chrome.kill(); } catch (e) {} try { wrangler.kill(); } catch (e) {} }

async function api(method, url, body, tok) {
  const r = await fetch(BASE + url, { method, headers: Object.assign({ "Content-Type": "application/json" }, tok ? { Authorization: "Bearer " + tok } : {}), body: body == null ? undefined : JSON.stringify(body) });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) {}
  return { s: r.status, j, text };
}
const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej));
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 }); sockets.push(ws);
  await new Promise((r) => ws.on("open", r));
  let idc = 0; const pend = new Map(); const errs = []; const listeners = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
    if (m.method === "Runtime.exceptionThrown") errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300));
    listeners.forEach((f) => { try { f(m); } catch (e) {} });
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++idc; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr, ms) => { const r = await Promise.race([send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }), wait(ms || 30000).then(() => { throw new Error("evaluate 무응답"); })]); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
  const evS = async (e) => { try { return await ev(e, 15000); } catch (x) { return { __err: String(x.message).slice(0, 200) }; } };
  const waitFor = async (cond, t = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if ((await evS("(function(){try{return !!(" + cond + ")}catch(e){return false}})()")) === true) return Date.now() - t0; await wait(120); } return -1; };
  return { ws, send, ev, evS, waitFor, errs, listeners };
}
async function click(P, x, y) {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await P.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
}
let shotN = 0;
async function shot(P, name) { const s = await P.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, String(++shotN).padStart(2, "0") + "-" + name + ".png"), Buffer.from(s.data, "base64")); }

try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { const r = await fetch(BASE + "/manifest.webmanifest"); up = !!r.status; } catch (e) {} if (!up) await wait(500); }
  if (!up) { console.log("FAIL wrangler 기동 실패\n" + wlog.slice(-1500)); process.exit(1); }

  const videoPath = await ensureVideoFixture(TMP, CHROME);
  ok(fs.existsSync(videoPath) && fs.statSync(videoPath).size > 500, "준비 — 실 디코드 가능한 초소형 webm 픽스처 생성(MediaRecorder, 가짜 바이트 0)", { size: fs.existsSync(videoPath) ? fs.statSync(videoPath).size : 0 });

  const acc = JSON.parse(fs.readFileSync(path.join(TMP, "local-test-accounts.json"), "utf8")).accounts;
  const sup = acc.find((a) => a.role === "super");
  const sTok = (await api("POST", "/api/signup/login", { email: sup.email, password: sup.password })).j.token;
  ok(!!sTok, "준비 — 로컬 super 로그인(시드 프로젝트 소유자)");

  const profile = path.join(TMP, "p156-chrome-" + Date.now());
  chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", "--user-data-dir=" + profile, "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
  let port = 0;
  for (let i = 0; i < 80 && !port; i++) { try { port = parseInt(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0], 10); } catch (e) {} if (!port) await wait(150); }
  let pageWs = null;
  for (let i = 0; i < 40 && !pageWs; i++) { try { const l = await getJson("http://127.0.0.1:" + port + "/json/list"); const pg = l.find((t) => t.type === "page"); if (pg) pageWs = pg.webSocketDebuggerUrl; } catch (e) {} if (!pageWs) await wait(250); }
  const P = await connect(pageWs);
  await P.send("Page.enable"); await P.send("Runtime.enable"); await P.send("Network.enable"); await P.send("DOM.enable");
  await P.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  const net206 = []; let fileChooserBackendNodeId = null;
  P.listeners.push((m) => {
    if (m.method === "Network.responseReceived" && /\/api\/r2\/object\//.test(m.params.response.url)) net206.push(m.params.response.status);
    if (m.method === "Page.fileChooserOpened") fileChooserBackendNodeId = m.params.backendNodeId;
  });
  await P.send("Page.setInterceptFileChooserDialog", { enabled: true });

  // ── 로그인(로컬 designer) + 프로젝트(기존 시드, 원본 도면 보유) 진입 ──
  await P.send("Page.navigate", { url: BASE + "/manifest.webmanifest" });
  await P.waitFor("location.pathname === '/manifest.webmanifest'");
  await P.ev(`localStorage.setItem("wm_local_token", ${JSON.stringify(sTok)}); 1`);
  await P.send("Page.navigate", { url: BASE + "/" });
  const entered = await P.waitFor(`window.__wm && __wm.ProjectHub && __wm.ProjectHub.list && __wm.ProjectHub.list.some(function(p){return p.id==='${PID}'})`, 30000);
  ok(entered >= 0, "준비 — 허브 로드(로컬 designer)");
  await P.ev(`(async function(){ var p=__wm.ProjectHub.list.find(function(x){return x.id==='${PID}'}); await __wm.ProjectHub.openProject(p); return 1; })()`, 30000);
  const drawOk = await P.waitFor(`__wm.State.pins && __wm.State.pins.length > 0 && !document.getElementById('map-viewport').classList.contains('hidden')`, 20000);
  ok(drawOk >= 0, "준비 — 원본 도면 로드(핀 존재 · map-viewport 표시)");
  // [p148 과 동일 근거] 허브 진입 후 ~2초 안에 문서가 배경에서 한 번 더 재진입하는 기존 거동이
  // 있다 — 안정화 대기 후에도 화면이 살아있는지 재확인한다(그렇지 않으면 아래 FeatureMenu 질의가
  // 그 사이 사라진 DOM 을 봐서 간헐적으로 실패한다).
  await wait(2500);
  await P.waitFor(`document.querySelector('#screen-app.active') && document.getElementById('btn-feature-menu')`, 10000);
  const isDesigner0 = await P.evS(`__wm.Routes.isDesigner()`);
  ok(isDesigner0 === true, "준비 — designer 세션(Routes.isDesigner() === true)");

  /* ══ A. [전체 기능] 메뉴 → 360 동영상 동선 긋기 → 점 3개 → Enter 로 완료 ══ */
  // [근본원인 — 하네스, 제품 결함 아님] #btn-route-draw 는 #section-place 안에 있고 그 섹션은
  //   style.css:5867 `#section-place{display:none!important;}`(WO 20260929-tree1 도구바+트리 통합,
  //   "요소는 DOM 유지=위임 동작") 로 영구 숨김 — 실사용자 진입점은 45_FeatureMenu.js 의
  //   [☰ 전체 기능] 패널(f.click 으로 숨은 버튼을 위임 .click())이다. 실제 사용자 경로를 그대로 쓴다.
  console.log("\n[A] [☰ 전체 기능] → 360 동영상 동선 긋기 → 점 3개 → Enter 완료");
  const fmBtn = await P.ev(`(function(){ var b=document.getElementById('btn-feature-menu'); var r=b.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}; })()`);
  await click(P, fmBtn.x, fmBtn.y); await wait(300);
  // [근본원인] 데스크톱 패널(#feature-menu)과 모바일 더보기 시트(#mdock-feature-menu) 둘 다
  // 같은 .fm-item 을 렌더한다(45_FeatureMenu.js mount/renderInto 2곳) — 모바일 쪽은 항상
  // display:none 이라 스코프 없는 querySelector 는 그 숨은 사본을 집어 rect 0x0 을 낸다.
  const fmSel = '#feature-menu .fm-item[data-feature="route-draw"]';
  const fmOpen = await P.waitFor(`document.querySelector('${fmSel}')`, 5000);
  ok(fmOpen >= 0, "A0 [전체 기능] 패널에 '360 동영상 동선 긋기' 항목 존재");
  const fmItem = await P.ev(`(function(){ var b=document.querySelector('${fmSel}'); b.scrollIntoView({block:'center'}); var r=b.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2, disabled:b.getAttribute('aria-disabled')}; })()`);
  ok(fmItem.disabled !== "true", "A0b 항목이 비활성 아님(perm·도면 조건 통과)", fmItem);
  await click(P, fmItem.x, fmItem.y); await wait(300);
  const drawingOn = await P.evS(`__wm.State.drawingRoute === true`);
  ok(drawingOn === true, "A1 [동선 긋기] 실행 → State.drawingRoute = true");

  await P.waitFor(`document.getElementById('map-transform') && document.getElementById('map-transform').getBoundingClientRect().width > 10`, 10000);
  const rect = await P.ev(`(function(){ var r=document.getElementById('map-viewport').getBoundingClientRect(); return {left:r.left, top:r.top, width:r.width, height:r.height}; })()`);
  const pts = [[0.2, 0.2], [0.5, 0.3], [0.6, 0.6]].map(([fx, fy]) => ({ x: rect.left + rect.width * fx, y: rect.top + rect.height * fy }));
  for (const p of pts) { await click(P, p.x, p.y); await wait(150); }
  const polyLen = await P.evS(`__wm.Routes._poly ? __wm.Routes._poly.length : -1`);
  ok(polyLen === 3, "A2 도면 클릭 3회 → 점 3개 누적(Routes._poly)", { polyLen });

  // 완료 = 실사용자 경로(더블클릭/Enter) — "동선 완료" 버튼도 같은 숨김 섹션 안이라 Enter 를 쓴다.
  await P.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter" });
  await P.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  await wait(300);
  const pending = await P.evS(`__wm.Routes._pendingPoints ? __wm.Routes._pendingPoints.length : -1`);
  ok(pending === 3, "A3 Enter → 완료, 3점이 _pendingPoints 로 확정(파일 선택 대기)", { pending });

  /* ══ B. 소형 webm 업로드 → 이름 입력 → 서버 저장 ══ */
  console.log("\n[B] 소형 동영상 업로드 → 이름 입력");
  const chooserOpened = await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 10000) { if (fileChooserBackendNodeId != null) return true; await wait(100); } return false; })();
  ok(chooserOpened, "B1 파일 선택창이 열림(가로채기)");
  if (chooserOpened) { await P.send("DOM.setFileInputFiles", { files: [videoPath], backendNodeId: fileChooserBackendNodeId }); }
  await wait(600);
  const askOpened = await P.waitFor("document.getElementById('prompt-modal') && document.getElementById('prompt-modal').classList.contains('on')", 8000);
  ok(askOpened >= 0, "B2 동선 이름 입력 모달 열림(Prompt.ask)");
  await P.ev(`(function(){ var i=document.getElementById('prompt-modal-input'); i.value='테스트동선'; i.dispatchEvent(new Event('input')); return 1; })()`);
  await P.evS(`document.getElementById('prompt-modal-ok').click()`);

  const routeCreated = await P.waitFor(`__wm.State.routes && __wm.State.routes.length === 1`, 8000);
  ok(routeCreated >= 0, "B3 State.routes 에 동선 1건 생성");
  const videoUploaded = await P.waitFor(`__wm.State.routes[0] && !!__wm.State.routes[0].videoId`, 15000);
  ok(videoUploaded >= 0, "B4 영상이 업로드되어 route.videoId 연결됨(/api/r2/upload)");
  const routeId = await P.evS(`__wm.State.routes[0].id`);

  const renderChk = await P.evS(`(function(){ var el=document.querySelector('#routes-svg .route-line'); if(!el) return {lineRendered:false}; var cs=getComputedStyle(el); return { lineRendered:true, dash: cs.strokeDasharray, marker: cs.markerEnd }; })()`);
  ok(renderChk.lineRendered, "B5 #routes-svg 안에 .route-line 렌더");
  ok(!!renderChk.dash && renderChk.dash !== "none", "B5b stroke-dasharray(점선) CSS 적용", renderChk);
  ok(!!renderChk.marker && /route-arrow/.test(renderChk.marker), "B5c marker-end(화살표) 적용", renderChk);

  await shot(P, "route-drawn");

  /* ══ C. 새로고침 후 복원 ══ */
  console.log("\n[C] 새로고침 후 복원");
  await P.send("Page.navigate", { url: BASE + "/" });
  await P.waitFor(`window.__wm && __wm.ProjectHub && __wm.ProjectHub.list && __wm.ProjectHub.list.some(function(p){return p.id==='${PID}'})`, 20000);
  await P.ev(`(async function(){ var p=__wm.ProjectHub.list.find(function(x){return x.id==='${PID}'}); await __wm.ProjectHub.openProject(p); return 1; })()`, 30000);
  const restored = await P.waitFor(`__wm.State.routes && __wm.State.routes.some(function(r){return r.id===${JSON.stringify(routeId)} && !!r.videoId})`, 20000);
  ok(restored >= 0, "C1 새로고침 후 서버에서 동선·영상 연결 복원");
  await wait(2500);
  await P.waitFor(`document.querySelector('#screen-app.active')`, 10000);

  /* ══ D. 클릭 재생 → 진행률↔위치점 ══ */
  console.log("\n[D] 클릭 재생 → 진행률 ↔ 위치점");
  // [근본원인 — 하네스] 새로고침 후 재진입은 화면맞춤 줌이 아니라 이전/기본 줌을 복원해, 도면이
  // 1280px 뷰포트보다 훨씬 크게(실측 2164px) 렌더되어 동선 일부가 화면 밖으로 나갔다(hit=null).
  // 실사용자도 겪는 동일 상황이므로 F(화면 맞춤)로 맞춘 뒤 클릭한다.
  await P.evS(`__wm.MapCtrl && __wm.MapCtrl.fit && __wm.MapCtrl.fit(); 1`);
  // fit() 의 transform 전환(CSS transition)이 끝나 #routes-svg 가 뷰포트 안에 안정될 때까지 대기
  // (전환 중 질의하면 아직 확대된 중간값을 읽어 클릭 좌표가 화면 밖으로 나간다 — 실측 간헐 재현).
  await P.waitFor(`(function(){ var r=document.getElementById('routes-svg').getBoundingClientRect(); return r.width > 0 && r.width < 1300 && r.left > -50 && r.left < 1300; })()`, 6000);
  await wait(200);
  // [근본원인] 꺾인(3점) 폴리라인은 bbox 중심이 선 위에 있지 않다(대각 경로) — 실제 선 위의
  // 한 점(Routes.pointAtRatio, %좌표)을 #routes-svg 의 실제 렌더 사각형으로 환산해 클릭한다.
  const pctToScreen = (routeIdStr, t) => `(function(){
    var svg=document.getElementById('routes-svg'); var sr=svg.getBoundingClientRect();
    var r0=__wm.State.routes.find(function(r){return r.id===${JSON.stringify(routeIdStr)}});
    var p=__wm.Routes.pointAtRatio(r0.points, ${t});
    return { x: sr.left + (p.x/100)*sr.width, y: sr.top + (p.y/100)*sr.height };
  })()`;
  // [근본원인 — 하네스] fit() 의 CSS 전환(transition) 도중에 좌표를 구하면 그 사이 svg 사각형이
  // 계속 움직여 "좌표 계산"과 "클릭 디스패치"(별도 CDP 왕복) 사이에 어긋난다(간헐 재현, map-image로
  // 클릭이 샘). 좌표 계산 → dispatchEvent 를 같은 동기 실행(한 번의 evaluate) 안에서 끝내 경합을 없앤다
  // — 이벤트 핸들러는 e.clientX/clientY 만 읽으므로(MapCtrl.viewportToPercent) 데이터상 실 클릭과 동등하다.
  const d1 = await P.ev(`(function(){
    var el = document.querySelector('.route-line[data-route="${routeId}"]');
    if (!el) return { ok:false, reason:'no-el' };
    var svg = document.getElementById('routes-svg'); var sr = svg.getBoundingClientRect();
    var p = __wm.Routes.pointAtRatio(__wm.State.routes.find(function(r){return r.id===${JSON.stringify(routeId)}}).points, 0.4);
    var x = sr.left + (p.x/100)*sr.width, y = sr.top + (p.y/100)*sr.height;
    el.dispatchEvent(new MouseEvent('click', { clientX:x, clientY:y, bubbles:true, cancelable:true }));
    return { ok:true, x:x, y:y };
  })()`);
  ok(d1.ok, "D0 동선 선(.route-line) 클릭 디스패치", d1);
  const videoBarOpen = await P.waitFor(`!document.getElementById('pano-video-bar').classList.contains('hidden')`, 15000);
  ok(videoBarOpen >= 0, "D1 동선 클릭 → 재생(pano-overlay·pano-video-bar 표시)");
  const panoVisible = await P.evS(`!document.getElementById('pano-overlay').classList.contains('hidden')`);
  ok(panoVisible === true, "D1b pano-overlay 표시");

  await P.ev(`(function(){ __wm.Routes._playRatio = 0.5; __wm.Routes.render(); return 1; })()`);
  const playheadChk = await P.evS(`(function(){ var el=document.querySelector('.route-playhead'); if(!el) return null; var r0=__wm.State.routes.find(function(r){return r.id===${JSON.stringify(routeId)}}); var p=__wm.Routes.pointAtRatio(r0.points, 0.5); return { rendered:true, cx:+el.getAttribute('cx'), cy:+el.getAttribute('cy'), expectX:p.x, expectY:p.y }; })()`);
  ok(playheadChk && playheadChk.rendered && Math.abs(playheadChk.cx - playheadChk.expectX) < 0.01 && Math.abs(playheadChk.cy - playheadChk.expectY) < 0.01,
    "D2 진행률 0.5 주입 → .route-playhead 가 동선 중앙 좌표에 렌더(진행률↔위치점 일치)", playheadChk);

  /* ══ E. 동선 중간 지점 탐색(Range 206) ══
   * 🔴 [제품 결함 — 정직 기록, 이 테스트의 범위 밖(발주서는 하네스·이식만 지시)] 63_RouteDraw.js
   *   의 .route-line click 핸들러는 "PanoViewer.open && isVideo" 일 때만 좌표→비율 변환 후
   *   seekRatio() 를 부르는 분기를 갖는다(재생 중 동선 위 다른 점을 눌러 탐색하는 의도, 주석 11행).
   *   그런데 #pano-overlay 는 style.css:1537 `position:fixed;inset:0;z-index:9999;background:#000`
   *   로 전체화면 불투명 오버레이라 재생 중에는 지도/동선이 화면에 존재하되 클릭 대상에서 가려진다
   *   (CDP 실측: 동선 위 좌표를 클릭해도 elementFromPoint = #pano-canvas, .route-line 이 받지 못함).
   *   즉 이 분기는 **실제 화면 클릭으로는 영원히 도달 불가능한 죽은 코드**다(대체 진입점도 없음 —
   *   07_Radar·08_PanoNav 에 동선 미니맵 없음). 제품 수정은 발주서 범위 밖이라 보고만 하고, 여기서는
   *   같은 함수(PanoViewer.seekRatio)를 직접 호출해 "탐색→서버 Range 206" 자체의 동작은 검증한다.
   */
  console.log("\n[E] 동선 중간 지점 탐색 — 서버 Range(206) [click 분기는 도달 불가 — 함수 직접 호출로 검증]");
  // [근본원인] MediaRecorder 가 만든 webm 은 큐(seek 인덱스)가 없어, Chrome 이 재생 시작 직후
  // 메타데이터 확보를 위해 파일을 Range 로 (거의) 전부 내려받는다 — 그 뒤 seek 은 이미 버퍼된
  // 구간이라 새 네트워크 요청이 0건이다(정상 — 완전 캐시). 그래서 D 이후 누적된 응답까지 함께
  // 본다: "360 영상 스트리밍에 서버가 206 Partial Content 로 응답한다"는 사실 자체는 이렇게도
  // 증명된다(이 세션에서 실제로 206 이 나왔는지).
  const durBefore = await P.evS(`__wm.PanoViewer.videoEl ? __wm.PanoViewer.videoEl.duration : null`);
  await P.evS(`__wm.PanoViewer.seekRatio(0.75); 1`);
  await wait(400);
  const seekChk = await P.evS(`(function(){ var v=__wm.PanoViewer.videoEl; return { duration: v ? v.duration : null, currentTime: v ? v.currentTime : null }; })()`);
  ok(isFinite(durBefore) && durBefore > 0, "E0 영상 duration 획득(실 디코드 성공)", { durBefore });
  ok(seekChk.currentTime != null && seekChk.currentTime > (durBefore * 0.5), "E1 PanoViewer.seekRatio(0.75) → currentTime 이 그 지점으로 이동", seekChk);
  ok(net206.some((s) => s === 206), "E2 360 영상 스트리밍 중 서버가 Range 요청에 206 Partial Content 로 응답(누적)", { statuses: net206 });

  /* ══ F. 배포(열람 링크) — 재생 가능 · 그리기(편집) 0 ══ */
  console.log("\n[F] 열람 링크 — 재생 가능 · 편집 0");
  const pub = await api("POST", "/api/projects/" + PID + "/publish", null, sTok);
  const tok = pub.j && pub.j.project && pub.j.project.share_path ? pub.j.project.share_path.split("/").pop() : "";
  ok(pub.s === 200 && !!tok, "F0 배포 성공 — 열람 링크 토큰 발급", { s: pub.s });

  // [근본원인 — 하네스] 같은 탭에서 이어 쓰면 디자이너 로그인(wm_local_token)이 localStorage 에
  // 남아 열람 링크 진입 시에도 Auth 가 그 토큰을 세션으로 복원해 isDesigner=true 가 된다
  // (p149 는 이 오염을 피하려 아예 새 탭을 썼다 — 여기는 토큰만 지우는 가벼운 방법으로 대체).
  await P.ev(`localStorage.removeItem("wm_local_token"); 1`);
  await P.send("Page.navigate", { url: BASE + "/v/" + tok });
  const vReady = await P.waitFor(`window.__wm && __wm.State.routes && __wm.State.routes.length > 0`, 20000);
  ok(vReady >= 0, "F1 열람 링크 — 동선 데이터 로드됨(동결 스냅샷에 포함)");
  const isDesignerV = await P.evS(`__wm.Routes.isDesigner()`);
  ok(isDesignerV === false, "F2 열람 세션 — Routes.isDesigner() === false", { isDesignerV });
  const beforeDraw = await P.evS(`__wm.State.drawingRoute`);
  // [동일 실사용자 경로] [전체 기능] → '360 동영상 동선 긋기' — 열람자는 perm:"designer" 사유로
  // 비활성(aria-disabled) 표시만 되고 클릭해도 toast 만 뜨며 실행(exec)되지 않아야 한다.
  const fmBtnV = await P.ev(`(function(){ var b=document.getElementById('btn-feature-menu'); var r=b.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}; })()`);
  await click(P, fmBtnV.x, fmBtnV.y); await wait(300);
  const fmItemV = await P.evS(`(function(){ var b=document.querySelector('#feature-menu .fm-item[data-feature="route-draw"]'); if(b) b.scrollIntoView({block:'center'}); return b ? { disabled: b.getAttribute('aria-disabled')==='true', rect:(function(){var r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};})() } : null; })()`);
  ok(!!fmItemV && fmItemV.disabled === true, "F3a 열람 세션 — '360 동영상 동선 긋기' 항목이 비활성(aria-disabled, perm:designer)", fmItemV);
  if (fmItemV && fmItemV.rect) { await click(P, fmItemV.rect.x, fmItemV.rect.y); await wait(300); }
  const afterDraw = await P.evS(`__wm.State.drawingRoute`);
  ok(afterDraw === beforeDraw && afterDraw !== true, "F3b 열람 세션 — 클릭해도 그리기 모드 진입 0(편집 차단)", { beforeDraw, afterDraw });
  // [뮤테이션 증명 대상] F3 는 [전체 기능] 패널의 perm 게이트(UI.permCheck)만 지나므로, 그 패널을
  // 우회해 Routes.toggleDraw() 자체의 isDesigner() 가드를 직접 호출로 검증한다(63_RouteDraw.js
  // viewerdraw 뮤테이션은 이 가드를 지운다 — F3 만으로는 그 뮤테이션이 안 잡힌다, 실측 확인됨).
  const directDraw = await P.evS(`__wm.Routes.toggleDraw(); __wm.State.drawingRoute`);
  ok(directDraw !== true, "F3c 열람 세션 — Routes.toggleDraw() 직접 호출해도 그리기 모드 진입 0(함수 자체 가드)", { directDraw });
  await P.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await P.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  await wait(200);

  const vRouteId = await P.evS(`(function(){ var el=document.querySelector('.route-line'); return el ? el.getAttribute('data-route') : null; })()`);
  const vLineR = vRouteId ? await P.ev(pctToScreen(vRouteId, 0.5)) : null;
  if (vLineR) { await click(P, vLineR.x, vLineR.y); }
  const vPlay = await P.waitFor(`!document.getElementById('pano-video-bar').classList.contains('hidden')`, 15000);
  ok(!!vLineR && vPlay >= 0, "F4 열람 세션 — 동선 클릭 재생은 가능(읽기 전용 기능 유지)");

  ok(P.errs.length === 0, "콘솔 예외 0건", P.errs);
} catch (e) {
  console.log("FAIL 예외: " + (e && e.stack || e));
  failed++;
} finally {
  clearTimeout(watchdog);
  await cleanup();
}
console.log("\n" + (failed ? "FAIL " + failed : "ALL PASS") + " — 산출물 " + OUT);
process.exit(failed ? 1 : 0);
