// [WO 20261010-apk] 안드로이드 APK 설치 안내·게이트 선택지·APK(Capacitor) 연결 회귀 테스트 — 실 Chrome CDP, 375 모바일.
// 실소스: public/js/modules/38_Install.js · 38b_InstallGate.js · 38c_ApkInstall.js + 실제 public/download/seastar360.{apk,json}.
// 스텁은 이 모듈들의 바깥 의존(Auth·AdminPanels·Prompt.toast·ThetaIntake.receive·Capacitor 네이티브 브리지)만.
// 스크린샷: .tmp/fixapk/ (CLAUDE.md G-5). Chrome 미존재 시 SKIP(기존 -cdp.mjs 관례).
// 뮤테이션: 환경변수 MUT=<id> 면 해당 소스를 변형해 서빙 → 어떤 단언이 깨져 EXIT=1 이어야 한다(tests/p145-apk-mutate.mjs).
import { spawn } from "child_process";
import WebSocket from "ws";
import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ROOT = path.join(__dirname, "..");
const MOD = (f) => path.join(ROOT, "public", "js", "modules", f);
const DL = path.join(ROOT, "public", "download");
const TMP_ROOT = path.join(ROOT, ".tmp");
const SHOT_DIR = path.join(TMP_ROOT, "fixapk");
const MUT = process.env.MUT || "";

if (!fs.existsSync(CHROME)) { console.log("[SKIP] Chrome 없음(" + CHROME + ")"); process.exit(0); }
fs.mkdirSync(SHOT_DIR, { recursive: true });

const rd = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const SRC = { install: rd(MOD("38_Install.js")), gate: rd(MOD("38b_InstallGate.js")), apk: rd(MOD("38c_ApkInstall.js")) };
const MUTATIONS = {
  "native-standalone": ["install", "    if (this.isNativeApp()) return true;\n      try {", "    try {"],
  "vendor-filter": ["apk", 'return all.filter((s) => s.vendor === "all" || s.vendor === v);', "return all;"],
  "android-only": ["apk", '      if (!this.isAndroid()) return "안드로이드 휴대폰 전용(iPhone은 홈 화면에 추가)";\n', ""],
  "sha-display": ["apk", "e(this.groupHex(m.sha256))", 'e(this.groupHex(m.sha256).slice(0, 20))'],
  "back-confirm": ["apk", '      this.confirmExit();\n      return "confirm";', '      return "confirm";'],
  "gate-allow": ["gate", ' || el.hasAttribute("data-installgate-allow")) return;', ") return;"]
};
if (MUT) {
  const m = MUTATIONS[MUT];
  if (!m) { console.log("unknown MUT " + MUT); process.exit(2); }
  const before = SRC[m[0]];
  SRC[m[0]] = before.replace(m[1], m[2]);
  if (SRC[m[0]] === before) { console.log("MUTATION NOT APPLIED (needle missing): " + MUT); process.exit(3); }
  console.log("[MUT] " + MUT + " applied to " + m[0]);
}

const APK_BUF = fs.readFileSync(path.join(DL, "seastar360.apk"));
const APK_SHA = crypto.createHash("sha256").update(APK_BUF).digest("hex");
const META = JSON.parse(fs.readFileSync(path.join(DL, "seastar360.json"), "utf8"));
const FAKE_JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");

const UA_ANDROID = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";
const UA_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const UA_DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

const HARNESS = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>.hidden{display:none!important}.install-gate{background:#0b1220;color:#fff;display:flex;align-items:center;justify-content:center}.install-gate-card{padding:20px;max-width:340px}</style></head>
<body><div id="outside-app" style="padding:40px;">바깥 앱 화면</div>
<script>
  var qs = new URLSearchParams(location.search);
  window.__rec = { toast: [], native: [], received: [], back: [], historyBack: 0 };
  var realMM = window.matchMedia.bind(window);
  window.matchMedia = function (q) {
    if (q.indexOf('display-mode: standalone') >= 0) return { matches: false };
    if (q.indexOf('pointer: coarse') >= 0 || q.indexOf('max-width: 760px') >= 0) return { matches: qs.get('mobile') !== '0' };
    return realMM(q);
  };
  window.Auth = { user: qs.get('loggedin') === '0' ? null : { email: 'designer@test.com' } };
  window.AdminPanels = { isEnabled: function () { return true; } };
  window.Prompt = { toast: function (m) { window.__rec.toast.push(String(m)); } };
  window.ThetaIntake = { receive: function (files, o) { window.__rec.received.push({ n: files.map(function (f) { return f.name + ':' + f.size + ':' + f.type; }), src: o && o.source }); return Promise.resolve(); } };
  if (qs.get('native') === '1') {
    window.__listeners = {};
    window.Capacitor = {
      isNativePlatform: function () { return true; },
      convertFileSrc: function (p) { return '/__capfile__' + p; },
      nativeCallback: function (plugin, method, opts, cb) { window.__rec.native.push(plugin + '.' + method + ':' + (opts && opts.eventName)); window.__listeners[plugin + ':' + opts.eventName] = cb; return 'cb1'; },
      nativePromise: function (plugin, method, opts) {
        window.__rec.native.push(plugin + '.' + method);
        if (plugin === 'SeastarNative' && method === 'takeShared') return Promise.resolve({ files: window.__pendingShared.splice(0) });
        if (plugin === 'Filesystem' && method === 'writeFile') { window.__rec.written = { path: opts.path, len: (opts.data || '').length, dir: opts.directory }; return Promise.resolve({ uri: 'file:///cache/' + opts.path }); }
        if (plugin === 'Share' && method === 'share') { window.__rec.shared = opts.url; return Promise.resolve({}); }
        if (plugin === 'App' && method === 'getInfo') return Promise.resolve({ build: '10000', version: '1.0.0' });
        return Promise.resolve({});
      }
    };
    window.__pendingShared = [{ path: '/data/cache/shared/1-R0010001.JPG', name: 'R0010001.JPG', type: 'image/jpeg', size: ${FAKE_JPEG.length} }];
    history.back = function () { window.__rec.historyBack++; };
  }
</script>
<script src="/38_Install.js"></script>
<script src="/38b_InstallGate.js"></script>
<script src="/38c_ApkInstall.js"></script>
<script>Install.init(); InstallGate.init(); ApkInstall.init(); window.__booted = true;</script>
</body></html>`;

function serve() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const p = decodeURIComponent(u.pathname);
    const js = (s) => { res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" }); res.end(s); };
    if (p === "/38_Install.js") return js(SRC.install);
    if (p === "/38b_InstallGate.js") return js(SRC.gate);
    if (p === "/38c_ApkInstall.js") return js(SRC.apk);
    if (p === "/download/seastar360.json") {
      if ((req.headers.referer || "").includes("nometa=1")) { res.writeHead(404); res.end("nf"); return; }
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(META)); return;
    }
    if (p === "/download/seastar360.apk") { res.writeHead(200, { "Content-Type": "application/vnd.android.package-archive" }); res.end(APK_BUF); return; }
    if (p.startsWith("/__capfile__/")) { res.writeHead(200, { "Content-Type": "image/jpeg" }); res.end(FAKE_JPEG); return; }
    if (p === "/" || p === "/harness.html") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(HARNESS); return; }
    res.writeHead(404); res.end("nf");
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function devPort(dir) {
  for (let i = 0; i < 80; i++) { try { const n = parseInt(fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf8").split("\n")[0], 10); if (n > 0) return n; } catch (e) {} await wait(150); }
  throw new Error("DevToolsActivePort not found");
}
async function wsUrl(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await new Promise((ok, no) => http.get(`http://127.0.0.1:${port}/json/list`, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => ok(JSON.parse(d))); }).on("error", no));
      const pg = list.find((t) => t.type === "page"); if (pg) return pg.webSocketDebuggerUrl;
    } catch (e) {}
    await wait(200);
  }
  throw new Error("devtools not up");
}
let idc = 0;
function send(ws, method, params = {}) {
  return new Promise((ok, no) => {
    const id = ++idc;
    const h = (raw) => { const m = JSON.parse(raw); if (m.id === id) { ws.removeListener("message", h); m.error ? no(new Error(JSON.stringify(m.error))) : ok(m.result); } };
    ws.on("message", h); ws.send(JSON.stringify({ id, method, params }));
  });
}
async function ev(ws, expr) {
  const r = await send(ws, "Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}
async function shot(ws, name) { const s = await send(ws, "Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(SHOT_DIR, name + ".png"), Buffer.from(s.data, "base64")); }

async function withPage(port, query, ua, meta, fn) {
  const dir = path.join(TMP_ROOT, "cdp-p145-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--window-size=375,812", "about:blank"], { stdio: "ignore" });
  try {
    await wait(600);
    const ws = new WebSocket(await wsUrl(await devPort(dir)));
    await new Promise((r) => ws.on("open", r));
    await send(ws, "Page.enable");
    await send(ws, "Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
    await send(ws, "Emulation.setUserAgentOverride", meta ? { userAgent: ua, userAgentMetadata: meta } : { userAgent: ua });
    const loaded = new Promise((r) => { const h = (raw) => { if (JSON.parse(raw).method === "Page.loadEventFired") { ws.removeListener("message", h); r(); } }; ws.on("message", h); });
    await send(ws, "Page.navigate", { url: `http://127.0.0.1:${port}/harness.html${query}` });
    await loaded; await wait(250);
    const out = await fn(ws);
    ws.close();
    return out;
  } finally { chrome.kill(); await wait(300); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
}

let failed = 0;
const ok = (c, msg) => { console.log((c ? "  PASS " : "  FAIL ") + msg); if (!c) failed++; };
const STEP = `(function(){var h=document.getElementById('apk-guide-title');return {id:h&&h.getAttribute('data-step-id'),no:(document.getElementById('apk-step-no')||{}).textContent,hl:document.querySelectorAll('#apk-guide [data-hl], #apk-guide .apk-mock [style*="outline:3px solid #c2410c"]').length,lead:(document.getElementById('apk-lead')||{}).textContent};})()`;
const SAMSUNG_META = { brands: [{ brand: "Chromium", version: "129" }], fullVersion: "129.0.0.0", platform: "Android", platformVersion: "14.0.0", architecture: "", model: "SM-S921N", mobile: true };

const server = await serve();
const port = server.address().port;
try {
  console.log("\n[S1] 안드로이드(삼성 UA-CH) — 안내 5단계 · 지문 · 이동");
  await withPage(port, "?loggedin=0", UA_ANDROID, SAMSUNG_META, async (ws) => {
    ok((await ev(ws, "ApkInstall.availabilityReason()")) === "", "A1 안드로이드 브라우저 — 사용 가능(사유 없음)");
    await ev(ws, "ApkInstall.open()");
    await ev(ws, "new Promise(function(r){var n=0;(function t(){if(document.getElementById('apk-sha256')||n++>40)return r();setTimeout(t,100);})();})");
    await wait(300); // UA-CH 보강(_refineVendor) 반영
    ok((await ev(ws, "getComputedStyle(document.getElementById('apk-guide')).display")) === "flex", "A2 안내 팝업이 뜬다");
    ok((await ev(ws, "ApkInstall._vendor")) === "samsung", "A3 Chrome 축소 UA 라도 UA-CH 모델(SM-)로 삼성 분기");
    const shaTxt = (await ev(ws, "document.getElementById('apk-sha256').textContent")).replace(/\s+/g, "");
    ok(shaTxt === APK_SHA, "A4 화면의 SHA-256 = 실제 public/download/seastar360.apk 의 sha256 (" + APK_SHA.slice(0, 12) + "…)");
    ok((await ev(ws, "document.getElementById('apk-ver').textContent")) === META.versionName && (await ev(ws, "document.getElementById('apk-size').textContent")) === (APK_BUF.length / 1048576).toFixed(1) + " MB", "A5 버전·크기 표시(메타 SoT)");
    ok((await ev(ws, "document.getElementById('apk-download').getAttribute('href')")) === "/download/seastar360.apk?v=" + APK_SHA.slice(0, 12), "A6 다운로드 링크 = 실제 파일 + 지문 캐시버스터");
    ok(/사내 배포 앱/.test(await ev(ws, "document.getElementById('apk-honest').textContent")) && /certutil -hashfile/.test(await ev(ws, "document.getElementById('apk-honest').textContent")), "A7 정직성 — 사내 배포라 경고가 뜬다 + SHA-256 확인 방법");
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const s = await ev(ws, STEP);
      ids.push(s.id);
      ok(s.hl >= 1, `A8.${i + 1} 단계 ${s.no} '${s.id}' — 누를 곳 강조 ${s.hl}개`);
      await shot(ws, `step${i + 1}-${s.id}`);
      if (i < 4) await ev(ws, "document.getElementById('apk-next').click()");
    }
    ok(ids.join(",") === "download,blocker,unknown,protect,done", "A9 삼성 5단계 순서: " + ids.join(","));
    await ev(ws, "document.getElementById('apk-prev').click()");
    ok((await ev(ws, STEP)).id === "protect", "A10 [이전] → 직전 단계");
    await ev(ws, "document.querySelector('[data-apk=vendor][data-v=other]').click()");
    const n2 = await ev(ws, "ApkInstall.steps().map(function(s){return s.id}).join(',')");
    ok(n2 === "download,unknown,protect,done", "A11 '그 외 안드로이드' — 삼성 전용 단계 제외: " + n2);
    await ev(ws, "ApkInstall.go(1)");
    ok(/이 소스에서 가져온 앱 설치 허용/.test(await ev(ws, "document.getElementById('apk-guide-card').textContent")), "A12 비삼성 = AOSP 문구 '이 소스에서 가져온 앱 설치 허용'");
    await ev(ws, "document.querySelector('[data-apk=vendor][data-v=samsung]').click()");
    await ev(ws, "ApkInstall.go(2)");
    ok(/이 출처 허용/.test(await ev(ws, "document.getElementById('apk-guide-card').textContent")), "A13 삼성 = '이 출처 허용'");
    await ev(ws, "document.querySelector('[data-apk=close]').click()");
    ok((await ev(ws, "getComputedStyle(document.getElementById('apk-guide')).display")) === "none", "A14 닫기");
  });

  console.log("\n[S2] PC — 노출 안 함");
  await withPage(port, "?mobile=0", UA_DESKTOP, null, async (ws) => {
    ok(/안드로이드 휴대폰 전용/.test(await ev(ws, "ApkInstall.availabilityReason()")), "B1 PC — 비활성 사유 '안드로이드 휴대폰 전용'");
    ok((await ev(ws, "ApkInstall.open()")) === false && (await ev(ws, "!document.getElementById('apk-guide')")), "B2 PC 에서 open() → 팝업 안 뜸");
  });

  console.log("\n[S3] iPhone — 기존 홈 화면 추가 안내 유지, APK 선택지 없음");
  await withPage(port, "", UA_IOS, null, async (ws) => {
    ok(/안드로이드 휴대폰 전용/.test(await ev(ws, "ApkInstall.availabilityReason()")), "C1 iPhone — 비활성");
    ok((await ev(ws, "!document.getElementById('install-gate').classList.contains('hidden')")) && (await ev(ws, "!document.getElementById('install-gate-ios').classList.contains('hidden')")), "C2 게이트 iOS 안내 유지");
    ok(await ev(ws, "document.getElementById('install-gate-apk-box').classList.contains('hidden')"), "C3 iOS 게이트엔 APK 선택지 숨김");
  });

  console.log("\n[S4] 안드로이드 브라우저 게이트 — PWA 또는 APK 선택");
  await withPage(port, "", UA_ANDROID, null, async (ws) => {
    ok(await ev(ws, "!document.getElementById('install-gate').classList.contains('hidden')"), "D1 로그인 모바일 → 게이트 표시");
    ok(await ev(ws, "!document.getElementById('install-gate-apk-box').classList.contains('hidden')"), "D2 게이트에 'APK로 설치' 선택지");
    await shot(ws, "gate-android-choice");
    await ev(ws, "document.getElementById('install-gate-apk').click()");
    await ev(ws, "new Promise(function(r){var n=0;(function t(){if(document.getElementById('apk-sha256')||n++>40)return r();setTimeout(t,100);})();})");
    const hit = await ev(ws, "(function(){document.getElementById('apk-next').scrollIntoView({block:'center'});var b=document.getElementById('apk-next').getBoundingClientRect();var el=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);return el&&el.id;})()");
    ok(hit === "apk-next", "D3 게이트 위 안내의 [다음]이 실제로 눌린다(inert 제외) — hit=" + hit);
    await ev(ws, "InstallGate.recheck()"); // 재검사(visibilitychange 등)가 안내를 다시 잠그지 않아야
    ok(!(await ev(ws, "document.getElementById('apk-guide').hasAttribute('inert')")), "D4 게이트 재검사 후에도 안내는 inert 아님");
  });

  console.log("\n[S5] APK 안(Capacitor 감지) — 게이트 통과 · 뒤로가기 · 공유 받기 · 파일 저장");
  await withPage(port, "?native=1", UA_ANDROID + " SEASTAR360App", null, async (ws) => {
    await wait(300);
    ok(await ev(ws, "Install.isNativeApp() && Install.isStandalone()"), "E1 Capacitor 감지 → 설치됨으로 판정");
    ok(await ev(ws, "InstallGate.shouldGate() === false && document.getElementById('install-gate').classList.contains('hidden')"), "E2 APK 안에서는 설치 게이트 통과");
    ok(/이미 SEASTAR 360 앱/.test(await ev(ws, "ApkInstall.availabilityReason()")), "E3 앱 안에서 설치 메뉴 = '이미 앱에서 실행 중'");
    const rec = await ev(ws, "window.__rec");
    ok(rec.native.indexOf("App.addListener:backButton") !== -1, "E4 하드웨어 뒤로가기 리스너 등록(App.addListener backButton)");
    ok(rec.received.length === 1 && /^R0010001\.JPG:\d+:image\/jpeg$/.test(rec.received[0].n[0]) && rec.received[0].src === "share", "E5 공유 받은 사진 → ThetaIntake.receive(source=share): " + JSON.stringify(rec.received));
    ok(rec.native.indexOf("SeastarNative.releaseShared") !== -1, "E6 읽은 뒤 캐시 사본 정리(releaseShared)");
    ok(await ev(ws, "!!(Capacitor.Plugins && Capacitor.Plugins.App && typeof Capacitor.Plugins.App.exitApp==='function' && !Capacitor.Plugins.App.addListener)"), "E7 BackGuard.leave 용 Plugins.App.exitApp 브리지(addListener 없음=이중 배선 방지)");
    // 뒤로가기 — BackGuard 없음 + 최상위 → 종료 확인 → [나가기] 때만 exitApp
    await ev(ws, "window.__listeners['App:backButton']({canGoBack:false})");
    await wait(100);
    ok(await ev(ws, "getComputedStyle(document.getElementById('apk-exit-confirm')).display==='flex'"), "E8 최상위 뒤로가기 → '정말 나가시겠습니까?' 확인창");
    await shot(ws, "native-back-confirm");
    ok((await ev(ws, "window.__rec.native.indexOf('App.exitApp')")) === -1, "E9 확인 전에는 종료하지 않음");
    await ev(ws, "document.getElementById('apk-exit-cancel').click()");
    ok((await ev(ws, "window.__rec.native.indexOf('App.exitApp')")) === -1, "E10 [취소] → 종료 안 함");
    await ev(ws, "window.__listeners['App:backButton']({canGoBack:false})");
    await wait(100);
    await ev(ws, "document.getElementById('apk-exit-ok').click()");
    ok((await ev(ws, "window.__rec.native.indexOf('App.exitApp')")) !== -1, "E11 [나가기] → App.exitApp");
    await ev(ws, "window.__listeners['App:backButton']({canGoBack:true})");
    ok((await ev(ws, "window.__rec.historyBack")) === 1, "E12 BackGuard 없음 + 뒤로 갈 곳 있음 → history.back()");
    await ev(ws, "window.BackGuard={handleBack:function(){window.__rec.back.push(1);return 'closed:x';}}");
    await ev(ws, "window.__listeners['App:backButton']({canGoBack:true})");
    await wait(50);
    ok((await ev(ws, "window.__rec.back.length")) === 1 && (await ev(ws, "window.__rec.historyBack")) === 1, "E13 BackGuard 있으면 handleBack() 에 위임(자체 처리 안 함)");
    // <a download> blob → Filesystem + Share
    await ev(ws, "(function(){var u=URL.createObjectURL(new Blob(['hello'],{type:'text/plain'}));var a=document.createElement('a');a.href=u;a.download='보고서.txt';a.click();URL.revokeObjectURL(u);})()");
    await ev(ws, "new Promise(function(r){var n=0;(function t(){if(window.__rec.shared||n++>30)return r();setTimeout(t,100);})();})");
    const r2 = await ev(ws, "window.__rec");
    ok(r2.written && r2.written.dir === "CACHE" && r2.written.len > 0 && r2.shared === "file:///cache/" + r2.written.path, "E14 <a download>(blob, 직후 revoke) → Filesystem.writeFile(CACHE) → Share.share: " + JSON.stringify({ w: r2.written, s: r2.shared }));
  });

  console.log("\n[S6] 메타 못 읽음 — 지문 없는 다운로드 금지");
  await withPage(port, "?nometa=1&loggedin=0", UA_ANDROID, null, async (ws) => {
    await ev(ws, "ApkInstall.open()");
    await ev(ws, "new Promise(function(r){var n=0;(function t(){if(ApkInstall._metaErr||n++>40)return r();setTimeout(t,100);})();})");
    ok(!(await ev(ws, "!!document.getElementById('apk-download')")) && /불러오지 못했습니다/.test(await ev(ws, "document.getElementById('apk-file-info').textContent")), "F1 메타 404 → 다운로드 버튼 없음 + 사유 + 다시 시도");
  });
} catch (e) {
  console.log("  FAIL 예외: " + (e && e.stack || e)); failed++;
} finally { server.close(); }

console.log(failed ? `\nFAIL ${failed}` : "\nALL PASS");
process.exit(failed ? 1 : 0);
