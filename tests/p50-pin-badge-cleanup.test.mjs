/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p50-pin-badge-cleanup.test.mjs)
 *
 * 마스터 지시(2026-09-18, 2026-09-21 재확인, 스크린샷 첨부):
 *   ① "이렇게 말고 동그라미를 겹친다든가 공 모양이 다르거나 색상 음영이 다르게 해줘.
 *      이게 뭘 품고 있는지 알려"
 *   ② "이런 거추장스런 거 지워" — 핀에 붙은 위성 배지 3종(이슈 카운트·번호중복·작성자 대역)
 *
 * 근본원인: 11_UI.js renderPinsOnMap() 이 핀 마커 SVG 밖에 <span class="pin-marker-issue/
 *   -dup/-author"> 3개를 위성처럼 덧붙여 그렸다 — 핀 하나당 배지 2~3개가 따라붙어 지저분했다.
 *
 * 조치:
 *   1) 위성 배지 3종 제거(마크업+CSS 둘 다). 정보는 버리지 않는다:
 *      - 이슈 카운트 → #pin-list(.pin-issue-badge, 기존부터 있었음) + PinActionPop(pap-meta)
 *      - 번호 중복 경고 → #pin-list(.pin-dup-badge, 기존부터 있었음, designer 모드) + PinActionPop
 *      - 작성자 대역 → PinActionPop(pap-meta, 이번에 신규 이관)
 *   2) 핀 본체(tierDisc)로 photo 를 "겹친 원 2개"로 표현 — 기존엔 photo/empty 가 완전히
 *      같은 단일 원이라 구분이 head fill(채움 여부)에만 의존했다. 이제 photo 만 원이 겹친다.
 *
 * 실제 모듈 소스(01b_PinSeries.js/11_UI.js/27_PinActionPop.js/CSS)를 그대로 vm 에 평가한다.
 * 뮤테이션 3건이 붙어 있어, 고친 부분을 되돌리면 해당 검사가 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const seriesSrc = rd("public/js/modules/01b_PinSeries.js");
const uiSrc     = rd("public/js/modules/11_UI.js");
const papSrc    = rd("public/js/modules/27_PinActionPop.js");
const cssPublic = rd("public/css/style.css");
const cssRoot   = rd("css/style.css");

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
    // [WO 20261002-allmenu §2 회귀 a61fbf5] 실 DOM(Element) API 보강 — #pin-list 맨 위 선택 도구줄(mountBulkBar)이
    //   이제 디자이너 모드 전체에서 그려져 list.insertBefore(bar, list.firstChild) 를 부른다(실 브라우저 Element 는 항상 지원).
    //   assertion 변경 0 — 셸만 브라우저와 같게 맞춘다(G-4⑧ 대조는 커밋 메시지).
    get firstChild() { return this._children[0] || null; },
    insertBefore(n, ref) { const i = this._children.indexOf(ref); if (i >= 0) this._children.splice(i, 0, n); else this._children.push(n); return n; },
    setAttribute(k, v) { this.dataset["attr_" + k] = String(v); },
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    querySelector() { return makeEl(); }, // designer 모드 item.querySelector(".pin-edit"/".pin-del") 용 더미
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

/* 픽스처: 이슈 미해결 1건(c1) + 번호중복 체크보드 2개(bA/bB, 둘 다 label "5") + 작성자 대역(bA author) */
const FIXTURE = () => [
  { id: "c1", page: 1, x: 10, y: 10, imageId: "img1", author: "a@x.com" },
  { id: "bA", page: 1, x: 15, y: 15, checkboard: true, label: "5", imageId: "shot-A", author: "a@x.com" },
  { id: "bB", page: 1, x: 20, y: 20, checkboard: true, label: "5", author: "b@x.com" },
  { id: "e1", page: 1, x: 25, y: 25 }
];
const NotesMock = { openCountFor: (id) => (id === "c1" ? 3 : 0) };

function runUI(sSrc, uSrc, pins, page = 1) {
  const { document, registry } = makeDoc();
  const State = { pins, pdfPage: page, mode: "viewer", activePin: null, zoneView: null, zones: [] };
  const sandbox = { console, document, State, localStorage: makeLocalStorage(), App: AppMock, Notes: NotesMock, JSON, Map, Set };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(sSrc + "\n" + uSrc + "\n;globalThis.__UI = UI; globalThis.__PS = PinSeries;", sandbox);
  sandbox.__UI.renderPinsOnMap();
  const markerHtml = registry["pins-layer"]._children.map((m) => m._html).join("\n");
  return { markerHtml, registry, PS: sandbox.__PS };
}

/** #pin-list(designer 모드) 렌더 → 리스트 HTML 통짜 문자열 */
function runPinList(sSrc, uSrc, pins, page = 1, mode = "designer") {
  const { document, registry } = makeDoc();
  const State = { pins, pdfPage: page, pdfPages: 1, mode, activePin: null, zoneView: null, zones: [] };
  const sandbox = { console, document, State, localStorage: makeLocalStorage(), App: AppMock, Notes: NotesMock, JSON, Map, Set };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(sSrc + "\n" + uSrc + "\n;globalThis.__UI = UI;", sandbox);
  sandbox.__UI.renderPinList();
  const listHtml = registry["pin-list"]._children.map((m) => m._html).join("\n");
  return listHtml;
}

/* ────────────────────────────────────────────────────────────
 * ① 도면 마커 마크업에 위성 배지 3종이 없다
 * ──────────────────────────────────────────────────────────── */
function suiteNoSatelliteBadges(label, sSrc, uSrc) {
  console.log("\n[" + label + "]");
  const { markerHtml } = runUI(sSrc, uSrc, FIXTURE());
  ok(!/pin-marker-issue/.test(markerHtml), "① 도면 마커에 pin-marker-issue 없음");
  ok(!/pin-marker-dup/.test(markerHtml), "① 도면 마커에 pin-marker-dup 없음");
  ok(!/pin-marker-author/.test(markerHtml), "① 도면 마커에 pin-marker-author 없음");
}

/* ────────────────────────────────────────────────────────────
 * ② CSS 규칙 잔재 0 (렌더 고아 금지) — 소스 CSS 2개(public/css, 루트 mirror)
 * ──────────────────────────────────────────────────────────── */
function suiteNoOrphanCss() {
  console.log("\n[CSS 렌더 고아 검사]");
  [["public/css/style.css", cssPublic], ["css/style.css", cssRoot]].forEach(([name, css]) => {
    // 실제 셀렉터 규칙만 본다(같은 줄에서 "{" 를 만나는 경우만) — 주석 속 클래스명 언급은 허용
    const hasRule = (cls) => new RegExp("\\." + cls + "\\b[^\\n{]*\\{").test(css);
    ok(!hasRule("pin-marker-issue"), `② ${name}: .pin-marker-issue 규칙 없음`);
    ok(!hasRule("pin-marker-dup"), `② ${name}: .pin-marker-dup 규칙 없음`);
    ok(!hasRule("pin-marker-author"), `② ${name}: .pin-marker-author 규칙 없음`);
  });
}

/* ────────────────────────────────────────────────────────────
 * ③④ 이슈/중복 정보가 다른 경로(#pin-list · PinActionPop)에서 여전히 보인다
 * ──────────────────────────────────────────────────────────── */
function suiteInfoRelocated(label, sSrc, uSrc) {
  console.log("\n[" + label + "]");
  const listHtml = runPinList(sSrc, uSrc, FIXTURE());
  ok(/pin-issue-badge/.test(listHtml) && />3</.test(listHtml.match(/pin-issue-badge[^>]*>(\d+)</)?.[0] || listHtml),
    "③ #pin-list 에 미해결 이슈 뱃지(3건) 유지");
  ok(/pin-dup-badge/.test(listHtml), "④ #pin-list 에 번호 중복 뱃지 유지(designer 모드)");

  // PinActionPop 소스가 정본 함수(Notes.openCountFor/PinSeries.duplicateCheckboardIds/PinSeries.userMark)를
  // open()에서 실제로 호출해 pap-meta 에 반영하는지 정적 검증(런타임은 DOM/이벤트 의존이 커 소스 단으로 확인)
  ok(/Notes\.openCountFor/.test(papSrc), "③ PinActionPop.open()이 Notes.openCountFor 를 호출(이슈 이관)");
  ok(/PinSeries\.duplicateCheckboardIds/.test(papSrc), "④ PinActionPop.open()이 PinSeries.duplicateCheckboardIds 를 호출(중복 이관)");
  ok(/pin-issue-badge/.test(papSrc) && /pin-dup-badge/.test(papSrc),
    "③④ PinActionPop 이 리스트와 같은 뱃지 클래스를 재사용(SoT, 별도 스타일 중복 없음)");
  ok(/PinSeries\.userMark/.test(papSrc), "작성자 대역 정보도 PinActionPop 으로 이관(정보 유실 0)");
}

/* ────────────────────────────────────────────────────────────
 * ⑤ 핀 본체만으로(색 제거 후에도) photo/content/empty 3상태가 구분된다
 * ──────────────────────────────────────────────────────────── */
function suiteTierShape(label, sSrc, uSrc) {
  console.log("\n[" + label + "]");
  const pins = [
    { id: "photo", page: 1, x: 1, y: 1, imageId: "img" },
    { id: "content", page: 1, x: 2, y: 2, note: "메모" },
    { id: "empty", page: 1, x: 3, y: 3 }
  ];
  const { registry } = runUI(sSrc, uSrc, pins);
  const html = (id) => registry["pins-layer"]._children.find((m) => m.dataset.id === id)._html;
  const discCount = (h) => (h.match(/<circle[^>]*\/>|<rect[^>]*\/>/g) || []).filter((t) => /class="pin-tier-disc"|cx="22\.6"/.test(t) || /class="pin-tier-disc"/.test(t)).length;
  const photoHtml = html("photo"), contentHtml = html("content"), emptyHtml = html("empty");
  const photoCircles = (photoHtml.match(/<circle/g) || []).length;
  const emptyCircles = (emptyHtml.match(/<circle/g) || []).length;
  ok(/class="pin-tier-disc"[^>]*\/>/.test(contentHtml) && /<rect class="pin-tier-disc"/.test(contentHtml),
    "⑤ content = 둥근사각형(rect) 원판");
  ok(/<circle class="pin-tier-disc"/.test(photoHtml), "⑤ photo = 원(circle) 원판(첫 번째)");
  ok(/<circle class="pin-tier-disc"/.test(emptyHtml), "⑤ empty = 원(circle) 원판");
  ok(photoCircles > emptyCircles,
    `⑤ photo 는 겹친 원(circle ${photoCircles}개)이 empty(circle ${emptyCircles}개)보다 많다 — 흑백에서도 구분(마스터 제안 "동그라미를 겹친다")`);
}

/* ────────────────────────────────────────────────────────────
 * ⑥ 핀 크기 불변(.pin-pin 21×37)
 * ──────────────────────────────────────────────────────────── */
function suitePinSize() {
  console.log("\n[핀 크기 불변]");
  [["public/css/style.css", cssPublic], ["css/style.css", cssRoot]].forEach(([name, css]) => {
    const m = css.match(/\.pin-pin\s*\{[^}]*\}/);
    ok(!!m && /width:\s*21px/.test(m[0]) && /height:\s*37px/.test(m[0]), `⑥ ${name}: .pin-pin 21×37 유지`);
  });
}

/* ────────────────────────────────────────────────────────────
 * ⑦ 기존 축 회귀 없음(계열색·필터·아이콘·dash 정본 함수 존재 확인 — 상세 회귀는 p9/p4 담당)
 * ──────────────────────────────────────────────────────────── */
function suiteExistingAxesIntact(label, sSrc, uSrc) {
  console.log("\n[" + label + "]");
  const { markerHtml, registry } = runUI(sSrc, uSrc, FIXTURE());
  const classNames = registry["pins-layer"]._children.map((m) => m.className).join(" ");
  ok(/pin-kind-/.test(classNames), "⑦ 계열(kind) 클래스 훅 유지");
  ok(/pin-filled|pin-hollow/.test(classNames), "⑦ 등록여부(filled/hollow) 클래스 유지");
  ok(/pin-tier-/.test(classNames), "⑦ 콘텐츠 3상태(tier) 클래스 유지");
  ok(/stroke-dasharray/.test(markerHtml), "⑦ 링 dash 형태단서 유지(체크보드 핀 포함 픽스처)");
}

suiteNoSatelliteBadges("① 위성 배지 3종 제거", seriesSrc, uiSrc);
suiteNoOrphanCss();
suiteInfoRelocated("③④ 정보 이관 확인", seriesSrc, uiSrc);
suiteTierShape("⑤ 3상태 형태 구분", seriesSrc, uiSrc);
suitePinSize();
suiteExistingAxesIntact("⑦ 기존 축 회귀 없음", seriesSrc, uiSrc);

/* ════════════════════════════════════════════════════════════
 * 뮤테이션 증명 3건 — 되돌리면 반드시 실패해야 한다
 * ══════════════════════════════════════════════════════════ */

/* 뮤테이션ⓐ: 배지 복원 → ① 실패 */
{
  console.log("\n[뮤테이션ⓐ] pin-marker-issue 배지를 부활 → ①이 실패해야 함");
  const needle = "if (hasContent) marker.classList.add(\"has-content\");";
  const restored = uiSrc.replace(needle,
    'const _issueDot = `<span class="pin-marker-issue">1</span>`; if (hasContent) marker.classList.add("has-content");');
  // 부활한 변수를 실제 마크업에 꽂아 넣어야 검증 의미가 있다 — innerHTML 삽입부에 이어붙인다
  const needle2 = "            </svg>\n          </div>`;";
  const mutated = restored.includes(needle2)
    ? restored.replace(needle2, "            </svg>\n            ${_issueDot}\n          </div>`;")
    : restored;
  if (mutated === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { markerHtml } = runUI(seriesSrc, mutated, FIXTURE());
    ok(/pin-marker-issue/.test(markerHtml), "뮤테이션 적용 시 pin-marker-issue 가 다시 나타남(① 붕괴 증명)");
  }
}

/* 뮤테이션ⓑ: 3상태 구분 제거(모두 단일 원) → ⑤ 실패 */
{
  console.log("\n[뮤테이션ⓑ] tierDisc 를 전부 단일 원으로 통일 → ⑤가 실패해야 함");
  const needle = 'const tierDisc = (tier === "content")\n          ? `<rect class="pin-tier-disc" x="9.8" y="6.8" width="16.4" height="16.4" rx="3" fill="#ffffff" opacity="0.99"/>`\n          : (tier === "photo")\n            ? `<circle class="pin-tier-disc" cx="18" cy="15" r="8.6" fill="#ffffff" opacity="0.99"/><circle cx="22.6" cy="10.4" r="4.2" fill="#ffffff" opacity="0.99" stroke="#1a1a1a" stroke-width="0.8"/>`\n            : `<circle class="pin-tier-disc" cx="18" cy="15" r="8.6" fill="#ffffff" opacity="0.99"/>`;';
  const mutated = uiSrc.replace(needle, 'const tierDisc = `<circle class="pin-tier-disc" cx="18" cy="15" r="8.6" fill="#ffffff" opacity="0.99"/>`;');
  if (mutated === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const pins = [
      { id: "photo", page: 1, x: 1, y: 1, imageId: "img" },
      { id: "content", page: 1, x: 2, y: 2, note: "메모" },
      { id: "empty", page: 1, x: 3, y: 3 }
    ];
    const { registry } = runUI(seriesSrc, mutated, pins);
    const html = (id) => registry["pins-layer"]._children.find((m) => m.dataset.id === id)._html;
    const contentHtml = html("content");
    ok(!/<rect class="pin-tier-disc"/.test(contentHtml),
      "뮤테이션 적용 시 content 도 rect 가 아닌 circle 이 됨 → 3상태 형태 구분 붕괴(⑤ 실패 증명)");
  }
}

/* 뮤테이션ⓒ: 핀 확대 → ⑥ 실패 */
{
  console.log("\n[뮤테이션ⓒ] .pin-pin 을 42×74 로 확대 → ⑥이 실패해야 함");
  const needle = "width: 21px; height: 37px;     /* 바늘형(36x64 비율) — 더 길고 날카롭게 */";
  const mutated = cssPublic.replace(needle, "width: 42px; height: 74px;");
  if (mutated === cssPublic) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const m = mutated.match(/\.pin-pin\s*\{[^}]*\}/);
    ok(!(m && /width:\s*21px/.test(m[0]) && /height:\s*37px/.test(m[0])),
      "뮤테이션 적용 시 핀 크기 21×37 판정이 깨짐(⑥ 실패 증명)");
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
