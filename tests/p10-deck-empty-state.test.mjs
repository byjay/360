/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p10-deck-empty-state.test.mjs)
 *
 * 결함(프로덕션 실측): 구역이 없는 프로젝트는 사이드바(#side-tree)가 통째로 비어 보였다.
 *  원인 — Projects._renderDecks() 가 decks.length===0 일 때 UI.renderTree() 호출 자체를
 *  건너뛰고 return 해버려(#decks-empty 는 CSS로 영구 숨김) #side-tree 가 갱신되지 않는
 *  "조용한 빈 상태"였다.
 *
 * [WO 20260929-tree1] 🔴 근본수정 이후 — "구역 0" 안내의 실제 DOM(문구·버튼)은 이제
 *  11_UI.js UI.renderTree() 가 그린다(31_Projects._renderSideTreeEmpty() 는 위임만 한다 —
 *  예전엔 #side-tree.innerHTML 을 직접 덮어써 트리가 붙인 실 DOM을 다음 렌더에서 파괴하는
 *  결함으로 이어졌다). 이 스위트는 원래 설계대로 31_Projects.js 만 올리므로(11_UI.js 미로드),
 *  아래 항목은 "위임이 실제로 일어나는가"만 검사한다 — CTA 의 정확한 문구·배선은
 *  real-source 스위트(p22/p62, 11_UI.js 를 그대로 vm 에 올림)가 담당한다.
 *
 * 검증 항목:
 *  ① 구역 0개 + 프로젝트 선택됨 → UI.renderTree() 위임 호출됨.
 *  ② 구역 1개 이상 → 기존 트리(#decks-list 행 + UI.renderTree 위임)가 그대로 렌더된다(회귀 없음).
 *  ③ 프로젝트 미선택이어도 위임 자체는 일어난다(빈 트리 여부 판단은 11_UI.js 담당).
 *  ④ [Uncertain] CTA 클릭→Projects.createDeck() 배선은 11_UI.js 안이라 이 스위트론 검증 불가 —
 *     위임 대상 함수 존재만 확인(후속: p22/p62 에 전용 커버리지 추가 권고).
 *
 * 실제 모듈 소스(31_Projects.js)를 그대로 vm에 평가해 검사한다(목 구현 아님).
 * 뮤테이션 1건(①)이 붙어 있어, 고친 코드를 되돌리면 해당 검사가 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const projectsSrc = rd("public/js/modules/31_Projects.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 최소 DOM 목(mock) — p4-pin-series.test.mjs 와 동일 패턴 ─────────────── */
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
    getAttribute(k) { return this.dataset["attr_" + k]; },
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    querySelector(sel) {
      // 최소 지원: ".deck-name" / ".deck-del" — 클래스 셀렉터로 자식 검색
      const cls = sel.replace(/^\./, "");
      const find = (node) => {
        for (const c of node._children || []) {
          if (c.classList && c.classList.contains(cls)) return c;
          const nested = find(c);
          if (nested) return nested;
        }
        return null;
      };
      const viaChildren = find(this);
      if (viaChildren) return viaChildren;
      // 31_Projects.js 는 row.innerHTML = `...class="deck-name"...` 처럼 문자열로 그린 뒤
      // querySelector 로 이벤트를 붙인다(appendChild 트리가 아님) — 클릭 바인딩 대상 스텁 반환.
      if (this._html && this._html.indexOf('class="' + cls + '"') !== -1) {
        this._htmlChildStubs = this._htmlChildStubs || {};
        if (!this._htmlChildStubs[cls]) this._htmlChildStubs[cls] = makeEl();
        return this._htmlChildStubs[cls];
      }
      return null;
    },
    querySelectorAll() { return []; },
    closest() { return null; },
    click() { (this._handlers.click || []).forEach((fn) => fn({ target: this, stopPropagation() {} })); },
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
  const document = {
    getElementById: (id) => (registry[id] = registry[id] || makeEl()),
    createElement: (t) => makeEl(t),
    querySelectorAll: () => [],
    addEventListener() {}
  };
  return { document, registry };
}

/** 31_Projects.js 를 vm 에 로드하고 Projects 객체를 반환. 렌더 위임 대상(UI.renderTree)은
 *  스파이로 교체해 다른 에이전트가 동시 작업 중인 11_UI.js 없이도 검증한다(목이 아니라 위임 계약 검증). */
function loadProjects(pSrc, { currentProject, decks }) {
  const { document, registry } = makeDoc();
  const renderTreeCalls = [];
  const sandbox = {
    console, document,
    State: { fileName: null, currentDeploymentId: null },
    App: { isDeckUnsaved: () => false },
    UI: { renderTree: (...a) => renderTreeCalls.push(a) },
    JSON
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(pSrc + "\n;globalThis.__P = Projects;", sandbox);
  const Projects = sandbox.__P;
  Projects.currentProject = currentProject || null;
  Projects.decks = decks || [];
  return { Projects, document, registry, renderTreeCalls };
}

/* ────────────────────────────────────────────────────────────
 * 실행: 정상 소스
 * ──────────────────────────────────────────────────────────── */
console.log("\n[정상 소스]");

// ① 구역 0개 + 프로젝트 선택됨
// [WO 20260929-tree1] 🔴 근본수정 — "구역 0" 안내의 실제 DOM(문구·생성 버튼)은 이제
// 11_UI.js UI.renderTree() 가 그린다(예전엔 _renderSideTreeEmpty() 가 #side-tree.innerHTML
// 을 직접 덮어써, 트리가 같은 자리에 붙인 실 DOM(#project-actions 등)을 다음 렌더에서 파괴하는
// 결함으로 이어졌다 — 렌더 SoT 를 11_UI.js 하나로 합쳤다). 이 스위트는 11_UI.js 없이 31_Projects.js
// 만 올리므로(파일 docstring 원칙), 여기서는 **위임이 실제로 일어나는지**만 검사한다. 실제 CTA
// 문구/버튼 내용은 real-source 스위트(p22/p62, real 11_UI.js)가 이미 커버한다.
{
  const { Projects, renderTreeCalls } = loadProjects(projectsSrc, {
    currentProject: { id: "p1", name: "테스트 프로젝트" }, decks: []
  });
  Projects._renderDecks();
  ok(renderTreeCalls.length === 1, `① 구역 0개+프로젝트 선택 → UI.renderTree() 위임 호출됨(실제 ${renderTreeCalls.length}회)`);
}

// ② 구역 1개 이상 → 기존 트리 렌더 경로(회귀 없음)
{
  const { Projects, document, registry, renderTreeCalls } = loadProjects(projectsSrc, {
    currentProject: { id: "p1", name: "테스트 프로젝트" },
    decks: [{ id: "d1", name: "Main Deck", deployment_id: null }]
  });
  Projects._renderDecks();
  const host = document.getElementById("side-tree"); // 정상 경로는 UI.renderTree(스텁)에 위임 — 여기서 손대지 않음
  const list = registry["decks-list"];
  ok(!/side-tree-empty/.test(host.innerHTML || ""), "② 구역 1개 이상 → 빈 상태 안내가 렌더되지 않음(직접 렌더 안 함)");
  ok(list._children.length === 1, `② decks-list 행 1개 렌더됨 (실제 ${list._children.length})`);
  ok(renderTreeCalls.length === 1, `② UI.renderTree() 가 그대로 위임 호출됨 (호출 ${renderTreeCalls.length}회)`);
}

// ③ 프로젝트 미선택 — "안내를 띄울지 말지"는 이제 11_UI.js 의 판단(위 ① 주석 참조).
// 31_Projects.js 쪽은 프로젝트 유무와 무관하게 위임만 한다(위임 자체가 이 파일의 계약).
// 프로젝트 미선택 시 실제로 안내가 안 뜨는지는 real-source 스위트(p22 ⑤·p62)가 검증한다.
{
  const { Projects, renderTreeCalls } = loadProjects(projectsSrc, { currentProject: null, decks: [] });
  Projects._renderDecks();
  ok(renderTreeCalls.length === 1, `③ 프로젝트 미선택이어도 UI.renderTree() 위임은 일어난다(빈 트리 여부 판단은 11_UI.js 담당, 실제 ${renderTreeCalls.length}회)`);
}

// ④ [WO 20260929-tree1] 🔴 CTA 버튼의 실제 DOM 배선(클릭→Projects.createDeck())은 이제
// 11_UI.js 안에서 이뤄진다 — 이 스위트(31_Projects.js 단독)로는 검증 불가([Uncertain],
// p64 와 동일한 후속 커버리지 필요 — 이 턴엔 실 CDP 스크린샷으로 육안 확인만 했다).
// 여기서는 위임 대상 함수(Projects.createDeck)가 여전히 존재/호출 가능한지만 확인한다.
{
  const { Projects } = loadProjects(projectsSrc, {
    currentProject: { id: "p1", name: "테스트 프로젝트" }, decks: []
  });
  ok(typeof Projects.createDeck === "function", "④ Projects.createDeck 함수가 여전히 존재(11_UI.js CTA 가 위임할 대상)");
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 A: 빈 상태 분기를 제거하면 ①이 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션A] 빈 상태 분기 제거(구 동작으로 되돌림) → ①이 실패해야 함");
  const needle = `      if (!this.decks.length) {
        // ── [결함수정] #decks-empty 는 side-tree 일원화(2b9b677)로 CSS에서 영구 숨김이다.
        //    과거엔 여기서 return 해버려 UI.renderTree() 호출까지 건너뛰어 #side-tree 가
        //    갱신되지 않았다(= 구역 0개일 때 사이드바가 통째로 비어 보이는 조용한 실패).
        //    #decks-empty 를 되살리지 않고, #side-tree 안에서 직접 실제 안내를 그린다. ──
        if (emptyEl) emptyEl.classList.add("hidden");
        this._renderSideTreeEmpty();
        return;
      }`;
  const mutated = projectsSrc.replace(needle, `      if (!this.decks.length) { if (emptyEl) emptyEl.classList.add("hidden"); return; }`);
  if (mutated === projectsSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { Projects, renderTreeCalls } = loadProjects(mutated, { currentProject: { id: "p1", name: "테스트" }, decks: [] });
    Projects._renderDecks();
    ok(renderTreeCalls.length === 0,
      `뮤테이션 적용 시 ①이 깨짐(테스트 실효성 증명 — UI.renderTree() 위임 자체가 빠짐) → 호출 ${renderTreeCalls.length}회`);
  }
}

/* ────────────────────────────────────────────────────────────
 * [WO 20260929-tree1] 🔴 뮤테이션 B 제거 — "프로젝트 미선택 시 안내를 띄우지 않는다" 가드는
 * 근본수정으로 31_Projects._renderSideTreeEmpty() 에서 11_UI.js UI.renderTree() 의 `!proj`
 * 분기로 옮겨갔다(위 ① 주석 참조). 이 스위트는 31_Projects.js 만 올리므로(파일 설계 원칙)
 * 그 분기를 직접 뮤테이션할 수 없다 — real-source 스위트(p22/p62, 11_UI.js 를 그대로 vm 에
 * 올림)가 정상 동작은 검증하지만, 그 분기 전용 뮤테이션은 아직 없다([Uncertain] 잔여 갭 —
 * 후속 작업으로 p22/p62 에 `!proj` 분기 전용 뮤테이션 추가 권고).
 * ──────────────────────────────────────────────────────────── */

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
