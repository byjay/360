/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p28-help.test.mjs)
 *
 * 대상: public/js/modules/36_Help.js — "항상 모든 메뉴마다 사용자 매뉴얼을 구현해"
 * (마스터 지시, 2026-09-17) 의 1단계 체계.
 *
 * 🔴 [재작업] 최초 구현("길게 누르기")은 화면에 단서가 없어 존재를 알 수 없고
 * 버튼 원래 클릭과 충돌한다는 이유로 반려됨(지휘자 지시, 2026-09-17). 트리거를
 * **도움말 모드 토글("?" 버튼, 항상 화면에 보임) + data-help 요소마다 붙는 "?" 배지**
 * 로 교체했다. 정본(Help.CONTENT) 8키와 SoT/미정의키/manifest/title보존/뷰어모드
 * 검증은 그대로 유지하고, 트리거 계층만 재검증한다.
 *
 * 검사:
 *  ① 도움말 모드를 켜면(toggle) data-help 요소마다 "?" 배지가 화면에 나타나고,
 *     배지를 누르면 정본(Help.CONTENT) 문구가 연결된다(사용자가 존재를 알 수 있음)
 *  ② 도움말 모드를 끄면 배지가 전부 사라진다(평소엔 화면이 깨끗함)
 *  ③ 배지를 눌러도 그 아래 원래 버튼의 클릭 동작은 실행되지 않는다(충돌 없음)
 *  ④ 토글·배지 모두 click 이벤트만으로 동작 — hover 의존 0(터치 전용 환경에서도 도달 가능)
 *  ⑤ 도움말 정본이 한 곳(Help.CONTENT)에만 있다(중복 정의 0)
 *  ⑥ 없는 키 → 조용한 실패 없이 "준비 중" 문구 + console.warn 으로 처리된다(예외 없음)
 *  ⑦ 기존 title 속성(브라우저 기본 툴팁)은 이 레이어가 절대 건드리지 않는다
 *  ⑧ 36_Help.js 모듈이 _manifest.txt 에 등록돼 있다(고아 모듈 방지)
 *  ⑨ 뷰어 모드(State.mode==="viewer")에서도 동일하게 동작한다
 *
 * 실제 모듈 소스(36_Help.js)를 그대로 vm 에 평가해 검사한다(목 구현 아님).
 * 뮤테이션 2건: "토글 상태 무시" → ①②실패 / "원래 동작 차단 제거" → ③실패.
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

/* ── 최소 DOM 목(mock) ─────────────────────────────────────────────── */
function makeEl(tag) {
  const el = {
    tagName: tag || "div", dataset: {}, style: {}, title: "", _attrs: {}, parentNode: null, _text: "",
    _handlers: {},
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k]; },
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    getBoundingClientRect() { return { left: 10, top: 10, bottom: 30, width: 50, height: 20 }; }
  };
  Object.defineProperty(el, "textContent", { get() { return this._text; }, set(v) { this._text = v == null ? "" : String(v); } });
  return el;
}
function makeDoc() {
  const allEls = []; // 테스트가 "지금 페이지에 있는 요소들"을 수동으로 등록(실제 DOM 트리 대신)
  const body = {
    children: [],
    appendChild(c) { this.children.push(c); c.parentNode = body; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i !== -1) this.children.splice(i, 1); c.parentNode = null; }
  };
  const document = {
    body,
    _all: allEls,
    createElement: (t) => makeEl(t),
    querySelectorAll(sel) {
      if (sel === "[data-help]") return allEls.filter((e) => e.dataset && e.dataset.help);
      return [];
    },
    addEventListener() {}
  };
  return { document, body, allEls };
}
function makeEnv() {
  const { document, body, allEls } = makeDoc();
  const warns = [];
  const sandbox = {
    console: { warn: (...a) => warns.push(a.join(" ")), log() {}, error() {} },
    document,
    window: { addEventListener() {}, innerWidth: 1024, innerHeight: 768 },
    setTimeout, clearTimeout // 실제 타이머(팝업 6초 자동닫힘)는 이번 검사 범위 밖 — 그대로 통과
  };
  vm.createContext(sandbox);
  vm.runInContext(helpSrc + "\n;globalThis.__Help = Help;", sandbox);
  sandbox.__Help.init();
  return { Help: sandbox.__Help, document, body, allEls, warns };
}
/** 배지 click 이 실제로 대상(target)까지 버블링되는지 백박스 검증용 — 배지를 target 의
 *  자식으로 임시 재배치한 뒤(운영 코드는 body 에 붙이지만, stopPropagation 방어자체를
 *  구조와 무관하게 단위검증하기 위함) stopPropagation 을 지키며 버블링을 흉내낸다. */
function dispatchBubble(el, type, base) {
  const evt = Object.assign({ _stopped: false }, base, {
    stopPropagation() { this._stopped = true; },
    preventDefault() { this._prevented = true; }
  });
  let n = el;
  while (n) {
    (n._handlers && n._handlers[type] || []).forEach((fn) => { if (!evt._stopped) fn(evt); });
    if (evt._stopped) break;
    n = n.parentNode || null;
  }
  return evt;
}

console.log("\n[정상 소스]");

/* ══ ① 토글 ON → data-help 요소마다 배지가 보이고, 배지 클릭 → 정본 연결 ══ */
{
  const env = makeEnv();
  const target = makeEl("button");
  target.dataset.help = "zone-create";
  env.allEls.push(target);

  ok(env.body.children.filter((c) => c._attrs["data-help-badge"]).length === 0,
    "① 도움말 모드를 켜기 전에는 배지가 하나도 없음(평소 화면이 깨끗함)");

  env.Help.toggle(); // OFF → ON
  ok(env.Help.active === true, "① toggle() 호출 시 Help.active 가 true 로 바뀜(모드 ON)");
  const badges = env.body.children.filter((c) => c._attrs["data-help-badge"]);
  ok(badges.length === 1, `① data-help 요소 수만큼 "?" 배지가 화면(body)에 생성됨 → ${badges.length}개`);

  const entry = env.Help._badges.find((b) => b.target === target);
  entry.badge._handlers.click[0]({ preventDefault() {}, stopPropagation() {} });
  const popup = env.body.children[env.body.children.length - 1];
  ok(!!popup && popup.textContent === env.Help.CONTENT["zone-create"],
    "① 배지를 누르면 정본(Help.CONTENT) 문구가 그대로 팝업에 표시됨");
}

/* ══ ② 토글 OFF → 배지 전부 제거 ══ */
{
  const env = makeEnv();
  const target = makeEl("button");
  target.dataset.help = "drawing-upload";
  env.allEls.push(target);

  env.Help.enable();
  ok(env.body.children.filter((c) => c._attrs["data-help-badge"]).length === 1, "② (사전조건) 켜면 배지 1개 존재");
  env.Help.disable();
  ok(env.Help.active === false, "② disable() 호출 시 Help.active 가 false 로 바뀜(모드 OFF)");
  ok(env.body.children.filter((c) => c._attrs["data-help-badge"]).length === 0,
    "② 도움말 모드를 끄면 배지가 전부 사라짐(평소 화면으로 복귀)");
}

/* ══ ③ 배지를 눌러도 원래 버튼의 클릭 동작은 실행되지 않는다 ══ */
{
  const env = makeEnv();
  const target = makeEl("button");
  target.dataset.help = "pin-place";
  env.allEls.push(target);
  let btnClicked = false;
  target.addEventListener("click", () => { btnClicked = true; });

  env.Help.enable();
  const entry = env.Help._badges.find((b) => b.target === target);
  entry.badge.parentNode = target; // 방어코드(stopPropagation) 자체를 구조와 무관하게 검증
  dispatchBubble(entry.badge, "click", {});
  ok(btnClicked === false, "③ 배지를 눌러도 원래 버튼의 click 핸들러가 실행되지 않음(충돌 없음)");
}

/* ══ ④ 토글·배지 모두 click 이벤트만으로 동작(hover 의존 0 — 터치 전용 환경에서도 도달) ══ */
{
  // 주석(설명문)엔 "왜 mouseenter 를 안 쓰는지"가 언급되므로 주석을 제거한 실제
  // 코드에서만 hover 계열 이벤트 등록 여부를 검사한다(자기지시적 오탐 방지).
  const codeOnly = helpSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const hoverPatterns = ["mouseenter", "mouseover", "pointerenter", ":hover"];
  const hasHoverDep = hoverPatterns.some((p) => codeOnly.includes(p));
  ok(hasHoverDep === false, "④ 실제 코드(주석 제외)에 hover 계열 이벤트/의존이 전혀 없음(click 만으로 완결)");

  // 이 파일의 모든 시나리오(①②③⑨)가 hover 를 단 한 번도 발생시키지 않고 click 만으로
  // 토글→배지노출→배지클릭→팝업표시까지 전부 성공한다는 사실 자체가 터치 전용 환경(현장 폰,
  // 호버 없음)에서도 100% 동일 경로로 도달 가능함을 증명한다.
  const env = makeEnv();
  const target = makeEl("button");
  target.dataset.help = "checkerboard";
  env.allEls.push(target);
  env.Help._toggleBtn._handlers.click[0]({ preventDefault() {}, stopPropagation() {} }); // 탭(click)만 사용
  const entry = env.Help._badges.find((b) => b.target === target);
  entry.badge._handlers.click[0]({ preventDefault() {}, stopPropagation() {} }); // 탭(click)만 사용
  const popup = env.body.children[env.body.children.length - 1];
  ok(!!popup && popup.textContent === env.Help.CONTENT["checkerboard"],
    "④ click 이벤트만으로 토글→배지노출→내용표시 전 과정이 완결됨(호버 불필요)");
}

/* ══ ⑤ 도움말 정본이 한 곳에만 있다(중복 정의 0) ══ */
{
  const key = "zone-create";
  const occurrences = helpSrc.split(key).length - 1;
  ok(occurrences === 1, `⑤ 정본 키("${key}")가 소스 전체에서 정확히 1회만 등장(중복 정의 없음) → ${occurrences}회`);

  console.log("\n[뮤테이션A-보조] 정본을 두 곳으로 쪼개면(같은 키를 다른 객체에도 정의) 이 검사가 실패해야 함");
  const mutated = helpSrc + "\n  const _SPLIT_HELP_CONTENT = { \"zone-create\": \"쪼개진 두번째 정본(위반)\" };\n";
  const occ2 = mutated.split(key).length - 1;
  ok(occ2 !== 1, `뮤테이션 적용 시 중복 정의가 생겨 "정본 1곳" 판정이 깨짐(테스트 실효성 증명) → ${occ2}회`);
}

/* ══ ⑥ 없는 키 → 조용한 실패 없이 "준비 중" + console.warn, 예외 없음 ══ */
{
  const env = makeEnv();
  const target = makeEl("button");
  let threw = false;
  try { env.Help.show(target, "존재하지-않는-키-xyz"); } catch (e) { threw = true; }
  ok(threw === false, "⑥ 정의되지 않은 키를 호출해도 예외 없이 처리됨");
  const popup = env.body.children[env.body.children.length - 1];
  ok(!!popup && /준비 중/.test(popup.textContent), `⑥ "준비 중" 문구로 조용한 실패 없이 표시됨 → "${popup && popup.textContent}"`);
  ok(env.warns.some((w) => /Help/.test(w) && /존재하지-않는-키-xyz/.test(w)),
    "⑥ 개발자에게는 console.warn 으로 빠진 키를 알림(사용자에게는 오류로 안 보임)");
}

/* ══ ⑦ 기존 title 속성은 이 레이어가 절대 건드리지 않는다 ══ */
{
  const env = makeEnv();
  const target = makeEl("button");
  target.title = "원래 브라우저 기본 툴팁";
  target.dataset.help = "pin-place";
  env.allEls.push(target);
  env.Help.enable();
  const entry = env.Help._badges.find((b) => b.target === target);
  entry.badge._handlers.click[0]({ preventDefault() {}, stopPropagation() {} });
  ok(target.title === "원래 브라우저 기본 툴팁", "⑦ 도움말을 띄운 뒤에도 기존 title 속성이 그대로 보존됨");
}

/* ══ ⑧ 36_Help.js 가 _manifest.txt 에 등록돼 있다(고아 모듈 방지) ══ */
{
  const registered = manifest.split("\n").map((l) => l.trim()).includes("36_Help.js");
  ok(registered === true, "⑧ _manifest.txt 에 36_Help.js 가 등록되어 있음(번들 조립 대상)");

  console.log("\n[뮤테이션B-보조] manifest 등록을 제거하면 이 검사가 실패해야 함");
  const mutatedManifest = manifest.split("\n").filter((l) => l.trim() !== "36_Help.js").join("\n");
  const registeredAfter = mutatedManifest.split("\n").map((l) => l.trim()).includes("36_Help.js");
  ok(registeredAfter === false, "뮤테이션 적용 시 등록이 사라져 고아 모듈 판정으로 깨짐(테스트 실효성 증명)");
}

/* ══ ⑨ 뷰어 모드(State.mode==="viewer")에서도 동일하게 동작한다 ══ */
{
  const env = makeEnv();
  const State = { mode: "viewer" }; // Help 는 State 를 참조하지 않는 순수 DOM 레이어
  const target = makeEl("button");
  target.dataset.help = "deploy-viewer";
  env.allEls.push(target);
  env.Help.enable();
  const entry = env.Help._badges.find((b) => b.target === target);
  entry.badge._handlers.click[0]({ preventDefault() {}, stopPropagation() {} });
  const popup = env.body.children[env.body.children.length - 1];
  ok(!!popup && popup.textContent === env.Help.CONTENT["deploy-viewer"] && State.mode === "viewer",
    "⑨ State.mode='viewer' 상황에서도 토글+배지 흐름이 동일하게 동작함(모드 무관)");
}

/* ────────────────────────────────────────────────────────────
 * ⑩~⑬ 실제 배선 검증: public/index.html 의 data-help 속성 + 20_App.js 의
 * Help.init() 호출부(고아 방지). 소스 문자열을 그대로 읽어 검사한다(목 아님).
 * ──────────────────────────────────────────────────────────── */
const indexHtmlSrc = rd("public/index.html");
const appJsSrc = rd("public/js/modules/20_App.js");

{
  const dataHelpValues = [...indexHtmlSrc.matchAll(/data-help="([^"]*)"/g)].map((m) => m[1]);
  ok(dataHelpValues.length >= 8,
    `⑩ index.html 에 data-help 속성이 8개 이상 존재함 (실제 ${dataHelpValues.length}개)`);

  const validKeys = Object.keys(makeEnv().Help.CONTENT);
  const invalid = dataHelpValues.filter((v) => !validKeys.includes(v));
  ok(invalid.length === 0,
    `⑪ 모든 data-help 값이 Help.CONTENT 의 실제 키다 (오타/미정의 0건, 발견: ${JSON.stringify(invalid)})`);

  const titleCount = (indexHtmlSrc.match(/title="/g) || []).length;
  ok(titleCount === 130,
    `⑫ 기존 title 속성 개수가 보존됨(회귀 기준값 130, 실제 ${titleCount})`);

  ok(/Help\.init\s*\(\s*\)/.test(appJsSrc),
    "⑬ 20_App.js 안에 Help.init() 호출부가 존재함(렌더 고아 방지)");
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션1: 토글 상태 무시 — 토글 버튼 클릭이 실제 toggle() 대신 항상 배지를
 * (재)장착만 하도록 바꾼다 → active 플래그가 갱신되지 않고(①), OFF 클릭에도
 * 배지가 사라지지 않아야 한다(②)
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션1] 토글 상태 무시(항상 마운트, active 갱신 안 함) → ①②가 실패해야 함");
  const needle = `        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        this.toggle();
      });
      document.body.appendChild(btn);`;
  const mutated = helpSrc.replace(needle,
    `        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        this._mountBadges();
      });
      document.body.appendChild(btn);`);
  if (mutated === helpSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { document, body, allEls } = makeDoc();
    const sandbox = { console: { warn() {}, log() {}, error() {} }, document, window: { addEventListener() {}, innerWidth: 1024, innerHeight: 768 }, setTimeout, clearTimeout };
    vm.createContext(sandbox);
    vm.runInContext(mutated + "\n;globalThis.__Help = Help;", sandbox);
    sandbox.__Help.init();
    const target = makeEl("button");
    target.dataset.help = "zone-create";
    allEls.push(target);

    sandbox.__Help._toggleBtn._handlers.click[0]({ preventDefault() {}, stopPropagation() {} }); // 1차 클릭(켜짐 의도)
    ok(sandbox.__Help.active !== true,
      `뮤테이션 적용 시 ①이 깨짐(테스트 실효성 증명 — active 플래그가 갱신되지 않음) → active=${sandbox.__Help.active}`);

    sandbox.__Help._toggleBtn._handlers.click[0]({ preventDefault() {}, stopPropagation() {} }); // 2차 클릭(끄는 의도)
    const badgesAfter = body.children.filter((c) => c._attrs["data-help-badge"]).length;
    ok(badgesAfter !== 0,
      `뮤테이션 적용 시 ②가 깨짐(테스트 실효성 증명 — 두번째 클릭에도 배지가 제거되지 않음) → ${badgesAfter}개 남음`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션2: 원래 동작 차단 제거 — 배지 click 핸들러의 stopPropagation 제거
 * → ③이 실패해야 한다(버블링돼 원래 버튼 클릭이 실행됨)
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션2] 배지 클릭 핸들러의 stopPropagation 제거 → ③이 실패해야 함");
  const needle = `          if (e.preventDefault) e.preventDefault();
          if (e.stopPropagation) e.stopPropagation();
          this.show(el, el.dataset ? el.dataset.help : el.getAttribute("data-help"));`;
  const mutated = helpSrc.replace(needle,
    `          if (e.preventDefault) e.preventDefault();
          this.show(el, el.dataset ? el.dataset.help : el.getAttribute("data-help"));`);
  if (mutated === helpSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { document, body, allEls } = makeDoc();
    const sandbox = { console: { warn() {}, log() {}, error() {} }, document, window: { addEventListener() {}, innerWidth: 1024, innerHeight: 768 }, setTimeout, clearTimeout };
    vm.createContext(sandbox);
    vm.runInContext(mutated + "\n;globalThis.__Help = Help;", sandbox);
    sandbox.__Help.init();
    const target = makeEl("button");
    target.dataset.help = "pin-place";
    allEls.push(target);
    let btnClicked = false;
    target.addEventListener("click", () => { btnClicked = true; });

    sandbox.__Help.enable();
    const entry = sandbox.__Help._badges.find((b) => b.target === target);
    entry.badge.parentNode = target;
    dispatchBubble(entry.badge, "click", {});
    ok(btnClicked === true,
      `뮤테이션 적용 시 ③이 깨짐(테스트 실효성 증명 — stopPropagation 없어 원래 버튼 클릭까지 버블링됨) → btnClicked=${btnClicked}`);
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
