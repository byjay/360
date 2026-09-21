/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p51-single-pin-editor.test.mjs)
 *
 * 마스터 신고: "등록 종류 자체도 중복이고, 사진 추가를 하면 또 다른 등록창이 나오는 게
 * 치명적인 결함이다" — PinActionPop(A, #pin-action-pop)에서 "수정 / 사진 추가"를 누르면
 * #section-pin-form(B, 핀 신규배치용 플로팅 폼)이 겹쳐 뜨고, 등록 종류(사진/360/문서/노트/
 * 동영상/URL) 선택이 B에만 있어 A와 기능이 중복됐다.
 *
 * 지휘자 결정: A를 단일 창으로 한다.
 *  1) pap-edit 버튼은 더 이상 App.editPin()을 호출하지 않는다(= B를 열지 않는다).
 *  2) B의 등록 종류 선택(6종)을 A 안에 흡수한다(사진/URL은 기존 pap-photo-* 위젯 재사용 —
 *     중복 위젯 생성 금지, 문서만 신규 pap-doc-* 위젯, 노트/360/동영상은 기존 위젯으로 라우팅).
 *  3) 모바일(≤720px)에서는 '사진'만 노출(마스터 기존 지시, CSS 미의존 — window.matchMedia로 판정).
 *  4) B(#section-pin-form) 자체는 제거하지 않는다 — 11_UI.js(pin-list "수정" 버튼)·
 *     17_Inspector.js("수정" 버튼)가 여전히 App.editPin()을 호출해 B를 연다(전수 grep 확인,
 *     렌더 고아 아님). 잘라낸 것은 "PinActionPop → B" 경로 하나뿐이다.
 *
 * 실제 모듈 소스(27_PinActionPop.js/index.html)를 그대로 평가/파싱한다(목 구현 아님).
 * 뮤테이션 4건: ⓐ pap-edit 에 App.editPin 호출 복원 → ①실패 / ⓑ 등록종류 선택 중복 배치 →
 * ④실패 / ⓒ 모바일 필터 제거 → ⑤실패 / ⓓ 사진 등록 경로 제거 → ②실패.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ══════════════════════ fake DOM (jsdom 없음 — p27 패턴 확장) ══════════════════════
 * .pap-reg-btn 만 innerHTML 문자열에서 data-reg 속성을 파싱해 합성 엘리먼트로 캐시한다
 * (실제 DOM 처럼, innerHTML 을 다시 설정하기 전까지는 querySelectorAll 이 같은 객체를 돌려준다). */
function makeElement(id) {
  const el = {
    id, value: "", textContent: "", src: "", readOnly: false,
    style: {}, files: null, _attrs: {}, _innerHTML: "", _btnCache: [],
    _classes: new Set(),
    _listeners: {},
    classList: {
      add: (c) => el._classes.add(c),
      remove: (c) => el._classes.delete(c),
      toggle: (c, force) => {
        if (force === true) { el._classes.add(c); return true; }
        if (force === false) { el._classes.delete(c); return false; }
        if (el._classes.has(c)) { el._classes.delete(c); return false; }
        el._classes.add(c); return true;
      },
      contains: (c) => el._classes.has(c),
    },
    setAttribute(k, v) { el._attrs[k] = v; },
    getAttribute(k) { return el._attrs[k]; },
    focus() {}, select() {}, scrollTop: 0,
    addEventListener(type, fn) { (el._listeners[type] = el._listeners[type] || []).push(fn); },
    dispatch(type, evt) { (el._listeners[type] || []).forEach((fn) => fn(evt || {})); },
    querySelector() { return makeElement("__stub__"); },
    querySelectorAll(sel) { return sel === ".pap-reg-btn" ? el._btnCache : []; },
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return el._innerHTML; },
    set(html) {
      el._innerHTML = html;
      const btns = [];
      const re = /<button[^>]*data-reg="([a-z]+)"[^>]*>([^<]*)<\/button>/g;
      let m;
      while ((m = re.exec(html))) {
        const be = makeElement("__btn_" + m[1] + "__");
        be.dataset = { reg: m[1] };
        be.textContent = m[2];
        btns.push(be);
      }
      el._btnCache = btns;
    },
  });
  return el;
}

function makeSandbox() {
  const registry = new Map();
  const getElementById = (id) => {
    if (!registry.has(id)) registry.set(id, makeElement(id));
    return registry.get(id);
  };
  const document = {
    getElementById,
    addEventListener() {},
    querySelector: () => null,
    createElement: () => makeElement("__anon__"),
  };
  const State = { pins: [], mode: "designer", currentDeploymentId: "dep1", pinEditUnlocked: null };
  const notesFetchImpl = () => Promise.resolve({ ok: true, json: async () => ({ data: [] }) });
  const App = {
    pinHasContent(p) { return !!(p && (p.imageId || p.imageUrl || p.videoUrl || p.note)); },
    pinHasMedia(p) { return !!(p && (p.imageId || p.imageUrl || p.videoUrl || p.pendingOpId || p.localPreview)); },
    openPano(pin) { App._openPanoCalled = pin; },
    editPin(id) { App._editPinCalled = id; }, // ── ① 검증 대상: 호출되면 안 된다 ──
    deletePin() {}, focusPin() {},
    setActivePin() {},
    _dirty: false,
    _markDirty() { App._dirty = true; },
    _autoSave() { throw new Error("자동저장 OFF 정책 위반: App._autoSave() 가 호출됨"); },
  };
  const Auth = { isDesigner: true, user: { name: "tester" }, headers: () => ({}) };
  const Prompt = { toast() {}, ask: async () => null };
  const Cloud = {
    _cache: {}, MAX_DOC_BYTES: 3 * 1024 * 1024,
    async resizeImage() { return { dataURL: "data:image/jpeg;base64,AAAA", width: 10, height: 10 }; },
    async uploadImage() { return "img-uploaded-1"; },
    async fetchImage(id) { return Cloud._cache[id] || "data:fetched:" + id; },
    async fileToDataURL() { return "data:application/pdf;base64,AAAA"; },
    async uploadDoc() { return "doc-uploaded-1"; },
  };
  const UI = {
    renderPinsOnMap() {}, renderPinList() {},
    escapeHtml: (s) => String(s == null ? "" : s),
    $: (id) => getElementById(id),
  };
  const Inspector = { showPin() {} };
  let mobileMatch = false;
  const sandbox = {
    console, Math, JSON, Promise, setTimeout, clearTimeout, URL, Date, Array, String, Object,
    document, State, App, Auth, Prompt, Cloud, UI, Inspector,
    fetch: notesFetchImpl,
    navigator: { onLine: true },
    matchMedia: (q) => ({ matches: mobileMatch, media: q }),
    addEventListener() {},
    setMobile(v) { mobileMatch = v; },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return { sandbox, getElementById, App, State, Auth };
}

function load(paSrc, notesSrc) {
  const { sandbox, getElementById, App, State, Auth } = makeSandbox();
  vm.runInContext(notesSrc + "\n;globalThis.__NOTES = Notes;", sandbox);
  sandbox.Notes = sandbox.__NOTES;
  vm.runInContext(paSrc + "\n;globalThis.__PAP = PinActionPop;", sandbox);
  const PinActionPop = sandbox.__PAP;
  PinActionPop.init();
  return { PinActionPop, getElementById, App, State, Auth, sandbox };
}

function makePin(overrides) {
  return Object.assign({ id: "p1", page: 1, x: 10, y: 10, label: "" }, overrides);
}

const paSrc = rd("public/js/modules/27_PinActionPop.js");
const notesSrc = rd("public/js/modules/13_Notes.js");
const indexHtml = rd("public/index.html");
const uiSrc = rd("public/js/modules/11_UI.js");
const inspectorSrc = rd("public/js/modules/17_Inspector.js");

/* ══════════════════════ ① pap-edit 클릭 → B 안 열림 ══════════════════════ */
console.log("\n[①] '수정/사진 추가' 클릭 → #section-pin-form 안 열림(App.editPin 미호출)");
function check1(src) {
  const { PinActionPop, getElementById, App, State } = load(src, notesSrc);
  const pin = makePin({});
  State.pins = [pin];
  getElementById("section-pin-form").classList.add("hidden"); // 실제 index.html 초기 상태(hidden) 재현
  PinActionPop.open(pin.id);
  getElementById("pap-edit").dispatch("click");
  return { editCalled: App._editPinCalled, sectionHidden: getElementById("section-pin-form").classList.contains("hidden"), popHidden: getElementById("pin-action-pop").classList.contains("hidden") };
}
{
  const r = check1(paSrc);
  ok(!r.editCalled, "App.editPin() 이 호출되지 않았다");
  ok(r.sectionHidden, "#section-pin-form 은 hidden 상태 그대로");
  ok(!r.popHidden, "PinActionPop(A) 자체는 열려 있다(닫히지 않음 — 같은 창 안에서 계속 편집)");
}

/* ══════════════════════ ② A 안에서 사진 등록(파일·경로) ══════════════════════ */
console.log("\n[②] A 안에서 사진 등록 — 파일 선택 / 경로 등록");
await (async () => {
  const { PinActionPop, getElementById, App, State } = load(paSrc, notesSrc);
  const pin = makePin({});
  State.pins = [pin];
  PinActionPop.open(pin.id);
  await PinActionPop._registerPhotoFile({ name: "a.jpg" });
  ok(pin.imageId === "img-uploaded-1", "파일 선택 → Cloud.uploadImage 경로로 imageId 반영");
})();
await (async () => {
  const { PinActionPop, getElementById, State } = load(paSrc, notesSrc);
  const pin = makePin({});
  State.pins = [pin];
  PinActionPop.open(pin.id);
  getElementById("pap-photo-url").value = "https://x.test/pic.jpg";
  PinActionPop._registerPhotoUrl();
  ok(pin.imageUrl === "https://x.test/pic.jpg", "경로 입력 → pin.imageUrl 반영");
})();

/* ══════════════════════ ③ A 안에서 노트·번호 저장 ══════════════════════ */
console.log("\n[③] A 안에서 위치명/번호 저장 + 노트 등록");
{
  const { PinActionPop, getElementById, App, State } = load(paSrc, notesSrc);
  const pin = makePin({ label: "3" });
  State.pins = [pin];
  PinActionPop.open(pin.id);
  getElementById("pap-label-input").value = "7";
  PinActionPop._saveLabel();
  ok(pin.label === "7", "위치명/번호 저장됨");
  ok(App._dirty === true, "미저장 표시(markDirty)만 남음");
}

/* ══════════════════════ ④ 등록 종류 선택 — A 안 한 곳만(중복 0) ══════════════════════ */
console.log("\n[④] 등록 종류 선택 — A 안에 한 곳만 존재");
function countRegToolsInA(html) {
  return (html.match(/id="pap-reg-tools"/g) || []).length;
}
{
  const n = countRegToolsInA(indexHtml);
  ok(n === 1, "index.html 전체에서 #pap-reg-tools 가 정확히 1개 (n=" + n + ")");
  const popStart = indexHtml.indexOf('id="pin-action-pop"');
  const popBlock = indexHtml.slice(popStart, popStart + 4000);
  ok(popBlock.includes('id="pap-reg-tools"'), "그 1개가 PinActionPop(A) 블록 안에 있다");
  const sectionStart = indexHtml.indexOf('id="section-pin-form"');
  const sectionBlock = indexHtml.slice(sectionStart, sectionStart + 4000);
  ok(!sectionBlock.includes('id="pap-reg-tools"'), "B(#section-pin-form) 안에는 pap-reg-tools 가 없다(중복 배치 아님)");
}

/* ══════════════════════ ⑤⑥ 모바일 사진만 / 데스크톱 6종 ══════════════════════ */
console.log("\n[⑤⑥] 모바일(≤720px) 사진 1개만 / 데스크톱 6종");
function regState(src, mobile) {
  const { PinActionPop, getElementById, State, sandbox } = load(src, notesSrc);
  sandbox.setMobile(mobile);
  const pin = makePin({});
  State.pins = [pin];
  PinActionPop.open(pin.id);
  const btns = getElementById("pap-reg-tools").querySelectorAll(".pap-reg-btn");
  return btns.map((b) => ({ reg: b.dataset.reg, hidden: b.classList.contains("hidden") }));
}
{
  const mobileBtns = regState(paSrc, true);
  ok(mobileBtns.length === 6, "등록 종류 버튼 총 6개 렌더됨(정의는 6종)");
  const visibleMobile = mobileBtns.filter((b) => !b.hidden);
  ok(visibleMobile.length === 1 && visibleMobile[0].reg === "photo", "모바일에서 노출된 건 '사진' 1개뿐 (visible=" + JSON.stringify(visibleMobile) + ")");

  const desktopBtns = regState(paSrc, false);
  const visibleDesktop = desktopBtns.filter((b) => !b.hidden);
  ok(visibleDesktop.length === 6, "데스크톱에서는 6종 전부 노출 (n=" + visibleDesktop.length + ")");
}

/* ══════════════════════ ⑦ B 처리 — 제거 아님, 다른 진입 경로가 실재(고아 아님) ══════════════════════ */
console.log("\n[⑦] B(#section-pin-form) 처리 — 유지 + 호출부 실재 확인");
{
  ok(/id="section-pin-form"/.test(indexHtml), "B 마크업이 index.html 에 존재(제거하지 않음)");
  const uiCalls = (uiSrc.match(/App\.editPin\(/g) || []).length;
  const inspCalls = (inspectorSrc.match(/App\.editPin\(/g) || []).length;
  ok(uiCalls >= 1, "11_UI.js(pin-list '수정' 버튼)가 여전히 App.editPin() 을 호출 — B 는 렌더 고아 아님 (n=" + uiCalls + ")");
  ok(inspCalls >= 1, "17_Inspector.js('수정' 버튼)도 App.editPin() 을 호출 — 또 다른 실재 호출부 (n=" + inspCalls + ")");
  ok(!/App\.editPin\(/.test(paSrc), "27_PinActionPop.js 자신은 더 이상 App.editPin() 을 호출하지 않는다(PinActionPop→B 경로만 차단)");
}

/* ══════════════════════ ⑧ 기존 겹침 회귀 유지(p34/p41/p42/p46) ══════════════════════ */
console.log("\n[⑧] 375×812 겹침 회귀 — p34/p41/p42/p46 그대로 통과");
{
  ["p34-mobile-pano-layout.test.mjs", "p41-mobile-save-reachable.test.mjs", "p42-mobile-reachability.test.mjs", "p46-upload-button.test.mjs"]
    .forEach((f) => {
      let rc = 0;
      try { execFileSync(process.execPath, [path.join(ROOT, "tests", f)], { stdio: "pipe" }); } catch (e) { rc = e.status || 1; }
      ok(rc === 0, f + " EXIT=0 유지(겹침 회귀 없음)");
    });
}

/* ══════════════════════ 뮤테이션 4건 ══════════════════════ */
console.log("\n[뮤테이션] 4건 — 각 되돌리면 실패해야 한다");
{
  // ⓐ B 호출 복원 → ① 실패
  const mutA = paSrc.replace(
    /const input = \$\("pap-label-input"\);\s*\n\s*if \(input && !input\.readOnly\) \{ input\.focus\(\); input\.select\(\); \}\s*\n\s*Prompt\.toast && Prompt\.toast\("아래에서 위치명·사진·노트를 바로 수정하세요"\);/,
    'State.pinEditUnlocked = pin.id; this.close(); App.editPin(pin.id);'
  );
  ok(mutA !== paSrc, "ⓐ mutation 적용됨(문자열이 실제로 바뀜)");
  const r = check1(mutA);
  ok(!!r.editCalled, "ⓐ B 호출 복원 → App.editPin() 이 다시 호출됨(①이 실패해야 정상)");

  // ⓑ 등록종류 선택 중복 배치 → ④ 실패 (pap-reg-tools 자체를 통째로 복제해 재현)
  const popStart = indexHtml.indexOf('id="pin-action-pop"');
  const popEndTag = indexHtml.indexOf('id="pap-reg-tools"', popStart);
  const regBlockMatch = indexHtml.slice(popEndTag - 40, popEndTag + 400);
  const dupHtml2 = indexHtml.slice(0, popEndTag) + regBlockMatch + indexHtml.slice(popEndTag);
  const nDup = countRegToolsInA(dupHtml2);
  ok(nDup === 2, "ⓑ mutation 적용됨(pap-reg-tools 가 2개로 늘어남, n=" + nDup + ")");
  ok(!(nDup === 1), "ⓑ 등록종류 중복 배치 → ④(n===1) 가 실패해야 정상");

  // ⓒ 모바일 필터 제거 → ⑤ 실패
  const mutC = paSrc.replace(
    /const mobile = !!\(window\.matchMedia && window\.matchMedia\(PAP_MOBILE_MQ\)\.matches\);/,
    "const mobile = false; /* [뮤테이션] 모바일 필터 무력화 */"
  );
  ok(mutC !== paSrc, "ⓒ mutation 적용됨(문자열이 실제로 바뀜)");
  const mobileBtnsMut = regState(mutC, true);
  const visibleMobileMut = mobileBtnsMut.filter((b) => !b.hidden);
  ok(!(visibleMobileMut.length === 1 && visibleMobileMut[0].reg === "photo"),
    "ⓒ 모바일 필터 제거 → ⑤(사진만 노출)이 실패해야 정상 (실제 visible=" + JSON.stringify(visibleMobileMut) + ")");

  // ⓓ 사진 등록 경로 제거 → ② 실패
  const mutD = paSrc.replace(
    /async _registerPhotoFile\(file\) \{[\s\S]*?\n    \},\n\n    \/\*\* ── 사진 등록: 경로/,
    'async _registerPhotoFile(file) { return; /* [뮤테이션] 사진 등록 경로 제거 */ },\n\n    /** ── 사진 등록: 경로'
  );
  ok(mutD !== paSrc, "ⓓ mutation 적용됨(문자열이 실제로 바뀜)");
  await (async () => {
    const { PinActionPop, State } = load(mutD, notesSrc);
    const pin = makePin({});
    State.pins = [pin];
    PinActionPop.open(pin.id);
    await PinActionPop._registerPhotoFile({ name: "a.jpg" });
    ok(!pin.imageId, "ⓓ 사진 등록 경로 제거 → ②(imageId 반영)가 실패해야 정상");
  })();
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
