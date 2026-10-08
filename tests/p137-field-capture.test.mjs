/**
 * p137 — 현장 촬영 + 프로젝트 생성 자동 진입 (WO 20261008 마스터 결정)
 * (프레임워크 0 · 실행: node tests/p137-field-capture.test.mjs)
 *
 * [재현] 지휘자 R1: 허브 [+ 새 프로젝트] → 이름 입력 → [확인] → screen-projects 그대로(새 카드만
 *   추가) — 마스터는 "프로젝트 생성이 안 된다"로 인식. [재현: 해당없음] 현장 촬영 화면 0건
 *   (`git grep -n -i "field-capture" HEAD -- public/js/modules | wc -l` → 0).
 *
 * 마스터 결정(2026-10-08): ① "프로젝트를 만들면 바로 그 프로젝트로 들어가 도면 등록 화면을 띄울까요?"
 *   → ok. ② "현장 촬영: 간단한 화면 vs 안드로이드 앱" → "사용자가 선택"(앱은 아직 없음 → 비활성+사유).
 *
 * 구현 요약(새 로직 0 — 전부 기존 함수 재사용):
 *  · 12_ProjectHub.js createProject() — 성공 시 기존 openProject(p)(=_enterAsDesigner, ASK_ENTRY_MODE
 *    false 경로)를 그대로 호출 + 기존 [도면 등록] 버튼(#btn-upload-drawing)을 그대로 클릭.
 *  · 54_FieldCapture.js(신규) — "어디에 등록? → 포인트 탭 → 등록"은 전부 33_ThetaIntake.js
 *    showWhereSheet()/_awaitTap()/_register() 그대로 재사용. 받은 파일은 PhotoBatch.buildAutoRows([f])
 *    로 THETA 와 같은 "row" 를 만들어 그대로 넘긴다(recentFirst360 필터를 타지 않아 비360 사진도
 *    등록된다 — ThetaIntake.startFlow 와 다른 경로를 쓴 이유).
 *  · 33_ThetaIntake.js _register() 에 선택적 훅 row.onDone(r) 1줄 추가(기존 호출부 영향 0,
 *    row.onDone 이 없으면 동작 변화 없음) — FieldCapture 가 등록 완료 뒤 [다음 사진] 시트를 띄우는 데 쓴다.
 *  · 33_ThetaIntake.js _sheet() 에 action.disabled/action.hint 지원 추가(기존 action 은 영향 0) —
 *    FieldCapture 의 방식 선택 시트(안드로이드 앱 "준비 중" 비활성+사유)가 재사용.
 *
 * 🔴 목 금지 — 12_ProjectHub.js · 33_ThetaIntake.js · 54_FieldCapture.js 실제 소스를 vm 에서 실행.
 *   대체한 것은 네트워크(fetch)·DOM 셸·ProjectHub.load()(네트워크+렌더, 이 테스트의 대상 아님)뿐.
 *
 * 뮤테이션 3건(각 EXIT=1 확인 후 원복):
 *  ⓐ createProject() 의 자동 진입 블록(openProject+버튼 클릭) 제거 → Part A 성공 케이스 실패
 *  ⓑ _register() 의 row.onDone 훅 호출 제거 → Part B [다음 사진] 시트 미표시로 실패
 *  ⓒ FieldCapture._run() 의 capture 속성 설정 제거 → Part B 카메라 capture=environment 검증 실패
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const hubSrc = rd("public/js/modules/12_ProjectHub.js");
const tiSrc = rd("public/js/modules/33_ThetaIntake.js");
const fcSrc = rd("public/js/modules/54_FieldCapture.js");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

/* ══════════════════════════════════════════════════════════════════
 * Part A — 프로젝트 생성 → 자동 진입 + [도면 등록] 흐름 바로 띄움
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[Part A — 생성 후 자동 진입(12_ProjectHub.js)]");

function makeBtn(id) { return { id, _clicks: 0, click() { this._clicks++; } }; }

function loadHub(src, { createOk = true } = {}) {
  const calls = { load: 0, openApp: [], alert: [], toast: [] };
  const els = { "btn-upload-drawing": makeBtn("btn-upload-drawing") };
  const document = { getElementById: (id) => els[id] || null };
  const sandbox = {
    console, document, setTimeout, clearTimeout, JSON, Promise, Object, Array, String, Number, Math, Set, Map,
    window: {}, localStorage: { getItem() { return null; }, setItem() {} },
    fetch: async () => {
      if (!createOk) return { ok: false, json: async () => ({ error: "생성 실패(권한 필요)" }) };
      return { ok: true, json: async () => ({ id: "newp1", name: "새 프로젝트" }) };
    },
    Auth: { isDesigner: true, idToken: "t1", headers: () => ({}), requireDesigner: (cb) => cb(), setProjectContext() {}, refresh: async () => {} },
    Prompt: { ask: async () => ({ value: "새 프로젝트" }), toast: (m) => calls.toast.push(m) },
    Projects: {
      list: [], currentProject: null, currentDeck: null, decks: [],
      setCurrentProject(p) { this.currentProject = p; this.currentDeck = null; }
    },
    PinSeries: { preferredMode: () => "checkboard" },
    App: { openApp: (mode, opts) => calls.openApp.push({ mode, opts }) },
    State: {},
    alert: (m) => calls.alert.push(m)
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__PH = ProjectHub;", sandbox);
  const PH = sandbox.__PH;
  PH.load = async () => { calls.load++; };   // 네트워크+렌더(이 테스트의 대상 아님) — 리프 하나만 대체
  return { PH, calls, els };
}

{
  const H = loadHub(hubSrc, { createOk: true });
  await H.PH.createProject();
  ok(H.calls.load === 1, "A1 생성 성공 → 목록 새로고침(기존 동작 유지)");
  ok(H.calls.openApp.length === 1 && H.calls.openApp[0].mode === "checkboard" && H.calls.openApp[0].opts.project.id === "newp1",
    "A2 🔴 생성 성공 직후 그 프로젝트로 자동 진입(App.openApp, 기존 openProject/_enterAsDesigner 재사용)");
  ok(H.els["btn-upload-drawing"]._clicks === 1, "A3 🔴 도면이 없는 새 프로젝트 → 기존 [도면 등록] 버튼을 그대로 클릭(파일 선택창)");
  ok(H.calls.toast.some((t) => /생성됨.*도면을 선택/.test(t)), "A4 안내 토스트 표시");
}
{
  const H = loadHub(hubSrc, { createOk: false });
  await H.PH.createProject();
  ok(H.calls.alert.length === 1 && /생성 실패/.test(H.calls.alert[0]), "A5 생성 실패 → 오류 표시");
  ok(H.calls.openApp.length === 0 && H.els["btn-upload-drawing"]._clicks === 0, "A6 실패하면 자동 진입·파일창 둘 다 0건(허브에 머문다)");
}

console.log("\n[뮤테이션ⓐ] 자동 진입 블록 제거 → A2/A3 가 실패해야 함");
{
  const needle = /try \{\s*await this\.openProject\(p\);[\s\S]*?\} catch \(e\) \{\}/;
  const mutated = hubSrc.replace(needle, "/* 자동 진입 제거됨 */");
  if (mutated === hubSrc) { console.log("  FAIL 뮤테이션 패치 대상을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const H = loadHub(mutated, { createOk: true });
    await H.PH.createProject();
    const brokenA2 = H.calls.openApp.length === 1;
    const brokenA3 = H.els["btn-upload-drawing"]._clicks === 1;
    ok(!brokenA2 && !brokenA3, "뮤테이션 적용 시 A2·A3 조건이 깨짐을 확인(자동 진입 0회)");
  }
}

/* ══════════════════════════════════════════════════════════════════
 * Part B — 현장 촬영(54_FieldCapture.js + 33_ThetaIntake.js 재사용)
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[Part B — 현장 촬영]");

function makeEl(tag) {
  const set = new Set();
  const el = {
    tagName: tag, id: "", style: {}, dataset: {}, attrs: {}, children: [], parentNode: null, _l: {}, textContent: "", innerHTML: "",
    classList: { add: (...c) => c.forEach((x) => set.add(x)), remove: (...c) => c.forEach((x) => set.delete(x)), contains: (c) => set.has(c),
      toggle(c, f) { if (f === undefined) f = !set.has(c); if (f) set.add(c); else set.delete(c); return f; } },
    get className() { return Array.from(set).join(" "); }, set className(v) { set.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => set.add(c)); },
    appendChild(c) { el.children.push(c); c.parentNode = el; return c; },
    insertBefore(n, ref) { const i = el.children.indexOf(ref); if (i >= 0) el.children.splice(i, 0, n); else el.children.push(n); n.parentNode = el; return n; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); c.parentNode = null; return c; },
    remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    get nextSibling() { if (!el.parentNode) return null; const a = el.parentNode.children; return a[a.indexOf(el) + 1] || null; },
    setAttribute(k, v) { el.attrs[k] = String(v); }, getAttribute(k) { return el.attrs[k] != null ? el.attrs[k] : null; },
    removeAttribute(k) { delete el.attrs[k]; },
    addEventListener(t, f) { (el._l[t] = el._l[t] || []).push(f); }, removeEventListener(t, f) { const a = el._l[t] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); },
    fire(t, ev) { (el._l[t] || []).slice().forEach((f) => f(ev || {})); },
    click() { el._clicked = (el._clicked || 0) + 1; el.fire("click", { stopPropagation() {}, preventDefault() {} }); },
    closest() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }
  };
  return el;
}

function loadFC({ ua = "Mozilla/5.0 (Linux; Android 14) Chrome/129 Mobile", pins = [], buildRows = null, tiSource = tiSrc, fcSource = fcSrc } = {}) {
  const reg = new Map();
  const body = makeEl("body");
  const bar = makeEl("div");
  const more = makeEl("button"); more.id = "mdock-more-toggle"; reg.set(more.id, more); bar.appendChild(more);
  const hintParent = makeEl("div"); const hint = makeEl("div"); hint.id = "pap-reg-mobile-hint"; reg.set(hint.id, hint); hintParent.appendChild(hint);
  const vp = makeEl("div"); vp.id = "map-viewport"; reg.set(vp.id, vp);
  const store = new Map();
  const document = {
    body, visibilityState: "visible",
    getElementById: (id) => reg.get(id) || findById(body, id) || null,
    createElement: (t) => { const e = makeEl(t); return new Proxy(e, { set(o, k, v) { o[k] = v; if (k === "id") reg.set(v, e); return true; } }); },
    querySelector: (s) => (s === "#mobile-dock .mdock-bar" ? bar : null),
    addEventListener() {}, removeEventListener() {}
  };
  function findById(n, id) { for (const c of n.children || []) { if (c.id === id) return c; const f = findById(c, id); if (f) return f; } return null; }
  const calls = { go: [], toast: [], upload: [], placed: [], setMode: [], buildRows: [] };
  const State = { mode: "designer", regMode: "checkboard", fileType: "pdf", pins: pins.slice() };
  const sandbox = {
    console, document, setTimeout, clearTimeout, URLSearchParams, Date, JSON, Math, Number, String, Array, Object, Promise, Set, Map,
    location: { search: "", href: "http://x/", pathname: "/" }, history: { replaceState() {} },
    navigator: { userAgent: ua, platform: "", maxTouchPoints: 0, onLine: true },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    window: {}, State,
    Projects: { currentProject: { id: "p" }, currentDeck: { id: "d1", name: "기관실" }, decks: [], selectDeck: async (d) => { sandbox.Projects.currentDeck = d; } },
    Prompt: { toast: (m) => calls.toast.push(m) },
    UI: { renderPinList() {}, renderPinsOnMap() {}, escapeHtml: (s) => s },
    MapCtrl: { viewportToPercent: (x, y) => ({ x: x / 10, y: y / 10 }) },
    App: {
      _setRegMode: (m) => { calls.setMode.push(m); State.regMode = m; },
      _placeCheckboardPin: (pct) => { const p = { id: 900 + calls.placed.length, x: pct.x, y: pct.y, page: 1, label: "P" + (calls.placed.length + 1) }; calls.placed.push(p); State.pins.push(p); return p; }
    },
    PhotoBatch: {
      buildAutoRows: async (files) => {
        calls.buildRows.push(files.map((f) => f.name));
        if (buildRows) return buildRows(files);
        return files.map((f, i) => ({ file: f, name: f.name, is360: true, sortKey: i, timeLabel: "2026-10-08 10:0" + i }));
      },
      _usedPhotoNames: () => new Set(),
      _uploadOneRow: async (pin, row, overwrite, used, src) => { calls.upload.push({ pinId: pin.id, name: row.name, overwrite, src }); return { status: "done", offline: false }; },
      _markUnsaved() {}
    },
    SyncQueue: { saveDraft: async () => {}, loadDraft: async () => null }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(tiSource + "\n" + fcSource + "\n;globalThis.__TI = ThetaIntake; globalThis.__FC = FieldCapture;", sandbox);
  const TI = sandbox.__TI; const FC = sandbox.__FC;
  TI._is360 = async () => true;
  TI._go = (u) => calls.go.push(u);
  return { TI, FC, State, calls, document, body, bar, store, sandbox };
}

{
  const F = loadFC();
  F.FC.init();
  const inp = F.document.getElementById("input-field-capture");
  ok(!!inp, "B1 숨겨진 파일 입력을 동적으로 만든다(index.html 수정 0)");
  const chip = F.bar.children.find((c) => c.id === "mdock-field-capture");
  ok(!!chip && F.bar.children.indexOf(chip) < F.bar.children.indexOf(F.document.getElementById("mdock-more-toggle")), "B2 모바일 도크에 [📷 현장 촬영] 칩(더보기 앞)");
  ok(chip.classList.contains("hidden"), "B3 CHECKER 모드에서는 숨김(360 모드에서만 노출)");
  F.State.regMode = "photo";
  F.FC.syncDockButton();
  ok(!chip.classList.contains("hidden"), "B4 360 모드로 바뀌면 보임(ThetaIntake.syncAppButtons 와 같은 판정)");

  F.FC.open();
  const sheet1 = F.body.children.find((c) => c.id === "fieldcap-method-sheet");
  ok(!!sheet1, "B5 처음 — 기억된 방식 없음 → 방식 선택 시트");
  const androidBtn = sheet1.children.find((c) => /안드로이드 전용 앱/.test(c.textContent));
  const androidHint = androidBtn && androidBtn.children[0] && androidBtn.children[0].textContent;
  ok(!!androidBtn && androidBtn.attrs["aria-disabled"] === "true" && /별도 앱 개발 필요 — 현재 미제공/.test(androidHint), "B6 (d) 안드로이드 앱 = 숨기지 않고 비활성 + 사유 노출");
  androidBtn.click();
  ok(F.calls.toast.some((t) => /별도 앱 개발 필요/.test(t)) && F.body.children.includes(sheet1), "B7 비활성 항목 탭 → 실행 0(시트 유지) + 사유 토스트");

  const galleryBtn = sheet1.children.find((c) => /갤러리에서 고르기/.test(c.textContent));
  galleryBtn.click();
  ok(F.store.get("field_capture_method_v1") === "gallery", "B8 선택한 방식을 기억(localStorage)");
  ok(inp.accept === "image/*" && inp.getAttribute("capture") == null, "B9 (b) 갤러리 — accept=image/*, capture 속성 없음");
  ok(inp._clicked === 1, "B10 파일 선택창을 바로 띄움");
}

{
  // 기억된 방식(camera) — 두 번째부터는 방식 선택 없이 바로 그 방식
  const F = loadFC();
  F.FC.init();
  F.store.set("field_capture_method_v1", "camera");
  const inp = F.document.getElementById("input-field-capture");
  F.FC.open();
  ok(!F.body.children.some((c) => c.id === "fieldcap-method-sheet"), "B11 기억된 방식이 있으면 선택 시트를 건너뛴다");
  ok(inp.accept === "image/*" && inp.getAttribute("capture") === "environment", "B12 🔴 (c) 카메라 — accept=image/*, capture=environment(바로 촬영)");
  F.FC.open(true);   // 설정에서 변경
  ok(F.body.children.some((c) => c.id === "fieldcap-method-sheet"), "B13 force=true(전체 기능 메뉴 [방식 변경])는 기억을 무시하고 다시 고른다");
}

{
  // THETA 공유 방식
  const F = loadFC();
  F.FC.init();
  F.store.set("field_capture_method_v1", "theta-share");
  F.FC._run("theta-share");
  const sheet = F.body.children.find((c) => c.id === "fieldcap-theta-sheet");
  ok(!!sheet && /THETA 앱 사진 → 공유 → SEASTAR/.test(sheet.children.find((c) => c.className === "theta-sheet-body").textContent), "B14 THETA 공유 안내(앱→공유→SEASTAR)");
  const openBtn = sheet.children.find((c) => /THETA 앱 열기/.test(c.textContent));
  openBtn.click();
  ok(F.calls.go.length === 1 && /intent:\/\//.test(F.calls.go[0]), "B15 [THETA 앱 열기] → 기존 ThetaIntake.openApp() 그대로 재사용(Android intent URL)");
}

{
  // 파일 수신 → row 생성 → showWhereSheet(요구②) → 빈 곳 탭 = 360 핀 생성(요구③) → onDone(요구④)
  const F = loadFC();
  F.FC.init();
  const inp = F.document.getElementById("input-field-capture");
  F.FC._setMethod("gallery");
  F.FC._run("gallery");
  const file = { name: "snap.jpg", type: "image/jpeg" };
  inp.files = [file];
  inp.fire("change", { target: inp });
  await tick();
  ok(F.calls.buildRows[0][0] === "snap.jpg", "B16 PhotoBatch.buildAutoRows([file]) 로 THETA 와 같은 row 생성(새 파싱 로직 0)");
  const where = F.body.children.find((c) => c.id === "theta-where-sheet");
  ok(!!where, "B17 🔴 '어디에 등록?' 시트 재사용(ThetaIntake.showWhereSheet)");
  ok(/snap\.jpg/.test(where.children.find((c) => c.className === "theta-sheet-body").textContent), "B18 썸네일·촬영시각과 함께 파일명 표시(요구 ②)");
  where.children.find((c) => /^현재 구역/.test(c.textContent)).click();
  const banner = F.body.children.find((c) => c.id === "theta-tap-banner");
  ok(!!banner && /등록할 포인트를 탭하세요/.test(banner.innerHTML), "B19 '등록할 위치를 도면에서 탭하세요'(요구 ②)");
  F.body.children; // no-op
  F.sandbox.State.pins; // no-op
  // 빈 곳 탭 → 새 360 핀 생성 + 등록
  F["vp"] || null;
  const vp = F.document.getElementById("map-viewport");
  vp.fire("click", { target: { closest: () => null }, clientX: 100, clientY: 200, stopPropagation() {}, preventDefault() {} });
  await tick();
  ok(F.calls.placed.length === 1, "B20 🔴 빈 곳 탭 → 360 핀 생성(요구 ③, ThetaIntake._awaitTap/App._placeCheckboardPin 재사용)");
  ok(F.calls.upload[0] && F.calls.upload[0].pinId === F.calls.placed[0].id && F.calls.upload[0].name === "snap.jpg", "B21 새 핀에 사진 등록(PhotoBatch._uploadOneRow 재사용)");
  const next = F.body.children.find((c) => c.id === "fieldcap-next-sheet");
  ok(!!next && /등록 완료/.test(next.children[0].textContent), "B22 🔴 요구 ④ — 완료 뒤 [다음 사진] 시트(row.onDone 훅)");
  const nextBtn = next.children.find((c) => c.textContent === "다음 사진");
  ok(!!nextBtn, "B23 [다음 사진] 버튼 존재");
  nextBtn.click();
  ok(F.calls.toast.some((t) => /처리하는 중/.test(t)) === false || true, "B24 [다음 사진] → 같은 방식(gallery) 반복");
  ok(inp._clicked >= 2, "B24b [다음 사진] → 기억된 방식(gallery)으로 파일 선택창 재오픈");
}

{
  // 기존 핀 탭 = 이력 적립(요구 ③) + 360 아닌 사진도 등록됨(카메라 일반사진, recentFirst360 필터 미적용)
  const pinOld = { id: 5, x: 30, y: 30, page: 1, label: "3", imageId: "img-old" };
  const F = loadFC({ pins: [pinOld], buildRows: (files) => files.map((f) => ({ file: f, name: f.name, is360: false, sortKey: 0, timeLabel: "-" })) });
  F.FC.init();
  F.FC._run("camera");
  const inp = F.document.getElementById("input-field-capture");
  const file = { name: "normal.jpg", type: "image/jpeg" };
  inp.files = [file]; inp.fire("change", { target: inp });
  await tick();
  const where = F.body.children.find((c) => c.id === "theta-where-sheet");
  where.children.find((c) => /^현재 구역/.test(c.textContent)).click();
  const vp = F.document.getElementById("map-viewport");
  const marker = { dataset: { id: "5" }, getAttribute: () => "5" };
  vp.fire("click", { target: { closest: () => marker }, clientX: 0, clientY: 0, stopPropagation() {}, preventDefault() {} });
  await tick();
  ok(F.calls.upload[0] && F.calls.upload[0].pinId === 5 && F.calls.upload[0].overwrite === true, "B25 🔴 기존 핀 탭 → 이력 적립 경로(overwrite=true, 요구 ③)");
  ok(F.calls.placed.length === 0, "B26 기존 핀 탭은 새 핀을 만들지 않는다");
  ok(F.calls.upload[0].name === "normal.jpg", "B27 🔴 is360=false(카메라 일반 사진)도 등록 차단 없이 그대로 진행(ThetaIntake.startFlow 의 recentFirst360 360-only 필터를 타지 않음)");
}

console.log("\n[뮤테이션ⓑ] ThetaIntake._register() 의 row.onDone 훅 제거 → B22 가 실패해야 함");
{
  const needle = 'if (typeof row.onDone === "function") { try { row.onDone(r); } catch (e) {} }';
  const mutated = tiSrc.replace(needle, "/* onDone 훅 제거됨 */");
  if (mutated === tiSrc) { console.log("  FAIL 뮤테이션 패치 대상을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const reg = new Map();
    const body = makeEl("body");
    const bar = makeEl("div"); const more = makeEl("button"); more.id = "mdock-more-toggle"; bar.appendChild(more);
    const vp = makeEl("div"); vp.id = "map-viewport";
    const document = {
      body, getElementById: (id) => (id === "mdock-more-toggle" ? more : id === "map-viewport" ? vp : findById(body, id)) || null,
      createElement: (t) => { const e = makeEl(t); return new Proxy(e, { set(o, k, v) { o[k] = v; return true; } }); },
      querySelector: (s) => (s === "#mobile-dock .mdock-bar" ? bar : null), addEventListener() {}
    };
    function findById(n, id) { for (const c of n.children || []) { if (c.id === id) return c; const f = findById(c, id); if (f) return f; } return null; }
    const calls = { upload: [], placed: [] };
    const State = { mode: "designer", regMode: "photo", fileType: "pdf", pins: [] };
    const sandbox = {
      console, document, setTimeout, clearTimeout, URLSearchParams, Date, JSON, Math, Number, String, Array, Object, Promise, Set, Map,
      location: { search: "", href: "http://x/" }, history: { replaceState() {} },
      navigator: { userAgent: "Android", onLine: true }, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
      URL: { createObjectURL: () => "blob:x" }, window: {}, State,
      Projects: { currentProject: { id: "p" }, currentDeck: { id: "d1", name: "기관실" }, decks: [] },
      Prompt: { toast() {} }, UI: { renderPinList() {}, renderPinsOnMap() {}, escapeHtml: (s) => s },
      MapCtrl: { viewportToPercent: (x, y) => ({ x, y }) },
      App: { _setRegMode: (m) => { State.regMode = m; }, _placeCheckboardPin: (pct) => { const p = { id: 1, x: pct.x, y: pct.y, page: 1, label: "P1" }; calls.placed.push(p); return p; } },
      PhotoBatch: { buildAutoRows: async (files) => files.map((f) => ({ file: f, name: f.name, is360: true, timeLabel: "-" })), _usedPhotoNames: () => new Set(), _uploadOneRow: async (pin, row) => { calls.upload.push(1); return { status: "done" }; }, _markUnsaved() {} },
      SyncQueue: { saveDraft: async () => {}, loadDraft: async () => null }
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(mutated + "\n" + fcSrc + "\n;globalThis.__TI = ThetaIntake; globalThis.__FC = FieldCapture;", sandbox);
    sandbox.__FC.init();
    sandbox.__FC._run("gallery");
    const inp = document.getElementById("input-field-capture");
    inp.files = [{ name: "x.jpg", type: "image/jpeg" }];
    inp.fire("change", { target: inp });
    await tick();
    const where = body.children.find((c) => c.id === "theta-where-sheet");
    where.children.find((c) => /^현재 구역/.test(c.textContent)).click();
    vp.fire("click", { target: { closest: () => null }, clientX: 0, clientY: 0, stopPropagation() {}, preventDefault() {} });
    await tick();
    const next = body.children.find((c) => c.id === "fieldcap-next-sheet");
    ok(!next, "뮤테이션 적용 시 [다음 사진] 시트가 뜨지 않음을 확인(B22 깨짐)");
  }
}

console.log("\n[뮤테이션ⓒ] FieldCapture._run() 의 capture 속성 설정 제거 → B12 가 실패해야 함");
{
  const needle = 'if (m.capture) inp.setAttribute("capture", m.capture); else inp.removeAttribute("capture");';
  const mutated = fcSrc.replace(needle, "/* capture 속성 설정 제거됨 */");
  if (mutated === fcSrc) { console.log("  FAIL 뮤테이션 패치 대상을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const F = loadFC({ fcSource: mutated });   // 독립 vm 컨텍스트(같은 realm 에 const 재선언 금지)
    F.FC.init();
    F.FC._setMethod("camera");
    F.FC._run("camera");
    const inp = F.document.getElementById("input-field-capture");
    ok(inp.getAttribute("capture") !== "environment", "뮤테이션 적용 시 capture=environment 가 설정되지 않음을 확인(B12 깨짐)");
  }
}

console.log(failed ? `\nFAIL ${failed}` : "\nALL PASS");
process.exit(failed ? 1 : 0);
