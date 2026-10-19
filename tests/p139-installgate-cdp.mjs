// [WO 20261009-installgate] 모바일 강제 설치 게이트 회귀 테스트(실 Chrome CDP, 375 모바일 에뮬레이션).
// public/js/modules/38_Install.js + 38b_InstallGate.js 를 실제 브라우저에서 구동(p131 패턴 재사용).
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
const INSTALL_FILE = path.join(REPO_ROOT, "public", "js", "modules", "38_Install.js");
const GATE_FILE = path.join(REPO_ROOT, "public", "js", "modules", "38b_InstallGate.js");
const TMP_ROOT = path.join(REPO_ROOT, ".tmp"); // 🔴 CLAUDE.md §G-5
const SHOT_DIR = path.join(TMP_ROOT, "fixinstallgate");
const HARNESS = path.join(SHOT_DIR, "harness.html");

if (!fs.existsSync(CHROME)) {
  console.log("[SKIP] Chrome 실행파일을 찾지 못함(" + CHROME + ") — CDP 실측 생략(p131 관례와 동일)");
  process.exit(0);
}
fs.mkdirSync(SHOT_DIR, { recursive: true });

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 두 모듈을 그대로 로드 + Auth/AdminPanels 최소 스텁 + matchMedia/UA 오버라이드(쿼리로 제어).
const HARNESS_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body>
  <div id="outside-app" style="padding:40px;">바깥 앱 화면(게이트 아래)</div>
  <script>
    var qs = new URLSearchParams(location.search);
    window.__scn = {
      mobile: qs.get('mobile') !== '0',          // 기본 모바일
      ios: qs.get('ios') === '1',
      standalone: qs.get('standalone') === '1',
      loggedIn: qs.get('loggedin') !== '0',       // 기본 로그인됨
      viewLink: qs.get('viewlink') === '1',
      readonly: qs.get('readonly') === '1',       // 서버 판정 열람전용(통행증) 세션
      flagOn: qs.get('flagoff') !== '1'           // 기본 플래그 ON
    };
    var realMM = window.matchMedia.bind(window);
    window.matchMedia = function (q) {
      if (q.indexOf('display-mode: standalone') >= 0) return { matches: window.__scn.standalone };
      if (q.indexOf('pointer: coarse') >= 0) return { matches: window.__scn.mobile };
      if (q.indexOf('max-width: 760px') >= 0) return { matches: window.__scn.mobile };
      return realMM(q);
    };
    if (window.__scn.ios) {
      try { Object.defineProperty(window.navigator, 'userAgent', { value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15', configurable: true }); } catch (e) {}
    }
    window.Auth = {
      user: window.__scn.loggedIn ? { email: 'designer@test.com' } : null,
      readonly: window.__scn.readonly,
      _isViewLink: function () { return window.__scn.viewLink; }
    };
    window.AdminPanels = { isEnabled: function (k) { return k === 'install-required' ? window.__scn.flagOn : true; } };
    window.__promptCalled = false;
    window.__fireBeforeInstallPrompt = function () {
      var ev = new Event('beforeinstallprompt', { cancelable: true });
      ev.prompt = function () { window.__promptCalled = true; return Promise.resolve(); };
      ev.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(ev);
    };
    window.__fireAppInstalled = function () { window.dispatchEvent(new Event('appinstalled')); };
  </script>
  <script src="/38_Install.js"></script>
  <script src="/38b_InstallGate.js"></script>
  <script>Install.init(); InstallGate.init();</script>
</body></html>`;

function serveStatic(installSrc, gateSrc) {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/38_Install.js") { res.writeHead(200, { "Content-Type": "application/javascript" }); res.end(installSrc); return; }
    if (p === "/38b_InstallGate.js") { res.writeHead(200, { "Content-Type": "application/javascript" }); res.end(gateSrc); return; }
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

async function withPage(sitePort, urlPath, fn, viewport) {
  const vw = (viewport && viewport.width) || 375, vh = (viewport && viewport.height) || 812;
  const profileDir = path.join(TMP_ROOT, "cdp-p139-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, `--window-size=${vw},${vh}`, "about:blank"], { stdio: "ignore" });
  try {
    await wait(800);
    const port = await readDevToolsPort(profileDir);
    const wsUrl = await getWsUrl(port);
    const ws = new WebSocket(wsUrl);
    await new Promise((r) => ws.on("open", r));
    await send(ws, "Page.enable");
    await send(ws, "Emulation.setDeviceMetricsOverride", { width: vw, height: vh, deviceScaleFactor: 2, mobile: true });
    const navigate = async (p) => {
      const loadFired = new Promise((resolve) => { const h = (raw) => { const msg = JSON.parse(raw); if (msg.method === "Page.loadEventFired") { ws.removeListener("message", h); resolve(); } }; ws.on("message", h); });
      await send(ws, "Page.navigate", { url: `http://127.0.0.1:${sitePort}${p}` });
      await loadFired;
      await wait(200);
    };
    await navigate(urlPath);
    const result = await fn(ws, navigate);
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
  gateHidden: document.getElementById('install-gate').classList.contains('hidden'),
  outsideInert: document.getElementById('outside-app').hasAttribute('inert'),
  bodyOverflow: document.body.style.overflow,
  btnHidden: document.getElementById('install-gate-btn').classList.contains('hidden'),
  btnDisabled: document.getElementById('install-gate-btn').disabled,
  btnText: document.getElementById('install-gate-btn').textContent,
  iosHidden: document.getElementById('install-gate-ios').classList.contains('hidden'),
  guideHidden: document.getElementById('install-gate-guide').classList.contains('hidden'),
  guideText: document.getElementById('install-gate-guide').textContent,
  doneHidden: document.getElementById('install-gate-done').classList.contains('hidden'),
  continueExists: !!document.getElementById('install-gate-continue'),
  continueHidden: (function(){var b=document.getElementById('install-gate-continue'); return !b || b.classList.contains('hidden');})(),
  continueBtnHeight: (function(){var b=document.getElementById('install-gate-continue'); return b ? b.getBoundingClientRect().height : 0;})(),
  bannerHidden: (function(){var b=document.getElementById('install-gate-banner'); return !b || b.classList.contains('hidden');})()
})`;

async function run(installSrc, gateSrc) {
  const server = await serveStatic(installSrc, gateSrc);
  const port = server.address().port;
  const results = {};
  try {
    // S1: 모바일 + 로그인 + 브라우저탭(standalone 아님) → 게이트 표시 + 바깥 inert + 스크롤 잠금
    results.s1 = await withPage(port, "/harness.html", async (ws) => {
      const st = JSON.parse(await evalJson(ws, STATE_EXPR));
      await shot(ws, "s1-mobile-login-gated");
      // 바깥 영역 클릭이 실제로 씹히는지(hit-test) — inert면 클릭 리스너가 안 붙어도 pointer-events가 none이 됨
      const clickThrough = await evalJson(ws, "(function(){var el=document.elementFromPoint(50,50); return el && el.id;})()");
      return { st, clickThrough };
    });

    // S2: standalone=1 → 게이트 없음(요구 6)
    results.s2 = await withPage(port, "/harness.html?standalone=1", async (ws) => {
      const st = JSON.parse(await evalJson(ws, STATE_EXPR));
      await shot(ws, "s2-standalone-nogate");
      return st;
    });

    // S3: ?viewlink=1 + loggedin=0(비로그인 열람자) → 게이트 없음(요구 1 예외)
    results.s3 = await withPage(port, "/harness.html?viewlink=1&loggedin=0", async (ws) => {
      const st = JSON.parse(await evalJson(ws, STATE_EXPR));
      await shot(ws, "s3-sharelink-nogate");
      return st;
    });

    // S3b: 보안 — 로그인했는데 ?viewlink=1 도 같이 왔다 → 그래도 게이트(우회 금지, 설계 메모 참조)
    results.s3b = await withPage(port, "/harness.html?viewlink=1&loggedin=1", async (ws) => {
      const st = JSON.parse(await evalJson(ws, STATE_EXPR));
      return st;
    });

    // S3c: 열람 링크 통행증 세션 — /api/auth/me 가 user 를 채우고 readonly=true → 게이트 없음
    results.s3c = await withPage(port, "/harness.html?viewlink=1&loggedin=1&readonly=1", async (ws) => {
      const st = JSON.parse(await evalJson(ws, STATE_EXPR));
      await shot(ws, "s3c-readonly-link-nogate");
      return st;
    });

    // S4: PC(mobile=0) → 게이트 없음
    results.s4 = await withPage(port, "/harness.html?mobile=0", async (ws) => {
      const st = JSON.parse(await evalJson(ws, STATE_EXPR));
      await shot(ws, "s4-pc-nogate");
      return st;
    });

    // S5: 기능 플래그 OFF → 게이트 없음
    results.s5 = await withPage(port, "/harness.html?flagoff=1", async (ws) => {
      const st = JSON.parse(await evalJson(ws, STATE_EXPR));
      await shot(ws, "s5-flagoff-nogate");
      return st;
    });

    // S6: 뒤로가기/새로고침 재진입 모사 — 게이트를 수동으로 숨긴 뒤 pageshow 재발화 → 다시 덮여야 함
    results.s6 = await withPage(port, "/harness.html", async (ws) => {
      await evalJson(ws, "InstallGate.hide(); 'ok'");
      const hiddenNow = JSON.parse(await evalJson(ws, STATE_EXPR));
      await evalJson(ws, "window.dispatchEvent(new Event('pageshow')); 'ok'");
      await wait(50);
      const afterPageshow = JSON.parse(await evalJson(ws, STATE_EXPR));
      await shot(ws, "s6-pageshow-regate");
      return { hiddenNow, afterPageshow };
    });

    // S7: beforeinstallprompt 도착 후 [지금 설치] 클릭 → Install.accept() 경로로 prompt() 호출
    results.s7 = await withPage(port, "/harness.html", async (ws) => {
      await evalJson(ws, "window.__fireBeforeInstallPrompt(); 'ok'");
      await wait(50);
      const ready = JSON.parse(await evalJson(ws, STATE_EXPR));
      await shot(ws, "s7-ready-install");
      await evalJson(ws, "document.getElementById('install-gate-btn').click(); 'ok'");
      await wait(80);
      const promptCalled = await evalJson(ws, "JSON.stringify(!!window.__promptCalled)");
      return { ready, promptCalled: JSON.parse(promptCalled) };
    });

    // S8: iOS UA → 홈 화면 추가 안내, 설치 버튼 숨김
    results.s8 = await withPage(port, "/harness.html?ios=1", async (ws) => {
      const st = JSON.parse(await evalJson(ws, STATE_EXPR));
      await shot(ws, "s8-ios-guide");
      return st;
    });

    // S9: 설치 완료(appinstalled) → "홈 화면 아이콘으로" 안내, 게이트는 유지(브라우저 탭)
    results.s9 = await withPage(port, "/harness.html", async (ws) => {
      await evalJson(ws, "window.__fireAppInstalled(); 'ok'");
      await wait(50);
      const st = JSON.parse(await evalJson(ws, STATE_EXPR));
      await shot(ws, "s9-installed-done");
      return st;
    });

    // [WO 20261019] S10: 휴대폰 — [브라우저에서 계속 사용] 클릭 → 닫힘 + 같은 탭 새로고침해도 7일간 재노출 안됨(요구 1)
    results.s10 = await withPage(port, "/harness.html", async (ws, navigate) => {
      const before = JSON.parse(await evalJson(ws, STATE_EXPR));
      await evalJson(ws, "document.getElementById('install-gate-continue').click(); 'ok'");
      await wait(50);
      const afterClick = JSON.parse(await evalJson(ws, STATE_EXPR));
      await shot(ws, "s10-continue-dismissed");
      await navigate("/harness.html"); // 같은 탭 새로고침 재진입(요구 1 — 7일 재노출 금지) — 하니스 하단 스크립트가 InstallGate.init() 을 다시 실행
      await wait(50);
      const afterReload = JSON.parse(await evalJson(ws, STATE_EXPR));
      return { before, afterClick, afterReload };
    });

    // [WO 20261019] S11: localStorage 차단(try/catch 폴백) — 클릭 직후(같은 JS 런타임)엔 닫혀 있어야 하고,
    // 실제 새로고침(JS 런타임 재시작) 후에는 저장이 안 됐으므로 다시 떠야 함("세션 동안만" = 재로드 전까지).
    results.s11 = await withPage(port, "/harness.html", async (ws, navigate) => {
      await evalJson(ws, "Object.defineProperty(window, 'localStorage', { get: function(){ throw new Error('blocked'); } }); 'ok'");
      await evalJson(ws, "document.getElementById('install-gate-continue').click(); 'ok'");
      await wait(50);
      const afterClick = JSON.parse(await evalJson(ws, STATE_EXPR));
      await evalJson(ws, "window.dispatchEvent(new Event('pageshow')); 'ok'"); // 재진입 모사(런타임은 그대로) — 세션 동안엔 유지
      await wait(50);
      const afterPageshowSameRuntime = JSON.parse(await evalJson(ws, STATE_EXPR));
      await navigate("/harness.html"); // 실제 새로고침 — 저장 안 됐으므로 다시 떠야 함
      await wait(50);
      const afterRealReload = JSON.parse(await evalJson(ws, STATE_EXPR));
      return { afterClick, afterPageshowSameRuntime, afterRealReload };
    });

    // [WO 20261019] S12: 태블릿(800x1280, 짧은 변 800≥600) — 전체화면 강제 없음 + 작은 배너만(요구 2)
    results.s12 = await withPage(port, "/harness.html", async (ws) => {
      const st = JSON.parse(await evalJson(ws, STATE_EXPR));
      await shot(ws, "s12-tablet-banner-only");
      return st;
    }, { width: 800, height: 1280 });

    // [WO 20261019] S13: 태블릿 배너의 닫기(×) 클릭 → 배너도 닫힘(요구 2 "배너도 닫을 수 있다")
    results.s13 = await withPage(port, "/harness.html", async (ws) => {
      const before = JSON.parse(await evalJson(ws, STATE_EXPR));
      await evalJson(ws, "document.getElementById('install-gate-banner-close').click(); 'ok'");
      await wait(50);
      const after = JSON.parse(await evalJson(ws, STATE_EXPR));
      return { before, after };
    }, { width: 800, height: 1280 });
  } finally { server.close(); }
  return results;
}

(async () => {
  const installSrc = fs.readFileSync(INSTALL_FILE, "utf8");
  const gateSrc = fs.readFileSync(GATE_FILE, "utf8");
  fs.writeFileSync(HARNESS, HARNESS_HTML, "utf8");

  console.log("[CDP] 정상 소스 — 시나리오 13종 실행");
  const r = await run(installSrc, gateSrc);
  console.log(JSON.stringify(r, null, 2));

  let fail = 0;
  const check = (name, cond) => { if (!cond) { console.log("  FAIL " + name); fail = 1; } else console.log("  PASS " + name); };

  check("S1 모바일+로그인+브라우저탭: 게이트 표시", r.s1.st.gateHidden === false);
  check("S1 바깥 영역 inert(클릭 통과 0)", r.s1.st.outsideInert === true && r.s1.clickThrough !== "outside-app");
  check("S1 바깥 스크롤 잠금", r.s1.st.bodyOverflow === "hidden");
  check("S2 standalone: 게이트 없음", r.s2.gateHidden === true);
  check("S3 공유링크(비로그인): 게이트 없음", r.s3.gateHidden === true);
  check("S3b 공유링크+로그인: 그래도 게이트(우회 금지)", r.s3b.gateHidden === false);
  check("S3c 열람링크 readonly 세션(Auth.user 있음): 게이트 없음", r.s3c.gateHidden === true);
  check("S4 PC: 게이트 없음", r.s4.gateHidden === true);
  check("S5 플래그 OFF: 게이트 없음", r.s5.gateHidden === true);
  check("S6 수동 숨김 후 pageshow 재진입: 다시 표시", r.s6.hiddenNow.gateHidden === true && r.s6.afterPageshow.gateHidden === false);
  check("S7 prompt 도착: 버튼 활성+설치 문구", r.s7.ready.btnDisabled === false && r.s7.ready.btnText === "지금 설치");
  check("S7 클릭 → accept() 경로로 prompt() 호출", r.s7.promptCalled === true);
  check("S8 iOS: 버튼 숨김 + 안내 노출", r.s8.btnHidden === true && r.s8.iosHidden === false);
  check("S9 설치완료: 완료안내 노출 + 게이트 유지(탭)", r.s9.doneHidden === false && r.s9.gateHidden === false);
  check("S1 계속버튼 존재+대비용 테두리색+44px 이상", r.s1.st.continueExists === true && r.s1.st.continueHidden === false && r.s1.st.continueBtnHeight >= 44);
  check("S1 태블릿 아님: 배너 숨김", r.s1.st.bannerHidden === true);
  check("S10 계속버튼 클릭 전: 게이트 표시", r.s10.before.gateHidden === false);
  check("S10 계속버튼 클릭 후: 즉시 닫힘", r.s10.afterClick.gateHidden === true);
  check("S10 새로고침해도 7일간 재노출 안됨(localStorage 영속)", r.s10.afterReload.gateHidden === true);
  check("S11 저장소 차단 — 클릭 즉시 닫힘", r.s11.afterClick.gateHidden === true);
  check("S11 저장소 차단 — 같은 런타임에서 재진입(pageshow)해도 유지", r.s11.afterPageshowSameRuntime.gateHidden === true);
  check("S11 저장소 차단 — 실제 새로고침(런타임 재시작) 후엔 다시 뜸(세션 동안만)", r.s11.afterRealReload.gateHidden === false);
  check("S12 태블릿(800x1280): 전체화면 강제 없음", r.s12.gateHidden === true);
  check("S12 태블릿: 작은 배너 노출", r.s12.bannerHidden === false);
  check("S13 배너 닫기 클릭 전: 배너 노출", r.s13.before.bannerHidden === false);
  check("S13 배너 닫기 클릭 후: 배너도 닫힘", r.s13.after.bannerHidden === true);

  // ── 뮤테이션 1: 로그인 검사(Auth.user)를 무력화 → 비로그인도 게이트돼야(현재는 안 됨) → S3(공유링크 비로그인)가 깨져야 함 ──
  const needle1 = 'if (!(typeof Auth !== "undefined" && Auth.user)) return false;';
  if (!gateSrc.includes(needle1)) { console.log("  FAIL 뮤테이션1 대상 문자열을 찾지 못함(소스 변경?)"); fail = 1; }
  else {
    const mutated1 = gateSrc.replace(needle1, "/* mutated: no-op */");
    console.log("\n[CDP][뮤테이션1] 로그인 검사 제거 — 비로그인 공유링크도 게이트에 걸려야 함(=가드 제거 시 공유링크가 깨짐)");
    const mr1 = await run(installSrc, mutated1);
    const broke = mr1.s3.gateHidden === false; // 제거 전엔 true(게이트 없음)였는데 이제 걸려야 뮤테이션이 유효
    if (broke) console.log("  PASS(뮤테이션 효과 확인) — 로그인 가드 제거 시 공유링크까지 게이트에 걸림(회귀 재현됨)");
    else { console.log("  FAIL 뮤테이션을 넣어도 영향 없음(테스트가 실효성 없음)"); fail = 1; }
  }

  // ── 뮤테이션 2: 기능 플래그 검사를 무력화 → S5(플래그 OFF)가 깨져야(게이트가 떠야) 함 ──
  const needle2 = "if (typeof AdminPanels !== \"undefined\" && AdminPanels.isEnabled && !AdminPanels.isEnabled(this.FLAG_KEY)) return false;";
  if (!gateSrc.includes(needle2)) { console.log("  FAIL 뮤테이션2 대상 문자열을 찾지 못함(소스 변경?)"); fail = 1; }
  else {
    const mutated2 = gateSrc.replace(needle2, "/* mutated: no-op */");
    console.log("\n[CDP][뮤테이션2] 기능 플래그 검사 제거 — 플래그 OFF 상태에서도 게이트가 떠야 함(=가드 제거 시 끌 수 없는 버그 재현)");
    const mr2 = await run(installSrc, mutated2);
    const broke2 = mr2.s5.gateHidden === false;
    if (broke2) console.log("  PASS(뮤테이션 효과 확인) — 플래그 가드 제거 시 OFF 에도 게이트가 뜸(회귀 재현됨)");
    else { console.log("  FAIL 뮤테이션을 넣어도 영향 없음(테스트가 실효성 없음)"); fail = 1; }
  }

  // ── 뮤테이션 3: readonly 예외 제거 → S3c(열람링크 readonly 세션)가 깨져야(게이트가 떠야) 함 ──
  const needle3 = "if (Auth.readonly) return false;";
  if (!gateSrc.includes(needle3)) { console.log("  FAIL 뮤테이션3 대상 문자열을 찾지 못함(소스 변경?)"); fail = 1; }
  else {
    const mutated3 = gateSrc.replace(needle3, "/* mutated: no-op */");
    console.log("\n[CDP][뮤테이션3] readonly 예외 제거 — 열람 링크 모바일 방문자가 게이트에 막혀야 함(=원 결함 재현)");
    const mr3 = await run(installSrc, mutated3);
    if (mr3.s3c.gateHidden === false) console.log("  PASS(뮤테이션 효과 확인) — readonly 예외 제거 시 열람링크에 게이트가 뜸(회귀 재현됨)");
    else { console.log("  FAIL 뮤테이션을 넣어도 영향 없음(테스트가 실효성 없음)"); fail = 1; }
  }

  // ── 뮤테이션 4(요구된 2개 중 1 — "닫기 저장 제거"): 7일 스누즈 검사를 무력화 → S10(재로드 후에도 다시 떠야) 깨짐 ──
  const needle4 = "if (this._isContinueDismissed()) return false;  // \"계속 사용\" 선택 후 7일(요구 1)";
  if (!gateSrc.includes(needle4)) { console.log("  FAIL 뮤테이션4 대상 문자열을 찾지 못함(소스 변경?)"); fail = 1; }
  else {
    const mutated4 = gateSrc.replace(needle4, "/* mutated: no-op */");
    console.log("\n[CDP][뮤테이션4] 계속사용 7일 스누즈 검사 제거 — 닫아도 새로고침하면 다시 떠야 함(=닫기가 무력화된 결함 재현)");
    const mr4 = await run(installSrc, mutated4);
    const broke4 = mr4.s10.afterReload.gateHidden === false; // 제거 전엔 true(재노출 안됨)였는데 이제 다시 떠야 뮤테이션이 유효
    if (broke4) console.log("  PASS(뮤테이션 효과 확인) — 스누즈 검사 제거 시 새로고침 후 다시 게이트가 뜸(닫기 무력화 재현됨)");
    else { console.log("  FAIL 뮤테이션을 넣어도 영향 없음(테스트가 실효성 없음)"); fail = 1; }
  }

  // ── 뮤테이션 5(요구된 2개 중 2 — "태블릿 판정 제거"): 태블릿 예외를 무력화 → S12(태블릿은 전체화면 없어야) 깨짐 ──
  const needle5 = "if (this._isTabletLike()) return false;        // 태블릿/폴드 펼침은 배너만(요구 2)";
  if (!gateSrc.includes(needle5)) { console.log("  FAIL 뮤테이션5 대상 문자열을 찾지 못함(소스 변경?)"); fail = 1; }
  else {
    const mutated5 = gateSrc.replace(needle5, "/* mutated: no-op */");
    console.log("\n[CDP][뮤테이션5] 태블릿 판정 제거 — 태블릿 뷰포트에도 전체화면 게이트가 떠야 함(=요구 2 위반 재현)");
    const mr5 = await run(installSrc, mutated5);
    const broke5 = mr5.s12.gateHidden === false; // 제거 전엔 true(강제 없음)였는데 이제 떠야 뮤테이션이 유효
    if (broke5) console.log("  PASS(뮤테이션 효과 확인) — 태블릿 판정 제거 시 태블릿에도 전체화면 게이트가 뜸(회귀 재현됨)");
    else { console.log("  FAIL 뮤테이션을 넣어도 영향 없음(테스트가 실효성 없음)"); fail = 1; }
  }

  console.log("\n" + (fail ? "FAILED" : "ALL PASS") + " — 스크린샷: " + SHOT_DIR);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
