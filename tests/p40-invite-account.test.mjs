/**
 * 회귀 테스트 P40 — 프로젝트 초대 링크 / 이름·비번 설정 / 오프라인 재인증 / PWA 설치 유도
 * 실행: node tests/p40-invite-account.test.mjs      (프레임워크 0)
 *
 * ── 결함(이번에 없앤 것) ────────────────────────────────────────────────
 * POST /api/projects/:id/members 는 초대 즉시 local_users 를 **비밀번호 '1'** 로 만들었다.
 * must_change_password=1 로 변경을 강제해도, 본인이 첫 로그인 하기 전의 창에서
 * 이메일을 아는 제3자가 <email> + '1' 로 선점 로그인할 수 있었다(계정 탈취).
 * → 초대 시 계정을 만들지 않고 1회용 초대 토큰만 발급하도록 구조를 바꿨다.
 *
 * ── 목(mock) 금지 ───────────────────────────────────────────────────────
 * 서버 항목(①②③④⑤)은 **실제로 빌드한 워커(dist/_worker.js)를 miniflare 에 올리고
 * 실제 D1(SQLite)에 실제 migrations/*.sql 을 적용해** HTTP 로 때린다. DB 스텁 없음.
 * 클라이언트 항목(⑥⑦⑧⑨)은 실제 모듈 소스(22_Auth.js / 05_SyncQueue.js / 38_Install.js)를
 * 원문 그대로 vm 에 평가해 실행한다. 해시는 node webcrypto 로 실제 PBKDF2 를 돌린다.
 * ⑩은 CSS 를 **수치로 파싱**해 겹침 면적을 계산한다(문자열 포함검사 아님).
 *
 * 검증 항목:
 *  ① 초대 시 기본 비밀번호 계정이 생성되지 않는다 (이번 결함의 핵심 회귀)
 *  ② 초대 토큰이 crypto.getRandomValues 기반 128비트 이상 + DB 에 원문 미저장
 *  ③ 이름 빈 값이면 계정 생성 거부
 *  ④ 토큰은 1회만 사용 가능, 만료 후 거부
 *  ⑤ 기존 계정 이메일 초대 시 새 계정을 만들지 않고 멤버만 추가
 *  ⑥ 오프라인 검증자에 평문 비밀번호가 없다 (+ 서버와 동일 KDF 임을 실제 값으로 교차검증)
 *  ⑦ 오프라인 인증 상태로는 서버 쓰기가 승인되지 않는다
 *  ⑧ 로그아웃 시 오프라인 검증자가 삭제된다
 *  ⑨ PWA 설치 안내가 standalone 에서는 안 뜬다
 *  ⑩ 설치 안내와 .mobile-dock 겹침 면적 0 (CSS 값 수치 파싱)
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Miniflare } from "miniflare";
import { majorityVerdict, CHI_THRESHOLD } from "./_lib/chi-judge.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 브레이스-밸런싱 발췌: needle 부터 매칭되는 닫는 중괄호까지 원문 그대로 ── */
function endOfBlock(src, needle) {
  const start = src.indexOf(needle);
  if (start < 0) throw new Error("needle not found: " + needle);
  const braceStart = src.indexOf("{", start);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  return i;
}
/** 파일 앞부분(상수 선언 포함) ~ 객체 리터럴 끝까지 — 원문 그대로 */
function sliceThroughObject(src, needle) { return src.slice(0, endOfBlock(src, needle) + 1) + ";"; }
function extractBalanced(src, needle) {
  const start = src.indexOf(needle);
  return src.slice(start, endOfBlock(src, needle) + 1);
}
/** 실제 src/lib/util.ts 의 randInviteToken() 소스를 그대로 추출해 vm 에서 평가한다
 *  (HTTP 왕복 없이 in-process 로 대량 표본을 빠르게 뽑아 통계 검정 표본 수를 늘리기 위함).
 *  TS 반환형 주석(": string")만 벗겨낸다 — 로직은 원문 그대로다. */
function loadRealRandInviteToken() {
  const utilSrc = rd("src/lib/util.ts");
  const fnSrc = extractBalanced(utilSrc, "export function randInviteToken()")
    .replace(/^export\s+/, "")
    .replace(/\)\s*:\s*string(?=\s*\{)/, ")");
  const sandbox = { crypto };
  vm.createContext(sandbox);
  vm.runInContext(fnSrc + "\nglobalThis.__fn = randInviteToken;", sandbox);
  return sandbox.__fn;
}

/* ══════════════════════════════════════════════════════════════════════
 * 서버 하네스 — 실제 워커 + 실제 D1
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[빌드] src → dist/_worker.js (테스트가 실제로 검증하는 대상과 소스를 일치시킨다)");
execFileSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
  cwd: ROOT, stdio: "pipe", env: Object.assign({}, process.env, { NODE_OPTIONS: "--max-old-space-size=896" })
});
console.log("  빌드 완료");

const mf = new Miniflare({
  modules: true,
  scriptPath: path.join(ROOT, "dist/_worker.js"),
  modulesRoot: path.join(ROOT, "dist"),
  compatibilityDate: "2025-05-01",
  compatibilityFlags: ["nodejs_compat"],
  d1Databases: { DB: ":memory:" },
  r2Buckets: ["R2"],
  bindings: { SUPER_ADMIN_EMAIL: "designssir@gmail.com", SUPER_ADMIN_EMAILS: "designssir@gmail.com" },
});
const db = await mf.getD1Database("DB");

// 실제 migrations/*.sql 전량 적용 (0024_project_invites.sql 포함)
{
  const files = fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  let applied = 0;
  for (const f of files) {
    const sql = rd("migrations/" + f).replace(/--[^\n]*/g, "");
    for (let s of sql.split(";")) {
      s = s.trim(); if (!s) continue;
      await db.prepare(s).run(); applied++;
    }
  }
  console.log("  migrations 적용: " + files.length + "개 파일 / " + applied + "개 statement");
}

const BOSS = "boss@seastargo.com";
const PID = "prj_p40";
const NOW = Date.now();
await db.prepare("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, ?, '', ?, ?, ?, 0)")
  .bind(PID, "P40 초대 테스트", BOSS, NOW, NOW).run();
await db.prepare("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, '관리자', 'seastargo.com', 'x', 'y', 1, ?, ?, 0)")
  .bind(BOSS, NOW, NOW).run();
await db.prepare("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, '관리자', 'seed', ?, ?, 0)")
  .bind(BOSS, NOW, NOW).run();
const BOSS_TOKEN = "local-p40bosstoken";
await db.prepare("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)")
  .bind(BOSS_TOKEN, BOSS, NOW, NOW + 86400000).run();

const api = async (url, opts = {}) => {
  const res = await mf.dispatchFetch("http://p40.test" + url, opts);
  let body = null;
  try { body = JSON.parse(await res.text()); } catch (e) { body = null; }
  return { status: res.status, body };
};
const asBoss = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + BOSS_TOKEN },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const countRows = async (sql, ...args) => {
  const r = await db.prepare(sql).bind(...args).first();
  return Number(Object.values(r)[0]);
};

/* ══════════════════════════════════════════════════════════════════════
 * ① 초대 시 기본 비밀번호 계정이 생성되지 않는다  (이번 결함의 핵심 회귀)
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[① 초대 → 기본 비밀번호 계정이 생기지 않는다]");
const NEWBIE = "newbie@seastargo.com";
const inviteRes = await api("/api/projects/" + PID + "/members", asBoss("POST", { email: NEWBIE, role: "viewer" }));
ok(inviteRes.status === 200, "① 초대 요청 200: " + inviteRes.status);
ok(inviteRes.body && inviteRes.body.invited === true && typeof inviteRes.body.invite_url === "string",
   "① 응답이 초대 링크를 준다(계정 생성 아님): invited=" + (inviteRes.body && inviteRes.body.invited));
ok(inviteRes.body && inviteRes.body.created === false, "① created=false (계정 미생성 명시)");
ok((await countRows("SELECT COUNT(*) FROM local_users WHERE email = ?", NEWBIE)) === 0,
   "🔴① local_users 에 행이 생기지 않는다 = 기본 비밀번호 선점 로그인 불가");
ok((await countRows("SELECT COUNT(*) FROM project_members WHERE project_id = ? AND email = ?", PID, NEWBIE)) === 0,
   "① 수락 전에는 project_members 권한도 없다");
// 기본 비밀번호 '1' 로 로그인이 되는지 실제로 때려본다 — 되면 그게 결함이다
const preLogin = await api("/api/signup/login", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: NEWBIE, password: "1" }) });
ok(preLogin.status === 401, "🔴① 초대받은 이메일 + 비밀번호 '1' 로그인 거부(401): 실제 " + preLogin.status);

/* ══════════════════════════════════════════════════════════════════════
 * ② 토큰 = 암호난수 128비트 이상 · DB 에 원문 미저장
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[② 초대 토큰 — 암호난수 128비트+ / DB 에 원문 없음]");
const rawToken = new URL(inviteRes.body.invite_url).searchParams.get("invite");
ok(/^[0-9a-f]+$/.test(rawToken) && rawToken.length >= 32,
   "② 토큰이 hex 이고 128비트 이상: " + (rawToken.length * 4) + "비트(" + rawToken.length + " hex)");
ok(rawToken.length === 64, "② 실제 길이 256비트(요구치 128비트의 2배)");

// DB 의 초대행 어느 컬럼에도 토큰 원문이 없어야 한다 (전 컬럼 스캔)
const invRow = await db.prepare("SELECT * FROM project_invites WHERE project_id = ? AND email = ?").bind(PID, NEWBIE).first();
const invDump = JSON.stringify(invRow);
ok(invDump.indexOf(rawToken) < 0, "🔴② DB 초대행 어느 컬럼에도 토큰 원문이 없다");
// 저장된 값이 SHA-256(token) 인지 실제로 계산해 대조
const sha = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))))
  .map((b) => b.toString(16).padStart(2, "0")).join("");
ok(invRow.token_hash === (await sha(rawToken)), "② 저장값 = SHA-256(token) — 해시만 보관");

// 런타임 난수 품질: 200개 발급(HTTP, 실서버 경로) → 전부 유일 + hex 자리 분포가 균등(카이제곱)
let httpTokens;
{
  const tokens = [];
  for (let i = 0; i < 200; i++) {
    const r = await api("/api/projects/" + PID + "/members", asBoss("POST", { email: "bulk" + i + "@seastargo.com", role: "viewer" }));
    tokens.push(new URL(r.body.invite_url).searchParams.get("invite"));
  }
  ok(new Set(tokens).size === 200, "② 200개 토큰 전부 유일(충돌 0)");
  httpTokens = tokens;
}
// 🔴 표본 1회 카이제곱 판정(임계값 37.7=df15 p=0.001)은 정상 난수도 약 1/1000 확률로 거짓 실패한다
// (2026-09-28 실측: node --test 3연속 중 1회 발생). → 독립 표본 3회 중 2회 이상 통과로 완화
// (거짓 실패율 ≈ 3e-6, tests/_lib/chi-judge.mjs 참조). 표본1=실서버 HTTP 200개, 표본2·3=
// 같은 실제 randInviteToken() 소스를 in-process 로 평가해 빠르게 추가 표본 확보(HTTP 375회 왕복 회피).
{
  const realGen = loadRealRandInviteToken();
  const trial2 = Array.from({ length: 200 }, () => realGen());
  const trial3 = Array.from({ length: 200 }, () => realGen());
  ok(new Set(trial2).size === 200 && new Set(trial3).size === 200, "② in-process 표본도 전부 유일(충돌 0)");
  const v = majorityVerdict([httpTokens, trial2, trial3]);
  ok(v.ok, "🔴② hex 자리 분포 균등 — 독립 표본 3회 중 " + v.passCount + "/3 통과(각 카이제곱 "
     + v.chis.map((c) => c.toFixed(1)).join(", ") + " / 임계값 " + CHI_THRESHOLD + "=df15 p.001)");

  // 카나리아 ①: Math.random 기반 소스였다면 정적 검사가 여전히 거부하는지(판정 로직 자체 회귀 방지)
  const fakeMathRandomSrc = "function randInviteToken() {\n  let h = '';\n"
    + "  for (let i = 0; i < 64; i++) h += Math.floor(Math.random() * 16).toString(16);\n  return h\n}";
  const wouldPassStaticCheck = fakeMathRandomSrc.includes("crypto.getRandomValues") && !fakeMathRandomSrc.includes("Math.random");
  ok(wouldPassStaticCheck === false, "🔴② 카나리아①: Math.random 기반 생성기 소스는 아래 정적 검사가 여전히 걸러낸다");

  // 카나리아 ②: hex 한 자리를 약하게 편향(0~e 만, 'f' 배제)시킨 생성기는 majorityVerdict 가 여전히 잡아내는지
  const biasedToken = () => {
    let h = "";
    for (let i = 0; i < 64; i++) {
      let d; do { d = Math.floor(Math.random() * 16); } while (d === 15);
      h += d.toString(16);
    }
    return h;
  };
  const biasedTrials = [0, 1, 2].map(() => Array.from({ length: 200 }, biasedToken));
  const biasedVerdict = majorityVerdict(biasedTrials);
  ok(biasedVerdict.ok === false, "🔴② 카나리아②: 0~e 편향 생성기(3/3 표본)는 판정이 여전히 FAIL(카이제곱 "
     + biasedVerdict.chis.map((c) => c.toFixed(1)).join(", ") + ") — 통계 검정이 실제로 약화되지 않았음을 증명");
}
// 🔴 CSPRNG 여부는 출력만 봐서는 PRNG 와 구별할 수 없다(이론적 한계) → 생성기 소스를 직접 확인한다.
{
  const utilSrc = rd("src/lib/util.ts");
  const genSrc = extractBalanced(utilSrc, "export function randInviteToken()");
  ok(genSrc.includes("crypto.getRandomValues"), "🔴② 생성기가 crypto.getRandomValues 를 쓴다");
  ok(!genSrc.includes("Math.random"), "🔴② 생성기에 Math.random 이 없다");
  const m = genSrc.match(/new\s+Uint8Array\((\d+)\)/);
  ok(m && Number(m[1]) * 8 >= 128, "🔴② 난수 바이트 길이 " + (m ? Number(m[1]) * 8 : 0) + "비트 ≥ 128비트");
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 이름 빈 값이면 계정 생성 거부
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[③ 이름 필수 — 빈 값이면 계정 생성 거부]");
const FIELD_PW = "Field-Pass-2026!";
{
  const r = await api("/api/invite/" + rawToken + "/accept", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "   ", password: FIELD_PW }) });
  ok(r.status === 400, "🔴③ 이름 공백 → 400 거부: 실제 " + r.status);
  ok((await countRows("SELECT COUNT(*) FROM local_users WHERE email = ?", NEWBIE)) === 0, "③ 거부 후에도 계정 미생성");
  ok((await countRows("SELECT COUNT(*) FROM project_invites WHERE token_hash = ? AND used = 0", await sha(rawToken))) === 1,
     "③ 거부 시 토큰이 소비되지 않는다(재시도 가능)");
}
{
  const r = await api("/api/invite/" + rawToken + "/accept", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "김현장", password: "short" }) });
  ok(r.status === 400, "③ 비밀번호 8자 미만 → 400 거부: 실제 " + r.status);
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 토큰 1회 사용 · 만료 거부
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[④ 1회용 · 만료]");
const accepted = await api("/api/invite/" + rawToken + "/accept", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "김현장", password: FIELD_PW }) });
ok(accepted.status === 200 && accepted.body.success === true, "④ 이름+비번 입력 → 수락 성공: " + accepted.status);
ok(String(accepted.body.token || "").startsWith("local-"), "④ 기존 local_sessions 경로로 세션 발급(새 체계 없음)");
ok((await countRows("SELECT COUNT(*) FROM local_users WHERE email = ?", NEWBIE)) === 1, "④ 이 시점에 비로소 계정 생성");
ok((await countRows("SELECT COUNT(*) FROM project_members WHERE project_id = ? AND email = ?", PID, NEWBIE)) === 1, "④ 멤버 등록 동시 수행");
{
  const again = await api("/api/invite/" + rawToken + "/accept", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "침입자", password: "Another-Pass-1!" }) });
  ok(again.status === 404 || again.status === 409, "🔴④ 같은 토큰 재사용 거부: 실제 " + again.status);
  const u = await db.prepare("SELECT name FROM local_users WHERE email = ?").bind(NEWBIE).first();
  ok(u.name === "김현장", "④ 재사용으로 계정이 덮어써지지 않는다: name=" + u.name);
}
{
  // 만료 토큰 — 실제 발급된 토큰의 expires_at 을 과거로 돌려 서버 판정을 그대로 태운다
  const EXPIRED = "expired@seastargo.com";
  const r = await api("/api/projects/" + PID + "/members", asBoss("POST", { email: EXPIRED, role: "viewer" }));
  const t = new URL(r.body.invite_url).searchParams.get("invite");
  await db.prepare("UPDATE project_invites SET expires_at = ? WHERE token_hash = ?").bind(Date.now() - 1000, await sha(t)).run();
  const info = await api("/api/invite/" + t);
  ok(info.status === 404, "🔴④ 만료 토큰 조회 거부(404): 실제 " + info.status);
  const acc = await api("/api/invite/" + t + "/accept", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "늦은사람", password: FIELD_PW }) });
  ok(acc.status === 404, "🔴④ 만료 토큰 수락 거부(404): 실제 " + acc.status);
  ok((await countRows("SELECT COUNT(*) FROM local_users WHERE email = ?", EXPIRED)) === 0, "④ 만료 수락으로 계정이 생기지 않는다");
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 기존 계정 이메일 초대 → 새 계정 없이 멤버만 추가
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[⑤ 기존 계정 초대 → 멤버만 추가]");
{
  const VET = "veteran@seastargo.com";
  await db.prepare("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, '고참', 'seastargo.com', 'HASH_KEEP', 'SALT_KEEP', 1, ?, ?, 0)")
    .bind(VET, NOW, NOW).run();
  const before = await countRows("SELECT COUNT(*) FROM local_users");
  const r = await api("/api/projects/" + PID + "/members", asBoss("POST", { email: VET, role: "designer" }));
  ok(r.status === 200 && r.body.existing === true && !r.body.invited,
     "⑤ 기존 계정은 초대 링크 없이 즉시 배정: existing=" + (r.body && r.body.existing) + " invited=" + (r.body && r.body.invited));
  ok((await countRows("SELECT COUNT(*) FROM local_users")) === before, "⑤ 계정 총수 불변(새 계정 생성 0)");
  const u = await db.prepare("SELECT name, pw_hash, pw_salt FROM local_users WHERE email = ?").bind(VET).first();
  ok(u.name === "고참" && u.pw_hash === "HASH_KEEP" && u.pw_salt === "SALT_KEEP", "🔴⑤ 이름·비밀번호를 다시 묻지도, 덮어쓰지도 않는다");
  ok((await countRows("SELECT COUNT(*) FROM project_members WHERE project_id = ? AND email = ?", PID, VET)) === 1, "⑤ 멤버십만 추가됨");
  ok((await countRows("SELECT COUNT(*) FROM project_invites WHERE email = ?", VET)) === 0, "⑤ 불필요한 초대 토큰을 만들지 않는다");
}

// ⑥ 교차검증용 — 서버가 실제로 저장한 해시/솔트
const SERVER_CRED = await db.prepare("SELECT pw_hash, pw_salt FROM local_users WHERE email = ?").bind(NEWBIE).first();

await mf.dispose();

/* ══════════════════════════════════════════════════════════════════════
 * 클라이언트 하네스 — 실제 모듈 소스를 vm 에 그대로 평가
 * ══════════════════════════════════════════════════════════════════════ */
function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => x && set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle: (c, f) => { if (f === undefined) { set.has(c) ? set.delete(c) : set.add(c); } else if (f) set.add(c); else set.delete(c); },
    contains: (c) => set.has(c),
  };
}
function makeEl() {
  const el = { _text: "", value: "", disabled: false };
  Object.defineProperty(el, "textContent", { get() { return this._text; }, set(v) { this._text = v == null ? "" : String(v); } });
  el.classList = makeClassList();
  el.classList.add("hidden");
  el.addEventListener = () => {};
  return el;
}
function makeDom(ids) {
  const reg = {};
  ids.forEach((id) => { reg[id] = makeEl(); });
  return {
    reg,
    document: {
      getElementById: (id) => reg[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => makeEl(),
      addEventListener: () => {},
      body: { appendChild: () => {} },
    },
  };
}
function makeStorage() {
  const s = {};
  return {
    getItem: (k) => (k in s ? s[k] : null),
    setItem: (k, v) => { s[k] = String(v); },
    removeItem: (k) => { delete s[k]; },
    key: (i) => Object.keys(s)[i] || null,
    get length() { return Object.keys(s).length; },
    _raw: s,
  };
}

const authSrc = rd("public/js/modules/22_Auth.js");
const syncSrc = rd("public/js/modules/05_SyncQueue.js");
const installSrc = rd("public/js/modules/38_Install.js");

/** Auth + SyncQueue 를 한 컨텍스트에 실제 소스 그대로 올린다(서로를 참조하므로). */
function makeAuthSandbox() {
  const fetchLog = [];
  let fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) });
  const { document } = makeDom([]);
  const localStorage = makeStorage();
  const sandbox = {
    console, document, localStorage,
    sessionStorage: makeStorage(),
    navigator: { onLine: true },
    crypto, TextEncoder, TextDecoder, Uint8Array, Set, Map, Math, JSON, Date, Object, Array, Promise, Number, String,
    setTimeout, clearTimeout, requestAnimationFrame: (fn) => fn(),
    State: { mode: "viewer" },
    Prompt: { toast: () => {} },
    fetch: (...a) => { fetchLog.push(a); return fetchImpl(...a); },
    window: {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(sliceThroughObject(syncSrc, "const SyncQueue = {"), sandbox);
  vm.runInContext(sliceThroughObject(authSrc, "const Auth = {"), sandbox);
  vm.runInContext("globalThis.__Auth = Auth; globalThis.__SQ = SyncQueue;", sandbox);
  return { Auth: sandbox.__Auth, SQ: sandbox.__SQ, fetchLog, localStorage, setFetch: (f) => { fetchImpl = f; } };
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 오프라인 검증자에 평문 비밀번호가 없다
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[⑥ 오프라인 검증자 — 평문 없음 + 서버와 동일 KDF]");
{
  const { Auth, SQ } = makeAuthSandbox();
  const saved = await Auth.saveOfflineVerifier(NEWBIE, FIELD_PW, { name: "김현장", role: "viewer" });
  ok(saved === true, "⑥ 검증자 저장 성공");
  const rec = await SQ.loadAuthRecord();
  const dump = JSON.stringify(rec);
  ok(dump.indexOf(FIELD_PW) < 0, "🔴⑥ 저장 레코드 어디에도 평문 비밀번호가 없다");
  ok(!("password" in rec) && !("pw" in rec), "⑥ password/pw 필드 자체가 없다");
  ok(/^[0-9a-f]{64}$/.test(rec.verifier), "⑥ 검증자 = 256비트 해시 hex");
  ok(/^[0-9a-f]{32}$/.test(rec.salt), "⑥ 기기별 salt = 128비트");
  // 🔴 서버가 실제로 저장한 해시와 교차검증 — 같은 KDF(PBKDF2-SHA256 100k/256bit)임을 값으로 증명
  const asServer = await Auth._deriveVerifier(FIELD_PW, SERVER_CRED.pw_salt);
  ok(asServer === SERVER_CRED.pw_hash, "🔴⑥ 클라 _deriveVerifier(비번, 서버salt) === 서버 pw_hash (동일 KDF 증명)");
  ok(rec.verifier !== SERVER_CRED.pw_hash, "⑥ 기기 검증자는 서버 해시와 다른 salt → 값 재사용 불가");
  // 실제 재인증 동작
  const bad = await Auth.offlineLogin(NEWBIE, "wrong-password");
  ok(bad.ok === false && bad.reason === "bad-password", "⑥ 잘못된 비밀번호 → 거부");
  const good = await Auth.offlineLogin(NEWBIE, FIELD_PW);
  ok(good.ok === true && good.user.email === NEWBIE, "⑥ 올바른 비밀번호 → 오프라인 재인증 성공");
  ok(Auth.idToken === null, "🔴⑥ 오프라인 인증은 서버 세션 토큰을 만들지 않는다");
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑦ 오프라인 인증 상태로는 서버 쓰기가 승인되지 않는다
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[⑦ 오프라인 인증 → 서버 쓰기 차단]");
{
  const { Auth, SQ, fetchLog, setFetch } = makeAuthSandbox();
  await Auth.saveOfflineVerifier(NEWBIE, FIELD_PW, { name: "김현장", role: "viewer" });
  await Auth.offlineLogin(NEWBIE, FIELD_PW);
  ok(Auth.canServerWrite() === false, "🔴⑦ canServerWrite() === false");
  await SQ.enqueue({ kind: "image", name: "field.jpg", image_data: "d1" });
  const before = fetchLog.length;
  const r = await SQ.flush();
  ok(r.offlineAuth === true, "🔴⑦ flush() 가 서버 업로드를 거부: " + JSON.stringify({ offlineAuth: r.offlineAuth }));
  ok(fetchLog.length === before, "🔴⑦ /api/sync/batch 호출 0회(서버 쓰기 시도조차 없음)");
  ok((await SQ.all()).length === 1, "⑦ 큐는 보존(데이터 유실 없음) → 온라인 재로그인 후 업로드");

  // 회귀: 서버가 재검증한 온라인 세션이면 실제로 업로드된다
  setFetch(async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) }));
  Auth._offlineOnly = false; Auth.idToken = "local-real-session";
  ok(Auth.canServerWrite() === true, "⑦ 회귀: 온라인 세션이면 canServerWrite() === true");
  const r2 = await SQ.flush();
  ok(!r2.offlineAuth && fetchLog.length > before, "⑦ 회귀: 온라인 세션에서는 실제로 서버 호출됨");
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑧ 로그아웃 시 오프라인 검증자 삭제
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[⑧ 로그아웃 → 검증자 삭제]");
{
  const { Auth, SQ, setFetch } = makeAuthSandbox();
  setFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  await Auth.saveOfflineVerifier(NEWBIE, FIELD_PW, { name: "김현장", role: "viewer" });
  ok((await SQ.loadAuthRecord()) !== null, "⑧ 사전조건: 검증자 존재");
  Auth.idToken = "local-real-session";
  Auth.signOut();
  await new Promise((r) => setTimeout(r, 60));
  ok((await SQ.loadAuthRecord()) === null, "🔴⑧ 로그아웃 후 검증자 삭제됨");
  const after = await Auth.offlineLogin(NEWBIE, FIELD_PW);
  ok(after.ok === false && after.reason === "no-record", "⑧ 로그아웃 후에는 오프라인 재인증 불가");
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑨ PWA 설치 안내 — standalone 이면 안 뜬다
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[⑨ 설치 안내 — standalone 억제]");
function makeInstallSandbox({ standalone, ua, platform, maxTouchPoints }) {
  const { document, reg } = makeDom(["pwa-install-banner", "pwa-install-ios", "pwa-install-accept", "pwa-install-close"]);
  const sandbox = {
    console, document, localStorage: makeStorage(),
    navigator: { userAgent: ua, platform: platform, maxTouchPoints: maxTouchPoints, standalone: !!standalone },
    setTimeout, requestAnimationFrame: (fn) => fn(),
    Number, String, Boolean, JSON, Date, Object, Array, Promise,
    window: {},
  };
  sandbox.window = sandbox;
  sandbox.matchMedia = (q) => ({ matches: !!standalone && /display-mode:\s*standalone/.test(q) });
  vm.createContext(sandbox);
  vm.runInContext(extractBalanced(installSrc, "const Install = {") + ";\nglobalThis.__Install = Install;", sandbox);
  return { Install: sandbox.__Install, reg };
}
{
  const { Install, reg } = makeInstallSandbox({ standalone: true, ua: "Mozilla/5.0 (iPhone)", platform: "iPhone", maxTouchPoints: 5 });
  Install._deferred = { prompt() {}, userChoice: Promise.resolve({ outcome: "accepted" }) };
  ok(Install.isStandalone() === true, "⑨ standalone 감지");
  // [WO 20260929] _shouldPrompt() 는 38_Install.js 리팩터(첫 화면 즉시노출+7일스누즈)로
  // showBanner()에 흡수됐다(내부 판정 로직은 그대로: standalone 이면 항상 false). 동일 계약 재검증.
  ok(Install.showBanner() === false, "🔴⑨ 이미 설치된 상태 → 안내 안 띄움(showBanner()===false)");
  ok(Install.maybePrompt() === false, "🔴⑨ maybePrompt() === false");
  ok(reg["pwa-install-banner"].classList.contains("hidden"), "🔴⑨ 배너가 숨김 그대로");
}
{
  // 회귀: 미설치 안드로이드(프롬프트 보유) → 뜬다
  const { Install, reg } = makeInstallSandbox({ standalone: false, ua: "Mozilla/5.0 (Linux; Android 13)", platform: "Linux armv8l", maxTouchPoints: 5 });
  Install._deferred = { prompt() {}, userChoice: Promise.resolve({ outcome: "accepted" }) };
  ok(Install.maybePrompt() === true, "⑨ 회귀: 미설치 + beforeinstallprompt 보유 → 배너 노출");
  ok(!reg["pwa-install-banner"].classList.contains("hidden"), "⑨ 회귀: 배너 표시됨");
  ok(reg["pwa-install-ios"].classList.contains("hidden"), "⑨ 안드로이드에서는 iOS 안내 문구 숨김");
}
{
  // iOS: beforeinstallprompt 가 없어도 수동 안내를 띄운다
  const { Install, reg } = makeInstallSandbox({ standalone: false, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)", platform: "iPhone", maxTouchPoints: 5 });
  ok(Install.isIOS() === true, "⑨ iOS 감지");
  ok(Install.maybePrompt() === true, "⑨ iOS: beforeinstallprompt 없이도 수동 안내 노출");
  ok(!reg["pwa-install-ios"].classList.contains("hidden"), "⑨ iOS 안내 문구 표시(공유→홈 화면에 추가)");
  ok(reg["pwa-install-accept"].classList.contains("hidden"), "⑨ iOS 에서는 동작하지 않는 '설치' 버튼을 숨긴다");
}
{
  // 거절하면 다시 띄우지 않는다
  const { Install } = makeInstallSandbox({ standalone: false, ua: "Mozilla/5.0 (Linux; Android 13)", platform: "Linux armv8l", maxTouchPoints: 5 });
  Install._deferred = { prompt() {}, userChoice: Promise.resolve({ outcome: "dismissed" }) };
  Install.dismiss();
  ok(Install.maybePrompt() === false, "⑨ 사용자가 닫으면 다시 띄우지 않는다");
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑩ 설치 안내 ↔ .mobile-dock 겹침 면적 0  (CSS 값을 수치로 파싱)
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[⑩ 설치 배너 ↔ 하단 도크 겹침 = 0 (수치 계산)]");
{
  const css = rd("public/css/style.css").replace(/\/\*[\s\S]*?\*\//g, "");

  /** :root 의 커스텀 속성 값 테이블 */
  const rootVars = {};
  {
    const m = css.match(/:root\s*\{([\s\S]*?)\}/);
    const re = /--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
    let x;
    while ((x = re.exec(m[1])) !== null) rootVars[x[1]] = x[2].trim();
  }
  /** CSS 길이식(calc/var/env/px)을 px 수치로 환산. env(...) 는 폴백값을 쓴다(데스크톱/일반 뷰포트 기준). */
  function px(expr) {
    let s = String(expr).trim();
    for (let i = 0; i < 8 && /var\(/.test(s); i++) {
      s = s.replace(/var\(\s*--([a-zA-Z0-9_-]+)\s*(?:,\s*([^()]*))?\)/g, (_, name, fb) => rootVars[name] || fb || "0px");
    }
    s = s.replace(/env\(\s*[a-zA-Z0-9_-]+\s*(?:,\s*([^()]*))?\)/g, (_, fb) => (fb || "0px").trim());
    s = s.replace(/calc\(/g, "(");
    s = s.replace(/(-?[\d.]+)px/g, "$1");
    if (!/^[\d\s()+\-*/.]+$/.test(s)) throw new Error("파싱 실패: " + expr + " → " + s);
    return Function('"use strict";return (' + s + ")")();
  }
  const decl = (selector, prop, scope) => {
    const src = scope || css;
    const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}");
    const m = src.match(re);
    if (!m) throw new Error("선택자 없음: " + selector);
    const p = m[1].match(new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+)"));
    if (!p) throw new Error(prop + " 없음: " + selector);
    return p[1].trim();
  };
  // 모바일 미디어쿼리 블록(<=760px)만 잘라낸다 — 도크와 배너가 모두 여기서 최종 결정된다
  const mobileBlocks = [];
  {
    const re = /@media\s*\(max-width:\s*760px\)\s*\{/g;
    let m;
    while ((m = re.exec(css)) !== null) {
      let depth = 0, i = css.indexOf("{", m.index);
      const start = i;
      for (; i < css.length; i++) { if (css[i] === "{") depth++; else if (css[i] === "}") { depth--; if (!depth) break; } }
      mobileBlocks.push(css.slice(start + 1, i));
    }
  }
  const mobile = mobileBlocks.join("\n");

  const dockH = px(decl(".mdock-bar", "height", mobile));                 // 도크 바 높이
  const bannerBottom = px(decl(".pwa-install-banner", "bottom", mobile)); // 배너 하단 offset
  const dockZ = Number(decl(".mobile-dock", "z-index", mobile));
  const bannerZ = Number(decl(".pwa-install-banner", "z-index"));

  ok(dockH === 58, "⑩ 도크 높이 파싱 = " + dockH + "px (SoT --mdock-h)");
  ok(bannerBottom > 0, "⑩ 배너 bottom 파싱 = " + bannerBottom + "px");
  // 도크 점유 구간 [0, dockH], 배너 점유 구간 [bannerBottom, ∞)
  const overlap = Math.max(0, dockH - bannerBottom);
  ok(overlap === 0, "🔴⑩ 겹침 면적(세로 중첩) = " + overlap + "px — 도크 상단 " + dockH + "px vs 배너 하단 " + bannerBottom + "px");
  ok(bannerBottom - dockH >= 8, "⑩ 여유 간격 " + (bannerBottom - dockH) + "px ≥ 8px");
  ok(bannerZ > dockZ, "⑩ 배너 z-index(" + bannerZ + ") > 도크 z-index(" + dockZ + ") — 도크에 덮이지 않음");
}

console.log(failed === 0 ? "\n전체 PASS" : `\n${failed}건 FAIL`);
process.exit(failed === 0 ? 0 : 1);
