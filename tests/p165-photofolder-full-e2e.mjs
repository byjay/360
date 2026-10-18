/**
 * p165 — 60_PhotoFolder.js(구역별 사진 폴더 지정·일괄/하나씩 등록) 실사용 시나리오 전수 e2e
 * 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p165-photofolder-full-e2e.mjs
 *
 * 마스터(음성): "구역을 지정하고 사진 경로만 지정하면 일괄등록 기능 완벽 테스트해".
 * 범위 = 기존 p152/p152b/p162 가 다루지 않는 조합(발주서 [재현] 미검증 목록):
 *  S1 구역 3단 깊이(원본>ER>4TH) 하위 구역 폴더 없을 때 상위(원본) 폴백
 *  S2 체크보드 핀과 360 핀이 섞인 일괄등록(번호 통합, 계열 무관)
 *  S3 알파벳 접두사 구역(A12/B12) + 파일 A012.jpg·012.jpg·ER_A012.JPG 2단계 매칭
 *  S4 연결 핀(linkId) — 대표 핀에만 일괄등록(멤버는 그대로)
 *  S5 벡터 복사 구역(crop:null) — Projects.currentDeck 폴백 경로로 폴더 해석
 *  S6 오프라인 등록 → SyncQueue 큐 → 온라인 복귀(_onReconnect) → 업로드 완료
 *  S7 25장 일괄등록 진행률 + 부분 실패(손상 파일 3장) → 재시도로 복구
 *
 * 경계(p152b 관례): 서버 API 는 목, 클라이언트는 public/ 실 모듈을 _manifest.txt 순서로 번들해 실행.
 * 핀/구역 셋업은 테스트 전용으로 window.__wm.State.pins / Projects.decks 를 직접 주입한다(p152b 의
 * State.pins.push 선례와 동일 — PhotoFolder 는 이 두 값만 읽으므로 UI 트리 클릭 없이도 실제 계약과 같다).
 * 폴더 지정 자체는 실 webkitdirectory input.uploadFile(실 파일) — 매칭·디코딩(App._detect360/
 * Cloud.resizeImage)까지 전부 실 브라우저 파이프라인(p152b 관례 그대로, 속성 제거 사유도 동일).
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "public");
const TMP = path.join(ROOT, ".tmp", "p165");
fs.mkdirSync(TMP, { recursive: true });

let failed = 0;
const ok = (cond, label, detail) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail).slice(0, 300) : "")); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 테스트용 이미지(실 2:1 파노라마) + 손상 파일(디코딩 실패 유도, S7) ── */
const PANO = path.join(PUB, "samples", "pano-test-1.jpg");
if (!fs.existsSync(PANO)) { console.log("FAIL public/samples/pano-test-1.jpg 없음"); process.exit(2); }
function mkPano(name) { const p = path.join(TMP, name); fs.copyFileSync(PANO, p); return p; }
function mkCorrupt(name) { const p = path.join(TMP, name); fs.writeFileSync(p, Buffer.from("not-an-image-" + name)); return p; }

const ROOT_FILES = []; // 폴더 지정 1회에 올릴 전체 파일(실 webkitdirectory 업로드, p165 전 시나리오 공용)
const add = (f) => { ROOT_FILES.push(f); return f; };
add(mkPano("701.jpg"));              // S1
add(mkPano("702.jpg"));              // S2(content)
add(mkPano("703.jpg"));              // S2(checkboard)
add(mkPano("A012.jpg"));             // S3 — A12 후보①
add(mkPano("012.jpg"));              // S3 — 접두 없음(B12 쪽 ambiguous)
add(mkPano("ER_A012.JPG"));          // S3 — A12 후보②(접두 추출 ER_A012→A)
add(mkPano("751.jpg"));              // S4(대표)
add(mkPano("752.jpg"));              // S5
add(mkPano("753.jpg"));              // S6
const S7_BAD = new Set([605, 610, 615]);
for (let n = 601; n <= 625; n++) {
  if (S7_BAD.has(n)) add(mkCorrupt(n + ".jpg"));
  else add(mkPano(n + ".jpg"));
}
// S7 재시도용 — 파일명은 그대로(605.jpg 등), 내용만 정상 파노라마로 **덮어쓴다**(puppeteer uploadFile
// 은 경로의 basename을 File.name으로 쓰므로 파일명을 바꾸면 매칭이 깨진다 — 같은 경로를 재사용).
function fixCorruptFiles() { for (const n of S7_BAD) fs.copyFileSync(PANO, path.join(TMP, n + ".jpg")); }

/* ── 실 모듈 번들(_manifest.txt 순서) ── */
const MODS = fs.readFileSync(path.join(PUB, "js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const rdMod = (f) => fs.readFileSync(path.join(PUB, "js/modules", f), "utf8").replace(/\r\n/g, "\n");
const bundle = MODS.map((f) => rdMod(f)).join("\n");

const CT = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webmanifest": "application/json" };
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/* ── 핀/구역 데이터(§헤더 주석 좌표 배치 — 구역끼리 겹치지 않게) ── */
const P = (id, label, extra) => Object.assign({ id, x: 1, y: 1, page: 1, label: String(label) }, extra || {});
const pins = [
  P(1, "701", { x: 5, y: 5 }),                                   // S1
  P(2, "702", { x: 30, y: 30 }),                                  // S2 content
  P(3, "703", { x: 32, y: 30, checkboard: true }),                // S2 checkboard
  P(4, "A12", { x: 55, y: 55 }),                                  // S3
  P(5, "B12", { x: 57, y: 55 }),                                  // S3
  P(6, "751", { x: 45, y: 45, linkId: "6" }),                     // S4 head(대표, linkId=자기 id)
  P(7, "999", { x: 46, y: 45, linkId: "6" }),                     // S4 member
  P(8, "752", { x: 90, y: 10 }),                                  // S5(벡터 복사 구역)
  P(9, "753", { x: 95, y: 5 }),                                   // S6(오프라인→온라인)
];
for (let n = 601; n <= 625; n++) pins.push(P(100 + (n - 601), String(n), { x: 70 + (n - 601) * 0.5, y: 70 })); // S7(25장)

const decks = [
  { id: "dkER", project_id: "prjT", name: "ER", deployment_id: "dep1", page: 1, crop: { x: 0, y: 0, w: 20, h: 20 }, parent_id: null },
  { id: "dk4TH", project_id: "prjT", name: "4TH", deployment_id: "dep1", page: 1, crop: { x: 2, y: 2, w: 6, h: 6 }, parent_id: "dkER" },
  { id: "dkMixed", project_id: "prjT", name: "혼합구역", deployment_id: "dep1", page: 1, crop: { x: 28, y: 28, w: 8, h: 6 }, parent_id: null },
  { id: "dkLink", project_id: "prjT", name: "연결구역", deployment_id: "dep1", page: 1, crop: { x: 43, y: 43, w: 5, h: 4 }, parent_id: null },
  { id: "dkCopy", project_id: "prjT", name: "벡터복사구역", deployment_id: "dep2", page: 1, crop: null, parent_id: null }, // S5 — crop:null(복사본)
  { id: "dkBig", project_id: "prjT", name: "대량구역", deployment_id: "dep1", page: 1, crop: { x: 68, y: 68, w: 16, h: 4 }, parent_id: null },
];

const dep = { id: "dep1", version: 1, title: "dep1", file_name: "dep1.pdf", pages_data: JSON.stringify([PNG]), drawing_data: PNG, pins: JSON.stringify(pins), zones: "[]", annotations: "[]" };
const json = (res, o, st = 200) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
const readBody = (req) => new Promise((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); });

const server = http.createServer(async (req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/sw.js") { res.writeHead(404); res.end(); return; }
  if (u === "/js/main.js") { res.writeHead(200, { "content-type": "application/javascript" }); res.end(bundle); return; }
  if (u === "/api/auth/auto-entry") return json(res, { token: "tokT", kind: "designer" });
  if (u === "/api/auth/me") return json(res, { authenticated: true, email: "owner@test.local", name: "owner", role: "super", auto: true, readonly: false });
  if (u === "/api/auth/config") return json(res, { google_client_id: "", demo_login: false });
  if (u === "/api/tenant/resolve") return json(res, { matched: false });
  if (u === "/api/projects") return json(res, { data: [{ id: "prjT", name: "tes", created_at: 1, published: false, can_manage_members: true }] });
  if (u === "/api/projects/prjT/decks") return json(res, { data: decks });
  if (u === "/api/projects/prjT/bands") return json(res, { band_size: 100, me: { email: "owner@test.local", band: 1, owner: true }, bands: [] });
  if (u === "/tables/deployments/dep1" && req.method === "GET") return json(res, dep);
  // S6 — 온라인 복귀 플러시(SyncQueue.flush) 대상 엔드포인트
  if (u === "/api/sync/batch" && req.method === "POST") {
    const body = await readBody(req);
    let ops = [];
    try { ops = JSON.parse(body).ops || []; } catch (e) {}
    return json(res, { results: ops.map((o) => ({ opId: o.opId, ok: true, id: "srv_" + o.opId })) });
  }
  if (u.startsWith("/api/") || u.startsWith("/tables/")) return json(res, { data: [], settings: {}, value: {} });
  const f = path.join(PUB, u === "/" ? "index.html" : u);
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "content-type": CT[path.extname(f)] || "application/octet-stream" }); res.end(fs.readFileSync(f));
});
await listenSafePort(server, "127.0.0.1");

let puppeteer = null;
try { puppeteer = createRequire("file:///C:/Users/FREE/package.json")("puppeteer"); } catch (e) { puppeteer = null; }
if (!puppeteer) { ok(false, "puppeteer 없음 — 실 브라우저 검증 불가(증거 없는 PASS 금지)"); process.exit(1); }
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const browser = await puppeteer.launch({ headless: "new", ...(fs.existsSync(CHROME) ? { executablePath: CHROME } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 180000 });

try {
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e && e.message)));
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto("http://127.0.0.1:" + server.address().port + "/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__wm, { timeout: 20000 });
  await page.evaluate(() => sessionStorage.setItem("wm_id_token", "tokT"));
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.__wm, { timeout: 20000 });
  ok((await page.evaluate(() => !!(window.__wm && window.__wm.PhotoFolder))), "사전 — __wm.PhotoFolder 노출");

  /* ── 핀/구역 직접 주입(p152b State.pins.push 선례) ── */
  await page.evaluate((pinsArg, decksArg) => {
    const w = window.__wm;
    w.State.currentDeploymentId = "dep1";
    w.State.pdfPage = 1;
    w.State.pins = pinsArg;
    w.State.checkboard = true;
    w.App._setRegMode ? w.App._setRegMode("photo") : (w.State.regMode = "photo");
    w.Projects.currentProject = { id: "prjT" };
    w.Projects.decks = decksArg;
    w.Projects.currentDeck = null;
  }, pins, decks);

  /* ── __root__ 폴더 지정(실 webkitdirectory 업로드, 34장) ── */
  await page.evaluate(() => { window.__wm.PhotoFolder._ensureFallbackInput(); document.getElementById("photofolder-fallback-input").removeAttribute("webkitdirectory"); });
  let input = await page.$("#photofolder-fallback-input");
  await page.evaluate(() => { window.__wm.PhotoFolder._pickTargetKey = "__root__"; });
  await input.uploadFile(...ROOT_FILES);
  await page.waitForFunction(() => window.__wm.PhotoFolder.hasFolder("__root__") === true, { timeout: 8000 });
  await page.evaluate(() => window.__wm.PhotoFolder.setSingleOn("__root__", true));
  ok(true, "사전 — __root__ 폴더 지정(" + ROOT_FILES.length + "장, 실 파일 업로드)");

  const pinOf = (id) => page.evaluate((i) => { const p = window.__wm.State.pins.find((q) => q.id === i); return p ? { imageId: p.imageId, pendingOpId: p.pendingOpId, imageName: p.imageName } : null; }, id);
  const registerViaConfirm = async (label, pinId) => {
    await page.waitForFunction(() => !document.getElementById("photofolder-confirm-modal").classList.contains("hidden"), { timeout: 5000 });
    const msg = await page.evaluate(() => document.getElementById("photofolder-confirm-msg").textContent);
    ok(true, label + " 확인모달 — " + msg);
    await page.evaluate(() => document.getElementById("photofolder-confirm-register").click());
    await page.waitForFunction((i) => { const p = window.__wm.State.pins.find((q) => q.id === i); return !!(p && (p.imageId || p.pendingOpId)); }, { timeout: 8000 }, pinId);
  };
  const registerViaPick = async (idx) => {
    await page.evaluate((j) => document.querySelectorAll("#photofolder-pick-list .photofolder-pick-item")[j].click(), idx);
  };
  const waitRegistered = (pinId) => page.waitForFunction((i) => { const p = window.__wm.State.pins.find((q) => q.id === i); return !!(p && (p.imageId || p.pendingOpId)); }, { timeout: 8000 }, pinId);

  /* ══ S1 — 구역 3단 깊이(dk4TH > dkER > __root__) 폴백 ══════════════════════════ */
  {
    const key = await page.evaluate(async () => {
      const pin = window.__wm.State.pins.find((p) => p.id === 1);
      return await window.__wm.PhotoFolder._resolveFolderKeyForPin(pin);
    });
    ok(key === "__root__", "S1a 3단 체인(dk4TH→dkER→__root__) 모두 폴더 없음 → __root__ 폴백 — " + key);
    const handled = await page.evaluate(async () => { window.__h1 = null; window.__wm.PhotoFolder.handlePinPlaced(window.__wm.State.pins.find((p) => p.id === 1)).then((h) => { window.__h1 = h; }); return true; });
    await registerViaConfirm("S1b", 1);
    const p1 = await pinOf(1);
    ok(!!(p1.imageId || p1.pendingOpId) && p1.imageName === "701", "S1c 핀701 등록 완료(701.jpg, 3단 폴백) — " + JSON.stringify(p1));
  }

  /* ══ S2 — CHECKER + 360 혼재 일괄등록(dkMixed) ══════════════════════════════ */
  {
    const rows = await page.evaluate(async () => { const d = window.__wm.Projects.decks.find((x) => x.id === "dkMixed"); return await window.__wm.PhotoFolder.previewBatch("__root__", d); });
    ok(rows.length === 2 && rows.every((r) => r.status === "일치"), "S2a dkMixed 미리보기 2건 모두 일치(계열 무관) — " + JSON.stringify(rows.map((r) => r.status)));
    const summary = await page.evaluate(async () => { const d = window.__wm.Projects.decks.find((x) => x.id === "dkMixed"); const rows = await window.__wm.PhotoFolder.previewBatch("__root__", d); return await window.__wm.PhotoFolder.runBatchConfirmed(rows); });
    ok(summary.done === 2, "S2b 일괄등록 done=2(CHECKER+360 혼재) — " + JSON.stringify(summary));
    const p2 = await pinOf(2), p3 = await pinOf(3);
    ok(!!(p2.imageId || p2.pendingOpId) && p2.imageName === "702", "S2c content 핀702 등록 완료 — " + JSON.stringify(p2));
    ok(!!(p3.imageId || p3.pendingOpId) && p3.imageName === "703", "S2d checkboard 핀703 등록 완료(계열 무관) — " + JSON.stringify(p3));
  }

  /* ══ S3 — 알파벳 접두사 A12/B12 + A012.jpg·012.jpg·ER_A012.JPG ══════════════ */
  {
    await page.evaluate(() => { window.__h4 = null; window.__wm.PhotoFolder.handlePinPlaced(window.__wm.State.pins.find((p) => p.id === 4)).then((h) => { window.__h4 = h; }); });
    await page.waitForFunction(() => !document.getElementById("photofolder-pick-modal").classList.contains("hidden"), { timeout: 5000 });
    const itemsA = await page.evaluate(() => Array.from(document.querySelectorAll("#photofolder-pick-list .photofolder-pick-item")).map((b) => b.textContent));
    ok(itemsA.length === 2 && itemsA.includes("A012.jpg") && itemsA.includes("ER_A012.JPG"), "S3a A12 → 2후보(A012.jpg·ER_A012.JPG, 012.jpg는 제외) — " + JSON.stringify(itemsA));
    await registerViaPick(0);
    await waitRegistered(4);
    const p4 = await pinOf(4);
    ok(!!(p4.imageId || p4.pendingOpId), "S3b A12 선택 등록 완료 — " + JSON.stringify(p4));

    await page.evaluate(() => { window.__h5 = null; window.__wm.PhotoFolder.handlePinPlaced(window.__wm.State.pins.find((p) => p.id === 5)).then((h) => { window.__h5 = h; }); });
    await page.waitForFunction(() => !document.getElementById("photofolder-pick-modal").classList.contains("hidden"), { timeout: 5000 });
    const itemsB = await page.evaluate(() => Array.from(document.querySelectorAll("#photofolder-pick-list .photofolder-pick-item")).map((b) => b.textContent));
    ok(itemsB.length === 1 && itemsB[0] === "012.jpg", "S3c B12 → ambiguous 1건(012.jpg, A/B 둘 다 아니라 확인 필요) — " + JSON.stringify(itemsB));
    await registerViaPick(0);
    await waitRegistered(5);
    const p5 = await pinOf(5);
    ok(!!(p5.imageId || p5.pendingOpId), "S3d B12 선택 등록 완료(012.jpg) — " + JSON.stringify(p5));
  }

  /* ══ S4 — 연결 핀(linkId) 일괄등록은 대표에만 (dkLink) ══════════════════════ */
  {
    const rows = await page.evaluate(async () => { const d = window.__wm.Projects.decks.find((x) => x.id === "dkLink"); return await window.__wm.PhotoFolder.previewBatch("__root__", d); });
    ok(rows.length === 1 && rows[0].pin.id === 6 && rows[0].status === "일치", "S4a dkLink 대상 1건(대표 핀6만, 멤버7은 dedupe) — " + JSON.stringify(rows.map((r) => r.pin.id)));
    const summary = await page.evaluate(async () => { const d = window.__wm.Projects.decks.find((x) => x.id === "dkLink"); const rows = await window.__wm.PhotoFolder.previewBatch("__root__", d); return await window.__wm.PhotoFolder.runBatchConfirmed(rows); });
    ok(summary.done === 1, "S4b 일괄등록 done=1 — " + JSON.stringify(summary));
    const p6 = await pinOf(6), p7 = await pinOf(7);
    ok(!!(p6.imageId || p6.pendingOpId) && p6.imageName === "751", "S4c 대표 핀6 등록 완료(751.jpg) — " + JSON.stringify(p6));
    ok(!p7.imageId && !p7.pendingOpId, "S4d 🔴 멤버 핀7은 미등록 그대로(대표에만 등록) — " + JSON.stringify(p7));
  }

  /* ══ S5 — 벡터 복사 구역(crop:null) → Projects.currentDeck 폴백 ══════════════ */
  {
    await page.evaluate(() => { window.__wm.Projects.currentDeck = window.__wm.Projects.decks.find((d) => d.id === "dkCopy"); });
    const resolved = await page.evaluate(() => {
      const pin = window.__wm.State.pins.find((p) => p.id === 8);
      return { deckForPin: window.__wm.PhotoFolder._deckForPin(pin) && window.__wm.PhotoFolder._deckForPin(pin).id };
    });
    ok(resolved.deckForPin === "dkCopy", "S5a crop:null 구역 — 어떤 crop 구역도 안 담아 Projects.currentDeck(dkCopy) 폴백 — " + resolved.deckForPin);
    const key = await page.evaluate(async () => { const pin = window.__wm.State.pins.find((p) => p.id === 8); return await window.__wm.PhotoFolder._resolveFolderKeyForPin(pin); });
    ok(key === "__root__", "S5b dkCopy 자체엔 폴더 없음 → __root__ 폴백 — " + key);
    await page.evaluate(() => { window.__h8 = null; window.__wm.PhotoFolder.handlePinPlaced(window.__wm.State.pins.find((p) => p.id === 8)).then((h) => { window.__h8 = h; }); });
    await registerViaConfirm("S5c", 8);
    const p8 = await pinOf(8);
    // [실측] 저장 이름은 PhotoNaming.name()(SoT)이 Projects.currentDeck 이름+시각으로 조합한다(파일명
    // 그대로가 아님 — 35_PhotoBatch.js scopeOf). 매칭은 번호(701/752 등)로 이미 끝났으므로 결함이 아니다.
    ok(!!(p8.imageId || p8.pendingOpId) && /^벡터복사구역_\d+$/.test(p8.imageName), "S5d 핀752 등록 완료(저장명=구역명+시각, SoT) — " + JSON.stringify(p8));
    await page.evaluate(() => { window.__wm.Projects.currentDeck = null; });
  }

  /* ══ S6 — 오프라인 등록 → SyncQueue 큐 → 온라인 복귀(_onReconnect) ══════════ */
  {
    await page.evaluate(() => { Object.defineProperty(navigator, "onLine", { get: () => false, configurable: true }); });
    await page.evaluate(() => { window.__h9 = null; window.__wm.PhotoFolder.handlePinPlaced(window.__wm.State.pins.find((p) => p.id === 9)).then((h) => { window.__h9 = h; }); });
    await registerViaConfirm("S6a(오프라인)", 9);
    const p9a = await pinOf(9);
    ok(!p9a.imageId && !!p9a.pendingOpId, "S6b 오프라인 — pendingOpId만 설정(imageId 0) — " + JSON.stringify(p9a));
    const queueBefore = await page.evaluate(async () => (await window.__wm.SyncQueue.all()).filter((o) => o.status !== "done").length);
    ok(queueBefore >= 1, "S6c SyncQueue 큐에 대기 op 존재 — " + queueBefore);

    await page.evaluate(() => { Object.defineProperty(navigator, "onLine", { get: () => true, configurable: true }); });
    await page.evaluate(async () => { await window.__wm.SyncQueue._onReconnect(); });
    await page.waitForFunction(() => { const p = window.__wm.State.pins.find((p) => p.id === 9); return !!p.imageId && !p.pendingOpId; }, { timeout: 8000 });
    const p9b = await pinOf(9);
    ok(!!p9b.imageId && /^srv_/.test(p9b.imageId) && !p9b.pendingOpId, "S6d 온라인 복귀(_onReconnect) → imageId 치환, pendingOpId 해제 — " + JSON.stringify(p9b));
    // [실측] flush()는 큐 전체를 배치로 올린다(핀 단위가 아니다 — 05_SyncQueue.js CHUNK=4) — 753뿐
    // 아니라 이전 시나리오에서 쌓인 대기 op 전부(S1·S3·S4) 가 이 한 번의 _onReconnect로 같이 빠진다.
    const queueAfter = await page.evaluate(async () => (await window.__wm.SyncQueue.all()).filter((o) => o.status !== "done").length);
    ok(queueAfter === 0, "S6e 온라인 복귀 1회로 큐 전체 드레인(핀 단위가 아니라 배치, " + queueBefore + "→" + queueAfter + ")");
  }

  /* ══ S7 — 25장 일괄등록 진행률 + 부분 실패(손상 3장) → 재시도 ══════════════ */
  {
    const r1 = await page.evaluate(async () => {
      const d = window.__wm.Projects.decks.find((x) => x.id === "dkBig");
      const rows = await window.__wm.PhotoFolder.previewBatch("__root__", d);
      window.__prog7 = [];
      const summary = await window.__wm.PhotoFolder.runBatchConfirmed(rows, (p) => window.__prog7.push(Object.assign({}, p)));
      return { rowsLen: rows.length, allMatched: rows.every((r) => r.status === "일치"), summary, prog: window.__prog7 };
    });
    ok(r1.rowsLen === 25 && r1.allMatched, "S7a dkBig 25건 전부 '일치'(파일명 매칭은 내용 무관) — " + r1.rowsLen);
    ok(r1.summary.done === 22 && r1.summary.fail === 3 && r1.summary.total === 25, "S7b 1차 실행 — done=22·fail=3(손상 601~625 중 605·610·615) — " + JSON.stringify(r1.summary));
    const monotonic = r1.prog.every((p, i) => i === 0 || (p.done + p.skip + p.fail) >= (r1.prog[i - 1].done + r1.prog[i - 1].skip + r1.prog[i - 1].fail));
    ok(monotonic && r1.prog.length === 25 && r1.prog[24].done + r1.prog[24].fail === 25, "S7c 진행률 콜백 25회 단조증가, 마지막 합계=25 — " + JSON.stringify(r1.prog[24]));
    const badIds = [100 + (605 - 601), 100 + (610 - 601), 100 + (615 - 601)];
    const badPinsBefore = await page.evaluate((ids) => ids.map((i) => { const p = window.__wm.State.pins.find((q) => q.id === i); return !!(p.imageId || p.pendingOpId); }), badIds);
    ok(badPinsBefore.every((b) => b === false), "S7d 손상 3장 대상 핀은 미등록 유지(실패 시 상태 불변) — " + JSON.stringify(badPinsBefore));

    // 재시도 — 손상 3장(같은 파일명, 내용만 교체)을 정상 파노라마로 덮어쓰고 폴더 재지정 후 재실행
    fixCorruptFiles();
    await page.evaluate(() => { window.__wm.PhotoFolder._pickTargetKey = "__root__"; });
    input = await page.$("#photofolder-fallback-input");
    await input.uploadFile(...ROOT_FILES);
    await page.waitForFunction(() => window.__wm.PhotoFolder.hasFolder("__root__") === true, { timeout: 8000 });
    const r2 = await page.evaluate(async () => {
      const d = window.__wm.Projects.decks.find((x) => x.id === "dkBig");
      const rows = await window.__wm.PhotoFolder.previewBatch("__root__", d);
      const summary = await window.__wm.PhotoFolder.runBatchConfirmed(rows);
      return { rowsLen: rows.length, summary };
    });
    ok(r2.rowsLen === 3, "S7e 재시도 대상 = 실패한 3건만(이미 성공한 22건은 mediaOf 가드로 제외) — " + r2.rowsLen);
    ok(r2.summary.done === 3 && r2.summary.fail === 0, "S7f 재시도 후 3건 모두 성공 — " + JSON.stringify(r2.summary));
  }

  const jsErrors = errs.filter((e) => !/favicon/i.test(e));
  ok(jsErrors.length === 0, "콘솔/페이지 JS 에러 0건 — " + JSON.stringify(jsErrors));
} finally {
  await browser.close();
  server.close();
}

console.log("\n" + (failed ? "FAILED " + failed + "건" : "ALL PASS"));
process.exit(failed ? 1 : 0);
