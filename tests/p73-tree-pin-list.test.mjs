/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p73-tree-pin-list.test.mjs)
 *
 * 마스터 지시(2026-09-28): "각 구역-영역-하위에 핀 리스트를 정렬"
 *
 * 근본원인: 11_UI.js renderTree() 의 deckNode() 가 영역(zone) 겹침을 고려하지 않고
 *   zpins 를 zones.forEach 안에서 독립적으로 필터링했다(겹치는 두 영역에 같은 핀이
 *   중복 표시될 수 있었다) + 핀 행에 번호가 없었다(pinNode 가 label 만 표시) +
 *   렌더 순서가 State.pins 배열 삽입 순서를 그대로 따라 번호 오름차순이 아니었다.
 *
 * 조치: ① 핀마다 "같은 page 의 영역 crop{x,y,w,h}(페이지%) 안이면 그 영역(겹치면 면적
 *   작은 쪽), 아니면 구역"으로 정확히 1곳에만 배정(zoneOfPin, 겹침 시 bbox 면적 최솟값).
 *   ② 번호 SoT(PinSeries.numbers)를 트리 전체 페이지 기준으로 병합해 pinNode 에 "#번호"
 *   배지로 표시. ③ 구역 직속/영역 각각 번호 오름차순(숫자 비교, 문자열 정렬 아님 — 2<10<101)
 *   으로 정렬 후 렌더.
 *
 * 실제 11_UI.js 원문을 vm 에 그대로 평가(p62/p65 와 동일 패턴, 목 아님).
 * 뮤테이션 2건(ⓐ 소속 판정 제거 ⓑ 정렬 제거)이 붙어 있어, 되돌리면 반드시 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const uiSrc = rd("public/js/modules/11_UI.js");
const seriesSrc = rd("public/js/modules/01b_PinSeries.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 최소 DOM 목(p62/p65 와 동일 패턴) ───────────────────────── */
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
function makeUI(src, ctx) {
  const { document, registry } = makeDoc();
  const sandbox = { console, document, JSON, Map, Set, ...ctx };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(seriesSrc + "\n" + src + "\n;globalThis.__UI = UI; globalThis.__PS = PinSeries;", sandbox);
  return { UI: sandbox.__UI, registry };
}
const has = (el, cls) => new RegExp("(^| )" + cls + "( |$)").test(el.className || "");
const kidsOf = (el) => (el._children || []).find((c) => has(c, "tree-children"));
const pick = (el, cls) => (el._children || []).filter((c) => has(c, cls));
/* [WO 20260930-moderole] 🔴 마스터 2차 지시로 모드 가지(88e52ff)를 제거 — 구역은 프로젝트 바로
   아래 한 벌(공유). 픽스처 핀은 전부 CHECKER 계열이므로 구역의 맨 안쪽 CHECKER 잎(.tree-mode-leaf-checker)
   아래를 본다(모드 잎 자체의 검사는 p91). */
const deckUnderChecker = (proj) => pick(kidsOf(proj), "tree-deck")[0];
const checkerKidsOf = (deck) => kidsOf(pick(kidsOf(deck), "tree-mode-leaf-checker")[0]);

/** 실 좌표 포함판정(16_Zones.js _contains 의 rect 분기와 동일 로직) */
const ZonesReal = {
  _contains(z, x, y) { return x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h; },
  focus() {}
};

/** 픽스처: 영역(zone) 1개(x:10,y:10,w:20,h:20) + 핀 5개(영역 안 2, 밖 3), 번호 뒤섞음(checkboard label 로 번호를 배열 순서와 분리) */
function fx() {
  const State = {
    mode: "designer", pdfPage: 1, pdfPages: 1, currentDeploymentId: "dep1", activePin: null,
    zones: [{ id: "z1", page: 1, x: 10, y: 10, w: 20, h: 20, shape: "rect", label: "ㅁㄴㅇ", color: "#4f8" }],
    // 배열 순서 = 번호 순서가 아니게 일부러 스크램블(checkboard + label 로 번호를 배열위치와 분리)
    pins: [
      { id: "zoneHigh", page: 1, x: 15, y: 15, checkboard: true, label: "104" }, // 영역 안
      { id: "rootHigh", page: 1, x: 90, y: 90, checkboard: true, label: "105" }, // 밖
      { id: "zoneLow",  page: 1, x: 12, y: 12, checkboard: true, label: "101" }, // 영역 안
      { id: "rootMid",  page: 1, x: 50, y: 50, checkboard: true, label: "102" }, // 밖
      { id: "rootLow",  page: 1, x: 70, y: 70, checkboard: true, label: "100" }  // 밖
    ]
  };
  const deck = { id: "d1", name: "ㅁ", deployment_id: "dep1", parent_id: null };
  const Projects = { decks: [deck], currentProject: { id: "prj1", name: "tes" }, currentDeck: deck, selectDeck() {} };
  return { State, Projects, Zones: ZonesReal, App: { focusPin() {} } };
}

/** 픽스처: 겹치는 두 영역(큰 것 A, 작은 것 B가 A 안에 포함) + 겹침 지점의 핀 1개 → 작은 쪽(B)에 배정 */
function fxOverlap() {
  const State = {
    mode: "designer", pdfPage: 1, pdfPages: 1, currentDeploymentId: "dep1", activePin: null,
    zones: [
      { id: "zBig",   page: 1, x: 0,  y: 0,  w: 80, h: 80, shape: "rect", label: "큰영역" },
      { id: "zSmall", page: 1, x: 10, y: 10, w: 10, h: 10, shape: "rect", label: "작은영역" }
    ],
    pins: [{ id: "overlapPin", page: 1, x: 15, y: 15, checkboard: true, label: "1" }] // 두 영역 겹침 지점(작은쪽 안)
  };
  const deck = { id: "d1", name: "ㅁ", deployment_id: "dep1", parent_id: null };
  const Projects = { decks: [deck], currentProject: { id: "prj1", name: "tes" }, currentDeck: deck, selectDeck() {} };
  return { State, Projects, Zones: ZonesReal, App: { focusPin() {} } };
}

/** 픽스처: 자연 숫자 정렬(2 < 10 < 101, 문자열 정렬이면 10 < 101 < 2 로 깨짐) */
function fxNaturalSort() {
  const State = {
    mode: "designer", pdfPage: 1, pdfPages: 1, currentDeploymentId: "dep1", activePin: null,
    zones: [],
    pins: [
      { id: "pA", page: 1, x: 5, y: 5, checkboard: true, label: "101" },
      { id: "pB", page: 1, x: 6, y: 6, checkboard: true, label: "2" },
      { id: "pC", page: 1, x: 7, y: 7, checkboard: true, label: "10" }
    ]
  };
  const deck = { id: "d1", name: "ㅁ", deployment_id: "dep1", parent_id: null };
  const Projects = { decks: [deck], currentProject: { id: "prj1", name: "tes" }, currentDeck: deck, selectDeck() {} };
  return { State, Projects, Zones: ZonesReal, App: { focusPin() {} } };
}

/* ════════════════════════════════════════════════════════════
 * ① 영역 안/밖 배정 + 번호 오름차순(뒤섞인 배열 순서 무시)
 * ════════════════════════════════════════════════════════════ */
function runFx(src, fixture) {
  const c = fixture();
  const { UI, registry } = makeUI(src, c);
  UI.renderTree();
  const host = registry["side-tree"];
  const proj = pick(host, "tree-project")[0];
  const deck = deckUnderChecker(proj);
  const kids = checkerKidsOf(deck);
  const zoneNode = pick(kids, "tree-zone")[0];
  const zonePinIds = zoneNode ? pick(kidsOf(zoneNode), "tree-node-pin").map((n) => n.innerHTML) : [];
  const rootPinIds = pick(kids, "tree-node-pin").map((n) => n.innerHTML);
  return { zonePinIds, rootPinIds, zoneNode };
}

{
  console.log("\n[① 영역 안 2 / 구역 직속 3, 번호 오름차순(정상 소스)]");
  const { zonePinIds, rootPinIds } = runFx(uiSrc, fx);
  ok(zonePinIds.length === 2, `① 영역(ㅁㄴㅇ) 아래 핀 2개(실제 ${zonePinIds.length}개)`);
  ok(rootPinIds.length === 3, `① 구역(ㅁ) 직속 핀 3개(영역 밖, 실제 ${rootPinIds.length}개)`);
  ok(/#101/.test(zonePinIds[0]) && /#104/.test(zonePinIds[1]),
    `① 영역 안 오름차순 101→104(배열은 104,101 순서였음) → [${zonePinIds.join(" | ")}]`);
  ok(/#100/.test(rootPinIds[0]) && /#102/.test(rootPinIds[1]) && /#105/.test(rootPinIds[2]),
    `① 구역 직속 오름차순 100→102→105 → [${rootPinIds.join(" | ")}]`);
}

/* ════════════════════════════════════════════════════════════
 * ② 겹치는 영역 — 면적 작은 쪽에 배정, 중복 표시 없음
 * ════════════════════════════════════════════════════════════ */
{
  console.log("\n[② 겹치는 영역 → 면적 작은 쪽에만 배정(정상 소스)]");
  const c = fxOverlap();
  const { UI, registry } = makeUI(uiSrc, c);
  UI.renderTree();
  const host = registry["side-tree"];
  const proj = pick(host, "tree-project")[0];
  const deck = deckUnderChecker(proj);
  const kids = checkerKidsOf(deck);
  const zoneNodes = pick(kids, "tree-zone");
  const bigZone = zoneNodes.find((z) => /큰영역/.test(z._children[0].innerHTML));
  const smallZone = zoneNodes.find((z) => /작은영역/.test(z._children[0].innerHTML));
  // [WO 20260930-moderole] 🔴 핀이 0개인 영역은 이 모드 잎 아래에 아예 그려지지 않는다(빈 중복
  // 방지, 11_UI.js "if (!zpins.length) return;") — 큰영역은 핀이 없으므로 zoneNodes 에 없는 게 정상.
  const bigPins = bigZone ? pick(kidsOf(bigZone), "tree-node-pin") : [];
  const smallPins = pick(kidsOf(smallZone), "tree-node-pin");
  ok(smallPins.length === 1, `② 작은 영역에 핀 1개 배정(실제 ${smallPins.length}개)`);
  ok(!bigZone && bigPins.length === 0, `② 큰 영역엔 중복 배정 없음(핀 0개라 영역 자체가 안 그려짐, 실제 ${bigPins.length}개)`);
}

/* ════════════════════════════════════════════════════════════
 * ③ 자연 숫자 정렬 — 2 < 10 < 101 (문자열 정렬이면 10,101,2 순서로 깨짐)
 * ════════════════════════════════════════════════════════════ */
{
  console.log("\n[③ 숫자 오름차순(2<10<101), 문자열 정렬 아님(정상 소스)]");
  const { rootPinIds } = runFx(uiSrc, fxNaturalSort);
  ok(/#2\b/.test(rootPinIds[0]) && /#10\b/.test(rootPinIds[1]) && /#101\b/.test(rootPinIds[2]),
    `③ 2→10→101 순서 → [${rootPinIds.join(" | ")}]`);
}

/* ════════════════════════════════════════════════════════════
 * ④ 핀 행에 번호(#N) 배지가 라벨과 함께 표시
 * ════════════════════════════════════════════════════════════ */
{
  console.log("\n[④ 핀 행 = 번호 + 라벨(정상 소스)]");
  const c = fx();
  const { UI, registry } = makeUI(uiSrc, c);
  UI.renderTree();
  const host = registry["side-tree"];
  const proj = pick(host, "tree-project")[0];
  const deck = deckUnderChecker(proj);
  const rootPins = pick(checkerKidsOf(deck), "tree-node-pin");
  ok(rootPins.every((n) => /tree-pin-no">#\d+</.test(n.innerHTML)), "④ 모든 핀 행에 #번호 배지 존재");
}

/* ── 뮤테이션 ⓐ: 소속 판정 제거(항상 구역 직속) → ①이 실패해야 한다 ───────── */
{
  console.log("\n[뮤테이션ⓐ] 소속 판정 제거(영역 배정 무시) → ①이 실패해야 함");
  const needle = 'if (best) zoneOfPin.set(p.id, best);';
  const mut = uiSrc.replace(needle, '/* removed */');
  if (mut === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { zonePinIds, rootPinIds } = runFx(mut, fx);
    ok(zonePinIds.length === 0 && rootPinIds.length === 5,
      `뮤테이션 적용 시 소속 판정 붕괴(전부 구역 직속, ①붕괴 증명) → zone=${zonePinIds.length}, root=${rootPinIds.length}`);
  }
}

/* ── 뮤테이션 ⓑ: 정렬 제거(배열 순서 그대로) → ①/③이 실패해야 한다 ───────── */
{
  console.log("\n[뮤테이션ⓑ] 정렬 제거(배열 삽입 순서 그대로) → ③이 실패해야 함");
  const needle = 'const sortByNo = (a, b) => ((numMap.get(a.id) || {}).no || 0) - ((numMap.get(b.id) || {}).no || 0);';
  const mut = uiSrc.replace(needle, 'const sortByNo = () => 0;');
  if (mut === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { rootPinIds } = runFx(mut, fxNaturalSort);
    // fxNaturalSort 배열 삽입순서 = pA(101), pB(2), pC(10) → 정렬 없으면 101,2,10 순서(오름차순 101,2,10 이 아님)
    const brokenOrder = /#101\b/.test(rootPinIds[0]) && /#2\b/.test(rootPinIds[1]) && /#10\b/.test(rootPinIds[2]);
    ok(brokenOrder, `뮤테이션 적용 시 오름차순 깨짐(③붕괴 증명, 배열 순서 그대로) → [${rootPinIds.join(" | ")}]`);
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
