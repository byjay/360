/**
 * p68 — 허락되지 않은 회사 리젝트 (초대코드 + 회사명 게이트)
 * (프레임워크 0 · 실행: node tests/p68-share-gate-company.test.mjs)
 *
 * 마스터 지시(2026-09-28): "링크를 제공할때는 회사이름과 이름을 입력하게 하고 그 이름이 맞지 않다면
 *   리젝트해 / 허락되지 않은 회사이면 리젝트해 / designsir@seastargo.com 에게 다시 링크 요청을 하라고해"
 *
 * 판정 순서(src/lib/jev.ts decideCompanyGate 가 정본):
 *   ① 코드 해시 검증 → ② 코드에 company 없으면 통과 → ③ 규칙(정규화 정확일치) 통과 시 Jev 미호출
 *   → ④ 규칙 실패 시에만 Jev 1회(p>=0.90 통과 / p<=0.10 리젝트 / 사이는 **보류**)
 *   → ⑤ Jev 실패 = 폴백 리젝트(🔴 catch 로 삼켜 통과시키지 않는다)
 *
 * 🔴 목 금지 규율: **판정 로직을 목으로 대체하지 않는다.** decideCompanyGate 는 실 소스를 그대로 돌리고,
 *   주입하는 것은 네트워크 경계(`ask`)뿐이다. 라우트 검증은 실제 Hono 앱(src/index.tsx)을 번들해
 *   실 Request 로 구동하고, 가짜는 D1 저장소·ASSETS 바인딩뿐이다(해시·인증체인·핸들러는 전부 실 소스).
 *
 *  [A] 판정 순서 — 실 함수
 *   A1 company NULL → 통과 + Jev 미호출 (기존 링크 무손상)
 *   A2 정규화 정확일치 → 통과 + 🔴 Jev 미호출 증명(호출수 0)
 *   A3 규칙실패 + p=0.95 → 통과(추정통과, 감사에 p 기록)
 *   A4 규칙실패 + p=0.05 → 리젝트
 *   A5 규칙실패 + p=0.75 → 🔴 pending (통과도 리젝트도 아니다)
 *   A6 Jev 에러 → 리젝트 + applied:false / verdict:'fallback'
 *   A7 Jev throw → 동일(삼키는 catch 금지)
 *   A8 빈 소속 입력 → 규칙 일치 아님(빈값이 모든 회사와 같아지지 않는다)
 *   A9 임계값 경계 p=0.90 통과 / p=0.10 리젝트 + 임계값 상수 SoT
 *  [B] 실 라우트
 *   B1 company 미지정 코드 → 200 (현행 동작 보존)
 *   B2 company 지정 + 일치 → 200, 로그에 gate_reason='rule-exact', jev.applied=false
 *   B3 company 지정 + 다른 회사(키 없음 → 폴백) → 403 + 재요청처 안내 + share.denied 로그
 *   B4 발급 API 가 company 저장 · 목록 API 가 반환
 *   B5 🔴 순서 유지 — 회사명이 맞아도 코드가 틀리면 403 (코드 검증이 먼저다)
 *  [C] 뮤테이션 3건 — ⓐ임계값 제거→A4 ⓑpending→통과→A5 ⓒ에러시 통과→A6
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
// [WO 20261012-viewlink] 열람 링크 = 배포 스냅샷(0044) — 가짜 저장소에 스냅샷 행 저장을 붙인다(SoT tests/_lib/fake-snapshot.mjs)
import { snapFirst, snapAll, snapRun, snapBatch } from "./_lib/fake-snapshot.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };
const mustPatch = (before, after, what) => {
  if (before === after) { console.log("  FAIL 뮤테이션 패치 대상을 찾지 못함: " + what); failed++; return false; }
  return true;
};

const SUPPORT = "designsir@seastargo.com";
const DEV_GMAILS = ["designssir@gmail.com", "designsir101@gmail.com"];

/* ══ 실 소스 로더(뮤테이션은 tmp 사본에 문자열 치환 — 원본 파일은 건드리지 않는다) ══ */
let seq = 0;
async function bundle(entry, patches = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p68-src-"));
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  // 🔴 src/lib/*.ts 를 손목록으로 적지 않는다 — 새 lib 파일이 추가되면 조용히 번들이 깨진다.
  const files = { "index.tsx": rd("src/index.tsx") };
  for (const f of fs.readdirSync(path.join(ROOT, "src/lib"))) if (/\.tsx?$/.test(f)) files["lib/" + f] = rd("src/lib/" + f);
  for (const p of patches) {
    const cur = files[p.file];
    const next = cur.replace(p.from, p.to);
    if (!mustPatch(cur, next, p.file + " :: " + String(p.from).slice(0, 60))) return null;
    files[p.file] = next;
  }
  for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), body, "utf8");
  const out = path.join(os.tmpdir(), `p68-out-${process.pid}-${seq++}.mjs`);
  await esbuild.build({
    entryPoints: [path.join(dir, entry)], bundle: true, format: "esm", platform: "node",
    outfile: out, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
    absWorkingDir: ROOT, nodePaths: [path.join(ROOT, "node_modules")],
  });
  const mod = await import("file://" + out.replace(/\\/g, "/"));
  fs.unlinkSync(out); fs.rmSync(dir, { recursive: true, force: true });
  return mod;
}
const loadJev = (patches = []) => bundle("lib/jev.ts", patches);
const loadWorker = async (patches = []) => { const m = await bundle("index.tsx", patches); return m && m.default; };

/** ask 주입 헬퍼 — 네트워크 경계만 대체하고 호출 횟수를 센다(§Jev 미호출 증명용). */
function probe(result) {
  const spy = { calls: 0, args: [] };
  const ask = async (a, b) => {
    spy.calls++; spy.args.push([a, b]);
    if (typeof result === "function") return result(a, b);
    return result;
  };
  return { ask, spy };
}

/* ══════════════════════════════ [A] 판정 순서 ══════════════════════════════ */
const jev = await loadJev();
if (!jev) { console.log("\n[FATAL] src/lib/jev.ts 번들 실패"); process.exit(1); }
const { decideCompanyGate, COMPANY_GATE_PASS_P, COMPANY_GATE_REJECT_P } = jev;

console.log("\n[A1 company NULL → 통과 (기존 코드·기존 링크 무손상)]");
for (const allowed of [null, undefined, "", "   "]) {
  const { ask, spy } = probe({ ok: true, p: 0.0 });
  const r = await decideCompanyGate({ allowed, input: "아무회사", ask });
  ok(r.verdict === "pass", `A1 allowed=${JSON.stringify(allowed)} → pass (실제 ${r.verdict})`);
  ok(r.jev === null, "A1 감사에 jev=null (회사 검사 자체가 없었음을 구분해 기록)");
  ok(spy.calls === 0, "A1 🔴 Jev 호출 0회 (실제 " + spy.calls + ")");
}

console.log("\n[A2 규칙 정확일치 → 통과 + 🔴 Jev 미호출]");
for (const input of ["한라ENS", "(주)한라ENS", "주식회사 한라ENS", "한라ens(주)", " 한라 ENS "]) {
  const { ask, spy } = probe({ ok: true, p: 0.0 });   // Jev 가 불리면 리젝트가 나올 값을 심어둔다
  const r = await decideCompanyGate({ allowed: "한라ENS", input, ask });
  ok(r.verdict === "pass" && r.reason === "rule-exact", `A2 '${input}' → pass/rule-exact (실제 ${r.verdict}/${r.reason})`);
  ok(spy.calls === 0, "A2 🔴 규칙이 답을 냈으므로 Jev 호출 0회 (실제 " + spy.calls + ")");
  ok(r.jev && r.jev.applied === false && r.jev.p === null, "A2 감사: applied=false, p=null → " + JSON.stringify(r.jev));
}

console.log("\n[A3 규칙실패 + p=0.95 → 통과(추정)]");
{
  const { ask, spy } = probe({ ok: true, p: 0.95 });
  const r = await decideCompanyGate({ allowed: "한라ENS", input: "HANLA ENS", ask });
  ok(r.verdict === "pass", "A3 verdict=pass (실제 " + r.verdict + ")");
  ok(spy.calls === 1, "A3 규칙이 못 잡았으므로 Jev 1회 호출 (실제 " + spy.calls + ")");
  ok(spy.args[0][0] === "한라ENS" && spy.args[0][1] === "HANLA ENS", "A3 등록명·입력값을 그대로 넘긴다 → " + JSON.stringify(spy.args[0]));
  ok(r.jev.applied === true && r.jev.p === 0.95 && r.jev.threshold === 0.9 && r.jev.verdict === "pass",
     "A3 🔴 감사에 확률·임계값 기록 → " + JSON.stringify(r.jev));
}

console.log("\n[A4 규칙실패 + p=0.05 → 리젝트]");
{
  const { ask } = probe({ ok: true, p: 0.05 });
  const r = await decideCompanyGate({ allowed: "한라ENS", input: "삼성중공업", ask });
  ok(r.verdict === "reject", "A4 verdict=reject (실제 " + r.verdict + ")");
  ok(r.reason === "company-mismatch", "A4 사유 기록 → " + r.reason);
  ok(r.jev.applied === true && r.jev.p === 0.05 && r.jev.verdict === "reject", "A4 감사 → " + JSON.stringify(r.jev));
}

console.log("\n[A5 🔴 규칙실패 + p=0.75 → pending (통과도 리젝트도 아니다)]");
for (const p of [0.11, 0.5, 0.75, 0.89]) {
  const { ask } = probe({ ok: true, p });
  const r = await decideCompanyGate({ allowed: "한라ENS", input: "한라이엔에스인터내셔널", ask });
  ok(r.verdict === "pending", `A5 p=${p} → pending (실제 ${r.verdict})`);
  ok(r.verdict !== "pass", `A5 🔴 p=${p} 는 자동 통과가 아니다`);
  ok(r.jev.verdict === "pending" && r.jev.p === p, "A5 감사에 보류와 확률 기록 → " + JSON.stringify(r.jev));
}

console.log("\n[A6 Jev 에러 → 폴백 리젝트 + applied:false]");
for (const err of [{ ok: false, error: "no-key" }, { ok: false, error: "http-500" }, { ok: false, error: "timeout" },
                   { ok: true, p: 1.7 }, { ok: true, p: NaN }, { ok: true, p: undefined }]) {
  const { ask } = probe(err);
  const r = await decideCompanyGate({ allowed: "한라ENS", input: "HANLA ENS", ask });
  ok(r.verdict === "reject", `A6 ${JSON.stringify(err)} → reject (실제 ${r.verdict})`);
  ok(r.jev.applied === false && r.jev.verdict === "fallback" && r.jev.p === null,
     "A6 🔴 Jev 미적용이었음을 기록(거짓 성공 금지) → " + JSON.stringify(r.jev));
}

console.log("\n[A7 Jev throw → 동일 폴백(삼키는 catch 금지)]");
{
  const r = await decideCompanyGate({ allowed: "한라ENS", input: "HANLA ENS", ask: async () => { throw new Error("boom"); } });
  ok(r.verdict === "reject", "A7 throw 도 reject (실제 " + r.verdict + ")");
  ok(r.jev.verdict === "fallback", "A7 감사 verdict=fallback → " + JSON.stringify(r.jev));
}

console.log("\n[A8 빈 소속 입력은 규칙 일치가 아니다]");
{
  const { ask, spy } = probe({ ok: true, p: 0.0 });
  const r = await decideCompanyGate({ allowed: "한라ENS", input: "", ask });
  ok(spy.calls === 1 && r.verdict === "reject", "A8 빈 입력 → 규칙 불일치 → Jev 경유 → reject (실제 " + r.verdict + ")");
  const { ask: ask2, spy: spy2 } = probe({ ok: true, p: 0.0 });
  const r2 = await decideCompanyGate({ allowed: "!!!", input: "???", ask: ask2 });
  ok(r2.verdict !== "pass", "A8 🔴 기호뿐인 값끼리 정규화 후 빈 문자열이 되어도 통과하지 않는다 (실제 " + r2.verdict + ")");
  ok(spy2.calls === 1, "A8 기호뿐인 값도 규칙 통과가 아니다 → Jev 로 넘어간다");
}

console.log("\n[A9 임계값 경계 + 상수 SoT]");
{
  ok(COMPANY_GATE_PASS_P === 0.9, "A9 통과 임계값 0.90 (실제 " + COMPANY_GATE_PASS_P + ")");
  ok(COMPANY_GATE_REJECT_P === 0.1, "A9 리젝트 임계값 0.10 (실제 " + COMPANY_GATE_REJECT_P + ")");
  const at = async (p) => (await decideCompanyGate({ allowed: "한라ENS", input: "HANLA ENS", ask: probe({ ok: true, p }).ask })).verdict;
  ok((await at(0.9)) === "pass", "A9 p=0.90 경계 포함 → pass");
  ok((await at(0.1)) === "reject", "A9 p=0.10 경계 포함 → reject");
  ok((await at(0.9 - 1e-9)) === "pending", "A9 p=0.90 직전 → pending");
  // 🔴 index.tsx 가 자기 임계값을 따로 들고 있으면 SoT 분열이다 — jev.ts 상수만 쓰는지 확인
  const idx = rd("src/index.tsx");
  ok(idx.includes("COMPANY_GATE_PASS_P") && !/0\.90?\s*\)?\s*\?\s*'pass'/.test(idx),
     "A9 라우트가 임계값을 하드코딩하지 않고 jev.ts 상수를 쓴다");
  ok(!/OPENROUTER_API_KEY\s*=\s*['"]/.test(idx) && !/sk-or-/.test(idx + rd("src/lib/jev.ts")),
     "A9 🔴 소스에 API 키 리터럴 0 (시크릿만 사용)");
}

/* ══════════════════════════ [B] 실 라우트 검증 ══════════════════════════ */
const PID = "prj_c1";
const DEP = "dep_c1";
function freshState() {
  return {
    settings: {},
    sessions: { "local-super-tok": { email: "designssir@gmail.com", expires_at: Date.now() + 8.64e7, revoked: 0 } },
    localUsers: { "designssir@gmail.com": { email: "designssir@gmail.com", name: "마스터", deleted: 0, must_change_password: 0 } },
    designers: new Set(),
    projects: { [PID]: { id: PID, name: "선각 A동", owner: "designssir@gmail.com", created_at: 1, updated_at: 1, published: 1, published_at: 1, published_by: "x", subdomain: null, share_token: null, deleted: 0 } },
    decks: [{ id: "dck1", project_id: PID, deployment_id: DEP, level_no: 1, created_at: 1, deleted: 0 }],
    deployments: { [DEP]: { id: DEP, project_id: PID, pins: "[]", zones: "[]", annotations: "[]", version: 3, deleted: 0, tenant_id: null, name: "T", created_at: 1, updated_at: 1 } },
    codes: [], logs: [], writes: [],
  };
}
function makeDB(state) {
  const like = (q, s) => q.indexOf(s) >= 0;
  return {
    prepare(sql) {
      const q = sql.replace(/\s+/g, " ").trim();
      const exec = (a) => ({
        async first() {
          { const __s = snapFirst(state, q, a); if (__s !== undefined) return __s; }
          if (like(q, "FROM app_settings WHERE scope = '*' AND skey = ?")) return state.settings[a[0]] ? { value: state.settings[a[0]] } : null;
          if (like(q, "FROM local_sessions WHERE token = ?")) return state.sessions[a[0]] || null;
          if (like(q, "FROM local_users WHERE email = ?")) return state.localUsers[String(a[0]).toLowerCase()] || null;
          if (like(q, "FROM designers WHERE email = ?")) return state.designers.has(String(a[0]).toLowerCase()) ? { email: a[0], deleted: 0 } : null;
          if (like(q, "FROM tenant_members WHERE email = ?")) return null;
          if (like(q, "FROM deployments WHERE id = ?")) return state.deployments[a[0]] || null;
          if (like(q, "SELECT COUNT(*) AS n FROM project_share_codes")) {
            const now = a[1];
            return { n: state.codes.filter((c) => c.project_id === a[0] && !c.revoked && (!c.expires_at || c.expires_at > now)).length };
          }
          if (like(q, "FROM project_share_codes WHERE project_id = ? AND code_hash = ?"))
            return state.codes.find((c) => c.project_id === a[0] && c.code_hash === a[1]) || null;
          if (like(q, "FROM project_share_codes WHERE id = ?")) return state.codes.find((c) => c.id === a[0]) || null;
          if (like(q, "SELECT share_token FROM projects WHERE id = ?")) { const p = state.projects[a[0]]; return p ? { share_token: p.share_token } : null; }
          if (like(q, "FROM projects WHERE share_token = ? AND deleted = 0")) {
            const p = Object.values(state.projects).find((x) => !x.deleted && x.share_token && x.share_token === a[0]);
            return p ? { id: p.id, name: p.name, share_token: p.share_token, published: p.published } : null;
          }
          if (like(q, "SELECT id, name FROM projects WHERE id = ?")) { const p = state.projects[a[0]]; return p ? { id: p.id, name: p.name } : null; }
          if (like(q, "FROM projects WHERE id = ?")) return state.projects[a[0]] || null;
          if (like(q, "SELECT COUNT(*) AS n FROM decks WHERE project_id = ?")) return { n: state.decks.filter((d) => d.project_id === a[0] && !d.deleted && d.deployment_id).length };
          if (like(q, "SELECT deployment_id FROM decks WHERE project_id = ?")) {
            const d = state.decks.find((x) => x.project_id === a[0] && !x.deleted && x.deployment_id);
            return d ? { deployment_id: d.deployment_id } : null;
          }
          if (like(q, "SELECT project_id FROM decks WHERE deployment_id = ?")) {
            const d = state.decks.find((x) => x.deployment_id === a[0] && !x.deleted);
            return d ? { project_id: d.project_id } : null;
          }
          return null;
        },
        async all() {
          { const __s = snapAll(state, q, a); if (__s !== undefined) return __s; }
          if (like(q, "SELECT project_id FROM decks WHERE deployment_id = ?"))
            return { results: state.decks.filter((d) => d.deployment_id === a[0] && !d.deleted).map((d) => ({ project_id: d.project_id })) };
          if (like(q, "FROM project_share_codes WHERE project_id = ?")) return { results: state.codes.filter((c) => c.project_id === a[0]) };
          if (like(q, "FROM projects WHERE deleted = 0")) return { results: Object.values(state.projects).filter((p) => !p.deleted) };
          if (like(q, "FROM decks")) return { results: state.decks.filter((d) => !d.deleted) };
          return { results: [] };
        },
        async run() {
          { const __s = snapRun(state, q, a); if (__s !== undefined) return __s; }
          if (like(q, "INSERT INTO app_settings")) { if (!state.settings[a[0]]) state.settings[a[0]] = a[1]; return { success: true }; }
          if (like(q, "INSERT INTO activity_log")) {
            state.logs.push({ id: a[0], ts: a[1], actor_email: a[2], actor_role: a[3], action: a[4], target_type: a[5], target_id: a[6], detail: a[7], ip: a[8], ua: a[9] });
            return { success: true };
          }
          if (like(q, "INSERT INTO project_share_codes")) {
            // 🔴 컬럼 순서는 소스의 INSERT 문에서 읽어온다 — 하드코딩하면 컬럼 추가 때 조용히 틀린다
            const cols = (q.match(/\(([^)]*)\)\s*VALUES/i)[1]).split(",").map((s) => s.trim());
            const vals = (q.match(/VALUES\s*\(([^)]*)\)/i)[1]).split(",").map((s) => s.trim());
            const row = { revoked: 0, use_count: 0, last_used_at: null };
            let bi = 0;
            cols.forEach((col, i) => { row[col] = vals[i] === "?" ? a[bi++] : (vals[i] === "0" ? 0 : vals[i]); });
            state.codes.push(row);
            return { success: true };
          }
          if (like(q, "UPDATE project_share_codes SET use_count")) {
            const c = state.codes.find((x) => x.id === a[1]); if (c) { c.use_count++; c.last_used_at = a[0]; }
            return { success: true };
          }
          if (like(q, "UPDATE projects SET share_token = ?")) { const p = state.projects[a[2]]; if (p && p.share_token == null) p.share_token = a[0]; state.writes.push(q); return { success: true }; }
          if (like(q, "UPDATE projects SET published = 1")) { const p = state.projects[a[3]]; if (p) p.published = 1; state.writes.push(q); return { success: true }; }
          if (/^(INSERT|UPDATE|DELETE)/i.test(q)) state.writes.push(q);
          return { success: true };
        },
      });
      return { bind: (...a) => exec(a), first: async () => exec([]).first(), all: async () => exec([]).all(), run: async () => exec([]).run() };
    },
    batch: snapBatch,
  };
}
const SHELL = '<!doctype html><html><head></head><body></body></html>';
const ASSETS = { async fetch(req) { return new URL(req.url).pathname === "/index.html" ? new Response(SHELL, { status: 200, headers: { "Content-Type": "text/html" } }) : new Response("nf", { status: 404 }); } };
function makeCaller(worker, state, env = {}) {
  const ENV = { DB: null, ASSETS, DEMO_LOGIN: "0", ...env };
  return async (method, p, { token, body } = {}) => {
    ENV.DB = makeDB(state);
    const host = "scan.seastar.work";
    const h = { "Content-Type": "application/json", Host: host, Origin: "https://" + host, "User-Agent": "p68-agent", "CF-Connecting-IP": "203.0.113.9" };
    if (token) h.Authorization = "Bearer " + token;
    return await worker.fetch(new Request("https://" + host + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }),
      ENV, { waitUntil() {}, passThroughOnException() {} });
  };
}
const SUP = "local-super-tok";
const J = async (r) => { try { return await r.json(); } catch { return null; } };

const worker = await loadWorker();
if (!worker) { console.log("\n[FATAL] 워커 번들 실패"); process.exit(1); }

/** 배포 → 공유토큰 → 코드 1개 발급(company 옵션) */
async function scenario(codeBody, env = {}) {
  const st = freshState();
  const call = makeCaller(worker, st, env);
  const pub = await J(await call("POST", `/api/projects/${PID}/publish`, { token: SUP, body: {} }));
  const made = await J(await call("POST", `/api/projects/${PID}/share-codes`, { token: SUP, body: codeBody }));
  return { st, call, shareToken: pub.project.share_token, made };
}
const lastLog = (st, action) => { const a = st.logs.filter((l) => l.action === action); return a.length ? JSON.parse(a[a.length - 1].detail || "{}") : null; };

console.log("\n[B1 company 미지정 코드 → 기존대로 통과 (기존 링크 무손상)]");
{
  const S = await scenario({ label: "대한중공업 배관팀" });
  ok(!!S.made && typeof S.made.code === "string", "B1 사전조건 — 코드 발급");
  ok(S.made.company === null && S.made.company_gate === false, "B1 company 미지정임을 응답이 밝힌다 → " + JSON.stringify(S.made.company));
  const j = await J(await S.call("POST", "/api/share/verify", { body: { t: S.shareToken, company: "아무회사", name: "김현장", code: S.made.code } }));
  ok(!!j && j.ok === true, "B1 🔴 회사 검사 없이 통과 (실제 " + JSON.stringify(j && j.error) + ")");
  const d = lastLog(S.st, "share.access");
  ok(!!d && d.jev === null, "B1 감사: 회사 검사 자체가 없었음(jev=null) → " + JSON.stringify(d && d.jev));
}

console.log("\n[B2 company 지정 + 일치 → 통과, Jev 미경유]");
let S2 = null;
{
  S2 = await scenario({ label: "한라ENS 선각팀", company: "한라ENS" });
  ok(S2.made.company === "한라ENS" && S2.made.company_gate === true, "B2 발급 응답에 허용 회사 → " + S2.made.company);
  const j = await J(await S2.call("POST", "/api/share/verify", { body: { t: S2.shareToken, company: "(주)한라ENS", name: "김현장", code: S2.made.code } }));
  ok(!!j && j.ok === true, "B2 표기 차이(법인접미사) 흡수 후 통과 (실제 " + JSON.stringify(j && j.error) + ")");
  const d = lastLog(S2.st, "share.access");
  ok(!!d && d.gate_reason === "rule-exact", "B2 통과 사유 기록 → " + (d && d.gate_reason));
  ok(!!d && d.jev && d.jev.applied === false && d.jev.threshold === 0.9, "B2 🔴 감사: 규칙으로 통과(Jev 미적용) → " + JSON.stringify(d && d.jev));
  ok(!!d && d.allowed_company === "한라ENS", "B2 어떤 기준과 대조했는지 기록 → " + (d && d.allowed_company));
}

console.log("\n[B3 company 지정 + 다른 회사 → 🔴 리젝트 + 재요청처 안내]");
{
  // 🔴 실 환경에 키가 없을 때(OPENROUTER_API_KEY 미설정) = 폴백. 폴백은 **통과가 아니라 리젝트**여야 한다.
  const r = await S2.call("POST", "/api/share/verify", { body: { t: S2.shareToken, company: "무단침입산업", name: "침입", code: S2.made.code } });
  const j = await J(r);
  ok(r.status === 403, "B3 🔴 403 (실제 " + r.status + ")");
  ok(!!j && j.ok === false, "B3 ok=false");
  ok(!!j && j.contact === SUPPORT && String(j.message).includes(SUPPORT), "B3 🔴 재요청처 안내 → " + (j && j.message));
  ok(!!j && !String(j.message).includes("한라ENS"), "B3 🔴 등록된 회사명을 알려주지 않는다(추측 공격 방지)");
  ok(!DEV_GMAILS.some((g) => JSON.stringify(j).includes(g)), "B3 응답에 개발자 gmail 0");
  const d = lastLog(S2.st, "share.denied");
  ok(!!d && d.reason.startsWith("jev-unavailable"), "B3 감사 사유 → " + (d && d.reason));
  ok(!!d && d.jev && d.jev.applied === false && d.jev.verdict === "fallback", "B3 🔴 Jev 미적용 폴백임을 기록 → " + JSON.stringify(d && d.jev));
  ok(!!d && d.company === "무단침입산업" && d.name === "침입", "B3 누가 시도했는지 기록 → " + (d && d.company) + "/" + (d && d.name));
  // 리젝트된 시도는 통행증을 못 받는다 → 도면 데이터도 못 본다
  ok(!j.token, "B3 🔴 통행증 미발급");
}

console.log("\n[B4 발급/목록 API 가 company 를 다룬다]");
{
  const list = await J(await S2.call("GET", `/api/projects/${PID}/share-codes`, { token: SUP }));
  const row = list && list.data && list.data[0];
  ok(!!row && row.company === "한라ENS" && row.company_gate === true, "B4 목록 API 가 company 반환 → " + JSON.stringify(row && row.company));
  ok(list.company_gate_threshold === 0.9, "B4 목록이 임계값을 밝힌다 → " + (list && list.company_gate_threshold));
  ok(S2.st.codes[0].company === "한라ENS", "B4 DB INSERT 에 company 저장 → " + S2.st.codes[0].company);
  ok(S2.st.codes[0].code_hash && !String(S2.st.codes[0].code_hash).includes(S2.made.code.replace(/-/g, "")),
     "B4 🔴 코드 원문은 여전히 DB 에 없다(해시만) — 0027 정책 회귀 금지");
  const cd = lastLog(S2.st, "share.code.create");
  ok(!!cd && cd.company === "한라ENS", "B4 발급 감사에도 허용 회사 기록 → " + (cd && cd.company));
  // 🔴 label 을 대조 기준으로 자동 승격하면 현장 전원이 리젝트된다 — 분리돼 있음을 확인
  const S3 = await scenario({ label: "한라ENS 선각팀" });
  const j3 = await J(await S3.call("POST", "/api/share/verify", { body: { t: S3.shareToken, company: "한라ENS", name: "김현장", code: S3.made.code } }));
  ok(!!j3 && j3.ok === true, "B4 🔴 label 을 company 로 끌어다 쓰지 않는다(미지정 = 검사 없음)");
}

console.log("\n[B5 🔴 순서 유지 — 코드 검증이 회사 검사보다 먼저다]");
{
  const r = await S2.call("POST", "/api/share/verify", { body: { t: S2.shareToken, company: "한라ENS", name: "김현장", code: "aaaaa-bbbbb-ccccc" } });
  const j = await J(r);
  ok(r.status === 403 && j.error === "unknown-code", "B5 회사명이 맞아도 코드가 틀리면 코드 사유로 거부 → " + (j && j.error));
  const r2 = await S2.call("POST", "/api/share/verify", { body: { t: S2.shareToken, company: "", name: "김현장", code: S2.made.code } });
  ok(r2.status === 400, "B5 회사명 미입력은 그대로 400 (실제 " + r2.status + ")");
}

/* ══════════════════════════ [C] 뮤테이션 3건 ══════════════════════════ */
console.log("\n[C 뮤테이션 — 고친 부분을 되돌리면 위 판정이 실제로 뒤집힌다]");
{
  // ⓐ 임계값을 버리고 라벨만 쓴다(확률 무시) → A4(p=0.05 리젝트) 가 무너져야 한다
  const mA = await loadJev([{ file: "lib/jev.ts", from: "if (p >= COMPANY_GATE_PASS_P)", to: "if (true)" }]);
  if (mA) {
    const r = await mA.decideCompanyGate({ allowed: "한라ENS", input: "삼성중공업", ask: probe({ ok: true, p: 0.05 }).ask });
    ok(r.verdict === "pass", "Ⓐ 임계값 제거 시 p=0.05 가 통과로 뒤집힌다 → A4 가 이 결함을 잡는다 (실제 " + r.verdict + ")");
  }
  // ⓑ pending 을 통과로 바꾼다 → A5 가 무너져야 한다
  const mB = await loadJev([{ file: "lib/jev.ts", from: "return { verdict: 'pending', reason: 'company-uncertain'", to: "return { verdict: 'pass', reason: 'company-uncertain'" }]);
  if (mB) {
    const r = await mB.decideCompanyGate({ allowed: "한라ENS", input: "한라이엔에스인터내셔널", ask: probe({ ok: true, p: 0.75 }).ask });
    ok(r.verdict === "pass", "Ⓑ pending→pass 로 바꾸면 p=0.75 가 통과한다 → A5 가 이 결함을 잡는다 (실제 " + r.verdict + ")");
  }
  // ⓒ Jev 실패를 통과로 삼킨다 → A6/B3 가 무너져야 한다
  const mC = await loadJev([{ file: "lib/jev.ts", from: "return { verdict: 'reject', reason: 'jev-unavailable:'", to: "return { verdict: 'pass', reason: 'jev-unavailable:'" }]);
  if (mC) {
    const r = await mC.decideCompanyGate({ allowed: "한라ENS", input: "무단침입산업", ask: probe({ ok: false, error: "no-key" }).ask });
    ok(r.verdict === "pass", "Ⓒ 에러를 통과로 삼키면 키 없이도 뚫린다 → A6/B3 가 이 결함을 잡는다 (실제 " + r.verdict + ")");
  }
  // ⓓ 라우트에서 게이트 호출을 지우면 B3 가 무너져야 한다 (실 라우트 뮤테이션)
  const mW = await loadWorker([{ file: "index.tsx", from: "if (gate.verdict !== 'pass') {", to: "if (false) {" }]);
  if (mW) {
    const st = freshState();
    const call = makeCaller(mW, st);
    const pub = await J(await call("POST", `/api/projects/${PID}/publish`, { token: SUP, body: {} }));
    const made = await J(await call("POST", `/api/projects/${PID}/share-codes`, { token: SUP, body: { label: "L", company: "한라ENS" } }));
    const j = await J(await call("POST", "/api/share/verify", { body: { t: pub.project.share_token, company: "무단침입산업", name: "침입", code: made.code } }));
    ok(!!j && j.ok === true, "Ⓓ 라우트 게이트를 제거하면 다른 회사가 통과한다 → B3 가 이 결함을 잡는다 (실제 " + JSON.stringify(j && j.error) + ")");
  }
}

console.log("\n" + (failed === 0 ? "✅ p68 ALL PASS" : `❌ p68 FAIL ${failed}건`));
process.exit(failed === 0 ? 0 : 1);
