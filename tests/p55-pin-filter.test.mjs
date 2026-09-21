/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p55-pin-filter.test.mjs)
 *
 * 마스터 신고: "체크보드 모드일 때 역시 핀이 생겨야지", "리스트만 생기고 핀 모양이 안 생기잖아"
 * 지휘자 프로덕션 재현(scan.seastar.work, RICHO E2E, SW·캐시 삭제 후):
 *   초기 진입 #pins-layer.children=0(전부 숨김) → "전체" 클릭 시 5 → "체크보드" 클릭 시 다시 0
 *   (5개 전부 체크보드 계열인데 칩은 "체크보드 5"로 개수를 정확히 센다)
 *
 * 근본원인(경로:라인) — 01b_PinSeries.js filter()/iconFilter() (수정 전):
 *   FILTER_KEY="wm-pin-filter" / ICON_FILTER_KEY="wm-pin-icon-filter" 가 프로젝트/배포본 구분이
 *   없는 "전역" localStorage 키였다. 한 프로젝트에서 계열(kind) 하나를 껐다가 나가면 그 값이
 *   브라우저에 영구히 남아, 전혀 다른 새 프로젝트를 열 때도 조용히 적용된다. "SW·캐시 삭제"는
 *   보통 localStorage 를 지우지 않으므로, 이전 세션에서 저장된 {checkboard:false} 값이 살아남아
 *   RICHO E2E(핀 100%가 checkboard 계열)를 열자마자 전부 숨겨졌다 — "초기 전부 숨김"과
 *   "체크보드 필터가 체크보드를 거른다"는 사실 하나의 근본원인(전역 영구 필터 유령 상태)이다.
 *   개수 계산(counts())과 표시 판정(isVisible())은 이미 같은 kindOf() 정본을 썼다(SoT 자체는
 *   원래도 문제 없었음) — 문제는 그 판정이 참조하는 filter() 값이 세션 밖에서 오염된 것.
 *
 * 조치: filter()/iconFilter() 의 localStorage read/write(영구 저장)를 제거. 매 페이지 로드마다
 *   항상 { content:true, empty:true, checkboard:true }(전체 표시)로 시작 — 다른 프로젝트/이전
 *   세션의 값이 새 프로젝트에 새어 들어올 통로 자체를 없앤다. 판정 함수(kindOf/isVisible/counts)는
 *   그대로 SoT 유지.
 *
 * 실제 모듈 소스(01b_PinSeries.js / 11_UI.js)를 그대로 vm 에 평가한다(목 구현 아님).
 * 뮤테이션 3건이 붙어 있어, 되돌리면 반드시 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const seriesSrc = rd("public/js/modules/01b_PinSeries.js");
const uiSrc     = rd("public/js/modules/11_UI.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 최소 DOM 목 (p54 와 동일 구조 재사용) ───────────────────────── */
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
function makeEl(tag) {
  const el = {
    tagName: tag || "div", style: {}, dataset: {}, title: "", value: "", disabled: false,
    _text: "", _html: "", _children: [], _handlers: {},
    appendChild(c) { this._children.push(c); return c; },
    setAttribute(k, v) { this.dataset["attr_" + k] = String(v); },
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
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
  return {
    registry,
    document: {
      getElementById: (id) => (registry[id] = registry[id] || makeEl()),
      createElement: (t) => makeEl(t),
      querySelectorAll: () => [],
      addEventListener() {}
    }
  };
}
/** localStorage 목 — 뮤테이션ⓐ 재현용으로 seed 값을 미리 심을 수 있게 함 */
const makeLocalStorage = (seed) => {
  const store = Object.assign({}, seed || {});
  return { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, _store: store };
};
const AppMock = {
  pinHasContent(pin) {
    return !!(pin && (pin.imageId || pin.imageUrl || pin.videoId ||
      pin.note || (pin.attachments && pin.attachments.length) || pin.has3D));
  }
};

/** 세션 하나(=page 새로고침/새 프로젝트 열기 1회에 해당) 실행. clicks 로 칩 클릭 시퀀스를 재현.
 *  localStorageSeed 로 "이전 세션에서 남은 값"을 주입해 유령 상태를 재현할 수 있다. */
function runSession(sSrc, uSrc, pins, clicks, localStorageSeed) {
  const { document, registry } = makeDoc();
  const State = { pins, pdfPage: 1, mode: "viewer", activePin: null, zoneView: null, zones: [] };
  const ls = makeLocalStorage(localStorageSeed);
  const sandbox = { console, document, State, localStorage: ls, App: AppMock, JSON, Map, Set };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(sSrc + "\n" + uSrc + "\n;globalThis.__UI = UI; globalThis.__PS = PinSeries;", sandbox);
  sandbox.__UI.renderPinsOnMap(); // 최초 렌더(진입 직후, 클릭 이전)
  const snapshot = () => {
    const bar = registry["pin-filter-bar"];
    const html = bar ? bar._html : "";
    const chipCounts = {};
    const chipActive = {};
    const re = /data-kind="([a-z]+)"[^>]*aria-pressed="(true|false)"[^>]*>[\s\S]*?<span class="zpager-cnt">(\d+)<\/span>/g;
    let m;
    while ((m = re.exec(html))) { chipCounts[m[1]] = Number(m[3]); chipActive[m[1]] = m[2] === "true"; }
    return {
      layerChildren: registry["pins-layer"]._children.length,
      chipCounts, chipActive,
      html
    };
  };
  const snapshots = [snapshot()];
  clicks.forEach((kind) => {
    if (kind === "all") sandbox.__PS.showAll(); else sandbox.__PS.toggle(kind);
    sandbox.__PS.apply();
    snapshots.push(snapshot());
  });
  return { snapshots, PS: sandbox.__PS, ls };
}

/* 픽스처 A: 프로덕션 재현과 동일 — 5개 전부 체크보드 계열 */
const FIXTURE_ALL_CB = () => Array.from({ length: 5 }, (_, i) => ({ id: "cb" + i, page: 1, x: i * 5, y: i * 5, checkboard: true, label: String(i + 1) }));
/* 픽스처 B: 혼합 계열 — content 2개(등록 1·미등록 1) + checkboard 3개 */
const FIXTURE_MIXED = () => ([
  { id: "c1", page: 1, x: 1, y: 1, imageId: "img1" },
  { id: "c2", page: 1, x: 2, y: 2 },
  { id: "cb1", page: 1, x: 3, y: 3, checkboard: true, label: "1" },
  { id: "cb2", page: 1, x: 4, y: 4, checkboard: true, label: "2" },
  { id: "cb3", page: 1, x: 5, y: 5, checkboard: true, label: "3" }
]);

/* ────────────────────────────────────────────────────────────
 * ① 초기 상태(클릭 이전)에서 핀 전부 표시 — 프로덕션 재현 픽스처(체크보드만 5개)
 * ──────────────────────────────────────────────────────────── */
function suiteInitialAllVisible(label, sSrc) {
  console.log("\n[" + label + "]");
  const { snapshots } = runSession(sSrc, uiSrc, FIXTURE_ALL_CB(), []);
  ok(snapshots[0].layerChildren === 5, `① 초기 진입 시 #pins-layer 자식 5개(전부 표시) → 실측 ${snapshots[0].layerChildren}`);
  ok(snapshots[0].chipActive.all === true, "① '전체' 칩이 초기부터 active(aria-pressed=true)");
  ok(snapshots[0].chipActive.checkboard === true, "① '체크보드' 칩이 초기부터 active(aria-pressed=true)");
}

/* ────────────────────────────────────────────────────────────
 * ② "체크보드" 칩을 껐다가 다시 켜면(=toggle 두 번) 체크보드 핀이 보이고 칩 개수와 일치
 *    ("체크보드"만 존재하는 프로젝트에서 실수로 껐다 켜는 정상 플로우까지 검증)
 * ──────────────────────────────────────────────────────────── */
function suiteCheckboardOnMatches(label, sSrc) {
  console.log("\n[" + label + "]");
  const { snapshots } = runSession(sSrc, uiSrc, FIXTURE_ALL_CB(), ["checkboard", "checkboard"]);
  const off = snapshots[1], on = snapshots[2];
  ok(off.layerChildren === 0 && off.chipCounts.checkboard === 5,
    `② 껐을 때: 표시 0 / 칩 표기 5(끈 것 자체는 정상) → 표시=${off.layerChildren}, 칩=${off.chipCounts.checkboard}`);
  ok(on.layerChildren === 5 && on.chipCounts.checkboard === 5,
    `② 다시 켰을 때: 표시=칩 표기 → 표시=${on.layerChildren}, 칩=${on.chipCounts.checkboard}`);
}

/* ────────────────────────────────────────────────────────────
 * ③ "전체" 칩 클릭 → 전 핀 표시
 * ──────────────────────────────────────────────────────────── */
function suiteAllChip(label, sSrc) {
  console.log("\n[" + label + "]");
  const { snapshots } = runSession(sSrc, uiSrc, FIXTURE_MIXED(), ["content", "all"]);
  const afterOff = snapshots[1], afterAll = snapshots[2];
  ok(afterOff.layerChildren < 5, `③ 사전조건: content 끄면 5 미만 → ${afterOff.layerChildren}`);
  ok(afterAll.layerChildren === 5, `③ '전체' 클릭 후 5개 전부 표시 → ${afterAll.layerChildren}`);
}

/* ────────────────────────────────────────────────────────────
 * ④ 모든 필터 조합에서 "칩 개수 == 실제 표시 개수"
 * ──────────────────────────────────────────────────────────── */
function suiteCountsMatchDisplay(label, sSrc) {
  console.log("\n[" + label + "]");
  const combos = [
    [], ["content"], ["empty"], ["checkboard"],
    ["content", "empty"], ["content", "checkboard"], ["empty", "checkboard"],
    ["content", "empty", "checkboard"], ["all"]
  ];
  let allMatch = true;
  combos.forEach((clicks) => {
    const { snapshots } = runSession(sSrc, uiSrc, FIXTURE_MIXED(), clicks);
    const last = snapshots[snapshots.length - 1];
    const kindsShown = Object.keys(last.chipCounts).filter((k) => k !== "all");
    const sumShown = kindsShown.reduce((a, k) => a + (last.chipActive[k] ? last.chipCounts[k] : 0), 0);
    if (sumShown !== last.layerChildren) {
      allMatch = false;
      console.log(`    불일치: clicks=${JSON.stringify(clicks)} chipSum=${sumShown} layer=${last.layerChildren}`);
    }
  });
  ok(allMatch, "④ 모든 필터 조합에서 활성 칩 개수 합 == #pins-layer 표시 개수");
}

/* ────────────────────────────────────────────────────────────
 * ⑤ 개수 계산(counts)과 표시 판정(isVisible)이 같은 kindOf() 정본을 쓴다(SoT)
 * ──────────────────────────────────────────────────────────── */
function suiteSameSourceOfTruth(label, sSrc) {
  console.log("\n[" + label + "]");
  ok(/counts\(pins, page\)[\s\S]{0,200}c\[this\.kindOf\(p\)\]\+\+/.test(sSrc),
    "⑤ counts() 가 kindOf() 를 직접 호출해 집계(정본 공용)");
  ok(/isVisible\(pin\)\s*\{\s*return\s*!!this\.filter\(\)\[this\.kindOf\(pin\)\]/.test(sSrc),
    "⑤ isVisible() 도 같은 kindOf() 를 직접 호출해 판정(정본 공용, 카운트와 분리된 별도 소스 없음)");
}

/* ────────────────────────────────────────────────────────────
 * ⑥ on/off 가 aria-pressed 로 시각적으로 구분된다(다른 값)
 * ──────────────────────────────────────────────────────────── */
function suiteVisualDistinction(label, sSrc) {
  console.log("\n[" + label + "]");
  const { snapshots } = runSession(sSrc, uiSrc, FIXTURE_ALL_CB(), ["checkboard"]);
  ok(snapshots[0].chipActive.checkboard === true && snapshots[1].chipActive.checkboard === false,
    `⑥ 클릭 전후 aria-pressed 값이 다름(true→false) → ${snapshots[0].chipActive.checkboard} → ${snapshots[1].chipActive.checkboard}`);
  ok(/\.pinfilter-chip\.pf-checkboard\.active\{/.test(rd("public/css/style.css")),
    "⑥ CSS 에 .active 전용 배경색 규칙 존재(클래스로도 구분)");
}

/* 🔴 핵심 재현: 이전 세션에서 남은 전역 localStorage 값이 새 프로젝트에 새어 들어오지 않는다 */
function suiteNoGhostLeak(label, sSrc) {
  console.log("\n[" + label + "]");
  const ghostSeed = { "wm-pin-filter": JSON.stringify({ content: true, empty: true, checkboard: false }) };
  const { snapshots } = runSession(sSrc, uiSrc, FIXTURE_ALL_CB(), [], ghostSeed);
  ok(snapshots[0].layerChildren === 5,
    `🔴 이전 세션 유령값(checkboard:false)이 남아있어도 새 세션은 전체표시로 시작 → 실측 ${snapshots[0].layerChildren}`);
}

/* ── 실행: 정상 소스 ─────────────────────────────────────────── */
suiteInitialAllVisible("① 초기 전부 표시 (정상 소스)", seriesSrc);
suiteCheckboardOnMatches("② 체크보드 on/off 표시 == 칩 개수 (정상 소스)", seriesSrc);
suiteAllChip("③ 전체 칩 (정상 소스)", seriesSrc);
suiteCountsMatchDisplay("④ 모든 조합 칩 개수==표시개수 (정상 소스)", seriesSrc);
suiteSameSourceOfTruth("⑤ 개수·필터 SoT 공용 (정상 소스)", seriesSrc);
suiteVisualDistinction("⑥ on/off 시각 구분 (정상 소스)", seriesSrc);
suiteNoGhostLeak("🔴 전역 유령 localStorage 미반영 (정상 소스)", seriesSrc);

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 ⓐ: 예전처럼 localStorage 를 다시 읽게 되돌림 → ①(유령값 없어도 원래 회귀 확인용)
 *   대신 직접적으로는 🔴 유령값 테스트가 실패해야 한다 — filter() 를 구버전 동작으로 복원.
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션ⓐ] filter() 를 localStorage 복원 버전으로 되돌림 → 유령값 테스트가 실패해야 함");
  const needle = 'filter() {\n      if (!this._filter) this._filter = { content: true, empty: true, checkboard: true };\n      return this._filter;\n    },';
  const mutated = seriesSrc.replace(needle,
    'filter() {\n      if (!this._filter) {\n        this._filter = { content: true, empty: true, checkboard: true };\n        try {\n          const raw = localStorage.getItem(this.FILTER_KEY);\n          if (raw) { const v = JSON.parse(raw); this.KINDS.forEach(k => { if (typeof v[k] === "boolean") this._filter[k] = v[k]; }); }\n        } catch (e) {}\n      }\n      return this._filter;\n    },');
  if (mutated === seriesSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const ghostSeed = { "wm-pin-filter": JSON.stringify({ content: true, empty: true, checkboard: false }) };
    const { snapshots } = runSession(mutated, uiSrc, FIXTURE_ALL_CB(), [], ghostSeed);
    ok(snapshots[0].layerChildren === 0,
      `뮤테이션 적용 시 유령값이 다시 반영되어 초기 0개(①/유령누출 붕괴 증명) → 실측 ${snapshots[0].layerChildren}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 ⓑ: kindOf() 가 checkboard 를 항상 "content"로 오판 → ②④가 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션ⓑ] kindOf() 가 checkboard 를 오판 → ②④가 실패해야 함");
  const needle = 'kindOf(pin) {\n      if (!pin) return "empty";\n      if (pin.checkboard) return "checkboard";\n      return this.hasContent(pin) ? "content" : "empty";\n    },';
  const mutated = seriesSrc.replace(needle,
    'kindOf(pin) {\n      if (!pin) return "empty";\n      return this.hasContent(pin) ? "content" : "empty";\n    },');
  if (mutated === seriesSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { snapshots } = runSession(mutated, uiSrc, FIXTURE_ALL_CB(), ["checkboard", "checkboard"]);
    const off = snapshots[1];
    // checkboard 가 더는 존재하지 않는 kind 로 오판되어 renderChips 에 체크보드 칩 자체가 사라짐
    ok(off.chipCounts.checkboard === undefined || off.layerChildren !== 0,
      `뮤테이션 적용 시 체크보드 칩/판정 붕괴(②실효성 증명) → chipCounts=${JSON.stringify(off.chipCounts)}, layer=${off.layerChildren}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 ⓒ: isVisible() 이 counts() 와 다른 판정(pin.checkboard 직접 참조)을 쓰게 분리 → ⑤가 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션ⓒ] isVisible() 을 counts() 와 다른 소스로 분리 → ⑤가 실패해야 함");
  const needle = 'isVisible(pin) { return !!this.filter()[this.kindOf(pin)] && this.isIconVisible(pin); },';
  const mutated = seriesSrc.replace(needle,
    'isVisible(pin) { const k = pin && pin.checkboard ? "checkboard" : "content"; return !!this.filter()[k] && this.isIconVisible(pin); },');
  if (mutated === seriesSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    ok(!/isVisible\(pin\)\s*\{\s*return\s*!!this\.filter\(\)\[this\.kindOf\(pin\)\]/.test(mutated),
      "뮤테이션 적용 시 isVisible() 이 더는 kindOf() 를 직접 쓰지 않음(⑤ 실효성 증명)");
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
