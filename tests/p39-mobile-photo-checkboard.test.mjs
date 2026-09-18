/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p39-mobile-photo-checkboard.test.mjs)
 *
 * 마스터 지시 4건(2026-09-18) + 지휘자 추가 실측 1건 검증:
 *  ① 모바일에서 .pf-tools 노출 타입이 사진 1개뿐
 *  ② 데스크톱은 6개 유지
 *  ③ 핀 기본 모드가 체크보드
 *  ④ 기존 저장 핀의 kind 해석 불변(회귀) — PinSeries.kindOf() 는 preferredMode 와 무관
 *  ⑤ 오프라인+번들있음 → "오프라인 모드" 표기
 *  ⑥ 오프라인+번들없음 → 다른 안내("작업 불가")
 *  ⑦ 온라인 복귀 시 표기 해제("동기화됨")
 *  ⑧ IndexedDB 이름이 코드 전체에서 1개(정본 DB_NAME)다
 *  ⑨ 다운로드 상태가 "재시작"(별도 verify 호출) 후에도 유지된다
 *  ⑩ [지휘자 추가] 모바일 편집 전환 시 편집 그룹 도구 행이 활성화된다(구조+CSS 캐스케이드 확인)
 *  ⑪ [지휘자 추가] 보기로 되돌리면 편집 행은 비활성화된다
 *
 * 실제 모듈 소스(01b_PinSeries.js, 20_App.js, 32_Offline.js, 05_SyncQueue.js)를
 * 문자열 브레이스-밸런싱으로 발췌해 vm 에 그대로 평가한다(목 구현 아님 — 소스 그대로).
 * CSS 는 텍스트 포함 검사가 아니라 선언값을 파싱해 판정한다.
 *
 * [Uncertain] ⑩⑪은 실제 브라우저 getBoundingClientRect 측정이 아니다 — 이 저장소에는
 * puppeteer/playwright/jsdom 이 설치돼 있지 않아(sandbox 환경) 진짜 레이아웃 엔진이 없다.
 * 대신 (a) 실제 _bindMobileNav() 소스를 그대로 실행해 클릭 시 올바른 행에 "active" 클래스가
 * 붙는지(행동 검증) + (b) 3개 CSS 파일 전체 캐스케이드에서 .mdock-row.active 가 display:flex 로
 * 해석되고, .mdock-row/.mdock-tool 을 display:none 또는 width/height:0 으로 덮는 !important
 * 규칙이 없는지(정적 판정)를 결합해 "활성화되면 실제로 렌더된다"를 최대한 근사 검증한다.
 * 진짜 픽셀 측정은 실기기/브라우저 재현이 필요하다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const pinSeriesSrc = rd("public/js/modules/01b_PinSeries.js");
const appSrc = rd("public/js/modules/20_App.js");
const offlineSrc = rd("public/js/modules/32_Offline.js");
const syncSrc = rd("public/js/modules/05_SyncQueue.js");
const htmlSrc = rd("public/index.html");
const cssFiles = ["style.css", "seastar-family-tokens.css", "seastar-3d-skin.css"].map((f) =>
  rd("public/css/" + f)
);

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 브레이스-밸런싱 발췌(p15 와 동일 패턴) ── */
function extractBalanced(src, needle) {
  const start = src.indexOf(needle);
  if (start < 0) throw new Error("needle not found: " + needle);
  const braceStart = src.indexOf("{", start);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ""); }

/* ── 최소 DOM 목(mock) ── */
function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => x && set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    contains: (c) => set.has(c),
    toggle(c, force) {
      if (force === undefined) { if (set.has(c)) { set.delete(c); return false; } set.add(c); return true; }
      if (force) { set.add(c); return true; }
      set.delete(c); return false;
    },
    _set: set
  };
}
function makeEl(dataset) {
  const el = { _text: "", dataset: dataset || {}, _listeners: {} };
  Object.defineProperty(el, "textContent", { get() { return this._text; }, set(v) { this._text = v == null ? "" : String(v); } });
  el.classList = makeClassList();
  el.addEventListener = function (type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); };
  el.click = function () { (this._listeners.click || []).forEach((fn) => fn()); };
  el.setAttribute = function () {};
  return el;
}

/* ══════════════════════════════════════════════════════════════════
 * ①② — 모바일 .pf-tools 필터(사진만) / 데스크톱 6개 유지 — CSS 값 파싱
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[①② 모바일=사진만 / 데스크톱=6개]");
{
  // index.html 에서 .pf-tools 안의 실제 pf-tool 버튼 id 목록을 뽑는다(하드코딩 손목록 금지 — 소스에서 파생)
  const toolsBlockMatch = htmlSrc.match(/<div class="pf-tools"[\s\S]*?<\/div>\s*<\/div>/);
  if (!toolsBlockMatch) throw new Error(".pf-tools 블록을 찾지 못함");
  const toolsBlock = toolsBlockMatch[0];
  const ids = Array.from(toolsBlock.matchAll(/id="(btn-pin-[a-z-]+)"/g)).map((m) => m[1]);
  ok(ids.length === 6, "소스상 pf-tool 버튼 6개 존재(사진/360/문서/노트/동영상/URL), 실제 " + ids.length);
  ok(ids.includes("btn-pin-file"), "사진 버튼(btn-pin-file) id 확인");

  // 3개 CSS 캐스케이드 전체에서 각 버튼 id 가 max-width:720px 미디어 안에서 display:none 이 되는지 파싱
  const allCss = cssFiles.map(stripComments).join("\n");
  function findMediaBlocks(css, marker) {
    const out = [];
    let idx = 0;
    while (true) {
      const start = css.indexOf(marker, idx);
      if (start === -1) break;
      let depth = 0, i = css.indexOf("{", start);
      const braceStart = i;
      for (; i < css.length; i++) { if (css[i] === "{") depth++; else if (css[i] === "}") { depth--; if (depth === 0) break; } }
      out.push(css.slice(braceStart + 1, i));
      idx = i + 1;
    }
    return out;
  }
  const mobileBlocks = findMediaBlocks(allCss, "@media (max-width: 720px)").join("\n");
  // 모바일에서 숨겨지는 규칙: `.pf-tools .pf-tool:not(#btn-pin-file) { display: none; }`
  const hideRuleMatch = mobileBlocks.match(/\.pf-tools\s+\.pf-tool:not\(#btn-pin-file\)\s*\{([^}]*)\}/);
  ok(!!hideRuleMatch, "모바일(720px) 안에 .pf-tools .pf-tool:not(#btn-pin-file) 규칙 존재");
  const hideDecl = (hideRuleMatch && hideRuleMatch[1]) || "";
  const displayVal = (hideDecl.match(/display\s*:\s*([a-z-]+)/) || [])[1];
  ok(displayVal === "none", "그 규칙의 display 값 = none (실제: " + displayVal + ")");
  // :not(#btn-pin-file) 이므로 숨겨지는 건 btn-pin-file 을 제외한 5개, 즉 모바일 노출 = 1개(사진)
  const hiddenOnMobile = ids.filter((id) => id !== "btn-pin-file");
  ok(hiddenOnMobile.length === 5, "모바일에서 숨는 버튼 5개(사진 제외), 실제 " + hiddenOnMobile.length);
  const visibleOnMobile = ids.filter((id) => id === "btn-pin-file");
  ok(visibleOnMobile.length === 1, "① 모바일 노출 = 사진 1개, 실제 " + visibleOnMobile.length);

  // ② 데스크톱(미디어쿼리 매치 안 함) — 같은 규칙이 :not() 셀렉터라 미디어쿼리 밖에서는 적용되지 않으므로
  //   전역(미디어쿼리 밖) 스코프에 .pf-tool 을 숨기는 규칙이 없어야 한다.
  const globalCss = allCss.replace(new RegExp("@media \\(max-width: 720px\\) \\{[\\s\\S]*?\\n\\}", "g"), "");
  const globalHidesPfTool = /\.pf-tool[^{]*\{[^}]*display\s*:\s*none/.test(globalCss);
  ok(!globalHidesPfTool, "② 데스크톱(미디어쿼리 밖)에는 .pf-tool 을 숨기는 규칙 없음 — 6개 전부 유지");
}

/* ══════════════════════════════════════════════════════════════════
 * ③④ — PinSeries.preferredMode() 기본값 = checkboard / kindOf() 불변
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[③④ 체크보드 기본 모드 + 기존 핀 kind 해석 불변]");
function makePinSeriesSandbox(initialStore) {
  const store = Object.assign({}, initialStore);
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  const sandbox = { localStorage, console, JSON, Object, Array, Math, Number, String, Date };
  vm.createContext(sandbox);
  vm.runInContext(pinSeriesSrc + "\n;globalThis.__PS = PinSeries;", sandbox);
  return { PS: sandbox.__PS, store };
}
{
  const { PS } = makePinSeriesSandbox({}); // 새 사용자(저장된 선호 없음)
  ok(PS.preferredMode() === "checkboard", "③ 저장된 선호 없을 때 기본값 = checkboard, 실제 " + PS.preferredMode());
  ok(PS.DEFAULT_MODE === "checkboard", "③ DEFAULT_MODE 리터럴 = checkboard(SoT)");

  // 사용자가 designer 로 전환하면 그 선택이 유지되는지
  PS.setPreferredMode("designer");
  const { PS: PS2 } = makePinSeriesSandbox({ wm_pin_default_mode: "designer" });
  ok(PS2.preferredMode() === "designer", "사용자가 designer 전환 후 유지 확인");

  // ④ 기존 저장 핀의 kind 해석은 preferredMode 와 무관(회귀) — 체크보드 핀/콘텐츠 핀/빈 핀
  ok(PS.kindOf({ checkboard: true }) === "checkboard", "④ 기존 체크보드 핀 kindOf 불변");
  ok(PS.kindOf({ imageId: "img1" }) === "content", "④ 기존 콘텐츠(360 등록) 핀 kindOf 불변");
  ok(PS.kindOf({}) === "empty", "④ 기존 빈 핀 kindOf 불변");
  // preferredMode 를 바꿔도 kindOf 결과가 달라지지 않아야 한다(완전 독립)
  PS.setPreferredMode("checkboard");
  ok(PS.kindOf({ imageId: "img1" }) === "content", "④ preferredMode 변경 후에도 기존 핀 kindOf 그대로");
}

/* ══════════════════════════════════════════════════════════════════
 * ⑤⑥⑦ — _updateSyncBadge() 오프라인 모드 / 작업불가 / 온라인 복귀
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[⑤⑥⑦ 오프라인 모드 표기 / 작업불가 구분 / 온라인 복귀 시 해제]");
function makeBadgeSandbox({ online, syncCount, opPending, hasManifest, projectId }) {
  const badge = makeEl();
  const dot = makeEl();
  const txt = makeEl();
  const registry = { "sync-badge": badge, "sync-dot": dot, "sync-text": txt };
  const UI = { $: (id) => registry[id] || null };
  const SyncQueue = { count: async () => syncCount };
  const OpLog = { pending: async () => opPending };
  const Offline = {
    curDepId: () => "dep1",
    Bundle: { hasManifest: async () => hasManifest }
  };
  const Projects = { currentProject: projectId ? { id: projectId } : null };
  const navigatorObj = { onLine: online };
  const src = "function " + extractBalanced(appSrc, "_updateSyncBadge() {")
    + "\nglobalThis.__run = _updateSyncBadge;";
  const sandbox = { UI, SyncQueue, OpLog, Offline, Projects, navigator: navigatorObj, console, Promise, JSON, Object };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { run: sandbox.__run, badge, dot, txt };
}
async function flush() { await new Promise((r) => setTimeout(r, 10)); }
{
  const { run, badge, txt } = makeBadgeSandbox({ online: false, syncCount: 0, opPending: [], hasManifest: true, projectId: "p1" });
  run(); await flush();
  ok(txt.textContent === "오프라인 모드", "⑤ 오프라인+번들있음 → '오프라인 모드', 실제: " + JSON.stringify(txt.textContent));
  ok(badge.classList.contains("offline"), "⑤ badge offline 클래스");
  ok(!badge.classList.contains("offline-blocked"), "⑤ offline-blocked 클래스 없음(작업 가능)");
}
{
  const { run, badge, txt } = makeBadgeSandbox({ online: false, syncCount: 0, opPending: [], hasManifest: false, projectId: "p1" });
  run(); await flush();
  ok(/작업 불가/.test(txt.textContent), "⑥ 오프라인+번들없음 → '작업 불가' 문구 포함, 실제: " + JSON.stringify(txt.textContent));
  ok(txt.textContent !== "오프라인 모드", "⑥ '오프라인 모드'와 다른 문구(구분됨)");
  ok(badge.classList.contains("offline-blocked"), "⑥ badge offline-blocked 클래스");
}
{
  const { run, badge, txt } = makeBadgeSandbox({ online: true, syncCount: 0, opPending: [], hasManifest: true, projectId: "p1" });
  run(); await flush();
  ok(txt.textContent === "동기화됨", "⑦ 온라인 복귀(대기 0) → '동기화됨', 실제: " + JSON.stringify(txt.textContent));
  ok(!badge.classList.contains("offline"), "⑦ offline 클래스 해제됨");
  ok(badge.classList.contains("online"), "⑦ online 클래스 부여");
}

/* ══════════════════════════════════════════════════════════════════
 * ⑧ — IndexedDB 이름이 코드 전체에서 1개(정본)다
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[⑧ IndexedDB 이름 SoT — 정본 1개, 잔여 DB 정리 경로만 예외적으로 옛 이름 참조]");
{
  const modulesDir = path.join(ROOT, "public/js/modules");
  const files = fs.readdirSync(modulesDir).filter((f) => f.endsWith(".js"));
  const dbNameDefs = [];
  const openCalls = [];
  for (const f of files) {
    const src = rd("public/js/modules/" + f);
    for (const m of src.matchAll(/(?<!LEGACY_)DB_NAME\s*:\s*"([^"]+)"/g)) dbNameDefs.push({ file: f, name: m[1] });
    for (const m of src.matchAll(/indexedDB\.open\(([^,)]+)/g)) openCalls.push({ file: f, arg: m[1].trim() });
  }
  ok(dbNameDefs.length === 1 && dbNameDefs[0].name === "wm_sync", "정본 DB_NAME 정의가 05_SyncQueue.js 1곳뿐(wm_sync), 실제: " + JSON.stringify(dbNameDefs));
  // open() 호출은 2곳(정본 오픈 + 잔여 DB 정리용 임시 오픈) — 둘 다 05_SyncQueue.js 안에서만, 인자는 this.DB_NAME 또는 this.LEGACY_DB_NAME 뿐
  const otherFileOpens = openCalls.filter((c) => c.file !== "05_SyncQueue.js");
  ok(otherFileOpens.length === 0, "05_SyncQueue.js 이외 파일에서 indexedDB.open() 호출 0건, 실제 " + otherFileOpens.length);
  const badArgs = openCalls.filter((c) => c.arg !== "this.DB_NAME" && c.arg !== "this.LEGACY_DB_NAME");
  ok(badArgs.length === 0, "모든 indexedDB.open() 인자가 this.DB_NAME/this.LEGACY_DB_NAME 뿐(하드코딩 리터럴 직접 사용 0건), 위반: " + JSON.stringify(badArgs));
  // "wm-sync"(하이픈) 리터럴은 오직 LEGACY_DB_NAME 정의 1곳에서만 등장해야 한다(잔여 DB 정리용, 다른 곳에서 재사용 금지)
  // 주석은 제외(문서화 목적 언급은 여러 번 있을 수 있음) — 실제 코드(문자열 리터럴 대입/전달)만 센다
  const syncQCode = rd("public/js/modules/05_SyncQueue.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const hyphenLiteralCount = (syncQCode.match(/"wm-sync"/g) || []).length;
  ok(hyphenLiteralCount === 1, "'wm-sync'(하이픈) 리터럴은 LEGACY_DB_NAME 정의 1곳뿐(코드상, 주석 제외), 실제 " + hyphenLiteralCount + "회");
}

/* ══════════════════════════════════════════════════════════════════
 * ⑨ — 다운로드 상태가 "재시작"(별도 verify 호출) 후에도 유지된다
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[⑨ 다운로드 상태 재시작 후 유지 — saveOrThrow 로 조용한 실패 차단]");
function makeSharedStore() {
  const drafts = {};
  return {
    saveDraft: async (k, d) => { drafts[k] = d; return true; },
    loadDraft: async (k) => (k in drafts ? drafts[k] : null),
    drafts
  };
}
function makeOfflineSandbox(sharedSyncQueue, fetchImpl) {
  const src = "function _authHeaders() { return {}; }\n"
    + extractBalanced(offlineSrc, "const OfflineBundle = {") + "\nglobalThis.__OB = OfflineBundle;";
  const sandbox = {
    SyncQueue: sharedSyncQueue,
    Cloud: { _cache: {} },
    navigator: { onLine: true, storage: undefined },
    fetch: fetchImpl,
    console, JSON, Object, Array, Set, Promise, Date, Math, Error
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.__OB;
}
{
  const shared = makeSharedStore();
  const fetchImpl = async (url) => {
    if (url === "/api/projects") return { json: async () => ({ data: [{ id: "p1", name: "Proj" }] }) };
    if (url === "/api/projects/p1/decks") return { json: async () => ({ data: [{ deployment_id: "d1" }] }) };
    if (url === "/tables/deployments/d1") return { json: async () => ({ id: "d1", title: "도면1", pins: "[]" }) };
    throw new Error("unexpected url " + url);
  };
  // "1차 세션" — 다운로드 실행
  const OB1 = makeOfflineSandbox(shared, fetchImpl);
  const manifest = await OB1.download("p1", () => {});
  ok(!!manifest && manifest.projectId === "p1", "1차 세션: 다운로드 완료(매니페스트 생성)");

  // "재시작" — 완전히 새 vm 컨텍스트(새 세션)를 만들되, 같은 공유 스토어(=같은 IndexedDB 라고 가정)만 넘긴다.
  const OB2 = makeOfflineSandbox(shared, fetchImpl);
  const v = await OB2.verify("p1");
  ok(v.ok === true, "⑨ 재시작 후 새 세션에서 verify() 도 ok:true(저장됨 유지), 실제: " + JSON.stringify(v));
}
{
  // saveDraft 실패(예: 저장공간 부족) 시 download() 가 조용히 '성공'을 보고하지 않고 throw 하는지
  const failingStore = { saveDraft: async () => false, loadDraft: async () => null };
  const fetchImpl = async (url) => {
    if (url === "/api/projects") return { json: async () => ({ data: [{ id: "p1", name: "Proj" }] }) };
    if (url === "/api/projects/p1/decks") return { json: async () => ({ data: [] }) };
    throw new Error("unexpected url " + url);
  };
  const OB = makeOfflineSandbox(failingStore, fetchImpl);
  let threw = false;
  try { await OB.download("p1", () => {}); } catch (e) { threw = true; }
  ok(threw, "⑨ 저장 실패 시 download() 가 throw(조용한 '완료' 보고 금지) — 마스터 기기 재현 가설 차단");
}

/* ══════════════════════════════════════════════════════════════════
 * ⑩⑪ — [지휘자 추가] 모바일 편집↔보기 전환 시 도구 행 활성화/비활성화
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[⑩⑪ 모바일 편집/보기 전환 — 도구 행 active 토글 + CSS 캐스케이드 비-숨김 확인]");
function runBindMobileNav(srcOverride) {
  const rows = ["view", "edit", "page", "anno"].map((g) => makeEl({ group: g }));
  const chips = ["view", "edit", "page", "anno"].map((g) => makeEl({ grp: g }));
  const dock = makeEl();
  dock.offsetHeight = 130;
  dock.querySelectorAll = (sel) => {
    if (sel === ".mdock-row") return rows;
    if (sel === "[data-grp]") return chips;
    if (sel === ".mdock-tool") return [];
    return [];
  };
  dock.querySelector = () => null;
  const UI = { $: (id) => (id === "mobile-dock" ? dock : null) };
  const documentMock = { body: makeEl(), querySelectorAll: () => [] };
  const windowMock = { addEventListener: () => {}, matchMedia: undefined };
  const src = (srcOverride || ("function " + extractBalanced(appSrc, "_bindMobileNav() {")))
    + "\nglobalThis.__bind = _bindMobileNav;";
  const sandbox = { UI, document: documentMock, window: windowMock, console, setTimeout, requestAnimationFrame: (fn) => fn() };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  sandbox.__bind();
  return { rows, chips, dock };
}
{
  const { rows, chips, dock } = runBindMobileNav();
  const editChip = chips[1], viewRow = rows[0], editRow = rows[1];
  editChip.click();
  ok(editRow.classList.contains("active"), "⑩ 편집 칩 클릭 → 편집 행(.mdock-row[data-group=edit]) active 부여");
  ok(!viewRow.classList.contains("active"), "⑩ 편집 전환 시 보기 행은 비활성");
  ok(dock.classList.contains("tray-open"), "⑩ 트레이가 펼쳐짐(tray-open)");

  const viewChip = chips[0];
  viewChip.click();
  ok(viewRow.classList.contains("active"), "⑪ 보기 칩 클릭 → 보기 행 active 부여");
  ok(!editRow.classList.contains("active"), "⑪ 보기로 되돌리면 편집 행은 비활성화됨");
}
{
  // CSS 캐스케이드 정적 확인: .mdock-row.active 가 display:flex 로 해석되고,
  // .mdock-row/.mdock-tool 을 숨기거나 크기 0 으로 만드는 !important 규칙이 다른 곳에 없는지.
  const allCss = cssFiles.map(stripComments).join("\n");
  const activeRuleMatch = allCss.match(/\.mdock-row\.active\s*\{([^}]*)\}/);
  ok(!!activeRuleMatch, "'.mdock-row.active' 규칙 존재");
  const disp = (activeRuleMatch && (activeRuleMatch[1].match(/display\s*:\s*([a-z-]+)/) || [])[1]) || "";
  ok(disp === "flex", "'.mdock-row.active' display 값 = flex, 실제 " + disp);

  const dangerous = Array.from(allCss.matchAll(/\.mdock-(?:row|tool)[^{]*\{([^}]*)\}/g))
    .filter((m) => /!important/.test(m[1]) && /(display\s*:\s*none|width\s*:\s*0|height\s*:\s*0)/.test(m[1]));
  ok(dangerous.length === 0, "'.mdock-row'/'.mdock-tool' 을 !important 로 숨기거나 0크기화하는 규칙 없음, 위반 " + dangerous.length + "건");
}

console.log(failed === 0 ? "\n[ALL PASS]" : "\n[FAIL] " + failed + "건 실패");
process.exit(failed === 0 ? 0 : 1);
