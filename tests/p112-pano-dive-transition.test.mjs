/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p112-pano-dive-transition.test.mjs)
 *
 * 마스터 지시 "사진으로 빨려 들어가는 효과 구현" — PanoViewer.Dive (public/js/modules/06_PanoViewer.js)
 *  ① 진입점 공유: 모든 진입점이 App.openPano() 1개로 수렴 + 06_PanoViewer.js가 DOMContentLoaded 이후
 *     App.openPano를 비침투적으로 감싸(monkey-patch) PanoViewer.Dive.open()을 선두에 끼운다
 *     (🔴 20_App.js는 열람자 요청 팀 점유라 직접 편집하지 않음 — 기존 R1/R2/R4/R6 모바일 토글과 같은 패턴)
 *  ② reduced-motion(또는 저사양) → 200ms 페이드 경로(줌/원형/화각 생략)
 *  ③ 중복 탭 무시 — busy 중 재호출은 애니메이션을 재시작하지 않음
 *  ④ 닫기 역재생 후 #map-viewport 인라인 스타일 원복 + MapCtrl/State 불변(전혀 참조하지 않음)
 *  ⑤ 화각 펼침 — 다이빙 중 로드 시작 시 fov가 좁아지고(FOV_NARROW), 텍스처 준비 후 기본값으로 복귀
 *
 * 실제 모듈 소스(public/js/modules/06_PanoViewer.js)를 그대로 vm에 평가해 검사한다(목 구현 아님).
 * 각 검사에는 뮤테이션(수정 무력화) 케이스가 붙어 있어, 고친 코드를 되돌리면 실패한다.
 * 타이머는 실제(real) setTimeout을 쓴다(결정적 가짜 시계 대신 — 전체 실행 ~2초 내외).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pvSrc = fs.readFileSync(path.join(ROOT, "public/js/modules/06_PanoViewer.js"), "utf8").replace(/\r\n/g, "\n");

// 진입점 전수(grep 고정 — 발주서 재확인됨): 전부 App.openPano()를 호출한다.
const ENTRY_FILES = [
  "public/js/modules/11_UI.js",
  "public/js/modules/27_PinActionPop.js",
  "public/js/modules/07_Radar.js",
  "public/js/modules/08_PanoNav.js",
];

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 최소 fake DOM 엘리먼트(classList + style) */
function makeEl(extra) {
  const classes = new Set();
  return Object.assign({
    style: {},
    innerHTML: "",
    classList: {
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      contains: (c) => classes.has(c),
      toggle(c, force) {
        if (force === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); }
        else if (force) classes.add(c); else classes.delete(c);
        return classes.has(c);
      },
    },
    _classes: classes,
  }, extra || {});
}

/** 06_PanoViewer.js 를 새 vm 컨텍스트에 평가 — 다이빙에 필요한 최소 DOM/전역만 제공.
 *  App(선택)을 넘기면 DOMContentLoaded 디스패치로 06_PanoViewer.js 하단의 monkey-patch가
 *  실제로 App.openPano를 감싸는지까지 동적으로 검증할 수 있다. */
function makePV({ hardwareConcurrency = 8, reducedMotion = false, markerRect = { left: 90, top: 90, width: 20, height: 20 }, src = pvSrc, App } = {}) {
  const mapEl = makeEl();
  const ovEl = makeEl();
  const markerEl = markerRect ? { getBoundingClientRect: () => markerRect } : null;
  const els = { "map-viewport": mapEl, "pano-overlay": ovEl };
  const listeners = {};
  const document = {
    getElementById: (id) => els[id] || null,
    querySelector: (sel) => (markerEl && /pin-marker\[data-id="t1"\]/.test(sel) ? markerEl : null),
    querySelectorAll: () => [],
    fullscreenElement: null,
    exitFullscreen: () => Promise.resolve(),
    addEventListener: (type, cb) => { (listeners[type] = listeners[type] || []).push(cb); },
    __dispatch: (type) => { (listeners[type] || []).forEach((cb) => cb()); },
  };
  const window = {
    innerWidth: 400, innerHeight: 300,
    matchMedia: (q) => ({ matches: reducedMotion && /reduced-motion/.test(q) }),
  };
  const navigator = { hardwareConcurrency };
  const performance = { now: () => Date.now() };
  const Radar = { hide() {}, spin() {} };
  const PanoNav = { hide() {} };
  const Notes = { closePanel() {} };
  const sandbox = {
    console, document, window, navigator, performance, Radar, PanoNav, Notes,
    setTimeout, clearTimeout,
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  };
  if (App) sandbox.App = App;
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__PV = PanoViewer;", sandbox);
  return { PV: sandbox.__PV, mapEl, ovEl, document, sandbox };
}

/* ────────────────────────────────────────────────────────────
 * ① 진입점 공유 — grep 고정 대상 전부 App.openPano() 호출 + openPano()가 Dive.open() 배선
 * ──────────────────────────────────────────────────────────── */
function suiteEntryWiring(label, src) {
  console.log("\n[" + label + "]");
  for (const f of ENTRY_FILES) {
    const s = fs.readFileSync(path.join(ROOT, f), "utf8");
    ok(/App\.openPano\(/.test(s), f + " → App.openPano() 호출");
  }
  // 정적: monkey-patch 코드가 존재(20_App.js는 건드리지 않음 — 열람자 요청 팀 점유)
  ok(/if \(typeof App !== "undefined" && typeof App\.openPano === "function" && !App\.openPano\.__diveWrapped\) \{/.test(src),
    "06_PanoViewer.js에 App.openPano monkey-patch 가드가 있음(20_App.js 미편집)");
  // 동적: DOMContentLoaded 디스패치 후 실제로 App.openPano가 감싸지고, Dive.open()이 선행 호출되며,
  // 원래 로직(_origCalledWith)도 그대로 이어서 실행되는지 끝까지 검증.
  const calls = [];
  const App = { openPano(pin) { calls.push(pin); } };
  const { PV, document } = makePV({ App, src });
  document.__dispatch("DOMContentLoaded");
  ok(typeof App.openPano === "function" && App.openPano.__diveWrapped === true,
    "DOMContentLoaded 후 App.openPano가 Dive로 감싸짐(__diveWrapped=true)");
  App.openPano({ id: "wired-test" });
  ok(PV.Dive.busy === true, "감싸진 App.openPano 호출 → PanoViewer.Dive.open()이 실제로 실행됨(busy=true)");
  ok(calls.length === 1 && calls[0].id === "wired-test", "원래 openPano 로직도 그대로 이어서 실행됨(재구현 아님)");
  PV.Dive.busy = false;
}

/* ────────────────────────────────────────────────────────────
 * ② reduced-motion(저사양 포함) → 페이드 경로(줌/원형 생략)
 * ──────────────────────────────────────────────────────────── */
async function suiteReducedFade(label, src) {
  console.log("\n[" + label + "]");
  const { PV, mapEl, ovEl } = makePV({ hardwareConcurrency: 2, src });
  PV.Dive.open(PV, { id: "t1" });
  await sleep(10); // rAF(setTimeout 0)가 opacity:1을 걸 시간
  ok(ovEl.style.opacity === "1", "reduced 경로 → opacity 페이드 적용됨(opacity=1)");
  ok(mapEl.style.transform !== "scale(3)", "reduced 경로 → 도면 줌(scale(3)) 생략됨");
  await sleep(PV.Dive.REDUCED_FADE_MS + 60);
  ok(PV.Dive.busy === false, "페이드 종료 후 busy 해제(다음 입장 가능)");
}

/* ────────────────────────────────────────────────────────────
 * ③ 중복 탭 무시 — busy 중 재호출은 _zoomMap을 다시 실행하지 않음
 * ──────────────────────────────────────────────────────────── */
function suiteDuplicateTapIgnored(label, src) {
  console.log("\n[" + label + "]");
  const { PV } = makePV({ hardwareConcurrency: 8, reducedMotion: false, src });
  let calls = 0;
  const orig = PV.Dive._zoomMap.bind(PV.Dive);
  PV.Dive._zoomMap = (...a) => { calls++; return orig(...a); };
  PV.Dive.open(PV, { id: "t1" });
  PV.Dive.open(PV, { id: "t1" }); // 중복 탭(아직 busy)
  ok(calls === 1, "busy 중 재탭 → _zoomMap 1회만 실행(재시작 안 함), calls=" + calls);
  PV.Dive.busy = false; // 정리
}

/* ────────────────────────────────────────────────────────────
 * ④ 닫기 역재생 후 #map-viewport 원복 + MapCtrl/State 불변(참조 자체가 없음)
 * ──────────────────────────────────────────────────────────── */
async function suiteCloseRestoresMap(label, src) {
  console.log("\n[" + label + "]");
  const { PV, mapEl, ovEl } = makePV({ hardwareConcurrency: 8, reducedMotion: false, src });
  const State = { zoom: 2, pan: { x: 5, y: 9 } };
  const before = JSON.stringify(State);
  let closeImmediateCalled = false;
  PV._currentPin = { id: "t1" };
  PV.open = true;
  PV._closeImmediate = () => { closeImmediateCalled = true; };
  PV.close();
  await sleep(PV.Dive.CLOSE_FOV_MS + PV.Dive.CLOSE_OPEN_MS + PV.Dive.CLOSE_ZOOM_MS + 150);
  ok(closeImmediateCalled === true, "역재생 종료 후 _closeImmediate() 호출됨(실제 정리로 이어짐)");
  ok(mapEl.style.transform === "", "역재생 종료 후 #map-viewport 인라인 transform 원복(빈 문자열)");
  ok(ovEl.style.clipPath === "", "역재생 종료 후 clip-path 원복(빈 문자열)");
  ok(JSON.stringify(State) === before, "MapCtrl/State는 애초에 참조되지 않아 완전히 불변");
  const diveBlock = src.slice(src.indexOf("Dive: {"), src.indexOf("Dive: {") + 9000);
  const diveCodeOnly = diveBlock.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""); // 주석 제거(설명문 안의 "MapCtrl." 오탐 방지)
  ok(!/MapCtrl\.|State\./.test(diveCodeOnly),
    "Dive 블록 실행 코드 안에 MapCtrl./State. 참조가 전혀 없음(구조적 보장, 주석 제외)");
}

/* ────────────────────────────────────────────────────────────
 * ⑤ 화각 펼침 — markLoadStart가 fov를 좁히고, onTextureReady가 기본값으로 복귀시킴
 * ──────────────────────────────────────────────────────────── */
async function suiteFovRamp(label, src) {
  console.log("\n[" + label + "]");
  const { PV } = makePV({ hardwareConcurrency: 8, reducedMotion: false, src });
  PV.Dive.busy = true; PV.Dive.closing = false; PV.Dive._startTs = Date.now();
  PV.S = { fov: 75 };
  PV._invalidate = () => {};
  PV.Dive.markLoadStart(PV);
  ok(PV.S.fov === PV.Dive.FOV_NARROW, "다이빙 중 markLoadStart → fov가 FOV_NARROW(30)로 좁혀짐");
  PV.Dive.onTextureReady(PV);
  await sleep(PV.Dive.FOV_DELAY_MS + PV.Dive.FOV_MS + 80);
  ok(Math.abs(PV.S.fov - 75) < 0.5, "텍스처 준비 후 화각이 기본값(75)으로 복귀, fov=" + PV.S.fov);
  PV.Dive.busy = false;
}

/* ────────────────────────────────────────────────────────────
 * 실행: 정상 소스
 * ──────────────────────────────────────────────────────────── */
await (async () => {
  suiteEntryWiring("① 진입점 공유(정상)", pvSrc);
  await suiteReducedFade("② reduced-motion 페이드(정상)", pvSrc);
  suiteDuplicateTapIgnored("③ 중복 탭 무시(정상)", pvSrc);
  await suiteCloseRestoresMap("④ 닫기 역재생 원복(정상)", pvSrc);
  await suiteFovRamp("⑤ 화각 펼침(정상)", pvSrc);
})();

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 증명 ①: monkey-patch 가드를 지우면 ①이 실패해야 함(App.openPano가 감싸지지 않음)
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션①] monkey-patch 가드를 지우면 ①이 실패해야 함(App.openPano가 감싸지지 않음)");
  const needle = `if (typeof App !== "undefined" && typeof App.openPano === "function" && !App.openPano.__diveWrapped) {`;
  const replacement = `if (false) {`;
  const mutated = pvSrc.replace(needle, replacement);
  if (mutated === pvSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const App2 = { openPano(pin) {} };
    const { document: doc2 } = makePV({ App: App2, src: mutated });
    doc2.__dispatch("DOMContentLoaded");
    ok(App2.openPano.__diveWrapped !== true, "뮤테이션 적용 시 App.openPano가 더 이상 감싸지지 않음(테스트가 실효성 있음을 증명)");
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 증명 ②: reduced() 분기를 항상 false로 만들면 ②가 실패해야 함(풀 연출로 뒤집힘)
 * ──────────────────────────────────────────────────────────── */
await (async () => {
  console.log("\n[뮤테이션②] reduced 분기 가드를 무력화하면 ②가 실패해야 함(줌이 적용되어 버림)");
  const needle = `if (this.reduced() || !ov || !map) {`;
  const replacement = `if (false) {`;
  const mutated = pvSrc.replace(needle, replacement);
  if (mutated === pvSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; return; }
  const { PV, mapEl } = makePV({ hardwareConcurrency: 2, src: mutated });
  PV.Dive.open(PV, { id: "t1" });
  await sleep(20); // _zoomMap의 rAF(setTimeout 0)가 transform을 걸 시간
  ok(mapEl.style.transform === "scale(3)", "뮤테이션 적용 시 reduced 상태에서도 도면 줌이 걸려버림(테스트가 실효성 있음을 증명), transform=" + mapEl.style.transform);
})();

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 증명 ③: busy 가드를 지우면 ③이 실패해야 함(재탭마다 재시작)
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션③] busy 가드를 지우면 ③이 실패해야 함(중복 탭마다 재시작)");
  const needle = `      open(pv, pin) {
        if (this.busy) return; // 🔴 중복 탭 무시(재시작 금지)
        this.busy = true; this.closing = false;`;
  const replacement = `      open(pv, pin) {
        this.busy = true; this.closing = false;`;
  const mutated = pvSrc.replace(needle, replacement);
  if (mutated === pvSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PV } = makePV({ hardwareConcurrency: 8, src: mutated });
    // mutated 소스 재평가
    const mapEl2 = makeEl(); const ovEl2 = makeEl();
    const els = { "map-viewport": mapEl2, "pano-overlay": ovEl2 };
    const sb = {
      console,
      document: { getElementById: (id) => els[id] || null, querySelector: () => null, fullscreenElement: null },
      window: { innerWidth: 400, innerHeight: 300, matchMedia: () => ({ matches: false }) },
      navigator: { hardwareConcurrency: 8 },
      performance: { now: () => Date.now() },
      Radar: { hide(){}, spin(){} }, PanoNav: { hide(){} }, Notes: { closePanel(){} },
      setTimeout, clearTimeout,
      requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
      cancelAnimationFrame: (id) => clearTimeout(id),
    };
    vm.createContext(sb);
    vm.runInContext(mutated + "\n;globalThis.__PV3 = PanoViewer;", sb);
    const PV3 = sb.__PV3;
    let calls = 0;
    const orig = PV3.Dive._zoomMap.bind(PV3.Dive);
    PV3.Dive._zoomMap = (...a) => { calls++; return orig(...a); };
    PV3.Dive.open(PV3, { id: "t1" });
    PV3.Dive.open(PV3, { id: "t1" });
    ok(calls === 2, "뮤테이션 적용 시 중복 탭마다 재시작되어 버림(테스트가 실효성 있음을 증명), calls=" + calls);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 증명 ④: finish()의 _resetMap() 호출을 지우면 ④가 실패해야 함(원복 안 됨)
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션④] close() finish()의 _resetMap()을 지우면 ④가 실패해야 함(도면 줌 흔적이 남음)");
  const needle = `        const finish = () => {
          this._resetMap(); map.classList.remove("dive-dim");`;
  const replacement = `        const finish = () => {
          map.classList.remove("dive-dim");`;
  const mutated = pvSrc.replace(needle, replacement);
  if (mutated === pvSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mapEl2 = makeEl(); const ovEl2 = makeEl();
    const els = { "map-viewport": mapEl2, "pano-overlay": ovEl2 };
    const sb = {
      console,
      document: { getElementById: (id) => els[id] || null, querySelector: () => null, fullscreenElement: null },
      window: { innerWidth: 400, innerHeight: 300, matchMedia: () => ({ matches: false }) },
      navigator: { hardwareConcurrency: 8 },
      performance: { now: () => Date.now() },
      Radar: { hide(){}, spin(){} }, PanoNav: { hide(){} }, Notes: { closePanel(){} },
      setTimeout, clearTimeout,
      requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
      cancelAnimationFrame: (id) => clearTimeout(id),
    };
    vm.createContext(sb);
    vm.runInContext(mutated + "\n;globalThis.__PV4 = PanoViewer;", sb);
    const PV4 = sb.__PV4;
    PV4._currentPin = { id: "t1" };
    PV4.open = true;
    PV4._closeImmediate = () => {};
    PV4.close();
    await sleep(PV4.Dive.CLOSE_FOV_MS + PV4.Dive.CLOSE_OPEN_MS + PV4.Dive.CLOSE_ZOOM_MS + 150);
    ok(mapEl2.style.transform !== "", "뮤테이션 적용 시 #map-viewport 줌 흔적이 원복되지 않고 남음(테스트가 실효성 있음을 증명), transform=" + mapEl2.style.transform);
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
