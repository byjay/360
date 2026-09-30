/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p101-pin-mode-style.test.mjs)
 *
 * 마스터 지시(2026-09-30): "핀 색이나 형태를 모드별로 구분" — CHECKER(체크보드)와 360(콘텐츠)이
 * 도면 마커·미니맵에서 형태(모양)·색 둘 다로 구분되는지 검사한다.
 *
 * 판정 SoT = PinSeries.seriesOf(meta.series) / pin.checkboard.
 *   - 도면 마커(11_UI.renderPinsOnMap): pin-mode-checker/pin-mode-360 클래스 + CHECKER 전용
 *     둥근사각 배지 프레임(<rect ... rx="7.5">, 360 은 없음) — 형태 자체가 다르다.
 *   - 미니맵(07_Radar.update): pano-radar-pin-mode-checker/360 클래스(CSS border-radius로 형태 분기).
 *   - 색: PinSeries.CHECKBOARD_COLOR/CHECKBOARD_EMPTY_COLOR(주황/앰버 계열) vs 360의 EMPTY_COLOR/
 *     PinPrefs 팔레트(레드/그린 등 비-주황 계열) — 실측 WCAG 대비는 p9/p18 담당, 여기선 "형태" 축만 집중.
 *
 * 실제 모듈 소스(01b_PinSeries.js/11_UI.js/07_Radar.js)를 그대로 vm 에 평가한다(목 구현 아님).
 * 뮤테이션 2건이 붙어 있어, 고친 코드를 되돌리면 해당 검사가 실패한다.
 *
 * [미완, 정직 명시] 이 파일은 DOM 클래스·SVG 문자열 수준 회귀만 검사한다. 헤드리스 Chrome
 * 1280x800/375x812 실 스크린샷 비교는 이 세션에 브라우저 자동화 도구 접근 권한이 없어 수행하지
 * 못했다(지휘자 재현 필요 — 미완 항목으로 보고).
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

/* ── 최소 DOM 목 (p9 와 동일 구조) ─────────────────────────────── */
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
const AppMock = { pinHasContent(pin) { return !!(pin && (pin.imageId || pin.imageUrl || pin.videoId || pin.note)); } };

function runUI(sSrc, uSrc, pins, page = 1) {
  const { document, registry } = makeDoc();
  const State = { pins, pdfPage: page, mode: "viewer", activePin: null, zoneView: null, zones: [] };
  const sandbox = { console, document, State, localStorage: makeLocalStorage(), App: AppMock, JSON, Map, Set };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(sSrc + "\n" + uSrc + "\n;globalThis.__UI = UI;", sandbox);
  sandbox.__UI.renderPinsOnMap();
  const out = {};
  registry["pins-layer"]._children.forEach((m) => { out[m.dataset.id] = { cls: m.className, html: m._html }; });
  return out;
}
function runRadar(sSrc, rSrc, pins, currentPin, page = 1) {
  const { document, registry } = makeDoc();
  const State = { pins, pdfPage: page, mode: "viewer", viewerPages: ["p1.jpg"], zones: [] };
  const sandbox = { console, document, State, localStorage: makeLocalStorage(), App: AppMock, JSON, Map, Set };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(sSrc + "\n" + rSrc + "\n;globalThis.__R = Radar;", sandbox);
  sandbox.__R.update(currentPin);
  const out = {};
  registry["pano-radar-pins"]._children.forEach((d) => { out[d.dataset.id] = { cls: d.className }; });
  return out;
}

const FIXTURE = () => [
  { id: "chk1", page: 1, x: 10, y: 10, checkboard: true, label: "1" },
  { id: "chk2", page: 1, x: 15, y: 15, checkboard: true, label: "2", imageId: "shotA" },
  { id: "c360", page: 1, x: 20, y: 20, imageId: "img1" },
  { id: "cur",  page: 1, x: 25, y: 25, imageId: "img-cur" }
];
const CURRENT = (f) => f.find((p) => p.id === "cur");

/* ── ① 도면 마커: 모드 클래스 ── */
function suiteMarkerModeClass(label, sSrc, uSrc) {
  console.log("\n[" + label + "]");
  const ui = runUI(sSrc, uSrc, FIXTURE());
  ok(/(^|\s)pin-mode-checker(\s|$)/.test(ui.chk1.cls), `CHECKER 핀(chk1) 클래스에 pin-mode-checker → ${ui.chk1.cls}`);
  ok(/(^|\s)pin-mode-checker(\s|$)/.test(ui.chk2.cls), `CHECKER 핀(chk2) 클래스에 pin-mode-checker`);
  ok(/(^|\s)pin-mode-360(\s|$)/.test(ui.c360.cls), `360 핀(c360) 클래스에 pin-mode-360 → ${ui.c360.cls}`);
  ok(!/pin-mode-360/.test(ui.chk1.cls), "CHECKER 핀에는 pin-mode-360 없음(상호배타)");
  ok(!/pin-mode-checker/.test(ui.c360.cls), "360 핀에는 pin-mode-checker 없음(상호배타)");
}

/* ── ② 도면 마커: 형태(SVG) 자체가 다르다 — CHECKER 만 둥근사각 배지 프레임 ── */
function suiteMarkerShape(label, sSrc, uSrc) {
  console.log("\n[" + label + "]");
  const ui = runUI(sSrc, uSrc, FIXTURE());
  const badgeFrame = /<rect[^>]*rx="7\.5"[^>]*opacity="0\.95"/;
  ok(badgeFrame.test(ui.chk1.html), "CHECKER 마커(chk1)에 둥근사각 배지 프레임 rect 존재");
  ok(badgeFrame.test(ui.chk2.html), "CHECKER 마커(chk2)에 둥근사각 배지 프레임 rect 존재");
  ok(!badgeFrame.test(ui.c360.html), "360 마커(c360)에는 배지 프레임 없음(원형 티어드롭 그대로)");
  // 위치 앵커 불변 — 둘 다 같은 tip(18,60) 유지(회귀: 배지 프레임이 위치 계산을 깨지 않음)
  ok(/M14\.2 22 L18 60 L21\.8 22 Z/.test(ui.chk1.html), "CHECKER 도 tip(18,60) 앵커 불변(위치 회귀 없음)");
  ok(/M14\.2 22 L18 60 L21\.8 22 Z/.test(ui.c360.html), "360 tip(18,60) 앵커 불변");
}

/* ── ③ 미니맵: 모드 클래스(형태는 CSS border-radius 분기) ── */
function suiteRadarModeClass(label, sSrc, rSrc) {
  console.log("\n[" + label + "]");
  const fixture = FIXTURE();
  const rdr = runRadar(sSrc, rSrc, fixture, CURRENT(fixture));
  ok(/pano-radar-pin-mode-checker/.test(rdr.chk1.cls), `미니맵 CHECKER 점(chk1) 클래스 → ${rdr.chk1.cls}`);
  ok(/pano-radar-pin-mode-360/.test(rdr.c360.cls), `미니맵 360 점(c360) 클래스 → ${rdr.c360.cls}`);
}

/* ── ④ 색: CHECKER(주황/앰버)가 360/EMPTY(레드)·기본 콘텐츠(그린) 계열과 다른 색상군 ── */
function suiteColorFamily(label, sSrc) {
  console.log("\n[" + label + "]");
  const sandbox = { console, JSON, Map, Set };
  vm.createContext(sandbox);
  vm.runInContext(sSrc + "\n;globalThis.__PS = PinSeries;", sandbox);
  const PS = sandbox.__PS;
  // 주황 판정: R 채널이 G·B 채널보다 뚜렷이 높다(간단한 색상군 신호 — 정밀 색공간 분석 아님)
  const isOrange = (hex) => {
    const v = hex.replace("#", "");
    const r = parseInt(v.substr(0, 2), 16), g = parseInt(v.substr(2, 2), 16), b = parseInt(v.substr(4, 2), 16);
    return r > g + 20 && r > b + 40;
  };
  ok(isOrange(PS.CHECKBOARD_COLOR.head), `CHECKER 등록 head(${PS.CHECKBOARD_COLOR.head})는 주황 계열`);
  ok(isOrange(PS.CHECKBOARD_EMPTY_COLOR.head), `CHECKER 미등록 head(${PS.CHECKBOARD_EMPTY_COLOR.head})는 주황 계열`);
  ok(PS.CHECKBOARD_COLOR.head !== PS.EMPTY_COLOR.head, "CHECKER 색은 360 미배치(레드) 색과 다름");
  const green = { head: "#10b981" }; // PinPrefs 기본(그린)
  ok(PS.CHECKBOARD_COLOR.head !== green.head, "CHECKER 색은 360 기본 콘텐츠(그린) 색과 다름");
}

suiteMarkerModeClass("① 도면 마커 모드 클래스 (정상 소스)", seriesSrc, uiSrc);
suiteMarkerShape("② 도면 마커 형태(배지 프레임) (정상 소스)", seriesSrc, uiSrc);
suiteRadarModeClass("③ 미니맵 모드 클래스 (정상 소스)", seriesSrc, radarSrc);
suiteColorFamily("④ 색상군 구분 (정상 소스)", seriesSrc);

/* ────────────────────────────────────────────────────────────
 * 뮤테이션A: 도면 마커 모드 클래스 추가 라인 제거 → ①이 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션A] 도면 마커 pin-mode-* 클래스 부여 제거 → ①이 실패해야 함");
  const needle = 'marker.classList.add(isChecker ? "pin-mode-checker" : "pin-mode-360");';
  const mutated = uiSrc.replace(needle, "");
  if (mutated === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const ui = runUI(seriesSrc, mutated, FIXTURE());
    ok(!/pin-mode-checker/.test(ui.chk1.cls) && !/pin-mode-360/.test(ui.c360.cls),
      `뮤테이션 적용 시 모드 클래스가 사라짐(테스트 실효성 증명) → chk1=${ui.chk1.cls}, c360=${ui.c360.cls}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션B: CHECKER 배지 프레임 제거(형태 구분 무력화) → ②가 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션B] CHECKER 배지 프레임 렌더 제거(형태 구분 무력화) → ②가 실패해야 함");
  const needle = '${isChecker ? `<rect x="3.6" y="2" width="28.8" height="27" rx="7.5" fill="${_st.filled ? "#fff7ed" : "#ffffff"}" opacity="0.95" stroke="#1a1a1a" stroke-width="1.6" stroke-opacity="0.45"/>` : ""}';
  const mutated = uiSrc.replace(needle, "");
  if (mutated === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const ui = runUI(seriesSrc, mutated, FIXTURE());
    const badgeFrame = /<rect[^>]*rx="7\.5"[^>]*opacity="0\.95"/;
    ok(!badgeFrame.test(ui.chk1.html),
      `뮤테이션 적용 시 CHECKER 마커도 배지 프레임이 사라져 360과 형태 구분 불가(테스트 실효성 증명) → html에 프레임 없음=${!badgeFrame.test(ui.chk1.html)}`);
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
