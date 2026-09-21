/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p54-pin-no-number-balloon.test.mjs)
 *
 * 마스터 지시(2026-09-21): "이런 거 보기 싫어. 상태를 색이나 모양으로 변경하라고. 숫자 풍선 없애고"
 *
 * 근본원인: 11_UI.js renderPinsOnMap() 이 커스텀 아이콘이 없는 모든 핀 머리에
 *   흰 원판(pin-tier-disc) 위 <text>{번호}</text> ("숫자 풍선")를 항상 그렸다.
 *   이미 존재하던 3축(등록여부=헤드 fill 채움/속빈 · 콘텐츠 3상태=tier 원판 실루엣(원/둥근사각/겹원)
 *   · 계열=외곽 링 dash 패턴)만으로 흑백에서도 상태 구분이 충분한데, 그 위에 숫자까지 얹어
 *   "풍선"으로 보였다.
 *
 * 조치: 커스텀 아이콘이 없는 핀은 <text> 를 그리지 않는다(11_UI.js). 번호 자체는 버리지 않고
 *   dataset.no 는 유지 + #pin-list(.pin-num)·PinActionPop(#pap-no)에서 계속 확인 가능.
 *
 * 실제 모듈 소스(01b_PinSeries.js / 11_UI.js / 07_Radar.js / style.css / 27_PinActionPop.js)를
 * 그대로 vm 에 평가하거나 원문을 직접 grep 한다(목 구현 아님).
 * 뮤테이션 3건(ⓐ번호 복원 ⓑ형태 제거·색만 ⓒ핀 확대)이 붙어 있어, 되돌리면 반드시 실패한다.
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
  vm.runInContext(sSrc + "\n" + uSrc + "\n;globalThis.__UI = UI; globalThis.__PS = PinSeries;", sandbox);
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
      dash: (html.match(/stroke-dasharray="([^"]*)"/) || [])[1] || ""
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

/* 픽스처: 콘텐츠 3상태 × 등록여부 × 계열(content/checkboard) 전 조합 */
const FIXTURE = () => [
  { id: "photo1",   page: 1, x: 5,  y: 5,  imageId: "img1" },                          // content 계열, 등록, photo
  { id: "content1", page: 1, x: 10, y: 10, note: "메모" },                              // content 계열, 등록, content(노트만)
  { id: "empty1",   page: 1, x: 15, y: 15 },                                            // content 계열, 미등록, empty
  { id: "cbPhoto",  page: 1, x: 20, y: 20, checkboard: true, imageId: "shotA" },        // checkboard 계열, 등록, photo
  { id: "cbEmpty",  page: 1, x: 25, y: 25, checkboard: true },                          // checkboard 계열, 미등록, empty
  { id: "iconPin",  page: 1, x: 30, y: 30, icon: "warning" }                            // 커스텀 아이콘(번호 아님, 예외 확인용)
];
const CURRENT = (f) => f[0];

/* ────────────────────────────────────────────────────────────
 * ① 핀 마커 SVG 에 번호 <text> 가 없다 (커스텀 아이콘 예외 제외)
 * ──────────────────────────────────────────────────────────── */
function suiteNoNumberText(label, sSrc) {
  console.log("\n[" + label + "]");
  const fixture = FIXTURE();
  const ui = runUI(sSrc, uiSrc, fixture).pins;
  ["photo1", "content1", "empty1", "cbPhoto", "cbEmpty"].forEach((id) => {
    ok(!/<text\b/.test(ui[id].html), `① ${id}: 머리 SVG 에 <text> 요소 없음`);
    ok(!/>\d+<\/text>/.test(ui[id].html), `① ${id}: 숫자 텍스트 노드 없음`);
  });
  // 커스텀 아이콘 핀은 번호가 아니라 아이콘(PinIcons)이 렌더 시도 대상 — <text> 는 여전히 없어야 함
  ok(!/<text\b/.test(ui.iconPin.html), "① iconPin: 커스텀 아이콘 핀도 <text> 없음(번호 아님)");
}

/* ────────────────────────────────────────────────────────────
 * ② 흰 원판(pin-tier-disc)이 숫자 담는 용도로 남아있지 않다
 *   (원판 다음에 곧바로 오는 숫자 텍스트가 없음 — ①과 함께 구조적으로 증명)
 * ──────────────────────────────────────────────────────────── */
function suiteDiscNotNumberCarrier(label, sSrc) {
  console.log("\n[" + label + "]");
  const fixture = FIXTURE();
  const ui = runUI(sSrc, uiSrc, fixture).pins;
  ["photo1", "content1", "empty1"].forEach((id) => {
    ok(!!ui[id].discTag, `② ${id}: pin-tier-disc 는 여전히 형태 단서로 존재(discTag=${ui[id].discTag})`);
    // 원판 렌더 뒤에 숫자 <text> 가 이어붙지 않음(원판=형태 단서 전용, 숫자 캐리어 아님)
    const afterDisc = ui[id].html.slice(ui[id].html.indexOf('class="pin-tier-disc"'));
    ok(!/>\d+<\/text>/.test(afterDisc), `② ${id}: 원판 뒤에 숫자 텍스트 없음(원판=형태 전용)`);
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
  // dataset.no 는 여전히 계산·부여됨(화면 표시만 다른 곳으로 이관, 값 자체는 안 버림)
  ok(ui.photo1.no === "1" && ui.content1.no === "2" && ui.empty1.no === "3",
    `⑥ dataset.no 계속 계산됨(content 계열) → ${ui.photo1.no}/${ui.content1.no}/${ui.empty1.no}`);
  // #pin-list — renderPinList()가 .pin-num 에 번호를 그대로 표시(11_UI.js 원문 확인)
  ok(/class="pin-num">\$\{idx \+ 1\}/.test(uiSrc) || /pin-num">\$\{idx\+1\}/.test(uiSrc),
    "⑥ #pin-list 의 .pin-num 에 번호 표시 코드 존재(renderPinList)");
  // PinActionPop(#pap-no) — 편집 팝업에 번호 표시(27_PinActionPop.js 원문 확인)
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
 * ⑧ 미니맵 점 표시와 규칙 정합 — 같은 PinSeries.markerStyle 정본 사용,
 *   filled/kind 판정이 도면 마커와 일치한다(한쪽만 바뀌면 갈라짐).
 * ──────────────────────────────────────────────────────────── */
function suiteRadarParity(label, sSrc, rSrc) {
  console.log("\n[" + label + "]");
  const fixture = FIXTURE();
  const ui = runUI(sSrc, uiSrc, fixture).pins;
  const rdr = runRadar(sSrc, rSrc, fixture, CURRENT(fixture));
  const ids = ["content1", "empty1", "cbPhoto", "cbEmpty"]; // photo1 은 current(색 비교 제외 사양)
  const diff = ids.filter((id) => ui[id].filled !== rdr[id].filled || ui[id].kind !== rdr[id].kind);
  ok(diff.length === 0, `⑧ 도면↔미니맵 kind/filled 판정 일치(정본 PinSeries.markerStyle 공용) 불일치 ${diff.length}건`);
  // 미니맵은 여전히 07_Radar.js 가 PinSeries 정본을 그대로 호출(우회 없음)
  ok(/PinSeries\.markerStyle\(p\)/.test(rSrc), "⑧ 07_Radar.js 가 PinSeries.markerStyle 정본을 그대로 호출(우회 없음)");
}

/* ── 실행: 정상 소스 ─────────────────────────────────────────── */
suiteNoNumberText("① 번호 <text> 없음 (정상 소스)", seriesSrc);
suiteDiscNotNumberCarrier("② 원판이 숫자 캐리어가 아님 (정상 소스)", seriesSrc);
suiteShapeOnly3State("③ 색 제거해도 3상태 형태로 구분 (정상 소스)", seriesSrc);
suiteSeriesKind("④ 계열 구분 유지 (정상 소스)", seriesSrc);
suiteFilledHollow("⑤ 등록여부 구분 유지 (정상 소스)", seriesSrc);
suiteNumberStillAvailable("⑥ 번호 다른 경로 확인 가능 (정상 소스)", seriesSrc);
suitePinSize("⑦ 핀 크기 불변 (정상 소스)", cssSrc);
suiteRadarParity("⑧ 미니맵 정합 (정상 소스)", seriesSrc, radarSrc);

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 ⓐ: 번호 <text> 복원 → ①이 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션ⓐ] 번호 <text> 복원 → ①이 실패해야 함");
  const needle = '${(typeof PinIcons !== "undefined" && pin.icon && pin.icon !== "number" && PinIcons.headMarkup(pin.icon, txtFill, 15)) || ""}';
  const mutated = uiSrc.replace(needle,
    '${(typeof PinIcons !== "undefined" && pin.icon && pin.icon !== "number" && PinIcons.headMarkup(pin.icon, txtFill, 15)) || `<text x="18" y="15.4" text-anchor="middle" dominant-baseline="central" font-family="\'Segoe UI\',sans-serif" font-size="13" font-weight="900" fill="${txtFill}">${dispNo}</text>`}');
  if (mutated === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const fixture = FIXTURE();
    const ui = runUI(seriesSrc, mutated, fixture).pins;
    ok(/<text\b/.test(ui.photo1.html), `뮤테이션 적용 시 <text> 복원됨(①붕괴 증명) → ${ui.photo1.html.includes("<text") }`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 ⓑ: 형태 구분 제거하고 색만 다르게 → ③이 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션ⓑ] 형태 구분 제거·색만 다르게 → ③이 실패해야 함");
  const needle = 'const tierDisc = (tier === "content")\n          ? `<rect class="pin-tier-disc" x="9.8" y="6.8" width="16.4" height="16.4" rx="3" fill="#ffffff" opacity="0.99"/>`\n          : (tier === "photo")\n            ? `<circle class="pin-tier-disc" cx="18" cy="15" r="8.6" fill="#ffffff" opacity="0.99"/><circle cx="22.6" cy="10.4" r="4.2" fill="#ffffff" opacity="0.99" stroke="#1a1a1a" stroke-width="0.8"/>`\n            : `<circle class="pin-tier-disc" cx="18" cy="15" r="8.6" fill="#ffffff" opacity="0.99"/>`;';
  const mutated = uiSrc.replace(needle,
    'const tierDisc = (tier === "content")\n          ? `<circle class="pin-tier-disc" cx="18" cy="15" r="8.6" fill="#ffcc00" opacity="0.99"/>`\n          : (tier === "photo")\n            ? `<circle class="pin-tier-disc" cx="18" cy="15" r="8.6" fill="#00ccff" opacity="0.99"/>`\n            : `<circle class="pin-tier-disc" cx="18" cy="15" r="8.6" fill="#ffffff" opacity="0.99"/>`;');
  if (mutated === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const fixture = FIXTURE();
    const ui = runUI(seriesSrc, mutated, fixture).pins;
    // headFillAttr 은 photo/content 모두 등록 상태(url)라 채움구조 동일 → discTag(형태)까지 같아지면
    // shapeSig 가 photo/content 를 구분 못 함(색만 다르므로 색 제거 시 붕괴)
    const sigs = [shapeSig(ui.photo1), shapeSig(ui.content1), shapeSig(ui.empty1)];
    ok(new Set(sigs).size < 3,
      `뮤테이션 적용 시 색만 다르고 형태(태그)는 같아져 색 제거 서명이 붕괴(③ 실효성 증명) → ${sigs.join(", ")}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 ⓒ: 핀 확대(37→50px) → ⑦이 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션ⓒ] 핀 확대(height 37→50px) → ⑦이 실패해야 함");
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
