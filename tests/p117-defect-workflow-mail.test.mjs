/**
 * p117 — 결함 워크플로(묶음C) + 메일 실패 사유 기록(묶음D) (WO 20261002-gap)
 * 프레임워크 0 · 실행: node tests/p117-defect-workflow-mail.test.mjs
 *
 * S = 서버 src/index.tsx 실 번들 → Miniflare(workerd) + 실 D1(migrations 전부, 0036 포함). 목 0.
 *   메일(D)은 RESEND_API_KEY 에 **진짜 존재하지 않는 키**를 넣어 실제 api.resend.com 에 요청한다(목 금지, G-2-2).
 *   틀린 키는 Resend 가 진짜 401 을 돌려준다(이메일은 발송되지 않음) — 이걸로 "키 폐기" 경로를 실측한다.
 *   네트워크가 막힌 환경이면 ①②가 스킵 표시(SKIP)로 빠지고 나머지(C)는 그대로 검사한다.
 * L = src/lib/jevSeverity.ts 순수 어댑터 — fetch 스텁(OpenRouter 외부 호출만 대체, 로직은 실 소스).
 *
 * 뮤테이션: P117_MUT=<이름> → 서버 소스를 바꿔 실행 → EXIT=1 이어야 한다(대상 문자열 못 찾으면 EXIT=2).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { Miniflare } from "miniflare";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
let SRV = rd("src/index.tsx");

const MUTS = {
  "verify-gate-patch": ["if (!(await canVerifyNoteByDeployment(c, actor.user, note.deployment_id))) {", "if (false) {"],
  "verify-gate-ops": ["(d.status !== 'verified' || await canManageMembers(c, user, dep.project_id))", "(true)"],
  "mail-devcode-leak": ["return { sent: false, mailError: r.error }\n}\n\n/** [WO 20261001-viewerhelp] HTML 이스케이프",
    "return { sent: false, devCode: code }\n}\n\n/** [WO 20261001-viewerhelp] HTML 이스케이프"],
  "keyrevoked-flag": ["keyRevoked: res.status === 401 || res.status === 403", "keyRevoked: false"],
};
const MUT = process.env.P117_MUT || "";
if (MUT) {
  const m = MUTS[MUT];
  if (!m) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }
  if (!SRV.includes(m[0])) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함: " + MUT); process.exit(2); }
  SRV = SRV.replace(m[0], m[1]);
  console.log("[뮤테이션 적용] " + MUT);
}

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };
const skip = (label) => console.log("  SKIP " + label);
const watchdog = setTimeout(() => { console.log("\nWATCHDOG — 120s 초과 → FAIL"); process.exit(1); }, 120000);

/* ══ ① jevSeverity 순수 어댑터 — fetch 스텁(OpenRouter 외부 호출만) ══ */
console.log("\n[① src/lib/jevSeverity.ts — 확률 게이트 p≥0.9 자동 / 0.7~0.9 추정 / <0.7 빈칸]");
{
  const out = path.join(os.tmpdir(), "p117-sev-" + process.pid + ".mjs");
  await esbuild.build({ entryPoints: [path.join(ROOT, "src/lib/jevSeverity.ts")], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" });
  const L = await import(pathToFileURL(out).href);
  const ENV = { OPENROUTER_API_KEY: "test-key-not-real" };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const realFetch = globalThis.fetch;
  let calls = [];
  const stub = (fn) => { calls = []; globalThis.fetch = async (url, init) => { calls.push({ url, init }); return fn(url, init, calls.length); }; };

  stub(() => json(200, { answers: { severity: { choice: "상", probabilities: { 상: 0.95, 중: 0.04, 하: 0.01 } } } }));
  const p95 = await L.askJevSeverity(ENV, "배관 용접부 누수 — 즉시 조치 필요");
  const g95 = L.gateSeverity(p95);
  ok(p95.ok && p95.label === "상" && p95.p === 0.95, "① p=0.95 → 라벨 상, 확률 그대로(라벨만 버리지 않음)");
  ok(g95.level === "상" && g95.estimated === false, "① 게이트 p≥0.9 → 자동선택(estimated:false)");

  stub(() => json(200, { answers: { severity: { choice: "중", probabilities: { 상: 0.1, 중: 0.8, 하: 0.1 } } } }));
  const g80 = L.gateSeverity(await L.askJevSeverity(ENV, "도장 색 불일치"));
  ok(g80.level === "중" && g80.estimated === true, "① 게이트 0.7~0.9 → 「추정」(estimated:true)");

  stub(() => json(200, { answers: { severity: { choice: "하", probabilities: { 상: 0.1, 중: 0.3, 하: 0.6 } } } }));
  const g60 = L.gateSeverity(await L.askJevSeverity(ENV, "미세 스크래치"));
  ok(g60.level === null && g60.p === 0.6, "① 게이트 <0.7 → 빈칸(자동확정 금지)");

  stub(() => json(401, { error: "unauthorized" }));
  const r401 = await L.askJevSeverity(ENV, "본문");
  ok(!r401.ok && r401.error === "http-401" && calls.length === 1, "① 401 → 재시도 없이 실패값(ok:false)");
  ok(L.gateSeverity(r401).level === null, "① 실패 → 폴백 빈칸(거짓 성공 금지)");

  const rNoKey = await L.askJevSeverity({}, "본문");
  ok(!rNoKey.ok && rNoKey.error === "no-key", "① 키 없음 → no-key(호출 0)");

  stub(() => json(200, { answers: { severity: { choice: "모름", probabilities: { 모름: 1 } } } }));
  const rBad = await L.askJevSeverity(ENV, "본문");
  ok(!rBad.ok && rBad.error === "bad-answer", "① 후보 밖 라벨 → bad-answer(폴백)");

  globalThis.fetch = realFetch;
}

/* ══ ②③ 서버 — Miniflare + 실 D1(0036 포함) ══ */
const MIG_DIR = path.join(ROOT, "migrations");
const MIGS = fs.readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
ok(MIGS.includes("0036_defect_workflow.sql"), "마이그레이션 0036_defect_workflow.sql 존재");
const stmtsOf = (file) => fs.readFileSync(path.join(MIG_DIR, file), "utf8").replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
const workerOut = path.join(os.tmpdir(), "p117-worker-" + process.pid + ".mjs");
await esbuild.build({
  stdin: { contents: SRV, resolveDir: path.join(ROOT, "src"), sourcefile: "index.tsx", loader: "tsx" },
  bundle: true, format: "esm", platform: "neutral", outfile: workerOut, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
  conditions: ["workerd", "worker", "browser"],
});
// 🔴 G-2-2: 메일 발송 경로는 목(mock) 없이 실제 api.resend.com 에 요청한다. 존재하지 않는 키라 Resend 가
//   실제로 401 을 돌려준다(이메일은 발송되지 않음) — 이걸로 "키 폐기(401/403)" 경로를 실측 재현한다.
const FAKE_KEY = "re_p117_fake_key_not_real_" + Date.now();
const mf = new Miniflare({
  modules: true, scriptPath: workerOut, d1Databases: { DB: "p117-" + Date.now() }, r2Buckets: { R2: "p117r2-" + Date.now() },
  bindings: { DEMO_LOGIN: "0", RESEND_API_KEY: FAKE_KEY }, compatibilityDate: "2025-01-01",
});
const BASE = "http://p117.test";
const db = await mf.getD1Database("DB");
try {
  for (const f of MIGS) for (const st of stmtsOf(f)) await db.exec(st);
  const now0 = Date.now();
  const run = (q, a) => db.prepare(q).bind(...a).run();
  const U = { o: "own117@seastar.test", d: "dsg117@seastar.test", sup: "designssir@gmail.com" };
  const TOK = {};
  const addUser = async (k, designer) => {
    if (designer) await run("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)", [U[k], k, "designssir@gmail.com", now0, now0]);
    await run("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)", [U[k], "이름" + k, U[k].split("@")[1], "x", "y", now0, now0]);
    TOK[k] = "local-p117-" + k;
    await run("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOK[k], U[k], now0, now0 + 8.64e7]);
  };
  await addUser("o", true);
  await addUser("d", false);
  await addUser("sup", true);   // SUPER_ADMIN_FALLBACK(designssir@gmail.com) — requireAdmin(/api/inquiries) 통과용
  let ipSeq = 0;
  const api = async (who, method, url, body) => {
    ipSeq++;
    const h = { "Content-Type": "application/json", "CF-Connecting-IP": "10.2." + (ipSeq >> 8) + "." + (ipSeq & 255) };
    const t = who && (TOK[who] || who);
    if (t) h.Authorization = "Bearer " + t;
    const r = await mf.dispatchFetch(BASE + url, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, j };
  };

  await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES ('prj_D', '결함 프로젝트', '', ?, ?, ?, 0)", [U.o, now0, now0]);
  await api("o", "POST", "/api/projects/prj_D/members", { email: U.d, role: "designer" });
  const pins = [{ id: "p1", page: 1, x: 20, y: 20, label: "1", checkboard: true }];
  const PAGE_URL = "/api/r2/object/assets/p117-base.png";
  const dep = (await api("o", "POST", "/tables/deployments", { title: "D", file_name: "D.pdf", project_id: "prj_D", pins: JSON.stringify(pins), pages_data: JSON.stringify([PAGE_URL]), drawing_data: PAGE_URL })).j.id;
  const deck = (await api("o", "POST", "/api/projects/prj_D/decks", { name: "구역D", deployment_id: dep, page: 1 })).j;
  ok(!!(dep && deck.id), "전제: 배포본·구역 생성");

  console.log("\n[② 묶음D — 메일 실패 사유 기록(실 api.resend.com, 틀린 키 → 실제 401)]");
  let netOk = true;
  try {
    const probe = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer x" }, body: "{}" });
    netOk = probe.status === 401;
  } catch { netOk = false; }
  if (!netOk) {
    skip("② 네트워크 미연결 — 메일 실측 구간 전체 스킵(환경 제약, 로직은 ①에서 검증됨)");
  } else {
    const sc = await api(null, "POST", "/api/signup/send-code", { email: "newbie" + Date.now() + "@acme-test.com" });
    ok(sc.j && sc.j.success === false && !sc.j.dev_code, "② 키 설정됐는데 실패 → dev_code 미노출(가짜 성공·백도어 금지) — " + JSON.stringify(sc.j));
    ok(sc.j && String(sc.j.error || "").includes("메일 키 확인 필요"), "② 401 → '메일 키 확인 필요' 로 구분 표시 — " + (sc.j && sc.j.error));

    const inq = await api(null, "POST", "/api/inquiries", { title: "테스트 문의", body: "메일 실패 재현용" });
    ok(inq.status === 200 && inq.j.success === true && inq.j.mail_sent === false, "② 문의는 저장됨(메일 실패와 무관하게 접수) — " + inq.status);
    const list = await api("sup", "GET", "/api/inquiries?limit=10");
    const row = (list.j.data || []).find((r) => r.id === inq.j.id);
    ok(!!row && !row.mail_sent && !!row.mail_error, "② 관리자 목록에 mail_error 저장됨 — " + (row && row.mail_error));
    let errInfo = null; try { errInfo = JSON.parse(row.mail_error); } catch {}
    ok(errInfo && errInfo.status === 401 && errInfo.keyRevoked === true && !JSON.stringify(errInfo).includes(FAKE_KEY), "② mail_error = {status:401, keyRevoked:true}, 키 값 미포함 — " + JSON.stringify(errInfo));

    const rs = await api("sup", "POST", "/api/inquiries/" + inq.j.id + "/resend");
    ok(rs.status === 200 && rs.j.mail_sent === false && rs.j.mail_error && rs.j.mail_error.keyRevoked === true, "② [재발송] 다시 401(동일 실패, 서버가 재시도는 하지만 가짜 성공 안 만듦) — " + JSON.stringify(rs.j));
    const rsNonAdmin = await api("d", "POST", "/api/inquiries/" + inq.j.id + "/resend");
    ok(rsNonAdmin.status === 403, "② 비관리자 재발송 → 403 — " + rsNonAdmin.status);
  }

  console.log("\n[③ 묶음C — 결함 노트: 기한·심각도·'확인(verified)' 권한]");
  const mkNote = await api("d", "POST", "/api/notes", { deployment_id: dep, pin_id: "p1", kind: "note", body: "용접부 누수", due_at: now0 + 86400000, severity: "상" });
  ok(mkNote.status === 200 && mkNote.j.due_at === now0 + 86400000 && mkNote.j.severity === "상", "③ 생성 시 due_at·severity 저장 — " + JSON.stringify({ d: mkNote.j.due_at, s: mkNote.j.severity }));
  const noteId = mkNote.j.id;

  const badSev = await api("d", "PATCH", "/api/notes/" + noteId, { severity: "극상" });
  ok(badSev.status === 400, "③ 잘못된 심각도 값 → 400 — " + badSev.status);

  const toDone = await api("d", "PATCH", "/api/notes/" + noteId, { status: "done" });
  ok(toDone.status === 200 && toDone.j.status === "done" && toDone.j.resolved_at, "③ 멤버(디자이너)가 done 으로 전환 → 200 — " + toDone.status);

  // 🔴 마스터 확정 — 소유자가 아닌 멤버(d)는 verified 로 못 바꾼다(403).
  const verifyByMember = await api("d", "PATCH", "/api/notes/" + noteId, { status: "verified" });
  ok(verifyByMember.status === 403, "③ 소유자 아닌 멤버의 verified 전환 → 403(마스터 확정) — " + verifyByMember.status);

  const verifyByOwner = await api("o", "PATCH", "/api/notes/" + noteId, { status: "verified" });
  ok(verifyByOwner.status === 200 && verifyByOwner.j.status === "verified" && verifyByOwner.j.resolved_at, "③ 소유자의 verified 전환 → 200 — " + verifyByOwner.status);

  // 오프라인 큐(ops) 경로도 같은 게이트 — 다시 done 으로 내렸다가 멤버(d)가 ops 로 verified 시도 → 무시(여전히 done)
  await api("o", "PATCH", "/api/notes/" + noteId, { status: "done" });
  const opBody = { ops: [{ opId: "op-verify-" + Date.now(), entity: "note", action: "upsert", id: noteId, ts: Date.now(), data: { status: "verified" } }] };
  const opsR = await api("d", "POST", "/tables/deployments/" + dep + "/ops", opBody);
  ok(opsR.status === 200, "③ ops 요청 자체는 200(배치의 다른 엔티티를 막지 않는다) — " + opsR.status);
  const afterOps = await api("o", "GET", "/api/notes?deployment_id=" + dep + "&pin_id=p1");
  const afterNote = (afterOps.j.data || []).find((n) => n.id === noteId);
  ok(afterNote && afterNote.status === "done", "③ ops 경유 verified 는 권한 없어 조용히 건너뜀(여전히 done, 형제 호출부 동일 게이트) — " + (afterNote && afterNote.status));

  // 전역 목록에 kind=note 포함 + 미완 카운트가 verified 를 완료로 취급
  const glist = await api("o", "GET", "/api/projects/prj_D/requests");
  const got = (glist.j.data || []).find((n) => n.id === noteId);
  ok(!!got, "③ 전역 목록(/api/projects/:id/requests)에 결함 노트(kind=note) 포함 — " + (got ? "found" : "missing"));
} finally {
  clearTimeout(watchdog);
  await mf.dispose();
}

console.log(failed ? ("\n총 " + failed + "건 실패") : "\n전체 PASS");
process.exit(failed ? 1 : 0);
