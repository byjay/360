/**
 * p102 — 실환경 점검: 오프라인 작업 후 업로드(A1~A9) · 초대 로직(B1~B9)
 * (프레임워크 0 · 실행: node tests/p102-offline-invite-audit.test.mjs)
 *
 * 마스터 원문(2026-10-01): "오프라인에서 작업 후 업로드 방식과 초대받는 로직 점검"
 *
 * 🔴 목 금지 범위(p93 하니스 재사용):
 *   서버 = src/index.tsx 실 번들 → Miniflare(workerd) + 실제 D1(migrations 전부) + 실제 R2.
 *   클라 = 01_State · 01b_PinSeries · 02_PDF · 04_Cloud · 05_SyncQueue · 10_MapCtrl · 20_App · 22_Auth ·
 *          31_Projects · 32_Offline · 35_PhotoBatch 실 소스를 기기(사람)마다 vm realm 에 올린다.
 *          네트워크 = fetch → mf.dispatchFetch(실 HTTP 핸들러). 오프라인 = fetch 가 TypeError 를 던진다(브라우저와 동일).
 *   "새로고침" = 같은 기기 저장소(localStorage)를 가진 **새 realm** 에 모듈을 다시 올린다(메모리 전부 소실).
 *   대체한 경계(브라우저 전용 리프 I/O 뿐): DOM(프록시) · 캔버스(pdf.js 렌더 · Cloud.resizeImage · App._detect360) ·
 *     IndexedDB(Node 에 없음 → 실 SyncQueue 가 **자체 localStorage 폴백 경로**로 동작 — 폴백 경로 자체가 검사 대상).
 *     IndexedDB 경로는 A9-idb 에서 실 헤드리스 Chrome 으로 따로 잰다.
 *
 * EXIT = 판정(ok) 항목 전부. 측정 전용(measure)은 EXIT 에 넣지 않는다(결정 필요 항목 · 설계상 동작 기록).
 * 뮤테이션: P102_AUTH_SRC / P102_APP_SRC / P102_SQ_SRC / P102_PB_SRC = <변형 22_Auth / 20_App / 05_SyncQueue / 35_PhotoBatch> 로 주입.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { Miniflare } from "miniflare";
import * as PDFLib from "pdf-lib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const rdEnv = (env, p) => (process.env[env] ? fs.readFileSync(process.env[env], "utf8").replace(/\r\n/g, "\n") : rd(p));
const M = "public/js/modules/";
const SRC = [
  rd("public/vendor/pdf-lib.min.js"),
  rd(M + "01_State.js"), rd(M + "01b_PinSeries.js"), rd(M + "02_PDF.js"), rd(M + "04_Cloud.js"),
  rdEnv("P102_SQ_SRC", M + "05_SyncQueue.js"), rd(M + "10_MapCtrl.js"), rdEnv("P102_APP_SRC", M + "20_App.js"),
  rdEnv("P102_AUTH_SRC", M + "22_Auth.js"), rd(M + "31_Projects.js"), rd(M + "32_Offline.js"), rdEnv("P102_PB_SRC", M + "35_PhotoBatch.js"),
];

let failed = 0;
const R = {};   // 항목별 결과(보고용)
const ok = (id, cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + id + " " + label); if (!cond) failed++; R[id] = R[id] === false ? false : !!cond; };
const measure = (id, cond, label) => console.log((cond ? "  [MEASURE ok]   " : "  [MEASURE 결함] ") + id + " " + label);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idsOf = (arr) => (arr || []).filter((p) => p && !p._deleted).map((p) => String(p.id)).sort();
const dupLabels = (pins) => { const seen = new Set(), d = []; (pins || []).filter((p) => p && !p._deleted).forEach((p) => { const k = (p.page || 1) + "|" + (p.checkboard ? "c" : "n") + "|" + p.label; if (seen.has(k)) d.push(p.label); seen.add(k); }); return d; };
const watchdog = setTimeout(() => { console.log("\nWATCHDOG — 240s 초과(무한 대기) → FAIL"); process.exit(1); }, 240000);

/* ══ 서버: 실 워커 + 실 D1 + 실 R2 ══ */
const MIG_DIR = path.join(ROOT, "migrations");
const MIGS = fs.readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
const stmtsOf = (file) => fs.readFileSync(path.join(MIG_DIR, file), "utf8").replace(/--[^\n]*/g, "")
  .split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
const workerOut = path.join(os.tmpdir(), "p102-worker-" + process.pid + ".mjs");
await esbuild.build({
  entryPoints: [path.join(ROOT, "src/index.tsx")], bundle: true, format: "esm", platform: "neutral",
  outfile: workerOut, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
  conditions: ["workerd", "worker", "browser"],
});
const mf = new Miniflare({
  modules: true, scriptPath: workerOut, d1Databases: { DB: "p102-" + Date.now() },
  r2Buckets: { R2: "p102r2-" + Date.now() }, bindings: { DEMO_LOGIN: "0" }, compatibilityDate: "2025-01-01",
});
const BASE = "http://p102.test";
const db = await mf.getD1Database("DB");
for (const f of MIGS) for (const st of stmtsOf(f)) await db.exec(st);
const run = (q, a = []) => db.prepare(q).bind(...a).run();
const first = (q, a = []) => db.prepare(q).bind(...a).first();

const USERS = { a: "alice@seastar.test", b: "bruno@seastar.test", c: "chloe@seastar.test", d: "dora@seastar.test", v: "vera@seastar.test", m: "mallory@seastar.test" };
const TOK = (k) => "local-p102-" + k;
const tokens = {};
async function addUser(k, email, designer) {
  const now = Date.now();
  if (designer) await run("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)", [email, k, "designssir@gmail.com", now, now]);
  await run("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)", [email, k, email.split("@")[1], "x", "y", now, now]);
  await newSession(k, email);
}
async function newSession(k, email) {
  const now = Date.now(); const t = TOK(k) + "-" + now + Math.random().toString(36).slice(2, 6);
  await run("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [t, email, now, now + 8.64e7]);
  tokens[k] = t; return t;
}
for (const k of ["a", "b", "c"]) await addUser(k, USERS[k], true);
for (const k of ["d", "v", "m"]) await addUser(k, USERS[k], false);
async function mkProject(pid, owner = USERS.a) {
  const now = Date.now();
  await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)", [pid, pid, "", owner, now, now]);
}
const H = (k) => ({ Authorization: "Bearer " + (tokens[k] || k), "Content-Type": "application/json" });
const api = async (k, method, url, body) => {
  const headers = k ? H(k) : { "Content-Type": "application/json" };
  const r = await mf.dispatchFetch(BASE + url, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
};
const getDep = async (id) => (await api("a", "GET", "/tables/deployments/" + id)).j;
const srvPins = async (id) => JSON.parse((await getDep(id)).pins || "[]");
const PAGE_URL = "/api/r2/object/assets/p102-base.png";
async function seedDeployment(pins, prj, k = "a") {
  const d = (await api(k, "POST", "/tables/deployments", { title: "도면", file_name: "GA.pdf", project_id: prj, pins: JSON.stringify(pins), pages_data: JSON.stringify([PAGE_URL]), drawing_data: PAGE_URL })).j;
  const deck = (await api(k, "POST", "/api/projects/" + prj + "/decks", { name: "D" + d.id.slice(-5), deployment_id: d.id, page: 1 })).j;
  return { depId: d.id, deck };
}
const P = (id, x = 50, y = 50, extra = {}) => Object.assign({ id, x, y, page: 1, label: String(id), checkboard: true, createdAt: id }, extra);

/* ══ 클라이언트: 기기(localStorage) 단위 · 새로고침 = 새 realm ══ */
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
const noopObj = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : (k === "then" ? undefined : () => {})), set: (t, k, v) => { t[k] = v; return true; } });
const PNG1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
async function pdfDims(bytes) {
  const d = await PDFLib.PDFDocument.load(new Uint8Array(bytes));
  return d.getPages().map((p) => { const { width, height } = p.getSize(); return { w: Math.round(width), h: Math.round(height), pw: Math.round(width), ph: Math.round(height) }; });
}
function makeDevice() {
  const m = new Map();
  return {
    _m: m,
    get length() { return m.size; },
    key(i) { const a = Array.from(m.keys()); return i < a.length ? a[i] : null; },
    getItem(x) { return m.has(x) ? m.get(x) : null; },
    setItem(x, v) { m.set(String(x), String(v)); },
    removeItem(x) { m.delete(x); },
  };
}
const draftsOf = (dev) => { const o = {}; for (const [k, v] of dev._m) if (k.startsWith("wm_draft_")) { try { o[k.slice(9)] = JSON.parse(v).data; } catch {} } return o; };

function makeClient(k, dev, opts = {}) {
  const email = USERS[k];
  const els = {};
  // 경계: <img> 디코드 — data: URL 은 브라우저처럼 비동기 load 이벤트를 낸다(원격 URL 은 p93 과 같이 미발화)
  const img = () => ({ _src: "", onload: null, onerror: null, complete: false, naturalWidth: 0, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    set src(v) { this._src = v; if (/^data:/.test(String(v))) setTimeout(() => { this.complete = true; this.naturalWidth = 1; if (this.onload) this.onload(); }, 0); }, get src() { return this._src; } });
  const document = {
    getElementById: (id) => (els[id] = els[id] || (id === "map-image" ? img() : anyEl())),
    querySelector: () => null, querySelectorAll: () => [], createElement: () => anyEl(),
    body: anyEl(), documentElement: anyEl(), addEventListener() {},
    visibilityState: "visible", activeElement: null,
  };
  const net = [], toasts = [], hooks = {};
  const nav = { onLine: opts.online !== false, userAgent: "node" };
  const fetchShim = async (url, init = {}) => {
    if (typeof url === "string" && url.startsWith("data:")) return fetch(url);
    if (!nav.onLine) throw new TypeError("Failed to fetch (offline)");
    const rec = { k, method: (init.method || "GET").toUpperCase(), url: String(url) };
    if (hooks.before) await hooks.before(rec);
    net.push(rec);
    const r = await mf.dispatchFetch(String(url).startsWith("http") ? url : BASE + url, init);
    rec.status = r.status;
    return r;
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    document, navigator: nav, location: { search: "", origin: BASE, pathname: "/", href: BASE + "/" },
    localStorage: dev, sessionStorage: makeDevice(),
    UI: Object.assign(noopObj(), { $: (id) => document.getElementById(id), escapeHtml: (s) => String(s), val: () => "" }),
    Prompt: { toast: (m) => toasts.push(String(m)), confirm: async () => true, ask: async () => null },
    Zones: { refreshPinLinks() {}, render() {}, renderList() {} },
    Log: { push() {} },
    _revokeVideoBlob() {}, _revokeAllVideoBlobs() {},
    fetch: fetchShim, Blob, File, Headers, URL, URLSearchParams, AbortController, TextEncoder, TextDecoder, atob, btoa,
    setTimeout: (f, ms) => (ms && ms >= 500 ? 0 : setTimeout(f, ms)), clearTimeout, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: (f) => setTimeout(f, 0), performance: { now: () => Date.now() },
  };
  sandbox.window = sandbox; sandbox.addEventListener = () => {}; sandbox.removeEventListener = () => {};
  vm.createContext(sandbox);
  for (const s of SRC) vm.runInContext(s, sandbox);
  vm.runInContext("globalThis.__X = { State, PinSeries, PDF, MapCtrl, App, Projects, SyncQueue, Auth, Cloud, OpLog, OfflineBundle, PhotoBatch };", sandbox);
  const X = sandbox.__X;
  const { State, App, Projects, PDF, MapCtrl, Auth, Cloud } = X;
  // 로그인 상태(재로그인은 A6 에서 실 /api/auth/me 로)
  Auth.idToken = tokens[k]; Auth.user = { email }; Auth.role = "designer";
  let gateOpened = 0;
  Auth._applyUi = () => {}; Auth._openGate = () => { gateOpened++; };
  // 경계: 화면 변환(DOM)
  for (const f of ["applyTransform", "fit", "fitZone", "setCropBoundary", "flyTo"]) MapCtrl[f] = () => {};
  let nextPct = null; MapCtrl.viewportToPercent = () => nextPct;
  State.mode = "designer"; State.regMode = "checkboard";
  // 경계: pdf.js 캔버스 렌더
  PDF.load = async (bytes) => ({ numPages: 1, __bytes: bytes, destroy() {} });
  PDF.snapshotAllPages = async (doc) => { PDF.lastSnapshotDims = await pdfDims(doc.__bytes); return PDF.lastSnapshotDims.map(() => PNG1); };
  PDF.setDeckCrop = () => null;
  const U8 = vm.runInContext("Uint8Array", sandbox), rawCopy = PDF.copyRegionToPdf;
  PDF.copyRegionToPdf = function (b, ...rest) { return rawCopy.call(this, new U8(new Uint8Array(b)), ...rest); };
  sandbox.__U8 = U8;
  // 경계: 이미지 디코드(캔버스)
  Cloud.resizeImage = async () => ({ dataURL: PNG1, width: 2, height: 1 });
  App._detect360 = (f, cb) => cb(true, 2, 1);
  // 경계: 표시/인디케이터(DOM)
  App._setSaveIndicator = () => {}; App._updateSaveBtn = () => {}; App._markDeckUnsaved = () => {};
  App._closePinForm = () => {}; App._updateCheckboardQuickStatus = () => {}; App._openSidebarSheet = () => {};
  Projects._renderDecks = () => {};
  const c = { k, dev, sandbox, X, State, App, Projects, PDF, Auth, SyncQueue: X.SyncQueue, nav, net, toasts, hooks,
    gate: () => gateOpened, setPct: (p) => { nextPct = p; } };
  return c;
}
async function open(c, depId, deck, prj) {
  c.Projects.currentProject = { id: prj, name: prj };
  c.Projects.currentDeck = deck;
  c.Projects.decks = [deck];
  await c.App.loadDeckDrawing(depId);
  await sleep(5);
  return c.State.autoSaveDepId === depId;
}
async function place(c, x, y) { await sleep(3); const p = c.App._placeCheckboardPin({ x, y }); await sleep(3); return p; }
const save = (c) => c.App._saveNow({ now: true });
const reconnect = async (c) => { c.nav.onLine = true; await c.SyncQueue._onReconnect(); await sleep(20); };
const depWrites = (c, from = 0) => c.net.slice(from).filter((n) => /\/tables\/deployments/.test(n.url) && n.method !== "GET");
const dirtyDrafts = (dev) => Object.entries(draftsOf(dev)).filter(([, d]) => d && d.dirty);

/* ══════════ A1 — 오프라인 CHECKER 핀 3개 → 새로고침(오프라인) → 복원 → 복귀 자동 업로드 ══════════ */
await mkProject("prj_A");
for (const variant of ["번들없음", "번들있음"]) {
  console.log("\n[A1·" + variant + "] 오프라인 CHECKER 3개 → 오프라인 새로고침 → 복원 → 온라인 복귀");
  const { depId, deck } = await seedDeployment([P(1000)], "prj_A");
  const dev = makeDevice();
  const A = makeClient("a", dev);
  await open(A, depId, deck, "prj_A");
  if (variant === "번들있음") await A.X.OfflineBundle.download("prj_A");
  A.nav.onLine = false;
  const made = [];
  for (let i = 0; i < 3; i++) made.push(String((await place(A, 10 + i * 10, 20)).id));
  await sleep(10);
  // 새로고침(오프라인 유지)
  const A2 = makeClient("a", dev, { online: false });
  const opened = await open(A2, depId, deck, "prj_A");
  const shown = idsOf(A2.State.pins);
  const restoredOk = made.every((id) => shown.includes(id));
  const n0 = A2.net.length;
  await reconnect(A2);
  const fin = idsOf(await srvPins(depId));
  const dl = dirtyDrafts(dev).length;
  console.log("   측정: 새로고침 후 화면 핀=" + shown.length + " (열림=" + opened + ") · 복귀 요청=" + JSON.stringify(A2.net.slice(n0).map((n) => n.method + " " + n.status)) + " · 서버=" + JSON.stringify(fin) + " · dirty draft=" + dl);
  ok("A1", restoredOk && shown.includes("1000"), variant + " 오프라인 새로고침 후 draft 복원으로 3개(+기존 1) 보임 — " + shown.length);
  ok("A1", made.every((id) => fin.includes(id)) && fin.includes("1000") && fin.length === 4, variant + " 복귀 자동 업로드 → 서버 4개(기존 1 + 오프라인 3)");
  ok("A1", dl === 0, variant + " 업로드 후 dirty draft 0 — " + dl);
}

/* ══════════ A2 — 오프라인 360 핀 + 사진 자동연결 → 복귀 ══════════ */
async function photoPin(c, x, y) {
  c.State.regMode = "photo";
  c.State.placing = true;
  c.setPct({ x, y });
  await sleep(3);
  const before = c.State.pins.length;
  c.App._handlePlaceClick({ clientX: 0, clientY: 0 });
  const pin = c.State.pins[before];
  const PB = c.X.PhotoBatch;
  if (!PB._autoRows.length) {
    const f = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "R0010" + String(Date.now()).slice(-3) + ".JPG", { lastModified: Date.now() });
    await PB._onAutoFilesChosen([f]);                     // 파일선택창 change 핸들러가 부르는 그 함수
  }
  await sleep(10);
  c.State.regMode = "checkboard"; c.State.placing = false;
  return pin;
}
for (const variant of ["도면 열린 채 복귀", "오프라인 새로고침 후 복귀"]) {
  console.log("\n[A2·" + variant + "] 오프라인 360 핀 + 사진(autoConnectPin) → 복귀");
  const { depId, deck } = await seedDeployment([], "prj_A");
  deck.name = "메인데크";
  const dev = makeDevice();
  let A = makeClient("a", dev);
  await open(A, depId, deck, "prj_A");
  A.nav.onLine = false;
  const pin = await photoPin(A, 40, 40);
  const localName = pin && pin.imageName, pendingOp = pin && pin.pendingOpId;
  const draftPin = (draftsOf(dev)["prj_A::" + deck.id] || { pins: [] }).pins.find((p) => String(p.id) === String(pin && pin.id));
  if (variant !== "도면 열린 채 복귀") {
    A = makeClient("a", dev, { online: false });
    await open(A, depId, deck, "prj_A");
  }
  const n0 = A.net.length;
  await reconnect(A);
  const sp = (await srvPins(depId)).find((p) => String(p.id) === String(pin && pin.id));
  const img = sp && sp.imageId ? await first("SELECT id, name FROM pano_images WHERE id = ?", [sp.imageId]) : null;
  const orphan = await first("SELECT COUNT(*) AS n FROM pano_images WHERE name = ?", [localName || "-"]);
  const stateHas = (A.State.pins.find((p) => String(p.id) === String(pin && pin.id)) || {});
  console.log("   측정: 오프라인 pin.pendingOpId=" + !!pendingOp + " 이름=" + localName + " · draft 에 pendingOpId=" + !!(draftPin && draftPin.pendingOpId) +
    " · 복귀 요청=" + JSON.stringify(A.net.slice(n0).map((n) => n.method + " " + n.url.replace(BASE, "").split("?")[0] + " " + n.status)) +
    " · 서버 핀 imageId=" + (sp && sp.imageId) + " imageName=" + (sp && sp.imageName) + " · pano_images(name)=" + (orphan && orphan.n) + " · 화면 imageId=" + stateHas.imageId + " dirty=" + A.App._dirty);
  ok("A2", !!pendingOp && /^메인데크_\d{8}/.test(localName || ""), variant + " 오프라인 연결: pendingOpId + 저장명 '구역_시각' — " + localName);
  ok("A2", !!(sp && sp.imageId && img), variant + " 복귀 후 서버 핀에 사진 연결(imageId → pano_images 행 존재) — " + (sp && sp.imageId));
  ok("A2", !!(img && img.name === localName), variant + " 서버 사진 이름 = 오프라인에서 정한 저장명 — " + (img && img.name));
}

/* ══════════ A3 — 오프라인 삭제 1건 → 복귀 → 삭제 반영 · 부활 0 ══════════ */
console.log("\n[A3] 오프라인 삭제 1건 → 복귀 (+ 낡은 화면 B 저장 · 재로드)");
{
  const { depId, deck } = await seedDeployment([P(3001), P(3002, 60, 60)], "prj_A");
  const devA = makeDevice(), devB = makeDevice();
  const A = makeClient("a", devA), B = makeClient("b", devB);
  await mkMember("prj_A", USERS.b, "designer");
  await open(A, depId, deck, "prj_A"); await open(B, depId, deck, "prj_A");
  A.nav.onLine = false;
  A.App._removePins([3001]);
  await sleep(20);
  const A2 = makeClient("a", devA, { online: false }); await open(A2, depId, deck, "prj_A");
  const hidden = !idsOf(A2.State.pins).includes("3001");
  await reconnect(A2);
  const s1 = idsOf(await srvPins(depId));
  await place(B, 80, 80); await save(B);           // B 는 3001 이 살아있던 화면
  const s2 = idsOf(await srvPins(depId));
  const A3c = makeClient("a", devA); await open(A3c, depId, deck, "prj_A");
  console.log("   측정: 새로고침 후 화면에서 사라짐=" + hidden + " 복귀 후 서버=" + JSON.stringify(s1) + " · 낡은 B 저장 후=" + JSON.stringify(s2) + " · 재로드 화면=" + JSON.stringify(idsOf(A3c.State.pins)));
  ok("A3", hidden && !s1.includes("3001") && s1.includes("3002"), "오프라인 삭제가 복귀 후 서버 반영");
  ok("A3", !s2.includes("3001") && !idsOf(A3c.State.pins).includes("3001"), "낡은 화면 저장·재로드 후에도 부활 0");
}
async function mkMember(pid, email, role) { await run("INSERT INTO project_members (project_id, email, role, granted_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, email) DO UPDATE SET role = excluded.role", [pid, email, role, USERS.a, Date.now()]); }

/* ══════════ A4 — 오프라인 편집 중 다른 사용자 온라인 편집 → 복귀 병합 ══════════ */
console.log("\n[A4] A 오프라인(추가 2 · X 라벨 수정) ∥ B 온라인(추가 2 · Y 라벨 수정) → A 복귀");
{
  const { depId, deck } = await seedDeployment([P(4001, 10, 10, { label: "1" }), P(4002, 20, 20, { label: "2" })], "prj_A");
  const devA = makeDevice();
  const A = makeClient("a", devA), B = makeClient("b", makeDevice());
  await open(A, depId, deck, "prj_A"); await open(B, depId, deck, "prj_A");
  A.nav.onLine = false;
  const a1 = await place(A, 30, 30), a2 = await place(A, 31, 31);
  await sleep(3); A.State.pins.find((p) => p.id === 4001).note = "A-오프라인-메모"; A.App._autoSave();
  const b1 = await place(B, 60, 60), b2 = await place(B, 61, 61);
  await sleep(3); B.State.pins.find((p) => p.id === 4002).note = "B-온라인-메모"; B.App._autoSave();
  const bOk = await save(B);
  await sleep(10);
  await reconnect(A);
  const srv = await srvPins(depId);
  const want = ["4001", "4002", a1.id, a2.id, b1.id, b2.id].map(String).sort();
  const by = (id) => srv.find((p) => String(p.id) === String(id)) || {};
  console.log("   측정: B 저장=" + bOk + " · 서버=" + JSON.stringify(srv.map((p) => p.id + ":" + p.label)) + " · 4001.note=" + by(4001).note + " 4002.note=" + by(4002).note + " · 중복=" + JSON.stringify(dupLabels(srv)));
  ok("A4", JSON.stringify(idsOf(srv)) === JSON.stringify(want), "양쪽 추가 전부 보존(6개)");
  ok("A4", by(4001).note === "A-오프라인-메모" && by(4002).note === "B-온라인-메모", "양쪽 기존 핀 수정 보존");
  ok("A4", dupLabels(srv).length === 0, "번호 중복 0 — " + JSON.stringify(srv.map((p) => p.label)));
}
console.log("\n[A4-race] A 복귀 업로드의 GET 과 PATCH 사이에 B 가 저장(경합) → A 작업 유실·영구 보류 없는가");
{
  const { depId, deck } = await seedDeployment([P(4101)], "prj_A");
  const devA = makeDevice();
  const A = makeClient("a", devA), B = makeClient("b", makeDevice());
  await open(A, depId, deck, "prj_A"); await open(B, depId, deck, "prj_A");
  A.nav.onLine = false;
  const a1 = await place(A, 30, 30);
  await sleep(10);
  const b1 = await place(B, 70, 70);
  let fired = false;
  A.hooks.before = async (rec) => {
    if (!fired && rec.method === "PATCH" && rec.url.includes(depId)) { fired = true; await save(B); }
  };
  await reconnect(A);
  A.hooks.before = null;
  const s1 = idsOf(await srvPins(depId));
  const dA = draftsOf(devA)["prj_A::" + deck.id] || {};
  const denyToast = A.toasts.filter((t) => /삭제되어|권한이 없어/.test(t));
  // 다음 기회(재연결 한 번 더) — 보류된 작업이 결국 올라가는가
  const n1 = A.net.length;
  await A.SyncQueue._onReconnect(); await sleep(20);
  const s2 = idsOf(await srvPins(depId));
  console.log("   측정: 경합 발생=" + fired + " · 1차 복귀 후 서버=" + JSON.stringify(s1) + " draft.dirty=" + dA.dirty + " writeDenied=" + dA.writeDenied +
    " 토스트=" + JSON.stringify(denyToast) + " · 재연결 요청=" + depWrites(A, n1).length + " → 서버=" + JSON.stringify(s2));
  ok("A4", fired && s1.includes(String(a1.id)) && s1.includes(String(b1.id)), "경합(버전 409) → 같은 복귀 안에서 최신본 재병합·재시도 → A 오프라인 핀 반영 + B 핀 보존");
  ok("A4", !dA.writeDenied && denyToast.length === 0, "버전 경합 409 를 '프로젝트 삭제/권한없음'으로 오판하지 않음(writeDenied·삭제 토스트 0)");
}

/* ══════════ A5 — 오프라인 새 도면 등록 → 복귀 ══════════ */
const SRC_W = 1000, SRC_H = 500;
const srcBytes = await (async () => {
  const d = await PDFLib.PDFDocument.create();
  const font = await d.embedFont(PDFLib.StandardFonts.Helvetica);
  const p = d.addPage([SRC_W, SRC_H]);
  for (let x = 20; x < SRC_W; x += 80) p.drawText("G" + x, { x, y: 40, size: 6, font });
  return await d.save();
})();
function loadPdfInto(c, name) {
  c.State.reset(); c.State.mode = "designer"; c.State.regMode = "checkboard";
  c.State.fileType = "pdf"; c.State.fileName = name; c.State.fileData = new c.sandbox.__U8(srcBytes).buffer;
  c.State.pdfDoc = { numPages: 1, __bytes: srcBytes }; c.State.pdfPage = 1; c.State.pdfPages = 1;
}
for (const variant of ["같은 세션 복귀", "오프라인 새로고침 후 복귀"]) {
  const pid = variant === "같은 세션 복귀" ? "prj_N1" : "prj_N2";
  console.log("\n[A5·" + variant + "] 오프라인 새 도면 등록(구역 0 프로젝트) → 복귀 → 첫 구역 지정");
  await mkProject(pid);
  const dev = makeDevice();
  let A = makeClient("a", dev);
  A.Projects.currentProject = { id: pid, name: pid }; A.Projects.currentDeck = null; A.Projects.decks = [];
  A.nav.onLine = false;
  loadPdfInto(A, "NEW.pdf");
  await A.App._afterDrawingLoaded();                    // 도면 등록의 유일한 확정 지점(20_App)
  await place(A, 20, 30);
  await sleep(10);
  const kept = Object.keys(draftsOf(dev));
  if (variant !== "같은 세션 복귀") {
    A = makeClient("a", dev, { online: false });
    A.Projects.currentProject = { id: pid, name: pid }; A.Projects.currentDeck = null; A.Projects.decks = [];
    await A.App._restoreProjectDraft(pid);              // 프로젝트 재진입 시 로컬 draft 복원 경로
  }
  const n0 = A.net.length;
  await reconnect(A);
  const autoReq = depWrites(A, n0).length;
  const autoRows = (await db.prepare("SELECT id FROM deployments WHERE project_id = ?").bind(pid).all()).results.length;
  const restoredType = A.State.fileType, restoredPins = idsOf(A.State.pins).length;
  // 경계: 원본 없는 도면일 때 뜨는 확인 모달(DOM) — 사용자가 "PDF 첨부 안 함 → 창 방식으로 만들기"를 고른다.
  //   (vm 은 IndexedDB 가 없어 새로고침 뒤 원본 PDF 바이트가 없다 — 실브라우저는 IDB sources 에서 원본 복원)
  const reloaded = variant !== "같은 세션 복귀";
  A.Projects._confirmLabeled = async (title) => /기존 방식/.test(String(title));
  const zone = await A.Projects.createDeckFromLoadedDrawing({ crop: { x: 10, y: 10, w: 40, h: 40 }, name: "Z1" });
  const deps = (await db.prepare("SELECT id, project_id, source_meta, pins FROM deployments WHERE project_id = ?").bind(pid).all()).results;
  const proj = await first("SELECT original_deployment_id FROM projects WHERE id = ?", [pid]);
  const orig = deps.find((d) => d.id === (proj && proj.original_deployment_id));
  const deckRow = zone ? await first("SELECT deployment_id, project_id FROM decks WHERE id = ?", [zone.id]) : null;
  const dl = dirtyDrafts(dev).map(([k]) => k);
  console.log("   측정: 오프라인 draft 키=" + JSON.stringify(kept) + " · 복귀 자동 쓰기요청=" + autoReq + " 자동 배포본=" + autoRows +
    " · 복귀 시 화면 도면형식=" + restoredType + " 핀=" + restoredPins + " · 첫 구역 후 배포본=" + deps.length + " 원본=" + (proj && proj.original_deployment_id) +
    " 원본 source_meta=" + !!(orig && orig.source_meta) + " 원본 핀=" + (orig ? JSON.parse(orig.pins || "[]").length : "-") + " · deck→dep=" + (deckRow && deckRow.deployment_id) + " · 남은 dirty draft=" + JSON.stringify(dl));
  measure("A5", autoRows === 0, variant + " 설계(P0-2): 구역 없는 오프라인 등록분은 복귀 시 자동 생성 안 함(로컬 보존) — 자동 배포본 " + autoRows);
  ok("A5", !!zone && deps.every((d) => d.project_id === pid) && deps.length === (reloaded ? 1 : 2), variant + " 첫 구역 지정 → 배포본 생성(" + (reloaded ? "원본 1 · 창 방식" : "원본 + 구역 복사본") + "), 전부 project_id=" + pid);
  ok("A5", !!orig && !!deckRow && !!deckRow.deployment_id && (reloaded ? deckRow.deployment_id === orig.id : deckRow.deployment_id !== orig.id),
    variant + " 원본 기록(original_deployment_id) + deck 연결(" + (reloaded ? "창 방식 = 원본" : "구역 복사본") + ")");
  ok("A5", !!orig && JSON.parse(orig.pins || "[]").length === 1, variant + " 오프라인에서 찍은 핀이 원본 배포본에 저장");
  measure("A5", !!(orig && orig.source_meta), variant + " 원본 PDF(source_meta) 보존 — vm 은 IndexedDB 없음(원본 바이트 저장소 없음) → 새로고침 변형은 이미지로 복원됨");
  ok("A5", dl.length === 0, variant + " 첫 구역 저장 후 남은 dirty draft 0 — " + JSON.stringify(dl));
}

/* ══════════ A6 — 복귀 시 토큰 만료(401/403 login) → 안내 1회 · 보존 · 재로그인 후 업로드 ══════════ */
console.log("\n[A6] 복귀 시 세션 만료 → 재로그인 안내 1회 · draft 보존 · 재로그인 후 자동 업로드");
{
  await mkMember("prj_A", USERS.c, "designer");
  const { depId, deck } = await seedDeployment([P(6001)], "prj_A");
  const dev = makeDevice();
  const C = makeClient("c", dev);
  await open(C, depId, deck, "prj_A");
  C.nav.onLine = false;
  const c1 = await place(C, 33, 33);
  await sleep(10);
  await run("UPDATE local_sessions SET revoked = 1 WHERE email = ?", [USERS.c]);
  await reconnect(C);
  await C.SyncQueue._onReconnect(); await sleep(10);          // 두 번째 기회에도 안내 반복 없음
  const exp = C.toasts.filter((t) => /로그인이 만료/.test(t));
  const d = draftsOf(dev)["prj_A::" + deck.id] || {};
  const s1 = idsOf(await srvPins(depId));
  // 재로그인 — 새 세션 발급 → 실 Auth.refresh()(/api/auth/me) 가 보류분을 이어 올린다
  C.Auth.idToken = await newSession("c", USERS.c);
  await C.Auth.refresh();
  let s2 = [];
  for (let i = 0; i < 60 && !s2.includes(String(c1.id)); i++) { await sleep(50); s2 = idsOf(await srvPins(depId)); }   // refresh 가 비차단으로 올린다
  console.log("   측정: 만료 토스트=" + exp.length + " 게이트=" + C.gate() + " · draft dirty=" + d.dirty + " writeDenied=" + !!d.writeDenied + " · 만료 중 서버=" + JSON.stringify(s1) + " · 재로그인 후=" + JSON.stringify(s2));
  ok("A6", exp.length === 1 && C.gate() >= 1, "재로그인 안내 1회(토스트 1 · 로그인 게이트)");
  ok("A6", d.dirty === true && !d.writeDenied && !s1.includes(String(c1.id)), "만료 중 draft 보존(dirty, writeDenied 아님) · 서버 무변경");
  ok("A6", s2.includes(String(c1.id)), "재로그인 후 자동 업로드");
}

/* ══════════ A7 — 복귀 시 권한 없음(멤버 제거) → 보존 · 재시도 0 · 토스트 1회 ══════════ */
console.log("\n[A7] 복귀 시 403(멤버에서 제거됨)");
{
  await mkProject("prj_R");
  await mkMember("prj_R", USERS.b, "designer");
  const { depId, deck } = await seedDeployment([P(7001)], "prj_R");
  const dev = makeDevice();
  const B = makeClient("b", dev);
  await open(B, depId, deck, "prj_R");
  B.nav.onLine = false;
  const b1 = await place(B, 44, 44); await sleep(10);
  const rm = await api("a", "DELETE", "/api/projects/prj_R/members/" + encodeURIComponent(USERS.b));
  await reconnect(B);
  const n1 = B.net.length;
  await B.SyncQueue._onReconnect(); await B.SyncQueue._onReconnect(); await sleep(10);
  const retries = depWrites(B, n1).length;
  const deny = B.toasts.filter((t) => /쓰기 권한이 없어/.test(t));
  const d = draftsOf(dev)["prj_R::" + deck.id] || {};
  const s = idsOf(await srvPins(depId));
  console.log("   측정: 제거=" + rm.status + " · 토스트=" + deny.length + " 게이트=" + B.gate() + " · 이후 재연결 2회 쓰기요청=" + retries + " · draft dirty=" + d.dirty + " writeDenied=" + d.writeDenied + " 핀 보존=" + (d.pins || []).some((p) => String(p.id) === String(b1.id)) + " · 서버=" + JSON.stringify(s));
  ok("A7", rm.status === 200 && !s.includes(String(b1.id)), "제거된 멤버의 오프라인 작업은 서버에 쓰이지 않음");
  ok("A7", d.dirty === true && d.writeDenied === true && (d.pins || []).some((p) => String(p.id) === String(b1.id)), "draft 보존(작업분 그대로)");
  ok("A7", retries === 0 && deny.length === 1 && B.gate() === 0, "무한 재시도 0 · '권한 없음' 토스트 1회 · 재로그인 창 안 띄움");
}

/* ══════════ A8 — 복귀 시 프로젝트 삭제(409) ══════════ */
console.log("\n[A8] 복귀 시 프로젝트 삭제됨(409)");
{
  await mkProject("prj_D");
  const { depId, deck } = await seedDeployment([P(8001)], "prj_D");
  const dev = makeDevice();
  const A = makeClient("a", dev);
  await open(A, depId, deck, "prj_D");
  A.nav.onLine = false;
  const a1 = await place(A, 44, 44); await sleep(10);
  const del = await api("a", "DELETE", "/api/projects/prj_D");
  await reconnect(A);
  const n1 = A.net.length;
  await A.SyncQueue._onReconnect(); await sleep(10);
  const t = A.toasts.filter((x) => /프로젝트가 삭제되어/.test(x));
  const d = draftsOf(dev)["prj_D::" + deck.id] || {};
  const row = await first("SELECT pins, version FROM deployments WHERE id = ?", [depId]);
  console.log("   측정: 삭제=" + del.status + " · 토스트=" + t.length + " · 이후 쓰기요청=" + depWrites(A, n1).length + " · draft dirty=" + d.dirty + " writeDenied=" + d.writeDenied + " · 서버 핀=" + JSON.stringify(idsOf(JSON.parse(row.pins))));
  ok("A8", del.status === 200 && !idsOf(JSON.parse(row.pins)).includes(String(a1.id)), "삭제된 프로젝트 배포본에 쓰기 0");
  ok("A8", d.dirty === true && (d.pins || []).some((p) => String(p.id) === String(a1.id)) && t.length === 1 && depWrites(A, n1).length === 0, "draft 보존 · 삭제 안내 1회 · 재시도 0");
}

/* ══════════ A9 — 오프라인 중 여러 번 새로고침 + 30개 이상 → 유실 0 (localStorage 폴백 경로) ══════════ */
console.log("\n[A9] 오프라인 새로고침 3회 사이사이 12개씩(총 36) → 복귀");
{
  const { depId, deck } = await seedDeployment([], "prj_A");
  const dev = makeDevice();
  let A = makeClient("a", dev);
  await open(A, depId, deck, "prj_A");
  A.nav.onLine = false;
  const all = [];
  const seen = [];
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 12; i++) all.push(String((await place(A, 5 + i * 7, 10 + round * 25)).id));
    await sleep(10);
    A = makeClient("a", dev, { online: false });
    await open(A, depId, deck, "prj_A");
    seen.push(idsOf(A.State.pins).length);
  }
  await reconnect(A);
  const fin = idsOf(await srvPins(depId));
  const lost = all.filter((id) => !fin.includes(id));
  const srv = await srvPins(depId);
  const bytes = [...dev._m].reduce((s, [k, v]) => s + k.length + v.length, 0);
  console.log("   측정: 새로고침마다 화면 핀=" + JSON.stringify(seen) + " · 서버=" + fin.length + " 유실=" + lost.length + " 중복번호=" + dupLabels(srv).length + " · 기기 저장 " + bytes + "자");
  ok("A9", JSON.stringify(seen) === "[12,24,36]", "새로고침마다 누적 복원 12→24→36");
  ok("A9", lost.length === 0 && fin.length === 36 && dupLabels(srv).length === 0, "복귀 후 서버 36개 · 유실 0 · 번호 중복 0");
}

/* ══════════ A9-idb — 실 Chrome IndexedDB: 실 05_SyncQueue 로 큰 draft 저장 → 실제 페이지 새로고침 3회 → 무손실 ══════════ */
{
  const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  if (!fs.existsSync(CHROME)) console.log("\n[A9-idb] SKIP — Chrome 없음(" + CHROME + ")");
  else {
    console.log("\n[A9-idb] 실 Chrome · 실 IndexedDB · 실 SyncQueue — 36핀 + 2MB 페이지 draft · 새로고침 3회 · IDB 불가 시 폴백 한도");
    const r = await chromeIdbAudit(CHROME);
    console.log("   측정: " + JSON.stringify(r));
    ok("A9", r && r.idbRounds && r.idbRounds.every((x) => x.pins === 36 && x.pageLen === r.pageLen), "IndexedDB: 새로고침 3회 모두 36핀 · 페이지 바이트 동일");
    measure("A9", r && r.lsSave === true, "IDB 불가(사생활 모드 등) → localStorage 폴백으로 같은 draft(≈" + (r && r.pageLen) + "자) 저장 가능? saveDraft=" + (r && r.lsSave));
  }
}
async function chromeIdbAudit(CHROME) {
  const sq = rd(M + "05_SyncQueue.js");
  const page = (mode) => "<!doctype html><meta charset=utf-8><script>" + (mode === "noidb" ? "try{Object.defineProperty(window,'indexedDB',{value:undefined});delete window.indexedDB;}catch(e){}" : "") +
    "\n" + sq.replace(/\n  function docKind[\s\S]*$/, "") + "\nwindow.SQ = SyncQueue;</script>";
  const srv = http.createServer((q, s) => { s.writeHead(200, { "Content-Type": "text/html" }); s.end(page(q.url.includes("noidb") ? "noidb" : "idb")); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const tmp = path.join(ROOT, ".tmp", "p102-chrome-" + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  const ch = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", "--user-data-dir=" + tmp, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((res, rej) => { let b = ""; const to = setTimeout(() => rej(new Error("chrome start timeout")), 20000); ch.stderr.on("data", (d) => { b += d; const m = b.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(to); res(m[0]); } }); });
  const { default: WebSocket } = await import("ws");
  const out = { idbRounds: [] };
  try {
    const verRes = await fetch(wsUrl.replace("ws://", "http://").replace(/\/devtools\/browser\/.*/, "/json/list"));
    const tab = (await verRes.json()).find((t) => t.type === "page");
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((r) => ws.on("open", r));
    let seq = 0; const pend = new Map(); const evs = [];
    ws.on("message", (m) => { const j = JSON.parse(m); if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); } else if (j.method) evs.push(j.method); });
    const cmd = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    const ev = async (expr) => { const r = await cmd("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : r; };
    const nav = async (u) => { evs.length = 0; await cmd("Page.navigate", { url: u }); for (let i = 0; i < 100 && !evs.includes("Page.loadEventFired"); i++) await sleep(50); };
    await cmd("Page.enable");
    const base = "http://127.0.0.1:" + port + "/";
    await nav(base + "idb");
    const write = `(async()=>{const big="data:image/png;base64,"+"A".repeat(2*1024*1024);const pins=[];for(let i=0;i<36;i++)pins.push({id:1700000000000+i,x:i,y:i,page:1,label:String(i+1),checkboard:true});
      const ok=await SQ.saveDraft("prj::deck",{pages:[big],pins,dirty:true});return {ok,idb:!!(await SQ._open()),pageLen:big.length};})()`;
    const w = await ev(write);
    out.idbWrite = w && w.ok; out.idbOpen = w && w.idb; out.pageLen = w && w.pageLen;
    for (let i = 0; i < 3; i++) {
      await cmd("Page.reload", { ignoreCache: true }); evs.length = 0; for (let t = 0; t < 100 && !evs.includes("Page.loadEventFired"); t++) await sleep(50);
      const r = await ev(`(async()=>{const d=await SQ.loadDraft("prj::deck");return {pins:d?d.pins.length:-1,pageLen:d?d.pages[0].length:-1,idb:!!(await SQ._open())};})()`);
      out.idbRounds.push(r);
    }
    await nav(base + "noidb");
    const l = await ev(`(async()=>{const big="data:image/png;base64,"+"A".repeat(2*1024*1024);const pins=[];for(let i=0;i<36;i++)pins.push({id:i});return {hasIdb:("indexedDB" in window)&&!!window.indexedDB, ok:await SQ.saveDraft("prj::deck2",{pages:[big],pins,dirty:true})};})()`);
    out.lsHasIdb = l && l.hasIdb; out.lsSave = l && l.ok;
    ws.close();
  } catch (e) { out.error = String(e && e.message || e); }
  finally { try { ch.kill(); } catch {} srv.close(); await sleep(300); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  return out;
}

/* ══════════ B — 초대 ══════════ */
console.log("\n[B] 초대 로직 (서버 실 핸들러)");
await mkProject("prj_I");
const { depId: depI } = await seedDeployment([P(9001)], "prj_I");
async function patchAs(k) {
  const cur = await getDep(depI);
  const r = await api(k, "PATCH", "/tables/deployments/" + depI, { base_version: cur.version, pins: cur.pins });
  return r.status;
}
const tokenOf = (url) => (url || "").split("invite=")[1] || "";
async function acceptInvite(tok, body, authK) {
  const r = await mf.dispatchFetch(BASE + "/api/invite/" + tok + "/accept", { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, authK ? { Authorization: "Bearer " + tokens[authK] } : {}), body: JSON.stringify(body || {}) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
}
const me = async (tok) => (await (await mf.dispatchFetch(BASE + "/api/auth/me", { headers: { Authorization: "Bearer " + tok } })).json());
const listed = async (k) => ((await api(k, "GET", "/api/projects")).j.data || []).map((p) => p.id);
{
  // B1 designer 초대(미가입 이메일) → 링크 수락 → 허브 노출 · 편집 200
  const inv = await api("a", "POST", "/api/projects/prj_I/members", { email: "newbie@seastar.test", role: "designer" });
  const tok = tokenOf(inv.j && inv.j.invite_url);
  const info = await api(null, "GET", "/api/invite/" + tok);
  const acc = await acceptInvite(tok, { name: "뉴비", password: "pw-12345678" });
  tokens.n = acc.j && acc.j.token; USERS.n = "newbie@seastar.test";
  const see = await listed("n");
  const w = await patchAs("n");
  console.log("   측정(B1): 초대=" + inv.status + " invited=" + (inv.j && inv.j.invited) + " · 조회=" + info.status + " needs_account=" + (info.j && info.j.needs_account) + " · 수락=" + acc.status + " · 허브 노출=" + see.includes("prj_I") + " · PATCH=" + w);
  ok("B1", inv.status === 200 && acc.status === 200 && see.includes("prj_I") && w === 200, "designer 초대 → 수락 → 허브 노출 · 배포본 PATCH 200");

  // B2 viewer 초대(가입된 이메일 → 즉시 멤버) → 쓰기 403 · 서버가 알려주는 역할 = viewer
  const invV = await api("a", "POST", "/api/projects/prj_I/members", { email: USERS.v, role: "viewer" });
  const wv = await patchAs("v");
  const mv = await me(tokens.v);
  const seeV = await listed("v");
  console.log("   측정(B2): 초대=" + invV.status + " existing=" + (invV.j && invV.j.existing) + " · PATCH=" + wv + " · /api/auth/me role=" + mv.role + " readonly=" + mv.readonly + " · 허브 노출=" + seeV.includes("prj_I"));
  ok("B2", invV.status === 200 && wv === 403 && mv.role === "viewer", "viewer 초대 → 쓰기 403 · 역할 viewer(편집 UI 는 Auth.isDesigner=false 로 숨김)");

  // B3 초대받지 않은 designer
  const see3 = await listed("c");
  const w3 = await patchAs("c");
  console.log("   측정(B3): 비초대 designer(chloe) 허브 노출=" + see3.includes("prj_I") + " · PATCH=" + w3);
  ok("B3", w3 === 403, "초대받지 않은 designer 쓰기 403 — " + w3);
  measure("B3", !see3.includes("prj_I"), "허브 노출(TEMP_OPEN_ALL_TENANTS=true 면 전원 노출 — 스위치 설계대로) — 노출=" + see3.includes("prj_I"));

  // B4 토큰
  const bad1 = await api(null, "GET", "/api/invite/zzz");
  const bad2 = await api(null, "GET", "/api/invite/" + "ab".repeat(32));
  const reuse = await acceptInvite(tok, { name: "x", password: "pw-12345678" });
  const invE = await api("a", "POST", "/api/projects/prj_I/members", { email: "exp@seastar.test", role: "designer" });
  await run("UPDATE project_invites SET expires_at = 1 WHERE email = ?", ["exp@seastar.test"]);
  const expd = await acceptInvite(tokenOf(invE.j.invite_url), { name: "x", password: "pw-12345678" });
  const invR = await api("a", "POST", "/api/projects/prj_I/members", { email: "rev@seastar.test", role: "designer" });
  const iid = (await first("SELECT id FROM project_invites WHERE email = ?", ["rev@seastar.test"])).id;
  const rv = await api("a", "DELETE", "/api/projects/prj_I/invites/" + encodeURIComponent(iid));
  const revd = await acceptInvite(tokenOf(invR.j.invite_url), { name: "x", password: "pw-12345678" });
  const stored = await first("SELECT token_hash FROM project_invites WHERE email = ?", ["newbie@seastar.test"]);
  console.log("   측정(B4): 형식오류=" + bad1.status + " 없는토큰=" + bad2.status + " 재사용=" + reuse.status + " 만료=" + expd.status + " 취소(" + rv.status + ")=" + revd.status +
    " · 토큰=" + tok.length + "hex(" + tok.length * 4 + "bit) · DB 원문저장=" + (stored && stored.token_hash === tok));
  ok("B4", bad1.status === 404 && bad2.status === 404 && reuse.status === 404 && expd.status === 404 && revd.status === 404, "잘못된·재사용·만료·취소 토큰 전부 거부");
  ok("B4", /^[0-9a-f]{64}$/.test(tok) && stored && stored.token_hash !== tok, "토큰 256bit 암호난수(hex64) · DB 에는 해시만");
  // 다른 계정으로 수락: mallory(로그인 상태)가 eve 앞 초대 링크를 수락
  const invX = await api("a", "POST", "/api/projects/prj_I/members", { email: "eve@seastar.test", role: "designer" });
  const cross = await acceptInvite(tokenOf(invX.j.invite_url), { name: "mallory", password: "mallory-pw-1" }, "m");
  const crossMe = cross.j && cross.j.token ? await me(cross.j.token) : {};
  console.log("   측정(B4 교차): mallory 로그인 상태로 eve 초대 수락=" + cross.status + " → 발급 세션의 신원=" + crossMe.email + " (200 이면 eve 계정 비번을 mallory 가 정함)");
  // [WO 20261001-invite · 마스터 확정 ①] 다른 계정으로 로그인한 상태의 수락 = 403, 세션 발급 0
  ok("B4", cross.status === 403 && !(cross.j && cross.j.token) && !crossMe.email, "다른 계정(로그인 상태)이 남의 초대 수락 → 403 · 세션 발급 0 — " + cross.status);
  // 이미 가입된 이메일 앞 대기 초대: 비로그인 수락 → 401(세션 0) · 그 이메일 로그인 → 200(멤버, 새 세션 0)
  const invK = await api("a", "POST", "/api/projects/prj_I/members", { email: "kim@seastar.test", role: "designer" });
  const tokK = tokenOf(invK.j && invK.j.invite_url);
  USERS.k = "kim@seastar.test"; await addUser("k", USERS.k, false);   // 초대 후 다른 경로로 가입된 계정
  const infoK = await api(null, "GET", "/api/invite/" + tokK);
  const anonK = await acceptInvite(tokK, {});
  const wrongK = await acceptInvite(tokK, {}, "m");
  const memK0 = await first("SELECT role FROM project_members WHERE project_id = 'prj_I' AND email = ?", [USERS.k]);
  const selfK = await acceptInvite(tokK, {}, "k");
  const memK1 = await first("SELECT role FROM project_members WHERE project_id = 'prj_I' AND email = ?", [USERS.k]);
  console.log("   측정(B4 기존계정): 조회 needs_account=" + (infoK.j && infoK.j.needs_account) + " · 비로그인 수락=" + anonK.status + " 토큰=" + !!(anonK.j && anonK.j.token) +
    " · 타계정 수락=" + wrongK.status + " · 본인 로그인 수락=" + selfK.status + " 토큰=" + !!(selfK.j && selfK.j.token) + " → 멤버 " + JSON.stringify(memK0) + "→" + JSON.stringify(memK1));
  ok("B4", anonK.status === 401 && !(anonK.j && anonK.j.token) && anonK.j && anonK.j.code === "login_required", "가입된 이메일 링크 비로그인 수락 → 401 login_required · 세션 발급 0");
  ok("B4", wrongK.status === 403 && wrongK.j && wrongK.j.code === "wrong_account" && /초대받은 이메일로 로그인/.test(wrongK.j.error || ""), "타계정 로그인 수락 → 403 '초대받은 이메일로 로그인하세요'");
  ok("B4", !memK0 && selfK.status === 200 && !(selfK.j && selfK.j.token) && memK1 && memK1.role === "designer", "초대 이메일로 로그인한 상태에서만 수락(멤버 편입 · 새 세션 미발급)");
  // 클라(실 22_Auth + 실 37_Invite): 비로그인으로 링크 → 로그인 게이트 → 로그인(refresh) → 같은 토큰으로 자동 수락
  {
    const invC = await api("a", "POST", "/api/projects/prj_I/members", { email: "kc@seastar.test", role: "designer" });
    const tokC = tokenOf(invC.j && invC.j.invite_url);
    USERS.kc = "kc@seastar.test"; await addUser("kc", USERS.kc, false);
    const KC = makeClient("kc", makeDevice());
    const INV_SRC = rdEnv("P102_INV_SRC", M + "37_Invite.js");
    vm.runInContext(INV_SRC, KC.sandbox);
    const Inv = vm.runInContext("Invite", KC.sandbox);
    KC.Auth.user = null; KC.Auth.idToken = null; KC.Auth.role = "viewer";
    Inv._token = tokC; await Inv.open();
    const mode0 = Inv._mode;
    await Inv.accept();
    const pend = KC.sandbox.sessionStorage.getItem("wm_pending_invite");
    const gate0 = KC.gate();
    KC.Auth.idToken = tokens.kc; await KC.Auth.refresh();          // 로그인 완료 지점(모든 로그인 경로 공통)
    let memC = null;
    for (let i = 0; i < 40 && !memC; i++) { await sleep(25); memC = await first("SELECT role FROM project_members WHERE project_id = 'prj_I' AND email = ?", [USERS.kc]); }
    // 다른 계정(mallory)으로 로그인한 기기에서 링크
    const invW = await api("a", "POST", "/api/projects/prj_I/members", { email: "kw@seastar.test", role: "viewer" });
    const MW = makeClient("m", makeDevice());
    vm.runInContext(INV_SRC, MW.sandbox);
    const InvW = vm.runInContext("Invite", MW.sandbox);
    InvW._token = tokenOf(invW.j && invW.j.invite_url); await InvW.open();
    const errW = String(MW.sandbox.document.getElementById("inv-error").textContent || "");
    console.log("   측정(B4 클라): 비로그인 모드=" + mode0 + " · 참여클릭 → 보류토큰=" + (pend === tokC) + " 로그인게이트=" + gate0 + " · 로그인 후 멤버=" + JSON.stringify(memC) +
      " 토스트=" + JSON.stringify(KC.toasts.filter((t) => /참여/.test(t))) + " · 타계정 모드=" + InvW._mode + " 안내=" + errW.slice(0, 30));
    ok("B4", mode0 === "login" && pend === tokC && gate0 >= 1, "클라: 가입된 이메일·비로그인 → 로그인 게이트 + 토큰 보류");
    ok("B4", !!memC && memC.role === "designer" && !KC.sandbox.sessionStorage.getItem("wm_pending_invite"), "클라: 로그인 직후 같은 토큰으로 자동 수락 → 멤버 편입 · 보류 토큰 소거");
    ok("B4", InvW._mode === "wrong" && /초대받은 이메일\(kw@seastar\.test\)로 로그인하세요/.test(errW), "클라: 다른 계정 로그인 상태 → '초대받은 이메일로 로그인하세요'");
  }

  // B5 멤버 제거 → 즉시 403
  const w5a = await patchAs("n");
  const rm = await api("a", "DELETE", "/api/projects/prj_I/members/" + encodeURIComponent("newbie@seastar.test"));
  const w5b = await patchAs("n");
  const leg = await api("a", "POST", "/tables/deployments", { title: "레거시", pins: "[]" });
  const legW = await api("n", "PATCH", "/tables/deployments/" + leg.j.id, { pins: "[]" });
  const glob = await first("SELECT deleted, added_by FROM designers WHERE email = ?", ["newbie@seastar.test"]);
  console.log("   측정(B5): 제거 전=" + w5a + " 제거=" + rm.status + " 제거 후=" + w5b + " · 전역 designers 행 deleted=" + (glob && glob.deleted) + " added_by=" + (glob && glob.added_by) + " · 레거시(project_id NULL) PATCH=" + legW.status);
  ok("B5", w5a === 200 && rm.status === 200 && w5b === 403, "멤버 제거 → 즉시 쓰기 403");
  measure("B5", !(glob && Number(glob.deleted) === 0), "제거 후에도 초대로 받은 전역 designer 권한이 남는가(레거시 NULL 배포본 쓰기 " + legW.status + ")");

  // B6 미가입 이메일 초대 → 그 이메일로 자체가입 → 자동 멤버?
  const inv6 = await api("a", "POST", "/api/projects/prj_I/members", { email: "late@seastar.test", role: "designer" });
  const sc = await api(null, "POST", "/api/signup/send-code", { email: "late@seastar.test" });
  const vf = await api(null, "POST", "/api/signup/verify", { email: "late@seastar.test", code: sc.j && sc.j.dev_code, password: "late-pw-123", name: "레이트", department: "설계" });
  const mem6a = await first("SELECT role FROM project_members WHERE project_id = 'prj_I' AND email = ?", ["late@seastar.test"]);
  const info6 = await api(null, "GET", "/api/invite/" + tokenOf(inv6.j.invite_url));
  const acc6 = await acceptInvite(tokenOf(inv6.j.invite_url), {});             // 가입 후 링크 수락(비밀번호 없음)
  const mem6b = await first("SELECT role FROM project_members WHERE project_id = 'prj_I' AND email = ?", ["late@seastar.test"]);
  const me6 = acc6.j && acc6.j.token ? await me(acc6.j.token) : {};
  console.log("   측정(B6): 초대=" + inv6.status + " · 가입 send=" + sc.status + " verify=" + vf.status + " → 가입 직후 멤버=" + JSON.stringify(mem6a) + " · 링크 needs_account=" + (info6.j && info6.j.needs_account) +
    " · 수락(비밀번호 없이)=" + acc6.status + " → 멤버=" + JSON.stringify(mem6b) + " · 수락 응답 세션 신원=" + me6.email);
  // [WO 20261001-invite · 마스터 확정 ②] 인증 완료 가입 = 대기 초대 자동 편입 + 초대 소진
  const used6 = await first("SELECT used FROM project_invites WHERE project_id = 'prj_I' AND email = ?", ["late@seastar.test"]);
  ok("B6", vf.status === 200 && !!mem6a && mem6a.role === "designer" && used6 && Number(used6.used) === 1, "메일 인증 가입 직후 대기 초대 자동 멤버 편입 · 초대 소진 — " + JSON.stringify(mem6a));
  ok("B6", !(acc6.j && acc6.j.token), "가입된 계정 앞 링크를 비밀번호 없이 수락해도 세션 미발급 — " + acc6.status);
  // 로그인(/api/auth/me) 경로: 인증된 계정만 편입, 미인증 계정은 편입 금지
  const inv6v = await api("a", "POST", "/api/projects/prj_I/members", { email: "gv@seastar.test", role: "viewer" });
  const inv6u = await api("a", "POST", "/api/projects/prj_I/members", { email: "gu@seastar.test", role: "designer" });
  USERS.gv = "gv@seastar.test"; await addUser("gv", USERS.gv, false);
  USERS.gu = "gu@seastar.test"; await addUser("gu", USERS.gu, false);
  await run("UPDATE local_users SET email_verified = 0 WHERE email = ?", [USERS.gu]);
  await me(tokens.gv); await me(tokens.gu);
  const m6v = await first("SELECT role FROM project_members WHERE project_id = 'prj_I' AND email = ?", [USERS.gv]);
  const m6u = await first("SELECT role FROM project_members WHERE project_id = 'prj_I' AND email = ?", [USERS.gu]);
  const u6u = await first("SELECT used FROM project_invites WHERE project_id = 'prj_I' AND email = ?", [USERS.gu]);
  console.log("   측정(B6 로그인): 초대=" + inv6v.status + "/" + inv6u.status + " · 인증계정 로그인 후 멤버=" + JSON.stringify(m6v) + " · 미인증계정 로그인 후 멤버=" + JSON.stringify(m6u) + " 초대 used=" + (u6u && u6u.used));
  ok("B6", m6v && m6v.role === "viewer", "인증된 계정의 첫 로그인(/api/auth/me) → 대기 초대 자동 편입");
  ok("B6", !m6u && u6u && Number(u6u.used) === 0, "이메일 미인증 계정은 편입 금지 · 초대 보존");

  // B7 역할 변경 viewer → designer 즉시 반영(그리고 역방향)
  const w7a = await patchAs("v");
  const up = await api("a", "POST", "/api/projects/prj_I/members", { email: USERS.v, role: "designer" });
  const w7b = await patchAs("v");
  const dn = await api("a", "POST", "/api/projects/prj_I/members", { email: USERS.v, role: "viewer" });
  const w7c = await patchAs("v");
  console.log("   측정(B7): viewer PATCH=" + w7a + " → designer 로(" + up.status + ") PATCH=" + w7b + " → 다시 viewer(" + dn.status + ") PATCH=" + w7c);
  ok("B7", w7a === 403 && w7b === 200 && w7c === 403, "역할 변경 즉시 반영(viewer 403 → designer 200 → viewer 403)");

  // B8 자동입장 공용석 — 측정만
  const ae = await api(null, "POST", "/api/auth/auto-entry", { kind: "designer" });
  tokens.auto = ae.j && ae.j.token;
  const w8 = await patchAs("auto");
  const m8 = await api("auto", "POST", "/api/projects/prj_I/members", { email: "stranger@seastar.test", role: "designer" });
  console.log("   측정(B8): 익명 auto-entry=" + ae.status + " kind=" + (ae.j && ae.j.kind) + " · 남의 프로젝트 배포본 PATCH=" + w8 + " · 남의 프로젝트에 멤버 초대=" + m8.status);
  // [WO 20261001-invite · 마스터 확정 ④] 전체개방 종료 — 공용석 designer 발급 0 · 쓰기 0 · 초대 0
  // [WO 20261009-readacl] 열람 토큰도 열람 링크가 있어야 발급 → 링크 없는 designer 요청 = 401(토큰 0) — 종전 "viewer 강등 발급"보다 강하다.
  const noTok = ae.status === 401 && !(ae.j && ae.j.token);
  ok("B8", (noTok || (ae.j && ae.j.kind === "viewer" && ae.j.readonly === true)) && w8 === 403 && m8.status === 403, "로그인 없는 공용석: designer 발급 거부(" + (noTok ? "401 토큰 없음" : "viewer") + ") · PATCH " + w8 + " · 초대 " + m8.status);
  const legacy = await api("auto-designer-entry-360", "PATCH", "/tables/deployments/" + depI, { pins: "[]" });
  ok("B8", legacy.status === 403, "레거시 고정 문자열 토큰 쓰기 거부 — " + legacy.status);
  // 공용석(auto.designer) 소유 프로젝트: 익명 열람 토큰이 '소유자'로 둔갑하지 않음 · super 는 관리 가능
  await mkProject("prj_AUTO", "auto.designer@seastargo.com");
  USERS.s = "designssir@gmail.com"; await addUser("s", USERS.s, false);
  const { depId: depAuto } = await seedDeployment([P(9101)], "prj_AUTO", "s");
  const anonSee = ((await api("auto", "GET", "/api/projects")).j.data || []).find((p) => p.id === "prj_AUTO");
  const sunList = await listed("c");
  const sInv = await api("s", "POST", "/api/projects/prj_AUTO/members", { email: USERS.c, role: "designer" });
  const curA = await getDep(depAuto);
  const sW = await api("s", "PATCH", "/tables/deployments/" + depAuto, { base_version: curA.version, pins: curA.pins });
  const cW = (await api("c", "PATCH", "/tables/deployments/" + depAuto, { base_version: (await getDep(depAuto)).version, pins: curA.pins })).status;
  console.log("   측정(B8 공용석 소유): 익명 열람토큰에 prj_AUTO 노출=" + !!anonSee + (anonSee ? " is_member=" + anonSee.is_member : "") + " · chloe 허브 노출=" + sunList.includes("prj_AUTO") +
    " · super 멤버추가=" + sInv.status + " super PATCH=" + sW.status + " · 추가된 chloe PATCH=" + cW);
  ok("B8", !anonSee, "공용석 소유 미배포 프로젝트가 익명 열람 토큰에 노출되지 않음(소유자 둔갑 0)");
  ok("B8", sInv.status === 200 && sW.status === 200 && cW === 200, "공용석 소유 프로젝트 = super(designssir) 가 멤버 추가·쓰기 가능 → 데이터 접근 단절 0");

  // B9 초대 관리 권한 — 가정: 소유자·super 만
  await mkMember("prj_I", USERS.b, "designer");
  const b9a = await api("b", "POST", "/api/projects/prj_I/members", { email: "friend@seastar.test", role: "designer" });
  const b9b = await api("b", "DELETE", "/api/projects/prj_I/members/" + encodeURIComponent(USERS.v));
  const c9a = await api("c", "POST", "/api/projects/prj_I/members", { email: USERS.c, role: "designer" });   // 비멤버가 자기 자신을 designer 로
  const c9b = await patchAs("c");
  const d9 = await api("d", "POST", "/api/projects/prj_I/members", { email: USERS.d, role: "designer" });    // 전역 designer 아님
  console.log("   측정(B9): 멤버 designer(bruno) 초대=" + b9a.status + " 제거=" + b9b.status + " · 비멤버 designer(chloe) 자기 추가=" + c9a.status + " → PATCH=" + c9b + " · 비designer(dora) 자기 추가=" + d9.status);
  ok("B9", b9a.status === 403 && b9b.status === 403, "멤버 designer 의 초대·제거 차단(소유자·super 만) — 초대 " + b9a.status + " 제거 " + b9b.status);
  ok("B9", c9a.status === 403 && c9b === 403, "비멤버 designer 가 자기 자신을 designer 로 추가 → 403 · 쓰기 403 — 추가 " + c9a.status + " → PATCH " + c9b);
  // 역할 변경 · 접근신청 승인 · 권한 매트릭스(형제 경로)도 같은 규칙
  const b9c = await api("b", "POST", "/api/projects/prj_I/members", { email: USERS.b, role: "designer" });          // 멤버 designer 의 역할 변경(자기 자신)
  const b9m = await api("b", "POST", "/api/admin/access-matrix", { updates: [{ email: "mx@seastar.test", project_id: "prj_I", role: "designer" }] });
  const mx = await first("SELECT role FROM project_members WHERE project_id = 'prj_I' AND email = ?", ["mx@seastar.test"]);
  await run("INSERT INTO project_access_requests (id, project_id, email, message, status, created_at, updated_at) VALUES ('par_p102', 'prj_I', ?, '', 'pending', ?, ?)", [USERS.d, Date.now(), Date.now()]);
  const b9r = await api("b", "POST", "/api/projects/prj_I/access-requests/par_p102/approve");
  const sOwn = await api("s", "DELETE", "/api/projects/prj_I/members/" + encodeURIComponent(USERS.a));
  const aOwn = await api("a", "DELETE", "/api/projects/prj_I/members/" + encodeURIComponent(USERS.a));
  const sAdd = await api("s", "POST", "/api/projects/prj_I/members", { email: "byadmin@seastar.test", role: "viewer" });
  console.log("   측정(B9 형제): 멤버 역할변경=" + b9c.status + " · 매트릭스 반영=" + JSON.stringify(mx) + " · 접근신청 승인=" + b9r.status + " · 소유자 제거(super)=" + sOwn.status + " (본인)=" + aOwn.status + " · super 초대=" + sAdd.status);
  ok("B9", b9c.status === 403 && !mx && b9r.status === 403, "멤버 designer 의 역할 변경·매트릭스·접근신청 승인도 403");
  ok("B9", sOwn.status === 400 && aOwn.status === 400 && sAdd.status === 200, "소유자는 제거 불가(super·본인 모두) · super 는 초대 가능");
  ok("B9", d9.status === 403, "전역 designer 가 아닌 사용자의 멤버 관리 거부 — " + d9.status);
}

await mf.dispose();
try { fs.unlinkSync(workerOut); } catch {}
clearTimeout(watchdog);
console.log("\n항목별: " + Object.entries(R).map(([k, v]) => k + "=" + (v ? "PASS" : "FAIL")).join(" "));
console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
