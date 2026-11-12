// [WO 20261106-minimapsize] 파노라마 미니맵(레이더) "창" 크기 +/− 단계 조절 — 헤드리스 Chrome(CDP) 실측.
// public/index.html + 실제 CSS 3종 + "지금 이 순간의" public/js/modules/* 소스(p116 패턴 재사용)를
// 그대로 로드해, #pano-radar-size-in/out 클릭 → #pano-radar 박스 실제 scale() 변화·뷰포트 경계 클램프·
// localStorage 복원·핀 점(.pano-radar-pin) 개수/치수를 실 브라우저에서 검증한다.
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
const SHOT_DIR = path.join(TMP_ROOT, "p193"); // 🔴 지휘자 지시(2026-11-12) — 증거 스크린샷 경로 고정

if (!fs.existsSync(CHROME)) {
  console.log("[SKIP] Chrome 실행파일을 찾지 못함(" + CHROME + ") — CDP 실측 생략(p116 과 동일 관례)");
  process.exit(0);
}
fs.mkdirSync(SHOT_DIR, { recursive: true });

/** mutateKind: null(정상) | "clamp"(뷰포트 클램프 제거) | "dots"(점 절반 생략 복원) |
 *  "nothreshold"(가독 임계 제거 — 작아져도 번호 항상 표시) */
function buildBundle(mutateKind) {
  const manifest = fs.readFileSync(path.join(MODULES_DIR, "_manifest.txt"), "utf8").trim().split(/\r?\n/);
  return manifest.map((f) => {
    let src = fs.readFileSync(path.join(MODULES_DIR, f), "utf8");
    if (f === "07_Radar.js" && mutateKind === "clamp") {
      const needle = "const safe = this._clampSizeScale(nominal, box);";
      if (!src.includes(needle)) throw new Error("뮤테이션(clamp) 대상 문자열을 찾지 못함");
      src = src.replace(needle, "const safe = nominal; // [P193_MUTATE clamp] 클램프 제거(뷰포트 무시)");
    }
    if (f === "07_Radar.js" && mutateKind === "dots") {
      const needle = "(State.pins || []).filter(p => (p.page || 1) === page).forEach(p => {";
      if (!src.includes(needle)) throw new Error("뮤테이션(dots) 대상 문자열을 찾지 못함");
      src = src.replace(needle,
        "(State.pins || []).filter(p => (p.page || 1) === page).forEach((p, __i) => {\n" +
        "          if (__i % 2 === 1) return; // [P193_MUTATE dots] 절반 생략(옛 결함 재현)");
    }
    if (f === "07_Radar.js" && mutateKind === "nothreshold") {
      const needle = "const RADAR_PIN_NO_MIN_PX = 8;";
      if (!src.includes(needle)) throw new Error("뮤테이션(nothreshold) 대상 문자열을 찾지 못함");
      src = src.replace(needle, "const RADAR_PIN_NO_MIN_PX = 0; // [P193_MUTATE nothreshold] 가독 임계 제거(항상 표시)");
    }
    return src;
  }).join("\n");
}
function exposeForTest(bundle) {
  const idx = bundle.lastIndexOf("})();");
  if (idx === -1) return bundle;
  const inject = "\n  try { window.__T_App = App; window.__T_State = State; window.__T_Auth = Auth; window.__T_Radar = Radar; } catch (e) {}\n";
  return bundle.slice(0, idx) + inject + bundle.slice(idx);
}
function makeServeDir(bundleContent) {
  const dir = path.join(TMP_ROOT, "p193-serve-" + Date.now() + "-" + Math.random().toString(36).slice(2));
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

/** 핀 5개(page 1) 픽셀 셋업 + map-image 를 보이게 하고 Radar.update(핀[0]) 로 미니맵을 띄운다. */
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
    var map = document.getElementById('map-image');
    map.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    map.classList.remove('hidden');
    var pins = [];
    for (var i = 0; i < 5; i++) {
      pins.push({ id: 'pin' + i, page: 1, x: 10 + i * 15, y: 10 + i * 12, label: 'P' + i });
    }
    window.__T_State.pins = pins;
    window.__T_State.pdfPage = 1;
    window.__T_State.zones = [];
    var ov = document.getElementById('pano-overlay');
    ov.classList.remove('hidden');
    window.__T_Radar.update(pins[0]);
    return 'ok';
  })();
`;

const READ_JS = `JSON.stringify({
  box: (function(){ var r = document.getElementById('pano-radar').getBoundingClientRect(); return { left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height }; })(),
  transform: document.getElementById('pano-radar').style.transform,
  sinDisabled: document.getElementById('pano-radar-size-in').disabled,
  soutDisabled: document.getElementById('pano-radar-size-out').disabled,
  dotCount: document.querySelectorAll('.pano-radar-pin').length,
  dotWidth: (function(){ var d = document.querySelector('.pano-radar-pin:not(.current)'); return d ? parseFloat(getComputedStyle(d).width) : null; })(),
  noFontSize: (function(){ var n = document.querySelector('.pano-radar-pin-no'); return n ? parseFloat(getComputedStyle(n).fontSize) : null; })(),
  noHiddenClass: document.getElementById('pano-radar').classList.contains('pano-radar-no-hidden'),
  noActuallyHidden: (function(){ var n = document.querySelector('.pano-radar-pin-no'); return n ? (getComputedStyle(n).display === 'none') : null; })(),
  innerWidth: window.innerWidth, innerHeight: window.innerHeight,
  step: localStorage.getItem('wm-radar-size-step')
})`;

/** [마스터 결정 2026-11-12] 구역(zone)이 페이지 대부분을 덮어 자동 프레이밍 배율이 1에 가까워지는
 *  "줌아웃" 픽스처 — 10핀, 번호 가독 임계(8px) 경계를 창 크기(+/−)·콘텐츠 줌(+/−) 조합으로 넘나든다. */
const ZOOMOUT_SETUP_JS = `
  (function(){
    document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
    document.getElementById('screen-app').classList.add('active');
    document.body.classList.remove('role-viewer');
    document.body.classList.add('role-designer');
    var gate = document.getElementById('login-gate');
    if (gate) { gate.classList.remove('on'); gate.classList.add('hidden'); }
    window.__T_State.mode = 'designer';
    window.__T_Auth.isDesigner = true;
    var map = document.getElementById('map-image');
    map.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    map.classList.remove('hidden');
    var pins = [];
    for (var i = 0; i < 10; i++) {
      pins.push({ id: 'z' + i, page: 1, x: 5 + i * 9, y: 5 + i * 8, label: 'Z' + i });
    }
    window.__T_State.pins = pins;
    window.__T_State.pdfPage = 1;
    window.__T_State.zones = [{ id: 'zn', page: 1, x: 2, y: 2, w: 92, h: 92, pinIds: ['z0'] }];
    var ov = document.getElementById('pano-overlay');
    ov.classList.remove('hidden');
    window.__T_Radar.update(pins[0]);
    return 'ok';
  })();
`;
function clickContentZoomIn(ws) {
  return send(ws, "Runtime.evaluate", { expression: "document.getElementById('pano-radar-zoom-in').click(); 'ok'" });
}

async function withChrome(bundle, width, height, fn) {
  const overlayDir = makeServeDir(exposeForTest(bundle));
  const server = await serveStatic(overlayDir);
  const sitePort = server.address().port;
  const profileDir = path.join(TMP_ROOT, "cdp-p193-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    `--window-size=${width},${height}`,
    "about:blank",
  ], { stdio: "ignore" });
  try {
    await wait(800);
    const port = await readDevToolsPort(profileDir);
    const wsUrl = await getWsUrl(port);
    const ws = new WebSocket(wsUrl);
    await new Promise((r) => ws.on("open", r));
    await send(ws, "Page.enable");
    await send(ws, "Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 500 });
    const loadFired = new Promise((resolve) => {
      const h = (raw) => { const msg = JSON.parse(raw); if (msg.method === "Page.loadEventFired") { ws.removeListener("message", h); resolve(); } };
      ws.on("message", h);
    });
    await send(ws, "Page.navigate", { url: `http://127.0.0.1:${sitePort}/index.html` });
    await loadFired;
    await wait(400);
    return await fn(ws);
  } finally {
    try { chrome.kill(); } catch (e) {}
    server.close();
  }
}
function evalJSON(ws, expr) {
  return send(ws, "Runtime.evaluate", { expression: expr, returnByValue: true }).then((r) => JSON.parse(r.result.value));
}
function clickSizeIn(ws) {
  return send(ws, "Runtime.evaluate", { expression: "document.getElementById('pano-radar-size-in').click(); 'ok'", returnByValue: true });
}
function clickSizeOut(ws) {
  return send(ws, "Runtime.evaluate", { expression: "document.getElementById('pano-radar-size-out').click(); 'ok'", returnByValue: true });
}

async function run() {
  let failed = 0;
  const ok = (cond, label, detail) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (detail ? " :: " + detail : "")); if (!cond) failed++; };

  const bundle = buildBundle(null);

  // ── A. 데스크톱 1280px — 기본 step=1(변화 없음) → + 2회 → 폭 단조 증가 → 최대에서 비활성 ──
  await withChrome(bundle, 1280, 900, async (ws) => {
    const setupRes = await send(ws, "Runtime.evaluate", { expression: SETUP_JS, returnByValue: true });
    ok(setupRes.result && setupRes.result.value === "ok", "A0 셋업 성공(미니맵 렌더)");
    const r0 = await evalJSON(ws, READ_JS);
    ok(r0.transform === "" || r0.transform === "none", "A1 기본 step=1 → transform 미적용(회귀 0)", r0.transform);
    ok(r0.dotCount === 5, "A2 점(.pano-radar-pin) 5개 = 전체 핀 수", String(r0.dotCount));
    ok(r0.dotWidth >= 9.5, "A3 점 지름 ≥9.5px(기존 8px보다 넓음)", String(r0.dotWidth));
    // [마스터 결정 2026-11-12] 번호 폰트는 5px로 내리지 않고 6px(기존값) 유지 — 대신 실화면이
    // 작아지면 가독임계(§F)로 "숨김" 처리한다. 이 기본 픽스처(핀이 근접, 자동확대 ≈2.78x)는
    // 실화면 6*2.78≈16.7px로 임계(8px) 상회 → 번호가 보여야 정상.
    ok(r0.noFontSize === 6, "A4 번호 저작 글자크기 = 6px(5px로 축소하지 않음)", String(r0.noFontSize));
    ok(r0.noHiddenClass === false && r0.noActuallyHidden === false, "A4b 기본(근접 핀, 고배율) 상태 → 번호 표시(숨김 아님)", JSON.stringify({ hiddenClass: r0.noHiddenClass, actuallyHidden: r0.noActuallyHidden }));

    await clickSizeIn(ws); await wait(80);
    const r1 = await evalJSON(ws, READ_JS);
    ok(r1.box.width > r0.box.width, "A5 + 1회 → 박스 폭 증가", r0.box.width + " → " + r1.box.width);

    await clickSizeIn(ws); await wait(80);
    const r2 = await evalJSON(ws, READ_JS);
    ok(r2.box.width > r1.box.width, "A6 + 2회 → 폭 추가 증가(단조)", r1.box.width + " → " + r2.box.width);

    await clickSizeIn(ws); await wait(80);
    const r3 = await evalJSON(ws, READ_JS);
    ok(r3.sinDisabled === true, "A7 최대 step 도달 → [+] 비활성", JSON.stringify(r3.sinDisabled));
    ok(r3.soutDisabled === false, "A8 최대 step에서 [−]는 여전히 활성", JSON.stringify(r3.soutDisabled));
    ok(r3.box.top > -0.5, "A8b 최대 step에서도 패널 상단이 화면 안(top≥0, 클램프 — D1 뮤테이션과 대조)", String(r3.box.top));
    const shotMax = await send(ws, "Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOT_DIR, "desktop-1280-size-max.png"), Buffer.from(shotMax.data, "base64"));

    await clickSizeOut(ws); await clickSizeOut(ws); await clickSizeOut(ws); await clickSizeOut(ws); await wait(80);
    const r4 = await evalJSON(ws, READ_JS);
    ok(r4.soutDisabled === true, "A9 최소 step 도달 → [−] 비활성", JSON.stringify(r4.soutDisabled));
    ok(r4.box.width < r0.box.width, "A10 최소 step 폭 < 기본값(0.8x 축소 확인)", r0.box.width + " → " + r4.box.width);

    // 복원 확인용 localStorage 값 세팅 — step 0(최소)에서 +3회 → 0→1→2→3(최대)
    await clickSizeIn(ws); await clickSizeIn(ws); await clickSizeIn(ws); await wait(80);
    const r5 = await evalJSON(ws, READ_JS);
    ok(r5.step === "3", "A11 클릭 후 localStorage(wm-radar-size-step)=3 저장", String(r5.step));
  });

  // ── B. 새로고침(재내비게이트) 후 저장된 step 복원 ──
  await withChrome(bundle, 1280, 900, async (ws) => {
    // localStorage는 오리진(포트)별 — 같은 withChrome 호출 안에서만 공유. 같은 세션에서 재현.
    await send(ws, "Runtime.evaluate", { expression: SETUP_JS, returnByValue: true });
    await clickSizeIn(ws); await clickSizeIn(ws); await wait(80); // step 1→3(최대)
    const before = await evalJSON(ws, READ_JS);
    // 페이지 재내비게이트(새로고침과 동등 — localStorage 유지)
    const loadFired2 = new Promise((resolve) => {
      const h = (raw) => { const msg = JSON.parse(raw); if (msg.method === "Page.loadEventFired") { ws.removeListener("message", h); resolve(); } };
      ws.on("message", h);
    });
    const url = await send(ws, "Runtime.evaluate", { expression: "location.href", returnByValue: true });
    await send(ws, "Page.navigate", { url: url.result.value });
    await loadFired2;
    await wait(300);
    await send(ws, "Runtime.evaluate", { expression: SETUP_JS, returnByValue: true });
    await wait(80);
    const after = await evalJSON(ws, READ_JS);
    ok(after.step === before.step, "B1 새로고침 후 step 복원(localStorage)", before.step + " == " + after.step);
    ok(after.box.width === before.box.width, "B2 새로고침 후 박스 실측 폭도 동일(복원이 실제 렌더에 반영)", before.box.width + " == " + after.box.width);
  });

  // ── C. 모바일 375×812 — 최대 step까지 올려도 박스가 뷰포트를 넘지 않음(클램프) ──
  await withChrome(bundle, 375, 812, async (ws) => {
    await send(ws, "Runtime.evaluate", { expression: SETUP_JS, returnByValue: true });
    await clickSizeIn(ws); await clickSizeIn(ws); await clickSizeIn(ws); await wait(80); // step → 3(최대)
    const r = await evalJSON(ws, READ_JS);
    ok(r.box.right <= r.innerWidth + 0.5, "C1 모바일 최대 step에서도 우측이 뷰포트 안(클램프)", r.box.right + " <= " + r.innerWidth);
    ok(r.box.top >= -0.5, "C2 모바일 최대 step에서도 상단이 화면 안(클램프)", String(r.box.top));
    ok(r.dotCount === 5, "C3 모바일에서도 점 5개 전부 표시(생략 0)", String(r.dotCount));
    const shotMobile = await send(ws, "Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOT_DIR, "mobile-375-size-max-clamped.png"), Buffer.from(shotMobile.data, "base64"));
  });

  // ── D. 뮤테이션 1: 클램프 제거 → 데스크톱에서도 패널이 화면 위(top<0)로 넘침(결함 재현).
  //    1280×900 기준 실측: 정상 코드는 maxByH(≈1.41)가 nominal(1.55)보다 작아 높이 쪽이 먼저
  //    막는다(§ _clampSizeScale 주석) — 폭이 아니라 "위로" 넘치는 경로라 top을 본다. ──
  const mutClampBundle = buildBundle("clamp");
  await withChrome(mutClampBundle, 1280, 900, async (ws) => {
    await send(ws, "Runtime.evaluate", { expression: SETUP_JS, returnByValue: true });
    await clickSizeIn(ws); await clickSizeIn(ws); await clickSizeIn(ws); await wait(80);
    const r = await evalJSON(ws, READ_JS);
    ok(r.box.top < -0.5, "D1 뮤테이션(클램프 제거) → 패널 상단이 화면 밖(top<0, 결함 재현, 정상코드에선 A6/A7 경로의 클램프가 막음)", String(r.box.top));
  });

  // ── E. 뮤테이션 2: 점 절반 생략 복원 → dotCount가 전체 핀 수보다 적어짐(결함 재현) ──
  const mutDotsBundle = buildBundle("dots");
  await withChrome(mutDotsBundle, 1280, 900, async (ws) => {
    await send(ws, "Runtime.evaluate", { expression: SETUP_JS, returnByValue: true });
    await wait(80);
    const r = await evalJSON(ws, READ_JS);
    ok(r.dotCount < 5, "E1 뮤테이션(점 절반 생략) → dotCount < 5(결함 재현, 정상코드에선 A2가 막음)", String(r.dotCount));
  });

  // ── F. 마스터 결정(2026-11-12) — 번호 가독 임계(8px): 작으면 번호만 숨김, 점은 항상 유지 ──
  await withChrome(bundle, 1280, 900, async (ws) => {
    await send(ws, "Runtime.evaluate", { expression: ZOOMOUT_SETUP_JS, returnByValue: true });
    await wait(150);
    const f0 = await evalJSON(ws, READ_JS);
    ok(f0.noHiddenClass === true && f0.noActuallyHidden === true, "F1 줌아웃(구역 bbox 기준 ≈1배)+기본 창크기 → 번호 숨김(임계 미만)", JSON.stringify(f0.noHiddenClass));
    ok(f0.dotCount === 10, "F2 번호 숨김 상태에서도 점(.pano-radar-pin) 10개 = 전체 핀 수(생략 0)", String(f0.dotCount));
    const shotHidden = await send(ws, "Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOT_DIR, "desktop-1280-number-hidden.png"), Buffer.from(shotHidden.data, "base64"));

    await clickSizeOut(ws); await clickSizeOut(ws); await clickSizeOut(ws); await wait(100);
    const f1 = await evalJSON(ws, READ_JS);
    ok(f1.noHiddenClass === true, "F3 최소 창크기(0.8x)로 더 줄여도 여전히 숨김(더 작아짐, 안 보임 유지)", JSON.stringify(f1.noHiddenClass));
    ok(f1.dotCount === 10, "F4 최소 창크기에서도 점 10개 유지", String(f1.dotCount));

    await clickSizeIn(ws); await clickSizeIn(ws); await clickSizeIn(ws); await wait(100); // 최대 창크기
    const f2 = await evalJSON(ws, READ_JS);
    ok(f2.noHiddenClass === true, "F5 최대 창크기(클램프 ≈1.23x)만으로는 아직 임계 미달 → 숨김 유지", JSON.stringify(f2.noHiddenClass));

    await clickContentZoomIn(ws); await clickContentZoomIn(ws); await wait(100); // 콘텐츠 줌 추가
    const f3 = await evalJSON(ws, READ_JS);
    ok(f3.noHiddenClass === false && f3.noActuallyHidden === false, "F6 창크기+콘텐츠줌 조합으로 임계 초과 → 번호 다시 표시(히스테리시스 상단 통과)", JSON.stringify(f3.noHiddenClass));
    ok(f3.dotCount === 10, "F7 번호 재표시 후에도 점 10개 그대로", String(f3.dotCount));
    const shotShown = await send(ws, "Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOT_DIR, "desktop-1280-number-shown.png"), Buffer.from(shotShown.data, "base64"));
  });

  // ── G. 뮤테이션 3: 가독 임계 제거(RADAR_PIN_NO_MIN_PX=0) → 줌아웃 상태에서도 번호가 표시됨(결함 재현) ──
  const mutNoThresholdBundle = buildBundle("nothreshold");
  await withChrome(mutNoThresholdBundle, 1280, 900, async (ws) => {
    await send(ws, "Runtime.evaluate", { expression: ZOOMOUT_SETUP_JS, returnByValue: true });
    await wait(150);
    const r = await evalJSON(ws, READ_JS);
    ok(r.noActuallyHidden === false, "G1 뮤테이션(임계 제거) → 작은 상태에서도 번호가 표시됨(결함 재현, 정상코드에선 F1이 막음)", JSON.stringify(r.noActuallyHidden));
    ok(r.dotCount === 10, "G2 (참고) 이 뮤테이션은 점 개수에는 영향 없음", String(r.dotCount));
  });

  console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED") + " — 스크린샷/산출물: " + SHOT_DIR);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error("ERROR", e); process.exit(1); });
