/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p91-pin-panel-fixes.test.mjs)
 *
 * 대상: 지휘자 발주 2026-09-29 — 라이브 배포 8cd85d44 실측 결함 6건.
 * 파일: 27_PinActionPop.js(항목1·2·4), 35_PhotoBatch.js(항목3), 06_PanoViewer.js(항목6),
 *       public/css/style.css(항목5, 다른 두 CSS 파일엔 충돌 규칙 없음도 함께 확인).
 *
 * 실제 모듈 소스를 vm 에 그대로 평가해 검사한다(목 구현 아님). DOM 은 jsdom 없이 최소
 * fake element 레지스트리로 대체(classList/value/style/addEventListener만 필요).
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

/* ══════════════════════ fake DOM (jsdom 없음) ══════════════════════ */
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
    querySelector() { return makeElement("__stub__"); },
    querySelectorAll() { return []; },
    appendChild() {},
    setAttribute() {},
    getAttribute() { return null; },
    focus() {},
    click() {},
  };
  return el;
}

function makeSandbox(opts) {
  const o = opts || {};
  const registry = new Map();
  const getElementById = (id) => {
    if (!registry.has(id)) registry.set(id, makeElement(id));
    return registry.get(id);
  };
  const bodyEl = makeElement("body");
  const document = {
    getElementById,
    body: bodyEl,
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeElement("__anon_" + tag + "__"),
  };
  const State = { pins: [], mode: "designer", currentDeploymentId: "dep1", pinEditUnlocked: null, pdfPage: 1 };
  const notesFetchImpl = () => Promise.resolve({ ok: true, json: async () => ({ data: [] }) });
  const toastLog = [];
  const App = {
    pinHasContent(p) { return !!(p && (p.imageId || p.imageUrl || p.videoUrl || p.note)); },
    pinHasMedia(p) { return !!(p && (p.imageId || p.imageUrl || p.videoUrl || p.pendingOpId || p.localPreview)); },
    openPano(pin) { App._openPanoCalled = pin; },
    _detect360(file, cb) { cb(!!(file && /360/i.test(file.name || ""))); },
    editPin() {}, deletePin() {}, focusPin() {},
    _dirty: false,
    _markDirty() { App._dirty = true; },
    _autoSave() { throw new Error("자동저장 OFF 정책 위반"); },
  };
  const Auth = { isDesigner: true, user: { name: "tester" }, headers: () => ({}) };
  const Prompt = { toast(msg) { toastLog.push(msg); }, ask: async () => null, confirm: async () => true };
  const Cloud = {
    _cache: {},
    async resizeImage() { return { dataURL: "data:image/jpeg;base64,AAAA", width: 10, height: 10 }; },
    async uploadImage() { return "img-uploaded-1"; },
    async fetchImage(id) { return Cloud._cache[id] || "data:fetched:" + id; },
  };
  const UI = {
    renderPinsOnMap() {}, renderPinList() {},
    escapeHtml: (s) => String(s == null ? "" : s),
    $: (id) => getElementById(id),
  };
  const Inspector = { showPin() {} };
  const PinSeries = {
    numbers(pins, page) {
      const map = new Map();
      (pins || []).forEach((p, i) => {
        if ((p.page || 1) !== page) return;
        const series = p.checkboard ? "checkboard" : "content";
        map.set(p.id, { no: i + 1, kind: "content", series });
      });
      return map;
    },
    formatNo(no, series) { return series === "checkboard" ? String(no) : ("P" + no); },
    duplicateCheckboardIds() { return new Set(); },
    userMark() { return null; },
    hasContent(p) { return !!(p && (p.imageId || p.imageUrl)); },
  };
  let mobile = !!o.mobile;
  const matchMedia = (q) => ({ matches: mobile });
  const sandbox = {
    console, Math, JSON, Promise, setTimeout, clearTimeout, URL, Date, Number, Array, Object,
    document, State, App, Auth, Prompt, Cloud, UI, Inspector, PinSeries,
    fetch: notesFetchImpl,
    navigator: { onLine: true },
    __setMobile: (v) => { mobile = v; },
    __toastLog: toastLog,
  };
  sandbox.window = sandbox;
  sandbox.window.matchMedia = matchMedia;
  sandbox.window.addEventListener = () => {};
  sandbox.window.innerWidth = 375; sandbox.window.innerHeight = 812;
  vm.createContext(sandbox);
  return { sandbox, getElementById, App, State, Auth, toastLog };
}

function makePin(overrides) {
  return Object.assign({ id: "p1", page: 1, x: 10, y: 10, label: "" }, overrides);
}

/* ══════════════════════ [항목1·2·4] 27_PinActionPop.js ══════════════════════ */
function runPinActionPopTests(paSrc, notesSrc, helpSrc) {
  console.log("\n[항목1] 360 탭 선택 — 토스트 대신 인라인 안내(등록 UI를 가리지 않음)");
  {
    const { sandbox, getElementById } = makeSandbox({ mobile: true });
    vm.runInContext(notesSrc + "\n;globalThis.__NOTES = Notes;", sandbox);
    sandbox.Notes = sandbox.__NOTES;
    vm.runInContext(paSrc + "\n;globalThis.__PAP = PinActionPop;", sandbox);
    const PinActionPop = sandbox.__PAP;
    PinActionPop.init();
    const pin = makePin({});
    sandbox.State.pins = [pin];
    PinActionPop.open(pin.id);
    sandbox.__toastLog.length = 0; // open() 자체에서 토스트가 안 났는지는 별도 관심사 아님 — 리셋
    PinActionPop._selectRegCategory("theta");
    const thetaToast = sandbox.__toastLog.some((m) => /THETA/.test(m || ""));
    ok(!thetaToast, "'360' 탭 선택 시 Prompt.toast 호출 없음(패널을 덮지 않음)");
    const hint = getElementById("pap-reg-mobile-hint");
    ok(/THETA/.test(hint.textContent), "인라인 안내 요소(pap-reg-mobile-hint)에 THETA 안내 문구 표시");
    ok(!hint.classList.contains("hidden"), "인라인 안내 요소가 보임(hidden 아님)");
  }

  console.log("\n[항목1-b] 동영상 탭도 토스트 대신 인라인 안내");
  {
    const { sandbox, getElementById } = makeSandbox({});
    vm.runInContext(notesSrc + "\n;globalThis.__NOTES = Notes;", sandbox);
    sandbox.Notes = sandbox.__NOTES;
    vm.runInContext(paSrc + "\n;globalThis.__PAP = PinActionPop;", sandbox);
    const PinActionPop = sandbox.__PAP;
    PinActionPop.init();
    const pin = makePin({});
    sandbox.State.pins = [pin];
    PinActionPop.open(pin.id);
    sandbox.__toastLog.length = 0;
    PinActionPop._selectRegCategory("video");
    ok(!sandbox.__toastLog.some((m) => /동영상은 경로/.test(m || "")), "'동영상' 탭 선택 시 토스트 없음");
    ok(/동영상은 경로/.test(getElementById("pap-reg-mobile-hint").textContent), "동영상 인라인 안내 표시");
  }

  console.log("\n[항목2] 핀 패널 열림/닫힘 — 좌하단 도움말(?) 토글 표시 제어");
  {
    const { sandbox } = makeSandbox({});
    vm.runInContext(helpSrc + "\n;globalThis.__HELP = Help;", sandbox);
    sandbox.Help = sandbox.__HELP;
    sandbox.Help.init();
    vm.runInContext(notesSrc + "\n;globalThis.__NOTES = Notes;", sandbox);
    sandbox.Notes = sandbox.__NOTES;
    vm.runInContext(paSrc + "\n;globalThis.__PAP = PinActionPop;", sandbox);
    const PinActionPop = sandbox.__PAP;
    PinActionPop.init();
    const pin = makePin({});
    sandbox.State.pins = [pin];

    ok(sandbox.Help._toggleBtn.style.display !== "none", "패널 열기 전 도움말 토글은 숨겨져 있지 않음");
    PinActionPop.open(pin.id);
    ok(sandbox.Help._toggleBtn.style.display === "none", "핀 패널 열림 → 도움말 토글 숨김(겹침 방지)");
    PinActionPop.close();
    ok(sandbox.Help._toggleBtn.style.display === "flex", "핀 패널 닫힘 → 도움말 토글 복귀");
  }

  console.log("\n[항목4] 번호=위치명 중복 표시 제거");
  {
    const { sandbox, getElementById } = makeSandbox({});
    vm.runInContext(notesSrc + "\n;globalThis.__NOTES = Notes;", sandbox);
    sandbox.Notes = sandbox.__NOTES;
    vm.runInContext(paSrc + "\n;globalThis.__PAP = PinActionPop;", sandbox);
    const PinActionPop = sandbox.__PAP;
    PinActionPop.init();
    // PinSeries.formatNo(checkboard) === String(no) → 체크보드 1번핀 라벨을 "1"로 두면 번호와 동일
    const pinDup = makePin({ id: "pd", checkboard: true, label: "1" });
    sandbox.State.pins = [pinDup];
    PinActionPop.open(pinDup.id);
    ok(getElementById("pap-no").textContent === "#1", "배지는 번호(#1) 표시");
    ok(getElementById("pap-title").textContent === "", "위치명이 번호와 같으면 제목은 비움(중복 제거)");

    const pinDiff = makePin({ id: "pf", checkboard: true, label: "화물창 5번" });
    sandbox.State.pins = [pinDup, pinDiff];
    PinActionPop.open(pinDiff.id);
    ok(getElementById("pap-title").textContent === "화물창 5번", "위치명이 번호와 다르면 그대로 표시");

    const pinNoLabel = makePin({ id: "pn", checkboard: true, label: "" });
    sandbox.State.pins = [pinDup, pinDiff, pinNoLabel];
    PinActionPop.open(pinNoLabel.id);
    ok(/^포인트 /.test(getElementById("pap-title").textContent), "라벨 자체가 없으면 기존처럼 '포인트 N' 표시");
  }

  return failed;
}

/* ══════════════════════ [항목3] 35_PhotoBatch.js — PhotoNaming.describe ══════════════════════ */
function runPhotoNamingTests(pbSrc) {
  console.log("\n[항목3] 사진 캡션 — shotAt/origName 없어도 imageName 으로 보강");
  const sandbox = { console, Math, JSON, Date, Number, Array, Object, String };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(pbSrc + "\n;globalThis.__PN = PhotoNaming;", sandbox);
  const PhotoNaming = sandbox.__PN;

  // Projects 미정의 → scopeOf 는 {area:null, zone:null} (typeof 가드로 안전 폴백)
  const pinOld = { id: "p2", label: "2", imageId: "img1", imageName: "floor_20260101120000" };
  const oldDesc = PhotoNaming.describe(pinOld);
  ok(oldDesc === "floor_20260101120000", "shotAt/origName 없는 기존 핀 — imageName 으로 사진 정보 표시(빈 캡션 방지)");

  const pinNew = { id: "p3", label: "3", imageId: "img2", shotAt: Date.UTC(2026, 8, 29, 15, 0, 0), origName: "IMG_0001.jpg" };
  const newDesc = PhotoNaming.describe(pinNew);
  ok(/원본 IMG_0001\.jpg/.test(newDesc), "shotAt/origName 있는 신규 핀은 기존 동작(원본파일명 포함) 그대로 유지");
  ok(!/undefined/.test(newDesc), "신규 핀 캡션에 imageName 중복 삽입 없음");

  return failed;
}

/* ══════════════════════ [항목6] 06_PanoViewer.js — 저장명 표시 ══════════════════════ */
function runPanoViewerTests(pvSrc, pbSrc) {
  console.log("\n[항목6] 360 뷰어 제목에 사진 저장명(PhotoNaming) 표시");
  {
    const { sandbox } = makeSandbox({});
    vm.runInContext(pbSrc + "\n;globalThis.__PN = PhotoNaming;", sandbox);
    sandbox.PhotoNaming = sandbox.__PN;
    vm.runInContext(pvSrc + "\n;globalThis.__PV = PanoViewer;", sandbox);
    const PanoViewer = sandbox.__PV;
    const pin = { id: "p9", label: "9", imageId: "img9", imageName: "zoneA_20260101090000" };
    PanoViewer._currentPin = pin;
    PanoViewer.load("data:image/jpeg;base64,AAAA", pin.label);
    const title = sandbox.document.getElementById("pano-location-name").textContent;
    ok(title === "360° — 9 · zoneA_20260101090000", "저장명(PhotoNaming.describe 결과)이 제목에 덧붙음: " + title);
  }
  {
    const { sandbox } = makeSandbox({});
    vm.runInContext(pbSrc + "\n;globalThis.__PN = PhotoNaming;", sandbox);
    sandbox.PhotoNaming = sandbox.__PN;
    vm.runInContext(pvSrc + "\n;globalThis.__PV = PanoViewer;", sandbox);
    const PanoViewer = sandbox.__PV;
    const pin = { id: "p10", label: "10" }; // 저장명 정보 전혀 없음
    PanoViewer._currentPin = pin;
    PanoViewer.load("data:image/jpeg;base64,AAAA", pin.label);
    const title = sandbox.document.getElementById("pano-location-name").textContent;
    ok(title === "360° — 10", "저장명 정보가 없으면 기존 동작(제목 그대로) 유지: " + title);
  }
  return failed;
}

/* ══════════════════════ [항목5] CSS — 세로사진 높이 제한 ══════════════════════ */
function runCssTests() {
  console.log("\n[항목5] public/css/style.css — #pap-photo-img 높이 제한(3개 CSS 파일 전수 확인)");
  const styleCss = rd("public/css/style.css");
  const tokensCss = rd("public/css/seastar-family-tokens.css");
  const skinCss = rd("public/css/seastar-3d-skin.css");
  const rule = /#pap-photo-img\s*\{[^}]*max-height:\s*[^;]+;[^}]*object-fit:\s*contain[^}]*\}/;
  ok(rule.test(styleCss), "style.css 에 #pap-photo-img max-height + object-fit:contain 규칙 존재");
  ok(!/#pap-photo-img/.test(tokensCss), "seastar-family-tokens.css 에 충돌 규칙 없음(전수 확인)");
  ok(!/#pap-photo-img/.test(skinCss), "seastar-3d-skin.css 에 충돌 규칙 없음(전수 확인)");
  return failed;
}

/* ══════════════════════ 실행부 ══════════════════════ */
const paSrc = rd("public/js/modules/27_PinActionPop.js");
const notesSrc = rd("public/js/modules/13_Notes.js");
const helpSrc = rd("public/js/modules/36_Help.js");
const pbSrc = rd("public/js/modules/35_PhotoBatch.js");
const pvSrc = rd("public/js/modules/06_PanoViewer.js");

runPinActionPopTests(paSrc, notesSrc, helpSrc);
runPhotoNamingTests(pbSrc);
runPanoViewerTests(pvSrc, pbSrc);
runCssTests();

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
