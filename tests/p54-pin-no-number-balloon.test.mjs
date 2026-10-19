/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p54-pin-no-number-balloon.test.mjs)
 *
 * 마스터 지시(2026-09-21): "이런 거 보기 싫어. 상태를 색이나 모양으로 변경하라고. 숫자 풍선 없애고"
 * → 마스터 지시(2026-09-28): "번호가 안본다" (체크보드 핀 6개가 흰 원판만, 번호 없음)
 * → 마스터 지시(2026-09-29): "번호가 없잖아 … 번호가 왜 사라졌는지 복구해" (스크린샷: 초록 과녁
 *   아이콘만 보이고 번호 없음)
 *
 * 근본원인(9/28→9/29 재회귀): 9/28 조치가 "아이콘 없는 핀만 번호"로 좁게 복구했다
 *   (11_UI.js: `PinIcons.headMarkup(...) || <text>번호</text>`) — 커스텀 아이콘(icon≠"number")을
 *   고른 핀은 여전히 번호 대신 아이콘만 그려져 마스터가 본 화면(밸브 아이콘 핀)엔 번호가 없었다.
 *
 * 조치(9/29): 번호 <text> 를 아이콘 유무와 무관하게 항상 그린다(더는 `||` 폴백 아님, 독립 라인).
 *   아이콘은 버리지 않고 머리 우상단 모서리의 작은 보조 배지(circle.pin-icon-badge + PinIcons
 *   아이콘, cx=26.8/cy=6.3/scale=0.32)로 옮겨 번호와 공존시킨다. 상태 3축(등록 fill/tier 원판
 *   실루엣/계열 링 dash)은 그대로 유지. 체크보드 간소화 분기(500행대)는 원래부터 아이콘 오버라이드가
 *   없었으므로(항상 번호만) 변경 없음 — 아이콘 배지도 그 분기에선 계속 숨겨진다(요구사항 그대로).
 *
 * 실제 모듈 소스(01b_PinSeries.js / 11_UI.js / 07_Radar.js / style.css / 27_PinActionPop.js /
 * 23b_PinIcons.js)를 그대로 vm 에 평가하거나 원문을 직접 grep 한다(목 구현 아님).
 * 뮤테이션 4건(ⓐ아이콘 핀 번호 제거 재회귀 재현 ⓑ아이콘 배지 제거 ⓒ형태 제거·색만 ⓓ핀 확대)이
 * 붙어 있어, 되돌리면 반드시 실패한다.
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
const cssSrc    = rd("public/css/style.css");
const popupSrc  = rd("public/js/modules/27_PinActionPop.js");
const iconsSrc  = rd("public/js/modules/23b_PinIcons.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 최소 DOM 목 (p9 와 동일 구조 재사용) ───────────────────────── */
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
const AppMock = {
  pinHasContent(pin) {
    return !!(pin && (pin.imageId || pin.imageUrl || pin.videoId ||
      pin.note || (pin.attachments && pin.attachments.length) || pin.has3D));
  }
};

/** 도면 마커 렌더 → 핀별 상세(마크업 문자열까지 보존해 텍스트/도형 부재를 직접 검사) */
function runUI(sSrc, uSrc, pins, page = 1) {
  const { document, registry } = makeDoc();
  const State = { pins, pdfPage: page, mode: "viewer", activePin: null, zoneView: null, zones: [] };
  const sandbox = { console, document, State, localStorage: makeLocalStorage(), App: AppMock, JSON, Map, Set };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // PinIcons 실제 모듈도 로드(icon 핀은 headMarkup 배지 렌더 대상 — sandbox 에 PinIcons 가
  // 없으면 typeof 가드가 항상 false 로 빠져 icon 핀도 배지 없는 허위 실패가 난다).
  vm.runInContext(iconsSrc + "\n" + sSrc + "\n" + uSrc + "\n;globalThis.__UI = UI; globalThis.__PS = PinSeries;", sandbox);
  sandbox.__UI.renderPinsOnMap();
  const out = {};
  registry["pins-layer"]._children.forEach((m) => {
    const html = m._html;
    out[m.dataset.id] = {
      html,
      no: String(m.dataset.no), kind: m.dataset.kind, filled: m.dataset.filled, tier: m.dataset.tier,
      cls: m.className,
      discTag: (html.match(/<(circle|rect)\b[^>]*class="pin-tier-disc"/) || [])[1] || null,
      headFillAttr: (html.match(/r="11\.8" fill="([^"]+)"/) || [])[1] || null,
      dash: (html.match(/stroke-dasharray="([^"]*)"/) || [])[1] || "",
      hasBadge: /class="pin-icon-badge"/.test(html)
    };
  });
  return { pins: out, PS: sandbox.__PS };
}

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
    out[d.dataset.id] = { kind: d.dataset.kind, filled: d.dataset.filled, bg: d.style.background, border: d.style.borderStyle };
  });
  return out;
}

/* 픽스처: 콘텐츠 3상태 × 등록여부 × 계열(content/checkboard) 전 조합 + 커스텀 아이콘 핀 */
const FIXTURE = () => [
  { id: "photo1",   page: 1, x: 5,  y: 5,  imageId: "img1" },                          // content 계열, 등록, photo
  { id: "content1", page: 1, x: 10, y: 10, note: "메모" },                              // content 계열, 등록, content(노트만)
  { id: "empty1",   page: 1, x: 15, y: 15 },                                            // content 계열, 미등록, empty
  { id: "cbPhoto",  page: 1, x: 20, y: 20, checkboard: true, imageId: "shotA" },        // checkboard 계열, 등록, photo
  { id: "cbEmpty",  page: 1, x: 25, y: 25, checkboard: true },                          // checkboard 계열, 미등록, empty
  { id: "iconPin",  page: 1, x: 30, y: 30, icon: "valve" }                              // 커스텀 아이콘(번호+배지 공존 확인용, content 계열 4번째)
];
const CURRENT = (f) => f[0];

/* ────────────────────────────────────────────────────────────
 * ① 핀 마커 SVG 머리 안(흰 원판 위)에 번호 <text> 가 있다 — 커스텀 아이콘 핀도 예외 없음(9/29 수정 핵심)
 * ──────────────────────────────────────────────────────────── */
function suiteHeadHasNumberText(label, sSrc) {
  console.log("\n[" + label + "]");
  const fixture = FIXTURE();
  const ui = runUI(sSrc, uiSrc, fixture).pins;
  // [WO 20260930-marker-no] 표시 라벨 포맷 SoT = PinSeries.formatNo. dataset.no(raw)는 ⑥에서 별도로 검증한다.
  // 🔴 [WO 20261015-numunify] 전·후 대조: 종전 P1/P2/P3/1/2/P4(계열별 독립·360 P접두) → 새 1/2/3/4/5/6(한 번호 공간·접두 없음)
  const expectLabel = { photo1: "1", content1: "2", empty1: "3", cbPhoto: "4", cbEmpty: "5", iconPin: "6" };
  Object.keys(expectLabel).forEach((id) => {
    ok(/<text\b/.test(ui[id].html), `① ${id}: 머리 SVG 에 <text> 요소 있음(번호)`);
    const re = new RegExp(`>${expectLabel[id]}</text>`);
    ok(re.test(ui[id].html), `① ${id}: 번호 텍스트 표시 라벨이 PinSeries.formatNo(${expectLabel[id]})와 일치`);
  });
  // 🔴 9/29 핵심 수정: 커스텀 아이콘(icon="valve") 핀도 번호 <text> 가 있어야 한다(더는 번호 대체 아님)
  ok(/<text\b/.test(ui.iconPin.html) && />6<\/text>/.test(ui.iconPin.html),
    "① iconPin: 커스텀 아이콘 핀도 번호(6) <text> 존재 — 9/29 재회귀 수정 확인");
  // 아이콘은 버리지 않고 보조 배지로 공존(원본 기능 보존)
  ok(ui.iconPin.hasBadge, "① iconPin: 아이콘은 pin-icon-badge 보조 배지로 이동해 공존");
  ok(!ui.photo1.hasBadge && !ui.content1.hasBadge,
    "① 아이콘 없는 핀은 pin-icon-badge 없음(불필요한 빈 배지 그리지 않음)");
}

/* ────────────────────────────────────────────────────────────
 * ② 번호는 머리 안(흰 원판 위)에 있고, 머리 밖 별도 숫자 배지("풍선")는 없다.
 *   (아이콘 보조 배지 pin-icon-badge 는 "숫자 풍선"이 아니므로 별개 — 배제하지 않는다.)
 * ──────────────────────────────────────────────────────────── */
function suiteNumberInsideHeadOnly(label, sSrc) {
  console.log("\n[" + label + "]");
  const fixture = FIXTURE();
  const ui = runUI(sSrc, uiSrc, fixture).pins;
  ["photo1", "content1", "empty1", "iconPin"].forEach((id) => {
    ok(!!ui[id].discTag, `② ${id}: pin-tier-disc 는 여전히 형태 단서로 존재(discTag=${ui[id].discTag})`);
    const afterDisc = ui[id].html.slice(ui[id].html.indexOf('class="pin-tier-disc"'));
    // [WO 20260930-marker-no] content 계열은 "P" 접두가 붙는다(PinSeries.formatNo) — 접두 유무 무관하게 숫자 텍스트가 있으면 통과.
    ok(/>P?\d+<\/text>/.test(afterDisc), `② ${id}: 원판 뒤(같은 svg 안)에 번호 텍스트 있음`);
    // svg 밖(마커 최상위)에 별도 "숫자" 배지 div 는 없음(풍선=머리 밖 숫자 배지는 여전히 없음).
    // pin-icon-badge 는 svg 안의 circle(아이콘 보조 표시)이지 svg 밖 숫자 배지가 아니므로 무관.
    ok(!/<div[^>]*(pin-num-badge|number-badge|pin-badge)/.test(ui[id].html),
      `② ${id}: 머리 밖 별도 숫자 배지(풍선) 요소 없음`);
  });
}

/* ────────────────────────────────────────────────────────────
 * ③ 색을 전부 제거해도 photo/content/empty 3상태가 형태만으로 구분된다
 * ──────────────────────────────────────────────────────────── */
const shapeSig = (p) => p.discTag + ":" + (/^url\(/.test(p.headFillAttr) ? "filled" : "hollow");
function suiteShapeOnly3State(label, sSrc) {
  console.log("\n[" + label + "]");
  const fixture = FIXTURE();
  const ui = runUI(sSrc, uiSrc, fixture).pins;
  ok(ui.photo1.tier === "photo" && ui.content1.tier === "content" && ui.empty1.tier === "empty",
    `③ tier 판정: photo=${ui.photo1.tier}, content=${ui.content1.tier}, empty=${ui.empty1.tier}`);
  const sigs = [shapeSig(ui.photo1), shapeSig(ui.content1), shapeSig(ui.empty1)];
  ok(new Set(sigs).size === 3,
    `③ 색 속성(hex) 전혀 안 보고 태그명+채움구조만으로 3상태 전부 구분 → ${sigs.join(", ")}`);
}

/* ────────────────────────────────────────────────────────────
 * ④ 계열(content·checkboard) 구분 유지
 * ──────────────────────────────────────────────────────────── */
function suiteSeriesKind(label, sSrc) {
  console.log("\n[" + label + "]");
  const fixture = FIXTURE();
  const ui = runUI(sSrc, uiSrc, fixture).pins;
  ok(ui.photo1.kind === "content" && ui.cbPhoto.kind === "checkboard",
    `④ kind 구분: content 계열=${ui.photo1.kind}, checkboard 계열=${ui.cbPhoto.kind}`);
  ok(ui.cbPhoto.dash !== ui.photo1.dash || ui.cbEmpty.dash !== ui.empty1.dash,
    "④ 계열별 외곽 링 dash 패턴이 최소 한 조합에서 구분됨(형태 단서)");
}

/* ────────────────────────────────────────────────────────────
 * ⑤ 등록여부(채운 원 vs 속 빈 원) 구분 유지
 * ──────────────────────────────────────────────────────────── */
function suiteFilledHollow(label, sSrc) {
  console.log("\n[" + label + "]");
  const fixture = FIXTURE();
  const ui = runUI(sSrc, uiSrc, fixture).pins;
  ok(ui.photo1.headFillAttr !== ui.empty1.headFillAttr,
    `⑤ 일반 계열 등록↔미등록 헤드 fill 다름: ${ui.photo1.headFillAttr} ≠ ${ui.empty1.headFillAttr}`);
  ok(ui.cbPhoto.headFillAttr !== ui.cbEmpty.headFillAttr,
    `⑤ 체크보드 계열 등록↔미등록 헤드 fill 다름: ${ui.cbPhoto.headFillAttr} ≠ ${ui.cbEmpty.headFillAttr}`);
  ok(/pin-filled/.test(ui.photo1.cls) && /pin-hollow/.test(ui.empty1.cls),
    "⑤ pin-filled/pin-hollow 클래스로도 등록여부 구분");
}

/* ────────────────────────────────────────────────────────────
 * ⑥ 번호를 다른 경로에서 확인 가능(정보 유실 0)
 * ──────────────────────────────────────────────────────────── */
function suiteNumberStillAvailable(label, sSrc) {
  console.log("\n[" + label + "]");
  const fixture = FIXTURE();
  const ui = runUI(sSrc, uiSrc, fixture).pins;
  ok(ui.photo1.no === "1" && ui.content1.no === "2" && ui.empty1.no === "3",
    `⑥ dataset.no 계속 계산됨(content 계열) → ${ui.photo1.no}/${ui.content1.no}/${ui.empty1.no}`);
  ok(/class="pin-num">\$\{idx \+ 1\}/.test(uiSrc) || /pin-num">\$\{idx\+1\}/.test(uiSrc),
    "⑥ #pin-list 의 .pin-num 에 번호 표시 코드 존재(renderPinList)");
  ok(/pap-no"\)\.textContent = "#" \+/.test(popupSrc),
    "⑥ PinActionPop #pap-no 에 번호 표시 코드 존재(open())");
}

/* ────────────────────────────────────────────────────────────
 * ⑦ 핀 크기 21×37 불변
 * ──────────────────────────────────────────────────────────── */
function suitePinSize(label, css) {
  console.log("\n[" + label + "]");
  ok(/\.pin-pin svg\s*\{[^}]*width:\s*21px;\s*height:\s*37px/.test(css),
    "⑦ .pin-pin svg { width:21px; height:37px } 불변");
}

/* ────────────────────────────────────────────────────────────
 * ⑧ 미니맵 점 표시와 규칙 정합
 * ──────────────────────────────────────────────────────────── */
function suiteRadarParity(label, sSrc, rSrc) {
  console.log("\n[" + label + "]");
  const fixture = FIXTURE();
  const ui = runUI(sSrc, uiSrc, fixture).pins;
  const rdr = runRadar(sSrc, rSrc, fixture, CURRENT(fixture));
  const ids = ["content1", "empty1", "cbPhoto", "cbEmpty"];
  const diff = ids.filter((id) => ui[id].filled !== rdr[id].filled || ui[id].kind !== rdr[id].kind);
  ok(diff.length === 0, `⑧ 도면↔미니맵 kind/filled 판정 일치(정본 PinSeries.markerStyle 공용) 불일치 ${diff.length}건`);
  ok(/PinSeries\.markerStyle\(p\)/.test(rSrc), "⑧ 07_Radar.js 가 PinSeries.markerStyle 정본을 그대로 호출(우회 없음)");
}

/* ── 실행: 정상 소스 ─────────────────────────────────────────── */
suiteHeadHasNumberText("① 머리 안 번호 <text> 있음, 아이콘도 예외 없음 (정상 소스)", seriesSrc);
suiteNumberInsideHeadOnly("② 번호는 머리 안에만, 머리 밖 숫자 배지 없음 (정상 소스)", seriesSrc);
suiteShapeOnly3State("③ 색 제거해도 3상태 형태로 구분 (정상 소스)", seriesSrc);
suiteSeriesKind("④ 계열 구분 유지 (정상 소스)", seriesSrc);
suiteFilledHollow("⑤ 등록여부 구분 유지 (정상 소스)", seriesSrc);
suiteNumberStillAvailable("⑥ 번호 다른 경로 확인 가능 (정상 소스)", seriesSrc);
suitePinSize("⑦ 핀 크기 불변 (정상 소스)", cssSrc);
suiteRadarParity("⑧ 미니맵 정합 (정상 소스)", seriesSrc, radarSrc);

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 ⓐ: 아이콘 핀 번호 제거(9/28→9/29 실제 회귀 재현 — `text||icon` 폴백으로 되돌림)
 *   → ①의 iconPin 번호 검사가 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션ⓐ] 아이콘 핀 번호를 폴백(||)으로 되돌림(9/29 재회귀 재현) → ①이 실패해야 함");
  // [2026-10-19 WO 20261019-pinscale3-label 갱신] font-size 리터럴(9/13)이 labelGeom.fs(자릿수 SoT)로
  // 바뀌었다 — needle/치환 양쪽을 그 리터럴과 일치시킨다.
  // [2026-10-19 WO 20261019-pinscale4 갱신] ae36a91 이 번호 <text> 에 class="pin-num-text" 를
  // 추가했다(LABEL_HIDE_PX 자동숨김용 셀렉터) — needle/치환 양쪽을 그 클래스와 일치시킨다.
  const needle = '<text class="pin-num-text" x="18" y="15.4" text-anchor="middle" dominant-baseline="central" font-family="\'Segoe UI\',sans-serif" font-size="${labelGeom.fs}" font-weight="900" fill="${txtFill}">${dispLabel}</text>\n              ${(typeof PinIcons !== "undefined" && pin.icon && pin.icon !== "number")\n                ? `<circle class="pin-icon-badge" cx="26.8" cy="6.3" r="5.4" fill="#ffffff" stroke="${headFill2}" stroke-width="1.3"/>${PinIcons.headMarkup(pin.icon, txtFill, 6.3, 26.8, 0.32)}`\n                : ""}';
  const mutated = uiSrc.replace(needle,
    '${(typeof PinIcons !== "undefined" && pin.icon && pin.icon !== "number" && PinIcons.headMarkup(pin.icon, txtFill, 15))\n                || `<text class="pin-num-text" x="18" y="15.4" text-anchor="middle" dominant-baseline="central" font-family="\'Segoe UI\',sans-serif" font-size="${labelGeom.fs}" font-weight="900" fill="${txtFill}">${dispLabel}</text>`}');
  if (mutated === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const fixture = FIXTURE();
    const ui = runUI(seriesSrc, mutated, fixture).pins;
    ok(!/<text\b/.test(ui.iconPin.html), `뮤테이션 적용 시 iconPin 번호 <text> 사라짐(①붕괴 증명, 9/29 회귀 재현) → hasText=${/<text\b/.test(ui.iconPin.html)}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 ⓑ: 아이콘 보조 배지 제거 → ① 의 배지 존재 검사가 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션ⓑ] 아이콘 보조 배지 제거 → ① 의 hasBadge 검사가 실패해야 함");
  const needle = '${(typeof PinIcons !== "undefined" && pin.icon && pin.icon !== "number")\n                ? `<circle class="pin-icon-badge" cx="26.8" cy="6.3" r="5.4" fill="#ffffff" stroke="${headFill2}" stroke-width="1.3"/>${PinIcons.headMarkup(pin.icon, txtFill, 6.3, 26.8, 0.32)}`\n                : ""}';
  const mutated = uiSrc.replace(needle, '""');
  if (mutated === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const fixture = FIXTURE();
    const ui = runUI(seriesSrc, mutated, fixture).pins;
    ok(!ui.iconPin.hasBadge, `뮤테이션 적용 시 iconPin 의 pin-icon-badge 사라짐(① 붕괴 증명) → hasBadge=${ui.iconPin.hasBadge}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 ⓒ: 형태 구분 제거하고 색만 다르게 → ③이 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션ⓒ] 형태 구분 제거·색만 다르게 → ③이 실패해야 함");
  // [2026-10-19 WO 20261019-pinscale3-label 갱신] tierDisc 가 labelGeom 기반 — 이 테스트 fixture 는
  // 전부 1자리라 rx===ry=8.6, 결과는 원문과 동일(회귀 0).
  const needle = "const tierDisc = (tier === \"content\")\n          ? `<rect class=\"pin-tier-disc\" x=\"${(18 - labelGeom.rx).toFixed(1)}\" y=\"${(15 - labelGeom.ry).toFixed(1)}\" width=\"${(labelGeom.rx * 2).toFixed(1)}\" height=\"${(labelGeom.ry * 2).toFixed(1)}\" rx=\"3\" fill=\"#ffffff\" opacity=\"0.99\"/>`\n          : (tier === \"photo\")\n            ? `<${_discTag} class=\"pin-tier-disc\" ${_discGeomAttr(18, 15)} fill=\"#ffffff\" opacity=\"0.99\"/><circle cx=\"22.6\" cy=\"10.4\" r=\"4.2\" fill=\"#ffffff\" opacity=\"0.99\" stroke=\"#1a1a1a\" stroke-width=\"0.8\"/>`\n            : `<${_discTag} class=\"pin-tier-disc\" ${_discGeomAttr(18, 15)} fill=\"#ffffff\" opacity=\"0.99\"/>`;";
  const mutated = uiSrc.replace(needle,
    'const tierDisc = (tier === "content")\n          ? `<circle class="pin-tier-disc" cx="18" cy="15" r="8.6" fill="#ffcc00" opacity="0.99"/>`\n          : (tier === "photo")\n            ? `<circle class="pin-tier-disc" cx="18" cy="15" r="8.6" fill="#00ccff" opacity="0.99"/>`\n            : `<circle class="pin-tier-disc" cx="18" cy="15" r="8.6" fill="#ffffff" opacity="0.99"/>`;');
  if (mutated === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const fixture = FIXTURE();
    const ui = runUI(seriesSrc, mutated, fixture).pins;
    const sigs = [shapeSig(ui.photo1), shapeSig(ui.content1), shapeSig(ui.empty1)];
    ok(new Set(sigs).size < 3,
      `뮤테이션 적용 시 색만 다르고 형태(태그)는 같아져 색 제거 서명이 붕괴(③ 실효성 증명) → ${sigs.join(", ")}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 ⓓ: 핀 확대(37→50px) → ⑦이 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션ⓓ] 핀 확대(height 37→50px) → ⑦이 실패해야 함");
  const needle = ".pin-pin svg { width: 21px; height: 37px; display: block; overflow: visible; }";
  const mutated = cssSrc.replace(needle, ".pin-pin svg { width: 30px; height: 50px; display: block; overflow: visible; }");
  if (mutated === cssSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    ok(!/\.pin-pin svg\s*\{[^}]*width:\s*21px;\s*height:\s*37px/.test(mutated),
      "뮤테이션 적용 시 21×37 매치 실패(⑦ 실효성 증명)");
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
