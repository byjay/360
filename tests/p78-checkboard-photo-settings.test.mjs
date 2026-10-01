/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p78-checkboard-photo-settings.test.mjs)
 *
 * 발주서(WO 20260928, 마스터 원문):
 *  ① "포인트찍으면 사진을 기본으로 등록하게 해야하는데 이전에 되는걸 상실했네"
 *     → 체크보드 핀 배치 직후 사진(360) 선택창이 곧바로 열리고, 사진을 고르면 그 핀에
 *       바로 첨부되며(새 "등록창" 없음), 취소하면 핀은 번호만 가진 채 남는다.
 *  ② "세팅에 시작번호 설정기능구현해" → #settings-modal 에 체크보드 시작번호 [적용]/
 *     [전체 번호 일괄 변경]. 도면 미로드 시 비활성 + 이유 표시.
 *
 * 실제 모듈 소스(20_App.js/24_Settings.js/01b_PinSeries.js)를 그대로 vm 에 평가한다
 * (목 구현 아님). ①②③ 에 뮤테이션(수정 무력화) 케이스가 붙어 되돌리면 실패를 증명한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const seriesSrc = rd("public/js/modules/01b_PinSeries.js");
const appSrc = rd("public/js/modules/20_App.js");
const settingsSrc = rd("public/js/modules/24_Settings.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 최소 DOM 목(mock) — p8/p39 패턴 재사용 ── */
function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => x && set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle(c, force) {
      if (force === undefined) { if (set.has(c)) { set.delete(c); return false; } set.add(c); return true; }
      if (force) set.add(c); else set.delete(c);
      return !!force;
    },
    contains: (c) => set.has(c),
    _set: set
  };
}
function makeEl() {
  const el = {
    style: {}, dataset: {}, title: "", value: "", disabled: false,
    _text: "", _handlers: {},
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    click() { (this._handlers.click || []).forEach((fn) => fn({})); },
    focus() {}, querySelector() { return null; }, querySelectorAll() { return []; }
  };
  Object.defineProperty(el, "textContent", { get() { return this._text; }, set(v) { this._text = v == null ? "" : String(v); } });
  el.classList = makeClassList();
  return el;
}
function makeDoc() {
  const registry = {};
  const document = {
    getElementById: (id) => (registry[id] = registry[id] || makeEl()),
    createElement: () => makeEl(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}
  };
  return { document, registry };
}
function makeUI(document) {
  return {
    $: (id) => document.getElementById(id),
    show(id) { const e = document.getElementById(id); if (e) e.classList.remove("hidden"); },
    hide(id) { const e = document.getElementById(id); if (e) e.classList.add("hidden"); },
    toggle(id, force) { const e = document.getElementById(id); if (!e) return; if (force === undefined) e.classList.toggle("hidden"); else force ? e.classList.remove("hidden") : e.classList.add("hidden"); },
    text(id, v) { const e = document.getElementById(id); if (e) e.textContent = v; },
    val(id) { const e = document.getElementById(id); return e ? e.value : ""; },
    clearVal(id) { const e = document.getElementById(id); if (e) e.value = ""; },
    enable(id) { const e = document.getElementById(id); if (e) e.disabled = false; },
    disable(id) { const e = document.getElementById(id); if (e) e.disabled = true; },
    escapeHtml(s) { return String(s); },
    renderPinList() {}, renderPinsOnMap() {}, togglePinList() {}
  };
}
function makeSeqDate() {
  let t = 2000000;
  class SeqDate extends Date { static now() { return t++; } }
  return SeqDate;
}

/** _placeCheckboardPin 직후 사진 선택창까지 검증하는 "가벼운" App 환경.
 *  _confirmPin() 이 타는 Cloud/SyncQueue/OpLog 는 오프라인 큐잉 분기로 고정(네트워크 없음). */
function makeAppEnv() {
  const { document, registry } = makeDoc();
  const State = {
    checkboard: false, mode: "designer", pdfPage: 1, pins: [], checkboardStart: {},
    activePin: null, editingPinId: null, pending: null, pendingFile: null, pendingIsVideo: false,
    pendingIs360: false, pendingDocs: [], pendingFls: null, pendingIcon: "number", pinColor: null
  };
  const UI = makeUI(document);
  const calls = { autoSave: 0, confirmPin: 0, resizeImage: 0, enqueue: 0 };
  const Cloud = {
    _cache: {},
    resizeImage: async (f) => { calls.resizeImage++; return { dataURL: "data:image/jpeg;base64,x", width: 100, height: 50 }; },
    uploadImage: async () => { throw new Error("network unavailable in test"); }
  };
  const SyncQueue = { enqueue: async () => { calls.enqueue++; return "op" + calls.enqueue; } };
  const Prompt = { toast() {}, ask: async () => null, confirm: async () => true };
  const sandbox = {
    console, document, window: { addEventListener() {} }, navigator: { onLine: false },
    SyncQueue, OpLog: undefined, Cloud, State, UI, Prompt,
    MapCtrl: { flyTo() {} }, Zones: undefined, Log: undefined, PinGrid: undefined,
    JSON, Array, Map, Set, Date: makeSeqDate(), URL: { createObjectURL: () => "blob:x" }, Promise, setTimeout, alert() {}
  };
  vm.createContext(sandbox);
  vm.runInContext(seriesSrc + "\n" + appSrc + "\n;globalThis.__App = App;", sandbox);
  const App = sandbox.__App;
  const origAutoSave = App._autoSave;
  App._autoSave = function (...a) { calls.autoSave++; return origAutoSave ? origAutoSave.apply(App, a) : undefined; };
  App._updateSyncBadge = () => {};
  App._bindSidebar(); // input-pin-file change 핸들러 등 실제 바인딩
  return { App, State, UI, registry, calls, sandbox };
}

/* ══ ① [WO 20260929 마스터 정정] 체크보드 모드: _placeCheckboardPin 은 번호 핀만 만든다
 *  ("빈 곳 클릭 → 다른 반응 없음"). 사진 선택창은 절대 자동으로 뜨지 않는다. ══ */
console.log("\n[① 체크보드 배치 — 파일창 자동 오픈 없음(WO 20260929 정정)]");
{
  const { App, State, registry } = makeAppEnv();
  State.checkboard = true; State.regMode = "checkboard";
  let fileClicked = 0;
  registry["input-pin-file"].addEventListener("click", () => { fileClicked++; });
  const pin = App._placeCheckboardPin({ x: 10, y: 10 });
  ok(State.pins.length === 1 && State.pins[0].label === "1", "핀이 번호 '1'로 생성됨");
  ok(!!pin && pin.id === State.pins[0].id, "_placeCheckboardPin 이 생성한 핀을 반환함(사진등록 모드 호출부가 재사용)");
  ok(fileClicked === 0, "체크보드는 '다른 반응 없음' — 사진 선택창이 열리지 않음");
  ok(State.editingPinId === null, "편집 대상 상태도 건드리지 않음(폼·팝업 없음)");

  console.log("\n[뮤테이션①] _placeCheckboardPin 이 다시 파일창을 열도록 되돌리면(체크보드에서도 반응) — 실패해야 함");
  const needle = "      // 🔴 [WO 20260929 마스터 정정] 이 함수는 항상 \"번호 핀만\" 만든다";
  if (!appSrc.includes(needle)) { console.log("  FAIL 뮤테이션① 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mutated = appSrc.replace("      return pin;\n    },", "      this._openPinMediaPicker(pin);\n      return pin;\n    },");
    if (mutated === appSrc) { console.log("  FAIL 뮤테이션① 치환 실패(needle 중복/불일치)"); failed++; }
    else {
      const { document: docM, registry: regM } = makeDoc();
      const StateM = { checkboard: true, regMode: "checkboard", mode: "designer", pdfPage: 1, pins: [], checkboardStart: {}, editingPinId: null, pending: null, pendingIcon: "number" };
      const UIm = makeUI(docM);
      const sandboxM = { console, document: docM, window: { addEventListener() {} }, navigator: { onLine: false }, SyncQueue: { enqueue: async () => "op" }, Cloud: { _cache: {}, resizeImage: async () => ({ dataURL: "d", width: 1, height: 1 }) }, State: StateM, UI: UIm, Prompt: { toast() {} }, MapCtrl: { flyTo() {} }, JSON, Array, Map, Set, Date: makeSeqDate(), setTimeout };
      vm.createContext(sandboxM);
      vm.runInContext(seriesSrc + "\n" + mutated + "\n;globalThis.__App = App;", sandboxM);
      sandboxM.__App._updateSyncBadge = () => {};
      let clickedM = 0;
      const fiM = regM["input-pin-file"] = regM["input-pin-file"] || makeEl();
      fiM.addEventListener("click", () => { clickedM++; });
      sandboxM.__App._placeCheckboardPin({ x: 1, y: 1 });
      ok(clickedM === 1, "뮤테이션 적용 시 체크보드에서도 파일창이 열림(①이 깨짐을 증명) → click 호출 " + clickedM + "회");
    }
  }
}

/* ══ ①' [WO 20260929] 사진 등록 모드: 핀 생성 직후 즉시 사진 선택창(동기 호출) ══ */
console.log("\n[①' 사진 등록 모드 — 핀 생성 직후 사진 선택창 자동 오픈]");
{
  const { App, State, registry } = makeAppEnv();
  State.checkboard = true; State.regMode = "photo";
  let fileClicked = 0;
  registry["input-pin-file"].addEventListener("click", () => { fileClicked++; });
  const pin = App._placeCheckboardPin({ x: 10, y: 10 });
  App._openPinMediaPicker(pin); // _handlePlaceClick 의 photo 분기가 실제로 호출하는 두 함수(동기 순서 재현)
  ok(State.pins.length === 1 && State.pins[0].label === "1", "핀이 번호 '1'로 생성됨");
  ok(fileClicked === 1, "핀 생성 직후 input-pin-file.click() 이 곧바로(동기) 호출됨(모바일 user-activation 유지)");
  ok(State.editingPinId === State.pins[0].id, "편집 대상 상태가 방금 만든 핀으로 세팅됨(기존 editPin() 경로 재사용)");
  ok(registry["input-pin-label"].value === "1", "라벨 입력 필드가 핀 번호로 미리 채워짐(← _confirmPin() 이 기본라벨로 덮어쓰지 않게)");
}

/* ══ ①b 사진을 고르면 그 핀에 첨부되고, "또 다른 등록창"은 뜨지 않는다 ══ */
console.log("\n[①b 사진 선택 → 같은 핀에 첨부, 등록창(section-pin-form) 안 뜸]");
{
  const { App, State, registry, calls } = makeAppEnv();
  State.checkboard = true; State.regMode = "photo"; // [WO 20260929] 첨부 파일창은 사진등록 모드 전용
  const pinForm = registry["section-pin-form"] = registry["section-pin-form"] || makeEl();
  pinForm.classList.add("hidden"); // 실제 기본 상태(index.html) 재현
  const newPin = App._placeCheckboardPin({ x: 20, y: 20 });
  App._openPinMediaPicker(newPin);
  const pinId = State.pins[0].id;
  ok(pinForm.classList.contains("hidden"), "배치 직후에도 등록 폼(section-pin-form)은 여전히 hidden");

  // 실제 change 이벤트 발화(파일 선택 완료)
  const fakeFile = { name: "photo.jpg", type: "image/jpeg", size: 12345 };
  registry["input-pin-file"]._handlers.change.forEach((fn) => fn({ target: { files: [fakeFile], value: "" } }));

  await new Promise((r) => setTimeout(r, 250)); // _acceptPinMediaFile setTimeout(120) + _confirmPin() 비동기 완료 대기

  ok(State.pins.length === 1, "새 핀이 추가로 생기지 않음(같은 핀에 첨부, 중복 생성 없음) — 실제 " + State.pins.length);
  ok(State.pins[0].id === pinId, "핀 id 불변(그 핀에 그대로 첨부)");
  ok(State.pins[0].label === "1", "번호 라벨 유지(사진 첨부가 라벨을 덮어쓰지 않음)");
  ok(!!State.pins[0].pendingOpId || !!State.pins[0].pendingSync, "핀에 미디어(오프라인 큐잉)가 첨부됨 → " + JSON.stringify({ pendingOpId: State.pins[0].pendingOpId, pendingSync: State.pins[0].pendingSync }));
  ok(registry["section-pin-form"].classList.contains("hidden"), "사진 첨부 후에도 등록 폼(section-pin-form)은 계속 hidden — '또 다른 등록창' 없음");
  ok(State.editingPinId === null, "저장 완료 후 편집 대상 상태가 정리됨");
  ok(State._checkboardAutoConfirm !== true, "체크보드 자동첨부 플래그가 소비되어 꺼짐");
}

/* ══ ①c 취소(파일 미선택) 시 핀은 번호만 가진 채 유지된다(조용히 삭제 금지) ══ */
console.log("\n[①c 사진 선택 취소 → 핀 유지(삭제 안 됨)]");
{
  const { App, State, registry } = makeAppEnv();
  State.checkboard = true; State.regMode = "photo"; // [WO 20260929] 첨부 파일창은 사진등록 모드 전용
  const cPin = App._placeCheckboardPin({ x: 5, y: 5 });
  App._openPinMediaPicker(cPin);
  const pinId = State.pins[0].id;
  registry["input-pin-file"]._handlers.change.forEach((fn) => fn({ target: { files: [], value: "" } }));
  ok(State.pins.length === 1 && State.pins[0].id === pinId, "취소해도 핀이 삭제되지 않고 그대로 남음");
  ok(State.pins[0].label === "1", "번호도 그대로 유지됨");
  ok(State.editingPinId === null, "취소 시 편집 대상 상태만 정리됨(핀 자체는 건드리지 않음)");
  ok(State._checkboardAutoConfirm !== true, "취소 후 자동첨부 플래그도 꺼짐(다음 동작에 오염 안 됨)");

  console.log("\n[뮤테이션②] 취소 분기가 핀을 삭제하도록 바꾸면 — 실패해야 함");
  const needle = 'if (wasCheckboardAuto) { State.editingPinId = null; State.pending = null; }\n          return;\n        }\n        const isImg';
  const mutated = appSrc.replace(needle, 'if (wasCheckboardAuto) { State.pins = State.pins.filter(p => p.id !== State.editingPinId); State.editingPinId = null; State.pending = null; }\n          return;\n        }\n        const isImg');
  if (mutated === appSrc) { console.log("  FAIL 뮤테이션② 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { document: docM, registry: regM } = makeDoc();
    const StateM = { checkboard: true, mode: "designer", pdfPage: 1, pins: [], checkboardStart: {}, editingPinId: null, pending: null, pendingIcon: "number" };
    const UIm = makeUI(docM);
    const sandboxM = { console, document: docM, window: { addEventListener() {} }, navigator: { onLine: false }, SyncQueue: { enqueue: async () => "op" }, Cloud: { _cache: {}, resizeImage: async () => ({ dataURL: "d", width: 1, height: 1 }) }, State: StateM, UI: UIm, Prompt: { toast() {} }, MapCtrl: { flyTo() {} }, JSON, Array, Map, Set, Date: makeSeqDate(), setTimeout, alert() {} };
    vm.createContext(sandboxM);
    vm.runInContext(seriesSrc + "\n" + mutated + "\n;globalThis.__App = App;", sandboxM);
    sandboxM.__App._updateSyncBadge = () => {};
    sandboxM.__App._bindSidebar();
    StateM.regMode = "photo"; // [WO 20260929] 첨부 파일창은 사진등록 모드 전용
    const pinM = sandboxM.__App._placeCheckboardPin({ x: 1, y: 1 });
    sandboxM.__App._openPinMediaPicker(pinM);
    const pinIdM = StateM.pins[0].id;
    regM["input-pin-file"]._handlers.change.forEach((fn) => fn({ target: { files: [], value: "" } }));
    ok(StateM.pins.length !== 1 || StateM.pins.find((p) => p.id === pinIdM) === undefined,
      "뮤테이션 적용 시 취소해도 핀이 삭제됨(①c가 깨짐을 증명) → 남은 핀 수 " + StateM.pins.length);
  }
}

/* ══ ② 설정 패널 — 체크보드 시작 번호 [적용]/[전체 번호 일괄 변경] ══ */
console.log("\n[② 설정(#settings-modal) 체크보드 시작 번호]");
function makeSettingsEnv(hasDrawing) {
  const { document, registry } = makeDoc();
  const State = { pdfPage: 1, checkboardStart: {}, pins: [], pdfDoc: hasDrawing ? {} : null, viewerPages: null, pinColor: null };
  const UI = makeUI(document);
  const Auth = { user: { name: "designer", email: "d@x.com" }, isDesigner: true, isSuper: false, role: "designer" };
  const renumberCalls = [];
  const sandbox = {
    console, document, window: { addEventListener() {} }, State, UI, Auth,
    App: null, // 아래서 실제 App 을 주입(20_App.js 로드 후)
    Prompt: { toast() {} }, PinPrefs: { get: () => "green", PALETTE: [] },
    JSON, Array, Map, Set, Date: makeSeqDate(), setTimeout
  };
  vm.createContext(sandbox);
  // App._checkboardStart/_setCheckboardStart/_renumberCheckboard 정본 재사용(20_App.js 그대로 로드)
  vm.runInContext(seriesSrc + "\n" + appSrc + "\n;globalThis.__App = App;", sandbox);
  sandbox.App = sandbox.__App;
  sandbox.App._renumberCheckboard = async (...a) => { renumberCalls.push(a); };
  vm.runInContext(settingsSrc + "\n;globalThis.__Settings = Settings;", sandbox);
  const Settings = sandbox.__Settings;
  Settings.init();
  return { Settings, App: sandbox.App, State, UI, registry, renumberCalls };
}
{
  const { Settings, App, State, registry, renumberCalls } = makeSettingsEnv(true);
  // [WO 20261001-startno] 시작 번호 입력·[적용]은 번호 대역 시트(24b_NumBand · p104)로 일원화됐다.
  //   전: 모달 입력 101 → [적용] → _checkboardStart === 101 · 후: 모달에는 입력이 없고(마크업 0) 같은 정본
  //   App._setCheckboardStart 를 시트가 부른다 — 여기서는 정본 자체(150 → 대역 101–200 안 하한 150)와 모달 잔여 UI 를 본다.
  Settings.render(); // 모달 렌더 — 디자이너면 _renderCheckboardStart() 호출
  const indexHtml = rd("public/index.html");
  ok(!/id="settings-checkboard-start"/.test(indexHtml) && !/id="btn-settings-checkboard-apply"/.test(indexHtml),
    "모달의 중복 시작번호 입력·[적용] 마크업 제거(SoT 1개)");
  ok(/id="btn-settings-numband"/.test(indexHtml), "모달에 [번호 대역] 버튼(같은 시트를 연다) 존재");
  ok(registry["btn-settings-checkboard-renumber"].disabled === false, "도면 로드됨 → 일괄 변경 버튼 활성화");

  ok(App._setCheckboardStart(1, 150, "checkboard") === 150 && App._checkboardStart(1) === 150 && App._numBand() === 2,
    "정본 _setCheckboardStart(150) → 시작 150 · 대역 2(101–200)로 자동 귀속 → " + App._checkboardStart(1) + " · " + App._numBand());

  registry["btn-settings-checkboard-renumber"].click();
  ok(renumberCalls.length === 1, "전체 번호 일괄 변경 클릭 → 기존 App._renumberCheckboard() 정본 그대로 호출됨");

  console.log("\n[뮤테이션③] 직접 입력 하한 저장을 지우면(대역만 귀속) — 실패해야 함");
  const needle = "PinSeries.setUserStart(this._pinAuthor(), ser, n);";
  const mutated = appSrc.replace(needle, "/* [뮤테이션] 하한 저장 제거 */");
  if (mutated === appSrc) { console.log("  FAIL 뮤테이션③ 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { document: docM } = makeDoc();
    const StateM = { pdfPage: 1, checkboardStart: {}, pins: [], pdfDoc: {}, viewerPages: null, pinColor: null };
    const AuthM = { user: { name: "d", email: "d@x.com" }, isDesigner: true, isSuper: false, role: "designer" };
    const sandboxM = { console, document: docM, window: { addEventListener() {} }, State: StateM, UI: makeUI(docM), Auth: AuthM, Prompt: { toast() {} }, JSON, Array, Map, Set, Date: makeSeqDate(), setTimeout };
    vm.createContext(sandboxM);
    vm.runInContext(seriesSrc + "\n" + mutated + "\n;globalThis.__App = App;", sandboxM);
    const AppM = sandboxM.__App;
    AppM._setCheckboardStart(1, 150, "checkboard");
    ok(AppM._checkboardStart(1) !== 150, "뮤테이션 적용 시 입력값(150)이 무시되고 대역 시작값으로 떨어짐(②가 깨짐을 증명) → " + AppM._checkboardStart(1));
  }
}

/* ══ ②b 도면 미로드 시 비활성 + 이유 표시(조용히 무시 금지) ══ */
console.log("\n[②b 도면 미로드 → 입력 비활성 + 이유 문구]");
{
  const { Settings, registry } = makeSettingsEnv(false);
  Settings.render();
  // [WO 20261001-startno] 입력·[적용] 은 제거됐다(번호 대역 시트로 일원화) — 남은 일괄 변경 버튼의 비활성 + 이유만 본다.
  ok(registry["btn-settings-checkboard-renumber"].disabled === true, "도면 없음 → 일괄변경 버튼 비활성화");
  ok(/도면|구역/.test(registry["settings-checkboard-hint"].textContent), "이유 문구가 표시됨(조용히 무시 아님) → " + JSON.stringify(registry["settings-checkboard-hint"].textContent));
}

console.log(failed ? `\n총 ${failed}건 실패` : "\n전부 통과");
process.exit(failed ? 1 : 0);
