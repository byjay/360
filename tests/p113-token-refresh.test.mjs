/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p113-token-refresh.test.mjs)
 *
 * WO 20261001(지휘자 긴급) — "구역 → 새 페이지 저장 실패 / 원본 PDF 보관 실패" (super 로그인 1시간 경과 후)
 * 근본원인: Firebase ID 토큰(TTL 1시간)을 로그인 시 1회만 받고(22_Auth.js loginWithFirebase),
 *   onIdTokenChanged 갱신도 주기 강제갱신도 없어 Auth.headers() 가 만료 토큰을 계속 실었다(22_Auth.js:269).
 *
 * 재현(지휘자 R1~R3) — git grep HEAD f4c9acb: onIdTokenChanged/getIdToken(true) 0건(재인증 전용 2건 제외) →
 *   FAIL 확정. 본 테스트 Step 0 은 "아무도 idToken 을 갱신하지 않으면 만료 토큰이 계속 전송돼 서버가 403을
 *   돌려준다"는 기본 결함 구조를 가짜 서버로 재현한다. Step 1~4 는 수정(22_Auth.js onIdTokenChanged 구독 +
 *   만료임박 선제갱신 타이머)이 그 상황을 막는지 검사한다.
 *
 * 검사 대상: 실 public/js/modules/22_Auth.js 를 vm 에 올리고 SeaFirebase/fetch/sessionStorage 를
 *   하니스로 스텁한다(Firebase SDK·실제 네트워크는 테스트 범위 밖 — p107 과 동일 전략).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const AUTH_SRC = rd("public/js/modules/22_Auth.js");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };

/** 최소 JWT 모양(header.payload.signature, base64url) — exp 는 초단위 유닉스타임 */
function makeJwt(expSec, extra) {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return b64u({ alg: "none" }) + "." + b64u(Object.assign({ exp: expSec }, extra || {})) + ".sig";
}
function makeStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

/** 22_Auth.js 를 새 vm 컨텍스트에 올린다. timers: {fns:Map, seq} 로 setTimeout 을 가로채 수동 발화시킨다. */
function loadAuth({ fbEmail = "owner@seastar.test" } = {}) {
  const timers = { seq: 0, fns: new Map() };
  const visHandlers = [];
  const idTokenCbs = [];
  const authCurrentUser = { email: fbEmail, _token: "stale-initial-token", getIdToken: async () => authCurrentUser._token };
  const SF = {
    ready: true,
    _auth: { currentUser: authCurrentUser },
    onIdTokenChanged(cb) { idTokenCbs.push(cb); },
  };
  let meResponse = { authenticated: false };
  const fetchCalls = [];
  const fetchImpl = async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), opts });
    if (String(url) === "/api/auth/config") return { ok: false };
    if (String(url) === "/api/auth/me") return { ok: true, json: async () => meResponse };
    return { ok: true, json: async () => ({}) };
  };
  const doc = {
    visibilityState: "visible",
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener(type, fn) { if (type === "visibilitychange") visHandlers.push(fn); },
    createElement: () => ({}),
  };
  const sandbox = {
    console, document: doc, window: { FIREBASE_ENABLED: true, SeaFirebase: SF },
    sessionStorage: makeStore(), localStorage: makeStore(),
    State: { mode: "viewer" }, App: { exitEdit() {} },   // signOut() 말미의 모드전환 분기용 최소 스텁
    fetch: fetchImpl, URLSearchParams, requestAnimationFrame: (f) => f(),
    setTimeout: (fn) => { const id = ++timers.seq; timers.fns.set(id, fn); return id; },
    clearTimeout: (id) => { timers.fns.delete(id); },
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    JSON, Object, String, Number, Math, Date, Promise, Error,
  };
  sandbox.window.sessionStorage = sandbox.sessionStorage;
  sandbox.window.localStorage = sandbox.localStorage;
  vm.createContext(sandbox);
  vm.runInContext(AUTH_SRC + "\n;globalThis.__Auth = Auth;", sandbox);
  const Auth = sandbox.__Auth;
  return {
    Auth, SF, authCurrentUser, timers, visHandlers,
    fireIdToken: (u) => idTokenCbs.forEach((cb) => cb(u)),
    fireTimer: (id) => { const fn = timers.fns.get(id); if (fn) fn(); },
    setMe: (m) => { meResponse = m; },
    fetchCalls,
  };
}

/* ══ Step 0 — 재현: 아무도 갱신하지 않으면 만료 토큰이 서버 거부(403)를 계속 유발한다 ══ */
console.log("\n[Step0. 재현 — 만료 토큰을 아무도 갱신하지 않으면 요청이 영구히 403]");
{
  const nowSec = Math.floor(Date.now() / 1000);
  const expiredJwt = makeJwt(nowSec - 3600); // 1시간 전 만료(로그인 1시간 경과 시나리오)
  const fakeServerCheck = (bearer) => {
    const payload = JSON.parse(Buffer.from(bearer.split(".")[1], "base64").toString("utf8"));
    return payload.exp * 1000 > Date.now() ? 200 : 403;
  };
  const headers = { Authorization: "Bearer " + expiredJwt };
  const status = fakeServerCheck(headers.Authorization.replace("Bearer ", ""));
  ok(status === 403, "S0 1시간 지난 Firebase 토큰을 그대로 실으면 서버가 403(원본 PDF 보관 실패의 원인)");
}

/* ══ Step 1 — onIdTokenChanged 로 새 토큰 → Auth.headers() 가 새 값을 돌려준다 ══ */
console.log("\n[Step1. onIdTokenChanged → Auth.headers() 최신 토큰]");
{
  const h = loadAuth({ fbEmail: "owner@seastar.test" });
  const nowSec = Math.floor(Date.now() / 1000);
  h.Auth.idToken = makeJwt(nowSec + 3000); // 50분 뒤 만료(정상 세션)
  h.setMe({ authenticated: true, email: "owner@seastar.test", name: "Owner", role: "designer" });
  await h.Auth.refresh();
  ok(h.Auth._usingFirebase === true, "1a refresh() 후 Firebase 세션으로 판정(_usingFirebase=true)");
  const newToken = "fresh-token-after-sdk-refresh";
  h.authCurrentUser.getIdToken = async () => newToken;
  h.fireIdToken(h.authCurrentUser);
  await new Promise((r) => setImmediate(r));
  ok(h.Auth.idToken === newToken, "1b onIdTokenChanged 콜백 → Auth.idToken 갱신 (" + h.Auth.idToken + ")");
  ok(h.Auth.headers().Authorization === "Bearer " + newToken, "1c Auth.headers() 가 새 토큰을 싣는다");
}

/* ══ Step 2 — 만료 임박 → getIdToken(true) 강제 갱신 호출 ══ */
console.log("\n[Step2. 만료 임박 → 강제 갱신(getIdToken(true))]");
{
  const h = loadAuth({ fbEmail: "owner@seastar.test" });
  const nowSec = Math.floor(Date.now() / 1000);
  h.Auth.idToken = makeJwt(nowSec + 60); // 1분 뒤 만료 → 5분 마진 안 → 짧은 지연으로 스케줄
  h.setMe({ authenticated: true, email: "owner@seastar.test", name: "Owner", role: "designer" });
  await h.Auth.refresh();
  const timerId = h.Auth._idTokenTimer;
  ok(timerId != null, "2a 만료 임박 세션 → 갱신 타이머가 예약된다");
  let forcedWithTrue = false;
  h.authCurrentUser.getIdToken = async (force) => { if (force) forcedWithTrue = true; return "forced-fresh-token"; };
  h.fireTimer(timerId);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  ok(forcedWithTrue === true, "2b 타이머 발화 → currentUser.getIdToken(true) 강제 호출");
}

/* ══ Step 3 — 로그아웃 → 리스너/타이머 해제 ══ */
console.log("\n[Step3. 로그아웃 → 토큰 자동갱신 해제]");
{
  const h = loadAuth({ fbEmail: "owner@seastar.test" });
  const nowSec = Math.floor(Date.now() / 1000);
  h.Auth.idToken = makeJwt(nowSec + 3000);
  h.setMe({ authenticated: true, email: "owner@seastar.test", name: "Owner", role: "designer" });
  await h.Auth.refresh();
  ok(h.Auth._usingFirebase === true && h.Auth._idTokenTimer != null, "3a 로그인 상태 — Firebase 세션 + 타이머 활성");
  h.Auth.signOut();
  ok(h.Auth._usingFirebase === false, "3b signOut() → _usingFirebase=false");
  ok(h.Auth._idTokenTimer === null, "3c signOut() → 예약 타이머 해제");
  // 로그아웃 후 옛 Firebase 세션이 뒤늦게 콜백을 울려도(네트워크 지연 등) idToken 은 null 그대로.
  h.authCurrentUser.getIdToken = async () => "late-callback-token";
  h.fireIdToken(h.authCurrentUser);
  await new Promise((r) => setImmediate(r));
  ok(h.Auth.idToken === null, "3d 로그아웃 후 지연 콜백이 와도 idToken 복원되지 않음(this.user=null 가드)");
}

/* ══ Step 4 — 로컬 세션(local-) 무영향 ══ */
console.log("\n[Step4. 로컬(회사 이메일) 세션 — Firebase 자동갱신 영향 없음]");
{
  const h = loadAuth({ fbEmail: "exfirebase@seastar.test" }); // 과거 같은 브라우저에 남은 다른 Firebase 세션 가정
  h.Auth.idToken = "local-p113-abc123";
  h.setMe({ authenticated: true, email: "local.user@seastar.test", name: "LocalUser", role: "designer" });
  await h.Auth.refresh();
  ok(h.Auth._usingFirebase === false, "4a local- 토큰 세션 → _usingFirebase=false(Firebase 아님)");
  ok(h.Auth._idTokenTimer === null, "4b 로컬 세션 → 갱신 타이머 없음");
  h.authCurrentUser.getIdToken = async () => "should-not-apply";
  h.fireIdToken(h.authCurrentUser);
  await new Promise((r) => setImmediate(r));
  ok(h.Auth.idToken === "local-p113-abc123", "4c 이메일도 다르고 세션도 로컬 — idToken 불변");
  ok(h.Auth.headers().Authorization === "Bearer local-p113-abc123", "4d Auth.headers() 는 여전히 로컬 토큰을 싣는다");
}

console.log(failed ? `\n결과: FAIL ${failed}건` : "\n결과: 전부 PASS");
process.exit(failed === 0 ? 0 : 1);
