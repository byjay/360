/**
 * p160 — 원본 다중 영역 일괄 등록 + 구역 안 낱장 도면(시트) 다중 등록(WO 20261016-multisheet/multiregion)
 * 프레임워크 0 · 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p160-multiregion-sheets.test.mjs
 *
 * 설계 정본: .tmp/design-multisheet.md §1(시트 묶음)/4-1(P1). DB 변경 0(decks.page 는 0022 에 이미 있다,
 *   src_dep_id/src_page/src_crop 는 0031) — 기존 POST /api/projects/:id/decks(SoT) 를 그대로 재사용한다.
 *
 * 목(mock) 사용 범위 — 🔴 정직하게 명시:
 *  · Part A(65_Sheets.js 순수함수) — DOM·App 0, 완전 실 소스 vm.
 *  · Part B(Sheets.createSheets) — App._createRegionCopyDeployment/_uploadPagesToR2/_deploymentBody/
 *    _blobToDataUrl 는 "파일→배포본 바이트" 경로(기존에 이미 있는 저장 로직, 이번 WO 범위 밖)라 호출
 *    횟수만 세는 가짜로 대체한다. **deck 생성(POST /api/projects/:id/decks)과 /tables/deployments 는
 *    실 워커(src/index.tsx) + 실 D1(Miniflare)** 을 그대로 통과한다 — mock 없음.
 *  · Part C(Projects.extractRegionsAsDecks, 실 31_Projects.js 소스) — App._regionSource/
 *    _createRegionCopyDeployment/PDF.copyRegionToPdf 는 같은 이유로 가짜. _planRegionCopy/_srcBoxFields/
 *    _withDeckMode/_cutParentId 는 **실 소스** 그대로 실행한다. deck POST·GET 은 실 D1.
 *
 * 뮤테이션 3건(P160_MUT=<이름>), 각 EXIT=1 이어야 통과(확인 후 원복):
 *  parent-ignore       — Sheets.planBody 의 parent_id 를 항상 null 로(부모 무시)
 *  page-split-upload   — createSheets 가 페이지마다 업로드를 호출(원본 PDF 재업로드 N회)
 *  name-fabricate       — suggestName 이 PDF 페이지 텍스트를 무시(이름 날조 경로 차단 회귀)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { Miniflare } from "miniflare";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const MUT = process.env.P160_MUT || "";

let sheetsSrc = rd("public/js/modules/65_Sheets.js");
const projSrc = rd("public/js/modules/31_Projects.js");

const MUTS = {
  "parent-ignore": {
    needle: "const body = { name: opts.name, page: opts.page || 1, crop: null, deployment_id: opts.deploymentId, parent_id: opts.parentId != null ? opts.parentId : null };",
    repl: "const body = { name: opts.name, page: opts.page || 1, crop: null, deployment_id: opts.deploymentId, parent_id: null };"
  },
  "page-split-upload": {
    needle: `        const depId = await this.ensureDeploymentForFile(plan.file, plan.name || (plan.file && plan.file.name) || "도면");
        if (!depId) {
          for (const p of pages) failed.push({ file: plan.file, page: p.page, name: p.name, reason: "업로드 실패" });
          continue;
        }
        for (const p of pages) {
          const body = this.planBody({ name: p.name, page: p.page, deploymentId: depId, parentId });`,
    repl: `        for (const p of pages) {
          const depId = await this.ensureDeploymentForFile(plan.file, plan.name || (plan.file && plan.file.name) || "도면");
          if (!depId) { failed.push({ file: plan.file, page: p.page, name: p.name, reason: "업로드 실패" }); continue; }
          const body = this.planBody({ name: p.name, page: p.page, deploymentId: depId, parentId });`
  },
  "name-fabricate": {
    needle: "const fromText = this._shortKindLine(pageText);\n      if (fromText) return fromText;",
    repl: "const fromText = null;"
  }
};
if (MUT) {
  const m = MUTS[MUT];
  if (!m) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }
  if (!sheetsSrc.includes(m.needle)) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함: " + MUT); process.exit(2); }
  sheetsSrc = sheetsSrc.replace(m.needle, m.repl);
  console.log("[뮤테이션 적용] " + MUT);
}

let failedCnt = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failedCnt++; };

function loadSheets(src) {
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.window.Sheets;
}

/* ══════════════════════════════════════════════════════════════════════
 * Part A — 순수 함수(실 소스, DOM·네트워크 0)
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[Part A · 순수 함수 — 65_Sheets.js 실 소스 vm]");
{
  const Sheets = loadSheets(sheetsSrc);
  ok(Sheets.kindOf("A DK PLAN") === "plan", "T1 kindOf plan");
  ok(Sheets.kindOf("SECT A-A") === "section", "T1 kindOf section");
  ok(Sheets.kindOf("FR45 EL") === "elevation", "T1 kindOf elevation");
  ok(Sheets.kindOf("상세도") === "detail", "T1 kindOf detail(한글)");
  ok(Sheets.kindOf("무제") === null, "T1 kindOf 미매칭 → null(지어내지 않음)");

  const text1 = "SEASTAR ENGINERING\nA DK PLAN\nSCALE 1:100\nDWG NO. 0001";
  ok(Sheets.suggestName(text1, "x.pdf", 1) === "A DK PLAN", "T2 ① PDF 텍스트에서 가장 짧은 매칭 줄을 쓴다");

  ok(Sheets.suggestName(null, "ENGINE_ROOM_A-DK_PLAN.pdf", 1) === "ENGINE ROOM A DK PLAN", "T2 ② 텍스트 실패 → 파일명(정리됨, 종류 매칭)");

  ok(Sheets.suggestName(null, "scan001.pdf", 3) === "scan001 p3", "T2 ③ 텍스트·종류매칭 모두 실패 → \"<파일명> p3\"(사실만)");

  ok(Sheets.suggestName(null, "", 1) === "도면 p1", "T2 ④ 파일명도 없으면 \"도면 p1\"(지어낸 제목 금지)");

  ok(Sheets.isPdfFile({ name: "a.pdf", type: "application/pdf" }) === true, "isPdfFile PDF true");
  ok(Sheets.isPdfFile({ name: "a.png", type: "image/png" }) === false, "isPdfFile 이미지 false");
}

/* ══════════════════════════════════════════════════════════════════════
 * 공용 — 실 워커(src/index.tsx) + 실 D1(Miniflare)
 * ══════════════════════════════════════════════════════════════════════ */
const MIG_DIR = path.join(ROOT, "migrations");
const MIGS = fs.readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
const stmtsOf = (file) => fs.readFileSync(path.join(MIG_DIR, file), "utf8").replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
async function applyMigrations(db, files) { for (const f of files) for (const st of stmtsOf(f)) await db.exec(st); }
async function buildWorker() {
  const out = path.join(os.tmpdir(), "p160-worker-" + process.pid + "-" + Math.random().toString(36).slice(2) + ".mjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/index.tsx")], bundle: true, format: "esm", platform: "neutral",
    outfile: out, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
    conditions: ["workerd", "worker", "browser"]
  });
  return out;
}
const now0 = Date.now();
const TOK = "local-p160-owner";
function seedSql(pid, parentDeckId, origDepId, tag) {
  const now = now0;
  return [
    ["INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)", ["owner" + tag + "@p160.test", "오너", "designssir@gmail.com", now, now]],
    ["INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)", ["owner" + tag + "@p160.test", "오너", "p160.test", "x", "y", now, now]],
    ["INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOK + tag, "owner" + tag + "@p160.test", now, now + 8.64e7]],
    ["INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)", [pid, "P160 프로젝트" + tag, "", "owner" + tag + "@p160.test", now, now]],
    ["INSERT INTO deployments (id, title, file_name, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)", [origDepId, "원본", "A0.pdf", now, now]],
    ["INSERT INTO decks (id, project_id, name, parent_id, deployment_id, page, crop, created_at, updated_at, deleted) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 0)", [parentDeckId, pid, "A DK" + tag, now, now]],
  ];
}
async function apiRun(pid, parentDeckId, origDepId, tag) {
  const script = await buildWorker();
  const mf = new Miniflare({
    modules: true, scriptPath: script, d1Databases: { DB: "p160-" + Math.random().toString(36).slice(2) },
    r2Buckets: { R2: "p160r2" }, bindings: { DEMO_LOGIN: "0" }, compatibilityDate: "2025-01-01"
  });
  const db = await mf.getD1Database("DB");
  await applyMigrations(db, MIGS);
  for (const [q, a] of seedSql(pid, parentDeckId, origDepId, tag)) await db.prepare(q).bind(...a).run();
  const B = "http://p160.test";
  const H = { Authorization: "Bearer " + TOK + tag, "Content-Type": "application/json" };
  const realFetch = (url, opts) => mf.dispatchFetch(B + url, opts);
  return { mf, db, B, H, realFetch };
}

/* ══════════════════════════════════════════════════════════════════════
 * Part B — Sheets.createSheets: 3페이지 PDF 1개 + PNG 1개 → 자식 4개, PDF 업로드 1회
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[Part B · Sheets.createSheets — 실 D1(Miniflare) deck POST]");
{
  const pid = "prj_p160b", parentId = "dck_p160b_parent", origDep = "dep_p160b_orig";
  const { mf, db, H, realFetch } = await apiRun(pid, parentId, origDep, "b");
  try {
    const calls = { pdf: 0, img: 0 };
    const App = {
      _createRegionCopyDeployment: async (name, bytes) => { calls.pdf++; return "dep_pdf_fake_1"; },
      _uploadPagesToR2: async (pages) => { calls.img++; return pages.map(() => "https://fake.r2/x.png"); },
      _deploymentBody: (o, pagesData, meta) => ({ title: o.title, file_name: o.fileName, pins: "[]", zones: "[]", annotations: "[]", routes: "[]", drawing_data: pagesData[0], pages_data: JSON.stringify(pagesData) }),
      _blobToDataUrl: async (file) => "data:image/png;base64,FAKE"
    };
    const sandbox = { console, fetch: realFetch, Auth: { headers: () => H, isDesigner: true }, App };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(sheetsSrc, sandbox);
    const Sheets = sandbox.window.Sheets;

    const fakePdf = { name: "ENGINE_A-DK.pdf", type: "application/pdf", arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    const fakePng = { name: "scan.png", type: "image/png" };
    const plans = [
      { file: fakePdf, name: "ENGINE A-DK", pages: [
        { page: 1, name: "A DK PLAN", selected: true },
        { page: 2, name: "A DK SECTION A-A", selected: true },
        { page: 3, name: "A DK ELEVATION", selected: true }
      ] },
      { file: fakePng, name: "스캔 이미지", pages: [{ page: 1, name: "스캔 이미지", selected: true }] }
    ];
    const result = await Sheets.createSheets(pid, parentId, plans);
    ok(result.created.length === 4, "T3 자식 4개 생성(" + result.created.length + ")");
    ok(result.failed.length === 0, "T3 실패 0건");
    ok(calls.pdf === 1, "T3 🔴 PDF 원본 R2 업로드 1회(페이지 3장이어도) — 실측 " + calls.pdf);
    ok(calls.img === 1, "T3 이미지 업로드 1회 — 실측 " + calls.img);

    const rows = (await db.prepare("SELECT * FROM decks WHERE parent_id = ? ORDER BY page").bind(parentId).all()).results || [];
    ok(rows.length === 4, "T3 D1 실측 — parent_id 아래 자식 행 4개");
    const pdfRows = rows.filter((r) => r.deployment_id === "dep_pdf_fake_1");
    ok(pdfRows.length === 3 && pdfRows.every((r) => r.parent_id === parentId), "T3 PDF 3개 행이 같은 배포본 1개를 공유 + parent_id 일치");
    ok(rows.every((r) => [1, 2, 3].includes(r.page)), "T3 page 값이 1/2/3 그대로(쪼개짐 없이 page 참조)");
    ok(rows.some((r) => r.name === "A DK PLAN") && rows.some((r) => r.name === "A DK SECTION A-A") && rows.some((r) => r.name === "A DK ELEVATION") && rows.some((r) => r.name === "스캔 이미지"), "T3 이름 그대로 저장(날조 없음)");

    // T4 — 선택 0 → POST 0건
    const calls2 = { pdf: 0 };
    App._createRegionCopyDeployment = async () => { calls2.pdf++; return "dep_should_not_exist"; };
    const emptyPlans = [{ file: fakePdf, name: "선택없음", pages: [{ page: 1, name: "x", selected: false }, { page: 2, name: "y", selected: false }] }];
    const r4 = await Sheets.createSheets(pid, parentId, emptyPlans);
    ok(r4.created.length === 0 && r4.failed.length === 0, "T4 선택 0 → 결과 0건(건너뜀, 실패 아님)");
    ok(calls2.pdf === 0, "T4 선택 0 → 업로드 호출 자체가 0회(조용한 생성 없음)");
    const rows2 = (await db.prepare("SELECT COUNT(*) AS n FROM decks WHERE parent_id = ?").bind(parentId).all()).results[0].n;
    ok(rows2 === 4, "T4 D1 실측 — 자식 행이 그대로 4개(추가 생성 없음)");
  } finally { await mf.dispose(); }
}

/* ══════════════════════════════════════════════════════════════════════
 * Part C — Projects.extractRegionsAsDecks(실 31_Projects.js) — 원본 다중 영역 → 선택 부모 아래 3개
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[Part C · Projects.extractRegionsAsDecks — 실 31_Projects.js vm + 실 D1]");
async function runPartC() {
  const pid = "prj_p160c", parentId = "dck_p160c_parent", origDep = "dep_p160c_orig";
  const { mf, db, H, realFetch } = await apiRun(pid, parentId, origDep, "c");
  try {
    const calls = [];
    const sandbox = {
      console, navigator: { onLine: true },
      Auth: { isDesigner: true, headers: () => H },
      State: { pdfPage: 1 },
      Prompt: { toast() {}, ask: async () => null, confirm: async () => false },
      App: {
        _regionSource: async (depId, page) => ({ bytes: new ArrayBuffer(4), expect: null }),
        _createRegionCopyDeployment: async (name, bytes) => { calls.push(name); return "dep_region_" + calls.length; },
        _attachSourcePdf: async () => true,
        _pickPdfFile: async () => null
      },
      PDF: { copyRegionToPdf: async (bytes, page, crop, expect) => ({ bytes: new ArrayBuffer(4), box: { x: crop.x, y: crop.y, w: crop.w, h: crop.h } }) },
      fetch: realFetch
    };
    vm.createContext(sandbox);
    vm.runInContext(projSrc + "\nthis.Projects = Projects;", sandbox);
    const Projects = sandbox.Projects;
    Projects._renderDecks = () => {};   // 렌더는 CDP 테스트 영역 — 여기는 D1 왕복만 검증(document 0)
    Projects.currentProject = { id: pid };
    Projects.currentDeck = { id: "dck_src", deployment_id: origDep, page: 1 };   // src = 원본(이미 저장됨, src_dep_id 없음)
    Projects.decks = [];

    const regions = [
      { crop: { x: 10, y: 10, w: 20, h: 15 }, name: "A DK PLAN" },
      { crop: { x: 40, y: 10, w: 20, h: 15 }, name: "A DK SECTION A-A" },
      { crop: { x: 70, y: 10, w: 15, h: 15 }, name: "A DK ELEVATION" }
    ];
    const result = await Projects.extractRegionsAsDecks(parentId, regions);
    return { result, calls, db, parentId, origDep, regions, mf };
  } catch (e) { await mf.dispose(); throw e; }
}

{
  const { result, calls, db, parentId, origDep, regions, mf } = await runPartC();
  try {
    ok(result.created.length === 3, "R1 자식 3개 생성(" + result.created.length + ")");
    ok(result.failed.length === 0, "R1 실패 0건");
    ok(calls.length === 3, "R1 영역마다 독립 배포본 생성(_createRegionCopyDeployment 3회 — 재사용 아님)");

    const rows = (await db.prepare("SELECT * FROM decks WHERE parent_id = ? ORDER BY name").bind(parentId).all()).results || [];
    ok(rows.length === 3, "R1 D1 실측 — parent_id 아래 자식 3개");
    ok(rows.every((r) => r.crop == null), "R2 벡터 복사 결과는 crop:null(원본 창이 아니라 새 1페이지 배포본)");
    ok(new Set(rows.map((r) => r.deployment_id)).size === 3, "R2 서로 다른 배포본 3개(내용이 다른 영역이므로 재사용 금지)");
    for (const r of rows) {
      const region = regions.find((x) => x.name === r.name);
      ok(!!region, "R3 이름 일치(" + r.name + ")");
      let crop = null; try { crop = JSON.parse(r.src_crop || "null"); } catch (e) {}
      ok(!!crop, "R3 src_crop 기록됨(" + r.name + ")");
      ok(crop && crop.x === region.crop.x && crop.y === region.crop.y && crop.w === region.crop.w && crop.h === region.crop.h,
        "R3 🔴 src_crop 이 입력 영역과 정확히 일치(" + r.name + "): " + JSON.stringify(crop) + " vs " + JSON.stringify(region.crop));
      ok(String(r.src_dep_id) === String(origDep), "R3 src_dep_id = 원본 배포본(" + r.name + ")");
      ok(Number(r.src_page) === 1, "R3 src_page = 1(" + r.name + ")");
    }
  } finally { await mf.dispose(); }
}

console.log("\n" + (failedCnt ? ("FAIL " + failedCnt + "건") : "PASS 전체"));
process.exit(failedCnt ? 1 : 0);
