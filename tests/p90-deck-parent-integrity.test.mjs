/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p90-deck-parent-integrity.test.mjs)
 *
 * [WO 20260929-parent-guard] 마스터 재현: "구역을 원래도면으로 하고 영역 지정하면 원래 전체
 * 도면이 사라진다" — 근본원인(지휘자+본 세션 실측):
 *  ① Projects.currentProject 를 바꾸는 세 진입점(31_Projects.selectProject ·
 *     12_ProjectHub.openProject · 99_footer.js 서브도메인 자동진입)이 각자 currentDeck 을
 *     리셋하지 않아, 이전/삭제된 프로젝트의 deck 참조가 새 프로젝트로 샌다.
 *     → extractRegionAsDeck(src=currentDeck)이 그 참조를 parent_id 로 그대로 써서
 *       "다른 프로젝트의 deck 을 부모로 둔 고아 deck"을 만든다.
 *     → ProjectHub.openProject 는 currentProject 대입 후 비동기로 deck 목록을 새로 받는데,
 *       그 경쟁 창에서 _draftKey()(pid::did)가 stale currentDeck.id 를 써 IndexedDB 에
 *       "새 프로젝트+옛 프로젝트 deck" 조합 draft 키가 영구 저장되고, 나중에 _flushDirtyDrafts
 *       가 그 draft 의 depId(옛 프로젝트 배포본)로 PATCH 를 보낸다(지휘자 실측: prod dep_muksj6py
 *       updated_at 이 삭제된 프로젝트 재진입 없이 갱신됨).
 *  ② 서버(POST/PUT /decks)가 parent_id 를 검증 없이 그대로 믿어 위 오염을 그대로 저장한다.
 *  ③ Projects.pickOriginalDeck 이 parent_id==null 만 루트로 쳐서, 오염된(다른/삭제된 프로젝트
 *     deck 을 가리키는) deck 은 루트로도 안 잡혀 "등록된 원본 도면이 없습니다" 로 영영 숨는다.
 *  ④ App._restoreProjectDraft 가 draft 의 deck id 가 현재 프로젝트의 살아있는 decks 에 없어도
 *     그 draft 를 "최선"으로 골라 복원할 수 있었다(고아 draft 화면 유입).
 *
 * 검사(①~④ 각 1개 이상) + 뮤테이션 4건, 각 EXIT=1 확인 후 원복.
 *
 * 목(mock) 범위: Part A/B/D 는 실제 소스(31_Projects.js/11_UI.js/20_App.js)를 vm 에 그대로
 * 평가하고 I/O(fetch/document/SyncQueue)만 최소 목(p1/p62 와 동일 패턴). Part C 는 실제 워커
 * (src/index.tsx) + 실제 Miniflare D1(SQLite)에 실제 마이그레이션을 적용해 HTTP 로 때린다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { Miniflare } from "miniflare";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, "public/js/modules", f), "utf8");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ══════════════════════════════════════════════════════════════════════
 * Part A — Projects.setCurrentProject() / selectProject() 가 currentDeck 을 리셋한다
 * ══════════════════════════════════════════════════════════════════════ */
function makeDoc() {
  const el = () => ({
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {}, textContent: "", innerHTML: "", value: "",
    addEventListener() {}, appendChild() {}, querySelector: () => null
  });
  return { getElementById: () => el(), createElement: () => el(), body: { appendChild() {} } };
}
function loadProjects(projectsSrc, extra) {
  const sandbox = {
    console, document: makeDoc(), navigator: { onLine: true },
    Auth: { headers: () => ({}), isDesigner: true, setProjectContext() {} },
    Prompt: { ask: async () => null, toast() {}, confirm: async () => true },
    fetch: async () => ({ ok: true, json: async () => ({ data: [] }) }),
    ...extra
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(projectsSrc + "\n;globalThis.__P = Projects;", sandbox);
  return sandbox.__P;
}

console.log("\n[Part A · Projects — currentProject 전환 시 currentDeck 리셋]");
const projectsSrc = src("31_Projects.js");
{
  const P = loadProjects(projectsSrc);
  P.list = [{ id: "prjB", name: "새 프로젝트" }];
  // 이전 프로젝트(삭제됐거나 전환 전) 에서 남은 stale 구역 참조를 흉내낸다.
  P.currentProject = { id: "prjA", name: "옛 프로젝트" };
  P.currentDeck = { id: "dckA_root", deployment_id: "depA", parent_id: null };
  P.loadDecks = async () => { P.decks = []; };   // 네트워크 없이 전환만 검사
  P.selectProject("prjB");
  // selectProject 는 async 이나 currentDeck 리셋은 최초 동기 구간에서 일어나야 한다(경쟁창 제거).
  ok(P.currentDeck === null, "① selectProject() 직후(동기) currentDeck === null — 옛 프로젝트 구역 참조가 새지 않는다, 실제 " + JSON.stringify(P.currentDeck));
  ok(P.currentProject && P.currentProject.id === "prjB", "① currentProject 는 정상 전환됨");
}
{
  const P = loadProjects(projectsSrc);
  ok(typeof P.setCurrentProject === "function", "① Projects.setCurrentProject() 공유 지점이 존재한다(SoT)");
  P.currentDeck = { id: "leftover" };
  P.setCurrentProject({ id: "prjC", name: "C" });
  ok(P.currentDeck === null && P.currentProject.id === "prjC",
    "① setCurrentProject() 직접 호출도 currentDeck 을 null 로 만든다");
}
/* ── 뮤테이션ⓐ: setCurrentProject 의 리셋 줄 제거 → ①이 실패해야 한다 ── */
{
  console.log("\n[뮤테이션ⓐ] setCurrentProject() 의 currentDeck=null 제거 → ①이 실패해야 함");
  const needle = "setCurrentProject(p) {\n      this.currentProject = p || null;\n      this.currentDeck = null;\n    },";
  const mut = projectsSrc.replace(needle, "setCurrentProject(p) {\n      this.currentProject = p || null;\n    },");
  if (mut === projectsSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const P = loadProjects(mut);
    P.currentDeck = { id: "leftover" };
    P.setCurrentProject({ id: "prjC" });
    ok(P.currentDeck !== null, "뮤테이션 적용 시 ①이 깨짐(currentDeck 이 새 프로젝트로 샌다)");
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * Part B — pickOriginalDeck 은 UI.groupDecksByParent(SoT)로 고아(오염 parent_id) deck 도 루트로 승격
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[Part B · Projects.pickOriginalDeck — 오염된 parent_id 를 가진 deck 도 원본으로 찾는다]");
const uiSrc = src("11_UI.js");
function loadProjectsWithUI(projectsSrc, uiSrc) {
  const sandbox = {
    console, document: makeDoc(), navigator: { onLine: true },
    Auth: { headers: () => ({}), isDesigner: true, setProjectContext() {} },
    Prompt: { ask: async () => null, toast() {}, confirm: async () => true },
    fetch: async () => ({ ok: true, json: async () => ({ data: [] }) })
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // UI 를 먼저 평가해 Projects 실행 시점에 typeof UI !== "undefined" 가 참이 되게 한다.
  vm.runInContext(uiSrc + "\n;globalThis.__UI = UI;", sandbox);
  vm.runInContext(projectsSrc + "\n;globalThis.__P = Projects;", sandbox);
  return sandbox.__P;
}
{
  const P = loadProjectsWithUI(projectsSrc, uiSrc);
  // 재현 그대로: floor 의 parent_id 가 "이 프로젝트에 없는"(다른/삭제된 프로젝트) deck id 를 가리킨다.
  const decks = [
    { id: "dck_floor", name: "floor", deployment_id: "dep_floor", parent_id: "dck_foreign_root", created_at: 2000 }
  ];
  const picked = P.pickOriginalDeck(decks);
  ok(!!picked && picked.id === "dck_floor",
    "② 오염된 parent_id(이 프로젝트에 없는 deck)를 가진 deck 도 루트로 승격돼 원본으로 선택된다, 실제 " + JSON.stringify(picked));
}
{
  const P = loadProjectsWithUI(projectsSrc, uiSrc);
  // 회귀 없음 — 정상 parent_id(영역, 실제 구역 자식)는 여전히 루트에서 제외된다.
  const decks = [
    { id: "d1", name: "구역", deployment_id: "dep1", parent_id: null, created_at: 1000 },
    { id: "d1a", name: "영역", deployment_id: "dep1", parent_id: "d1", created_at: 2000 }
  ];
  const picked = P.pickOriginalDeck(decks);
  ok(!!picked && picked.id === "d1", "② 정상 영역(parent_id=존재하는 구역)은 여전히 원본 후보에서 제외된다(회귀 없음)");
}
/* ── 뮤테이션ⓑ: pickOriginalDeck 을 옛 필터(parent_id==null 만)로 되돌림 → ②가 실패해야 한다 ── */
{
  console.log("\n[뮤테이션ⓑ] pickOriginalDeck 을 parent_id==null 전용 필터로 되돌림 → ②가 실패해야 함");
  const needle = `      const roots = (typeof UI !== "undefined" && UI.groupDecksByParent)
        ? UI.groupDecksByParent(decks).roots.filter((d) => d && d.deployment_id)
        : decks.filter((d) => d && d.deployment_id && d.parent_id == null);`;
  const mut = projectsSrc.replace(needle, `      const roots = decks.filter((d) => d && d.deployment_id && d.parent_id == null);`);
  if (mut === projectsSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const P = loadProjectsWithUI(mut, uiSrc);
    const decks = [{ id: "dck_floor", name: "floor", deployment_id: "dep_floor", parent_id: "dck_foreign_root", created_at: 2000 }];
    const picked = P.pickOriginalDeck(decks);
    ok(picked === null, "뮤테이션 적용 시 ②가 깨짐(오염된 deck 이 다시 '원본 없음'으로 숨는다)");
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * Part C — 서버: POST/PUT /decks 는 parent_id 가 같은 프로젝트의 살아있는 deck 이 아니면 400
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[Part C · 실제 워커(src/index.tsx) + 실제 D1(Miniflare) — parent_id 신뢰 경계]");
const MIG_DIR = path.join(ROOT, "migrations");
const MIGS = fs.readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
const stmtsOf = (file) =>
  fs.readFileSync(path.join(MIG_DIR, file), "utf8").replace(/--[^\n]*/g, "")
    .split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
async function applyMigrations(db, files) { for (const f of files) for (const st of stmtsOf(f)) await db.exec(st); }
async function buildWorker(transform) {
  const out = path.join(os.tmpdir(), "p90-worker-" + process.pid + "-" + Math.random().toString(36).slice(2) + ".mjs");
  const plugins = transform ? [{
    name: "p90-mutate",
    setup(b) { b.onLoad({ filter: /index\.tsx$/ }, (a) => ({ contents: transform(fs.readFileSync(a.path, "utf8")), loader: "tsx" })); }
  }] : [];
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/index.tsx")], bundle: true, format: "esm", platform: "neutral",
    outfile: out, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
    conditions: ["workerd", "worker", "browser"], plugins
  });
  return out;
}
const TOK = "local-p90-designer";
const SEED = (now) => [
  ["INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
    ["designer@seastar.test", "설계자", "designssir@gmail.com", now, now]],
  ["INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)",
    ["designer@seastar.test", "설계자", "seastar.test", "x", "y", now, now]],
  ["INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)",
    [TOK, "designer@seastar.test", now, now + 8.64e7]],
  ["INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)",
    ["prj_p90a", "P90 프로젝트A(sunbo 역)", "", "designer@seastar.test", now, now]],
  ["INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)",
    ["prj_p90b", "P90 프로젝트B(tes 역, 삭제 예정)", "", "designer@seastar.test", now, now]],
  ["INSERT INTO deployments (id, title, file_name, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
    ["dep_p90", "도면", "floor.pdf", now, now]],
  // 다른 프로젝트(B)의 살아있는 루트 deck — A 에서 이걸 parent_id 로 쓰면 막혀야 한다.
  ["INSERT INTO decks (id, project_id, name, level_no, deployment_id, page, crop, parent_id, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,0)",
    ["dck_foreign_root", "prj_p90b", "ㅁ(다른 프로젝트 루트)", 1, "dep_p90", 1, null, null, now, now]],
  // 삭제된(soft-delete) A 프로젝트 자신의 deck — 같은 프로젝트여도 deleted=1 이면 막혀야 한다.
  ["INSERT INTO decks (id, project_id, name, level_no, deployment_id, page, crop, parent_id, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,1)",
    ["dck_deleted_a", "prj_p90a", "삭제된 A 구역", 1, "dep_p90", 1, null, null, now, now]],
];
const H = { Authorization: "Bearer " + TOK, "Content-Type": "application/json" };
async function apiRun(transform) {
  const script = await buildWorker(transform);
  const mf = new Miniflare({
    modules: true, scriptPath: script, d1Databases: { DB: "p90-" + Math.random().toString(36).slice(2) },
    r2Buckets: { R2: "p90r2" }, bindings: { DEMO_LOGIN: "0" }, compatibilityDate: "2025-01-01"
  });
  try {
    const db = await mf.getD1Database("DB");
    await applyMigrations(db, MIGS);
    const now = Date.now();
    for (const [q, a] of SEED(now)) await db.prepare(q).bind(...a).run();
    const B = "http://p90.test";
    const post = (body) => mf.dispatchFetch(B + "/api/projects/prj_p90a/decks", { method: "POST", headers: H, body: JSON.stringify(body) });
    // ① 다른 프로젝트(B)의 살아있는 deck 을 parent_id 로 — 400 기대
    const rForeign = await post({ name: "floor(오염)", deployment_id: "dep_p90", page: 1, parent_id: "dck_foreign_root" });
    // ② 자기 프로젝트(A)의 삭제된 deck 을 parent_id 로 — 400 기대
    const rDeleted = await post({ name: "floor(삭제부모)", deployment_id: "dep_p90", page: 1, parent_id: "dck_deleted_a" });
    // ③ 정상: 먼저 루트 구역을 만들고, 그 살아있는 id 를 parent_id 로 — 200 기대(회귀 없음)
    const rRoot = await post({ name: "메인데크", deployment_id: "dep_p90", page: 1 });
    const root = await rRoot.json();
    const rOk = await post({ name: "평면도", deployment_id: "dep_p90", page: 1, parent_id: root.id });
    // ④ PUT 도 같은 규칙 — 방금 만든 정상 영역을 다른 프로젝트 deck 부모로 바꾸려 하면 400
    const okRegion = await rOk.json();
    const rPutForeign = await mf.dispatchFetch(B + "/api/decks/" + okRegion.id, {
      method: "PUT", headers: H, body: JSON.stringify({ parent_id: "dck_foreign_root" })
    });
    return {
      foreignStatus: rForeign.status, deletedStatus: rDeleted.status,
      rootStatus: rRoot.status, okStatus: rOk.status, putForeignStatus: rPutForeign.status
    };
  } finally { await mf.dispose(); try { fs.unlinkSync(script); } catch {} }
}
{
  const r = await apiRun(null);
  ok(r.foreignStatus === 400, "③ POST — 다른 프로젝트의 살아있는 deck 을 parent_id 로 쓰면 400, 실제 " + r.foreignStatus);
  ok(r.deletedStatus === 400, "③ POST — 삭제된(deleted=1) deck 을 parent_id 로 쓰면 400, 실제 " + r.deletedStatus);
  ok(r.rootStatus === 200 && r.okStatus === 200, "③ 정상 루트 생성 + 같은 프로젝트 살아있는 구역을 부모로 둔 영역 생성은 여전히 200(회귀 없음)");
  ok(r.putForeignStatus === 400, "③ PUT — 다른 프로젝트 deck 으로 부모를 바꾸려 하면 400, 실제 " + r.putForeignStatus);
}
/* ── 뮤테이션ⓒ: POST 의 parent_id 검증 제거 → ③이 실패해야 한다 ── */
{
  console.log("\n[뮤테이션ⓒ] POST /decks 의 parent_id 신뢰경계 검증 제거 → ③이 실패해야 함");
  const needle = `  if (parentId && !(await isLiveDeckInProject(c.env.DB, parentId, pid))) {
    return c.json({ error: 'parent_id must reference a live deck in the same project' }, 400)
  }
  await c.env.DB.prepare(
    \`INSERT INTO decks`;
  const r = await apiRun((s) => {
    const mut = s.replace(needle, `  await c.env.DB.prepare(\n    \`INSERT INTO decks`);
    if (mut === s) throw new Error("뮤테이션 대상 문자열을 찾지 못함(소스 변경?)");
    return mut;
  }).catch((e) => ({ error: String(e && e.message || e) }));
  if (r.error) { console.log("  FAIL " + r.error); failed++; }
  else ok(r.foreignStatus === 200, "뮤테이션 적용 시 ③이 깨짐(오염된 parent_id 가 다시 그대로 저장됨) — 실제 status " + r.foreignStatus);
}

/* ══════════════════════════════════════════════════════════════════════
 * Part D — App._restoreProjectDraft: 현재 프로젝트의 살아있는 decks 에 없는 deck 의 draft 는 버린다
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[Part D · App._restoreProjectDraft — 고아(다른/삭제 프로젝트) deck 의 draft 는 복원하지 않는다]");
const appSrc = src("20_App.js");
function loadAppForRestore(appSrc, { drafts, liveDecks }) {
  const restored = [];
  const sandbox = {
    console,
    SyncQueue: {
      allDraftKeys: async () => Object.keys(drafts),
      loadDraft: async (k) => drafts[k]
    },
    Projects: { decks: liveDecks, currentDeck: null, _renderDecks() {} }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appSrc + "\n;globalThis.__A = App;", sandbox);
  const A = sandbox.__A;
  A._deckIdOfKey = (k) => { const i = String(k).indexOf("::"); return i < 0 ? null : String(k).slice(i + 2); };
  A._restoreDraftLocal = async (key) => { restored.push(key); return true; };
  return { A, sandbox, restored };
}
{
  // 재현 그대로 — "prjSunbo::dck_foreign_root"(다른/삭제 프로젝트 deck) 하나뿐인 오염 draft.
  const drafts = {
    "prjSunbo::dck_foreign_root": { pages: ["data:x"], dirty: true }
  };
  const { A, restored } = loadAppForRestore(appSrc, { drafts, liveDecks: [] /* 현재 프로젝트엔 이 deck 이 없다 */ });
  const result = await A._restoreProjectDraft("prjSunbo");
  ok(result === false && restored.length === 0,
    "④ 현재 프로젝트에 없는 deck 을 가리키는 draft 는 복원하지 않는다(고아 draft 화면 유입 차단), 실제 result=" + result + " restored=" + JSON.stringify(restored));
}
{
  // 회귀 없음 — 진짜 이 프로젝트의 살아있는 deck 을 가리키는 draft 는 그대로 복원된다.
  const drafts = { "prjSunbo::dck_real": { pages: ["data:x"], dirty: true } };
  const { A, restored } = loadAppForRestore(appSrc, { drafts, liveDecks: [{ id: "dck_real" }] });
  const result = await A._restoreProjectDraft("prjSunbo");
  ok(result === true && restored[0] === "prjSunbo::dck_real",
    "④ 정상 draft(현재 프로젝트의 살아있는 deck)는 그대로 복원된다(회귀 없음)");
}
/* ── 뮤테이션ⓓ: _restoreProjectDraft 의 고아 discard 가드 제거 → ④가 실패해야 한다 ── */
{
  console.log("\n[뮤테이션ⓓ] _restoreProjectDraft 의 고아 discard 가드(if (did && !deck) continue;) 제거 → ④가 실패해야 함");
  const needle = "          if (did && !deck) continue;\n";
  const mut = appSrc.replace(needle, "");
  if (mut === appSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const drafts = { "prjSunbo::dck_foreign_root": { pages: ["data:x"], dirty: true } };
    const { A, restored } = loadAppForRestore(mut, { drafts, liveDecks: [] });
    const result = await A._restoreProjectDraft("prjSunbo");
    ok(result === true && restored.length === 1, "뮤테이션 적용 시 ④가 깨짐(고아 draft 가 다시 복원된다)");
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
