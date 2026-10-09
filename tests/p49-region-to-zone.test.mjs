/**
 * p49 — PDF 영역 드래그 추출: 여러 뷰가 담긴 도면에서 그 부분만 새 영역(구역)으로
 * (프레임워크 0 · 실행: node tests/p49-region-to-zone.test.mjs)
 *
 * 마스터 원문(2026-09-18):
 *   "pdf 에 여러 개의 뷰가 있는 파일일 때 긁어서 그 부분만 복사하듯이 새로운 영역으로 만들어내는 기능"
 *   "pdf 원본은 유지한 채 그 영역만 보여주는 기능"  ← 🔴 비파괴 확정
 *
 * 구현(새 메커니즘 0 — 기존 자산 재사용):
 *   · 드래그 UI      : 31_Projects._pickDeckCrop() (16_Zones 의 rect 드래그를 가로채 bbox(%)만 취함)
 *   · 저장           : POST /api/projects/:id/decks {name, page, crop, deployment_id}
 *                      → 🔴 **원본과 같은 deployment_id** 를 가리키는 decks 행 1개 INSERT.
 *                        픽셀을 복사하지 않는다 = 원본을 들여다보는 "창(view)".
 *   · 그 부분만 확대 : selectDeck → PDF.setDeckCrop + MapCtrl.fitZone (기존 경로)
 *   · 좌표           : 드래그/핀 모두 MapCtrl.viewportToPercent = **페이지 기준 %**.
 *                      [WP1·H7] 저장(=배포, 같은 행)도 페이지 기준 % 그대로 — 크롭 기준 %로 바꿔 저장하던
 *                      App._mapZoneForCrop 경로는 원본 행의 크롭 밖 항목을 지워 제거됐다(p25).
 *
 * 검증(목 금지 — 서버는 src/index.tsx 실 핸들러, 클라는 31_Projects.js 실 소스):
 *   ① 드래그 → 새 구역 생성, 같은 도면에서 반복 생성 가능
 *   ② 원본 PDF/배포본 비변형 (deployments 에 쓰기 0건, 원본 deck 행 불변)
 *   ③ 영역 안 좌표 ↔ 원본 좌표 왕복 일치 (허용오차 1e-9 %p — 부동소수 왕복 오차만 허용)
 *   ④ 영역 삭제 시 원본 영향 0
 *   ⑤ 모바일 375×812 겹침 0 (p46 과 동일 CSS 파싱 공식)
 *   ⑥ 사용자 매뉴얼(36_Help.js) 항목 존재 + 버튼이 그 키를 가리킴
 *
 * 🔴 뮤테이션 3건: ⓐ 좌표 재매핑 제거 → ③ 실패 · ⓑ 원본 변형 → ② 실패 · ⓒ 반복 생성 차단 → ① 실패
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { findHelpToggleBottomRaw } from "./_lib/find-help-toggle-bottom.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

const projectsSrc = rd("public/js/modules/31_Projects.js");
const mapSrc      = rd("public/js/modules/10_MapCtrl.js");
const appSrc      = rd("public/js/modules/20_App.js");
const zonesSrc    = rd("public/js/modules/16_Zones.js");
const helpSrc     = rd("public/js/modules/36_Help.js");
const indexHtml   = rd("public/index.html");
const styleCss    = rd("public/css/style.css").replace(/\/\*[\s\S]*?\*\//g, "");

/* 브레이스-밸런싱 발췌 (p36 과 동일 패턴) */
function extractBalanced(src, needle) {
  const start = src.indexOf(needle);
  if (start < 0) throw new Error("needle not found: " + needle);
  const braceStart = src.indexOf("{", start);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

/* ══ 실제 워커(src/index.tsx) 번들 — 서버는 실 핸들러로 돌린다 ═══════════ */
const outFile = path.join(os.tmpdir(), "p49-worker-" + process.pid + ".mjs");
await esbuild.build({
  entryPoints: [path.join(ROOT, "src/index.tsx")],
  bundle: true, format: "esm", platform: "node", outfile: outFile,
  jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
});
const worker = (await import("file://" + outFile.replace(/\\/g, "/"))).default;
fs.unlinkSync(outFile);

/* ══ D1 데이터스토어 가짜 (핸들러가 아니라 저장소만 대체) ══════════════════
 *  🔴 모든 run() SQL 을 writeLog 에 남긴다 → "원본에 쓰기가 있었는가"를 사실로 판정한다. */
const PID = "prj_a0", DEP_ID = "dep_a0", SRC_DECK = "dck_src";
function freshDb() {
  return {
    writeLog: [],
    settings: {},
    sessions: { "local-designer-tok": { email: "designer@example.com", expires_at: Date.now() + 8.64e7, revoked: 0 } },
    localUsers: { "designer@example.com": { email: "designer@example.com", name: "설계자", deleted: 0, must_change_password: 0 } },
    designers: new Set(["designer@example.com"]),
    // 🔴 원본 도면(배포본). 이 행이 단 1바이트도 바뀌면 안 된다.
    deployments: { [DEP_ID]: { id: DEP_ID, project_id: PID, pins: "[]", zones: "[]", annotations: "[]", version: 7, deleted: 0, tenant_id: null, file_name: "A0_multi_view.pdf", drawing_data: "data:image/png;base64,AAAA" } },
    decks: [{ id: SRC_DECK, project_id: PID, name: "원본 도면", level_no: 1, deployment_id: DEP_ID, page: 1, crop: null, created_at: 100, updated_at: 100, deleted: 0 }],
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
              if (like(q, "FROM projects WHERE id = ?")) return [PID].includes(a[0]) ? { owner: "designer@example.com", deleted: 0 } : null;   // [WO 20261009-readacl] canManageProject
              if (like(q, "FROM deployments WHERE id = ?")) return st.deployments[a[0]] || null;
              if (like(q, "FROM tenant_members")) return null;
              return null;
            },
            async all() {
              if (like(q, "FROM projects WHERE deleted = 0")) return { results: [PID].map((id) => ({ id, owner: "designer@example.com", published: 0 })) };   // [WO 20261009-readacl] 읽기 SoT — 소유 프로젝트
              // [WO 20260921-tree] GET /api/projects/:id/decks 는 이제 deployments 를 LEFT JOIN 해
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
                st.decks.push(row);
              } else if (like(q, "UPDATE decks SET deleted = 1")) {
                const d = st.decks.find((x) => x.id === a[1]); if (d) { d.deleted = 1; d.updated_at = a[0]; }
              } else if (like(q, "UPDATE decks SET name =")) {
                const cols = (q.match(/UPDATE decks SET (.*) WHERE id = \?/) || ["", ""])[1]
                  .split(",").map((x) => x.trim().replace(/\s*=\s*\?$/, ""));
                const d = st.decks.find((x) => x.id === a[cols.length]);
                if (d) cols.forEach((cname, i) => { d[cname] = a[i]; });
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
        async all() { if (like(q, "FROM projects WHERE deleted = 0")) return { results: [PID].map((id) => ({ id, owner: "designer@example.com", published: 0 })) };   // [WO 20261009-readacl] 읽기 SoT — 소유 프로젝트
          return { results: [] }; },
        async run() { return { success: true }; },
      };
    },
  };
}

/* ══ 클라이언트 — 31_Projects.js 실 소스를 vm 에 올리고 fetch 를 실 서버에 연결 ══ */
function makeClient(db) {
  const calls = { toasts: [], syncToolUi: 0, cancelDraw: 0, fitZone: [], setDeckCrop: [] };
  const el = () => ({ classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, dataset: {}, textContent: "", innerHTML: "", addEventListener() {}, appendChild() {}, querySelector: () => el(), querySelectorAll: () => [] });
  const ENV = { DB: makeDB(db), DEMO_LOGIN: "0" };
  const sandbox = {
    console, JSON, Math, Date, Set, Map, Promise, Object, Array, String, Number, Boolean, URLSearchParams, setTimeout,
    alert() {}, confirm: () => true,
    navigator: { onLine: true },
    location: { search: "" },
    document: { getElementById: () => null, createElement: () => el(), querySelector: () => null, body: { appendChild() {}, classList: { toggle() {} } } },
    Auth: { headers: () => ({ Authorization: "Bearer local-designer-tok", "Content-Type": "application/json" }), isDesigner: true },
    Prompt: { ask: async () => ({ value: "" }), toast: (m) => calls.toasts.push(String(m)), confirm: async () => true },
    UI: { renderTree() {}, $: () => null },
    State: { mode: "designer", drawingZone: false, pdfPage: 1 },
    PDF: { load: async () => ({ numPages: 1, destroy() {} }), setDeckCrop: (c) => calls.setDeckCrop.push(c) },
    MapCtrl: { fitZone: (bb) => calls.fitZone.push(bb) },
    // 16_Zones 스텁 — _pickDeckCrop 이 가로채는 대상. 실제 _cancelDraw 의 관측 가능한 효과
    //   (State.drawingZone=false + _syncToolUi)만 그대로 재현하고 DOM 조작은 뺀다.
    Zones: {
      _commitZone: async () => {},
      _cancelDraw() { calls.cancelDraw++; sandbox.State.drawingZone = false; calls.syncToolUi++; },
      _bbox: (g) => ({ x: g.x, y: g.y, w: g.w, h: g.h }),
      _syncToolUi: () => { calls.syncToolUi++; },
      _shape: null, _poly: null
    },
    App: { _refreshUnsavedDecks() {}, isDeckUnsaved: () => false, _loadDrawing: async () => {}, _gotoPage: async () => {}, loadDeckDrawing: async () => {} },
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
  P.currentProject = { id: PID, name: "A0 프로젝트" };
  return { P, sandbox, calls };
}

const clone = (o) => JSON.parse(JSON.stringify(o));

/* ══════════════════════════════════════════════════════════════════════
 * ① 드래그 → 새 영역 생성 · 반복 생성 가능
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[① 드래그한 영역이 새 구역이 된다 — 같은 도면에서 반복 가능]");
const db = freshDb();
const { P } = makeClient(db);
await P.loadDecks();
P.currentDeck = P.decks.find((d) => d.id === SRC_DECK);
ok(!!P.currentDeck && !!P.currentDeck.deployment_id, "① 사전조건 — 도면이 등록된 원본 구역이 열려 있다");

// 원본 스냅샷(②/④ 에서 비교)
const srcDeckBefore = clone(db.decks.find((d) => d.id === SRC_DECK));
const depBefore = clone(db.deployments[DEP_ID]);
const writeLogBefore = db.writeLog.length;

// A0 한 장에 들어 있는 3개 뷰를 차례로 긁어낸다("복사하듯이" 반복)
const VIEWS = [
  { name: "평면도",   crop: { x: 4,  y: 6,  w: 44, h: 38 } },
  { name: "측면도",   crop: { x: 52, y: 6,  w: 44, h: 38 } },
  { name: "A-A 단면", crop: { x: 4,  y: 50, w: 92, h: 44 } },
];
const made = [];
for (const v of VIEWS) made.push(await P.extractRegionAsDeck({ crop: v.crop, name: v.name }));

ok(made.every((d) => d && d.id), "① 3회 연속 추출 모두 성공 — 반복 생성 가능: " + made.map((d) => d && d.name).join(", "));
ok(new Set(made.map((d) => d.id)).size === 3, "① 서로 다른 구역 3개가 생성됨(같은 행 재사용 아님)");
ok(db.decks.filter((d) => !d.deleted).length === 4, "① 원본1 + 추출3 = 4개 구역, 실제 " + db.decks.filter((d) => !d.deleted).length);
ok(made.every((d, i) => d.crop && d.crop.x === VIEWS[i].crop.x && d.crop.w === VIEWS[i].crop.w),
  "① 각 구역이 드래그한 crop 을 그대로 갖는다");
ok(made.every((d) => d.deployment_id === DEP_ID),
  "① 세 구역 모두 **원본과 같은 도면(deployment_id)** 을 가리킨다 — 픽셀 복사 아님");
ok(P.currentDeck && P.currentDeck.id === SRC_DECK,
  "① 추출 후에도 원본 도면 화면에 머문다 → 곧바로 다음 영역을 긁을 수 있다(현재 구역=" + (P.currentDeck && P.currentDeck.id) + ")");

/* ── 실제 드래그 경로(_pickDeckCrop ← 16_Zones 가로채기)로도 한 번 뽑아본다 ──
 *  위 3건은 crop 을 선주입해 서버/데이터 계층을 검증했고, 여기서는 **드래그 UI 경로 자체**를 구동한다.
 *  Zones._commitZone 이 실제로 가로채진 시점(=_syncToolUi 호출)을 기다렸다가 드래그 완료를 흘려넣는다(p17 패턴). */
console.log("\n[①' 실제 드래그 경로 — Zones rect 드래그가 그대로 영역 추출로 이어진다]");
{
  const cl = makeClient(db);
  await cl.P.loadDecks();
  cl.P.currentDeck = cl.P.decks.find((d) => d.id === SRC_DECK);
  cl.sandbox.Prompt.ask = async () => ({ value: "드래그로 뽑은 뷰" });
  const armedBefore = cl.calls.syncToolUi;
  const pending = cl.P.extractRegionAsDeck();            // crop 미주입 → 실제 _pickDeckCrop 진입
  for (let i = 0; i < 50 && cl.calls.syncToolUi === armedBefore; i++) await Promise.resolve();
  ok(cl.calls.syncToolUi > armedBefore, "①' 드래그 모드가 실제로 켜졌다(Zones._syncToolUi 호출됨)");
  ok(cl.sandbox.State.drawingZone === true, "①' State.drawingZone=true — 도면 위 드래그 대기 상태");
  await cl.sandbox.Zones._commitZone({ shape: "rect", x: 12.5, y: 63.25, w: 30, h: 20 });   // 사용자가 드래그를 놓음
  const dragged = await pending;
  ok(!!dragged && dragged.name === "드래그로 뽑은 뷰", "①' 드래그 → 새 영역 생성: " + (dragged && dragged.name));
  ok(!!dragged && dragged.crop && dragged.crop.x === 12.5 && dragged.crop.w === 30,
    "①' 드래그한 bbox 가 그대로 crop 이 됨: " + JSON.stringify(dragged && dragged.crop));
  ok(cl.calls.cancelDraw >= 1, "①' 완료 후 _pickDeckCrop 이 Zones._cancelDraw 를 호출해 드래그 모드를 끈다(" + cl.calls.cancelDraw + "회)");
  ok(cl.sandbox.State.drawingZone === false, "①' State.drawingZone 이 false 로 되돌아옴");
  // 🔴 가로채기 해제 확인 — 참조 동일성이 아니라 **동작**으로 본다.
  //   (_pickDeckCrop 은 bind() 한 래퍼를 되돌려 놓으므로 참조는 달라진다 — 기존 설계, 결함 아님)
  //   해제되지 않았다면 다음 영역 그리기가 추출 흐름으로 새어 구역이 하나 더 생긴다.
  {
    const n = db.decks.length;
    await cl.sandbox.Zones._commitZone({ shape: "rect", x: 1, y: 1, w: 5, h: 5 });
    ok(db.decks.length === n, "①' 가로채기 해제됨 — 이후 일반 영역 그리기가 구역을 만들지 않는다(누출 0)");
  }
  ok(JSON.stringify(db.deployments[DEP_ID]) === JSON.stringify(depBefore), "①' 이 경로에서도 원본 배포본 불변");
  made.push(dragged);
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 원본 PDF/배포본 비변형
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[② 🔴 비파괴 — 원본 PDF/배포본과 원본 구역이 변하지 않는다]");
{
  const newWrites = db.writeLog.slice(writeLogBefore);
  const depWrites = newWrites.filter((w) => /deployments/.test(w.sql));
  ok(depWrites.length === 0, "② deployments(원본 도면)에 대한 쓰기 0건, 실제 " + depWrites.length);
  ok(JSON.stringify(db.deployments[DEP_ID]) === JSON.stringify(depBefore),
    "② 배포본 행이 바이트 단위로 불변(version=" + db.deployments[DEP_ID].version + ")");
  ok(JSON.stringify(db.decks.find((d) => d.id === SRC_DECK)) === JSON.stringify(srcDeckBefore),
    "② 원본 구역 행 불변(crop=" + JSON.stringify(db.decks.find((d) => d.id === SRC_DECK).crop) + ")");
  const srcMutations = newWrites.filter((w) => /^(UPDATE|DELETE)/i.test(w.sql) && w.args.includes(SRC_DECK));
  ok(srcMutations.length === 0, "② 원본 구역 행을 겨눈 UPDATE/DELETE 0건, 실제 " + srcMutations.length);
  const deckInserts = newWrites.filter((w) => /INSERT INTO decks/.test(w.sql));
  ok(deckInserts.length === 4, "② 추가된 쓰기는 decks INSERT 4건뿐(추출 건수와 정확히 일치), 실제 " + deckInserts.length);
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 영역 좌표 ↔ 원본 좌표 왕복 일치 — 허용오차 1e-9 %p
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[③ 좌표 정합 — 영역 안 좌표 ↔ 원본(페이지) 좌표 왕복]");
{
  const TOL = 1e-9;   // %p. 부동소수 왕복 오차만 허용(실측은 대부분 0 또는 ~1e-14)
  const mapSand = { console, Math, Object, JSON, Array, Number };
  vm.createContext(mapSand);
  vm.runInContext(
    "const MapCtrl = {" +
      extractBalanced(mapSrc, "pageToDeckCropPct(x, y, crop) {") + "," +
      extractBalanced(mapSrc, "deckCropPctToPage(x, y, crop) {") +
    "};\n" +
    "globalThis.__M = MapCtrl;", mapSand);
  const M = mapSand.__M;

  ok(typeof M.pageToDeckCropPct === "function" && typeof M.deckCropPctToPage === "function",
    "③ 사전조건 — 기존 변환 함수(새 로직 아님)를 실 소스에서 로드");

  // 3개 추출 영역 × 격자 점 — 영역 안에 찍은 핀이 원본 좌표로 정확히 돌아오는가
  let worst = 0, checked = 0, outside = 0;
  for (const v of VIEWS) {
    const c = v.crop;
    for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
      const px = c.x + (c.w * i) / 10, py = c.y + (c.h * j) / 10;   // 원본(페이지) 좌표
      const inCrop = M.pageToDeckCropPct(px, py, c);                 // 영역 기준 좌표
      if (!inCrop) { outside++; continue; }
      const back = M.deckCropPctToPage(inCrop.x, inCrop.y, c);       // 다시 원본 좌표로
      worst = Math.max(worst, Math.abs(back.x - px), Math.abs(back.y - py));
      checked++;
    }
  }
  ok(outside === 0, "③ 영역 경계 포함 모든 격자점이 영역 안으로 판정됨(누락 " + outside + ")");
  ok(checked === 363, "③ 검사 점 수 3영역×121 = 363, 실제 " + checked);
  ok(worst <= TOL, "③ 왕복 최대 오차 " + worst.toExponential(2) + " %p ≤ 허용치 " + TOL + " %p");

  // 영역 밖 좌표는 배포본에서 제외되어야 한다(경계 규칙도 기존과 동일)
  ok(M.pageToDeckCropPct(VIEWS[0].crop.x - 0.1, VIEWS[0].crop.y, VIEWS[0].crop) === null,
    "③ 영역 밖 좌표는 null(배포본 제외) — 기존 규칙 그대로");

  // 🔴 [WP1·H7] 창 구역은 원본과 같은 배포본 행 — 저장 경로가 크롭 변환을 쓰면 원본의 크롭 밖 항목이 지워진다.
  //   (종전 이 자리의 "App._mapZoneForCrop 과 동일 규칙" 검사는 그 함수가 제거되어 대상이 사라졌다.
  //    행동 검증은 p25 · 실 워커 E2E 는 p93) 여기서는 저장 모듈에 변환 호출이 되살아나지 않았는지 본다.
  ok(!/pageToDeckCropPct|_mapZoneForCrop|_mapAnnoForCrop|_currentDeckCrop/.test(appSrc),
    "③ 저장 경로(20_App.js)는 크롭 기준 변환을 쓰지 않는다 — 영역 안 좌표도 페이지 기준 % 그대로 저장");
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 영역 삭제 시 원본 영향 0
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[④ 추출 영역을 지워도 원본 도면은 그대로]");
{
  const before = db.writeLog.length;
  const victim = made[1];
  await P.deleteDeck(victim.id, victim.name);
  const row = db.decks.find((d) => d.id === victim.id);
  ok(row && row.deleted === 1, "④ 추출 영역 행이 soft delete 됨");
  ok(JSON.stringify(db.deployments[DEP_ID]) === JSON.stringify(depBefore),
    "④ 원본 배포본 불변(version=" + db.deployments[DEP_ID].version + ")");
  ok(JSON.stringify(db.decks.find((d) => d.id === SRC_DECK)) === JSON.stringify(srcDeckBefore),
    "④ 원본 구역 행 불변");
  const depWrites = db.writeLog.slice(before).filter((w) => /deployments/.test(w.sql));
  ok(depWrites.length === 0, "④ 삭제 중 deployments 쓰기 0건, 실제 " + depWrites.length);
  ok(db.decks.filter((d) => !d.deleted).length === 4, "④ 남은 구역 = 원본1 + 추출3 = 4, 실제 " + db.decks.filter((d) => !d.deleted).length);
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 모바일 375×812 겹침 0 (p46 과 동일 공식)
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[⑤ 모바일 375×812 — 드래그 진입 UI 가 하단 독·업로드 버튼과 겹치지 않는다]");
{
  const VIEWPORT = { w: 375, h: 812 };
  const ROOT_VARS = (() => {
    const vars = {}; const re = /:root\s*\{([^}]*)\}/gs; let rm;
    while ((rm = re.exec(styleCss))) { const dre = /--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g; let m; while ((m = dre.exec(rm[1]))) vars[m[1]] = m[2].trim(); }
    return vars;
  })();
  const resolveOnce = (expr) => {
    let changed = false;
    const out = expr.replace(/var\(\s*--([a-zA-Z0-9_-]+)\s*(?:,((?:[^()]|\([^()]*\))*))?\)/, (full, name, fb) => {
      changed = true;
      if (ROOT_VARS[name] !== undefined) return ROOT_VARS[name];
      if (fb !== undefined) return fb.trim();
      throw new Error("정의되지 않은 var(--" + name + ")");
    });
    if (changed) return out;
    return expr.replace(/env\(\s*safe-area-inset-bottom\s*(?:,([^()]*))?\)/, () => "0px");
  };
  const resolveAll = (e) => { let p = e, c = resolveOnce(e), g = 0; while (c !== p) { p = c; c = resolveOnce(c); if (++g > 30) throw new Error("루프 초과"); } return c; };
  const toPx = (t) => { t = t.trim(); if (/^0$/.test(t)) return 0; const m = t.match(/^(-?[\d.]+)px$/); if (m) return parseFloat(m[1]); throw new Error("px 아님: " + t); };
  const evalPx = (raw) => { const r = resolveAll(raw.trim()); const cm = r.match(/^calc\((.+)\)$/s); if (cm) return cm[1].split("+").map((s) => s.trim()).reduce((s, t) => s + toPx(t), 0); return toPx(r); };
  const findDecl = (css, selRe, prop) => {
    const blockRe = new RegExp(selRe + "\\s*\\{([^}]*)\\}", "gs");
    const propRe = new RegExp("(?:^|[;\\s])" + prop + "\\s*:\\s*([^;]+);");
    let m, found = null;
    while ((m = blockRe.exec(css))) { const pm = m[1].match(propRe); if (pm) { found = pm[1].trim(); break; } }
    if (found === null) throw new Error(`'${prop}' 선언 없음 (${selRe})`);
    return found.replace(/!important/g, "").trim();
  };
  const overlapArea = (a, b) => {
    const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return ox * oy;
  };

  // 진입 버튼 3곳(정본 + 위임 미러 2곳)이 전부 **기존 컨테이너의 평범한 flex 자식**인지
  ok(/id="btn-region-extract"[^>]*class="zone-tool"|class="zone-tool"[^>]*id="btn-region-extract"/.test(indexHtml),
    "⑤a 정본 버튼이 기존 .zone-tool 클래스를 그대로 쓴다(새 CSS 0)");
  const ztBlock = indexHtml.match(/<div id="zone-tools" class="zone-tools">([\s\S]*?)<\/div>/);
  ok(!!ztBlock && /id="btn-region-extract"/.test(ztBlock[1]), "⑤b 정본 버튼이 #zone-tools 안에 있다(사이드 패널 · 고정 오버레이 아님)");
  ok(!/#btn-region-extract\s*\{/.test(styleCss) && !/\[data-deleg="btn-region-extract"\]\s*\{/.test(styleCss),
    "⑤c 새 버튼 전용 CSS 규칙 0 — 절대배치/음수마진으로 상위 박스를 벗어날 수 없다");

  // 모바일 독 미러 — .mdock-row[data-group="edit"] (⊆ .mobile-dock) 의 평범한 .mdock-tool
  const editRow = indexHtml.match(/<div class="mdock-row designer-only" data-group="edit">([\s\S]*?)<\/div>/);
  ok(!!editRow && /data-deleg="btn-region-extract"/.test(editRow[1]),
    "⑤d 모바일 미러가 .mdock-row[data-group=edit] (⊆ .mobile-dock) 안에 있다(포함관계)");
  ok(/class="mdock-tool" data-deleg="btn-region-extract"/.test(editRow[1]), "⑤e 미러가 기존 .mdock-tool 클래스를 그대로 쓴다");

  // 상위 사각형(.mobile-dock)이 다른 고정 UI 와 겹치지 않음 → 부분집합인 새 버튼도 겹치지 않는다
  const mdockH = evalPx(findDecl(styleCss, "\\.mdock-bar", "height"));
  const dockBorderTop = parseFloat(findDecl(styleCss, "\\.mobile-dock", "border-top"));
  const dockTotalH = mdockH + dockBorderTop;
  const mobileDockRect = { x: 0, y: VIEWPORT.h - dockTotalH, w: VIEWPORT.w, h: dockTotalH };
  const pfBlock = (() => {
    const re = /@media \(max-width:640px\), \(pointer:coarse\)\{([\s\S]*?)\n\}/g;
    let m; while ((m = re.exec(styleCss))) { if (m[1].includes(".pinfilter-bar{")) return m[1]; } return null;
  })();
  if (!pfBlock) throw new Error(".pinfilter-bar 모바일 미디어 블록을 찾지 못함");
  const pinfilterBarRect = { x: 0, y: VIEWPORT.h - evalPx(findDecl(pfBlock, "\\.pinfilter-bar", "bottom")) - evalPx(ROOT_VARS["pinfilter-h-mobile"]), w: VIEWPORT.w, h: evalPx(ROOT_VARS["pinfilter-h-mobile"]) };
  ok(overlapArea(mobileDockRect, pinfilterBarRect) === 0,
    "⑤f .mobile-dock ∩ .pinfilter-bar = 0 → dock=" + JSON.stringify(mobileDockRect));
  // [WO 20261002-gap 재발주] 공유 헬퍼(tests/_lib/find-help-toggle-bottom.mjs,
  // p34·p41·p46·p47 와 공용) — 4073788 이후 [data-help-toggle] 가 쉼표 그룹 중간 항목이다.
  const helpBottomRawP49 = findHelpToggleBottomRaw(styleCss);
  if (helpBottomRawP49 === null) throw new Error("[data-help-toggle] 모바일 bottom 규칙을 찾지 못함");
  const helpBottom = evalPx(helpBottomRawP49);
  ok(overlapArea(mobileDockRect, { x: 16, y: VIEWPORT.h - helpBottom - 40, w: 40, h: 40 }) === 0,
    "⑤g .mobile-dock ∩ [data-help-toggle] = 0");

  // 업로드 버튼(#mdock-upload, p46)은 .mdock-bar, 새 버튼은 .mdock-row — 형제 컨테이너라 서로 겹치지 않는다
  ok(!editRow[1].includes('id="mdock-upload"'), "⑤h 업로드 버튼과 다른 행(.mdock-bar vs .mdock-row)에 있어 자리 경합 0");

  // 터치타깃 — .mdock-tool 은 min-width 고정 + .mdock-row 는 overflow-x:auto(개수가 늘어도 축소되지 않음)
  const toolMinW = parseFloat(findDecl(styleCss, "\\.mdock-tool", "min-width"));
  const rowH = parseFloat(findDecl(styleCss, "\\.mdock-row", "height"));
  ok(toolMinW >= 44 && rowH >= 44, "⑤i 터치타깃 " + toolMinW + "×" + rowH + " ≥ 44×44");
  ok(/\.mdock-row\{[^}]*overflow-x:auto/.test(styleCss),
    "⑤j .mdock-row 가 overflow-x:auto — 버튼이 1개 늘어도 기존 칩이 좁아지지 않는다(p34/p41/p42/p46 불변)");

  // 드래그 자체는 기존 영역 그리기(16_Zones)를 재사용 — 새 전체화면 오버레이를 만들지 않는다
  ok(/_pickDeckCrop\(/.test(projectsSrc) && /Zones\._commitZone/.test(projectsSrc),
    "⑤k 드래그는 기존 Zones 경로 재사용 — 새 고정 오버레이 0");
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 사용자 매뉴얼 + 배선
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[⑥ 사용자 매뉴얼(36_Help.js) + 버튼 배선]");
{
  ok(/"region-extract"\s*:/.test(helpSrc), "⑥a 36_Help.js 에 region-extract 항목 존재");
  const txt = (helpSrc.match(/"region-extract"\s*:\s*"([^"]*)"/) || [])[1] || "";
  ok(txt.length > 60 && /원본/.test(txt), "⑥b 매뉴얼이 비파괴(원본 유지)를 설명한다(" + txt.length + "자)");
  ok(/data-help="region-extract"/.test(indexHtml), "⑥c 버튼이 그 매뉴얼 키를 가리킨다");
  ok(/btn-region-extract/.test(zonesSrc) && /extractRegionAsDeck/.test(zonesSrc), "⑥d 16_Zones.init() 이 버튼을 실제 동작에 연결(고아 아님)");
  ok(/extractRegionAsDeck/.test(rd("public/js/main.js")), "⑥e 번들(public/js/main.js)에 반영됨 — assemble 미러 확인");
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
