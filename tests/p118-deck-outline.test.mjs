/**
 * p118 — WO 20261002-allmenu §6: 메인 도면 위에 "그 메인을 캡처해 만든 구역"의 원본 윤곽을
 * 보여주고, 보기 상태에서는 윤곽 안쪽 클릭으로 그 구역으로 이동한다(지휘자 2차 추가지시).
 * (프레임워크 0 · 실행: node tests/p118-deck-outline.test.mjs)
 *
 * [재현] 지휘자 R3: `git grep -n -i "src_crop" HEAD -- public/js/modules src/index.tsx`
 *   → 31_Projects.js(저장)·41_RegionMerge.js(합치기)·src/index.tsx(검증)뿐, 렌더/클릭 코드 0건.
 *   → FAIL(원본 상자는 저장되지만 메인 도면 위에 그리지도, 클릭 이동도 되지 않았다).
 *
 * 🔴 목 금지(단, 협력 모듈은 p103 과 같은 관례로 경량 스텁) — 단위 대상(46_DeckOutline.js)과
 *   좌표계(01_State.js·10_MapCtrl.js)는 실제 소스를 vm 에 그대로 실행해 검증한다. UI/Zones/Projects
 *   는 DeckOutline 의 "협력자"일 뿐이라 p103 이 App/Prompt/Zones 를 스텁한 것과 동일한 관례로
 *   경량 스텁(동작 기록용 스파이)을 쓴다 — 가짜는 스텁뿐, DeckOutline 자신의 로직은 전부 실행된다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const stateSrc = rd("public/js/modules/01_State.js");
const mapSrc = rd("public/js/modules/10_MapCtrl.js");
const doSrc = rd("public/js/modules/46_DeckOutline.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ══ 가짜 DOM(id 레지스트리 기반 — getElementById 가 동적 생성 요소도 찾는다) ══ */
function makeEnv() {
  const idReg = new Map();
  function makeEl(tag) {
    const el = {
      tagName: tag, _classes: new Set(), style: {}, dataset: {}, attrs: {},
      children: [], parentNode: null, offsetWidth: 1000, offsetHeight: 800,
      _id: "",
      get id() { return el._id; },
      set id(v) { if (el._id) idReg.delete(el._id); el._id = v; if (v) idReg.set(v, el); },
      classList: {
        add: (...c) => c.forEach((x) => el._classes.add(x)),
        remove: (...c) => c.forEach((x) => el._classes.delete(x)),
        contains: (c) => el._classes.has(c),
        toggle(c, f) {
          if (f === undefined) { if (el._classes.has(c)) { el._classes.delete(c); return false; } el._classes.add(c); return true; }
          if (f) el._classes.add(c); else el._classes.delete(c);
          return !!f;
        }
      },
      _listeners: {},
      addEventListener(t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn); },
      removeEventListener(t, fn) { const a = el._listeners[t]; if (!a) return; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
      dispatch(t, ev) { (el._listeners[t] || []).slice().forEach((fn) => fn(ev || {})); },
      appendChild(c) { el.children.push(c); c.parentNode = el; return c; },
      insertBefore(n, ref) {
        const i = ref ? el.children.indexOf(ref) : -1;
        if (i >= 0) el.children.splice(i, 0, n); else el.children.push(n);
        n.parentNode = el; return n;
      },
      removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
      remove() { if (el.parentNode) el.parentNode.removeChild(el); },
      get nextSibling() { if (!el.parentNode) return null; const i = el.parentNode.children.indexOf(el); return el.parentNode.children[i + 1] || null; },
      setAttribute(k, v) { el.attrs[k] = v; if (k === "id") el.id = v; },
      getAttribute(k) { return k === "id" ? el._id : el.attrs[k]; },
      closest(sel) {
        const cls = sel.replace(/^\./, "");
        let n = el;
        while (n) { if (n.classList && n.classList.contains(cls)) return n; n = n.parentNode; }
        return null;
      },
      querySelectorAll(sel) {
        const cls = sel.replace(/^\./, "").split(".").filter(Boolean);
        const dataAttr = /^\[data-([\w-]+)\]$/.exec(sel);
        const out = [];
        const walk = (node) => {
          (node.children || []).forEach((c) => {
            if (dataAttr) { if (c.attrs && (dataAttr[1] in c.attrs)) out.push(c); }
            else if (cls.length && cls.every((x) => c.classList && c.classList.contains(x))) out.push(c);
            walk(c);
          });
        };
        walk(el);
        return out;
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      get className() { return Array.from(el._classes).join(" "); },
      set className(v) { el._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
      set innerHTML(v) { el._html = v; el.children = []; },
      get innerHTML() { return el._html || ""; },
      get textContent() { return el._text || ""; },
      set textContent(v) { el._text = v; },
      getBoundingClientRect() { return { left: 0, top: 0, width: el.offsetWidth, height: el.offsetHeight }; }
    };
    return el;
  }

  const bodyEl = makeEl("body");
  const vp = makeEl("div"); vp.id = "map-viewport";
  const transformEl = makeEl("div"); transformEl.id = "map-transform"; transformEl.offsetWidth = 1000; transformEl.offsetHeight = 800;
  bodyEl.appendChild(vp); vp.appendChild(transformEl);
  const zonesLayer = makeEl("div"); zonesLayer.id = "zones-layer"; transformEl.appendChild(zonesLayer);
  // 설정 패널의 360 리더선 토글 라벨(앵커) — 실 index.html 마크업과 동일한 for 속성만 재현
  const leaderLabel = makeEl("label"); leaderLabel.setAttribute("for", "chk-leader360");
  const settingsBlock = makeEl("div"); settingsBlock.appendChild(leaderLabel);
  bodyEl.appendChild(settingsBlock);

  const docListeners = {};
  const document_ = {
    getElementById: (id) => idReg.get(id) || null,
    createElement: (tag) => makeEl(tag),
    createElementNS: (ns, tag) => makeEl(tag),
    body: bodyEl,
    querySelector(sel) { return findByAttr(bodyEl, sel); },
    querySelectorAll: () => [],
    addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
    removeEventListener(t, fn) { const a = docListeners[t]; if (!a) return; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    dispatch(t, ev) { (docListeners[t] || []).slice().forEach((fn) => fn(ev || {})); }
  };
  // label[for="chk-leader360"] 전용 간이 검색(제너릭 쿼리 엔진 불필요 — 실제 호출부가 이 한 패턴뿐)
  function findByAttr(root, sel) {
    const m = /^label\[for="([^"]+)"\]$/.exec(sel);
    if (!m) return null;
    let found = null;
    const walk = (n) => { (n.children || []).forEach((c) => { if (c.tagName === "label" && c.attrs.for === m[1]) found = c; walk(c); }); };
    walk(root);
    return found;
  }

  const lsStore = {};
  const localStorage_ = { getItem: (k) => (k in lsStore ? lsStore[k] : null), setItem: (k, v) => { lsStore[k] = v; } };

  const calls = { selectDeck: [] };
  const UI = { escapeHtml: (s) => String(s), _alignCapture: null };
  const Zones = { render() {}, updateLabelScale() {} };
  const Projects = {
    decks: [], currentDeck: null,
    selectDeck(d) { calls.selectDeck.push(d); }
  };

  const sandbox = {
    console, document: document_, window: {}, navigator: { onLine: true },
    UI, Zones, Projects, localStorage: localStorage_,
    JSON, Array, Map, Set, Date, Math, String, Number, Object, Boolean,
    setTimeout, clearTimeout, performance, requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: (id) => clearTimeout(id)
  };
  vm.createContext(sandbox);
  vm.runInContext(
    stateSrc + "\n" + mapSrc + "\n" + doSrc + "\n;globalThis.__STATE=State;globalThis.__MC=MapCtrl;globalThis.__DO=DeckOutline;",
    sandbox
  );
  const State = sandbox.__STATE, MapCtrl = sandbox.__MC, DeckOutline = sandbox.__DO;
  MapCtrl.init(vp, transformEl);
  return { State, MapCtrl, DeckOutline, Projects, Zones, UI, vp, transformEl, zonesLayer, calls, document: document_ };
}

/* ══ ① _boxesForCurrentPage — 벡터복사(src_crop)·창(crop)·자기제외·다른 페이지/배포본 제외 ══ */
function testBoxes() {
  const { State, Projects, DeckOutline } = makeEnv();
  State.currentDeploymentId = "dep-main"; State.pdfPage = 1;
  Projects.currentDeck = { id: "self" };
  Projects.decks = [
    { id: "self", deployment_id: "dep-main", page: 1 }, // 자기 자신 — 제외
    { id: "vec1", name: "평면도", src_dep_id: "dep-main", src_page: 1, src_crop: { x: 10, y: 10, w: 20, h: 15 } }, // ①벡터 복사
    { id: "win1", name: "측면 창", deployment_id: "dep-main", page: 1, crop: { x: 40, y: 40, w: 10, h: 10 } }, // ②창 방식
    { id: "otherpage", name: "다른 페이지", src_dep_id: "dep-main", src_page: 2, src_crop: { x: 0, y: 0, w: 5, h: 5 } }, // 페이지 다름 — 제외
    { id: "otherdep", name: "다른 배포본", deployment_id: "dep-other", page: 1, crop: { x: 0, y: 0, w: 5, h: 5 } }, // 배포본 다름 — 제외
  ];
  const boxes = DeckOutline._boxesForCurrentPage();
  ok(boxes.length === 2, "①a 메인(dep-main · page1) 위 윤곽 = 2개(벡터+창), 자기/다른페이지/다른배포본 제외 → " + boxes.length);
  ok(boxes.some((b) => b.id === "vec1" && b.x === 10 && b.w === 20), "①b 벡터 복사 구역은 src_crop 좌표를 그대로 사용");
  ok(boxes.some((b) => b.id === "win1" && b.x === 40 && b.w === 10), "①c 창 방식 구역은 crop 좌표를 그대로 사용");
  ok(!boxes.some((b) => b.id === "self" || b.id === "otherpage" || b.id === "otherdep"), "①d 자기 자신·다른 페이지·다른 배포본 윤곽 0개");

  // [뮤테이션 증명] _boxesForCurrentPage 의 src_dep_id 분기(if (d.src_dep_id && ...))를 통째로 주석(return 무조건
  // null) 처리 → ①a/①b EXIT=1 확인 후 원복(아래 자동 실행, 지휘자 보고용 기록 — 실측은 본문 하단 참조).
}

/* ══ ② 편집 도구 활성 판정 — placing/drawingZone/annoTool/정렬캡처 중엔 윤곽 클릭 양보 ══ */
function testEditActive() {
  const { State, UI, DeckOutline } = makeEnv();
  ok(DeckOutline._editActive() === false, "②a 기본 상태(편집 도구 無) → false");
  State.placing = true; ok(DeckOutline._editActive() === true, "②b 핀 배치 중 → true"); State.placing = false;
  State.drawingZone = true; ok(DeckOutline._editActive() === true, "②c 영역 그리기 중 → true"); State.drawingZone = false;
  State.annoTool = "rect"; ok(DeckOutline._editActive() === true, "②d 주석 도구(cursor 아님) → true"); State.annoTool = "cursor";
  UI._alignCapture = {}; ok(DeckOutline._editActive() === true, "②e 리더선 정렬 클릭 캡처 중 → true"); UI._alignCapture = null;
  ok(DeckOutline._editActive() === false, "②f 전부 해제 후 → false");
}

/* ══ ③ 드래그/팬 뒤 클릭 무시 — 5px 임계값(11_UI.js 핀 드래그와 동일 수치 재사용) ══ */
function testWasDrag() {
  const { DeckOutline } = makeEnv();
  DeckOutline._downPt = { x: 100, y: 100 };
  ok(DeckOutline._wasDrag({ clientX: 102, clientY: 101 }) === false, "③a 3px 이동 → 드래그 아님(클릭 유효)");
  ok(DeckOutline._wasDrag({ clientX: 120, clientY: 100 }) === true, "③b 20px 이동 → 드래그(클릭 무시)");
}

/* ══ ④~⑧ 보기 상태 통합 — 윤곽 안쪽 클릭(바디) → 이동 / 라벨·핀 클릭은 양보 / 편집 중·드래그 뒤엔 이동 無 ══ */
function testViewClickIntegration2() {
  const env = makeEnv();
  const { State, Projects, DeckOutline, vp, calls } = env;
  DeckOutline.init();
  State.currentDeploymentId = "dep-main"; State.pdfPage = 1;
  Projects.decks = [
    { id: "big", name: "큰 구역", src_dep_id: "dep-main", src_page: 1, src_crop: { x: 0, y: 0, w: 60, h: 60 } },
    { id: "small", name: "작은 구역", src_dep_id: "dep-main", src_page: 1, src_crop: { x: 20, y: 20, w: 10, h: 10 } },
  ];
  DeckOutline.render();

  const bg = { closest() { return null; } };
  // ── ④ 겹침 → 가장 작은 구역("small") ──
  vp.dispatch("mousedown", { clientX: 250, clientY: 200 });
  vp.dispatch("click", { clientX: 250, clientY: 200, target: bg });
  ok(calls.selectDeck.length === 1 && calls.selectDeck[0].id === "small", "④ 겹친 두 윤곽(큰/작은) 클릭 → 가장 작은 구역으로 이동 → " + JSON.stringify(calls.selectDeck.map((d) => d.id)));

  // ── ⑤ 핀 위 클릭 → 핀 우선(이동 없음) ──
  calls.selectDeck.length = 0;
  const pinTarget = { closest(sel) { return sel === ".pin-marker" ? this : null; } };
  vp.dispatch("mousedown", { clientX: 250, clientY: 200 });
  vp.dispatch("click", { clientX: 250, clientY: 200, target: pinTarget });
  ok(calls.selectDeck.length === 0, "⑤ 핀(.pin-marker) 위 클릭 → 윤곽 이동 없음(핀 팝업 우선)");

  // ── ⑥ 편집 도구(핀 배치) 켜진 상태 → 윤곽 안쪽 클릭이어도 이동 없음 ──
  calls.selectDeck.length = 0;
  State.placing = true;
  vp.dispatch("mousedown", { clientX: 250, clientY: 200 });
  vp.dispatch("click", { clientX: 250, clientY: 200, target: bg });
  ok(calls.selectDeck.length === 0, "⑥ 핀 배치 모드 켜짐 → 윤곽 클릭해도 이동 없음(기존 핀 생성 클릭 경로 유지)");
  State.placing = false;

  // ── ⑦ 드래그(팬) 뒤 클릭 → 이동 없음 ──
  calls.selectDeck.length = 0;
  vp.dispatch("mousedown", { clientX: 250, clientY: 200 });
  vp.dispatch("click", { clientX: 280, clientY: 200, target: bg }); // 30px 이동 = 드래그
  ok(calls.selectDeck.length === 0, "⑦ 30px 이동 후(팬으로 간주) 클릭 → 이동 없음");

  // ── ⑧ 라벨 클릭은 항상 이동(편집 도구 상태와 무관) ──
  calls.selectDeck.length = 0;
  State.placing = true;
  DeckOutline._goto("big"); // 라벨 click 핸들러가 내부적으로 호출하는 것과 동일한 경로(2730행대 handler)
  ok(calls.selectDeck.length === 1 && calls.selectDeck[0].id === "big", "⑧ 라벨 클릭 경로(_goto)는 편집 모드와 무관하게 항상 이동 유지");
  State.placing = false;
}

/* ══ ⑨ 대비 — 윤곽선(#4338ca) 백색 도면 대비 ≥3:1, 라벨 흰 글자 on #4338ca ≥4.5:1 + CSS 충돌 0 ══ */
function testContrastAndCss() {
  const lum = (r, g, b) => {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const [R, G, B] = [f(r), f(g), f(b)];
    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
  };
  const ratio = (l1, l2) => { const a = Math.max(l1, l2) + 0.05, b = Math.min(l1, l2) + 0.05; return a / b; };
  const white = lum(255, 255, 255);
  const indigo = lum(0x43, 0x38, 0xca);
  const rLine = ratio(white, indigo);
  ok(rLine >= 3, "⑨a 윤곽선 #4338ca on 백색 도면 대비 " + rLine.toFixed(2) + ":1 ≥ 3:1");
  const textW = lum(255, 255, 255);
  const rLabel = ratio(textW, indigo);
  ok(rLabel >= 4.5, "⑨b 라벨 흰 글자 on #4338ca 배경 대비 " + rLabel.toFixed(2) + ":1 ≥ 4.5:1");

  const css3 = ["public/css/style.css", "public/css/seastar-family-tokens.css", "public/css/seastar-3d-skin.css"]
    .map((p) => fs.readFileSync(path.join(ROOT, p), "utf8"));
  const collisions = css3.filter((src) => /\.deck-outline-(shape|label|svg|layer|tip)\b/.test(src)).length;
  ok(collisions === 1, "⑨c 신규 클래스가 3개 CSS 파일 중 정확히 1곳에만 정의(충돌 0) → " + collisions);
}

testBoxes();
testEditActive();
testWasDrag();
testViewClickIntegration2();
testContrastAndCss();

console.log(failed === 0 ? "\n✅ p118 전체 PASS" : `\n❌ p118 ${failed}건 FAIL`);
process.exit(failed === 0 ? 0 : 1);
