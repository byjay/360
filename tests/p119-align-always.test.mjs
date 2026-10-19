/**
 * p119 — WO 20261002-allmenu §2: 리더선 정렬 상시 노출 + [선택] 모드 = 디자이너 이상(삭제만 소유자·super)
 * (프레임워크 0 · 실행: node tests/p119-align-always.test.mjs)
 *
 * [재현] 지휘자 R1: `git grep -n "_startAlign(" HEAD -- public/js/modules` → 11_UI.js:137-138 둘 다
 *   `if (s.on)`(트리 핀 목록 [선택] 모드) 안에서만 생성. [선택] 진입은 _pinBulkOk(소유자·super) → FAIL.
 *
 * 🔴 목 금지 — 실제 소스(01_State.js, 01b_PinSeries.js, 10_MapCtrl.js, 11_UI.js)를 vm 에 concat 실행.
 *   가짜는 DOM 셸과 협력자 스텁(App.canBulkDeletePins/Projects.currentDeck)뿐(p103 과 같은 관례).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const SRC = ["01_State.js", "01b_PinSeries.js", "10_MapCtrl.js", "11_UI.js"].map((f) => rd("public/js/modules/" + f)).join("\n");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };

function makeEl(tag) {
  const el = {
    tagName: tag, _classes: new Set(), style: {}, dataset: {}, children: [], attrs: {}, _id: "",
    parentNode: null, offsetWidth: 1000, offsetHeight: 800, disabled: false, title: "",
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
    appendChild(c) { el.children.push(c); c.parentNode = el; if (c._id && el._reg) el._reg.set(c._id, c); return c; },
    insertBefore(n, ref) { const i = ref ? el.children.indexOf(ref) : -1; if (i >= 0) el.children.splice(i, 0, n); else el.children.push(n); n.parentNode = el; return n; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
    remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    setAttribute(k, v) { el.attrs[k] = v; },
    getAttribute(k) { return el.attrs[k]; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    insertAdjacentHTML() {},
    click() { el.dispatch("click", { stopPropagation() {}, preventDefault() {} }); },
    getBoundingClientRect() { return { left: 0, top: 0, width: el.offsetWidth, height: el.offsetHeight }; },
    get className() { return Array.from(el._classes).join(" "); },
    set className(v) { el._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    set innerHTML(v) { el._html = v; el.children = []; },
    get innerHTML() { return el._html || ""; },
    get textContent() { return el._text || ""; },
    set textContent(v) { el._text = v; }
  };
  return el;
}

function loadEnv({ owner = true } = {}) {
  const reg = new Map();
  const dl = {};
  const bar = makeEl("div");
  const document = {
    getElementById: (id) => reg.get(id) || null,
    createElement: (tag) => {
      const e = makeEl(tag);
      // id 대입 시 레지스트리 등록(동적 생성 요소도 getElementById 로 찾도록)
      Object.defineProperty(e, "id", { get() { return e._id; }, set(v) { e._id = v; reg.set(v, e); } });
      return e;
    },
    createElementNS: (ns, tag) => makeEl(tag),
    body: { appendChild() {} },
    querySelector: (sel) => (sel === "#mobile-dock .mdock-bar" ? bar : null),
    querySelectorAll: () => [],
    addEventListener(t, fn) { (dl[t] = dl[t] || []).push(fn); },
    removeEventListener(t, fn) { const a = dl[t]; if (!a) return; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  };
  const put = (id, tag = "div") => { const e = document.createElement(tag); e.id = id; return e; };
  put("pins-layer"); put("leader-layer", "svg");
  const transformEl = put("map-transform"); transformEl.offsetWidth = 1000; transformEl.offsetHeight = 800;
  const viewportEl = put("map-viewport");
  const tb = put("pdf-toolbar");
  const more = put("mdock-more-toggle", "button"); bar.appendChild(more);
  const toasts = [];
  const App = { _markDirty() {}, _autoSave() {}, setActivePin() {}, onPinTap() {}, deletePins: async () => 0, canBulkDeletePins: () => owner };
  const Projects = { currentDeck: null, decks: [] };
  const sandbox = {
    console, document, window: {}, navigator: { onLine: true },
    App, Projects, Prompt: { toast: (m) => toasts.push(m) }, Zones: { render() {} }, PdfAnno: { refresh() {} }, PinIcons: { headMarkup: () => "" },
    Auth: { readonly: false },
    JSON, Array, Map, Set, Date, Math, String, Number, Object, Boolean,
    setTimeout, clearTimeout, localStorage: { getItem: () => null, setItem() {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC + "\n;globalThis.__UI=UI;globalThis.__STATE=State;globalThis.__MC=MapCtrl;", sandbox);
  const UI = sandbox.__UI, State = sandbox.__STATE;
  sandbox.__MC.init(viewportEl, transformEl);
  return { UI, State, Projects, tb, bar, viewportEl, toasts, reg, sandbox };
}

/* ══ A. 상시 노출 — CHECKER 툴바(데스크톱 #pdf-toolbar + 모바일 도크)에 정렬 ↕/↔ ══ */
{
  const { UI, State, tb, bar, reg } = loadEnv({ owner: false });
  State.mode = "designer"; State.regMode = "checkboard";
  UI.mountCheckerAlignTools();
  const grp = reg.get("checker-align-tools");
  ok(!!grp && grp.parentNode === tb, "A1 #pdf-toolbar 안에 정렬 도구 그룹 생성");
  const axes = grp ? grp.children.filter((c) => c.dataset && c.dataset.alignAxis).map((c) => c.dataset.alignAxis).join(",") : "";
  ok(axes === "v,h", "A2 데스크톱 툴바 버튼 = [정렬 ↕][정렬 ↔] → " + axes);
  const mv = reg.get("mdock-align-v"), mh = reg.get("mdock-align-h");
  ok(!!mv && !!mh && bar.children.indexOf(mv) >= 0 && bar.children.indexOf(mv) < bar.children.indexOf(reg.get("mdock-more-toggle")), "A3 모바일 도크에 정렬 칩 2개(더보기 앞)");
  ok(!grp.classList.contains("hidden") && !mv.classList.contains("hidden"), "A4 CHECKER 모드 + 비소유 디자이너 → 보임(권한·선택 모드와 무관)");
  State.regMode = "photo"; UI.syncCheckerAlignTools();
  ok(grp.classList.contains("hidden") && mh.classList.contains("hidden"), "A5 360 모드 → 툴바에서는 숨김(모드 전용 도구)");
  State.regMode = "checkboard"; State.mode = "viewer"; UI.syncCheckerAlignTools();
  ok(grp.classList.contains("hidden"), "A6 열람(viewer) → 숨김");
  UI.mountCheckerAlignTools();
  ok(tb.children.filter((c) => c._id === "checker-align-tools").length === 1 && bar.children.filter((c) => c._id === "mdock-align-v").length === 1, "A7 재호출해도 중복 생성 0");
}

/* ══ B. 선택 0 → 현재 구역·영역의 CHECKER 핀 전체(360 핀·다른 페이지·창 밖 제외) ══ */
{
  const { UI, State, Projects, reg, viewportEl } = loadEnv({ owner: false });
  State.mode = "designer"; State.regMode = "checkboard"; State.pdfPage = 1; State.zoom = 1; State.currentDeploymentId = "dep1";
  // [WO 20261008-pinstyle] 정렬 대상 = 리더선 핀만 → 범위 판정(창·모드·페이지)은 모두 리더선 핀으로 검사하고,
  //   창 안 CHECKER 지만 핀 표현(leader:false)인 7 이 빠지는지도 함께 본다.
  const P = (id, x, y, extra) => Object.assign({ id, x, y, page: 1, checkboard: true, label: String(id), leader: true }, extra || {});
  const c1 = P(1, 20, 20), c2 = P(2, 30, 30), c3 = P(3, 40, 40);
  const out = P(4, 90, 90);                       // 창(crop) 밖
  const p360 = P(5, 25, 25, { checkboard: false, label: "P1" });   // 360 계열
  const pg2 = P(6, 25, 25, { page: 2 });          // 다른 페이지
  const plain = P(7, 35, 35, { leader: false });  // 창 안 CHECKER 지만 핀 표현
  State.pins = [c1, c2, c3, out, p360, pg2, plain];
  Projects.currentDeck = { id: "dk1a", deployment_id: "dep1", crop: { x: 10, y: 10, w: 50, h: 50 }, page: 1 };
  UI.mountCheckerAlignTools();
  ok(UI._pinSel.ids.size === 0 && !UI._pinSel.on, "B0 전제 — 선택 0개, 선택 모드 꺼짐");
  reg.get("mdock-align-v").click();
  ok(!!UI._alignCapture, "B1 도크 [정렬 ↕] → 정렬 대기(도면 클릭 캡처)");
  viewportEl.dispatch("click", { clientX: 500, clientY: 80, stopPropagation() {}, preventDefault() {} });
  const got = State.pins.filter((p) => p.callout).map((p) => p.id).join(",");
  // 🔴 [WO 20261019-unifymode] 전: 1,2,3(360 계열 5 제외 — 모드 범위) / 후: 1,2,3,5(체커 메타 무관 — 핀은 하나). 창 밖(4)·다른 페이지(6)·핀 표현(7) 제외는 그대로.
  ok(got === "1,2,3,5", "B2 정렬 대상 = 창 안 리더선 핀 1,2,3,5 (체커 메타 무관 · 창 밖·다른 페이지·핀 표현 제외) → " + got);
  ok(c1.callout.x === 50 && c2.callout.x === 50 && c3.callout.x === 50 && c2.callout.y > c1.callout.y, "B3 세로 등간격(x 동일·번호순)");
  ok(c1.x === 20 && c1.y === 20, "B4 화살촉(대상 x,y) 불변");
  UI.undoAlign();
  ok(!c1.callout && !c2.callout && !c3.callout, "B5 되돌리기 → 정렬 전 상태");
}

/* ══ C. [선택] 모드 = 디자이너 이상 · 삭제만 소유자·super(숨김 금지 → 비활성 + 사유) ══ */
{
  const { UI, State } = loadEnv({ owner: false });
  State.mode = "designer"; State.pins = [{ id: 1, x: 1, y: 1, page: 1, checkboard: true, label: "1" }];
  UI.setPinSelectMode(true);
  ok(UI._pinSel.on === true, "C1 비소유 디자이너 → [선택] 모드 진입 가능");
  UI._pinSel.ids.add("1");
  const btns = UI._pinBulkButtons({ scopePins: State.pins, scopeLabel: "이 구역 CHECKER" });
  const has = (c) => btns.find((b) => b.classList.contains(c));
  ok(!!has("pin-align-v") && !!has("pin-align-h"), "C2 선택 모드 → 정렬 ↕/↔ 버튼");
  const del = has("pin-bulk-del");
  ok(!!del && del.disabled === true && del.attrs["aria-disabled"] === "true" && /소유자·관리자 전용/.test(del.title), "C3 [선택 삭제] 는 숨기지 않고 비활성 + 사유 → " + (del && del.title));
  ok(!has("pin-bulk-scope"), "C4 범위 전체 삭제(파괴적)는 비소유자에게 생성 안 함");
  State.mode = "viewer"; UI.setPinSelectMode(true);
  ok(UI._pinSel.on === false, "C5 열람(viewer) → [선택] 진입 불가");
}
{
  const { UI, State } = loadEnv({ owner: true });
  State.mode = "designer"; State.pins = [{ id: 1, x: 1, y: 1, page: 1, checkboard: true, label: "1" }];
  UI.setPinSelectMode(true); UI._pinSel.ids.add("1");
  const btns = UI._pinBulkButtons({ scopePins: State.pins, scopeLabel: "이 구역 CHECKER" });
  const del = btns.find((b) => b.classList.contains("pin-bulk-del"));
  ok(del && del.disabled === false && !!btns.find((b) => b.classList.contains("pin-bulk-scope")), "C6 소유자 → [선택 삭제] 활성 + 범위 삭제 버튼 존재(종전 동작 유지)");
}

console.log(failed ? `\nFAIL ${failed}` : "\nALL PASS");
process.exit(failed ? 1 : 0);
