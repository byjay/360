/**
 * p48 — 배포 링크(?d=) 세션이 서버 쓰기까지 가능하던 보안 결함 회귀 테스트
 * (프레임워크 0 · 실행: node tests/p48-viewer-readonly.test.mjs)
 *
 * 마스터 재현(프로덕션, 2026-09-18):
 *   localStorage/sessionStorage 전부 clear → `?d=dep_...` 만 열기
 *   → sessionStorage.wm_id_token = "auto-designer-entry-360" 자동 발급, role=designer
 *   → 화면상 편집칩/저장버튼은 숨겨지지만(designerOnlyVisible=0)
 *   → 🔴 fetch PATCH /tables/deployments/<id> 가 **200 성공**
 *
 * 근본원인 2개:
 *   ⓐ AUTO_DESIGNER_TOKEN 이 클라이언트 번들에 박힌 **고정 문자열**이었다 — 비밀이 아닌데 쓰기 자격.
 *   ⓑ 쓰기 차단이 클라이언트 UI 에만 있었고 **서버가 강제하지 않았다**.
 *
 * 조치(src/index.tsx):
 *   ① 고정 문자열 토큰 → 열람 전용(_readonly)으로 강등.
 *   ② 편집 가능한 자동입장 토큰은 서버 HMAC 서명본(POST /api/auth/auto-entry, kind=designer).
 *   ③ `?d=` 클라이언트(22_Auth.js)는 kind='viewer' 만 요청.
 *   ④ 🔴 readOnlyGuard 미들웨어 — 모든 변경 메서드를 **한 곳**에서 거부(allowlist 방식).
 *
 * 🔴 목 금지 — 실제 Hono 앱(src/index.tsx)을 esbuild 로 번들해 실제 Request 로 구동한다.
 *   가짜는 D1 데이터스토어뿐이다(핸들러·라우팅·인증체인은 전부 실 소스).
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

/* ══ 실제 워커 번들 — src/index.tsx 를 그대로 ══════════════════════════ */
const outFile = path.join(os.tmpdir(), "p48-worker-" + process.pid + ".mjs");
await esbuild.build({
  entryPoints: [path.join(ROOT, "src/index.tsx")],
  bundle: true, format: "esm", platform: "node", outfile: outFile,
  jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
});
const worker = (await import("file://" + outFile.replace(/\\/g, "/"))).default;
fs.unlinkSync(outFile);

/* ══ D1 데이터스토어 가짜 (핸들러가 아니라 저장소만 대체) ══════════════ */
const DEP_ID = "dep_test_001";
function makeDB(state) {
  const like = (sql, s) => sql.replace(/\s+/g, " ").indexOf(s) >= 0;
  return {
    prepare(sql) {
      const q = sql.replace(/\s+/g, " ").trim();
      return {
        bind(...a) {
          return {
            async first() {
              if (like(q, "FROM app_settings WHERE scope = '*' AND skey = ?"))
                return state.settings[a[0]] ? { value: state.settings[a[0]] } : null;
              if (like(q, "FROM local_sessions WHERE token = ?"))
                return state.sessions[a[0]] || null;
              if (like(q, "FROM local_users WHERE email = ?"))
                return state.localUsers[String(a[0]).toLowerCase()] || null;
              if (like(q, "FROM designers WHERE email = ?"))
                return state.designers.has(String(a[0]).toLowerCase()) ? { email: a[0], deleted: 0 } : null;
              if (like(q, "FROM deployments WHERE id = ?"))
                return state.deployments[a[0]] || null;
              // [WP3] 배포본 쓰기 권한(deploymentWriteDenied) — 배포본의 project_id(prj1) 기준
              if (like(q, "FROM projects WHERE id = ?"))
                return state.projects[a[0]] || null;
              if (like(q, "FROM project_members WHERE project_id = ? AND lower(email) = ?"))
                return state.members[a[0] + "|" + a[1]] ? { role: state.members[a[0] + "|" + a[1]] } : null;
              if (like(q, "FROM tenant_members WHERE email = ?")) return null;
              return null;
            },
            async all() { return { results: [] }; },
            async run() {
              if (like(q, "INSERT INTO app_settings")) {
                // ON CONFLICT DO NOTHING — 이미 있으면 유지
                if (!state.settings[a[0]]) state.settings[a[0]] = a[1];
              } else if (like(q, "UPDATE deployments SET")) {
                state.writes.push(q);
              } else if (/^(INSERT|UPDATE|DELETE)/i.test(q)) {
                state.writes.push(q);
              }
              return { success: true };
            },
          };
        },
        async first() { return null; },
        async all() { return { results: [] }; },
        async run() { return { success: true }; },
      };
    },
    batch: async () => [],
  };
}
function freshState() {
  return {
    settings: {},
    sessions: {
      "local-super-tok": { email: "designssir@gmail.com", expires_at: Date.now() + 8.64e7, revoked: 0 },
      "local-invited-tok": { email: "invited.designer@example.com", expires_at: Date.now() + 8.64e7, revoked: 0 },
    },
    localUsers: {
      "designssir@gmail.com": { email: "designssir@gmail.com", name: "마스터", deleted: 0, must_change_password: 0 },
      "invited.designer@example.com": { email: "invited.designer@example.com", name: "초대설계자", deleted: 0, must_change_password: 0 },
    },
    designers: new Set(["invited.designer@example.com"]),   // 마스터가 초대해 배정한 designer
    deployments: { [DEP_ID]: { id: DEP_ID, project_id: "prj1", pins: "[]", zones: "[]", annotations: "[]", version: 3, deleted: 0, tenant_id: null, name: "T", created_at: 1, updated_at: 1 } },
    // [WP3] prj1 = 마스터 소유, 초대 designer 는 prj1 의 designer 멤버(초대 = project_members 배정)
    projects: { prj1: { owner: "designssir@gmail.com", deleted: 0 } },
    members: { "prj1|invited.designer@example.com": "designer" },
    writes: [],
  };
}

let STATE = freshState();
const ENV = { DB: null, DEMO_LOGIN: "0" };   // 데모 토큰 봉인 상태(운영과 동일)
const req = (method, p, { token, body, host = "scan.seastar.work" } = {}) => {
  const h = { "Content-Type": "application/json", Host: host, Origin: "https://" + host };
  if (token) h.Authorization = "Bearer " + token;
  return new Request("https://" + host + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
};
const call = async (method, p, opts) => {
  ENV.DB = makeDB(STATE);
  return await worker.fetch(req(method, p, opts), ENV, { waitUntil() {}, passThroughOnException() {} });
};

/** 자동입장 토큰 발급 — 클라이언트(22_Auth._mintAutoEntryToken)와 동일한 실제 호출 */
async function mint(kind) {
  const r = await call("POST", "/api/auth/auto-entry", { body: { kind } });
  const j = await r.json();
  return j;
}

const LEGACY = "auto-designer-entry-360";

/* ══════════════════════════════════════════════════════════════════════ */
console.log("\n[① `?d=` 배포 링크 세션(kind=viewer) → 쓰기 거부]");
const viewer = await mint("viewer");
ok(viewer.kind === "viewer" && viewer.readonly === true, "① 발급 토큰이 열람전용으로 표시됨: kind=" + viewer.kind + " readonly=" + viewer.readonly);
ok(typeof viewer.token === "string" && viewer.token.startsWith("ae1."), "① 고정 문자열이 아니라 서버 서명 토큰: " + String(viewer.token).slice(0, 12) + "…");
{
  const before = STATE.writes.length;
  const r = await call("PATCH", "/tables/deployments/" + DEP_ID, { token: viewer.token, body: { pins: [{ id: "hack" }] } });
  ok(r.status === 403, "① PATCH /tables/deployments/:id → 403 (실제 " + r.status + ")");
  ok(STATE.writes.length === before, "① DB 쓰기 0건 (실제 " + (STATE.writes.length - before) + "건)");
  const r2 = await call("POST", "/tables/deployments/" + DEP_ID + "/ops", { token: viewer.token, body: { ops: [] } });
  ok(r2.status === 403, "① POST …/ops → 403 (실제 " + r2.status + ")");
}

console.log("\n[② 같은 세션의 열람은 계속 200 — 마스터 모델(링크로 보이는 것은 유지)]");
{
  const r = await call("GET", "/tables/deployments/" + DEP_ID, { token: viewer.token });
  ok(r.status === 200, "② GET /tables/deployments/:id → 200 (실제 " + r.status + ")");
  const j = await r.json();
  ok(j && j.id === DEP_ID, "② 도면/핀 데이터가 실제로 반환됨: id=" + (j && j.id));
  const me = await call("GET", "/api/auth/me", { token: viewer.token });
  const mj = await me.json();
  ok(me.status === 200 && mj.authenticated === true && mj.readonly === true, "② /api/auth/me 가 열람전용임을 정직하게 보고: readonly=" + mj.readonly);
}

console.log("\n[③ 마스터가 초대한 designer 의 쓰기는 종전대로 200 (회귀)]");
{
  const r = await call("PATCH", "/tables/deployments/" + DEP_ID, { token: "local-invited-tok", body: { pins: [{ id: "p1" }] } });
  ok(r.status === 200, "③ 초대 designer PATCH → 200 (실제 " + r.status + ")");
}

console.log("\n[④ 마스터(슈퍼관리자) 쓰기 200 (회귀)]");
{
  const r = await call("PATCH", "/tables/deployments/" + DEP_ID, { token: "local-super-tok", body: { pins: [{ id: "p2" }] } });
  ok(r.status === 200, "④ 슈퍼관리자 PATCH → 200 (실제 " + r.status + ")");
  const r2 = await call("POST", "/api/projects", { token: "local-super-tok", body: { name: "새 프로젝트" } });
  ok(r2.status === 200, "④ 슈퍼관리자 POST /api/projects → 200 (실제 " + r2.status + ")");
}

console.log("\n[⑤ 자동 디자이너 직접 접속(`?d=` 없음, kind=designer) 쓰기 200 (회귀)]");
const designer = await mint("designer");
ok(designer.kind === "designer" && designer.readonly === false, "⑤ designer 종류로 발급됨: kind=" + designer.kind);
{
  const r = await call("PATCH", "/tables/deployments/" + DEP_ID, { token: designer.token, body: { pins: [{ id: "p3" }] } });
  ok(r.status === 200, "⑤ 자동입장(designer) PATCH → 200 (실제 " + r.status + ")");
}

console.log("\n[⑥ 🔴 고정 문자열 토큰만으로는 쓰기 불가 — 번들에 박혀 공개된 값이므로 자격이 될 수 없다]");
{
  const before = STATE.writes.length;
  const r = await call("PATCH", "/tables/deployments/" + DEP_ID, { token: LEGACY, body: { pins: [{ id: "hack2" }] } });
  ok(r.status === 403, "⑥ 고정 문자열 PATCH → 403 (실제 " + r.status + ")");
  ok(STATE.writes.length === before, "⑥ DB 쓰기 0건");
  const g = await call("GET", "/tables/deployments/" + DEP_ID, { token: LEGACY });
  ok(g.status === 200, "⑥ 단, 기존 세션의 열람은 깨지지 않는다 → GET 200 (실제 " + g.status + ")");
  // 토큰 위조 내성: 서명 없이 kind 만 designer 로 바꿔 넣어도 통과 못 한다
  const forgedPayload = Buffer.from(JSON.stringify({ k: "designer", exp: Date.now() + 1e6, n: "x" })).toString("base64url");
  const f = await call("PATCH", "/tables/deployments/" + DEP_ID, { token: "ae1." + forgedPayload + ".AAAA", body: { pins: [] } });
  ok(f.status === 401 || f.status === 403, "⑥ 서명 없는 위조 designer 토큰 거부 (실제 " + f.status + ")");
  // 열람전용 토큰의 payload 를 designer 로 바꿔치기해도(서명 불일치) 통과 못 한다
  const parts = viewer.token.slice(4).split(".");
  const t = await call("PATCH", "/tables/deployments/" + DEP_ID, { token: "ae1." + forgedPayload + "." + parts[1], body: { pins: [] } });
  ok(t.status === 401 || t.status === 403, "⑥ 서명 재사용 변조 토큰 거부 (실제 " + t.status + ")");
}

console.log("\n[⑦ 🔴 다른 쓰기 경로 전수 — src/index.tsx 의 모든 변경 라우트를 소스에서 뽑아 검사]");
{
  const src = fs.readFileSync(path.join(ROOT, "src/index.tsx"), "utf8");
  const ALLOW = ["/api/signup/", "/api/invite/", "/api/auth/", "/api/client-log"];
  const routes = [];
  const re = /app\.(post|put|patch|delete)\('([^']+)'/g;
  let m;
  while ((m = re.exec(src))) {
    const method = m[1].toUpperCase();
    const p = m[2].replace(/:[A-Za-z]+/g, "x").replace(/\*/g, "x");
    if (ALLOW.some((a) => p === a || p.startsWith(a))) continue;
    routes.push({ method, p });
  }
  ok(routes.length >= 40, "⑦ 검사 대상 변경 라우트 수집: " + routes.length + "개");
  const leaks = [];
  for (const r of routes) {
    const res = await call(r.method, r.p, { token: viewer.token, body: {} });
    if (res.status !== 403) leaks.push(r.method + " " + r.p + " → " + res.status);
  }
  ok(leaks.length === 0, "⑦ 열람전용 세션이 뚫는 쓰기 경로 0개" + (leaks.length ? " — 누출: " + leaks.join(", ") : ""));
  // 고정 문자열 토큰도 같은 전수 검사
  const leaks2 = [];
  for (const r of routes) {
    const res = await call(r.method, r.p, { token: LEGACY, body: {} });
    if (res.status !== 403) leaks2.push(r.method + " " + r.p + " → " + res.status);
  }
  ok(leaks2.length === 0, "⑦ 고정 문자열 토큰이 뚫는 쓰기 경로 0개" + (leaks2.length ? " — 누출: " + leaks2.join(", ") : ""));
}

console.log("\n[⑧ 클라이언트 — `?d=` 일 때 열람전용 종류만 요청하는지(소스 계약)]");
{
  const auth = fs.readFileSync(path.join(ROOT, "public/js/modules/22_Auth.js"), "utf8");
  ok(/get\("d"\)\s*\?\s*"viewer"\s*:\s*"designer"/.test(auth), "⑧ ?d= 존재 시 kind='viewer' 로 발급 요청");
  ok(auth.includes("/api/auth/auto-entry"), "⑧ 서버 발급 엔드포인트를 호출한다(고정 문자열 직접 사용 아님)");
  const main = fs.readFileSync(path.join(ROOT, "public/js/main.js"), "utf8");
  ok(main.includes("/api/auth/auto-entry"), "⑧ 번들(main.js)에 반영됨 — assemble 미러 확인");
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
