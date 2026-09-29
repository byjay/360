/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p86-install-first-screen.test.mjs)
 *
 * 발주서(WO 20260929) — 마스터: "핸드폰으로 접속하면 바로 어플을 설치할 수 있게 해"
 * 근본원인(지휘자 실측): maybePrompt() 는 로그인 직후에만 호출 → 첫 화면(로그인 전) 미표시.
 *   닫으면 localStorage 영구 저장(재노출 불가). beforeinstallprompt 가 늦게 오면 영영 무반응.
 *   설치 로직 2벌(38_Install.js + index.html 인라인 IIFE)이 같은 #pwa-install-btn 을 각자 제어.
 *
 * 검증:
 *  ① 모바일 + 로그인 전(첫 화면) → init() 호출만으로 배너 즉시 노출.
 *  ② beforeinstallprompt 가 배너를 연 "뒤"에 도착해도 그 순간 버튼이 비활성→활성으로 바뀐다
 *     (도착 전엔 "설치 준비 중" 비활성 — 조용한 무반응 아님).
 *  ③ 닫기 = 7일 스누즈(영구 아님) — 6일 후엔 그대로 숨김, 8일 후엔 다시 노출.
 *  ④ standalone(이미 설치) 이면 절대 노출 안 함.
 *  ⑤ iOS Safari → 공유 아이콘(인라인 SVG) 안내로 전환, accept 버튼 숨김.
 *  ⑥ SoT 단일 — public/index.html 에 beforeinstallprompt 리스너/중복 버튼 생성 로직이 없다
 *     (38_Install.js 1곳뿐).
 *
 * 실제 모듈 소스(38_Install.js)를 vm 에 그대로 평가해 검사한다(목 구현 아님).
 * 뮤테이션 2건 — 되돌리면 반드시 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const installSrc = rd("public/js/modules/38_Install.js");
const indexHtml = rd("public/index.html");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 최소 DOM 목(mock) — p12-toast-empty-guard.test.mjs 와 동일 패턴 ───────────── */
function makeClassList(initial) {
  const set = new Set(initial || []);
  return {
    add: (...c) => c.forEach((x) => x && set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle: (c, force) => { const on = force === undefined ? !set.has(c) : !!force; if (on) set.add(c); else set.delete(c); return on; },
    contains: (c) => set.has(c),
    _set: set
  };
}
function makeEl(id, opts) {
  opts = opts || {};
  const el = {
    id, dataset: {}, disabled: false, _text: "", _listeners: {},
    style: {}, children: [],
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this[k === "aria-label" ? "_ariaLabel" : k] = v; },
  };
  el.classList = makeClassList(opts.classes);
  Object.defineProperty(el, "textContent", { get() { return el._text; }, set(v) { el._text = v == null ? "" : String(v); } });
  return el;
}
/** banner 전용 — querySelector(".pwa-install-sub") 가 참조할 자식 하나를 붙인다(무한 재귀 방지 위해 makeEl 밖에서 생성). */
function attachSub(el) {
  el._sub = makeEl(null, { classes: [] });
  el.querySelector = (sel) => (sel === ".pwa-install-sub" ? el._sub : null);
  return el;
}

/** env: { standalone, ios, mobileWide(=isMobile() true/false), ua, nowMs } */
function loadInstall(env) {
  env = env || {};
  const registry = {
    "pwa-install-banner": attachSub(makeEl("pwa-install-banner", { classes: ["hidden"] })),
    "pwa-install-accept": makeEl("pwa-install-accept"),
    "pwa-install-close": makeEl("pwa-install-close"),
    "pwa-install-ios": makeEl("pwa-install-ios", { classes: ["hidden"] })
  };
  const body = { appendChild(c) { registry[c.id] = c; } };
  const winListeners = {};
  const localStore = {};
  const fixedNow = env.nowMs != null ? env.nowMs : 1_700_000_000_000;
  const sandbox = {
    console,
    document: {
      getElementById: (id) => registry[id] || null,
      createElement: (t) => makeEl(null),
      body
    },
    navigator: { userAgent: env.ua || "Mozilla/5.0 (Linux; Android 13)", platform: env.ua && env.ua.includes("iPhone") ? "iPhone" : "Linux armv8l", maxTouchPoints: env.ios ? 5 : 0, standalone: env.iosStandalone || false },
    localStorage: {
      getItem: (k) => (k in localStore ? localStore[k] : null),
      setItem: (k, v) => { localStore[k] = String(v); }
    },
    requestAnimationFrame: (fn) => fn(),
    setTimeout, clearTimeout,
    Date: { now: () => fixedNow }
  };
  sandbox.window = {
    matchMedia: (q) => {
      if (q.includes("display-mode: standalone")) return { matches: !!env.standalone };
      if (q.includes("pointer: coarse")) return { matches: !!env.mobileWide };
      if (q.includes("max-width")) return { matches: !!env.mobileWide };
      return { matches: false };
    },
    addEventListener: (ev, fn) => { (winListeners[ev] = winListeners[ev] || []).push(fn); },
    navigator: sandbox.navigator
  };
  vm.createContext(sandbox);
  vm.runInContext(installSrc + "\n;globalThis.__INSTALL = Install;", sandbox);
  return { Install: sandbox.__INSTALL, registry, winListeners, localStore, setNow: (ms) => { fixedNow_ref.v = ms; } };
}
/* ══════════ ① 모바일 + 로그인 전(첫 화면) → 즉시 배너 노출 ══════════ */
console.log("\n[① 첫 화면(로그인 전) 모바일 즉시 배너]");
{
  const { Install, registry } = loadInstall({ mobileWide: true, standalone: false });
  Install.init();
  const banner = registry["pwa-install-banner"];
  ok(!banner.classList.contains("hidden"), "① init() 호출만으로 배너 hidden 해제(로그인 여부 무관)");
}

/* ══════════ ② 늦게 온 beforeinstallprompt 에 반응 ══════════ */
console.log("\n[② beforeinstallprompt 지연 도착 시 배너 활성화]");
{
  const { Install, registry, winListeners } = loadInstall({ mobileWide: true, standalone: false });
  Install.init();
  const accept = registry["pwa-install-accept"];
  ok(accept.disabled === true && accept.textContent === "설치 준비 중", "② 도착 전: 버튼 비활성 + '설치 준비 중'(조용한 무반응 아님)");
  const fns = winListeners["beforeinstallprompt"] || [];
  ok(fns.length > 0, "② beforeinstallprompt 리스너 등록됨");
  fns.forEach((fn) => fn({ preventDefault() {}, userChoice: Promise.resolve({ outcome: "accepted" }) }));
  ok(accept.disabled === false && accept.textContent === "설치", "② 도착 순간: 버튼 활성화 + '설치'로 전환");
}

/* ══════════ ③ 7일 스누즈(영구 아님) ══════════ */
console.log("\n[③ 닫기 = 7일 스누즈]");
{
  // 같은 localStorage 를 공유하는 하나의 sandbox 안에서 시간만 이동시켜 검증(정확한 SoT 재현)
  const DAY = 24 * 60 * 60 * 1000;
  const t0 = 1_700_000_000_000;
  const registry = {
    "pwa-install-banner": attachSub(makeEl("pwa-install-banner", { classes: ["hidden"] })),
    "pwa-install-accept": makeEl("pwa-install-accept"),
    "pwa-install-close": makeEl("pwa-install-close"),
    "pwa-install-ios": makeEl("pwa-install-ios", { classes: ["hidden"] })
  };
  const body = { appendChild(c) { registry[c.id] = c; } };
  const localStore = {};
  let now = t0;
  const sandbox = {
    console,
    document: { getElementById: (id) => registry[id] || null, createElement: () => makeEl(null), body },
    navigator: { userAgent: "Mozilla/5.0 (Linux; Android 13)", platform: "Linux armv8l", maxTouchPoints: 0 },
    localStorage: { getItem: (k) => (k in localStore ? localStore[k] : null), setItem: (k, v) => { localStore[k] = String(v); } },
    requestAnimationFrame: (fn) => fn(),
    setTimeout, clearTimeout,
    Date: { now: () => now }
  };
  sandbox.window = { matchMedia: (q) => ({ matches: q.includes("pointer: coarse") || q.includes("max-width") }), addEventListener: () => {}, navigator: sandbox.navigator };
  vm.createContext(sandbox);
  vm.runInContext(installSrc + "\n;globalThis.__INSTALL = Install;", sandbox);
  const Install = sandbox.__INSTALL;

  Install.dismiss(); // t0 시점에 닫음 → t0+7일까지 스누즈
  now = t0 + 6 * DAY;
  registry["pwa-install-banner"].classList.add("hidden"); // 새 페이지 로드처럼 초기 상태로 리셋
  Install._booted = false;
  Install.init();
  ok(registry["pwa-install-banner"].classList.contains("hidden"), "③ +6일: 아직 스누즈 기간 — 배너 숨김 유지");

  now = t0 + 8 * DAY;
  registry["pwa-install-banner"].classList.add("hidden");
  Install._booted = false;
  Install.init();
  ok(!registry["pwa-install-banner"].classList.contains("hidden"), "③ +8일: 스누즈 만료 — 배너 재노출(영구 금지 증명)");
}

/* ══════════ ④ standalone → 절대 노출 안 함 ══════════ */
console.log("\n[④ standalone(이미 설치) → 미노출]");
{
  const { Install, registry } = loadInstall({ mobileWide: true, standalone: true });
  Install.init();
  ok(registry["pwa-install-banner"].classList.contains("hidden"), "④ standalone: 배너 계속 hidden");
  ok(registry["pwa-install-btn"] === undefined, "④ standalone: 상시 버튼도 생성되지 않음");
}

/* ══════════ ⑤ iOS → 인라인 SVG 공유 안내 ══════════ */
console.log("\n[⑤ iOS Safari 안내]");
{
  const { Install, registry } = loadInstall({ mobileWide: true, ios: true, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" });
  Install.init();
  const banner = registry["pwa-install-banner"];
  const ios = registry["pwa-install-ios"];
  const accept = registry["pwa-install-accept"];
  ok(!banner.classList.contains("hidden"), "⑤ iOS 도 첫 화면에 배너 노출");
  ok(!ios.classList.contains("hidden"), "⑤ iOS 안내(공유→홈 화면에 추가) 노출");
  ok(accept.classList.contains("hidden"), "⑤ iOS 는 accept 버튼 숨김(설치 API 없음)");
}
ok(/<rect[^>]*width="14"[^>]*height="8"/.test(indexHtml) && /pwa-install-ios/.test(indexHtml.slice(indexHtml.indexOf("pwa-install-ios") - 400, indexHtml.indexOf("pwa-install-ios") + 400)),
  "⑤ index.html #pwa-install-ios 안내에 인라인 SVG(그림) 포함");

/* ══════════ ⑥ SoT 단일 — index.html 중복 로직 제거 ══════════ */
console.log("\n[⑥ SoT 단일 — index.html 중복 제거]");
ok(!/addEventListener\(['"]beforeinstallprompt['"]/.test(indexHtml), "⑥ index.html 에 beforeinstallprompt 리스너 없음(38_Install.js 1곳뿐)");
ok(!/getElementById\(['"]pwa-install-btn['"]\)/.test(indexHtml), "⑥ index.html 에 #pwa-install-btn 생성/조회 로직 없음");

/* ══════════ 뮤테이션 1 — _onDeferredReady 호출 제거 → ②가 실패해야 함 ══════════ */
console.log("\n[뮤테이션 1] beforeinstallprompt 리스너의 _onDeferredReady() 호출 제거 → ②붕괴 확인");
{
  const needle = "this._deferred = e;\n          this._onDeferredReady();";
  const mutated = installSrc.replace(needle, "this._deferred = e;");
  if (mutated === installSrc) { console.log("  FAIL 뮤테이션1 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const registry = {
      "pwa-install-banner": attachSub(makeEl("pwa-install-banner", { classes: ["hidden"] })),
      "pwa-install-accept": makeEl("pwa-install-accept"),
      "pwa-install-close": makeEl("pwa-install-close"),
      "pwa-install-ios": makeEl("pwa-install-ios", { classes: ["hidden"] })
    };
    const body = { appendChild(c) { registry[c.id] = c; } };
    const winListeners = {};
    const localStore = {};
    const sandbox = {
      console,
      document: { getElementById: (id) => registry[id] || null, createElement: () => makeEl(null), body },
      navigator: { userAgent: "Mozilla/5.0 (Linux; Android 13)", platform: "Linux armv8l", maxTouchPoints: 0 },
      localStorage: { getItem: (k) => (k in localStore ? localStore[k] : null), setItem: (k, v) => { localStore[k] = String(v); } },
      requestAnimationFrame: (fn) => fn(), setTimeout, clearTimeout, Date: { now: () => 1_700_000_000_000 }
    };
    sandbox.window = { matchMedia: (q) => ({ matches: q.includes("pointer: coarse") || q.includes("max-width") }), addEventListener: (ev, fn) => { (winListeners[ev] = winListeners[ev] || []).push(fn); }, navigator: sandbox.navigator };
    vm.createContext(sandbox);
    vm.runInContext(mutated + "\n;globalThis.__INSTALL = Install;", sandbox);
    const Install = sandbox.__INSTALL;
    Install.init();
    const accept = registry["pwa-install-accept"];
    (winListeners["beforeinstallprompt"] || []).forEach((fn) => fn({ preventDefault() {}, userChoice: Promise.resolve({ outcome: "accepted" }) }));
    ok(accept.disabled === true, `뮤테이션1 적용 시 버튼이 계속 비활성(disabled=${accept.disabled}) — ②붕괴 증명(늦은 도착에 무반응으로 되돌아감)`);
  }
}

/* ══════════ 뮤테이션 2 — 스누즈 만료 조건 제거(영구화) → ③붕괴 확인 ══════════ */
console.log("\n[뮤테이션 2] _dismissed() 를 영구 스누즈로 되돌림 → ③붕괴 확인");
{
  const needle = "return Date.now() < until;";
  const mutated = installSrc.replace(needle, "return until > 0;"); // 한번 닫으면 시간 무관 영구 숨김(구버전 재현)
  if (mutated === installSrc) { console.log("  FAIL 뮤테이션2 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const DAY = 24 * 60 * 60 * 1000;
    const t0 = 1_700_000_000_000;
    const registry = {
      "pwa-install-banner": attachSub(makeEl("pwa-install-banner", { classes: ["hidden"] })),
      "pwa-install-accept": makeEl("pwa-install-accept"),
      "pwa-install-close": makeEl("pwa-install-close"),
      "pwa-install-ios": makeEl("pwa-install-ios", { classes: ["hidden"] })
    };
    const body = { appendChild(c) { registry[c.id] = c; } };
    const localStore = {};
    let now = t0;
    const sandbox = {
      console,
      document: { getElementById: (id) => registry[id] || null, createElement: () => makeEl(null), body },
      navigator: { userAgent: "Mozilla/5.0 (Linux; Android 13)", platform: "Linux armv8l", maxTouchPoints: 0 },
      localStorage: { getItem: (k) => (k in localStore ? localStore[k] : null), setItem: (k, v) => { localStore[k] = String(v); } },
      requestAnimationFrame: (fn) => fn(), setTimeout, clearTimeout, Date: { now: () => now }
    };
    sandbox.window = { matchMedia: (q) => ({ matches: q.includes("pointer: coarse") || q.includes("max-width") }), addEventListener: () => {}, navigator: sandbox.navigator };
    vm.createContext(sandbox);
    vm.runInContext(mutated + "\n;globalThis.__INSTALL = Install;", sandbox);
    const Install = sandbox.__INSTALL;
    Install.dismiss();
    now = t0 + 8 * DAY;
    registry["pwa-install-banner"].classList.add("hidden");
    Install._booted = false;
    Install.init();
    ok(registry["pwa-install-banner"].classList.contains("hidden"), "뮤테이션2 적용 시 +8일에도 계속 숨김(영구 스누즈로 퇴행) — ③붕괴 증명");
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
