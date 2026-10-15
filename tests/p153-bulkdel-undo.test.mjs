/**
 * p153 — 구역/선택 일괄 삭제 + 되돌리기(WO 20261015-bulkdel-undo)
 * (프레임워크 0 · 실행: node tests/p153-bulkdel-undo.test.mjs)
 *
 * 마스터(음성) "핀 일괄 삭제 기능도 구현하고 되돌리기도 기능도 구현해. 삭제했던 걸 다시 되돌리고
 *   싶을 때 되돌릴 수 있게끔." — 서버 = src/index.tsx 실 번들 → Miniflare(workerd) + 실 D1(migrations 전부). 목 0.
 *
 *  A 구역 범위 삭제: 소유자 200 · 기록 1건(scope=zone) · tombstone · 노트 불변
 *  B 11분 뒤(30일 창 안) 되돌리기 성공 — 핀 원상 · 사진 연결(imageUrl) 복원 · 노트 그대로
 *  C 선택 범위 삭제 + 되돌리기(scope=selection)
 *  D 재복원 거부(멱등) — 두 번째 되돌리기 = restored 0
 *  E 열람자 403(일괄삭제·삭제기록 둘 다) · 디자이너(비소유자) 403
 *  F 별칭 구역(벡터 복사) 범위 삭제 → 원본(home) 에 기록·tombstone, 구역 자기 pins 불변 → 되돌리기 → 원본 복원
 *  G 삭제 기록 목록 — scope_label·pin_count·status(가능/복원됨) · batch 단위 집계
 *  H base_version 충돌 → 409, 0건
 *
 * 뮤테이션: MUT=<이름> 이면 src 사본에 치환해 빌드(치환 대상 없음 = EXIT 3). 각 뮤테이션은 EXIT=1 이어야 한다.
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
const ok = (cond, label, d) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (!cond && d !== undefined ? " :: " + JSON.stringify(d).slice(0, 400) : "")); if (!cond) failed++; };
const watchdog = setTimeout(() => { console.log("\nWATCHDOG — 180s 초과 → FAIL"); process.exit(1); }, 180000);

/* ── 뮤테이션(src 사본) ── */
const MUTS = {
  // 스냅샷 기록 제거 — bulk-delete 의 INSERT 조건에 0=1 을 더해 항상 0행(핀은 그래도 지워짐) → undo 가 404(배치 없음)
  snapshot: [
    "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM deployments WHERE id = ? AND deleted = 0 AND version = ?)`\n    ).bind(batch, targetId, pid, user.email, JSON.stringify(targets), targets.length, now, scope, scopeLabel, targetId, cur),",
    "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM deployments WHERE id = ? AND deleted = 0 AND version = ?) AND 0=1`\n    ).bind(batch, targetId, pid, user.email, JSON.stringify(targets), targets.length, now, scope, scopeLabel, targetId, cur),",
  ],
  // 되돌리기 기간 제한 복원 — 새 30일 상수를 옛 10분으로 되돌린다
  window: ["const PIN_BULK_UNDO_MS = 30 * 24 * 60 * 60 * 1000", "const PIN_BULK_UNDO_MS = 10 * 60 * 1000"],
  // 재복원 허용 — 이미 복원된 행도 다시 처리(멱등 가드 제거)
  rerestore: [
    "if (row.restored_at != null) { results.push({ id: row.deployment_id, ok: true, restored: 0, already: true }); continue }",
    "if (false) { results.push({ id: row.deployment_id, ok: true, restored: 0, already: true }); continue }",
  ],
};
const MUT = process.env.MUT || "";
let entry = path.join(ROOT, "src/index.tsx");
if (MUT) {
  const m = MUTS[MUT];
  if (!m) { console.log("unknown MUT " + MUT); process.exit(3); }
  const dir = path.join(ROOT, ".tmp", "p153src-" + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, "src"), dir, { recursive: true });
  const f = path.join(dir, "index.tsx");
  const s = fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  if (!s.includes(m[0])) { console.log("MUT " + MUT + " 치환 대상 없음"); process.exit(3); }
  fs.writeFileSync(f, s.replace(m[0], m[1]));
  entry = f;
  console.log("[MUT=" + MUT + "]");
}

const workerOut = path.join(os.tmpdir(), "p153-worker-" + process.pid + ".mjs");
await esbuild.build({
  entryPoints: [entry], bundle: true, format: "esm", platform: "neutral",
  outfile: workerOut, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
  conditions: ["workerd", "worker", "browser"],
});
const mf = new Miniflare({
  modules: true, scriptPath: workerOut, d1Databases: { DB: "p153-" + Date.now() }, r2Buckets: { R2: "p153r2-" + Date.now() },
  bindings: { DEMO_LOGIN: "0", SUPER_ADMIN_EMAIL: "sup@seastar.test", SUPER_ADMIN_EMAILS: "sup@seastar.test" },
  compatibilityDate: "2025-01-01",
});
const BASE = "http://p153.test";
const db = await mf.getD1Database("DB");
for (const f of fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()) {
  for (const st of rd("migrations/" + f).replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean)) await db.exec(st);
}
const run = (q, a = []) => db.prepare(q).bind(...a).run();
const first = (q, a = []) => db.prepare(q).bind(...a).first();

const PW = { o: "owner-pass-1234", m: "member-pass-1234", v: "viewer-pass-1234" };
const U = { o: "owner@seastar.test", m: "member@seastar.test", v: "viewer@seastar.test" };
const TOK = {};
const pbkdf2 = (pw, saltHex) => crypto.pbkdf2Sync(pw, Buffer.from(saltHex, "hex"), 100000, 32, "sha256").toString("hex");
for (const k of Object.keys(U)) {
  const now = Date.now(), salt = crypto.randomBytes(16).toString("hex");
  if (k !== "v") await run("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, 'seed', ?, ?, 0)", [U[k], k, now, now]);
  await run("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, 'seastar.test', ?, ?, 1, ?, ?, 0)", [U[k], k, pbkdf2(PW[k], salt), salt, now, now]);
  TOK[k] = "local-p153-" + k + "-" + crypto.randomBytes(6).toString("hex");
  await run("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOK[k], U[k], now, now + 8.64e7]);
}
const api = async (tok, method, url, body, extra) => {
  const headers = Object.assign({ "Content-Type": "application/json" }, tok ? { Authorization: "Bearer " + tok } : {}, extra || {});
  const r = await mf.dispatchFetch(BASE + url, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j: j || {} };
};
const rx = async (k) => (await api(TOK[k], "POST", "/api/auth/reauth", { password: PW[k] })).j.token;

/* ── 시드 ── */
const PID = "prj_p153", NAME = "P153 선박";
const MAIN = "dep_p153_main", VEC = "dep_p153_vec";
const BOX = { x: 20, y: 20, w: 40, h: 30 };   // 원본 1페이지 % 상자
const PINS_MAIN = [
  { id: "z1", x: 30, y: 25, page: 1, label: "1", checkboard: true },                 // 구역 범위(상자 안)
  { id: "z2", x: 40, y: 30, page: 1, label: "2", checkboard: true, imageUrl: "/api/r2/object/media/p153/a.jpg" }, // 구역 범위(상자 안) + 사진 연결
  { id: "s1", x: 5, y: 5, page: 1, label: "3", checkboard: true },                   // 선택 범위(상자 밖)
  { id: "s2", x: 7, y: 7, page: 1, label: "4", checkboard: true },                   // 선택 범위(상자 밖)
  { id: "keep", x: 90, y: 90, page: 1, label: "5", checkboard: true },               // 건드리지 않음
];
const seed = async () => {
  const now = Date.now();
  await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, ?, '', ?, ?, ?, 0)", [PID, NAME, U.o, now, now]);
  await run("INSERT INTO project_members (project_id, email, role, granted_by, created_at) VALUES (?, ?, 'designer', ?, ?)", [PID, U.m, U.o, now]);
  await run("INSERT INTO deployments (id, title, file_name, pins, zones, annotations, created_at, updated_at, deleted, version, project_id) VALUES (?, ?, ?, ?, '[]', '[]', ?, ?, 0, 3, ?)",
    [MAIN, "T-main", "main.pdf", JSON.stringify(PINS_MAIN), now, now, PID]);
  await run("INSERT INTO deployments (id, title, file_name, pins, zones, annotations, created_at, updated_at, deleted, version, project_id) VALUES (?, ?, ?, '[]', '[]', '[]', ?, ?, 0, 7, ?)",
    [VEC, "T-vec", "vec.pdf", now, now, PID]);
  await run("INSERT INTO decks (id, project_id, name, deployment_id, page, crop, src_dep_id, src_page, src_crop, created_at, updated_at, deleted) VALUES ('dk_main', ?, 'dk_main', ?, 1, NULL, NULL, NULL, NULL, ?, ?, 0)", [PID, MAIN, now, now]);
  await run("INSERT INTO decks (id, project_id, name, deployment_id, page, crop, src_dep_id, src_page, src_crop, created_at, updated_at, deleted) VALUES ('dk_vec', ?, 'dk_vec', ?, 1, NULL, ?, 1, ?, ?, ?, 0)", [PID, VEC, MAIN, JSON.stringify(BOX), now, now]);
  await run("INSERT INTO pin_notes (id, deployment_id, pin_id, pin_label, body, status, author, created_at, updated_at, deleted) VALUES ('note_z1', ?, 'z1', '1', '누수', 'open', 'o', ?, ?, 0)", [MAIN, now, now]);
};
await seed();
const depRow = (id) => first("SELECT pins, version FROM deployments WHERE id = ?", [id]);
const pinsOf = async (id) => JSON.parse((await depRow(id)).pins || "[]");
const liveOf = async (id) => (await pinsOf(id)).filter((p) => !p._deleted);
const liveIds = async (id) => (await liveOf(id)).map((p) => p.id).sort().join(",");
const histUrl = "/api/projects/" + PID + "/pins/purge/history";
const bulkUrl = "/api/projects/" + PID + "/pins/bulk-delete";
/** 시간 흐름 시뮬레이션 — pin_bulk_deletes.created_at 과 그 핀의 tombstone.ts 를 함께 과거로 당긴다
 *  (undo 라우트는 두 값을 비교해 "이 batch 이후 다시 지워졌나" 를 판정하므로 둘이 같이 가야 한다). */
const backdate = async (batch, depId, ms) => {
  const past = Date.now() - ms;
  await run("UPDATE pin_bulk_deletes SET created_at = ? WHERE batch_id = ? AND deployment_id = ?", [past, batch, depId]);
  const pins = await pinsOf(depId);
  const next = pins.map((p) => (p && p._deleted) ? Object.assign({}, p, { ts: past }) : p);
  await run("UPDATE deployments SET pins = ? WHERE id = ?", [JSON.stringify(next), depId]);
};

console.log("\n[A. 구역 범위 삭제 — scope=zone]");
let batchA = null;
{
  const mainVer = (await depRow(MAIN)).version;
  const before = await liveIds(MAIN);
  ok(before === "z1,z2,s1,s2,keep".split(",").sort().join(","), "A0 시드 핀 5개 생존", before);
  const rxo = await rx("o");
  const r = await api(TOK.o, "POST", bulkUrl, { deployment_id: MAIN, ids: ["z1", "z2"], scope: "zone", scope_label: "구역 'Zone-1'", base_version: mainVer }, { "X-Reauth": rxo });
  ok(r.status === 200 && r.j.ok === true && r.j.deleted === 2, "A1 200, 삭제 2건", r.j);
  batchA = r.j.batch;
  ok(typeof batchA === "string" && r.j.undo_until > Date.now() + 29 * 24 * 60 * 60000, "A2 batch · undo_until ≈ 30일", r.j.undo_until);
  ok((await liveIds(MAIN)) === "keep,s1,s2".split(",").sort().join(","), "A3 z1,z2 만 tombstone(나머지 생존)", await liveIds(MAIN));
  const row = await first("SELECT scope, scope_label, pin_count FROM pin_bulk_deletes WHERE batch_id = ? AND deployment_id = ?", [batchA, MAIN]);
  ok(row && row.scope === "zone" && row.scope_label === "구역 'Zone-1'" && row.pin_count === 2, "A4 pin_bulk_deletes 기록 scope=zone", row);
  const note = await first("SELECT deleted, body FROM pin_notes WHERE id = 'note_z1'");
  ok(note && note.deleted === 0 && note.body === "누수", "A5 pin_notes 불변(z1 핀 지워도 노트는 그대로)", note);
}

console.log("\n[B. 11분 뒤(30일 창 안) 되돌리기 — 핀 원상 · 사진 연결 복원]");
{
  await backdate(batchA, MAIN, 11 * 60000);
  const u = await api(TOK.o, "POST", "/api/projects/" + PID + "/pins/purge/" + batchA + "/undo");
  ok(u.status === 200 && u.j.restored === 2, "B1 11분 뒤에도 복원 성공(30일 창)", u.j);
  const live = await liveOf(MAIN);
  const z2 = live.find((p) => p.id === "z2");
  ok((await liveIds(MAIN)) === "keep,s1,s2,z1,z2".split(",").sort().join(","), "B2 z1,z2 원상 복귀", await liveIds(MAIN));
  ok(z2 && z2.imageUrl === "/api/r2/object/media/p153/a.jpg", "B3 사진 연결(imageUrl) 복원", z2);
  const note = await first("SELECT deleted FROM pin_notes WHERE id = 'note_z1'");
  ok(note && note.deleted === 0, "B4 노트 여전히 불변");
}

console.log("\n[C. 선택 범위 삭제(scope=selection) + 되돌리기]");
let batchC = null;
{
  const mainVer = (await depRow(MAIN)).version;
  const r = await api(TOK.o, "POST", bulkUrl, { deployment_id: MAIN, ids: ["s1", "s2"], scope: "selection", base_version: mainVer }, { "X-Reauth": await rx("o") });
  ok(r.status === 200 && r.j.deleted === 2, "C1 선택 삭제 200, 2건", r.j);
  batchC = r.j.batch;
  const row = await first("SELECT scope, scope_label FROM pin_bulk_deletes WHERE batch_id = ? AND deployment_id = ?", [batchC, MAIN]);
  ok(row && row.scope === "selection" && (row.scope_label == null), "C2 기록 scope=selection, scope_label 없음", row);
  ok((await liveIds(MAIN)) === "keep,z1,z2".split(",").sort().join(","), "C3 s1,s2 tombstone", await liveIds(MAIN));
  const u = await api(TOK.o, "POST", "/api/projects/" + PID + "/pins/purge/" + batchC + "/undo");
  ok(u.status === 200 && u.j.restored === 2 && (await liveIds(MAIN)) === "keep,s1,s2,z1,z2".split(",").sort().join(","), "C4 되돌리기 → 원상", u.j);
}

console.log("\n[D. 재복원 거부(멱등) — restored 0 뿐 아니라 배포본 version 도 그대로(불필요한 재쓰기 0)]");
{
  const verBefore = (await depRow(MAIN)).version;
  const u2 = await api(TOK.o, "POST", "/api/projects/" + PID + "/pins/purge/" + batchC + "/undo");
  ok(u2.status === 200 && u2.j.restored === 0, "D1 두 번째 되돌리기 → restored 0(거부·멱등)", u2.j);
  const u3 = await api(TOK.o, "POST", "/api/projects/" + PID + "/pins/purge/" + batchA + "/undo");
  ok(u3.status === 200 && u3.j.restored === 0, "D2 batchA 도 재복원 0건", u3.j);
  // 🔴 restored_at 멱등 가드가 없으면 put=0 이어도 UPDATE deployments 가 다시 실행돼 version 이 헛되이 또 올라간다
  //   (남이 그 사이 저장한 base_version 이 억울하게 409 로 튕기는 숨은 손실 — 뮤테이션 rerestore 가 이 값으로 잡힌다).
  ok((await depRow(MAIN)).version === verBefore, "D3 재복원 호출로 version 이 또 올라가지 않음(헛된 재쓰기 0)", { before: verBefore, after: (await depRow(MAIN)).version });
}

console.log("\n[E. 권한 — 열람자 403 · 비소유자 디자이너 403]");
{
  const mainVer = (await depRow(MAIN)).version;
  const ev = await api(TOK.v, "POST", bulkUrl, { deployment_id: MAIN, ids: ["keep"], scope: "selection", base_version: mainVer }, { "X-Reauth": "x" });
  ok(ev.status === 403, "E1 열람자 일괄삭제 → 403", ev.status);
  const evh = await api(TOK.v, "GET", histUrl);
  ok(evh.status === 403, "E2 열람자 삭제기록 → 403", evh.status);
  const em = await api(TOK.m, "POST", bulkUrl, { deployment_id: MAIN, ids: ["keep"], scope: "selection", base_version: mainVer }, { "X-Reauth": await rx("m") });
  ok(em.status === 403, "E3 비소유자 디자이너(멤버) 일괄삭제 → 403", em.status);
  ok((await liveIds(MAIN)) === "keep,s1,s2,z1,z2".split(",").sort().join(","), "E4 권한 거부 — 핀 불변");
}

console.log("\n[F. 별칭 구역(벡터 복사) 범위 삭제 — 원본에 기록/tombstone, 되돌리기도 원본]");
let batchF = null;
{
  const mainBefore = await depRow(MAIN);
  const vecBefore = await depRow(VEC);
  const aliasBaseVersion = 1_000_000_000 + Number(mainBefore.version);   // aliasVersion 오프셋(서버 regionAlias.ALIAS_VERSION_OFFSET)
  const r = await api(TOK.o, "POST", bulkUrl, { deployment_id: VEC, ids: ["z1", "z2"], scope: "zone", scope_label: "구역 'dk_vec'", base_version: aliasBaseVersion }, { "X-Reauth": await rx("o") });
  ok(r.status === 200 && r.j.deleted === 2, "F1 별칭 구역 범위 삭제 200, 2건", r.j);
  batchF = r.j.batch;
  ok((await liveIds(MAIN)) === "keep,s1,s2".split(",").sort().join(","), "F2 삭제가 원본(MAIN)에 반영", await liveIds(MAIN));
  const row = await first("SELECT deployment_id FROM pin_bulk_deletes WHERE batch_id = ?", [batchF]);
  ok(row && row.deployment_id === MAIN, "F3 기록도 원본 배포본 id 로 저장(home)", row);
  ok((await depRow(VEC)).pins === vecBefore.pins, "F4 구역(VEC) 자기 pins 컬럼은 손대지 않음(원래 그대로)", { before: vecBefore.pins, after: (await depRow(VEC)).pins });
  const u = await api(TOK.o, "POST", "/api/projects/" + PID + "/pins/purge/" + batchF + "/undo");
  ok(u.status === 200 && u.j.restored === 2, "F5 되돌리기 → 원본에 복원", u.j);
  ok((await liveIds(MAIN)) === "keep,s1,s2,z1,z2".split(",").sort().join(","), "F6 원본 핀 원상", await liveIds(MAIN));
}

console.log("\n[G. 삭제 기록 목록]");
{
  const h = await api(TOK.o, "GET", histUrl);
  ok(h.status === 200 && h.j.ready === true, "G1 200, ready", h.status);
  const byBatch = Object.fromEntries((h.j.batches || []).map((b) => [b.batch, b]));
  ok(byBatch[batchA] && byBatch[batchA].scope === "zone" && byBatch[batchA].scope_label === "구역 'Zone-1'" && byBatch[batchA].pin_count === 2 && byBatch[batchA].status === "restored",
    "G2 batchA — zone · scope_label · pin_count 2 · restored", byBatch[batchA]);
  ok(byBatch[batchC] && byBatch[batchC].scope === "selection" && byBatch[batchC].status === "restored", "G3 batchC — selection · restored", byBatch[batchC]);
  ok(byBatch[batchF] && byBatch[batchF].scope === "zone" && byBatch[batchF].status === "restored", "G4 batchF(별칭) — zone · restored", byBatch[batchF]);
  ok((h.j.batches || []).length === 3, "G5 총 3개 배치(A·C·F)", (h.j.batches || []).length);
}

console.log("\n[H. base_version 충돌]");
{
  const mainVer = (await depRow(MAIN)).version;
  const r = await api(TOK.o, "POST", bulkUrl, { deployment_id: MAIN, ids: ["keep"], scope: "selection", base_version: mainVer + 99 }, { "X-Reauth": await rx("o") });
  ok(r.status === 409 && (await liveIds(MAIN)) === "keep,s1,s2,z1,z2".split(",").sort().join(","), "H1 버전 불일치 → 409, 0건", r);
}

clearTimeout(watchdog);
await mf.dispose();
try { fs.unlinkSync(workerOut); } catch {}
console.log("\n" + (failed ? "FAIL " + failed : "ALL PASS"));
process.exit(failed ? 1 : 0);
