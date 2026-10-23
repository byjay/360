/**
 * p186 — [WO 20261023-pointlist] 구역별 포인트 리스트(21_AllPins.js scope='zone' + 11_UI.groupDecksByParent
 * 트리 SoT). 마스터: "구역별 포인트 리스트를 구현하고 리스트로도 볼 수 있어야지."
 *
 * [재현] RECON.md "구역별 포인트 리스트" — 종전 21_AllPins 는 현재 구역 1개의 평면 목록만 보여줬다
 *   (_scopedPins, 21_AllPins.js:125-130 구 라인). 트리(11_UI.js)만 구역>영역 계층을 알고 있었고,
 *   AllPins 패널엔 그룹·코멘트 요약·360 바로가기·보이는 목록 내보내기가 없었다.
 *
 * Part A(vm, 실제 11_UI.js + 01b_PinSeries.js + 21_AllPins.js 소스 그대로, DOM 없이 순수 메서드 호출)
 *  ① _zoneGroups() 그룹 순서 = 트리 SoT(UI.groupDecksByParent) DFS(부모 바로 다음에 그 자식들) —
 *     로드 안 된(다른 배포본) 구역은 포함되지 않는다(0 날조 금지).
 *  ② 크롭 있는 영역이 겹치지 않게 핀을 가져가고, 크롭 없는 구역은 남은 핀(leftover)만 가진다.
 *  ③ _commentSummary() — pin.note 폴백 요약.
 *  ④ _visibleRowsForExport() — 지금 탭 필터(PinSeries.photoFilter)가 내보내기 행 수에 반영된다.
 *  ⑤ _canSelect() — 열람 세션(Auth.readonly)에서는 false(편집 노출 없음).
 *  뮤테이션 3종(각 EXIT 조건 — ok() 로 "깨짐"을 직접 단언, 전체 프로세스는 구분 섹션으로 보고 후 원복):
 *   ⓐ 그룹 순서를 트리 SoT 대신 이름순 정렬로 바꾸면 ①이 깨진다.
 *   ⓑ 내보내기에서 탭 필터를 건너뛰면 ④가 깨진다.
 *   ⓒ _canSelect()를 무조건 true로 바꾸면 ⑤가 깨진다(열람 세션에 체크박스 노출).
 *
 * Part B(실 Chrome·Puppeteer, 실 public/ 정적 자산 — p62-tree-3level.test.mjs Part C 와 같은 패턴:
 *  가벼운 정적 서버 + 실제 UI.renderTree 대신 AllPins.show()/render() 실 호출, App.focusPin 은 무거운
 *  PDF/맵 의존성이 있어 테스트 전용 스텁으로 교체 — 11_UI 쪽과 동일하게 "실제 소스, 최소 DOM 아님 —
 *  이번엔 실 브라우저 DOM, 무거운 하위 렌더러만 스텁")
 *  ⑥ 그룹 헤더(구역명·핀 수·사진 있음 수) 렌더, 접기/펼치기 + localStorage 유지.
 *  ⑦ 탭·검색이 그룹 안에도 반영(필터 시 그룹이 줄거나 사라진다).
 *  ⑧ 코멘트 요약 텍스트 노출, [360] 버튼은 사진 있는 핀에만 — 클릭 시 구역 전환 + App.focusPin 호출.
 *  ⑨ 열람 세션(Auth.readonly) — 체크박스 0개, 그룹·360·코멘트는 그대로 보임.
 *  ⑩ 새 클래스(.allpins-group-head·.allpins-row-comment·.allpins-row-360·.allpins-scope-btn.active)
 *     실측 대비 ≥4.5:1(가짜 var() 추정 금지 — getComputedStyle 실측).
 *  ⑪ 모바일 375px — 패널·버튼이 겹치지 않고 전부 탭 가능한 크기. 스크린샷 .tmp/p186/.
 *
 * 실행: TEMP=E:\code-project\360\.tmp TMP=E:\code-project\360\.tmp node tests/p186-pointlist-by-zone-cdp.mjs
 * 사전: public/js/main.js 가 최신(python build-tools/assemble.py) — Part B 는 조립된 번들을 그대로 서빙한다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const uiSrc = rd("public/js/modules/11_UI.js");
const psSrc = rd("public/js/modules/01b_PinSeries.js");
const apSrc = rd("public/js/modules/21_AllPins.js");

let failed = 0;
const ok = (cond, label, d) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (d != null ? " :: " + JSON.stringify(d).slice(0, 300) : "")); if (!cond) failed++; };

/* ══════════════════════════════════════════════════════════════════════
 * Part A — 순수 로직(실제 소스 vm 평가, DOM 없음)
 * ══════════════════════════════════════════════════════════════════════ */
function fx() {
  const State = {
    mode: "designer", currentDeploymentId: "dep1", activePin: null,
    pins: [
      { id: "p1", label: "옥상 누수", page: 1, x: 20, y: 20, imageId: "img1" },               // d1a(가영역) 크롭 안
      { id: "p2", label: "복도 조명", page: 1, x: 70, y: 20, note: "자주 확인 필요 — 자재 요청함" }, // d1b(나영역) 크롭 안
      { id: "p4", label: "창고 바닥", page: 1, x: 20, y: 80 },                                  // 크롭 밖 → d1(A구역) leftover
      { id: "p5", label: "기관실 밸브", page: 2, x: 10, y: 10 }                                  // d2(B구역, page2)
    ],
    zones: []
  };
  // 🔴 의도적으로 트리 순서(부모 d1 바로 다음 자식 d1b,d1a)와 다른 배열 순서로 선언 —
  //  배열 순서를 그대로 쓰면(뮤테이션과 동치) ①이 틀어진다는 것을 보장하기 위한 픽스처.
  const decks = [
    { id: "d2", name: "B구역", deployment_id: "dep1", parent_id: null, page: 2, crop: null },
    { id: "d1", name: "A구역", deployment_id: "dep1", parent_id: null, page: 1, crop: null },
    { id: "d1b", name: "나영역", deployment_id: "dep1", parent_id: "d1", page: 1, crop: { x: 50, y: 0, w: 50, h: 50 } },
    { id: "d3", name: "C구역", deployment_id: "dep2", parent_id: null, page: 1, crop: null }, // 다른 배포본 — 로드 안 됨
    { id: "d1a", name: "가영역", deployment_id: "dep1", parent_id: "d1", page: 1, crop: { x: 0, y: 0, w: 50, h: 50 } }
  ];
  const Projects = {
    decks, currentProject: { id: "prjP186" }, currentDeck: decks[0],
    // [재현 — 테스트 픽스처] 31_Projects.js pinsForDeck 의 실제 공식(_pinsWithinCrop) 그대로 복붙.
    pinsForDeck(pins, deck) {
      if (!deck || !deck.crop || !(deck.crop.w > 0) || !(deck.crop.h > 0)) return pins;
      const pg = deck.page || 1, x1 = deck.crop.x + deck.crop.w, y1 = deck.crop.y + deck.crop.h;
      return pins.filter((p) => (p.page || 1) === pg && p.x >= deck.crop.x && p.x <= x1 && p.y >= deck.crop.y && p.y <= y1);
    }
  };
  const PinLink = { dedupe: (p) => p };
  const Auth = { readonly: false };
  return { State, Projects, PinLink, Auth, App: { pinHasContent: () => false }, UI: undefined };
}
function evalModules(src, ctx) {
  const sandbox = { console, JSON, Map, Set, localStorage: { getItem: () => null, setItem() {} }, document: { getElementById: () => null }, ...ctx };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__AllPins = AllPins; globalThis.__UI = UI; globalThis.__PS = PinSeries;", sandbox);
  return sandbox;
}
const FULL_SRC = uiSrc + "\n" + psSrc + "\n" + apSrc;

console.log("\n[Part A · 순수 로직 — 실제 11_UI.js + 01b_PinSeries.js + 21_AllPins.js]");
{
  const c = fx();
  const sb = evalModules(FULL_SRC, c);
  const groups = sb.__AllPins._zoneGroups();
  const names = groups.map((g) => g.deck.name);
  ok(JSON.stringify(names) === JSON.stringify(["B구역", "A구역", "나영역", "가영역", "C구역"]),
    "① 그룹 순서 = 트리 SoT DFS(부모 바로 다음 자식) — 로드 안 된 C구역도 목록엔 있다(화면에서 숨기는 건 render 쪽)", names);
  const byName = (n) => groups.find((g) => g.deck.name === n);
  ok(byName("C구역").loaded === false && byName("C구역").pins.length === 0,
    "① 다른 배포본(C구역)은 loaded=false·pins=[](0 날조 금지)", byName("C구역"));
  ok(byName("가영역").pins.map((p) => p.id).join(",") === "p1", "② 크롭 있는 영역(가영역)은 자기 크롭 안 핀만", byName("가영역").pins.map((p) => p.id));
  ok(byName("나영역").pins.map((p) => p.id).join(",") === "p2", "② 크롭 있는 영역(나영역)은 자기 크롭 안 핀만", byName("나영역").pins.map((p) => p.id));
  ok(byName("A구역").pins.map((p) => p.id).join(",") === "p4", "② 크롭 없는 구역(A구역)은 자식 영역이 가져간 핀을 뺀 나머지(leftover)만", byName("A구역").pins.map((p) => p.id));
  ok(byName("B구역").pins.map((p) => p.id).join(",") === "p5", "② 다른 페이지(B구역, page2)는 자기 페이지 핀만", byName("B구역").pins.map((p) => p.id));

  const cs2 = sb.__AllPins._commentSummary(c.State.pins[1]); // p2
  ok(cs2.count === 1 && cs2.text.indexOf("자주 확인 필요") === 0, "③ 코멘트 요약 — pin.note 폴백", cs2);
  const cs1 = sb.__AllPins._commentSummary(c.State.pins[0]); // p1(note 없음)
  ok(cs1.count === 0 && cs1.text === "", "③ 노트·요청 둘 다 없으면 빈 요약(지어내지 않음)", cs1);

  sb.__AllPins.scope = "zone";
  const allExp = sb.__AllPins._visibleRowsForExport();
  ok(allExp.pins.length === 4, "④ 탭=전체일 때 내보내기 행 수 = 로드된 그룹 전체 핀 수(4)", allExp.pins.length);
  sb.__PS.setPhotoFilter("photo");
  const photoExp = sb.__AllPins._visibleRowsForExport();
  ok(photoExp.pins.length === 1 && photoExp.pins[0].id === "p1", "④ 탭=사진 있음으로 바꾸면 내보내기도 1건(p1)만 — 필터가 내보내기에 반영", photoExp.pins.map((p) => p.id));
  sb.__PS.setPhotoFilter("all");

  c.Auth.readonly = false;
  ok(sb.__AllPins._canSelect() === true, "⑤ 디자이너 세션은 선택 가능(기존 그대로)");
  c.Auth.readonly = true;
  ok(sb.__AllPins._canSelect() === false, "⑤ 열람 세션(Auth.readonly)은 선택 불가 — 편집 노출 없음");
}

/* ── 뮤테이션 ⓐ: 그룹 순서를 트리 SoT 대신 이름순 정렬 → ①이 깨져야 함 ── */
{
  console.log("\n[뮤테이션ⓐ] 그룹 순서를 트리 SoT 대신 이름순 정렬 → ①이 깨져야 함");
  const needle = "      walk(roots, 1);";
  const mutSrc = apSrc.replace(needle, "      decks.slice().sort((a, b) => String(a.name).localeCompare(b.name)).forEach((d) => order.push({ deck: d, depth: 1 }));");
  if (mutSrc === apSrc) { console.log("  FAIL 뮤테이션 대상 문자열 없음(소스 변경?)"); failed++; }
  else {
    const c = fx();
    const sb = evalModules(uiSrc + "\n" + psSrc + "\n" + mutSrc, c);
    const names = sb.__AllPins._zoneGroups().map((g) => g.deck.name);
    ok(JSON.stringify(names) !== JSON.stringify(["B구역", "A구역", "나영역", "가영역", "C구역"]),
      "뮤테이션 적용 시 ①이 깨짐(트리 SoT 순서 대신 이름순으로 뒤바뀜) — 실제 " + JSON.stringify(names));
  }
}

/* ── 뮤테이션 ⓑ: 내보내기에서 탭 필터를 건너뜀 → ④가 깨져야 함 ── */
{
  console.log("\n[뮤테이션ⓑ] 내보내기(zone)가 탭 필터(_sortedFrom)를 건너뛰고 원본 핀을 그대로 씀 → ④가 깨져야 함");
  const needle = "          const rows = this._sortedFrom(g.pins);";
  const mutSrc = apSrc.replace(needle, "          const rows = g.pins.map((p) => ({ pin: p }));");
  if (mutSrc === apSrc) { console.log("  FAIL 뮤테이션 대상 문자열 없음(소스 변경?)"); failed++; }
  else {
    const c = fx();
    const sb = evalModules(uiSrc + "\n" + psSrc + "\n" + mutSrc, c);
    sb.__AllPins.scope = "zone";
    sb.__PS.setPhotoFilter("photo");
    const exp = sb.__AllPins._visibleRowsForExport();
    ok(exp.pins.length !== 1, "뮤테이션 적용 시 ④가 깨짐(탭=사진 있음인데 필터 무시돼 " + exp.pins.length + "건 나옴, 기대 1건)");
  }
}

/* ── 뮤테이션 ⓒ: _canSelect()를 무조건 true로 → ⑤가 깨져야 함 ── */
{
  console.log("\n[뮤테이션ⓒ] _canSelect() 무조건 true → ⑤가 깨져야 함(열람 세션 편집 노출)");
  const needle = '    _canSelect() { return typeof State !== "undefined" && State.mode === "designer" && !(typeof Auth !== "undefined" && Auth.readonly); },';
  const mutSrc = apSrc.replace(needle, "    _canSelect() { return true; },");
  if (mutSrc === apSrc) { console.log("  FAIL 뮤테이션 대상 문자열 없음(소스 변경?)"); failed++; }
  else {
    const c = fx();
    c.Auth.readonly = true;
    const sb = evalModules(uiSrc + "\n" + psSrc + "\n" + mutSrc, c);
    ok(sb.__AllPins._canSelect() === true, "뮤테이션 적용 시 ⑤가 깨짐(열람 세션인데 선택 가능 — 체크박스가 노출된다)");
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * Part B — 실 Chrome(Puppeteer) · 실 public/ 정적 자산(조립된 public/js/main.js 포함)
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[Part B · 실 Chrome — 그룹 렌더·접기 유지·필터·360·코멘트·열람세션·대비·모바일]");
const require = createRequire("file:///C:/Users/FREE/package.json");
let puppeteer = null;
try { puppeteer = require("puppeteer"); } catch (e) { puppeteer = null; }
if (!puppeteer) {
  console.log("  FAIL puppeteer 를 로드할 수 없다 — 실 브라우저 수치 증명 불가(증거 없는 PASS 금지)");
  failed++;
} else {
  const PUB = path.join(ROOT, "public");
  const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
    ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon" };
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    if (u.startsWith("/api/") || u.startsWith("/tables/")) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"data":[]}'); return; }
    const f = path.join(PUB, u === "/" ? "index.html" : u);
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
    res.end(fs.readFileSync(f));
  });
  await listenSafePort(server, "127.0.0.1");
  const PORT = server.address().port;
  const browser = await puppeteer.launch({ headless: "new", protocolTimeout: 180000, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  page.on("pageerror", () => {});
  let firstDoc = true;
  await page.setRequestInterception(true);
  page.on("request", (q) => {
    if (q.resourceType() === "document") { if (firstDoc) { firstDoc = false; q.continue(); } else q.abort(); return; }
    q.continue();
  });
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => !!window.__wm, { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500));

  const SETUP = () => {
    const { State, UI, Projects, App, Auth, AllPins } = window.__wm;
    window.__focusCalls = [];
    App.focusPin = (pin, openAfter) => { window.__focusCalls.push({ id: pin.id, openAfter }); return Promise.resolve(); };
    App.pinHasContent = (pin) => !!pin.imageId;
    // [p186 환경 안정화] 이 테스트는 실 로그인 없이 돌아간다 — 백그라운드 폴링(_liveTick)이 가짜 토큰으로
    // 서버 왕복하다 로그인 게이트를 되살리는 걸 실측(스크린샷)으로 발견했다. AllPins 로직과 무관한
    // 무거운 하위 시스템이라 끈다(App.focusPin 을 스텁한 것과 같은 원칙 — CLAUDE.md §G-4④).
    if (App._livePollStop) App._livePollStop();
    Auth._openGate = () => {};
    Auth.authExpired = () => {};
    State.mode = "designer"; State.pdfPage = 1; State.pdfPages = 2; State.fileName = "A0.pdf";
    State.currentDeploymentId = "dep1"; State.activePin = null; State.zones = [];
    State.pins = [
      { id: "p1", label: "옥상 누수", page: 1, x: 20, y: 20, imageId: "img1" },
      { id: "p2", label: "복도 조명", page: 1, x: 70, y: 20, note: "자주 확인 필요 — 자재 요청함" },
      { id: "p4", label: "창고 바닥", page: 1, x: 20, y: 80 },
      { id: "p5", label: "기관실 밸브", page: 2, x: 10, y: 10 }
    ];
    Auth.readonly = false;
    // [p186 환경 안정화] 실 로그인 없이 돌리는 합성 픽스처라 Auth.user/idToken 이 비어 있으면 App 의
    // 백그라운드 체크(라이브 폴링 등)가 로그인 게이트를 되살릴 수 있다 — 실측(스크린샷)으로 발견.
    // AllPins 자체 로직과 무관한 테스트 환경 안정화(측정 환경부터 의심 — CLAUDE.md §G-4④).
    Auth.user = { email: "p186@test.local" }; Auth.idToken = "test-token-p186";
    Projects.currentProject = { id: "prjP186b" };
    Projects.decks = [
      { id: "d2", name: "B구역", deployment_id: "dep1", parent_id: null, page: 2, crop: null },
      { id: "d1", name: "A구역", deployment_id: "dep1", parent_id: null, page: 1, crop: null },
      { id: "d1b", name: "나영역", deployment_id: "dep1", parent_id: "d1", page: 1, crop: { x: 50, y: 0, w: 50, h: 50 } },
      { id: "d1a", name: "가영역", deployment_id: "dep1", parent_id: "d1", page: 1, crop: { x: 0, y: 0, w: 50, h: 50 } }
    ];
    Projects.currentDeck = Projects.decks[0]; // B구역
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    document.getElementById("screen-app").classList.add("active");
    document.querySelectorAll(".signin-gate").forEach((e) => e.classList.add("hidden"));
    try { localStorage.removeItem("wm_allpins_zc:prjP186b"); } catch (e) {}
    AllPins.scope = "zone";
    AllPins.show();
  };
  await page.evaluate(SETUP);
  await new Promise((r) => setTimeout(r, 200));

  const READ = () => {
    const groups = Array.from(document.querySelectorAll(".allpins-group"));
    return groups.map((g) => ({
      name: g.querySelector(".allpins-group-name").textContent,
      cnts: Array.from(g.querySelectorAll(".allpins-group-cnt")).map((c) => c.textContent),
      rows: g.querySelectorAll(".allpins-item").length,
      open: g.classList.contains("open"),
      bodyHidden: g.querySelector(".allpins-group-body").classList.contains("hidden")
    }));
  };
  const g0 = await page.evaluate(READ);
  ok(g0.length === 4, "⑥ 로드된 4개 그룹(A/B구역+가/나영역) 전부 렌더(기본 전체 탭, leftover 포함)", g0.map((g) => g.name));
  ok(JSON.stringify(g0.map((g) => g.name)) === JSON.stringify(["B구역", "A구역", "나영역", "가영역"]),
    "⑥ 실 DOM에서도 그룹 순서 = 트리 SoT(부모 바로 다음 자식)", g0.map((g) => g.name));
  const gA = g0.find((g) => g.name === "가영역");
  ok(gA.rows === 1 && gA.cnts.some((c) => /핀 1/.test(c)) && gA.cnts.some((c) => /사진 1/.test(c)), "⑥ 그룹 헤더 — 핀 수·사진 있음 수 정확", gA);
  const gB = g0.find((g) => g.name === "나영역");
  ok(gB.rows === 1 && gB.cnts.some((c) => /핀 1/.test(c)) && gB.cnts.some((c) => /사진 0/.test(c)), "⑥ 그룹 헤더(나영역, 사진 없음) 정확", gB);

  // ── 접기/펼치기 + localStorage 유지 ──
  await page.evaluate(() => { document.querySelectorAll(".allpins-group-head")[2].click(); }); // 나영역(3번째)
  await new Promise((r) => setTimeout(r, 100));
  const afterCollapse = await page.evaluate(READ);
  ok(afterCollapse[2].bodyHidden === true && !afterCollapse[2].open, "⑥ 그룹 헤더 클릭 → 접힘(body hidden)");
  const lsVal = await page.evaluate(() => localStorage.getItem("wm_allpins_zc:prjP186b"));
  ok(lsVal && JSON.parse(lsVal).includes("d1b"), "⑥ 접힘 상태가 localStorage(프로젝트별 키)에 저장됨", lsVal);
  await page.evaluate(() => { window.__wm.AllPins.render(); });
  await new Promise((r) => setTimeout(r, 100));
  const afterRerender = await page.evaluate(READ);
  ok(afterRerender[2].bodyHidden === true, "⑥ render() 재호출(패널 재진입과 동등) 후에도 접힘 유지");

  // ── 필터(탭) + 검색 반영 ──
  await page.evaluate(() => { window.__wm.PinSeries.setPhotoFilter("photo"); window.__wm.AllPins.render(); });
  await new Promise((r) => setTimeout(r, 100));
  const g1 = await page.evaluate(READ);
  ok(g1.length === 1 && g1[0].name === "가영역", "⑦ 탭=사진 있음 → 가영역 그룹만 남는다(나머지는 사진 없는 핀만이라 사라짐)", g1.map((g) => g.name));
  await page.evaluate(() => { window.__wm.PinSeries.setPhotoFilter("all"); window.__wm.AllPins.query = "조명"; window.__wm.AllPins.render(); });
  await new Promise((r) => setTimeout(r, 100));
  const g2 = await page.evaluate(READ);
  ok(g2.length === 1 && g2[0].name === "나영역", "⑦ 검색 '조명' → 나영역 그룹만 남는다", g2.map((g) => g.name));
  await page.evaluate(() => { window.__wm.AllPins.query = ""; window.__wm.AllPins.render(); });
  await new Promise((r) => setTimeout(r, 100));

  // ── 코멘트 요약 · [360] 버튼 ──
  const rowInfo = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".allpins-item"));
    return rows.map((r) => ({
      id: r.dataset.id,
      comment: r.querySelector(".allpins-row-comment") ? r.querySelector(".allpins-row-comment").textContent : null,
      has360: !!r.querySelector(".allpins-row-360")
    }));
  });
  const r2 = rowInfo.find((r) => r.id === "p2");
  ok(r2 && r2.comment && r2.comment.indexOf("자주 확인 필요") === 0, "⑧ 코멘트 요약(pin.note) 행에 노출", r2);
  const r1 = rowInfo.find((r) => r.id === "p1"), r4 = rowInfo.find((r) => r.id === "p4");
  ok(r1 && r1.has360 === true, "⑧ 사진 있는 핀(p1)엔 [360] 버튼 있음");
  ok(r4 && r4.has360 === false, "⑧ 사진 없는 핀(p4)엔 [360] 버튼 없음");

  ok((await page.evaluate(() => window.__wm.Projects.currentDeck.id)) === "d2", "⑧ 클릭 전 — 현재 구역은 초기값(B구역=d2)");
  await page.evaluate(() => { document.querySelector('.allpins-item[data-id="p1"] .allpins-row-360').click(); });
  await new Promise((r) => setTimeout(r, 150));
  const afterGoto = await page.evaluate(() => ({ deckId: window.__wm.Projects.currentDeck && window.__wm.Projects.currentDeck.id, calls: window.__focusCalls }));
  ok(afterGoto.deckId === "d1a", "⑧ [360] 클릭 → 구역 전환(p1 소속인 '가영역'=d1a 로 Projects.currentDeck 변경)", afterGoto.deckId);
  ok(afterGoto.calls.length === 1 && afterGoto.calls[0].id === "p1" && afterGoto.calls[0].openAfter === true, "⑧ [360] 클릭 → App.focusPin(p1, true) 1회 호출(기존 _goto 재사용)", afterGoto.calls);

  // [360] 클릭 → 기존 _goto() 가 this.hide() 까지 호출해 드로어가 닫힌다(기존 "이동+보기" 동작 그대로,
  // 회귀 아님) — 이어지는 열람 세션 점검을 위해 패널을 다시 연다(실사용자가 재진입하는 것과 동등).
  await page.evaluate(() => window.__wm.AllPins.show());
  await new Promise((r) => setTimeout(r, 300));

  // ── 열람 세션(Auth.readonly) ──
  await page.evaluate(() => { window.__wm.Auth.readonly = true; window.__wm.AllPins.render(); });
  await new Promise((r) => setTimeout(r, 100));
  const viewerDom = await page.evaluate(() => ({
    checkboxes: document.querySelectorAll(".allpins-sel").length,
    groups: document.querySelectorAll(".allpins-group").length,
    comments: document.querySelectorAll(".allpins-row-comment").length,
    btn360: document.querySelectorAll(".allpins-row-360").length
  }));
  ok(viewerDom.checkboxes === 0, "⑨ 열람 세션 — 선택 체크박스 0개(편집 노출 없음)", viewerDom);
  ok(viewerDom.groups === 4 && viewerDom.comments >= 1 && viewerDom.btn360 >= 1, "⑨ 열람 세션에서도 그룹·코멘트·[360] 은 그대로 보임(읽기 기능 유지)", viewerDom);
  await page.evaluate(() => { window.__wm.Auth.readonly = false; window.__wm.AllPins.render(); });
  await new Promise((r) => setTimeout(r, 100));

  // ── 대비 실측(≥4.5:1, 가짜 var() 추정 금지) ──
  const contrast = await page.evaluate(() => {
    function parseRgb(s) { const m = /rgba?\(([^)]+)\)/.exec(s); if (!m) return null; const p = m[1].split(",").map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    function composite(fg, bg) { if (!fg || fg.a >= 1) return fg; const a = fg.a; return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) }; }
    function lum(c) { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); }
    function ratio(a, b) { const L1 = lum(a), L2 = lum(b); const hi = Math.max(L1, L2), lo = Math.min(L1, L2); return (hi + 0.05) / (lo + 0.05); }
    function bgChainOf(el) { let n = el, bg = { r: 255, g: 255, b: 255 }; const chain = []; while (n) { chain.unshift(n); n = n.parentElement; } for (const e of chain) { const c = parseRgb(getComputedStyle(e).backgroundColor); if (c && c.a > 0) bg = composite(c, bg); } return bg; }
    function measure(sel) {
      const el = document.querySelector(sel);
      if (!el) return { exists: false };
      const cs = getComputedStyle(el);
      const fg = parseRgb(cs.color);
      const bg = bgChainOf(el);
      return { exists: true, ratio: ratio(fg, bg) };
    }
    return {
      groupHead: measure(".allpins-group-head .allpins-group-name"),
      rowComment: measure(".allpins-row-comment"),
      row360: measure(".allpins-row-360"),
      scopeActive: measure(".allpins-scope-btn.active")
    };
  });
  Object.entries(contrast).forEach(([k, v]) => ok(v.exists && v.ratio >= 4.5, "⑩ 실측 대비 " + k + " ≥ 4.5:1", v));

  // ── 모바일 375px ──
  // 🔴 [p62-tree-3level Part C 와 동일 실측 함정] isMobile:false→true 로 바뀌는 setViewport 는 Chrome
  //   이 모바일 뷰포트 재해석을 위해 문서를 다시 로드시킬 수 있다(p62 는 이 때문에 SETUP() 을 재호출)
  //   — 재현(스크린샷): 재적용 없이는 로그인 게이트 화면이 다시 뜨고 패널 width=0 이었다.
  await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  try { await page.evaluate(SETUP); } catch { await page.waitForFunction(() => !!window.__wm, { timeout: 20000 }); await page.evaluate(SETUP); }
  await new Promise((r) => setTimeout(r, 200));
  const mobile = await page.evaluate(() => {
    const panel = document.querySelector(".allpins-panel");
    const tools2 = document.querySelector(".allpins-tools2");
    const heads = Array.from(document.querySelectorAll(".allpins-group-head"));
    const btn360 = document.querySelector(".allpins-row-360");
    return {
      panelW: panel.getBoundingClientRect().width,
      tools2Dir: getComputedStyle(tools2).flexDirection,
      headTap: heads.every((h) => h.getBoundingClientRect().height >= 24),
      btn360Tap: btn360 ? btn360.getBoundingClientRect().height >= 20 : null
    };
  });
  ok(mobile.panelW > 300 && mobile.panelW <= 376, "⑪ 모바일 375px — 패널이 실제로 보이고(폭>300) 가로 스크롤을 만들지 않는다(width " + mobile.panelW + ")");
  ok(mobile.tools2Dir === "column", "⑪ 모바일에서 범위·내보내기 버튼 줄이 세로로 쌓인다(겹침 방지)");
  ok(mobile.headTap === true, "⑪ 그룹 헤더 탭 영역 ≥24px");
  fs.mkdirSync(path.join(ROOT, ".tmp", "p186"), { recursive: true });
  await page.screenshot({ path: path.join(ROOT, ".tmp", "p186", "mobile-375.png") });
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  try { await page.evaluate(SETUP); } catch { await page.waitForFunction(() => !!window.__wm, { timeout: 20000 }); await page.evaluate(SETUP); }
  await new Promise((r) => setTimeout(r, 150));
  await page.screenshot({ path: path.join(ROOT, ".tmp", "p186", "desktop-zone.png") });
  console.log("  [스크린샷] .tmp/p186/desktop-zone.png, .tmp/p186/mobile-375.png");

  const pageErrs = await page.evaluate(() => window.__wmConsoleErr || null);
  ok(pageErrs == null, "앱 콘솔 예외 추적 없음(있다면 __wmConsoleErr 로 노출돼야 함 — 이 픽스처는 미등록, 참고용)");

  await browser.close();
  server.close();
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
