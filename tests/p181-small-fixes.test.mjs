/**
 * 회귀 테스트 — 2026-10-22 소규모 결함 3건 (프레임워크 0 · 실행: node tests/p181-small-fixes.test.mjs)
 *
 * [재현] 발주서(지휘자 실측, REA):
 *  R1 — 비로그인에서도 GET /api/app-settings?scope=*&key=features → 401 1건 + 콘솔 error 1건.
 *       호출부 public/js/modules/20_App.js:59 AdminPanels.applyFeaturesToUI(), 28_AdminPanels.js:6-14.
 *  R3 — "[DOM] Password field is not contained in a form" 7건. public/index.html 의 type="password" 7개.
 *       (R2 = 60_PhotoFolder.js _scanSummaryLine — 회귀 검증은 tests/p180-scanproject-recursive.test.mjs ②에 반영됨)
 *
 * 대상: 28_AdminPanels.js(applyFeaturesToUI 가드) · 22_Auth.js(refresh() 단일 지점에서 1회 호출) ·
 *   29_CompanyAuth.js/37_Invite.js(_bindPwForm) · public/index.html(7개 <form> 래핑).
 * 실 모듈 소스를 vm 에 그대로 평가한다(재구현 금지, 목 아님) — 12_ProjectHub.js p176 테스트와 같은 패턴.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const ok = (cond, label, detail) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail).slice(0, 400) : "")); if (!cond) failed++; };

/* ══════════════════════════════════════════════════════════════
   공용 — 자동생성 fake DOM (getElementById 는 없으면 자동으로 만들어 돌려준다)
   ══════════════════════════════════════════════════════════════ */
function makeClassList() {
  const set = new Set();
  return { add: (...c) => c.forEach((x) => x && set.add(x)), remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle(c, f) { if (f === undefined) { if (set.has(c)) { set.delete(c); return false; } set.add(c); return true; } if (f) set.add(c); else set.delete(c); return !!f; },
    contains: (c) => set.has(c) };
}
function mkEl(id) {
  const listeners = {};
  const el = {
    id, classList: makeClassList(), style: {}, _text: "", _val: "", disabled: false,
    get textContent() { return this._text; }, set textContent(v) { this._text = v; },
    get value() { return this._val; }, set value(v) { this._val = v; },
    focus() {}, querySelector: () => null, setAttribute() {},
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type) {
      const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      (listeners[type] || []).forEach((fn) => fn(ev));
      return ev;
    }
  };
  return el;
}
function makeAutoDoc() {
  const registry = new Map();
  return { getElementById(id) { if (!registry.has(id)) registry.set(id, mkEl(id)); return registry.get(id); }, querySelector: () => null, body: mkEl("body"), createElement: () => mkEl("tmp") };
}

/* ══════════════════════════════════════════════════════════════
   R1 — 28_AdminPanels.js applyFeaturesToUI() 비로그인 가드 + 1회 적용
   ══════════════════════════════════════════════════════════════ */
console.log("\n[R1] AdminPanels.applyFeaturesToUI — 비로그인 요청 생략 + 로그인 후 1회");
function loadAdminPanels(src) {
  const calls = [];
  const Auth = { idToken: null, headers: () => ({}) };
  const document = { body: { classList: makeClassList() } };
  const FEATURE_DEFS = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true, json: async () => ({ value: {} }) }; };
  const sandbox = { console, Auth, document, FEATURE_DEFS, fetch: fetchImpl, InstallGate: undefined };
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__AP = AdminPanels;", sandbox);
  return { AP: sandbox.__AP, Auth, calls };
}
{
  const src = rd("public/js/modules/28_AdminPanels.js");
  const { AP, Auth, calls } = loadAdminPanels(src);

  await AP.applyFeaturesToUI();
  ok(calls.length === 0, "①a 비로그인(idToken null) → fetch 0회", calls);

  Auth.idToken = "tok1";
  await AP.applyFeaturesToUI();
  ok(calls.length === 1, "①b 로그인 완료(tok1) → fetch 1회", calls);

  await AP.applyFeaturesToUI();
  ok(calls.length === 1, "①c 같은 토큰 재호출 → 중복 fetch 없음(여전히 1회)", calls);

  Auth.idToken = "tok2";
  await AP.applyFeaturesToUI();
  ok(calls.length === 2, "①d 다른 토큰(재로그인) → fetch 2회째", calls);
}

/* 뮤테이션 — 비로그인 가드를 제거하면 비로그인에서도 fetch 가 나가야(결함 재현) 한다 */
{
  const src = rd("public/js/modules/28_AdminPanels.js");
  const needle = 'if (!Auth.idToken) { this._reflect(); return; }';
  const mutated = src.replace(needle, '/* mutated: guard removed */');
  if (mutated === src) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { AP, Auth, calls } = loadAdminPanels(mutated);
    Auth.idToken = undefined;   // null 은 _featuresFetchedFor 초기값(null)과 우연히 같아 dedup 가드에 또 걸린다 — undefined 로 비로그인 상태를 표현
    await AP.applyFeaturesToUI();
    ok(calls.length === 1, "[뮤테이션] 가드 제거 시 비로그인도 fetch 1회(결함 재현 — 원본은 0회였음)", calls);
  }
}

/* ══════════════════════════════════════════════════════════════
   R3 — public/index.html 비밀번호 7개 각자 <form> + JS 제출 preventDefault
   ══════════════════════════════════════════════════════════════ */
console.log("\n[R3-static] public/index.html — password 7개 각자 <form> 안");
{
  const html = rd("public/index.html");
  const pwInputs = html.match(/<input[^>]*type="password"[^>]*>/g) || [];
  ok(pwInputs.length === 7, "②a type=\"password\" 입력 7개", pwInputs.length);

  const forms = html.match(/<form[^>]*>[\s\S]*?<\/form>/g) || [];
  const pwFormIds = ["cg-pw-form", "cg-pw2-form", "cg-login-pw-form", "pwc-new-form", "pwc-new2-form", "inv-pw-form", "inv-pw2-form"];
  pwFormIds.forEach((fid) => {
    const block = forms.find((f) => f.indexOf('id="' + fid + '"') >= 0);
    ok(!!block && /type="password"/.test(block), "②b " + fid + " 안에 password 입력 1개 포함", block && block.slice(0, 120));
  });
  // 전체 password 입력 7개가 각각 하나의 <form> 블록 안에 있는지(바깥에 방치된 것 없는지)
  const wrapped = pwFormIds.reduce((n, fid) => n + (forms.filter((f) => f.indexOf('id="' + fid + '"') >= 0 && /type="password"/.test(f)).length), 0);
  ok(wrapped === 7, "②c password 7개 전부 자기 <form> 안(바깥 방치 0개)", wrapped);
}

console.log("\n[R3-runtime] 29_CompanyAuth.js / 37_Invite.js — 제출 시 preventDefault + 기존 동작만");
function loadCompanyAuth(src) {
  const document = makeAutoDoc();
  const Auth = { idToken: null, headers: () => ({}), refresh: async () => {}, user: null };
  const App = { openApp: () => {} };
  const Prompt = { toast: () => {} };
  const Projects = { currentProject: null };
  const Install = { maybePrompt: () => {} };
  const sandbox = {
    console, document, Auth, App, Prompt, Projects, Install,
    sessionStorage: { setItem() {}, getItem() { return null; }, removeItem() {} },
    localStorage: { setItem() {}, getItem() { return null; }, removeItem() {} },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    requestAnimationFrame: (fn) => fn(), setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__CA = CompanyAuth;", sandbox);
  return { CA: sandbox.__CA, document };
}
function loadInvite(src) {
  const document = makeAutoDoc();
  const Auth = { idToken: null, headers: () => ({}), user: null, _ROLE_LABELS: {} };
  const Prompt = { toast: () => {} };
  const ProjectHub = { refreshIfVisible: () => {} };
  const sandbox = {
    console, document, Auth, Prompt, ProjectHub,
    location: { search: "", pathname: "/" }, history: { replaceState() {} },
    sessionStorage: { setItem() {}, getItem() { return null; }, removeItem() {} },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    requestAnimationFrame: (fn) => fn(), setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__INV = Invite;", sandbox);
  return { INV: sandbox.__INV, document };
}

{
  const src = rd("public/js/modules/29_CompanyAuth.js");
  const { CA, document } = loadCompanyAuth(src);
  CA.init();
  let verifyCalls = 0, loginCalls = 0, pwChangeCalls = 0;
  CA._verify = async () => { verifyCalls++; };
  CA._login = async () => { loginCalls++; };
  CA._submitPwChange = async () => { pwChangeCalls++; };

  const evPw = document.getElementById("cg-pw-form").dispatch("submit");
  ok(evPw.defaultPrevented === true, "③a cg-pw-form 제출 → preventDefault(페이지 이동 금지)");
  ok(verifyCalls === 0 && loginCalls === 0, "③a-2 cg-pw-form 은 아무 동작도 안 함(첫 필드)");

  const evPw2 = document.getElementById("cg-pw2-form").dispatch("submit");
  ok(evPw2.defaultPrevented === true && verifyCalls === 1, "③b cg-pw2-form 제출 → preventDefault + _verify() 1회");

  const evLogin = document.getElementById("cg-login-pw-form").dispatch("submit");
  ok(evLogin.defaultPrevented === true && loginCalls === 1, "③c cg-login-pw-form 제출 → preventDefault + _login() 1회");

  const evPwcNew = document.getElementById("pwc-new-form").dispatch("submit");
  ok(evPwcNew.defaultPrevented === true && pwChangeCalls === 0, "③d pwc-new-form 제출 → preventDefault, 동작 없음(첫 필드)");

  const evPwcNew2 = document.getElementById("pwc-new2-form").dispatch("submit");
  ok(evPwcNew2.defaultPrevented === true && pwChangeCalls === 1, "③e pwc-new2-form 제출 → preventDefault + _submitPwChange() 1회");
}

{
  const src = rd("public/js/modules/37_Invite.js");
  const { INV, document } = loadInvite(src);
  INV.init();
  let acceptCalls = 0;
  INV.accept = async () => { acceptCalls++; };

  const evInvPw = document.getElementById("inv-pw-form").dispatch("submit");
  ok(evInvPw.defaultPrevented === true && acceptCalls === 0, "③f inv-pw-form 제출 → preventDefault, 동작 없음(첫 필드)");

  const evInvPw2 = document.getElementById("inv-pw2-form").dispatch("submit");
  ok(evInvPw2.defaultPrevented === true && acceptCalls === 1, "③g inv-pw2-form 제출 → preventDefault + accept() 1회");
}

/* 뮤테이션 C — 29_CompanyAuth.js _bindPwForm 의 preventDefault 를 제거하면 페이지 이동이 막히지 않아야(결함 재현) */
{
  const src = rd("public/js/modules/29_CompanyAuth.js");
  const needle = 'f.addEventListener("submit", (e) => { e.preventDefault(); try { onSubmit(); } catch (err) {} });';
  const mutated = src.replace(needle, 'f.addEventListener("submit", (e) => { try { onSubmit(); } catch (err) {} });');
  if (mutated === src) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { CA, document } = loadCompanyAuth(mutated);
    CA.init();
    const ev = document.getElementById("cg-pw-form").dispatch("submit");
    ok(ev.defaultPrevented === false, "[뮤테이션C] preventDefault 제거 시 페이지 이동이 막히지 않음(결함 재현 — 원본은 true)");
  }
}

/* 뮤테이션 D — 37_Invite.js bindPwForm 의 preventDefault 를 제거하면 동일하게 깨져야 함 */
{
  const src = rd("public/js/modules/37_Invite.js");
  const needle = 'if (f) f.addEventListener("submit", (e) => { e.preventDefault(); try { onSubmit(); } catch (err) {} });';
  const mutated = src.replace(needle, 'if (f) f.addEventListener("submit", (e) => { try { onSubmit(); } catch (err) {} });');
  if (mutated === src) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { INV, document } = loadInvite(mutated);
    INV.init();
    const ev = document.getElementById("inv-pw-form").dispatch("submit");
    ok(ev.defaultPrevented === false, "[뮤테이션D] preventDefault 제거 시 페이지 이동이 막히지 않음(결함 재현 — 원본은 true)");
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
