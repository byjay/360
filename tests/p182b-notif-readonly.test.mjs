/**
 * p182b — viewer-audit: 열람 링크 세션(Auth.readonly)에서 알림 벨 숨김 + /api/notifications 호출 0.
 *
 * 결함(2026-10-23 실 Chrome 재현, .tmp/viewer-audit/scn.log): 열람 링크(/v/<토큰>) 진입·새로고침마다
 *   GET /api/notifications?limit=30 → 401 (데스크톱·모바일 4회, 콘솔 에러 4건) + 30초 주기 재시도.
 *   근본원인: 42_Requests.syncChrome/refreshNotif 가 Auth.user 만 보고 "로그인"으로 판정 — 열람 통행증도 Auth.user 가 있다.
 *   서버는 _readonly 를 401 로 거부(src/index.tsx GET /api/notifications). → _notifEligible() 단일 판정.
 * 실 소스(42_Requests.js)를 vm 에서 평가 — DOM 은 notif-wrap 한 요소만(리프 I/O 대체).
 * 뮤테이션: P182B_MUT=1 → _notifEligible 에서 !Auth.readonly 제거 → 이 테스트 FAIL 이어야 한다.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let SRC = fs.readFileSync(path.join(ROOT, "public/js/modules/42_Requests.js"), "utf8").replace(/\r\n/g, "\n");
const FIX = "return typeof Auth !== \"undefined\" && !!Auth.user && !Auth.readonly;";
assert.ok(SRC.includes(FIX), "고친 줄(_notifEligible) 존재");
if (process.env.P182B_MUT) SRC = SRC.replace(FIX, "return typeof Auth !== \"undefined\" && !!Auth.user;");

function load(auth) {
  const calls = [];
  const wrap = { style: { display: "" } };
  const sandbox = {
    Auth: Object.assign({ headers: () => ({}) }, auth),
    fetch: async (u) => { calls.push(String(u)); return { ok: true, json: async () => ({ data: [], unread: 0 }) }; },
    document: { getElementById: (id) => (id === "notif-wrap" ? wrap : null), querySelector: () => null },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC + "\n;globalThis.__R = Requests;", sandbox);
  return { R: sandbox.__R, calls, wrap };
}

test("열람 링크 세션(readonly) — 알림 벨 숨김 · /api/notifications 호출 0", async () => {
  const { R, calls, wrap } = load({ user: { email: "", name: "열람자" }, readonly: true });
  R.syncChrome();
  await R.refreshNotif();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(wrap.style.display, "none", "벨 숨김");
  assert.deepEqual(calls.filter((u) => u.includes("/api/notifications")), [], "알림 조회 0");
});

test("실계정 로그인 — 벨 표시 · 알림 조회(회귀 0)", async () => {
  const { R, calls, wrap } = load({ user: { email: "d@x.com" }, readonly: false });
  R.syncChrome();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(wrap.style.display, "flex");
  assert.ok(calls.some((u) => u.startsWith("/api/notifications")), "알림 조회 1회 이상");
});
