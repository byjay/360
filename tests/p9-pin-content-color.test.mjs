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
    out[m.dataset.id] = {
      no: String(m.dataset.no), kind: m.dataset.kind, filled: m.dataset.filled,
      head: stops[0], head2: stops[1], needle: stops[3], text: txt, dash: dash,
      cls: m.className, pulse: /pin-pulse/.test(html)
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
  const ui = runUI(sSrc, uiSrc, fixture).pins;
  const rdr = runRadar(sSrc, rSrc, fixture, CURRENT(fixture)).pins;
  const WHITE = "#ffffff";

  ["c1", "e1", "bA", "bB"].forEach((id) => {
    const r = contrast(ui[id].text, WHITE);
    ok(r >= 4.5, `[본문 4.5:1] ${id} 숫자 ${ui[id].text} ↔ 흰 디스크 #fff = ${r.toFixed(2)}:1`);
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

/* ── 실행: 정상 소스 ─────────────────────────────────────────── */
suiteCheckboardColor("① 체크보드 사진 유무 색 구분 (정상 소스)", seriesSrc, radarSrc);
suiteNormalPins("② 일반 핀 구분 유지 (정상 소스)", seriesSrc);
suiteSameJudgment("③ 도면 == 미니맵 판정 (정상 소스)", seriesSrc, radarSrc);
suiteNumbers("④ 번호 체계 불변 (정상 소스)", seriesSrc, radarSrc);
suiteShape("⑤ 색 외 형태 단서 (정상 소스)", seriesSrc, radarSrc);
suiteContrast("⑥ WCAG 대비 실측 (정상 소스)", seriesSrc, radarSrc);

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

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
