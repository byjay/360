// [WO 20260918 재조사] p42 의 기존 시뮬레이션(값 파싱+수식)은 세로(flex-shrink) 뭉개짐만 잡고
// 가로 폭 뭉개짐(.sidebar 의 max-width:30vw 잔존)은 못 잡았다 — 이번 결함이 그 증거다.
// 이 스크립트는 실제 헤드리스 Chrome(CDP)으로 public/index.html + 실제 3개 CSS 를 375×812 에 그대로
// 로드해 사이드바(바텀시트)를 연 뒤, 15개 조작요소 전부에 대해
//   (a) getBoundingClientRect 가 뷰포트 [0,375]x[0,812] 안에 완전히 들어오는가(가로/세로 모두)
//   (b) 그 중심점에서 document.elementFromPoint 가 실제로 그 요소(또는 자손)를 반환하는가(히트테스트)
// 를 검증한다. 실패하면 비0 종료.
import { spawn } from "child_process";
import WebSocket from "ws";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
// [WO 20260928 격리수정] 고정 포트(9337/8796)는 node --test 동시실행 시 다른 프로세스
// (p42 본체 자신 + p51 가 execFileSync 로 spawn 하는 사본)가 동시에 같은 포트를 bind 하려다
// EADDRINUSE 로 충돌한다(재현: 두 인스턴스 동시 실행 → 2번째가 EADDRINUSE:8796). port:0(OS 임의
// 할당)으로 프로세스마다 고유 포트를 받도록 고쳐 근본 원인(고정 포트)을 제거한다.
const ROOT = path.join(__dirname, "..", "public");

if (!fs.existsSync(CHROME)) {
  console.log("[SKIP] Chrome 실행파일을 찾지 못함(" + CHROME + ") — CDP 실측 생략, 정적 시뮬레이션(p42 본체)만으로 판정");
  process.exit(0);
}

function serveStatic() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const full = path.join(ROOT, p);
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
// Chrome 이 --remote-debugging-port=0 으로 뜰 때 실제 배정된 포트는 user-data-dir 안의
// DevToolsActivePort 파일 1행에 기록된다(고정 포트 대신 이 파일에서 읽어 충돌을 원천 차단).
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

const setupJs = `
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
    // 실 프로덕션에선 로그인된 디자이너는 이 게이트가 닫혀 있다(로그인 전 오버레이) — 인증 상태 재현
    var gate = document.getElementById('login-gate');
    if (gate) { gate.classList.remove('on'); gate.classList.add('hidden'); }
    var tree = document.getElementById('side-tree');
    // [WO 20260929-tree1] 🔴 #btn-delete-project 자체는 이제 #section-projects 와 함께 항상
    //   display:none(논리 앵커) — 실사용자는 트리 노드 안의 대리 버튼(.tree-project-actions)으로
    //   삭제한다(11_UI.js mountProjectNode, .click() 위임). 모바일 도달성도 그 대리 버튼 기준으로
    //   재현해야 실사용 경로를 검증한다(예전 목업은 옛 구조를 그대로 흉내내 거짓 PASS 위험).
    tree.innerHTML =
      '<div class="tree-project open"><button class="tree-node tree-node-project" style="width:100%"><span class="tree-label">ARCTIC VOYAGER E2E</span></button>' +
      '<div class="tree-project-actions"><button type="button" class="btn-mini">다운로드</button><button type="button" class="btn-mini danger">프로젝트 삭제</button></div>' +
      '<div class="tree-children"><div class="tree-node tree-node-deck" style="width:100%"><span class="tree-label">MAIN DECK</span></div>' +
      '<div class="tree-children"><div class="tree-node tree-node-doc"><span class="tree-label">도면1.pdf</span></div>' +
      '<div class="tree-node tree-node-pin"><span class="tree-label">핀1</span></div>' +
      '<div class="tree-node tree-node-pin"><span class="tree-label">핀2</span></div></div></div></div>';
    return 'ok';
  })();
`;

const measureJs = `
  (function(){
    var sb = document.getElementById('sidebar');
    var scrollH = sb.scrollHeight, clientH = sb.clientHeight;
    var maxScroll = Math.max(0, scrollH - clientH);
    var targets = {
      '+생성(프로젝트)': document.getElementById('btn-new-project'),
      '프로젝트삭제': document.querySelector('.tree-project-actions button.danger'), // [WO 20260929-tree1] 대리 버튼(실사용 경로)
      '도구토글': document.getElementById('stb-toggle'),
      '구역생성': document.querySelector('[data-deleg="btn-new-deck"]'),
      '도면등록': document.querySelector('[data-deleg="btn-upload-drawing"]'),
      '포인트': document.getElementById('btn-quickpoint'),
      '사각영역': document.querySelector('[data-deleg="btn-zone-rect"]'),
      '원형영역': document.querySelector('[data-deleg="btn-zone-circle"]'),
      '다각영역': document.querySelector('[data-deleg="btn-zone-poly"]'),
      '360사진인입': document.querySelector('[data-deleg="btn-theta-intake"]'),
      '체크보드모드': document.querySelector('[data-deleg="btn-checkboard-enter"]'),
      '사진폴더매칭': document.getElementById('btn-photobatch'),
      'MAIN_DECK트리': document.querySelector('.tree-node-deck'),
      '뷰어로배포': document.getElementById('btn-deploy')
    };
    var VW = window.innerWidth, VH = window.innerHeight;
    var results = {}; var okCount = 0; var total = 0;
    function tryScrollIntoView(el){
      // scrollIntoView 로 최선의 스크롤 위치를 잡은 뒤 rect/hit-test 재측정(실사용 시나리오: 사용자가 스크롤한다)
      el.scrollIntoView({ block: 'nearest' });
    }
    for (var name in targets) {
      var el = targets[name];
      if (!el) { results[name] = { ok:false, reason:'NOT_FOUND' }; total++; continue; }
      total++;
      tryScrollIntoView(el);
      var r = el.getBoundingClientRect();
      var inViewport = r.left >= -0.5 && r.top >= -0.5 && r.right <= VW + 0.5 && r.bottom <= VH + 0.5 && r.width > 0 && r.height > 0;
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var hit = inViewport ? document.elementFromPoint(cx, cy) : null;
      var hitOk = !!hit && (hit === el || el.contains(hit) || (hit && hit.contains && hit.contains(el)));
      var ok = inViewport && hitOk;
      if (ok) okCount++;
      results[name] = { ok, rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }, inViewport, hitOk,
        hitTag: hit ? (hit.tagName + (hit.id?('#'+hit.id):'') + (hit.className && typeof hit.className==='string' ? ('.'+hit.className.split(' ').join('.')) : '')) : null };
    }
    return JSON.stringify({ viewport: { w: VW, h: VH }, sidebarClientWidth: sb.clientWidth, total, okCount, results }, null, 1);
  })();
`;

async function run() {
  const server = await serveStatic();
  const sitePort = server.address().port;
  const profileDir = path.join(process.env.TEMP || "C:\\Windows\\Temp", "cdp-p42-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--window-size=375,812",
    "about:blank",
  ], { stdio: "ignore" });
  let exitCode = 1;
  try {
    await wait(800);
    const port = await readDevToolsPort(profileDir);
    const wsUrl = await getWsUrl(port);
    const ws = new WebSocket(wsUrl);
    await new Promise((r) => ws.on("open", r));
    await send(ws, "Page.enable");
    await send(ws, "Network.enable");
    await send(ws, "Fetch.enable", { patterns: [{ urlPattern: "*main.js*" }, { urlPattern: "*sw.js*" }] });
    ws.on("message", async (raw) => {
      const msg = JSON.parse(raw);
      if (msg.method === "Fetch.requestPaused") {
        const url = msg.params.request.url;
        if (url.includes("sw.js")) {
          await send(ws, "Fetch.fulfillRequest", { requestId: msg.params.requestId, responseCode: 404, body: "" });
        } else {
          await send(ws, "Fetch.fulfillRequest", {
            requestId: msg.params.requestId,
            responseCode: 200,
            responseHeaders: [{ name: "Content-Type", value: "application/javascript" }],
            body: Buffer.from("// stub — CSS 레이아웃 실측 전용\n").toString("base64"),
          });
        }
      }
    });
    await send(ws, "Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
    const loadFired = new Promise((resolve) => {
      const h = (raw) => {
        const msg = JSON.parse(raw);
        if (msg.method === "Page.loadEventFired") { ws.removeListener("message", h); resolve(); }
      };
      ws.on("message", h);
    });
    await send(ws, "Page.navigate", { url: `http://127.0.0.1:${sitePort}/index.html` });
    await loadFired;
    await wait(600);
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      await send(ws, "Runtime.evaluate", { expression: setupJs });
      await wait(250);
      const check = await send(ws, "Runtime.evaluate", { expression: "document.getElementById('screen-app').className", returnByValue: true });
      ok = String(check.result.value || "").includes("active");
      if (!ok) await wait(300);
    }
    if (!ok) throw new Error("setupJs 적용 확인 실패");
    const r = await send(ws, "Runtime.evaluate", { expression: measureJs, returnByValue: true });
    const data = JSON.parse(r.result.value);
    console.log(`[CDP-REAL] sidebarClientWidth=${data.sidebarClientWidth} viewport=${data.viewport.w}x${data.viewport.h}`);
    for (const name in data.results) {
      const it = data.results[name];
      console.log(`  [${it.ok ? "PASS" : "FAIL"}] ${name} :: ${JSON.stringify(it)}`);
    }
    console.log(`\n합격기준: 조작요소 전부 화면안+히트테스트 통과 => ${data.okCount}/${data.total}`);
    exitCode = data.okCount === data.total && data.total > 0 ? 0 : 1;
    ws.close();
  } finally {
    chrome.kill();
    server.close();
    await wait(300);
  }
  process.exit(exitCode);
}

run().catch((e) => { console.error("ERROR", e); process.exit(1); });
