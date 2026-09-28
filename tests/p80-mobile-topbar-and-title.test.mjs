/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p80-mobile-topbar-and-title.test.mjs)
 *
 * 배경 — 전수 점검 에이전트 실측(HEAD 21f77b4, 375×812 헤드리스 Chrome 실클릭,
 * 스크린샷 .tmp/audit/46-mobile-app-root.png · 08b-zone-created-settled.png):
 *
 * FAIL-2 (상단) : 편집화면 3모드 세그먼트(#regmode-seg, 보기/체크보드/사진등록) 앞에 오는
 *   브랜드 로고(brand-logo-top)·상태 텍스트가 375px 폭을 먼저 차지해 "사진 등록" 버튼이
 *   화면 밖으로 완전히 밀려났다(가로 스크롤 없이는 도달 불가 — 요구는 스크롤 없이 화면 안).
 *   수정: public/css/style.css @media(max-width:760px) 에 `#btn-back, #regmode-seg { order:-1; }`
 *   — DOM 순서는 그대로, flex order 로 두 요소만 topbar 맨 앞으로 당긴다.
 *
 * FAIL-2 (하단) : #pwa-install-btn("앱 설치", index.html 인라인 style, bottom:16px 고정,
 *   z-index:10000)이 모바일 하단 도크(.mobile-dock, 높이 var(--mdock-h)=58px, z-index:140)를
 *   전혀 모르고 항상 화면 맨 아래에 뜬다 → 도크의 "목록"·"업로드" 칩을 그대로 덮어 글자가
 *   잘려 보였다(마스터가 본 "다운로드 잘림" — 실제로는 업로드 칩이 "로드"만 삐져나온 것).
 *   수정: public/css/style.css @media(max-width:760px) 에
 *   `#pwa-install-btn { bottom: calc(var(--mdock-h) + env(safe-area-inset-bottom,0) + 12px) !important; }`
 *   (.pwa-install-banner 와 동일 SoT 변수 재사용, 값 중복 정의 0).
 *
 * 관찰-3 (헤더 제목) : 구역/영역을 열어도(생성 직후 포함) 상단 헤더 제목(#file-name-label)이
 *   원본 도면 파일명("test-drawing.pdf")에 그대로 머물렀다(08b-zone-created-settled.png,
 *   사이드바는 "구역A"인데 헤더는 여전히 파일명). 공유 지점(§G-2-5) _applyDeckCropView(31_Projects.js)
 *   — selectDeck(트리에서 열기)과 createDeckFromLoadedDrawing(생성 직후)이 둘 다 거치는 유일한
 *   합류점 — 에 제목 갱신을 한 곳에서만 추가.
 *
 * 검사(실 브라우저 375×812, puppeteer, 실제 CSS 3파일 캐스케이드):
 *  ① #regmode-seg 의 버튼 3개(보기/체크보드/사진등록)가 전부 뷰포트 안(right ≤ 375, 스크롤 없이)
 *  ② 버튼 3개 전부 높이 ≥44px(터치 타깃)
 *  ③ #pwa-install-btn 의 top 이 .mobile-dock 의 top 보다 위(수직 겹침 0)
 *  ④ _applyDeckCropView({name:"구역A"}) 호출 후 #file-name-label.textContent === "구역A"
 *     (createDeckFromLoadedDrawing 생성 직후와 selectDeck 트리열기가 공유하는 지점 — 재현)
 *
 * 뮤테이션 3건, 각 EXIT=1 확인 후 원복:
 *  ⓐ `#btn-back, #regmode-seg { order: -1; }` 제거 → ①이 실패해야 함
 *  ⓑ `#pwa-install-btn{ bottom: ... !important; }` 제거 → ③이 실패해야 함
 *  ⓒ _applyDeckCropView 의 제목 갱신 블록 제거 → ④가 실패해야 함
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const indexHtml = rd("public/index.html");
const cssStyle = rd("public/css/style.css");
const uiSrc = rd("public/js/modules/11_UI.js");
const promptSrc = rd("public/js/modules/30_Prompt.js");
const projectsSrc = rd("public/js/modules/31_Projects.js");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };

async function withBrowser(fn) {
  const require = createRequire("file:///C:/Users/FREE/package.json");
  let puppeteer = null;
  try { puppeteer = require("puppeteer"); } catch (e) { puppeteer = null; }
  if (!puppeteer) { console.log("  FAIL puppeteer 를 로드할 수 없다 — 실 브라우저 검증 불가(증거 없는 PASS 금지)"); failed++; return; }
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try { await fn(browser); } finally { await browser.close(); }
}

function serveDir(dir) {
  const PUB = path.join(ROOT, "public");
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    if (u.startsWith("/css/") || u.startsWith("/images/") || u.startsWith("/js/")) {
      const f = path.join(PUB, u);
      if (fs.existsSync(f)) {
        const ct = u.endsWith(".css") ? "text/css" : u.endsWith(".js") ? "text/javascript" : "application/octet-stream";
        res.writeHead(200, { "content-type": ct }); res.end(fs.readFileSync(f)); return;
      }
    }
    const f = path.join(dir, u === "/" ? "index.html" : u);
    if (!f.startsWith(dir) || !fs.existsSync(f)) { res.writeHead(404); res.end("nf"); return; }
    const ct = f.endsWith(".html") ? "text/html" : f.endsWith(".css") ? "text/css" : "text/javascript";
    res.writeHead(200, { "content-type": ct });
    res.end(fs.readFileSync(f));
  });
  return new Promise((resolve) => { listenSafePort(server, "127.0.0.1").then(() => resolve(server)); });
}

/* ══════════════════════════════════════════════════════════
 * Part A — 실제 public/index.html + CSS 3파일로 #topbar/#regmode-seg/#pwa-install-btn 측정
 *   (JS 번들은 로드하지 않는다 — 순수 레이아웃/CSS 검증. pwa-install-btn 은 인라인 script 로 만들어지므로
 *   그 script 블록만 최소 재현: 실제 index.html 의 makeBtn()cssText 를 그대로 씀 — 값 중복 0, 재현 정확).
 * ══════════════════════════════════════════════════════════ */
function buildLayoutHtml(cssSrc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p80-"));
  // 🔴 /css/style.css 는 serveDir() 가 PUB(진짜 public/css/)로 가로채므로(다른 두 CSS 파일은 그대로
  // 재사용해야 하니 그 라우팅을 유지) 변형본(mutated)은 반드시 다른 경로(/style.css, dir 루트)로 서빙한다
  // — 안 그러면 뮤테이션이 실제로는 반영되지 않은 채 "PASS"가 나오는 거짓 초록(§G-2 위반)이 된다.
  fs.writeFileSync(path.join(dir, "style.css"), cssSrc, "utf8");
  const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/css/seastar-family-tokens.css">
<link rel="stylesheet" href="/css/seastar-3d-skin.css">
<style>.hidden{display:none!important}</style>
</head><body>
<div id="screen-app" class="screen active">
  <header id="topbar" class="topbar">
    <button id="btn-back" class="btn-icon" type="button">back</button>
    <div id="brand-logo-top" class="brand-logo brand-logo-top brand-logo--img"><img class="brand-logo-img" src="/images/logo.png" alt="SEASTAR" /></div>
    <div id="topbar-dot" class="topbar-dot"></div>
    <span id="mode-label" class="mode-label">편집모드</span>
    <span class="topbar-sep">·</span>
    <span id="file-name-label" class="file-name-label">test-drawing.pdf</span>
    <div id="regmode-seg" class="regmode-seg designer-only" role="group" aria-label="편집 모드 선택">
      <button id="btn-regmode-view" class="regmode-btn active" type="button">보기</button>
      <button id="btn-regmode-checkboard" class="regmode-btn" type="button">체크보드</button>
      <button id="btn-regmode-photo" class="regmode-btn" type="button">사진 등록</button>
    </div>
    <button id="btn-save" class="btn-save" type="button">저장</button>
  </header>
  <nav class="mobile-dock">
    <div class="mdock-bar">
      <button class="mdock-chip" type="button"><span>메뉴</span></button>
      <button class="mdock-chip" type="button"><span>목록</span></button>
      <button id="mdock-upload" class="mdock-chip" type="button"><span>업로드</span></button>
    </div>
  </nav>
</div>
<script>
  // index.html 의 makeBtn() 인라인 style 재현 (경로: public/index.html #pwa-install-btn 생성부, 값 동일)
  var b = document.createElement('button');
  b.id = 'pwa-install-btn';
  b.innerHTML = '<span>앱 설치</span>';
  b.style.cssText = 'position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom));z-index:10000;display:flex;';
  document.body.appendChild(b);
</script>
</body></html>`;
  fs.writeFileSync(path.join(dir, "index.html"), HTML, "utf8");
  return dir;
}

console.log("\n[Part A · 모바일 375×812 — 상단 3모드 세그먼트 + 하단 설치버튼 겹침]");
await withBrowser(async (browser) => {
  const dir = buildLayoutHtml(cssStyle);
  const server = await serveDir(dir);
  const port = server.address().port;
  const page = await browser.newPage();
  await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2 });
  await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "load" });

  const m = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("#regmode-seg .regmode-btn"));
    const rects = btns.map((b) => b.getBoundingClientRect());
    const installBtn = document.getElementById("pwa-install-btn");
    const dock = document.querySelector(".mobile-dock");
    return {
      count: btns.length,
      rights: rects.map((r) => r.right),
      heights: rects.map((r) => r.height),
      vw: window.innerWidth,
      installTop: installBtn ? installBtn.getBoundingClientRect().top : null,
      installBottomCss: installBtn ? getComputedStyle(installBtn).bottom : null,
      dockTop: dock ? dock.getBoundingClientRect().top : null
    };
  });
  console.log("  [실측] regmode-btn rights=" + JSON.stringify(m.rights) + " vw=" + m.vw + " heights=" + JSON.stringify(m.heights));
  ok(m.count === 3, "사전조건 — 3모드 버튼 3개 존재(실제 " + m.count + ")");
  ok(m.rights.every((r) => r <= m.vw), "① 3버튼 모두 뷰포트 안(스크롤 없이) — right ≤ " + m.vw + " (실제 " + JSON.stringify(m.rights) + ")");
  ok(m.heights.every((h) => h >= 44), "② 3버튼 모두 터치타깃 높이 ≥44px (실제 " + JSON.stringify(m.heights) + ")");
  console.log("  [실측] pwa-install-btn top=" + m.installTop + " computed-bottom=" + m.installBottomCss + " / mobile-dock top=" + m.dockTop);
  ok(m.installTop != null && m.dockTop != null && m.installTop < m.dockTop,
    "③ #pwa-install-btn 이 .mobile-dock 위(수직 겹침 0) — installTop(" + m.installTop + ") < dockTop(" + m.dockTop + ")");

  server.close();
});

console.log("\n[뮤테이션ⓐ] `#btn-back, #regmode-seg { order: -1; }` 제거 → ①이 실패해야 함");
await withBrowser(async (browser) => {
  const needle = "#btn-back, #regmode-seg { order: -1; }";
  const mutated = cssStyle.replace(needle, "");
  if (mutated === cssStyle) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; return; }
  const dir = buildLayoutHtml(mutated);
  const server = await serveDir(dir);
  const port = server.address().port;
  const page = await browser.newPage();
  await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2 });
  await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "load" });
  const m = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("#regmode-seg .regmode-btn"));
    return { rights: btns.map((b) => b.getBoundingClientRect().right), vw: window.innerWidth };
  });
  console.log("  [뮤테이션 실측] rights=" + JSON.stringify(m.rights) + " vw=" + m.vw);
  ok(!m.rights.every((r) => r <= m.vw), "뮤테이션 적용 시 버튼 중 하나 이상이 뷰포트 밖으로 밀려난다(①이 깨짐을 확인)");
  server.close();
});

console.log("\n[뮤테이션ⓑ] `#pwa-install-btn{ bottom:... !important; }` 제거 → ③이 실패해야 함");
await withBrowser(async (browser) => {
  const needle = /#pwa-install-btn\{[^}]*!important;\s*\}/;
  if (!needle.test(cssStyle)) { console.log("  FAIL 뮤테이션 대상 패턴을 찾지 못함(소스 변경?)"); failed++; return; }
  const mutated = cssStyle.replace(needle, "");
  const dir = buildLayoutHtml(mutated);
  const server = await serveDir(dir);
  const port = server.address().port;
  const page = await browser.newPage();
  await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2 });
  await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "load" });
  const m = await page.evaluate(() => {
    const installBtn = document.getElementById("pwa-install-btn");
    const dock = document.querySelector(".mobile-dock");
    return { installTop: installBtn.getBoundingClientRect().top, dockTop: dock.getBoundingClientRect().top };
  });
  console.log("  [뮤테이션 실측] installTop=" + m.installTop + " dockTop=" + m.dockTop);
  ok(!(m.installTop < m.dockTop), "뮤테이션 적용 시 설치버튼이 도크와 겹치거나 아래로 내려간다(③이 깨짐을 확인)");
  server.close();
});

/* ══════════════════════════════════════════════════════════
 * Part B — _applyDeckCropView 제목 갱신(관찰-3) — 31_Projects.js 실 소스 + 최소 스텁
 * ══════════════════════════════════════════════════════════ */
function buildTitleBundle(projSource) {
  return "(function(){\n" + uiSrc + "\n" + promptSrc + "\n" + projSource +
    "\nwindow.Projects = Projects; window.UI = UI; window.Prompt = Prompt;\n})();\n";
}
function titleHarnessDir(bundleSrc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p80t-"));
  fs.writeFileSync(path.join(dir, "bundle.js"), bundleSrc, "utf8");
  const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<span id="file-name-label">test-drawing.pdf</span>
<script>
  window.State = { fileName: "test-drawing.pdf" };
  window.PDF = { setDeckCrop() {} };
  window.MapCtrl = { fit() {}, fitZone() {} };
</script>
<script src="./bundle.js"></script>
</body></html>`;
  fs.writeFileSync(path.join(dir, "index.html"), HTML, "utf8");
  return dir;
}

console.log("\n[Part B · 관찰-3 — _applyDeckCropView 호출 후 헤더 제목이 구역 이름으로 갱신]");
await withBrowser(async (browser) => {
  const dir = titleHarnessDir(buildTitleBundle(projectsSrc));
  const server = await serveDir(dir);
  const port = server.address().port;
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "load" });
  const before = await page.evaluate(() => document.getElementById("file-name-label").textContent);
  await page.evaluate(() => { window.Projects._applyDeckCropView({ name: "구역A", crop: null }); });
  const after = await page.evaluate(() => document.getElementById("file-name-label").textContent);
  console.log("  [실측] before=" + before + " after=" + after);
  ok(before === "test-drawing.pdf", "사전조건 — 호출 전 제목은 원본 파일명");
  ok(after === "구역A", "④ _applyDeckCropView({name:'구역A'}) 호출 후 헤더 제목 = '구역A' (실제 " + after + ")");
  server.close();
});

console.log("\n[뮤테이션ⓒ] _applyDeckCropView 의 제목 갱신 블록 제거 → ④가 실패해야 함");
await withBrowser(async (browser) => {
  const needle = 'UI.text("file-name-label", (d && d.name) ? d.name : "도면 없음");';
  const mutated = projectsSrc.replace(needle, '/* 제목 갱신 제거됨 */');
  if (mutated === projectsSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; return; }
  const dir = titleHarnessDir(buildTitleBundle(mutated));
  const server = await serveDir(dir);
  const port = server.address().port;
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "load" });
  await page.evaluate(() => { window.Projects._applyDeckCropView({ name: "구역A", crop: null }); });
  const after = await page.evaluate(() => document.getElementById("file-name-label").textContent);
  console.log("  [뮤테이션 실측] after=" + after);
  ok(after !== "구역A", "뮤테이션 적용 시 제목이 갱신되지 않고 원본 파일명에 머문다(④가 깨짐을 확인, 실제 " + after + ")");
  server.close();
});

console.log(failed === 0 ? "\n[ALL PASS]" : "\n[" + failed + " FAILED]");
process.exit(failed === 0 ? 0 : 1);
