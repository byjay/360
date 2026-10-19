/**
 * p167-capture-session-cdp — WO 20261019-capsession (실 Chrome · 모바일 에뮬레이션 · 실 모듈 번들
 * (_manifest.txt 순서) · 목 서버 API만). 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p167-capture-session-cdp.mjs
 *
 * 순수 함수(단조매칭·오프셋·군집화·재보간)는 p167-capture-session-pure.test.mjs 가 이미 검증했다.
 * 이 CDP 테스트는 그 순수 로직이 "실제 화면·실제 저장소"에 제대로 연결됐는지만 검증한다:
 *  A. 모바일 뷰포트(375x812, 터치) + 디자이너 360 모드 → [촬영 세션] 도크 버튼 노출
 *  B. CaptureSession.start() → 실 터치(#map-viewport touchstart, 20_App.js _bindMap 분기 —
 *     onDrawStart/isArmedTap)로 정지점 탭 → 접두 D → D1~D4 번호핀 실제 DOM(.pin-marker) 렌더
 *  C. 실 새로고침(location.reload) → CaptureSession.restore() → 같은 세션 id·탭 4건 복원
 *     (SyncQueue.saveDraft/loadDraft — 실 IndexedDB, Node vm 목이 아님)
 *  D. 실 파일 입력(#input-capture-session, ElementHandle.uploadFile) → 미리보기 시트 → [확인] →
 *     PhotoBatch._uploadOneRow 재사용 경로(오프라인 폴백 pendingOpId, p152b 와 동일 근거)
 *  E. 되돌리기 → 세션 생성 핀 전부 제거(실 DOM 에서도 사라짐)
 *
 * 🔴 발견한 결함(이 테스트 작성 중 실측, 즉시 수정) —
 *   ① 99_footer.js 부트스트랩에 CaptureSession.init() 호출이 없어 도크 버튼이 전혀
 *      마운트되지 않았다(죽은 코드). 다른 모듈과 같은 자리에 1줄 추가.
 *   ② 20_App.js _updateCheckboardQuickStatus() 에 CaptureSession.syncDockButton() 호출이
 *      없어 모드 전환 시 도크 버튼 표시가 갱신되지 않았다(FieldCapture 와 같은 자리에 1줄 추가).
 *   ③ 지도 탭을 "click" 리스너로 받았으나, MapCtrl.handlePanStart(mousedown)가 먼저 pan을
 *      잡으면 네이티브 click 합성이 억제돼(실 마우스·터치 둘 다) 탭이 전혀 들어오지 않았다 —
 *      Zones/Routes 와 같은 자리(20_App.js _bindMap 의 mousedown/touchstart 분기)에서
 *      onDrawStart()/isArmedTap() 을 직접 호출하도록 재설계.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "public");
const TMP = path.join(ROOT, ".tmp", "p167cdp");
fs.mkdirSync(TMP, { recursive: true });

let failed = 0;
const ok = (cond, label, detail) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail).slice(0, 300) : "")); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 실 파일(EXIF 없음 — lastModified 폴백 경로 검증, PhotoBatch._sortRows SoT) ── */
const SAMPLE = path.join(PUB, "samples", "pano-test-1.jpg");
if (!fs.existsSync(SAMPLE)) { console.log("FAIL public/samples/pano-test-1.jpg 없음"); process.exit(2); }
function mkPhoto(name) { const p = path.join(TMP, name); fs.copyFileSync(SAMPLE, p); return p; }

const MODS = fs.readFileSync(path.join(PUB, "js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const rdMod = (f) => fs.readFileSync(path.join(PUB, "js/modules", f), "utf8").replace(/\r\n/g, "\n");
ok(MODS.includes("69_CaptureSession.js"), "사전 — _manifest.txt 에 69_CaptureSession.js 등록");
const bundle = MODS.map((f) => rdMod(f)).join("\n");

const CT = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webmanifest": "application/json" };
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const dep = { id: "dep1", version: 1, title: "dep1", file_name: "dep1.pdf", pages_data: JSON.stringify([PNG]), drawing_data: PNG, pins: JSON.stringify([]), zones: "[]", annotations: "[]" };
const decks = [{ id: "dk1", project_id: "prjT", name: "구역1", deployment_id: "dep1", page: 1, crop: null, parent_id: null }];
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

try {
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e && e.message)));
  // [A] 모바일 뷰포트 + 터치 에뮬레이션(지시 — "실 Chrome 모바일 에뮬레이션")
  await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await page.setUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Mobile Safari/537.36");
  // 38_Install.js/38b_InstallGate.js 가 모바일 UA 에서 "설치 안 됨" 이면 전체화면 설치 안내로
  // 지도를 덮는다(p114 와 동일 근거) — display-mode:standalone 을 true 로 패치해 "이미 설치됨"
  // 신호를 준다(CDP 에 display-mode 를 직접 바꾸는 공식 커맨드가 없다, p114 주석 참조).
  await page.evaluateOnNewDocument(() => {
    const realMM = window.matchMedia.bind(window);
    window.matchMedia = (q) => {
      if (typeof q === "string" && q.indexOf("display-mode: standalone") >= 0) {
        return { matches: true, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
      }
      return realMM(q);
    };
  });
  await page.goto("http://127.0.0.1:" + server.address().port + "/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__wm, { timeout: 20000 });
  await page.evaluate(() => sessionStorage.setItem("wm_id_token", "tokT"));
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.__wm, { timeout: 20000 });

  ok((await page.evaluate(() => !!(window.__wm && window.__wm.CaptureSession))), "사전 — __wm.CaptureSession 노출(99_footer)");

  await page.waitForSelector(".hub-tree-deck", { timeout: 15000 }).catch(() => {});
  await sleep(300);
  await page.evaluate(() => document.querySelector('.hub-tree-deck[data-deck-id="dk1"]').click());
  await page.waitForFunction(() => window.__wm.State.currentDeploymentId === "dep1", { timeout: 20000 });
  await sleep(200);

  // 디자이너 360(photo) 모드 진입 — App._setRegMode(SoT) 재사용(p152b 와 동일 근거)
  await page.evaluate(() => { window.__wm.State.checkboard = true; if (window.__wm.App._setRegMode) window.__wm.App._setRegMode("photo"); else window.__wm.State.regMode = "photo"; });
  await sleep(100);

  /* ══ A. 도크 버튼 노출 — 🔴 이 테스트가 찾아 고친 결함(init() 미호출)의 회귀 가드 ══ */
  const dockVisible = await page.evaluate(() => { const d = document.getElementById("mdock-capture-session"); return !!d && !d.classList.contains("hidden"); });
  ok(dockVisible, "A1 360 모드 → [촬영 세션] 도크 버튼 노출(CaptureSession.init() 가 실 부트스트랩에 연결됨)");

  /* ══ B. 실 터치(모바일)로 정지점 탭 → 접두 D → D1~D4 ══ */
  await page.evaluate(() => { window.__wm.CaptureSession.start({ mode: "tap", zoneName: "갑판", prefix: "D", startNo: 1, page: 1 }); });
  const vpBox = await page.evaluate(() => { const r = document.getElementById("map-viewport").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  // 🔴 실측(환경 함정, CLAUDE.md §G-4④) — page.touchscreen.tap() 을 연달아 호출하면 헤드리스
  // Chrome 이 간혹 이전 터치 포인트를 완전히 떼지 못한 채 다음 탭을 "핀치"로 오인해
  // State.zoom 이 수백 배로 폭주한다(실측: zoom=345). 그러면 #map-transform 의 전체 변환이
  // 그 배율로 커져 핀 마커의 getBoundingClientRect() 가 화면 전체를 덮는 값(8694x15318px)이
  // 되고, 다음 탭이 전부 "핀 위 클릭"으로 오판된다 — CaptureSession 결함이 아니라 테스트의
  // 터치 디스패치 부작용이다. 매 탭 전 zoom/pan 을 1:0,0 으로 되돌려 깨끗한 상태에서 측정한다.
  const resetView = () => page.evaluate(() => { window.__wm.State.zoom = 1; window.__wm.State.pan = { x: 0, y: 0 }; if (window.__wm.MapCtrl && window.__wm.MapCtrl.applyTransform) window.__wm.MapCtrl.applyTransform(); });
  const TAP_XY = [[30, 40], [30, 300], [280, 40], [280, 300]];
  for (const [dx, dy] of TAP_XY) {
    await resetView();
    await page.touchscreen.tap(Math.round(vpBox.x + dx), Math.round(vpBox.y + dy));
    await sleep(150);
  }
  await resetView();
  const taps1 = await page.evaluate(() => window.__wm.CaptureSession.current().taps.map((t) => t.label));
  ok(taps1.join(",") === "D1,D2,D3,D4", "B1 실 터치(_bindMap touchstart 분기) → 접두 D → D1~D4 순차 채번 → " + taps1.join(","));
  const markerCount = await page.evaluate(() => document.querySelectorAll(".pin-marker").length);
  ok(markerCount === 4, "B2 실 DOM 에 핀 마커 4개 렌더 → " + markerCount);

  /* ══ C. 실 새로고침 → 세션 복원(실 IndexedDB) ══ */
  const sessIdBefore = await page.evaluate(() => window.__wm.CaptureSession.current().id);
  const tapTimes = await page.evaluate(() => window.__wm.CaptureSession.current().taps.map((t) => t.t));
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.__wm, { timeout: 20000 });
  await page.evaluate(async () => { await window.__wm.CaptureSession.restore(); });
  const restored = await page.evaluate(() => window.__wm.CaptureSession.current());
  ok(!!restored && restored.id === sessIdBefore, "C1 새로고침 후 CaptureSession.restore() → 같은 세션 id 복원(실 IndexedDB, 목 아님) → " + (restored && restored.id));
  ok(!!restored && restored.taps.length === 4, "C2 탭 4건 그대로 복원 → " + (restored && restored.taps.length));

  // 새로고침은 허브 화면으로 되돌아간다 — 지도(viewportToPercent 의 #map-transform rect)를
  // 다시 쓰려면 배포본을 다시 열어야 한다(섹션 E 의 실 탭 재현을 위해 필요).
  await page.waitForSelector(".hub-tree-deck", { timeout: 15000 }).catch(() => {});
  await sleep(300);
  await page.evaluate(() => document.querySelector('.hub-tree-deck[data-deck-id="dk1"]').click());
  await page.waitForFunction(() => window.__wm.State.currentDeploymentId === "dep1", { timeout: 20000 });
  await sleep(200);
  await page.evaluate(() => { window.__wm.State.checkboard = true; if (window.__wm.App._setRegMode) window.__wm.App._setRegMode("photo"); else window.__wm.State.regMode = "photo"; });
  await sleep(100);

  /* ══ D. 실 파일 업로드 → 미리보기 시트 → [확인] → 등록(오프라인 폴백, p152b 와 동일 근거) ══ */
  // 복원 후엔 State.pins 가 리로드로 비었으므로(목 서버가 /tables/deployments 를 공유 안 함),
  // 탭이 만든 핀을 다시 화면에 올려 업로드 대상을 마련한다(세션 taps.pinId 기준 재주입 — 순수 보조, 신규 로직 0).
  await page.evaluate((taps) => {
    window.__wm.State.pins = taps.map((t, i) => ({ id: t.pinId, x: 10, y: 10, page: 1, label: t.label }));
    window.__wm.UI.renderPinList(); window.__wm.UI.renderPinsOnMap();
  }, restored.taps);

  const F = [0, 1, 2, 3].map((i) => mkPhoto("tap" + i + ".jpg"));
  F.forEach((f, i) => { const t = new Date(tapTimes[i]); fs.utimesSync(f, t, t); }); // lastModified = 탭시각(EXIF 없음 폴백 경로)

  const input = await page.$("#input-capture-session");
  ok(!!input, "D0 숨겨진 파일 입력(#input-capture-session) 존재(index.html 수정 0)");
  await input.uploadFile(...F);
  await page.waitForSelector("#capsess-preview-sheet", { timeout: 8000 }).catch(() => {});
  const previewBody = await page.evaluate(() => { const s = document.getElementById("capsess-preview-sheet"); return s ? s.querySelector(".theta-sheet-body").textContent : null; });
  ok(!!previewBody && /4건 매칭/.test(previewBody), "D1 실 파일 업로드(lastModified=탭시각) → 미리보기 시트 '4건 매칭' → " + previewBody);

  await page.evaluate(() => { const s = document.getElementById("capsess-preview-sheet"); const btn = Array.from(s.querySelectorAll(".theta-sheet-btn")).find((b) => /확인/.test(b.textContent)); btn.click(); });
  await page.waitForFunction(() => window.__wm.State.pins.every((p) => !!(p.imageId || p.pendingOpId)), { timeout: 8000 }).catch(() => {});
  const registered = await page.evaluate(() => window.__wm.State.pins.map((p) => !!(p.imageId || p.pendingOpId)));
  ok(registered.every(Boolean), "D2 [확인] → 4건 전부 등록 완료(imageId/pendingOpId, PhotoBatch._uploadOneRow 재사용) → " + JSON.stringify(registered));

  /* ══ E. 되돌리기 — 세션 생성 핀 실 DOM 에서도 제거 ══ */
  await page.evaluate(() => { window.__wm.CaptureSession.start({ mode: "tap", zoneName: "하부", prefix: "E", startNo: 1, page: 1 }); });
  for (const [dx, dy] of [[120, 500], [320, 500]]) {
    await resetView();
    await page.touchscreen.tap(Math.round(vpBox.x + dx), Math.round(vpBox.y + dy));
    await sleep(150);
  }
  await resetView();
  const beforeUndo = await page.evaluate(() => document.querySelectorAll(".pin-marker").length);
  await page.evaluate(async () => { await window.__wm.CaptureSession.undo(); });
  const afterUndo = await page.evaluate(() => document.querySelectorAll(".pin-marker").length);
  ok(afterUndo === beforeUndo - 2, "E1 되돌리기 → 세션이 만든 핀 2개만 실 DOM 에서 제거 → " + beforeUndo + "→" + afterUndo);
  ok((await page.evaluate(() => window.__wm.CaptureSession.current())) === null, "E2 되돌리기 후 세션 정리(current()===null)");

  const jsErrors = errs.filter((e) => !/favicon/i.test(e));
  ok(jsErrors.length === 0, "콘솔/페이지 JS 에러 0건 — " + JSON.stringify(jsErrors));
} finally {
  await browser.close();
  server.close();
}

console.log("\n" + (failed ? "FAILED " + failed + "건" : "ALL PASS"));
process.exit(failed ? 1 : 0);
