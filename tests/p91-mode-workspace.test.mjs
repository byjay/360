/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p91-mode-workspace.test.mjs)
 *
 * [WO 20260930-fixmode] 마스터(같은 요구 두 번째): "모드를 체커와 360으로 구분 — 완전히 다른 프로젝트처럼.
 *   별도의 트리부터 구분해" / "프로젝트 하단 최상단에 체커와 360으로 구분하고 그 하위로 구역-영역으로 가자"
 * 재현(지휘자, 라이브 103a60fc sunbo): [CHECKER]/[360] 세그먼트를 바꿔도 트리·지도 핀·필터 칩이 완전히 동일.
 *
 * 설계(SoT 1곳 = 01b_PinSeries.js DECK_MODES/activeMode/filter()/modePins/deckInMode/withDeckMode):
 *  · 모드 = 작업공간 — 활성 모드(State.regMode)의 핀 계열만 지도 마커·미니맵(filter())·칩·핀 목록·"N PINS"에 보인다.
 *  · 트리: 프로젝트 → CHECKER / 360 → 구역 → 영역 → 핀(그 모드 계열만). 모드 노드 클릭 = App._setRegMode.
 *  · decks.mode(마이그레이션 0029): 'checker' | '360' | NULL. NULL(기존 구역)은 두 모드 트리에 모두 보인다(유실 0).
 *  · 새 구역 = 활성 모드 태그, 영역 = 부모 구역 mode 상속(부모 NULL 이면 활성 모드). 서버는 그 외 값 400.
 *
 * Part A  (vm · 실 소스 01b_PinSeries.js + 11_UI.js + 12_ProjectHub.js)  — 트리·지도·칩·목록·태그
 * Part B  (실 워커 src/index.tsx esbuild + 실 D1 Miniflare + 실 마이그레이션 전부) — mode 검증·상속·NULL 보존
 * Part C  (실 Chrome · 실 CSS 3파일) — 전환 전·후 스크린샷(.tmp/fixmode/) + 모드 노드 글자 대비 실측
 * 뮤테이션 M1~M8 — 각각 해당 검사가 FAIL 로 뒤집혀야 PASS.
 *
 * 🔴 [WO 20261015-numunify 계약 반전 — 설계 .tmp/design-numunify.md §1-1·P1] 마스터: "체크 모드와 360 모드를 번호를
 *   따로 구분한 걸 하나로 합치고 … 체크보드 모드에서 번호만 일괄적으로 찍고 나서 사진폴더 … 일괄적으로".
 *   CHECKER 에서 찍은 핀이 360 에서 안 보이면 사진 일괄 등록 대상이 0건이 되므로 **모드는 더 이상 가시성을 잠그지 않는다**.
 *   전·후 대조(G-4⑧):
 *     A1 지도 마커  종전 CHECKER 3 · 360 2      → 새 5 · 5(전 핀)
 *     A2 필터 칩    종전 활성 모드 칩 1개만      → 새 두 칩 대칭 [CHECKER 3][360 2](독립 토글)
 *     A3 N PINS     종전 '3 PINS' · '2 PINS'     → 새 '5 PINS' · '5 PINS'
 *     A7 트리 잎    종전 [#1,#2,#3] · [#P1,#P2]  → 새 [#1,#2,#3] · [#4,#5](생성 계열 묶음은 유지 · 번호는 한 공간 · P 접두 폐기)
 *     A2-x(0개)    종전 360 모드 지도 0 · [360 0]만 → 새 지도 2(체커 핀 보임) · [CHECKER 2][360 0] 대칭
 *   M1/M4/A2 뮤테이션 방향 반전 — 이제 "모드 게이트 **복구**"가 뮤테이션이다(각각 EXIT=1 이어야 한다).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";
import { Miniflare } from "miniflare";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const uiSrc = rd("public/js/modules/11_UI.js");
const seriesSrc = rd("public/js/modules/01b_PinSeries.js");
const hubSrc = rd("public/js/modules/12_ProjectHub.js");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };
const mutate = (src, needle, repl, name) => {
  const out = src.replace(needle, repl);
  if (out === src) throw new Error("뮤테이션 대상 문자열을 찾지 못함: " + name);
  return out;
};

/* ── 최소 DOM 목(p73 과 동일 패턴) ── */
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
    contains: (c) => set.has(c), _set: set
  };
}
function makeEl(tag) {
  const el = {
    tagName: tag || "div", style: {}, dataset: {}, title: "", value: "", disabled: false, type: "",
    _text: "", _html: "", _children: [], _handlers: {},
    appendChild(c) { this._children.push(c); return c; },
    insertBefore(c) { this._children.unshift(c); return c; },
    insertAdjacentHTML() {},
    setAttribute(k, v) { this.dataset["attr_" + k] = String(v); },
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    querySelector() { return makeEl(); }, querySelectorAll() { return []; }, closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
  };
  Object.defineProperty(el, "textContent", { get() { return this._text; }, set(v) { this._text = v == null ? "" : String(v); } });
  Object.defineProperty(el, "innerHTML", { get() { return this._html; }, set(v) { this._html = String(v); if (v === "") this._children = []; } });
  Object.defineProperty(el, "className", {
    get() { return Array.from(this.classList._set).join(" "); },
    set(v) { this.classList = makeClassList(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c)); }
  });
  el.classList = makeClassList();
  return el;
}
function makeDoc() {
  const registry = {};
  return { registry, document: {
    getElementById: (id) => (registry[id] = registry[id] || makeEl()),
    createElement: (t) => makeEl(t), querySelectorAll: () => [], addEventListener() {}
  } };
}
const has = (el, cls) => new RegExp("(^| )" + cls + "( |$)").test(el.className || "");
const kidsOf = (el) => (el && el._children || []).find((c) => has(c, "tree-children"));
const pick = (el, cls) => (el && el._children || []).filter((c) => has(c, cls));
const headOf = (el) => (el._children || []).find((c) => has(c, "tree-node"));
const labelOf = (node) => { const m = /class="tree-label">([^<]*)</.exec(headOf(node)._html); return m ? m[1] : ""; };
function findAll(el, cls, out) {
  out = out || [];
  (el && el._children || []).forEach((c) => { if (has(c, cls)) out.push(c); findAll(c, cls, out); });
  return out;
}

/* ── 픽스처 ──
   구역: floor(mode NULL — 0029 이전 기존 구역, sunbo 역) · 체커구역(checker) + 그 영역 체커영역(checker) · 360구역(360)
   핀(floor 도면 dep1 에 로드됨): CHECKER 계열 3개(1,2,3) + 360 계열 2개 */
function fixture(regMode, viewer) {
  const decks = [
    { id: "dNull", name: "floor", mode: null, deployment_id: "dep1", parent_id: null },
    { id: "dChk", name: "체커구역", mode: "checker", deployment_id: "dep2", parent_id: null },
    { id: "dChkR", name: "체커영역", mode: "checker", deployment_id: "dep2", parent_id: "dChk" },
    { id: "d360", name: "360구역", mode: "360", deployment_id: "dep3", parent_id: null }
  ];
  const State = {
    mode: viewer ? "viewer" : "designer", regMode, pdfPage: 1, pdfPages: 1, currentDeploymentId: "dep1",
    activePin: null, zones: [], zoneView: null, editMode: false, placing: false,
    pins: [
      { id: "c1", page: 1, x: 10, y: 10, checkboard: true, label: "1" },
      { id: "c2", page: 1, x: 20, y: 20, checkboard: true, label: "2" },
      { id: "c3", page: 1, x: 30, y: 30, checkboard: true, label: "3" },
      { id: "q1", page: 1, x: 60, y: 60, label: "현장A" },
      { id: "q2", page: 1, x: 70, y: 70, label: "현장B" }
    ]
  };
  const calls = { setRegMode: [], selectDeck: [] };
  const Projects = { decks, currentProject: { id: "prj1", name: "sunbo" }, currentDeck: decks[0],
    selectDeck(d) { calls.selectDeck.push(d.id); } };
  const App = { _setRegMode: (m) => calls.setRegMode.push(m), pinHasContent: () => false, focusPin() {}, isDeckUnsaved: () => false };
  return { State, Projects, App, calls };
}
function runUI(fx, srcs) {
  const { document, registry } = makeDoc();
  const sandbox = { console, document, JSON, Map, Set, Math, Number, String, Array, Object, Date, RegExp,
    localStorage: { getItem: () => null, setItem() {} },
    State: fx.State, Projects: fx.Projects, App: fx.App,
    Zones: { _contains: () => false, focus() {}, render() {} }, PinActionPop: { open() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext((srcs.series || seriesSrc) + "\n" + (srcs.ui || uiSrc) + "\n" + (srcs.hub || hubSrc) +
    "\n;globalThis.__UI = UI; globalThis.__PS = PinSeries; globalThis.__HUB = ProjectHub;", sandbox);
  return { UI: sandbox.__UI, PS: sandbox.__PS, HUB: sandbox.__HUB, registry };
}
/** 한 모드 상태를 전부 렌더하고 관측값을 뽑는다.
 *  [WO 20260930-moderole] 🔴 마스터 2차 지시로 88e52ff(프로젝트→모드→구역) 가지 구조를 뒤집는다 —
 *  구역·영역은 두 모드가 공유하는 한 벌만 렌더(중복 0). 모드 분리는 로드된 구역(floor, 픽스처의
 *  currentDeck)의 맨 안쪽 잎(.tree-mode-leaf-checker/.tree-mode-leaf-360)에서만 일어난다. */
function observe(regMode, srcs, viewer) {
  const fx = fixture(regMode, viewer);
  const { UI, PS, HUB, registry } = runUI(fx, srcs || {});
  UI.renderPinsOnMap();
  UI.renderPinList(); // 내부에서 renderTree() 까지 호출
  const markers = (registry["pins-layer"]._children || []).length;
  const chips = registry["pin-filter-bar"]._html;
  const badge = registry["pin-count-badge"]._text;
  const proj = pick(registry["side-tree"], "tree-project")[0];
  const decks = pick(kidsOf(proj), "tree-deck"); // 공유 — 모드 가지 없이 프로젝트 바로 아래 한 벌
  const deckNames = decks.map(labelOf);
  const floorDeck = decks.find((d) => labelOf(d) === "floor"); // 픽스처의 currentDeck(로드됨)
  const leafInfo = {};
  if (floorDeck) {
    pick(kidsOf(floorDeck), "tree-mode-leaf").forEach((lw) => {
      const tag = lw.dataset.mode;
      leafInfo[tag] = {
        head: headOf(lw), open: has(lw, "open"),
        pins: findAll(lw, "tree-node-pin").map((n) => (/tree-pin-no">([^<]*)</.exec(n._html) || [])[1])
      };
    });
  }
  const chkDeck = decks.find((d) => labelOf(d) === "체커구역");
  const regionsOfChk = chkDeck ? pick(kidsOf(chkDeck), "tree-region").map(labelOf) : [];
  const hubHtml = HUB._renderDeckTreeHtml.call(Object.assign(Object.create(HUB), { _deckTreeCache: { prj1: fx.Projects.decks } }), { id: "prj1" });
  return { fx, PS, markers, chips, badge, deckNames, leafInfo, regionsOfChk, hubHtml };
}

/* ══════════════════ Part A — 모드 = 작업공간 (실 소스) ══════════════════ */
console.log("\n[Part A · CHECKER ↔ 360 전환 시 지도·칩·목록·트리 분리]");
function checkA(label, srcs) {
  const r = { checks: [] };
  const push = (c, l) => r.checks.push([c, l]);
  const C = observe("checkboard", srcs);
  const P = observe("photo", srcs);
  push(C.markers === 5 && P.markers === 5, `A1 지도 마커: CHECKER=${C.markers}(기대 5) · 360=${P.markers}(기대 5) — 모드 무관 전 핀`);
  const twoChips = (h) => /data-series="checkboard"[\s\S]*?zpager-cnt">3</.test(h) && /data-series="content"[\s\S]*?zpager-cnt">2</.test(h);
  push(twoChips(C.chips) && twoChips(P.chips),
    "A2 필터 칩·카운트: 두 모드 모두 [CHECKER 3][360 2] 두 칩(생성 계열별 개수)");
  push(C.badge === "5 PINS" && P.badge === "5 PINS", `A3 핀 목록 "N PINS": CHECKER='${C.badge}' · 360='${P.badge}'(기대 둘 다 5)`);
  // [WO 20260930-moderole] 🔴 A4~A9 재작성 — 구역은 두 모드가 공유(중복 0), 모드 분리는 로드된
  // 구역(floor)의 맨 안쪽 잎(CHECKER/360)에서만 일어난다(88e52ff 모드 가지 제거, 마스터 2차 지시).
  push(C.deckNames.join() === "floor,체커구역,360구역" && P.deckNames.join() === C.deckNames.join(),
    `A4 트리: 구역은 모드 무관 한 벌만(중복 0) — CHECKER 관찰=[${C.deckNames}] · 360 관찰=[${P.deckNames}] 동일`);
  push(!!C.leafInfo.checker && has(C.leafInfo.checker.head, "active") && !has(C.leafInfo["360"].head, "active"),
    "A5 CHECKER 모드 → floor 구역의 CHECKER 잎만 강조(.active)");
  push(!!P.leafInfo["360"] && has(P.leafInfo["360"].head, "active") && !has(P.leafInfo.checker.head, "active"),
    "A5 360 모드 → floor 구역의 360 잎만 강조(.active)");
  push(C.regionsOfChk.join() === "체커영역" && P.regionsOfChk.join() === "체커영역",
    `A6 영역은 부모 구역 아래(체커구역 → 체커영역) — 두 모드 관찰 모두 동일(공유), CHECKER=[${C.regionsOfChk}] · 360=[${P.regionsOfChk}]`);
  push(C.leafInfo.checker.pins.join() === "#1,#2,#3" && C.leafInfo["360"].pins.join() === "#4,#5",
    `A7 floor 구역(모드 무관 한 벌)의 CHECKER 잎=[${C.leafInfo.checker.pins}] · 360 잎=[${C.leafInfo["360"].pins}] — 생성 계열 묶음 유지 · 번호는 한 공간(유실 없음)`);
  push(C.leafInfo.checker.open && !C.leafInfo["360"].open, "A8 CHECKER 모드 → floor 의 CHECKER 잎만 기본 펼침(360 잎은 접힘)");
  push(!P.leafInfo.checker.open && P.leafInfo["360"].open, "A8 360 모드 → floor 의 360 잎만 기본 펼침");
  // 잎 클릭 = App._setRegMode (상단 세그먼트와 같은 SoT)
  C.leafInfo["360"].head._handlers.click.forEach((fn) => fn({ target: { closest: () => null } }));
  push(C.fx.calls.setRegMode.join() === "photo", `A9 CHECKER 모드에서 floor 의 [360] 잎 클릭 → App._setRegMode('photo') → [${C.fx.calls.setRegMode}]`);
  // 뷰어(모드 없음)는 분리 없이 전부
  const V = observe("checkboard", srcs, true);
  push(V.markers === 5, `A10 뷰어(편집 모드 아님) → 분리 없음, 마커 5 (실제 ${V.markers})`);
  // 허브 카드 트리도 같은 구조 — 구역 공유(중복 0) + 맨 안쪽 잎(CHECKER/360)
  const h = C.hubHtml;
  // [주의] "floor"·data-deck-id="dNull" 은 구역 행 자체뿐 아니라 그 맨 안쪽 잎(CHECKER/360,
  // 같은 구역을 가리키는 게 정상)에도 나타난다. 중복 판정은 "구역 행"(class="hub-tree-deck")
  // 자체의 등장 횟수로 한정한다(§ fixture dNull=floor).
  const floorRowCount = (h.match(/class="hub-tree-deck" data-act="deck-open" data-deck-id="dNull"/g) || []).length;
  push(/hub-tree-decks/.test(h) && /floor/.test(h) && /체커구역/.test(h) && /체커영역/.test(h) && /360구역/.test(h)
    && floorRowCount === 1 && /hub-tree-leaf-modes/.test(h) && />CHECKER</.test(h) && />360</.test(h),
    `A11 허브 카드 트리: 구역 공유(floor·체커구역>체커영역·360구역 한 벌, floor 행 ${floorRowCount}회=중복 0) + 맨 안쪽 잎(CHECKER/360)`);
  // 새 구역·영역 태그
  const PS = C.PS;
  const t1 = PS.withDeckMode({ name: "a" });
  const t2 = PS.withDeckMode({ name: "b" }, { id: "dChk", mode: "checker" });
  const t3 = PS.withDeckMode({ name: "c" }, { id: "dNull", mode: null });
  push(t1.mode === "checker" && t2.mode === "checker" && t3.mode === "checker", "A12 CHECKER 모드: 새 구역 mode='checker' · 영역은 부모 상속");
  const PS3 = P.PS;
  const u2 = PS3.withDeckMode({ name: "b" }, { id: "dChk", mode: "checker" });
  const u3 = PS3.withDeckMode({ name: "c" }, { id: "dNull", mode: null });
  push(PS3.withDeckMode({ name: "a" }).mode === "360" && u2.mode === "checker" && u3.mode === "360",
    `A13 360 모드: 새 구역 '360' · 태그된 부모(checker) 아래 영역은 부모 상속('${u2.mode}') · NULL 부모 아래는 활성 모드('${u3.mode}')`);
  return r.checks;
}
{
  const checks = checkA("정상");
  checks.forEach(([c, l]) => ok(c, l));
}
/* 뮤테이션 — 각각 지정 검사가 FAIL 로 뒤집혀야 한다 */
function mutation(name, srcs, mustFailPrefix) {
  let checks;
  try { checks = checkA(name, srcs); } catch (e) { ok(true, name + " → 예외로 깨짐(" + String(e.message).slice(0, 60) + ")"); return; }
  const broke = checks.filter(([c, l]) => !c && l.startsWith(mustFailPrefix));
  ok(broke.length > 0, name + " → " + mustFailPrefix + " FAIL 로 뒤집힘(" + broke.length + "건)");
}
console.log("\n[Part A 뮤테이션]");
// [WO 20261015-numunify] M1 방향 반전 — filter() 의 모드 게이트를 **복구**하면 A1(전 핀 보임)이 깨져야 한다
mutation("M1 filter() 모드 게이트 복구(구 작업공간 잠금)",
  { series: mutate(seriesSrc, "      if (!this._filter) this._filter = { checkboard: true, content: true };\n      return this._filter;",
    "      const act = this.activeSeries();\n      if (act) return { checkboard: act === \"checkboard\", content: act === \"content\" };\n      if (!this._filter) this._filter = { checkboard: true, content: true };\n      return this._filter;", "M1") }, "A1");
/* [WO 20260930-moderole] 🔴 구 M2/M3 은 deckInMode()로 구역을 모드 가지에 배분하던 시절의
 * 뮤테이션이다. 88e52ff 모드 가지를 제거하며 트리 렌더 경로가 deckInMode()를 더 이상 부르지
 * 않으므로(구역 공유, 필터 없음) 그 결함을 트리에서 재현할 방법이 없다(폐기 — 대체 커버리지는
 * tests/p62-tree-3level.test.mjs 뮤테이션 ⓕ, 구역 중복 렌더 재도입 → 그 테스트의 ①이 실패). */
// [WO 20261015-numunify] M4 방향 반전 — inMode() 의 활성 모드 잠금을 **복구**하면 A3(N PINS 전 핀)이 깨져야 한다
mutation("M4 inMode 활성 모드 잠금 복구(핀 목록 분리 재도입)",
  { series: mutate(seriesSrc, "      if (series === undefined || series === null) return true;",
    "      if (series === undefined || series === null) { const s = this.activeSeries(); return !s || this.seriesOf(pin) === s; }", "M4") }, "A3");
mutation("M5 영역 부모 mode 상속 제거",
  { series: mutate(seriesSrc, "const tag = (parentDeck && parentDeck.mode) || this.deckModeTag();", "const tag = this.deckModeTag();", "M5") }, "A13");
mutation("M6 트리 핀 나열을 모드 계열로 거르지 않음(모드 잎 안에서 전체 핀을 나열)",
  { ui: mutate(uiSrc, "renderScopedPins(mk, modePinsHere);", "renderScopedPins(mk, pins);", "M6") }, "A7");
mutation("M7 모드 잎(CHECKER/360) 렌더 제거 → 구역 로드돼도 계열 분리 없음",
  { ui: mutate(uiSrc, "MODES.forEach((m) => {\n              const modeAll", "[].forEach((m) => {\n              const modeAll", "M7") }, "A7");

/* ══════════════════ Part B — 서버 + 실 D1 ══════════════════ */
console.log("\n[Part B · 실제 워커(src/index.tsx) + 실제 D1(Miniflare) — decks.mode]");
const MIG_DIR = path.join(ROOT, "migrations");
const MIGS = fs.readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
ok(MIGS.includes("0029_deck_mode.sql"), "B0 마이그레이션 0029_deck_mode.sql 존재");
const stmtsOf = (file) => fs.readFileSync(path.join(MIG_DIR, file), "utf8").replace(/--[^\n]*/g, "")
  .split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
async function buildWorker(transform) {
  const out = path.join(os.tmpdir(), "p91-worker-" + process.pid + "-" + Math.random().toString(36).slice(2) + ".mjs");
  const plugins = transform ? [{ name: "p91-mutate", setup(b) { b.onLoad({ filter: /index\.tsx$/ }, (a) => ({ contents: transform(fs.readFileSync(a.path, "utf8")), loader: "tsx" })); } }] : [];
  await esbuild.build({ entryPoints: [path.join(ROOT, "src/index.tsx")], bundle: true, format: "esm", platform: "neutral",
    outfile: out, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent", conditions: ["workerd", "worker", "browser"], plugins });
  return out;
}
const TOK = "local-p91-designer";
const H = { Authorization: "Bearer " + TOK, "Content-Type": "application/json" };
async function apiRun(transform) {
  const script = await buildWorker(transform);
  const mf = new Miniflare({ modules: true, scriptPath: script, d1Databases: { DB: "p91-" + Math.random().toString(36).slice(2) },
    r2Buckets: { R2: "p91r2" }, bindings: { DEMO_LOGIN: "0" }, compatibilityDate: "2025-01-01" });
  try {
    const db = await mf.getD1Database("DB");
    const now = Date.now();
    // 0028 까지 적용 → 기존(마이그레이션 이전) 구역 1행 삽입 → 0029 적용: 기존 행 유실 0·mode NULL 확인
    for (const f of MIGS.filter((f) => f < "0029")) for (const st of stmtsOf(f)) await db.exec(st);
    const seed = [
      ["INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)", ["designer@seastar.test", "설계자", "designssir@gmail.com", now, now]],
      ["INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)", ["designer@seastar.test", "설계자", "seastar.test", "x", "y", now, now]],
      ["INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOK, "designer@seastar.test", now, now + 8.64e7]],
      ["INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)", ["prj_p91", "sunbo", "", "designer@seastar.test", now, now]],
      ["INSERT INTO deployments (id, title, file_name, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)", ["dep_p91", "도면", "floor.pdf", now, now]],
      ["INSERT INTO decks (id, project_id, name, level_no, deployment_id, page, crop, parent_id, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,0)", ["dck_legacy", "prj_p91", "floor", 1, "dep_p91", 1, null, null, now, now]]
    ];
    for (const [q, a] of seed) await db.prepare(q).bind(...a).run();
    for (const f of MIGS.filter((f) => f >= "0029")) for (const st of stmtsOf(f)) await db.exec(st);
    const B = "http://p91.test";
    const post = async (body) => { const r = await mf.dispatchFetch(B + "/api/projects/prj_p91/decks", { method: "POST", headers: H, body: JSON.stringify(body) }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
    const put = async (id, body) => { const r = await mf.dispatchFetch(B + "/api/decks/" + id, { method: "PUT", headers: H, body: JSON.stringify(body) }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
    const out = {};
    out.chk = await post({ name: "체커구역", deployment_id: "dep_p91", mode: "checker" });
    out.m360 = await post({ name: "360구역", deployment_id: "dep_p91", mode: "360" });
    out.bogus = await post({ name: "x", mode: "CHECKER" });
    out.nul = await post({ name: "x", mode: null });
    out.empty = await post({ name: "x", mode: "" });
    out.none = await post({ name: "모드없음", deployment_id: "dep_p91" });
    out.regInherit = await post({ name: "체커영역", deployment_id: "dep_p91", parent_id: out.chk.j.id });
    out.regConflict = await post({ name: "충돌영역", deployment_id: "dep_p91", parent_id: out.chk.j.id, mode: "360" });
    out.regUnderNull = await post({ name: "레거시아래360영역", deployment_id: "dep_p91", parent_id: "dck_legacy", mode: "360" });
    out.putBad = await put(out.none.j.id, { mode: "photo" });
    out.putOk = await put(out.none.j.id, { mode: "360" });
    out.putKeep = await put(out.none.j.id, { name: "이름만변경" });
    const lr = await mf.dispatchFetch(B + "/api/projects/prj_p91/decks", { headers: H });
    out.list = (await lr.json()).data || [];
    return out;
  } finally { await mf.dispose(); try { fs.unlinkSync(script); } catch {} }
}
function checkB(o) {
  const L = (id) => o.list.find((d) => d.id === id) || {};
  return [
    [o.chk.s === 200 && o.chk.j.mode === "checker" && o.m360.s === 200 && o.m360.j.mode === "360", `B1 POST mode 'checker'/'360' → 200 · 저장(${o.chk.j.mode}/${o.m360.j.mode})`],
    [o.bogus.s === 400 && o.nul.s === 400 && o.empty.s === 400, `B2 POST mode 'CHECKER'/null/'' → 400 (실제 ${o.bogus.s}/${o.nul.s}/${o.empty.s})`],
    [o.none.s === 200 && o.none.j.mode === null, `B3 POST mode 미전송 → 200 · NULL(구버전 호환, 실제 ${o.none.s}/${o.none.j.mode})`],
    [o.regInherit.s === 200 && o.regInherit.j.mode === "checker", `B4 영역(mode 미전송) → 부모 'checker' 상속 (실제 ${o.regInherit.s}/${o.regInherit.j.mode})`],
    [o.regConflict.s === 400, `B4 영역 mode 가 부모 태그와 다르면 400 (실제 ${o.regConflict.s})`],
    [o.regUnderNull.s === 200 && o.regUnderNull.j.mode === "360", `B5 NULL 부모 아래 영역은 보낸 활성 모드 저장 (실제 ${o.regUnderNull.s}/${o.regUnderNull.j.mode})`],
    [o.putBad.s === 400 && o.putOk.s === 200 && o.putOk.j.mode === "360" && o.putKeep.s === 200 && L(o.none.j.id).mode === "360",
      `B6 PUT mode 'photo' → 400 · '360' → 200 · 미전송 PUT 은 기존값 유지 (실제 ${o.putBad.s}/${o.putOk.s}/${L(o.none.j.id).mode})`],
    [!!L("dck_legacy").id && L("dck_legacy").mode === null && L("dck_legacy").name === "floor", `B7 0029 이전 기존 구역(floor) 유실 0 · mode NULL (목록 ${o.list.length}행)`]
  ];
}
{
  const o = await apiRun(null);
  checkB(o).forEach(([c, l]) => ok(c, l));
}
console.log("\n[Part B 뮤테이션]");
for (const [name, needle, repl, prefix] of [
  ["M8 서버 mode 허용값 검사 제거(아무 값이나 저장)", "if (typeof v === 'string' && (DECK_MODES as readonly string[]).includes(v)) return { mode: v }", "return { mode: v }", "B2"],
  ["M9 서버 영역 부모 mode 상속 제거", "      return { mode: pm }\n", "", "B4"]
]) {
  try {
    const o = await apiRun((s) => mutate(s, needle, repl, name));
    const broke = checkB(o).filter(([c, l]) => !c && l.startsWith(prefix));
    ok(broke.length > 0, name + " → " + prefix + " FAIL 로 뒤집힘(" + broke.length + "건)");
  } catch (e) { ok(false, name + " 실행 실패: " + e.message); }
}

/* ══════════════════ Part C — 실 Chrome · 실 CSS 3파일 · 스크린샷 ══════════════════ */
console.log("\n[Part C · 실 Chrome 375x812 · CSS 3파일 · 전환 전/후 스크린샷 + 모드 노드 대비]");
const SHOT_DIR = path.join(ROOT, ".tmp", "fixmode");
fs.mkdirSync(SHOT_DIR, { recursive: true });
const require = createRequire("file:///C:/Users/FREE/package.json");
let puppeteer = null;
try { puppeteer = require("puppeteer"); } catch (e) { puppeteer = null; }
if (!puppeteer) { ok(false, "C puppeteer 로드 불가 — 실 브라우저 검증 불가(증거 없는 PASS 금지)"); }
else {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/css/style.css"><link rel="stylesheet" href="/css/seastar-family-tokens.css"><link rel="stylesheet" href="/css/seastar-3d-skin.css">
<style>#stage{display:flex;gap:8px;padding:8px}#map{position:relative;width:170px;height:260px;background:#fff;flex:0 0 auto}#side-tree{width:190px;max-height:none;flex-basis:auto}</style>
</head><body><div id="stage"><div id="tree-wrap"><div id="side-tree" class="side-tree"></div></div>
<div><div id="pin-filter-bar"></div><div id="map"><div id="pins-layer"></div></div><div id="pin-count-badge"></div></div></div>
<div id="hub" class="hub-card"></div><div id="pin-list"></div><div id="pin-empty"></div><div id="section-export"></div><div id="pin-list-count"></div>
<script>
const FX = ${JSON.stringify({ decks: fixture("checkboard").Projects.decks, pins: fixture("checkboard").State.pins })};
window.State = { mode: "designer", regMode: "checkboard", pdfPage: 1, pdfPages: 1, currentDeploymentId: "dep1", activePin: null, zones: [], pins: FX.pins, editMode: false, placing: false };
window.Projects = { decks: FX.decks, currentProject: { id: "prj1", name: "sunbo" }, currentDeck: FX.decks[0], selectDeck() {} };
window.App = { _setRegMode(m) { State.regMode = m; UI.renderPinsOnMap(); UI.renderPinList(); }, pinHasContent: () => false, focusPin() {}, isDeckUnsaved: () => false };
window.Zones = { _contains: () => false, focus() {}, render() {} };
window.Auth = { isDesigner: true, headers() { return {}; } };
</script>
<script src="/bundle.js"></script>
<script>window.__render = () => { UI.renderPinsOnMap(); UI.renderPinList();
  document.getElementById("hub").innerHTML = ProjectHub._renderDeckTreeHtml.call(Object.assign(Object.create(ProjectHub), { _deckTreeCache: { prj1: FX.decks } }), { id: "prj1" }); };</script>
</body></html>`;
  const bundle = seriesSrc + "\n" + uiSrc + "\n" + hubSrc + "\nwindow.PinSeries = PinSeries; window.UI = UI; window.ProjectHub = ProjectHub;\n";
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    if (u === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(html); return; }
    if (u === "/bundle.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(bundle); return; }
    const f = path.join(ROOT, "public", u);
    if (u.startsWith("/css/") && fs.existsSync(f)) { res.writeHead(200, { "content-type": "text/css" }); res.end(fs.readFileSync(f)); return; }
    res.writeHead(404); res.end("nf");
  });
  await listenSafePort(server, "127.0.0.1");
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e.message)));
    await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2 });
    await page.goto("http://127.0.0.1:" + server.address().port + "/", { waitUntil: "load" });
    const measure = () => page.evaluate(() => {
      const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(",").map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
      const bgOf = (el) => { const stack = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } }
        let out = { r: 255, g: 255, b: 255 }; for (let i = stack.length - 1; i >= 0; i--) { const c = stack[i]; out = { r: c.r * c.a + out.r * (1 - c.a), g: c.g * c.a + out.g * (1 - c.a), b: c.b * c.a + out.b * (1 - c.a) }; } return out; };
      const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
      const ratio = (el) => { if (!el) return 0; const fg = parse(getComputedStyle(el).color), bg = bgOf(el); const a = lum(fg), b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
      // [WO 20260930-moderole] 🔴 모드 가지(.tree-mode/.tree-node-mode)는 제거됐다 — 구역은
      // 공유(모드 무관 항상 보임), 모드 분리는 로드된 구역(floor)의 맨 안쪽 잎(.tree-node-mode-leaf)에서만.
      const heads = [...document.querySelectorAll(".tree-node-mode-leaf")];
      return {
        markers: document.querySelectorAll("#pins-layer .pin-marker").length,
        modeHeads: heads.map((h) => h.querySelector(".tree-label").textContent.trim() + (h.classList.contains("active") ? "*" : "")),
        ratioActive: ratio(document.querySelector(".tree-node-mode-leaf.active")),
        ratioIdle: ratio(document.querySelector(".tree-node-mode-leaf:not(.active)")),
        ratioHub: ratio(document.querySelector(".hub-tree-mode-label")),
        // 구역은 공유 — 모드가 바뀌어도 트리에 보이는 구역 목록 자체는 그대로여야 한다(중복·숨김 없음).
        visibleDecks: [...document.querySelectorAll("#side-tree .tree-deck > .tree-node .tree-label")].filter((e) => e.offsetParent).map((e) => e.textContent)
      };
    });
    await page.evaluate(() => window.__render());
    const before = await measure();
    await page.screenshot({ path: path.join(SHOT_DIR, "p91-before-checker.png"), fullPage: true });
    // 트리의 [360] 모드 잎을 실제 클릭 → App._setRegMode('photo') → 재렌더
    await page.evaluate(() => { const h = [...document.querySelectorAll(".tree-node-mode-leaf")].find((b) => /360/.test(b.textContent)); h.click(); });
    const after = await measure();
    await page.screenshot({ path: path.join(SHOT_DIR, "p91-after-360.png"), fullPage: true });
    ok(errs.length === 0, "C0 페이지 오류 없음 " + JSON.stringify(errs.slice(0, 2)));
    // [WO 20261015-numunify] 전·후 대조: 종전 3 → 2(작업공간 분리) → 새 5 → 5(모드가 가시성을 잠그지 않음)
    ok(before.markers === 5 && after.markers === 5, `C1 실 DOM 지도 마커: 전환 전 CHECKER ${before.markers} → 후 360 ${after.markers}(기대 5 → 5)`);
    ok(before.modeHeads.join() === "CHECKER*,360" && after.modeHeads.join() === "CHECKER,360*", `C2 트리 모드 잎(floor 구역 맨 안쪽) 강조 전 [${before.modeHeads}] → 후 [${after.modeHeads}]`);
    // [WO 20260930-moderole] 구역은 공유 — 모드가 바뀌어도(체커↔360) 트리에 보이는 구역 목록은
    // 동일해야 한다(중복도 숨김도 없음). 전환 전후가 완전히 같은 목록인지로 "공유"를 실측한다.
    ok(before.visibleDecks.join() === "floor,체커구역,360구역" && after.visibleDecks.join() === before.visibleDecks.join(),
      `C3 구역 공유 — 모드 전환 전 [${before.visibleDecks}] → 후 [${after.visibleDecks}] (동일해야 정상)`);
    ok(before.ratioActive >= 4.5 && before.ratioIdle >= 4.5 && before.ratioHub >= 4.5,
      `C4 글자 대비(실 CSS 3파일 런타임) 활성 ${before.ratioActive.toFixed(2)} · 비활성 ${before.ratioIdle.toFixed(2)} · 허브 ${before.ratioHub.toFixed(2)} ≥ 4.5`);
    ok(fs.existsSync(path.join(SHOT_DIR, "p91-before-checker.png")) && fs.existsSync(path.join(SHOT_DIR, "p91-after-360.png")), "C5 스크린샷 저장 .tmp/fixmode/p91-{before-checker,after-360}.png");
  } finally { await browser.close(); server.close(); }
}

/* ══════════════════ Part A2 — [추가] 활성 모드 핀 0개일 때 배지·칩 대칭 표시 ══════════════════
 * 재현(지휘자 라이브 실측, 배포 ab4aefec/88e52ff): sunbo 를 360 모드로 바꾸면 지도 핀 0개·트리는
 * 정상인데 "N PINS" 배지는 CHECKER 개수(11) 그대로 남고, 필터 칩 영역은 완전히 빈다(숨김).
 * 근본원인(01b_PinSeries.js renderChips): 칩 카운트를 this.modePins(pins) 로 먼저 거른 뒤 셌다 —
 * 활성 모드 자신의 계열만 셀 수 있게 되어 그 계열이 0개면 c.all 도 0이 되고, 칩바 전체가 숨는다.
 * 수정: seriesCounts 는 항상 페이지 전체(두 계열) 기준으로 세고, 활성 모드일 때만 자기 계열 칩
 * 하나로(0 이어도 표시) 좁힌다. 배지(#pin-count-badge)는 이미 PinSeries.modePins 기준이었다
 * (WO 20260930-fixmode) — 라이브에서 "11" 로 남아 보인 것은 소스 문제가 아니라 그 배포본이
 * 이 SoT 이전 빌드였을 가능성이 높다([Uncertain] 라이브 미확인, 배포는 지휘자 소관).
 * ────────────────────────────────────────────────────────────────────────── */
console.log("\n[Part A2 · 활성 모드 핀 0개 — 배지/칩 대칭 표시(360 0)]");
function fixtureZeroContent(regMode) {
  const decks = [{ id: "dChk", name: "체커구역", mode: "checker", deployment_id: "dep2", parent_id: null }];
  const State = {
    mode: "designer", regMode, pdfPage: 1, pdfPages: 1, currentDeploymentId: "dep2",
    activePin: null, zones: [], zoneView: null, editMode: false, placing: false,
    pins: [
      { id: "c1", page: 1, x: 10, y: 10, checkboard: true, label: "1" },
      { id: "c2", page: 1, x: 20, y: 20, checkboard: true, label: "2" }
    ] // 360(content) 계열 핀은 0개 — 실측 재현과 동일 구성
  };
  const Projects = { decks, currentProject: { id: "prj1", name: "sunbo" }, currentDeck: decks[0], selectDeck() {} };
  const App = { pinHasContent: () => false, focusPin() {}, isDeckUnsaved: () => false };
  return { State, Projects, App };
}
function observeZero(regMode, srcs) {
  const fx = fixtureZeroContent(regMode);
  const { UI, PS, registry } = runUI(fx, srcs || {});
  UI.renderPinsOnMap();
  UI.renderPinList();
  return { chips: registry["pin-filter-bar"]._html, chipsHidden: has(registry["pin-filter-bar"], "hidden"),
    badge: registry["pin-count-badge"]._text, badgeHidden: has(registry["pin-count-badge"], "hidden"), markers: (registry["pins-layer"]._children || []).length };
}
{
  const Z = observeZero("photo");   // 360 모드인데 content 핀이 0개 — [WO 20261015-numunify] 체커 핀 2개는 이제 보인다
  ok(Z.markers === 2, `A2-1 360 모드(360 핀 0개) → 지도 마커 2개(체커 핀 — 모드가 가시성을 잠그지 않음, 실제 ${Z.markers})`);
  ok(!Z.badgeHidden && Z.badge === "2 PINS", `A2-2 "N PINS" 배지 = 전 핀 2개 → '${Z.badge}' hidden=${Z.badgeHidden}`);
  ok(!Z.chipsHidden, `A2-3 필터 칩 바: 360 모드에서 콘텐츠 핀 0개여도 숨지 않음 hidden=${Z.chipsHidden}`);
  ok(/data-series="content"/.test(Z.chips) && /data-series="checkboard"/.test(Z.chips), `A2-4 칩: 두 칩 대칭([CHECKER 2][360 0]) → ${Z.chips}`);
  ok(/data-series="content"[\s\S]*?zpager-cnt">0</.test(Z.chips), `A2-5 칩 카운트 = "360 0"(대칭 표시 유지) → ${Z.chips}`);

  const C2 = observeZero("checkboard"); // 대조군: CHECKER 모드도 같은 두 칩
  ok(/data-series="checkboard"[\s\S]*?zpager-cnt">2</.test(C2.chips) && /data-series="content"/.test(C2.chips),
    `A2-6 대조군 CHECKER 모드(핀 2개) → [CHECKER 2][360 0] → ${C2.chips}`);
}
// [WO 20261015-numunify] 뮤테이션 대상 갱신 — 활성 분기가 "두 칩 대칭(showAll)"으로 바뀌었다. 대칭을 빼고(개수 있는 칩만)
//   되돌리면 360 모드의 [360 0] 칩이 사라져 A2-4/A2-5 가 실패해야 한다.
console.log("\n[Part A2 뮤테이션] renderChips 대칭 표시(showAll) 제거 → A2-4/A2-5 가 실패해야 함");
{
  const needleBranch = "this.SERIES.forEach(s => { if (showAll || c[s]) html += chip(s, this.LABELS[s], c[s] || 0, !!f[s]); });";
  if (seriesSrc.indexOf(needleBranch) < 0) {
    console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)");
    failed++;
  } else {
    const mutatedSeries = seriesSrc.replace(needleBranch, "this.SERIES.forEach(s => { if (c[s]) html += chip(s, this.LABELS[s], c[s], !!f[s]); });");
    const Z2 = observeZero("photo", { series: mutatedSeries });
    const broke = Z2.chipsHidden || !/data-series="content"/.test(Z2.chips) || !/zpager-cnt">0</.test(Z2.chips);
    console.log((broke ? "  PASS(예상대로 실패 재현) " : "  FAIL(뮤테이션에도 통과 — 테스트가 가짜) ") + "chipsHidden=" + Z2.chipsHidden + " chips=" + JSON.stringify(Z2.chips));
    if (!broke) failed++;
  }
}

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
