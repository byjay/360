// [WO 20260929-회귀수정] 지휘자 CDP 실측(HEAD a9063f6, 재조립된 main.js)으로 발견된 회귀 —
// 모바일 첫 화면에 즉시 뜨는 설치 배너(#pwa-install-banner)가 편집 화면(#screen-app.active,
// 사이드바·도크·지도 조작) 진입 후에도 그대로 떠 있어 사이드바 도구 행(y≈686 부근)을 덮어
// 클릭이 막혔다(hitTag: "B"/배너 DIV — p42-cdp-real.mjs 재현과 동일 좌표).
//
// 이 스크립트는 실제 헤드리스 Chrome(CDP)으로 public/index.html + 실제 CSS 3종을 375×812 에
// 그대로 로드한다. main.js 는 "지금 이 순간의" public/js/modules/* 소스로 그 자리에서 새로
// 조립해, 격리된 임시 디렉터리(.tmp/)에 물리 파일로 써서 서빙한다.
// 🔴 CDP Fetch 도메인으로 main.js 응답을 가로채는 방식은 시도했으나, 문서 파싱기가 <script> 를
//   프리로드하는 시점과 Fetch.enable 활성화 시점 사이에 경합이 있어(실측: 뮤테이션 버전이 간헐적으로
//   무시되고 디스크의 원본이 그대로 응답됨) 신뢰할 수 없었다 — 그래서 아예 물리 파일을 미리 써 두는
//   방식으로 바꿨다(경합 원천 차단). 🔴 또한 절대 커밋된 public/js/main.js 를 직접 덮어쓰지 않는다
//   (다른 세션이 참조 중일 수 있음) — 항상 .tmp/ 밑의 격리된 사본에만 쓴다.
//
// 검증:
//  ① 허브(첫 화면, #screen-app 비활성) — 모바일이면 배너가 즉시 뜬다(요구1 유지 확인, 회귀 없음)
//  ② 편집 화면(#screen-app.active) 진입 — 배너 hidden, 상시버튼 display:none
//  ③ ②상태에서 사이드바 조작요소(사각영역/원형영역/다각영역/뷰어로배포) 중심점 elementFromPoint
//     가 배너가 아닌 자기 자신(또는 자손)을 반환 — 겹침 면적 0 을 실측으로 증명
// 뮤테이션 1건: isEditorScreenActive() 를 항상 false 로 되돌림(화면 구분 제거) → ②③ 가 실패해야 한다.
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
const TMP_ROOT = process.env.TEMP || path.join(__dirname, "..", ".tmp");

if (!fs.existsSync(CHROME)) {
  console.log("[SKIP] Chrome 실행파일을 찾지 못함(" + CHROME + ") — CDP 실측 생략(p42-cdp-real.mjs 와 동일 관례)");
  process.exit(0);
}

/** 현재 모듈 소스로 번들을 그 자리에서 조립한다(_manifest.txt 순서 그대로) — installSrcOverride 가
 *  있으면 38_Install.js 자리에 그 내용을 대신 끼운다(뮤테이션 재현용). */
function buildBundle(installSrcOverride) {
  const manifest = fs.readFileSync(path.join(MODULES_DIR, "_manifest.txt"), "utf8").trim().split(/\r?\n/);
  return manifest.map((f) => {
    if (f === "38_Install.js" && installSrcOverride != null) return installSrcOverride;
    return fs.readFileSync(path.join(MODULES_DIR, f), "utf8");
  }).join("\n");
}

/** 격리된 임시 서빙 디렉터리를 만든다: index.html/css 는 실 public/ 을 그대로 읽어 응답하고,
 *  js/main.js 만 미리 조립된 문자열을 디스크에 물리적으로 써서 응답한다(Fetch 가로채기 경합 회피).
 *  🔴 실 public/js/main.js 는 절대 건드리지 않는다(읽기조차 하지 않음 — 이 파일은 조립 결과만 씀). */
function makeServeDir(bundleContent) {
  const dir = path.join(TMP_ROOT, "p86-serve-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(path.join(dir, "js"), { recursive: true });
  fs.writeFileSync(path.join(dir, "js", "main.js"), bundleContent);
  return dir;
}

function serveStatic(overlayDir) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    if (p === "/sw.js") { res.writeHead(404); res.end("nf"); return; } // SW 등록 차단(p42-cdp-real.mjs 와 동일 안전장치)
    // js/main.js 만 오버레이 디렉터리에서, 나머지는 실 public/ 에서 그대로 서빙
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

// p42-cdp-real.mjs 의 measureJs 와 동일한 대상(사이드바 조작요소) — 좌표/도구행이 실제로 같은
// 곳인지 대조하기 위해 그대로 재사용한다(SoT 드리프트 방지: 새 좌표 발명 금지).
const EDITOR_SETUP_JS = `
  (function(){
    document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
    document.getElementById('screen-app').classList.add('active');
    document.body.classList.remove('role-viewer');
    document.body.classList.add('role-designer');
    document.getElementById('section-projects').classList.remove('hidden');
    document.getElementById('project-actions').classList.remove('hidden');
    document.getElementById('project-current').textContent = 'ARCTIC VOYAGER E2E';
    document.getElementById('section-export').classList.remove('hidden');
    document.body.classList.add('sidebar-open');
    document.body.classList.add('tools-open');
    var gate = document.getElementById('login-gate');
    if (gate) { gate.classList.remove('on'); gate.classList.add('hidden'); }
    var tree = document.getElementById('side-tree');
    tree.innerHTML = '<div class="tree-node tree-node-deck" style="width:100%"><span class="tree-label">MAIN DECK</span></div>';
    return 'ok';
  })();
`;

const MEASURE_EDITOR_JS = `
  (function(){
    var targets = {
      '사각영역': document.querySelector('[data-deleg="btn-zone-rect"]'),
      '원형영역': document.querySelector('[data-deleg="btn-zone-circle"]'),
      '다각영역': document.querySelector('[data-deleg="btn-zone-poly"]'),
      '뷰어로배포': document.getElementById('btn-deploy')
    };
    var results = {}; var okCount = 0; var total = 0;
    for (var name in targets) {
      var el = targets[name];
      if (!el) { results[name] = { ok:false, reason:'NOT_FOUND' }; total++; continue; }
      total++;
      el.scrollIntoView({ block: 'nearest' });
      var r = el.getBoundingClientRect();
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var hit = document.elementFromPoint(cx, cy);
      var hitOk = !!hit && (hit === el || el.contains(hit) || (hit && hit.contains && hit.contains(el)));
      if (hitOk) okCount++;
      results[name] = { ok: hitOk, hitTag: hit ? (hit.tagName + (hit.id?('#'+hit.id):'')) : null };
    }
    var banner = document.getElementById('pwa-install-banner');
    var btn = document.getElementById('pwa-install-btn');
    return JSON.stringify({
      total, okCount, results,
      bannerHidden: banner ? banner.classList.contains('hidden') : true,
      btnDisplay: btn ? getComputedStyle(btn).display : 'none(no-el)'
    });
  })();
`;

async function runCase(installOverride) {
  const bundle = buildBundle(installOverride);
  const overlayDir = makeServeDir(bundle);
  const server = await serveStatic(overlayDir);
  const sitePort = server.address().port;
  const profileDir = path.join(TMP_ROOT, "cdp-p86-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--window-size=375,812",
    "about:blank",
  ], { stdio: "ignore" });
  try {
    await wait(800);
    const port = await readDevToolsPort(profileDir);
    const wsUrl = await getWsUrl(port);
    const ws = new WebSocket(wsUrl);
    await new Promise((r) => ws.on("open", r));
    await send(ws, "Page.enable");
    await send(ws, "Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
    const loadFired = new Promise((resolve) => {
      const h = (raw) => { const msg = JSON.parse(raw); if (msg.method === "Page.loadEventFired") { ws.removeListener("message", h); resolve(); } };
      ws.on("message", h);
    });
    await send(ws, "Page.navigate", { url: `http://127.0.0.1:${sitePort}/index.html` });
    await loadFired;
    await wait(700);

    // ① 허브(첫 화면) — #screen-app 비활성 상태 그대로, 모바일이면 배너 즉시 노출되는지 확인
    const hubCheck = await send(ws, "Runtime.evaluate", {
      expression: "document.getElementById('pwa-install-banner') ? document.getElementById('pwa-install-banner').classList.contains('hidden') : true",
      returnByValue: true,
    });
    const hubBannerHidden = !!hubCheck.result.value;

    // ② 편집 화면 진입 — MutationObserver 가 잡아 배너/버튼을 즉시 숨겨야 한다
    let editorOk = false;
    for (let attempt = 0; attempt < 3 && !editorOk; attempt++) {
      await send(ws, "Runtime.evaluate", { expression: EDITOR_SETUP_JS });
      await wait(250);
      const check = await send(ws, "Runtime.evaluate", { expression: "document.getElementById('screen-app').className", returnByValue: true });
      editorOk = String(check.result.value || "").includes("active");
      if (!editorOk) await wait(300);
    }
    if (!editorOk) throw new Error("EDITOR_SETUP_JS 적용 확인 실패");
    await wait(250); // MutationObserver 콜백 처리 대기

    const r = await send(ws, "Runtime.evaluate", { expression: MEASURE_EDITOR_JS, returnByValue: true });
    const data = JSON.parse(r.result.value);
    ws.close();
    return { hubBannerHidden, data };
  } finally {
    chrome.kill();
    server.close();
    await wait(300);
    try { fs.rmSync(overlayDir, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
  }
}

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };

async function main() {
  console.log("\n[① 허브(첫 화면) — 모바일 배너 즉시 노출 유지(회귀 없음)]");
  const baseline = await runCase(undefined);
  ok(baseline.hubBannerHidden === false, "① 편집화면 진입 전(#screen-app 비활성) — 배너 hidden=false(즉시 노출)");

  console.log("\n[② 편집 화면 진입 — 배너 숨김 + 상시버튼 숨김]");
  ok(baseline.data.bannerHidden === true, "② #screen-app.active 진입 후 배너 hidden=true");
  ok(baseline.data.btnDisplay === "none", "② #screen-app.active 진입 후 상시버튼 display=none (실제: " + baseline.data.btnDisplay + ")");

  console.log("\n[③ 사이드바 조작요소 겹침 0 — elementFromPoint 실측]");
  for (const name in baseline.data.results) {
    const it = baseline.data.results[name];
    ok(it.ok === true, `③ ${name} 히트테스트 통과(hitTag=${it.hitTag}) :: ${JSON.stringify(it)}`);
  }
  ok(baseline.data.okCount === baseline.data.total && baseline.data.total > 0,
    `③ 합계 ${baseline.data.okCount}/${baseline.data.total} 겹침 0`);

  // [WO 20260929-회귀수정] 가드가 showBanner()/_applyScreenVisibility() 등 여러 곳에 방어적으로
  // 중복돼 있어(의도된 설계) 한 곳만 지우면 나머지가 여전히 막는다 — 모든 가드가 의존하는
  // 단일 판정 함수(isEditorScreenActive)를 무력화해야 원래 결함(화면 구분 없음)이 정확히 재현된다.
  console.log("\n[뮤테이션] isEditorScreenActive() 를 항상 false 로 되돌림(화면 구분 제거) → ②③ 붕괴 확인");
  const installSrc = fs.readFileSync(path.join(MODULES_DIR, "38_Install.js"), "utf8");
  const needle = "    isEditorScreenActive() {\n      try {\n        const app = document.getElementById(\"screen-app\");\n        return !!(app && app.classList && app.classList.contains(\"active\"));\n      } catch (e) { return false; }\n    },";
  const mutated = installSrc.replace(needle, "    isEditorScreenActive() { return false; },");
  if (mutated === installSrc) {
    console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)");
    failed++;
  } else {
    const mutRun = await runCase(mutated);
    const overlapBroken = mutRun.data.bannerHidden === false || mutRun.data.okCount < mutRun.data.total;
    ok(overlapBroken, `뮤테이션 적용 시 편집화면에서도 배너 노출/겹침 발생(②③ 붕괴 증명) :: bannerHidden=${mutRun.data.bannerHidden} okCount=${mutRun.data.okCount}/${mutRun.data.total}`);
  }

  console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("ERROR", e); process.exit(1); });
