/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p22-tree-always-visible.test.mjs)
 *
 * 마스터 지시(2026-09-17): "메인데크는 구역이고 그 데크에서 00룸은 영역인 거지.
 *  항상 리스트가 보이게 만들어 모든 항목에 대해서" — 사이드바 트리(#side-tree)가
 *  현재 페이지/현재 배포본이 아닌 항목을 조건부로 숨기던 결함 수정.
 *
 * 근본원인(실측, public/js/modules/11_UI.js renderTree()):
 *  · 영역/핀을 `zone.page === State.pdfPage` 로 필터 → 다른 페이지 항목이 안 보였다.
 *  · 구역 하위(도면/영역/핀)는 `isCur && deck.deployment_id === State.currentDeploymentId`
 *    로만 렌더 — 로드되지 않은 구역은 원래도 하위 데이터가 없어(클라이언트 미보유) 그대로.
 *
 * 검사:
 *  ① 다른 페이지의 영역/핀도 트리에 표시된다(과거엔 숨겨짐)
 *  ② 다른 배포본의 구역도 목록에 표시된다(하위 없이 — 데이터 미보유, 0 날조 금지)
 *  ③ 현재 페이지 영역은 .active 클래스로 구분된다(숨기지 않음)
 *  ④ 구역별 영역 수 · 영역별 핀 수 배지가 정확하다
 *  ⑤ 구역 0개 → 기존 빈 상태 안내가 그대로 동작(회귀 없음)
 *  ⑥ 클릭 핸들러가 종전과 동일한 함수(Projects.selectDeck / Zones.focus / App.focusPin)를 호출한다
 *
 * 실제 모듈 소스(11_UI.js)를 그대로 vm 에 평가해 검사한다(목 구현 아님).
 * 뮤테이션 2건이 붙어 있어, 고친 코드를 되돌리면 해당 검사가 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const uiSrc = rd("public/js/modules/11_UI.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 최소 DOM 목(mock) — p9/p10 과 동일 패턴 ─────────────────────────── */
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
    click() { (this._handlers.click || []).forEach((fn) => fn({ target: this, stopPropagation() {}, closest: () => null })); },
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

/** 11_UI.js 를 vm 에 로드해 UI.renderTree() 실행, DOM(#side-tree) 반환 */
function runTree(src, { State, Projects, Zones, App }) {
  const { document, registry } = makeDoc();
  const sandbox = { console, document, State, Projects, Zones, App, JSON, Map, Set };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__UI = UI;", sandbox);
  sandbox.__UI.renderTree();
  return { host: registry["side-tree"], UI: sandbox.__UI };
}

/* ── 공용 픽스처: 구역 1개(로드됨) + 2페이지 영역/핀 ───────────────── */
function baseFixture() {
  const zoneFocusCalls = [];
  const selectDeckCalls = [];
  const focusPinCalls = [];
  const State = {
    fileName: "도면A.pdf", currentDeploymentId: "dep1", pdfPage: 1, pdfPages: 2, mode: "designer",
    activePin: null,
    zones: [
      { id: "z1", label: "00룸", page: 1, color: "#f00", x1: 0, y1: 0, x2: 50, y2: 50 },
      { id: "z2", label: "01룸", page: 2, color: "#0f0", x1: 0, y1: 0, x2: 50, y2: 50 }
    ],
    pins: [
      { id: "p1", label: "핀1", page: 1, x: 10, y: 10 },
      { id: "p2", label: "핀2", page: 2, x: 10, y: 10 }
    ]
  };
  const decks = [
    { id: "d1", name: "1층", deployment_id: "dep1" },
    { id: "d2", name: "2층", deployment_id: "dep2" } // 다른 배포본 — 미로드
  ];
  const Projects = { decks, currentDeck: decks[0], selectDeck: (d) => selectDeckCalls.push(d.id) };
  const Zones = {
    _contains: (zone, x, y) => zone.page === 1 ? zone.id === "z1" : zone.id === "z2", // 페이지별 1핀씩 소속
    focus: (id) => zoneFocusCalls.push(id)
  };
  const App = { focusPin: (p) => focusPinCalls.push(p.id) };
  return { State, Projects, Zones, App, zoneFocusCalls, selectDeckCalls, focusPinCalls };
}

/** DOM 목은 host.innerHTML(문자열 대입)이 아니라 appendChild 로 조립되므로,
 *  검색 가능한 텍스트를 얻으려면 각 노드의 _html(버튼/도큐먼트 노드에 직접 대입된 innerHTML)을
 *  재귀적으로 모아야 한다. */
function flattenHtml(el) {
  let out = el._html || "";
  (el._children || []).forEach((c) => { out += flattenHtml(c); });
  return out;
}

/** [WO 20260921-tree] 마스터 확정 4단(프로젝트>도면>구역>영역>핀) 도입으로 DOM 깊이가 깊어졌다.
 *  이 테스트의 '의도'는 구조 좌표가 아니라 "숨김 없음 · 핸들러 동일"이므로,
 *  인덱스 고정 접근(host._children[0]...) 대신 클래스명 재귀 탐색으로 바꾼다. */
function findAll(el, cls, out) {
  out = out || [];
  const re = new RegExp("(^| )" + cls + "( |$)");
  (el._children || []).forEach((c) => { if (re.test(c.className || "")) out.push(c); findAll(c, cls, out); });
  return out;
}
function nodeByText(host, cls, text) {
  return findAll(host, cls).find((b) => new RegExp(text).test(b._html || ""));
}

console.log("\n[정상 소스]");

// ① 다른 페이지의 영역/핀도 표시된다
{
  const fx = baseFixture();
  const { host } = runTree(uiSrc, fx);
  const html1 = flattenHtml(host);
  ok(/00룸/.test(html1) && /01룸/.test(html1),
    "① 현재 페이지(z1=00룸)뿐 아니라 다른 페이지(z2=01룸)도 트리에 표시됨");
  ok(/핀1/.test(html1) && /핀2/.test(html1),
    "① 현재 페이지 핀(핀1)뿐 아니라 다른 페이지 핀(핀2)도 표시됨");
}

// ② 다른 배포본의 구역(d2)도 목록에 표시된다
{
  const fx = baseFixture();
  const { host } = runTree(uiSrc, fx);
  ok(/2층/.test(flattenHtml(host)), "② 다른 배포본 구역(2층, dep2)도 목록에 표시됨");
}

// ③ 현재 페이지 영역은 .active 로 구분(숨기지 않음)
{
  const fx = baseFixture();
  const { host } = runTree(uiSrc, fx);
  // tree-zone 구조: ... > g(tree-deck) > kids > zn(tree-zone) > zh(tree-node-zone)
  const zoneNodes = findAll(host, "tree-zone");
  const z1 = zoneNodes[0], z2 = zoneNodes[1];
  const zh1 = z1._children[0], zh2 = z2._children[0];
  ok(zh1.classList.contains("active"), "③ 현재 페이지(z1) 영역 헤더에 active 클래스 부여");
  ok(!zh2.classList.contains("active"), "③ 다른 페이지(z2) 영역 헤더에는 active 없음(숨김 아닌 구분)");
}

// ④ 구역별 영역 수 · 영역별 핀 수 배지 정확
{
  const fx = baseFixture();
  const { host } = runTree(uiSrc, fx);
  const head = nodeByText(host, "tree-node-deck", "1층");
  ok(/tree-cnt[^>]*>2</.test(head.innerHTML), `④ 구역(1층) 영역 수 배지 = 2 (실제 head html 일부: ${(head.innerHTML.match(/tree-cnt[^<]*<\/span>[^<]*<\/span>/) || [""])[0]})`);
  const zh1 = findAll(host, "tree-zone")[0]._children[0];
  ok(/tree-cnt[^>]*>1</.test(zh1.innerHTML), "④ 영역(00룸) 핀 수 배지 = 1");
}

// ⑤ 구역 0개 → 기존 빈 상태 안내 회귀 없음
{
  const fx = baseFixture();
  fx.Projects.decks = [];
  const { host } = runTree(uiSrc, fx);
  ok(/구역이 없습니다/.test(host.innerHTML), "⑤ 구역 0개 → 기존 빈 상태 안내 문구 유지");
}

// ⑥ 클릭 핸들러가 종전과 동일 함수를 호출
{
  const fx = baseFixture();
  const { host } = runTree(uiSrc, fx);
  const zoneNodes = findAll(host, "tree-zone");
  const zh1 = zoneNodes[0]._children[0];
  zh1.click();
  ok(fx.zoneFocusCalls.length === 1 && fx.zoneFocusCalls[0] === "z1", "⑥ 영역 클릭 → Zones.focus('z1') 호출(기존 그대로)");
  const zc1 = zoneNodes[0]._children[1];
  const pinBtn = zc1._children[0];
  pinBtn.click();
  ok(fx.focusPinCalls.length === 1 && fx.focusPinCalls[0] === "p1", "⑥ 핀 클릭 → App.focusPin('p1') 호출(기존 그대로)");

  // 다른(비선택) 구역 클릭 → Projects.selectDeck 호출
  const head2 = nodeByText(host, "tree-node-deck", "2층");
  head2.click();
  ok(fx.selectDeckCalls.length === 1 && fx.selectDeckCalls[0] === "d2", "⑥ 미선택 구역 클릭 → Projects.selectDeck('d2') 호출(기존 그대로)");
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 A: 페이지 필터를 복원(구 동작) → ①이 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션A] 영역/핀 페이지 필터 복원(구 동작으로 되돌림) → ①이 실패해야 함");
  const needle = `          const zones = State.zones || []; // 전체 페이지(필터 없음)
          const pins = State.pins || [];   // 전체 페이지(필터 없음)`;
  const mutated = uiSrc.replace(needle,
    `          const zones = (State.zones || []).filter((z) => (z.page || 1) === curPage);
          const pins = (State.pins || []).filter((p) => (p.page || 1) === curPage);`);
  if (mutated === uiSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const fx = baseFixture();
    const { host } = runTree(mutated, fx);
    ok(!/01룸/.test(flattenHtml(host)),
      `뮤테이션 적용 시 ①이 깨짐(테스트 실효성 증명 — 다른 페이지 영역이 다시 숨겨짐)`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 B: 활성 페이지 구분(active 클래스) 제거 → ③이 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션B] 현재 페이지 active 구분 제거 → ③이 실패해야 함");
  const needle = `zh.className = "tree-node tree-node-zone" + (isCurZonePage ? " active" : "");`;
  const mutated = uiSrc.replace(needle, `zh.className = "tree-node tree-node-zone";`);
  if (mutated === uiSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const fx = baseFixture();
    const { host } = runTree(mutated, fx);
    const zh1 = findAll(host, "tree-zone")[0]._children[0];
    ok(!zh1.classList.contains("active"),
      "뮤테이션 적용 시 ③이 깨짐(테스트 실효성 증명 — 현재 페이지 영역도 active 없음)");
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
