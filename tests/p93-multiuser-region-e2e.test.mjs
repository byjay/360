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
 * 판정은 "측정" 이다 — B4(H3)는 현행 결함을 **측정만** 한다([MEASURE], EXIT 제외).
 *   B5(H4)·C3 는 WP3(0030 deployments.project_id · projects.original_deployment_id)로 고쳐 EXIT 에 포함한다.
 *   EXIT 는 A(H7)·B1·B2·B3·B5·C1·C2·C3·C4 로 정한다.
 * 뮤테이션: P93_APP_SRC=<변형 20_App.js> 로 주입(예: HEAD 의 크롭 변환 저장 → H7 FAIL → EXIT=1).
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
  series: rd("public/js/modules/01b_PinSeries.js"),
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

/* ══════════ B4 — 번호 중복(H3) 측정만 ══════════ */
console.log("\n[B4] 두 사람이 대역 설정 없이 동시에 체크보드 핀 → 번호 (측정만, WP4)");
{
  const { depId, deck } = await seedDeployment([]);
  const [A, B] = ["a", "b"].map(makeClient);
  for (const c of [A, B]) await open(c, depId, deck);
  const la = (await place(A, 10, 10)).label, lb = (await place(B, 20, 20)).label;
  const r = await Promise.all([save(A), save(B)]);
  for (const [i, c] of [A, B].entries()) if (!r[i]) await save(c);
  const B2c = makeClient("b"); await open(B2c, depId, deck);
  const lb2 = (await place(B2c, 30, 30)).label;   // A 의 1번을 로드한 뒤의 B 다음 번호
  const labels = (await srvPins(depId)).map((p) => p.label);
  console.log("   측정: A=" + la + " B=" + lb + " (재로드 후 B 다음=" + lb2 + ") 서버 라벨=" + JSON.stringify(labels));
  measure(la !== lb, "B4 동시 신규 핀 번호 중복 없음 — A=" + la + " B=" + lb);
  measure(lb2 !== la, "B4 남의 핀을 로드한 뒤 번호가 겹치지 않음 — A=" + la + " B 다음=" + lb2);
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

await mf.dispose();
try { fs.unlinkSync(workerOut); } catch {}
console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
