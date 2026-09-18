/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p17-deck-page-crop.test.mjs)
 *
 * 대상: WORK_ORDER_20260916.md — "구역 = 도면의 한 조각(page+crop)". 마스터 원문:
 *  "구역은 pdf 여러 장을 올리더라도 한쪽 지정한 구역이나 한 장만 등록하게 해" /
 *  "구역별로 큰 pdf 영역에서 한 구역을 지정하게 해" / "그 구역을 확대해서 구역별로 관리하게 해줘" /
 *  "색 음영을 최소한으로 하고"(구역 확대 상태 한정, 영역 기본 스타일은 불변).
 *
 * 근본원인(scout 실측): decks 테이블에 페이지·영역 정보가 없어 구역이 "이름표"일 뿐이었다
 * (migrations/0002_auth_projects_decks.sql). 이번 변경으로 decks.page/decks.crop 을 추가하고
 * (migrations/0022_deck_page_crop.sql), 생성 흐름(31_Projects.js createDeck)에서 페이지 선택 +
 * 기존 영역 그리기(16_Zones.js rect 드래그) 재사용으로 crop 을 받아, 선택 흐름(selectDeck)에서
 * 기존 MapCtrl.fitZone(10_MapCtrl.js:443)으로 그 조각만 확대한다.
 *
 * 실제 모듈 소스(public/js/modules/31_Projects.js, src/index.tsx, public/css/style.css)를
 * 그대로 평가/파싱해 검사한다(목 구현 아님). 뮤테이션 4건으로 테스트 실효성을 증명한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const projectsSrc = rd("public/js/modules/31_Projects.js");
const cssSrc = rd("public/css/style.css");
const serverSrc = rd("src/index.tsx");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ══════════════════════════════════════════════════════════════════
 * 공용: 실제 Projects 모듈을 vm 에서 그대로 로드
 * ══════════════════════════════════════════════════════════════════ */
function makeSandbox(src, overrides) {
  const calls = { post: [], put: [], pick: 0, loadDrawing: [], gotoPage: [], commitZone: 0, cancelDraw: 0, bbox: 0, syncToolUi: 0 };
  const decksOnServer = [];
  const el = () => ({ classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, dataset: {}, textContent: "", innerHTML: "", addEventListener() {}, appendChild() {}, querySelector: () => el() });
  const sandbox = Object.assign({
    console,
    alert: (m) => { calls.alert = m; },
    confirm: () => true,
    navigator: { onLine: true },
    document: { getElementById: () => null, createElement: () => el(), body: { appendChild() {}, classList: { toggle: (c, v) => calls.bodyClass = [c, !!v] } } },
    Auth: { headers: () => ({}), isDesigner: true },
    Prompt: { ask: async () => ({ value: "TEST DECK" }), toast: () => {} },
    UI: { renderTree() {} },
    State: { mode: "designer", drawingZone: false },
    PDF: { load: async () => ({ numPages: 1, destroy() {} }) },
    Zones: {
      _commitZone: async () => { calls.commitZone++; },
      _cancelDraw: () => { calls.cancelDraw++; },
      _bbox: (g) => { calls.bbox++; return { x: g.x, y: g.y, w: g.w, h: g.h }; },
      _syncToolUi: () => { calls.syncToolUi++; },
      _shape: null, _poly: null
    },
    MapCtrl: { fitZone: (bb) => { calls.fitZone = calls.fitZone || []; calls.fitZone.push(bb); } },
    App: {
      _pickDrawingFile: async () => { calls.pick++; return overrides.pickResult; },
      _loadDrawing: async (f) => { calls.loadDrawing.push(f); },
      _gotoPage: async (p) => { calls.gotoPage.push(p); },
      _refreshUnsavedDecks() {}, isDeckUnsaved: () => false
    },
    fetch: async (url, opt) => {
      const method = (opt && opt.method) || "GET";
      const body = opt && opt.body ? JSON.parse(opt.body) : {};
      if (method === "POST" && /\/decks$/.test(url)) {
        calls.post.push(body);
        const d = { id: "deck_new", name: body.name, project_id: "p1", page: body.page != null ? body.page : null, crop: null };
        decksOnServer.push(d);
        return { ok: true, json: async () => d };
      }
      if (method === "GET" && /\/decks$/.test(url)) {
        return { ok: true, json: async () => ({ data: decksOnServer.slice() }) };
      }
      if (method === "PUT" && /\/api\/decks\//.test(url)) {
        calls.put.push(body);
        const d = decksOnServer.find((x) => x.id === url.split("/").pop());
        if (d) Object.assign(d, body);
        return { ok: true, json: async () => (d || {}) };
      }
      return { ok: true, json: async () => ({}) };
    }
  }, overrides.sandboxExtra || {});
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__P = Projects;", sandbox);
  const P = sandbox.__P;
  P.currentProject = { id: "p1", name: "PRJ" };
  P.decks = [];
  return { P, calls, sandbox, decksOnServer };
}

/** _pickDeckCrop 이 Zones._commitZone/_cancelDraw 를 실제로 가로챈 시점(armed)까지 마이크로태스크를 흘려보낸 뒤,
 *  드래그 완료(geom) 또는 취소(null)를 시뮬레이션한다. */
async function driveCreateDeck(P, sandbox, calls, { geom, cancel } = {}) {
  const armedBefore = calls.syncToolUi;
  const p = P.createDeck();
  for (let i = 0; i < 100 && calls.syncToolUi === armedBefore; i++) {
    await new Promise((r) => setImmediate(r));
  }
  if (cancel) sandbox.Zones._cancelDraw();
  else if (geom) await sandbox.Zones._commitZone(geom);
  return await p;
}

/* ══════════════════════════════════════════════════════════════════
 * ① 여러 장 PDF → 선택한 1페이지만 deck.page 에 기록
 * ══════════════════════════════════════════════════════════════════ */
{
  const file = { name: "big.pdf", type: "application/pdf", arrayBuffer: async () => new ArrayBuffer(8) };
  const { P, calls, sandbox } = makeSandbox(projectsSrc, {
    pickResult: file,
    sandboxExtra: {
      PDF: { load: async () => ({ numPages: 5, destroy() {} }) },
      Prompt: { ask: async (o) => (o.title === "페이지 선택" ? { value: "3" } : { value: "TEST DECK" }), toast: () => {} }
    }
  });
  const r = await driveCreateDeck(P, sandbox, calls, { cancel: true }); // crop 은 건너뜀(페이지만 검증)
  ok(r && r.page === 3, `① 선택한 페이지(3)가 POST body 에 실림 → r.page=${r && r.page}`);
  ok(calls.post[0] && calls.post[0].page === 3, `① POST body.page === 3 (실제 ${calls.post[0] && calls.post[0].page})`);
}

/* ══════════════════════════════════════════════════════════════════
 * ② 영역 지정 → deck.crop 에 {x,y,w,h}(%) 저장
 * ══════════════════════════════════════════════════════════════════ */
{
  const file = { name: "single.png", type: "image/png" };
  const { P, calls, sandbox } = makeSandbox(projectsSrc, { pickResult: file });
  const geom = { shape: "rect", x: 10, y: 20, w: 30, h: 15 };
  const r = await driveCreateDeck(P, sandbox, calls, { geom });
  ok(!!(r && r.crop && r.crop.x === 10 && r.crop.y === 20 && r.crop.w === 30 && r.crop.h === 15),
    `② 드래그한 영역이 deck.crop(%) 로 저장됨 → ${JSON.stringify(r && r.crop)}`);
  ok(calls.put.length === 1 && calls.put[0].crop && calls.put[0].crop.w === 30, `② PUT /api/decks/:id 로 crop 전송 (put=${JSON.stringify(calls.put)})`);
}

/* ══════════════════════════════════════════════════════════════════
 * ③ 영역 지정을 건너뛰면 crop = NULL(페이지 전체)
 * ══════════════════════════════════════════════════════════════════ */
{
  const file = { name: "single.png", type: "image/png" };
  const { P, calls, sandbox } = makeSandbox(projectsSrc, { pickResult: file });
  const r = await driveCreateDeck(P, sandbox, calls, { cancel: true });
  ok(!!r && (r.crop === null || r.crop === undefined), `③ 크롭 건너뜀 → deck.crop = NULL (실제 ${JSON.stringify(r && r.crop)})`);
  ok(calls.put.length === 0, `③ crop 없으면 PUT 호출 안 함 (실제 ${calls.put.length}회)`);
}

/* ══════════════════════════════════════════════════════════════════
 * ④ / ⑥ selectDeck — page 전환 + crop 있으면 fitZone, 같은 배포본의 다른 페이지 가능
 * ══════════════════════════════════════════════════════════════════ */
function makeSelectSandbox(src) {
  const calls = { loadDeckDrawing: [], gotoPage: [], fitZone: [], bodyClass: [] };
  const sandbox = {
    console,
    document: { body: { classList: { toggle: (c, v) => calls.bodyClass.push([c, !!v]) } } },
    Auth: { headers: () => ({}) },
    Prompt: { toast: () => {} },
    State: { mode: "designer" },
    App: {
      loadDeckDrawing: async (id) => { calls.loadDeckDrawing.push(id); },
      _gotoPage: async (p) => { calls.gotoPage.push(p); }
    },
    MapCtrl: { fitZone: (bb) => calls.fitZone.push(bb) }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__P = Projects;", sandbox);
  const P = sandbox.__P;
  P._renderDecks = () => {};
  return { P, calls };
}

{
  const { P, calls } = makeSelectSandbox(projectsSrc);
  const d = { id: "d1", name: "3F", deployment_id: "depX", page: 3, crop: { x: 5, y: 5, w: 40, h: 40 } };
  await P.selectDeck(d);
  ok(calls.loadDeckDrawing[0] === "depX", "④ selectDeck → loadDeckDrawing(deployment_id) 호출");
  ok(calls.gotoPage[0] === 3, `④ deck.page(3) 로 _gotoPage 호출 (실제 ${calls.gotoPage[0]})`);
  ok(calls.fitZone.length === 1 && calls.fitZone[0].w === 40, `④ crop 있으면 MapCtrl.fitZone 호출 (실제 ${JSON.stringify(calls.fitZone)})`);
  ok(calls.bodyClass.some((x) => x[0] === "deck-view-active" && x[1] === true), "④ deck-view-active 클래스 on(crop 있음)");
}

{
  // ⑥ 같은 배포본(depX)의 다른 페이지를 가리키는 구역 2개
  const { P, calls } = makeSelectSandbox(projectsSrc);
  await P.selectDeck({ id: "dA", name: "1F", deployment_id: "depX", page: 1, crop: null });
  await P.selectDeck({ id: "dB", name: "2F", deployment_id: "depX", page: 2, crop: null });
  ok(calls.loadDeckDrawing.length === 2 && calls.loadDeckDrawing.every((x) => x === "depX"),
    `⑥ 두 구역 모두 같은 배포본(depX) 로드 (실제 ${JSON.stringify(calls.loadDeckDrawing)})`);
  ok(calls.gotoPage.join(",") === "1,2", `⑥ 각 구역이 자신의 page 로 전환(1, 2) (실제 ${calls.gotoPage.join(",")})`);
}

/* ══════════════════════════════════════════════════════════════════
 * ⑤ 회귀 — 구버전 구역(page/crop 없음)은 종전대로(page 전환·fitZone·deck-view-active 없음)
 * ══════════════════════════════════════════════════════════════════ */
function regressionCheck(src) {
  const { P, calls } = makeSelectSandbox(src);
  return P.selectDeck({ id: "old1", name: "레거시", deployment_id: "depOld" }).then(() => calls);
}
{
  const calls = await regressionCheck(projectsSrc);
  ok(calls.gotoPage.length === 0, `⑤ 구버전 구역 → _gotoPage 호출 안 함 (실제 ${calls.gotoPage.length}회)`);
  ok(calls.fitZone.length === 0, `⑤ 구버전 구역 → fitZone 호출 안 함 (실제 ${calls.fitZone.length}회)`);
  ok(calls.bodyClass.some((x) => x[0] === "deck-view-active" && x[1] === false), "⑤ 구버전 구역 → deck-view-active off");
}

/* ══════════════════════════════════════════════════════════════════
 * 서버 mapDeck — page/crop NULL 패스스루 (src/index.tsx)
 * ══════════════════════════════════════════════════════════════════ */
{
  const start = "function mapDeck(r: any) {";
  const s = serverSrc.indexOf(start);
  const e = serverSrc.indexOf("\n}", s) + 2;
  if (s < 0) { ok(false, "서버 mapDeck 함수를 찾지 못함(소스 변경?)"); }
  else {
    const fnSrc = serverSrc.slice(s, e).replace(/: any/g, "");
    const mapDeck = new Function("return (" + fnSrc.replace("function mapDeck", "function") + ")")();
    const oldRow = { id: "d1", project_id: "p1", name: "Old", level_no: null, deployment_id: "dep1", created_at: 1, updated_at: 1 }; // page/crop 컬럼 없음(구버전 행)
    const mapped = mapDeck(oldRow);
    ok(mapped.page === null && mapped.crop === null, `서버 mapDeck: 구버전 행(컬럼 없음) → page/crop = null (실제 ${JSON.stringify({ page: mapped.page, crop: mapped.crop })})`);
    const newRow = { ...oldRow, page: 3, crop: JSON.stringify({ x: 1, y: 2, w: 3, h: 4 }) };
    const mapped2 = mapDeck(newRow);
    ok(mapped2.page === 3 && mapped2.crop.w === 3, `서버 mapDeck: 신규 행 → page/crop 파싱됨 (실제 ${JSON.stringify(mapped2.page)}, ${JSON.stringify(mapped2.crop)})`);
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 색 음영 최소화(구역 확대 상태) — fill-opacity 인하 + 외곽선 대비 ≥3:1
 * ══════════════════════════════════════════════════════════════════ */
function checkDeckViewCss(css) {
  const m = css.match(/body\.deck-view-active \.zone-shape\{([^}]*)\}/);
  if (!m) return { found: false };
  const rule = m[1];
  const fo = rule.match(/fill-opacity:\s*([\d.]+)/);
  const br = rule.match(/brightness\(([\d.]+)\)/);
  return { found: true, fillOpacity: fo ? parseFloat(fo[1]) : 1, brightness: br ? parseFloat(br[1]) : 1 };
}
function lum(r, g, b) {
  const f = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrastVsWhite(hex, k) {
  const c = hex.replace("#", "");
  const r = (parseInt(c.slice(0, 2), 16) / 255) * k, g = (parseInt(c.slice(2, 4), 16) / 255) * k, b = (parseInt(c.slice(4, 6), 16) / 255) * k;
  return (1 + 0.05) / (lum(r, g, b) + 0.05);
}
const zoneColorsMatch = rd("public/js/modules/15_Compare.js").match(/ZONE_COLORS\s*=\s*\[([^\]]+)\]/);
const ZONE_COLORS = zoneColorsMatch ? zoneColorsMatch[1].match(/#[0-9a-fA-F]{6}/g) : [];
{
  ok(ZONE_COLORS.length === 6, `사전조건: ZONE_COLORS 6색 실측 (실제 ${ZONE_COLORS.length}) — ${ZONE_COLORS.join(",")}`);
  const info = checkDeckViewCss(cssSrc);
  ok(info.found, "구역 확대 상태 CSS 규칙(body.deck-view-active .zone-shape) 존재");
  ok(info.fillOpacity < 1, `채움 불투명도가 평상시(1)보다 낮음 (실제 fill-opacity=${info.fillOpacity})`);
  const contrasts = ZONE_COLORS.map((c) => +contrastVsWhite(c, info.brightness).toFixed(2));
  const minC = Math.min(...contrasts);
  ok(minC >= 3.0, `외곽선 대비 실측(흰 배경, brightness(${info.brightness})) 전부 ≥3:1 — ${ZONE_COLORS.map((c, i) => c + "=" + contrasts[i]).join(", ")} (최저 ${minC})`);
}

/* ══════════════════════════════════════════════════════════════════
 * 뮤테이션 4건 — 되돌리면 각각 실패해야 한다(확인 후 원복 = 파일 미변경, in-memory 뮤테이션)
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션 M1] body.page = page 제거 → ① 실패해야 함");
{
  const mut = projectsSrc.replace("if (opts.askDrawing !== false) body.page = page; // 자동생성 경로는 전송하지 않음 → 서버 NULL(구버전과 동일)", "// removed");
  if (mut === projectsSrc) ok(false, "M1 앵커 없음(소스 변경?)");
  else {
    const file = { name: "big.pdf", type: "application/pdf", arrayBuffer: async () => new ArrayBuffer(8) };
    const { P, calls, sandbox } = makeSandbox(mut, {
      pickResult: file,
      sandboxExtra: { PDF: { load: async () => ({ numPages: 5, destroy() {} }) }, Prompt: { ask: async (o) => (o.title === "페이지 선택" ? { value: "3" } : { value: "TEST DECK" }), toast: () => {} } }
    });
    const r = await driveCreateDeck(P, sandbox, calls, { cancel: true });
    ok(!(r && r.page === 3), `M1 무력화 시 ①이 다시 깨짐(page 저장 안 됨) → r.page=${r && r.page}`);
  }
}
console.log("\n[뮤테이션 M2] crop 저장(_pickDeckCrop 결과) 무시 → ② 실패해야 함");
{
  const mut = projectsSrc.replace("const crop = await this._pickDeckCrop();", "const crop = await this._pickDeckCrop(); /*M2*/ const __ignored = crop; const crop2 = null;")
                          .replace("if (crop) {", "if (crop2) {");
  if (!mut.includes("crop2")) ok(false, "M2 앵커 없음(소스 변경?)");
  else {
    const file = { name: "single.png", type: "image/png" };
    const { P, calls, sandbox } = makeSandbox(mut, { pickResult: file });
    const geom = { shape: "rect", x: 10, y: 20, w: 30, h: 15 };
    const r = await driveCreateDeck(P, sandbox, calls, { geom });
    ok(!(r && r.crop && r.crop.w === 30), `M2 무력화 시 ②가 다시 깨짐(crop 저장 안 됨) → ${JSON.stringify(r && r.crop)}`);
  }
}
console.log("\n[뮤테이션 M3] selectDeck 의 NULL 폴백 가드 제거 → ⑤ 실패해야 함");
{
  const mut = projectsSrc.replace(
    'if (d.page && typeof App._gotoPage === "function") { try { await App._gotoPage(d.page); } catch (e) {} }',
    'if (typeof App._gotoPage === "function") { try { await App._gotoPage(d.page); } catch (e) {} }'
  );
  if (mut === projectsSrc) ok(false, "M3 앵커 없음(소스 변경?)");
  else {
    const calls = await regressionCheck(mut);
    ok(calls.gotoPage.length > 0, `M3 무력화 시 ⑤가 다시 깨짐(구버전 구역도 _gotoPage 호출됨) → ${calls.gotoPage.length}회`);
  }
}
console.log("\n[뮤테이션 M4] deck-view-active 채움 인하 제거 → 색음영 최소화 검증 실패해야 함");
{
  const mutCss = cssSrc.replace("body.deck-view-active .zone-shape{ fill-opacity:.25; filter:brightness(.8); }", "body.deck-view-active .zone-shape{ }");
  if (mutCss === cssSrc) ok(false, "M4 앵커 없음(소스 변경?)");
  else {
    const info = checkDeckViewCss(mutCss);
    ok(!(info.found && info.fillOpacity < 1), `M4 무력화 시 채움 인하 규칙이 사라져 검증 실패 재현 (info=${JSON.stringify(info)})`);
  }
}

console.log("\n" + (failed ? "FAILED " + failed : "ALL PASS"));
process.exit(failed ? 1 : 0);
