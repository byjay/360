/**
 * p63 — 뷰어 초대코드 게이트 + 접속 기록(이름·소속·IP·주소)
 * (프레임워크 0 · 실행: node tests/p63-viewer-gate-log.test.mjs)
 *
 * 마스터 확정(2026-09-21): "1단계 = 접속 기록 / 차단은 초대 계정" → "좋아 그렇게 해. 초대코드"
 *   공유 링크 접속 → [회사명][이름][초대코드]
 *     → 코드 유효 → 열람 + 기록(이름·소속·IP·접속주소·시각)
 *     → 코드 무효 → 거부 + "designsir@seastargo.com 으로 링크를 다시 요청하세요"
 * 마스터 추가질문: "그런데 그 링크가 유출된다면?"
 *   → 링크만 유출 = 코드에서 막힌다 / 코드까지 유출 = **폐기·만료·기록**으로 대응(3종 전부 필수).
 *
 * 🔴 이름·회사는 **자기 신고**라 대조하지 않는다(대조할 명단이 DB 에 없다) — 기록만 한다.
 *
 *  ① 🔴 코드 없이 접근 → **서버가 도면 데이터를 안 준다**(UI 차단만으로는 불합격)
 *  ② 유효 코드 → 열람
 *  ③ 기록에 이름·소속·**IP**·접속주소·시각
 *  ④ 🔴 거부 화면에 designsir@seastargo.com 노출 + gmail 주소 미노출
 *  ⑤ 코드가 암호난수 · DB 에 원문 미저장
 *  ⑥ 만료·**폐기** 코드 거부
 *  ⑦ 🔴 게이트 통과 후에도 쓰기 403 (p48 회귀 금지)
 *  ⑧ `?d=` 하위호환 + 동일 게이트 적용 + fail-closed
 *  ⑨ 세션 재입력 불필요 + 교차 프로젝트 차단
 *  ⑩ 보관기간 상수 SoT 1곳
 *
 * 뮤테이션 5건: ⓐ서버 게이트 제거→① ⓑ비암호난수→⑤ ⓒgmail 노출→④ ⓓ통과에 쓰기 허용→⑦ ⓔ만료·폐기 검사 제거→⑥
 *
 * 🔴 목 금지 — 실제 Hono 앱(src/index.tsx)을 esbuild 로 번들해 실제 Request 로 구동한다.
 *   가짜는 D1 저장소와 ASSETS 바인딩뿐이다(라우팅·인증체인·핸들러·해시는 전부 실 소스).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
// [WO 20261012-viewlink] 열람 링크 읽기 = 배포 스냅샷(0044) — 가짜 저장소에 스냅샷 행 저장을 붙인다(SoT tests/_lib/fake-snapshot.mjs)
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

/* ══ 실제 워커 번들(뮤테이션은 src/ 사본에 문자열 치환) ══════════════════ */
let seq = 0;
async function buildWorker(patches = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p63-src-"));
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  // 🔴 src/lib/*.ts 를 손목록으로 적지 않는다 — 새 lib 파일이 추가되면 조용히 번들이 깨진다(P68 실사고).
  const files = { "index.tsx": rd("src/index.tsx") };
  for (const f of fs.readdirSync(path.join(ROOT, "src/lib"))) if (/\.tsx?$/.test(f)) files["lib/" + f] = rd("src/lib/" + f);
  for (const p of patches) {
    const cur = files[p.file];
    const next = cur.replace(p.from, p.to);
    if (!mustPatch(cur, next, p.file + " :: " + String(p.from).slice(0, 60))) return null;
    files[p.file] = next;
  }
  for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), body, "utf8");
  const out = path.join(os.tmpdir(), `p63-worker-${process.pid}-${seq++}.mjs`);
  await esbuild.build({
    entryPoints: [path.join(dir, "index.tsx")], bundle: true, format: "esm", platform: "node",
    outfile: out, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
    absWorkingDir: ROOT, nodePaths: [path.join(ROOT, "node_modules")],
  });
  const mod = (await import("file://" + out.replace(/\\/g, "/"))).default;
  fs.unlinkSync(out); fs.rmSync(dir, { recursive: true, force: true });
  return mod;
}
async function loadUtil(patches = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p63-util-"));
  let body = rd("src/lib/util.ts");
  for (const p of patches) {
    const next = body.replace(p.from, p.to);
    if (!mustPatch(body, next, "util :: " + String(p.from).slice(0, 50))) return null;
    body = next;
  }
  const src = path.join(dir, "util.ts");
  fs.writeFileSync(src, body, "utf8");
  const out = path.join(os.tmpdir(), `p63-util-${process.pid}-${seq++}.mjs`);
  await esbuild.build({ entryPoints: [src], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  const mod = await import("file://" + out.replace(/\\/g, "/"));
  fs.unlinkSync(out); fs.rmSync(dir, { recursive: true, force: true });
  return mod;
}

/* ══ D1 저장소 가짜 (핸들러가 아니라 저장소만 대체) ═══════════════════════ */
const PID = "prj_gate1";
const DEP = "dep_gate1";
const PID2 = "prj_gate2";      // 교차 사용 · fail-closed 검사용 두 번째 프로젝트
const DEP2 = "dep_gate2";
function freshState() {
  return {
    settings: {},
    sessions: { "local-super-tok": { email: "designssir@gmail.com", expires_at: Date.now() + 8.64e7, revoked: 0 } },
    localUsers: { "designssir@gmail.com": { email: "designssir@gmail.com", name: "마스터", deleted: 0, must_change_password: 0 } },
    designers: new Set(),
    projects: {
      [PID]:  { id: PID,  name: "선각 A동", description: null, owner: "designssir@gmail.com", created_at: 1, updated_at: 1, published: 1, published_at: 1, published_by: "x", subdomain: null, share_token: null, deleted: 0 },
      [PID2]: { id: PID2, name: "기관실 B", description: null, owner: "designssir@gmail.com", created_at: 1, updated_at: 1, published: 1, published_at: 1, published_by: "x", subdomain: null, share_token: null, deleted: 0 },
    },
    decks: [{ id: "dck1", project_id: PID, deployment_id: DEP, level_no: 1, created_at: 1, deleted: 0 },
            { id: "dck2", project_id: PID2, deployment_id: DEP2, level_no: 1, created_at: 1, deleted: 0 }],
    deployments: {
      [DEP]:  { id: DEP,  project_id: PID,  pins: "[]", zones: "[]", annotations: "[]", version: 3, deleted: 0, tenant_id: null, name: "T", created_at: 1, updated_at: 1 },
      [DEP2]: { id: DEP2, project_id: PID2, pins: "[]", zones: "[]", annotations: "[]", version: 3, deleted: 0, tenant_id: null, name: "T2", created_at: 1, updated_at: 1 },
    },
    codes: [],       // project_share_codes
    logs: [],        // activity_log
    writes: [],
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
          // ── project_share_codes ──
          if (like(q, "SELECT COUNT(*) AS n FROM project_share_codes")) {
            const now = a[1];
            return { n: state.codes.filter((c) => c.project_id === a[0] && !c.revoked && (!c.expires_at || c.expires_at > now)).length };
          }
          if (like(q, "FROM project_share_codes WHERE project_id = ? AND code_hash = ?")) {
            return state.codes.find((c) => c.project_id === a[0] && c.code_hash === a[1]) || null;
          }
          if (like(q, "FROM project_share_codes WHERE id = ?")) return state.codes.find((c) => c.id === a[0]) || null;
          // ── projects ──
          if (like(q, "SELECT share_token FROM projects WHERE id = ?")) { const p = state.projects[a[0]]; return p ? { share_token: p.share_token } : null; }
          if (like(q, "FROM projects WHERE share_token = ? AND deleted = 0")) {
            const p = Object.values(state.projects).find((x) => !x.deleted && x.share_token && x.share_token === a[0]);
            return p ? { id: p.id, name: p.name, share_token: p.share_token, published: p.published } : null;
          }
          if (like(q, "SELECT id, name FROM projects WHERE id = ?")) { const p = state.projects[a[0]]; return p ? { id: p.id, name: p.name } : null; }
          if (like(q, "FROM projects WHERE id = ?")) return state.projects[a[0]] || null;
          // ── decks ──
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
          // 🔴 게이트가 쓰는 "이 배포본을 참조하는 프로젝트 전부" — 인자를 실제로 반영해야
          //   fail-closed 회귀(⑧i)가 의미를 갖는다.
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
            state.codes.push({ id: a[0], project_id: a[1], label: a[2], code_hash: a[3], code_hint: a[4], created_by: a[5], created_at: a[6], expires_at: a[7], revoked: 0, use_count: 0, last_used_at: null });
            return { success: true };
          }
          if (like(q, "UPDATE project_share_codes SET revoked = 1")) {
            const c = state.codes.find((x) => x.id === a[2]); if (c) { c.revoked = 1; c.revoked_at = a[0]; }
            return { success: true };
          }
          if (like(q, "UPDATE project_share_codes SET use_count")) {
            const c = state.codes.find((x) => x.id === a[1]); if (c) { c.use_count++; c.last_used_at = a[0]; }
            return { success: true };
          }
          if (like(q, "UPDATE projects SET share_token = ?")) {
            const p = state.projects[a[2]]; if (p && p.share_token == null) { p.share_token = a[0]; }
            state.writes.push(q); return { success: true };
          }
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
const SHELL = '<!doctype html><html><head><link rel="stylesheet" href="/css/style.css"></head><body><script src="/js/main.js"></script></body></html>';
const ASSETS = { async fetch(req) { return new URL(req.url).pathname === "/index.html" ? new Response(SHELL, { status: 200, headers: { "Content-Type": "text/html" } }) : new Response("nf", { status: 404 }); } };

const CLIENT_IP = "203.0.113.77";
function makeCaller(worker, state, opts = {}) {
  const ENV = { DB: null, ASSETS, DEMO_LOGIN: "0" };
  return async (method, p, { token, body, headers } = {}) => {
    ENV.DB = makeDB(state);
    const host = "scan.seastar.work";
    const h = { "Content-Type": "application/json", Host: host, Origin: "https://" + host, "User-Agent": "p63-agent", ...(headers || {}) };
    if (!opts.noIp) h["CF-Connecting-IP"] = CLIENT_IP;
    if (token) h.Authorization = "Bearer " + token;
    const req = new Request("https://" + host + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    return await worker.fetch(req, ENV, { waitUntil() {}, passThroughOnException() {} });
  };
}
const SUP = "local-super-tok";
const J = async (r) => { try { return await r.json(); } catch { return null; } };

/* ══════════════════════════════════════════════════════════════════════ */
const worker = await buildWorker();
const util = await loadUtil();
if (!worker || !util) { console.log("\n[FATAL] 번들 실패"); process.exit(1); }

/** 배포 → 토큰 확보 → 코드 1개 발급 → viewer 세션 토큰 확보 */
async function scenario(w = worker, opts = {}) {
  const st = freshState();
  const call = makeCaller(w, st, opts);
  const pub = await J(await call("POST", `/api/projects/${PID}/publish`, { token: SUP, body: {} }));
  const shareToken = pub.project.share_token;
  const made = await J(await call("POST", `/api/projects/${PID}/share-codes`, { token: SUP, body: { label: "대한중공업 배관팀" } }));
  // [WO 20261009-readacl] 열람 토큰은 열람 링크(?d=)로만 발급 — 클라이언트와 같은 호출
  const mint = await J(await call("POST", "/api/auth/auto-entry", { body: { kind: "viewer", d: DEP } }));
  return { st, call, shareToken, made, viewer: mint.token };
}

console.log("\n[① 🔴 코드 없이 접근 → 서버가 도면 데이터를 주지 않는다]");
const S = await scenario();
{
  ok(!!S.made && typeof S.made.code === "string", "① 사전조건 — 코드 발급됨(라벨 단위) → " + (S.made && S.made.label));
  const r = await S.call("GET", "/tables/deployments/" + DEP, { token: S.viewer });
  const j = await J(r);
  ok(r.status === 403, "① 🔴 GET /tables/deployments/:id → 403 (실제 " + r.status + ")");
  ok(!!j && j.gate_required === true, "① 응답이 '초대코드 필요'임을 명시 → " + JSON.stringify(j && j.error));
  ok(!j || j.pins === undefined, "① 🔴 응답 본문에 도면/핀 데이터가 없다");
  const r2 = await S.call("GET", "/api/notes?deployment_id=" + DEP, { token: S.viewer });
  ok(r2.status === 403, "① 노트(이슈)도 같이 막힌다 → " + r2.status);
  const r3 = await S.call("GET", `/api/projects/${PID}/decks`, { token: S.viewer });
  ok(r3.status === 403, "① 프로젝트 구조(decks)도 막힌다 → " + r3.status);
  // 🔴 라이브에서 실제로 뚫렸던 우회로 2건 — 재발 방지
  const r4 = await S.call("GET", "/tables/deployments/" + DEP, { token: "auto-designer-entry-360" });
  // [WO 20261001-invite ④] 공용석 종료 후 레거시 고정문자열 = 미인증(401). 게이트 403 과 같이 '열람 불가' 다.
  ok(r4.status === 403 || r4.status === 401, "①e 🔴 레거시 고정문자열 토큰도 게이트를 못 뚫는다 → " + r4.status);
  const r5 = await S.call("GET", "/tables/deployments/" + DEP, { token: "demo-viewer" });
  ok(r5.status === 403 || r5.status === 401, "①f 🔴 데모 뷰어 토큰도 게이트를 못 뚫는다(로컬 실측 우회로) → " + r5.status);
}

console.log("\n[② 유효 코드 → 열람]");
let PASS = null;
{
  const r = await S.call("POST", "/api/share/verify", { token: S.viewer,
    body: { t: S.shareToken, company: "대한중공업", name: "김현장", code: S.made.code } });
  const j = await J(r);
  ok(r.status === 200 && j && j.ok === true, "② verify → 200 ok (실제 " + r.status + ")");
  ok(!!j && typeof j.token === "string" && j.token.startsWith("ae1."), "② 서명된 통행증 발급 → " + String(j && j.token).slice(0, 10) + "…");
  ok(!!j && j.readonly === true, "② 통행증은 열람 전용임을 명시");
  PASS = j.token;
  const g = await S.call("GET", "/tables/deployments/" + DEP, { token: PASS });
  const gj = await J(g);
  ok(g.status === 200, "② 🔴 통과 후 도면 데이터 200 (실제 " + g.status + ")");
  ok(!!gj && gj.id === DEP, "② 실제 배포본이 반환된다 → id=" + (gj && gj.id));
  const loose = S.made.code.replace(/-/g, "").toUpperCase();
  const r2 = await J(await S.call("POST", "/api/share/verify", { body: { t: S.shareToken, company: "대한중공업", name: "박현장", code: loose } }));
  ok(!!r2 && r2.ok === true, "② 하이픈 제거·대문자 입력도 동일 코드로 인정(정규화) → " + loose.slice(0, 6) + "…");
}

console.log("\n[③ 기록 — 이름·소속·IP·접속주소·시각]");
{
  const acc = S.st.logs.filter((l) => l.action === "share.access");
  ok(acc.length >= 1, "③ share.access 로그가 남았다 → " + acc.length + "건");
  const l = acc[0];
  const d = JSON.parse(l.detail || "{}");
  ok(d.company === "대한중공업", "③ 소속 기록 → " + d.company);
  ok(d.name === "김현장", "③ 이름 기록 → " + d.name);
  ok(l.ip === CLIENT_IP, "③ 🔴 IP 기록(CF-Connecting-IP) → " + l.ip);
  ok(typeof l.ts === "number" && l.ts > 0, "③ 시각 기록 → " + l.ts);
  ok(typeof d.url === "string" && d.url.length > 0, "③ 접속주소 기록 → " + d.url);
  ok(l.target_id === PID, "③ 어느 프로젝트인지 기록 → " + l.target_id);
  ok(d.code_id === S.made.id && d.code_label === "대한중공업 배관팀", "③ 어느 발급단위 코드인지 기록(유출 추적) → " + d.code_label);
  ok(l.actor_email === null || l.actor_email === "", "③ 🔴 자기신고 이름을 actor_email(검증된 신원) 자리에 넣지 않는다 → " + JSON.stringify(l.actor_email));
  ok(d.retention_days === 365, "③ 보관기간이 로그에도 명시 → " + d.retention_days);
  ok(S.st.codes[0].use_count >= 1 && !!S.st.codes[0].last_used_at, "③ 코드 사용 횟수/최근시각 갱신 → " + S.st.codes[0].use_count + "회");
  // 🔴 IP 헤더가 없는 환경에서는 ''(빈 문자열)가 아니라 null 이어야 "기록했는데 빈 값"과 "모른다"가 구분된다.
  const s2 = await scenario(worker, { noIp: true });
  const before = s2.st.logs.length;
  await s2.call("POST", "/api/share/verify", { body: { t: s2.shareToken, company: "c", name: "n", code: s2.made.code } });
  const rec = s2.st.logs.slice(before).find((x) => x.action === "share.access");
  ok(!!rec && rec.ip === null, "③ IP 헤더 부재 시 null 로 기록(빈 문자열 위장 금지) → " + JSON.stringify(rec && rec.ip));
}

console.log("\n[④ 🔴 거부 안내에 designsir@seastargo.com 노출 · gmail 미노출]");
{
  const r = await S.call("POST", "/api/share/verify", { body: { t: S.shareToken, company: "무단", name: "침입", code: "aaaaa-bbbbb-ccccc" } });
  const j = await J(r);
  ok(r.status === 403, "④ 틀린 코드 → 403 (실제 " + r.status + ")");
  ok(!!j && j.contact === SUPPORT && String(j.message).includes(SUPPORT), "④ 🔴 재요청처 안내 → " + (j && j.message));
  const blob = JSON.stringify(j);
  ok(!DEV_GMAILS.some((g) => blob.includes(g)), "④ 🔴 응답에 개발 관리자 gmail 없음");
  const nf = await (await S.call("GET", "/srview/" + encodeURIComponent("없는이름"))).text();
  ok(nf.includes(SUPPORT), "④ /srview 404 페이지에도 재요청처 노출");
  ok(!DEV_GMAILS.some((g) => nf.includes(g)), "④ 🔴 404 페이지에 gmail 없음");
  const g403 = await J(await S.call("GET", "/tables/deployments/" + DEP, { token: S.viewer }));
  ok(g403.contact === SUPPORT && !DEV_GMAILS.some((x) => JSON.stringify(g403).includes(x)), "④ 게이트 403 응답도 동일(gmail 0)");
  const gate = rd("public/js/modules/01d_ShareGate.js");
  ok(gate.includes(SUPPORT), "④ 클라이언트 게이트 모듈이 같은 주소를 쓴다");
  ok(!DEV_GMAILS.some((x) => gate.includes(x)), "④ 🔴 클라이언트 게이트 모듈에 gmail 0");
  const html = rd("public/index.html");
  const m = html.match(/<div id="share-gate-modal"[\s\S]*?\n  <\/div>/);
  ok(!!m, "④ 게이트 모달 마크업 존재(index.html)");
  ok(!!m && !DEV_GMAILS.some((x) => m[0].includes(x)), "④ 🔴 게이트 모달 마크업에 gmail 0");
  ok(rd("public/js/main.js").includes('CONTACT: "' + SUPPORT + '"'), "④ 번들(main.js)에 반영됨 — assemble 미러 확인");
  // 🔴 라이브 재현 회귀: .admin-gate 는 `hidden` 을 빼는 것만으로는 opacity:0 · pointer-events:none 이라
  //   모달이 보이지도 클릭되지도 않았다(거부 메시지가 실제로 안 떴다). `.on` 을 반드시 붙여야 한다.
  const css = rd("public/css/style.css");
  ok(/\.admin-gate\.on\s*\{[^}]*pointer-events:\s*auto/.test(css), "④ 사전사실 — .admin-gate 는 `.on` 이 붙어야 클릭 가능하다(style.css)");
  ok(/modal\.classList\.add\("on"\)/.test(gate), "④ 게이트 모달이 `.on` 을 붙인다(보이고 눌리는 상태)");
  ok(/modal\.classList\.remove\("on"\)/.test(gate), "④ 통과 후 `.on` 을 떼 모달을 닫는다");
  // 🔴 게이트 뒤로 다른 프로젝트 이름이 비치면 "유추 불가" 요구가 깨진다(라이브에서 실측함)
  const hub = rd("public/js/modules/12_ProjectHub.js");
  ok(/_isShareEntry\(\)/.test(hub) && /if \(this\._isShareEntry\(\)\) \{/.test(hub), "④ 공유·배포 링크 세션은 프로젝트 목록을 그리지 않는다");
}

console.log("\n[뮤테이션ⓒ] 안내 주소를 gmail 로 바꾸면 ④가 실패해야 함");
{
  const w = await buildWorker([{ file: "index.tsx", from: "const SUPPORT_CONTACT_EMAIL = 'designsir@seastargo.com'", to: "const SUPPORT_CONTACT_EMAIL = 'designssir@gmail.com'" }]);
  if (w) {
    const s2 = await scenario(w);
    const j = await J(await s2.call("POST", "/api/share/verify", { body: { t: s2.shareToken, company: "x", name: "y", code: "aaaaa-bbbbb-ccccc" } }));
    const blob = JSON.stringify(j);
    ok(DEV_GMAILS.some((g) => blob.includes(g)) && !blob.includes(SUPPORT), "뮤테이션 적용 시 거부 응답에 gmail 이 노출된다(④가 깨짐을 확인)");
  }
}

console.log("\n[⑤ 코드가 암호난수 · DB 에 원문 미저장]");
{
  const src = rd("src/lib/util.ts");
  const fn = (src.match(/export function randShareCode\(\)[\s\S]*?\n}/) || [""])[0];
  ok(fn.includes("crypto.getRandomValues"), "⑤a 코드 생성기가 crypto.getRandomValues 사용");
  ok(!/Math\s*\.\s*random/.test(fn), "⑤b 생성기 본문에 비암호 PRNG 호출 0건");
  const N = 4000, seen = new Set();
  let bad = 0;
  for (let i = 0; i < N; i++) { const c = util.randShareCode(); if (!/^[0-9a-z]{5}-[0-9a-z]{5}-[0-9a-z]{5}$/.test(c)) bad++; seen.add(c); }
  ok(bad === 0, "⑤c " + N + "개 전부 xxxxx-xxxxx-xxxxx 형식");
  ok(seen.size === N, "⑤d " + N + "개 전부 유일(충돌 0)");
  const chars = new Set(Array.from(seen).join("").replace(/-/g, ""));
  ok(chars.size === 32, "⑤e Crockford base32 알파벳 32자 전부 출현(편향 없음) → " + chars.size);
  const bits = Math.log2(32) * 15;
  ok(bits >= 64, "⑤f 엔트로피 " + bits + "비트 ≥ 64비트(해시 저장이 안전한 하한 초과)");
  ok(!/[ilou]/.test(Array.from(chars).join("")), "⑤g 혼동문자(i·l·o·u) 미사용 — 구두 전달 오류 방지");
  const row = S.st.codes[0];
  const plain = S.made.code, norm = plain.replace(/-/g, "");
  ok(!Object.values(row).some((v) => typeof v === "string" && (v.includes(plain) || v === norm)),
    "⑤h 🔴 DB 행 어디에도 코드 원문이 없다 → " + JSON.stringify({ hash: String(row.code_hash).slice(0, 12) + "…", hint: row.code_hint }));
  ok(row.code_hash === await util.sha256Hex(util.normalizeShareCode(plain)), "⑤i 저장값은 SHA-256(정규화 코드)");
  ok(String(row.code_hint).length <= 4, "⑤j 힌트는 앞 4자뿐 → " + row.code_hint);
  const list = await J(await S.call("GET", `/api/projects/${PID}/share-codes`, { token: SUP }));
  ok(!JSON.stringify(list).includes(plain.slice(6)), "⑤k 목록 API 도 원문을 돌려주지 않는다");
  ok(list.plaintext_available === false, "⑤l 재확인 불가임을 정직하게 표시(잊으면 재발급)");
}

console.log("\n[뮤테이션ⓑ] 코드 생성기를 비암호 PRNG 로 바꾸면 ⑤가 실패해야 함");
{
  const src = rd("src/lib/util.ts");
  const needle = "  const a = new Uint8Array(10)   // 80비트 뽑아 75비트 사용\n  crypto.getRandomValues(a)";
  const mutated = src.replace(needle, "  const a = new Uint8Array(10)\n  for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256)");
  if (mustPatch(src, mutated, "randShareCode 난수원")) {
    const fnM = (mutated.match(/export function randShareCode\(\)[\s\S]*?\n}/) || [""])[0];
    ok(!fnM.includes("crypto.getRandomValues") && /Math\s*\.\s*random/.test(fnM), "뮤테이션 적용 시 ⑤a/⑤b 가 깨진다(암호난수 아님을 탐지)");
  }
}

console.log("\n[⑥ 만료·폐기 코드 거부]");
{
  const s2 = await scenario();
  const rev = await s2.call("POST", `/api/share-codes/${s2.made.id}/revoke`, { token: SUP, body: {} });
  ok(rev.status === 200, "⑥a 🔴 폐기 API 200 (유출 시 끊을 수단) (실제 " + rev.status + ")");
  const r = await s2.call("POST", "/api/share/verify", { body: { t: s2.shareToken, company: "c", name: "n", code: s2.made.code } });
  const j = await J(r);
  ok(r.status === 403 && j.error === "revoked-code", "⑥b 폐기된 코드 → 403 revoked-code (실제 " + r.status + "/" + (j && j.error) + ")");
  ok(s2.st.logs.some((l) => l.action === "share.denied" && JSON.parse(l.detail).reason === "revoked-code"), "⑥c 거부도 기록된다(유출 시점 추적)");
  const st = await J(await s2.call("GET", "/api/share-gate?t=" + s2.shareToken));
  ok(st.gated === false, "⑥d 살아있는 코드 0개 → gated=false (운영자에게 '지금 잠겨있지 않다'를 정직하게 알린다)");

  const s3 = await scenario();
  s3.st.codes[0].expires_at = Date.now() - 1000;
  const r3 = await s3.call("POST", "/api/share/verify", { body: { t: s3.shareToken, company: "c", name: "n", code: s3.made.code } });
  const j3 = await J(r3);
  ok(r3.status === 403 && j3.error === "expired-code", "⑥e 만료된 코드 → 403 expired-code (실제 " + r3.status + "/" + (j3 && j3.error) + ")");
  const s4 = await scenario();
  const made2 = await J(await s4.call("POST", `/api/projects/${PID}/share-codes`, { token: SUP, body: { label: "30일", ttl_days: 30 } }));
  ok(made2.expires_at > Date.now() && made2.expires_at < Date.now() + 31 * 86400000, "⑥f ttl_days 로 만료일이 실제로 설정된다");
}

console.log("\n[뮤테이션ⓔ] 만료·폐기 검사를 제거하면 ⑥이 실패해야 함");
{
  const w = await buildWorker([{ file: "index.tsx",
    from: "  const bad = !row ? 'unknown-code' : (row.revoked ? 'revoked-code' : ((row.expires_at && row.expires_at <= now) ? 'expired-code' : null))",
    to:   "  const bad = !row ? 'unknown-code' : null" }]);
  if (w) {
    const s2 = await scenario(w);
    await s2.call("POST", `/api/share-codes/${s2.made.id}/revoke`, { token: SUP, body: {} });
    const r = await s2.call("POST", "/api/share/verify", { body: { t: s2.shareToken, company: "c", name: "n", code: s2.made.code } });
    ok(r.status === 200, "뮤테이션 적용 시 폐기된 코드로도 통과한다(⑥b 가 깨짐을 확인) → " + r.status);
    s2.st.codes[0].expires_at = Date.now() - 1000;
    const r2 = await s2.call("POST", "/api/share/verify", { body: { t: s2.shareToken, company: "c", name: "n", code: s2.made.code } });
    ok(r2.status === 200, "뮤테이션 적용 시 만료된 코드로도 통과한다(⑥e 가 깨짐을 확인) → " + r2.status);
  }
}

console.log("\n[⑦ 🔴 게이트 통과 후에도 쓰기 403 — p48 회귀 금지]");
{
  const before = S.st.writes.length;
  const w1 = await S.call("PATCH", "/tables/deployments/" + DEP, { token: PASS, body: { pins: [{ id: "hack" }] } });
  ok(w1.status === 403, "⑦a 통행증으로 PATCH /tables/deployments → 403 (실제 " + w1.status + ")");
  const w2 = await S.call("POST", `/api/projects/${PID}/unpublish`, { token: PASS, body: {} });
  ok(w2.status === 403, "⑦b 통행증으로 unpublish → 403 (실제 " + w2.status + ")");
  const w3 = await S.call("POST", `/api/projects/${PID}/share-codes`, { token: PASS, body: { label: "self" } });
  ok(w3.status === 403, "⑦c 🔴 통행증으로 코드 자가발급 불가 → 403 (실제 " + w3.status + ")");
  ok(S.st.writes.length === before, "⑦d DB 쓰기 0건 (실제 " + (S.st.writes.length - before) + "건)");
  const payload = JSON.parse(Buffer.from(PASS.slice(4).split(".")[0], "base64url").toString());
  ok(payload.k === "viewer" && payload.g === PID, "⑦e 통행증 claim: kind=" + payload.k + " gate=" + payload.g);
  const me = await J(await S.call("GET", "/api/auth/me", { token: PASS }));
  ok(me.readonly === true, "⑦f /api/auth/me 가 열람전용임을 정직하게 보고");
}

console.log("\n[뮤테이션ⓓ] 게이트 통과에 쓰기를 허용하면 ⑦이 실패해야 함");
{
  const w = await buildWorker([{ file: "index.tsx",
    from: "  if (gatePid) kind = 'viewer'   // [불변식] 게이트 통과가 쓰기 권한이 되는 경로를 원천 차단",
    to:   "  if (gatePid) kind = 'designer'" },
    // [WO 20261001-invite] 공용석 종료(designer 토큰 전면 무효)가 이 불변식을 가리지 않도록, 공용석이 열린 상태를 가정해 검사한다
    { file: "index.tsx", from: "const AUTO_DESIGNER_TOKEN_ENABLED = false", to: "const AUTO_DESIGNER_TOKEN_ENABLED = true" }]);
  if (w) {
    const s2 = await scenario(w);
    const j = await J(await s2.call("POST", "/api/share/verify", { body: { t: s2.shareToken, company: "c", name: "n", code: s2.made.code } }));
    const r = await s2.call("PATCH", "/tables/deployments/" + DEP, { token: j.token, body: { pins: [] } });
    ok(r.status === 200, "뮤테이션 적용 시 통행증으로 쓰기가 뚫린다(⑦a 가 깨짐을 확인) → " + r.status);
  }
}

// [WO 20261009-readacl] 게이트 판정이 2겹이 됐다 — 읽기 미들웨어 + 읽기 SoT(readScopeOf, 목록 경로까지 덮는다).
//   한 겹만 걷어내면 다른 겹이 막으므로(심층 방어) 뮤테이션은 **두 겹 모두** 제거해야 ①이 깨진다.
console.log("\n[뮤테이션ⓐ] 서버 게이트 가드(미들웨어 + 읽기 SoT)를 제거하면 ①이 실패해야 함");
{
  const w = await buildWorker([{ file: "index.tsx",
    from: "  if (!GATED_READ_PREFIXES.some((x) => p.startsWith(x))) return next()",
    to:   "  if (true) return next()" },
  { file: "index.tsx",
    // [2026-10-10] 판정 본체가 validLinkPids(익명 토큰·로그인 링크 공유)로 이동 — 들여쓰기 4칸
    // [WO 20261012-viewlink] 410 판정(배포 중단 링크 미들웨어)이 같은 함수를 ignoreGate 로 공유 — 조건식 앞에 옵션 검사가 붙었다
    from: "    if (!(opts && opts.ignoreGate) && await shareGateLockedPid(c, user, [String(pid)])) continue",
    to:   "" }]);
  if (w) {
    const s2 = await scenario(w);
    const r = await s2.call("GET", "/tables/deployments/" + DEP, { token: s2.viewer });
    ok(r.status === 200, "뮤테이션 적용 시 코드 없이 도면 데이터가 나간다(①이 깨짐을 확인) → " + r.status);
  }
}

console.log("\n[⑧ `?d=` 하위호환 + 동일 게이트 적용]");
{
  const s2 = await scenario();
  const g = await J(await s2.call("GET", "/api/share-gate?d=" + DEP));
  ok(g.matched === true && g.project.id === PID, "⑧a `?d=` 로도 프로젝트가 해석된다 → " + g.project.name);
  ok(g.gated === true, "⑧b 🔴 `?d=` 에도 게이트가 걸린다(우회로 차단)");
  const blocked = await s2.call("GET", "/tables/deployments/" + DEP, { token: s2.viewer });
  ok(blocked.status === 403, "⑧c `?d=` 세션도 코드 없이는 403 (실제 " + blocked.status + ")");
  const j = await J(await s2.call("POST", "/api/share/verify", { body: { d: DEP, company: "협력사", name: "이현장", code: s2.made.code } }));
  ok(j.ok === true, "⑧d `?d=` 로도 코드 검증이 된다(링크가 죽지 않는다)");
  const after = await s2.call("GET", "/tables/deployments/" + DEP, { token: j.token });
  ok(after.status === 200, "⑧e 통과 후 기존 `?d=` 링크가 정상 열람 (실제 " + after.status + ")");
  const s3 = await scenario();
  s3.st.codes.length = 0;
  const legacy = await s3.call("GET", "/tables/deployments/" + DEP, { token: s3.viewer });
  ok(legacy.status === 200, "⑧f 🔴 코드 미발급 프로젝트는 종전대로 열람 — 마이그레이션 직후 현장이 멈추지 않는다 (실제 " + legacy.status + ")");
  // 🔴 라이브 재현 회귀: 한 배포본을 두 프로젝트가 참조하고 **한쪽만** 잠겨 있을 때
  //   LIMIT 1 로 안 잠긴 쪽을 고르면 게이트가 그대로 뚫린다(fail-open). 반드시 fail-closed.
  const s5 = await scenario();
  s5.st.decks.push({ id: "dck_dup", project_id: PID2, deployment_id: DEP, level_no: 1, created_at: 0, deleted: 0 });
  const dup = await s5.call("GET", "/tables/deployments/" + DEP, { token: s5.viewer });
  ok(dup.status === 403, "⑧i 🔴 두 프로젝트가 공유하는 배포본 — 한쪽만 잠겨도 차단(fail-closed) → " + dup.status);
  const footer = rd("public/js/modules/99_footer.js");
  ok(/ShareGate\.ensure\(\{ d: depId \}\)/.test(footer), "⑧g 클라이언트도 `?d=` 경로에서 게이트를 지난다");
  ok(/}\s*else if \(depId\) \{/.test(footer), "⑧h `?d=` 진입 분기 자체는 살아 있다(p61 ④ 회귀 0)");
}

console.log("\n[⑨ 세션 재입력 불필요 · 교차 프로젝트 차단]");
{
  const a = await S.call("GET", "/tables/deployments/" + DEP, { token: PASS });
  const b = await S.call("GET", "/api/notes/summary?deployment_id=" + DEP, { token: PASS });
  ok(a.status === 200 && b.status === 200, "⑨a 같은 통행증으로 반복 열람 200/200 (실제 " + a.status + "/" + b.status + ")");
  const g = await J(await S.call("GET", "/api/share-gate?t=" + S.shareToken, { token: PASS }));
  ok(g.passed === true, "⑨b 게이트 상태 조회가 passed=true → 클라이언트가 모달을 띄우지 않는다");
  const gate = rd("public/js/modules/01d_ShareGate.js");
  ok(/localStorage\.setItem\(this\._passKey/.test(gate), "⑨c 통행증을 브라우저에 보관한다(재방문 시 재입력 없음)");
  ok(/j\.exp < Date\.now\(\)/.test(gate), "⑨d 만료된 보관 통행증은 버린다");
  const payload = JSON.parse(Buffer.from(PASS.slice(4).split(".")[0], "base64url").toString());
  const days = Math.round((payload.exp - Date.now()) / 86400000);
  ok(days > 0 && days <= 30, "⑨e 통행증 유효기간 " + days + "일 — 무기한이 아니다(폐기가 최장 이 기간 내 반영)");
  // 🔴 교차 사용 — A 통행증으로 B 프로젝트 도면을 열 수 없어야 한다.
  await S.call("POST", `/api/projects/${PID2}/publish`, { token: SUP, body: {} });
  await S.call("POST", `/api/projects/${PID2}/share-codes`, { token: SUP, body: { label: "B현장" } });
  const cross = await S.call("GET", "/tables/deployments/" + DEP2, { token: PASS });
  ok(cross.status === 403, "⑨f 🔴 A 통행증으로 B 프로젝트 도면 열람 → 403 (실제 " + cross.status + ")");
  const stillA = await S.call("GET", "/tables/deployments/" + DEP, { token: PASS });
  ok(stillA.status === 200, "⑨f-2 자기 프로젝트(A)는 그대로 200 (실제 " + stillA.status + ")");
  const forged = "ae1." + Buffer.from(JSON.stringify({ k: "viewer", exp: Date.now() + 1e6, n: "x", g: PID2 })).toString("base64url") + ".AAAA";
  const r = await S.call("GET", "/tables/deployments/" + DEP2, { token: forged });
  ok(r.status !== 200, "⑨g 🔴 서명 없는 위조 통행증은 통하지 않는다 → " + r.status);
}

console.log("\n[⑩ 개인정보 보관기간 상수 SoT]");
{
  const idx = rd("src/index.tsx");
  const defs = (idx.match(/const PERSONAL_LOG_RETENTION_DAYS\s*=/g) || []).length;
  const hits = (idx.match(/PERSONAL_LOG_RETENTION_DAYS/g) || []).length;
  ok(defs === 1, "⑩a 정의가 정확히 1곳 → " + defs + "곳");
  ok(hits >= 2, "⑩b 그 상수를 실제로 참조한다(장식 아님) → 등장 " + hits + "회");
  ok(/const PERSONAL_LOG_RETENTION_DAYS = 365/.test(idx), "⑩c 값 = 365일(1년)");
  ok((idx.match(/retention_days:\s*\d+/g) || []).length === 0, "⑩d 숫자를 직접 박은 곳 0 — 값이 두 곳에 생기면 반드시 갈라진다");
  const mig = rd("migrations/0027_project_share_codes.sql");
  ok(mig.includes("PERSONAL_LOG_RETENTION_DAYS"), "⑩e 마이그레이션 주석이 정본 상수를 가리킨다(문서-코드 SoT 연결)");
  ok(/1년|365/.test(mig), "⑩f 마이그레이션에 보관기간 정책과 근거가 적혀 있다");
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
