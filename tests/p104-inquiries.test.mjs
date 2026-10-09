/**
 * p104 — 개발자 문의(POST /api/inquiries) 회귀 테스트
 * (프레임워크 0 · 실행: node tests/p104-inquiries.test.mjs)
 *
 * WO 20261001-viewerhelp: "뷰어로 배포된 모드에서도 도움말 기능 구현하고
 * 개발자 문의 노트도 추가해 designsir@seastargo.com"
 *
 * 검사:
 *  ① 비로그인(익명) POST → D1 저장 + success:true
 *  ② 열람전용(_readonly) 공유/배포 링크 세션도 POST 가능(403 아님) — readOnlyGuard 허용 경로 e2e 검증
 *  ③ 분당 레이트리밋 — 같은 IP 4번째 요청 429
 *  ④ 메일 발송 = Resend 호출을 테스트 하니스에서만 가로채 수신 주소가 SUPPORT_CONTACT_EMAIL(=
 *     designsir@seastargo.com) 인지 검증
 *  ⑤ HTML 이스케이프 — 제목/본문에 <script> 를 넣어도 메일 HTML 에는 이스케이프된 채로만 들어감
 *  ⑥ 제목/내용 미입력 400, 길이 상한 초과 400, 잘못된 회신 이메일 형식 400
 *  ⑦ 관리자(super) GET 목록 200 / 비관리자 GET 403
 *  ⑧ 관리자 PATCH 로 처리완료 체크 반영
 *  ⑨ 저장 실패(D1 예외) 시 "접수됨"으로 속이지 않고 500 정직 보고
 *
 * 🔴 목 금지 — 실제 Hono 앱(src/index.tsx)을 esbuild 로 번들해 실제 Request 로 구동한다.
 *   가짜는 D1 데이터스토어와 Resend 호출(fetch)뿐이다(핸들러·라우팅·인증체인은 전부 실 소스).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

async function buildWorker(srcOverride) {
  const outFile = path.join(os.tmpdir(), "p104-worker-" + process.pid + "-" + Date.now() + ".mjs");
  if (srcOverride) {
    const tmpSrc = path.join(os.tmpdir(), "p104-index-" + process.pid + "-" + Date.now() + ".tsx");
    fs.writeFileSync(tmpSrc, srcOverride, "utf8");
    // [lib] 상대경로 의존(./lib/util 등)을 그대로 쓰려면 원본 디렉터리에 심링크 대신 복사본을 둔다.
    // 🔴 [WO 20261002-gap] 매번 새로 복사한다 — os.tmpdir() 는 프로세스 간 공유 경로라, 새 lib 파일(예:
    //   jevSeverity.ts)이 추가돼도 "이미 존재"로 오판해 옛 복사본을 쓰면 esbuild 가 그 파일을 못 찾는다(실사고).
    const libDir = path.join(path.dirname(tmpSrc), "lib");
    fs.rmSync(libDir, { recursive: true, force: true });
    fs.cpSync(path.join(ROOT, "src/lib"), libDir, { recursive: true });
    await esbuild.build({
      entryPoints: [tmpSrc], bundle: true, format: "esm", platform: "node", outfile: outFile,
      jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
    });
    fs.unlinkSync(tmpSrc);
  } else {
    await esbuild.build({
      entryPoints: [path.join(ROOT, "src/index.tsx")], bundle: true, format: "esm", platform: "node", outfile: outFile,
      jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
    });
  }
  const mod = (await import("file://" + outFile.replace(/\\/g, "/"))).default;
  fs.unlinkSync(outFile);
  return mod;
}

function makeDB(state) {
  const like = (sql, s) => sql.replace(/\s+/g, " ").indexOf(s) >= 0;
  // [WO 20261009-readacl] 열람 토큰 발급은 배포 프로젝트의 구역 배포본 링크가 있어야 한다 — 살아있는 프로젝트·구역
  const linkAll = (q) => {
    if (like(q, "FROM projects WHERE deleted = 0")) return { results: state.projects || [] };
    if (like(q, "FROM decks WHERE deleted = 0 AND deployment_id IS NOT NULL")) return { results: state.decks || [] };
    return { results: [] };
  };
  return {
    prepare(sql) {
      const q = sql.replace(/\s+/g, " ").trim();
      return {
        bind(...a) {
          return {
            async first() {
              if (like(q, "FROM app_settings WHERE scope = '*' AND skey = ?"))
                return state.settings[a[0]] ? { value: state.settings[a[0]] } : null;
              if (like(q, "SELECT COUNT(*) AS n FROM inquiries WHERE ip = ?")) {
                const [ip, windowStart] = a;
                const n = state.inquiries.filter((r) => r.ip === ip && r.created_at > windowStart && !r.deleted).length;
                return { n };
              }
              if (like(q, "FROM local_sessions WHERE token = ?")) return state.sessions[a[0]] || null;
              if (like(q, "FROM local_users WHERE email = ?")) return state.localUsers[String(a[0]).toLowerCase()] || null;
              if (like(q, "FROM designers WHERE email = ?")) return null;
              // [WO 20261009-readacl] 열람 링크(?d=) 해석 — 배포본 행
              if (like(q, "FROM deployments WHERE id = ?")) return state.deployments[a[0]] || null;
              return null;
            },
            async all() {
              if (like(q, "FROM inquiries WHERE deleted = 0 ORDER BY created_at DESC")) {
                const limit = a[0];
                return { results: state.inquiries.filter((r) => !r.deleted).sort((x, y) => y.created_at - x.created_at).slice(0, limit) };
              }
              return linkAll(q);
            },
            async run() {
              if (like(q, "INSERT INTO app_settings")) {
                if (!state.settings[a[0]]) state.settings[a[0]] = a[1];
              } else if (like(q, "INSERT INTO inquiries")) {
                if (state.forceInsertFail) throw new Error("forced insert failure");
                const [id, created_at, title, body, reply_email, sender_email, project_name, deployment_id, mode, user_agent, app_version, ip] = a;
                state.inquiries.push({ id, created_at, title, body, reply_email, sender_email, project_name, deployment_id, mode, user_agent, app_version, ip, mail_sent: 0, resolved: 0, resolved_at: null, deleted: 0 });
              } else if (like(q, "UPDATE inquiries SET mail_sent = 1 WHERE id = ?")) {
                const row = state.inquiries.find((r) => r.id === a[0]); if (row) row.mail_sent = 1;
              } else if (like(q, "UPDATE inquiries SET resolved = ?")) {
                const [resolved, resolved_at, id] = a;
                const row = state.inquiries.find((r) => r.id === id); if (row) { row.resolved = resolved; row.resolved_at = resolved_at; }
              } else if (/^(INSERT|UPDATE|DELETE)/i.test(q)) {
                state.writes.push(q);
              }
              return { success: true };
            },
          };
        },
        async first() { return null; },
        async all() { return linkAll(q); },
        async run() { return { success: true }; },
      };
    },
    batch: async () => [],
  };
}

function freshState() {
  return { settings: {}, sessions: {}, localUsers: {}, inquiries: [], writes: [], forceInsertFail: false,
    // [WO 20261009-readacl] 공유/배포 링크(?d=dep_p104) 대상 — 배포된 프로젝트의 구역
    deployments: { dep_p104: { id: "dep_p104", project_id: "prj_p104", deleted: 0 } },
    projects: [{ id: "prj_p104", owner: "owner@seastar.test", published: 1 }],
    decks: [{ deployment_id: "dep_p104", project_id: "prj_p104", deleted: 0 }] };
}

const resendCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url) === "https://api.resend.com/emails") {
    resendCalls.push(JSON.parse(opts.body));
    return { ok: true, status: 200, text: async () => "ok" };
  }
  return realFetch(url, opts);
};

async function run(worker, state, env) {
  const req = (method, p, { token, body, host = "scan.seastar.work", ip } = {}) => {
    const h = { "Content-Type": "application/json", Host: host, Origin: "https://" + host };
    if (token) h.Authorization = "Bearer " + token;
    if (ip) h["CF-Connecting-IP"] = ip;
    return new Request("https://" + host + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  return async (method, p, opts) => {
    env.DB = makeDB(state);
    return await worker.fetch(req(method, p, opts), env, { waitUntil() {}, passThroughOnException() {} });
  };
}

const worker = await buildWorker();
let STATE = freshState();
const ENV = { DB: null, DEMO_LOGIN: "1", RESEND_API_KEY: "test-resend-key" };
let call = await run(worker, STATE, ENV);

/* ══ ① 비로그인 POST → 저장 + success ══ */
console.log("\n[① 비로그인 POST /api/inquiries]");
{
  const r = await call("POST", "/api/inquiries", { ip: "1.2.3.4", body: { title: "로그인 버튼이 안 보여요", body: "모바일에서 로그인 버튼을 찾을 수 없습니다." } });
  const j = await r.json();
  ok(r.status === 200 && j.success === true, "① 200 + success=true (실제 " + r.status + ")");
  ok(STATE.inquiries.length === 1, "① D1 행 1건 생성 (실제 " + STATE.inquiries.length + "건)");
  ok(STATE.inquiries[0].sender_email == null, "① 비로그인 → sender_email NULL");
}

/* ══ ② 열람전용 세션도 POST 가능(403 아님) ══ */
console.log("\n[② 공유/배포 링크 열람전용 세션도 문의 제출 가능]");
{
  const mint = await call("POST", "/api/auth/auto-entry", { ip: "9.9.9.9", body: { kind: "viewer", d: "dep_p104" } });
  const mj = await mint.json();
  ok(mj.readonly === true, "② 발급 토큰 readonly=true (사전조건)");
  const r = await call("POST", "/api/inquiries", { ip: "9.9.9.9", token: mj.token, body: { title: "핀이 안 눌려요", body: "360 핀을 눌러도 반응이 없습니다." } });
  ok(r.status !== 403, "② 열람전용 토큰 POST 가 403 으로 막히지 않음 (실제 " + r.status + ")");
  const j = await r.json();
  ok(j.success === true, "② 저장 성공");
}

/* ══ ③ 레이트리밋 — 같은 IP 4번째 429 ══ */
console.log("\n[③ 레이트리밋: IP 당 분당 3건]");
{
  const ip = "5.5.5.5";
  const results = [];
  for (let i = 0; i < 4; i++) {
    const r = await call("POST", "/api/inquiries", { ip, body: { title: "문의 " + i, body: "내용 " + i } });
    results.push(r.status);
  }
  ok(results[0] === 200 && results[1] === 200 && results[2] === 200, "③ 1~3번째 성공: " + results.slice(0, 3).join(","));
  ok(results[3] === 429, "③ 4번째 429 (실제 " + results[3] + ")");
}

/* ══ ④ Resend 수신 주소 = SUPPORT_CONTACT_EMAIL ══ */
console.log("\n[④ 메일 발송 수신 주소 검증(Resend 호출 가로채기)]");
{
  ok(resendCalls.length > 0, "④ Resend 호출이 가로채짐 (" + resendCalls.length + "건)");
  const last = resendCalls[resendCalls.length - 1];
  ok(Array.isArray(last.to) && last.to.includes("designsir@seastargo.com"), "④ 수신 주소 = designsir@seastargo.com (실제 " + JSON.stringify(last.to) + ")");
}

/* ══ ⑤ HTML 이스케이프 ══ */
console.log("\n[⑤ HTML 이스케이프 — <script> 주입 방어]");
{
  const ip = "7.7.7.7";
  const payload = { title: "<script>alert(1)</script>", body: "본문에도 <img src=x onerror=alert(2)> 삽입 시도" };
  const r = await call("POST", "/api/inquiries", { ip, body: payload });
  const j = await r.json();
  ok(r.status === 200 && j.success, "⑤ 저장은 성공 (원문 그대로 DB 보관, 표시 시점에 escape)");
  const mail = resendCalls[resendCalls.length - 1];
  ok(!mail.html.includes("<script>alert(1)</script>"), "⑤ 메일 HTML 에 원문 <script> 태그가 그대로 들어가지 않음");
  ok(mail.html.includes("&lt;script&gt;"), "⑤ 메일 HTML 에 이스케이프된 형태로 들어감");
}

/* ══ ⑥ 유효성 검사 ══ */
console.log("\n[⑥ 입력 유효성 검사]");
{
  const ip = "8.8.8.8";
  const r1 = await call("POST", "/api/inquiries", { ip, body: { title: "", body: "" } });
  ok(r1.status === 400, "⑥ 제목/내용 미입력 400 (실제 " + r1.status + ")");
  const r2 = await call("POST", "/api/inquiries", { ip: "8.8.8.9", body: { title: "x".repeat(300), body: "ok" } });
  ok(r2.status === 400, "⑥ 제목 200자 초과 400 (실제 " + r2.status + ")");
  const r3 = await call("POST", "/api/inquiries", { ip: "8.8.8.10", body: { title: "ok", body: "x".repeat(5000) } });
  ok(r3.status === 400, "⑥ 본문 4000자 초과 400 (실제 " + r3.status + ")");
  const r4 = await call("POST", "/api/inquiries", { ip: "8.8.8.11", body: { title: "ok", body: "ok", reply_email: "not-an-email" } });
  ok(r4.status === 400, "⑥ 잘못된 회신 이메일 형식 400 (실제 " + r4.status + ")");
}

/* ══ ⑦ 관리자 목록 조회 ══ */
console.log("\n[⑦ 관리자 문의 목록]");
{
  const forbidden = await call("GET", "/api/inquiries", {});
  ok(forbidden.status === 403, "⑦ 비로그인 GET 403 (실제 " + forbidden.status + ")");
  const r = await call("GET", "/api/inquiries", { token: "demo-super" });
  const j = await r.json();
  ok(r.status === 200 && Array.isArray(j.data) && j.data.length === STATE.inquiries.length, "⑦ super 목록 조회 200, 건수 일치(" + j.data.length + "/" + STATE.inquiries.length + ")");
}

/* ══ ⑧ 처리완료 체크 ══ */
console.log("\n[⑧ 관리자 PATCH 처리완료]");
{
  const target = STATE.inquiries[0].id;
  const r = await call("PATCH", "/api/inquiries/" + target, { token: "demo-super", body: { resolved: true } });
  ok(r.status === 200, "⑧ PATCH 200 (실제 " + r.status + ")");
  const row = STATE.inquiries.find((x) => x.id === target);
  ok(row.resolved === 1 && !!row.resolved_at, "⑧ D1 상태 반영: resolved=" + row.resolved);
}

/* ══ ⑨ 저장 실패 시 정직 보고(500, 접수됨으로 속이지 않음) ══ */
console.log("\n[⑨ D1 저장 실패 시 접수됨으로 속이지 않음]");
{
  STATE.forceInsertFail = true;
  const before = STATE.inquiries.length;
  const r = await call("POST", "/api/inquiries", { ip: "6.6.6.6", body: { title: "ok", body: "ok" } });
  const j = await r.json();
  ok(r.status === 500 && j.success !== true, "⑨ 저장 실패 → 500 + success 아님 (실제 " + r.status + ", success=" + j.success + ")");
  ok(STATE.inquiries.length === before, "⑨ 행 추가 안 됨");
  STATE.forceInsertFail = false;
}

/* ──────────────────────────────────────────────────────────────
 * 뮤테이션: 레이트리밋 임계값 체크를 제거 → ③이 실패해야 함
 * ────────────────────────────────────────────────────────────── */
console.log("\n[뮤테이션] 레이트리밋 조건 제거 → ③(4번째 429)이 실패해야 함");
{
  const src = fs.readFileSync(path.join(ROOT, "src/index.tsx"), "utf8");
  // [WO 20261001-viewreq] 레이트리밋 조회가 공용 헬퍼(overRateLimit — 열람자 요청과 공유)로 이동 → 같은 판정 지점을 끊는다
  const needle = "if (await overRateLimit(c, 'inquiries', limiterKey, INQUIRY_RATE_LIMIT_PER_MIN)) {";
  if (!src.includes(needle)) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mutated = src.replace(needle, "if (false) {");
    const mWorker = await buildWorker(mutated);
    const mState = freshState();
    const mEnv = { DB: null, DEMO_LOGIN: "1", RESEND_API_KEY: "test-resend-key" };
    const mCall = await run(mWorker, mState, mEnv);
    const ip = "3.3.3.3";
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await mCall("POST", "/api/inquiries", { ip, body: { title: "t" + i, body: "b" + i } })).status);
    ok(results[3] !== 429, "뮤테이션 적용 시 레이트리밋이 깨짐(테스트 실효성 증명) → 4번째 상태=" + results[3]);
  }
}

globalThis.fetch = realFetch;
console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
