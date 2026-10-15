/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p107-bulk-reauth.test.mjs)
 *
 * WO 20261001-bulkreauth — 마스터: "핀 일괄삭제 기능도 구현해. 이때는 구글 비번을 넣게 해"
 *   🔴 앱은 구글 비밀번호를 받지 않는다 → Google 계정 = 구글 공식 창(Firebase 재인증), 회사 이메일 계정 = 앱 비밀번호.
 *
 * 검사 대상(목은 브라우저·구글 경계뿐):
 *   서버 = src/index.tsx 실 번들 → Miniflare(workerd) + 실 D1(migrations 전부).
 *   클라 = 실 20_App.js + 실 22_Auth.js 를 vm 에 올리고 fetch 를 실 워커로 잇는다.
 *   Firebase = 실 public/js/firebase-init.js 를 vm 에 올리되 gstatic 모듈 import 만 하니스 스텁으로 바꾼다
 *              (실제 구글 창은 테스트 불가 — 배포 후 마스터 확인 항목).
 *
 *  V  노출: 소유자·super = 보임 / 디자이너 멤버·관리자(비소유)·뷰어 모드 = 숨김 (서버 can_manage_members 가 SoT)
 *  R  재인증: 성공 → 삭제 · 비번 오류/취소/구글 창 닫힘 → 0건 · 5분 내 재사용 · 5분 경과 → 다시 요청
 *  S  서버: X-Reauth 유효 → 200 · 만료/위조/타인 토큰 → 403 · 비소유자 → 403 · 실계정 아님 → 재인증 불가
 *  P  저장: 일괄삭제 PATCH 에 X-Reauth 탑재 · 서버 403(만료) → 재인증 후 재전송
 *  F  firebase-init: 재인증 팝업 → 새 ID 토큰(getIdToken(true)) · 팝업 차단 → redirect 폴백 · 복귀 결과 회수
 *  U  util: reauthFresh(auth_time 5분) · safeEqualStr
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { Miniflare } from "miniflare";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const M = "public/js/modules/";

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };
const watchdog = setTimeout(() => { console.log("\nWATCHDOG — 180s 초과 → FAIL"); process.exit(1); }, 180000);

/* ══ 서버: 실 워커 + 실 D1 ══ */
const SECRET = "p107-signing-secret-0123456789abcdef";
const SUPER = "sup@seastar.test", ADMIN = "adm@seastar.test";
const workerOut = path.join(os.tmpdir(), "p107-worker-" + process.pid + ".mjs");
await esbuild.build({
  entryPoints: [path.join(ROOT, "src/index.tsx")], bundle: true, format: "esm", platform: "neutral",
  outfile: workerOut, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
  conditions: ["workerd", "worker", "browser"],
});
const mf = new Miniflare({
  modules: true, scriptPath: workerOut, d1Databases: { DB: "p107-" + Date.now() }, r2Buckets: { R2: "p107r2-" + Date.now() },
  bindings: { DEMO_LOGIN: "0", AUTO_ENTRY_SECRET: SECRET, SUPER_ADMIN_EMAIL: SUPER, SUPER_ADMIN_EMAILS: SUPER, ADMIN_EMAILS: ADMIN },
  compatibilityDate: "2025-01-01",
});
const BASE = "http://p107.test";
const db = await mf.getD1Database("DB");
for (const f of fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()) {
  for (const st of rd("migrations/" + f).replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean)) await db.exec(st);
}
const run = (q, a = []) => db.prepare(q).bind(...a).run();

const PW = { o: "owner-pass-1234", m: "member-pass-1234", s: "super-pass-1234", a: "admin-pass-1234" };
const U = { o: "owner@seastar.test", m: "member@seastar.test", s: SUPER, a: ADMIN };
const TOK = {};
const pbkdf2 = (pw, saltHex) => crypto.pbkdf2Sync(pw, Buffer.from(saltHex, "hex"), 100000, 32, "sha256").toString("hex");
for (const k of Object.keys(U)) {
  const now = Date.now(), salt = crypto.randomBytes(16).toString("hex");
  await run("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, 'seed', ?, ?, 0)", [U[k], k, now, now]);
  await run("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, 'seastar.test', ?, ?, 1, ?, ?, 0)", [U[k], k, pbkdf2(PW[k], salt), salt, now, now]);
  TOK[k] = "local-p107-" + k + "-" + crypto.randomBytes(6).toString("hex");
  await run("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOK[k], U[k], now, now + 8.64e7]);
}
const PID = "prj_p107";
{ const now = Date.now();
  await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, 'P107', '', ?, ?, ?, 0)", [PID, U.o, now, now]);
  for (const k of ["m", "a"]) await run("INSERT INTO project_members (project_id, email, role, granted_by, created_at) VALUES (?, ?, 'designer', ?, ?)", [PID, U[k], U.o, now]); }

const api = async (tok, method, url, body, extra) => {
  const headers = Object.assign({ "Content-Type": "application/json" }, tok ? { Authorization: "Bearer " + tok } : {}, extra || {});
  const r = await mf.dispatchFetch(BASE + url, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
};
const P = (id) => ({ id, x: 10 + id, y: 10, page: 1, label: String(id), checkboard: true, createdAt: id });
async function seedDep(n) {
  const d = (await api(TOK.o, "POST", "/tables/deployments", { title: "도면", file_name: "GA.pdf", project_id: PID, pins: JSON.stringify(Array.from({ length: n }, (_, i) => P(i + 1))) })).j;
  return d.id;
}
const getDep = async (id) => (await api(TOK.o, "GET", "/tables/deployments/" + id)).j;
const srvIds = async (id) => JSON.parse((await getDep(id)).pins || "[]").filter((p) => !p._deleted).map((p) => String(p.id)).sort().join(",");
/** 서버와 같은 형식(rx1.<b64u payload>.<HMAC-SHA256 b64u over 'rx1.'+payload>)으로 위조/만료 토큰 생성 */
const forge = (email, exp, secret = SECRET) => {
  const payload = Buffer.from(JSON.stringify({ e: email, exp, n: "x" })).toString("base64url");
  return "rx1." + payload + "." + crypto.createHmac("sha256", secret).update("rx1." + payload).digest("base64url");
};

/* ══ S. 서버 ══ */
console.log("\n[S. 서버 — /api/auth/reauth · X-Reauth]");
const depS = await seedDep(4);
{
  const bad = await api(TOK.o, "POST", "/api/auth/reauth", { password: "wrong-password" });
  ok(bad.status === 401 && !(bad.j && bad.j.token), "S1 비밀번호 오류 → 401, 토큰 없음 (" + bad.status + ")");
  const t0 = Date.now();
  const good = await api(TOK.o, "POST", "/api/auth/reauth", { password: PW.o });
  const exp = good.j && Number(good.j.exp);
  ok(good.status === 200 && /^rx1\./.test(good.j.token || "") && exp >= t0 + 299000 && exp <= Date.now() + 300000,
    "S2 비밀번호 일치 → rx1 단기 토큰 · exp = 발급 +5분 (Δ=" + (exp - t0) + "ms)");
  const rxO = good.j.token;
  const cur = await getDep(depS);
  const p3 = await api(TOK.o, "PATCH", "/tables/deployments/" + depS, { base_version: cur.version, pins: JSON.stringify([P(1), P(2)]) }, { "X-Reauth": rxO });
  ok(p3.status === 200 && (await srvIds(depS)) === "1,2", "S3 소유자 + 유효 X-Reauth → 200, 서버 핀 [1,2]");
  const v = (await getDep(depS)).version;
  const p4 = await api(TOK.o, "PATCH", "/tables/deployments/" + depS, { base_version: v, pins: "[]" }, { "X-Reauth": forge(U.o, Date.now() - 1000) });
  ok(p4.status === 403 && p4.j && p4.j.reauth_required === true && (await srvIds(depS)) === "1,2", "S4 만료 X-Reauth → 403 reauth_required, 핀 불변");
  const p5 = await api(TOK.o, "PATCH", "/tables/deployments/" + depS, { base_version: v, pins: "[]" }, { "X-Reauth": forge(U.o, Date.now() + 60000, "not-the-server-secret-xxxxxxxx") });
  ok(p5.status === 403 && (await srvIds(depS)) === "1,2", "S5 서명 위조 X-Reauth → 403");
  const rxM = (await api(TOK.m, "POST", "/api/auth/reauth", { password: PW.m })).j.token;
  const p6 = await api(TOK.o, "PATCH", "/tables/deployments/" + depS, { base_version: v, pins: "[]" }, { "X-Reauth": rxM });
  ok(p6.status === 403 && (await srvIds(depS)) === "1,2", "S6 남의 재인증 토큰(멤버 것)을 소유자 세션에 → 403");
  const p7 = await api(TOK.m, "PATCH", "/tables/deployments/" + depS, { base_version: v, pins: "[]" }, { "X-Reauth": rxM });
  ok(p7.status === 403 && /owner or super/.test((p7.j && p7.j.error) || "") && (await srvIds(depS)) === "1,2", "S7 디자이너 멤버(비소유) + 본인 유효 토큰 → 403(소유자·super 아님)");
  const rxS = (await api(TOK.s, "POST", "/api/auth/reauth", { password: PW.s })).j.token;
  const p8 = await api(TOK.s, "PATCH", "/tables/deployments/" + depS, { base_version: v, pins: JSON.stringify([P(1)]) }, { "X-Reauth": rxS });
  ok(p8.status === 200 && (await srvIds(depS)) === "1", "S8 super(비소유) + 유효 토큰 → 200");
  const p9 = await api(TOK.o, "PATCH", "/tables/deployments/" + depS, { base_version: v + 1, pins: JSON.stringify([P(1)]) }, { "X-Reauth": "garbage" });
  ok(p9.status === 403, "S9 형식 불량 X-Reauth → 403");
  const ro = await api("auto-designer-entry-360", "POST", "/api/auth/reauth", { password: "x" });
  ok(ro.status === 403 && !(ro.j && ro.j.token), "S10 열람 전용(공용 문자열) 세션 → 재인증 불가 403");
  const fb = await api(TOK.o.replace("local-", "x-"), "POST", "/api/auth/reauth", { id_token: "a.b.c" });
  ok(fb.status === 403 || fb.status === 401, "S11 미인증 → 토큰 미발급 (" + fb.status + ")");
  // 한계 기록(정직): 헤더 없는 PATCH 는 일괄삭제인지 서버가 식별 못 함 → 통상 저장으로 통과
  const vv = (await getDep(depS)).version;
  const p12 = await api(TOK.m, "PATCH", "/tables/deployments/" + depS, { base_version: vv, pins: JSON.stringify([P(1)]) });
  ok(p12.status === 200, "S12 [한계 기록] X-Reauth 없는 통상 저장은 종전대로 200 (헤더 없는 일괄삭제는 식별 불가)");
  // /api/projects 의 can_manage_members = canManageMembers 와 같은 판정
  const cm = async (k) => { const l = (await api(TOK[k], "GET", "/api/projects")).j.data || []; const p = l.find((x) => x.id === PID); return p ? p.can_manage_members : "없음"; };
  const flags = { o: await cm("o"), s: await cm("s"), m: await cm("m"), a: await cm("a") };
  ok(flags.o === true && flags.s === true && flags.m === false && flags.a === false,
    "S13 /api/projects can_manage_members: 소유자 true · super true · 디자이너 멤버 false · 관리자(비소유) false " + JSON.stringify(flags));
}

/* ══ 클라이언트 realm: 실 22_Auth.js + 실 20_App.js, fetch → 실 워커 ══ */
function anyEl() {
  const store = {};
  const fn = function () { return proxy; };
  const proxy = new Proxy(fn, {
    get(t, k) { if (k in store) return store[k]; if (k === Symbol.toPrimitive) return () => ""; if (k === "then") return undefined; if (k === "contains") return () => false; return proxy; },
    set(t, k, v) { store[k] = v; return true; }, apply() { return proxy; },
  });
  return proxy;
}
function makeStore() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; }
const RealDate = Date;
async function makeClient(k, { askAns, fb, reauthIntercept } = {}) {
  const clock = { off: 0 };
  class FakeDate extends RealDate { static now() { return RealDate.now() + clock.off; } }
  const calls = { ask: [], toast: [], confirm: 0, patches: [], reauthBodies: [] };
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u === "/api/auth/reauth") { try { calls.reauthBodies.push(JSON.parse(opts.body || "{}")); } catch (e) {} if (reauthIntercept) return reauthIntercept(opts); }
    if (/^\/tables\/deployments\//.test(u) && opts.method === "PATCH") calls.patches.push({ xr: (opts.headers || {})["X-Reauth"] || null });
    // [WO 20261015-bulkdel-undo] G 섹션은 Auth.idToken 을 "google-session-token"(가짜 문자열)로 바꿔 ensureReauth 의
    // 분기(local- 접두 아님 → 구글 경로)만 흉내낸다 — 실 서버 Bearer 인증과는 무관했다(deletePins 가 자기 네트워크
    // 호출을 하지 않던 시절). 이제 deletePins 가 직접 POST(bulk-delete) 를 보내므로, 이 가짜 문자열이 그대로
    // Authorization 에 실리면 실 서버가 로그인 자체를 거부한다 — 같은 계정(TOK[k])으로 바로잡아 전달한다.
    const headers = Object.assign({}, opts.headers || {});
    if (headers.Authorization === "Bearer google-session-token") headers.Authorization = "Bearer " + TOK[k];
    const r = await mf.dispatchFetch(BASE + u, { method: opts.method || "GET", headers, body: opts.body });
    if (/^\/tables\/deployments\//.test(u) && opts.method === "PATCH") calls.patches[calls.patches.length - 1].status = r.status;
    return r;
  };
  const document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], body: anyEl(), documentElement: anyEl(), addEventListener() {}, createElement: () => anyEl() };
  const State = { pins: [], zones: [], annotations: [], checkboardStart: {}, pdfPage: 1, mode: "designer", fileType: "image", pinTombstones: {}, pinBaseIds: null, depVersion: 0, autoSaveDepId: null };
  const sandbox = {
    console, document, navigator: { onLine: true }, location: { search: "" },
    window: Object.assign({ addEventListener() {} }, fb ? { FIREBASE_ENABLED: true, SeaFirebase: fb } : {}),
    sessionStorage: makeStore(), localStorage: makeStore(),
    State,
    UI: { $: () => anyEl(), renderPinsOnMap() {}, renderPinList() {}, updatePdfPagination() {} },
    Projects: { currentProject: null, currentDeck: null, decks: [] },
    Prompt: {
      toast(m) { calls.toast.push(String(m)); },
      confirm: async () => { calls.confirm++; return true; },
      ask: async (o) => { calls.ask.push(o); return typeof askAns === "function" ? askAns(o) : askAns; },
    },
    OpLog: { recordCurrent: async () => {} }, persistLocalDeployment: async () => {},
    _revokeVideoBlob() {}, Zones: { refreshPinLinks() {} }, MapCtrl: { applyTransform() {}, fit() {} }, Log: { push() {} },
    SyncQueue: { loadDraft: async () => null, saveDraft: async () => {}, allDraftKeys: async () => [] },
    fetch: fetchImpl, URLSearchParams, AbortController, requestAnimationFrame: (f) => setTimeout(f, 0),
    setTimeout: (f, ms) => (ms && ms >= 1000 ? 0 : setTimeout(f, ms)), clearTimeout,
    JSON, Array, Map, Set, Date: FakeDate, Promise, Object, Number, String, Math, RegExp, Error, encodeURIComponent,
  };
  sandbox.window.sessionStorage = sandbox.sessionStorage;
  vm.createContext(sandbox);
  vm.runInContext(rd(M + "22_Auth.js") + "\n;globalThis.__Auth = Auth;", sandbox);
  vm.runInContext(rd(M + "20_App.js") + "\n;globalThis.__App = App;", sandbox);
  const Auth = sandbox.__Auth, App = sandbox.__App;
  App._markDeckUnsaved = () => {}; App._closePinForm = () => {}; App._setSaveIndicator = () => {};
  Auth.idToken = TOK[k];
  await Auth.refresh();
  const list = (await (await mf.dispatchFetch(BASE + "/api/projects", { headers: { Authorization: "Bearer " + TOK[k] } })).json()).data || [];
  Auth.setProjectContext(list.find((p) => p.id === PID) || null);
  // [WO 20261015-bulkdel-undo] deletePins 가 이제 Projects.currentProject.id 로 서버(/api/projects/:id/pins/bulk-delete)를
  // 부른다 — 이 클라 realm 은 Projects 를 스텁(고정 null)으로만 두므로 실제 열린 프로젝트를 흉내낸다.
  sandbox.Projects.currentProject = { id: PID, name: "P107" };
  return { Auth, App, State, calls, clock, sandbox };
}
async function loadDep(c, depId) {
  const d = await getDep(depId);
  c.State.pins = JSON.parse(d.pins || "[]"); c.State.depVersion = Number(d.version || 0); c.State.autoSaveDepId = depId;
}
const cids = (c) => c.State.pins.map((p) => String(p.id)).sort().join(",");

/* ══ V. 노출 ══ */
console.log("\n[V. 노출 — 소유자·super 만]");
{
  const o = await makeClient("o"), s = await makeClient("s"), m = await makeClient("m"), a = await makeClient("a");
  ok(o.Auth.role !== "super" && o.App.canBulkDeletePins() === true, "V1 프로젝트 소유자(전역 디자이너) → 보임");
  ok(s.Auth.isSuper && s.App.canBulkDeletePins() === true, "V2 super(비소유) → 보임");
  ok(m.App.canBulkDeletePins() === false, "V3 디자이너 멤버 → 숨김");
  ok(a.Auth.isAdmin === true && a.App.canBulkDeletePins() === false, "V4 일반관리자(Auth.isAdmin=true, 비소유) → 숨김 (종전 isAdmin 기준이면 보였다)");
  o.State.mode = "viewer";
  ok(o.App.canBulkDeletePins() === false, "V5 소유자라도 뷰어 모드 → 숨김");
  o.State.mode = "designer";
  m.State.pins = [P(1), P(2)];
  ok((await m.App.deletePins([1, 2])) === 0 && m.State.pins.length === 2 && m.calls.confirm === 0, "V6 멤버가 deletePins 직접 호출 → 0건, 확인창도 없음");
}

/* ══ R. 재인증 흐름(로컬 계정 = 앱 비밀번호, 실 서버 검증) ══ */
console.log("\n[R. 재인증 → 삭제 / 실패·취소 0건 / 5분 재사용]");
{
  const depR = await seedDep(8);
  // R1 비밀번호 오류 → 0건
  const w = await makeClient("o", { askAns: { value: "wrong-password" } });
  await loadDep(w, depR);
  ok((await w.App.deletePins([1, 2])) === 0 && cids(w) === "1,2,3,4,5,6,7,8" && w.calls.ask.length === 1, "R1 비밀번호 오류 → 삭제 0건(로컬 핀 8개 그대로)");
  ok(w.calls.ask[0] && w.calls.ask[0].password === true, "R1b 비밀번호 입력은 가림 입력(password:true) — 구글 비번 아님(로컬 계정)");
  ok(!w.Auth.hasValidReauth(), "R1c 실패 후 재인증 토큰 없음");
  // R2 취소 → 0건
  const x = await makeClient("o", { askAns: null });
  await loadDep(x, depR);
  ok((await x.App.deletePins([1, 2])) === 0 && cids(x) === "1,2,3,4,5,6,7,8", "R2 비밀번호 창 취소 → 삭제 0건");
  // R3 성공 → 삭제 (기존 _removePins 경로: tombstone)
  const c = await makeClient("o", { askAns: { value: PW.o } });
  await loadDep(c, depR);
  const n = await c.App.deletePins([1, 2]);
  // [WO 20261015-bulkdel-undo] 일괄삭제는 이제 서버 전용 — tombstone 은 서버 pin_bulk_deletes/배포본에 남고
  // (클라 State.pinTombstones 는 더 안 씀), 로컬은 즉시 필터링 반영만 확인한다.
  ok(n === 2 && cids(c) === "3,4,5,6,7,8" && (await srvIds(depR)) === "3,4,5,6,7,8", "R3 비밀번호 일치 → 2개 삭제(로컬·서버 모두 반영)");
  ok(c.calls.reauthBodies.length === 1 && c.calls.reauthBodies[0].password === PW.o && !("id_token" in c.calls.reauthBodies[0]), "R3b 로컬 계정 → 서버 /api/auth/reauth 에 앱 비밀번호로 검증");
  // R4 5분 이내 → 다시 묻지 않음
  const n2 = await c.App.deletePins([3]);
  ok(n2 === 1 && c.calls.ask.length === 1 && c.calls.reauthBodies.length === 1, "R4 5분 이내 두 번째 일괄삭제 → 재인증 창 없이 삭제 (ask " + c.calls.ask.length + "회)");
  // R5 5분 경과 → 다시 요청
  c.clock.off = 5 * 60 * 1000 + 1000;
  const n3 = await c.App.deletePins([4]);
  ok(n3 === 1 && c.calls.ask.length === 2, "R5 5분 경과 → 재인증 다시 요청 (ask " + c.calls.ask.length + "회)");
  c.clock.off = 0;
  // R6 재인증은 확인(confirm) 뒤 — 확인 취소면 재인증 창도 안 뜬다
  const cc = await makeClient("o", { askAns: { value: PW.o } });
  await loadDep(cc, depR);
  cc.sandbox.Prompt.confirm = async () => false;
  ok((await cc.App.deletePins([5])) === 0 && cc.calls.ask.length === 0, "R6 개수 확인 취소 → 재인증 창 없음, 0건");

  /* ══ P. [WO 20261015-bulkdel-undo] 저장 PATCH — 일괄삭제가 이제 자기 재인증을 그 자리에서 끝낸다(전용
     서버 엔드포인트, R 섹션이 이미 검증) → 다음 평범한 저장(_patchDeployment)에 X-Reauth 를 "이어 태우는"
     옛 _bulkReauthDep 중계는 더 쓰지 않는다(그 필드는 이제 아무도 세팅하지 않아 항상 null). 재확인만. ══ */
  console.log("\n[P. 저장 PATCH — 일괄삭제 재인증은 삭제 시점에 끝남, 다음 저장은 평범하게]");
  // 이 시점 depR 서버 상태(R 섹션에서 1,2,3,4 를 이미 지웠다) = 살아있는 5,6,7,8
  await loadDep(c, depR);                      // 서버본(현재 라이브 5,6,7,8)에서 다시 시작
  ok((await c.App.deletePins([7, 8])) === 2 && (await srvIds(depR)) === "5,6", "P0 일괄삭제 2개 — 서버에 즉시 반영(그 자리에서 재인증 끝)");
  ok(c.App._bulkReauthDep === null, "P1 옛 이어태우기 필드(_bulkReauthDep)는 더 안 쓴다 — 항상 null");
  const r1 = await c.App._patchDeployment(depR, () => ({ pins: JSON.stringify(c.State.pins) }));
  const last = c.calls.patches[c.calls.patches.length - 1] || {};
  ok(r1.ok && !last.xr && (await srvIds(depR)) === "5,6", "P2 다음 저장은 X-Reauth 없이도 200(평범한 저장) — 서버 [5,6] 유지");
  const r2 = await c.App._patchDeployment(depR, () => ({ pins: JSON.stringify(c.State.pins) }));
  ok(r2.ok && !(c.calls.patches[c.calls.patches.length - 1] || {}).xr, "P3 그 다음 저장도 동일(X-Reauth 없음)");
  // [WO 20261015-bulkdel-undo] P5 — 일괄삭제 뒤 재인증을 지우고 취소해도(이 저장과 무관해졌으므로) 다음
  //   평범한 저장은 그대로 성공한다(이전엔 _bulkReauthDep 이어태우기가 이 저장을 막았다 — 이제 그 결합이 없다).
  await loadDep(c, depR);
  ok((await c.App.deletePins([5])) === 1, "P5a 일괄삭제 1개(로컬)");
  c.Auth.clearReauth();
  c.sandbox.Prompt.ask = async () => null;
  const pB = c.calls.patches.length;
  const r5 = await c.App._patchDeployment(depR, () => ({ pins: JSON.stringify(c.State.pins) }));
  ok(r5.ok && c.calls.patches.length === pB + 1 && !(c.calls.patches[c.calls.patches.length - 1] || {}).xr,
    "P5 일괄삭제와 무관해진 저장 — 재인증 취소여도 평범히 전송·성공(X-Reauth 없이)");
}

/* ══ G. Google(Firebase) 계정 분기 — 구글 공식 창 결과(새 ID 토큰)를 서버로, 앱은 비밀번호를 받지 않는다 ══ */
console.log("\n[G. Google 계정 — Firebase 재인증 분기]");
{
  const depG = await seedDep(3);
  const mkFb = (impl) => ({ ready: true, calls: [], reauthGoogle: async (email) => impl(email) });
  // [WO 20261015-bulkdel-undo] deletePins 가 이제 이 토큰을 그대로 실 서버(bulk-delete)에 보낸다 — 가짜 서명(rx1.stub.sig)
  // 이면 실 서버가 403 으로 거부한다(이전엔 _bulkReauthDep 이어태우기만 쓰고 이 토큰 자체를 보낸 적이 없어 안 걸렸다).
  // forge() 로 실 서버 SECRET 과 같은 서명을 만든다(토큰 포맷·검증은 실 서버 reauthTokenValid 그대로).
  const okIntercept = async () => new Response(JSON.stringify({ ok: true, token: forge(U.o, Date.now() + 300000), exp: Date.now() + 300000 }), { status: 200, headers: { "content-type": "application/json" } });
  const fbOk = mkFb(async () => "fresh.id.token");
  const g = await makeClient("o", { fb: fbOk, reauthIntercept: okIntercept });
  g.Auth.idToken = "google-session-token";   // 로컬 세션이 아닌 계정으로 취급(Google)
  await loadDep(g, depG);
  ok((await g.App.deletePins([1])) === 1 && g.calls.ask.length === 0, "G1 Google 계정: 구글 창 재인증 성공 → 삭제, 앱 비밀번호 입력창 없음");
  ok(g.calls.reauthBodies.length === 1 && g.calls.reauthBodies[0].id_token === "fresh.id.token" && !("password" in g.calls.reauthBodies[0]),
    "G2 서버로 보내는 것 = 새 ID 토큰(id_token) 뿐, 비밀번호 필드 없음");
  const fbClose = mkFb(async () => { const e = new Error("closed"); e.code = "auth/popup-closed-by-user"; throw e; });
  const h = await makeClient("o", { fb: fbClose, reauthIntercept: okIntercept });
  h.Auth.idToken = "google-session-token";
  await loadDep(h, depG);
  ok((await h.App.deletePins([1, 2])) === 0 && cids(h) === "1,2,3" && h.calls.reauthBodies.length === 0, "G3 구글 창 닫음/취소 → 0건, 서버 호출 없음");
  const failIntercept = async () => new Response(JSON.stringify({ error: "구글 재인증이 오래되었습니다", stale: true }), { status: 401, headers: { "content-type": "application/json" } });
  const i = await makeClient("o", { fb: mkFb(async () => "old.id.token"), reauthIntercept: failIntercept });
  i.Auth.idToken = "google-session-token";
  await loadDep(i, depG);
  ok((await i.App.deletePins([1])) === 0 && cids(i) === "1,2,3", "G4 서버가 auth_time 오래됨으로 거부 → 0건");
}

/* ══ F. firebase-init.js — 재인증 팝업 · 팝업 차단 → redirect 폴백 · 복귀 회수 ══ */
console.log("\n[F. firebase-init.js (gstatic 모듈만 하니스 스텁)]");
{
  const src = rd("public/js/firebase-init.js").replace(/await import\("[^"]*firebase-(\w+)\.js"\)/g, 'await __imp("$1")');
  const fc = { popup: 0, redirect: 0, params: null, force: [] };
  let popupMode = "ok";
  const userObj = { getIdToken: async (force) => { fc.force.push(!!force); return force ? "tok-fresh" : "tok-cached"; } };
  const authObj = { currentUser: userObj };
  class GoogleAuthProvider { setCustomParameters(p) { this.params = p; fc.params = p; } }
  const mods = {
    app: { initializeApp: () => ({}) },
    auth: {
      getAuth: () => authObj, GoogleAuthProvider, onAuthStateChanged() {}, signOut: async () => {},
      signInWithPopup: async () => ({ user: userObj }),
      reauthenticateWithPopup: async (u, p) => { fc.popup++; if (popupMode === "blocked") { const e = new Error("blocked"); e.code = "auth/popup-blocked"; throw e; } return { user: userObj }; },
      reauthenticateWithRedirect: async () => { fc.redirect++; }, signInWithRedirect: async () => { fc.redirect++; },
      getRedirectResult: async () => ({ user: { getIdToken: async (force) => (force ? "tok-redirect" : "tok-cached") } }),
    },
    firestore: { getFirestore: () => ({}) }, storage: { getStorage: () => ({}) },
  };
  const ss = makeStore();
  const sb = {
    console: { info() {}, error() {}, log() {} }, sessionStorage: ss,
    window: { FIREBASE_ENABLED: true, FIREBASE_CONFIG: { projectId: "p107" } },
    document: { fullscreenElement: null, dispatchEvent() {} }, CustomEvent: class { constructor(t) { this.type = t; } },
    __imp: async (name) => mods[name], Date, Promise, Error, String,
  };
  vm.createContext(sb);
  vm.runInContext(src, sb);
  for (let k = 0; k < 50 && !sb.window.SeaFirebase.ready; k++) await new Promise((r) => setTimeout(r, 5));
  const SF = sb.window.SeaFirebase;
  ok(SF.ready && typeof SF.reauthGoogle === "function", "F0 firebase-init 실소스 초기화 → reauthGoogle 노출");
  const t1 = await SF.reauthGoogle("owner@seastar.test");
  ok(t1 === "tok-fresh" && fc.popup === 1 && fc.force[fc.force.length - 1] === true, "F1 현재 사용자 reauthenticateWithPopup → getIdToken(true) 새 토큰(auth_time 갱신)");
  ok(fc.params && fc.params.login_hint === "owner@seastar.test", "F2 구글 창에 본인 이메일 힌트(login_hint) — 다른 계정 재인증 방지");
  popupMode = "blocked";
  const pend = SF.reauthGoogle("owner@seastar.test");
  const raced = await Promise.race([pend.then(() => "resolved", () => "rejected"), new Promise((r) => setTimeout(() => r("pending"), 50))]);
  ok(fc.redirect === 1 && raced === "pending" && ss.getItem(SF.REAUTH_REDIRECT_KEY), "F3 팝업 차단 → reauthenticateWithRedirect 폴백 + 복귀 표시 저장 (" + raced + ")");
  const t2 = await SF.reauthRedirectResult();
  ok(t2 === "tok-redirect" && !ss.getItem(SF.REAUTH_REDIRECT_KEY), "F4 redirect 복귀 → 새 ID 토큰 회수 + 표시 제거");
  ok((await SF.reauthRedirectResult()) === null, "F5 표시 없으면 결과 읽지 않음(null)");
}

/* ══ U. util — reauthFresh(auth_time) · safeEqualStr ══ */
console.log("\n[U. src/lib/util.ts]");
{
  const out = path.join(os.tmpdir(), "p107-util-" + process.pid + ".mjs");
  await esbuild.build({ entryPoints: [path.join(ROOT, "src/lib/util.ts")], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" });
  const u = await import(pathToFileURL(out).href);
  const now = 1_800_000_000_000, s = (ms) => (now - ms) / 1000;
  ok(u.REAUTH_TTL_MS === 5 * 60 * 1000, "U1 REAUTH_TTL_MS = 5분(이름 있는 상수)");
  ok(u.reauthFresh(s(10_000), now) === true && u.reauthFresh(s(299_000), now) === true, "U2 auth_time 10초·299초 전 → 신선");
  ok(u.reauthFresh(s(301_000), now) === false, "U3 auth_time 301초 전 → 만료");
  ok(u.reauthFresh(s(-120_000), now) === false && u.reauthFresh(undefined, now) === false && u.reauthFresh("x", now) === false, "U4 너무 미래·없음·비숫자 → false");
  ok(u.safeEqualStr("abc", "abc") && !u.safeEqualStr("abc", "abd") && !u.safeEqualStr("abc", "abcd"), "U5 safeEqualStr");
  try { fs.unlinkSync(out); } catch {}
}

await mf.dispose();
try { fs.unlinkSync(workerOut); } catch {}
clearTimeout(watchdog);
console.log(failed ? `\n결과: FAIL ${failed}건` : "\n결과: 전부 PASS");
process.exit(failed === 0 ? 0 : 1);
