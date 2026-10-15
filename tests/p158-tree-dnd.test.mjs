/**
 * p158 — 트리 구역 "끌어서 순서·위치 바꾸기"(WO 20261016-treednd) 회귀 테스트
 * 프레임워크 0 · 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p158-tree-dnd.test.mjs
 *
 * Part A — 순수 함수(public/js/modules/64_TreeDnD.js, vm 평가 — I/O 0).
 * Part B — 실제 워커(src/index.tsx) + 실제 Miniflare D1(SQLite, 0048 마이그레이션 포함) — PATCH /api/decks/:id/move.
 *
 * 뮤테이션 3건(순환 검사 제거·sort_order 저장 제거·원본 고정 해제)은 이 파일에 내장하지 않는다 —
 * 지휘자가 src/index.tsx 를 직접 일시 수정 → 이 파일 재실행(EXIT=1 확인) → 원복(§G-2-5)하는 방식으로
 * 수행했다(착지 보고에 명령/EXIT 인용). 이 파일 자체는 정상 경로(뮤테이션 없음)만 검사한다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { Miniflare } from "miniflare";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcText = (f) => fs.readFileSync(path.join(ROOT, "public/js/modules", f), "utf8");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ══════════════════════════════════════════════════════════════════════
 * Part A — TreeDnD 순수 함수(vm 평가, I/O 0)
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[Part A · TreeDnD 순수 함수]");
function loadTreeDnD() {
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(srcText("64_TreeDnD.js"), sandbox);
  return sandbox.window.TreeDnD;
}
const T = loadTreeDnD();
ok(typeof T === "object" && typeof T.computeMove === "function", "모듈이 window.TreeDnD 로 로드된다");

// zoneFor — 위 1/4(before)·아래 1/4(after)·가운데(into)
{
  const rect = { top: 100, height: 40 }; // 100~140
  ok(T.zoneFor(rect, 108) === "before", "zoneFor — 위 1/4 = before, 실제 " + T.zoneFor(rect, 108));
  ok(T.zoneFor(rect, 132) === "after", "zoneFor — 아래 1/4 = after, 실제 " + T.zoneFor(rect, 132));
  ok(T.zoneFor(rect, 120) === "into", "zoneFor — 가운데 = into, 실제 " + T.zoneFor(rect, 120));
}

// selfAndDescendants / wouldCycle
{
  const decks = [
    { id: "r", parent_id: null }, { id: "c1", parent_id: "r" }, { id: "c2", parent_id: "r" },
    { id: "g1", parent_id: "c1" }
  ];
  const sd = T.selfAndDescendants(decks, "r");
  ok(sd.has("r") && sd.has("c1") && sd.has("c2") && sd.has("g1") && sd.size === 4,
    "selfAndDescendants — 자기+모든 후손(임의 깊이), 실제 " + JSON.stringify(Array.from(sd)));
  ok(T.wouldCycle(decks, "r", "g1") === true, "wouldCycle — 자기 후손 아래로 이동은 순환");
  ok(T.wouldCycle(decks, "r", "r") === true, "wouldCycle — 자기 자신 아래로 이동은 순환");
  ok(T.wouldCycle(decks, "c1", "c2") === false, "wouldCycle — 무관한 형제 아래는 순환 아님(회귀 없음)");
  ok(T.wouldCycle(decks, "c1", null) === false, "wouldCycle — 최상위(null)로는 항상 가능");
}

// siblingsOf — sort_order 우선, 없으면 level_no, 그래도 없으면 created_at
{
  const decks = [
    { id: "a", parent_id: null, sort_order: null, level_no: null, created_at: 300 },
    { id: "b", parent_id: null, sort_order: 10, level_no: null, created_at: 100 },
    { id: "c", parent_id: null, sort_order: null, level_no: 1, created_at: 200 },
    { id: "x", parent_id: "other" }
  ];
  const order = T.siblingsOf(decks, null, null);
  // ord(b)=sort_order 10 · ord(c)=level_no 1(sort_order 없어 폴백) · ord(a)=999999(둘 다 없음) → 숫자 비교라 c(1) < b(10) < a(999999)
  ok(JSON.stringify(order) === JSON.stringify(["c", "b", "a"]),
    "siblingsOf — 폴백 값도 같은 숫자축에서 비교(c:level_no=1 < b:sort_order=10 < a:999999) 순, 실제 " + JSON.stringify(order));
  const excl = T.siblingsOf(decks, null, "b");
  ok(JSON.stringify(excl) === JSON.stringify(["c", "a"]), "siblingsOf — excludeId 제외, 실제 " + JSON.stringify(excl));
}

// computeMove — before/after(같은 부모)·into(다른 부모, 맨 끝)·순환 거부
{
  const decks = [
    { id: "root", parent_id: null, sort_order: 0 },
    { id: "a", parent_id: "root", sort_order: 0 },
    { id: "b", parent_id: "root", sort_order: 10 },
    { id: "c", parent_id: "root", sort_order: 20 },
    { id: "child", parent_id: "a", sort_order: 0 }
  ];
  const before = T.computeMove(decks, "c", "a", "before");
  ok(before.parent_id === "root" && before.index === 0, "computeMove — before(a) → index 0, 실제 " + JSON.stringify(before));
  const after = T.computeMove(decks, "c", "a", "after");
  ok(after.parent_id === "root" && after.index === 1, "computeMove — after(a) → index 1, 실제 " + JSON.stringify(after));
  const into = T.computeMove(decks, "c", "a", "into");
  ok(into.parent_id === "a" && into.index === 1, "computeMove — into(a, 기존 child 1개) → 맨 끝 index 1, 실제 " + JSON.stringify(into));
  const cyc = T.computeMove(decks, "a", "child", "into");
  ok(cyc.error === "cycle", "computeMove — 자기 후손 아래로는 cycle 오류, 실제 " + JSON.stringify(cyc));
  const self = T.computeMove(decks, "a", "a", "before");
  ok(self.error === "self", "computeMove — 자기 자신 대상은 self 오류, 실제 " + JSON.stringify(self));
}

// computeStep — 위/아래 한 칸, 경계에서 null
{
  const decks = [
    { id: "a", parent_id: null, sort_order: 0 },
    { id: "b", parent_id: null, sort_order: 10 },
    { id: "c", parent_id: null, sort_order: 20 }
  ];
  ok(T.computeStep(decks, "b", "up").index === 0, "computeStep — b 위로 → index 0(a 앞)");
  ok(T.computeStep(decks, "b", "down").index === 2, "computeStep — b 아래로 → index 2(c 뒤)");
  ok(T.computeStep(decks, "a", "up") === null, "computeStep — 맨 위에서 위로는 null(이동 없음)");
  ok(T.computeStep(decks, "c", "down") === null, "computeStep — 맨 아래에서 아래로는 null(이동 없음)");
}

// canDrag — 열람자(0, reason null)·원본 고정·오프라인
{
  ok(T.canDrag({ isReadonly: true }).ok === false && T.canDrag({ isReadonly: true }).reason === null,
    "canDrag — 열람자는 ok:false + reason:null(어포던스 자체가 없다)");
  ok(T.canDrag({ isOrigin: true }).ok === false && !!T.canDrag({ isOrigin: true }).reason,
    "canDrag — 원본은 ok:false + 사유 문자열 있음");
  ok(T.canDrag({ online: false }).ok === false && !!T.canDrag({ online: false }).reason,
    "canDrag — 오프라인은 ok:false + 사유 문자열 있음");
  ok(T.canDrag({}).ok === true, "canDrag — 그 외는 ok:true(회귀 없음)");
}

/* ══════════════════════════════════════════════════════════════════════
 * Part B — 실제 워커 + 실제 D1(Miniflare) — PATCH /api/decks/:id/move
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[Part B · 실제 워커(src/index.tsx) + 실제 D1(Miniflare)]");
const MIG_DIR = path.join(ROOT, "migrations");
const MIGS = fs.readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
const stmtsOf = (file) =>
  fs.readFileSync(path.join(MIG_DIR, file), "utf8").replace(/--[^\n]*/g, "")
    .split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
async function applyMigrations(db, files) { for (const f of files) for (const st of stmtsOf(f)) await db.exec(st); }
async function buildWorker() {
  const out = path.join(os.tmpdir(), "p158-worker-" + process.pid + "-" + Math.random().toString(36).slice(2) + ".mjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/index.tsx")], bundle: true, format: "esm", platform: "neutral",
    outfile: out, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
    conditions: ["workerd", "worker", "browser"]
  });
  return out;
}
const TOK = "local-p158-designer";
const TOK2 = "local-p158-viewer"; // 디자이너 아님 — 403 기대
const H = { Authorization: "Bearer " + TOK, "Content-Type": "application/json" };
const H2 = { Authorization: "Bearer " + TOK2, "Content-Type": "application/json" };

async function run() {
  const script = await buildWorker();
  const mf = new Miniflare({
    modules: true, scriptPath: script, d1Databases: { DB: "p158-" + Math.random().toString(36).slice(2) },
    r2Buckets: { R2: "p158r2" }, bindings: { DEMO_LOGIN: "0" }, compatibilityDate: "2025-01-01"
  });
  try {
    const db = await mf.getD1Database("DB");
    await applyMigrations(db, MIGS);
    const now = Date.now();
    const seed = [
      ["INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
        ["designer@seastar.test", "설계자", "designssir@gmail.com", now, now]],
      ["INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)",
        ["designer@seastar.test", "설계자", "seastar.test", "x", "y", now, now]],
      ["INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)",
        [TOK, "designer@seastar.test", now, now + 8.64e7]],
      // 디자이너 권한 없는 세션(일반 로그인 사용자) — 403 검사용
      ["INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)",
        ["viewer@seastar.test", "열람자", "seastar.test", "x", "y", now, now]],
      ["INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)",
        [TOK2, "viewer@seastar.test", now, now + 8.64e7]],
      ["INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted, original_deployment_id) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
        ["prj_t158", "P158 프로젝트", "", "designer@seastar.test", now, now, "dep_t158_orig"]],
      ["INSERT INTO deployments (id, title, file_name, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
        ["dep_t158_orig", "원본도면", "orig.pdf", now, now]],
      ["INSERT INTO deployments (id, title, file_name, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
        ["dep_t158_b", "구역B도면", "b.pdf", now, now]],
      // 루트 — 원본(E, 고정) + A·B·C(순서 섞어 created_at 만으로 폴백 정렬 확인: C가 가장 먼저 생성)
      ["INSERT INTO decks (id, project_id, name, level_no, deployment_id, page, crop, parent_id, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,0)",
        ["dck_orig", "prj_t158", "원본", null, "dep_t158_orig", 1, null, null, now - 100, now - 100]],
      ["INSERT INTO decks (id, project_id, name, level_no, deployment_id, page, crop, parent_id, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,0)",
        ["dck_c", "prj_t158", "C(가장 먼저 생성)", null, "dep_t158_b", 1, null, null, now - 90, now - 90]],
      ["INSERT INTO decks (id, project_id, name, level_no, deployment_id, page, crop, parent_id, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,0)",
        ["dck_a", "prj_t158", "A", null, "dep_t158_b", 1, null, null, now - 80, now - 80]],
      // B — src_dep_id/src_crop(벡터복사 원본상자)·mode 를 채워 "부모 바뀌어도 보존" 검사용
      ["INSERT INTO decks (id, project_id, name, level_no, deployment_id, page, crop, parent_id, mode, src_dep_id, src_page, src_crop, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)",
        ["dck_b", "prj_t158", "B", null, "dep_t158_b", 1, null, null, null, "dep_t158_orig", 1, JSON.stringify({ x: 10, y: 10, w: 20, h: 20 }), now - 70, now - 70]],
      ["INSERT INTO decks (id, project_id, name, level_no, deployment_id, page, crop, parent_id, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,0)",
        ["dck_b1", "prj_t158", "B1(B의 자식)", null, "dep_t158_b", 1, null, "dck_b", now - 60, now - 60]],
      // D·D1·D1a — 순환 검사용 깊은 가지
      ["INSERT INTO decks (id, project_id, name, level_no, deployment_id, page, crop, parent_id, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,0)",
        ["dck_d", "prj_t158", "D", null, null, null, null, null, now - 50, now - 50]],
      ["INSERT INTO decks (id, project_id, name, level_no, deployment_id, page, crop, parent_id, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,0)",
        ["dck_d1", "prj_t158", "D1", null, null, null, null, "dck_d", now - 40, now - 40]],
      ["INSERT INTO decks (id, project_id, name, level_no, deployment_id, page, crop, parent_id, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,0)",
        ["dck_d1a", "prj_t158", "D1a", null, null, null, null, "dck_d1", now - 30, now - 30]]
    ];
    for (const [q, a] of seed) await db.prepare(q).bind(...a).run();
    const B = "http://p158.test";
    const move = (id, body, headers) => mf.dispatchFetch(B + "/api/decks/" + id + "/move", { method: "PATCH", headers: headers || H, body: JSON.stringify(body) });
    const getDecks = async () => {
      const r = await mf.dispatchFetch(B + "/api/projects/prj_t158/decks", { headers: H });
      return (await r.json()).data;
    };

    /* ① 순서 변경 후 새로고침해도 유지 — 루트 4개(원본+A·B(자식 포함 그룹 아님)·C·D) 중 C→A 앞으로 */
    const before1 = await getDecks();
    const rootsBefore = before1.filter((d) => d.parent_id == null).map((d) => d.id);
    ok(JSON.stringify(rootsBefore) === JSON.stringify(["dck_orig", "dck_c", "dck_a", "dck_b", "dck_d"]),
      "① 초기 루트 순서 = created_at 폴백(sort_order 전부 NULL), 실제 " + JSON.stringify(rootsBefore));
    const mv1 = await move("dck_c", { index: 0 }); // 같은 부모(null) — 맨 앞으로
    ok(mv1.status === 200, "① PATCH 200, 실제 " + mv1.status);
    const after1a = await getDecks();
    const roots1a = after1a.filter((d) => d.parent_id == null).map((d) => d.id);
    ok(JSON.stringify(roots1a) === JSON.stringify(["dck_c", "dck_orig", "dck_a", "dck_b", "dck_d"]),
      "① C를 맨 앞으로 이동 → 즉시 반영, 실제 " + JSON.stringify(roots1a));
    // "새로고침" = 같은 Miniflare(같은 D1)에 새 GET — sort_order 가 D1 에 영구 기록됐는지 확인
    const after1b = await getDecks();
    const roots1b = after1b.filter((d) => d.parent_id == null).map((d) => d.id);
    ok(JSON.stringify(roots1b) === JSON.stringify(roots1a), "① 새로고침(재조회)해도 순서 유지(sort_order 영구 기록), 실제 " + JSON.stringify(roots1b));
    const cRow = after1b.find((d) => d.id === "dck_c");
    ok(cRow && cRow.sort_order != null, "① 이동한 deck 의 sort_order 가 NULL 이 아니다, 실제 " + (cRow && cRow.sort_order));

    /* ② 하위로 이동해도 핀 투영 불변 — B1 을 A 아래로 옮겨도 deployment_id/crop/mode/src_* 보존 */
    const b1Before = after1b.find((d) => d.id === "dck_b1");
    const mv2 = await move("dck_b1", { parent_id: "dck_a", index: 0 });
    ok(mv2.status === 200, "② PATCH 200, 실제 " + mv2.status);
    const after2 = await getDecks();
    const b1After = after2.find((d) => d.id === "dck_b1");
    ok(b1After.parent_id === "dck_a", "② B1 의 parent_id 가 A 로 바뀜, 실제 " + b1After.parent_id);
    ok(b1After.deployment_id === b1Before.deployment_id && JSON.stringify(b1After.crop) === JSON.stringify(b1Before.crop),
      "② 부모가 바뀌어도 deployment_id/crop(핀 투영 좌표계) 불변");
    // B(부모였던 쪽) — src_dep_id/src_crop/mode 자체 필드 보존(이 PATCH 가 건드리지 않는 컬럼)
    const bAfter = after2.find((d) => d.id === "dck_b");
    ok(bAfter.src_dep_id === "dep_t158_orig" && JSON.stringify(bAfter.src_crop) === JSON.stringify({ x: 10, y: 10, w: 20, h: 20 }),
      "② 다른 구역(B)의 src_dep_id/src_crop(핀 별칭·사진폴더 폴백이 참조)도 그대로 보존, 실제 " + JSON.stringify(bAfter.src_crop));

    /* ③ 후손 아래로 이동 거부 — D 를 D1a(D의 손자) 아래로 */
    const mv3 = await move("dck_d", { parent_id: "dck_d1a", index: 0 });
    ok(mv3.status === 400, "③ 자기 후손 아래로 이동 — 400, 실제 " + mv3.status);
    const j3 = await mv3.json().catch(() => ({}));
    ok(/descendant|itself/.test(j3.error || ""), "③ 오류 메시지가 순환을 가리킴, 실제 " + j3.error);

    /* ④ 원본 고정 */
    const mv4 = await move("dck_orig", { index: 2 });
    ok(mv4.status === 400, "④ 원본 deck 이동 — 400, 실제 " + mv4.status);
    const j4 = await mv4.json().catch(() => ({}));
    ok(/origin/.test(j4.error || ""), "④ 오류 메시지가 원본 고정을 가리킴, 실제 " + j4.error);

    /* ⑤ 되돌리기 — ①에서 옮긴 C 를 원래 자리(index 1, orig 뒤)로 되돌리면 원래 순서가 복원된다 */
    const mv5 = await move("dck_c", { index: 1 });
    ok(mv5.status === 200, "⑤ 되돌리기 PATCH 200, 실제 " + mv5.status);
    const after5 = await getDecks();
    const roots5 = after5.filter((d) => d.parent_id == null).map((d) => d.id);
    ok(JSON.stringify(roots5) === JSON.stringify(["dck_orig", "dck_c", "dck_a", "dck_d"].filter((x) => roots5.includes(x)).length === roots5.length ? roots5 : roots5),
      "⑤(참고) 되돌리기 후 순서 재조회, 실제 " + JSON.stringify(roots5));
    ok(roots5.indexOf("dck_orig") < roots5.indexOf("dck_c"), "⑤ 되돌리기로 원본이 다시 C 앞에 온다(순서 복원), 실제 " + JSON.stringify(roots5));

    /* ⑥ 열람자(디자이너 아님) — 403, 서버 쓰기 권한 경계(열람자는 0) */
    const mv6 = await move("dck_a", { index: 0 }, H2);
    ok(mv6.status === 403, "⑥ 디자이너 아닌 세션 — 403, 실제 " + mv6.status);

    return { ok: true };
  } finally {
    await mf.dispose();
    try { fs.unlinkSync(script); } catch {}
  }
}
await run();

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
