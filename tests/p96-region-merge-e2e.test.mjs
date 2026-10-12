/**
 * p96 — 실환경 E2E: 구역 단위 포인트 합치기(D5 · 41_RegionMerge.js)
 * (프레임워크 0 · 실행: node tests/p96-region-merge-e2e.test.mjs)
 *
 * 마스터 원문(2026-09-30): "다른 사람이 한 포인트도 전체 복사해서 구역 단위로 합치는 기능도 구현해.
 *   모든 기능은 가장 쉽고 심플하지만 강력하고 버그 없이."
 *
 * 🔴 목 금지 범위: p93 하니스 그대로 — 서버 = src/index.tsx 실 번들 → Miniflare + 실 D1(migrations 전부) + 실 R2.
 *   클라 = 01_State · 01b_PinSeries · 02_PDF · 10_MapCtrl · 20_App · 31_Projects · 41_RegionMerge 실 소스(vm, 사람마다 realm).
 *   벡터 복사는 실 pdf-lib. 대체 경계 = DOM 스텁 · IndexedDB 메모리 · pdf.js 캔버스 렌더 뿐.
 * 검사: ⑨ 좌표 왕복 <1e-9 · 범위 밖 미복사 / ⑩ 두 번째 합치기 0건(+증분) / ⑪ 되돌리기 = 합치기 전 /
 *   모드 분리(핀 계열만) / Jev 폴백(키 없음 → 거리 규칙) / 0031 원본 상자 기록·합성·신뢰 경계 / 노트 옵션.
 * 뮤테이션: P96_MERGE_SRC=<변형 41_RegionMerge.js> 로 주입(M7: srcPinId 멱등 검사 제거 → ⑩ FAIL → EXIT=1).
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
  merge: process.env.P96_MERGE_SRC ? fs.readFileSync(process.env.P96_MERGE_SRC, "utf8").replace(/\r\n/g, "\n") : rd("public/js/modules/41_RegionMerge.js"),
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
const workerOut = path.join(os.tmpdir(), "p96-worker-" + process.pid + ".mjs");
await esbuild.build({
  entryPoints: [path.join(ROOT, "src/index.tsx")], bundle: true, format: "esm", platform: "neutral",
  outfile: workerOut, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
  conditions: ["workerd", "worker", "browser"],
});
const mf = new Miniflare({
  modules: true, scriptPath: workerOut, d1Databases: { DB: "p96-" + Date.now() },
  r2Buckets: { R2: "p96r2-" + Date.now() }, bindings: { DEMO_LOGIN: "0" }, compatibilityDate: "2025-01-01",
});
const BASE = "http://p96.test";
const db = await mf.getD1Database("DB");
for (const f of MIGS) for (const st of stmtsOf(f)) await db.exec(st);

const USERS = { a: "alice@seastar.test", b: "bruno@seastar.test", c: "chloe@seastar.test", bob: "bob@outside.test", carol: "carol@outside.test" };
const TOK = (k) => "local-p96-" + k;
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
  for (const s of [SRC.vendorPdfLib, SRC.state, SRC.series, SRC.pdf, SRC.map, SRC.app, SRC.proj, SRC.merge]) vm.runInContext(s, sandbox);
  vm.runInContext("globalThis.__X = { State, PinSeries, PDF, MapCtrl, App, Projects, RegionMerge };", sandbox);
  const { State, App, Projects, PDF, MapCtrl, RegionMerge, PinSeries } = sandbox.__X;
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
  return { k, sandbox, State, App, Projects, PDF, nav, net, drafts, RM: RegionMerge, PinSeries, MapCtrl };
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
const live = (arr) => (arr || []).filter((p) => p && !p._deleted);
const snapPins = (arr) => JSON.stringify(live(arr).map((p) => [String(p.id), p.x, p.y, p.page || 1, String(p.label)]).sort());

/* ══════════ 준비 — 원본 PDF 등록 → 벡터 복사 구역 2개(겹침) ══════════ */
console.log("\n[준비] 원본 등록 → 구역1(벡터 복사) · 구역2(벡터 복사, 구역1과 일부 겹침)");
const SRC_W = 1000, SRC_H = 500;
const srcBytes = await (async () => {
  const d = await PDFLib.PDFDocument.create();
  const font = await d.embedFont(PDFLib.StandardFonts.Helvetica);
  const p = d.addPage([SRC_W, SRC_H]);
  for (let x = 20; x < SRC_W; x += 60) for (let y = 20; y < SRC_H; y += 40) p.drawText("G" + x + "_" + y, { x, y, size: 6, font });
  return await d.save();
})();
const CROP1 = { x: 10, y: 20, w: 40, h: 30 };
const CROP2 = { x: 30, y: 25, w: 40, h: 40 };
const A = makeClient("a");
A.Projects.currentProject = { id: "prj_A", name: "prj_A" };
A.Projects.currentDeck = null; A.Projects.decks = [];
A.State.reset(); A.State.mode = "designer"; A.State.regMode = "checkboard";
A.State.fileType = "pdf"; A.State.fileName = "GA.pdf"; A.State.fileData = new A.sandbox.__U8(srcBytes).buffer;
A.State.pdfDoc = { numPages: 1, __bytes: srcBytes }; A.State.pdfPage = 1; A.State.pdfPages = 1;
await A.App._createInitialSave();
const ORIG = A.State.autoSaveDepId;
const zone1 = await A.Projects.createDeckFromLoadedDrawing({ crop: CROP1, name: "구역1" });
const zone2 = await A.Projects.createDeckFromLoadedDrawing({ crop: CROP2, name: "구역2" });
ok(!!zone1 && zone1.src_dep_id === ORIG && zone1.src_page === 1 && JSON.stringify(zone1.src_crop) === JSON.stringify(CROP1),
  "R0 구역1 생성 시 원본 상자 기록(0031) — src_dep_id=원본 · src_crop=" + JSON.stringify(zone1 && zone1.src_crop));
ok(!!zone2 && zone2.src_dep_id === ORIG && JSON.stringify(zone2.src_crop) === JSON.stringify(CROP2), "R0 구역2 원본 상자 기록");
// 복사본 안에서 다시 자른 영역 → 원본까지 합성(같은 기준 배포본 공유)
A.Projects.currentDeck = zone1;
await A.App.loadDeckDrawing(zone1.deployment_id);
const AREA = { x: 50, y: 0, w: 50, h: 100 };
const area1 = await A.Projects.extractRegionAsDeck({ crop: AREA, name: "구역1-영역" });
const wantArea = { x: 30, y: 20, w: 20, h: 30 };
const eq = (a, b) => ["x", "y", "w", "h"].every((k) => Math.abs(a[k] - b[k]) < 1e-9);
ok(!!area1 && area1.src_dep_id === ORIG && area1.src_crop && eq(area1.src_crop, wantArea),
  "R0 영역(복사본의 복사본)의 원본 상자 = 원본 기준으로 합성 " + JSON.stringify(area1 && area1.src_crop));
{
  const bad = await api("a", "POST", "/api/projects/prj_A/decks", { name: "bad", src_dep_id: ORIG, src_page: 1 });
  const bad2 = await api("a", "PUT", "/api/decks/" + zone1.id, { src_dep_id: ORIG, src_page: 1, src_crop: { x: 1, y: 1, w: 0, h: 1 } });
  ok(bad.status === 400 && bad2.status === 400, "R0 src_* 신뢰 경계 — 일부만 전송 400 · w=0 400 (" + bad.status + "/" + bad2.status + ")");
}

/* [WO 20261012-pinsync] 🔴 픽스처 개정 — 벡터 복사 구역은 이제 자기 핀이 0개면 원본과 연동된다(서버 별칭: 구역 핀 = 원본 핀,
 *   마스터 "서로 연동되게"). 그 구역끼리의 "포인트 가져오기"는 자기 복제가 되므로 아래 [연동] 블록·p151 이 검증한다.
 *   합치기(복사) 경로는 **이 기능 이전에 만든 구역 = 자기 핀을 가진 구역(서버 pin_alias:'pending')** 에서 그대로 유효하다 →
 *   구역1·구역2 를 그 상태로 만든다: 각 구역 행에 이전 버전이 저장한 핀 1개를 심고(DB 직접), 사용자가 그 핀을 지운 뒤 작업한다.
 *   지우는 저장 순간에도 구역 행엔 살아있는 핀이 있어 pending 이 유지된다 → 아래 검사 수치·단정은 종전과 동일. */
const LEGACY = { id: "legacy-own", x: 99, y: 99, page: 1, label: "L" };
for (const z of [zone1, zone2]) await db.prepare("UPDATE deployments SET pins = ? WHERE id = ?").bind(JSON.stringify([LEGACY]), z.deployment_id).run();
const dropLegacy = (c) => { c.State.pins = c.State.pins.filter((p) => p.id !== LEGACY.id); };
ok((await getDep(zone1.deployment_id)).pin_alias === "pending", "R0' 자기 핀 있는 구역 = pending(자동 연동·변환 없음)");

/* ══════════ B(다른 사람 · 프로젝트 설계자 멤버) 가 구역1 에서 작업 ══════════ */
const invB = await api("a", "POST", "/api/projects/prj_A/members", { email: USERS.b, role: "designer" });
ok(invB.status === 200, "B 를 prj_A 설계자로 초대(" + invB.status + ")");
const B = makeClient("b");
B.Projects.currentProject = { id: "prj_A", name: "prj_A" };
B.Projects.currentDeck = zone1;
await B.App.loadDeckDrawing(zone1.deployment_id);
dropLegacy(B);
B.State.mode = "designer"; B.State.regMode = "checkboard";
const b1 = await place(B, 75, 50);   // 원본 (40,35) → 구역2 화면 (25,25)
const b2 = await place(B, 10, 10);   // 원본 (14,23) → 구역2 범위 밖
B.State.pins.push({ id: 777001, x: 75, y: 80, page: 1, label: "P1", imageId: "img-360-a", imageName: "R0010001", is360: true, createdAt: 1700000000000 });  // 360 계열(콘텐츠)
ok(await save(B), "B 구역1 에 핀 저장(체크 2 · 360 1) — b2=" + b2.id);

/* ══════════ ⑨ 좌표 왕복 · 범위 밖 미복사 ══════════ */
console.log("\n[⑨] 좌표 변환 — 원본 기준 경유, 새 수식 0");
{
  const RM = A.RM;
  const s1 = RM.boxOf(zone1), s2 = RM.boxOf(zone2);
  let worst = 0, n = 0;
  for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20; j++) {
    const p = { x: 25 + i * 2.5, y: 25 + j * 2.5, page: 1 };   // 구역1 화면 25~75 %
    const q = RM.fromBase(s2, RM.toBase(s1, p));
    if (!q) continue;
    const back = RM.fromBase(s1, RM.toBase(s2, q));
    worst = Math.max(worst, Math.abs(back.x - p.x), Math.abs(back.y - p.y)); n++;
  }
  console.log("   측정: 겹침 안 표본 " + n + "점 · 최대 왕복 오차 " + worst.toExponential(2));
  ok(n > 50 && worst < 1e-9, "⑨ 왕복 오차 < 1e-9 (" + worst.toExponential(2) + ", " + n + "점)");
}

/* ══════════ 합치기 — A 가 구역2 를 열고 구역1 포인트 가져오기(CHECKER) ══════════ */
console.log("\n[M] A: 구역2 ← 구역1 (CHECKER)");
A.Projects.currentDeck = zone2;
await A.App.loadDeckDrawing(zone2.deployment_id);
dropLegacy(A);
A.State.mode = "designer"; A.State.regMode = "checkboard";
// 대상에 이미 있는 핀: 들어올 핀(25,25)과 0.5% 거리(같은 위치)
await place(A, 25.3, 25.4);
ok(await save(A), "A 구역2 기존 핀 저장");
const before = snapPins(A.State.pins);
const beforeSrv = snapPins(await srvPins(zone2.deployment_id));
ok(A.RM.canMergeInto(zone2), "M 대상 조건(설계자 · 로드된 배포본) 충족");
A.Projects.decks = [zone1, zone2, area1];
A.Projects.currentProject = { id: "prj_A", name: "prj_A", original_deployment_id: ORIG };
const cands = A.RM.candidates(zone2);
ok(cands.some((d) => d.id === zone1.id) && !cands.some((d) => d.id === zone2.id) && cands.some((d) => d.original),
  "M 후보 = 다른 구역 + 원본 도면, 대상 자신 제외 — " + cands.map((d) => d.name).join(","));
const prep = await A.RM.prepare(zone2, zone1, { photos: true });
const pl = prep.plan;
console.log("   측정: total=" + pl.total + " items=" + pl.items.length + " outside=" + pl.outside + " already=" + pl.already + " otherMode=" + pl.otherMode + " dups=" + JSON.stringify(prep.dups));
ok(pl.total === 2 && pl.items.length === 1 && pl.outside === 1, "⑨ 범위 밖 1개는 가져오지 않고 개수 표시(total 2 · 가져옴 1 · 밖 1)");
const np = prep.pins[0];
ok(!!np && Math.abs(np.x - 25) < 1e-9 && Math.abs(np.y - 25) < 1e-9 && np.page === 1, "⑨ 변환 좌표 = 원본 경유 기대값(25,25) — " + (np && [np.x, np.y]));
ok(pl.otherMode === 1 && !prep.pins.some((p) => !p.checkboard), "모드 분리 — CHECKER 대상엔 360 핀을 가져오지 않음(otherMode=1)");
ok(!!np && np.label === b1.label && np.srcDeckId === String(zone1.id) && np.srcPinId === String(b1.id) && !!np.mergeBatchId && typeof np.id === "string",
  "번호 원본 유지 · srcDeckId/srcPinId/mergeBatchId · 문자열 id");
// Jev 폴백: 로컬 워커엔 OPENROUTER_API_KEY 없음 → no-key → 거리 규칙
const d0 = prep.dups.find((d) => d.i === 0);
ok(!!d0 && d0.source === "rule" && d0.reason === "no-key" && d0.verdict === "same" && prep.include[0] === false,
  "Jev 폴백(키 없음) → 거리 규칙 same(0.5%) → 기본 선택 해제 — " + JSON.stringify(d0));
const dupDecision = await api("a", "POST", "/api/merge/dup-check", { pairs: [{ i: 0, distance_pct: 0.5, incoming: { label: "1" }, existing: { label: "1" } }] });
ok(dupDecision.status === 200 && dupDecision.j && dupDecision.j.ok === false && dupDecision.j.error === "no-key", "서버 라우트: 키 없음 → 200 + ok:false(no-key) — " + JSON.stringify(dupDecision.j));
const viewerDeny = await api("bob", "POST", "/api/merge/dup-check", { pairs: [{ i: 0, distance_pct: 0.5 }] });
ok(viewerDeny.status === 403, "서버 라우트: 비설계자 403 (" + viewerDeny.status + ")");

// 사용자가 "같은 위치 의심"을 다시 켜서 가져온다(확정은 사람)
const batch = A.RM.apply(prep, prep.pins.map(() => true));
ok(batch.ids.length === 1 && A.State.pins.some((p) => p.id === batch.ids[0]), "M 적용 — State 에 1개 추가");
ok(await save(A), "M 저장");
const srvAfter = live(await srvPins(zone2.deployment_id));
ok(srvAfter.some((p) => p.srcPinId === String(b1.id) && p.mergeBatchId === batch.batchId), "M 서버 대상 배포본에 반영(srcPinId·mergeBatchId 포함)");
const srcAfter = live(await srvPins(zone1.deployment_id));
ok(srcAfter.length === 3, "M 원본 구역1 핀 무변경(" + srcAfter.length + ")");

/* ══════════ ⑩ 두 번째 합치기 = 0건 ══════════ */
console.log("\n[⑩] 같은 원본을 두 번 합치기");
{
  const p2 = await A.RM.prepare(zone2, zone1, { photos: true });
  console.log("   측정: 두 번째 items=" + p2.plan.items.length + " already=" + p2.plan.already);
  ok(p2.plan.items.length === 0 && p2.plan.already === 1, "⑩ 두 번째 합치기 신규 0건(already 1)");
  // 증분: B 가 구역1 에 새 핀을 추가하면 그것만 들어온다
  await B.App.loadDeckDrawing(zone1.deployment_id);
  const b3 = await place(B, 60, 60);
  await save(B);
  const p3 = await A.RM.prepare(zone2, zone1, { photos: true });
  ok(p3.plan.items.length === 1 && p3.pins[0].srcPinId === String(b3.id), "⑩ 증분 — 새로 생긴 핀 1개만");
}

/* ══════════ ⑪ 되돌리기 ══════════ */
console.log("\n[⑪] 되돌리기 → 합치기 전과 동일");
{
  const n = await A.RM.undo(batch);
  const afterUndo = snapPins(A.State.pins);
  ok(n === 1 && afterUndo === before, "⑪ State 핀 = 합치기 전(" + n + "개 제거)");
  ok(await save(A), "⑪ 저장");
  const srvUndo = snapPins(await srvPins(zone2.deployment_id));
  ok(srvUndo === beforeSrv, "⑪ 서버 대상 배포본 살아있는 핀 = 합치기 전");
}

/* ══════════ 360 모드 — 360 핀만 ══════════ */
console.log("\n[모드] 360 모드에서는 360 핀만");
{
  A.State.regMode = "photo";
  const p4 = await A.RM.prepare(zone2, zone1, { photos: true });
  ok(p4.plan.items.length === 1 && !p4.pins[0].checkboard && p4.pins[0].imageId === "img-360-a" && p4.plan.otherMode === 3,
    "모드 분리 — 360 모드 = 360 핀 1개(imageId 참조 공유), 체크 3개 제외 (otherMode=" + p4.plan.otherMode + ")");
  const p5 = await A.RM.prepare(zone2, zone1, { photos: false });
  ok(p5.pins.length === 1 && p5.pins[0].imageId === undefined && p5.pins[0].is360 === undefined, "사진 끔 → 사진 필드 미복사");
  A.State.regMode = "checkboard";
}

/* ══════════ 레거시(기록 없음) — 변환 불가 · 그대로 얹기만 ══════════ */
console.log("\n[레거시] src 기록 없는 구역");
{
  const legacy = Object.assign({}, zone1, { src_dep_id: null, src_page: null, src_crop: null });
  ok(!A.RM.canTransform(legacy, zone2), "레거시 구역(src 기록 NULL) → 좌표 변환 불가");
  const p6 = await A.RM.prepare(zone2, legacy, { raw: true });
  const same = p6.pins.every((p) => { const s = p6.plan.items.find((it) => String(it.src.id) === p.srcPinId).src; return p.x === s.x && p.y === s.y; });
  ok(p6.plan.items.length === 3 && same, "그대로 얹기 — 화면 상대 위치 그대로(" + p6.plan.items.length + "개)");
}

/* ══════════ 노트 옵션 — 저장 후 복사 · 되돌리기 시 삭제 ══════════ */
console.log("\n[노트] 옵션");
{
  const nr = await api("b", "POST", "/api/notes", { deployment_id: zone1.deployment_id, pin_id: String(b1.id), pin_label: b1.label, body: "용접 확인 필요" });
  const pn = await A.RM.prepare(zone2, zone1, {});
  const bt = A.RM.apply(pn, pn.pins.map(() => true));
  ok(await save(A), "노트 — 핀 먼저 저장");
  const cn = await A.RM.copyNotes(pn, bt);
  const got = (await api("a", "GET", "/api/notes?deployment_id=" + zone2.deployment_id)).j.data || [];
  ok(nr.status === 200 && cn.n === 1 && got.some((x) => x.body.indexOf("[원본: 구역1 #") === 0 && x.body.indexOf("용접 확인 필요") > 0),
    "노트 복사 — 출처 표기 + 본문 (" + cn.n + "건)");
  await A.RM.undo(bt);
  const got2 = (await api("a", "GET", "/api/notes?deployment_id=" + zone2.deployment_id)).j.data || [];
  ok(got2.length === 0, "노트 — 되돌리기 시 복사 노트 삭제(" + got2.length + ")");
}

/* ══════════ [연동] 원본과 연동된 구역끼리 — 같은 id 핀 = 이미 있음(자기 복제 0) ══════════ */
console.log("\n[연동] 연동(별칭) 구역끼리 가져오기 = 이미 있음");
{
  const sp = { id: "shared-1", x: 75, y: 50, page: 1, label: "9", checkboard: true };   // 구역1 화면 좌표
  const dp = { id: "shared-1", x: 25, y: 25, page: 1, label: "9", checkboard: true };   // 같은 핀이 구역2 화면에 투영된 것
  const pl = A.RM.plan({ srcDeck: zone1, dstDeck: zone2, srcPins: [sp], dstPins: [dp], series: "checkboard" });
  ok(pl.total === 1 && pl.items.length === 0 && pl.already === 1, "연동 — 대상에 같은 id 핀이 있으면 가져오지 않음(already 1 · 신규 0)");
}

await mf.dispose();
try { fs.unlinkSync(workerOut); } catch {}
console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
