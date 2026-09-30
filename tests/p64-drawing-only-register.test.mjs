/**
 * p64 — 🔴 도면 등록과 구역 생성의 분리 (프레임워크 0 · 실행: node tests/p64-drawing-only-register.test.mjs)
 *
 * 마스터 원문(3회):
 *   2026-09-17 "이건 처음 등록하면 끝이다 등록 안 되게 해. 한 번만 등록하던지, 아니면 구역을 등록할 때
 *               기존 도면에서 영역을 지정할 건지 새로운 도면으로 할 건지 선택하게 해"
 *   2026-09-21 "처음 도면을 등록했을 때는 구역 이름을 지정하게 하지 마. 1.프로젝트 2.구역 3.영역 이니까.
 *               구역은 전체 파일에서 별도의 하나의 구역만 저장할 수 있어야 하니까"
 *   2026-09-21 "프로젝트에 처음 도면 등록 시에는 그냥 등록만 해"
 *
 * 확정 계층: 프로젝트 > 구역 > 영역. 도면은 트리 단계가 아니라 **구역을 잘라낼 원본 파일**이다.
 *
 * 근본원인(수정 전): "도면 등록"과 "구역 생성"이 코드에서 한 덩어리였다.
 *   · 20_App.js  btn-upload-drawing 클릭 게이트 — decks 0개면 업로드를 막고 createDeck() 강제
 *   · 20_App.js  _loadDrawing() 게이트 — 파일을 읽기 전에 createDeck({askDrawing:false}) 로 구역부터
 *   · 20_App.js  _afterDrawingLoaded() → Projects.ensureDeck() — **"구역 1" 자동 이름**으로 구역 생성
 *   · 31_Projects.js _syncUploadLock() — 구역 0개면 업로드 버튼을 "먼저 구역을 등록하세요"로 잠금
 *
 * 검증(마스터 발주 항목 그대로):
 *   ① 도면 등록 시 이름 모달(Prompt.ask)이 뜨지 않는다
 *   ② 🔴 도면 등록만으로 deck 이 생성되지 않는다(자동 이름도 없음 — decks INSERT 0건)
 *   ③ "도면 있음 + 구역 0" 에서 안내가 표시된다(빈 화면 0) + 업로드 버튼 잠금 해제
 *   ④ 영역 지정 시 비로소 구역 생성 — 배포본(deployments) + 구역(decks, parent_id NULL) + crop 묶음
 *   ⑤ 두 번째 영역부터도 정상(반복) — 배포본은 재사용(중복 0), 구역 안의 '영역'으로 붙는다
 *   ⑥ 🔴 기존 데이터 불변 — 옛 프로젝트의 deck/deployment 행 바이트 단위 불변 + 쓰기 0건
 *   ⑦ 좌표 왕복 일치(실제 MapCtrl 순수함수, 허용치 1e-9 %p)
 *   ⑧ 모바일 375×812 — 안내/CTA 겹침 0(정적 흐름) · 스크롤 도달 · 대비 실측 ≥4.5:1 · 새 CSS 0
 *
 * 🔴 뮤테이션 4건: ⓐ 게이트 복원 → ② 실패 · ⓑ 안내 제거 → ③ 실패 ·
 *                ⓒ 묶음 경로 끊기 → ④ 실패 · ⓓ 좌표 재매핑 제거 → ⑦ 실패
 *
 * 🔴 목 금지 — 서버는 src/index.tsx 실 번들, 클라이언트는 20_App.js/31_Projects.js/10_MapCtrl.js/
 *   01_State.js 실 소스를 vm 에 그대로 올려 돈다. 대체한 것은 순수 리프 I/O 뿐이다
 *   (스냅샷·R2 업로드·IndexedDB draft·캔버스/PDF·DOM 렌더 — p1/p56 과 동일 범위).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

const stateSrc    = rd("public/js/modules/01_State.js");
const mapSrc      = rd("public/js/modules/10_MapCtrl.js");
const appSrc      = rd("public/js/modules/20_App.js");
const projectsSrc = rd("public/js/modules/31_Projects.js");
const styleCss    = rd("public/css/style.css").replace(/\/\*[\s\S]*?\*\//g, "");

/* ══ 실제 워커(src/index.tsx) 번들 — 서버는 실 핸들러로 돌린다(p56 과 동일) ══ */
const outFile = path.join(os.tmpdir(), "p64-worker-" + process.pid + ".mjs");
await esbuild.build({
  entryPoints: [path.join(ROOT, "src/index.tsx")],
  bundle: true, format: "esm", platform: "node", outfile: outFile,
  jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
});
const worker = (await import("file://" + outFile.replace(/\\/g, "/"))).default;
fs.unlinkSync(outFile);

/* ══ D1 가짜 — 모든 run() SQL 을 writeLog 에 남긴다 ════════════════════════
 *  PID_NEW : 이번 시나리오의 프로젝트(구역 0개)
 *  PID_OLD : 🔴 이 변경 **전에** 만들어진 기존 데이터(구역+영역+핀+배포본) — 불변이어야 한다 */
const PID_NEW = "prj_new", PID_OLD = "prj_old";
const OLD_DEP = "dep_old", OLD_DECK = "dck_old", OLD_REGION = "dck_old_rgn";
function freshDb() {
  return {
    writeLog: [],
    settings: {},
    sessions: { "local-designer-tok": { email: "designer@example.com", expires_at: Date.now() + 8.64e7, revoked: 0 } },
    localUsers: { "designer@example.com": { email: "designer@example.com", name: "설계자", deleted: 0, must_change_password: 0 } },
    designers: new Set(["designer@example.com"]),
    deployments: {
      [OLD_DEP]: {
        id: OLD_DEP, title: "구형 도면", file_name: "legacy.pdf", drawing_data: "data:image/png;base64,LEGACY",
        pages_data: null, pins: '[{"id":"pin_old","x":31.25,"y":48.5,"label":"OLD-1","page":1}]',
        zones: '[{"id":"zone_old","shape":"rect","x":10,"y":10,"w":20,"h":20,"label":"영역A","page":1}]',
        annotations: "[]", source_meta: null, checkboard_start: null,
        version: 7, deleted: 0, tenant_id: null, created_at: 100, updated_at: 100,
      },
    },
    decks: [
      { id: OLD_DECK,   project_id: PID_OLD, name: "구형 구역", level_no: 1, deployment_id: OLD_DEP, page: 1, crop: null, parent_id: null, created_at: 100, updated_at: 100, deleted: 0 },
      { id: OLD_REGION, project_id: PID_OLD, name: "구형 영역", level_no: 1, deployment_id: OLD_DEP, page: 1, crop: '{"x":5,"y":6,"w":30,"h":25}', parent_id: OLD_DECK, created_at: 101, updated_at: 101, deleted: 0 },
    ],
  };
}
function makeDB(st) {
  const like = (q, s) => q.indexOf(s) >= 0;
  return {
    prepare(sql) {
      const q = sql.replace(/\s+/g, " ").trim();
      return {
        bind(...a) {
          return {
            async first() {
              if (like(q, "FROM app_settings")) return st.settings[a[0]] ? { value: st.settings[a[0]] } : null;
              if (like(q, "FROM local_sessions WHERE token = ?")) return st.sessions[a[0]] || null;
              if (like(q, "FROM local_users WHERE email = ?")) return st.localUsers[String(a[0]).toLowerCase()] || null;
              if (like(q, "FROM designers WHERE email = ?")) return st.designers.has(String(a[0]).toLowerCase()) ? { email: a[0], deleted: 0 } : null;
              if (like(q, "FROM decks WHERE id = ?")) return st.decks.find((d) => d.id === a[0]) || null;
              // [WP3] 배포본 쓰기 권한(deploymentWriteDenied) — 두 프로젝트 모두 이 테스트의 설계자 소유
              if (like(q, "FROM projects WHERE id = ?")) return (a[0] === PID_NEW || a[0] === PID_OLD) ? { owner: "designer@example.com", deleted: 0 } : null;
              if (like(q, "FROM deployments WHERE id = ?")) return st.deployments[a[0]] || null;
              if (like(q, "FROM tenant_members")) return null;
              return null;
            },
            async all() {
              if (like(q, "FROM decks WHERE project_id = ? AND deleted = 0") || like(q, "FROM decks d LEFT JOIN deployments"))
                return { results: st.decks.filter((d) => d.project_id === a[0] && !d.deleted).map((d) => {
                  const dp = d.deployment_id ? st.deployments[d.deployment_id] : null;
                  return { ...d, deployment_title: dp ? (dp.title ?? null) : null, deployment_file_name: dp ? (dp.file_name ?? null) : null };
                }) };
              return { results: [] };
            },
            async run() {
              st.writeLog.push({ sql: q, args: a });
              if (like(q, "INSERT INTO decks")) {
                const cols = (q.match(/INSERT INTO decks \(([^)]*)\)/) || ["", ""])[1].split(",").map((x) => x.trim());
                const row = { deleted: 0 };
                cols.forEach((cname, i) => { row[cname] = a[i]; });
                row.deployment_id = row.deployment_id || null;
                row.deleted = 0;
                st.decks.push(row);
              } else if (like(q, "INSERT INTO deployments")) {
                const cols = (q.match(/INSERT INTO deployments \(([^)]*)\)/) || ["", ""])[1].split(",").map((x) => x.trim());
                const row = { version: 0, deleted: 0 };
                cols.forEach((cname, i) => { row[cname] = a[i]; });
                st.deployments[row.id] = row;
              } else if (like(q, "UPDATE decks SET deleted = 1")) {
                const d = st.decks.find((x) => x.id === a[1]); if (d) { d.deleted = 1; d.updated_at = a[0]; }
              } else if (like(q, "UPDATE decks SET name =")) {
                const cols = (q.match(/UPDATE decks SET (.*) WHERE id = \?/) || ["", ""])[1]
                  .split(",").map((x) => x.trim().replace(/\s*=\s*\?$/, ""));
                const d = st.decks.find((x) => x.id === a[cols.length]);
                if (d) cols.forEach((cname, i) => { d[cname] = a[i]; });
              } else if (like(q, "UPDATE decks SET crop")) {
                const d = st.decks.find((x) => x.id === a[a.length - 1]);
                if (d) { d.crop = a[0]; d.updated_at = a[1]; }
              } else if (like(q, "INSERT INTO app_settings")) {
                if (!st.settings[a[0]]) st.settings[a[0]] = a[1];
              }
              return { success: true };
            },
          };
        },
        async first() { return null; },
        async all() { return { results: [] }; },
        async run() { return { success: true }; },
      };
    },
  };
}

/* ══ 최소 DOM — 실제 렌더 대상 id 를 등록해 innerHTML/handler 를 관찰한다 ══ */
function makeEl(tag) {
  const classes = new Set();
  const el = {
    tagName: tag || "div", _classes: classes, style: {}, dataset: {}, disabled: false,
    onclick: null, title: "", value: "", _children: [], _handlers: {},
    classList: {
      add: (...c) => c.forEach((x) => x && classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, force) => { const want = force === undefined ? !classes.has(c) : !!force; if (want) classes.add(c); else classes.delete(c); return want; },
      contains: (c) => classes.has(c),
    },
    appendChild(c) { this._children.push(c); return c; },
    removeChild() {},
    setAttribute(k, v) { this.dataset["attr_" + k] = String(v); },
    getAttribute(k) { return this.dataset["attr_" + k]; },
    addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); },
    click() { (this._handlers.click || []).forEach((fn) => fn({ target: this, stopPropagation() {} })); if (this.onclick) this.onclick({ target: this }); },
    querySelector: () => makeEl(), querySelectorAll: () => [], closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 240, height: 100 }),
  };
  Object.defineProperty(el, "textContent", { get() { return this._text || ""; }, set(v) { this._text = v == null ? "" : String(v); } });
  Object.defineProperty(el, "innerHTML", { get() { return this._html || ""; }, set(v) { this._html = String(v); if (v === "") this._children = []; } });
  return el;
}
function makeDom() {
  const reg = {};
  // 🔴 실제 DOM 처럼 **요청된 id 를 lazily 등록**한다(p10 과 동일 패턴). 이렇게 해야
  //   innerHTML 로 그려진 CTA(#side-tree-make-deck-region) 에 실제 핸들러가 붙는 경로를 검증할 수 있다.
  const get = (id) => (reg[id] = reg[id] || makeEl());
  // 선택 모달 · 빈 상태 호스트 · 업로드 버튼은 미리 만들어 기본 클래스를 맞춘다
  ["deck-source-modal", "dsm-backdrop", "dsm-btn-region", "dsm-btn-upload", "dsm-region-reason",
   "dsm-sub", "dsm-cancel", "side-tree", "decks-list", "decks-empty", "btn-upload-drawing",
   "upload-zone-hint", "decks-block", "map-image", "pdf-canvas"].forEach(get);
  reg["deck-source-modal"].classList.add("hidden");
  reg["dsm-region-reason"].classList.add("hidden");
  // [WO 20260929-fitrace] #map-image — 이 스위트의 시나리오(이미 로드된 도면 위에서 드래그로
  // 영역/구역을 만든다)에선 실제로 이미지가 이미 로드·표시된 상태다(§_applyDeckCropView 의
  // img.complete 체크가 통과해 종전처럼 fitZone 이 즉시 불린다). 로드 레이스 자체는 p81 이 검증.
  reg["map-image"].complete = true; reg["map-image"].naturalWidth = 100;
  return { reg, get };
}

/* ══ 클라이언트 — 실 소스(State/MapCtrl/App/Projects)를 한 컨텍스트에 올린다 ══ */
function makeClient(db, srcs) {
  srcs = srcs || {};
  const S = {
    state: srcs.state || stateSrc, map: srcs.map || mapSrc,
    app: srcs.app || appSrc, projects: srcs.projects || projectsSrc,
  };
  const { reg, get } = makeDom();
  const calls = { asks: [], toasts: [], saveDraft: 0, snapshot: 0, indicator: [], renderTree: 0, syncToolUi: 0, dirty: 0 };
  // 01_State.js 는 `const State = {...}` 라 vm 전역 프로퍼티가 아니다(렉시컬 바인딩) →
  // 로드 후 실 객체를 여기에 담아 Zones 스텁이 참조한다.
  const live = { State: null };
  const ENV = { DB: makeDB(db), DEMO_LOGIN: "0" };
  const sandbox = {
    console, JSON, Math, Date, Set, Map, Promise, Object, Array, String, Number, Boolean,
    URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, isNaN, parseInt, parseFloat,
    requestAnimationFrame: (fn) => fn(),
    alert: (m) => calls.toasts.push("ALERT:" + m), confirm: () => true,
    navigator: { onLine: true },
    location: { origin: "https://scan360.pages.dev", pathname: "/", search: "", href: "https://scan360.pages.dev/" },
    localStorage: { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } },
    URL: { createObjectURL: () => "blob:fake-drawing", revokeObjectURL() {} },
    document: {
      getElementById: (id) => get(id),
      createElement: (t) => makeEl(t),
      querySelector: () => null, querySelectorAll: () => [],
      body: { appendChild() {}, removeChild() {}, classList: makeEl().classList },
      documentElement: { style: { setProperty() {} } },
      addEventListener() {},
    },
    Auth: { headers: () => ({ Authorization: "Bearer local-designer-tok", "Content-Type": "application/json" }), isDesigner: true, idToken: "t", user: { email: "designer@example.com" } },
    Prompt: {
      ask: async (o) => { calls.asks.push(o && o.title); return { value: (o && o.value) || "" }; },
      toast: (m) => calls.toasts.push(String(m)),
    },
    Log: { push() {} },
    UI: {
      $: (id) => get(id), text() {}, toggle() {}, escapeHtml: (s) => String(s),
      renderPinsOnMap() {}, renderPinList() {}, updatePdfPagination() {}, renderPdfThumbs() {},
      updateRotationLabel() {}, showScreen() {}, renderTree() { calls.renderTree++; }, togglePinList() {},
    },
    PDF: {
      load: async () => ({ numPages: 1, destroy() {} }),
      setDeckCrop: (c) => { (calls.setDeckCrop = calls.setDeckCrop || []).push(c); },
      lastSnapshotDims: null,
    },
    Zones: {
      _commitZone: async () => {},
      _cancelDraw() { calls.cancelDraw = (calls.cancelDraw || 0) + 1; if (live.State) live.State.drawingZone = false; calls.syncToolUi++; },
      _bbox: (g) => ({ x: g.x, y: g.y, w: g.w, h: g.h }),
      _syncToolUi: () => { calls.syncToolUi++; },
      _shape: null, _poly: null, serialize: () => "[]",
    },
    SyncQueue: { saveDraft: async () => { calls.saveDraft++; }, loadDraft: async () => null, flush: async () => ({}) },
    ProjectHub: {}, Notes: {}, PinPrefs: {},
    fetch: async (url, opt) => {
      const o = opt || {};
      const req = new Request("https://scan.seastar.work" + url, {
        method: o.method || "GET",
        headers: Object.assign({ Host: "scan.seastar.work" }, o.headers || {}),
        body: o.body,
      });
      ENV.DB = makeDB(db);
      return await worker.fetch(req, ENV, { waitUntil() {}, passThroughOnException() {} });
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    // 01_State.reset() 이 쓰는 00_header.js 의 blob 해제 헬퍼(리프 I/O) — 그 모듈만 최소 스텁
    "function _revokeAllVideoBlobs(){}\n" +
    S.state + "\n" + S.map + "\n" + S.app + "\n" + S.projects +
    "\n;globalThis.__P = Projects; globalThis.__A = App; globalThis.__S = State; globalThis.__M = MapCtrl;",
    sandbox
  );
  const P = sandbox.__P, A = sandbox.__A, St = sandbox.__S, M = sandbox.__M;
  live.State = St;
  // ── 리프 I/O 만 대체 (검사 대상 로직은 실 소스 그대로) ──
  A._snapshotPages    = async () => { calls.snapshot++; return ["data:image/jpeg;base64,AAAA"]; };
  A._uploadPagesToR2  = async (p) => p;
  A._buildSourceMeta  = async () => null;
  A._saveDraftLocal   = async () => { calls.saveDraft++; };
  A._markDraftClean   = async () => {};
  A._setSaveIndicator = (s) => { calls.indicator.push(s); };
  A._updateSaveBtn    = () => {};
  A._markDeckUnsaved  = () => {};
  A._deckIdOfKey      = () => null;
  A._draftKey         = () => PID_NEW + "::x";
  A._refreshUnsavedDecks = () => {};
  A.isDeckUnsaved     = () => false;
  A._markDirty        = () => { calls.dirty++; };
  A._closePinForm     = () => {};
  // MapCtrl 의 **렌더 리프**만 대체 — 검사 대상인 순수 좌표함수(pageToDeckCropPct/deckCropPctToPage)는 실 소스 그대로
  M.applyTransform = () => {};
  M.fitZone = (bb) => { (calls.fitZone = calls.fitZone || []).push(bb); };
  St.mode = "designer";
  P.currentProject = { id: PID_NEW, name: "새 프로젝트" };
  P.decks = [];
  return { P, A, State: St, MapCtrl: M, reg, calls, sandbox };
}

const waitUntil = async (fn, max) => {
  for (let i = 0; i < (max || 600) && !fn(); i++) await new Promise((r) => setTimeout(r, 0));
  if (!fn()) throw new Error("waitUntil timeout");
};
/** 조건이 안 와도 던지지 않는다 — 뮤테이션 적용 시 '조용히 아무 일도 안 일어남'을
 *  스택트레이스가 아니라 **읽을 수 있는 FAIL 줄**로 보고하기 위함. */
const softWait = async (fn, max) => {
  for (let i = 0; i < (max || 600) && !fn(); i++) await new Promise((r) => setTimeout(r, 0));
  return !!fn();
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const deckWrites = (db, from) => db.writeLog.slice(from).filter((w) => /INSERT INTO decks/.test(w.sql));
const depWrites  = (db, from) => db.writeLog.slice(from).filter((w) => /INSERT INTO deployments/.test(w.sql));

/** 도면 등록 = 실제 진입 수렴점 App._loadDrawing(file) 을 그대로 실행(이미지 경로). */
async function registerDrawing(c, fileName) {
  const file = { name: fileName || "hull_A0.png", type: "image/png", size: 1234 };
  const p = c.A._loadDrawing(file);
  // 이미지 로드 완료 콜백은 브라우저가 호출한다 — 여기서 대신 발화(리프 I/O)
  await waitUntil(() => typeof c.reg["map-image"].onload === "function");
  c.reg["map-image"].onload();
  await p;
  await new Promise((r) => setTimeout(r, 0));
  return file;
}

/* ══════════════════════════════════════════════════════════════════════
 * ①② 도면 등록 = 파일을 올리는 것, 그게 전부
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[①② 도면 등록만으로는 이름 모달도, 구역도 생기지 않는다]");
const db = freshDb();
const c1 = makeClient(db);
const w0 = db.writeLog.length;
await registerDrawing(c1, "hull_A0.png");

ok(c1.calls.asks.length === 0, `① 도면 등록 중 Prompt.ask(이름 모달) 호출 0회 (실제 ${c1.calls.asks.length}: ${c1.calls.asks.join(",")})`);
ok(deckWrites(db, w0).length === 0, `② 도면 등록만으로 decks INSERT 0건 (실제 ${deckWrites(db, w0).length})`);
ok(db.decks.filter((d) => d.project_id === PID_NEW).length === 0, "② 새 프로젝트의 구역 수 0개 유지");
ok((c1.P.decks || []).length === 0 && !c1.P.currentDeck, "② 클라이언트 상태에도 구역/현재구역 0");
ok(!db.decks.some((d) => /^구역 \d+$/.test(String(d.name))), "② '구역 N' 자동 이름 구역 0개(자동 이름 금지)");
ok(c1.State.fileType === "image" && c1.State.fileName === "hull_A0.png", "② 도면 자체는 정상 로드됨(등록은 됐다)");

/* ══════════════════════════════════════════════════════════════════════
 * ③ "도면 있음 + 구역 0" 안내 (빈 화면 0)
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[③ '도면 있음 + 구역 0' 상태 안내]");
{
  // [WO 20260929-tree1] 🔴 근본수정 — "도면 있음 + 구역 0" CTA 안내의 실제 DOM 렌더링(문구·
  //   버튼)은 이제 11_UI.js UI.renderTree() 가 맡는다(예전엔 31_Projects._renderSideTreeEmpty()
  //   가 #side-tree.innerHTML 을 직접 덮어써 렌더 SoT 가 둘로 갈라져 있었다 — 트리가 그 위에
  //   붙인 실 DOM(#project-actions 등)을 다음 렌더에서 파괴하는 결함으로 이어져 합쳤다).
  //   이 스위트는 UI 를 "리프 스텁"으로 유지한다(파일 docstring 원칙 — DOM 렌더는 대체 대상).
  //   그래서 여기서는 **위임이 실제로 일어나는지**(호출)만 검사하고, CTA 의 정확한 문구·버튼
  //   내용은 11_UI.js 를 직접 로드하는 별도 커버리지가 필요하다([Uncertain] — 이 턴엔 실 CDP
  //   스크린샷(.tmp/fix13/01-after-drawing-register.png)으로 육안 확인만 했다. 자동화 스위트로
  //   승격은 후속 작업).
  ok(c1.calls.renderTree > 0, `③ "도면 있음 + 구역 0" → UI.renderTree() 위임 호출됨(실제 ${c1.calls.renderTree}회) — CTA 렌더 SoT는 11_UI.js`);
  // 업로드 버튼 잠금(옛 게이트의 시각적 절반)이 해제됐는지
  const ub = c1.reg["btn-upload-drawing"];
  ok(!ub.classList.contains("upload-locked"), "③ 업로드 버튼 잠금 클래스 해제됨");
  ok(ub.getAttribute("aria-disabled") === "false", `③ aria-disabled=false (실제 ${ub.getAttribute("aria-disabled")})`);
  ok(!/먼저 구역을 등록하세요/.test(ub.textContent), `③ 업로드 버튼 문구에 옛 차단 안내 없음 (실제 "${ub.textContent}")`);
  ok(/영역을 지정/.test(c1.reg["upload-zone-hint"].textContent), `③ 업로드 힌트가 새 순서를 안내 (실제 "${c1.reg["upload-zone-hint"].textContent}")`);
  // 🔴 라이브 실측 결함(375×812): #side-tree 는 바텀시트(y≈1045px=화면 밖)라 그려도 안 보였다 →
  //   구역 0일 때 그 시트를 연다. body.sidebar-open 이 그 상태의 SoT.
  ok(c1.sandbox.document.body.classList.contains("sidebar-open"),
    "③ 🔴 구역 0 + 도면 있음 → 모바일 사이드 시트가 열려 안내가 화면 안으로 들어온다");
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 영역 지정 시 비로소 구역 생성 — 배포본 + 구역 + crop 묶음
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[④ 첫 영역 지정 = 배포본 + 구역(parent_id NULL) + crop 묶음]");
const c2 = makeClient(db);
await registerDrawing(c2, "hull_A0.png");
const w1 = db.writeLog.length;
const CROP1 = { x: 12.5, y: 20, w: 35, h: 28 };
let deck1 = null;
{
  // 실제 진입경로: #btn-region-extract → Projects.extractRegionAsDeck() (구역 0 + 도면 로드 → 위임)
  c2.sandbox.Prompt.ask = async (o) => { c2.calls.asks.push(o && o.title); return { value: "MAIN DECK" }; };
  const pending = c2.P.extractRegionAsDeck();
  const armed = await softWait(() => c2.calls.syncToolUi > 0);    // 기존 Zones 드래그 모드가 실제로 켜짐
  ok(armed, "④ 첫 영역 지정 요청이 실제로 드래그 모드를 켠다(묶음 경로 진입)");
  // 🔴 라이브 실측: 시트가 열린 채로는 도면을 만질 수 없다 → 드래그 요구 시 반드시 닫힌다.
  ok(!c2.sandbox.document.body.classList.contains("sidebar-open"),
    "④ 드래그 요구 시 사이드 시트가 닫힌다(도면이 가려지지 않음)");
  if (armed) await c2.sandbox.Zones._commitZone({ shape: "rect", ...CROP1 });
  deck1 = await pending;

  ok(!!deck1 && !!deck1.id, "④ 구역이 생성됨: " + (deck1 && deck1.name));
  ok(deck1 && deck1.name === "MAIN DECK", `④ 사용자가 준 이름이 그대로 저장됨 (실제 ${deck1 && deck1.name})`);
  ok(c2.calls.asks.some((t) => /구역 이름/.test(String(t))), `④ 이름을 **이 시점에** 묻는다 (실제 ${JSON.stringify(c2.calls.asks)})`);
  ok(depWrites(db, w1).length === 1, `④ 배포본(deployments) INSERT 1건 (실제 ${depWrites(db, w1).length})`);
  ok(deckWrites(db, w1).length === 1, `④ 구역(decks) INSERT 1건 (실제 ${deckWrites(db, w1).length})`);
  const row = db.decks.find((d) => d.id === (deck1 && deck1.id));
  ok(!!row, "④ 서버 decks 행이 실제로 존재");
  ok(!!row && !!row.deployment_id && !!db.deployments[row.deployment_id], "④ 구역이 실제 배포본을 가리킨다(끊긴 참조 아님)");
  ok(!!row && (row.parent_id === null || row.parent_id === undefined), `④ parent_id = NULL → 최상위 '구역' (실제 ${row && row.parent_id})`);
  ok(!!deck1.crop && deck1.crop.x === CROP1.x && deck1.crop.w === CROP1.w, `④ 드래그한 crop 이 그대로 저장됨 (실제 ${JSON.stringify(deck1 && deck1.crop)})`);
  ok(c2.P.currentDeck && c2.P.currentDeck.id === deck1.id, "④ 생성 직후 이 구역이 현재 컨텍스트가 된다(고아 배포본 방지)");
  ok(c2.calls.syncToolUi > 0, "④ 드래그는 기존 Zones 도구를 재사용(새 그리기 도구 0)");
  // 🔴 마스터 확정: "바운더리를 잘라서 별도의 페이지로 구성" — 생성 직후 그 구역이 독립 페이지처럼 열린다.
  const lastCrop = (c2.calls.setDeckCrop || []).slice(-1)[0];
  ok(!!lastCrop && lastCrop.x === CROP1.x && lastCrop.w === CROP1.w,
    `④ PDF.setDeckCrop 이 이 구역의 crop 으로 호출됨(잘린 페이지 렌더) — ${JSON.stringify(lastCrop)}`);
  ok((c2.calls.fitZone || []).some((z) => z && z.x === CROP1.x && z.w === CROP1.w),
    "④ MapCtrl.fitZone 이 그 영역으로 화면을 맞춤 — 별도 페이지처럼 보인다");
  ok(!!c2.sandbox.document.body.classList.contains("deck-view-active"),
    "④ body.deck-view-active — 구역 뷰 상태 진입(selectDeck 과 동일한 공유 지점)");
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 두 번째 영역부터도 정상(반복) — 배포본 재사용, 구역 하위 '영역'
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[⑤ 두 번째·세 번째 영역 지정(반복)]");
if (!deck1) { ok(false, "⑤ 선행 ④가 실패해 반복 검증 불가(첫 구역이 없음)"); } else {
  const w2 = db.writeLog.length;
  const made = [];
  for (const v of [{ name: "영역 B", crop: { x: 50, y: 10, w: 20, h: 18 } },
                   { name: "영역 C", crop: { x: 60, y: 55, w: 22, h: 20 } }]) {
    const p = c2.P.extractRegionAsDeck({ name: v.name, crop: v.crop });
    made.push(await p);
  }
  ok(made.every((d) => d && d.id), "⑤ 2회 연속 생성 모두 성공: " + made.map((d) => d && d.name).join(", "));
  ok(new Set(made.map((d) => d.id)).size === 2, "⑤ 서로 다른 행 2개(재사용 아님)");
  ok(depWrites(db, w2).length === 0, `⑤ 🔴 배포본은 재사용 — 추가 deployments INSERT 0건 (실제 ${depWrites(db, w2).length})`);
  ok(deckWrites(db, w2).length === 2, `⑤ decks INSERT 2건 (실제 ${deckWrites(db, w2).length})`);
  ok(made.every((d) => String(d.parent_id) === String(deck1.id)),
    `⑤ 계층 3단 유지 — 2·3번째는 구역 '${deck1.name}' 의 **영역**(parent_id=${made.map((d) => d.parent_id).join(",")})`);
  ok(made.every((d) => String(d.deployment_id) === String(deck1.deployment_id)), "⑤ 모두 같은 원본 도면을 가리킴(픽셀 복사 0)");
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 🔴 기존 데이터 불변
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[⑥ 기존(변경 전) 데이터 불변]");
{
  const base = freshDb();
  const oldDeckNow   = db.decks.find((d) => d.id === OLD_DECK);
  const oldRegionNow = db.decks.find((d) => d.id === OLD_REGION);
  ok(JSON.stringify(oldDeckNow) === JSON.stringify(base.decks[0]), "⑥ 구형 구역 행 바이트 단위 불변");
  ok(JSON.stringify(oldRegionNow) === JSON.stringify(base.decks[1]), "⑥ 구형 영역 행(crop·parent_id 포함) 바이트 단위 불변");
  ok(JSON.stringify(db.deployments[OLD_DEP]) === JSON.stringify(base.deployments[OLD_DEP]), "⑥ 구형 배포본(핀·영역 JSON 포함) 바이트 단위 불변");
  const touched = db.writeLog.filter((w) => (w.args || []).some((a) => a === OLD_DEP || a === OLD_DECK || a === OLD_REGION));
  ok(touched.length === 0, `⑥ 구형 행을 인수로 받은 쓰기 SQL 0건 (실제 ${touched.length})`);
  // 구형 프로젝트를 그대로 열어도(구역 2개, 도면 있음) 새 코드에서 정상 동작해야 한다
  const c3 = makeClient(db);
  c3.P.currentProject = { id: PID_OLD, name: "구형 프로젝트" };
  await c3.P.loadDecks();
  ok(c3.P.decks.length === 2, `⑥ 구형 프로젝트의 구역/영역 2개 그대로 조회됨 (실제 ${c3.P.decks.length})`);
  ok(c3.P.decks.every((d) => d.deployment_id === OLD_DEP), "⑥ 구형 도면 연결 유지");
  ok(!/side-tree-empty/.test(c3.reg["side-tree"].innerHTML || ""), "⑥ 구역이 있는 구형 프로젝트에는 빈 상태 안내가 뜨지 않음");
  const legacyRegion = c3.P.decks.find((d) => d.id === OLD_REGION);
  ok(!!legacyRegion.crop && legacyRegion.crop.x === 5 && legacyRegion.crop.w === 30,
    `⑥ 구형 영역의 crop 이 그대로 파싱됨 (실제 ${JSON.stringify(legacyRegion.crop)})`);
  ok(!/ALTER TABLE|ADD COLUMN/.test(db.writeLog.map((w) => w.sql).join(" ")), "⑥ 스키마 변경(마이그레이션) 0건 — 기존 컬럼만 사용");
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑦ 좌표 왕복 일치 (실제 MapCtrl 순수함수)
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[⑦ 좌표 왕복 일치 — 페이지 기준 % ↔ 구역 크롭 기준 %]");
function roundTripMaxErr(M, crop, pts) {
  let maxErr = 0;
  for (const p of pts) {
    const m = M.pageToDeckCropPct(p.x, p.y, crop);
    if (!m) return Infinity;                        // 크롭 안의 점은 반드시 매핑돼야 한다
    const back = M.deckCropPctToPage(m.x, m.y, crop);
    maxErr = Math.max(maxErr, Math.abs(back.x - p.x), Math.abs(back.y - p.y));
  }
  return maxErr;
}
const RT_PTS = [{ x: 12.5, y: 20 }, { x: 20, y: 30 }, { x: 47.5, y: 48 }, { x: 30.125, y: 41.875 }];
if (!deck1 || !deck1.crop) { ok(false, "⑦ 선행 ④가 실패해 좌표 검증 불가(저장된 crop 이 없음)"); } else {
  const err = roundTripMaxErr(c2.MapCtrl, deck1.crop, RT_PTS);
  ok(err < 1e-9, `⑦ 왕복 최대 오차 ${err} %p < 1e-9 (crop=${JSON.stringify(deck1.crop)})`);
  ok(c2.MapCtrl.pageToDeckCropPct(12.5, 20, deck1.crop).x === 0, "⑦ crop 좌상단이 크롭 기준 0% 로 매핑됨");
  ok(c2.MapCtrl.pageToDeckCropPct(1, 1, deck1.crop) === null, "⑦ crop 밖 좌표는 null(표시 제외) — 날조 좌표 0");
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑧ 모바일 375×812 — 겹침 0 · 스크롤 도달 · 대비 · 새 CSS 0
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[⑧ 모바일 375×812 안내 레이아웃]");
{
  const rule = (sel) => {
    const m = styleCss.match(new RegExp(sel.replace(/[.#*]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
    return m ? m[1] : "";
  };
  const sideTree = rule(".side-tree");
  ok(/overflow-y\s*:\s*auto/.test(sideTree), `⑧ .side-tree 가 스크롤 컨테이너 → 안내/CTA 스크롤 도달 (실제 "${sideTree.trim()}")`);
  ok(/max-height\s*:/.test(sideTree), "⑧ .side-tree 에 max-height 존재(컨테이너가 형제를 밀어내지 않음)");
  const empty = rule(".side-tree-empty"), cta = rule(".side-tree-empty-cta");
  ok(!!empty && !/position\s*:\s*(fixed|absolute)/.test(empty), "⑧ 안내 블록이 정적 흐름(position fixed/absolute 아님) → 형제와 겹침 0");
  ok(!!cta && !/position\s*:\s*(fixed|absolute)/.test(cta), "⑧ CTA 도 정적 흐름 → 겹침 0");
  ok(!/width\s*:\s*\d{3,}px/.test(empty), "⑧ 안내 블록에 375px 를 넘는 고정 폭 없음(가로 넘침 0)");
  // 새 CSS 0 — 새 id 전용 규칙을 만들지 않고 기존 클래스만 재사용
  ok(!/side-tree-make-deck-region/.test(styleCss), "⑧ 새 CTA 전용 CSS 규칙 0건 — 기존 .side-tree-empty-cta 재사용");
  // 대비 실측(WCAG 2.1 상대휘도) — 문자열 검사 아님
  const lum = (hex) => {
    const v = hex.replace("#", "").match(/../g).map((h) => parseInt(h, 16) / 255)
      .map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const pick = (css, prop) => (css.match(new RegExp(prop + "\\s*:\\s*(#[0-9a-fA-F]{6})")) || [])[1];
  const msgFg = pick(rule(".side-tree-empty-msg"), "color");
  const boxBg = pick(empty, "background");
  const ctaFg = pick(cta, "color"), ctaBg = pick(cta, "background");
  const rMsg = (msgFg && boxBg) ? ratio(msgFg, boxBg) : 0;
  const rCta = (ctaFg && ctaBg) ? ratio(ctaFg, ctaBg) : 0;
  ok(rMsg >= 4.5, `⑧ 안내 문구 대비 ${rMsg.toFixed(2)}:1 ≥ 4.5 (${msgFg} on ${boxBg})`);
  ok(rCta >= 4.5, `⑧ CTA 글자 대비 ${rCta.toFixed(2)}:1 ≥ 4.5 (${ctaFg} on ${ctaBg})`);
}

/* ══════════════════════════════════════════════════════════════════════
 * 🔴 뮤테이션 ⓐ — 게이트 복원(도면 등록 시 구역 자동생성) → ② 실패해야 함
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션ⓐ 도면 등록 시 구역 자동생성 복원 → ②가 깨져야 함]");
{
  const anchor = "          deck = Projects.currentDeck || (Projects.decks && Projects.decks[0]) || null;";
  const mutApp = appSrc.replace(anchor,
    '          deck = await Projects.createDeck({ name: "구역 1", select: true, askDrawing: false });');
  if (mutApp === appSrc) { ok(false, "뮤테이션ⓐ 앵커 없음(소스 변경?)"); }
  else {
    const mdb = freshDb();
    const mc = makeClient(mdb, { app: mutApp });
    const mw = mdb.writeLog.length;
    await registerDrawing(mc, "hull_A0.png");
    ok(deckWrites(mdb, mw).length === 1 && mdb.decks.some((d) => d.name === "구역 1"),
      `ⓐ 무력화 시 '구역 1' 자동생성 재현 (decks INSERT ${deckWrites(mdb, mw).length})`);
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 🔴 뮤테이션 ⓑ — "도면 있음" 안내 분기 제거 → ③ 실패해야 함
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션ⓑ '도면 있음 + 구역 0' 안내 위임(UI.renderTree() 호출) 제거 → ③이 깨져야 함]");
{
  // [WO 20260929-tree1] 🔴 앵커 이동 — CTA 분기 자체는 이제 11_UI.js 안에 있다(이 스위트는
  // UI 를 리프 스텁으로 유지하므로 그 안까지는 못 본다, 위 ③ 주석 참조). 여기서는 31_Projects.js
  // 쪽 공유 지점(위임 호출)이 빠지면 "구역 0" 렌더링 경로 자체가 끊긴다는 것만 증명한다.
  const anchor = '      if (typeof UI !== "undefined" && UI.renderTree) UI.renderTree();\n    },\n\n    /** [WO 20260928] 🔴 옛';
  const mutP = projectsSrc.replace(anchor, "      /* 위임 제거(뮤테이션) */\n    },\n\n    /** [WO 20260928] 🔴 옛");
  if (mutP === projectsSrc) { ok(false, "뮤테이션ⓑ 앵커 없음(소스 변경?)"); }
  else {
    const mdb = freshDb();
    const mc = makeClient(mdb, { projects: mutP });
    await registerDrawing(mc, "hull_A0.png");
    ok(mc.calls.renderTree === 0,
      `ⓑ 무력화 시 UI.renderTree() 위임이 끊겨 "구역 0" 안내 경로 자체가 실행되지 않는다(실제 ${mc.calls.renderTree}회)`);
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 🔴 뮤테이션 ⓒ — 묶음 경로(위임) 끊기 → ④ 실패해야 함
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션ⓒ 묶음 경로 위임 제거 → ④가 깨져야 함]");
{
  const anchor = "        if (this._canExtractFromLoadedDrawing()) return await this.createDeckFromLoadedDrawing(opts);";
  const mutP = projectsSrc.replace(anchor, "        // 위임 제거(뮤테이션)");
  if (mutP === projectsSrc) { ok(false, "뮤테이션ⓒ 앵커 없음(소스 변경?)"); }
  else {
    const mdb = freshDb();
    const mc = makeClient(mdb, { projects: mutP });
    await registerDrawing(mc, "hull_A0.png");
    const mw = mdb.writeLog.length;
    const r = await mc.P.extractRegionAsDeck({ name: "MAIN DECK", crop: CROP1 });
    ok(r === null && deckWrites(mdb, mw).length === 0 && depWrites(mdb, mw).length === 0,
      `ⓒ 무력화 시 첫 영역 지정이 아무것도 만들지 못함(반환 ${r}, decks ${deckWrites(mdb, mw).length}, dep ${depWrites(mdb, mw).length})`);
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 🔴 뮤테이션 ⓓ — 좌표 재매핑 제거(항등) → ⑦ 실패해야 함
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션ⓓ pageToDeckCropPct 항등화 → ⑦이 깨져야 함]");
{
  const anchor = '      return { x: (x - crop.x) / crop.w * 100, y: (y - crop.y) / crop.h * 100 };';
  const mutM = mapSrc.replace(anchor, "      return { x, y };");
  if (mutM === mapSrc) { ok(false, "뮤테이션ⓓ 앵커 없음(소스 변경?)"); }
  else {
    const mdb = freshDb();
    const mc = makeClient(mdb, { map: mutM });
    const err = roundTripMaxErr(mc.MapCtrl, CROP1, RT_PTS);
    ok(!(err < 1e-9), `ⓓ 무력화 시 왕복 오차 재현 = ${err} %p (1e-9 초과해야 정상)`);
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
