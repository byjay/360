/**
 * p171-gap3-cdp — SIGNAX 격차3 재발주(2026-10-19 지휘자) 실 Chrome CDP 검증.
 * 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p171-gap3-cdp.mjs
 *
 * 실 모듈 번들(_manifest.txt 순서) + 실 Chrome(데스크톱 뷰포트, GPS 기준점 맞추기는 디자이너 데스크톱
 * 작업을 전제) + 목 서버(API 는 JSON 목, 48_GPS.js/69_CaptureSession.js 는 실 소스).
 *
 * 검증:
 *  A. [GPS 기준점 맞추기] 화면 — 도면 탭 2점 + navigator.geolocation(page.setGeolocation)으로 짝짓기
 *     → 저장(POST) → 목 서버에 points·matrix 저장됨.
 *  A2. 3번째 점을 고의로 어긋난 GPS로 짝지으면 잔차>5m 경고 문구 표시(저장 전 취소, 2점 상태로 복귀).
 *  B. CaptureSession GPS 배치 모드 — 저장된 기준점으로 EXIF GPS 사진 3장 업로드 → 핀 3개가
 *     사전 계산한 기대 픽셀 위치(±1%)에 생성(GPS.Calib.pixelToGps 의 역함수로 EXIF 를 역산).
 *  C. 탭 모드 수동 시계보정 슬라이더 — 슬라이더 조작 시 미리보기 요약 실시간 갱신.
 *  D. 동선 모드 드래그 미리보기 — ghost-stop 을 실 포인터 드래그로 옮기면 확정 핀이 그 위치에 생성.
 *
 * 뮤테이션 2건(P171C_MUT=<이름>) — EXIT=1 이어야 한다:
 *   attachAlwaysNew : planBatchPlacement 의 임계거리 연결(attach) 판정 제거 → 전부 "new"
 *   clampRemoved    : CaptureSession.setManualOffsetSec 의 ±120초 clamp 제거(서버 소스 변형, p171 pure 와 같은 대상이나
 *                      이 CDP 가 실 UI 슬라이더 경로로 같은 결함을 다시 잡는지 별도 확인)
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "public");
const TMP = path.join(ROOT, ".tmp", "p171cdp");
fs.mkdirSync(TMP, { recursive: true });

let failed = 0;
const ok = (cond, label, detail) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail).slice(0, 400) : "")); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MUT = process.env.P171C_MUT || "";
let gpsSrc = fs.readFileSync(path.join(PUB, "js/modules/48_GPS.js"), "utf8").replace(/\r\n/g, "\n");
let csSrc = fs.readFileSync(path.join(PUB, "js/modules/69_CaptureSession.js"), "utf8").replace(/\r\n/g, "\n");
if (MUT === "attachAlwaysNew") {
  const needle = "if (best) { used.add(best.id); return { file: p.file, mode: \"attach\", pinId: best.id, x: pos.x, y: pos.y, distPct: bestD }; }";
  if (!gpsSrc.includes(needle)) { console.log("뮤테이션 대상 없음: attachAlwaysNew"); process.exit(2); }
  gpsSrc = gpsSrc.replace(needle, "if (false && best) { used.add(best.id); return { file: p.file, mode: \"attach\", pinId: best.id, x: pos.x, y: pos.y, distPct: bestD }; }");
  console.log("[뮤테이션 적용] attachAlwaysNew");
} else if (MUT === "clampRemoved") {
  const needle = "const s = Math.max(-this.MANUAL_OFFSET_MAX_S, Math.min(this.MANUAL_OFFSET_MAX_S, Number(sec) || 0));";
  if (!csSrc.includes(needle)) { console.log("뮤테이션 대상 없음: clampRemoved"); process.exit(2); }
  csSrc = csSrc.replace(needle, "const s = Number(sec) || 0;");
  console.log("[뮤테이션 적용] clampRemoved");
} else if (MUT) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }

/* ── Node 쪽에서 GPS.Calib 를 그대로 로드(실 소스, vm) — 테스트 기대값을 라이브러리와 동일 수식으로 계산 ── */
import vm from "node:vm";
function loadGPS(src) {
  const sandbox = { console, Math, JSON, Date, crypto: globalThis.crypto };
  sandbox.window = sandbox; sandbox.navigator = {}; sandbox.document = undefined; sandbox.localStorage = undefined;
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__GPS = GPS;", sandbox);
  return sandbox.__GPS;
}
const GPS_NODE = loadGPS(gpsSrc);

// 캘리브레이션 기준점 2개(실 브라우저에서도 똑같은 값을 geolocation 으로 먹인다)
const CAL_PX = [{ x: 15, y: 20 }, { x: 85, y: 70 }];
const CAL_GPS = [{ lat: 35.1000, lng: 129.0000 }, { lat: 35.1008, lng: 129.0009 }];
const calibPoints = CAL_PX.map((p, i) => ({ x: p.x, y: p.y, lat: CAL_GPS[i].lat, lng: CAL_GPS[i].lng }));
const fitExpected = GPS_NODE.Calib.fit(calibPoints);
ok(!!fitExpected, "사전 — Node 쪽 기대 fit 계산 성공(2점 상사변환)");

// 3장의 사진이 도착해야 할 기대 픽셀 위치 → 역변환으로 EXIF 에 넣을 GPS 계산
const TARGET_PX = [{ x: 30, y: 25 }, { x: 60, y: 55 }, { x: 40, y: 80 }];
const PHOTO_GPS = TARGET_PX.map((p) => GPS_NODE.Calib.pixelToGps(fitExpected, p.x, p.y));
ok(PHOTO_GPS.every((g) => g && Number.isFinite(g.lat) && Number.isFinite(g.lng)), "사전 — 3장 목표 픽셀 → GPS 역산 성공");

/* ── 합성 EXIF GPS JPEG 생성 — 실 디코드 가능한 샘플 이미지(SOI 뒤)에 APP1(EXIF GPS IFD)를 주입 ── */
const SAMPLE = path.join(PUB, "samples", "pano-test-1.jpg");
if (!fs.existsSync(SAMPLE)) { console.log("FAIL public/samples/pano-test-1.jpg 없음"); process.exit(2); }
function toDmsRational(absDeg) {
  const d = Math.floor(absDeg);
  const minFull = (absDeg - d) * 60;
  const m = Math.floor(minFull);
  const secFull = (minFull - m) * 60;
  const secNum = Math.round(secFull * 10000);
  return [[d, 1], [m, 1], [secNum, 10000]];
}
function u16le(b, o, v) { b.writeUInt16LE(v, o); }
function u32le(b, o, v) { b.writeUInt32LE(v, o); }
function buildTiffGps(lat, lng) {
  const latRef = lat >= 0 ? "N" : "S", lngRef = lng >= 0 ? "E" : "W";
  const latR = toDmsRational(Math.abs(lat)), lngR = toDmsRational(Math.abs(lng));
  const buf = Buffer.alloc(124);
  buf.write("II", 0, "latin1"); u16le(buf, 2, 42); u32le(buf, 4, 8);
  u16le(buf, 8, 1);
  u16le(buf, 10, 0x8825); u16le(buf, 12, 4); u32le(buf, 14, 1); u32le(buf, 18, 26);
  u32le(buf, 22, 0);
  u16le(buf, 26, 4);
  let e = 28;
  u16le(buf, e, 0x0001); u16le(buf, e + 2, 2); u32le(buf, e + 4, 2); buf.write(latRef, e + 8, "latin1"); buf.writeUInt8(0, e + 9); e += 12;
  u16le(buf, e, 0x0002); u16le(buf, e + 2, 5); u32le(buf, e + 4, 3); u32le(buf, e + 8, 76); e += 12;
  u16le(buf, e, 0x0003); u16le(buf, e + 2, 2); u32le(buf, e + 4, 2); buf.write(lngRef, e + 8, "latin1"); buf.writeUInt8(0, e + 9); e += 12;
  u16le(buf, e, 0x0004); u16le(buf, e + 2, 5); u32le(buf, e + 4, 3); u32le(buf, e + 8, 100); e += 12;
  const wr = (off, [num, den]) => { u32le(buf, off, num); u32le(buf, off + 4, den); };
  wr(76, latR[0]); wr(84, latR[1]); wr(92, latR[2]);
  wr(100, lngR[0]); wr(108, lngR[1]); wr(116, lngR[2]);
  return buf;
}
function makeGpsJpeg(lat, lng) {
  const base = fs.readFileSync(SAMPLE);
  const tiff = buildTiffGps(lat, lng);
  const exifHeader = Buffer.from("Exif\0\0", "latin1");
  const lenVal = 2 + exifHeader.length + tiff.length;
  const lenBuf = Buffer.alloc(2); lenBuf.writeUInt16BE(lenVal, 0);
  const app1 = Buffer.concat([Buffer.from([0xFF, 0xE1]), lenBuf, exifHeader, tiff]);
  return Buffer.concat([base.slice(0, 2), app1, base.slice(2)]);
}
// 자체 검증 — Node 쪽 GPS.parseExifGPS 로 주입한 EXIF 를 되읽어 원값과 일치하는지(픽스처 자체 결함 방지)
{
  const test = makeGpsJpeg(35.123456, -129.654321);
  const parsed = GPS_NODE.parseExifGPS(test.buffer.slice(test.byteOffset, test.byteOffset + test.byteLength));
  ok(!!parsed && Math.abs(parsed.lat - 35.123456) < 1e-4 && Math.abs(parsed.lng - (-129.654321)) < 1e-4, "사전 — 합성 EXIF GPS 픽스처 자체 왕복 검증", parsed);
}
const PHOTO_FILES = PHOTO_GPS.map((g, i) => {
  const p = path.join(TMP, "gpsphoto" + i + ".jpg");
  fs.writeFileSync(p, makeGpsJpeg(g.lat, g.lng));
  return p;
});

const MODS = fs.readFileSync(path.join(PUB, "js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const rdMod = (f) => {
  if (f === "48_GPS.js") return gpsSrc;
  if (f === "69_CaptureSession.js") return csSrc;
  return fs.readFileSync(path.join(PUB, "js/modules", f), "utf8").replace(/\r\n/g, "\n");
};
ok(MODS.includes("48_GPS.js") && MODS.includes("69_CaptureSession.js"), "사전 — _manifest.txt 에 48_GPS.js/69_CaptureSession.js 등록");
const bundle = MODS.map((f) => rdMod(f)).join("\n");

const CT = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webmanifest": "application/json" };
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const dep = { id: "dep1", version: 1, title: "dep1", file_name: "dep1.pdf", pages_data: JSON.stringify([PNG]), drawing_data: PNG, pins: JSON.stringify([]), zones: "[]", annotations: "[]" };
const decks = [{ id: "dk1", project_id: "prjT", name: "구역1", deployment_id: "dep1", page: 1, crop: null, parent_id: null }];
const json = (res, o, st = 200) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };

// 목 서버의 gps-calibration 저장소(메모리, deployment+page 키)
const calibStore = new Map();
const server = http.createServer(async (req, res) => {
  const u0 = decodeURIComponent(req.url.split("?")[0]);
  const qs = new URLSearchParams(req.url.split("?")[1] || "");
  if (u0 === "/sw.js") { res.writeHead(404); res.end(); return; }
  if (u0 === "/js/main.js") { res.writeHead(200, { "content-type": "application/javascript" }); res.end(bundle); return; }
  if (u0 === "/api/auth/auto-entry") return json(res, { token: "tokT", kind: "designer" });
  if (u0 === "/api/auth/me") return json(res, { authenticated: true, email: "owner@test.local", name: "owner", role: "super", auto: true, readonly: false });
  if (u0 === "/api/auth/config") return json(res, { google_client_id: "", demo_login: false });
  if (u0 === "/api/tenant/resolve") return json(res, { matched: false });
  if (u0 === "/api/projects") return json(res, { data: [{ id: "prjT", name: "tes", created_at: 1, published: false, can_manage_members: true }] });
  if (u0 === "/api/projects/prjT/decks") return json(res, { data: decks });
  if (u0 === "/api/projects/prjT/bands") return json(res, { band_size: 100, me: { email: "owner@test.local", band: 1, owner: true }, bands: [] });
  if (u0 === "/tables/deployments/dep1" && req.method === "GET") return json(res, dep);
  if (u0 === "/api/deployments/dep1/gps-calibration") {
    const page = qs.get("page") || "1";
    if (req.method === "GET") return json(res, { data: calibStore.get(page) || null });
    if (req.method === "DELETE") { calibStore.delete(page); return json(res, { success: true }); }
    if (req.method === "POST") {
      let buf = ""; req.on("data", (d) => (buf += d));
      req.on("end", () => {
        const body = JSON.parse(buf || "{}");
        calibStore.set(String(body.page || 1), { id: "cal1", page: body.page, points: body.points, matrix: body.matrix, residual_m: body.residual_m });
        json(res, { id: "cal1", page: body.page });
      });
      return;
    }
  }
  if (u0.startsWith("/api/") || u0.startsWith("/tables/")) return json(res, { data: [], settings: {}, value: {} });
  const f = path.join(PUB, u0 === "/" ? "index.html" : u0);
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
  const origin = "http://127.0.0.1:" + server.address().port;
  await browser.defaultBrowserContext().overridePermissions(origin, ["geolocation"]);
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e && e.message)));
  await page.setViewport({ width: 1280, height: 960 });
  await page.goto(origin + "/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__wm, { timeout: 20000 });
  await page.evaluate(() => sessionStorage.setItem("wm_id_token", "tokT"));
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.__wm, { timeout: 20000 });
  ok((await page.evaluate(() => !!(window.__wm && window.__wm.GPS && window.__wm.GPS.Calib))), "사전 — __wm.GPS.Calib 노출(99_footer)");

  await page.waitForSelector(".hub-tree-deck", { timeout: 15000 }).catch(() => {});
  await sleep(300);
  await page.evaluate(() => document.querySelector('.hub-tree-deck[data-deck-id="dk1"]').click());
  await page.waitForFunction(() => window.__wm.State.currentDeploymentId === "dep1", { timeout: 20000 });
  await sleep(200);

  /* ══ A. GPS 기준점 맞추기 — 실 탭 2점 + 실 geolocation 짝짓기 + 저장 ══ */
  await page.evaluate((deck) => window.__wm.GPS.Calib.openSheet(deck), decks[0]);
  await page.waitForSelector("#gps-calib-sheet", { timeout: 8000 });
  const paneBox = await page.evaluate(() => { const r = document.querySelector("#gps-calib-sheet img").parentElement.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });

  for (let i = 0; i < 2; i++) {
    await page.setGeolocation({ latitude: CAL_GPS[i].lat, longitude: CAL_GPS[i].lng, accuracy: 5 });
    const cx = paneBox.x + (CAL_PX[i].x / 100) * paneBox.w, cy = paneBox.y + (CAL_PX[i].y / 100) * paneBox.h;
    await page.mouse.click(cx, cy);
    await page.waitForSelector("#gps-calib-pair-sheet", { timeout: 5000 });
    await page.evaluate(() => { const s = document.getElementById("gps-calib-pair-sheet"); const b = Array.from(s.querySelectorAll(".theta-sheet-btn")).find((x) => /지금 위치 기록/.test(x.textContent)); b.click(); });
    await sleep(300);
  }
  const rowsText2 = await page.evaluate(() => document.getElementById("gps-calib-status").textContent);
  ok(/짝지어짐 2개/.test(rowsText2), "A1 기준점 2개 모두 GPS 짝지어짐 → " + rowsText2.replace(/\n/g, " / "));
  ok(/상사\(2점\)/.test(rowsText2), "A2 2점 → 상사변환으로 계산 → " + rowsText2.replace(/\n/g, " / "));

  /* ══ A2. 3번째 점 — 고의로 어긋난 GPS(500m 이상) → 잔차 경고, 확인 후 취소(3번째만 제거) ══ */
  await page.setGeolocation({ latitude: CAL_GPS[0].lat + 0.02, longitude: CAL_GPS[0].lng + 0.02, accuracy: 5 }); // 기준점1·2 추세와 크게 어긋나는 위치
  const cx3 = paneBox.x + 0.5 * paneBox.w, cy3 = paneBox.y + 0.5 * paneBox.h;
  await page.mouse.click(cx3, cy3);
  await page.waitForSelector("#gps-calib-pair-sheet", { timeout: 5000 });
  await page.evaluate(() => { const s = document.getElementById("gps-calib-pair-sheet"); const b = Array.from(s.querySelectorAll(".theta-sheet-btn")).find((x) => /지금 위치 기록/.test(x.textContent)); b.click(); });
  await sleep(300);
  const warnText = await page.evaluate(() => document.getElementById("gps-calib-status").textContent);
  ok(/잔차 경고/.test(warnText) || /최대 잔차/.test(warnText), "A3 3번째(어긋난 GPS) → 잔차 경고/수치 표시 → " + warnText.replace(/\n/g, " / "));
  // 3번째 점 제거(삭제 버튼 — 마지막 행)
  await page.evaluate(() => { const rows = document.querySelectorAll("#gps-calib-rows > div"); const last = rows[rows.length - 1]; const btn = Array.from(last.querySelectorAll("button")).find((b) => /삭제/.test(b.textContent)); btn.click(); });
  await sleep(200);
  const afterRemoveText = await page.evaluate(() => document.getElementById("gps-calib-status").textContent);
  ok(/짝지어짐 2개/.test(afterRemoveText), "A4 3번째 점 삭제 → 다시 2점 상태로 복귀 → " + afterRemoveText.replace(/\n/g, " / "));

  // 저장
  await page.evaluate(() => { const btns = document.querySelectorAll("#gps-calib-sheet button"); Array.from(btns).find((b) => b.textContent === "저장").click(); });
  await sleep(300);
  ok(calibStore.has("1"), "A5 [저장] → 목 서버에 POST 되어 저장됨(points·matrix) → " + JSON.stringify(calibStore.get("1") && { pts: calibStore.get("1").points.length }));
  await page.evaluate(() => { const btns = document.querySelectorAll("#gps-calib-sheet button"); Array.from(btns).find((b) => b.textContent === "닫기").click(); });

  /* ══ B. CaptureSession GPS 배치 — EXIF GPS 사진 3장 → 새 핀 2개(±1%) + 기존 핀 1개 연결(임계거리 내) ══ */
  // 🔴 attach 분기(임계거리 내 기존 핀 연결)를 실제로 타게 — TARGET_PX[1](60,55) 바로 옆(0.7% 거리)에
  // 기존 핀을 미리 심어 둔다(뮤테이션 attachAlwaysNew 가 이 분기를 지워도 여기서 "새 핀 3개"로 드러난다).
  await page.evaluate(() => { window.__wm.State.pins.push({ id: "existPin1", page: 1, x: 60.5, y: 55.5, label: "E1", checkboard: false }); window.__wm.UI.renderPinList(); window.__wm.UI.renderPinsOnMap(); });
  await page.evaluate(() => { window.__wm.State.checkboard = true; if (window.__wm.App._setRegMode) window.__wm.App._setRegMode("photo"); else window.__wm.State.regMode = "photo"; });
  await sleep(100);
  await page.evaluate(() => { window.__wm.CaptureSession.start({ mode: "gps", zoneName: "GPS구역", prefix: "G", startNo: 1, page: 1 }); });
  const inputGps = await page.$("#input-capture-session");
  ok(!!inputGps, "B0 숨겨진 파일 입력 존재");
  await inputGps.uploadFile(...PHOTO_FILES);
  await page.waitForSelector("#capsess-preview-sheet", { timeout: 10000 }).catch(() => {});
  const gpsPreviewBody = await page.evaluate(() => { const s = document.getElementById("capsess-preview-sheet"); return s ? s.querySelector(".theta-sheet-body").textContent : null; });
  ok(!!gpsPreviewBody && /새 핀 2개/.test(gpsPreviewBody) && /연결 1개/.test(gpsPreviewBody), "B1 GPS 배치 미리보기 — 새 핀 2개 + 기존 핀 연결 1개 → " + gpsPreviewBody);
  const ghostCountGps = await page.evaluate(() => document.querySelectorAll(".capsess-ghost-stop").length);
  ok(ghostCountGps === 3, "B2 ghost 미리보기 점 3개(새 2 + 연결 1) 렌더 → " + ghostCountGps);

  await page.evaluate(() => { const s = document.getElementById("capsess-preview-sheet"); const btn = Array.from(s.querySelectorAll(".theta-sheet-btn")).find((b) => /확인/.test(b.textContent)); btn.click(); });
  await page.waitForFunction(
    () => { const gp = window.__wm.State.pins.filter((p) => p.label && p.label.startsWith("G")); const ex = window.__wm.State.pins.find((p) => p.id === "existPin1"); return gp.length === 2 && gp.every((p) => !!(p.imageId || p.pendingOpId)) && ex && !!(ex.imageId || ex.pendingOpId); },
    { timeout: 15000 }
  ).catch(() => {});
  const createdPins = await page.evaluate(() => window.__wm.State.pins.filter((p) => p.label && p.label.startsWith("G")).map((p) => ({ x: p.x, y: p.y, imageId: p.imageId, pendingOpId: p.pendingOpId })));
  const existPinAfter = await page.evaluate(() => { const p = window.__wm.State.pins.find((pp) => pp.id === "existPin1"); return p && { x: p.x, y: p.y, imageId: p.imageId, pendingOpId: p.pendingOpId }; });
  ok(createdPins.length === 2, "B3 새 핀 2개만 생성됨(3번째는 기존 핀에 연결) → " + createdPins.length);
  ok(!!existPinAfter && existPinAfter.x === 60.5 && existPinAfter.y === 55.5, "B3b 기존 핀(existPin1)은 위치 불변(연결만, 이동 없음) → " + JSON.stringify(existPinAfter));
  [TARGET_PX[0], TARGET_PX[2]].forEach((t, i) => {
    const got = createdPins[i];
    const dx = got ? Math.abs(got.x - t.x) : 999, dy = got ? Math.abs(got.y - t.y) : 999;
    ok(!!got && dx <= 1 && dy <= 1, "B4." + i + " 핀 위치 기대(" + t.x + "," + t.y + ") vs 실제(" + (got && got.x.toFixed(2)) + "," + (got && got.y.toFixed(2)) + ") ±1% 이내", { dx, dy });
  });
  ok(createdPins.every((p) => !!(p.imageId || p.pendingOpId)), "B5 새 핀 2건 사진 등록 완료(imageId/pendingOpId)");
  ok(!!existPinAfter && !!(existPinAfter.imageId || existPinAfter.pendingOpId), "B6 기존 핀(existPin1)에 사진 연결 완료(attach) → " + JSON.stringify(existPinAfter));

  /* ══ C. 탭 모드 — 수동 시계보정 슬라이더 실시간 갱신 ══ */
  await page.evaluate(() => { window.__wm.CaptureSession.start({ mode: "tap", zoneName: "탭구역", prefix: "T", startNo: 1, page: 1 }); });
  await sleep(300); // 🔴 실측(함정) — start() 직후 지도/허브 레이아웃이 아직 자리잡기 전에 클릭하면 간헐적으로 다른 요소가 먹는다(레이아웃 안정화 대기).
  // 🔴 실측 — MapCtrl.viewportToPercent() 는 #map-viewport 가 아니라 #map-transform(실 콘텐츠, 줌/팬 반영
  //   후 렌더 크기)의 rect 로 % 를 계산한다(10_MapCtrl.js:578). 클릭 좌표를 여기 기준으로 잡아야 의도한
  //   %(기대 위치) 에 정확히 떨어진다 — #map-viewport 기준이면 레이아웃에 따라 clamp(0/100) 로 어긋난다.
  const vpBox = await page.evaluate(() => { const r = document.getElementById("map-transform").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const resetView = () => page.evaluate(() => { window.__wm.State.zoom = 1; window.__wm.State.pan = { x: 0, y: 0 }; if (window.__wm.MapCtrl && window.__wm.MapCtrl.applyTransform) window.__wm.MapCtrl.applyTransform(); });
  for (const [dx, dy] of [[60, 60], [60, 300]]) {
    await resetView();
    await page.mouse.click(vpBox.x + dx, vpBox.y + dy);
    await sleep(200);
  }
  await resetView();
  const tapTimes = await page.evaluate(() => window.__wm.CaptureSession.current().taps.map((t) => t.t));
  ok(tapTimes.length === 2, "사전 — 탭 2회가 실제 기록됨 → " + tapTimes.length);
  if (tapTimes.length < 2) { console.log("\nFAILED (탭 미기록 — 조사 필요)"); process.exit(1); }
  // 🔴 실측(함정) — public/samples/pano-test-1.jpg 는 실제 THETA EXIF(DateTimeOriginal=2022-08-25)가
  //   박혀 있다("EXIF 없음" 전제는 GPS 태그에만 해당). lastModified 폴백을 재현하려면 EXIF 날짜가 없는
  //   사진이 필요 — 브라우저 Canvas 로 생성한 순수 JPEG(EXIF 0바이트, 실 디코드 가능)를 쓴다.
  const blankJpegB64 = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 4; c.height = 4; const ctx = c.getContext("2d"); ctx.fillStyle = "#808080"; ctx.fillRect(0, 0, 4, 4); return c.toDataURL("image/jpeg", 0.8).split(",")[1]; });
  const blankJpeg = Buffer.from(blankJpegB64, "base64");
  const TF = [0, 1].map((i) => { const p = path.join(TMP, "tap" + i + ".jpg"); fs.writeFileSync(p, blankJpeg); return p; });
  TF.forEach((f, i) => { const t = new Date(tapTimes[i] + 20000); fs.utimesSync(f, t, t); }); // 20초 어긋난 시계(고의)
  const inputTap = await page.$("#input-capture-session");
  await inputTap.uploadFile(...TF);
  await page.waitForSelector("#capsess-preview-sheet", { timeout: 8000 }).catch(() => {});
  const beforeSlide = await page.evaluate(() => document.getElementById("capsess-preview-sheet").querySelector(".theta-sheet-body").textContent);
  const sliderExists = await page.evaluate(() => !!document.querySelector('#capsess-preview-sheet input[type="range"]'));
  ok(sliderExists, "C1 탭 미리보기 시트에 수동 시계보정 슬라이더 렌더");
  // 🔴 clampRemoved 뮤테이션 가드 — HTML input[type=range] 자체의 min/max 는 브라우저가 자동 clamp 하므로
  // 슬라이더 값만으론 JS 클램프 제거를 못 잡는다. setManualOffsetSec() 를 직접 호출해 ±120초 경계를 확인.
  const clampCheck = await page.evaluate(() => { window.__wm.CaptureSession.setManualOffsetSec(999); return window.__wm.CaptureSession.current().manualOffsetMs; });
  ok(clampCheck === 120000, "C1b setManualOffsetSec(999) → ±120초로 clamp(실 UI 경로) → " + clampCheck);
  await page.evaluate(() => { window.__wm.CaptureSession.setManualOffsetSec(0); });
  await page.evaluate(() => { const s = document.querySelector('#capsess-preview-sheet input[type="range"]'); s.value = "-20"; s.dispatchEvent(new Event("input", { bubbles: true })); });
  await sleep(300);
  const afterSlide = await page.evaluate(() => document.getElementById("capsess-preview-sheet").querySelector(".theta-sheet-body").textContent);
  // 🔴 photos 의 mtime 을 taps+20초로 고의 설정(시계 어긋남 재현) → auto-offset(-20초)가 이미 완전 보정 중이라
  //   매칭 2건. 슬라이더로 수동 -20초를 "추가"하면 보정이 과해져(총 -40초) 허용오차(5분) 안이라 매칭수는
  //   유지될 수 있다 — 실시간 갱신의 증거는 "텍스트 자체가 바뀌었다"(before!==after)로 충분하고,
  //   추가로 미연결 탭/사진 수치가 실제로 달라졌는지도 함께 확인한다(화면이 죽은 채 그대로가 아님).
  ok(afterSlide !== beforeSlide, "C2 슬라이더 조작(-20초) → 미리보기 텍스트 실시간 갱신(이전과 다른 텍스트) → before=[" + beforeSlide + "] after=[" + afterSlide + "]");
  await page.evaluate(() => { const s = document.getElementById("capsess-preview-sheet"); const btn = Array.from(s.querySelectorAll(".theta-sheet-btn")).find((b) => /취소/.test(b.textContent)); btn.click(); });
  await page.evaluate(() => { window.__wm.CaptureSession.undo(); });

  /* ══ D. 동선 모드 — ghost-stop 실 드래그 → 확정 핀이 드래그된 위치에 생성 ══ */
  await page.evaluate(() => {
    window.__wm.CaptureSession.start({ mode: "route", zoneName: "동선구역", prefix: "R", startNo: 1, page: 1, routePoints: [{ x: 10, y: 10 }, { x: 90, y: 90 }] });
  });
  const RF = [0, 1].map((i) => { const p = path.join(TMP, "route" + i + ".jpg"); fs.writeFileSync(p, blankJpeg); return p; });
  const inputRoute = await page.$("#input-capture-session");
  await inputRoute.uploadFile(...RF);
  await page.waitForSelector(".capsess-ghost-stop", { timeout: 8000 }).catch(() => {});
  const ghostBeforeLeftPct = await page.evaluate(() => parseFloat(document.querySelector(".capsess-ghost-stop").style.left));
  // 실 포인터 드래그(PointerEvent) — #map-transform 의 60%,20% 지점으로. 🔴 실측(함정) — MapCtrl.viewportToPercent
  //   는 #map-transform(10_MapCtrl.js:578) 기준이고, 그 rect 는 모드 전환·업로드 때마다 재계산될 수 있어
  //   섹션 C 에서 측정한 낡은 vpBox 를 그대로 쓰면 clamp(100%) 로 어긋난다 — 드래그 직전에 다시 측정한다.
  const tfBox = await page.evaluate(() => { const r = document.getElementById("map-transform").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const dragTargetPct = { x: 60, y: 20 };
  const dragTarget = { x: tfBox.x + (dragTargetPct.x / 100) * tfBox.w, y: tfBox.y + (dragTargetPct.y / 100) * tfBox.h };
  await page.evaluate((mx, my) => {
    const el = document.querySelector(".capsess-ghost-stop");
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 0, clientY: 0, pointerId: 1 }));
    document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true, clientX: mx, clientY: my, pointerId: 1 }));
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, clientX: mx, clientY: my, pointerId: 1 }));
  }, dragTarget.x, dragTarget.y);
  await sleep(200);
  const ghostAfterLeftPct = await page.evaluate(() => parseFloat(document.querySelector(".capsess-ghost-stop").style.left));
  ok(Math.abs(ghostAfterLeftPct - dragTargetPct.x) <= 1, "D1 ghost-stop 실 드래그(PointerEvent) → left% 가 드래그 지점(60%)으로 이동 → " + ghostBeforeLeftPct.toFixed(1) + " → " + ghostAfterLeftPct.toFixed(1));
  await page.evaluate(() => { const s = document.getElementById("capsess-preview-sheet"); const btn = Array.from(s.querySelectorAll(".theta-sheet-btn")).find((b) => /확인/.test(b.textContent)); btn.click(); });
  await page.waitForFunction(() => window.__wm.State.pins.some((p) => p.label && p.label.startsWith("R")), { timeout: 8000 }).catch(() => {});
  const routePin = await page.evaluate(() => window.__wm.State.pins.find((p) => p.label && p.label.startsWith("R")));
  ok(!!routePin && Math.abs(routePin.x - dragTargetPct.x) <= 2, "D2 확정 핀이 드래그된 위치에 생성 → 기대 x≈" + dragTargetPct.x + " 실제 x=" + (routePin && routePin.x.toFixed(2)));

  const jsErrors = errs.filter((e) => !/favicon/i.test(e));
  ok(jsErrors.length === 0, "콘솔/페이지 JS 에러 0건 — " + JSON.stringify(jsErrors));
} finally {
  await browser.close();
  server.close();
}

console.log("\n" + (failed ? "FAILED " + failed + "건" : "ALL PASS"));
process.exit(failed ? 1 : 0);
