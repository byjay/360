/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p4-pin-series.test.mjs)
 *
 * 마스터 지시(2026-09-02):
 *  "360 사진/첨부를 넣는 핀과 단순 체크보드 핀은 색상을 달리하고,
 *   각각 일련번호도 따로, 그 핀만 보기 버튼도 칩 버튼(필터)으로."
 *
 *  ① 콘텐츠 계열 / 체크보드 계열이 각각 1부터 독립 채번된다.
 *  ② 체크보드 핀은 저장된 label 숫자를 우선한다(기존 데이터 불변).
 *  ③ 도면 마커(11_UI.renderPinsOnMap)와 미니맵 점(07_Radar.update)이 같은 번호를 낸다
 *     — 둘 다 정본 PinSeries.numbers() 하나만 호출하기 때문.
 *  ④ 필터를 켜도 번호가 재계산되지 않는다(숨김은 표시만 감춘다).
 *  ⑤ 필터가 도면·미니맵 양쪽에 동일하게 적용된다.
 *
 * 실제 모듈 소스(01b_PinSeries.js / 11_UI.js / 07_Radar.js)를 그대로 vm에 평가해 검사한다(목 구현 아님).
 * 각 검사에는 뮤테이션(수정 무력화) 케이스가 붙어 있어, 고친 코드를 되돌리면 실패한다.
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

/* ── 최소 DOM 목(mock) ─────────────────────────────────────── */
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
  // 실제 DOM 과 동일하게 textContent/ dataset 값은 문자열로 강제 변환된다.
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
const makeLocalStorage = () => {
  const store = {};
  return { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, _store: store };
};

/** 실제 App.pinHasContent 와 같은 판정(미디어 또는 노트/첨부) — 목이 아니라 동일 규칙의 최소 구현 */
const AppMock = {
  pinHasContent(pin) {
    return !!(pin && (pin.imageId || pin.imageUrl || pin.videoId ||
      pin.note || (pin.attachments && pin.attachments.length) || pin.has3D));
  }
};

/** 도면 마커 렌더(11_UI.renderPinsOnMap) 실행 → { id: 번호 } / kind 맵 */
function runUI(sSrc, uSrc, { pins, page = 1, filter = null }) {
  const { document, registry } = makeDoc();
  const State = { pins, pdfPage: page, mode: "viewer", activePin: null, zoneView: null, zones: [] };
  const sandbox = { console, document, State, localStorage: makeLocalStorage(), App: AppMock, JSON, Map, Set };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(sSrc + "\n" + uSrc + "\n;globalThis.__UI = UI; globalThis.__PS = PinSeries;", sandbox);
  const PS = sandbox.__PS;
  if (filter) PS._filter = Object.assign({ content: true, empty: true, checkboard: true }, filter);
  sandbox.__UI.renderPinsOnMap();
  const markers = registry["pins-layer"]._children;
  const nums = {}, kinds = {};
  markers.forEach((m) => { nums[m.dataset.id] = String(m.dataset.no); kinds[m.dataset.id] = m.dataset.kind; });
  return { nums, kinds, markers, registry, PS };
}

/** 미니맵 점 렌더(07_Radar.update) 실행 → { id: 번호 } */
function runRadar(sSrc, rSrc, { pins, page = 1, filter = null, currentPin }) {
  const { document, registry } = makeDoc();
  const State = { pins, pdfPage: page, mode: "viewer", viewerPages: ["p1.jpg"], zones: [] };
  const sandbox = { console, document, State, localStorage: makeLocalStorage(), App: AppMock, JSON, Map, Set };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(sSrc + "\n" + rSrc + "\n;globalThis.__R = Radar; globalThis.__PS = PinSeries;", sandbox);
  const PS = sandbox.__PS;
  if (filter) PS._filter = Object.assign({ content: true, empty: true, checkboard: true }, filter);
  sandbox.__R.update(currentPin || pins[0]);
  const dots = registry["pano-radar-pins"]._children;
  const nums = {};
  dots.forEach((d) => { nums[d.dataset.id] = String(d._children[0] && d._children[0]._text); });
  return { nums, dots, registry, PS };
}

/* 공통 픽스처
   콘텐츠 계열(체크보드 아님): c1(콘텐츠), e1(미배치), c2(콘텐츠)  → 1, 2, 3
   체크보드 계열: b1(label 없음) → 1,  b2(label "77") → 77,  b3(label 없음) → 3
   다른 페이지 x1 은 제외된다. */
const FIXTURE = () => [
  { id: "c1", page: 1, x: 10, y: 10, imageId: "img1" },
  { id: "b1", page: 1, x: 15, y: 15, checkboard: true },
  { id: "e1", page: 1, x: 20, y: 20 },
  { id: "b2", page: 1, x: 25, y: 25, checkboard: true, label: "77" },
  { id: "x1", page: 2, x: 30, y: 30, imageId: "img2" },
  { id: "c2", page: 1, x: 35, y: 35, note: "확인 필요" },
  { id: "b3", page: 1, x: 40, y: 40, checkboard: true }
];

/* ────────────────────────────────────────────────────────────
 * ① 계열 독립 채번  ② 체크보드 label 우선
 * ──────────────────────────────────────────────────────────── */
function suiteSeries(label, sSrc) {
  console.log("\n[" + label + "]");
  const { nums, kinds } = runUI(sSrc, uiSrc, { pins: FIXTURE() });
  ok(nums.c1 === "1", `콘텐츠 계열 c1 = ${nums.c1} (기대 1)`);
  ok(nums.e1 === "2", `콘텐츠 계열 e1(미배치도 같은 계열) = ${nums.e1} (기대 2)`);
  ok(nums.c2 === "3", `콘텐츠 계열 c2 = ${nums.c2} (기대 3)`);
  ok(nums.b1 === "1", `체크보드 계열 b1 = ${nums.b1} (기대 1 — 콘텐츠 계열과 독립)`);
  ok(nums.b3 === "3", `체크보드 계열 b3 = ${nums.b3} (기대 3 — 체크보드 3번째)`);
  ok(nums.x1 === undefined, "다른 페이지 핀 x1 은 렌더되지 않음");
  ok(kinds.c1 === "content" && kinds.e1 === "empty" && kinds.b1 === "checkboard",
    `부류 판정 = ${kinds.c1}/${kinds.e1}/${kinds.b1} (기대 content/empty/checkboard)`);
  // ② label 우선
  ok(nums.b2 === "77", `체크보드 b2 = ${nums.b2} (기대 77 — 저장된 label 숫자 우선)`);
}

/* ────────────────────────────────────────────────────────────
 * ③ 도면 마커 == 미니맵 점 (같은 정본 함수)
 * ──────────────────────────────────────────────────────────── */
function suiteSameNumbers(label, sSrc, rSrc) {
  console.log("\n[" + label + "]");
  const pins = FIXTURE();
  const ui = runUI(sSrc, uiSrc, { pins });
  const rd2 = runRadar(sSrc, rSrc, { pins, currentPin: pins[0] });
  const ids = Object.keys(ui.nums);
  ok(ids.length === 6, `도면 마커 수 = ${ids.length} (기대 6)`);
  const diff = ids.filter((id) => ui.nums[id] !== rd2.nums[id]);
  ok(diff.length === 0,
    `도면↔미니맵 번호 불일치 ${diff.length}건` +
    (diff.length ? " → " + diff.map((id) => `${id}: 도면 ${ui.nums[id]} vs 미니맵 ${rd2.nums[id]}`).join(", ") : ""));
}

/* ────────────────────────────────────────────────────────────
 * ④ 필터를 켜도 번호가 재계산되지 않는다 (숨김은 표시만)
 * ⑤ 필터가 도면·미니맵 양쪽에 동일 적용
 * ──────────────────────────────────────────────────────────── */
/* [WO 20260929 addendum, 지휘자 정정] "그냥 체크보드랑 360모드랑 2개 해" — 필터 축이 kindOf
 * (3종: content/empty/checkboard)에서 seriesOf(2종: checkboard/content)로 바뀌었다. e1(empty
 * 부류)은 체크보드가 아니므로 이제 "content(360)" 계열 필터에 포함되어 함께 보인다(kind=empty
 * 만 따로 숨기는 3번째 칩은 없다 — 마스터: "내가 시킨 것만 하고"). */
function suiteFilter(label, sSrc, rSrc) {
  console.log("\n[" + label + "]");
  const pins = FIXTURE();
  const filter = { checkboard: false, content: true }; // 360(content) 계열만 보기
  const ui = runUI(sSrc, uiSrc, { pins, filter });
  const shown = Object.keys(ui.nums).sort();
  ok(shown.join(",") === "c1,c2,e1", `도면 표시 핀 = [${shown.join(",")}] (기대 c1,c2,e1 — checkboard 아닌 전부)`);
  // ④ 필터 전과 같은 번호(1, 3) — 1,2 로 다시 매겨지면 안 된다
  ok(ui.nums.c1 === "1" && ui.nums.c2 === "3",
    `필터 후 번호 c1=${ui.nums.c1}, c2=${ui.nums.c2} (기대 1, 3 — 재채번 금지)`);

  // ⑤ 미니맵에도 같은 필터 적용 + 같은 번호
  const rd2 = runRadar(sSrc, rSrc, { pins, filter, currentPin: pins[0] });
  const shownR = Object.keys(rd2.nums).sort();
  ok(shownR.join(",") === "c1,c2,e1", `미니맵 표시 점 = [${shownR.join(",")}] (기대 c1,c2,e1 — 도면과 동일)`);
  ok(rd2.nums.c1 === "1" && rd2.nums.c2 === "3",
    `미니맵 필터 후 번호 c1=${rd2.nums.c1}, c2=${rd2.nums.c2} (기대 1, 3)`);

  // 체크보드만 보기 → 체크보드 번호(1, 77, 3) 유지
  const ui2 = runUI(sSrc, uiSrc, { pins, filter: { checkboard: true, content: false } });
  ok(Object.keys(ui2.nums).sort().join(",") === "b1,b2,b3", `체크보드만 보기 = [${Object.keys(ui2.nums).sort().join(",")}]`);
  ok(ui2.nums.b1 === "1" && ui2.nums.b2 === "77" && ui2.nums.b3 === "3",
    `체크보드만 보기 번호 = ${ui2.nums.b1}/${ui2.nums.b2}/${ui2.nums.b3} (기대 1/77/3)`);

  // 칩 렌더: CHECKER/360 2칩뿐 — '전체' 칩 없음(마스터: "그냥 체크보드랑 360모드랑 2개 해")
  const bar = ui.registry["pin-filter-bar"];
  ok(!/data-series="all"/.test(bar.innerHTML) && !/data-kind="all"/.test(bar.innerHTML), "필터 칩 바에 '전체' 칩이 없음(2칩만)");
  ok(/data-series="content"[\s\S]*?zpager-cnt">3</.test(bar.innerHTML), "360 칩 개수 = 3(c1,c2,e1)");
  ok(/data-series="checkboard"[\s\S]*?zpager-cnt">3</.test(bar.innerHTML), "CHECKER 칩 개수 = 3(b1,b2,b3)");
}

/* ────────────────────────────────────────────────────────────
 * 실행: 정상 소스
 * ──────────────────────────────────────────────────────────── */
suiteSeries("①② 계열 독립 채번 + label 우선 (정상 소스)", seriesSrc);
suiteSameNumbers("③ 도면 == 미니맵 (정상 소스)", seriesSrc, radarSrc);
suiteFilter("④⑤ 필터 (정상 소스)", seriesSrc, radarSrc);

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 A: 계열 분리를 되돌려 하나의 카운터로 세면 ①이 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션A] 계열 분리 제거(체크보드가 콘텐츠 계열 번호를 소비) → ①이 실패해야 함");
  const needle = "          nCheck++;\n";
  const mutated = seriesSrc.replace(needle, "          nCheck++; nContent++; nCheck = nContent;\n");
  if (mutated === seriesSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { nums } = runUI(mutated, uiSrc, { pins: FIXTURE() });
    const broken = (nums.c1 === "1" && nums.e1 === "2" && nums.c2 === "3" && nums.b1 === "1" && nums.b3 === "3");
    ok(broken === false,
      `뮤테이션 적용 시 계열 독립 채번이 깨짐(테스트 실효성 증명) → c1=${nums.c1}, e1=${nums.e1}, c2=${nums.c2}, b1=${nums.b1}, b3=${nums.b3}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 B: 미니맵이 정본을 우회해 자체 카운터로 세면 ③이 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션B] 미니맵이 PinSeries 정본을 우회해 자체 채번 → ③이 실패해야 함");
  let m = radarSrc.replace(
    "const numMap = PinSeries.numbers(State.pins, page);",
    "const numMap = PinSeries.numbers(State.pins, page); let radarIdx = 0;");
  const hit1 = m !== radarSrc;
  const before = m;
  m = m.replace(
    "const meta = numMap.get(p.id) || { no: 0, kind: PinSeries.kindOf(p), series: PinSeries.seriesOf(p) };",
    "radarIdx++; const meta = { no: radarIdx, kind: PinSeries.kindOf(p), series: PinSeries.seriesOf(p) };");
  const hit2 = m !== before;
  if (!hit1 || !hit2) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const pins = FIXTURE();
    const ui = runUI(seriesSrc, uiSrc, { pins });
    const rd2 = runRadar(seriesSrc, m, { pins, currentPin: pins[0] });
    const diff = Object.keys(ui.nums).filter((id) => ui.nums[id] !== rd2.nums[id]);
    ok(diff.length > 0,
      `뮤테이션 적용 시 도면↔미니맵 번호가 어긋남(테스트 실효성 증명) → 불일치 ${diff.length}건`);
  }
}

/* ────────────────────────────────────────────────────────────
 * ⑥ [WO 20260930-marker-no] 지도 마커 표시 라벨 = PinSeries.formatNo SoT
 *    (트리/핀패널과 같은 포맷: 360=P접두, CHECKER=숫자만). dataset.no 는 원본 숫자 그대로(위 ①③④⑤ 불변).
 * ──────────────────────────────────────────────────────────── */
console.log("\n[⑥ 지도 마커 표시 라벨 — 360=P접두 / CHECKER=숫자만 (정상 소스)]");
{
  const { markers } = runUI(seriesSrc, uiSrc, { pins: FIXTURE() });
  const byId = {}; markers.forEach((m) => { byId[m.dataset.id] = m; });
  ok(/>P1</.test(byId.c1.innerHTML), `콘텐츠(360) 계열 c1 마커 라벨 = P1 표시: ${/>P\d+</.exec(byId.c1.innerHTML)}`);
  ok(/>P2</.test(byId.e1.innerHTML), `콘텐츠(360) 계열 e1 마커 라벨 = P2 표시`);
  ok(/>P3</.test(byId.c2.innerHTML), `콘텐츠(360) 계열 c2 마커 라벨 = P3 표시`);
  ok(/>1</.test(byId.b1.innerHTML) && !/>P1</.test(byId.b1.innerHTML), `CHECKER 계열 b1 마커 라벨 = 1(접두 없음, 기존 그대로)`);
  ok(/>77</.test(byId.b2.innerHTML) && !/>P77</.test(byId.b2.innerHTML), `CHECKER 계열 b2 마커 라벨 = 77(접두 없음)`);
  // dataset.no 는 여전히 원본 숫자(포맷 없음) — 위 ①의 nums 비교(p4 suiteSeries)와 회귀 없음 재확인
  ok(String(byId.c1.dataset.no) === "1" && String(byId.b1.dataset.no) === "1", `dataset.no 는 원본 숫자 그대로(포맷 미적용): c1=${byId.c1.dataset.no}, b1=${byId.b1.dataset.no}`);
}
console.log("\n[뮤테이션C] 마커 라벨 포맷을 dispNo(포맷 없음)로 되돌리면 ⑥이 실패해야 함");
{
  const needle = 'const dispLabel = (typeof PinSeries !== "undefined" && PinSeries.formatNo) ? PinSeries.formatNo(meta.no, meta.series) : String(dispNo);';
  if (uiSrc.indexOf(needle) < 0) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mutatedUiSrc = uiSrc.replace(needle, "const dispLabel = dispNo;");
    const { markers } = runUI(seriesSrc, mutatedUiSrc, { pins: FIXTURE() });
    const byId = {}; markers.forEach((m) => { byId[m.dataset.id] = m; });
    const stillFormatted = /P1/.test(byId.c1.innerHTML);
    console.log((!stillFormatted ? "  PASS(예상대로 실패 재현) " : "  FAIL(뮤테이션에도 통과 — 테스트가 가짜) ") + "c1 innerHTML has P1: " + stillFormatted);
    if (stillFormatted) failed++;
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
