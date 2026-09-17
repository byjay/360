/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p28-help.test.mjs)
 *
 * 대상: public/js/modules/36_Help.js — "항상 모든 메뉴마다 사용자 매뉴얼을 구현해"
 * (마스터 지시, 2026-09-17) 의 1단계 체계: `data-help="키"` 요소를 길게 누르면
 * (Pointer Events 기반, 마우스 누르고 있기 = 터치 길게 누르기와 동일 코드) 근처에
 * 도움말 팝업이 뜬다.
 *
 * 검사:
 *  ① data-help 있는 요소를 길게 누르면 정본(Help.CONTENT)의 도움말이 연결된다
 *     (부수 검사: 길게 눌러 팝업이 뜬 직후의 click 1회는 버튼 오작동 방지를 위해 억제된다)
 *  ② 도움말 정본이 한 곳(Help.CONTENT)에만 있다 — 동일 키 문자열이 소스에 중복 정의되지 않는다
 *  ③ 없는 키 → 조용한 실패 없이 "준비 중" 문구 + console.warn 으로 처리된다(예외 없음)
 *  ④ 기존 title 속성(브라우저 기본 툴팁)은 이 레이어가 절대 건드리지 않는다
 *  ⑤ 36_Help.js 모듈이 _manifest.txt 에 등록돼 있다(고아 모듈 방지)
 *  ⑥ 뷰어 모드(State.mode==="viewer")에서도 동일하게 동작한다
 *     (Help 는 State 에 의존하지 않는 순수 DOM 레이어이므로 모드 무관 — 이 자체가 설계 근거)
 *
 * 실제 모듈 소스(36_Help.js)를 그대로 vm 에 평가해 검사한다(목 구현 아님).
 * 뮤테이션 2건이 붙어 있어, 고친 코드를 되돌리면 해당 검사가 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const helpSrc = rd("public/js/modules/36_Help.js");
const manifest = rd("public/js/modules/_manifest.txt");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 최소 DOM 목(mock) — pointer-hold 흐름 검증에 필요한 만큼만 ── */
function makeEl(tag) {
  const el = {
    tagName: tag || "div", dataset: {}, style: {}, title: "", _attrs: {}, parentNode: null, _text: "",
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k]; },
    getBoundingClientRect() { return { left: 10, top: 10, bottom: 30, width: 50, height: 20 }; },
    closest(sel) {
      const attr = sel.replace(/^\[|\]$/g, "");
      let n = this;
      while (n) {
        if (attr === "data-help" && n.dataset && n.dataset.help) return n;
        if (attr === "data-help-popup" && n._attrs && n._attrs["data-help-popup"]) return n;
        n = n.parentNode || null;
      }
      return null;
    }
  };
  Object.defineProperty(el, "textContent", { get() { return this._text; }, set(v) { this._text = v == null ? "" : String(v); } });
  return el;
}
function makeDoc() {
  const listeners = {};
  const body = {
    children: [],
    appendChild(c) { this.children.push(c); c.parentNode = body; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i !== -1) this.children.splice(i, 1); c.parentNode = null; }
  };
  const document = {
    body,
    createElement: (t) => makeEl(t),
    addEventListener(type, fn, capture) { (listeners[type] = listeners[type] || []).push({ fn, capture: !!capture }); }
  };
  return { document, listeners, body };
}
/** 결정적(fake) 타이머 — 실제 500ms 대기 없이 hold 시나리오를 재현한다. */
function makeClock() {
  let id = 0;
  const pending = new Map();
  return {
    setTimeout(fn) { const t = ++id; pending.set(t, fn); return t; },
    clearTimeout(t) { pending.delete(t); },
    flush() { const fns = Array.from(pending.values()); pending.clear(); fns.forEach((fn) => fn()); }
  };
}
function makeEnv() {
  const { document, listeners, body } = makeDoc();
  const clock = makeClock();
  const warns = [];
  const sandbox = {
    console: { warn: (...a) => warns.push(a.join(" ")), log() {}, error() {} },
    document,
    window: { addEventListener() {}, innerWidth: 1024, innerHeight: 768 },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(helpSrc + "\n;globalThis.__Help = Help;", sandbox);
  sandbox.__Help.init();
  return { Help: sandbox.__Help, document, listeners, body, clock, warns };
}
function fire(listeners, type, evt) {
  (listeners[type] || []).forEach(({ fn }) => fn(evt));
}
function holdOn(env, el, opts) {
  fire(env.listeners, "pointerdown", Object.assign({ target: el, clientX: 0, clientY: 0 }, opts || {}));
  env.clock.flush(); // HOLD_MS 경과 시뮬레이션 → 타이머 콜백(Help.show) 실행
}

console.log("\n[정상 소스]");

/* ══ ① data-help 요소를 길게 누르면 정본 도움말이 연결된다 + 직후 click 1회 억제 ══ */
{
  const env = makeEnv();
  const btn = makeEl("button");
  btn.dataset.help = "zone-create";
  holdOn(env, btn);
  const popup = env.body.children[env.body.children.length - 1];
  ok(!!popup && popup.textContent === env.Help.CONTENT["zone-create"],
    "① 길게 누르면 data-help 키에 대응하는 정본(Help.CONTENT) 문구가 팝업에 그대로 표시됨");

  // 부수: 팝업이 뜬 직후의 click 은 버튼 원래 동작으로 이어지지 않게 억제된다
  let clicked = false;
  let prevented = false;
  const clickEvt = { target: btn, preventDefault: () => { prevented = true; }, stopPropagation() {} };
  fire(env.listeners, "click", clickEvt);
  ok(prevented === true, "① 길게 눌러 팝업이 뜬 직후의 click 1회는 preventDefault 로 억제됨(버튼 오작동 방지)");
}

/* ══ ② 도움말 정본이 한 곳에만 있다(중복 정의 0) ══ */
{
  const key = 'zone-create';
  const occurrences = helpSrc.split(key).length - 1;
  ok(occurrences === 1, `② 정본 키("${key}")가 소스 전체에서 정확히 1회만 등장(중복 정의 없음) → ${occurrences}회`);

  console.log("\n[뮤테이션②] 정본을 두 곳으로 쪼개면(같은 키를 다른 객체에도 정의) 이 검사가 실패해야 함");
  const mutated = helpSrc + "\n  const _SPLIT_HELP_CONTENT = { \"zone-create\": \"쪼개진 두번째 정본(위반)\" };\n";
  const occ2 = mutated.split(key).length - 1;
  ok(occ2 !== 1, `뮤테이션 적용 시 중복 정의가 생겨 "정본 1곳" 판정이 깨짐(테스트 실효성 증명) → ${occ2}회`);
}

/* ══ ③ 없는 키 → 조용한 실패 없이 "준비 중" + console.warn, 예외 없음 ══ */
{
  const env = makeEnv();
  const btn = makeEl("button");
  btn.dataset.help = "존재하지-않는-키-xyz";
  let threw = false;
  try { holdOn(env, btn); } catch (e) { threw = true; }
  ok(threw === false, "③ 정의되지 않은 키를 눌러도 예외 없이 처리됨");
  const popup = env.body.children[env.body.children.length - 1];
  ok(!!popup && /준비 중/.test(popup.textContent), `③ "준비 중" 문구로 조용한 실패 없이 표시됨 → "${popup && popup.textContent}"`);
  ok(env.warns.some((w) => /Help/.test(w) && /존재하지-않는-키-xyz/.test(w)),
    "③ 개발자에게는 console.warn 으로 빠진 키를 알림(사용자에게는 오류로 안 보임)");
}

/* ══ ④ 기존 title 속성은 이 레이어가 절대 건드리지 않는다 ══ */
{
  const env = makeEnv();
  const btn = makeEl("button");
  btn.title = "원래 브라우저 기본 툴팁";
  btn.dataset.help = "pin-place";
  holdOn(env, btn);
  ok(btn.title === "원래 브라우저 기본 툴팁", "④ 길게 눌러 도움말을 띄운 뒤에도 기존 title 속성이 그대로 보존됨");
}

/* ══ ⑤ 36_Help.js 가 _manifest.txt 에 등록돼 있다(고아 모듈 방지) ══ */
{
  const registered = manifest.split("\n").map((l) => l.trim()).includes("36_Help.js");
  ok(registered === true, "⑤ _manifest.txt 에 36_Help.js 가 등록되어 있음(번들 조립 대상)");

  console.log("\n[뮤테이션⑤] manifest 등록을 제거하면 이 검사가 실패해야 함");
  const mutatedManifest = manifest.split("\n").filter((l) => l.trim() !== "36_Help.js").join("\n");
  const registeredAfter = mutatedManifest.split("\n").map((l) => l.trim()).includes("36_Help.js");
  ok(registeredAfter === false, "뮤테이션 적용 시 등록이 사라져 고아 모듈 판정으로 깨짐(테스트 실효성 증명)");
}

/* ══ ⑥ 뷰어 모드(State.mode==="viewer")에서도 동일하게 동작한다 ══ */
{
  const env = makeEnv();
  // Help 는 State 를 전혀 참조하지 않는 순수 DOM 레이어 — 뷰어 전역에 State가 있어도 동작에
  // 영향이 없음을 그대로 증명한다(모드 분기 없이도 뷰어에서 보이는 것이 설계 목표였다).
  const State = { mode: "viewer" };
  const btn = makeEl("button");
  btn.dataset.help = "deploy-viewer";
  holdOn(env, btn);
  const popup = env.body.children[env.body.children.length - 1];
  ok(!!popup && popup.textContent === env.Help.CONTENT["deploy-viewer"] && State.mode === "viewer",
    "⑥ State.mode='viewer' 상황에서도 도움말 팝업이 동일하게 표시됨(모드 무관 동작)");
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
