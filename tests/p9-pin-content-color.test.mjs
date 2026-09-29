/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p9-pin-content-color.test.mjs)
 *
 * 마스터 지시(2026-09-03): "사진이 등록된거와 아닌거 심볼색을 다르게해"
 *
 * 근본원인: PinSeries.kindOf() 가 `if (pin.checkboard) return "checkboard"` 를
 *   콘텐츠 판정보다 먼저 반환한다. 색은 kind 로만 결정됐으므로
 *   **체크보드 핀은 사진이 있든 없든 항상 같은 색**이었다 → 일괄 매칭 직후
 *   무엇이 등록됐는지 화면으로 확인할 방법이 없었다.
 *
 * 검사:
 *   ① 체크보드 + 사진 vs 체크보드 + 무사진 → 색이 다르다(도면 마커·미니맵 둘 다)
 *   ② 일반 핀의 content/empty 구분은 그대로 유지된다
 *   ③ 도면 마커와 미니맵 점이 **같은 판정**(PinSeries.markerStyle 정본)을 쓴다
 *   ④ 번호 체계(PinSeries.numbers)는 변하지 않는다
 *   ⑤ 색맹 대비: 색 외 형태 단서(링 dasharray / 점 테두리)로도 구분된다
 *   ⑥ WCAG 대비 실측: 흰 디스크 위 숫자 ≥4.5:1 · 흰 도면 위 마커 외곽 ≥3:1
 *
 * 실제 모듈 소스(01b_PinSeries.js / 11_UI.js / 07_Radar.js)를 그대로 vm 에 평가한다(목 구현 아님).
 * 뮤테이션 2건이 붙어 있어, 고친 코드를 되돌리면 해당 검사가 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const seriesSrc = rd("public/js/modules/01b_PinSeries.js");
const uiSrc     = rd("public/js/modules/11_UI.js");
const radarSrc  = rd("public/js/modules/07_Radar.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── WCAG 2.1 대비비 (의존성 0 · 전역 CLAUDE.md §4 체커) ───────── */
const lum = (hex) => {
  const v = String(hex).replace("#", "");
  const c = [0, 2, 4].map((i) => parseInt(v.substr(i, 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => {
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

/* ── 최소 DOM 목 (p4 와 동일 구조) ─────────────────────────────── */
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
const makeLocalStorage = () => {
  const store = {};
  return { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
};

/** 실제 App.pinHasContent 와 같은 판정(미디어 또는 노트/첨부) */
const AppMock = {
  pinHasContent(pin) {
    return !!(pin && (pin.imageId || pin.imageUrl || pin.videoId ||
      pin.note || (pin.attachments && pin.attachments.length) || pin.has3D));
  }
};

/** 도면 마커 렌더 → 핀별 {no, kind, filled, colors, dash} */
function runUI(sSrc, uSrc, pins, page = 1) {
  const { document, registry } = makeDoc();
  const State = { pins, pdfPage: page, mode: "viewer", activePin: null, zoneView: null, zones: [] };
  const sandbox = { console, document, State, localStorage: makeLocalStorage(), App: AppMock, JSON, Map, Set };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(sSrc + "\n" + uSrc + "\n;globalThis.__UI = UI; globalThis.__PS = PinSeries;", sandbox);
  sandbox.__UI.renderPinsOnMap();
  const out = {};
  registry["pins-layer"]._children.forEach((m) => {
    const html = m._html;
    const stops = (html.match(/stop-color="(#[0-9a-fA-F]{6})"/g) || []).map((s) => s.slice(12, -1));
    const txt = (html.match(/fill="(#[0-9a-fA-F]{6})">\d+<\/text>/) || [])[1] || null;
    const dash = (html.match(/stroke-dasharray="([^"]*)"/) || [])[1] || "";
    const headFillAttr = (html.match(/r="11\.8" fill="([^"]+)"/) || [])[1] || null;
    out[m.dataset.id] = {
      no: String(m.dataset.no), kind: m.dataset.kind, filled: m.dataset.filled,
      head: stops[0], head2: stops[1], needle: stops[3], text: txt, dash: dash,
      headFillAttr: headFillAttr,
      cls: m.className, pulse: /pin-pulse/.test(html),
      // [WO 20260917 형태단서 재설계] tier(photo/content/empty) + 속 원판 실루엣(pin-tier-disc)의
      // 태그명(circle/rect)만 검출 — fill/stroke 색 속성은 일부러 보지 않는다(흑백 구분 검증용).
      tier: m.dataset.tier,
      discTag: (html.match(/<(circle|rect)\b[^>]*class="pin-tier-disc"/) || [])[1] || null
    };
  });
  return { pins: out, PS: sandbox.__PS };
}

/** 미니맵 점 렌더 → 핀별 {no, kind, filled, bg, border} */
function runRadar(sSrc, rSrc, pins, currentPin, page = 1) {
  const { document, registry } = makeDoc();
  const State = { pins, pdfPage: page, mode: "viewer", viewerPages: ["p1.jpg"], zones: [] };
  const sandbox = { console, document, State, localStorage: makeLocalStorage(), App: AppMock, JSON, Map, Set };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(sSrc + "\n" + rSrc + "\n;globalThis.__R = Radar; globalThis.__PS = PinSeries;", sandbox);
  sandbox.__R.update(currentPin);
  const out = {};
  registry["pano-radar-pins"]._children.forEach((d) => {
    out[d.dataset.id] = {
      no: String(d._children[0] && d._children[0]._text), kind: d.dataset.kind, filled: d.dataset.filled,
      bg: d.style.background, border: d.style.borderStyle, cls: d.className
    };
  });
  return { pins: out, PS: sandbox.__PS };
}

/* 픽스처 — 체크보드 계열에 "사진 있음/없음" 을 섞는다(일괄 매칭 직후 상황)
   콘텐츠 계열: c1(사진), e1(빈 핀), c2(노트)        → 1, 2, 3
   체크보드 계열: bA(label 없음·사진 있음) → 1,
                  bB(label "77"·사진 없음) → 77,
                  bC(label 없음·사진 없음) → 3 */
const FIXTURE = () => [
  { id: "c1", page: 1, x: 10, y: 10, imageId: "img1" },
  { id: "bA", page: 1, x: 15, y: 15, checkboard: true, imageId: "shot-A" },
  { id: "e1", page: 1, x: 20, y: 20 },
  { id: "bB", page: 1, x: 25, y: 25, checkboard: true, label: "77" },
  { id: "x1", page: 2, x: 30, y: 30, imageId: "img2" },
  { id: "c2", page: 1, x: 35, y: 35, note: "확인 필요" },
  { id: "bC", page: 1, x: 40, y: 40, checkboard: true },
  // 미니맵의 "현재 열람 중인 핀" — 골드 강조라 배경색을 인라인 지정하지 않는다(기존 사양).
  // 색 비교 대상에서 제외하기 위해 별도로 둔다.
  { id: "cur", page: 1, x: 45, y: 45, imageId: "img-cur" }
];
const CURRENT = (f) => f.find((p) => p.id === "cur");
/** 미니맵 현재 핀은 골드 강조(인라인 색 없음) → 색 비교에서 제외 */
const COLORED = (ids) => ids.filter((id) => id !== "cur");

/* ────────────────────────────────────────────────────────────
 * ① 체크보드 계열 안에서 사진 유무가 색으로 구분된다
 * ──────────────────────────────────────────────────────────── */
function suiteCheckboardColor(label, sSrc, rSrc) {
  console.log("\n[" + label + "]");
  const fixture = FIXTURE();
  const ui = runUI(sSrc, uiSrc, fixture).pins;
  const rdr = runRadar(sSrc, rSrc, fixture, CURRENT(fixture)).pins;

  ok(ui.bA.head2 !== ui.bB.head2,
    `도면 체크보드 머리색: 사진O ${ui.bA.head2} ≠ 사진X ${ui.bB.head2}`);
  ok(ui.bA.needle !== ui.bB.needle,
    `도면 체크보드 바늘색: 사진O ${ui.bA.needle} ≠ 사진X ${ui.bB.needle}`);
  ok(ui.bB.head2 === ui.bC.head2 && ui.bB.needle === ui.bC.needle,
    "사진 없는 체크보드끼리는 같은 색(bB == bC)");
  ok(rdr.bA.bg !== rdr.bB.bg,
    `미니맵 체크보드 점 색: 사진O ${rdr.bA.bg} ≠ 사진X ${rdr.bB.bg}`);
  // 계열 정체성 유지 — 체크보드는 여전히 checkboard 부류(번호·필터 계열 불변)
  ok(ui.bA.kind === "checkboard" && ui.bB.kind === "checkboard" && ui.bC.kind === "checkboard",
    "체크보드 계열 정체성 유지(kind = checkboard) — 필터 칩·채번 계열 불변");
}

/* ────────────────────────────────────────────────────────────
 * ② 일반 핀의 content/empty 구분 유지
 * ──────────────────────────────────────────────────────────── */
function suiteNormalPins(label, sSrc) {
  console.log("\n[" + label + "]");
  const ui = runUI(sSrc, uiSrc, FIXTURE()).pins;
  ok(ui.c1.kind === "content" && ui.e1.kind === "empty", `일반 핀 부류 = ${ui.c1.kind}/${ui.e1.kind}`);
  ok(ui.c1.head2 !== ui.e1.head2, `일반 핀 색 구분 유지: 콘텐츠 ${ui.c1.head2} ≠ 미배치 ${ui.e1.head2}`);
  ok(ui.c1.filled === "1" && ui.e1.filled === "0", `콘텐츠=채움(${ui.c1.filled}) · 미배치=빈칸(${ui.e1.filled})`);
  ok(ui.c2.kind === "content" && ui.c2.filled === "1", "노트만 있는 핀도 콘텐츠로 판정(App.pinHasContent 정본 준수)");
}

/* ────────────────────────────────────────────────────────────
 * ③ 도면 == 미니맵 (같은 정본 판정)
 * ──────────────────────────────────────────────────────────── */
function suiteSameJudgment(label, sSrc, rSrc) {
  console.log("\n[" + label + "]");
  const fixture = FIXTURE();
  const ui = runUI(sSrc, uiSrc, fixture).pins;
  const rdr = runRadar(sSrc, rSrc, fixture, CURRENT(fixture)).pins;
  const ids = Object.keys(ui);
  ok(ids.length === 7, `도면 마커 수 = ${ids.length} (기대 7)`);
  const diff = ids.filter((id) => ui[id].filled !== rdr[id].filled);
  ok(diff.length === 0,
    `도면↔미니맵 사진 등록 판정 불일치 ${diff.length}건` +
    (diff.length ? " → " + diff.map((id) => `${id}: 도면 ${ui[id].filled} vs 미니맵 ${rdr[id].filled}`).join(", ") : ""));
  const cdiff = COLORED(ids).filter((id) => ui[id].needle !== rdr[id].bg);
  ok(cdiff.length === 0,
    `도면 바늘색 == 미니맵 점 색 (같은 정본에서 파생) · 불일치 ${cdiff.length}건`);
}

/* ────────────────────────────────────────────────────────────
 * ④ 번호 체계 불변
 * ──────────────────────────────────────────────────────────── */
function suiteNumbers(label, sSrc, rSrc) {
  console.log("\n[" + label + "]");
  const fixture = FIXTURE();
  const ui = runUI(sSrc, uiSrc, fixture).pins;
  const rdr = runRadar(sSrc, rSrc, fixture, CURRENT(fixture)).pins;
  ok(ui.c1.no === "1" && ui.e1.no === "2" && ui.c2.no === "3", `콘텐츠 계열 = ${ui.c1.no}/${ui.e1.no}/${ui.c2.no} (기대 1/2/3)`);
  ok(ui.bA.no === "1" && ui.bB.no === "77" && ui.bC.no === "3", `체크보드 계열 = ${ui.bA.no}/${ui.bB.no}/${ui.bC.no} (기대 1/77/3 — label 우선)`);
  const nd = Object.keys(ui).filter((id) => ui[id].no !== rdr[id].no);
  ok(nd.length === 0, `도면↔미니맵 번호 불일치 ${nd.length}건 (채번 정본 불변)`);
  ok(ui.x1 === undefined, "다른 페이지 핀은 렌더되지 않음");
}

/* ────────────────────────────────────────────────────────────
 * ⑤ 색 외 형태 단서 (색맹 8% 대비)
 * ──────────────────────────────────────────────────────────── */
function suiteShape(label, sSrc, rSrc) {
  console.log("\n[" + label + "]");
  const fixture = FIXTURE();
  const ui = runUI(sSrc, uiSrc, fixture).pins;
  const rdr = runRadar(sSrc, rSrc, fixture, CURRENT(fixture)).pins;
  ok(ui.bA.dash !== ui.bB.dash, `도면 링 패턴: 사진O "${ui.bA.dash}" ≠ 사진X "${ui.bB.dash}"`);
  ok(rdr.bA.border !== rdr.bB.border, `미니맵 점 테두리: 사진O ${rdr.bA.border} ≠ 사진X ${rdr.bB.border}`);
  ok(ui.bA.cls.indexOf("pin-filled") >= 0 && ui.bB.cls.indexOf("pin-hollow") >= 0,
    "도면 마커에 pin-filled / pin-hollow 클래스 부여(추가 형태 훅)");
  ok(ui.bA.pulse === true && ui.bB.pulse === false,
    "사진 등록된 체크보드에만 펄스 링(움직임 단서) — 색 없이도 식별");
  ok(ui.e1.dash === ui.bB.dash, "미등록은 계열과 무관하게 같은 점선 패턴(일관된 의미)");
}

/* ────────────────────────────────────────────────────────────
 * ⑥ WCAG 대비 실측 (전역 CLAUDE.md §4)
 *    도면/미니맵 배경은 도면 이미지(흰 종이)이고, 여기서 쓰는 색은 전부 리터럴 hex 라
 *    라이트/다크 테마에서 값이 동일하다(테마 변수 var(--x) 미사용 — 아래에서 검증).
 * ──────────────────────────────────────────────────────────── */
function suiteContrast(label, sSrc, rSrc) {
  console.log("\n[" + label + "]");
  const fixture = FIXTURE();
  const uiRes = runUI(sSrc, uiSrc, fixture);
  const ui = uiRes.pins;
  const PS = uiRes.PS;
  const rdr = runRadar(sSrc, rSrc, fixture, CURRENT(fixture)).pins;
  const WHITE = "#ffffff";

  // [2026-09-28 WO 번호 복구] 마스터 지시("번호가 안본다") — 9/21 지시("숫자 풍선 없애")를
  // 머리 안 번호까지 지우는 것으로 오해석한 회귀를 되돌렸다. 머리 안 숫자 <text> 가 다시
  // 렌더되며, 그 fill 색은 팔레트(colorsOf().text)를 그대로 쓴다 — 아래에서 렌더된 텍스트
  // 자체의 색과 팔레트 함수 직접호출 값이 일치하는지, 그리고 대비도 함께 확인한다.
  ["c1", "e1", "bA", "bB"].forEach((id) => {
    ok(ui[id].text !== null, `[WO 번호 복구] 도면 마커 ${id} 머리에 숫자 <text> 있음(현재=${ui[id].text})`);
  });
  [["content", true, "c1"], ["empty", false, "e1"], ["checkboard", true, "bA"], ["checkboard", false, "bB"]]
    .forEach(([kind, filled, refId]) => {
      const c = PS.colorsOf(kind, filled);
      const r = contrast(c.text, WHITE);
      ok(r >= 4.5, `[본문 4.5:1(팔레트 직접검증, ${refId} 대응)] colorsOf(${kind},${filled}).text ${c.text} ↔ 흰 디스크 #fff = ${r.toFixed(2)}:1`);
    });
  ["c1", "e1", "bA", "bB"].forEach((id) => {
    const r2 = contrast(ui[id].head2, WHITE);
    const r3 = contrast(ui[id].needle, WHITE);
    ok(r2 >= 3 && r3 >= 3,
      `[UI 3:1] ${id} 머리 ${ui[id].head2}=${r2.toFixed(2)}:1 · 바늘 ${ui[id].needle}=${r3.toFixed(2)}:1 ↔ 흰 도면`);
  });
  ["c1", "e1", "bA", "bB"].forEach((id) => {
    const r = contrast(rdr[id].bg, WHITE);
    ok(r >= 4.5, `[본문 4.5:1] 미니맵 ${id} 점 ${rdr[id].bg} ↔ 흰 숫자 #fff = ${r.toFixed(2)}:1`);
  });
  // 등록/미등록 상호 분리도 — 눈으로 구분 가능한 명도차인지
  const sep = contrast(ui.bA.needle, ui.bB.needle);
  ok(sep >= 1.8, `체크보드 등록↔미등록 상호 분리도 = ${sep.toFixed(2)}:1 (눈에 띄는 명도차)`);
  // 테마 변수 함정 방지: 핀 색 정본에 var(--x) 가 섞이면 실행 시 값이 달라진다
  ok(!/EMPTY_COLOR[\s\S]{0,400}var\(--/.test(sSrc) && !/var\(--/.test(
      (sSrc.match(/CHECKBOARD_EMPTY_COLOR:[^\n]*\n/) || [""])[0]),
    "핀 색 정본은 리터럴 hex 만 사용(런타임 테마 변수 없음 → 라이트/다크 동일 값)");
}

/* ────────────────────────────────────────────────────────────
 * ⑦ [2026-09-17] 색 제거(흑백) 시에도 등록/미등록이 구분되는가.
 *   마스터 신고(3회차): "색 대비만 올려선(2.32→3.09:1) 육안 구분 안 됨."
 *   head/head2/needle/text(색) 필드는 전혀 보지 않는다 — dash(도면 링 패턴)와
 *   pin-filled/pin-hollow 클래스, 미니맵 border-style 만으로 등록/미등록을 가른다.
 *   체크보드 계열뿐 아니라 일반(content/empty) 계열도 함께 검사한다.
 * ──────────────────────────────────────────────────────────── */
function suiteBlackWhiteOnly(label, sSrc, rSrc) {
  console.log("\n[" + label + "]");
  const fixture = FIXTURE();
  const ui = runUI(sSrc, uiSrc, fixture).pins;
  const rdr = runRadar(sSrc, rSrc, fixture, CURRENT(fixture)).pins;

  ok(ui.bA.dash !== ui.bB.dash,
    `[체크보드] 색 무시·링 패턴만: 등록 "${ui.bA.dash}" ≠ 미등록 "${ui.bB.dash}"`);
  ok(/pin-filled/.test(ui.bA.cls) && /pin-hollow/.test(ui.bB.cls),
    "[체크보드] 색 무시·클래스만: 등록=pin-filled, 미등록=pin-hollow");
  ok(rdr.bA.border !== rdr.bB.border,
    `[체크보드] 색 무시·미니맵 테두리만: 등록 ${rdr.bA.border} ≠ 미등록 ${rdr.bB.border}`);

  ok(ui.c1.dash !== ui.e1.dash,
    `[일반] 색 무시·링 패턴만: 등록 "${ui.c1.dash}" ≠ 미등록 "${ui.e1.dash}"`);
  ok(/pin-filled/.test(ui.c1.cls) && /pin-hollow/.test(ui.e1.cls),
    "[일반] 색 무시·클래스만: 등록=pin-filled, 미등록=pin-hollow");
  ok(rdr.c1.border !== rdr.e1.border,
    `[일반] 색 무시·미니맵 테두리만: 등록 ${rdr.c1.border} ≠ 미등록 ${rdr.e1.border}`);

  // 이 스위트가 계열(kind) 축을 건드리지 않았음을 재확인(회귀)
  ok(ui.bA.kind === "checkboard" && ui.bB.kind === "checkboard" &&
     ui.c1.kind === "content" && ui.e1.kind === "empty",
    "계열(kind) 불변 회귀: checkboard/content/empty 그대로");
}

/* ────────────────────────────────────────────────────────────
 * ⑧ [2026-09-17 4차] 헤드(메달리온) 도형 자체가 등록/미등록으로 갈리는가.
 *   마스터 4번째 요구: "머리 원이 항상 채워져서 색을 흑백으로 봐도 구분이 안 된다."
 *   근본원인: 헤드 circle(r=11.8) 의 fill 이 filled 여부와 무관하게
 *   항상 url(#pgbody...) 그라디언트였다 → 이 스위트는 fill 속성 자체를 검사한다
 *   (색 hex 값이 아니라 "채움 vs none" 이라는 도형 축).
 * ──────────────────────────────────────────────────────────── */
function suiteHeadShape(label, sSrc) {
  console.log("\n[" + label + "]");
  const fixture = FIXTURE();
  const ui = runUI(sSrc, uiSrc, fixture).pins;

  ok(/^url\(/.test(ui.c1.headFillAttr), `등록 핀(c1) 헤드 fill = 채운 원 → ${ui.c1.headFillAttr}`);
  ok(ui.e1.headFillAttr === "none", `미등록 핀(e1) 헤드 fill = 속 빈 원 → ${ui.e1.headFillAttr}`);
  ok(ui.c1.headFillAttr !== ui.e1.headFillAttr,
    `등록↔미등록 헤드 fill 서로 다름: ${ui.c1.headFillAttr} ≠ ${ui.e1.headFillAttr}`);

  // 체크보드 계열도 헤드 도형으로 등록/미등록이 갈려야 한다(색만으로 우선되지 않게)
  ok(/^url\(/.test(ui.bA.headFillAttr), `체크보드 등록(bA) 헤드 fill = 채운 원 → ${ui.bA.headFillAttr}`);
  ok(ui.bB.headFillAttr === "none", `체크보드 미등록(bB) 헤드 fill = 속 빈 원 → ${ui.bB.headFillAttr}`);
  ok(ui.bA.headFillAttr !== ui.bB.headFillAttr, "체크보드 등록↔미등록 헤드 fill 서로 다름");

  // [2026-09-28 WO 번호 복구] 채움/속빈 둘 다 머리 안 숫자 <text> 를 다시 그린다
  // (⑥ 스위트에서 존재를 직접 검증하고, 팔레트 WCAG 대비도 거기서 직접 확인함 — 중복 방지).
  ok(ui.c1.text !== null && ui.e1.text !== null,
    `채운 원·속 빈 원 모두 머리 숫자 <text> 있음(c1=${ui.c1.text}, e1=${ui.e1.text})`);
}

/* ────────────────────────────────────────────────────────────
 * ⑬~⑯ [2026-09-17 콘텐츠 3상태 + 형태단서 재설계] "내용이 있는 거, 사진이 있는 거 모두 구분되게 해".
 *   근본원인1: App.pinHasContent = pinHasMedia || pinHasInfo — OR 로 뭉뚱그려져 있어
 *   사진만 있는 핀과 노트만 있는 핀이 등록여부(filled)만으로는 똑같이 "채운 원"이었다.
 *   PinSeries.contentTier() 가 media/info 를 따로 읽어 photo/content/empty 3상태로 가른다.
 *   근본원인2(마스터 실측): 21px 실크기 핀에서 지름 2.2px 짜리 작은 점(pin-content-dot)은
 *   안 보인다. → 속 원판(inner disc) 자체의 실루엣(원/둥근사각)으로 대체(pin-tier-disc).
 *   🔴 pinHasContent 자체는 건드리지 않는다 — markerStyle().filled 축은 그대로 media OR info.
 * ──────────────────────────────────────────────────────────── */
const FIXTURE_TIER = () => [
  { id: "p1", page: 1, x: 5,  y: 5,  imageId: "img" },                 // 사진만
  { id: "p2", page: 1, x: 10, y: 10, note: "메모만" },                  // 내용(노트)만
  { id: "p3", page: 1, x: 15, y: 15 },                                  // 빈 포인트
  { id: "p4", page: 1, x: 20, y: 20, imageId: "img2", note: "겸용" }    // 사진+내용 둘 다
];

/** [WO 20260917 형태단서 재설계] 색(fill hex) 없이 태그명 + 채움유무(url/none)만으로 만드는 서명.
 *  discTag: circle/rect(속 원판 실루엣) · headFillAttr: url(...)/none 은 색값이 아니라
 *  "채워짐 vs 빈 원" 구조 자체라 색 속성을 전부 제거해도 살아남는다. */
const shapeSig = (p) => (p.discTag || "?") + ":" + (/^url\(/.test(p.headFillAttr) ? "url" : "none");

function suiteContentTier(label, sSrc) {
  console.log("\n[" + label + "]");
  const ui = runUI(sSrc, uiSrc, FIXTURE_TIER()).pins;

  ok(ui.p1.tier === "photo" && ui.p2.tier === "content" && ui.p3.tier === "empty",
    `⑬ 3상태 판정: 사진=${ui.p1.tier}(기대 photo) · 내용만=${ui.p2.tier}(기대 content) · 빈핀=${ui.p3.tier}(기대 empty)`);
  ok(ui.p1.discTag === "circle" && ui.p2.discTag === "rect" && ui.p3.discTag === "circle",
    `⑬ 형태 단서(속 원판 실루엣): 사진=${ui.p1.discTag} · 내용만=${ui.p2.discTag}(기대 rect) · 빈핀=${ui.p3.discTag}`);

  // ⑭ 색(head/head2/needle/text/fill/stroke 전부)을 전혀 보지 않고 discTag(원/사각) +
  //    headFillAttr 구조(채움 url() vs 빈 none)만으로 3상태 전부 구분되는가.
  const keys = [shapeSig(ui.p1), shapeSig(ui.p2), shapeSig(ui.p3)];
  ok(new Set(keys).size === 3,
    `⑭ 색 속성 전부 제거·태그명+채움구조만으로 3상태 전부 구분됨 → ${keys.join(", ")}`);

  // ⑮ 사진+내용 둘 다 있는 핀 — 정상 처리(미디어 우선 → photo, 크래시 없음, 원판도 photo 형태)
  ok(ui.p4.tier === "photo" && ui.p4.filled === "1" && ui.p4.discTag === "circle",
    `⑮ 사진+내용 겸용 핀 정상 처리(미디어 우선) → tier=${ui.p4.tier}, filled=${ui.p4.filled}, discTag=${ui.p4.discTag}`);

  // ⑯ App.pinHasContent 호출부 동작 불변 — 실제 20_App.js 소스에서 정의·호출부가 그대로인지 확인
  const appSrcOnDisk = rd("public/js/modules/20_App.js");
  ok(/pinHasContent\(pin\)\s*\{\s*return this\.pinHasMedia\(pin\) \|\| this\.pinHasInfo\(pin\);\s*\}/.test(appSrcOnDisk),
    "⑯ App.pinHasContent 정의 불변(pinHasMedia || pinHasInfo)");
  const callSites = (appSrcOnDisk.match(/\.pinHasContent\(/g) || []).length;
  ok(callSites >= 1, `⑯ App.pinHasContent 호출부 개수 = ${callSites} (기존 호출부 보존, 회귀 없음)`);
}

/* ── 실행: 정상 소스 ─────────────────────────────────────────── */
suiteCheckboardColor("① 체크보드 사진 유무 색 구분 (정상 소스)", seriesSrc, radarSrc);
suiteNormalPins("② 일반 핀 구분 유지 (정상 소스)", seriesSrc);
suiteSameJudgment("③ 도면 == 미니맵 판정 (정상 소스)", seriesSrc, radarSrc);
suiteNumbers("④ 번호 체계 불변 (정상 소스)", seriesSrc, radarSrc);
suiteShape("⑤ 색 외 형태 단서 (정상 소스)", seriesSrc, radarSrc);
suiteContrast("⑥ WCAG 대비 실측 (정상 소스)", seriesSrc, radarSrc);
suiteBlackWhiteOnly("⑦ 흑백(색 제거) 구분 (정상 소스)", seriesSrc, radarSrc);
suiteHeadShape("⑧ 헤드 도형(fill) 자체가 등록/미등록으로 갈림 (정상 소스)", seriesSrc);
suiteContentTier("⑬~⑯ 콘텐츠 3상태(사진/내용만/빈 포인트) (정상 소스)", seriesSrc);

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 A: 체크보드 안의 콘텐츠 분기를 제거하면 ①이 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션A] 체크보드 색상 분기 제거(사진 유무 무시) → ①이 실패해야 함");
  const needle = 'if (kind === "checkboard") return (filled === false) ? this.CHECKBOARD_EMPTY_COLOR : this.CHECKBOARD_COLOR;';
  const mutated = seriesSrc.replace(needle, 'if (kind === "checkboard") return this.CHECKBOARD_COLOR;');
  if (mutated === seriesSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const fixture = FIXTURE();
    const ui = runUI(mutated, uiSrc, fixture).pins;
    const rdr = runRadar(mutated, radarSrc, fixture, CURRENT(fixture)).pins;
    ok(ui.bA.head2 === ui.bB.head2 && rdr.bA.bg === rdr.bB.bg,
      `뮤테이션 적용 시 체크보드 색이 사진 유무와 무관하게 같아짐(테스트 실효성 증명) → 도면 ${ui.bA.head2}=${ui.bB.head2}, 미니맵 ${rdr.bA.bg}=${rdr.bB.bg}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 B: 미니맵이 정본(markerStyle)을 우회하면 ③이 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션B] 미니맵이 PinSeries.markerStyle 정본을 우회 → ③이 실패해야 함");
  const needle = "const _st = PinSeries.markerStyle(p);";
  const mutated = radarSrc.replace(needle, "const _st = PinSeries.markerStyle({ checkboard: p.checkboard });");
  if (mutated === radarSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const fixture = FIXTURE();
    const ui = runUI(seriesSrc, uiSrc, fixture).pins;
    const rdr = runRadar(seriesSrc, mutated, fixture, CURRENT(fixture)).pins;
    const diff = COLORED(Object.keys(ui)).filter((id) => ui[id].filled !== rdr[id].filled || ui[id].needle !== rdr[id].bg);
    ok(diff.length > 0,
      `뮤테이션 적용 시 도면↔미니맵 판정이 어긋남(테스트 실효성 증명) → 불일치 ${diff.length}건: ${diff.join(",")}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 C: hasContent 판정을 바꾸면(App.pinHasContent 무시) ①·②가 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션C] hasContent 판정 변경(항상 콘텐츠 있음으로 오판) → ①·②가 실패해야 함");
  const needle = 'hasContent(pin) {\n      if (typeof App !== "undefined" && App.pinHasContent) { try { return !!App.pinHasContent(pin); } catch (e) {} }\n      return !!(pin && (pin.imageId || pin.imageUrl || pin.videoId));\n    },';
  const mutated = seriesSrc.replace(needle, 'hasContent(pin) { return true; },');
  if (mutated === seriesSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const fixture = FIXTURE();
    const ui = runUI(mutated, uiSrc, fixture).pins;
    ok(ui.e1.kind === "content",
      `뮤테이션 적용 시 빈 핀도 콘텐츠로 오판(테스트 실효성 증명, ②가 깨짐) → e1.kind=${ui.e1.kind}`);
    ok(ui.bA.head2 === ui.bB.head2,
      `뮤테이션 적용 시 체크보드 등록/미등록 색 구분도 무너짐(테스트 실효성 증명, ①이 깨짐) → ${ui.bA.head2}==${ui.bB.head2}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 D: 형태(패턴) 구분 제거 · 색은 유지 → ⑤·⑦의 형태(dash/border) 검사가 실패해야 한다.
 *   🔴 이 저장소는 색(colorsOf)과 형태(patternOf)가 이미 완전히 분리된 축이다.
 *   마스터가 요구한 "형태 구분 제거" / "색만 남기고 형태 통일" 두 시나리오는
 *   이 구조에서 동일한 단일 변이(patternOf 상수화)로 수렴한다 — colorsOf 를
 *   전혀 건드리지 않고도 형태만 지울 수 있기 때문이다(아래 세 번째 검사로 증명).
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션D] 형태(패턴) 구분 제거 · 색은 유지 → ⑤·⑦의 형태 검사가 실패해야 함");
  const needle = 'patternOf(kind, filled) {\n      if (kind === "checkboard") return filled ? "dashed" : "dotted";\n      return (kind === "empty") ? "dotted" : "solid";\n    },';
  const mutated = seriesSrc.replace(needle, 'patternOf(kind, filled) { return "solid"; },');
  if (mutated === seriesSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const fixture = FIXTURE();
    const ui = runUI(mutated, uiSrc, fixture).pins;
    const rdr = runRadar(mutated, radarSrc, fixture, CURRENT(fixture)).pins;
    ok(ui.bA.dash === ui.bB.dash && ui.bA.dash === "",
      `뮤테이션 적용 시 형태(dash) 구분이 사라짐(테스트 실효성 증명, ⑤·⑦이 깨짐) → bA="${ui.bA.dash}" bB="${ui.bB.dash}"`);
    ok(rdr.bA.border === rdr.bB.border,
      `뮤테이션 적용 시 미니맵 테두리 구분도 사라짐(테스트 실효성 증명) → ${rdr.bA.border}==${rdr.bB.border}`);
    ok(ui.bA.head2 !== ui.bB.head2,
      "색(colorsOf)은 이 뮤테이션과 무관하게 여전히 다름 — 형태·색 축이 서로 분리되어 있음을 확인");
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 E: 헤드 fill 분기를 제거하고 항상 채움으로 고정 → ⑧이 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션E] 헤드 fill 분기 제거(항상 채움) → ⑧이 실패해야 함");
  const needle = 'fill="${_st.filled ? `url(#pgbody${pageIdx})` : "none"}" stroke="${_st.filled ? "#ffffff" : headFill2}" stroke-width="${_st.filled ? 2.4 : 3.2}"';
  const mutated = uiSrc.replace(needle, `fill="url(#pgbody\${pageIdx})" stroke="#ffffff" stroke-width="2.4"`);
  if (mutated === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const fixture = FIXTURE();
    const ui = runUI(seriesSrc, mutated, fixture).pins;
    ok(/^url\(/.test(ui.c1.headFillAttr) && /^url\(/.test(ui.e1.headFillAttr),
      `뮤테이션 적용 시 미등록도 항상 채운 원이 됨(테스트 실효성 증명) → c1=${ui.c1.headFillAttr}, e1=${ui.e1.headFillAttr}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 F: filled 판정을 무시하고 pin.checkboard 로 잘못 분기 → 체크보드 계열
 *   등록/미등록 헤드 도형이 안 갈려야(실패해야) 한다(⑧ 체크보드 검사).
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션F] filled 판정 무시(pin.checkboard 로 대체) → ⑧ 체크보드 검사가 실패해야 함");
  const needle = 'fill="${_st.filled ? `url(#pgbody${pageIdx})` : "none"}" stroke="${_st.filled ? "#ffffff" : headFill2}" stroke-width="${_st.filled ? 2.4 : 3.2}"';
  const mutated = uiSrc.replace(needle,
    'fill="${pin.checkboard ? `url(#pgbody${pageIdx})` : "none"}" stroke="${pin.checkboard ? "#ffffff" : headFill2}" stroke-width="${pin.checkboard ? 2.4 : 3.2}"');
  if (mutated === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const fixture = FIXTURE();
    const ui = runUI(seriesSrc, mutated, fixture).pins;
    ok(/^url\(/.test(ui.bA.headFillAttr) && /^url\(/.test(ui.bB.headFillAttr),
      `뮤테이션 적용 시 체크보드 등록/미등록 헤드 fill 이 둘 다 채운 원이 됨(테스트 실효성 증명) → bA=${ui.bA.headFillAttr}, bB=${ui.bB.headFillAttr}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 G: 3상태(photo/content/empty)를 2상태로 되돌림 → ⑬이 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션G] contentTier 를 2상태로 되돌림(photo 구분 제거) → ⑬이 실패해야 함");
  const needle = 'contentTier(pin) {\n      if (this.mediaOf(pin)) return "photo";\n      if (this.infoOf(pin)) return "content";\n      return "empty";\n    },';
  const mutated = seriesSrc.replace(needle, 'contentTier(pin) { return (this.mediaOf(pin) || this.infoOf(pin)) ? "content" : "empty"; },');
  if (mutated === seriesSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const ui = runUI(mutated, uiSrc, FIXTURE_TIER()).pins;
    ok(ui.p1.tier === ui.p2.tier,
      `뮤테이션 적용 시 사진과 내용만 있는 핀이 같은 tier 가 됨(테스트 실효성 증명, ⑬이 깨짐) → ${ui.p1.tier} == ${ui.p2.tier}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 H: content 를 다시 원판(circle)으로 되돌림(마스터 발주 ① 시나리오)
 *   → ⑬(형태 판정 photo≠content≠empty)·⑭(색 무시 서명 3구분)가 모두 실패해야 한다.
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션H] content 를 원판(circle)으로 되돌림 → ⑬⑭ 가 실패해야 함");
  // [2026-09-21 갱신] tierDisc 가 3분기(content/photo/empty)로 재설계됨(photo=겹친 원 2개,
  // WO "동그라미를 겹친다" 반영) — needle 을 현재 소스와 일치시킨다(문자열이 안 맞으면
  // 아래 replace 가 무효화되어 뮤테이션 자체가 시행되지 않는 거짓-패스가 된다).
  const needle = 'const tierDisc = (tier === "content")\n          ? `<rect class="pin-tier-disc" x="9.8" y="6.8" width="16.4" height="16.4" rx="3" fill="#ffffff" opacity="0.99"/>`\n          : (tier === "photo")\n            ? `<circle class="pin-tier-disc" cx="18" cy="15" r="8.6" fill="#ffffff" opacity="0.99"/><circle cx="22.6" cy="10.4" r="4.2" fill="#ffffff" opacity="0.99" stroke="#1a1a1a" stroke-width="0.8"/>`\n            : `<circle class="pin-tier-disc" cx="18" cy="15" r="8.6" fill="#ffffff" opacity="0.99"/>`;';
  const mutated = uiSrc.replace(needle, 'const tierDisc = `<circle class="pin-tier-disc" cx="18" cy="15" r="8.6" fill="#ffffff" opacity="0.99"/>`;');
  if (mutated === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const ui = runUI(seriesSrc, mutated, FIXTURE_TIER()).pins;
    ok(ui.p1.discTag === ui.p2.discTag,
      `뮤테이션 적용 시 photo/content 원판 태그가 둘 다 circle 로 같아짐(⑬ 붕괴 증명) → p1=${ui.p1.discTag}, p2=${ui.p2.discTag}`);
    const keys = [shapeSig(ui.p1), shapeSig(ui.p2), shapeSig(ui.p3)];
    ok(new Set(keys).size < 3,
      `뮤테이션 적용 시 색 무시 서명이 3구분에서 무너짐(⑭ 붕괴 증명) → ${keys.join(", ")}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 I: 형태(태그)는 그대로 두고 "색만" content 를 다르게 칠함(마스터 발주 ② 시나리오)
 *   → 색 속성을 전부 제거한 뒤 보는 ⑭ 서명 검사가 실패해야 한다(형태 차이가 없으므로).
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션I] 형태 차이 제거·색만 다르게(content=circle+노란색) → ⑭ 가 실패해야 함");
  const needle = 'const tierDisc = (tier === "content")\n          ? `<rect class="pin-tier-disc" x="9.8" y="6.8" width="16.4" height="16.4" rx="3" fill="#ffffff" opacity="0.99"/>`\n          : (tier === "photo")\n            ? `<circle class="pin-tier-disc" cx="18" cy="15" r="8.6" fill="#ffffff" opacity="0.99"/><circle cx="22.6" cy="10.4" r="4.2" fill="#ffffff" opacity="0.99" stroke="#1a1a1a" stroke-width="0.8"/>`\n            : `<circle class="pin-tier-disc" cx="18" cy="15" r="8.6" fill="#ffffff" opacity="0.99"/>`;';
  const mutated = uiSrc.replace(needle,
    'const tierDisc = (tier === "content")\n          ? `<circle class="pin-tier-disc" cx="18" cy="15" r="8.6" fill="#ffcc00" opacity="0.99"/>`\n          : (tier === "photo")\n            ? `<circle class="pin-tier-disc" cx="18" cy="15" r="8.6" fill="#ffffff" opacity="0.99"/><circle cx="22.6" cy="10.4" r="4.2" fill="#ffffff" opacity="0.99" stroke="#1a1a1a" stroke-width="0.8"/>`\n            : `<circle class="pin-tier-disc" cx="18" cy="15" r="8.6" fill="#ffffff" opacity="0.99"/>`;');
  if (mutated === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const ui = runUI(seriesSrc, mutated, FIXTURE_TIER()).pins;
    ok(ui.p1.discTag === ui.p2.discTag,
      `뮤테이션 적용 시 photo/content 태그가 둘 다 circle(형태 차이 없음, 색만 다름) → p1=${ui.p1.discTag}, p2=${ui.p2.discTag}`);
    const keys = [shapeSig(ui.p1), shapeSig(ui.p2), shapeSig(ui.p3)];
    ok(new Set(keys).size < 3,
      `뮤테이션 적용 시 색(fill hex)만 다르고 형태(태그/채움구조)는 같아 색 제거 서명이 붕괴함(⑭ 실효성 증명) → ${keys.join(", ")}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 J: [2026-09-28 WO] 숫자 <text> 제거(9/21→9/28 실제 회귀 재현) → ⑥의
 *   "머리 안 숫자 <text> 있음" 검사가 실패해야 한다.
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션J] 숫자 <text> 제거(회귀 재현) → ⑥ 의 숫자 존재 검사가 실패해야 함");
  // [WO 20260929 갱신] 번호가 아이콘 유무와 무관하게 항상 그려지도록 바뀌어(마스터: "번호가
  // 왜 사라졌는지") <text> 가 더는 `||` 폴백이 아니라 독립 라인이 됨 — needle 을 그 라인으로 교체.
  // 🔴 이 <text> 라인은 체크보드 간소화 분기(497행대)와 일반 분기(543행대) 2곳에 동일 문자열로
  // 존재한다 — replace()(1곳만 치환)를 쓰면 c1(일반 분기 렌더)이 여전히 번호를 갖는 거짓-패스가
  // 난다. replaceAll 로 양쪽 다 제거해야 c1.text 가 실제로 null 이 된다.
  const needle = '<text x="18" y="15.4" text-anchor="middle" dominant-baseline="central" font-family="\'Segoe UI\',sans-serif" font-size="${String(dispNo).length >= 3 ? 9 : 13}" font-weight="900" fill="${txtFill}">${dispNo}</text>';
  const mutated = uiSrc.replaceAll(needle, "");
  if (mutated === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const fixture = FIXTURE();
    const ui = runUI(seriesSrc, mutated, fixture).pins;
    ok(ui.c1.text === null,
      `뮤테이션 적용 시 숫자 <text> 가 사라짐(테스트 실효성 증명, ⑥의 존재 검사가 깨짐) → c1.text=${ui.c1.text}`);
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
