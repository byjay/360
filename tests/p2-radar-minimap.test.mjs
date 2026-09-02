/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p2-radar-minimap.test.mjs)
 *
 * 마스터 지시 "기본적으로 확대한 크기로 반영해":
 *  ① localStorage("wm-radar-large")에 저장값이 없으면 미니맵 기본 상태 = 확대(large).
 *  ② 저장값이 "0"(축소)이면 그 선택이 유지된다.
 *  ③ 미니맵 점에 도면 핀 마커와 같은 번호(pageIdx / checkboard=label)가 표시된다.
 *
 * 실제 모듈 소스(public/js/modules/07_Radar.js)를 그대로 vm에 평가해 검사한다(목 구현 아님).
 * 각 검사에는 뮤테이션(수정 무력화) 케이스가 붙어 있어, 고친 코드를 되돌리면 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const radarSrc = fs.readFileSync(path.join(ROOT, "public/js/modules/07_Radar.js"), "utf8");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 최소 DOM 목(mock) ─────────────────────────────────────── */
function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle(c, force) {
      if (force === undefined) {
        if (set.has(c)) { set.delete(c); return false; }
        set.add(c); return true;
      }
      if (force) set.add(c); else set.delete(c);
      return force;
    },
    contains: (c) => set.has(c),
    _set: set
  };
}
function makeEl() {
  const el = {
    style: {}, dataset: {}, title: "", _text: "", _html: "", _children: [], _handlers: {},
    appendChild(c) { this._children.push(c); },
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    click() { (this._handlers.click || []).forEach((fn) => fn({ stopPropagation() {}, preventDefault() {} })); },
    querySelector() { return makeEl(); }
  };
  // 실제 DOM 의 textContent 는 대입값을 문자열로 강제 변환한다(el.textContent = 1 → "1").
  // 스텁이 원시값을 그대로 보관하면 코드가 정상인데도 문자열 비교가 어긋난다 → 실제 DOM 과 동일하게 강제 변환.
  Object.defineProperty(el, "textContent", { get() { return this._text; }, set(v) { this._text = v == null ? "" : String(v); } });
  Object.defineProperty(el, "innerHTML", { get() { return this._html; }, set(v) { this._html = v; if (v === "") this._children = []; } });
  Object.defineProperty(el, "className", {
    get() { return Array.from(this.classList._set).join(" "); },
    set(v) { this.classList = makeClassList(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c)); }
  });
  el.classList = makeClassList();
  return el;
}
function makeLocalStorage(initial) {
  const store = Object.assign({}, initial);
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    _store: store
  };
}

/** Radar 모듈을 새 VM 컨텍스트에 평가하고 update(pin)까지 실행한 뒤 결과를 돌려준다. */
function runRadar(src, { lsInitial = {}, pins, currentPin }) {
  const registry = {};
  const el = (id) => (registry[id] = registry[id] || makeEl());
  const document = {
    getElementById: (id) => el(id),
    createElement: () => makeEl()
  };
  const State = { pins, pdfPage: 1, mode: "viewer", viewerPages: ["deck1-p1.jpg"] };
  const localStorage = makeLocalStorage(lsInitial);
  const sandbox = { console, document, State, localStorage };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__R = Radar;", sandbox);
  const R = sandbox.__R;
  R.update(currentPin);
  return { R, registry };
}

/* ────────────────────────────────────────────────────────────
 * ① 저장값 없음 → 기본 확대(large)
 * ──────────────────────────────────────────────────────────── */
function suiteDefaultLarge(label, src) {
  console.log("\n[" + label + "]");
  const pins = [{ id: "a", page: 1, x: 10, y: 10 }];
  const { registry } = runRadar(src, { lsInitial: {}, pins, currentPin: pins[0] });
  const box = registry["pano-radar"];
  const eb = registry["pano-radar-expand"];
  ok(box.classList.contains("pano-radar-large") === true, "저장값 없음 → box에 pano-radar-large 켜짐");
  ok(eb.classList.contains("active") === true, "저장값 없음 → 확대버튼 active");
  ok(eb.title === "미니맵 작게 보기", "저장값 없음 → 버튼 title=축소 유도문구");
}

/* ────────────────────────────────────────────────────────────
 * ② 저장값 "0"(축소) → 축소 유지
 * ──────────────────────────────────────────────────────────── */
function suiteStoredSmall(label, src) {
  console.log("\n[" + label + "]");
  const pins = [{ id: "a", page: 1, x: 10, y: 10 }];
  const { registry } = runRadar(src, { lsInitial: { "wm-radar-large": "0" }, pins, currentPin: pins[0] });
  const box = registry["pano-radar"];
  const eb = registry["pano-radar-expand"];
  ok(box.classList.contains("pano-radar-large") === false, "저장값 0 → box에 pano-radar-large 꺼짐(축소 유지)");
  ok(eb.classList.contains("active") === false, "저장값 0 → 확대버튼 비활성");
  ok(eb.title === "미니맵 크게 보기", "저장값 0 → 버튼 title=확대 유도문구");
}

/* ────────────────────────────────────────────────────────────
 * ③ 점 번호 = 도면 핀 마커와 같은 번호 체계 (일반=pageIdx, checkboard=label)
 * ──────────────────────────────────────────────────────────── */
function suitePinNumbers(label, src) {
  console.log("\n[" + label + "]");
  const pins = [
    { id: "a", page: 1, x: 10, y: 10 },                                   // pageIdx1 → "1"
    { id: "b", page: 1, x: 20, y: 20, checkboard: true, label: "77" },    // pageIdx2, checkboard label → "77"
    { id: "c", page: 2, x: 5, y: 5 },                                     // 다른 페이지 → 제외
    { id: "d", page: 1, x: 30, y: 30 }                                    // pageIdx3 → "3"
  ];
  const { registry } = runRadar(src, { lsInitial: {}, pins, currentPin: pins[0] });
  const dots = registry["pano-radar-pins"]._children;
  ok(dots.length === 3, `현재 페이지 핀 점 개수 = ${dots.length} (기대 3)`);
  const nums = dots.map((d) => d._children[0] && d._children[0]._text);
  ok(nums[0] === "1", `일반 핀 a 번호 = ${nums[0]} (기대 1)`);
  ok(nums[1] === "77", `체크보드 핀 b 번호 = ${nums[1]} (기대 77, label 우선)`);
  ok(nums[2] === "3", `일반 핀 d 번호 = ${nums[2]} (기대 3)`);
}

/* ────────────────────────────────────────────────────────────
 * 실행: 정상 소스
 * ──────────────────────────────────────────────────────────── */
suiteDefaultLarge("① 기본값=확대 (정상 소스)", radarSrc);
suiteStoredSmall("② 저장값 축소 유지 (정상 소스)", radarSrc);
suitePinNumbers("③ 점 번호 표시 (정상 소스)", radarSrc);

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 증명: 기본값 로직을 되돌리면 ①이 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션] storedLarge 기본값을 true→false로 되돌리면 ①이 실패해야 함");
  const mutated = radarSrc.replace("let storedLarge = true;", "let storedLarge = false;");
  if (mutated === radarSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const pins = [{ id: "a", page: 1, x: 10, y: 10 }];
    const { registry } = runRadar(mutated, { lsInitial: {}, pins, currentPin: pins[0] });
    const brokenPasses = registry["pano-radar"].classList.contains("pano-radar-large") === true;
    ok(brokenPasses === false, "뮤테이션 적용 시 기본값=확대 검증이 실패로 뒤집힘(테스트가 실효성 있음을 증명)");
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 증명: checkboard 번호 오버라이드를 제거하면 ③이 실패해야 한다
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션] checkboard 번호 오버라이드 제거하면 ③이 실패해야 함");
  const needle = 'let dispNo = radarIdx;\n          if (p.checkboard) {\n            const lblNum = parseInt(p.label, 10);\n            if (Number.isFinite(lblNum)) dispNo = lblNum;\n          }';
  const mutated = radarSrc.replace(needle, "let dispNo = radarIdx;");
  if (mutated === radarSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const pins = [
      { id: "a", page: 1, x: 10, y: 10 },
      { id: "b", page: 1, x: 20, y: 20, checkboard: true, label: "77" }
    ];
    const { registry } = runRadar(mutated, { lsInitial: {}, pins, currentPin: pins[0] });
    const dots = registry["pano-radar-pins"]._children;
    const numB = dots[1]._children[0]._text;
    ok(numB !== "77", "뮤테이션 적용 시 checkboard 번호가 77이 아니게 뒤집힘(테스트가 실효성 있음을 증명) → 실제값=" + numB);
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
