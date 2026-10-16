/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p163-viewer-email-auth.test.mjs)
 *
 * WO 20261016-viewmail — 마스터: "본인 이메일로 보안코드 받고 그 사람, 즉 메일 주소별 사용자 사용 로그를 구현하자"
 *                               "메일로 받은 링크가 진짜인 거지" — 고른 사람만 열람 · 링크 재전달 = 무효.
 * 서버 = src/index.tsx 실 번들 → Miniflare(workerd) + 실 D1(migrations 전부). 목 0 — 외부 호출만 outboundService 로 가로챈다
 *   (Resend 메일 = 캡처만 · 실발송 0 / Firebase 공개키 = 테스트 RSA 키 — 서버 검증 코드는 실물 그대로 RS256 검증).
 *
 *  A(서버 메일 수단 RESEND):
 *   A0 새 링크(첫 배포) = 이메일 인증 기본 ON
 *   A1 🔴 토큰만(auto-entry v · ?d= 우회) → 401 email_auth_required · 정책 전 발급 익명 통행증도 데이터 401
 *   A2 허용 목록 추가(대소문자 정규화 · 형식 오류 분리)
 *   A3 🔴 메일 요청 — 수신자/비수신자 응답 동일 · 응답에 비밀(링크·코드) 0 · 메일은 수신자에게만
 *   A4 메일 링크 완료 → 통행증(이메일 바인딩) · 1회용 · 위조 비밀 401
 *   A5 통행증으로 열람 200 · 세션 이메일 빈값(권한 fail-closed)
 *   A6 🔴 이메일별 기록 — auth·zone·pin·photo · 국가 · 기기 · 원본 IP 0 · 디자이너 목록/타임라인
 *   A7 코멘트 작성자 = 인증 이메일(자기 신고 이름 무시)
 *   A8 🔴 차단 → 즉시 401 · 재초대 → 옛 통행증 계속 401 · 새 링크 200
 *   A9 🔴 레이트리밋(이메일·IP) — 수신자/비수신자 동일 429
 *   A10 로그인 계정 링크 열람(S1)도 정책 적용 — 비수신자 403 · 수신자(인증 이메일) 200
 *   A11 관리 권한 — 비멤버 디자이너 403
 *   A12 🔴 배포 취소 → 통행증 410 · /v 410
 *  B(Firebase 수단): 메일 요청 = method firebase(서버 발송 0) · 유효 ID 토큰 200 · 미인증/타 프로젝트/오래된 로그인 401 · 비수신자 403
 *  C(수단 없음): 🔴 503 · dev-fallback 0(응답에 비밀 0) · 임의 challenge 401
 *
 * 뮤테이션: MUT=<이름> → src 사본 치환 후 빌드(치환 실패 = EXIT 3). 각 뮤테이션은 EXIT=1 이어야 한다.
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const watchdog = setTimeout(() => { console.log("\nWATCHDOG — 240s 초과 → FAIL"); process.exit(1); }, 240000);

const MUTS = {
  // 허용 목록 검사 제거 — 비수신자도 통행증을 받는다
  noAllowlist: ["if (!rec || rec.status !== 'active') return c.json({ error: VIEW_AUTH_NOT_INVITED_MSG, not_invited: true }, 403)", ""],
  // 이메일 바인딩(요청마다 검증) 제거 — 링크 토큰만 가진 통행증이 그대로 열린다
  noBind: ["const fail = await viewEmailGate(c, scope.p, p.e, typeof p.ep === 'number' ? p.ep : -1)", "const fail: any = null"],
  // 차단 무효화 제거 — 차단·세대 불일치를 보지 않는다
  noBlock: ["    if (r.status !== 'active') return 'blocked'\n    if (ep !== null && ep !== undefined && Number(r.auth_epoch) !== Number(ep)) return 'revoked'\n", ""],
  // dev-fallback 허용 — 메일 링크 비밀을 응답에 싣는다
  devFallback: ["return c.json({ ok: true, method, message: VIEW_AUTH_SENT_MSG,", "return c.json({ ok: true, method, message: VIEW_AUTH_SENT_MSG, dev_link: ch.id + '.' + ch.secret,"],
  // 발송 수단 없을 때 실패로 닫지 않음
  noProvider: ["  if (!method) return c.json({ error: VIEW_AUTH_NO_PROVIDER_MSG, no_mail_provider: true }, 503)\n  const meta = await viewClientMeta(c)", "  const meta = await viewClientMeta(c)"],
  noRate: ["if (Number(byEmail?.n || 0) >= VIEW_AUTH_SEND_PER_EMAIL || Number(byIp?.n || 0) >= VIEW_AUTH_SEND_PER_IP) {", "if (false) {"],
  noNorm: ["  const email = normEmail(body && body.email)\n  if (!isValidEmail(email) || email.length > 200)", "  const email = String(body && body.email || '').trim()\n  if (!isValidEmail(email) || email.length > 200)"],
  noS1: ["if (await viewEmailGate(c, [pid], user._emailVerified ? email : null, null)) linkPids.delete(pid)", "void 0"],
  noDefaultOn: ["if (String(after.share_token) === tok && opts && opts.newLinkEmailAuth) {", "if (false) {"],
  // 이미 옛 링크(?d=)로 배포 중이던 프로젝트까지 기본 ON — 살아있는 기존 링크가 죽는다
  legacyOn: ["const firstLink = !!prevPub && !Number(prevPub.published) && !prevPub.published_at && !prevPub.share_token", "const firstLink = true"],
  noAutoEntry: ["if (await viewEmailGate(c, sc.p, null, null)) return c.json({ error: 'email verification required — 초대받은 이메일로 인증하세요.', email_auth_required: true, method: viewAuthMethod(c) }, 401)", ""],
};
const MUT = process.env.MUT || "";
let entry = path.join(ROOT, "src", "index.tsx");
if (MUT) {
  const m = MUTS[MUT];
  if (!m) { console.log("unknown MUT " + MUT); process.exit(3); }
  const dir = path.join(ROOT, ".tmp", "p163src-" + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, "src"), dir, { recursive: true });
  const f = path.join(dir, "index.tsx");
  const s = fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  if (!s.includes(m[0])) { console.log("MUT " + MUT + " 치환 대상 없음"); process.exit(3); }
  fs.writeFileSync(f, s.replace(m[0], m[1]));
  entry = f;
  console.log("[MUT=" + MUT + "]");
}

const workerOut = path.join(os.tmpdir(), "p163-worker-" + process.pid + ".mjs");
await esbuild.build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", outfile: workerOut, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent", conditions: ["workerd", "worker", "browser"] });

/* ── 외부 호출 어댑터(스텁) — Resend 캡처 · Firebase 공개키 ── */
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const spkiPem = "-----BEGIN CERTIFICATE-----\n" + publicKey.export({ type: "spki", format: "der" }).toString("base64").replace(/(.{64})/g, "$1\n") + "\n-----END CERTIFICATE-----\n";
const KID = "p163kid";
const outbox = [];
let outboundOther = 0;
const outbound = async (req) => {
  const u = new URL(req.url);
  if (u.hostname === "api.resend.com") { outbox.push(await req.json()); return new Response(JSON.stringify({ id: "re_p163" }), { status: 200, headers: { "content-type": "application/json" } }); }
  if (u.hostname === "www.googleapis.com" && u.pathname.includes("securetoken")) return new Response(JSON.stringify({ [KID]: spkiPem }), { headers: { "content-type": "application/json", "cache-control": "max-age=3600" } });
  outboundOther++;
  return new Response("blocked by p163 outbound stub", { status: 599 });
};
const b64u = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function fbToken(claims) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" }));
  const p = b64u(JSON.stringify(Object.assign({ iat: now, exp: now + 3600, auth_time: now, sub: "u" + crypto.randomBytes(4).toString("hex"), email_verified: true }, claims)));
  const sig = crypto.sign("RSA-SHA256", Buffer.from(h + "." + p), privateKey);
  return h + "." + p + "." + b64u(sig);
}

const SUPER = "sup@seastar.test";
async function boot(tag, extra) {
  const mf = new Miniflare({
    modules: true, scriptPath: workerOut, d1Databases: { DB: "p163" + tag + Date.now() }, r2Buckets: { R2: "p163r2" + tag + Date.now() },
    bindings: Object.assign({ DEMO_LOGIN: "0", AUTO_ENTRY_SECRET: "p163-signing-secret-0123456789abcdef", SUPER_ADMIN_EMAIL: SUPER, SUPER_ADMIN_EMAILS: SUPER }, extra),
    outboundService: outbound, compatibilityDate: "2025-01-01",
    serviceBindings: { ASSETS: () => new Response("<!doctype html><html><head><meta name=\"application-name\" content=\"V\"><title>x</title></head><body>shell</body></html>", { headers: { "content-type": "text/html" } }) },
  });
  const db = await mf.getD1Database("DB");
  for (const f of fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()) {
    for (const st of rd("migrations/" + f).replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean)) await db.exec(st);
  }
  const run = (q, a = []) => db.prepare(q).bind(...a).run();
  const all = async (q, a = []) => (await db.prepare(q).bind(...a).all()).results || [];
  const BASE = "http://p163.test";
  const api = async (tok, method, url, body, hdr) => {
    const headers = Object.assign({ "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7", "CF-IPCountry": "KR", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" }, tok ? { Authorization: "Bearer " + tok } : {}, hdr || {});
    const r = await mf.dispatchFetch(BASE + url, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    return { status: r.status, j, text };
  };
  const now = Date.now();
  const U = { o: "owner@seastar.test", d: "loose.designer@seastar.test", v: "logged.viewer@example.org" };
  const TOK = {};
  for (const k of Object.keys(U)) {
    if (k !== "v") await run("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, 'seed', ?, ?, 0)", [U[k], k, now, now]);
    await run("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, 'x', 'h', 's', 1, ?, ?, 0)", [U[k], k, now, now]);
    TOK[k] = "local-p163-" + k + "-" + crypto.randomBytes(6).toString("hex");
    await run("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOK[k], U[k], now, now + 8.64e7]);
  }
  const P = "prj_p163_" + tag, D = "dep_p163_" + tag;
  await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, 'P163', '', ?, ?, ?, 0)", [P, U.o, now, now]);
  const pins = [{ id: 1, x: 1, y: 1, page: 1, imageId: "img_p163_1", imageUrl: "/api/r2/object/pano/p163-a.jpg", no: 1 }, { id: 2, x: 2, y: 2, page: 1, videoUrl: "/api/r2/object/video/p163-b.mp4", no: 2 }];
  await run("INSERT INTO deployments (id, title, file_name, pins, zones, annotations, created_at, updated_at, deleted, version, project_id, tenant_id) VALUES (?, 'T', 'a.pdf', ?, '[]', '[]', ?, ?, 0, 1, ?, 'tnt_default')", [D, JSON.stringify(pins), now, now, P]);
  await run("INSERT INTO decks (id, project_id, name, deployment_id, created_at, updated_at, deleted) VALUES (?, ?, 'dk', ?, ?, ?, 0)", ["dk_p163_" + tag, P, D, now, now]);
  const pub = await api(TOK.o, "POST", "/api/projects/" + P + "/publish");
  const sp = pub.j && pub.j.project && pub.j.project.share_path;
  const tok = sp ? sp.replace(/^\/v\//, "") : null;
  return { mf, db, run, all, api, U, TOK, P, D, tok, pub };
}
const lastMailLink = async (to, n0) => {
  for (let i = 0; i < 40; i++) { const m = outbox.slice(n0).reverse().find((x) => x.to && x.to[0] === to); if (m) { const mm = String(m.text).match(/https?:\/\/\S+#va=([A-Za-z0-9_]+\.[a-f0-9]+)/); return mm ? { url: mm[0], ch: mm[1], mail: m } : { mail: m }; } await wait(50); }
  return null;
};
const waitRows = async (fn, cond) => { for (let i = 0; i < 40; i++) { const r = await fn(); if (cond(r)) return r; await wait(50); } return await fn(); };

/* ═══════════════ A. 서버 메일 수단(Resend 스텁) ═══════════════ */
{
  const A = await boot("a", { RESEND_API_KEY: "re_test_p163_not_real", FIREBASE_PROJECT_ID: "p163-fb" });
  const { api, run, all, TOK, P, D, tok } = A;
  console.log("\n[A0 새 링크 = 이메일 인증 기본 ON]");
  ok(A.pub.status === 200 && !!tok, "A0a 배포(publish) → 링크 발급", A.pub.status);
  const va0 = await api(TOK.o, "GET", "/api/projects/" + P + "/viewer-access");
  ok(va0.status === 200 && va0.j.email_auth === true && va0.j.method === "server", "A0b 🔴 새 링크 email_auth=true · 수단=server(RESEND 우선)", va0.j);
  {
    // 기존 링크 호환 — 이미 `?d=` 로 배포 중이던(published=1 · 공유 토큰 없음) 프로젝트가 다시 배포돼 처음 공유 토큰을 받아도 정책은 켜지지 않는다
    const t0 = Date.now(), LP = "prj_p163_legacy", LD = "dep_p163_legacy";
    await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted, published) VALUES (?, 'L', '', ?, ?, ?, 0, 1)", [LP, A.U.o, t0, t0]);
    await run("INSERT INTO deployments (id, title, file_name, pins, zones, annotations, created_at, updated_at, deleted, version, project_id, tenant_id) VALUES (?, 'T', 'a.pdf', '[]', '[]', '[]', ?, ?, 0, 1, ?, 'tnt_default')", [LD, t0, t0, LP]);
    await run("INSERT INTO decks (id, project_id, name, deployment_id, created_at, updated_at, deleted) VALUES ('dk_p163_legacy', ?, 'dk', ?, ?, ?, 0)", [LP, LD, t0, t0]);
    const oldTok = await api(null, "POST", "/api/auth/auto-entry", { kind: "viewer", d: LD });
    const rp = await api(TOK.o, "POST", "/api/projects/" + LP + "/publish");
    const vl = await api(TOK.o, "GET", "/api/projects/" + LP + "/viewer-access");
    const still = await api(oldTok.j && oldTok.j.token, "GET", "/tables/deployments/" + LD);
    ok(rp.status === 200 && vl.j.email_auth === false && vl.j.policy_set === false && oldTok.status === 200 && still.status === 200,
      "A0c 🔴 기존 링크(옛 ?d= 배포 중) 재배포 → 정책 OFF 유지 · 이미 받은 익명 통행증 200", { rp: rp.status, pol: vl.j, old: oldTok.status, still: still.status });
  }

  console.log("\n[A1 토큰만 — 재전달 무효]");
  const m1 = await api(null, "POST", "/api/auth/auto-entry", { kind: "viewer", v: tok });
  ok(m1.status === 401 && m1.j && m1.j.email_auth_required === true && !m1.j.token, "A1a 🔴 링크 토큰만으로 auto-entry → 401 email_auth_required(통행증 0)", m1);
  const m1d = await api(null, "POST", "/api/auth/auto-entry", { kind: "viewer", d: D });
  ok(m1d.status === 401 && !(m1d.j && m1d.j.token), "A1b 🔴 ?d=<배포본> 우회로도 401", m1d.status);
  await api(TOK.o, "PUT", "/api/projects/" + P + "/viewer-access", { email_auth: false });
  const anon = await api(null, "POST", "/api/auth/auto-entry", { kind: "viewer", v: tok });
  ok(anon.status === 200 && anon.j.token, "A1c 정책 OFF(기존 링크 호환) → 익명 통행증 200", anon.status);
  const g0 = await api(anon.j.token, "GET", "/tables/deployments/" + D);
  ok(g0.status === 200, "A1d 정책 OFF → 익명 열람 200(호환 유지)", g0.status);
  await api(TOK.o, "PUT", "/api/projects/" + P + "/viewer-access", { email_auth: true });
  const g1 = await api(anon.j.token, "GET", "/tables/deployments/" + D);
  ok(g1.status === 401 && g1.j && g1.j.email_auth_required === true, "A1e 🔴 정책 ON 후 기존 익명 통행증(재전달된 토큰) → 데이터 401", g1);
  const vshell = await api(null, "GET", "/v/" + tok);
  ok(vshell.status === 200 && !/P163/.test(vshell.text), "A1f /v 셸은 열린다(인증 화면을 띄울 곳) · 데이터 0", vshell.status);

  console.log("\n[A2 허용 목록]");
  const add = await api(TOK.o, "POST", "/api/projects/" + P + "/viewer-access/recipients", { emails: "Alice@Example.COM, bad-email ; bob@example.com" });
  ok(add.status === 200 && JSON.stringify(add.j.added) === JSON.stringify(["alice@example.com", "bob@example.com"]) && add.j.invalid.includes("bad-email"), "A2a 추가 — 소문자 정규화 · 형식 오류 분리", add.j);
  const add2 = await api(TOK.o, "POST", "/api/projects/" + P + "/viewer-access/recipients", { emails: ["ALICE@example.com"] });
  ok(add2.j.exists.includes("alice@example.com") && !add2.j.added.length, "A2b 대소문자만 다른 중복 → exists", add2.j);

  console.log("\n[A3 메일 요청 — 응답 동일 · 비밀 0 · 수신자에게만 발송]");
  const n0 = outbox.length;
  const sMem = await api(null, "POST", "/api/view-auth/start", { v: tok, email: "  ALICE@example.com " }, { "CF-Connecting-IP": "198.51.100.1" });
  const sNon = await api(null, "POST", "/api/view-auth/start", { v: tok, email: "eve@example.com" }, { "CF-Connecting-IP": "198.51.100.1" });
  ok(sMem.status === 200 && sNon.status === 200 && sMem.text === sNon.text, "A3a 🔴 수신자/비수신자 응답 바이트 동일", [sMem.text, sNon.text]);
  ok(Object.keys(sMem.j || {}).sort().join(",") === "message,method,ok" && !/va=|vac_|[a-f0-9]{32}/.test(sMem.text), "A3b 🔴 응답에 링크·비밀·코드 0(dev-fallback 없음)", sMem.text);
  const mailA = await lastMailLink("alice@example.com", n0);
  await wait(300);
  ok(!!(mailA && mailA.ch) && mailA.url.includes("/v/" + tok + "#va="), "A3c 수신자(정규화된 주소)에게만 1회용 링크 메일", mailA && mailA.mail && mailA.mail.to);
  ok(!outbox.slice(n0).some((m) => m.to && m.to[0] === "eve@example.com"), "A3d 비수신자에게는 발송 0", outbox.slice(n0).map((m) => m.to));
  const chRows = await all("SELECT email, email_hash, secret_hash FROM viewer_auth_challenges");
  ok(chRows.every((r) => r.email !== "eve@example.com") && chRows.every((r) => !r.secret_hash || !String(r.secret_hash).includes(mailA.ch.split(".")[1])), "A3e 비수신자 이메일 원문 저장 0 · 비밀은 해시만", chRows.length);

  console.log("\n[A4 메일 링크 완료 → 이메일 통행증]");
  const bad = await api(null, "POST", "/api/view-auth/complete", { v: tok, challenge: mailA.ch.split(".")[0] + ".deadbeef" });
  ok(bad.status === 401 && !bad.j.token, "A4a 위조 비밀 → 401", bad.status);
  const comp = await api(null, "POST", "/api/view-auth/complete", { v: tok, challenge: mailA.ch });
  ok(comp.status === 200 && comp.j.token && comp.j.email === "alice@example.com", "A4b 메일 링크 → 통행증(이메일=alice)", comp.j && { s: comp.status, e: comp.j.email });
  const again = await api(null, "POST", "/api/view-auth/complete", { v: tok, challenge: mailA.ch });
  ok(again.status === 401, "A4c 🔴 1회용 — 같은 링크 재사용 401", again.status);
  const pass = comp.j.token;
  const passPayload = JSON.parse(Buffer.from(pass.slice(4).split(".")[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
  ok(passPayload.e === "alice@example.com" && passPayload.ep === 0 && passPayload.k === "viewer" && passPayload.exp - Date.now() <= 7 * 864e5 + 5000, "A4d 통행증 = viewer + e·ep 서명 · 만료 ≤ 7일", passPayload);

  console.log("\n[A5 열람]");
  const g2 = await api(pass, "GET", "/tables/deployments/" + D, null, { "CF-Connecting-IP": "198.51.100.2" });
  ok(g2.status === 200 && g2.j && g2.j.id === D, "A5a 🔴 허용 이메일 인증 → 열람 200", g2.status);
  const me = await api(pass, "GET", "/api/auth/me");
  ok(me.j.authenticated && me.j.email === "" && me.j.readonly === true && me.j.role === "viewer", "A5b 세션 email 빈값(권한 fail-closed) · readonly", me.j);
  const w = await api(pass, "PATCH", "/tables/deployments/" + D, { title: "x" });
  ok(w.status === 403, "A5c 통행증 쓰기 403(readOnlyGuard 그대로)", w.status);

  console.log("\n[A6 이메일별 기록]");
  const ev = await api(pass, "POST", "/api/view-auth/event", { kind: "pin", target_id: "1", label: "P-1" });
  const evo = await api(pass, "POST", "/api/view-auth/event", { kind: "open" });
  const evx = await api(pass, "POST", "/api/view-auth/event", { kind: "drop table" });
  ok(ev.status === 200 && evo.status === 200 && evx.status === 400, "A6a 클라 기록(pin·open) 200 · 모르는 종류 400", [ev.status, evo.status, evx.status]);
  await A.mf.getR2Bucket("R2").then((b) => b.put("pano/p163-a.jpg", new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: "image/jpeg" } }));
  await A.mf.getR2Bucket("R2").then((b) => b.put("video/p163-b.mp4", new Uint8Array(64), { httpMetadata: { contentType: "video/mp4" } }));
  const ph = await api(pass, "GET", "/api/r2/object/pano/p163-a.jpg");
  const vd1 = await api(pass, "GET", "/api/r2/object/video/p163-b.mp4", null, { Range: "bytes=0-15" });
  const vd2 = await api(pass, "GET", "/api/r2/object/video/p163-b.mp4", null, { Range: "bytes=16-31" });
  const evRows = await waitRows(() => all("SELECT * FROM viewer_events WHERE email = 'alice@example.com' ORDER BY id"), (r) => ["auth", "zone", "pin", "open"].every((k) => r.some((x) => x.kind === k)));
  const kinds = evRows.map((r) => r.kind);
  ok(["auth_request", "auth", "zone", "pin", "open"].every((k) => kinds.includes(k)), "A6b 🔴 auth_request·auth·zone(구역)·pin·open 기록", kinds);
  const media = await waitRows(() => all("SELECT kind, target_id FROM viewer_events WHERE kind IN ('photo','video') ORDER BY id"), (r) => r.length >= 2);
  ok(ph.status === 200 && vd1.status === 206 && vd2.status === 206 && media.length === 2 && media[0].kind === "photo" && media[0].target_id === "pano/p163-a.jpg" && media[1].kind === "video" && media[1].target_id === "video/p163-b.mp4",
    "A6c 🔴 사진(200)·동영상(Range 206 ×2) 열람 → photo 1·video 1(Range 반복 dedupe)", { ph: ph.status, vd: [vd1.status, vd2.status], media });
  const zone = evRows.find((r) => r.kind === "zone");
  ok(zone && zone.target_id === D && zone.country === "KR" && /Windows · Chrome/.test(zone.device) && zone.ip_hash && zone.ip_hash.length === 22, "A6d 국가·기기 요약·IP 해시", zone);
  const allCells = JSON.stringify(await all("SELECT * FROM viewer_events")) + JSON.stringify(await all("SELECT * FROM viewer_auth_challenges"));
  ok(!/203\.0\.113\.7|198\.51\.100\.\d/.test(allCells) && !/Mozilla\/5\.0/.test(allCells), "A6e 🔴 원본 IP·원본 UA 저장 0", null);
  await api(pass, "GET", "/tables/deployments/" + D);
  const zoneN = (await all("SELECT COUNT(*) AS n FROM viewer_events WHERE kind = 'zone'"))[0].n;
  ok(zoneN === 1, "A6f 같은 구역 반복 열람 = 10분 1건(dedupe)", zoneN);
  const va1 = await api(TOK.o, "GET", "/api/projects/" + P + "/viewer-access");
  const ra = va1.j.recipients.find((r) => r.email === "alice@example.com");
  ok(ra && ra.status === "active" && ra.auths === 1 && ra.opens === 1 && ra.last_seen > 0 && ra.events >= 5, "A6g 디자이너 [열람자 기록] — 이메일별 최근 접속·횟수", ra);
  const tl = await api(TOK.o, "GET", "/api/projects/" + P + "/viewer-access/log?email=ALICE@example.com");
  ok(tl.status === 200 && tl.j.data.length >= 5 && tl.j.data.every((r) => r.email === "alice@example.com") && tl.j.data[0].ts >= tl.j.data[tl.j.data.length - 1].ts, "A6h 상세 타임라인(최신순 · 대소문자 무관 조회)", tl.j.data && tl.j.data.map((r) => r.kind));

  console.log("\n[A7 코멘트 작성자]");
  const nt = await api(pass, "POST", "/api/notes", { deployment_id: D, kind: "request", body: "확인 부탁", author: "가짜이름" }, { "CF-Connecting-IP": "198.51.100.3" });
  const nrow = nt.j && nt.j.id ? (await all("SELECT author, author_contact FROM pin_notes WHERE id = ?", [nt.j.id]))[0] : null;
  ok(nt.status === 200 && nrow && nrow.author === "alice@example.com" && nrow.author_contact === "alice@example.com", "A7a 🔴 작성자 = 인증 이메일(자기 신고 이름 무시)", { s: nt.status, nrow, err: nt.j && nt.j.error });

  console.log("\n[A8 차단 · 재초대]");
  const bl = await api(TOK.o, "POST", "/api/projects/" + P + "/viewer-access/recipients/" + encodeURIComponent("alice@example.com") + "/block");
  ok(bl.status === 200, "A8a 차단 200", bl.status);
  const g3 = await api(pass, "GET", "/tables/deployments/" + D);
  ok(g3.status === 401 && g3.j.email_auth_required === true, "A8b 🔴 차단 → 같은 통행증 즉시 401", g3);
  const n1 = outbox.length;
  const sBl = await api(null, "POST", "/api/view-auth/start", { v: tok, email: "alice@example.com" }, { "CF-Connecting-IP": "198.51.100.4" });
  await wait(300);
  ok(sBl.status === 200 && sBl.text === sNon.text && !outbox.slice(n1).length, "A8c 차단 이메일 메일 요청 → 같은 응답 · 발송 0", { s: sBl.status, sent: outbox.slice(n1).length });
  const ri = await api(TOK.o, "POST", "/api/projects/" + P + "/viewer-access/recipients/alice%40example.com/reinvite");
  ok(ri.status === 200 && ri.j.sent.includes("alice@example.com"), "A8d 재초대 → active + 초대 메일", ri.j);
  const g4 = await api(pass, "GET", "/tables/deployments/" + D);
  ok(g4.status === 401, "A8e 🔴 재초대 후에도 옛 통행증 401(세대 불일치)", g4.status);
  const inv = await lastMailLink("alice@example.com", n1);
  const comp2 = await api(null, "POST", "/api/view-auth/complete", { v: tok, challenge: inv && inv.ch });
  const g5 = await api(comp2.j && comp2.j.token, "GET", "/tables/deployments/" + D);
  ok(inv && /초대/.test(inv.mail.subject) && comp2.status === 200 && g5.status === 200, "A8f 초대 메일 링크 → 새 통행증 200", { c: comp2.status, g: g5.status });

  console.log("\n[A9 레이트리밋]");
  const ip = { "CF-Connecting-IP": "192.0.2.50" };
  const rs = [];
  for (let i = 0; i < 4; i++) rs.push(await api(null, "POST", "/api/view-auth/start", { v: tok, email: "bob@example.com" }, ip));
  const rn = [];
  for (let i = 0; i < 4; i++) rn.push(await api(null, "POST", "/api/view-auth/start", { v: tok, email: "mallory@example.com" }, { "CF-Connecting-IP": "192.0.2.51" }));
  ok(rs.slice(0, 3).every((r) => r.status === 200) && rs[3].status === 429, "A9a 🔴 이메일당 15분 3회 → 4번째 429", rs.map((r) => r.status));
  ok(rn[3].status === 429 && rn[3].text === rs[3].text, "A9b 비수신자도 같은 429(존재 비노출)", rn.map((r) => r.status));
  const ripr = [];
  for (let i = 0; i < 11; i++) ripr.push((await api(null, "POST", "/api/view-auth/start", { v: tok, email: "u" + i + "@example.net" }, { "CF-Connecting-IP": "192.0.2.99" })).status);
  ok(ripr.slice(0, 10).every((s) => s === 200) && ripr[10] === 429, "A9c 🔴 IP당 15분 10회 → 11번째 429", ripr);

  console.log("\n[A10 로그인 계정의 링크 열람(S1)]");
  const ref = { Referer: "http://p163.test/v/" + tok };
  const s1 = await api(TOK.v, "GET", "/tables/deployments/" + D, null, ref);
  ok(s1.status === 403 || s1.status === 404, "A10a 🔴 비수신자 로그인 계정 + 링크 Referer → 거부", s1.status);
  await api(TOK.o, "POST", "/api/projects/" + P + "/viewer-access/recipients", { emails: [A.U.v] });
  const s2 = await api(TOK.v, "GET", "/tables/deployments/" + D, null, ref);
  ok(s2.status === 200, "A10b 수신자 목록의 인증된 계정 이메일 → 200", s2.status);

  console.log("\n[A11 관리 권한]");
  const f1 = await api(TOK.d, "GET", "/api/projects/" + P + "/viewer-access");
  const f2 = await api(TOK.d, "POST", "/api/projects/" + P + "/viewer-access/recipients", { emails: ["x@example.com"] });
  const f3 = await api(comp2.j.token, "POST", "/api/projects/" + P + "/viewer-access/recipients", { emails: ["x@example.com"] });
  const f4 = await api(null, "GET", "/api/projects/" + P + "/viewer-access/log");
  ok(f1.status === 403 && f2.status === 403 && f3.status === 403 && f4.status === 403, "A11a 비멤버 디자이너·열람 통행증·익명 → 403", [f1.status, f2.status, f3.status, f4.status]);

  console.log("\n[A12 배포 취소]");
  const pass2 = comp2.j.token;
  const un = await api(TOK.o, "POST", "/api/projects/" + P + "/unpublish");
  const g6 = await api(pass2, "GET", "/tables/deployments/" + D);
  const v6 = await api(null, "GET", "/v/" + tok);
  const c6 = await api(null, "POST", "/api/view-auth/complete", { v: tok, challenge: "x.y" });
  ok(un.status === 200 && g6.status === 410 && v6.status === 410 && c6.status === 410, "A12a 🔴 배포 취소 → 통행증 410 · /v 410 · 인증 완료 410", [un.status, g6.status, v6.status, c6.status]);
  ok(outboundOther === 0, "A12b 외부 호출 = Resend 스텁·Firebase 키 외 0", outboundOther);
  await A.mf.dispose();
}

/* ═══════════════ B. Firebase 이메일 링크 수단 ═══════════════ */
{
  const FP = "p163-fb";
  const B = await boot("b", { FIREBASE_PROJECT_ID: FP });
  const { api, TOK, P, D, tok } = B;
  console.log("\n[B Firebase 수단]");
  await api(TOK.o, "POST", "/api/projects/" + P + "/viewer-access/recipients", { emails: ["Dan@Example.com"] });
  const n0 = outbox.length;
  const st = await api(null, "POST", "/api/view-auth/start", { v: tok, email: "dan@example.com" });
  await wait(200);
  ok(st.status === 200 && st.j.method === "firebase" && st.j.firebase_project === FP && outbox.length === n0, "B1 메일 요청 → method=firebase(클라가 발송) · 서버 발송 0", st.j);
  const iss = "https://securetoken.google.com/" + FP;
  const now = Math.floor(Date.now() / 1000);
  const c1 = await api(null, "POST", "/api/view-auth/complete", { v: tok, firebase_id_token: fbToken({ iss, aud: FP, email: "DAN@example.com" }) });
  ok(c1.status === 200 && c1.j.email === "dan@example.com", "B2 🔴 유효 Firebase ID 토큰(이메일 링크 로그인) → 통행증", c1.j && { s: c1.status, e: c1.j.email, err: c1.j.error });
  const g = await api(c1.j && c1.j.token, "GET", "/tables/deployments/" + D);
  ok(g.status === 200, "B3 열람 200", g.status);
  const bads = {
    unverified: fbToken({ iss, aud: FP, email: "dan@example.com", email_verified: false }),
    otherProject: fbToken({ iss: "https://securetoken.google.com/evil", aud: "evil", email: "dan@example.com" }),
    stale: fbToken({ iss, aud: FP, email: "dan@example.com", auth_time: now - 2 * 3600 }),
    forged: fbToken({ iss, aud: FP, email: "dan@example.com" }).replace(/\.[^.]+$/, ".AAAA"),
  };
  const rb = {};
  for (const k of Object.keys(bads)) rb[k] = (await api(null, "POST", "/api/view-auth/complete", { v: tok, firebase_id_token: bads[k] })).status;
  ok(Object.values(rb).every((s) => s === 401), "B4 🔴 미인증 이메일·타 프로젝트·오래된 로그인·서명 위조 → 401", rb);
  const nonm = await api(null, "POST", "/api/view-auth/complete", { v: tok, firebase_id_token: fbToken({ iss, aud: FP, email: "eve@example.com" }) });
  ok(nonm.status === 403 && nonm.j.not_invited === true && !nonm.j.token, "B5 🔴 소유 증명됐지만 비수신자 → 403(통행증 0)", nonm.status);
  await B.mf.dispose();
}

/* ═══════════════ C. 발송 수단 없음 ═══════════════ */
{
  const C = await boot("c", {});
  const { api, TOK, P, tok } = C;
  console.log("\n[C 수단 없음 — dev-fallback 금지]");
  await api(TOK.o, "POST", "/api/projects/" + P + "/viewer-access/recipients", { emails: ["dan@example.com"] });
  const st = await api(null, "POST", "/api/view-auth/start", { v: tok, email: "dan@example.com" });
  ok(st.status === 503 && st.j.no_mail_provider === true && !/va=|vac_|dev|code/i.test(JSON.stringify(Object.keys(st.j))), "C1 🔴 발송 수단 없음 → 503 · 사유 표시 · 코드/링크 0", st);
  const chN = (await C.all("SELECT COUNT(*) AS n FROM viewer_auth_challenges"))[0].n;
  ok(chN === 0, "C2 수단 없음 → 인증 시도 행 생성 0", chN);
  const cc = await api(null, "POST", "/api/view-auth/complete", { v: tok, challenge: "vac_x.y" });
  const ae = await api(null, "POST", "/api/auth/auto-entry", { kind: "viewer", v: tok });
  ok(cc.status === 401 && ae.status === 401 && ae.j.method === null, "C3 임의 challenge 401 · 토큰만 401(method=null)", [cc.status, ae.status, ae.j && ae.j.method]);
  await C.mf.dispose();
}

clearTimeout(watchdog);
console.log("\n" + (failed ? "FAIL " + failed : "ALL PASS"));
process.exit(failed ? 1 : 0);
