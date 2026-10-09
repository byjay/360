/**
 * p93 — 실환경 E2E: 여러 명 동시 작업(B1~B5) · 구역 설정 = 새 페이지(C1~C4) · 창 구역 저장이 원본을 지키는가(H7)
 * (프레임워크 0 · 실행: node tests/p93-multiuser-region-e2e.test.mjs)
 *
 * 마스터 원문(2026-09-30): "여러 명 동시 작업 문제없는지, 구역 설정 시 새로운 페이지 생성, 전체 원본 관리 유지 기능 점검"
 *
 * 🔴 목 금지 범위:
 *   서버 = src/index.tsx 실 번들 → Miniflare(workerd) + 실제 D1(SQLite, migrations/ 전부 적용) + 실제 R2.
 *   클라 = 01_State.js · 01b_PinSeries.js · 20_App.js · 31_Projects.js · 02_PDF.js 실 소스를 사람 수만큼 vm 에 올린다.
 *          네트워크는 fetch → mf.dispatchFetch 로 **실 HTTP 핸들러**까지 간다(응답 가공 0).
 *   대체한 경계(브라우저 전용 리프 I/O 뿐): DOM(프록시 스텁) · IndexedDB(SyncQueue 메모리) ·
 *     pdf.js 캔버스 렌더(PDF.load/snapshotAllPages → 자리표시 이미지 + pdf-lib 로 잰 실제 페이지 크기).
 *     벡터 복사(PDF.copyRegionToPdf)는 실 코드 + 실 pdf-lib.
 *
 * B4(H3 번호 중복)는 WO 20260930-numdup(전원 기준 채번 + 병합 재채번)으로 고쳐 EXIT 에 포함한다.
 *   B5(H4)·C3 는 WP3(0030 deployments.project_id · projects.original_deployment_id)로 고쳐 EXIT 에 포함한다.
 *   EXIT 는 A(H7)·B1·B2·B3·B4·B5·C1·C2·C3·C4 로 정한다.
 * 뮤테이션: P93_APP_SRC=<변형 20_App.js> / P93_SERIES_SRC=<변형 01b_PinSeries.js> 로 주입
 *   (예: HEAD 의 크롭 변환 저장 → H7 FAIL · author 필터 복원/재채번 제거 → B4 FAIL → EXIT=1).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { Miniflare } from "miniflare";
import * as PDFLib from "pdf-lib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const SRC = {
  state: rd("public/js/modules/01_State.js"),
  series: process.env.P93_SERIES_SRC ? fs.readFileSync(process.env.P93_SERIES_SRC, "utf8").replace(/\r\n/g, "\n") : rd("public/js/modules/01b_PinSeries.js"),
  pdf: rd("public/js/modules/02_PDF.js"),
  map: rd("public/js/modules/10_MapCtrl.js"),
  app: process.env.P93_APP_SRC ? fs.readFileSync(process.env.P93_APP_SRC, "utf8").replace(/\r\n/g, "\n") : rd("public/js/modules/20_App.js"),
  proj: rd("public/js/modules/31_Projects.js"),
  vendorPdfLib: rd("public/vendor/pdf-lib.min.js"),
};

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };
const measure = (cond, label) => console.log((cond ? "  [MEASURE ok]   " : "  [MEASURE 결함] ") + label);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idsOf = (arr) => (arr || []).filter((p) => p && !p._deleted).map((p) => String(p.id)).sort();

/* ══ 서버: 실 워커 + 실 D1 + 실 R2 ══ */
const MIG_DIR = path.join(ROOT, "migrations");
const MIGS = fs.readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
const stmtsOf = (file) => fs.readFileSync(path.join(MIG_DIR, file), "utf8").replace(/--[^\n]*/g, "")
  .split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
const workerOut = path.join(os.tmpdir(), "p93-worker-" + process.pid + ".mjs");
await esbuild.build({
  entryPoints: [path.join(ROOT, "src/index.tsx")], bundle: true, format: "esm", platform: "neutral",
  outfile: workerOut, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
  conditions: ["workerd", "worker", "browser"],
});
const mf = new Miniflare({
  modules: true, scriptPath: workerOut, d1Databases: { DB: "p93-" + Date.now() },
  r2Buckets: { R2: "p93r2-" + Date.now() }, bindings: { DEMO_LOGIN: "0" }, compatibilityDate: "2025-01-01",
});
const BASE = "http://p93.test";
const db = await mf.getD1Database("DB");
for (const f of MIGS) for (const st of stmtsOf(f)) await db.exec(st);

const USERS = { a: "alice@seastar.test", b: "bruno@seastar.test", c: "chloe@seastar.test", bob: "bob@outside.test", carol: "carol@outside.test" };
const TOK = (k) => "local-p93-" + k;
{
  const now = Date.now();
  const run = (q, a) => db.prepare(q).bind(...a).run();
  for (const k of Object.keys(USERS)) {
    const email = USERS[k];
    if (["a", "b", "c"].includes(k)) await run("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)", [email, k, "designssir@gmail.com", now, now]);
    await run("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)", [email, k, email.split("@")[1], "x", "y", now, now]);
    await run("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOK(k), email, now, now + 8.64e7]);
  }
  for (const pid of ["prj_A", "prj_B", "prj_C"]) {
    await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)", [pid, pid, "", USERS.a, now, now]);
    // [WO 20261009-readacl] 읽기 SoT = 소유·멤버 프로젝트만 → 같은 도면을 동시 편집하는 동료 디자이너 b·c 는 designer 멤버여야 한다
    //   (종전엔 전역 디자이너면 남의 프로젝트도 읽혔다 — 감사 H1 결함). 외부인 거부는 B5(bob·carol)가 따로 검증한다.
    for (const k of ["b", "c"]) await run("INSERT INTO project_members (project_id, email, role, granted_by, created_at) VALUES (?, ?, 'designer', ?, ?)", [pid, USERS[k], USERS.a, now]);
  }
}
const H = (k) => ({ Authorization: "Bearer " + TOK(k), "Content-Type": "application/json" });
const api = async (k, method, url, body) => {
  const r = await mf.dispatchFetch(BASE + url, { method, headers: H(k), body: body == null ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
};
const getDep = async (id) => (await api("a", "GET", "/tables/deployments/" + id)).j;
const srvPins = async (id) => JSON.parse((await getDep(id)).pins || "[]");
const PAGE_URL = "/api/r2/object/assets/p93-base.png";
async function seedDeployment(pins, prj = "prj_A") {
  const d = (await api("a", "POST", "/tables/deployments", { title: "도면", file_name: "GA.pdf", pins: JSON.stringify(pins), pages_data: JSON.stringify([PAGE_URL]), drawing_data: PAGE_URL })).j;
  const deck = (await api("a", "POST", "/api/projects/" + prj + "/decks", { name: "D" + d.id.slice(-5), deployment_id: d.id, page: 1 })).j;
  return { depId: d.id, deck };
}

/* ══ 클라이언트: 실 모듈을 사람마다 독립 realm 에 ══ */
function anyEl() {
  const store = {};
  const fn = function () { return proxy; };
  const proxy = new Proxy(fn, {
    get(t, k) { if (k in store) return store[k]; if (k === Symbol.toPrimitive) return () => ""; if (k === "then") return undefined; if (k === "contains") return () => false; return proxy; },
    set(t, k, v) { store[k] = v; return true; },
    apply() { return proxy; },
  });
  return proxy;
}
const PNG1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
async function pdfDims(bytes) {
  const d = await PDFLib.PDFDocument.load(new Uint8Array(bytes));
  return d.getPages().map((p) => { const { width, height } = p.getSize(); return { w: Math.round(width), h: Math.round(height), pw: Math.round(width), ph: Math.round(height) }; });
}

function makeClient(k) {
  const email = USERS[k];
  const els = {};
  const img = () => ({ _src: "", onload: null, onerror: null, complete: false, naturalWidth: 0, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, set src(v) { this._src = v; }, get src() { return this._src; } });
  const document = {
    getElementById: (id) => (els[id] = els[id] || (id === "map-image" ? img() : anyEl())),
    querySelector: () => null, querySelectorAll: () => [], createElement: () => anyEl(),
    body: anyEl(), documentElement: anyEl(), addEventListener() {},
    visibilityState: "visible", activeElement: null,   // [D4] 폴링 가드가 읽는 브라우저 상태(테스트가 바꿔 끼운다)
  };
  const drafts = {}, ls = {}, net = [];
  const nav = { onLine: true, userAgent: "node" };
  const fetchShim = async (url, init = {}) => {
    if (typeof url === "string" && url.startsWith("data:")) return fetch(url);
    if (!nav.onLine) throw new TypeError("Failed to fetch (offline)");
    const rec = { k, method: (init.method || "GET").toUpperCase(), url: String(url) };
    net.push(rec);
    const r = await mf.dispatchFetch(String(url).startsWith("http") ? url : BASE + url, init);
    rec.status = r.status;
    return r;
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    document, navigator: nav, location: { search: "", origin: BASE, pathname: "/", href: BASE + "/" },
    localStorage: { getItem: (x) => (x in ls ? ls[x] : null), setItem: (x, v) => { ls[x] = String(v); }, removeItem: (x) => { delete ls[x]; } },
    UI: { $: (id) => document.getElementById(id), text() {}, toggle() {}, hide() {}, show() {}, showScreen() {},
      renderPinsOnMap() {}, renderPinList() {}, updatePdfPagination() {}, escapeHtml: (s) => String(s) },
    SyncQueue: {
      loadDraft: async (x) => (drafts[x] ? JSON.parse(JSON.stringify(drafts[x])) : null),
      saveDraft: async (x, d) => { drafts[x] = JSON.parse(JSON.stringify(d)); },
      allDraftKeys: async () => Object.keys(drafts),
      count: async () => 0,
    },
    Auth: { headers: () => H(k), r2: (u) => u, isDesigner: true, isAdmin: false, readonly: false, user: { email }, idToken: TOK(k) },
    Prompt: { toast() {}, confirm: async () => true, ask: async () => null },
    OpLog: { recordCurrent: async () => {}, record: async () => {} },
    persistLocalDeployment: async () => {},
    _revokeVideoBlob() {}, _revokeAllVideoBlobs() {},
    Zones: { refreshPinLinks() {}, render() {}, renderList() {} },
    Log: { push() {} },
    fetch: fetchShim, Blob, Headers, URL, URLSearchParams, AbortController, TextEncoder, TextDecoder, atob, btoa,
    setTimeout: (f, ms) => (ms && ms >= 500 ? 0 : setTimeout(f, ms)), clearTimeout, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: (f) => setTimeout(f, 0), performance: { now: () => Date.now() },
  };
  sandbox.window = sandbox; sandbox.addEventListener = () => {}; sandbox.removeEventListener = () => {};
  vm.createContext(sandbox);
  // 벤더링한 public/vendor/pdf-lib.min.js 그 파일을 같은 realm 에(앱과 같은 조합 — p74 와 동일)
  for (const s of [SRC.vendorPdfLib, SRC.state, SRC.series, SRC.pdf, SRC.map, SRC.app, SRC.proj]) vm.runInContext(s, sandbox);
  vm.runInContext("globalThis.__X = { State, PinSeries, PDF, MapCtrl, App, Projects };", sandbox);
  const { State, App, Projects, PDF, MapCtrl } = sandbox.__X;
  // 경계: 화면 변환(DOM) — 좌표 순수함수(pageToDeckCropPct 등)는 실 MapCtrl 그대로
  for (const f of ["applyTransform", "fit", "fitZone", "setCropBoundary"]) MapCtrl[f] = () => {};
  State.mode = "designer"; State.regMode = "checkboard";
  // 경계: pdf.js 캔버스 렌더(브라우저 전용) — 자리표시 이미지 + pdf-lib 로 잰 실제 페이지 크기
  PDF.load = async (bytes) => ({ numPages: 1, __bytes: bytes, destroy() {} });
  PDF.snapshotAllPages = async (doc) => { PDF.lastSnapshotDims = await pdfDims(doc.__bytes); return PDF.lastSnapshotDims.map(() => PNG1); };
  PDF.setDeckCrop = () => null;
  // realm 어댑터(브라우저는 단일 realm): 바깥 realm 의 바이트(fetch 응답 등)를 vm realm Uint8Array 로 옮긴다
  const U8 = vm.runInContext("Uint8Array", sandbox), rawCopy = PDF.copyRegionToPdf;
  PDF.copyRegionToPdf = function (b, ...rest) { return rawCopy.call(this, new U8(new Uint8Array(b)), ...rest); };
  sandbox.__U8 = U8;
  // 경계: 표시/인디케이터(DOM)
  App._setSaveIndicator = () => {}; App._updateSaveBtn = () => {}; App._markDeckUnsaved = () => {};
  App._closePinForm = () => {}; App._updateCheckboardQuickStatus = () => {};
  Projects._renderDecks = () => {};
  return { k, sandbox, State, App, Projects, PDF, nav, net, drafts };
}
async function open(c, depId, deck, prj = "prj_A") {
  c.Projects.currentProject = { id: prj, name: prj };
  c.Projects.currentDeck = deck;
  await c.App.loadDeckDrawing(depId);
  if (c.State.autoSaveDepId !== depId) throw new Error(c.k + " 로드 실패(autoSaveDepId=" + c.State.autoSaveDepId + ")");
}
async function place(c, x, y) {
  await sleep(3);   // 사람 손 간격(핀 id = Date.now() — 같은 ms 충돌은 이 테스트의 대상이 아님)
  c.App._placeCheckboardPin({ x, y });
  return c.State.pins[c.State.pins.length - 1];
}
const save = (c) => c.App._saveNow({ now: true });
const P = (id, x = 50, y = 50, extra = {}) => Object.assign({ id, x, y, page: 1, label: String(id) }, extra);

/* ══════════ B1 — 3명 동시 핀 추가 → 합집합 ══════════ */
console.log("\n[B1] 디자이너 3명이 같은 배포본에 동시에 핀 추가");
{
  const { depId, deck } = await seedDeployment([P(1000)]);
  const cs = ["a", "b", "c"].map(makeClient);
  for (const c of cs) await open(c, depId, deck);
  const mine = [];
  for (const [i, c] of cs.entries()) mine.push(String((await place(c, 10 + i * 20, 30)).id));
  const r1 = await Promise.all(cs.map(save));
  const after1 = idsOf(await srvPins(depId));
  const st = cs.flatMap((c) => c.net.filter((n) => n.method === "PATCH").map((n) => n.status));
  const retry = [];
  for (const [i, c] of cs.entries()) if (!r1[i]) retry.push(await save(c));
  const fin = idsOf(await srvPins(depId));
  const want = ["1000", ...mine].sort();
  console.log("   측정: 1차 저장 결과=" + JSON.stringify(r1) + " PATCH 상태=" + JSON.stringify(st) + " 1차 후 서버=" + after1.length + "개 · 재시도=" + JSON.stringify(retry) + " 최종=" + fin.length + "개");
  ok(JSON.stringify(fin) === JSON.stringify(want), "B1 최종 서버 핀 = 3명 합집합 + 기존 1 (유실 0) — " + JSON.stringify(fin));
  ok(st.includes(409), "B1 동시 저장에서 409 가 실제로 발생하고 병합 경로를 탔다");
  measure(JSON.stringify(after1) === JSON.stringify(want), "B1 1차 동시 저장만으로 합집합 달성(재시도 없이) — 1차 후 " + after1.length + "/" + want.length);
}

/* ══════════ B2 — A 가 X 삭제 · 동시에 B 가 Y 추가 → X 부활 0, Y 보존 ══════════ */
console.log("\n[B2] A 가 핀 X 삭제, 같은 시각 B 가 다른 핀 추가 (+ 낡은 화면의 C 가 뒤이어 저장)");
{
  const X = 2001, W = 2002;
  const { depId, deck } = await seedDeployment([P(X), P(W, 60, 60)]);
  const [A, B, C] = ["a", "b", "c"].map(makeClient);
  for (const c of [A, B, C]) await open(c, depId, deck);
  A.App._removePins([X]);
  const Y = String((await place(B, 20, 20)).id);
  const r = await Promise.all([save(A), save(B)]);
  for (const [i, c] of [A, B].entries()) if (!r[i]) await save(c);
  const Q = String((await place(C, 80, 80)).id);   // C 는 X 가 살아있던 버전을 들고 있다
  await save(C);
  const fin = idsOf(await srvPins(depId));
  console.log("   측정: 저장=" + JSON.stringify(r) + " 최종=" + JSON.stringify(fin));
  ok(!fin.includes(String(X)), "B2 X 부활 0 (A 삭제 · B 동시 저장 · 낡은 C 저장 후에도)");
  ok(fin.includes(Y) && fin.includes(Q) && fin.includes(String(W)), "B2 B 의 Y · C 의 Q · 기존 W 보존");
}

/* ══════════ B3 — C 오프라인 추가2·삭제1 → 복귀 flush, A 의 온라인 변경 보존 ══════════ */
console.log("\n[B3] C 오프라인 작업(추가 2 · 삭제 1) 후 복귀 → _flushDirtyDrafts");
{
  const K1 = 3001, K2 = 3002;
  const { depId, deck } = await seedDeployment([P(K1), P(K2, 60, 60)]);
  const [A, C] = ["a", "c"].map(makeClient);
  for (const c of [A, C]) await open(c, depId, deck);
  C.nav.onLine = false;
  const c1 = String((await place(C, 11, 11)).id), c2 = String((await place(C, 12, 12)).id);
  C.App._removePins([K1]);
  await C.App._saveDraftLocal();          // _autoSave 가 하는 로컬 보관(비차단 호출을 기다린 것)
  const offSave = await save(C);           // 오프라인에서 누른 저장 → 실패(로컬 보관)
  const Z = String((await place(A, 70, 70)).id);
  const aOk = await save(A);
  C.nav.onLine = true;
  await C.App._flushDirtyDrafts();
  const fin = idsOf(await srvPins(depId));
  const dirtyLeft = Object.values(C.drafts).filter((d) => d && d.dirty).length;
  console.log("   측정: 오프라인 저장=" + offSave + " A 저장=" + aOk + " 최종=" + JSON.stringify(fin) + " 남은 dirty draft=" + dirtyLeft);
  ok(fin.includes(c1) && fin.includes(c2), "B3 C 의 오프라인 추가 2개 서버 반영");
  ok(!fin.includes(String(K1)), "B3 C 의 오프라인 삭제(K1) 서버 반영");
  ok(fin.includes(Z) && fin.includes(String(K2)), "B3 A 의 온라인 추가(Z)·기존 K2 보존");
  ok(dirtyLeft === 0, "B3 flush 후 dirty draft 0");
}

/* ══════════ B4 — 번호 중복(H3) · WO 20260930-numdup 로 고쳐 EXIT 포함 ══════════ */
console.log("\n[B4] 대역 설정 없이 동시에 체크보드 핀 → 번호 중복 0 (2명 · 로드 후 · 3명 · 오프라인 복귀 · 수동 번호 보존)");
const dupLabels = (pins) => { const seen = new Set(), d = []; (pins || []).filter((p) => p && !p._deleted && p.checkboard).forEach((p) => { const k = (p.page || 1) + "|" + p.label; if (seen.has(k)) d.push(p.label); seen.add(k); }); return d; };
const toastLog = (c) => { const t = []; c.sandbox.Prompt.toast = (m) => t.push(String(m)); return t; };
const numdupToasts = (...logs) => logs.flat().filter((m) => /조정\(동시 생성\)/.test(m));
const saveAll = async (cs) => { let r = await Promise.all(cs.map(save)); for (let round = 0; round < 3 && r.includes(false); round++) r = await Promise.all(cs.map((c, i) => (r[i] ? true : save(c)))); return r; };
{
  // B4-a 두 사람이 서로 보기 전에 동시 생성 → 409 병합에서 나중 핀 재채번
  const { depId, deck } = await seedDeployment([]);
  const [A, B] = ["a", "b"].map(makeClient);
  for (const c of [A, B]) await open(c, depId, deck);
  const ta = toastLog(A), tb = toastLog(B);
  const pa = await place(A, 10, 10), pb = await place(B, 20, 20);
  const la = pa.label, lb = pb.label;
  const r = await saveAll([A, B]);
  const srv = await srvPins(depId);
  const lab = new Map(srv.map((p) => [String(p.id), p.label]));
  const B2c = makeClient("b"); await open(B2c, depId, deck);
  const lb2 = (await place(B2c, 30, 30)).label;
  const nt = numdupToasts(ta, tb);
  console.log("   측정: 생성 A=" + la + " B=" + lb + " 저장=" + JSON.stringify(r) + " → 서버 A=" + lab.get(String(pa.id)) + " B=" + lab.get(String(pb.id)) + " · 재로드 후 다음=" + lb2 + " · 토스트=" + JSON.stringify(nt));
  ok(srv.length === 2 && dupLabels(srv).length === 0, "B4 2명 동시 생성 → 서버 번호 중복 0 — " + JSON.stringify(srv.map((p) => p.label)));
  ok(lab.get(String(pa.id)) === "1" && lab.get(String(pb.id)) === "2", "B4 먼저 만든 A 가 1 유지 · 나중 B 가 2 로 재채번");
  ok(lb2 === "3", "B4 재로드 후 다음 번호 = 전원 최댓값+1 = 3 — " + lb2);
  ok(nt.length === 1 && nt[0].includes("1 → 2"), "B4 재채번 토스트 1회(번호 1 → 2) — " + JSON.stringify(nt));
}
{
  // B4-b 남의 핀만 있는 도면을 로드한 뒤 내 첫 핀 — author 필터면 1(중복), 전원 기준이면 3
  const mk = (id, lbl) => ({ id, x: 10, y: 10, page: 1, label: lbl, checkboard: true, author: USERS.a, createdAt: id });
  const { depId, deck } = await seedDeployment([mk(1700000000001, "1"), mk(1700000000002, "2")]);
  const B = makeClient("b"); await open(B, depId, deck);
  const lb = (await place(B, 40, 40)).label;
  await save(B);
  const srv = await srvPins(depId);
  console.log("   측정: A 의 1·2 로드 후 B 첫 핀=" + lb + " 서버=" + JSON.stringify(srv.map((p) => p.label)));
  ok(lb === "3" && dupLabels(srv).length === 0, "B4 남의 핀(1·2)을 로드한 뒤 B 의 번호 = 3, 서버 중복 0 — " + lb);
}
{
  // B4-c 3명 동시 → 전원 한 번 더(낡은 화면) 추가·저장 → 중복 0 · 이미 정해진 번호 흔들림 0
  const { depId, deck } = await seedDeployment([]);
  const cs = ["a", "b", "c"].map(makeClient);
  for (const c of cs) await open(c, depId, deck);
  const first = [];
  for (const c of cs) first.push(String((await place(c, 10 + first.length * 20, 50)).id));
  // 가장 나중에 만든 C 가 먼저 저장 → 뒤이어 병합하는 B·A 가 "남의(서버에 있는) 핀"을 재채번하게 된다
  const r1 = [];
  for (const c of [...cs].reverse()) r1.push(await save(c));
  const s1 = await srvPins(depId);
  const lab1 = JSON.stringify(first.map((id) => (s1.find((p) => String(p.id) === id) || {}).label));
  for (const [i, c] of cs.entries()) { await place(c, 15 + i * 20, 70); await save(c); }
  const s2 = await srvPins(depId);
  const lab2 = JSON.stringify(first.map((id) => (s2.find((p) => String(p.id) === id) || {}).label));
  console.log("   측정: 1차 저장=" + JSON.stringify(r1) + " 1차 번호=" + lab1 + " → 2차 후 같은 핀 번호=" + lab2 + " 서버 전체=" + JSON.stringify(s2.map((p) => p.label)));
  ok(s1.length === 3 && dupLabels(s1).length === 0, "B4 3명 동시 생성 → 서버 중복 0 — " + JSON.stringify(s1.map((p) => p.label)));
  ok(s2.length === 6 && dupLabels(s2).length === 0, "B4 낡은 화면 3명이 이어서 추가·저장 → 6개 · 중복 0 — " + JSON.stringify(s2.map((p) => p.label)));
  ok(lab1 === lab2, "B4 이미 정해진 번호가 낡은 화면 병합으로 다시 바뀌지 않음(흔들림 0) — " + lab1 + " vs " + lab2);
}
{
  // B4-d 오프라인 복귀 flush 병합
  const { depId, deck } = await seedDeployment([]);
  const [A, C] = ["a", "c"].map(makeClient);
  for (const c of [A, C]) await open(c, depId, deck);
  C.nav.onLine = false;
  const c1 = await place(C, 11, 11), c2 = await place(C, 12, 12);
  await C.App._saveDraftLocal();
  const pa = await place(A, 70, 70);
  await save(A);
  C.nav.onLine = true;
  await C.App._flushDirtyDrafts();
  const srv = await srvPins(depId);
  const lab = (p) => (srv.find((q) => String(q.id) === String(p.id)) || {}).label;
  console.log("   측정: 오프라인 C=" + c1.label + "," + c2.label + " 온라인 A=" + pa.label + " → 서버 C=" + lab(c1) + "," + lab(c2) + " A=" + lab(pa));
  ok(srv.length === 3 && dupLabels(srv).length === 0, "B4 오프라인 복귀 병합 → 3개 · 중복 0 — " + JSON.stringify(srv.map((p) => p.label)));
  ok(lab(c1) === "1" && lab(c2) === "2" && lab(pa) === "3", "B4 먼저 만든 C 의 1·2 유지 · 나중 A 가 3 으로");
}
{
  // B4-e 수동 번호 보존 — 수동 vs 자동이면 자동이 옮기고, 수동끼리는 그대로 두고 중복 표시
  const { depId, deck } = await seedDeployment([]);
  const [A, B] = ["a", "b"].map(makeClient);
  for (const c of [A, B]) await open(c, depId, deck);
  const manual = (p, v) => { p.label = v; p.labelManual = true; };   // 27_PinActionPop._saveLabel 이 하는 일
  const a1 = await place(A, 10, 10); manual(a1, "5");
  B.App._setCheckboardStart(1, 9);                                     // B 대역 9 → 자동 9
  const b1 = await place(B, 20, 20), b1auto = b1.label;
  const a2 = await place(A, 30, 30); manual(a2, "9");                  // 나중에 만든 수동 9
  const b2 = await place(B, 40, 40); manual(b2, "5");                  // 수동 5 끼리 충돌
  await saveAll([A, B]);
  const srv = await srvPins(depId);
  const lab = (p) => (srv.find((q) => String(q.id) === String(p.id)) || {}).label;
  const dupIds = [...A.sandbox.__X.PinSeries.duplicateCheckboardIds(srv, 1)].map(String).sort();
  console.log("   측정: b1 자동=" + b1auto +" → 서버 a1=" + lab(a1) + " a2=" + lab(a2) + " b1=" + lab(b1) + " b2=" + lab(b2) + " 중복표시=" + JSON.stringify(dupIds));
  ok(lab(a1) === "5" && lab(a2) === "9" && lab(b2) === "5", "B4 수동 번호(5·9·5) 전부 보존");
  ok(b1auto === "9" && lab(b1) !== "9" && lab(b1) !== "5", "B4 수동 9 와 겹친 자동 9(먼저 만들었어도) 는 재채번 — " + lab(b1));
  ok(JSON.stringify(dupIds) === JSON.stringify([String(a1.id), String(b2.id)].sort()), "B4 수동끼리 겹친 5 는 재채번 없이 duplicateCheckboardIds 로 표시");
}
/* [WO 20261001-startno] 100 단위 대역 — 실 서버 병합(409)에서도 재채번이 대역 안에 머무는가 */
{
  // B4-f 같은 대역(101–200) 두 사람 동시 생성 → 나중 핀이 대역 안 다음 번호(102)
  const { depId, deck } = await seedDeployment([]);
  const [A, B] = ["a", "b"].map(makeClient);
  for (const c of [A, B]) { await open(c, depId, deck); c.App._setNumBand(2); }
  const ta = toastLog(A), tb = toastLog(B);
  const pa = await place(A, 10, 10), pb = await place(B, 20, 20);
  const la = pa.label, lb = pb.label;
  await saveAll([A, B]);
  const srv = await srvPins(depId);
  const lab = (p) => (srv.find((q) => String(q.id) === String(p.id)) || {}).label;
  console.log("   측정(B4-f 같은 대역): 생성 A=" + la + " B=" + lb + " → 서버 A=" + lab(pa) + " B=" + lab(pb) + " 토스트=" + JSON.stringify(numdupToasts(ta, tb)));
  ok(la === "101" && lb === "101" && lab(pa) === "101" && lab(pb) === "102", "B4-f 같은 대역 동시 생성 101·101 → 서버 101·102(대역 안 다음 번호, 1–100 으로 안 내려감)");
}
{
  // B4-g 다른 대역(A=101–200, B=201–300) 동시 생성 → 재채번 0 · 토스트 0
  const { depId, deck } = await seedDeployment([]);
  const [A, B] = ["a", "b"].map(makeClient);
  for (const c of [A, B]) await open(c, depId, deck);
  A.App._setNumBand(2); B.App._setNumBand(3);
  const ta = toastLog(A), tb = toastLog(B);
  const pa = await place(A, 10, 10), pb = await place(B, 20, 20);
  await saveAll([A, B]);
  const srv = await srvPins(depId);
  const lab = (p) => (srv.find((q) => String(q.id) === String(p.id)) || {}).label;
  console.log("   측정(B4-g 다른 대역): 서버 A=" + lab(pa) + " B=" + lab(pb) + " 토스트=" + JSON.stringify(numdupToasts(ta, tb)));
  ok(lab(pa) === "101" && lab(pb) === "201" && numdupToasts(ta, tb).length === 0, "B4-g 다른 대역 동시 생성 → 101·201 그대로 · 재채번 0");
}
{
  // B4-h 360 계열도 같은 대역 동시 → 101·102(P101·P102) · CHECKER 번호와 독립
  const { depId, deck } = await seedDeployment([]);
  const [A, B] = ["a", "b"].map(makeClient);
  for (const c of [A, B]) { await open(c, depId, deck); c.App._setNumBand(2); }
  const ac = await place(A, 5, 5);                       // CHECKER 101
  for (const c of [A, B]) c.State.regMode = "photo";
  const pa = await place(A, 10, 10), pb = await place(B, 20, 20);
  await saveAll([A, B]);
  const srv = await srvPins(depId);
  const lab = (p) => (srv.find((q) => String(q.id) === String(p.id)) || {}).label;
  console.log("   측정(B4-h 360): CHECKER=" + lab(ac) + " 360 A=" + lab(pa) + " B=" + lab(pb) + " 계열=" + JSON.stringify(srv.map((p) => (p.checkboard ? "C" : "P") + p.label)));
  ok(lab(ac) === "101" && lab(pa) === "101" && lab(pb) === "102" && !srv.find((p) => String(p.id) === String(pb.id)).checkboard,
    "B4-h 360 같은 대역 동시 → P101·P102 · CHECKER 101 과 독립");
}

/* ══════════ B5 — 초대 권한(H4) · WP3: 배포본 project_id 기준 프로젝트 단위 쓰기 권한 ══════════ */
console.log("\n[B5] prj_B 에만 초대된 사람이 prj_A 배포본을 쓸 수 있나 (WP3 — 이제 EXIT 에 포함)");
{
  const d = (await api("a", "POST", "/tables/deployments", { title: "도면", file_name: "GA.pdf", project_id: "prj_A", pins: JSON.stringify([P(5001)]), pages_data: JSON.stringify([PAGE_URL]), drawing_data: PAGE_URL })).j;
  const depId = d.id;
  ok(d.project_id === "prj_A", "B5 POST 가 project_id 를 기록 — " + d.project_id);
  const pre = await api("bob", "PATCH", "/tables/deployments/" + depId, { pins: "[]" });
  const inv = await api("a", "POST", "/api/projects/prj_B/members", { email: USERS.bob, role: "designer" });
  const invV = await api("a", "POST", "/api/projects/prj_B/members", { email: USERS.carol, role: "viewer" });
  const post = await api("bob", "PATCH", "/tables/deployments/" + depId, { pins: "[]" });
  const bOps = await api("bob", "POST", "/tables/deployments/" + depId + "/ops", { ops: [{ opId: "op-p93-b5", entity: "pin", action: "delete", id: 5001, ts: Date.now() }] });
  const bDel = await api("bob", "DELETE", "/tables/deployments/" + depId);
  const bHijack = await api("bob", "POST", "/tables/deployments", { title: "x", project_id: "prj_A", original: true });
  const pinsAfter = idsOf(await srvPins(depId));
  const alive = (await getDep(depId)).deleted === false;
  const carol = await api("carol", "PATCH", "/tables/deployments/" + depId, { pins: "[]" });
  console.log("   측정: 초대 전 bob PATCH=" + pre.status + " · 초대(designer)=" + inv.status + " · 초대 후 bob PATCH=" + post.status + " ops=" + bOps.status + " DELETE=" + bDel.status + " POST(prj_A)=" + bHijack.status + " → prj_A 핀=" + JSON.stringify(pinsAfter) + " alive=" + alive + " · viewer 초대(carol)=" + invV.status + " → PATCH=" + carol.status);
  ok(pre.status === 403, "B5 대조군: 초대 전 외부인 PATCH 거부 — " + pre.status);
  ok(post.status === 403 && bOps.status === 403 && bDel.status === 403, "B5 prj_B 초대(designer)만 받은 사람의 prj_A 배포본 PATCH/ops/DELETE 거부 — " + [post.status, bOps.status, bDel.status]);
  ok(bHijack.status === 403, "B5 남의 프로젝트(prj_A)로 배포본 생성 거부 — " + bHijack.status);
  ok(JSON.stringify(pinsAfter) === '["5001"]' && alive, "B5 거부 후 prj_A 배포본 핀·행 무변경 — " + JSON.stringify(pinsAfter));
  ok(carol.status === 403, "B5 viewer 초대자의 PATCH 거부 — " + carol.status);
  // 같은 프로젝트 designer 멤버 → 허용(잠금 사고 없음)
  const invA = await api("a", "POST", "/api/projects/prj_A/members", { email: USERS.b, role: "designer" });
  const cur = await getDep(depId);
  const mem = await api("b", "PATCH", "/tables/deployments/" + depId, { base_version: cur.version, pins: JSON.stringify([P(5001), P(5002)]) });
  const own = await api("a", "PATCH", "/tables/deployments/" + depId, { pins: JSON.stringify([P(5001), P(5002), P(5003)]) });
  ok(invA.status === 200 && mem.status === 200 && own.status === 200, "B5 같은 프로젝트 designer 멤버·소유자 PATCH 허용 — 초대=" + invA.status + " 멤버=" + mem.status + " 소유자=" + own.status);
  // 레거시(project_id NULL) → 종전 규칙(전역 designer 면 허용) 유지
  const leg = await seedDeployment([P(5101)]);
  const legRow = await getDep(leg.depId);
  const legP = await api("bob", "PATCH", "/tables/deployments/" + leg.depId, { pins: JSON.stringify([P(5101), P(5102)]) });
  ok(legRow.project_id == null && legP.status === 200, "B5 레거시 NULL 행은 현행 유지(전역 designer PATCH 200) — project_id=" + legRow.project_id + " status=" + legP.status);
  // 삭제된 프로젝트의 배포본 → 409 (소유자라도)
  await db.prepare("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES ('prj_DEL','prj_DEL','',?,0,0,0)").bind(USERS.a).run();
  const dd = (await api("a", "POST", "/tables/deployments", { title: "del", project_id: "prj_DEL", pins: "[]" })).j;
  const pdel = await api("a", "DELETE", "/api/projects/prj_DEL");
  const wDel = await api("a", "PATCH", "/tables/deployments/" + dd.id, { pins: JSON.stringify([P(5201)]) });
  const oDel = await api("a", "POST", "/tables/deployments/" + dd.id + "/ops", { ops: [{ opId: "op-p93-b5d", entity: "pin", action: "upsert", id: 5202, data: { x: 1, y: 1 }, ts: Date.now() }] });
  ok(pdel.status === 200 && wDel.status === 409 && oDel.status === 409, "B5 삭제된 프로젝트의 배포본 쓰기 409 — 삭제=" + pdel.status + " PATCH=" + wDel.status + " ops=" + oDel.status);
}

/* ══════════ C — 전체 도면 등록 → 구역(벡터 복사) → 영역 ══════════ */
console.log("\n[C] 전체 도면 등록 → 구역 설정(벡터 복사) → 영역 설정");
const SRC_W = 1000, SRC_H = 500;
const srcBytes = await (async () => {
  const d = await PDFLib.PDFDocument.create();
  const font = await d.embedFont(PDFLib.StandardFonts.Helvetica);
  const p = d.addPage([SRC_W, SRC_H]);
  for (let x = 20; x < SRC_W; x += 60) for (let y = 20; y < SRC_H; y += 40) p.drawText("G" + x + "_" + y, { x, y, size: 6, font });
  return await d.save();
})();
const CROP = { x: 10, y: 20, w: 40, h: 30 };      // % — 400pt × 150pt → 비율 2.667
const CROP2 = { x: 25, y: 25, w: 50, h: 50 };     // 구역(새 페이지) 안에서 다시 지정하는 영역
const A = makeClient("a");
A.Projects.currentProject = { id: "prj_C", name: "prj_C" };
A.Projects.currentDeck = null;
A.Projects.decks = [];
A.State.reset(); A.State.mode = "designer"; A.State.regMode = "checkboard";
A.State.fileType = "pdf"; A.State.fileName = "GA.pdf"; A.State.fileData = new A.sandbox.__U8(srcBytes).buffer;
A.State.pdfDoc = { numPages: 1, __bytes: srcBytes }; A.State.pdfPage = 1; A.State.pdfPages = 1;
await A.App._createInitialSave();                        // 도면 등록(구역 없이 — p64 규칙)
const ORIG = A.State.autoSaveDepId;
ok(!!ORIG, "C0 전체 도면 등록 → 배포본 생성 " + ORIG);
await place(A, 20, 30);  // 크롭 안
await place(A, 80, 80);  // 크롭 밖
await place(A, 5, 90);   // 크롭 밖
ok(await save(A), "C0 원본에 핀 3개 저장");
const snap = async (id) => { const d = await getDep(id); return { pins: d.pins, pages: d.pages_data, src: d.source_meta, ver: d.version }; };
const orig0 = await snap(ORIG);
ok(JSON.parse(orig0.pins).length === 3 && !!JSON.parse(orig0.src || "null"), "C0 원본 행: 핀 3 · source_meta(원본 PDF) 있음");

const zone = await A.Projects.createDeckFromLoadedDrawing({ crop: CROP, name: "Main Deck" });
{
  console.log("\n[C1] 구역 = 새 배포본(새 페이지) · 잘린 부분만");
  ok(!!zone && !!zone.deployment_id && zone.deployment_id !== ORIG, "C1 구역 배포본 id ≠ 원본 — " + (zone && zone.deployment_id) + " vs " + ORIG);
  ok(!!zone && zone.crop == null && zone.parent_id == null, "C1 구역은 crop 없음(창 아님)·루트 — crop=" + JSON.stringify(zone && zone.crop));
  const cp = zone ? await getDep(zone.deployment_id) : null;
  const meta = cp ? JSON.parse(cp.source_meta || "null") : null;
  let ratio = null, pages = null;
  if (meta && meta.pdf_url) {
    const r = await mf.dispatchFetch(BASE + meta.pdf_url, { headers: H("a") });
    const doc = await PDFLib.PDFDocument.load(new Uint8Array(await r.arrayBuffer()));
    pages = doc.getPageCount();
    const pg = doc.getPage(0), mb = pg.getMediaBox();
    ratio = mb.width / mb.height;
  }
  const want = (CROP.w * SRC_W) / (CROP.h * SRC_H);
  console.log("   측정: 새 PDF 쪽수=" + pages + " 가로/세로=" + (ratio && ratio.toFixed(4)) + " 기대(크롭)=" + want.toFixed(4) + " pages_data=" + (cp && JSON.parse(cp.pages_data || "[]").length));
  ok(pages === 1 && ratio != null && Math.abs(ratio - want) < 1e-3, "C1 새 페이지 비율 = 크롭 비율(" + want.toFixed(4) + ")");
}
{
  console.log("\n[C2] 원본 배포본 그대로");
  const o = await snap(ORIG);
  ok(o.pins === orig0.pins && o.pages === orig0.pages && o.src === orig0.src && o.ver === orig0.ver,
    "C2 구역 생성 전후 원본 pins·pages_data·source_meta·version 동일 (ver " + orig0.ver + "→" + o.ver + ")");
}
let area = null;
{
  console.log("\n[C1'] 구역 안에서 영역 설정");
  A.Projects.currentDeck = zone;
  await A.App.loadDeckDrawing(zone.deployment_id);
  area = await A.Projects.extractRegionAsDeck({ crop: CROP2, name: "영역1" });
  ok(!!area && area.parent_id === zone.id && area.deployment_id && area.deployment_id !== zone.deployment_id && area.deployment_id !== ORIG,
    "C1' 영역 = 구역의 자식 · 또 다른 새 배포본 — parent=" + (area && area.parent_id) + " dep=" + (area && area.deployment_id));
  const o = await snap(ORIG);
  ok(o.pins === orig0.pins && o.ver === orig0.ver, "C2' 영역 생성 후에도 원본 불변");
}
{
  console.log("\n[C4] 구역에서 핀 추가·저장 → 원본 핀 불변");
  A.Projects.currentDeck = zone;
  await A.App.loadDeckDrawing(zone.deployment_id);
  await place(A, 50, 50);
  const s = await save(A);
  const zp = await srvPins(zone.deployment_id);
  const o = await snap(ORIG);
  ok(s && zp.length === 1, "C4 구역 배포본에 핀 저장됨(" + zp.length + ")");
  ok(JSON.parse(o.pins).length === 3 && o.pins === orig0.pins, "C4 원본 핀 3개 그대로");
}
{
  console.log("\n[C3] 트리 최상단 프로젝트 노드 → pickOriginalDeck/openOriginal (WP3 — 이제 EXIT 에 포함)");
  await A.Projects.loadDecks();
  // 서버 기록(재조회) — 클라 로컬 반영(markOriginal)과 별개로 GET /api/projects 가 원본을 돌려주는가
  const srvProj = ((await api("a", "GET", "/api/projects")).j.data || []).find((p) => p.id === "prj_C");
  const zoneRow = await getDep(zone.deployment_id);
  // 새 세션(재접속) 흉내: 서버에서 받은 프로젝트 객체로 교체한 뒤 고른다
  A.Projects.currentProject = srvProj;
  const pick = A.Projects.pickOriginalDeck(A.Projects.decks);
  await A.Projects.openOriginal();
  console.log("   측정: 루트 구역=" + JSON.stringify(A.Projects.decks.filter((d) => d.parent_id == null).map((d) => d.name + ":" + d.deployment_id)) +
    " → pick=" + (pick && pick.deployment_id) + " · openOriginal 후 열린 배포본=" + A.State.autoSaveDepId + " · 원본=" + ORIG +
    " · 서버 original=" + (srvProj && srvProj.original_deployment_id) + " · 구역 복사본 project_id=" + zoneRow.project_id);
  ok(!!srvProj && srvProj.original_deployment_id === ORIG, "C3 서버 projects.original_deployment_id = 처음 등록한 원본(구역 복사본 아님)");
  ok(zoneRow.project_id === "prj_C", "C3 구역 복사본 배포본도 project_id 기록(권한 기준)");
  ok(!!pick && pick.deployment_id === ORIG, "C3 pickOriginalDeck 이 원본 배포본을 고른다");
  ok(A.State.autoSaveDepId === ORIG && A.Projects.currentDeck == null, "C3 openOriginal 이 원본 전체 도면을 연다(구역 없는 프로젝트 단위)");
  // 폴백: 기록 없는 레거시 프로젝트는 종전 규칙(최신 루트 구역)
  const legacyPick = A.Projects.pickOriginalDeck(A.Projects.decks, { id: "prj_C", name: "prj_C" });
  ok(!!legacyPick && legacyPick.deployment_id === zone.deployment_id, "C3 원본 기록 없는 레거시 프로젝트 → 종전 규칙 폴백(최신 루트 구역)");
}

/* ══════════ A(H7) — 창(crop) 구역에서 저장해도 원본 행의 크롭 밖 핀·좌표 보존 ══════════ */
console.log("\n[A·H7] 창(crop) 구역(원본과 같은 배포본)에서 핀 추가·저장");
{
  const win = (await api("a", "POST", "/api/projects/prj_C/decks", { name: "창", page: 1, crop: CROP, deployment_id: ORIG })).j;
  const W = makeClient("a");
  await open(W, ORIG, win, "prj_C");
  const before = JSON.parse((await getDep(ORIG)).pins);
  const np = await place(W, 30, 35);    // 크롭 안(페이지 기준 %)
  const s = await save(W);
  const after = await srvPins(ORIG);
  const keep = before.every((p) => after.some((q) => String(q.id) === String(p.id) && q.x === p.x && q.y === p.y));
  const mineSaved = after.find((q) => String(q.id) === String(np.id));
  console.log("   측정: 저장=" + s + " 전 " + before.length + "개 → 후 " + after.length + "개 · 새 핀 좌표=" + (mineSaved && mineSaved.x + "," + mineSaved.y));
  ok(s && after.length === before.length + 1, "H7 원본 행 핀 수 = 기존 " + before.length + " + 1 (크롭 밖 핀 삭제 0)");
  ok(keep, "H7 기존 핀 좌표 그대로(크롭 기준 재변환 0)");
  ok(!!mineSaved && mineSaved.x === 30 && mineSaved.y === 35, "H7 새 핀은 페이지 기준 % 그대로 저장");
}

/* ══════════ H8 — tombstone 이 섞인 서버본을 로드/병합해도 State 에 섞이지 않고 부활 0 ══════════ */
console.log("\n[H5·H8] /ops 삭제 tombstone 이 남은 배포본 — 로드·병합");
{
  const { depId, deck } = await seedDeployment([P(8001), P(8002, 60, 60)]);
  const [A2, B2] = ["a", "b"].map(makeClient);
  await open(B2, depId, deck);                                  // B 는 8001 이 살아있을 때 연다
  const ops = await api("a", "POST", "/tables/deployments/" + depId + "/ops", { ops: [{ opId: "op-p93-1", entity: "pin", action: "delete", id: 8001, ts: Date.now() }] });
  const raw = await srvPins(depId);
  await open(A2, depId, deck);
  const aIds = A2.State.pins.map((p) => String(p.id));
  B2.State.pins.find((p) => p.id === 8001).label = "B 가 고친 라벨";   // B 는 8001 을 고쳐서 저장
  await place(B2, 40, 40);
  await save(B2);
  const fin = await srvPins(depId);
  console.log("   측정: ops=" + ops.status + " 서버 원본=" + JSON.stringify(raw.map((p) => p.id + (p._deleted ? "(t)" : ""))) + " A State=" + JSON.stringify(aIds) + " 최종=" + JSON.stringify(fin.map((p) => p.id + (p._deleted ? "(t)" : ""))));
  ok(raw.some((p) => p._deleted) && !aIds.includes("8001") && A2.State.pins.every((p) => !p._deleted), "H8 로더가 tombstone 을 State.pins 에 넣지 않음");
  ok(!idsOf(fin).includes("8001"), "H5 서버 tombstone 이 있는 핀을 낡은 클라이언트가 병합으로 되살리지 못함");
}

/* ══════════ D4 — 다른 사람 변경 보기(경량 버전 폴링) · 설계서 H6/D4 ══════════ */
console.log("\n[D4] 20초 폴링 틱 — A 의 추가·삭제가 B 화면에 새로고침 없이 반영되는가");
{
  const { depId, deck } = await seedDeployment([P(9001), P(9002, 60, 60)]);
  const [A4, B4] = ["a", "b"].map(makeClient);
  for (const c of [A4, B4]) await open(c, depId, deck);
  const tb = toastLog(B4);
  const tick = async (c) => (typeof c.App._liveTick === "function" ? await c.App._liveTick() : "no-tick");
  const has = (c, id) => c.State.pins.some((p) => String(p.id) === String(id));
  const reqs = (c, from) => c.net.slice(from);

  // D4-a 추가 → 틱 1회 → 반영 + 경량 조회 사용 + 토스트 1회
  const pa = await place(A4, 30, 30); await save(A4);
  let n0 = B4.net.length;
  const ra = await tick(B4);
  const ua = reqs(B4, n0).map((n) => n.method + " " + n.url.replace(BASE, ""));
  console.log("   측정(a): 틱=" + ra + " 요청=" + JSON.stringify(ua) + " 토스트=" + JSON.stringify(tb));
  ok(has(B4, pa.id), "D4-a A 가 추가·저장한 핀이 B 틱 1회 후 B State.pins 에 있음");
  ok(ua[0] === "GET /tables/deployments/" + depId + "?fields=version", "D4-a 첫 요청은 경량 버전 조회(?fields=version)");
  ok(tb.filter((m) => /다른 사용자 변경 1건 반영/.test(m)).length === 1, "D4-a 토스트 1회(다른 사용자 변경 1건 반영)");
  n0 = B4.net.length;
  const rSame = await tick(B4);
  const uSame = reqs(B4, n0);
  ok(uSame.length === 1 && /fields=version/.test(uSame[0].url) && tb.length === 1, "D4-a 변경 없으면 버전 조회 1건만 · 토스트 추가 0 — " + rSame + " 요청=" + uSame.length);
  const vl = await api("a", "GET", "/tables/deployments/" + depId + "?fields=version");
  ok(vl.status === 200 && vl.j && JSON.stringify(Object.keys(vl.j).sort()) === '["deleted","id","version"]' && vl.j.version === (await getDep(depId)).version,
    "D4-a 경량 응답 = {id,version,deleted} 만(본문 0) · 버전 일치 — " + JSON.stringify(vl.j));
  const vx = await mf.dispatchFetch(BASE + "/tables/deployments/" + depId + "?fields=version");
  ok(vx.status === 401, "D4-a 경량 조회도 기존 인증 가드 유지(무토큰 401) — " + vx.status);

  // D4-b 삭제 → B 에서 사라지고 부활 0
  A4.App._removePins([9001]); await save(A4);
  const rb = await tick(B4);
  const goneAfterTick = !has(B4, 9001);            // B 저장(409 병합) 전에 잰다 — 틱 자체의 반영만
  const q = await place(B4, 70, 20); await save(B4);
  const finB = idsOf(await srvPins(depId));
  console.log("   측정(b): 틱=" + rb + " B State=" + JSON.stringify(idsOf(B4.State.pins)) + " 서버=" + JSON.stringify(finB));
  ok(goneAfterTick, "D4-b A 가 지운 9001 이 B 틱 후(B 저장 전) B 화면에서 사라짐");
  ok(!finB.includes("9001") && finB.includes(String(q.id)), "D4-b B 가 이어서 저장해도 9001 부활 0 · B 의 새 핀 보존");

  // D4-c B 편집 중(포커스·드래그·이동대기·저장 중) → 반영 미룸, B 입력 보존 → 편집 끝나면 반영 + B 미저장분 보존
  const bLocal = await place(B4, 45, 45);          // B 의 미저장 핀
  bLocal.label = "B 입력중";
  const pc = await place(A4, 15, 85); await save(A4);
  const guards = [
    ["포커스", () => { B4.sandbox.document.activeElement = { tagName: "INPUT" }; }, () => { B4.sandbox.document.activeElement = null; }],
    ["드래그", () => { B4.State.movingPinId = bLocal.id; }, () => { B4.State.movingPinId = null; }],
    ["이동대기", () => { B4.State.pinEditUnlocked = bLocal.id; }, () => { B4.State.pinEditUnlocked = null; }],
    ["저장중", () => { B4.App.autoSaving = true; }, () => { B4.App.autoSaving = false; }],
  ];
  for (const [nm, on, off] of guards) {
    on(); n0 = B4.net.length;
    const r = await tick(B4);
    const sent = B4.net.length - n0;
    off();
    ok(!has(B4, pc.id) && has(B4, bLocal.id) && bLocal.label === "B 입력중" && sent === 0,
      "D4-c B " + nm + " 중 틱 → 반영 보류(요청 0) · B 입력 보존 — 틱=" + r + " 요청=" + sent);
  }
  const rc = await tick(B4);
  const bl = B4.State.pins.find((p) => String(p.id) === String(bLocal.id));
  ok(has(B4, pc.id) && !!bl && bl.label === "B 입력중", "D4-c 편집 끝난 뒤 틱 → A 의 새 핀 반영 + B 미저장 핀·입력 보존 — " + rc);
  await save(B4);
  const finC = idsOf(await srvPins(depId));
  ok(finC.includes(String(pc.id)) && finC.includes(String(bLocal.id)), "D4-c B 저장 후 서버에 A·B 핀 모두");

  // D4-d 숨김 탭 · 오프라인 → 요청 0
  await place(A4, 88, 88); await save(A4);
  B4.sandbox.document.visibilityState = "hidden"; n0 = B4.net.length;
  const rh = await tick(B4);
  ok(B4.net.length === n0, "D4-d 숨김 탭 틱 → 요청 0 — " + rh);
  B4.sandbox.document.visibilityState = "visible";
  B4.nav.onLine = false; n0 = B4.net.length;
  const ro = await tick(B4);
  ok(B4.net.length === n0, "D4-d 오프라인 틱 → 요청 0 — " + ro);
  B4.nav.onLine = true;

  // D4-e 타이머 수명 — 숨김이면 정지, 보이면 즉시 1회 확인 후 재개, 중복 타이머 0
  const timers = new Set(); let seqT = 0;
  B4.sandbox.setInterval = () => { const id = ++seqT; timers.add(id); return id; };
  B4.sandbox.clearInterval = (id) => { timers.delete(id); };
  B4.App._livePollStart && B4.App._livePollStart(); B4.App._livePollStart && B4.App._livePollStart();
  const t1 = timers.size;
  B4.sandbox.document.visibilityState = "hidden";
  B4.App._onLiveVisibility && await B4.App._onLiveVisibility();
  const t2 = timers.size;
  B4.sandbox.document.visibilityState = "visible"; n0 = B4.net.length;
  B4.App._onLiveVisibility && await B4.App._onLiveVisibility();
  const t3 = timers.size, sentV = B4.net.length - n0;
  console.log("   측정(e): 타이머 start×2=" + t1 + " 숨김=" + t2 + " 복귀=" + t3 + " 복귀 즉시 요청=" + sentV);
  ok(t1 === 1 && t2 === 0 && t3 === 1 && sentV >= 1, "D4-e 타이머 1개만 · 숨김 정지 · 복귀 즉시 확인 후 재개");
  B4.App._livePollStop && B4.App._livePollStop();

  // D4-f 조회 도중 배포본 전환 → 늦게 온 응답 폐기(엉뚱한 도면에 병합 0)
  const pf = await place(A4, 22, 66); await save(A4);
  const pT = tick(B4);
  const keepDep = B4.State.autoSaveDepId; B4.State.autoSaveDepId = "dep_other";
  const rf = await pT;
  const leaked = has(B4, pf.id);
  B4.State.autoSaveDepId = keepDep;
  ok(!leaked, "D4-f 조회 중 배포본 전환 → 결과 폐기(병합 0) — " + rf);
}

/* ══════════ D5 — 기존 핀 수정 반영(핀 단위 LWW · pin.updatedAt) · 설계서 H2 ══════════
   종전: 병합이 같은 id 를 통째로 로컬 우선 치환 → A 가 옮기거나 라벨을 바꾼 핀이 B 화면에 안 보이고,
   B 가 나중에 저장하면 A 의 수정이 되돌아갔다. 편집 = UI 경로와 같은 모양(핀 객체 변경 → _autoSave/_markDirty). */
console.log("\n[D5] 기존 핀 수정 — A 의 라벨·좌표 변경이 B 에 반영되고 B 저장이 되돌리지 않는가");
{
  const LEG = P(7003, 80, 20, { label: "레거시" });
  const { depId, deck } = await seedDeployment([P(7001, 10, 10, { label: "X" }), P(7002, 20, 20, { label: "Y" }), LEG]);
  const [A5, B5] = ["a", "b"].map(makeClient);
  for (const c of [A5, B5]) await open(c, depId, deck);
  const tick = (c) => c.App._liveTick();
  const pinOf = (c, id) => c.State.pins.find((p) => String(p.id) === String(id));
  const srvOf = async (id) => (await srvPins(depId)).find((p) => String(p.id) === String(id));
  // UI 경로 모양: 드래그(11_UI) = 좌표 변경 → _autoSave · 라벨(27_PinActionPop) = 변경 → _markDirty
  const editAuto = async (c, id, fields) => { await sleep(3); Object.assign(pinOf(c, id), fields); c.App._autoSave(); };
  const editDirty = async (c, id, fields) => { await sleep(3); Object.assign(pinOf(c, id), fields); c.App._markDirty(); };

  // D5-a A 가 X 라벨·좌표 변경·저장 → B 틱 → B 의 X = A 값 → B 가 다른 핀 추가·저장해도 서버 X = A 값
  await editAuto(A5, 7001, { label: "A-수정", x: 11, y: 12 }); await save(A5);
  const ra = await tick(B5);
  const bx = pinOf(B5, 7001);
  console.log("   측정(a): 틱=" + ra + " B 의 X=" + JSON.stringify({ label: bx && bx.label, x: bx && bx.x, y: bx && bx.y }));
  ok(!!bx && bx.label === "A-수정" && bx.x === 11 && bx.y === 12, "D5-a A 가 바꾼 X 라벨·좌표가 B 틱 후 B 화면에 반영");
  await place(B5, 33, 33); await save(B5);
  const sa = await srvOf(7001);
  ok(!!sa && sa.label === "A-수정" && sa.x === 11, "D5-a B 가 이어서 저장해도 서버 X = A 값(되돌림 0) — " + JSON.stringify(sa && { label: sa.label, x: sa.x }));

  // D5-b 서로 다른 핀 동시 수정 → 둘 다 보존(B 는 미저장 상태에서 틱)
  await editDirty(B5, 7002, { label: "B-Y" });                 // B 미저장
  await editAuto(A5, 7001, { label: "A-X2" }); await save(A5);
  const rb = await tick(B5);
  ok(pinOf(B5, 7001).label === "A-X2" && pinOf(B5, 7002).label === "B-Y", "D5-b B 틱 후 A 의 X 반영 + B 미저장 Y 보존 — " + rb);
  await save(B5);
  const sbx = await srvOf(7001), sby = await srvOf(7002);
  ok(sbx.label === "A-X2" && sby.label === "B-Y", "D5-b B 저장 후 서버 X=A · Y=B 둘 다 — " + sbx.label + "/" + sby.label);

  // D5-c 같은 핀 동시 수정 → 나중 수정이 이김(저장 순서 무관)
  //  c1: A 먼저 수정 · B 나중 수정 · A 먼저 저장 · B 저장(409 병합) → B
  await editAuto(A5, 7001, { label: "A-c1" });
  await editAuto(B5, 7001, { label: "B-c1" });
  await save(A5); await save(B5);
  const c1 = (await srvOf(7001)).label;
  //  c2: B 먼저 수정 · A 나중 수정 · A 먼저 저장 · B 틱 → A 반영 · B 저장 → 서버 A 유지
  await tick(A5);
  await editDirty(B5, 7001, { label: "B-c2" });   // 라벨 경로(_markDirty) — 편집 시각이 찍혀야 A 가 이긴다
  await editAuto(A5, 7001, { label: "A-c2" });
  await save(A5); await tick(B5); const bc2 = pinOf(B5, 7001).label; await save(B5);
  const c2 = (await srvOf(7001)).label;
  console.log("   측정(c): c1 서버=" + c1 + " · c2 B틱후=" + bc2 + " 서버=" + c2);
  ok(c1 === "B-c1", "D5-c1 같은 핀: 나중 수정(B)이 이김 — 서버=" + c1);
  ok(bc2 === "A-c2" && c2 === "A-c2", "D5-c2 같은 핀: 나중 수정(A)이 이김 · B 저장이 되돌리지 않음 — B=" + bc2 + " 서버=" + c2);

  // D5-d B 미저장 편집 중 A 가 같은 핀을 (B 보다 먼저) 수정·저장 → B 틱 → B 편집 보존 → B 저장 → 서버 B
  await tick(A5); await tick(B5);
  await editAuto(A5, 7001, { label: "A-d" }); await save(A5);
  await editDirty(B5, 7001, { label: "B-d", x: 44 });
  const rd4 = await tick(B5);
  const bd = pinOf(B5, 7001);
  ok(bd.label === "B-d" && bd.x === 44, "D5-d B 가 더 나중에 한 미저장 편집은 틱에도 보존 — " + rd4 + " " + bd.label);
  await save(B5);
  ok((await srvOf(7001)).label === "B-d", "D5-d B 저장 후 서버 X = B 편집");

  // D5-e 삭제 부활 0 — B 가 Y 를 (미저장) 수정한 뒤 A 가 Y 삭제·저장 → B 틱·저장 후에도 Y 없음
  await tick(A5);
  await editDirty(B5, 7002, { label: "B-Y2" });
  A5.App._removePins([7002]); await save(A5);
  await tick(B5);
  const goneB = !pinOf(B5, 7002);
  await save(B5);
  const finE = idsOf(await srvPins(depId));
  ok(goneB && !finE.includes("7002"), "D5-e 수정 중이던 핀도 남의 삭제가 이김(부활 0) — B=" + goneB + " 서버=" + JSON.stringify(finE));

  // D5-f 레거시(updatedAt 없음) — 구버전 클라이언트가 L 을 바꿔 저장(updatedAt 없이) → B 틱 → 서버 값
  await tick(B5);
  const dep = await getDep(depId);
  const legacy = JSON.parse(dep.pins).map((p) => (String(p.id) === "7003" ? Object.assign({}, p, { label: "구버전-수정", x: 81 }) : p));
  const lp = await api("a", "PATCH", "/tables/deployments/" + depId, { pins: JSON.stringify(legacy), base_version: dep.version });
  const lsrv = legacy.find((p) => String(p.id) === "7003");
  const rf = await tick(B5);
  const bl = pinOf(B5, 7003);
  console.log("   측정(f): PATCH=" + lp.status + " 서버 L.updatedAt=" + (lsrv && lsrv.updatedAt) + " 틱=" + rf + " B 의 L=" + (bl && bl.label));
  ok(lp.status === 200 && !!bl && bl.label === "구버전-수정" && bl.x === 81, "D5-f 레거시 핀(updatedAt 없음) 변경 → B 에 서버 값 반영");
  await save(B5);
  ok((await srvOf(7003)).label === "구버전-수정", "D5-f B 저장 후에도 서버 L 유지");

  // D5-g 막 연 화면에서 곧바로 편집(틱·병합 전) → A 가 다른 핀 저장 → 틱 → C 편집 보존(로더 기준 기록)
  const C5 = makeClient("c"); await open(C5, depId, deck);
  await editDirty(C5, 7003, { label: "C-L" });
  await tick(A5); await editAuto(A5, 7001, { label: "A-g" }); await save(A5);
  const rg = await tick(C5);
  ok(pinOf(C5, 7003).label === "C-L" && pinOf(C5, 7001).label === "A-g", "D5-g 연 직후 편집도 로컬 수정으로 찍혀 보존 + A 반영 — " + rg + " " + pinOf(C5, 7003).label);

  // D5-h _markDirty 전(일괄 사진 등록 도중 등) 편집 중 틱 → 병합 직전 관찰로 보존(대상 = updatedAt 없는 A 의 새 핀)
  const ph = await place(A5, 55, 5); await save(A5); await tick(C5);
  await sleep(3); pinOf(C5, ph.id).imageId = "img_c_batch";
  await editAuto(A5, 7001, { label: "A-h" }); await save(A5);
  const rh = await tick(C5);
  ok(pinOf(C5, ph.id).imageId === "img_c_batch" && pinOf(C5, 7001).label === "A-h", "D5-h 관문 전 편집도 병합 직전 찍혀 보존 — " + rh);
}

await mf.dispose();
try { fs.unlinkSync(workerOut); } catch {}
console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
