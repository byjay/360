/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p13-setdir-flow.test.mjs)
 *
 * 결함: #btn-pano-setdir 가 클릭 즉시 "현재 보는 방향 = 오른쪽"으로 지정을 완료 선언했다
 * (사용자가 도면을 클릭하기도 전에 "지정되었습니다" 토스트가 뜸 — 조기 완료 선언 / 거짓 완료).
 * 마스터 요구: 도면(미니맵)에서 선수(오른쪽) 방향을 직접 클릭해야 지정이 확정된다.
 *
 * 수정: #btn-pano-setdir 는 기존 #pano-radar-dir 과 같은 "방향 지정 모드"(Radar._dirAdjust)로
 * 진입만 시킨다(Radar.enterDirAdjustMode). 실제 지정·완료 토스트는 사용자가 미니맵을 클릭해
 * Radar._commitAngle() 이 실행될 때만 발생한다.
 *
 * 검사:
 *  ① #btn-pano-setdir 진입점(Radar.enterDirAdjustMode) → 모드 진입(클래스/안내 토스트)
 *  ② 모드 진입만으로는 완료 토스트가 뜨지 않는다
 *  ③ 미니맵 클릭 후에야 방향이 확정되고 완료 토스트가 뜬다
 *  ④ 기존 #pano-radar-dir 토글 경로도 여전히 동작한다(진입/취소)
 *  ⑤ 미니맵이 없는(hidden) 상태에서 진입 시도 시 조용히 실패하지 않고 사유를 안내한다
 *  ⑥ [정적] 20_App.js 의 btn-pano-setdir 핸들러가 실제로 Radar.enterDirAdjustMode 를 호출하고,
 *     예전의 조기 완료 로직(하드코딩 lon-90 즉시지정 + 완료 토스트)이 남아있지 않다
 *
 * 실제 모듈 소스(07_Radar.js, 20_App.js)를 vm에 그대로 평가/검사한다(목 구현 아님).
 * 뮤테이션 2건 이상으로 테스트 실효성을 증명한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const radarSrc = fs.readFileSync(path.join(ROOT, "public/js/modules/07_Radar.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "public/js/modules/20_App.js"), "utf8");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 최소 DOM 목(mock) — 기존 p2/p3/p4/p9/p10/p12 테스트와 동일 패턴 재사용 ── */
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
    click(evt) { (this._handlers.click || []).forEach((fn) => fn(evt || { stopPropagation() {}, preventDefault() {} })); },
    querySelector() { return makeEl(); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
  };
  Object.defineProperty(el, "textContent", { get() { return this._text; }, set(v) { this._text = v == null ? "" : String(v); } });
  Object.defineProperty(el, "innerHTML", { get() { return this._html; }, set(v) { this._html = v; if (v === "") this._children = []; } });
  Object.defineProperty(el, "className", {
    get() { return Array.from(this.classList._set).join(" "); },
    set(v) { this.classList = makeClassList(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c)); }
  });
  el.classList = makeClassList();
  return el;
}

/** Radar 모듈을 새 VM 컨텍스트에 평가한다. */
function setup(src) {
  const registry = {};
  const el = (id) => (registry[id] = registry[id] || makeEl());
  ["pano-radar", "pano-radar-stage", "pano-radar-dir", "pano-radar-cone"].forEach(el);
  const fan = makeEl();
  const document = {
    getElementById: (id) => el(id),
    createElement: () => makeEl(),
    querySelector: (sel) => (sel === "#pano-radar-cone .pano-radar-fan" ? fan : makeEl())
  };
  const toasts = [];
  const Prompt = { toast: (msg) => toasts.push(msg) };
  const App = { _autoSave: () => {} };
  const sandbox = { console, document, Prompt, App };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__R = Radar;", sandbox);
  return { R: sandbox.__R, registry, toasts, fan };
}

const pin = { id: "a", page: 1, x: 10, y: 10 };
const State = { pins: [pin], pdfPage: 1, mode: "viewer", viewerPages: ["deck1-p1.jpg"] };

/* ────────────────────────────────────────────────────────────
 * ①~④ : 핀을 연 상태(미니맵 표시됨)에서의 정상 흐름
 * ──────────────────────────────────────────────────────────── */
function suiteOpenedFlow(label, src) {
  console.log("\n[" + label + "]");
  const { R, registry, toasts } = setup(src);
  // Radar.update()를 흉내: box를 "표시됨" 상태로 두고 dir 바인딩을 태운다.
  // (실제 update()는 document.querySelector("#pdf-canvas") 등 추가 DOM을 요구하므로
  //  이 테스트는 enterDirAdjustMode/exitDirAdjustMode/_bindDirClick 자체의 계약만 검사한다)
  const box = registry["pano-radar"];
  box.className = "pano-radar"; // 표시됨(= hidden 없음)
  R._pin = pin;
  const stage = registry["pano-radar-stage"];
  const db = registry["pano-radar-dir"];
  R._bindDirClick(stage, db, box);
  // update() 내부의 db 클릭 바인딩(토글 → enterDirAdjustMode/exitDirAdjustMode 위임)을 그대로 재현.
  // (update() 전체를 태우려면 pdf-canvas/PinSeries 등 무관한 DOM이 대거 필요해 이 계약만 발췌 검증)
  db.addEventListener("click", () => { if (R._dirAdjust) R.exitDirAdjustMode(); else R.enterDirAdjustMode(); });

  // ① btn-pano-setdir 대체 진입점(App이 위임 호출하는 실제 API) → 모드 진입
  const entered = R.enterDirAdjustMode();
  ok(entered === true, "① enterDirAdjustMode() 반환값 true(진입 성공)");
  ok(box.classList.contains("dir-adjust-mode") === true, "① box에 dir-adjust-mode 클래스(커서 crosshair CSS 트리거)");
  ok(toasts.some(t => t.indexOf("클릭") >= 0 && t.indexOf("선수") >= 0), "① 안내 토스트 = 무엇을 해야 하는지 알려줌: " + JSON.stringify(toasts));

  // ② 진입만으로는 완료 토스트가 없다
  ok(!toasts.some(t => t.indexOf("지정되었습니다") >= 0 || t.indexOf("조정되었습니다") >= 0), "② 모드 진입 시점엔 완료 토스트 없음(아직 클릭 안 함): " + JSON.stringify(toasts));

  // ③ 미니맵(스테이지) 클릭 후에야 확정
  stage.click({ clientX: 150, clientY: 50, preventDefault() {}, stopPropagation() {} }); // rect(0,0,100,100) 중심(50,50) 기준 우측 → 90deg
  ok(pin.dirOffset === -90, "③ 클릭 후 pin.dirOffset 확정(lon 0 - angle 90 = -90), 실제=" + pin.dirOffset);
  ok(toasts.some(t => t.indexOf("조정되었습니다") >= 0), "③ 클릭 확정 후에만 완료 토스트: " + JSON.stringify(toasts));
  ok(box.classList.contains("dir-adjust-mode") === false, "③ 확정 후 모드 자동 종료(dir-adjust-mode 해제)");

  // ④ 기존 #pano-radar-dir 토글 경로 — 진입/취소 둘 다 동작
  db.click(); // 진입
  ok(R._dirAdjust === true, "④ #pano-radar-dir 클릭 → 모드 진입");
  ok(db.classList.contains("active") === true, "④ #pano-radar-dir active 클래스 켜짐");
  db.click(); // 취소(클릭 없이 끄기)
  ok(R._dirAdjust === false, "④ #pano-radar-dir 재클릭 → 모드 취소(진입만 하고 지정은 안 됨)");
  ok(db.classList.contains("active") === false, "④ #pano-radar-dir active 클래스 꺼짐");
}

/* ────────────────────────────────────────────────────────────
 * ⑤ : 미니맵이 아직 표시되지 않은(hidden) 상태 — 조용한 실패 금지
 * ──────────────────────────────────────────────────────────── */
function suiteHiddenGuard(label, src) {
  console.log("\n[" + label + "]");
  const { R, registry, toasts } = setup(src);
  const box = registry["pano-radar"];
  box.className = "pano-radar hidden"; // 핀을 아직 안 열어서 미니맵이 숨겨진 초기 상태
  const entered = R.enterDirAdjustMode();
  ok(entered === false, "⑤ 미니맵 hidden 상태 → enterDirAdjustMode() false(모드 진입 안 함)");
  ok(box.classList.contains("dir-adjust-mode") === false, "⑤ dir-adjust-mode 클래스 안 붙음(클릭할 대상 없음)");
  ok(toasts.length > 0, "⑤ 조용히 실패하지 않고 사유를 안내함: " + JSON.stringify(toasts));
}

/* ────────────────────────────────────────────────────────────
 * ⑥ [정적] 20_App.js 의 btn-pano-setdir 핸들러 검사
 * ──────────────────────────────────────────────────────────── */
function suiteAppWiring(label, src) {
  console.log("\n[" + label + "]");
  const m = src.match(/UI\.\$\("btn-pano-setdir"\}?\)?[\s\S]*?\}\);/) || src.match(/UI\.\$\("btn-pano-setdir"\)[\s\S]*?\}\);/);
  ok(!!m, "⑥ btn-pano-setdir 핸들러 블록을 소스에서 찾음");
  if (m) {
    const block = m[0];
    ok(block.indexOf("Radar.enterDirAdjustMode") >= 0, "⑥ 핸들러가 Radar.enterDirAdjustMode 를 호출함");
    ok(block.indexOf("오른쪽 방향이 지정되었습니다") === -1, "⑥ 예전 조기완료 토스트 문구가 핸들러에서 제거됨");
    ok(block.indexOf("S.lon - 90") === -1, "⑥ 예전 하드코딩 즉시지정(lon-90) 로직이 핸들러에서 제거됨");
  }
}

/* ────────────────────────────────────────────────────────────
 * ⑦ [정적] update() 내부 db(#pano-radar-dir) 클릭 바인딩이 실제로
 *    enterDirAdjustMode/exitDirAdjustMode 를 호출하는지 (④의 동적 재현이 실제 소스와 일치함을 보증)
 * ──────────────────────────────────────────────────────────── */
function suiteRadarDbWiring(label, src) {
  console.log("\n[" + label + "]");
  const m = src.match(/db\.addEventListener\("click",[\s\S]*?\}\);/);
  ok(!!m, "⑦ #pano-radar-dir 클릭 바인딩 블록을 소스에서 찾음");
  if (m) {
    const block = m[0];
    ok(block.indexOf("this.exitDirAdjustMode()") >= 0, "⑦ 켜져있으면 exitDirAdjustMode 호출");
    ok(block.indexOf("this.enterDirAdjustMode()") >= 0, "⑦ 꺼져있으면 enterDirAdjustMode 호출(#btn-pano-setdir 과 동일 진입점 공유)");
  }
}

suiteOpenedFlow("①~④ 정상 흐름 (정상 소스)", radarSrc);
suiteHiddenGuard("⑤ 미니맵 숨김 가드 (정상 소스)", radarSrc);
suiteAppWiring("⑥ App 배선 정적 검사 (정상 소스)", appSrc);
suiteRadarDbWiring("⑦ Radar db 배선 정적 검사 (정상 소스)", radarSrc);

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 1: enterDirAdjustMode 의 모드진입 클래스 부여를 제거하면 ①이 실패해야 함
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션1] box.classList.add(\"dir-adjust-mode\") 제거 → ①이 실패해야 함");
  const needle = 'box.classList.add("dir-adjust-mode");';
  const mutated = radarSrc.replace(needle, "/* removed */");
  if (mutated === radarSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { R, registry } = setup(mutated);
    const box = registry["pano-radar"];
    box.className = "pano-radar";
    R._pin = pin;
    R.enterDirAdjustMode();
    const brokenPasses = box.classList.contains("dir-adjust-mode") === true;
    ok(brokenPasses === false, "뮤테이션 적용 시 ① 검증이 실패로 뒤집힘(테스트가 실효성 있음을 증명)");
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 2: 진입 안내 토스트를 완료 문구로 바꾸면 ②가 실패해야 함(조기완료 회귀 재현)
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션2] 진입 안내 토스트를 완료 문구로 바꾸면 ②가 실패해야 함(조기완료 회귀 재현)");
  const needle = 'Prompt.toast("도면에서 선수(오른쪽) 방향을 클릭하세요");';
  const replacement = 'Prompt.toast("시야 방향이 조정되었습니다");';
  const mutated = radarSrc.replace(needle, replacement);
  if (mutated === radarSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { R, registry, toasts } = setup(mutated);
    const box = registry["pano-radar"];
    box.className = "pano-radar";
    R._pin = pin;
    R.enterDirAdjustMode();
    const brokenPasses = !toasts.some(t => t.indexOf("조정되었습니다") >= 0);
    ok(brokenPasses === false, "뮤테이션 적용 시 ② 검증이 실패로 뒤집힘(진입 즉시 완료문구가 다시 뜸 = 조기완료 회귀 재현됨)");
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 3: App 핸들러를 예전 하드코딩 즉시지정으로 되돌리면 ⑥이 실패해야 함
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션3] App 핸들러를 예전 조기완료 로직으로 되돌리면 ⑥이 실패해야 함");
  const needle = 'if (typeof Radar !== "undefined" && Radar.enterDirAdjustMode) Radar.enterDirAdjustMode();';
  const replacement = 'pin.dirOffset = PanoViewer.S.lon - 90; this._autoSave && this._autoSave(); Prompt && Prompt.toast && Prompt.toast("오른쪽 방향이 지정되었습니다");';
  const mutated = appSrc.replace(needle, replacement);
  if (mutated === appSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const m = mutated.match(/UI\.\$\("btn-pano-setdir"\)[\s\S]*?\}\);/);
    const block = m ? m[0] : "";
    const brokenPasses = block.indexOf("Radar.enterDirAdjustMode") >= 0
      && block.indexOf("오른쪽 방향이 지정되었습니다") === -1
      && block.indexOf("S.lon - 90") === -1;
    ok(brokenPasses === false, "뮤테이션 적용 시 ⑥ 검증이 실패로 뒤집힘(조기완료 회귀가 다시 잡힘)");
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
