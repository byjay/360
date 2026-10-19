/**
 * p173-cdp — WO 20261019-unifymode (실 Chrome · 실 모듈 번들(_manifest.txt 순서) · 목 서버 API)
 * 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p173-unified-pin-mode-cdp.mjs
 *       뮤테이션: MUT=<이름> 이면 번들에 치환 1건 적용(치환 실패 = EXIT 3). 각 뮤테이션은 EXIT=1 이어야 한다.
 *
 * 마스터: "360 과 체커 통일하고, 번호만 매긴 후 사진 일괄 등록할지, 현장에서 번호 매기고 사진 등록할지를 결정하게 해. 옵션으로."
 * 경계(p152b/p165 관례): 서버 API 는 목, 클라이언트는 public/ 실 모듈. 도면 탭 = page.mouse.click(실 이벤트 경로),
 *   사진 선택창 = Puppeteer FileChooser(실 input.click() 가로채기), 폴더 = webkitdirectory 폴백 input 실 파일 업로드.
 *   서버 열람 링크 필터는 src/index.tsx 의 실제 함수 텍스트(pinHas360Media·filterPinArrByLinkMode)를 esbuild 로 그대로 묶어 실행한다.
 *
 *  U0 진입 기본 = [번호 먼저](regMode checkboard) · 상단 토글 2버튼(번호 먼저/바로 사진) · 모드 잎 0(허브·트리)
 *  A  [번호 먼저] 탭 5회 → 번호 핀 5개(사진 없음 · 체커 메타 없음 · 파일창 0회) → 폴더 일괄 등록 → 5개 모두 사진
 *  B  [바로 사진] 탭 1회 → 즉시 사진 선택창 → 파일 선택 → 그 핀에 연결
 *  T  토글 저장·복원: 구역 dk1=바로 사진 / dk2=기본(번호 먼저) · 구역 이동 시 그 구역 값 · 새로고침 후에도 · 설정 버튼 동기
 *  F  필터 3종 [전체/사진 있음/사진 없음] — 도면 마커·트리·전체 포인트 패널이 같은 상태
 *  V  열람 링크(360) = 사진 있는 핀만(새 통일 핀 포함) · 열람자 화면 = 등록 방식 토글 숨김(편집 0)
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "public");
const TMP = path.join(ROOT, ".tmp", "p173");
fs.mkdirSync(TMP, { recursive: true });

let failed = 0;
const ok = (cond, label, detail) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail).slice(0, 400) : "")); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const watchdog = setTimeout(() => { console.log("\nWATCHDOG — 240s 초과 → FAIL"); process.exit(1); }, 240000);

/* ── 뮤테이션(번들 텍스트 치환 1건) ── */
const MUTS = {
  // M1 새 핀에 체커 메타를 다시 쓰면 "핀은 하나"가 깨진다(A: 체커 메타 0 실패)
  metaWrite: ['      if (_linkHead) PinLink.link(State.pins, _linkHead, pin);\n', '      if (_linkHead) PinLink.link(State.pins, _linkHead, pin);\n      else if (State.regMode !== "photo") pin.checkboard = true;\n'],
  // M2 구역 이동 시 등록 방식 복원을 끊으면 T(구역별 저장) 실패
  noScopeSync: ["      if (typeof PinSeries === \"undefined\" || !PinSeries.preferredMode) return;\n      const want = PinSeries.preferredMode();", "      return;\n      const want = PinSeries.preferredMode();"],
  // M3 사진 필터가 key 를 무시하면 F 실패
  filterIgnored: ['      if (k === "photo") return this.hasPhoto(pin);', '      if (k === "photo") return true;'],
  // M4 [바로 사진] 분기를 없애면(탭 = 번호만) B 실패
  noEachBranch: ['      if (State.regMode === "photo") {\n        const pin = this._placeCheckboardPin(pct);', '      if (false) {\n        const pin = this._placeCheckboardPin(pct);'],
  // M5 기본값을 [바로 사진]으로 바꾸면 U0 실패(기본 = 번호 먼저)
  defaultEach: ['    DEFAULT_REG_METHOD: "batch",', '    DEFAULT_REG_METHOD: "each",'],
};
const MUT = process.env.MUT || "";
if (MUT && !MUTS[MUT]) { console.log("알 수 없는 MUT=" + MUT); process.exit(3); }

/* ── 실 모듈 번들(_manifest.txt 순서) ── */
const MODS = fs.readFileSync(path.join(PUB, "js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const rdMod = (f) => fs.readFileSync(path.join(PUB, "js/modules", f), "utf8").replace(/\r\n/g, "\n");
let bundle = MODS.map((f) => rdMod(f)).join("\n");
if (MUT) {
  const [a, b] = MUTS[MUT];
  if (bundle.split(a).length !== 2) { console.log("MUT 치환 대상 없음/중복: " + MUT); process.exit(3); }
  bundle = bundle.replace(a, b);
  console.log("[MUT] " + MUT + " 적용");
}

/* ── 테스트 파일(실 2:1 파노라마) ── */
const PANO = path.join(PUB, "samples", "pano-test-1.jpg");
if (!fs.existsSync(PANO)) { console.log("FAIL public/samples/pano-test-1.jpg 없음"); process.exit(2); }
const mk = (name) => { const p = path.join(TMP, name); fs.copyFileSync(PANO, p); return p; };
const FOLDER = ["3.jpg", "4.jpg", "5.jpg", "6.jpg", "7.jpg"].map(mk);   // 탭으로 생길 번호 3~7 (2.jpg 는 의도적으로 없음)
const EACH_FILE = mk("R0010099.jpg");                                    // [바로 사진] 선택창에서 고를 파일

/* ── 목 서버 ── */
const CT = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webmanifest": "application/json" };
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// 기존 핀 2개: 11 = 구 체커 메타 + 사진(체커 핀에 일괄 등록됐던 것) · 12 = 메타 없음 + 사진 없음
const PINS0 = [
  { id: 11, x: 12, y: 12, page: 1, label: "1", checkboard: true, imageId: "img-a" },
  { id: 12, x: 88, y: 12, page: 1, label: "2" }
];
const dep = { id: "dep1", version: 1, title: "dep1", file_name: "dep1.pdf", pages_data: JSON.stringify([PNG]), drawing_data: PNG, pins: JSON.stringify(PINS0), zones: "[]", annotations: "[]" };
const decks = [
  { id: "dk1", project_id: "prjT", name: "구역1", deployment_id: "dep1", page: 1, crop: null, parent_id: null },
  { id: "dk2", project_id: "prjT", name: "구역2", deployment_id: "dep1", page: 1, crop: null, parent_id: null }
];
const json = (res, o, st = 200) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
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
const browser = await puppeteer.launch({ headless: "new", ...(fs.existsSync(CHROME) ? { executablePath: CHROME } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 120000 });

const W = (page, fn, arg) => page.evaluate(fn, arg);
async function enterDeck(page, deckId) {
  await page.waitForSelector(".hub-tree-deck", { timeout: 15000 }).catch(() => {});
  await sleep(300);
  await W(page, (id) => document.querySelector('.hub-tree-deck[data-deck-id="' + id + '"]').click(), deckId);
  await page.waitForFunction((id) => window.__wm.State.currentDeploymentId === "dep1" && window.__wm.Projects.currentDeck && window.__wm.Projects.currentDeck.id === id && (window.__wm.State.pins || []).length >= 2, { timeout: 20000 }, deckId);
  await sleep(400);
}
async function boot(page) {
  await page.goto("http://127.0.0.1:" + server.address().port + "/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__wm, { timeout: 20000 });
  await W(page, () => sessionStorage.setItem("wm_id_token", "tokT"));
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.__wm, { timeout: 20000 });
}
const visible = (page, id) => W(page, (i) => { const e = document.getElementById(i); if (!e) return false; const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0; }, id);
/** #map-transform 안 비율(fx,fy) → 화면 좌표 */
const mapPoint = (page, fx, fy) => W(page, ([a, b]) => { const r = document.getElementById("map-transform").getBoundingClientRect(); return { x: r.left + r.width * a, y: r.top + r.height * b }; }, [fx, fy]);

try {
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e && e.message)));
  await page.setViewport({ width: 1280, height: 900 });
  await boot(page);

  /* ══ U0 — 진입 기본 · 토글 · 모드 잎 0 ══ */
  console.log("\n[U0 진입 기본 · 토글 · 모드 잎 0]");
  await page.waitForSelector(".hub-tree-deck", { timeout: 15000 }).catch(() => {});
  const hubLeaves = await W(page, () => document.querySelectorAll(".hub-tree-leaf-mode,[data-mode-reg]").length);
  ok(hubLeaves === 0, "U0a 허브 카드 트리 모드 잎(CHECKER/360) 0개 — " + hubLeaves);
  await enterDeck(page, "dk1");
  const u0 = await W(page, () => ({ mode: window.__wm.State.mode, reg: window.__wm.State.regMode, b1: document.getElementById("btn-regmode-checkboard").textContent.trim(), b2: document.getElementById("btn-regmode-photo").textContent.trim(), act: document.getElementById("btn-regmode-checkboard").classList.contains("active"), aria: document.getElementById("regmode-seg").getAttribute("aria-label") }));
  ok(u0.mode === "designer" && u0.reg === "checkboard" && u0.act, "U0b 구역 진입 기본 = [번호 먼저](regMode checkboard, 버튼 활성) — " + JSON.stringify(u0));
  ok(u0.b1 === "번호 먼저" && u0.b2 === "바로 사진" && /등록 방식/.test(u0.aria || ""), "U0c 상단 토글 = [번호 먼저][바로 사진](등록 방식) — 모드 이름(CHECKER/360) 없음 — " + JSON.stringify(u0));
  const treeLeaves = await W(page, () => document.querySelectorAll(".tree-mode-leaf,.tree-node-mode-leaf").length);
  ok(treeLeaves === 0, "U0d 사이드바 트리 모드 잎 0개 — " + treeLeaves);
  const treePins = await W(page, () => document.querySelectorAll("#side-tree .tree-node-pin").length);
  ok(treePins === 2, "U0e 트리 = 구역 바로 아래 핀 2개(모드 묶음 없이) — " + treePins);

  /* ══ A — [번호 먼저] 탭 5회 → 번호 핀 5개(사진 없음) → 폴더 일괄 등록 → 5개 모두 사진 ══ */
  console.log("\n[A 번호 먼저 → 일괄 등록]");
  await page.click("#btn-regmode-checkboard");   // 실 클릭 — 같은 방식이면 배치 자동 시작(_autoStartPlacing)
  await sleep(250);
  await W(page, () => { window.__fileClicks = 0; const o = HTMLInputElement.prototype.click; HTMLInputElement.prototype.click = function () { if (this.type === "file") window.__fileClicks++; return o.apply(this, arguments); }; });
  const placing0 = await W(page, () => !!window.__wm.State.placing);
  ok(placing0, "A0 [번호 먼저] 클릭 → 배치 켜짐");
  const before = await W(page, () => window.__wm.State.pins.length);
  const spots = [[0.3, 0.35], [0.4, 0.45], [0.5, 0.55], [0.6, 0.4], [0.7, 0.6]];
  for (const [fx, fy] of spots) { const pt = await mapPoint(page, fx, fy); await page.mouse.click(pt.x, pt.y); await sleep(220); }
  await sleep(300);
  const a1 = await W(page, (n0) => { const S = window.__wm.State, PS = window.__wm.PinSeries; const fresh = S.pins.slice(n0); return { n: fresh.length, labels: fresh.map((p) => p.label), photo: fresh.filter((p) => PS.hasPhoto(p)).length, meta: fresh.filter((p) => "checkboard" in p).length, clicks: window.__fileClicks, placing: S.placing }; }, before);
  ok(a1.n === 5 && JSON.stringify(a1.labels) === '["3","4","5","6","7"]', "A1 탭 5회 → 번호 핀 5개(3~7, 번호 공간 1개) — " + JSON.stringify(a1));
  ok(a1.photo === 0 && a1.clicks === 0, "A2 사진 없음 · 파일 선택창 0회(탭 = 번호만) — " + JSON.stringify(a1));
  ok(a1.meta === 0, "A3 새 핀에 체커 메타(pin.checkboard) 없음 — 생성 방식과 무관하게 같은 핀 — " + JSON.stringify(a1));
  ok(a1.placing === true, "A4 배치 유지(계속 탭하면 다음 번호)");
  const a5 = await W(page, (n0) => window.__wm.State.pins.slice(n0).map((p) => { const m = document.querySelector('.pin-marker[data-id="' + p.id + '"]'); return m ? m.dataset.photo + m.dataset.filled + (m.className.indexOf("pin-mode-") >= 0 ? "M" : "") : "none"; }), before);
  ok(a5.every((v) => v === "00"), "A5 도면 마커 = 사진 없음 표시(data-photo 0 · filled 0 · 모드 클래스 없음) — " + JSON.stringify(a5));
  // 폴더 지정(폴백 input, 실 파일 5장) → 이 구역 일괄 등록(PhotoFolder.previewBatch/runBatchConfirmed — 기능 메뉴 [구역별 사진 폴더 지정] 경로의 정본)
  await W(page, () => { window.__wm.PhotoFolder._ensureFallbackInput(); document.getElementById("photofolder-fallback-input").removeAttribute("webkitdirectory"); window.__wm.PhotoFolder._pickTargetKey = "__root__"; });
  const input = await page.$("#photofolder-fallback-input");
  await input.uploadFile(...FOLDER);
  await page.waitForFunction(() => window.__wm.PhotoFolder.hasFolder("__root__") === true, { timeout: 8000 });
  const summary = await W(page, async () => { const d = window.__wm.Projects.currentDeck; const rows = await window.__wm.PhotoFolder.previewBatch("__root__", d); return { rows: rows.map((r) => (r.pin && r.pin.label) + ":" + r.status), res: await window.__wm.PhotoFolder.runBatchConfirmed(rows) }; });
  ok(summary.res && summary.res.done === 5, "A6 폴더 일괄 등록 done=5 — " + JSON.stringify(summary));
  await sleep(200);
  const a7 = await W(page, (n0) => { const S = window.__wm.State, PS = window.__wm.PinSeries; window.__wm.UI.renderPinsOnMap(); return S.pins.slice(n0).map((p) => PS.hasPhoto(p) ? 1 : 0); }, before);
  ok(JSON.stringify(a7) === "[1,1,1,1,1]", "A7 5개 모두 사진 — " + JSON.stringify(a7));
  ok(["3:일치", "4:일치", "5:일치", "6:일치", "7:일치"].every((r) => summary.rows.indexOf(r) >= 0), "A7b 매칭 = 번호 ↔ 파일명(3~7.jpg) — " + JSON.stringify(summary.rows));
  const a8 = await W(page, (n0) => window.__wm.State.pins.slice(n0).map((p) => { const m = document.querySelector('.pin-marker[data-id="' + p.id + '"]'); return m ? m.dataset.photo : "none"; }), before);
  ok(a8.every((v) => v === "1"), "A8 도면 마커 = 사진 있음(data-photo 1) — " + JSON.stringify(a8));
  const p12 = await W(page, () => window.__wm.PinSeries.hasPhoto(window.__wm.State.pins.find((p) => p.id === 12)));
  ok(p12 === false, "A9 폴더에 없는 번호(2)는 그대로 사진 없음(조용히 지어내지 않음)");

  /* ══ B — [바로 사진] 탭 → 즉시 사진 선택 → 연결 ══ */
  console.log("\n[B 바로 사진]");
  await page.click("#btn-regmode-photo");
  await sleep(250);
  const b0 = await W(page, () => ({ reg: window.__wm.State.regMode, placing: window.__wm.State.placing, act: document.getElementById("btn-regmode-photo").classList.contains("active") }));
  ok(b0.reg === "photo" && b0.placing && b0.act, "B0 [바로 사진] 실클릭 → regMode photo · 배치 켜짐 · 버튼 활성 — " + JSON.stringify(b0));
  const nB = await W(page, () => window.__wm.State.pins.length);
  const ptB = await mapPoint(page, 0.45, 0.75);
  const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 6000 }).catch(() => null), page.mouse.click(ptB.x, ptB.y)]);
  ok(!!chooser, "B1 탭 1회 → 곧바로 사진 선택창(FileChooser) 열림");
  const pinB = await W(page, (n0) => { const p = window.__wm.State.pins[n0]; return p ? { id: p.id, label: p.label, meta: "checkboard" in p } : null; }, nB);
  ok(pinB && pinB.label === "8" && pinB.meta === false, "B2 번호 핀 8 생성(같은 번호 공간 · 체커 메타 없음) — " + JSON.stringify(pinB));
  if (chooser) await chooser.accept([EACH_FILE]);
  if (pinB) await page.waitForFunction((id) => { const p = window.__wm.State.pins.find((q) => q.id === id); return !!(p && (p.imageId || p.pendingOpId)); }, { timeout: 10000 }, pinB.id).catch(() => {});
  const b3 = pinB ? await W(page, (id) => { const p = window.__wm.State.pins.find((q) => q.id === id); return { photo: window.__wm.PinSeries.hasPhoto(p), name: p.imageName || "" }; }, pinB.id) : null;
  ok(b3 && b3.photo === true, "B3 고른 사진이 그 핀에 연결(imageId/pendingOpId) — " + JSON.stringify(b3));

  /* ══ T — 토글 저장·복원(구역별) ══ */
  console.log("\n[T 토글 저장·복원]");
  const sk1 = await W(page, () => window.__wm.PinSeries.regScopeKey());
  ok(await W(page, (k) => localStorage.getItem("wm-reg-method:" + k), sk1) === "each", "T1 dk1 의 방식 = each 로 저장(localStorage wm-reg-method:" + sk1 + ")");
  await W(page, () => { if (window.__wm.State.placing) window.__wm.App._togglePlacing(); });
  await W(page, async () => { const d = window.__wm.Projects.decks.find((x) => x.id === "dk2"); await window.__wm.Projects.selectDeck(d); });
  await sleep(500);
  const t2 = await W(page, () => ({ reg: window.__wm.State.regMode, deck: window.__wm.Projects.currentDeck.id, act: document.getElementById("btn-regmode-checkboard").classList.contains("active"), placing: window.__wm.State.placing }));
  ok(t2.deck === "dk2" && t2.reg === "checkboard" && t2.act, "T2 구역2 로 이동 → 그 구역 기본값 [번호 먼저] — " + JSON.stringify(t2));
  ok(t2.placing === false, "T3 구역 이동 복원은 배치를 저절로 켜지 않는다");
  await W(page, async () => { const d = window.__wm.Projects.decks.find((x) => x.id === "dk1"); await window.__wm.Projects.selectDeck(d); });
  await sleep(500);
  const t4 = await W(page, () => window.__wm.State.regMode);
  ok(t4 === "photo", "T4 구역1 로 돌아오면 [바로 사진] 복원 — " + t4);
  await W(page, () => window.__wm.Settings.open());
  await sleep(200);
  const t5 = await W(page, () => ({ each: document.getElementById("btn-settings-regmethod-each").getAttribute("aria-pressed"), batch: document.getElementById("btn-settings-regmethod-batch").getAttribute("aria-pressed") }));
  ok(t5.each === "true" && t5.batch === "false", "T5 설정 패널 등록 방식 = 바로 사진(aria-pressed 동기) — " + JSON.stringify(t5));
  await page.click("#btn-settings-regmethod-batch");
  await sleep(250);
  const t6 = await W(page, (k) => ({ reg: window.__wm.State.regMode, ls: localStorage.getItem("wm-reg-method:" + k), top: document.getElementById("btn-regmode-checkboard").classList.contains("active"), set: document.getElementById("btn-settings-regmethod-batch").getAttribute("aria-pressed") }), sk1);
  ok(t6.reg === "checkboard" && t6.ls === "batch" && t6.top && t6.set === "true", "T6 설정에서 [번호 먼저] → 상단 토글·저장값 동기 — " + JSON.stringify(t6));
  await page.click("#btn-settings-regmethod-each");
  await sleep(250);
  await W(page, () => window.__wm.Settings.close());
  // 새로고침 = 다음 방문
  await boot(page);
  await enterDeck(page, "dk1");
  const t7 = await W(page, () => window.__wm.State.regMode);
  ok(t7 === "photo", "T7 새로고침 후 구역1 진입 → [바로 사진] 그대로(구역별 저장) — " + t7);

  /* ══ F — 필터 3종 ══ */
  console.log("\n[F 필터 3종]");
  // 새로고침 뒤 A·B 핀의 로컬 초안 복원 여부는 저장 타이밍에 따라 다르다(이 테스트의 대상 아님) — 사진 있는 핀 1개를 더하고
  //   기대값은 지금 데이터에서 계산한다(사진 판정 = PinSeries.hasPhoto 정본).
  await W(page, () => { const S = window.__wm.State; S.pins.push({ id: 31, x: 50, y: 80, page: 1, label: "99", imageId: "img-z" }); window.__wm.UI.renderPinsOnMap(); window.__wm.UI.renderPinList(); });
  await sleep(150);
  const exp = await W(page, () => { const S = window.__wm.State, PS = window.__wm.PinSeries; const live = S.pins.filter((p) => p && !p._deleted && (p.page || 1) === 1);
    const ids = (f) => live.filter(f).map((p) => String(p.id)).sort().join(",");
    return { all: live.length, photo: live.filter((p) => PS.hasPhoto(p)).length, nophoto: live.filter((p) => !PS.hasPhoto(p)).length, idsAll: ids(() => true), idsPhoto: ids((p) => PS.hasPhoto(p)), idsNo: ids((p) => !PS.hasPhoto(p)) }; });
  ok(exp.photo >= 2 && exp.idsNo === "12", "F0 데이터 = 사진 있음 ≥2(11·31 …) · 사진 없음 = 핀 12 — " + JSON.stringify(exp));
  const chips = await W(page, () => Array.from(document.querySelectorAll("#pin-filter-bar [data-pfilter]")).map((b) => b.dataset.pfilter + ":" + b.querySelector(".zpager-cnt").textContent + ":" + b.getAttribute("aria-pressed")));
  ok(JSON.stringify(chips) === JSON.stringify(["all:" + exp.all + ":true", "photo:" + exp.photo + ":false", "nophoto:" + exp.nophoto + ":false"]), "F1 칩 3종 [전체][사진 있음][사진 없음] 개수 = 데이터 · 기본 = 전체 — " + JSON.stringify(chips));
  const oldChips = await W(page, () => document.querySelectorAll('#pin-filter-bar [data-series], .pf-checkboard, .pf-content').length);
  ok(oldChips === 0, "F2 구 CHECKER/360 칩 0개");
  const shownBy = async (key) => {
    await page.click('#pin-filter-bar [data-pfilter="' + key + '"]');
    await sleep(200);
    return W(page, () => ({
      map: Array.from(document.querySelectorAll("#pins-layer .pin-marker")).map((m) => m.dataset.id).sort().join(","),
      tree: document.querySelectorAll("#side-tree .tree-node-pin").length,
      pressed: (document.querySelector('#pin-filter-bar [aria-pressed="true"]') || {}).dataset
    }));
  };
  const fPhoto = await shownBy("photo");
  ok(fPhoto.map === exp.idsPhoto && fPhoto.tree === exp.photo, "F3 [사진 있음] → 도면·트리 = 사진 있는 핀만 — " + JSON.stringify(fPhoto));
  const fNo = await shownBy("nophoto");
  ok(fNo.map === exp.idsNo && fNo.tree === exp.nophoto, "F4 [사진 없음] → 도면 12 · 트리 1 — " + JSON.stringify(fNo));
  await W(page, () => window.__wm.AllPins.show());
  await sleep(300);
  const ap = await W(page, () => ({ tabs: Array.from(document.querySelectorAll("#allpins-tabs [data-pfilter]")).map((b) => b.dataset.pfilter + (b.classList.contains("active") ? "*" : "")), rows: document.querySelectorAll("#allpins-list .allpins-item").length }));
  ok(JSON.stringify(ap.tabs) === '["all","photo","nophoto*"]' && ap.rows === 1, "F5 전체 포인트 패널 탭 = 같은 필터(사진 없음 선택 · 1행) — " + JSON.stringify(ap));
  await W(page, () => window.__wm.AllPins.hide());
  await sleep(450);
  const fAll = await shownBy("all");
  ok(fAll.map === exp.idsAll && fAll.tree === exp.all, "F6 [전체] → 전부 — " + JSON.stringify(fAll));
  const dataSame = await W(page, () => window.__wm.State.pins.filter((p) => p && !p._deleted && (p.page || 1) === 1).length);
  ok(dataSame === exp.all, "F7 필터는 표시만 — 데이터 불변(" + exp.all + ")");

  /* ══ V — 열람 링크 = 사진 있는 핀만 · 열람자 편집 0 ══ */
  console.log("\n[V 열람 링크 · 열람자]");
  {
    const src = fs.readFileSync(path.join(ROOT, "src/index.tsx"), "utf8").replace(/\r\n/g, "\n");
    const grab = (sig) => { const i = src.indexOf(sig); if (i < 0) return null; const j = src.indexOf("\n}\n", i); return src.slice(i, j + 3); };
    const f1 = grab("function pinHas360Media("), f2 = grab("function filterPinArrByLinkMode(");
    const imp = (src.match(/import \{[^}]*pinImageRefs[^}]*\} from ['"]([^'"]+)['"]/) || [])[1];
    ok(!!(f1 && f2 && imp), "V0 서버 실제 함수 텍스트 추출(pinHas360Media · filterPinArrByLinkMode · pinImageRefs 출처 " + imp + ")");
    if (f1 && f2 && imp) {
      const entry = "import { pinImageRefs } from " + JSON.stringify(path.resolve(path.join(ROOT, "src"), imp).replace(/\\/g, "/")) + ";\n" + f1 + f2 + "export { filterPinArrByLinkMode };\n";
      const out = path.join(TMP, "linkfilter.mjs");
      await esbuild.build({ stdin: { contents: entry, loader: "ts", resolveDir: path.join(ROOT, "src") }, bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" });
      const { filterPinArrByLinkMode } = await import(pathToFileURL(out).href + "?t=" + Date.now());
      const pins = [
        { id: 1, label: "1", checkboard: true, imageId: "a" },  // 구 체커 메타 + 사진
        { id: 2, label: "2" },                                    // 새 통일 핀(메타 없음) · 사진 없음
        { id: 3, label: "3", imageId: "b" },                      // 새 통일 핀 · 사진 있음
        { id: 4, label: "4", checkboard: true }                   // 구 체커 메타 · 사진 없음
      ];
      const v360 = filterPinArrByLinkMode(pins, "360").map((p) => p.id).join(",");
      const vAll = filterPinArrByLinkMode(pins, null).map((p) => p.id).join(",");
      ok(v360 === "1,3", "V1 360 열람 링크 = 사진 있는 핀만(메타 무관 — 새 통일 핀 3 포함, 사진 없는 2·4 제외) — " + v360);
      ok(vAll === "1,2,3,4", "V2 링크 모드 없음(멤버 화면) = 전부 — " + vAll);
    }
  }
  await W(page, () => window.__wm.App.openApp("viewer"));
  await sleep(300);
  const segVis = await visible(page, "regmode-seg");
  ok(segVis === false, "V3 열람 화면 = 등록 방식 토글 숨김(편집 0)");
  const nV = await W(page, () => window.__wm.State.pins.length);
  const ptV = await mapPoint(page, 0.33, 0.66);
  await page.mouse.click(ptV.x, ptV.y);
  await sleep(300);
  ok((await W(page, () => window.__wm.State.pins.length)) === nV, "V4 열람 화면 탭 → 핀 생성 0");

  const jsErrors = errs.filter((e) => !/favicon/i.test(e));
  ok(jsErrors.length === 0, "콘솔/페이지 JS 에러 0건 — " + JSON.stringify(jsErrors));
} finally {
  clearTimeout(watchdog);
  await browser.close();
  server.close();
}

console.log("\n" + (failed ? "FAILED " + failed + "건" : "ALL PASS"));
process.exit(failed ? 1 : 0);
