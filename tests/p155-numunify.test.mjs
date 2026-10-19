/**
 * p155 — 번호 통합(CHECKER ↔ 360 단일 번호 공간) + 번호 리셋 정본 · 프레임워크 0
 * 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p155-numunify.test.mjs
 *
 * WO 20261015-numunify · 설계 .tmp/design-numunify.md §7. 마스터: "체크 모드와 360 모드를 번호를 따로 구분한 걸
 *   하나로 합치고 … 번호는 공통적으로 하나로 관리하고 체크보드 모드에서 번호만 일괄적으로 찍고 나서 사진폴더 …
 *   바로 그 위치에 360도 사진이 일괄적으로" / "번호 리셋기능도 구현하고".
 *
 * 클라 = 실 소스(01b_PinSeries · 60_PhotoFolder · 20_App · 61_NumReset)를 vm 에 그대로 평가(재구현 0).
 * 서버 = src/index.tsx 의 링크 필터 함수 원문을 잘라 실 pinImageRefs(src/lib/aiVision.ts)와 esbuild 로 묶어 실행.
 *   N1 numbers() 계열 무관 단일 카운터(체커 3 + 360 3 → 1…6, 중복 0)
 *   N2 nextInBand 계열 무관 최댓값+1(체커 101 · 360 102 → 다음 103, series 인자 무관)
 *   N3 formatNo 접두 없음("5"/"5")
 *   N4 교차 계열 중복 탐지 — 프로덕션 실데이터 모양(체커 1…11 / 360 1…12) → 중복 22 · 구명 별칭 동일
 *   N5 CHECKER 핀 → PhotoFolder.handlePinPlaced true(001.jpg 매칭) · 일괄 대상(_batchTargets)에 체커 핀 포함
 *   N6 CHECKER 모드 배치 클릭 → 사진창(autoConnectPin·PhotoFolder·_openPinMediaPicker) 호출 0(유지 가드)
 *   N7 서버 360 필터 = 미디어 보유 핀(체커+사진 포함 · 사진 없는 360 제외) · aliasMeta 가 같은 함수 사용
 *   N8 서버 checker/null 모드 = 전부(원문 그대로)
 *   N9 matchKey(1)="001" · 1001 이 실제 핀이면 1↔1001.jpg 불일치(절단 오매칭 가드) · 1001↔1001.jpg 일치
 *   N10 [WO 20261019-unifymode 반전] 색 통일 — 사진 붙은 체커 핀 = 사진 있는 일반 핀(체커 메타는 색 축 아님)
 *   R1 리셋 미리보기(위치순 위→아래·왼→오) · R2 기존 번호순 · R3 범위 밖 겹침 표시 · R4 적용(라벨 1…n · id 불변 · 스냅샷)
 *   R5 되돌리기(옛 라벨·수동표시 복원 · 리셋 뒤 고친 핀은 건너뜀) · R6 NumReset 권한 사유(열람자·오프라인 0)
 *
 * 뮤테이션: P155_MUT=<이름> → 해당 소스 치환 후 실행, EXIT=1 이어야 한다(대상 못 찾으면 EXIT=2).
 *   split-numbers · band-series · p-prefix · link-checkboard · dup-checkonly · gate-photofolder ·
 *   reset-order · reset-snapshot · undo-skip · offline-gate
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const SRC = {
  series: rd("public/js/modules/01b_PinSeries.js"),
  pf: rd("public/js/modules/60_PhotoFolder.js"),
  app: rd("public/js/modules/20_App.js"),
  nr: rd("public/js/modules/61_NumReset.js"),
  srv: rd("src/index.tsx"),
};
const MUTS = {
  "split-numbers":   ["series", "        n++;\n        if (series === \"checkboard\") {", "        n = (this.__nc = this.__nc || {})[pg + series] = ((this.__nc[pg + series]) || 0) + 1;\n        if (series === \"checkboard\") {"],
  "band-series":     ["series", "        const n = parseInt(p.label, 10);                       // label 이 숫자가 아니면(NaN) 무시", "        if (this.seriesOf(p) !== (series === \"content\" ? \"content\" : \"checkboard\")) return;\n        const n = parseInt(p.label, 10);"],
  "p-prefix":        ["series", "formatNo(no, series) { return String(no); },", "formatNo(no, series) { return series === \"checkboard\" ? String(no) : (\"P\" + no); },"],
  "link-checkboard": ["srv", "return arr.filter((p: any) => pinHas360Media(p))", "return arr.filter((p: any) => !(p && p.checkboard))"],
  "dup-checkonly":   ["series", "중복 판정\n        if (!p || p._deleted || (p.page || 1) !== pg) return;", "중복 판정\n        if (!p || p._deleted || (p.page || 1) !== pg || !p.checkboard) return;"],
  "gate-photofolder":["pf", "        // [WO 20261015-numunify] CHECKER 핀 차단 해제 — 결정 = 허용(헤더 주석). 계열 무관하게 번호로 매칭한다.\n", "        if (PinSeries.seriesOf(pin) === \"checkboard\") return false;\n"],
  "reset-order":     ["series", "        : (a, b) => this.byPosition(a, b));", "        : (a, b) => 0);"],
  "reset-snapshot":  ["series", "        pin.numReset = { batch: String(batch), from: pin.label == null ? null : pin.label, fromManual: !!pin.labelManual, to: c.newLabel, at: t };\n", ""],
  "undo-skip":       ["series", "        if (String(p.label == null ? \"\" : p.label) === String(p.numReset.to)) restore.push(", "        if (true) restore.push("],
  "offline-gate":    ["nr", "      if (typeof navigator !== \"undefined\" && navigator.onLine === false) return \"온라인에서만 — 오프라인에서는 번호 리셋을 실행하지 않습니다\";\n", ""],
};
const MUT = process.env.P155_MUT || "";
if (MUT) {
  const m = MUTS[MUT];
  if (!m) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }
  if (!SRC[m[0]].includes(m[1])) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함: " + MUT); process.exit(2); }
  SRC[m[0]] = SRC[m[0]].replace(m[1], m[2]);
  console.log("[뮤테이션 적용] " + MUT);
}

let failed = 0;
const ok = (cond, label, d) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (!cond && d !== undefined ? " :: " + JSON.stringify(d).slice(0, 300) : "")); if (!cond) failed++; };

/* ── 실 PinSeries(vm) ── */
function loadSeries(extra) {
  const sb = Object.assign({ console, JSON, Map, Set, Math, Number, String, Array, Object, Date, RegExp }, extra || {});
  vm.createContext(sb);
  vm.runInContext(SRC.series + "\n;globalThis.__PS = PinSeries;", sb);
  return sb.__PS;
}

console.log("\n[N1 numbers() — 계열 무관 단일 카운터]");
{
  const PS = loadSeries();
  const pins = [
    { id: "c1", page: 1, checkboard: true }, { id: "p1", page: 1 }, { id: "c2", page: 1, checkboard: true },
    { id: "p2", page: 1, imageId: "x" }, { id: "c3", page: 1, checkboard: true }, { id: "p3", page: 1 },
    { id: "z", page: 2 }
  ];
  const m = PS.numbers(pins, 1);
  const nos = pins.filter((p) => p.page === 1).map((p) => m.get(p.id).no);
  ok(JSON.stringify(nos) === "[1,2,3,4,5,6]", "N1 체커 3 + 360 3 → 1…6(배열 순서) · 중복 0 — " + JSON.stringify(nos));
  ok(m.get("c1").series === "checkboard" && m.get("p2").kind === "content", "N1b 반환 shape {no, kind, series} 유지(색·필터용)");
}

console.log("\n[N2 nextInBand — 계열 무관 최댓값+1]");
{
  const PS = loadSeries();
  const pins = [{ id: 1, page: 1, checkboard: true, label: "101" }, { id: 2, page: 1, label: "102" }];
  const a = PS.nextInBand(pins, 1, "checkboard", 2), b = PS.nextInBand(pins, 1, "content", 2);
  ok(a.no === 103 && b.no === 103, "N2 체커 101 · 360 102 → 다음 103(series 인자 무관) — " + a.no + "/" + b.no);
  ok(PS.bandUsage(pins, 1, "checkboard").get(2).count === 2, "N2b 대역 사용 현황도 계열 무관(2개)");
}

console.log("\n[N3 formatNo — 접두 없음]");
{
  const PS = loadSeries();
  ok(PS.formatNo(5, "content") === "5" && PS.formatNo(5, "checkboard") === "5", "N3 formatNo(5,content)=\"5\" · formatNo(5,checkboard)=\"5\"");
}

console.log("\n[N4 교차 계열 중복 탐지 — 프로덕션 실데이터 모양(dep_mumcudi1: 체커 1…11 / 360 1…12)]");
{
  const PS = loadSeries();
  const pins = [];
  for (let i = 1; i <= 11; i++) pins.push({ id: "c" + i, page: 1, checkboard: true, label: String(i) });
  for (let i = 1; i <= 12; i++) pins.push({ id: "p" + i, page: 1, label: String(i) });
  pins.push({ id: "t1", page: 1, label: "현장A" }, { id: "t2", page: 1, label: "현장A" });   // 자유 텍스트 이름은 번호가 아니다
  const dup = PS.duplicateNoIds(pins, 1);
  ok(dup.size === 22 && !dup.has("p12") && !dup.has("t1"), "N4 중복 22개(체커 11 + 360 11) · 360 12 · 텍스트 이름 제외 — " + dup.size);
  ok(PS.duplicateCheckboardIds(pins, 1).size === 22, "N4b 구명 duplicateCheckboardIds = 정본 별칭(같은 결과)");
  ok(PS.validateCheckboardLabel(pins, 1, "c1", "12").ok === false, "N4c 개별 번호 변경 — 360 핀이 쓰는 12 로도 못 바꾼다(계열 무관 유일성)");
}

/* ── 실 PhotoFolder + 실 PinSeries(vm) — p152 loadPF 관례(가짜 DOM), PinSeries 는 진짜 ── */
function loadPF(state) {
  const registry = new Map();
  const mk = () => {
    const el = { value: "", textContent: "", innerHTML: "", style: {}, dataset: {}, _l: {}, _c: new Set(), _children: [],
      classList: { add: (c) => el._c.add(c), remove: (c) => el._c.delete(c), contains: (c) => el._c.has(c), toggle: (c, f) => { if (f === undefined ? !el._c.has(c) : f) el._c.add(c); else el._c.delete(c); } } };
    el.addEventListener = (t, fn) => { (el._l[t] = el._l[t] || []).push(fn); };
    el.setAttribute = () => {}; el.appendChild = (c) => { el._children.push(c); if (c && c.id) registry.set(c.id, c); return c; };
    el.querySelector = () => null; el.querySelectorAll = () => []; el.remove = () => {};
    return el;
  };
  const document = { getElementById: (id) => registry.get(id) || null, createElement: () => mk(), createTextNode: (t) => ({ textContent: t }), body: mk(), querySelectorAll: () => [] };
  document.body.appendChild = (c) => { if (c && c.id) registry.set(c.id, c); return c; };
  const State = Object.assign({ pins: [], pdfPage: 1, checkboard: true, regMode: "checkboard", mode: "designer" }, state || {});
  const uploads = [];
  const sb = { console, Map, Set, Promise, JSON, Math, Number, String, Array, Object, Date, RegExp, document, window: {},
    localStorage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })(), State, Auth: { readonly: false },
    App: { _detect360: (f, cb) => cb(true, 4096, 2048) },
    PhotoBatch: { _usedPhotoNames: () => new Set(), _uploadOneRow: async (pin, row) => { uploads.push([pin.id, row.name]); pin.imageId = "img_" + row.name; return { status: "done" }; }, _markUnsaved() {} },
    UI: { renderPinList() {}, renderPinsOnMap() {} }, Prompt: { toast() {} },
    Projects: { currentProject: { id: "prjT" }, currentDeck: null, decks: [], pinsForDeck: (pins) => pins } };
  vm.createContext(sb);
  vm.runInContext(SRC.series + "\n" + SRC.pf + "\n;globalThis.__PF = PhotoFolder; globalThis.__PS = PinSeries;", sb);
  return { PF: sb.__PF, PS: sb.__PS, State, uploads, registry, mkEl: mk };
}

console.log("\n[N5 CHECKER 핀 → 사진 폴더 매칭 대상(244c5d8 결정 = 허용)]");
{
  const c1 = { id: "c1", page: 1, checkboard: true, label: "1", x: 1, y: 1 };
  const c2 = { id: "c2", page: 1, checkboard: true, label: "2", x: 2, y: 2 };
  const { PF, State, uploads, registry, mkEl } = loadPF({ pins: [c1, c2] });
  PF._entry("__root__").mode = "fallback";
  PF._entry("__root__").fallbackFiles = [{ name: "a" }];
  PF._listEntries = async () => [{ name: "IMG_001.jpg", getFile: async () => ({ name: "IMG_001.jpg", lastModified: 1 }) }];
  PF.setSingleOn("__root__", true);
  PF.setAuto("__root__", true);
  const handled = await PF.handlePinPlaced(c1);
  ok(handled === true && uploads.length === 1 && uploads[0][0] === "c1" && uploads[0][1] === "IMG_001.jpg", "N5 CHECKER 핀 1 ↔ IMG_001.jpg → handlePinPlaced true · 등록 1건", { handled, uploads });
  const targets = PF._batchTargets(null).map((p) => p.id);
  ok(JSON.stringify(targets) === JSON.stringify(["c2"]), "N5b 일괄 등록 대상 = 사진 없는 체커 핀(c2) 포함(c1 은 방금 등록돼 제외) — " + JSON.stringify(targets));
  // N5c — 설계 §5 #9(바를 CHECKER 에도) 는 의도적 미적용: 모바일에서 하단 도크 [포인트]·연속 탭을 가려 CHECKER 핀 0개(p146 실측).
  //   CHECKER 진입 = 모드 무관 기능 메뉴 [구역별 사진 폴더 지정](openDeckManager → 일괄 등록). 바는 CHECKER 에서 숨김이 유지돼야 한다.
  const bar = mkEl(); registry.set("photofolder-bar", bar);
  PF._refreshBarForActiveDeck = () => {};
  State.regMode = "checkboard";
  PF.syncUI();
  const hiddenInChecker = bar.classList.contains("hidden");
  State.regMode = "photo";
  PF.syncUI();
  const fm = fs.readFileSync(path.join(ROOT, "public/js/modules/45_FeatureMenu.js"), "utf8");
  const entry = /\{ id: "photo-folder-deck"[^}]*\}/.exec(fm);
  ok(hiddenInChecker && !bar.classList.contains("hidden") && !!entry && !/mode:/.test(entry[0]) && /PhotoFolder\.openDeckManager\(\)/.test(fm),
    "N5c 폴더 바 = 360 전용(CHECKER 숨김 — 모바일 가림 방지) · CHECKER 진입 = 모드 무관 [구역별 사진 폴더 지정]");
}

console.log("\n[N6 CHECKER 모드 배치 클릭 → 사진창 0(🔒 유지 가드)]");
{
  const calls = { auto: 0, folder: 0, picker: 0 };
  const registry = {};
  const mkEl = () => { const e = { style: {}, dataset: {}, value: "", _t: "", classList: { _c: new Set(), add(c) { this._c.add(c); }, remove(c) { this._c.delete(c); }, toggle(c, f) { if (f) this._c.add(c); else this._c.delete(c); }, contains(c) { return this._c.has(c); } }, addEventListener() {}, setAttribute() {}, focus() {}, querySelector() { return null; }, querySelectorAll() { return []; } }; Object.defineProperty(e, "textContent", { get() { return this._t; }, set(v) { this._t = String(v); } }); return e; };
  const document = { getElementById: (id) => (registry[id] = registry[id] || mkEl()), createElement: () => mkEl(), querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
  let t = 1000;
  class SeqDate extends Date { static now() { return t++; } }
  const State = { checkboard: true, mode: "designer", regMode: "checkboard", placing: true, pdfPage: 1, pins: [], checkboardStart: {}, activePin: null };
  const sb = { console, document, window: { addEventListener() {} }, navigator: { onLine: true }, SyncQueue: { count: () => Promise.resolve(0) }, State, JSON, Array, Map, Set, Math, Date: SeqDate,
    UI: { $: (id) => document.getElementById(id), hide() {}, text() {}, renderPinList() {}, renderPinsOnMap() {} }, Prompt: { toast() {} },
    MapCtrl: { viewportToPercent: () => ({ x: 40, y: 40 }) },
    PhotoBatch: { autoConnectPin: () => { calls.auto++; } }, PhotoFolder: { handlePinPlaced: async () => { calls.folder++; return true; } } };
  vm.createContext(sb);
  vm.runInContext(SRC.series + "\n" + SRC.app + "\n;globalThis.__App = App;", sb);
  const App = sb.__App;
  App._openPinMediaPicker = () => { calls.picker++; };
  App._handlePlaceClick({ clientX: 10, clientY: 10 });
  App._handlePlaceClick({ clientX: 20, clientY: 20 });
  ok(State.pins.length === 2 && calls.auto === 0 && calls.folder === 0 && calls.picker === 0, "N6 CHECKER 배치 2회 → 핀 2개 · 사진창 호출 0 — " + JSON.stringify(calls));
  State.regMode = "photo";
  App._handlePlaceClick({ clientX: 30, clientY: 30 });
  await new Promise((r) => setTimeout(r, 10));
  ok(calls.folder === 1, "N6b 대조군 360 모드 배치 → PhotoFolder 먼저 물음(1회) — " + JSON.stringify(calls));
  const labels = State.pins.map((p) => p.label);
  ok(JSON.stringify(labels) === JSON.stringify(["1", "2", "3"]), "N6c CHECKER 1·2 → 360 3(한 번호 공간으로 이어짐) — " + JSON.stringify(labels));
}

console.log("\n[N7·N8 서버 링크 필터(src/index.tsx 원문 + 실 pinImageRefs)]");
{
  const a = SRC.srv.indexOf("function pinHas360Media(");
  const b = SRC.srv.indexOf("function mapDeploymentFor(");
  ok(a > 0 && b > a, "N7-0 서버 필터 함수 원문 위치 확인");
  const tmpDir = path.join(ROOT, ".tmp", "p155-" + process.pid);
  fs.mkdirSync(tmpDir, { recursive: true });
  const entry = path.join(tmpDir, "srv.ts");
  fs.writeFileSync(entry, "import { pinImageRefs } from " + JSON.stringify(path.join(ROOT, "src/lib/aiVision.ts").replace(/\\/g, "/")) + ";\n" +
    SRC.srv.slice(a, b) + "\nexport { pinHas360Media, filterPinArrByLinkMode, filterPinsByLinkMode };\n");
  const out = path.join(tmpDir, "srv.mjs");
  await esbuild.build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" });
  const S = await import(pathToFileURL(out).href);
  const pins = [
    { id: 1, checkboard: true },                                   // 체커 · 사진 없음
    { id: 2, checkboard: true, imageId: "img2" },                  // 🔴 체커 · 사진 일괄 등록됨
    { id: 3, imageUrl: "/api/r2/object/a/b.jpg" },                 // 360 · R2 사진
    { id: 4 },                                                     // 360 · 사진 없음
    { id: 5, timeline: [{ imageId: "old" }] },                     // 이력 사진만
    { id: 6, videoUrl: "https://x/v.mp4" },                        // 360 영상
  ];
  const ids360 = JSON.parse(S.filterPinsByLinkMode(JSON.stringify(pins), "360")).map((p) => p.id);
  ok(JSON.stringify(ids360) === "[2,3,5,6]", "N7 360 링크 = 미디어 보유 핀(체커+사진 2 포함 · 사진 없는 1·4 제외) — " + JSON.stringify(ids360));
  const raw = JSON.stringify(pins);
  ok(S.filterPinsByLinkMode(raw, "checker") === raw && S.filterPinsByLinkMode(raw, null) === raw, "N8 checker/null 모드 = 원문 그대로(전 핀)");
  ok(S.filterPinsByLinkMode("not json", "360") === "not json", "N8b 파싱 실패 = 원본 유지(조용한 손상 0)");
  const am = SRC.srv.slice(SRC.srv.indexOf("function aliasMeta("), SRC.srv.indexOf("function mapAliasedFor("));
  ok(/filterPinArrByLinkMode\(parsePins\(h\.home\.pins\), linkMode\)/.test(am) && !/!!p\.checkboard ===/.test(am), "N7b aliasMeta 가 같은 정본 filterPinArrByLinkMode 사용(복붙 규칙 0)");
  ok(!/\(p\.checkboard \? 'c:' : 'p:'\)/.test(SRC.srv), "N7c pinMigrationPlan 번호 겹침 키에서 계열 접두 제거");
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("\n[N9 matchKey — 표시 전용 3자리 · 절단 오매칭 가드]");
{
  const { PF } = loadPF({ pins: [] });
  ok(PF._matchKey(1) === "001" && PF._matchKey(12) === "012", "N9 matchKey(1)=\"001\" · matchKey(12)=\"012\"");
  ok(PF.isMatch(1, "IMG_1001.jpg", new Set([1, 1001])) === false, "N9b 1001 이 실제 핀이면 1 ↔ 1001.jpg 불일치(진짜 주인 우선)");
  ok(PF.isMatch(1001, "IMG_1001.jpg", new Set([1, 1001])) === true && PF.isMatch(1, "001.jpg", new Set([1])) === true, "N9c 1001↔1001.jpg · 1↔001.jpg 일치");
}

// 🔴 [WO 20261019-unifymode] 계약 반전 — 전: 사진 붙은 체커 핀 = CHECKBOARD_COLOR(주황) 유지 / 후: 체커 메타는 색 축 아님 → 같은 사진 상태의 일반 핀과 같은 스타일
console.log("\n[N10 색 통일 — 사진 붙은 체커 핀 = 사진 있는 일반 핀]");
{
  const PS = loadSeries();
  const st = PS.markerStyle({ checkboard: true, imageId: "x" });
  const plain = PS.markerStyle({ imageId: "x" });
  ok(st.kind === "content" && st.filled === true && JSON.stringify(st.colors) === JSON.stringify(plain.colors) && st.dash === plain.dash, "N10 체커+사진 = 일반 사진 핀과 같은 kind·색·링(주황 체커 쌍 아님)");
  const e1 = PS.markerStyle({ checkboard: true }), e2 = PS.markerStyle({});
  ok(e1.kind === "empty" && JSON.stringify(e1.colors) === JSON.stringify(e2.colors) && e1.dash === e2.dash, "N10b 체커 메타·사진 없음 = 일반 빈 핀과 같은 스타일");
}

/* ══ 번호 리셋 정본 ══ */
console.log("\n[R1 리셋 미리보기 — 위치순(위→아래, 왼→오)]");
const RPINS = () => [
  { id: "a", page: 1, x: 80, y: 10, checkboard: true, label: "103" },
  { id: "b", page: 1, x: 10, y: 10, label: "7" },
  { id: "c", page: 1, x: 50, y: 60, checkboard: true, label: "101", labelManual: true },
  { id: "d", page: 1, x: 20, y: 40, label: "102", imageId: "img_d" },
  { id: "o", page: 2, x: 1, y: 1, label: "1" },
];
{
  const PS = loadSeries();
  const pins = RPINS();
  const before = JSON.stringify(pins);
  const plan = PS.resetPlan(pins, 1, { order: "pos" });
  ok(plan.ok && plan.changes.map((c) => c.id + ":" + c.oldLabel + ">" + c.newLabel).join(",") === "b:7>1,a:103>2,d:102>3,c:101>4",
    "R1 위치순 미리보기 b(10,10)→1 · a(80,10)→2 · d(20,40)→3 · c(50,60)→4 — " + plan.changes.map((c) => c.id + ">" + c.newLabel).join(","));
  ok(JSON.stringify(pins) === before, "R1b 미리보기는 pins 무변형");
  ok(plan.changed === 4 && plan.collisions.size === 0, "R1c 실제 변경 4 · 겹침 0");
}
console.log("\n[R2 기존 번호 순서]");
{
  const PS = loadSeries();
  const plan = PS.resetPlan(RPINS(), 1, { order: "no" });
  ok(plan.changes.map((c) => c.id).join(",") === "b,c,d,a", "R2 번호순 7,101,102,103 → b,c,d,a — " + plan.changes.map((c) => c.id).join(","));
}
console.log("\n[R3 구역(부분) 리셋 — 범위 밖 같은 페이지 핀과 겹침 표시]");
{
  const PS = loadSeries();
  const pins = RPINS();
  const plan = PS.resetPlan(pins, 1, { targets: pins.filter((p) => p.id === "c" || p.id === "d") });
  pins.push({ id: "e", page: 1, x: 5, y: 5, label: "2" });
  const plan2 = PS.resetPlan(pins, 1, { targets: pins.filter((p) => p.id === "c" || p.id === "d") });
  ok(plan.changes.length === 2 && plan.collisions.size === 0, "R3 대상 2개만 1·2 로 · 겹침 0");
  ok(plan2.collisions.size === 1 && plan2.collisions.has("e"), "R3b 범위 밖 핀 e(2) 와 새 번호 2 겹침 → 표시");
}
console.log("\n[R4 적용 — 라벨 1…n · id 불변 · 되돌리기 스냅샷]");
{
  const PS = loadSeries();
  const pins = RPINS();
  const plan = PS.resetPlan(pins, 1, { order: "pos" });
  const changed = PS.applyReset(pins, plan, "B1", 5000);
  const byId = Object.fromEntries(pins.map((p) => [p.id, p]));
  ok(changed.length === 4 && ["b", "a", "d", "c"].map((id) => byId[id].label).join(",") === "1,2,3,4", "R4 라벨 1,2,3,4 연속");
  ok(byId.d.imageId === "img_d" && byId.o.label === "1" && !byId.o.numReset, "R4b 사진 연결 그대로 · 다른 페이지 핀 무변경");
  ok(byId.a.numReset && byId.a.numReset.from === "103" && byId.a.numReset.batch === "B1" && byId.c.numReset.fromManual === true && byId.a.labelManual === true,
    "R4c 스냅샷(from·fromManual·batch) 기록 + labelManual(동시 생성 재채번 보호)", byId.a.numReset);
  ok(PS.duplicateNoIds(pins, 1).size === 0, "R4d 리셋 후 그 페이지 중복 0");
}
console.log("\n[R5 되돌리기 — 옛 라벨 복원 · 리셋 뒤 고친 핀은 건너뜀]");
{
  const PS = loadSeries();
  const pins = RPINS();
  PS.applyReset(pins, PS.resetPlan(pins, 1, { order: "pos" }), "B1", 5000);
  const byId = Object.fromEntries(pins.map((p) => [p.id, p]));
  byId.d.label = "50";   // 리셋 뒤 사용자가 직접 고침
  const last = PS.lastResetBatch(pins, 1);
  ok(last && last.batch === "B1" && last.count === 4, "R5 최근 리셋 묶음 B1 · 4개", last);
  const up = PS.undoResetPlan(pins, last.batch);
  ok(up.restore.length === 3 && up.skipped.length === 1 && up.skipped[0] === "d", "R5b 복원 3 · 건너뜀 1(d)");
  PS.applyUndoReset(pins, up);
  ok(byId.b.label === "7" && byId.a.label === "103" && byId.c.label === "101" && byId.d.label === "50", "R5c 옛 라벨 복원(7·103·101) · d 는 사용자 값 50 유지");
  ok(byId.c.labelManual === true && byId.a.labelManual === undefined && !byId.a.numReset && !byId.d.numReset, "R5d 수동 표시 원래대로(c 유지·a 제거) · 스냅샷 제거");
  ok(PS.lastResetBatch(pins, 1) === null, "R5e 되돌린 뒤 되돌릴 리셋 없음");
}

console.log("\n[R6 NumReset 권한 사유 — 열람자·비소유자·오프라인 0]");
{
  const mkNR = (o) => {
    const sb = { console, JSON, Map, Set, Math, Number, String, Array, Object, Date, RegExp,
      State: Object.assign({ mode: "designer", pdfPage: 1, fileType: "pdf", pins: [{ id: 1, page: 1, label: "5" }] }, o.state || {}),
      Auth: Object.assign({ readonly: false }, o.auth || {}), navigator: { onLine: o.online !== false },
      UI: { permCheck: () => o.perm || "" } };
    vm.createContext(sb);
    vm.runInContext(SRC.series + "\n" + SRC.nr + "\n;globalThis.__NR = NumReset;", sb);
    return sb.__NR;
  };
  ok(mkNR({}).reason() === "", "R6 소유자·온라인·편집 화면 → 사용 가능");
  ok(/열람/.test(mkNR({ state: { mode: "viewer" } }).reason()) && /열람/.test(mkNR({ auth: { readonly: true } }).reason()), "R6b 열람자(뷰어·readonly) → 비활성 사유");
  ok(mkNR({ perm: "소유자·관리자 전용" }).reason() === "소유자·관리자 전용", "R6c 비소유자 → UI.permCheck(owner) 사유 그대로");
  ok(/오프라인/.test(mkNR({ online: false }).reason()), "R6d 오프라인 → 비활성 사유");
  ok(/되돌릴/.test(mkNR({}).undoReason()), "R6e 리셋 기록 없으면 되돌리기 비활성 사유");
}

console.log(failed === 0 ? "\nALL PASS" : "\n" + failed + " FAILED");
process.exit(failed === 0 ? 0 : 1);
