/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p10-deck-empty-state.test.mjs)
 *
 * 결함(프로덕션 실측): 구역이 없는 프로젝트는 사이드바(#side-tree)가 통째로 비어 보였다.
 *  원인 — Projects._renderDecks() 가 decks.length===0 일 때 UI.renderTree() 호출 자체를
 *  건너뛰고 return 해버려(#decks-empty 는 CSS로 영구 숨김) #side-tree 가 갱신되지 않는
 *  "조용한 빈 상태"였다.
 *
 * 검증 항목:
 *  ① 구역 0개 + 프로젝트 선택됨 → #side-tree 안에 실제 안내(+생성 버튼)가 렌더된다.
 *  ② 구역 1개 이상 → 기존 트리(#decks-list 행 + UI.renderTree 위임)가 그대로 렌더된다(회귀 없음).
 *  ③ 프로젝트 미선택 → 구역 0개 안내를 띄우지 않는다(#side-tree 비어 있음 — 잘못된 안내 금지).
 *  ④ 안내의 생성 버튼 클릭 → 기존 생성 경로(Projects.createDeck)를 호출한다(새 로직 아님).
 *
 * 실제 모듈 소스(31_Projects.js)를 그대로 vm에 평가해 검사한다(목 구현 아님).
 * 뮤테이션 2건이 붙어 있어, 고친 코드를 되돌리면 해당 검사가 실패한다.
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
{
  const { Projects, registry } = loadProjects(projectsSrc, {
    currentProject: { id: "p1", name: "테스트 프로젝트" }, decks: []
  });
  Projects._renderDecks();
  const host = registry["side-tree"];
  ok(/side-tree-empty/.test(host.innerHTML), "① 구역 0개+프로젝트 선택 → #side-tree 에 안내 렌더됨");
  ok(/구역이 없습니다/.test(host.innerHTML), "① 안내 문구에 '구역이 없습니다' 포함");
  ok(/id="side-tree-create-deck"/.test(host.innerHTML), "① 안내에 생성 버튼(id=side-tree-create-deck) 포함");
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

// ③ 프로젝트 미선택 → 구역 0개 안내를 띄우지 않음
{
  const { Projects, registry } = loadProjects(projectsSrc, { currentProject: null, decks: [] });
  Projects._renderDecks();
  const host = registry["side-tree"];
  ok(host.innerHTML === "", `③ 프로젝트 미선택 → #side-tree 비어 있음 (실제 "${host.innerHTML}")`);
}

// ④ 안내의 생성 버튼 → 기존 생성 경로(Projects.createDeck) 호출
{
  const { Projects, registry } = loadProjects(projectsSrc, {
    currentProject: { id: "p1", name: "테스트 프로젝트" }, decks: []
  });
  Projects._renderDecks();
  let called = 0;
  Projects.createDeck = () => { called++; };
  const btn = registry["side-tree-create-deck"];
  ok(!!btn, "④ 생성 버튼 엘리먼트가 실제로 registry 에 존재(고아 아님)");
  if (btn) btn.click();
  ok(called === 1, `④ 버튼 클릭 시 Projects.createDeck() 이 정확히 1회 호출됨 (실제 ${called})`);
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
    const { Projects, document } = loadProjects(mutated, { currentProject: { id: "p1", name: "테스트" }, decks: [] });
    Projects._renderDecks();
    const host = document.getElementById("side-tree"); // 뮤테이션 상태에선 손대지 않아 빈 채로 남음
    ok(!/side-tree-empty/.test(host.innerHTML || ""),
      `뮤테이션 적용 시 ①이 깨짐(테스트 실효성 증명) → innerHTML="${host.innerHTML}"`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 B: 프로젝트 미선택에도 안내를 띄우면 ③이 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션B] 프로젝트 미선택 가드 제거(항상 안내 렌더) → ③이 실패해야 함");
  const needle = `      if (!this.currentProject) { host.innerHTML = ""; return; } // 프로젝트 미선택 — 안내 없음`;
  const mutated = projectsSrc.replace(needle, `      // 가드 제거(뮤테이션)`);
  if (mutated === projectsSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { Projects, registry } = loadProjects(mutated, { currentProject: null, decks: [] });
    Projects._renderDecks();
    const host = registry["side-tree"];
    ok(/side-tree-empty/.test(host.innerHTML || ""),
      `뮤테이션 적용 시 ③이 깨짐(테스트 실효성 증명 — 프로젝트 미선택인데도 안내가 뜸) → innerHTML="${host.innerHTML}"`);
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
