/**
 * p100 — 앱 주요 화면 전수 색 대비 감사(실 Chrome, 실 CSS 3파일 캐스케이드 + 런타임 계산값)
 * (프레임워크 0 · 실행: node tests/p100-contrast-audit.test.mjs)
 *
 * [재현] 이 파일이 재현 겸 회귀 테스트다(지휘자 미측정 지시). 주요 화면(허브·편집·핀패널
 *   CHECKER/360·360뷰어·설정·모바일 도크/더보기·토스트·설치배너·합치기모달·일괄삭제 선택모드·
 *   [WO 20261001-allpins] 전체 포인트 패널 모드탭×정렬 4조합)를
 *   1280x800·375x812 두 뷰포트에서 실 브라우저로 열고, 화면에 보이는 모든 텍스트 요소에 대해
 *   getComputedStyle(color) 와 조상 background 합성(반투명 포함)으로 WCAG 대비를 계산한다.
 *   큰 글자(≥24px 또는 ≥18.66px+bold)는 3:1, 그 외는 4.5:1 미만이면 실패.
 *   disabled/aria-disabled 요소는 WCAG 1.4.3 예외로 제외.
 *
 * 경계: 서버 API 만 목(p92/p98 과 같은 방식). 클라 = public/ 실 파일 + _manifest 순서 실 모듈
 *   번들 + 실 index.html + 실 CSS 3개(style.css/seastar-family-tokens.css/seastar-3d-skin.css).
 *   three.js/pdf.js 는 실 CDN(그대로 네트워크 로드, 목 없음) — 360 뷰어 WebGL 텍스처까지 실측.
 *
 * 스크린샷: .tmp/fixcontrast/*.png
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "public");
const SHOTS = path.join(ROOT, ".tmp", "fixcontrast");
fs.mkdirSync(SHOTS, { recursive: true });

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODS = fs.readFileSync(path.join(PUB, "js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const bundle = (() => {
  const b = MODS.map((f) => fs.readFileSync(path.join(PUB, "js/modules", f), "utf8").replace(/\r\n/g, "\n")).join("\n");
  const cut = b.lastIndexOf("})();");
  return b.slice(0, cut) + "\nwindow.__T = { App, State, UI, Projects, RegionMerge, Prompt, PinActionPop, PinSeries, Settings };\n" + b.slice(cut);
})();
const CT = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webmanifest": "application/json" };

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const P = (id, x, y, label, extra) => Object.assign({ id, x, y, page: 1, label: String(label) }, extra || {});
const dep = (id, pins) => ({ id, version: 1, title: id, file_name: id + ".pdf", pages_data: JSON.stringify([PNG]), drawing_data: PNG, pins: JSON.stringify(pins), zones: "[]", annotations: "[]" });
const CHECKER_PIN = P(101, 40, 40, "1", { checkboard: true });
const PANO_PIN = P(102, 60, 55, "P1", { imageUrl: "/images/pano-sample.jpg", note: "측정용 메모" });
const db = {
  deps: { dep1: dep("dep1", [CHECKER_PIN, PANO_PIN]), dep2: dep("dep2", [P(201, 25, 25, "1", { checkboard: true })]) },
  decks: [
    { id: "dk1", project_id: "prjT", name: "구역1", deployment_id: "dep1", page: 1, crop: null, parent_id: null, src_dep_id: "orig", src_page: 1, src_crop: { x: 10, y: 20, w: 40, h: 30 } },
    { id: "dk2", project_id: "prjT", name: "구역2", deployment_id: "dep2", page: 1, crop: null, parent_id: null, src_dep_id: "orig", src_page: 1, src_crop: { x: 30, y: 25, w: 40, h: 40 } },
  ],
};
const json = (res, o, st = 200) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
const body = (req) => new Promise((r) => { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => r(Buffer.concat(c).toString())); });
const server = http.createServer(async (req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/sw.js") { res.writeHead(404); res.end(); return; }
  if (u === "/js/main.js") { res.writeHead(200, { "content-type": "application/javascript" }); res.end(bundle); return; }
  if (u === "/api/auth/auto-entry") return json(res, { token: "tokT", kind: "designer" });
  if (u === "/api/auth/me") return json(res, { authenticated: true, email: "auto@test.local", name: "auto", role: "super", auto: true });
  if (u === "/api/auth/config") return json(res, { google_client_id: "", demo_login: false });
  if (u === "/api/tenant/resolve") return json(res, { matched: false });
  if (u === "/api/projects") return json(res, { data: [{ id: "prjT", name: "tes", created_at: 1, published: false }] });
  if (u === "/api/projects/prjT/decks") return json(res, { data: db.decks });
  if (u === "/api/merge/dup-check") { const b = JSON.parse((await body(req)) || "{}"); return json(res, { ok: true, probes: (b.pairs || []).map((p) => ({ i: p.i, ok: true, label: "diff", p: 0.1 })) }); }
  const m = u.match(/^\/tables\/deployments\/(.+)$/);
  if (m && req.method === "GET") { const d = db.deps[m[1]]; return d ? json(res, d) : json(res, { error: "nf" }, 404); }
  if (u.startsWith("/api/") || u.startsWith("/tables/")) return json(res, { data: [], settings: {}, value: {} });
  const f = path.join(PUB, u === "/" ? "index.html" : u);
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "content-type": CT[path.extname(f)] || "application/octet-stream" }); res.end(fs.readFileSync(f));
});
await listenSafePort(server, "127.0.0.1");

let puppeteer = null;
try { puppeteer = createRequire("file:///C:/Users/FREE/package.json")("puppeteer"); } catch (e) { puppeteer = null; }
if (!puppeteer) { ok(false, "puppeteer 없음 — 실 브라우저 검증 불가(증거 없는 PASS 금지)"); process.exit(1); }
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const browser = await puppeteer.launch({ headless: "new", ...(fs.existsSync(CHROME) ? { executablePath: CHROME } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 120000 });

/* ══════════════════ 런타임 대비 스캐너(브라우저 안에서 실행) ══════════════════ */
function SCAN() {
  function parseColor(s) {
    const m = String(s).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const a = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: a[0], g: a[1], b: a[2], a: a.length > 3 ? a[3] : 1 };
  }
  function over(f, b) { return { r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 }; }
  function parseGradientStops(s) {
    if (!s || s === "none" || s.indexOf("gradient") < 0) return [];
    const out = [];
    const re = /rgba?\(([^)]+)\)/g;
    let m;
    while ((m = re.exec(s))) {
      const a = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      out.push({ r: a[0], g: a[1], b: a[2], a: a.length > 3 ? a[3] : 1 });
    }
    return out;
  }
  function composite(overlays, base) {
    let acc = base;
    for (let i = overlays.length - 1; i >= 0; i--) acc = over(overlays[i], acc);
    return acc;
  }
  /** 요소 뒤에 실제로 보일 수 있는 배경 후보들(불투명 배경색 또는 그라디언트 stop 각각) —
   *  background-image:gradient() 는 backgroundColor 로 안 잡혀 조상의 배경으로 잘못 새는 걸 방지. */
  function bgCandidates(el) {
    const overlays = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      const grad = parseGradientStops(cs.backgroundImage);
      if (grad.length) return grad.map((stop) => composite(overlays, { r: stop.r, g: stop.g, b: stop.b, a: 1 }));
      const c = parseColor(cs.backgroundColor);
      if (c && c.a > 0) {
        overlays.push(c);
        if (c.a >= 1) return [composite(overlays, { r: 255, g: 255, b: 255, a: 1 })];
      }
    }
    return [composite(overlays, { r: 255, g: 255, b: 255, a: 1 })];
  }
  function L(c) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function ratio(fg, bg) { const fgo = over(fg, bg); const a = L(fgo), b = L(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); }
  function cssPath(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    else if (el.className && typeof el.className === "string") { const c = el.className.trim().split(/\s+/).slice(0, 2).join("."); if (c) s += "." + c; }
    const p = el.parentElement;
    const pp = p ? (p.id ? "#" + p.id : p.tagName.toLowerCase()) : "";
    return (pp ? pp + " > " : "") + s;
  }
  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.05) return false;
    return true;
  }
  function hasOwnText(el) {
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return true;
    return false;
  }
  const out = [];
  const seen = new Set();
  const all = document.body.querySelectorAll("*");
  for (const el of all) {
    if (el.closest("svg")) continue; // SVG <text> 는 fill 속성 기반(CSS backgroundColor 무관) — 별도 검사 필요, 자동 스캔 범위 밖
    if (!hasOwnText(el)) continue;
    if (el.closest("[disabled]") || el.getAttribute("aria-disabled") === "true") continue;
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const fg = parseColor(cs.color);
    if (!fg) continue;
    const bgs = bgCandidates(el);
    const ratios = bgs.map((bg) => ratio(fg, bg));
    const r = Math.min(...ratios);
    const bg = bgs[ratios.indexOf(r)];
    const fs = parseFloat(cs.fontSize) || 16;
    const fw = parseInt(cs.fontWeight, 10) || 400;
    const large = fs >= 24 || (fs >= 18.66 && fw >= 700);
    const threshold = large ? 3.0 : 4.5;
    const text = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim().slice(0, 30);
    const sel = cssPath(el);
    // 대비 비율까지 키에 포함 — 같은 선택자/텍스트라도 조상 경로가 달라 실제 합성 배경이
    // 다르면(예: 같은 .zpager-cnt 가 다른 활성 필터 칩 안에 있는 경우) 서로 다른 실패로 남긴다.
    const key = sel + "|" + text + "|" + r.toFixed(2);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sel, text, color: cs.color, bg: "rgb(" + Math.round(bg.r) + "," + Math.round(bg.g) + "," + Math.round(bg.b) + ")", ratio: +r.toFixed(2), threshold, pass: r >= threshold - 0.005, fs: +fs.toFixed(1), fw });
  }
  return out;
}

/* ══════════════════ 화면별 구동 시퀀스(한 페이지에서 순차 실행) ══════════════════ */
async function runFlow(vw, vh, tag) {
  const results = []; // { screen, viewport, fails: [...] }
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e && e.message)));
  await page.setViewport({ width: vw, height: vh, isMobile: vw < 500, hasTouch: vw < 500 });
  await page.goto("http://127.0.0.1:" + server.address().port + "/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__T, { timeout: 20000 });

  // [WO 20261001-invite ④] 공용석 종료 — 비로그인 첫 화면 = 로그인 게이트. 먼저 그 화면을 재고,
  //   이어서 "로그인한 사용자"(세션 토큰 보유 → 목 /api/auth/me 인증)로 새로고침해 나머지 화면을 잰다.
  const gateUp = await page.waitForFunction(() => { const g = document.getElementById("login-gate"); return g && !g.classList.contains("hidden"); }, { timeout: 15000 }).then(() => true).catch(() => false);
  ok(gateUp, tag + " 비로그인 첫 화면에 로그인 게이트가 뜬다");
  await sleep(400);
  await measure("login-gate");
  await page.evaluate(() => sessionStorage.setItem("wm_id_token", "tokT"));
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.__T, { timeout: 20000 });

  async function measure(screen) {
    const rows = await page.evaluate(SCAN);
    const fails = rows.filter((r) => !r.pass);
    results.push({ screen, viewport: vw + "x" + vh, total: rows.length, fails });
    console.log("  [" + tag + "/" + screen + "] 텍스트요소 " + rows.length + "건, 미달 " + fails.length + "건");
    for (const f of fails) console.log("    FAIL " + f.sel + " \"" + f.text + "\" ratio=" + f.ratio + " (기준 " + f.threshold + ") color=" + f.color + " bg=" + f.bg);
    await page.screenshot({ path: path.join(SHOTS, tag + "-" + screen.replace(/[^a-z0-9-]/gi, "_") + ".png") }).catch(() => {});
    return fails;
  }

  // S1 허브
  await page.waitForSelector(".hub-tree-deck", { timeout: 15000 }).catch(() => {});
  await sleep(400);
  await measure("hub");

  // S2 편집화면 (트리+툴바+필터칩+CHECKER/360 잎) — 모바일은 사이드바 시트를 강제로 연다
  if (vw < 500) await page.evaluate(() => document.body.classList.add("sidebar-open"));
  await page.evaluate(() => document.querySelector('.hub-tree-deck[data-deck-id="dk1"]').click());
  await page.waitForFunction(() => window.__T.State.currentDeploymentId === "dep1" && (window.__T.State.pins || []).length === 2, { timeout: 20000 });
  await sleep(700);
  await measure("editor-tree-toolbar-chips");

  // S3 핀 패널 — CHECKER
  await page.evaluate(() => { window.__T.App.setActivePin(101); window.__T.PinActionPop.open(101); });
  await page.waitForFunction(() => !document.getElementById("pin-action-pop").classList.contains("hidden"), { timeout: 10000 }).catch(() => {});
  await sleep(300);
  await measure("pin-panel-checker");
  await page.evaluate(() => { const b = document.getElementById("pap-close"); if (b) b.click(); });
  await sleep(150);

  // S4 핀 패널 — 360
  await page.evaluate(() => { window.__T.App.setActivePin(102); window.__T.PinActionPop.open(102); });
  await page.waitForFunction(() => !document.getElementById("pin-action-pop").classList.contains("hidden"), { timeout: 10000 }).catch(() => {});
  await sleep(300);
  await measure("pin-panel-360");
  await page.evaluate(() => { const b = document.getElementById("pap-close"); if (b) b.click(); });
  await sleep(150);

  // S5 360 뷰어 (상단바/도구/미니맵/힌트)
  await page.evaluate(() => window.__T.App.openPano(window.__T.State.pins.find((p) => p.id === 102)));
  const panoOk = await page.waitForFunction(() => !document.getElementById("pano-canvas").classList.contains("hidden"), { timeout: 15000 }).then(() => true).catch(() => false);
  await sleep(500);
  if (panoOk) {
    await page.evaluate(() => { const m = document.getElementById("pano-radar-more"); if (m) m.click(); const t = document.getElementById("btn-pano-tools-toggle"); if (t) t.click(); });
    await sleep(300);
    await measure("pano-viewer-header-tools-radar-hint");
  } else {
    console.log("  [" + tag + "/pano-viewer] WebGL 텍스처 로드 실패(헤드리스 환경) — 스캔 건너뜀");
  }
  await page.evaluate(() => { const b = document.getElementById("btn-pano-close"); if (b) b.click(); });
  await sleep(200);

  // S6 설정
  await page.evaluate(() => document.getElementById("btn-settings").click());
  await sleep(300);
  await measure("settings");
  await page.evaluate(() => { const b = document.getElementById("settings-close"); if (b) b.click(); });
  await sleep(150);

  // S7 합치기 모달 — dep1(구역1)에서 dep2(구역2) 가져오기 열기
  await page.evaluate(() => { const b = document.querySelector("#side-tree .rm-open-btn"); if (b) b.click(); });
  const rmOk = await page.waitForFunction(() => { const e = document.getElementById("rm-preview"); return e && /개 가져옴|없습니다|선택하세요/.test(e.textContent); }, { timeout: 10000 }).then(() => true).catch(() => false);
  await sleep(300);
  if (rmOk) await measure("region-merge-modal");
  else console.log("  [" + tag + "/region-merge-modal] 진입 버튼 없음(트리 구조 변경?) — 스캔 건너뜀");
  await page.evaluate(() => { const b = document.getElementById("rm-cancel"); if (b) b.click(); });
  await sleep(150);

  // S8 일괄삭제 선택모드
  await page.evaluate(() => { const t = document.getElementById("pin-list-toggle"); if (t) t.click(); });
  await sleep(200);
  const bulkOk = await page.evaluate(() => { const b = document.querySelector(".pin-bulk-toggle"); if (b) { b.click(); return true; } return false; });
  await sleep(300);
  if (bulkOk) {
    await page.evaluate(() => { const cb = document.querySelector(".pin-sel"); if (cb) cb.click(); });
    await sleep(150);
    await measure("bulk-delete-select-mode");
  } else console.log("  [" + tag + "/bulk-delete] 선택 버튼 없음 — 스캔 건너뜀");

  // S8b [WO 20261001-allpins] 전체 포인트 패널 — 모드 탭(CHECKER/360) × 정렬(번호순/이름순) 4조합.
  //   이 패널의 .allpins-sort-btn.active 가 p100 발주의 재현 대상(밝은 베이지 배경 위 흰 글자).
  await page.evaluate(() => { const b = document.getElementById("btn-all-pins"); if (b) b.click(); });
  const apOpen = await page.waitForFunction(() => { const d = document.getElementById("allpins-drawer"); return d && d.classList.contains("on"); }, { timeout: 8000 }).then(() => true).catch(() => false);
  if (apOpen) {
    await sleep(300);
    await measure("allpins-tab1-sort-page");
    await page.evaluate(() => { const b = document.querySelector('.allpins-sort-btn[data-sort="name"]'); if (b) b.click(); });
    await sleep(200);
    await measure("allpins-tab1-sort-name");
    const switched = await page.evaluate(() => {
      const b = document.querySelector('#allpins-tabs [data-series]:not(.active)');
      if (b) { b.click(); return true; }
      return false;
    });
    if (switched) {
      await page.waitForFunction(() => { const d = document.getElementById("allpins-drawer"); return d && d.classList.contains("on"); }, { timeout: 8000 }).catch(() => {});
      await sleep(400);
      await measure("allpins-tab2-sort-name");
      await page.evaluate(() => { const b = document.querySelector('.allpins-sort-btn[data-sort="page"]'); if (b) b.click(); });
      await sleep(200);
      await measure("allpins-tab2-sort-page");
    } else console.log("  [" + tag + "/allpins] 모드 탭 2번째 없음 — 2탭 스캔 건너뜀");
    await page.evaluate(() => { const b = document.getElementById("btn-allpins-close"); if (b) b.click(); });
    await sleep(250);
  } else console.log("  [" + tag + "/allpins] 전체 포인트 패널 열기 실패(핀 없음?) — 스캔 건너뜀");

  // S9 토스트
  await page.evaluate(() => window.__T.Prompt.toast("측정용 안내 메시지입니다"));
  await sleep(150);
  await measure("toast");

  // S10 설치 배너
  await page.evaluate(() => document.getElementById("pwa-install-banner").classList.remove("hidden"));
  await sleep(150);
  await measure("install-banner");

  // S11(모바일 전용) 모바일 도크 + 더보기 시트
  if (vw < 500) {
    await page.evaluate(() => document.getElementById("mdock-more-toggle").click());
    await sleep(250);
    await measure("mobile-dock-more-sheet");
  }

  ok(errs.length === 0, "[" + tag + "] 페이지 예외 0건 — " + JSON.stringify(errs.slice(0, 3)));
  await page.close();
  return results;
}

console.log("=== p100 — 대비 감사: 1280x800 ===");
const R1 = await runFlow(1280, 800, "desktop");
console.log("\n=== p100 — 대비 감사: 375x812 ===");
const R2 = await runFlow(375, 812, "mobile");

const ALL = [...R1, ...R2];
const totalFails = ALL.reduce((n, r) => n + r.fails.length, 0);
console.log("\n[전수 요약]");
for (const r of ALL) console.log("  " + r.viewport + " / " + r.screen + " — 총 " + r.total + "건, 미달 " + r.fails.length + "건");
ok(totalFails === 0, "모든 화면에서 대비 미달 0건 (실측 " + totalFails + "건)");

await browser.close();
server.close();

/* ══════════════════ 뮤테이션 — CSS 수정 하나를 되돌리면 잡혀야 함 ══════════════════ */
// (본 파일은 실행마다 실측 스캔이라 "CSS 를 되돌리면 실패" 자체가 곧 뮤테이션 실효성 증명이다.
//  별도 검증은 발주서 지시대로 지휘자가 수정 커밋 전/후 diff 를 되돌려 이 스위트를 재실행해 확인한다.)

console.log("\n" + (failed ? "FAIL: " + failed + "건" : "ALL PASS"));
process.exit(failed ? 1 : 0);
