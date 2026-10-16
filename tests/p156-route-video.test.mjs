/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p156-route-video.test.mjs)
 *
 * [360 동선] 재이식 — 참조: worktree 4e1b93b(구현·검증 완료, origin 옛 기반이라 merge 금지) →
 *   main(c0cfa9f 이후) 구조에 다시 구현. 마스터: "도면 위에서 선을 긋듯 동선을 그리고,
 *   그 동선에 360 동영상(30MB 까지)을 연결해 THETA 뷰처럼 재생".
 * 서버 = src/index.tsx 실 번들 → Miniflare(workerd) + 실 D1(migrations 전부, 0047 포함). 목 0.
 *
 *  T1 R2 Range: 206 + 바이트 정확성 · 전체 GET(Range 없음)은 영향 없음
 *  T2 업로드 크기 상한 — 30MB 성공 · 33MB 413(Content-Length 선검사)
 *  T3 routes 생성 → ops(entity:'route') upsert/삭제(tombstone) → 리로드 지속성
 *  T4 PATCH로 pins만 갱신해도 routes 유실 없음(머지) — 오프라인 병합 경로
 *  T5 뷰어(비디자이너): ops 403(편집 금지) · 단건 GET 200(재생 가능)
 *  T6 열람 링크(/v/ = auto-entry lk, 360 전용 모드): GET 에 routes 포함(재생 가능) · ops 403(편집 0)
 *  T7 배포(publish) → pub_snapshots 동결에 routes 포함 · 재배포 시 갱신 반영
 *  T8 도면 개정(revision) 적용 — carryRoutes 로 동선 점 좌표가 즉시 이월(아핀 변환)
 *  T9 R2 읽기 권한(canReadR2Key) — routes 컬럼에 적힌 videoId 도 그 배포본 멤버만 읽을 수 있다
 *
 * 뮤테이션: MUT=<이름> 이면 src 사본에 치환 적용 후 빌드(치환 실패 = EXIT 3). 각 뮤테이션은 EXIT=1 이어야 한다.
 *   range    : GET /api/r2/object Range 분기 제거 → 206 대신 200(전체) — Range 미지원 복원
 *   pickAnno : ops pick() 에서 'route' 분기 제거 → route op 가 annotations 로 오분류
 *   gateRead : getUser → requireDesigner 치환(열람자가 읽기도 막힘, 재생 불가 — §G 되돌림 검증용 반대 방향)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { Miniflare } from "miniflare";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
let failed = 0;
const ok = (cond, label, d) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (!cond && d !== undefined ? " :: " + JSON.stringify(d).slice(0, 300) : "")); if (!cond) failed++; };
const watchdog = setTimeout(() => { console.log("\nWATCHDOG — 150s 초과 → FAIL"); process.exit(1); }, 150000);

const MUTS = {
  range: ["const rangeHeader = c.req.header('Range') || ''\n  const m = rangeHeader.match(/bytes=(\\d*)-(\\d*)/)", "const rangeHeader = ''\n  const m = rangeHeader.match(/bytes=(\\d*)-(\\d*)/)"],
  pickAnno: ["const pick = (e: string) => e === 'pin' ? pins : e === 'zone' ? zones : e === 'route' ? routes : annos", "const pick = (e: string) => e === 'pin' ? pins : e === 'zone' ? zones : annos"],
  gateRead: ["app.get('/api/r2/object/*', async (c) => {\n  if (!c.env.R2) return c.json({ error: 'R2 미구성' }, 501)\n  // [보안] 로그인 필수", "app.get('/api/r2/object/*', async (c) => {\n  if (!c.env.R2) return c.json({ error: 'R2 미구성' }, 501)\n  if (true) return c.json({ error: 'forbidden' }, 403)\n  // [보안] 로그인 필수"],
};
const MUT = process.env.MUT || "";
let entry = path.join(ROOT, "src/index.tsx");
if (MUT) {
  const m = MUTS[MUT];
  if (!m) { console.log("unknown MUT " + MUT); process.exit(3); }
  const dir = path.join(ROOT, ".tmp", "p156src-" + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, "src"), dir, { recursive: true });
  const f = path.join(dir, "index.tsx");
  const s = fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  if (!s.includes(m[0])) { console.log("MUT " + MUT + " 치환 대상 없음"); process.exit(3); }
  fs.writeFileSync(f, s.replace(m[0], m[1]));
  entry = f;
  console.log("[MUT=" + MUT + "]");
}

const SECRET = "p156-signing-secret-0123456789abcdef";
const SUPER = "sup156@seastar.test";
const workerOut = path.join(os.tmpdir(), "p156-worker-" + process.pid + ".mjs");
await esbuild.build({
  entryPoints: [entry], bundle: true, format: "esm", platform: "neutral",
  outfile: workerOut, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
  conditions: ["workerd", "worker", "browser"],
});
const mf = new Miniflare({
  modules: true, scriptPath: workerOut, d1Databases: { DB: "p156-" + Date.now() }, r2Buckets: { R2: "p156r2-" + Date.now() },
  bindings: { DEMO_LOGIN: "0", AUTO_ENTRY_SECRET: SECRET, SUPER_ADMIN_EMAIL: SUPER, SUPER_ADMIN_EMAILS: SUPER },
  compatibilityDate: "2025-01-01",
});
const BASE = "http://p156.test";
const db = await mf.getD1Database("DB");
for (const f of fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()) {
  for (const st of rd("migrations/" + f).replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean)) await db.exec(st);
}
const run = (q, a = []) => db.prepare(q).bind(...a).run();
const first = (q, a = []) => db.prepare(q).bind(...a).first();

const U = { o: "owner156@seastar.test", v: "viewer156@seastar.test" };
const TOK = {};
for (const k of Object.keys(U)) {
  const now = Date.now();
  if (k !== "v") await run("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, 'seed', ?, ?, 0)", [U[k], k, now, now]);
  await run("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, 'x', 'h', 's', 1, ?, ?, 0)", [U[k], k, now, now]);
  TOK[k] = "local-p156-" + k + "-" + crypto.randomBytes(6).toString("hex");
  await run("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOK[k], U[k], now, now + 8.64e7]);
}
const api = async (tok, method, url, body, extra) => {
  const headers = Object.assign({ "Content-Type": "application/json" }, tok ? { Authorization: "Bearer " + tok } : {}, extra || {});
  const r = await mf.dispatchFetch(BASE + url, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text, headers: r.headers };
};
const upload = async (tok, buf, ct) => {
  const r = await mf.dispatchFetch(BASE + "/api/r2/upload", { method: "PUT", headers: { Authorization: "Bearer " + tok, "Content-Type": ct || "video/mp4" }, body: buf });
  const j = await r.json().catch(() => null);
  return { status: r.status, j };
};

/* ── 시드: 프로젝트(O 소유) + 배포본(동선 1건) + deck ── */
const P = "prj_p156_a";
const D = "dep_p156_a";
const now = Date.now();
await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted, published, published_by) VALUES (?, 'P156', '', ?, ?, ?, 0, 0, NULL)", [P, U.o, now, now]);
const route0 = { id: "r0", page: 1, points: [{ x: 10, y: 10 }, { x: 50, y: 50 }], videoId: null, name: "순찰로", ts: now };
await run("INSERT INTO deployments (id, title, file_name, pins, zones, annotations, routes, created_at, updated_at, deleted, version, project_id, tenant_id) VALUES (?, 'T', 'a.pdf', '[]', '[]', '[]', ?, ?, ?, 0, 0, ?, 'tnt_default')",
  [D, JSON.stringify([route0]), now, now, P]);
await run("INSERT INTO decks (id, project_id, name, deployment_id, created_at, updated_at, deleted) VALUES ('dk_p156_a', ?, 'dk', ?, ?, ?, 0)", [P, D, now, now]);
// [T5] 뷰어는 "그 프로젝트의 권한받은 뷰어"(project_members role=viewer) — 읽기는 되고(재생) 쓰기(ops)는 requireDesigner 에 막힌다.
await run("INSERT INTO project_members (project_id, email, role, granted_by, created_at) VALUES (?, ?, 'viewer', ?, ?)", [P, U.v, U.o, now]);

/* ══ T1 R2 Range: 206 + 바이트 정확성 ══ */
console.log("\n[T1 R2 Range — 206 Partial Content + 바이트 정확성]");
{
  const buf = Buffer.alloc(200 * 1024);
  for (let i = 0; i < buf.length; i++) buf[i] = i % 256;
  const up = await upload(TOK.o, buf, "video/mp4");
  ok(up.status === 200, "T1a 업로드 200", up.status);
  ok(up.j && /\.mp4$/.test(up.j.key), "T1b 비디오 .mp4 확장자", up.j && up.j.key);
  const key = up.j.key;

  const full = await mf.dispatchFetch(BASE + "/api/r2/object/" + key, { headers: { Authorization: "Bearer " + TOK.o } });
  ok(full.status === 200, "T1c 전체 GET(Range 없음) → 200", full.status);
  ok(Number(full.headers.get("content-length")) === buf.length, "T1d 전체 GET content-length 일치");

  const rr = await mf.dispatchFetch(BASE + "/api/r2/object/" + key, { headers: { Authorization: "Bearer " + TOK.o, Range: "bytes=1000-1099" } });
  ok(rr.status === 206, "T1e Range 요청 → 206", rr.status);
  ok(rr.headers.get("accept-ranges") === "bytes", "T1f Accept-Ranges: bytes");
  ok(rr.headers.get("content-range") === `bytes 1000-1099/${buf.length}`, "T1g Content-Range 정확", rr.headers.get("content-range"));
  const body = Buffer.from(await rr.arrayBuffer());
  ok(body.length === 100, "T1h Range 응답 바이트 길이 100", body.length);
  ok(Buffer.compare(body, buf.subarray(1000, 1100)) === 0, "T1i 바이트 정확성(요청한 구간과 동일)");
}

/* ══ T2 업로드 크기 상한 ══ */
console.log("\n[T2 업로드 크기 상한 — 30MB 성공 / 33MB 413]");
{
  const ok30 = await upload(TOK.o, Buffer.alloc(30 * 1024 * 1024, 1), "video/mp4");
  ok(ok30.status === 200, "T2a 30MB 업로드 → 200", ok30.status);
  const bad33 = await upload(TOK.o, Buffer.alloc(33 * 1024 * 1024, 1), "video/mp4");
  ok(bad33.status === 413, "T2b 33MB 업로드 → 413", bad33.status);
}

/* ══ T3 routes CRUD — ops upsert/delete + 지속성 ══ */
console.log("\n[T3 routes: ops upsert → tombstone 삭제 → 리로드 지속성]");
{
  const opUp = await api(TOK.o, "POST", `/tables/deployments/${D}/ops`, {
    ops: [{ opId: "op-r2-" + Date.now(), entity: "route", action: "upsert", id: "r1", data: { page: 1, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], videoId: "assets/y.mp4", name: "R1" }, ts: 1000 }],
  });
  ok(opUp.status === 200, "T3a ops upsert → 200", opUp.status);
  const rsAfterUp = JSON.parse(opUp.j.current.routes || "[]");
  ok(rsAfterUp.length === 2, "T3b upsert 후 routes 2건(기존 r0 + 신규 r1)", rsAfterUp.length);

  const reload = await api(TOK.o, "GET", "/tables/deployments/" + D);
  ok(JSON.parse(reload.j.routes).length === 2, "T3c 리로드 후에도 routes 2건 유지", reload.j.routes);

  const opDel = await api(TOK.o, "POST", `/tables/deployments/${D}/ops`, {
    ops: [{ opId: "op-del-" + Date.now(), entity: "route", action: "delete", id: "r0", ts: Date.now() + 999999 }],
  });
  const rsAfterDel = JSON.parse(opDel.j.current.routes);
  const r0 = rsAfterDel.find((r) => r.id === "r0");
  ok(r0 && r0._deleted === true, "T3d delete → tombstone(_deleted) 보존", r0);
  const r1 = rsAfterDel.find((r) => r.id === "r1");
  ok(r1 && !r1._deleted, "T3e r1 은 삭제되지 않고 유지", r1);
}

/* ══ T4 오프라인 병합 — pins만 PATCH 해도 routes 유실 없음 ══ */
console.log("\n[T4 PATCH(pins만) → routes 유실 0]");
{
  const before = await api(TOK.o, "GET", "/tables/deployments/" + D);
  const patch = await api(TOK.o, "PATCH", "/tables/deployments/" + D, { base_version: before.j.version, pins: JSON.stringify([{ id: "p1", x: 5, y: 5, page: 1 }]) });
  ok(patch.status === 200, "T4a PATCH 200", patch.status);
  ok(JSON.parse(patch.j.pins).length === 1, "T4b pins 반영", patch.j.pins);
  ok(JSON.parse(patch.j.routes).length === 2, "T4c 🔴 pins만 보내도 routes 는 유실되지 않음(머지)", patch.j.routes);
}

/* ══ T5 뷰어 — ops(편집) 403 · 단건 GET(재생) 200 ══ */
console.log("\n[T5 뷰어(비디자이너): ops 403 · GET 200]");
{
  const vOps = await api(TOK.v, "POST", `/tables/deployments/${D}/ops`, {
    ops: [{ opId: "op-v-" + Date.now(), entity: "route", action: "upsert", id: "rv2", data: { page: 1, points: [{ x: 9, y: 9 }, { x: 8, y: 8 }] }, ts: 1 }],
  });
  ok(vOps.status === 403, "T5a 뷰어 ops(쓰기) → 403(편집 금지)", vOps.status);
  const vGet = await api(TOK.v, "GET", "/tables/deployments/" + D);
  ok(vGet.status === 200, "T5b 뷰어 단건 GET(재생용) → 200", vGet.status);
}

/* ══ T6 열람 링크(/v/, auto-entry, 360 전용) — routes 포함 재생 · 편집 0 ══ */
console.log("\n[T6 열람 링크 — GET 에 routes 포함(재생 가능) · ops 403(편집 0)]");
{
  // auto-entry(lk) 는 "배포(published) + 그 스냅샷에 이 배포본이 있을 때"만 유효(viewLinkScope) — 먼저 1회 배포.
  const pre = await api(TOK.o, "POST", `/api/projects/${P}/publish`, {});
  ok(pre.status === 200, "T6-pre 사전 배포(링크 유효화) 200", pre.status, pre.j);
  // [WO 20261016-viewmail] 새 링크 = 이메일 인증 기본 ON → 이 블록은 무인증 링크 재생 계약 → 옵션 OFF 명시(assertion 불변 · 이메일 경로는 p163)
  const vaOff = await api(TOK.o, "PUT", `/api/projects/${P}/viewer-access`, { email_auth: false });
  ok(vaOff.status === 200, "T6-pre2 이메일 인증 OFF(무인증 링크 호환 모드) 200", vaOff.status);
  const l = await api(TOK.o, "POST", "/api/view-links", { dep_id: D, mode: "360" });
  ok(l.status === 200 && l.j && l.j.id, "T6a 링크 발급 200", l.status);
  const m = await api(null, "POST", "/api/auth/auto-entry", { kind: "viewer", lk: l.j.id });
  ok(m.status === 200 && m.j && m.j.token, "T6b auto-entry → 200 토큰", m.status);
  const g = await api(m.j.token, "GET", "/tables/deployments/" + D);
  ok(g.status === 200, "T6c 링크 세션 GET → 200", g.status);
  const linkRoutes = JSON.parse(g.j.routes || "[]");
  ok(Array.isArray(linkRoutes) && linkRoutes.length === 2, "T6d 🔴 링크 응답에 routes 포함(재생 가능)", linkRoutes);
  const edit = await api(m.j.token, "POST", `/tables/deployments/${D}/ops`, {
    ops: [{ opId: "op-link-" + Date.now(), entity: "route", action: "upsert", id: "rlink", data: { page: 1, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }, ts: 1 }],
  });
  ok(edit.status === 403, "T6e 🔴 링크 세션은 ops(편집) 금지 — 403", edit.status);
}

/* ══ T7 배포(publish) → pub_snapshots 동결에 routes 포함 ══ */
console.log("\n[T7 배포(publish) → pub_snapshots 에 routes 동결]");
{
  const snapRow = await first("SELECT row_json FROM pub_snapshot_deps WHERE project_id = ? AND dep_id = ?", [P, D]);
  ok(!!snapRow, "T7b pub_snapshot_deps 행 존재", snapRow);
  const snapDep = snapRow ? JSON.parse(snapRow.row_json) : null;
  const snapRoutes = snapDep ? JSON.parse(snapDep.routes || "[]") : [];
  ok(snapRoutes.length === 2, "T7c 🔴 스냅샷 row_json 에 routes 2건 동결", snapRoutes.length);

  // 재배포 — 동선 하나 더 추가 후 다시 publish → 스냅샷이 최신으로 갱신되는지
  await api(TOK.o, "POST", `/tables/deployments/${D}/ops`, {
    ops: [{ opId: "op-r3-" + Date.now(), entity: "route", action: "upsert", id: "r3", data: { page: 1, points: [{ x: 3, y: 3 }, { x: 4, y: 4 }] }, ts: 3000 }],
  });
  const pub2 = await api(TOK.o, "POST", `/api/projects/${P}/publish`, {});
  ok(pub2.status === 200, "T7d 재배포 200", pub2.status);
  const snapRow2 = await first("SELECT row_json FROM pub_snapshot_deps WHERE project_id = ? AND dep_id = ?", [P, D]);
  const snapRoutes2 = JSON.parse(JSON.parse(snapRow2.row_json).routes || "[]");
  ok(snapRoutes2.length === 3, "T7e 🔴 재배포 스냅샷에 새 동선(r3) 반영", snapRoutes2.length);
}

/* ══ T8 개정(revision) 적용 — carryRoutes 로 좌표 즉시 이월 ══ */
console.log("\n[T8 도면 개정 적용 — 동선 점 좌표 아핀 이월]");
{
  const cur = await api(TOK.o, "GET", "/tables/deployments/" + D);
  const before = JSON.parse(cur.j.routes).find((r) => r.id === "r1");
  ok(!!before, "T8a 이월 대상 동선(r1) 존재", before);
  const t = { a: 1, b: 0, c: 0, d: 1, e: 10, f: 5 }; // x+10, y+5 평행이동
  const rev = await api(TOK.o, "POST", `/api/deployments/${D}/revisions`, {
    base_version: cur.j.version, rev_label: "Rev.A", pages_data: JSON.stringify(["/api/r2/object/assets/fake-page.png"]), transform: t,
  });
  ok(rev.status === 200, "T8b 개정 적용 → 200", rev.status, rev.j);
  const after = await api(TOK.o, "GET", "/tables/deployments/" + D);
  const r1After = JSON.parse(after.j.routes).find((r) => r.id === "r1");
  ok(r1After && Math.abs(r1After.points[0].x - (before.points[0].x + 10)) < 0.01 && Math.abs(r1After.points[0].y - (before.points[0].y + 5)) < 0.01,
    "T8c 🔴 개정 적용 즉시 동선 점 좌표가 아핀 이월됨(carryRoutes)", { before: before.points[0], after: r1After && r1After.points[0] });
}

/* ══ T9 R2 읽기 권한 — routes 의 videoId 도 그 배포본 멤버만 ══ */
console.log("\n[T9 R2 읽기 권한 — routes.videoId 참조 배포본 멤버만 읽기 허용]");
{
  const up = await upload(TOK.o, Buffer.from("route-video-bytes"), "video/mp4");
  const vidKey = up.j.key;
  // 아직 어떤 배포본에도 연결 안 됨 — 업로더 본인만 읽기 가능(저장 전 미리보기 규칙)
  const beforeLink = await api(TOK.v, "GET", "/api/r2/object/" + vidKey);
  ok(beforeLink.status === 403, "T9a 연결 전: 업로더 아닌 뷰어 → 403", beforeLink.status);
  // 동선에 연결(routes.videoId) → 그 배포본을 읽을 수 있는 멤버(뷰어 포함)도 읽기 허용
  await api(TOK.o, "POST", `/tables/deployments/${D}/ops`, {
    ops: [{ opId: "op-vid-" + Date.now(), entity: "route", action: "upsert", id: "r1", data: { page: 1, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], videoId: vidKey }, ts: 9000 }],
  });
  const afterLink = await api(TOK.v, "GET", "/api/r2/object/" + vidKey);
  ok(afterLink.status === 200, "T9b 🔴 동선에 연결된 뒤에는 그 배포본 멤버(뷰어)도 읽기 허용(재생)", afterLink.status);
}

console.log(failed === 0 ? "\nALL PASS" : "\n" + failed + " FAILED");
clearTimeout(watchdog);
process.exit(failed === 0 ? 0 : 1);
