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
 *  🔴 [WO 20261001-startno] ② 갱신: 인라인 입력 → [번호 대역 ▾] 버튼(#btn-numband) + 시트(24b_NumBand). 상단·모달
 *     버튼 문구는 NumBand.render() 한 곳에서 나온다. ⑤ 의 검사 대상 id 도 input-regmode-start → btn-numband.
 *
 * 뮤테이션 2건, 각 EXIT=1 확인 후 원복:
 *  ⓐ 24b_NumBand.js render 의 모달 버튼 갱신(`if (sb) sb.textContent = txt;`) 제거 → ②(모달 쪽 반영)가 실패해야 함
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
// [WO 20261001-startno] 전: 인라인 `시작 #` 입력(#input-regmode-start) 존재 · 후: 그 자리에 [번호 대역 ▾] 버튼(#btn-numband)
ok(!/id="input-regmode-start"/.test(indexHtml) && /<button id="btn-numband"[^>]*aria-haspopup="dialog"/.test(indexHtml),
  "② 상단 `시작 #` 입력 → [번호 대역 ▾] 버튼(#btn-numband, aria-haspopup=dialog) 교체");
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
    const ids = ["btn-back", "btn-regmode-checkboard", "btn-regmode-photo", "btn-numband", "btn-settings"]; // [WO 20261001-startno] 입력 → 대역 버튼
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
  // [WO 20261001-mobilefast] 띠 전체 높이(지도 가림 폭) — regmode-start-wrap 자신의 rect.
  const wrapHeight = await page.evaluate(() => {
    const w = document.getElementById("regmode-start-wrap");
    return w ? w.getBoundingClientRect().height : null;
  });
  server.close();
  return { viewModeDisplay: view, rects, checkboardDisplay, wrapHeight, vw, vh };
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
    // [WO 20261001-startno] 전: 항상 참이던 식(삼항 우선순위 — `a || b ? c : true`) · 후: 다섯 요소 전부 ≥44px 를 실제로 검사
    // [WO 20261001-mobilefast 재수정] 🔴 마스터 명시 지시 — 이 띠(regmode-start-wrap)는 지도를
    // 가린다는 지적(R1)으로 ≤32px 로 축소했다. btn-numband 는 그 띠 안의 유일한 버튼이라
    // 44px 터치타깃을 지키면 띠가 다시 56px 로 되돌아간다 — "한 줄 32px 이하"가 44px 권고보다
    // 우선(판정 기준5). 나머지 4개(뒤로/세그먼트2/설정)는 종전대로 44px 유지(회귀 감시 유지).
    const others = m.rects.filter((r) => r.id !== "btn-numband");
    const nb = m.rects.find((r) => r.id === "btn-numband");
    ok(others.every((r) => r.height >= 44), "⑤ btn-numband 외 터치 타깃 높이 ≥44px(" + vw + "px) → " + JSON.stringify(others.map((r) => r.id + ":" + Math.round(r.height))));
    ok(!!nb && nb.height >= 20 && nb.height < 44, "⑤ btn-numband 는 의도적으로 압축됨(20~44px, 실측 " + (nb && Math.round(nb.height)) + "px)");
    ok(m.wrapHeight != null && m.wrapHeight <= 32, "⑤ regmode-start-wrap 띠 전체 높이 ≤32px(지도 가림 최소화, 실측 " + m.wrapHeight + "px)");
  }
});

console.log("\n[뮤테이션ⓑ] 모바일 2번째 줄 배치(position:fixed) 규칙 제거 → ⑤(375px) 실패해야 함");
await withBrowser(async (browser) => {
  const needle = `  #btn-regmode-checkboard.active ~ #regmode-start-wrap,
  #btn-regmode-photo.active ~ #regmode-start-wrap {
    position: fixed; left: 0; right: 0; top: 68px;
    justify-content: center; margin-left: 0; border-left: none;
    background: var(--bg2); padding: 2px 12px; box-shadow: 0 2px 6px rgba(0,0,0,.2);
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
/* [WO 20261001-startno] 전: 인라인 입력 ↔ 모달 입력 양방향 동기화(입력 2개) ·
   후: 입력은 시트 하나(24b_NumBand), 상단 버튼·모달 버튼 문구가 같은 NumBand.render() 에서 나온다(양쪽 항상 동일). */
const numbandSrc = rd("public/js/modules/24b_NumBand.js");
function makeEnv(numbandSrcToUse, hasDrawing = true) {
  const { document, registry } = makeDoc();
  const State = { pdfPage: 1, checkboardStart: {}, pins: [], pdfDoc: hasDrawing ? {} : null, viewerPages: null, pinColor: null, regMode: "checkboard" };
  const UI = makeUI(document);
  const Auth = { user: { name: "designer", email: "d@x.com" }, isDesigner: true, isSuper: false, role: "designer" };
  const sandbox = {
    console, document, window: { addEventListener() {} }, State, UI, Auth,
    App: null, Prompt: { toast() {} }, PinPrefs: { get: () => "green", PALETTE: [] },
    JSON, Array, Map, Set, Date: makeSeqDate(), setTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(seriesSrc + "\n" + appSrc + "\n" + numbandSrcToUse + "\n;globalThis.__App = App; globalThis.__NB = NumBand;", sandbox);
  sandbox.App = sandbox.__App;
  vm.runInContext(settingsSrc + "\n;globalThis.__Settings = Settings;", sandbox);
  const Settings = sandbox.__Settings;
  Settings.init();
  sandbox.__NB.init();
  Settings.render();
  return { Settings, App: sandbox.App, NB: sandbox.__NB, State, registry };
}

{
  const { App, registry } = makeEnv(numbandSrc);
  ok(registry["numband-btn-text"].textContent === "대역 1–100 · 다음 1" && registry["btn-settings-numband"].textContent === "대역 1–100 · 다음 1",
    "초기 렌더 — 상단·모달 버튼 둘 다 '대역 1–100 · 다음 1' → " + JSON.stringify([registry["numband-btn-text"].textContent, registry["btn-settings-numband"].textContent]));
  App._setCheckboardStart(1, 150, "checkboard");
  ok(registry["numband-btn-text"].textContent === "대역 101–200 · 다음 150", "② 직접 입력 150 → 상단 '대역 101–200 · 다음 150' → " + registry["numband-btn-text"].textContent);
  ok(registry["btn-settings-numband"].textContent === registry["numband-btn-text"].textContent, "② 모달 버튼도 같은 문구(한 렌더 지점)");
  App._setNumBand(3);
  ok(registry["numband-btn-text"].textContent === "대역 201–300 · 다음 201", "칩 선택(대역 3) → '대역 201–300 · 다음 201' → " + registry["numband-btn-text"].textContent);
}

{
  const { registry } = makeEnv(numbandSrc, false);
  ok(registry["numband-btn-text"].textContent === "대역 1–100" && registry["btn-settings-checkboard-renumber"].disabled === true,
    "도면 없음 → 버튼은 대역만(다음 번호 없음) · 일괄 변경 비활성 → " + JSON.stringify(registry["numband-btn-text"].textContent));
}

console.log("\n[뮤테이션ⓐ] NumBand.render 의 모달 버튼 갱신 제거 → 모달 쪽 동기화 실패해야 함");
{
  const needle = "if (sb) sb.textContent = txt;";
  if (!numbandSrc.includes(needle)) { console.log("  FAIL 뮤테이션ⓐ 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mutated = numbandSrc.replace(needle, "/* [뮤테이션] */");
    const { App, registry } = makeEnv(mutated);
    App._setCheckboardStart(1, 150, "checkboard");
    ok(registry["numband-btn-text"].textContent === "대역 101–200 · 다음 150", "사전조건 — 상단은 여전히 갱신됨");
    ok(registry["btn-settings-numband"].textContent !== registry["numband-btn-text"].textContent, "뮤테이션 적용 시 모달 버튼이 낡은 문구에 머문다(동기화가 깨짐을 증명) → " + JSON.stringify(registry["btn-settings-numband"].textContent));
  }
}

console.log(failed ? `\n총 ${failed}건 실패` : "\n전부 통과");
process.exit(failed ? 1 : 0);
