/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p81-deck-crop-fit-race.test.mjs)
 *
 * 대상: 마스터 라이브 재현(prod dep_muksj6py_jybyrh2n, 영역 'ㅁㄴㅇ') — 옛 창 방식(crop 있음) 영역을 허브
 *   트리에서 열면 클리핑은 정확한데 #map-transform 이 matrix(1,0,0,1,0,0) 으로 남는다.
 *
 * 🔴 교체 사유(WO 20260929-fitrace2): 직전 버전(9fdadd8)은 vm 스텁에서 img.complete 를 "이미지 준비"로
 *   모델링했다. 실브라우저에선 그 모델이 틀렸다 — data: URL 도면은 img.complete 가 load 이벤트보다
 *   **먼저** true 가 된다. 헤드리스 Chrome 호출스택(prod 데이터·계측 번들) 실측 순서:
 *     2940ms _applyDeckCropView → img.complete=true → fitZone (vp=0x0 tr=0x0 → 내부 가드로 조용히 무시)
 *     2942ms img load 이벤트 → loadDeckDrawing._r0 → App._showMapViewport → zoom=1/pan=0
 *     2943ms MapCtrl.applyTransform (vp=0x0 → _enforceBoundary 도 무력) → identity 확정
 *   즉 마지막으로 identity 를 쓴 것은 App._showMapViewport(20_App.js) 이고, 근본원인은 "맞춤 시점을
 *   img.complete 로 판정" 한 것이다. 진짜 전제조건은 "로더의 표시(리셋) 완료" → App.whenDisplayed().
 *
 * Part A — 실 Chrome(puppeteer) + 실제 public/js/modules 전체 번들 + 실제 index.html/CSS 3종.
 *   API 만 로컬 목 서버(허브 프로젝트·구역·배포본). 도면은 prod 와 같은 data: URL.
 *   허브 트리 클릭 / 사이드바 트리 클릭 × 옛 창 방식 영역 / 벡터복사 영역 → 3초 뒤 실제 transform 측정.
 * Part B — vm: Projects._applyDeckCropView 의 소비 규약(표시 신호 대기·낡은 로드 폐기·빠른 전환 가드).
 * 뮤테이션 — 번들/소스를 메모리에서만 되돌려 각 검사가 실패함을 증명(파일 미변경).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "public");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const projSrc = rd("public/js/modules/31_Projects.js");
const appSrc = rd("public/js/modules/20_App.js");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ══════════════════════════ Part A · 실 Chrome ══════════════════════════ */
const MODS = fs.readFileSync(path.join(PUB, "js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
/** 실제 모듈을 assemble.py 와 같은 순서로 이어 붙이고, 측정용으로 내부 객체만 window 에 노출한다. */
function buildBundle(mutate = (f, s) => s) {
  let b = MODS.map((f) => mutate(f, fs.readFileSync(path.join(PUB, "js/modules", f), "utf8").replace(/\r\n/g, "\n"))).join("\n");
  const cut = b.lastIndexOf("})();");
  return b.slice(0, cut) + "\nwindow.__T = { MapCtrl, App, Projects, State };\n" + b.slice(cut);
}
// prod 재현 조건: 배포본 pages_data 가 data: URL(원본 PDF 없음). 저장소에 있는 실제 JPEG 를 도면으로 쓴다.
const DRAWING = "data:image/jpeg;base64," + fs.readFileSync(path.join(PUB, "images/pano-sample.jpg")).toString("base64");
const CROP = { x: 1.587, y: 64.375, w: 10.718, h: 31.602 };   // 라이브 재현 값(ㅁㄴㅇ)
const DECKS = [
  { id: "dkRoot", project_id: "prjT", name: "구역A", parent_id: null, deployment_id: "depRoot", crop: null, page: 1, deleted: 0 },
  { id: "dkOld", project_id: "prjT", name: "ㅁㄴㅇ", parent_id: "dkRoot", deployment_id: "depOld", crop: CROP, page: 1, deleted: 0 },
  { id: "dkVec", project_id: "prjT", name: "벡터영역", parent_id: "dkRoot", deployment_id: "depVec", crop: null, page: 1, deleted: 0 },
];
const CT = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/json" };
async function serve(bundle) {
  const json = (res, o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  const server = http.createServer(async (req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    if (u === "/sw.js") { res.writeHead(404); res.end(); return; }   // SW 캐시가 측정을 오염시키지 않게(§G-4④)
    if (u === "/js/main.js") { res.writeHead(200, { "content-type": "application/javascript" }); res.end(bundle); return; }
    if (u === "/api/auth/auto-entry") return json(res, { token: "tokT", kind: "designer" });
    if (u === "/api/auth/me") return json(res, { authenticated: true, email: "auto@test.local", name: "auto", role: "designer", auto: true });
    if (u === "/api/auth/config") return json(res, { google_client_id: "", demo_login: false });
    if (u === "/api/tenant/resolve") return json(res, { matched: false });
    if (u === "/api/projects") return json(res, { data: [{ id: "prjT", name: "tes", created_at: 1, published: false }] });
    if (u === "/api/projects/prjT/decks") return json(res, { data: DECKS });
    const m = u.match(/^\/tables\/deployments\/(.+)$/);
    if (m && req.method === "GET") {
      await sleep(150);   // 실 네트워크처럼 await 사이에 다른 작업이 끼어들 틈을 준다
      return json(res, { id: m[1], title: m[1], file_name: m[1] + ".pdf", pages_data: JSON.stringify([DRAWING]), pins: "[]", zones: "[]", annotations: "[]", version: 1, source_meta: null });
    }
    if (u.startsWith("/api/") || u.startsWith("/tables/")) return json(res, { data: [], settings: {}, value: {} });
    const f = path.join(PUB, u === "/" ? "index.html" : u);
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "content-type": CT[path.extname(f)] || "application/octet-stream" }); res.end(fs.readFileSync(f));
  });
  await listenSafePort(server, "127.0.0.1");
  return server;
}
let puppeteer = null;
try { puppeteer = createRequire("file:///C:/Users/FREE/package.json")("puppeteer"); } catch (e) { puppeteer = null; }
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
let browser = null;
if (puppeteer) {
  browser = await puppeteer.launch({ headless: "new", ...(fs.existsSync(CHROME) ? { executablePath: CHROME } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}

/** flow: { hub: deckId } | { hub: deckId, side: 트리 라벨 } → 3초 뒤 실측 */
async function openAndMeasure(bundle, flow) {
  const server = await serve(bundle);
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 800 });
    // [WO 20261001-invite ④] 공용석 종료 — 로그인한 사용자로 진입(세션 토큰 보유 → 목 /api/auth/me 인증). 없으면 로그인 게이트가 허브를 덮는다.
    await page.evaluateOnNewDocument(() => { try { sessionStorage.setItem("wm_id_token", "tokT"); } catch (e) {} });
    await page.goto("http://127.0.0.1:" + server.address().port + "/", { waitUntil: "load" });
    const clickHub = async (id) => {
      const sel = '[data-deck-id="' + id + '"]';
      // 허브는 카드 트리를 비동기로 다시 그린다(구역 목록 fetch 후) — 좌표를 잡은 뒤 노드가 교체되면 클릭이
      // 빗나간다. 클릭이 실제로 진입을 일으켰는지(App 로드 세대 증가)로 확인하고 빗나갔으면 다시 누른다.
      for (let i = 0; i < 4; i++) {
        await page.waitForSelector(sel, { timeout: 15000 });
        await sleep(300);
        const b = await page.$eval(sel, (el) => { el.scrollIntoView(); const r = el.getBoundingClientRect(); return { x: r.x + Math.min(20, r.width / 2), y: r.y + 8 }; });
        await page.mouse.click(b.x, b.y);
        try { await page.waitForFunction(() => window.__T.App._loadSeq > 0, { timeout: 2000 }); return; } catch (e) {}
      }
      throw new Error("허브 트리 클릭이 진입을 일으키지 못함: " + id);
    };
    await clickHub(flow.hub);
    if (flow.side) {
      await sleep(2500);
      const pick = (n) => Array.from(document.querySelectorAll("#side-tree .tree-node-region,#side-tree .tree-node-deck")).find((e) => e.querySelector(".tree-label") && e.querySelector(".tree-label").textContent.trim() === n);
      await page.waitForFunction((src, n) => !!(0, eval)(src)(n), { timeout: 15000 }, pick.toString(), flow.side);
      const b = await page.evaluate((src, n) => { const el = (0, eval)(src)(n); el.scrollIntoView(); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, pick.toString(), flow.side);
      await page.mouse.click(b.x, b.y);
    }
    await sleep(3000);
    return await page.evaluate(() => {
      const { MapCtrl, State, Projects } = window.__T;
      const vw = MapCtrl.viewport.clientWidth, vh = MapCtrl.viewport.clientHeight;
      const cw = MapCtrl.transform.offsetWidth, ch = MapCtrl.transform.offsetHeight;
      const d = Projects.currentDeck;
      const box = d && d.crop ? d.crop : { x: 0, y: 0, w: 100, h: 100 };
      const sw = box.w / 100 * cw * State.zoom, sh = box.h / 100 * ch * State.zoom;
      return { deck: d && d.name, transform: getComputedStyle(MapCtrl.transform).transform, zoom: State.zoom, vw, vh,
        fitMin: Math.min(sw / vw, sh / vh), fitMax: Math.max(sw / vw, sh / vh), clip: getComputedStyle(MapCtrl.transform).clipPath };
    });
  } finally { await page.close(); server.close(); }
}
const fmt = (r) => `${r.deck} transform=${r.transform} zoom=${(r.zoom * 100).toFixed(0)}% 짧은변맞춤=${(r.fitMin * 100).toFixed(0)}% 긴변=${(r.fitMax * 100).toFixed(0)}% vp=${r.vw}x${r.vh}`;
/** 옛 창 방식: 크롭 경계가 화면을 덮는다(짧은 쪽이 뷰포트를 꽉 채움 = _enforceBoundary cover). identity 아님. */
const oldFitted = (r) => r.transform !== "matrix(1, 0, 0, 1, 0, 0)" && r.zoom > 1 && r.fitMin >= 0.95 && /inset/.test(r.clip);
/** 벡터복사: 페이지 전체가 화면 안에(MapCtrl.fit pad 0.92) — 긴 쪽이 85~100%. */
const vecFitted = (r) => r.fitMax >= 0.85 && r.fitMax <= 1.001 && r.zoom > 0;

async function partA(label, bundle, only) {
  console.log("\n[" + label + "]");
  const res = {};
  for (const [key, flow] of [["hubOld", { hub: "dkOld" }], ["hubVec", { hub: "dkVec" }], ["sideOld", { hub: "dkRoot", side: "ㅁㄴㅇ" }], ["sideVec", { hub: "dkRoot", side: "벡터영역" }]]) {
    if (only && !only.includes(key)) continue;
    const r = res[key] = await openAndMeasure(bundle, flow);
    if (key.endsWith("Old")) ok(oldFitted(r), `${key} 옛 창 방식 영역 → 크롭이 화면을 덮는다(identity 아님) :: ${fmt(r)}`);
    else ok(vecFitted(r), `${key} 벡터복사 영역 → 페이지 전체 맞춤 :: ${fmt(r)}`);
  }
  return res;
}

console.log("=== 회귀: 구역/영역 진입 시 크롭 맞춤 — 실 Chrome(prod 순서 재현: data: URL 도면) ===");
if (!browser) { console.log("  FAIL puppeteer 를 로드할 수 없다 — 실 브라우저 검증 불가(증거 없는 PASS 금지)"); failed++; }
else {
  await partA("A. 정상 번들", buildBundle());
}

/* ══════════════════════════ Part B · vm 소비 규약 ══════════════════════════ */
function makeHarness(src = projSrc) {
  const calls = { fitZone: [], fit: 0 };
  let pending = null;   // 현재 표시 대기(deferred)
  const sb = {
    console, JSON, Math, Promise, setTimeout,
    document: { getElementById: () => null, body: { classList: { toggle() {} } } },
    UI: { text() {} }, PDF: { setDeckCrop() {} }, Prompt: { toast() {} }, State: { mode: "designer" },
    MapCtrl: { fitZone: (c) => { calls.fitZone.push(c); }, fit: () => { calls.fit++; } },
  };
  sb.App = {
    // 실제 20_App 과 같은 계약: 새 로드는 이전 대기를 false 로 해제(_beginLoad) + 새 대기를 건다(_armDisplay).
    loadDeckDrawing: async () => { if (pending) pending.res(false); let res; const p = new Promise((r) => { res = r; }); pending = { p, res }; },
    whenDisplayed: () => (pending ? pending.p : Promise.resolve(true)),
    _gotoPage: async () => {},
  };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(src + "\n;globalThis.__J = Projects;", sb);
  sb.__J._renderDecks = () => {};
  return { J: sb.__J, calls, display: async (v = true) => { const d = pending; pending = null; if (d) d.res(v); await sleep(0); },
    /** 같은 구역인 채로 다른 로더(예: loadLatestDeployment)가 시작됨 = _beginLoad 가 대기를 false 로 해제 */
    supersede: async () => { if (pending) pending.res(false); let res; const p = new Promise((r) => { res = r; }); pending = { p, res }; await sleep(0); } };
}
const CROP_B = { x: 50, y: 50, w: 10, h: 10 };
async function partB(label, src) {
  console.log("\n[" + label + "]");
  let h = makeHarness(src);
  await h.J.selectDeck({ id: "a", name: "ㅁㄴㅇ", deployment_id: "dep1", crop: CROP });
  await sleep(0);
  ok(h.calls.fitZone.length === 0, `표시(_showMapViewport) 전 fitZone 0회 (${h.calls.fitZone.length})`);
  await h.display(true);
  ok(h.calls.fitZone.length === 1 && h.calls.fitZone[0].w === CROP.w, `표시 완료 뒤 fitZone 1회, crop.w=${h.calls.fitZone[0] && h.calls.fitZone[0].w}`);
  h = makeHarness(src);
  await h.J.selectDeck({ id: "a", deployment_id: "depA", crop: CROP });
  await h.J.selectDeck({ id: "b", deployment_id: "depB", crop: CROP_B });   // A 표시 전에 B 로 전환
  await h.display(true);
  ok(h.calls.fitZone.length === 1 && h.calls.fitZone[0].w === CROP_B.w, `빠른 전환 — 낡은 A 폐기, B(w=${CROP_B.w})만 적용: ${h.calls.fitZone.length}회`);
  h = makeHarness(src);
  await h.J.selectDeck({ id: "a", deployment_id: "depA", crop: CROP });
  await h.supersede();   // currentDeck 는 여전히 a — 그러나 표시 전에 다른 로드가 시작됨
  ok(h.calls.fitZone.length === 0, `표시 전 다른 로드 시작(settle false) → 숨은 뷰포트에 맞춤 0회 (${h.calls.fitZone.length})`);
  h = makeHarness(src);
  h.J.currentDeck = { id: "other" };
  h.J._applyDeckCropView({ id: "a", crop: CROP });   // 이미 다른 구역이 현재 — 늦은 맞춤 금지
  await sleep(0);
  ok(h.calls.fitZone.length === 0, `currentDeck 가 다른 구역이면 맞춤 0회 (${h.calls.fitZone.length})`);
}
await partB("B. 소비 규약(vm)", projSrc);

console.log("\n[C. 모드 전환(keepDrawing)은 별도 경로 — 줌 유지, 재적용 없음]");
{
  const m = appSrc.match(/if \(opts\.keepDrawing && State\.fileType\) \{[\s\S]*?return;\s*\n\s*\}[\s\S]*?this\.loadLatestDeployment/);
  ok(!!m && !/_applyDeckCropView|selectDeck|_showMapViewport/.test(m[0]), "openApp: keepDrawing 조기 반환 블록에 _applyDeckCropView/selectDeck/_showMapViewport 호출 없음");
}

/* ══════════════════════════ 뮤테이션(메모리에서만) ══════════════════════════ */
async function mutate(label, needleFile, needle, repl, run) {
  const src = needleFile === "31_Projects.js" ? projSrc : appSrc;
  const hit = src.includes(needle);
  ok(hit, label + " — 대상 존재");
  if (!hit) return;
  const before = failed;
  const logs = []; const orig = console.log; console.log = (...a) => logs.push(a.join(" "));
  try { await run((f, s) => (f === needleFile ? s.replace(needle, repl) : s)); } catch (e) { failed++; logs.push("  FAIL(throw) " + e.message); }
  console.log = orig;
  const caught = failed > before; failed = before;
  ok(caught, label + (caught ? " → 실패함(실효성 증명): " + (logs.find((l) => /FAIL/.test(l)) || "").trim().slice(0, 150) : " → 🔴 잡지 못함"));
}
console.log("\n[뮤테이션]");
if (browser) {
  // M1 = 근본원인 되돌리기: 표시 신호를 무시하고 즉시 맞춤(옛 img.complete 판정과 같은 타이밍) → prod 와 같은 identity
  await mutate("M1 표시 신호 무시(App.whenDisplayed → 즉시)", "31_Projects.js", "App.whenDisplayed() : Promise.resolve(true);", "Promise.resolve(true) : Promise.resolve(true);",
    (mut) => partA("M1", buildBundle(mut), ["hubOld"]));
  // M2 = 신호 발신 제거: _showMapViewport 가 표시 완료를 알리지 않으면 맞춤이 영영 안 일어난다
  await mutate("M2 _showMapViewport 의 settle 제거", "20_App.js", "      this._settleDisplay(true);\n", "",
    (mut) => partA("M2", buildBundle(mut), ["hubOld"]));
  // M3 = 로더의 arm 제거: 대기가 없으면 즉시 맞춤 → 숨은 뷰포트에서 무시됨
  await mutate("M3 loadDeckDrawing 의 _armDisplay 제거", "20_App.js", "        this._armDisplay();   // [WO 20260929-fitrace2] _r0→_showMapViewport 가 settle\n", "",
    (mut) => partA("M3", buildBundle(mut), ["hubOld"]));
}
await mutate("M4 빠른 전환 가드(currentDeck) 제거", "31_Projects.js", "          if (this.currentDeck && d && this.currentDeck.id !== d.id) return;\n", "",
  async (mut) => { await partB("M4", mut("31_Projects.js", projSrc)); });
await mutate("M5 낡은 로드(settle false) 폐기 제거", "31_Projects.js", "          if (!shown) return;", "",
  async (mut) => { await partB("M5", mut("31_Projects.js", projSrc)); });

if (browser) await browser.close();
console.log("\n" + (failed ? `❌ FAIL: ${failed}건` : "✅ ALL PASS"));
process.exit(failed ? 1 : 0);
