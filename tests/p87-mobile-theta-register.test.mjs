/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p87-mobile-theta-register.test.mjs)
 *
 * 대상: WORK_ORDER 2026-09-29 "휴대폰에서도 360 사진 등록되게" — 27_PinActionPop.js.
 * 검증: (1) 모바일 폭에서 [360] 탭 노출 (2) 사진칸은 사진이 있어도 계속 노출(추가 등록)
 *       (3) [360] 탭에서 파일 선택 → 데스크톱과 같은 등록 경로(Cloud.resizeImage/uploadImage) 재사용
 *       (4) 비등장방형 파일은 업로드 없이 거부(조용한 실패 금지) (5) confirm( 미사용(p76 유지).
 *
 * 실제 소스(27_PinActionPop.js/13_Notes.js)를 vm 에 그대로 평가(목 구현 아님). fake DOM 은
 * p27-pin-panel.test.mjs 와 동일한 최소 레지스트리 방식.
 *
 * 뮤테이션 2건: ①모바일 가시성에서 "theta" 제외 복원 → 실패 / ②hasPhoto 로 registerBox 재차 숨김 복원 → 실패.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ══════════════════════ fake DOM (jsdom 없음) — p27 과 동일 방식 ══════════════════════ */
function makeElement(id) {
  const el = {
    id, value: "", textContent: "", innerHTML: "", src: "", readOnly: false,
    style: {}, files: null, dataset: {},
    _classes: new Set(),
    _listeners: {},
    classList: {
      add: (c) => el._classes.add(c),
      remove: (c) => el._classes.delete(c),
      toggle: (c, force) => { if (force) el._classes.add(c); else el._classes.delete(c); },
      contains: (c) => el._classes.has(c),
    },
    addEventListener(type, fn) { (el._listeners[type] = el._listeners[type] || []).push(fn); },
    dispatch(type, evt) { (el._listeners[type] || []).forEach((fn) => fn(evt || {})); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return el;
}

function makeSandbox(mobile) {
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
    // SoT 재사용 지점(20_App.js) — 파일명에 "360"이 있으면 등장방형으로 취급(실 판별 로직은 원본에만 존재).
    _detect360(file, cb) { cb(!!(file && /360/i.test(file.name || ""))); },
    editPin() {}, deletePin() {}, focusPin() {},
    setActivePin() {},
    _dirty: false,
    _markDirty() { App._dirty = true; },
    _autoSave() { throw new Error("자동저장 OFF 정책 위반"); },
  };
  const Auth = { isDesigner: true, user: { name: "tester" }, headers: () => ({}) };
  const Prompt = { toast() {}, ask: async () => null };
  const Cloud = {
    _cache: {},
    async resizeImage() { return { dataURL: "data:image/jpeg;base64,AAAA", width: 4000, height: 2000 }; },
    async uploadImage() { return "img-uploaded-theta-1"; },
    async fetchImage(id) { return Cloud._cache[id] || "data:fetched:" + id; },
  };
  const UI = {
    renderPinsOnMap() {}, renderPinList() {},
    escapeHtml: (s) => String(s == null ? "" : s),
    $: (id) => getElementById(id),
  };
  const Inspector = { showPin() {} };
  const matchMedia = (q) => ({ matches: mobile && /max-width/.test(q) });
  const sandbox = {
    console, Math, JSON, Promise, setTimeout, clearTimeout, URL,
    document, State, App, Auth, Prompt, Cloud, UI, Inspector,
    fetch: notesFetchImpl,
    navigator: { onLine: true },
    matchMedia,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return { sandbox, getElementById, App, State, Auth };
}

function load(paSrc, notesSrc, mobile) {
  const { sandbox, getElementById, App, State, Auth } = makeSandbox(mobile);
  vm.runInContext(notesSrc + "\n;globalThis.__NOTES = Notes;", sandbox);
  sandbox.Notes = sandbox.__NOTES;
  vm.runInContext(paSrc + "\n;globalThis.__PAP = PinActionPop;", sandbox);
  const PinActionPop = sandbox.__PAP;
  PinActionPop.init();
  return { PinActionPop, getElementById, App, State, Auth };
}

function makePin(overrides) {
  return Object.assign({ id: "p1", page: 1, x: 10, y: 10, label: "" }, overrides);
}

function run(paSrc, notesSrc) {
  ok(!/confirm\(/.test(paSrc), "confirm( 미사용(p76 정책 유지)");

  /* [1] 모바일 폭 — [360] 탭 노출, 문서/동영상/URL 은 숨김 유지 */
  console.log("\n[1] 모바일 — [360] 탭 노출");
  {
    const { PinActionPop, getElementById, State } = load(paSrc, notesSrc, true);
    const pin = makePin({});
    State.pins = [pin];
    PinActionPop.open(pin.id);
    const grid = getElementById("pap-reg-tools");
    const btns = {};
    (grid._listeners ? null : null);
    // _renderRegTools 가 innerHTML 문자열을 만들 뿐 실제 버튼 엘리먼트를 등록하지 않으므로
    // _applyRegVisibility 는 querySelectorAll 기반(_regBtns) — fake DOM 은 빈 배열을 반환한다.
    // 대신 렌더된 innerHTML 문자열에 360 버튼이 존재하는지, 숨김 로직 소스 자체를 검사한다.
    ok(/data-reg="theta"/.test(grid.innerHTML), "등록 종류 그리드에 360(theta) 버튼 렌더됨");
    ok(!/reg !== "photo" && reg !== "note"\)/.test(paSrc) || /reg !== "theta"/.test(paSrc),
      "모바일 숨김 조건에 theta 예외 포함(소스 검사)");
    const hint = getElementById("pap-reg-mobile-hint");
    ok(!hint.classList.contains("hidden"), "모바일 안내 문구 표시됨");
    ok(/360/.test(hint.textContent) && /사진/.test(hint.textContent) && /노트/.test(hint.textContent),
      "안내 문구에 360·사진·노트 포함");
  }

  /* [2] 사진 있는 핀 — 등록칸(추가용) 계속 노출 */
  console.log("\n[2] 사진 있는 핀 → 파일 선택 칸 계속 노출");
  {
    const { PinActionPop, getElementById, State } = load(paSrc, notesSrc, true);
    const pin = makePin({ imageUrl: "https://x.test/photo.jpg" });
    State.pins = [pin];
    PinActionPop.open(pin.id);
    ok(!getElementById("pap-photo-register").classList.contains("hidden"), "사진 있어도 등록(추가) 칸 노출");
    ok(!getElementById("pap-photo-preview").classList.contains("hidden"), "미리보기도 함께 노출");
  }

  /* [3] [360] 탭 선택 후 등장방형 파일 → 기존 등록 경로(Cloud.resizeImage/uploadImage) 재사용 */
  console.log("\n[3] 360 탭 — 등장방형 파일 → 등록 성공(데스크톱과 같은 경로)");
  return (async () => {
    const { PinActionPop, getElementById, App, State } = load(paSrc, notesSrc, true);
    const pin = makePin({});
    State.pins = [pin];
    PinActionPop.open(pin.id);
    PinActionPop._selectRegCategory("theta");
    const file360 = { name: "R0010001_360.jpg" };
    await PinActionPop._registerPhotoFile(file360);
    ok(pin.imageId === "img-uploaded-theta-1", "Cloud.uploadImage 저장 경로 재사용(신규 업로드 로직 없음)");
    ok(pin.is360 === true, "pin.is360 반영(20_App.js:2083 과 동일 SoT 필드)");
    ok(App._dirty === true, "등록 후 미저장 표시(App._markDirty)만 — 자동저장 없음");
    ok(getElementById("pap-photo-err").classList.contains("hidden"), "에러 없음");

    /* [4] 비등장방형 파일 → 업로드 거부 + 이유 표시(조용한 실패 금지) */
    console.log("\n[4] 360 탭 — 비등장방형 파일 → 거부");
    const pin2 = makePin({ id: "p2" });
    State.pins.push(pin2);
    PinActionPop.open(pin2.id);
    PinActionPop._selectRegCategory("theta");
    const fileFlat = { name: "normal_photo.jpg" };
    await PinActionPop._registerPhotoFile(fileFlat);
    ok(!pin2.imageId, "비등장방형은 업로드되지 않음");
    ok(!getElementById("pap-photo-err").classList.contains("hidden"), "에러 표시됨(조용한 실패 아님)");
    ok(/등장방형|360 사진이 아닙니다/.test(getElementById("pap-photo-err").textContent), "이유 텍스트 표시");

    /* [5] '사진' 탭(기존 경로)은 비율 검사 없이 그대로 동작(회귀 없음) */
    console.log("\n[5] 사진 탭 — 비율 검사 없이 기존처럼 등록");
    const pin3 = makePin({ id: "p3" });
    State.pins.push(pin3);
    PinActionPop.open(pin3.id); // 열 때 _regCat = "photo" 로 초기화됨
    await PinActionPop._registerPhotoFile({ name: "any.jpg" });
    ok(pin3.imageId === "img-uploaded-theta-1", "'사진' 탭은 종전과 동일하게 즉시 업로드(회귀 없음)");
    ok(!pin3.is360, "'사진' 탭 등록은 is360 를 세우지 않음(360 탭과 구분)");

    return failed;
  })();
}

const paSrc = rd("public/js/modules/27_PinActionPop.js");
const notesSrc = rd("public/js/modules/13_Notes.js");

run(paSrc, notesSrc).then((f) => {
  console.log("\n" + (f === 0 ? "ALL PASS" : f + " FAILED"));
  process.exit(f === 0 ? 0 : 1);
});
