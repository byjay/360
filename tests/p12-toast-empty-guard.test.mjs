/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p12-toast-empty-guard.test.mjs)
 *
 * 결함(마스터 스크린샷 실측): 하단에 "검은 상자만" 뜨는 현상의 원인 후보 중 하나로,
 * Prompt.toast() 가 빈 문자열/undefined/공백 메시지로 호출되면 내용 없는 토스트 상자를
 * DOM 에 그대로 추가하고 있었다(글자가 없으니 배경만 보임 = 사용자 눈엔 잡음).
 *
 * 검증 항목:
 *  ① toast("") / toast(undefined) / toast(null) / toast("   ") → #wm-toast-host 에
 *     자식(.wm-toast)이 하나도 추가되지 않는다(호스트 자체도 아직 없으면 생성조차 안 함).
 *  ② toast("정상 메시지") → .wm-toast 1개가 정상 추가되고 textContent 에 메시지가 담긴다
 *     (가드가 정상 호출까지 막지 않는지 확인 — 회귀 없음).
 *
 * 실제 모듈 소스(30_Prompt.js)를 그대로 vm 에 평가해 검사한다(목 구현 아님).
 * 뮤테이션 증명: 가드(`if (!text) return;`)를 제거하면 ①이 실패해야 한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const fullSrc = rd("public/js/modules/30_Prompt.js");
// 파일이 뒤에 다른 섹션(PROJECTS 등)의 헤더 주석까지 이어지는 연결식 구조이므로,
// Prompt 객체 리터럴이 끝나는 지점(첫 "};" 줄)까지만 잘라서 평가한다.
const promptSrc = fullSrc.slice(0, fullSrc.indexOf("\n  };") + 5);

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 최소 DOM 목(mock) — p10-deck-empty-state.test.mjs 와 동일 패턴 ─────────────── */
function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => x && set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    contains: (c) => set.has(c),
    _set: set
  };
}
function makeEl(tag) {
  const el = {
    tagName: tag || "div", dataset: {}, _text: "", _children: [],
    appendChild(c) { this._children.push(c); return c; },
    remove() { if (el._parent) { const i = el._parent._children.indexOf(el); if (i >= 0) el._parent._children.splice(i, 1); } },
    get children() { return this._children; },
    get firstElementChild() { return this._children[0] || null; }
  };
  Object.defineProperty(el, "textContent", { get() { return this._text; }, set(v) { this._text = v == null ? "" : String(v); } });
  el.classList = makeClassList();
  const origAppend = el.appendChild.bind(el);
  el.appendChild = (c) => { c._parent = el; return origAppend(c); };
  return el;
}
function makeDoc() {
  const registry = {};
  const body = makeEl("body");
  const document = {
    body,
    getElementById: (id) => registry[id] || null,
    createElement: (t) => makeEl(t)
  };
  // wm-toast-host 는 toast() 내부에서 document.createElement + body.appendChild 로 생성되고
  // 이후 getElementById 로 재조회되므로, 생성 시 registry 에도 등록해야 한다.
  const origCreate = document.createElement;
  document.createElement = (t) => {
    const el = origCreate(t);
    const origSetId = Object.getOwnPropertyDescriptor(el, "id");
    Object.defineProperty(el, "id", {
      get() { return el._id; },
      set(v) { el._id = v; registry[v] = el; }
    });
    return el;
  };
  return { document, registry };
}

function loadPrompt() {
  const { document } = makeDoc();
  const sandbox = {
    console, document,
    requestAnimationFrame: (fn) => fn(),
    setTimeout, clearTimeout
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(promptSrc + "\n;globalThis.__PROMPT = Prompt;", sandbox);
  return { Prompt: sandbox.__PROMPT, document };
}

/* ══ ① 빈/undefined/null/공백 메시지 → 토스트 미추가 ══════════════════════ */
{
  const { Prompt, document } = loadPrompt();
  Prompt.toast("");
  Prompt.toast(undefined);
  Prompt.toast(null);
  Prompt.toast("   ");
  const host = document.getElementById("wm-toast-host");
  ok(host === null, `① 빈 메시지 4회 호출 → #wm-toast-host 자체도 생성되지 않음 (실제 ${host === null ? "null" : "생성됨"})`);
}

/* ══ ② 정상 메시지 → 토스트 1개 정상 추가(가드가 정상 흐름을 막지 않음) ══════ */
{
  const { Prompt, document } = loadPrompt();
  Prompt.toast("오른쪽 방향이 지정되었습니다");
  const host = document.getElementById("wm-toast-host");
  ok(!!host, "② 정상 메시지 → #wm-toast-host 생성됨");
  ok(host && host.children.length === 1, `② .wm-toast 1개 추가됨 (실제 ${host ? host.children.length : "N/A"})`);
  ok(host && host.children[0] && host.children[0].textContent === "오른쪽 방향이 지정되었습니다", "② textContent 에 메시지 정상 반영");
}

console.log(failed === 0 ? "\n전체 PASS" : `\n${failed}건 FAIL`);
process.exit(failed === 0 ? 0 : 1);
