/**
 * p56 — 구역 생성 시 "기존 도면에서 영역 지정" vs "새 도면 파일 업로드" 선택 분기
 * (프레임워크 0 · 실행: node tests/p56-deck-from-region.test.mjs)
 *
 * 마스터 원문(2026-09-21): "구역, 새로운 파일 로드가 아니라 이미 로드된 파일에서
 * 지정 시 캡처하듯이 완전한 새로운 페이지를 생성하게 해봐" — 2026-09-17 의 미완 재요청:
 * "구역을 등록할 때 기존 도면에서 영역을 지정할 건지 새로운 도면으로 할 건지 선택하게 해".
 *
 * 구현(새 메커니즘 0 — 기존 자산 재사용):
 *   · 선택 UI  : #deck-source-modal (기존 .admin-gate 패턴, proj-mode-select-modal 과 동일 클래스)
 *   · ①경로   : 31_Projects.createDeck() → Projects.extractRegionAsDeck() (기존, WO 20260918-B)
 *   · ②경로   : 31_Projects.createDeck() 기존 파일업로드 흐름 그대로(변경 없음)
 *   · 판단    : canExtract = !!(currentDeck && currentDeck.deployment_id)
 *
 * 검증:
 *   ① 구역 생성 시 두 선택지가 제시된다(도면 열려있음 → region 활성)
 *   ② 로드된 도면 없음 → region 비활성 + 이유 안내, upload 만 진행
 *   ③ 영역 지정으로 만든 구역이 독립 페이지처럼 동작(selectDeck 시 자기 crop 렌더)
 *   ④ 🔴 원본 deck·deployment 불변(쓰기 0건)
 *   ⑤ 반복 생성 가능(연속 2회)
 *   ⑥ 좌표 왕복 일치(기존 MapCtrl 함수 재사용 — p49 와 동일 허용치 1e-9 %p)
 *   ⑦ 목록에서 두 종류 구분(region=crop 아이콘, upload=파일/폴더 아이콘)
 *   ⑧ 모바일 겹침 0 — .admin-gate(z-index 9999, position:fixed inset:0) 가
 *      .mobile-dock(z-index 140) 보다 항상 위에 전체화면으로 뜬다(겹침이 아니라 완전히 덮음)
 *   ⑨ 36_Help.js 매뉴얼 항목 + 버튼 배선
 *   ⑩ 🔴 [WO 20260921-tree] extractRegionAsDeck() 이 parent_id 를 부모 구역 id 로 설정한다
 *      (원본이 이미 "영역"이어도 그 부모(루트 구역)에 붙여 트리 4단을 넘지 않게 한다)
 *
 * 🔴 뮤테이션 4건: ⓐ 선택 분기 제거 → ① 실패 · ⓑ 원본 변형 → ④ 실패 · ⓒ 좌표 재매핑 제거 → ⑥ 실패 ·
 *                 ⓓ parent_id 제거 → ⑩ 실패
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

const projectsSrc = rd("public/js/modules/31_Projects.js");
const mapSrc      = rd("public/js/modules/10_MapCtrl.js");
const helpSrc     = rd("public/js/modules/36_Help.js");
const indexHtml   = rd("public/index.html");
const styleCss    = rd("public/css/style.css").replace(/\/\*[\s\S]*?\*\//g, "");
const mainJs      = rd("public/js/main.js");

/* ══ 실제 워커(src/index.tsx) 번들 — 서버는 실 핸들러로 돌린다 ═══════════ */
const outFile = path.join(os.tmpdir(), "p56-worker-" + process.pid + ".mjs");
await esbuild.build({
  entryPoints: [path.join(ROOT, "src/index.tsx")],
  bundle: true, format: "esm", platform: "node", outfile: outFile,
  jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
});
const worker = (await import("file://" + outFile.replace(/\\/g, "/"))).default;
fs.unlinkSync(outFile);

/* ══ D1 데이터스토어 가짜 — 모든 run() SQL 을 writeLog 에 남긴다 ══════════ */
const PID = "prj_b0", DEP_ID = "dep_b0", SRC_DECK = "dck_src_b";
function freshDb() {
  return {
    writeLog: [],
    settings: {},
    sessions: { "local-designer-tok": { email: "designer@example.com", expires_at: Date.now() + 8.64e7, revoked: 0 } },
    localUsers: { "designer@example.com": { email: "designer@example.com", name: "설계자", deleted: 0, must_change_password: 0 } },
    designers: new Set(["designer@example.com"]),
    deployments: { [DEP_ID]: { id: DEP_ID, project_id: PID, pins: "[]", zones: "[]", annotations: "[]", version: 3, deleted: 0, tenant_id: null, file_name: "hull_plan.pdf", drawing_data: "data:image/png;base64,AAAA" } },
    decks: [{ id: SRC_DECK, project_id: PID, name: "원본 도면", level_no: 1, deployment_id: DEP_ID, page: 1, crop: null, created_at: 100, updated_at: 100, deleted: 0 }],
    nextDeckSeq: 1,
  };
}
function makeDB(st) {
  const like = (q, s) => q.indexOf(s) >= 0;
  return {
    prepare(sql) {
      const q = sql.replace(/\s+/g, " ").trim();
      return {
        bind(...a) {
          return {
            async first() {
              if (like(q, "FROM app_settings")) return st.settings[a[0]] ? { value: st.settings[a[0]] } : null;
              if (like(q, "FROM local_sessions WHERE token = ?")) return st.sessions[a[0]] || null;
              if (like(q, "FROM local_users WHERE email = ?")) return st.localUsers[String(a[0]).toLowerCase()] || null;
              if (like(q, "FROM designers WHERE email = ?")) return st.designers.has(String(a[0]).toLowerCase()) ? { email: a[0], deleted: 0 } : null;
              if (like(q, "FROM decks WHERE id = ?")) return st.decks.find((d) => d.id === a[0]) || null;
              if (like(q, "FROM deployments WHERE id = ?")) return st.deployments[a[0]] || null;
              if (like(q, "FROM tenant_members")) return null;
              return null;
            },
            async all() {
              // [WO 20260921-tree] GET /api/projects/:id/decks 는 deployments 를 LEFT JOIN 해
              //   도면 파일명을 함께 돌려준다(필드 추가). 가짜 D1 도 그 JOIN 을 그대로 흉내낸다.
              if (like(q, "FROM decks WHERE project_id = ? AND deleted = 0") || like(q, "FROM decks d LEFT JOIN deployments"))
                return { results: st.decks.filter((d) => d.project_id === a[0] && !d.deleted).map((d) => {
                  const dp = d.deployment_id ? st.deployments[d.deployment_id] : null;
                  return { ...d, deployment_title: dp ? (dp.title ?? null) : null, deployment_file_name: dp ? (dp.file_name ?? null) : null };
                }) };
              return { results: [] };
            },
            async run() {
              st.writeLog.push({ sql: q, args: a });
              // [WO 20260921-tree] 컬럼 위치 고정 파싱은 컬럼이 하나만 늘어도 조용히 틀린다
              //   (parent_id 추가 때 실제로 깨졌다) → SQL 의 컬럼 목록을 읽어 이름으로 매핑한다.
              if (like(q, "INSERT INTO decks")) {
                const cols = (q.match(/INSERT INTO decks \(([^)]*)\)/) || ["", ""])[1].split(",").map((x) => x.trim());
                const row = { deleted: 0 };
                cols.forEach((cname, i) => { row[cname] = a[i]; });
                row.deployment_id = row.deployment_id || null;
                row.deleted = 0;
                st.decks.push(row);
              } else if (like(q, "UPDATE decks SET deleted = 1")) {
                const d = st.decks.find((x) => x.id === a[1]); if (d) { d.deleted = 1; d.updated_at = a[0]; }
              } else if (like(q, "UPDATE decks SET name =")) {
                const cols = (q.match(/UPDATE decks SET (.*) WHERE id = \?/) || ["", ""])[1]
                  .split(",").map((x) => x.trim().replace(/\s*=\s*\?$/, ""));
                const d = st.decks.find((x) => x.id === a[cols.length]);
                if (d) cols.forEach((cname, i) => { d[cname] = a[i]; });
              } else if (like(q, "UPDATE decks SET crop")) {
                const d = st.decks.find((x) => x.id === a[a.length - 1]);
                if (d) { d.crop = a[0]; d.updated_at = a[1]; }
              } else if (like(q, "INSERT INTO app_settings")) {
                if (!st.settings[a[0]]) st.settings[a[0]] = a[1];
              } else if (like(q, "UPDATE deployments") || like(q, "INSERT INTO deployments")) {
                throw new Error("🔴 원본 배포본에 쓰기 시도 — 비파괴 위반");
              }
              return { success: true };
            },
          };
        },
        async first() { return null; },
        async all() { return { results: [] }; },
        async run() { return { success: true }; },
      };
    },
  };
}

/* ══ 가짜 DOM 레지스트리 — 새 선택 모달(#deck-source-modal)만 실제로 흉내낸다 ══ */
function makeEl() {
  const classes = new Set();
  return {
    _classes: classes,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, force) => { const has = classes.has(c); const want = force === undefined ? !has : force; if (want) classes.add(c); else classes.delete(c); return want; },
      contains: (c) => classes.has(c),
    },
    disabled: false, onclick: null, textContent: "", style: {},
  };
}
function makeDom() {
  const reg = {};
  ["deck-source-modal", "dsm-backdrop", "dsm-btn-region", "dsm-btn-upload", "dsm-region-reason", "dsm-sub", "dsm-cancel"].forEach((id) => { reg[id] = makeEl(); });
  reg["deck-source-modal"].classList.add("hidden");
  reg["dsm-region-reason"].classList.add("hidden");
  return reg;
}

/* ══ 클라이언트 — 31_Projects.js 실 소스를 vm 에 올리고 fetch 를 실 서버에 연결 ══ */
function makeClient(db, dom) {
  const calls = { toasts: [], syncToolUi: 0, cancelDraw: 0, fitZone: [], setDeckCrop: [], pickDrawingFile: 0 };
  const el = () => ({ classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, dataset: {}, textContent: "", innerHTML: "", addEventListener() {}, appendChild() {}, querySelector: () => el(), querySelectorAll: () => [] });
  const ENV = { DB: makeDB(db), DEMO_LOGIN: "0" };
  const sandbox = {
    console, JSON, Math, Date, Set, Map, Promise, Object, Array, String, Number, Boolean, URLSearchParams, setTimeout,
    requestAnimationFrame: (fn) => fn(),
    alert() {}, confirm: () => true,
    navigator: { onLine: true },
    location: { search: "" },
    document: {
      getElementById: (id) => (dom && dom[id]) || null,
      createElement: () => el(), querySelector: () => null,
      body: { appendChild() {}, classList: { toggle() {} } },
    },
    Auth: { headers: () => ({ Authorization: "Bearer local-designer-tok", "Content-Type": "application/json" }), isDesigner: true },
    Prompt: { ask: async () => ({ value: "" }), toast: (m) => calls.toasts.push(String(m)) },
    UI: { renderTree() {}, $: () => null },
    State: { mode: "designer", drawingZone: false, pdfPage: 1 },
    PDF: { load: async () => ({ numPages: 1, destroy() {} }), setDeckCrop: (c) => calls.setDeckCrop.push(c) },
    MapCtrl: { fitZone: (bb) => calls.fitZone.push(bb) },
    Zones: {
      _commitZone: async () => {},
      _cancelDraw() { calls.cancelDraw++; sandbox.State.drawingZone = false; calls.syncToolUi++; },
      _bbox: (g) => ({ x: g.x, y: g.y, w: g.w, h: g.h }),
      _syncToolUi: () => { calls.syncToolUi++; },
      _shape: null, _poly: null,
    },
    App: {
      _refreshUnsavedDecks() {}, isDeckUnsaved: () => false,
      _pickDrawingFile: async () => { calls.pickDrawingFile++; return { name: "new_upload.png", type: "image/png" }; },
      _loadDrawing: async () => {}, _gotoPage: async () => {}, loadDeckDrawing: async () => {},
    },
    ProjectHub: {},
    fetch: async (url, opt) => {
      const o = opt || {};
      const req = new Request("https://scan.seastar.work" + url, {
        method: o.method || "GET",
        headers: Object.assign({ Host: "scan.seastar.work" }, o.headers || {}),
        body: o.body,
      });
      ENV.DB = makeDB(db);
      return await worker.fetch(req, ENV, { waitUntil() {}, passThroughOnException() {} });
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(projectsSrc + "\n;globalThis.__P = Projects;", sandbox);
  const P = sandbox.__P;
  P.currentProject = { id: PID, name: "B0 프로젝트" };
  return { P, sandbox, calls };
}

const waitUntil = async (fn, max) => {
  for (let i = 0; i < (max || 400) && !fn(); i++) await new Promise((r) => setTimeout(r, 0));
  if (!fn()) throw new Error("waitUntil timeout — condition never became true");
};
const clone = (o) => JSON.parse(JSON.stringify(o));

/* ══════════════════════════════════════════════════════════════════════
 * ① 선택 분기 제공 — 도면이 열려 있으면 region 옵션이 활성
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[① 구역 생성 시 두 선택지 — 도면이 열려 있으면 ①이 활성]");
const db = freshDb();
const dom1 = makeDom();
const c1 = makeClient(db, dom1);
await c1.P.loadDecks();
c1.P.currentDeck = c1.P.decks.find((d) => d.id === SRC_DECK);
ok(!!c1.P.currentDeck && !!c1.P.currentDeck.deployment_id, "① 사전조건 — 도면 등록된 구역이 열려 있다");

const srcDeckBefore = clone(db.decks.find((d) => d.id === SRC_DECK));
const depBefore = clone(db.deployments[DEP_ID]);
const writeLogBefore0 = db.writeLog.length;

const pending1 = c1.P.createDeck({ name: "영역 R1" });
await waitUntil(() => dom1["deck-source-modal"]._classes.has("on"));
ok(dom1["deck-source-modal"]._classes.has("on"), "① 선택 모달이 실제로 열림");
ok(dom1["dsm-btn-region"].disabled === false, "① 도면이 열려있을 때 '기존 도면에서 영역 지정' 버튼 활성");
ok(dom1["dsm-region-reason"].classList.contains("hidden") === true, "① 활성 상태에서는 비활성 사유 문구가 숨겨짐");
ok(dom1["dsm-btn-upload"].disabled !== true, "① '새 도면 파일 업로드' 버튼도 항상 선택 가능");

// 사용자가 ①(기존 도면에서 영역 지정)을 누른다 → extractRegionAsDeck 로 위임 → 드래그 대기
dom1["dsm-btn-region"].onclick();
const armedBefore1 = c1.calls.syncToolUi;
await waitUntil(() => c1.calls.syncToolUi > armedBefore1);
ok(c1.calls.syncToolUi > armedBefore1, "① region 선택 후 기존 Zones 드래그 모드가 실제로 켜짐(extractRegionAsDeck 재사용)");
await c1.sandbox.Zones._commitZone({ shape: "rect", x: 10, y: 12, w: 30, h: 25 });
const regionDeck1 = await pending1;
ok(!!regionDeck1 && regionDeck1.id, "① 새 구역 생성됨: " + (regionDeck1 && regionDeck1.name));
ok(regionDeck1.deployment_id === DEP_ID, "① 원본과 같은 deployment_id 를 가리킴(픽셀 복사 아님)");
ok(regionDeck1.crop && regionDeck1.crop.x === 10 && regionDeck1.crop.w === 30, "① 드래그한 crop 이 그대로 저장됨");

/* ══════════════════════════════════════════════════════════════════════
 * ② 로드된 도면 없음 → ①이 비활성 + 이유 안내, ②만 진행
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[② 로드된 도면이 없으면 '기존 도면에서 영역 지정'을 고를 수 없다 — 이유 안내]");
const dom2 = makeDom();
const c2 = makeClient(db, dom2);
await c2.P.loadDecks();
c2.P.currentDeck = null; // 아무 구역도 열려있지 않음 = 로드된 도면 없음

const pending2 = c2.P.createDeck({ name: "새파일 U1" });
await waitUntil(() => dom2["deck-source-modal"]._classes.has("on"));
ok(dom2["dsm-btn-region"].disabled === true, "② 로드된 도면이 없으면 region 버튼이 비활성");
ok(dom2["dsm-region-reason"].classList.contains("hidden") === false, "② 비활성 사유가 화면에 안내됨(조용히 숨기지 않음)");

// 비활성 버튼을 눌러도 아무 일도 일어나지 않아야 한다(가드)
dom2["dsm-btn-region"].onclick();
ok(dom2["deck-source-modal"]._classes.has("on"), "② 비활성 버튼 클릭은 무시됨 — 모달이 계속 열려 있음");

// 이유를 확인한 사용자가 업로드를 선택
dom2["dsm-btn-upload"].onclick();
const armedCancel = c2.calls.cancelDraw;
await waitUntil(() => c2.calls.pickDrawingFile > 0);
ok(c2.calls.pickDrawingFile === 1, "② upload 선택 시 기존 App._pickDrawingFile() 파일선택 흐름을 그대로 탄다");
// 크롭 지정은 건너뜀(Esc) — 업로드 파일 자체의 크롭은 이 테스트의 관심사가 아님
await waitUntil(() => c2.calls.syncToolUi > 0);
await c2.sandbox.Zones._cancelDraw();
const uploadDeck2 = await pending2;
ok(!!uploadDeck2 && uploadDeck2.id, "② 업로드 경로로도 정상적으로 구역이 생성됨: " + (uploadDeck2 && uploadDeck2.name));
ok(!uploadDeck2.deployment_id, "② 업로드 구역은 원본과 deployment_id 를 공유하지 않는다(자기 파일)");

/* ══════════════════════════════════════════════════════════════════════
 * ③ 영역 지정 구역 = 독립 페이지처럼 동작(selectDeck → 자기 crop 렌더)
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[③ 영역 구역 선택 시 자기 crop 만 확대 렌더(독립 페이지처럼 동작)]");
{
  const before = c1.calls.setDeckCrop.length;
  await c1.P.selectDeck(regionDeck1);
  ok(c1.calls.setDeckCrop.length > before && JSON.stringify(c1.calls.setDeckCrop[c1.calls.setDeckCrop.length - 1]) === JSON.stringify(regionDeck1.crop),
    "③ PDF.setDeckCrop 이 이 구역만의 crop 으로 호출됨(다른 구역과 독립)");
  ok(c1.calls.fitZone.some((z) => z.x === regionDeck1.crop.x && z.w === regionDeck1.crop.w),
    "③ MapCtrl.fitZone 이 이 구역의 영역으로 화면을 맞춤 — 자기 영역만 확대 표시");
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 🔴 원본 deck·deployment 불변
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[④ 원본 도면(deployment)·원본 구역 불변]");
{
  const newWrites = db.writeLog.slice(writeLogBefore0);
  const depWrites = newWrites.filter((w) => /deployments/.test(w.sql));
  ok(depWrites.length === 0, "④ deployments(원본)에 대한 쓰기 0건, 실제 " + depWrites.length);
  ok(JSON.stringify(db.deployments[DEP_ID]) === JSON.stringify(depBefore), "④ 원본 배포본 바이트 단위 불변");
  ok(JSON.stringify(db.decks.find((d) => d.id === SRC_DECK)) === JSON.stringify(srcDeckBefore), "④ 원본 구역 행 불변");
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 반복 생성 가능(연속 2회)
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[⑤ 같은 도면에서 반복해 영역 구역을 만들 수 있다]");
{
  const dom3 = makeDom();
  const c3 = makeClient(db, dom3);
  await c3.P.loadDecks();
  c3.P.currentDeck = c3.P.decks.find((d) => d.id === SRC_DECK);
  const results = [];
  const views = [{ name: "영역 R2", crop: { x: 2, y: 3, w: 20, h: 18 } }, { name: "영역 R3", crop: { x: 40, y: 40, w: 22, h: 20 } }];
  for (const v of views) {
    const p = c3.P.createDeck({ name: v.name });
    await waitUntil(() => dom3["deck-source-modal"]._classes.has("on"));
    dom3["dsm-btn-region"].onclick();
    const armed = c3.calls.syncToolUi;
    await waitUntil(() => c3.calls.syncToolUi > armed);
    await c3.sandbox.Zones._commitZone({ shape: "rect", ...v.crop });
    results.push(await p);
  }
  ok(results.every((d) => d && d.id), "⑤ 2회 연속 생성 모두 성공: " + results.map((d) => d && d.name).join(", "));
  ok(new Set(results.map((d) => d.id)).size === 2, "⑤ 서로 다른 구역 2개(재사용 아님)");
  ok(results.every((d) => d.deployment_id === DEP_ID), "⑤ 모두 원본과 같은 deployment_id");
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 좌표 왕복 일치(기존 MapCtrl 함수 재사용)
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[⑥ 좌표 정합 — 영역 안 좌표 ↔ 원본(페이지) 좌표 왕복]");
{
  const TOL = 1e-9;
  const mapSand = { console, Math, Object, JSON, Array, Number };
  vm.createContext(mapSand);
  function extractBalanced(src, needle) {
    const start = src.indexOf(needle);
    if (start < 0) throw new Error("needle not found: " + needle);
    const braceStart = src.indexOf("{", start);
    let depth = 0, i = braceStart;
    for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { depth--; if (depth === 0) break; } }
    return src.slice(start, i + 1);
  }
  vm.runInContext(
    "const MapCtrl = {" + extractBalanced(mapSrc, "pageToDeckCropPct(x, y, crop) {") + "," + extractBalanced(mapSrc, "deckCropPctToPage(x, y, crop) {") + "};\n" +
    "globalThis.__M = MapCtrl;", mapSand);
  const M = mapSand.__M;
  ok(typeof M.pageToDeckCropPct === "function" && typeof M.deckCropPctToPage === "function", "⑥ 사전조건 — 기존 변환 함수 로드");
  const c = regionDeck1.crop;
  let worst = 0, checked = 0;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
    const px = c.x + (c.w * i) / 10, py = c.y + (c.h * j) / 10;
    const inCrop = M.pageToDeckCropPct(px, py, c);
    if (!inCrop) continue;
    const back = M.deckCropPctToPage(inCrop.x, inCrop.y, c);
    worst = Math.max(worst, Math.abs(back.x - px), Math.abs(back.y - py));
    checked++;
  }
  ok(checked === 121, "⑥ 검사 점 수 11×11 = 121, 실제 " + checked);
  ok(worst <= TOL, "⑥ 왕복 최대 오차 " + worst.toExponential(2) + " %p ≤ 허용치 " + TOL + " %p");
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑦ 목록에서 두 종류 구분
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[⑦ 구역 목록에서 영역-추출 구역과 업로드 구역이 구분된다]");
ok(/isRegion\s*=\s*!!\(d\.crop/.test(projectsSrc), "⑦a _renderDecks 가 crop 유무로 구분 아이콘을 정한다(기존 로직 재사용)");
ok(/fa-crop-simple/.test(projectsSrc) && /도면에서 긁어낸 영역/.test(projectsSrc), "⑦b 영역-추출 구역 전용 아이콘/툴팁 존재");
ok(!!regionDeck1.crop && !uploadDeck2.deployment_id, "⑦c 실측 — region 구역은 crop 보유, upload 구역은 별도 deployment(공유 아님)");

/* ══════════════════════════════════════════════════════════════════════
 * ⑧ 모바일 375×812 겹침 0 — .admin-gate 전체화면 오버레이가 하단 독을 완전히 덮는다
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[⑧ 모바일 — 선택 모달이 .mobile-dock/업로드 버튼과 겹치지 않는다(전체 덮음)]");
{
  ok(/id="deck-source-modal" class="admin-gate hidden"/.test(indexHtml), "⑧a 새 모달이 기존 .admin-gate 클래스를 그대로 쓴다(새 CSS 0)");
  const agBlock = styleCss.match(/\.admin-gate\s*\{([^}]*)\}/);
  ok(!!agBlock && /position:\s*fixed/.test(agBlock[1]) && /inset:\s*0/.test(agBlock[1]), "⑧b .admin-gate 는 position:fixed; inset:0 — 전체 화면을 덮는다");
  const agZ = parseInt((agBlock[1].match(/z-index:\s*(\d+)/) || [])[1] || "0", 10);
  const dockBlock = styleCss.match(/\.mobile-dock\{[^}]*z-index:\s*(\d+)/);
  const dockZ = parseInt((dockBlock || [])[1] || "0", 10);
  ok(agZ > 0 && dockZ > 0 && agZ > dockZ, `⑧c .admin-gate z-index(${agZ}) > .mobile-dock z-index(${dockZ}) — 열리면 하단 독을 완전히 덮어 겹침 자체가 발생하지 않는다`);
  ok(!/#deck-source-modal\s*\{/.test(styleCss) && !/#dsm-/.test(styleCss), "⑧d 새 모달 전용 CSS 규칙 0 — 기존 .admin-gate 계열 클래스만 사용");
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑨ 매뉴얼 + 배선
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[⑨ 사용자 매뉴얼(36_Help.js) + 배선]");
{
  ok(/"deck-source-select"\s*:/.test(helpSrc), "⑨a 36_Help.js 에 deck-source-select 항목 존재");
  const txt = (helpSrc.match(/"deck-source-select"\s*:\s*"([^"]*)"/) || [])[1] || "";
  ok(txt.length > 40 && /원본/.test(txt), "⑨b 매뉴얼이 비파괴(원본 유지)를 설명한다(" + txt.length + "자)");
  ok(/data-help="deck-source-select"/.test(indexHtml), "⑨c 모달이 그 매뉴얼 키를 가리킴");
  ok(/_chooseDeckSource/.test(mainJs) && /extractRegionAsDeck/.test(mainJs), "⑨d 번들(public/js/main.js)에 반영됨 — assemble 미러 확인");
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑩ 🔴 [WO 20260921-tree] parent_id — 트리 4단(프로젝트>도면>구역>영역)을 넘지 않는다
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[⑩ extractRegionAsDeck() 이 parent_id 를 부모 구역 id 로 설정 — 4단 초과 방지]");
{
  ok(/parent_id:\s*src\.parent_id\s*\|\|\s*src\.id/.test(projectsSrc),
    "⑩a extractRegionAsDeck() 이 POST body 에 parent_id: src.parent_id || src.id 를 보낸다");
  ok(regionDeck1.parent_id === SRC_DECK,
    "⑩b 루트 구역(SRC_DECK)에서 뽑은 영역의 parent_id = 그 루트 구역 id, 실제 " + regionDeck1.parent_id);

  // 이미 "영역"(parent_id 있음)인 구역 위에서 또 뽑아도 — 손자가 아니라 같은 부모(루트)에 붙는다(4단 유지)
  const dom4 = makeDom();
  const c4 = makeClient(db, dom4);
  await c4.P.loadDecks();
  c4.P.currentDeck = c4.P.decks.find((d) => d.id === regionDeck1.id); // 이미 parent_id 를 가진 "영역" 위에서 작업
  ok(!!c4.P.currentDeck.parent_id, "⑩ 사전조건 — 현재 구역이 이미 parent_id 를 가진 영역이다(" + c4.P.currentDeck.parent_id + ")");
  const grandPending = c4.P.extractRegionAsDeck({ name: "영역 R1-손자시도", crop: { x: 1, y: 1, w: 5, h: 5 } });
  const grand = await grandPending;
  ok(!!grand && grand.parent_id === SRC_DECK,
    "⑩c 영역 위에서 또 뽑아도 parent_id 는 그 조부모(루트 SRC_DECK)를 그대로 가리킨다(손자 체인 금지), 실제 " + (grand && grand.parent_id));
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
