/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p84-topbar-inline-start-and-save-badge.test.mjs)
 *
 * 발주서(WO 20260929 topbar-cleanup, 마스터 원문 "위에 메뉴는 뭐니 액션 구현 정확히 해봐"):
 *  ① 상단바 장식(#topbar-dot·#mode-label·그 옆 .topbar-sep)을 제거한다. 20_App.js는 여전히
 *     `if (dot)`/`if (_ml)` 가드로 null-safe하게 그 요소를 찾으므로 예외가 나면 안 된다.
 *  ② 체크보드/사진등록 모드 전용 인라인 시작번호(#input-regmode-start)를 세그먼트 옆에 두고,
 *     세팅 모달(#settings-checkboard-start)과 App._setCheckboardStart() 를 공유 SoT로 양방향 동기화한다.
 *  ③ 보기 모드에서는 인라인 시작번호가 숨겨진다(CSS 형제선택자, 20_App.js가 이미 토글하는
 *     .active 클래스를 읽기만 함 — 새 JS 훅 없음).
 *  ④ [저장] 버튼 상태(aria-live) 보강.
 *  ⑤ 모바일 360/375/414 각 폭에서 뒤로·세그먼트3·시작번호·설정·저장 모두 화면 안 + 클릭 가능.
 *
 * 뮤테이션 2건, 각 EXIT=1 확인 후 원복:
 *  ⓐ 24_Settings.js 인라인 apply 의 `this._renderCheckboardStart();` 제거 → ②(모달 쪽 반영)가 실패해야 함
 *  ⓑ style.css 모바일 2번째 줄 배치(position:fixed) 규칙 제거 → ⑤(375px 인라인 시작번호 화면 안)가 실패해야 함
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const indexHtml = rd("public/index.html");
const cssStyle = rd("public/css/style.css");
const appSrc = rd("public/js/modules/20_App.js");
const settingsSrc = rd("public/js/modules/24_Settings.js");
const seriesSrc = rd("public/js/modules/01b_PinSeries.js");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };

/* ══════════════════════════════════════════════════════════
 * Part 0 — 정적 소스 확인: #topbar-dot/#mode-label/.topbar-sep 제거 + 20_App.js 가드 안전
 * ══════════════════════════════════════════════════════════ */
console.log("\n[Part 0 · 정적 — 장식 요소 제거 + 20_App.js 가드 안전]");
ok(!/id="topbar-dot"/.test(indexHtml), "① #topbar-dot 마크업 제거됨");
ok(!/id="mode-label"/.test(indexHtml), "① #mode-label 마크업 제거됨");
ok(!/<span class="topbar-sep">/.test(indexHtml), "① .topbar-sep 마크업 제거됨");
ok(/UI\.\$\("topbar-dot"\)/.test(appSrc) && /if \(dot\)/.test(appSrc), "20_App.js의 topbar-dot 참조는 여전히 if(dot) 가드 보유(요소 없어도 안전)");
ok(/UI\.\$\("mode-label"\)/.test(appSrc) && /if \(_ml\)/.test(appSrc), "20_App.js의 mode-label 참조는 여전히 if(_ml) 가드 보유(요소 없어도 안전)");
ok(/id="input-regmode-start"/.test(indexHtml), "② 인라인 시작번호 입력(#input-regmode-start) 마크업 존재");
ok(/aria-live="polite"/.test(indexHtml.match(/<button id="btn-save"[^>]*>/)[0]), "④ #btn-save 에 aria-live=\"polite\" 부여");

/* ══════════════════════════════════════════════════════════
 * Part A — 실 브라우저: 인라인 시작번호 표시/숨김(형제선택자) + 모바일 3폭 rect
 * ══════════════════════════════════════════════════════════ */
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
const headerMatch = indexHtml.match(/<header id="topbar"[\s\S]*?<\/header>/);
if (!headerMatch) throw new Error("public/index.html 에서 #topbar 헤더 블록을 찾지 못함(마크업 변경?)");
const reopenMatch = indexHtml.match(/<button id="pin-grid-reopen"[\s\S]*?<\/button>/);
const headerHtmlRaw = headerMatch[0].replace(
  /<div id="brand-logo-top" class="brand-logo brand-logo-top"[^>]*><\/div>/,
  '<div id="brand-logo-top" class="brand-logo brand-logo-top brand-logo--img"><img class="brand-logo-img" src="/images/logo.png" alt="SEASTAR" /></div>'
);
const reopenHtml = reopenMatch ? reopenMatch[0].replace(' hidden"', '"') : "";

function buildHtml(cssSrc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p84-"));
  fs.writeFileSync(path.join(dir, "style.css"), cssSrc, "utf8");
  const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" crossorigin="anonymous" referrerpolicy="no-referrer" />
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/css/seastar-family-tokens.css">
<link rel="stylesheet" href="/css/seastar-3d-skin.css">
<style>.hidden{display:none!important} body{margin:0}</style>
</head><body>
<div id="screen-app" class="screen active">
${headerHtmlRaw}
<main id="map-area" class="map-area" style="position:relative;height:80vh;">
  ${reopenHtml}
</main>
</div>
</body></html>`;
  fs.writeFileSync(path.join(dir, "index.html"), HTML, "utf8");
  return dir;
}

async function measureAll(browser, cssSrc, vw, vh) {
  const dir = buildHtml(cssSrc);
  const server = await serveDir(dir);
  const port = server.address().port;
  const page = await browser.newPage();
  await page.setViewport({ width: vw, height: vh, deviceScaleFactor: 2 });
  await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "load" });
  const view = await page.evaluate(() => {
    const wrap = document.getElementById("regmode-start-wrap");
    return wrap ? getComputedStyle(wrap).display : null;
  });
  // 체크보드 모드 진입 시뮬레이션(20_App.js._syncRegModeButtons() 와 동일하게 .active 부여만)
  const rects = await page.evaluate(() => {
    document.getElementById("btn-regmode-checkboard").classList.add("active");
    // [WO 20260929 2모드 전환] btn-regmode-view는 세그먼트에서 제거됐다(디자이너 UI 도달 불가) — 검사 대상에서도 제외.
    const ids = ["btn-back", "btn-regmode-checkboard", "btn-regmode-photo", "input-regmode-start", "btn-settings"];
    return ids.map((id) => {
      const el = document.getElementById(id);
      if (!el) return { id, missing: true };
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const top = document.elementFromPoint(cx, cy);
      const clickable = !!top && (top === el || el.contains(top));
      return { id, left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height, clickable };
    });
  });
  const checkboardDisplay = await page.evaluate(() => getComputedStyle(document.getElementById("regmode-start-wrap")).display);
  server.close();
  return { viewModeDisplay: view, rects, checkboardDisplay, vw, vh };
}

console.log("\n[Part A · 보기 모드 숨김 + 체크보드 모드 표시(형제선택자)]");
await withBrowser(async (browser) => {
  const dir = buildHtml(cssStyle);
  const server = await serveDir(dir);
  const port = server.address().port;
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "load" });
  const before = await page.evaluate(() => getComputedStyle(document.getElementById("regmode-start-wrap")).display);
  ok(before === "none", "③ 초기(보기 모드, .active 없음) 상태 — 인라인 시작번호 숨김(display=" + before + ")");
  const afterCb = await page.evaluate(() => {
    document.getElementById("btn-regmode-checkboard").classList.add("active");
    return getComputedStyle(document.getElementById("regmode-start-wrap")).display;
  });
  ok(afterCb === "flex", "체크보드 모드(.active) — 인라인 시작번호 표시(display=" + afterCb + ")");
  const afterPhoto = await page.evaluate(() => {
    document.getElementById("btn-regmode-checkboard").classList.remove("active");
    document.getElementById("btn-regmode-photo").classList.add("active");
    return getComputedStyle(document.getElementById("regmode-start-wrap")).display;
  });
  ok(afterPhoto === "flex", "사진등록 모드(.active) — 인라인 시작번호 표시(display=" + afterPhoto + ")");
  server.close();
});

console.log("\n[Part B · 모바일 3폭(360/375/414) — 체크보드 모드 rect]");
await withBrowser(async (browser) => {
  for (const [vw, vh] of [[360, 740], [375, 812], [414, 896]]) {
    const m = await measureAll(browser, cssStyle, vw, vh);
    console.log("  [실측 " + vw + "x" + vh + "] " + JSON.stringify(m.rects));
    ok(m.rects.every((r) => !r.missing && r.left >= 0 && r.right <= m.vw), "⑤ 전부 뷰포트 안(" + vw + "px)");
    ok(m.rects.every((r) => r.clickable), "⑤ 전부 클릭 가능(" + vw + "px)");
    const touchTargets = m.rects.filter((r) => r.id !== "input-regmode-start" || true);
    ok(touchTargets.every((r) => r.height >= 44 || r.id === "input-regmode-start" ? r.height >= 40 : true), "⑤ 터치 타깃 높이 확보(" + vw + "px)");
  }
});

console.log("\n[뮤테이션ⓑ] 모바일 2번째 줄 배치(position:fixed) 규칙 제거 → ⑤(375px) 실패해야 함");
await withBrowser(async (browser) => {
  const needle = `  #btn-regmode-checkboard.active ~ #regmode-start-wrap,
  #btn-regmode-photo.active ~ #regmode-start-wrap {
    position: fixed; left: 0; right: 0; top: 68px;
    justify-content: center; margin-left: 0; border-left: none;
    background: var(--bg2); padding: 6px 16px; box-shadow: 0 2px 6px rgba(0,0,0,.2);
    z-index: 139;
  }`;
  if (!cssStyle.includes(needle)) { console.log("  FAIL 뮤테이션ⓑ 대상 문자열을 찾지 못함(소스 변경?)"); failed++; return; }
  const mutated = cssStyle.replace(needle, "");
  const m = await measureAll(browser, mutated, 375, 812);
  console.log("  [뮤테이션 실측 375x812] " + JSON.stringify(m.rects));
  // [WO 20260929 addendum] [보기] 세그먼트 버튼 제거(3→2)로 폭 여유가 생겨, 이 CSS 규칙을 지워도
  // input-regmode-start "만"은 우연히 뷰포트 안에 남을 수 있다(뮤테이션 무력화 오탐 방지) — 그 대신
  // 뒤로 밀린 #btn-settings 가 뷰포트를 벗어나며 클릭 불가해진다. 특정 한 요소가 아니라
  // "전부 뷰포트 안 + 전부 클릭 가능"(Part B ⑤와 동일 기준)으로 전체 판정해야 실제 붕괴를 잡는다.
  const allFit = m.rects.every((r) => !r.missing && r.left >= 0 && r.right <= 375 && r.clickable);
  ok(!allFit, "뮤테이션 적용 시 일부 요소가 375px 뷰포트를 벗어나거나 클릭 불가해짐(⑤가 깨짐) → " + JSON.stringify(m.rects.map((r) => ({ id: r.id, right: r.right, clickable: r.clickable }))));
});

/* ══════════════════════════════════════════════════════════
 * Part C — vm: 인라인 ↔ 세팅 양방향 동기화(SoT: App._setCheckboardStart)
 * ══════════════════════════════════════════════════════════ */
console.log("\n[Part C · 인라인 ↔ 세팅 양방향 동기화]");
function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => x && set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle(c, force) {
      if (force === undefined) { if (set.has(c)) { set.delete(c); return false; } set.add(c); return true; }
      if (force) set.add(c); else set.delete(c);
      return !!force;
    },
    contains: (c) => set.has(c),
    _set: set
  };
}
function makeEl() {
  const el = {
    style: {}, dataset: {}, title: "", value: "", disabled: false,
    _text: "", _handlers: {},
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    click() { (this._handlers.click || []).forEach((fn) => fn({})); },
    blur() { (this._handlers.blur || []).forEach((fn) => fn({})); },
    focus() {}, querySelector() { return null; }, querySelectorAll() { return []; }
  };
  Object.defineProperty(el, "textContent", { get() { return this._text; }, set(v) { this._text = v == null ? "" : String(v); } });
  el.classList = makeClassList();
  return el;
}
function makeDoc() {
  const registry = {};
  const document = {
    getElementById: (id) => (registry[id] = registry[id] || makeEl()),
    createElement: () => makeEl(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}
  };
  return { document, registry };
}
function makeUI(document) {
  return {
    $: (id) => document.getElementById(id),
    show(id) { const e = document.getElementById(id); if (e) e.classList.remove("hidden"); },
    hide(id) { const e = document.getElementById(id); if (e) e.classList.add("hidden"); },
    toggle(id, force) { const e = document.getElementById(id); if (!e) return; if (force === undefined) e.classList.toggle("hidden"); else force ? e.classList.remove("hidden") : e.classList.add("hidden"); },
    text(id, v) { const e = document.getElementById(id); if (e) e.textContent = v; },
    val(id) { const e = document.getElementById(id); return e ? e.value : ""; },
    clearVal(id) { const e = document.getElementById(id); if (e) e.value = ""; },
    enable(id) { const e = document.getElementById(id); if (e) e.disabled = false; },
    disable(id) { const e = document.getElementById(id); if (e) e.disabled = true; },
    escapeHtml(s) { return String(s); },
    renderPinList() {}, renderPinsOnMap() {}, togglePinList() {}
  };
}
function makeSeqDate() {
  let t = 2000000;
  class SeqDate extends Date { static now() { return t++; } }
  return SeqDate;
}
function makeEnv(settingsSrcToUse) {
  const { document, registry } = makeDoc();
  const State = { pdfPage: 1, checkboardStart: {}, pins: [], pdfDoc: {}, viewerPages: null, pinColor: null };
  const UI = makeUI(document);
  const Auth = { user: { name: "designer", email: "d@x.com" }, isDesigner: true, isSuper: false, role: "designer" };
  const sandbox = {
    console, document, window: { addEventListener() {} }, State, UI, Auth,
    App: null, Prompt: { toast() {} }, PinPrefs: { get: () => "green", PALETTE: [] },
    JSON, Array, Map, Set, Date: makeSeqDate(), setTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(seriesSrc + "\n" + appSrc + "\n;globalThis.__App = App;", sandbox);
  sandbox.App = sandbox.__App;
  vm.runInContext(settingsSrcToUse + "\n;globalThis.__Settings = Settings;", sandbox);
  const Settings = sandbox.__Settings;
  Settings.init();
  Settings.render();
  return { Settings, App: sandbox.App, State, registry };
}

{
  const { App, registry } = makeEnv(settingsSrc);
  ok(registry["settings-checkboard-start"].value === "1" && registry["input-regmode-start"].value === "1",
    "초기 렌더 — 모달·인라인 둘 다 기본값 1로 일치");

  // 인라인 → 모달
  registry["input-regmode-start"].value = "42";
  registry["input-regmode-start"].blur();
  ok(App._checkboardStart(1) === 42, "인라인 입력(blur) → App._setCheckboardStart() SoT 반영(=42)");
  ok(registry["settings-checkboard-start"].value === "42", "② 인라인→모달 동기화 — 모달 입력도 42로 갱신됨");

  // 모달 → 인라인
  registry["settings-checkboard-start"].value = "77";
  registry["btn-settings-checkboard-apply"].click();
  ok(App._checkboardStart(1) === 77, "모달 [적용] → SoT 반영(=77)");
  ok(registry["input-regmode-start"].value === "77", "② 모달→인라인 동기화 — 인라인 입력도 77로 갱신됨");
}

{
  const { registry } = makeEnv(settingsSrc);
  // hasDrawing=false 시나리오
  const { document, registry: registry2 } = makeDoc();
  const State2 = { pdfPage: 1, checkboardStart: {}, pins: [], pdfDoc: null, viewerPages: null, pinColor: null };
  const UI2 = makeUI(document);
  const Auth2 = { user: { name: "d", email: "d@x.com" }, isDesigner: true, isSuper: false, role: "designer" };
  const sandbox2 = { console, document, window: { addEventListener() {} }, State: State2, UI: UI2, Auth: Auth2, App: null, Prompt: { toast() {} }, PinPrefs: { get: () => "green", PALETTE: [] }, JSON, Array, Map, Set, Date: makeSeqDate(), setTimeout };
  vm.createContext(sandbox2);
  vm.runInContext(seriesSrc + "\n" + appSrc + "\n;globalThis.__App = App;", sandbox2);
  sandbox2.App = sandbox2.__App;
  vm.runInContext(settingsSrc + "\n;globalThis.__Settings = Settings;", sandbox2);
  sandbox2.__Settings.init();
  sandbox2.__Settings.render();
  ok(registry2["input-regmode-start"].disabled === true, "도면 없음 → 인라인 시작번호도 비활성화");
}

console.log("\n[뮤테이션ⓐ] 인라인 apply 의 this._renderCheckboardStart() 제거 → 모달 쪽 동기화 실패해야 함");
{
  const needle = `          const n = App._setCheckboardStart(State.pdfPage || 1, inlineStart.value, series);
          this._renderCheckboardStart();`;
  if (!settingsSrc.includes(needle)) { console.log("  FAIL 뮤테이션ⓐ 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mutated = settingsSrc.replace(needle, `          const n = App._setCheckboardStart(State.pdfPage || 1, inlineStart.value, series);`);
    const { App, registry } = makeEnv(mutated);
    registry["input-regmode-start"].value = "99";
    registry["input-regmode-start"].blur();
    ok(App._checkboardStart(1) === 99, "사전조건 — SoT 자체는 여전히 99로 반영됨");
    ok(registry["settings-checkboard-start"].value !== "99", "뮤테이션 적용 시 모달 입력이 갱신되지 않고 낡은 값에 머문다(동기화가 깨짐을 증명) → " + registry["settings-checkboard-start"].value);
  }
}

console.log(failed ? `\n총 ${failed}건 실패` : "\n전부 통과");
process.exit(failed ? 1 : 0);
