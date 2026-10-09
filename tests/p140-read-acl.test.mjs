/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p140-read-acl.test.mjs)
 *
 * WO 20261009-readacl — 운영 보안 결함(감사 .tmp/access-audit-20261009.md H1·H2·시나리오 2·3·5·8)
 *   로그인하지 않은 사람이 링크 없이 auto-entry{kind:'viewer'} 로 토큰을 받아 모든 프로젝트의 도면·핀·사진 원본을 읽었다.
 * 서버 = src/index.tsx 실 번들 → Miniflare(workerd) + 실 D1(migrations 전부) + 실 R2. 목 0.
 *
 *  T1 링크 없는 익명 auto-entry → 401 · 미배포 링크 → 401 · 배포 링크 → 200
 *  T2 링크 A 토큰: 목록 = A 의 구역/원본 배포본만 · B(비공개)/C(다른 배포 프로젝트)/레거시 단건 403
 *  T3 링크 A 토큰: R2 A 키 200 · 파노 경유 키 200 · B 키 403 · 파노 단건 A 200/B 403 · 파노 목록 403
 *  T4 링크 A 토큰: /api/projects = A 만 · decks A 200 / C 403 · 노트 B 403 · 요청 작성 B 403 / A 200
 *  T5 로그인 열람자(A viewer 멤버): A 200 · B·C 403 · 목록 A 만 · 요청 작성 C 403 · R2 B 403
 *  T6 디자이너(비멤버): A 403 · 레거시(귀속 없음·자기 테넌트) 200 · POST decks A 403(감사 추정 → 재현) · PUT/DELETE decks 403
 *  T7 소유자: A·레거시 200 · B 403 · super: 전부 200
 *  T8 초대코드 게이트: 코드 발급 → 링크 토큰 목록에서 A 제외 · 통행증(verify) → 목록 복귀
 *  T9 이메일: 열람자 응답(배포본·프로젝트·노트) 이메일 0건 · 디자이너 응답은 유지
 *  T10 무인증 /api/projects → 401
 *  T11 배포 취소: 이미 발급된 토큰 403 · 옛 링크 재발급 401 / 링크 폐기(구역 삭제): 그 링크 토큰 403
 *  T12 범위 없는 구 열람 토큰(감사 통행증) → 무효(auth/me unauthenticated · 목록 401)
 *  T13 공유 주소(/srview 토큰) 링크 → A 200 · C 403
 *
 * 뮤테이션: MUT=<이름> 이면 src 사본에 치환을 적용해 빌드한다(치환 실패 = EXIT 3). 각 뮤테이션은 EXIT=1 이어야 한다.
 * 재현: P140_SRC=<디렉터리> 면 그 디렉터리의 index.tsx 로 빌드(HEAD 추출본으로 결함 재현용).
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
const watchdog = setTimeout(() => { console.log("\nWATCHDOG — 240s 초과 → FAIL"); process.exit(1); }, 240000);

/* ── 뮤테이션(src 사본) ── */
const MUTS = {
  noLink:   ["if (!sc) return c.json({ error: 'view link required", "if (false) return c.json({ error: 'view link required"],
  list:     ["  const s = await readScopeOf(c, user)\n  let results: any[] = []\n  if (s.all) {", "  const s = await readScopeOf(c, user)\n  let results: any[] = []\n  if (true) {"],
  single:   ["if (!canReadDepRow(scope, await depRefIndexOf(c), row)) return c.json({ error: 'forbidden' }, 403)", "if (false) return c.json({ error: 'forbidden' }, 403)"],
  r2:       ["if (!(await canReadR2Key(c, user, key, obj))) return c.json({ error: 'forbidden' }, 403)", ""],
  member:   ["    const role = roles.get(id)\n    if (role == null) continue", "    const role = roles.get(id)\n    if (false) continue"],
  gate:     ["if (await shareGateLockedPid(c, user, [String(pid)])) continue", ""],
  mask:     ["  const o: any = mapDeployment(r)\n  if (!mask) return o", "  const o: any = mapDeployment(r)\n  return o"],
  unpub:    ["if (!p || !Number(p.published)) continue", "if (!p) continue"],
  decks:    ["  // [WO 20261009-readacl] 🔴 남의 프로젝트에 구역 추가 차단 — 프로젝트 관리 권한(슈퍼·소유자·designer 멤버) SoT\n  if (!(await canManageProject(c, user, pid))) return", "  if (false) return"],
  proj401:  ["if (!user) return c.json({ error: 'unauthorized — login required' }, 401)\n  const email = String(user.email || '').trim().toLowerCase()\n  const s = await readScopeOf(c, user)", "if (!user) return c.json({ data: [] })\n  const email = String(user.email || '').trim().toLowerCase()\n  const s = await readScopeOf(c, user)"],
  notePost: ["if (!(await canReadDeployment(c, a.user, deployment_id))) return c.json({ error: 'forbidden — no access to this deployment' }, 403)", ""],
  legacyTok:["    if (!ps.length) return null\n", "\n"],
  linkGone: ["if (sc.d && !(refs && refs.has(String(pid)))) continue", ""],
  pano:     ["if (!s.all && !s.designer && !(await canReadPanoAsViewer(c, user, id))) return c.json({ error: 'forbidden' }, 403)", ""],
};
const MUT = process.env.MUT || "";
const SRC_DIR = process.env.P140_SRC ? path.resolve(process.env.P140_SRC) : path.join(ROOT, "src");
let entry = path.join(SRC_DIR, "index.tsx");
if (MUT) {
  const m = MUTS[MUT];
  if (!m) { console.log("unknown MUT " + MUT); process.exit(3); }
  const dir = path.join(ROOT, ".tmp", "p140src-" + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, "src"), dir, { recursive: true });
  const f = path.join(dir, "index.tsx");
  const s = fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  if (!s.includes(m[0])) { console.log("MUT " + MUT + " 치환 대상 없음"); process.exit(3); }
  fs.writeFileSync(f, s.replace(m[0], m[1]));
  entry = f;
  console.log("[MUT=" + MUT + "]");
}
if (process.env.P140_SRC) console.log("[SRC=" + SRC_DIR + "]");

const SECRET = "p140-signing-secret-0123456789abcdef";
const SUPER = "sup@seastar.test";
const workerOut = path.join(os.tmpdir(), "p140-worker-" + process.pid + ".mjs");
await esbuild.build({
  entryPoints: [entry], bundle: true, format: "esm", platform: "neutral",
  outfile: workerOut, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
  conditions: ["workerd", "worker", "browser"],
});
const mf = new Miniflare({
  modules: true, scriptPath: workerOut, d1Databases: { DB: "p140-" + Date.now() }, r2Buckets: { R2: "p140r2-" + Date.now() },
  bindings: { DEMO_LOGIN: "0", AUTO_ENTRY_SECRET: SECRET, SUPER_ADMIN_EMAIL: SUPER, SUPER_ADMIN_EMAILS: SUPER },
  compatibilityDate: "2025-01-01",
});
const BASE = "http://p140.test";
const db = await mf.getD1Database("DB");
const r2 = await mf.getR2Bucket("R2");
for (const f of fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()) {
  for (const st of rd("migrations/" + f).replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean)) await db.exec(st);
}
const run = (q, a = []) => db.prepare(q).bind(...a).run();

/* ── 사용자: super · 소유자 O(A) · 소유자 O2(B·C) · 비멤버 디자이너 D · 열람자 V(A viewer 멤버) ── */
const U = { s: SUPER, o: "owner@seastar.test", o2: "owner2@seastar.test", d: "loose.designer@seastar.test", v: "viewer@client.test" };
const TOK = {};
for (const k of Object.keys(U)) {
  const now = Date.now();
  if (k !== "v") await run("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, 'seed', ?, ?, 0)", [U[k], k, now, now]);
  await run("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, 'x', 'h', 's', 1, ?, ?, 0)", [U[k], k, now, now]);
  TOK[k] = "local-p140-" + k + "-" + crypto.randomBytes(6).toString("hex");
  await run("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOK[k], U[k], now, now + 8.64e7]);
}
const api = async (tok, method, url, body, extra) => {
  const headers = Object.assign({ "Content-Type": "application/json" }, tok ? { Authorization: "Bearer " + tok } : {}, extra || {});
  const r = await mf.dispatchFetch(BASE + url, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text };
};
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const emailsIn = (t) => (String(t || "").match(EMAIL_RE) || []);

/* ── 시드: A(O 소유·배포) · B(O2 소유·비공개) · C(O2 소유·배포) · 레거시 L(귀속 없음) ── */
const P = { a: "prj_p140_a", b: "prj_p140_b", c: "prj_p140_c" };
const D = { a: "dep_p140_a", a2: "dep_p140_a2", b: "dep_p140_b", c: "dep_p140_c", l: "dep_p140_legacy" };
const K = { a: "assets/p140-a.png", a2: "assets/p140-a2-pano.jpg", b: "assets/p140-b.png", c: "assets/p140-c.png" };
const IMG = { a: "img_p140_a", b: "img_p140_b" };
for (const k of Object.keys(K)) await r2.put(K[k], "PNG-SECRET-" + k);
{
  const now = Date.now();
  const proj = (id, owner, pub) => run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted, published, published_by) VALUES (?, ?, '', ?, ?, ?, 0, ?, ?)", [id, "P140-" + id, owner, now, now, pub, pub ? owner : null]);
  await proj(P.a, U.o, 1); await proj(P.b, U.o2, 0); await proj(P.c, U.o2, 1);
  await run("INSERT INTO project_members (project_id, email, role, granted_by, created_at) VALUES (?, ?, 'viewer', ?, ?)", [P.a, U.v, U.o, now]);
  await run("INSERT INTO project_members (project_id, email, role, granted_by, created_at) VALUES (?, ?, 'designer', ?, ?)", [P.b, U.s, U.o2, now]);
  const pins = (tag, key, img) => JSON.stringify([{ id: 1, x: 10, y: 10, page: 1, title: "SECRET-" + tag, author: tag === "A" ? U.o : U.o2, imageUrl: "/api/r2/object/" + key }, ...(img ? [{ id: 2, x: 20, y: 20, page: 1, imageId: img, author: U.o }] : [])]);
  const dep = (id, pid, p) => run("INSERT INTO deployments (id, title, file_name, pins, zones, annotations, created_at, updated_at, deleted, version, project_id, tenant_id) VALUES (?, ?, ?, ?, '[]', '[]', ?, ?, 0, 1, ?, 'tnt_default')", [id, "T-" + id, id + ".pdf", p, now, now, pid]);
  await dep(D.a, P.a, pins("A", K.a, IMG.a)); await dep(D.a2, P.a, "[]"); await dep(D.b, P.b, pins("B", K.b, IMG.b)); await dep(D.c, P.c, pins("C", K.c)); await dep(D.l, null, "[]");
  await run("UPDATE projects SET original_deployment_id = ? WHERE id = ?", [D.a, P.a]);
  const deck = (id, pid, depId) => run("INSERT INTO decks (id, project_id, name, deployment_id, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)", [id, pid, id, depId, now, now]);
  await deck("dk_p140_a", P.a, D.a); await deck("dk_p140_a2", P.a, D.a2); await deck("dk_p140_b", P.b, D.b); await deck("dk_p140_c", P.c, D.c);
  const img = (id, data) => run("INSERT INTO pano_images (id, name, image_data, created_at, updated_at, deleted, tenant_id) VALUES (?, ?, ?, ?, ?, 0, 'tnt_default')", [id, id, data, now, now]);
  await img(IMG.a, "/api/r2/object/" + K.a2); await img(IMG.b, "data:image/jpeg;base64,U0VDUkVULUI=");
  await run("INSERT INTO pin_notes (id, deployment_id, pin_id, pin_label, body, status, author, author_email, author_role, created_at, updated_at, deleted, kind) VALUES ('note_p140_a', ?, '1', '1', '누수', 'open', ?, ?, 'designer', ?, ?, 0, 'note')", [D.a, U.o, U.o, now, now]);
  await run("INSERT INTO pin_notes (id, deployment_id, pin_id, pin_label, body, status, author, author_email, author_role, created_at, updated_at, deleted, kind) VALUES ('note_p140_b', ?, '1', '1', 'B비밀', 'open', 'o2', ?, 'designer', ?, ?, 0, 'note')", [D.b, U.o2, now, now]);
}
const mint = async (body) => api(null, "POST", "/api/auth/auto-entry", Object.assign({ kind: "viewer" }, body || {}));
const listIds = async (tok) => { const r = await api(tok, "GET", "/tables/deployments"); return { status: r.status, ids: ((r.j && r.j.data) || []).map((d) => d.id).sort(), r }; };

console.log("\n[T1 auto-entry — 링크 없으면 토큰 없음]");
let ANON = null;
{
  const a = await mint();
  ok(a.status === 401 && !(a.j && a.j.token), "T1a 링크 없는 익명 {kind:'viewer'} → 401(토큰 없음)", a.status);
  const dz = await mint({ kind: "designer" });
  ok(dz.status === 401, "T1b {kind:'designer'}(공용석 꺼짐 → viewer 강등) 링크 없이 → 401", dz.status);
  const b = await mint({ d: D.b });
  ok(b.status === 401, "T1c 비공개(미배포) 프로젝트 배포본 링크 → 401", b.status);
  const l = await mint({ d: D.l });
  ok(l.status === 401, "T1d 어느 프로젝트에도 연결 안 된 배포본 id → 401", l.status);
  const g = await mint({ d: D.a });
  ok(g.status === 200 && g.j && /^ae1\./.test(g.j.token) && g.j.readonly === true, "T1e 배포 프로젝트 A 링크 → 200 열람전용 토큰", g.status);
  ANON = g.j && g.j.token;
  // 하위호환: 링크 식별자를 안 보내는 캐시된 옛 클라이언트 — 같은 출처 Referer 의 ?d= 로 해석(범위 판정은 동일)
  const ra = await api(null, "POST", "/api/auth/auto-entry", { kind: "viewer" }, { Referer: BASE + "/?mode=viewer&d=" + D.a });
  ok(ra.status === 200 && ra.j && /^ae1\./.test(ra.j.token), "T1f 옛 클라이언트(본문 d 없음) + 같은 출처 Referer ?d=A → 200", ra.status);
  const rb = await api(null, "POST", "/api/auth/auto-entry", { kind: "viewer" }, { Referer: BASE + "/?d=" + D.b });
  ok(rb.status === 401, "T1g Referer ?d=B(비공개) → 401", rb.status);
  const rx = await api(null, "POST", "/api/auth/auto-entry", { kind: "viewer" }, { Referer: "http://evil.test/?d=" + D.a });
  ok(rx.status === 401, "T1h 다른 출처 Referer → 401(무시)", rx.status);
}

console.log("\n[T2 링크 A 토큰 — 배포본 목록·단건]");
{
  const L = await listIds(ANON);
  ok(L.status === 200 && L.ids.join(",") === [D.a, D.a2].sort().join(","), "T2a 목록 = A 의 원본+구역 2건만(B·C·레거시 없음)", L.ids);
  const sa = await api(ANON, "GET", "/tables/deployments/" + D.a);
  ok(sa.status === 200 && sa.j && sa.j.id === D.a, "T2b 단건 A → 200", sa.status);
  const sa2 = await api(ANON, "GET", "/tables/deployments/" + D.a2);
  ok(sa2.status === 200, "T2c 같은 프로젝트 구역 배포본 A2 → 200", sa2.status);
  const sb = await api(ANON, "GET", "/tables/deployments/" + D.b);
  ok(sb.status === 403 && !sb.text.includes("SECRET-B"), "T2d 🔴 비공개 B 단건 → 403(본문 없음)", sb.status);
  const sc = await api(ANON, "GET", "/tables/deployments/" + D.c);
  ok(sc.status === 403, "T2e 🔴 다른 배포 프로젝트 C 단건 → 403(링크 범위 밖)", sc.status);
  const sl = await api(ANON, "GET", "/tables/deployments/" + D.l);
  ok(sl.status === 403, "T2f 레거시(귀속 없음) 단건 → 403", sl.status);
  const vs = await api(ANON, "GET", "/tables/deployments/" + D.b + "?fields=version");
  ok(vs.status === 403, "T2g 버전 폴링 경량 경로도 B → 403", vs.status);
}

console.log("\n[T3 링크 A 토큰 — R2·파노]");
{
  const ra = await api(null, "GET", "/api/r2/object/" + K.a + "?t=" + encodeURIComponent(ANON));
  ok(ra.status === 200 && ra.text === "PNG-SECRET-a", "T3a R2 A 키(핀 imageUrl) → 200", ra.status);
  const ra2 = await api(null, "GET", "/api/r2/object/" + K.a2 + "?t=" + encodeURIComponent(ANON));
  ok(ra2.status === 200, "T3b R2 파노 경유 키(핀 imageId → pano_images.image_data) → 200", ra2.status);
  const rb = await api(null, "GET", "/api/r2/object/" + K.b + "?t=" + encodeURIComponent(ANON));
  ok(rb.status === 403 && !rb.text.includes("SECRET"), "T3c 🔴 R2 B 키 → 403", rb.status);
  const rc = await api(ANON, "GET", "/api/r2/object/" + K.c);
  ok(rc.status === 403, "T3d R2 C 키(헤더 토큰) → 403", rc.status);
  const pa = await api(ANON, "GET", "/tables/pano_images/" + IMG.a);
  ok(pa.status === 200, "T3e 파노 단건 A(핀 참조) → 200", pa.status);
  const pb = await api(ANON, "GET", "/tables/pano_images/" + IMG.b);
  ok(pb.status === 403, "T3f 파노 단건 B → 403", pb.status);
  const pl = await api(ANON, "GET", "/tables/pano_images");
  ok(pl.status === 403, "T3g 파노 목록(열거) → 403", pl.status);
}

console.log("\n[T4 링크 A 토큰 — 프로젝트·decks·노트·요청]");
{
  const pr = await api(ANON, "GET", "/api/projects");
  const ids = ((pr.j && pr.j.data) || []).map((p) => p.id);
  ok(pr.status === 200 && ids.join(",") === P.a, "T4a /api/projects = A 만(다른 배포 프로젝트 이름 열거 차단)", ids);
  const da = await api(ANON, "GET", "/api/projects/" + P.a + "/decks");
  ok(da.status === 200 && ((da.j && da.j.data) || []).length === 2, "T4b decks A → 200(구역 2)", da.status);
  const dc = await api(ANON, "GET", "/api/projects/" + P.c + "/decks");
  ok(dc.status === 403, "T4c decks C → 403", dc.status);
  const nb = await api(ANON, "GET", "/api/notes?deployment_id=" + D.b);
  ok(nb.status === 403, "T4d 노트 목록 B → 403", nb.status);
  const sb = await api(ANON, "GET", "/api/notes/summary?deployment_id=" + D.b);
  ok(sb.status === 403, "T4e 노트 요약 B → 403", sb.status);
  const wb = await api(ANON, "POST", "/api/notes", { deployment_id: D.b, body: "침투", kind: "request", author: "익명" });
  ok(wb.status === 403, "T4f 🔴 요청 작성 B → 403", wb.status);
  const wa = await api(ANON, "POST", "/api/notes", { deployment_id: D.a, body: "요청합니다", kind: "request", author: "현장" });
  ok(wa.status === 200 && wa.j && wa.j.kind === "request", "T4g 요청 작성 A → 200(정상 흐름)", wa.status);
}

console.log("\n[T5 로그인 열람자 V(A viewer 멤버)]");
{
  const L = await listIds(TOK.v);
  ok(L.status === 200 && L.ids.join(",") === [D.a, D.a2].sort().join(","), "T5a 목록 = 멤버 프로젝트 A 만", L.ids);
  ok((await api(TOK.v, "GET", "/tables/deployments/" + D.a)).status === 200, "T5b A → 200");
  const b = await api(TOK.v, "GET", "/tables/deployments/" + D.b);
  ok(b.status === 403, "T5c 🔴 비멤버 비공개 B → 403", b.status);
  const c = await api(TOK.v, "GET", "/tables/deployments/" + D.c);
  ok(c.status === 403, "T5d 비멤버 배포 C → 403", c.status);
  const wc = await api(TOK.v, "POST", "/api/notes", { deployment_id: D.c, body: "x", kind: "request" });
  ok(wc.status === 403, "T5e 🔴 비멤버 C 에 요청 작성 → 403", wc.status);
  const wa = await api(TOK.v, "POST", "/api/notes", { deployment_id: D.a, body: "질문", kind: "question" });
  ok(wa.status === 200, "T5f 멤버 A 에 질문 작성 → 200(정상 흐름)", wa.status);
  const rb = await api(TOK.v, "GET", "/api/r2/object/" + K.b);
  ok(rb.status === 403, "T5g R2 B 키 → 403", rb.status);
  const pr = await api(TOK.v, "GET", "/api/projects");
  const m = Object.fromEntries(((pr.j && pr.j.data) || []).map((p) => [p.id, p]));
  ok(m[P.a] && m[P.a].is_member === true && m[P.c] && m[P.c].is_member === false && !m[P.b], "T5h /api/projects: A 멤버 · C 잠금 카드 · B(비공개) 없음", Object.keys(m));
}

console.log("\n[T6 비멤버 디자이너 D]");
{
  const a = await api(TOK.d, "GET", "/tables/deployments/" + D.a);
  ok(a.status === 403, "T6a 비멤버 프로젝트 A → 403", a.status);
  const l = await api(TOK.d, "GET", "/tables/deployments/" + D.l);
  ok(l.status === 200, "T6b 레거시(귀속 없음·자기 테넌트) → 200(종전 유지)", l.status);
  const L = await listIds(TOK.d);
  ok(L.ids.join(",") === D.l, "T6c 목록 = 레거시만", L.ids);
  const pd = await api(TOK.d, "POST", "/api/projects/" + P.a + "/decks", { name: "침투구역", deployment_id: D.b });
  ok(pd.status === 403, "T6d 🔴 남의 프로젝트에 POST decks → 403", pd.status);
  const pu = await api(TOK.d, "PUT", "/api/decks/dk_p140_a", { name: "탈취" });
  ok(pu.status === 403, "T6e 형제 PUT /api/decks → 403", pu.status);
  const de = await api(TOK.d, "DELETE", "/api/decks/dk_p140_a");
  ok(de.status === 403, "T6f 형제 DELETE /api/decks → 403", de.status);
  const up = await mf.dispatchFetch(BASE + "/api/r2/upload", { method: "PUT", headers: { Authorization: "Bearer " + TOK.d, "Content-Type": "image/png" }, body: "fresh-upload" });
  const uj = await up.json();
  const own = await api(TOK.d, "GET", uj.url);
  ok(up.status === 200 && own.status === 200, "T6g 디자이너 본인 업로드 직후(배포본 미참조) 읽기 → 200(편집 흐름)", [up.status, own.status]);
  const vv = await api(TOK.v, "GET", uj.url);
  ok(vv.status === 403, "T6h 그 미참조 객체를 열람자는 → 403", vv.status);
}

console.log("\n[T7 소유자·super]");
{
  const oa = await api(TOK.o, "GET", "/tables/deployments/" + D.a);
  ok(oa.status === 200, "T7a 소유자 O: A → 200", oa.status);
  ok((await api(TOK.o, "GET", "/tables/deployments/" + D.b)).status === 403, "T7b 소유자 O: 남의 B → 403");
  const pd = await api(TOK.o, "POST", "/api/projects/" + P.a + "/decks", { name: "새구역", deployment_id: D.a2 });
  ok(pd.status === 200, "T7c 소유자 O: 자기 프로젝트 POST decks → 200(편집 흐름)", pd.status);
  if (pd.j && pd.j.id) await api(TOK.o, "DELETE", "/api/decks/" + pd.j.id);
  const L = await listIds(TOK.s);
  ok(L.ids.length === 5, "T7d super 목록 = 5건 전부", L.ids);
  ok((await api(TOK.s, "GET", "/tables/deployments/" + D.b)).status === 200, "T7e super: B → 200");
  ok((await api(TOK.s, "GET", "/api/r2/object/" + K.b)).status === 200, "T7f super: R2 B → 200");
}

console.log("\n[T8 초대코드 게이트 — 목록 경로]");
{
  const sc = await api(TOK.o, "POST", "/api/projects/" + P.a + "/share-codes", { label: "협력사1" });
  ok(sc.status === 200 && sc.j && sc.j.code, "T8a 소유자가 A 에 초대코드 발급", sc.status);
  const L = await listIds(ANON);
  ok(L.status === 200 && L.ids.length === 0, "T8b 🔴 코드 미통과 링크 토큰 → 목록에서 A 제외(0건)", L.ids);
  const s1 = await api(ANON, "GET", "/tables/deployments/" + D.a);
  ok(s1.status === 403 && s1.j && s1.j.gate_required, "T8c 단건도 403 gate_required(종전 유지)", s1.status);
  const v = await api(null, "POST", "/api/share/verify", { d: D.a, company: "협력사", name: "홍길동", code: sc.j.code });
  ok(v.status === 200 && v.j && v.j.ok && v.j.token, "T8d 코드 통과 → 통행증", v.status);
  const L2 = await listIds(v.j.token);
  ok(L2.ids.join(",") === [D.a, D.a2].sort().join(","), "T8e 통행증 목록 = A 2건", L2.ids);
  ok((await api(v.j.token, "GET", "/tables/deployments/" + D.c)).status === 403, "T8f 통행증으로 C → 403");
  await api(TOK.o, "POST", "/api/share-codes/" + sc.j.id + "/revoke", {});
}

console.log("\n[T9 이메일 노출]");
{
  const dep = await api(ANON, "GET", "/tables/deployments/" + D.a);
  ok(dep.status === 200 && emailsIn(dep.text).length === 0, "T9a 열람자 배포본 응답 이메일 0건", emailsIn(dep.text));
  const lst = await api(ANON, "GET", "/tables/deployments");
  ok(emailsIn(lst.text).length === 0, "T9b 열람자 배포본 목록 이메일 0건", emailsIn(lst.text));
  const pr = await api(ANON, "GET", "/api/projects");
  ok(pr.status === 200 && emailsIn(pr.text).length === 0, "T9c 열람자 /api/projects 이메일 0건(owner·published_by)", emailsIn(pr.text));
  const nt = await api(ANON, "GET", "/api/notes?deployment_id=" + D.a);
  ok(nt.status === 200 && (nt.j.data || []).length >= 1 && emailsIn(nt.text).length === 0, "T9d 열람자 노트 목록 이메일 0건", emailsIn(nt.text));
  const pv = await api(TOK.v, "GET", "/api/projects");
  ok(emailsIn(pv.text).length === 0, "T9e 로그인 열람자 /api/projects 이메일 0건", emailsIn(pv.text));
  const nv = await api(TOK.v, "GET", "/api/notes?deployment_id=" + D.a);
  const mine = (nv.j.data || []).find((n) => n.kind === "question");
  ok(mine && mine.author_email === U.v && !(nv.j.data || []).some((n) => n.author_email && n.author_email !== U.v), "T9f 로그인 열람자: 본인 글만 author_email 유지(수정 버튼), 남의 이메일 없음", (nv.j.data || []).map((n) => n.author_email));
  const dd = await api(TOK.o, "GET", "/tables/deployments/" + D.a);
  ok(dd.text.includes(U.o), "T9g 디자이너(소유자) 응답은 작성자 이메일 유지(편집 흐름)");
}

console.log("\n[T10 무인증 /api/projects]");
{
  const r = await api(null, "GET", "/api/projects");
  ok(r.status === 401 && emailsIn(r.text).length === 0, "T10 토큰 없는 /api/projects → 401", r.status);
}

console.log("\n[T11 배포 취소·링크 폐기 → 이미 발급된 토큰 즉시 차단]");
{
  const linkA2 = (await mint({ d: D.a2 })).j.token;
  ok((await api(linkA2, "GET", "/tables/deployments/" + D.a2)).status === 200, "T11a 구역 A2 링크 토큰 → 200");
  await run("UPDATE decks SET deleted = 1 WHERE id = 'dk_p140_a2'");
  const gone = await api(linkA2, "GET", "/tables/deployments/" + D.a);
  ok(gone.status === 403, "T11b 🔴 링크 폐기(구역 삭제) 후 그 링크로 받은 토큰 → 403", gone.status);
  await run("UPDATE decks SET deleted = 0 WHERE id = 'dk_p140_a2'");
  const un = await api(TOK.o, "POST", "/api/projects/" + P.a + "/unpublish", {});
  ok(un.status === 200, "T11c 소유자 배포 취소", un.status);
  const old = await api(ANON, "GET", "/tables/deployments/" + D.a);
  ok(old.status === 403, "T11d 🔴 배포 취소 후 이미 발급된 토큰 → 403", old.status);
  const oldR2 = await api(ANON, "GET", "/api/r2/object/" + K.a);
  ok(oldR2.status === 403, "T11e 배포 취소 후 R2 A 키 → 403", oldR2.status);
  const re = await mint({ d: D.a });
  ok(re.status === 401, "T11f 배포 취소 후 옛 링크로 재발급 → 401", re.status);
  await api(TOK.o, "POST", "/api/projects/" + P.a + "/publish", {});
  ok((await api(ANON, "GET", "/tables/deployments/" + D.a)).status === 200, "T11g 재배포 → 같은 토큰 다시 200(정상 흐름)");
}

console.log("\n[T12 범위 없는 구 열람 토큰(감사 H1 통행증)]");
{
  const b64u = (s) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const payload = b64u(JSON.stringify({ k: "viewer", exp: Date.now() + 3600e3, n: "legacy" }));
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const legacy = "ae1." + payload + "." + sig;
  const me = await api(legacy, "GET", "/api/auth/me");
  ok(me.status === 200 && me.j && me.j.authenticated === false, "T12a 구 토큰 → auth/me unauthenticated(클라가 링크로 재발급)", me.j);
  const L = await listIds(legacy);
  ok(L.status === 401, "T12b 구 토큰 목록 → 401", L.status);
}

console.log("\n[T13 공유 주소(/srview 토큰) 링크]");
{
  const row = await db.prepare("SELECT share_token FROM projects WHERE id = ?").bind(P.a).first();
  ok(!!(row && row.share_token), "T13a 배포 시 공유 토큰 발급됨");
  const t = await mint({ t: row.share_token });
  ok(t.status === 200, "T13b 공유 토큰 링크 → 200", t.status);
  ok((await api(t.j.token, "GET", "/tables/deployments/" + D.a)).status === 200, "T13c → A 200");
  ok((await api(t.j.token, "GET", "/tables/deployments/" + D.c)).status === 403, "T13d → C 403");
  const bad = await mint({ t: "aaaaaaaaaaaaaaaa" });
  ok(bad.status === 401, "T13e 틀린 공유 토큰 → 401", bad.status);
}

console.log("\n[T14 클라이언트 재발급 경로 — 실 22_Auth.js + 01c_ShareLink.js(vm) · fetch = 실 워커]");
{
  // 옛 7일 열람 토큰(범위 없음 — 감사 H1 통행증)을 세션에 가진 채 열람 링크로 다시 들어온 브라우저를 그대로 재현한다.
  const b64u = (s) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const pl = b64u(JSON.stringify({ k: "viewer", exp: Date.now() + 3600e3, n: "old7d" }));
  const LEGACY = "ae1." + pl + "." + crypto.createHmac("sha256", SECRET).update(pl).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const CMUTS = {
    bind: ['sessionStorage.getItem("wm_view_link") !== vk) {', "false) {"],
    clientD: ['JSON.stringify(Object.assign({ kind }, this._viewLinkParams() || {}))', "JSON.stringify({ kind })"],
  };
  const CMUT = process.env.P140_CMUT || "";
  let authSrc = rd("public/js/modules/22_Auth.js");
  if (CMUT) {
    if (!CMUTS[CMUT] || !authSrc.includes(CMUTS[CMUT][0])) { console.log("CMUT " + CMUT + " 치환 대상 없음"); process.exit(3); }
    authSrc = authSrc.replace(CMUTS[CMUT][0], CMUTS[CMUT][1]);
    console.log("[P140_CMUT=" + CMUT + "]");
  }
  const vm = await import("node:vm");
  const runBrowser = async (search, ss) => {
    const store = (init) => { const m = Object.assign({}, init); return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; }, _m: m }; };
    const el = () => ({ classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, style: {}, addEventListener() {}, setAttribute() {}, removeAttribute() {}, appendChild() {}, remove() {}, querySelector: () => null, querySelectorAll: () => [], textContent: "", innerHTML: "" });
    const sessionStorage = store(ss), localStorage = store({});
    const sandbox = {
      console, setTimeout, clearTimeout, URLSearchParams, Promise, JSON, Date, Math, Object, String, Number, Array,
      location: { search, pathname: "/", origin: BASE, href: BASE + "/" + search },
      sessionStorage, localStorage,
      document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: el, body: el(), head: el(), addEventListener() {} },
      navigator: { onLine: true, userAgent: "p140" },
      fetch: async (u, o) => mf.dispatchFetch(String(u).startsWith("http") ? u : BASE + u, o),
      Prompt: { toast() {} },
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(rd("public/js/modules/01c_ShareLink.js") + "\n" + authSrc + "\n;globalThis.__A = Auth;", sandbox);
    const A = sandbox.__A;
    // 발급 실패 → 로그인 게이트(_openGate)가 가짜 DOM 에서 던진다 = "재발급 실패"로 기록하고 단언이 판정한다
    try { await A.init(); } catch (e) { console.log("  INFO init 중단: " + String(e && e.message).slice(0, 80)); }
    return { A, sessionStorage };
  };
  // ⓐ 옛 클라이언트 상태(토큰-링크 짝 기록 없음) ⓑ 짝 기록이 있어도 서버가 범위 없는 토큰을 거부 → refresh 미인증 → 재발급
  for (const [tag, ss] of [["ⓐ", { wm_id_token: LEGACY }], ["ⓑ", { wm_id_token: LEGACY, wm_view_link: "d:" + D.a }]]) {
    const { A, sessionStorage } = await runBrowser("?mode=viewer&d=" + D.a, ss);
    const tok = A.idToken;
    ok(typeof tok === "string" && /^ae1\./.test(tok) && tok !== LEGACY && sessionStorage.getItem("wm_id_token") === tok,
      "T14" + tag + " 옛 범위 없는 토큰 → 클라가 링크(?d=A)로 새 토큰 재발급·세션 교체", String(tok).slice(0, 12));
    ok(!!A.user && A.readonly === true, "T14" + tag + " 재발급 토큰으로 열람전용 로그인 상태", A.user);
    const r = await api(tok, "GET", "/tables/deployments/" + D.a);
    ok(r.status === 200, "T14" + tag + " 새 토큰으로 링크 프로젝트 A 열람 200", r.status);
    const rb = await api(tok, "GET", "/tables/deployments/" + D.c);
    ok(rb.status === 403, "T14" + tag + " 새 토큰도 범위 밖 C → 403", rb.status);
  }
  // ⓒ 같은 탭에서 다른 링크(C)로 들어오면 A 토큰을 버리고 C 로 재발급
  {
    const aTok = (await mint({ d: D.a })).j.token;
    const { A } = await runBrowser("?d=" + D.c, { wm_id_token: aTok, wm_view_link: "d:" + D.a });
    ok(A.idToken && A.idToken !== aTok && (await api(A.idToken, "GET", "/tables/deployments/" + D.c)).status === 200,
      "T14ⓒ 다른 링크(C)로 진입 → A 토큰 폐기·C 토큰 재발급 → C 200");
  }
}

await mf.dispose();
try { fs.unlinkSync(workerOut); } catch {}
if (MUT) fs.rmSync(path.join(ROOT, ".tmp", "p140src-" + process.pid), { recursive: true, force: true });
clearTimeout(watchdog);
console.log("\n" + (failed ? "FAIL " + failed : "ALL PASS"));
process.exit(failed ? 1 : 0);
