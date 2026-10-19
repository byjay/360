/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p55-pin-filter.test.mjs)
 *
 * 마스터 신고: "체크보드 모드일 때 역시 핀이 생겨야지", "리스트만 생기고 핀 모양이 안 생기잖아"
 * 지휘자 프로덕션 재현(scan.seastar.work, RICHO E2E, SW·캐시 삭제 후):
 *   초기 진입 #pins-layer.children=0(전부 숨김) → "전체" 클릭 시 5 → "체크보드" 클릭 시 다시 0
 *   (5개 전부 체크보드 계열인데 칩은 "체크보드 5"로 개수를 정확히 센다)
 *
 * 근본원인(경로:라인) — 01b_PinSeries.js filter()/iconFilter() (수정 전):
 *   FILTER_KEY="wm-pin-filter" / ICON_FILTER_KEY="wm-pin-icon-filter" 가 프로젝트/배포본 구분이
 *   없는 "전역" localStorage 키였다. 한 프로젝트에서 계열(kind) 하나를 껐다가 나가면 그 값이
 *   브라우저에 영구히 남아, 전혀 다른 새 프로젝트를 열 때도 조용히 적용된다. "SW·캐시 삭제"는
 *   보통 localStorage 를 지우지 않으므로, 이전 세션에서 저장된 {checkboard:false} 값이 살아남아
 *   RICHO E2E(핀 100%가 checkboard 계열)를 열자마자 전부 숨겨졌다 — "초기 전부 숨김"과
 *   "체크보드 필터가 체크보드를 거른다"는 사실 하나의 근본원인(전역 영구 필터 유령 상태)이다.
 *   개수 계산(counts())과 표시 판정(isVisible())은 이미 같은 kindOf() 정본을 썼다(SoT 자체는
 *   원래도 문제 없었음) — 문제는 그 판정이 참조하는 filter() 값이 세션 밖에서 오염된 것.
 *
 * 조치: filter()/iconFilter() 의 localStorage read/write(영구 저장)를 제거. 매 페이지 로드마다
 *   항상 { content:true, empty:true, checkboard:true }(전체 표시)로 시작 — 다른 프로젝트/이전
 *   세션의 값이 새 프로젝트에 새어 들어올 통로 자체를 없앤다. 판정 함수(kindOf/isVisible/counts)는
 *   그대로 SoT 유지.
 *
 * 실제 모듈 소스(01b_PinSeries.js / 11_UI.js)를 그대로 vm 에 평가한다(목 구현 아님).
 * 뮤테이션 3건이 붙어 있어, 되돌리면 반드시 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const seriesSrc = rd("public/js/modules/01b_PinSeries.js");
const uiSrc     = rd("public/js/modules/11_UI.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 최소 DOM 목 (p54 와 동일 구조 재사용) ───────────────────────── */
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
/** localStorage 목 — 뮤테이션ⓐ 재현용으로 seed 값을 미리 심을 수 있게 함 */
const makeLocalStorage = (seed) => {
  const store = Object.assign({}, seed || {});
  return { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, _store: store };
};
const AppMock = {
  pinHasContent(pin) {
    return !!(pin && (pin.imageId || pin.imageUrl || pin.videoId ||
      pin.note || (pin.attachments && pin.attachments.length) || pin.has3D));
  }
};

/* 🔴 [WO 20261019-unifymode] 계약 이관 — 필터 축: 계열 2칩(data-series checkboard/content, 독립 토글) → 사진 유무 3칩
 *   (data-pfilter all/photo/nophoto, 배타 선택). 이 파일의 원래 불변식(유령 필터 0 · 칩 개수 == 표시 개수 · 개수/표시 SoT 공용 ·
 *   on/off 시각 구분)은 그대로 새 축에서 검사한다. 전·후 대조:
 *   | ① | CHECKER 칩 초기 active | [전체] 칩 초기 active · 5개 표시 |
 *   | ② | CHECKER 껐다 켜기(0→5) | [사진 있음](0 — 체커 5개 모두 사진 없음) → [사진 없음](5) → [전체](5) |
 *   | ③ | content 끄고 showAll() | [사진 없음] 후 showAll() → 5 |
 *   | ④ | 계열 2축 조합 | 3키 전부: 활성 칩 개수 == #pins-layer |
 *   | ⑤ | seriesCounts/isVisible 가 seriesOf 공용 | photoCounts/isVisible 가 hasPhoto(정본 mediaOf) 공용 |
 *   | ⑥ | pf-checkboard.active CSS | pf-nophoto.active CSS · aria-pressed true→false |
 *   | 🔴 | wm-pin-filter 유령값 무시 | 같은 유령값 + 새 키 유령값 무시(사진 필터는 메모리 전용) |
 *   뮤테이션 ⓐ(localStorage 복원) ⓑ(사진 판정 오판) ⓒ(표시 판정 소스 분리) — 각 대상이 새 축으로 이관. */
function runSession(sSrc, uSrc, pins, clicks, localStorageSeed) {
  const { document, registry } = makeDoc();
  const State = { pins, pdfPage: 1, mode: "viewer", activePin: null, zoneView: null, zones: [] };
  const ls = makeLocalStorage(localStorageSeed);
  const sandbox = { console, document, State, localStorage: ls, App: AppMock, JSON, Map, Set };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(sSrc + "\n" + uSrc + "\n;globalThis.__UI = UI; globalThis.__PS = PinSeries;", sandbox);
  sandbox.__UI.renderPinsOnMap(); // 최초 렌더(진입 직후, 클릭 이전)
  const snapshot = () => {
    const bar = registry["pin-filter-bar"];
    const html = bar ? bar._html : "";
    const chipCounts = {};
    const chipActive = {};
    const re = /data-pfilter="([a-z]+)"[^>]*aria-pressed="(true|false)"[^>]*>[\s\S]*?<span class="zpager-cnt">(\d+)<\/span>/g;
    let m;
    while ((m = re.exec(html))) { chipCounts[m[1]] = Number(m[3]); chipActive[m[1]] = m[2] === "true"; }
    return { layerChildren: registry["pins-layer"]._children.length, chipCounts, chipActive, html };
  };
  const snapshots = [snapshot()];
  clicks.forEach((key) => {
    if (key === "showAll") sandbox.__PS.showAll(); else sandbox.__PS.setPhotoFilter(key);
    sandbox.__PS.apply();
    snapshots.push(snapshot());
  });
  return { snapshots, PS: sandbox.__PS, ls };
}

/* 픽스처 A: 프로덕션 재현과 동일 — 5개 전부 체크보드 메타(사진 없음) */
const FIXTURE_ALL_CB = () => Array.from({ length: 5 }, (_, i) => ({ id: "cb" + i, page: 1, x: i * 5, y: i * 5, checkboard: true, label: String(i + 1) }));
/* 픽스처 B: 혼합 — 사진 있음 2(c1 · cb2) + 사진 없음 3(c2 · cb1 · cb3) — 체커 메타와 사진 유무를 엇갈리게 */
const FIXTURE_MIXED = () => ([
  { id: "c1", page: 1, x: 1, y: 1, imageId: "img1" },
  { id: "c2", page: 1, x: 2, y: 2 },
  { id: "cb1", page: 1, x: 3, y: 3, checkboard: true, label: "1" },
  { id: "cb2", page: 1, x: 4, y: 4, checkboard: true, label: "2", imageId: "img2" },
  { id: "cb3", page: 1, x: 5, y: 5, checkboard: true, label: "3" }
]);

function suiteInitialAllVisible(label, sSrc) {
  console.log("\n[" + label + "]");
  const { snapshots } = runSession(sSrc, uiSrc, FIXTURE_ALL_CB(), []);
  ok(snapshots[0].layerChildren === 5, `① 초기 진입 시 #pins-layer 자식 5개(전부 표시) → 실측 ${snapshots[0].layerChildren}`);
  ok(snapshots[0].chipActive.all === true && snapshots[0].chipActive.photo === false && snapshots[0].chipActive.nophoto === false, "① [전체] 칩이 초기부터 active(aria-pressed=true) · 나머지 false");
  ok(!/data-series=/.test(snapshots[0].html), "① 구 CHECKER/360 칩(data-series) 0");
}

function suiteToggleMatches(label, sSrc) {
  console.log("\n[" + label + "]");
  const { snapshots } = runSession(sSrc, uiSrc, FIXTURE_ALL_CB(), ["photo", "nophoto", "all"]);
  const ph = snapshots[1], no = snapshots[2], al = snapshots[3];
  ok(ph.layerChildren === 0 && ph.chipCounts.photo === 0 && ph.chipCounts.nophoto === 5, `② [사진 있음]: 표시 0 / 칩 0 · 사진 없음 칩 5 → 표시=${ph.layerChildren}, 칩=${JSON.stringify(ph.chipCounts)}`);
  ok(no.layerChildren === 5 && no.chipCounts.nophoto === 5, `② [사진 없음]: 표시=칩 표기 5 → ${no.layerChildren}`);
  ok(al.layerChildren === 5 && al.chipCounts.all === 5, `② [전체]: 표시=칩 표기 5 → ${al.layerChildren}`);
}

function suiteAllChip(label, sSrc) {
  console.log("\n[" + label + "]");
  const { snapshots } = runSession(sSrc, uiSrc, FIXTURE_MIXED(), ["nophoto", "showAll"]);
  const afterOff = snapshots[1], afterAll = snapshots[2];
  ok(afterOff.layerChildren === 3, `③ 사전조건: [사진 없음] → 3(c2·cb1·cb3 — 체커 메타 무관) → ${afterOff.layerChildren}`);
  ok(afterAll.layerChildren === 5, `③ showAll() 호출 후 5개 전부 표시 → ${afterAll.layerChildren}`);
}

function suiteCountsMatchDisplay(label, sSrc) {
  console.log("\n[" + label + "]");
  const combos = [[], ["photo"], ["nophoto"], ["photo", "nophoto"], ["nophoto", "all"], ["showAll"]];
  let allMatch = true;
  combos.forEach((clicks) => {
    const { snapshots } = runSession(sSrc, uiSrc, FIXTURE_MIXED(), clicks);
    const last = snapshots[snapshots.length - 1];
    const act = Object.keys(last.chipActive).filter((k) => last.chipActive[k]);
    const n = act.length === 1 ? last.chipCounts[act[0]] : -1;
    if (n !== last.layerChildren) { allMatch = false; console.log(`    불일치: clicks=${JSON.stringify(clicks)} active=${act} chip=${n} layer=${last.layerChildren}`); }
  });
  ok(allMatch, "④ 모든 필터 조합에서 활성 칩(배타 1개) 개수 == #pins-layer 표시 개수");
}

function suiteSameSourceOfTruth(label, sSrc) {
  console.log("\n[" + label + "]");
  ok(/photoCounts\(pins, page\)[\s\S]{0,260}this\.hasPhoto\(p\)/.test(sSrc), "⑤ photoCounts() 가 hasPhoto() 를 직접 호출해 집계(정본 공용)");
  ok(/isVisible\(pin\)\s*\{\s*return\s*this\.matchesPhotoFilter\(pin\)/.test(sSrc) && /matchesPhotoFilter\(pin, key\)[\s\S]{0,200}this\.hasPhoto\(pin\)/.test(sSrc),
    "⑤ isVisible() 도 matchesPhotoFilter → 같은 hasPhoto() 로 판정(카운트와 분리된 별도 소스 없음)");
}

function suiteVisualDistinction(label, sSrc) {
  console.log("\n[" + label + "]");
  const { snapshots } = runSession(sSrc, uiSrc, FIXTURE_ALL_CB(), ["nophoto"]);
  ok(snapshots[0].chipActive.nophoto === false && snapshots[1].chipActive.nophoto === true && snapshots[1].chipActive.all === false,
    `⑥ 클릭 전후 aria-pressed 값이 다름(사진 없음 false→true · 전체 true→false)`);
  ok(/\.pinfilter-chip\.pf-nophoto\.active\{/.test(rd("public/css/style.css")) && /\.pinfilter-chip\.pf-all\.active\{/.test(rd("public/css/style.css")),
    "⑥ CSS 에 .active 전용 배경색 규칙 존재(클래스로도 구분)");
}

function suiteNoGhostLeak(label, sSrc) {
  console.log("\n[" + label + "]");
  const ghostSeed = { "wm-pin-filter": JSON.stringify({ content: true, empty: true, checkboard: false }), "wm-photo-filter": "photo" };
  const { snapshots } = runSession(sSrc, uiSrc, FIXTURE_ALL_CB(), [], ghostSeed);
  ok(snapshots[0].layerChildren === 5 && snapshots[0].chipActive.all === true,
    `🔴 이전 세션 유령값(구 키 · 새 키)이 남아있어도 새 세션은 전체표시로 시작 → 실측 ${snapshots[0].layerChildren}`);
}

suiteInitialAllVisible("① 초기 전부 표시 (정상 소스)", seriesSrc);
suiteToggleMatches("② 사진 필터 전환 표시 == 칩 개수 (정상 소스)", seriesSrc);
suiteAllChip("③ showAll (정상 소스)", seriesSrc);
suiteCountsMatchDisplay("④ 모든 조합 칩 개수==표시개수 (정상 소스)", seriesSrc);
suiteSameSourceOfTruth("⑤ 개수·필터 SoT 공용 (정상 소스)", seriesSrc);
suiteVisualDistinction("⑥ on/off 시각 구분 (정상 소스)", seriesSrc);
suiteNoGhostLeak("🔴 전역 유령 localStorage 미반영 (정상 소스)", seriesSrc);

/* 뮤테이션 ⓐ: 사진 필터를 localStorage 에서 복원하게 되돌림 → 유령값 테스트가 실패해야 한다 */
{
  console.log("\n[뮤테이션ⓐ] photoFilter() 를 localStorage 복원 버전으로 → 유령값 테스트가 실패해야 함");
  const needle = '    photoFilter() { return this._photoFilter || "all"; },';
  const mutated = seriesSrc.replace(needle, '    photoFilter() { try { const v = localStorage.getItem("wm-photo-filter"); if (v && !this._photoTouched) { this._photoTouched = true; this._photoFilter = v; } } catch (e) {} return this._photoFilter || "all"; },');
  if (mutated === seriesSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const ghostSeed = { "wm-photo-filter": "photo" };
    const { snapshots } = runSession(mutated, uiSrc, FIXTURE_ALL_CB(), [], ghostSeed);
    ok(snapshots[0].layerChildren === 0, `뮤테이션 적용 시 유령값이 다시 반영되어 초기 0개(유령누출 붕괴 증명) → 실측 ${snapshots[0].layerChildren}`);
  }
}

/* 뮤테이션 ⓑ: 사진 판정(hasPhoto)을 항상 false 로 오판 → ②④가 실패해야 한다 */
{
  console.log("\n[뮤테이션ⓑ] hasPhoto() 오판(항상 false) → ③(혼합 [사진 없음] = 3)이 깨져야 함");
  const needle = '      return !!h && this.mediaOf(h);';
  const mutated = seriesSrc.replace(needle, '      return false;');
  if (mutated === seriesSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { snapshots } = runSession(mutated, uiSrc, FIXTURE_MIXED(), ["nophoto"]);
    ok(snapshots[1].layerChildren !== 3, `뮤테이션 적용 시 [사진 없음] 표시가 3 이 아님(③ 실효성 증명) → ${snapshots[1].layerChildren}`);
  }
}

/* 뮤테이션 ⓒ: isVisible() 을 photoCounts 와 다른 소스(pin.imageId 직접)로 분리 → ⑤가 실패해야 한다 */
{
  console.log("\n[뮤테이션ⓒ] isVisible() 을 다른 소스로 분리 → ⑤가 실패해야 함");
  const needle = '    isVisible(pin) { return this.matchesPhotoFilter(pin) && this.isIconVisible(pin); },';
  const mutated = seriesSrc.replace(needle, '    isVisible(pin) { const k = this.photoFilter(); return (k === "all" || (k === "photo") === !!(pin && pin.imageId)) && this.isIconVisible(pin); },');
  if (mutated === seriesSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    ok(!/isVisible\(pin\)\s*\{\s*return\s*this\.matchesPhotoFilter\(pin\)/.test(mutated), "뮤테이션 적용 시 isVisible() 이 더는 matchesPhotoFilter 를 직접 쓰지 않음(⑤ 실효성 증명)");
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
