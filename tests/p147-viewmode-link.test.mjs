/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p147-viewmode-link.test.mjs)
 *
 * WO 20261011-viewmode — 마스터: "배포는 체커보드와 360 모드 각각 가능하게"
 *   뷰어 배포 링크(view_links)에 모드(checker/360/둘다)를 싣고, 서버 응답(mapDeploymentFor)이
 *   그 모드가 아닌 핀을 빼고 내려준다(화면에서만 숨기면 데이터가 그대로 내려가는 결함 방지).
 * 서버 = src/index.tsx 실 번들 → Miniflare(workerd) + 실 D1(migrations 전부). 목 0.
 *
 *  T1 디자이너가 체커 링크 발급 → auto-entry(lk) → 단건 GET pins = checkboard 만 · view_mode='checker'
 *  T2 360 링크 → pins = content 만 · view_mode='360'
 *  T3 옛 링크(?d= 만, lk 없음) → pins 전부(둘다) · view_mode 없음(하위호환)
 *  T4 링크 폐기(revoke) → 그 링크로 auto-entry 재시도 401
 *  T5 목록(GET /api/view-links) 비소유 디자이너 403 · 소유자 200(모드·revoked_at 포함)
 *  T6 목록 응답의 pins(배포본 목록 GET /tables/deployments)도 같은 필터
 *  T7 본인 프로젝트 멤버(디자이너)가 설계 화면에서 읽을 때는(멤버십 경로) 필터 없음(자기 편집 화면 안 깨짐)
 *
 * 뮤테이션: MUT=<이름> 이면 src 사본에 치환 적용 후 빌드(치환 실패 = EXIT 3). 각 뮤테이션은 EXIT=1 이어야 한다.
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
const watchdog = setTimeout(() => { console.log("\nWATCHDOG — 120s 초과 → FAIL"); process.exit(1); }, 120000);

const MUTS = {
  noFilter:   ["if (linkMode) { o.pins = filterPinsByLinkMode(o.pins, linkMode); o.view_mode = linkMode }", "if (linkMode) { o.view_mode = linkMode }"],
  noRevoke:   ["if (!lrow || lrow.revoked_at) return null", "if (!lrow) return null"],
  noOwnGuard: ["if (bound.some((p) => s.pids.has(p))) return null\n  return s.linkMode", "return s.linkMode"],
};
const MUT = process.env.MUT || "";
const SRC_DIR = path.join(ROOT, "src");
let entry = path.join(SRC_DIR, "index.tsx");
if (MUT) {
  const m = MUTS[MUT];
  if (!m) { console.log("unknown MUT " + MUT); process.exit(3); }
  const dir = path.join(ROOT, ".tmp", "p147src-" + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, "src"), dir, { recursive: true });
  const f = path.join(dir, "index.tsx");
  const s = fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  if (!s.includes(m[0])) { console.log("MUT " + MUT + " 치환 대상 없음"); process.exit(3); }
  fs.writeFileSync(f, s.replace(m[0], m[1]));
  entry = f;
  console.log("[MUT=" + MUT + "]");
}

const SECRET = "p147-signing-secret-0123456789abcdef";
const SUPER = "sup@seastar.test";
const workerOut = path.join(os.tmpdir(), "p147-worker-" + process.pid + ".mjs");
await esbuild.build({
  entryPoints: [entry], bundle: true, format: "esm", platform: "neutral",
  outfile: workerOut, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
  conditions: ["workerd", "worker", "browser"],
});
const mf = new Miniflare({
  modules: true, scriptPath: workerOut, d1Databases: { DB: "p147-" + Date.now() }, r2Buckets: { R2: "p147r2-" + Date.now() },
  bindings: { DEMO_LOGIN: "0", AUTO_ENTRY_SECRET: SECRET, SUPER_ADMIN_EMAIL: SUPER, SUPER_ADMIN_EMAILS: SUPER },
  compatibilityDate: "2025-01-01",
});
const BASE = "http://p147.test";
const db = await mf.getD1Database("DB");
for (const f of fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()) {
  for (const st of rd("migrations/" + f).replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean)) await db.exec(st);
}
const run = (q, a = []) => db.prepare(q).bind(...a).run();

const U = { o: "owner@seastar.test", d: "loose.designer@seastar.test" };
const TOK = {};
for (const k of Object.keys(U)) {
  const now = Date.now();
  await run("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, 'seed', ?, ?, 0)", [U[k], k, now, now]);
  await run("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, 'x', 'h', 's', 1, ?, ?, 0)", [U[k], k, now, now]);
  TOK[k] = "local-p147-" + k + "-" + crypto.randomBytes(6).toString("hex");
  await run("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOK[k], U[k], now, now + 8.64e7]);
}
const api = async (tok, method, url, body, extra) => {
  const headers = Object.assign({ "Content-Type": "application/json" }, tok ? { Authorization: "Bearer " + tok } : {}, extra || {});
  const r = await mf.dispatchFetch(BASE + url, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text };
};

/* ── 시드: 프로젝트 A(소유자 O·배포) · 핀 혼합(checkboard 2개 + content 2개) ── */
const P = "prj_p147_a";
const D = "dep_p147_a";
const now = Date.now();
await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted, published, published_by) VALUES (?, 'P147', '', ?, ?, ?, 0, 1, ?)", [P, U.o, now, now, U.o]);
const pins = [
  { id: 1, x: 1, y: 1, page: 1, checkboard: true, no: 1 },
  { id: 2, x: 2, y: 2, page: 1, checkboard: true, no: 2 },
  { id: 3, x: 3, y: 3, page: 1 },   // content(360)
  { id: 4, x: 4, y: 4, page: 1 },   // content(360)
];
await run("INSERT INTO deployments (id, title, file_name, pins, zones, annotations, created_at, updated_at, deleted, version, project_id, tenant_id) VALUES (?, 'T', 'a.pdf', ?, '[]', '[]', ?, ?, 0, 1, ?, 'tnt_default')", [D, JSON.stringify(pins), now, now, P]);
await run("INSERT INTO decks (id, project_id, name, deployment_id, created_at, updated_at, deleted) VALUES ('dk_p147_a', ?, 'dk', ?, ?, ?, 0)", [P, D, now, now]);

const mint = (body) => api(null, "POST", "/api/auth/auto-entry", Object.assign({ kind: "viewer" }, body || {}));
const createLink = (tok, mode) => api(tok, "POST", "/api/view-links", mode ? { dep_id: D, mode } : { dep_id: D });

console.log("\n[T1 체커 링크 — pins=checkboard만 · view_mode='checker']");
{
  const l = await createLink(TOK.o, "checker");
  ok(l.status === 200 && l.j && l.j.id && l.j.mode === "checker", "T1a 링크 발급(mode=checker)", l.status);
  const m = await mint({ lk: l.j.id });
  ok(m.status === 200 && m.j && m.j.token, "T1b auto-entry(lk) → 200 토큰", m.status);
  const g = await api(m.j.token, "GET", "/tables/deployments/" + D);
  const gp = (g.j && g.j.pins) ? JSON.parse(g.j.pins) : null;
  ok(g.status === 200 && g.j.view_mode === "checker", "T1c 단건 GET view_mode='checker'", g.j && g.j.view_mode);
  ok(Array.isArray(gp) && gp.length === 2 && gp.every((p) => p.checkboard === true), "T1d 🔴 pins = checkboard 2개만(360 핀 0건)", gp);
  globalThis.__LK_CHECKER = l.j.id;
}

console.log("\n[T2 360 링크 — pins=content만 · view_mode='360']");
{
  const l = await createLink(TOK.o, "360");
  ok(l.status === 200 && l.j.mode === "360", "T2a 링크 발급(mode=360)", l.status);
  const m = await mint({ lk: l.j.id });
  const g = await api(m.j.token, "GET", "/tables/deployments/" + D);
  const gp = (g.j && g.j.pins) ? JSON.parse(g.j.pins) : null;
  ok(g.j.view_mode === "360", "T2b view_mode='360'", g.j.view_mode);
  ok(Array.isArray(gp) && gp.length === 2 && gp.every((p) => !p.checkboard), "T2c 🔴 pins = content 2개만(checker 핀 0건)", gp);
}

console.log("\n[T3 둘다 링크·옛 링크 — 전부 하위호환]");
{
  const l = await createLink(TOK.o, null);
  ok(l.status === 200 && l.j.mode === null, "T3a 링크 발급(mode 미전송=둘다)", l.j);
  const m = await mint({ lk: l.j.id });
  const g = await api(m.j.token, "GET", "/tables/deployments/" + D);
  const gp = JSON.parse(g.j.pins);
  ok(gp.length === 4 && !g.j.view_mode, "T3b 둘다 링크 → pins 4개 전부 · view_mode 없음", [gp.length, g.j.view_mode]);
  const m2 = await mint({ d: D });   // 옛 클라이언트(lk 없이 d만)
  const g2 = await api(m2.j.token, "GET", "/tables/deployments/" + D);
  const gp2 = JSON.parse(g2.j.pins);
  ok(gp2.length === 4 && !g2.j.view_mode, "T3c 옛 ?d= 링크(lk 없음) → pins 4개 전부(유실 0)", [gp2.length, g2.j.view_mode]);
}

console.log("\n[T4 링크 폐기]");
{
  const l = await createLink(TOK.o, "checker");
  const rv = await api(TOK.o, "POST", "/api/view-links/" + l.j.id + "/revoke", {});
  ok(rv.status === 200 && rv.j.ok, "T4a 폐기 성공", rv.status);
  const m = await mint({ lk: l.j.id });
  ok(m.status === 401, "T4b 🔴 폐기된 링크로 auto-entry → 401", m.status);
  const mUnknown = await mint({ lk: "lk_no_such_id" });
  ok(mUnknown.status === 401, "T4c 존재하지 않는 링크 id → 401", mUnknown.status);
}

console.log("\n[T5 링크 관리 권한]");
{
  const listForbidden = await api(TOK.d, "GET", "/api/view-links?dep_id=" + D);
  ok(listForbidden.status === 403, "T5a 비멤버 디자이너 → 목록 403", listForbidden.status);
  const listOk = await api(TOK.o, "GET", "/api/view-links?dep_id=" + D);
  ok(listOk.status === 200 && Array.isArray(listOk.j.data) && listOk.j.data.length >= 4, "T5b 소유자 → 목록 200(발급한 링크 전부)", listOk.j && listOk.j.data && listOk.j.data.length);
  const revoked = listOk.j.data.find((r) => r.revoked_at);
  ok(!!revoked, "T5c 목록에 폐기 표시(revoked_at) 포함", revoked);
  const createForbidden = await createLink(TOK.d, "checker");
  ok(createForbidden.status === 403, "T5d 비멤버 디자이너 → 링크 발급 403", createForbidden.status);
}

console.log("\n[T6 배포본 목록(GET /tables/deployments)도 같은 필터]");
{
  const l = await createLink(TOK.o, "checker");
  const m = await mint({ lk: l.j.id });
  const L = await api(m.j.token, "GET", "/tables/deployments");
  const row = (L.j.data || []).find((d) => d.id === D);
  const gp = row ? JSON.parse(row.pins) : null;
  ok(L.status === 200 && Array.isArray(gp) && gp.length === 2 && gp.every((p) => p.checkboard === true), "T6a 목록 응답도 checkboard 2개만", gp);
}

console.log("\n[T7 멤버십(자기 편집 화면) 경로는 필터 없음]");
{
  // 로그인 디자이너가 자기 소유 프로젝트를 읽을 때는 링크 모드 제한이 걸리면 안 된다(편집 화면 핀 소실 방지)
  const g = await api(TOK.o, "GET", "/tables/deployments/" + D);
  const gp = JSON.parse(g.j.pins);
  ok(g.status === 200 && gp.length === 4 && !g.j.view_mode, "T7a 소유자 직접 로그인 조회 → 필터 없음(4개 전부)", [gp.length, g.j.view_mode]);
  // 🔴 같은 소유자가 "체커 링크"로 들어와도(Referer ?lk=) 자기 프로젝트는 멤버십 경로 — 편집 화면 핀이 사라지면 안 된다
  const l = await createLink(TOK.o, "checker");
  const g2 = await api(TOK.o, "GET", "/tables/deployments/" + D, null, { Referer: BASE + "/?mode=viewer&lk=" + l.j.id });
  const gp2 = JSON.parse(g2.j.pins);
  ok(g2.status === 200 && gp2.length === 4 && !g2.j.view_mode, "T7b 🔴 멤버가 체커 링크로 들어와도 자기 프로젝트는 필터 없음(4개)", [gp2.length, g2.j.view_mode]);
}

console.log(failed === 0 ? "\nALL PASS" : "\n" + failed + " FAILED");
clearTimeout(watchdog);
process.exit(failed === 0 ? 0 : 1);
