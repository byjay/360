/**
 * p199 — decks.parent_id 순환 방지(WO 20261112-deckcycle) 회귀 테스트
 * 프레임워크 0 · 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p199-deck-cycle-guard.test.mjs
 *
 * 재현된 결함: PUT /api/decks/:id 는 자기참조만 막고(parentId === id) 후손 전수 검사가 없어
 * PUT A.parent=B → PUT B.parent=A 2회로 순환을 만들 수 있었다(.tmp/repro-cycle.mjs 실측,
 * 둘 다 status 200). PATCH /api/decks/:id/move 는 이미 deckSelfAndDescendantIds() 로 전수
 * 검사를 한다 — 그 공유 헬퍼를 PUT·POST 에도 재사용해 고쳤다.
 *
 * TLA+ 모델(formal/deck_parent_acyclic.tla)로 N<=4 유한 상태공간에서 수정 전 반례(EXIT=12,
 * Create→Create→PutParentBuggy 로 순환 발견) → 수정 후 무결(EXIT=0, 43013 states) 확인 완료.
 * 이 파일은 실제 워커(src/index.tsx) + 실제 Miniflare D1(SQLite, 마이그레이션 포함)으로
 * HTTP 레벨 회귀를 확인한다.
 *
 * 뮤테이션(PUT 의 후손 검사 제거 → ① 실패해야 함)은 이 파일에 esbuild onLoad 플러그인으로
 * 내장했다(p90 의 apiRun(transform) 패턴과 동일).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { Miniflare } from "miniflare";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

const MIG_DIR = path.join(ROOT, "migrations");
const MIGS = fs.readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
const stmtsOf = (file) =>
  fs.readFileSync(path.join(MIG_DIR, file), "utf8").replace(/--[^\n]*/g, "")
    .split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
async function applyMigrations(db, files) { for (const f of files) for (const st of stmtsOf(f)) await db.exec(st); }

async function buildWorker(transform) {
  const out = path.join(os.tmpdir(), "p199-worker-" + process.pid + "-" + Math.random().toString(36).slice(2) + ".mjs");
  const plugins = transform ? [{
    name: "p199-mutate",
    setup(b) { b.onLoad({ filter: /index\.tsx$/ }, (a) => ({ contents: transform(fs.readFileSync(a.path, "utf8")), loader: "tsx" })); }
  }] : [];
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/index.tsx")], bundle: true, format: "esm", platform: "neutral",
    outfile: out, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
    conditions: ["workerd", "worker", "browser"], plugins
  });
  return out;
}

const TOK = "local-p199-designer";
const H = { Authorization: "Bearer " + TOK, "Content-Type": "application/json" };
const SEED = (now) => [
  ["INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
    ["designer@seastar.test", "설계자", "designssir@gmail.com", now, now]],
  ["INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)",
    ["designer@seastar.test", "설계자", "seastar.test", "x", "y", now, now]],
  ["INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)",
    [TOK, "designer@seastar.test", now, now + 8.64e7]],
  ["INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)",
    ["prj_p199", "P199 프로젝트", "", "designer@seastar.test", now, now]],
];

async function apiRun(transform) {
  const script = await buildWorker(transform);
  const mf = new Miniflare({
    modules: true, scriptPath: script, d1Databases: { DB: "p199-" + Math.random().toString(36).slice(2) },
    r2Buckets: { R2: "p199r2" }, bindings: { DEMO_LOGIN: "0" }, compatibilityDate: "2025-01-01"
  });
  try {
    const db = await mf.getD1Database("DB");
    await applyMigrations(db, MIGS);
    const now = Date.now();
    for (const [q, a] of SEED(now)) await db.prepare(q).bind(...a).run();
    const B = "http://p199.test";
    const post = (body) => mf.dispatchFetch(B + "/api/projects/prj_p199/decks", { method: "POST", headers: H, body: JSON.stringify(body) });
    const put = (id, body) => mf.dispatchFetch(B + "/api/decks/" + id, { method: "PUT", headers: H, body: JSON.stringify(body) });
    const move = (id, body) => mf.dispatchFetch(B + "/api/decks/" + id + "/move", { method: "PATCH", headers: H, body: JSON.stringify(body) });

    // A, B, C 생성(모두 최상위)
    const a = await (await post({ name: "A" })).json();
    const b = await (await post({ name: "B" })).json();
    const c = await (await post({ name: "C" })).json();

    // ① PUT A.parent=B(200, 정상) 뒤 PUT B.parent=A — 재현된 결함: 지금 400 이어야 한다
    const pAB = await put(a.id, { parent_id: b.id });
    const pBA = await put(b.id, { parent_id: a.id });
    const jBA = await pBA.json().catch(() => ({}));

    // ② 3단 깊이: A.parent=B, B.parent=C 뒤 C.parent=A(손자 순환) — 400
    const pBC = await put(b.id, { parent_id: c.id }); // b 를 c 아래로(이미 a->b 라 지금은 a.parent=b, b.parent=c)
    const pCA = await put(c.id, { parent_id: a.id });
    const jCA = await pCA.json().catch(() => ({}));

    // ③ 정상 회귀 — 관련 없는 부모 지정은 여전히 200
    const d = await (await post({ name: "D" })).json();
    const pDOk = await put(d.id, { parent_id: c.id });

    // ④ 자기참조는 여전히 400(기존 규칙, 회귀 없음)
    const pSelf = await put(d.id, { parent_id: d.id });

    // ⑤ PATCH /move 경로는 기존 그대로 동작(순환 거부 유지, 정상 이동도 200)
    //   이 시점 체인: a.parent=b, b.parent=c(둘 다 ②에서 성립) → c 가 a 의 조상.
    //   c 를 a 아래로 옮기면(조상을 자기 후손 아래로) 순환 — 기존 가드가 그대로 막아야 한다.
    const e = await (await post({ name: "E" })).json();
    const mvCycle = await move(c.id, { parent_id: a.id, index: 0 });
    const mvOk = await move(e.id, { parent_id: d.id, index: 0 });

    // ⑥ POST 시 parent_id 지정 — 정상 생성은 그대로 200(회귀 없음, 새 id 는 후손일 수 없음)
    const f = await (await post({ name: "F", parent_id: d.id })).json();

    return {
      putCycleStatus: pBA.status, putCycleMsg: jBA.error || "",
      deepCycleStatus: pCA.status, deepCycleMsg: jCA.error || "",
      normalPutStatus: pDOk.status, selfPutStatus: pSelf.status,
      moveCycleStatus: mvCycle.status, moveOkStatus: mvOk.status,
      postWithParentStatus: f && f.id ? 200 : (f && f.error ? 400 : -1)
    };
  } finally { await mf.dispose(); try { fs.unlinkSync(script); } catch {} }
}

console.log("\n[p199 · decks.parent_id 순환 방지]");
{
  const r = await apiRun(null);
  ok(r.putCycleStatus === 400, "① PUT A.parent=B → PUT B.parent=A(순환) — 400, 실제 " + r.putCycleStatus);
  ok(/순환|cycle|descendant/.test(r.putCycleMsg), "① 오류 메시지가 순환을 가리킴, 실제 " + r.putCycleMsg);
  ok(r.deepCycleStatus === 400, "② 손자 단계(3-cycle) PUT C.parent=A — 400, 실제 " + r.deepCycleStatus);
  ok(r.normalPutStatus === 200, "③ 관련 없는 정상 PUT — 200(회귀 없음), 실제 " + r.normalPutStatus);
  ok(r.selfPutStatus === 400, "④ 자기참조 PUT — 여전히 400(기존 규칙 불변), 실제 " + r.selfPutStatus);
  ok(r.moveCycleStatus === 400, "⑤ PATCH/move 의 기존 순환 거부 — 그대로 400(회귀 없음), 실제 " + r.moveCycleStatus);
  ok(r.moveOkStatus === 200, "⑤ PATCH/move 의 정상 이동 — 그대로 200(회귀 없음), 실제 " + r.moveOkStatus);
  ok(r.postWithParentStatus === 200, "⑥ POST 생성 시 parent_id 지정(새 id) — 200(회귀 없음), 실제 " + r.postWithParentStatus);
}

/* ── 뮤테이션 — PUT 의 순환 검사(deckSelfAndDescendantIds 호출) 제거 → ①②가 실패해야 함 ── */
console.log("\n[뮤테이션] PUT /api/decks/:id 의 후손 순환 검사 제거 → ①②가 실패해야 함");
{
  const needle = `  if (parentId) {
    const selfAndDesc = await deckSelfAndDescendantIds(c.env.DB, row.project_id, id)
    if (selfAndDesc.has(parentId)) return c.json({ error: '순환 구조가 됩니다 — cannot set parent to self or own descendant' }, 400)
  }
  // [WO 20260930-fixmode] mode 부분 수정`;
  const r = await apiRun((s) => {
    const mut = s.replace(needle, `  // [WO 20260930-fixmode] mode 부분 수정`);
    if (mut === s) throw new Error("뮤테이션 대상 문자열을 찾지 못함(소스 변경?)");
    return mut;
  }).catch((e) => ({ error: String(e && e.message || e) }));
  if (r.error) { console.log("  FAIL " + r.error); failed++; }
  else {
    ok(r.putCycleStatus === 200, "뮤테이션 적용 시 ①이 깨짐(PUT 순환이 다시 200으로 허용됨) — 실제 " + r.putCycleStatus);
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
