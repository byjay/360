/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p101-pin-mode-style.test.mjs)
 *
 * 🔴 [WO 20261019-unifymode] 계약 반전(아래 대조표) — 이제 모드별 구분이 "없어야" 한다.
 * (구) 마스터 지시(2026-09-30): "핀 색이나 형태를 모드별로 구분" — CHECKER(체크보드)와 360(콘텐츠)이
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
  registry["pins-layer"]._children.forEach((m) => { out[m.dataset.id] = { cls: m.className, html: m._html, photo: m.dataset.photo }; });
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
  registry["pano-radar-pins"]._children.forEach((d) => { out[d.dataset.id] = { cls: d.className, kind: d.dataset.kind }; });
  return out;
}

const FIXTURE = () => [
  { id: "chk1", page: 1, x: 10, y: 10, checkboard: true, label: "1" },
  { id: "chk2", page: 1, x: 15, y: 15, checkboard: true, label: "2", imageId: "shotA" },
  { id: "c360", page: 1, x: 20, y: 20, imageId: "img1" },
  { id: "cur",  page: 1, x: 25, y: 25, imageId: "img-cur" }
];
const CURRENT = (f) => f.find((p) => p.id === "cur");

/* 🔴 [WO 20261019-unifymode] 계약 반전 — 마스터 "360 과 체커 통일". 모드별 형태·색 구분을 폐기하고 상태 = 사진 유무 하나로.
 *   전·후 대조(assertion):
 *   | 항목 | 전(WO 20260930-pinstyle) | 후(unifymode) |
 *   | ① 마커 클래스 | chk=pin-mode-checker · 360=pin-mode-360(상호배타) | pin-mode-* 0 · data-photo = 사진 유무(chk1 0 · chk2 1 · c360 1) |
 *   | ② 마커 형태 | chk 만 둥근사각 배지 프레임(rx 7.5) | 프레임 0(전부 같은 메달리온) · tip(18,60) 앵커 불변 |
 *   | ③ 미니맵 | pano-radar-pin-mode-checker/360 | mode 클래스 0 · kind = 사진 유무(chk2 = c360 = content) |
 *   | ④ 색 | CHECKER 주황 ≠ 360 | 같은 상태면 같은 색(chk2 = c360 · chk1 = EMPTY_COLOR) — 체커 메타는 색 축 아님 |
 *   뮤테이션 A/B 도 반전: 모드 클래스·배지 프레임을 **되살리면** ①②가 실패해야 한다. */
/* ── ① 도면 마커: 모드 클래스 없음 · 사진 유무 표식 ── */
function suiteMarkerModeClass(label, sSrc, uSrc) {
  console.log("\n[" + label + "]");
  const ui = runUI(sSrc, uSrc, FIXTURE());
  ok(!/pin-mode-/.test(ui.chk1.cls + " " + ui.chk2.cls + " " + ui.c360.cls), `모드 클래스(pin-mode-*) 0 → chk1=${ui.chk1.cls}`);
  ok(ui.chk1.photo === "0" && ui.chk2.photo === "1" && ui.c360.photo === "1", `data-photo = 사진 유무(체커 메타 무관) → chk1=${ui.chk1.photo}, chk2=${ui.chk2.photo}, c360=${ui.c360.photo}`);
  ok(/(^|\s)pin-hollow(\s|$)/.test(ui.chk1.cls) && /(^|\s)pin-filled(\s|$)/.test(ui.chk2.cls) && /(^|\s)pin-filled(\s|$)/.test(ui.c360.cls), "등록 표식 = pin-filled/hollow(사진 유무 축)만");
}

/* ── ② 도면 마커: 형태(SVG) 동일 — 배지 프레임 없음 ── */
function suiteMarkerShape(label, sSrc, uSrc) {
  console.log("\n[" + label + "]");
  const ui = runUI(sSrc, uSrc, FIXTURE());
  const badgeFrame = /<rect[^>]*rx="7\.5"[^>]*opacity="0\.95"/;
  ok(!badgeFrame.test(ui.chk1.html) && !badgeFrame.test(ui.chk2.html) && !badgeFrame.test(ui.c360.html), "어느 마커에도 CHECKER 배지 프레임 없음(같은 메달리온)");
  const norm = (h) => h.replace(/pg(body|stem|shadow)\d+/g, "pg$1").replace(/>[^<]*</g, "><");
  ok(norm(ui.chk2.html) === norm(ui.c360.html), "같은 상태(사진 있음)면 체커 메타가 있어도 마커 SVG 구조 동일(chk2 = c360)");
  ok(/M14\.2 22 L18 60 L21\.8 22 Z/.test(ui.chk1.html), "chk1 tip(18,60) 앵커 불변(위치 회귀 없음)");
  ok(/M14\.2 22 L18 60 L21\.8 22 Z/.test(ui.c360.html), "360 tip(18,60) 앵커 불변");
}

/* ── ③ 미니맵: 모드 클래스 없음 · kind = 사진 유무 ── */
function suiteRadarModeClass(label, sSrc, rSrc) {
  console.log("\n[" + label + "]");
  const fixture = FIXTURE();
  const rdr = runRadar(sSrc, rSrc, fixture, CURRENT(fixture));
  ok(!/pano-radar-pin-mode-/.test(rdr.chk1.cls + " " + rdr.c360.cls), `미니맵 모드 클래스 0 → chk1=${rdr.chk1.cls}`);
  ok(rdr.chk2.kind === "content" && rdr.c360.kind === "content" && rdr.chk1.kind === "empty", `미니맵 kind = 사진 유무 → chk1=${rdr.chk1.kind}, chk2=${rdr.chk2.kind}, c360=${rdr.c360.kind}`);
}

/* ── ④ 색: 같은 상태면 같은 색 ── */
function suiteColorFamily(label, sSrc) {
  console.log("\n[" + label + "]");
  const sandbox = { console, JSON, Map, Set, App: AppMock };
  vm.createContext(sandbox);
  vm.runInContext(sSrc + "\n;globalThis.__PS = PinSeries;", sandbox);
  const PS = sandbox.__PS;
  const f = FIXTURE(); const by = (id) => f.find((p) => p.id === id);
  ok(JSON.stringify(PS.markerStyle(by("chk2")).colors) === JSON.stringify(PS.markerStyle(by("c360")).colors), "사진 있는 체커 메타 핀(chk2) 색 = 360 핀(c360) 색");
  ok(JSON.stringify(PS.markerStyle(by("chk1")).colors) === JSON.stringify(PS.EMPTY_COLOR), "사진 없는 체커 메타 핀(chk1) 색 = 사진 없음(EMPTY_COLOR) — CHECKBOARD_EMPTY_COLOR 아님");
}

suiteMarkerModeClass("① 도면 마커 — 모드 클래스 0 · 사진 유무 표식 (정상 소스)", seriesSrc, uiSrc);
suiteMarkerShape("② 도면 마커 — 형태 동일 (정상 소스)", seriesSrc, uiSrc);
suiteRadarModeClass("③ 미니맵 — 모드 클래스 0 (정상 소스)", seriesSrc, radarSrc);
suiteColorFamily("④ 색 — 같은 상태 같은 색 (정상 소스)", seriesSrc);

/* ────────────────────────────────────────────────────────────
 * 뮤테이션A(반전): 모드 클래스 부여를 되살리면 ①이 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션A] 도면 마커 pin-mode-* 클래스 부여 복구 → ①이 실패해야 함");
  const needle = 'marker.dataset.photo = (PinSeries.hasPhoto && PinSeries.hasPhoto(pin)) ? "1" : "0";';
  const mutated = uiSrc.replace(needle, needle + ' marker.classList.add(pin.checkboard ? "pin-mode-checker" : "pin-mode-360");');
  if (mutated === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const ui = runUI(seriesSrc, mutated, FIXTURE());
    ok(/pin-mode-checker/.test(ui.chk1.cls), `뮤테이션 적용 시 모드 클래스 재출현(①이 잡는다 — 실효성 증명) → chk1=${ui.chk1.cls}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션B(반전): CHECKER 배지 프레임을 되살리면 ②가 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션B] CHECKER 배지 프레임 렌더 복구 → ②가 실패해야 함");
  const needle = '<circle cx="18" cy="15" r="12.4" fill="none" stroke="#1a1a1a"';
  const mutated = uiSrc.replace(needle, '${pin.checkboard ? `<rect x="3.6" y="2" width="28.8" height="27" rx="7.5" fill="#ffffff" opacity="0.95"/>` : ""}\n              ' + needle);
  if (mutated === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const ui = runUI(seriesSrc, mutated, FIXTURE());
    const badgeFrame = /<rect[^>]*rx="7\.5"[^>]*opacity="0\.95"/;
    ok(badgeFrame.test(ui.chk1.html), `뮤테이션 적용 시 배지 프레임 재출현(②가 잡는다 — 실효성 증명)`);
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
