/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p132-pin-purge.test.mjs)
 *
 * WO 20261008-pinpurge — 마스터: "관리자는 모든 핀 삭제 기능도 구현해"
 * 서버 = src/index.tsx 실 번들 → Miniflare(workerd) + 실 D1(migrations 전부) + 실 R2. 목 0.
 *
 *  A 미리보기: 디자이너 403 · 열람자 403 · 소유자/super 200 · 구역 N · 핀 M(CHECKER/360) · 사진 연결 · 타 프로젝트 제외
 *  B 확인: 디자이너 403 · 이름 불일치 → 0건 · 재인증 없음/위조 → 0건
 *  C 409 부분 실패: 미리보기 뒤 남이 저장한 배포본만 409, 나머지는 tombstone — 배포본별 보고
 *  D tombstone: 하드 삭제 0 · 기존 tombstone 보존 · zones/annotations/pin_notes 불변 · R2 객체 불변
 *  E 감사 기록: activity_log pins.purge(배포본별 수·실행자·undo:false) / pins.purge.undo(undo:true)
 *  F 되돌리기: 디자이너 403 · 소유자 → 복원 수 = 삭제 수 · 핀 원상 · 두 번째 되돌리기 0
 *  G 다중 배포본 전부(메인·벡터 복사·레거시 구역 연결) · tombstone 이 전체 저장으로 사라져도 스냅샷으로 복원
 *  H 10분 경과 → 410, 핀 그대로 삭제 상태
 *  I 마이그레이션 미적용(테이블 없음) → 503, 0건
 *
 * 뮤테이션: MUT=<이름> 이면 src 사본에 치환을 적용해 빌드한다(치환 실패 = EXIT 3). 각 뮤테이션은 EXIT=1 이어야 한다.
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
const watchdog = setTimeout(() => { console.log("\nWATCHDOG — 180s 초과 → FAIL"); process.exit(1); }, 180000);

/* ── 뮤테이션(src 사본) ── */
const MUTS = {
  perm:     ["if (!canManageMembersOf(c, user, proj.owner)) return { res:", "if (false) return { res:"],
  name:     ["if (String((body && body.confirm_name) || '').trim() !== String(proj.name || '').trim()) {", "if (false) {"],
  reauth:   ["if (!rx || !(await reauthTokenValid(c, rx, user.email))) return c.json({ error: 'reauth required", "if (false) return c.json({ error: 'reauth required"],
  legacy:   ["OR (project_id IS NULL AND (id IN", "OR (0 AND (id IN"],
  r2:       ["results.push({ id: d.id, title, ok: true, status: 200, deleted: live.length, version: cur + 1 })",
             "for (const p of live) { const m = String(p.imageUrl || '').match(/^\\/api\\/r2\\/object\\/(.+)$/); if (m) await c.env.R2.delete(m[1]) } results.push({ id: d.id, title, ok: true, status: 200, deleted: live.length, version: cur + 1 })"],
  lock:     ["if (Number(baseVersions[d.id]) !== cur) {", "if (false) {"],
  undo:     ["if (!now2 || (now2._deleted && Number(now2.ts || 0) <= Number(row.created_at))) put.set(k, sp)", "if (!now2) put.set(k, sp)"],
  window:   ["if (rows.some((r) => now - Number(r.created_at) > PIN_PURGE_UNDO_MS))", "if (false)"],
  table:    ["if (!(await purgeTableReady(c))) return c.json({ error: 'migration 0039_pin_bulk_deletes 미적용 — 삭제하지 않았습니다' }, 503)", ""],
  audit:    ["await logActivity(c, 'pins.purge', {", "if (0) await logActivity(c, 'pins.purge', {"],
  hard:     ["? { id: p.id, _deleted: true, ts: now } : p)", "? null : p).filter(Boolean)"],
};
const MUT = process.env.MUT || "";
let entry = path.join(ROOT, "src/index.tsx");
if (MUT) {
  const m = MUTS[MUT];
  if (!m) { console.log("unknown MUT " + MUT); process.exit(3); }
  const dir = path.join(ROOT, ".tmp", "p132src-" + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, "src"), dir, { recursive: true });
  const f = path.join(dir, "index.tsx");
  const s = fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  if (!s.includes(m[0])) { console.log("MUT " + MUT + " 치환 대상 없음"); process.exit(3); }
  fs.writeFileSync(f, s.replace(m[0], m[1]));
  entry = f;
  console.log("[MUT=" + MUT + "]");
}

const SECRET = "p132-signing-secret-0123456789abcdef";
const SUPER = "sup@seastar.test";
const workerOut = path.join(os.tmpdir(), "p132-worker-" + process.pid + ".mjs");
await esbuild.build({
  entryPoints: [entry], bundle: true, format: "esm", platform: "neutral",
  outfile: workerOut, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
  conditions: ["workerd", "worker", "browser"],
});
const mf = new Miniflare({
  modules: true, scriptPath: workerOut, d1Databases: { DB: "p132-" + Date.now() }, r2Buckets: { R2: "p132r2-" + Date.now() },
  bindings: { DEMO_LOGIN: "0", AUTO_ENTRY_SECRET: SECRET, SUPER_ADMIN_EMAIL: SUPER, SUPER_ADMIN_EMAILS: SUPER },
  compatibilityDate: "2025-01-01",
});
const BASE = "http://p132.test";
const db = await mf.getD1Database("DB");
const r2 = await mf.getR2Bucket("R2");
for (const f of fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()) {
  for (const st of rd("migrations/" + f).replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean)) await db.exec(st);
}
const run = (q, a = []) => db.prepare(q).bind(...a).run();
const first = (q, a = []) => db.prepare(q).bind(...a).first();

const PW = { o: "owner-pass-1234", m: "member-pass-1234", s: "super-pass-1234", v: "viewer-pass-1234" };
const U = { o: "owner@seastar.test", m: "member@seastar.test", s: SUPER, v: "viewer@seastar.test" };
const TOK = {};
const pbkdf2 = (pw, saltHex) => crypto.pbkdf2Sync(pw, Buffer.from(saltHex, "hex"), 100000, 32, "sha256").toString("hex");
for (const k of Object.keys(U)) {
  const now = Date.now(), salt = crypto.randomBytes(16).toString("hex");
  if (k !== "v") await run("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, 'seed', ?, ?, 0)", [U[k], k, now, now]);
  await run("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, 'seastar.test', ?, ?, 1, ?, ?, 0)", [U[k], k, pbkdf2(PW[k], salt), salt, now, now]);
  TOK[k] = "local-p132-" + k + "-" + crypto.randomBytes(6).toString("hex");
  await run("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOK[k], U[k], now, now + 8.64e7]);
}
const api = async (tok, method, url, body, extra) => {
  const headers = Object.assign({ "Content-Type": "application/json" }, tok ? { Authorization: "Bearer " + tok } : {}, extra || {});
  const r = await mf.dispatchFetch(BASE + url, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
};

/* ── 시드: 프로젝트 PID(메인·벡터 복사·레거시 연결 배포본) + 다른 프로젝트 PID2 ── */
const PID = "prj_p132", PID2 = "prj_p132_other", NAME = "P132 선박 A";
const D = { main: "dep_p132_main", vec: "dep_p132_vec", leg: "dep_p132_legacy", other: "dep_p132_other" };
const R2KEY = "media/p132/pano-a.jpg";
const R2BYTES = crypto.randomBytes(2048).toString("base64");   // 문자열 본문(miniflare 프록시가 Buffer 를 직렬화 못 함)
await r2.put(R2KEY, R2BYTES);
const PINS = {
  main: [
    { id: 1, x: 10, y: 10, page: 1, label: "1", checkboard: true },
    { id: 2, x: 20, y: 10, page: 1, label: "2", checkboard: true },
    { id: 3, x: 30, y: 10, page: 1, label: "3", checkboard: true },
    { id: 11, x: 60, y: 60, page: 1, label: "1", imageId: "img_p132_a" },
    { id: 12, x: 70, y: 60, page: 1, label: "2", imageUrl: "/api/r2/object/" + R2KEY, timeline: [{ imageId: "img_old", shotAt: 1 }] },
    { id: 99, _deleted: true, ts: 5 },   // 기존 tombstone — 그대로 남아야 한다
  ],
  vec: [{ id: 21, x: 10, y: 20, page: 1, label: "4", checkboard: true }, { id: 22, x: 15, y: 20, page: 1, label: "5", checkboard: true }],
  leg: [{ id: 31, x: 40, y: 40, page: 1, label: "3", imageUrl: "/api/r2/object/" + R2KEY }],
  other: [{ id: 41, x: 1, y: 1, page: 1, label: "1", checkboard: true }],
};
const ZONES = JSON.stringify([{ id: "z1", type: "rect", x: 1, y: 1, w: 5, h: 5 }]);
const ANNOS = JSON.stringify([{ id: "a1", kind: "pen", page: 1, pts: [[1, 1], [2, 2]] }]);
const seed = async () => {
  const now = Date.now();
  await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, ?, '', ?, ?, ?, 0)", [PID, NAME, U.o, now, now]);
  await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, 'OTHER', '', ?, ?, ?, 0)", [PID2, U.o, now, now]);
  await run("INSERT INTO project_members (project_id, email, role, granted_by, created_at) VALUES (?, ?, 'designer', ?, ?)", [PID, U.m, U.o, now]);
  const dep = (id, pid, pins) => run("INSERT INTO deployments (id, title, file_name, pins, zones, annotations, created_at, updated_at, deleted, version, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 3, ?)",
    [id, "T-" + id, id + ".pdf", JSON.stringify(pins), ZONES, ANNOS, now, now, pid]);
  await dep(D.main, PID, PINS.main); await dep(D.vec, PID, PINS.vec); await dep(D.leg, null, PINS.leg); await dep(D.other, PID2, PINS.other);
  await run("UPDATE projects SET original_deployment_id = ? WHERE id = ?", [D.main, PID]);
  const deck = (id, pid, depId) => run("INSERT INTO decks (id, project_id, name, deployment_id, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)", [id, pid, id, depId, now, now]);
  await deck("dk_a", PID, D.main); await deck("dk_b", PID, D.vec); await deck("dk_c", PID, D.leg); await deck("dk_o", PID2, D.other);
  await run("INSERT INTO pin_notes (id, deployment_id, pin_id, pin_label, body, status, author, created_at, updated_at, deleted) VALUES ('note_p132', ?, '1', '1', '누수', 'open', 'o', ?, ?, 0)", [D.main, now, now]);
};
await seed();
const depRow = (id) => first("SELECT pins, zones, annotations, version FROM deployments WHERE id = ?", [id]);
const pinsOf = async (id) => JSON.parse((await depRow(id)).pins);
const liveIds = async (id) => (await pinsOf(id)).filter((p) => !p._deleted).map((p) => p.id).join(",");
const snapshot = async () => JSON.stringify(await Promise.all(Object.values(D).map((id) => depRow(id))));
const rx = async (k) => (await api(TOK[k], "POST", "/api/auth/reauth", { password: PW[k] })).j.token;
const purgeUrl = "/api/projects/" + PID + "/pins/purge";
const baseOf = (pv) => Object.fromEntries(pv.deployments.map((d) => [d.id, d.version]));

console.log("\n[A. 미리보기 — 권한·집계]");
{
  const m = await api(TOK.m, "GET", purgeUrl);
  ok(m.status === 403, "A1 디자이너(멤버) 미리보기 → 403", m);
  const v = await api(TOK.v, "GET", purgeUrl);
  ok(v.status === 403, "A2 열람자(디자이너 아님) → 403", v.status);
  const s = await api(TOK.s, "GET", purgeUrl);
  ok(s.status === 200, "A3 super → 200", s.status);
  const o = await api(TOK.o, "GET", purgeUrl);
  const t = o.j && o.j.totals;
  ok(o.status === 200 && o.j.decks === 3, "A4 소유자 → 200, 구역 3개", o.j && o.j.decks);
  ok(t && t.pins === 8 && t.checker === 5 && t.pano === 3 && t.photos === 3, "A5 핀 8(CHECKER 5 / 360 3) · 사진 연결 3", t);
  const ids = (o.j.deployments || []).map((d) => d.id).sort().join(",");
  ok(ids === [D.leg, D.main, D.vec].sort().join(","), "A6 배포본 = 메인·벡터 복사·레거시 구역 연결 3곳(타 프로젝트 제외)", ids);
  ok(o.j.ready === true, "A7 ready(마이그레이션 0039 적용)", o.j.ready);
}

console.log("\n[B. 확인 단계 — 하나라도 실패하면 0건]");
{
  const pv = (await api(TOK.o, "GET", purgeUrl)).j;
  const before = await snapshot();
  const bm = await api(TOK.m, "POST", purgeUrl, { confirm_name: NAME, base_versions: baseOf(pv) }, { "X-Reauth": await rx("m") });
  ok(bm.status === 403 && (await snapshot()) === before, "B1 디자이너(유효 재인증) → 403, 0건", bm.status);
  const rxo = await rx("o");
  ok(typeof rxo === "string" && rxo.startsWith("rx1."), "B2 소유자 재인증 토큰 발급", rxo);
  const pv2 = pv;
  const before2 = await snapshot();
  const b3 = await api(TOK.o, "POST", purgeUrl, { confirm_name: "P132 선박 B", base_versions: baseOf(pv2) }, { "X-Reauth": rxo });
  ok(b3.status === 400 && b3.j.name_mismatch === true && (await snapshot()) === before2, "B3 이름 불일치 → 400, 0건", b3);
  const b4 = await api(TOK.o, "POST", purgeUrl, { confirm_name: NAME, base_versions: baseOf(pv2) });
  ok(b4.status === 403 && b4.j.reauth_required === true && (await snapshot()) === before2, "B4 재인증 없음 → 403 reauth_required, 0건", b4);
  const b5 = await api(TOK.o, "POST", purgeUrl, { confirm_name: NAME, base_versions: baseOf(pv2) }, { "X-Reauth": "rx1.forged.token" });
  ok(b5.status === 403 && (await snapshot()) === before2, "B5 위조 재인증 → 403, 0건", b5.status);
  const b6 = await api(TOK.o, "POST", purgeUrl, { confirm_name: NAME, base_versions: baseOf(pv2) }, { "X-Reauth": await rx("m") });
  ok(b6.status === 403 && (await snapshot()) === before2, "B6 타인(멤버) 재인증 토큰 → 403, 0건", b6.status);
}

console.log("\n[C. 409 부분 실패 — 배포본별 보고]");
let batchC = null, deletedC = 0;
const origLive = {};
for (const k of ["main", "vec", "leg"]) origLive[k] = JSON.stringify((await pinsOf(D[k])).filter((p) => !p._deleted));
const r2Before = await (await r2.get(R2KEY)).text();
{
  const pv = (await api(TOK.o, "GET", purgeUrl)).j;
  // 미리보기 뒤 멤버가 벡터 복사 배포본을 저장 → 그 배포본만 version 어긋남
  const vv = (await depRow(D.vec)).version;
  const pm = await api(TOK.m, "PATCH", "/tables/deployments/" + D.vec, { base_version: vv, title: "member-saved" });
  ok(pm.status === 200, "C0 멤버가 벡터 복사 배포본 저장(미리보기 이후)", pm.status);
  const r = await api(TOK.o, "POST", purgeUrl, { confirm_name: NAME, base_versions: baseOf(pv) }, { "X-Reauth": await rx("o") });
  const byId = Object.fromEntries((r.j.results || []).map((x) => [x.id, x]));
  ok(r.status === 200 && r.j.partial === true && r.j.failed === 1, "C1 200 partial · 실패 1곳", r.j);
  ok(byId[D.vec] && byId[D.vec].ok === false && byId[D.vec].status === 409 && /버전/.test(byId[D.vec].reason || ""), "C2 벡터 복사 배포본 = 409 + 사유", byId[D.vec]);
  ok(byId[D.main] && byId[D.main].deleted === 5 && byId[D.leg] && byId[D.leg].deleted === 1 && r.j.deleted === 6, "C3 메인 5 · 레거시 1 = 삭제 6", r.j.deleted);
  ok((await liveIds(D.vec)) === "21,22", "C4 409 배포본 핀 불변", await liveIds(D.vec));
  batchC = r.j.batch; deletedC = r.j.deleted;
  ok(typeof batchC === "string" && r.j.undo_until > Date.now() + 9 * 60000, "C5 batch · undo_until ≈ 10분", r.j.undo_until);
}

console.log("\n[D. tombstone — 하드 삭제 0 · 핀 외 불변 · R2 불변]");
{
  const mp = await pinsOf(D.main);
  ok(mp.length === 6 && mp.every((p) => p._deleted === true), "D1 메인 6행 전부 tombstone(행 수 유지 = 하드 삭제 아님)", mp);
  ok(mp.filter((p) => p.id !== 99).every((p) => Object.keys(p).sort().join(",") === "_deleted,id,ts"), "D2 tombstone 형식 = /ops delete 와 같은 {id,_deleted,ts}", mp[0]);
  ok(mp.find((p) => p.id === 99).ts === 5, "D3 기존 tombstone(id 99) 그대로", mp.find((p) => p.id === 99));
  const row = await depRow(D.main);
  ok(row.zones === ZONES && row.annotations === ANNOS, "D4 zones·annotations 불변");
  const note = await first("SELECT deleted, body FROM pin_notes WHERE id = 'note_p132'");
  ok(note && note.deleted === 0 && note.body === "누수", "D5 pin_notes 불변", note);
  const obj = await r2.get(R2KEY);
  const now = obj ? await obj.text() : null;
  ok(!!now && now === r2Before && now === R2BYTES, "D6 R2 사진 원본 객체 불변(바이트 동일)", !!now);
  ok((await liveIds(D.other)) === "41", "D7 다른 프로젝트 배포본 불변", await liveIds(D.other));
}

console.log("\n[E. 감사 기록]");
{
  const lg = await first("SELECT actor_email, target_type, target_id, detail FROM activity_log WHERE action = 'pins.purge' ORDER BY ts DESC LIMIT 1");
  const d = lg ? JSON.parse(lg.detail) : {};
  const per = Object.fromEntries((d.deployments || []).map((x) => [x.id, x]));
  ok(lg && lg.actor_email === U.o && lg.target_type === "project" && lg.target_id === PID, "E1 pins.purge — 실행자·프로젝트", lg);
  ok(d.undo === false && d.deleted === 6 && per[D.main].deleted === 5 && per[D.vec].status === 409, "E2 배포본별 삭제 수·실패 + undo:false", d);
}

console.log("\n[F. 되돌리기]");
{
  const fm = await api(TOK.m, "POST", purgeUrl + "/" + batchC + "/undo");
  ok(fm.status === 403 && (await liveIds(D.main)) === "", "F1 디자이너 되돌리기 → 403", fm.status);
  const u = await api(TOK.o, "POST", purgeUrl + "/" + batchC + "/undo");
  ok(u.status === 200 && u.j.restored === deletedC, "F2 복원 수 = 삭제 수(" + deletedC + ")", u.j);
  const mainLive = (await pinsOf(D.main)).filter((p) => !p._deleted);
  ok(JSON.stringify(mainLive) === origLive.main && JSON.stringify((await pinsOf(D.leg)).filter((p) => !p._deleted)) === origLive.leg, "F3 핀 원상(필드까지 동일)");
  ok((await pinsOf(D.main)).find((p) => p.id === 99)._deleted === true, "F4 기존 tombstone(id 99)은 되살리지 않음");
  const lg = await first("SELECT detail FROM activity_log WHERE action = 'pins.purge.undo' ORDER BY ts DESC LIMIT 1");
  ok(lg && JSON.parse(lg.detail).undo === true && JSON.parse(lg.detail).restored === deletedC, "F5 감사 pins.purge.undo(undo:true · 복원 수)", lg);
  const u2 = await api(TOK.o, "POST", purgeUrl + "/" + batchC + "/undo");
  ok(u2.status === 200 && u2.j.restored === 0, "F6 두 번째 되돌리기 → 0(중복 복원 없음)", u2.j);
}

console.log("\n[G. super — 다중 배포본 전부 + 전체 저장 뒤에도 복원]");
let batchG = null;
{
  const pv = (await api(TOK.s, "GET", purgeUrl)).j;
  const r = await api(TOK.s, "POST", purgeUrl, { confirm_name: NAME, base_versions: baseOf(pv) }, { "X-Reauth": await rx("s") });
  ok(r.status === 200 && r.j.ok === true && r.j.deleted === 8 && r.j.failed === 0, "G1 super 실행 → 3곳 전부, 삭제 8", r.j);
  const all = [await liveIds(D.main), await liveIds(D.vec), await liveIds(D.leg)];
  ok(all.every((s) => s === ""), "G2 메인·벡터 복사·레거시 전부 tombstone", all);
  batchG = r.j.batch;
  // 클라 전체 저장이 tombstone 을 지운 상황(PATCH pins 통째) — 복원은 스냅샷으로 해야 한다
  const v = (await depRow(D.main)).version;
  const p = await api(TOK.o, "PATCH", "/tables/deployments/" + D.main, { base_version: v, pins: "[]" });
  ok(p.status === 200 && (await pinsOf(D.main)).length === 0, "G3 전체 저장(PATCH pins []) → tombstone 사라짐", p.status);
  const u = await api(TOK.s, "POST", purgeUrl + "/" + batchG + "/undo");
  ok(u.status === 200 && u.j.restored === 8, "G4 되돌리기 복원 8 = 삭제 8", u.j);
  ok(JSON.stringify(await pinsOf(D.main)) === origLive.main, "G5 메인 핀 원상(스냅샷)");
}

console.log("\n[H. 30일 경과(WO 20261015-bulkdel-undo — 10분→30일로 늘림)]");
{
  const pv = (await api(TOK.o, "GET", purgeUrl)).j;
  ok(pv.undo_window_ms === 30 * 24 * 60 * 60 * 1000, "H0 미리보기 undo_window_ms = 30일", pv.undo_window_ms);
  const r = await api(TOK.o, "POST", purgeUrl, { confirm_name: NAME, base_versions: baseOf(pv) }, { "X-Reauth": await rx("o") });
  await run("UPDATE pin_bulk_deletes SET created_at = ? WHERE batch_id = ?", [Date.now() - 31 * 24 * 60 * 60000, r.j.batch]);
  const u = await api(TOK.o, "POST", purgeUrl + "/" + r.j.batch + "/undo");
  ok(u.status === 410 && u.j.expired === true && (await liveIds(D.main)) === "", "H1 30일 경과 → 410, 삭제 유지", u);
}

console.log("\n[I. 마이그레이션 미적용]");
{
  // 시드를 되살린다(H 가 지운 상태) — 새 핀 1개를 넣고 테이블을 지운다
  const v = (await depRow(D.vec)).version;
  await api(TOK.o, "PATCH", "/tables/deployments/" + D.vec, { base_version: v, pins: JSON.stringify([{ id: 777, x: 1, y: 1, page: 1, label: "7", checkboard: true }]) });
  const pv = (await api(TOK.o, "GET", purgeUrl)).j;
  await db.exec("DROP TABLE pin_bulk_deletes");
  const r = await api(TOK.o, "POST", purgeUrl, { confirm_name: NAME, base_versions: baseOf(pv) }, { "X-Reauth": await rx("o") });
  ok(r.status === 503 && (await liveIds(D.vec)) === "777", "I1 테이블 없음 → 503, 0건", r.status);
}

clearTimeout(watchdog);
await mf.dispose();
try { fs.unlinkSync(workerOut); } catch {}
console.log("\n" + (failed ? "FAIL " + failed : "ALL PASS"));
process.exit(failed ? 1 : 0);
