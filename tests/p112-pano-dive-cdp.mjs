// [WO 2026-10-01] "사진으로 빨려 들어가는" 전환 효과(PanoViewer.Dive) — 헤드리스 Chrome(CDP) 실측.
// public/index.html + 실제 CSS 3종 + "지금 이 순간의" public/js/modules/* 소스(p86 패턴 재사용)를
// 그대로 로드해, 핀 탭 1회로 트리거되는 전환 애니메이션의 중간 프레임 3장을 .tmp/fixdive/ 에 저장한다.
// (①도면 줌인 ②원형 개방 ③화각 펼침 — 실제 THREE/360 사진 파이프라인까지는 재현하지 않고,
//  PanoViewer.Dive.open()이 조작하는 #map-viewport/#pano-overlay 의 실제 CSS 전환만 캡처한다.)
// 뮤테이션 1건: Dive.open()의 clip-path 개방(_setClip 150%)을 지우면 ②③ 프레임에서 원형이
// 끝까지 안 열려야 한다 — 열려버리면(=차이 없으면) 비교가 실효성이 없다는 뜻이므로 실패 처리한다.
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
const TMP_ROOT = path.join(__dirname, "..", ".tmp"); // 🔴 CLAUDE.md §G-5 — 프로젝트 안 .tmp 고정(process.env.TEMP 금지)
const SHOT_DIR = path.join(TMP_ROOT, "fixdive");

if (!fs.existsSync(CHROME)) {
  console.log("[SKIP] Chrome 실행파일을 찾지 못함(" + CHROME + ") — CDP 실측 생략(p86-cdp-real.mjs 와 동일 관례)");
  process.exit(0);
}
fs.mkdirSync(SHOT_DIR, { recursive: true });

function buildBundle(panoSrc) {
  const manifest = fs.readFileSync(path.join(MODULES_DIR, "_manifest.txt"), "utf8").trim().split(/\r?\n/);
  return manifest.map((f) => {
    if (f === "06_PanoViewer.js") return panoSrc;
    return fs.readFileSync(path.join(MODULES_DIR, f), "utf8");
  }).join("\n");
}
// 스크린샷용 "슬로모션" — 헤드리스 CDP IPC 왕복(실측 40~270ms 변동)이 800ms 총 길이 애니메이션의
// 체크포인트 타이밍을 집어삼켜서 정상 소스로도 ③프레임이 리셋 이후로 밀리는 문제가 있었다(실측).
// 로직은 그대로 두고 시간 상수만 10배 늘려 같은 선택을 훨씬 더 넓은 시간창에서 캡처한다(코드 동일성 유지).
const SLOW_FACTOR = 10;
const MS_KEYS = ["ZOOM_MS", "OPEN_DELAY_MS", "OPEN_MS", "FOV_DELAY_MS", "FOV_MS", "TOTAL_MS", "CLOSE_FOV_MS", "CLOSE_OPEN_MS", "CLOSE_ZOOM_MS", "REDUCED_FADE_MS"];
function slowDown(src, factor) {
  let out = src;
  for (const key of MS_KEYS) {
    const re = new RegExp("(" + key + ":\\s*)(\\d+)(,)");
    out = out.replace(re, (m, pre, num, post) => pre + (Number(num) * factor) + post);
  }
  return out;
}
/** 번들 전체가 99_footer.js의 IIFE(`(function(){...})();`) 안에 있어 PanoViewer/App이 전역이 아니다.
 *  테스트 전용으로 닫는 괄호 직전에 window 노출 1줄을 끼워 CDP Runtime.evaluate가 접근할 수 있게 한다
 *  (실 파일은 건드리지 않음 — 이 함수가 메모리에서 조립한 문자열에만 적용). */
function exposeForTest(bundle) {
  const idx = bundle.lastIndexOf("})();");
  if (idx === -1) return bundle;
  const inject = "\n  try { window.__T_PanoViewer = PanoViewer; window.__T_App = App; } catch (e) {}\n";
  return bundle.slice(0, idx) + inject + bundle.slice(idx);
}
function makeServeDir(bundleContent) {
  const dir = path.join(TMP_ROOT, "p100-serve-" + Date.now() + "-" + Math.random().toString(36).slice(2));
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

// p86-cdp-real.mjs EDITOR_SETUP_JS 재사용(화면 전환 산식 SoT — 재발명 금지)
const EDITOR_SETUP_JS = `
  (function(){
    document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
    document.getElementById('screen-app').classList.add('active');
    document.body.classList.remove('role-viewer');
    document.body.classList.add('role-designer');
    document.getElementById('map-viewport').classList.remove('hidden');
    var gate = document.getElementById('login-gate');
    if (gate) { gate.classList.remove('on'); gate.classList.add('hidden'); }
    // 다이빙 대상 핀 마커 1개를 실측 가능한 위치(300,220)에 둠
    var pins = document.getElementById('pins-layer') || (function(){
      var d = document.createElement('div'); d.id='pins-layer'; d.style.cssText='position:absolute;inset:0;';
      document.getElementById('map-viewport').appendChild(d); return d;
    })();
    var m = document.createElement('div');
    m.className = 'pin-marker'; m.dataset.id = 't1';
    m.style.cssText = 'position:absolute;left:300px;top:220px;width:12px;height:12px;';
    pins.appendChild(m);
    return 'ok';
  })();
`;

async function captureFrames(label, panoSrcOverride) {
  const baseSrc = panoSrcOverride != null ? panoSrcOverride : fs.readFileSync(path.join(MODULES_DIR, "06_PanoViewer.js"), "utf8");
  const bundle = exposeForTest(buildBundle(slowDown(baseSrc, SLOW_FACTOR)));
  const overlayDir = makeServeDir(bundle);
  const server = await serveStatic(overlayDir);
  const sitePort = server.address().port;
  const profileDir = path.join(TMP_ROOT, "cdp-p100-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--window-size=1024,768",
    "about:blank",
  ], { stdio: "ignore" });
  const shots = {};
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
    await wait(500);
    await send(ws, "Runtime.evaluate", { expression: EDITOR_SETUP_JS, awaitPromise: false });
    await wait(150);
    // 핀 탭 트리거 — 페이지 안에서 시작시각(__diveStart)도 함께 기록(IPC 왕복 지연과 무관하게
    // "실제 경과시간"으로 체크포인트를 잡기 위함 — 왕복 지연만으로 wait(ms)를 예측하면 오차가 크다).
    // ③ 화각 펼침은 실제로는 load()/loadVideo()의 텍스처 로드 완료가 트리거한다. 이 하네스는
    // 실제 360 이미지 파이프라인을 재현하지 않으므로, markLoadStart+onTextureReady를 직접 호출해
    // 같은 연출(S.fov: FOV_NARROW→기본값)을 재현한다(로직은 06_PanoViewer.js 그대로 재사용).
    const openCheck = await send(ws, "Runtime.evaluate", {
      expression: "(function(){ var PV = window.__T_PanoViewer; window.__diveStart = Date.now(); PV.Dive.open(PV, {id:'t1'}); PV.Dive.markLoadStart(PV); PV.Dive.onTextureReady(PV); return 'ok'; })();",
      returnByValue: true,
    });
    if (openCheck.result && openCheck.result.subtype === "error") throw new Error("Dive.open 실행 실패: " + JSON.stringify(openCheck.result));

    const stateExpr = "JSON.stringify({elapsed: Date.now()-window.__diveStart, clip: getComputedStyle(document.getElementById('pano-overlay')).clipPath, clipStyle: document.getElementById('pano-overlay').style.clipPath, mapT: getComputedStyle(document.getElementById('map-viewport')).transform, fov: (window.__T_PanoViewer.S&&window.__T_PanoViewer.S.fov)||null})";
    /** 페이지 안 실제 경과시간(Date.now()-__diveStart) 기준 targetMs 시점까지 1회 대기한 뒤
     *  그 순간의 스크린샷+상태를 캡처한다. IPC 왕복(평균 ~40ms로 실측)을 선반영해 오버슈트를 줄인다. */
    const RTT_MARGIN_MS = 40;
    async function captureAt(targetMs, name) {
      const r0 = await send(ws, "Runtime.evaluate", { expression: "Date.now()-window.__diveStart", returnByValue: true });
      const remain = targetMs - r0.result.value - RTT_MARGIN_MS;
      if (remain > 0) await wait(remain);
      const r = await send(ws, "Runtime.evaluate", { expression: stateExpr, returnByValue: true });
      const state = JSON.parse(r.result.value);
      const shot = await send(ws, "Page.captureScreenshot", { format: "png" });
      const file = path.join(SHOT_DIR, label + "-" + name + "-t" + targetMs + "ms(actual" + state.elapsed + "ms).png");
      fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
      shots[name] = file;
      shots[name + "_state"] = JSON.stringify(state);
      return state;
    }
    // 10배 슬로모션(SLOW_FACTOR) 기준 체크포인트 — ① 줌인 중간(0~3500ms) ② 원형 개방 중간(2500~6000ms)
    // ③ 화각 구간(3000~8000ms, TOTAL=8000 리셋 전)
    await captureAt(1200, "frame1-zoomin");
    await captureAt(2800, "frame2-circleopen"); // OPEN_DELAY(2500)+300 — 막 열리기 시작한 작은 원(시각적으로 또렷)
    await captureAt(7000, "frame3-fov");
    ws.close();
  } finally {
    chrome.kill();
    server.close();
  }
  return shots;
}

(async () => {
  console.log("[CDP] 정상 소스 — 3프레임 캡처");
  const normal = await captureFrames("normal", null);
  for (const k of Object.keys(normal)) if (!k.endsWith("_state")) console.log("  saved: " + normal[k]);
  console.log("  frame1(줌인) state:", normal["frame1-zoomin_state"]);
  console.log("  frame2(원형개방) state:", normal["frame2-circleopen_state"]);
  console.log("  frame3(화각) state:", normal["frame3-fov_state"]);
  const f3 = JSON.parse(normal["frame3-fov_state"]);

  // 뮤테이션: 원형 개방(150% 설정)을 지우면 중후반 프레임에서도 clip-path(인라인 style, 실제 목표값)가
  // 150%로 열리지 않아야 한다. getComputedStyle(clip)은 Chrome이 %를 px로 환산해 반환하므로
  // 비교 기준은 우리가 직접 세팅하는 인라인 clipStyle("circle(150% ...)" 리터럴)을 쓴다.
  const pvSrc = fs.readFileSync(path.join(MODULES_DIR, "06_PanoViewer.js"), "utf8");
  const needle = `const go = () => this._setClip(pos, 150);`;
  const mutated = pvSrc.replace(needle, `const go = () => {};`);
  let mutFail = 0;
  if (mutated === pvSrc) {
    console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); mutFail = 1;
  } else {
    console.log("\n[CDP][뮤테이션] 원형 개방 호출 제거 — 원형개방 프레임에서도 clip-path가 열리지 않아야 함");
    const mutShots = await captureFrames("mutated", mutated);
    const mf2 = JSON.parse(mutShots["frame2-circleopen_state"]);
    console.log("  frame2(뮤테이션) state:", mutShots["frame2-circleopen_state"]);
    const normalOpened = /circle\(150%/.test(f3.clipStyle || "");
    const mutatedStillClosed = /circle\(0%/.test(mf2.clipStyle || "") && !/circle\(150%/.test(mf2.clipStyle || "");
    if (!normalOpened) { console.log("  FAIL 정상 소스에서도 원형이 150%까지 열리지 않음(캡처 타이밍/배선 재확인 필요)"); mutFail = 1; }
    else if (!mutatedStillClosed) { console.log("  FAIL 뮤테이션 적용에도 원형이 열려버림(테스트가 실효성 없음)"); mutFail = 1; }
    else console.log("  PASS 뮤테이션 적용 시 원형이 끝까지 닫혀 있음(테스트가 실효성 있음을 증명)");
  }

  console.log("\n" + (mutFail ? "FAILED" : "ALL PASS") + " — 스크린샷: " + SHOT_DIR);
  process.exit(mutFail ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
