/**
 * p152b-cdp — WO 20261013-photofolder (실 Chrome · 실 모듈 번들(_manifest.txt 순서) · 목 서버 API)
 * 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p152b-photo-folder-cdp.mjs
 *
 * 경계(p101/p106/p111 과 같은 관례): 서버 API 는 목, 클라이언트는 public/ 실 모듈을 _manifest.txt
 * 순서로 번들해 실행. showDirectoryPicker 는 헤드리스에서 네이티브 다이얼로그를 띄울 수 없으므로
 * webkitdirectory 폴백 경로(input[type=file][webkitdirectory])를 실제 이미지 파일로 검증한다
 * (ElementHandle.uploadFile — 실 File 객체 생성·EXIF/치수 읽기까지 실 브라우저 파이프라인).
 * handle 경로(FileSystemDirectoryHandle)는 IndexedDB 저장·복원 단위까지만 검증한다(지시 §).
 *
 * 검증: 1건+자동OFF→확인모달[등록] · [앞으로 자동]→이후 자동등록(확인 0) · 0건→기존 폴백(파일창) ·
 *   다중후보→선택모달(자동등록 0) · 열람자 0 · IndexedDB(SyncQueue draft) 저장·복원 라운드트립.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "public");
const TMP = path.join(ROOT, ".tmp", "p152b");
fs.mkdirSync(TMP, { recursive: true });

let failed = 0;
const ok = (cond, label, detail) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail).slice(0, 300) : "")); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 테스트용 이미지 파일(실 2:1 파노라마 — App._detect360 실제 판정 통과용) ── */
const PANO = path.join(PUB, "samples", "pano-test-1.jpg");
if (!fs.existsSync(PANO)) { console.log("FAIL public/samples/pano-test-1.jpg 없음"); process.exit(2); }
function mkPano(name) { const p = path.join(TMP, name); fs.copyFileSync(PANO, p); return p; }
const F_P1 = mkPano("P1.jpg");       // 핀 P1과 1건 매칭
const F_P02 = mkPano("p02.jpg");     // 핀 P2와 1건 매칭(앞자리0+소문자 — 정규화 검증)
const F_P3A = mkPano("P3.jpg");      // 핀 P3과 다중후보①
const F_P3B = mkPano("p-3.png");     // 핀 P3과 다중후보②(png, 구분자 포함)
// P99 매칭 파일은 의도적으로 없음(0건 경로 검증용)

/* ── 실 모듈 번들(_manifest.txt 순서) + __wm 테스트 훅 ── */
const MODS = fs.readFileSync(path.join(PUB, "js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const rdMod = (f) => fs.readFileSync(path.join(PUB, "js/modules", f), "utf8").replace(/\r\n/g, "\n");
ok(MODS.includes("60_PhotoFolder.js"), "사전 — _manifest.txt 에 60_PhotoFolder.js 등록");
ok(/49_AiVision\.js\n99_footer\.js/.test(fs.readFileSync(path.join(PUB, "js/modules/_manifest.txt"), "utf8")), "사전 — 49_AiVision→99_footer 인접(p127 제약 불변)");
const bundle = MODS.map((f) => rdMod(f)).join("\n"); // 99_footer.js 가 이미 __wm 에 PhotoFolder 를 담아 노출(수정 0, 재노출 불필요)

const CT = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webmanifest": "application/json" };
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const P = (id, label, extra) => Object.assign({ id, x: 30, y: 30, page: 1, label: String(label) }, extra || {});
// 360(content) 계열 핀 5개: 1,2,3,98(기존사진 있음=건너뛰기 대상),99(폴더에 매칭 파일 없음=0건 경로)
const N1 = P(1, "1"); const N2 = P(2, "2"); const N3 = P(3, "3");
const N98 = P(98, "98", { imageId: "already" });
const N99 = P(99, "99");
const dep = { id: "dep1", version: 1, title: "dep1", file_name: "dep1.pdf", pages_data: JSON.stringify([PNG]), drawing_data: PNG, pins: JSON.stringify([N1, N2, N3, N98, N99]), zones: "[]", annotations: "[]" };
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
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto("http://127.0.0.1:" + server.address().port + "/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__wm, { timeout: 20000 });
  await page.evaluate(() => sessionStorage.setItem("wm_id_token", "tokT"));
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.__wm, { timeout: 20000 });

  ok((await page.evaluate(() => !!(window.__wm && window.__wm.PhotoFolder))), "__wm.PhotoFolder 노출(99_footer)");

  await page.waitForSelector(".hub-tree-deck", { timeout: 15000 }).catch(() => {});
  await sleep(300);
  await page.evaluate(() => document.querySelector('.hub-tree-deck[data-deck-id="dk1"]').click());
  await page.waitForFunction(() => window.__wm.State.currentDeploymentId === "dep1" && (window.__wm.State.pins || []).length === 5, { timeout: 20000 });
  await sleep(300);

  // 360 모드 진입(regMode="photo") — App._setRegMode(SoT) 재사용
  await page.evaluate(() => { window.__wm.State.checkboard = true; if (window.__wm.App._setRegMode) window.__wm.App._setRegMode("photo"); else window.__wm.State.regMode = "photo"; window.__wm.App._updateCheckboardQuickStatus(1); });
  await sleep(100);
  ok((await page.evaluate(() => document.getElementById("photofolder-bar") && !document.getElementById("photofolder-bar").classList.contains("hidden"))), "A 360 모드 진입 → 폴더 지정 상태바 노출");

  // ── 폴더 지정(폴백 input, 실 파일 업로드) ──
  // [실측] 헤드리스 Chrome의 CDP DOM.setFileInputFiles 는 webkitdirectory 속성이 있는 input
  // 에는 files 를 채우지 못한다(input.files.length=0, change 이벤트 0회 — .tmp/p152b_debug*.log
  // 로 확인). OS 네이티브 폴더 다이얼로그 자체는 showDirectoryPicker 와 마찬가지로 헤드리스에서
  // 구동 불가(지시 §에 명시된 한계). 애플리케이션 로직(change 핸들러·매칭·등록)은 input 요소가
  // 아니라 e.target.files 만 읽으므로, 테스트 전용으로 속성만 제거해 동일 핸들러를 실 파일로
  // 구동한다(실사용 UI의 폴더-only 강제는 OS 다이얼로그 몫 — 이 테스트의 범위 밖, 정직하게 기록).
  await page.evaluate(() => { window.__wm.PhotoFolder._ensureFallbackInput(); document.getElementById("photofolder-fallback-input").removeAttribute("webkitdirectory"); });
  const input = await page.$("#photofolder-fallback-input");
  await input.uploadFile(F_P1, F_P02, F_P3A, F_P3B);
  await page.waitForFunction(() => /\(4장\)/.test(document.getElementById("photofolder-status-text").textContent), { timeout: 5000 });
  ok(true, "B 폴백 폴더 지정(webkitdirectory, 실 파일 4장) → 상태바 '(4장)' 반영");
  // [WO 20261015-numunify 동반 수정] 244c5d8(구역별 폴더·체크박스)가 API 를 바꿨는데 이 CDP 테스트는 갱신되지 않아 HEAD 에서도
  //   EXIT=1(확인모달 대기 타임아웃)이었다. "하나씩 등록" 기본값 OFF → 이 시나리오(핀 찍을 때마다 확인/자동)는 ON 전제.
  //   setAuto/_draftKey 는 구역 키 인자를 받는다(시그니처 변경 반영). 표시 번호는 "P" 접두 폐기(1·99).
  const DKEY = await page.evaluate(() => window.__wm.PhotoFolder._activeDeckKey());
  await page.evaluate((k) => window.__wm.PhotoFolder.setSingleOn(k, true), DKEY);

  /* ── 1건+자동OFF → 확인모달 → [등록] ── */
  await page.evaluate(() => { window.__handled1 = null; window.__wm.PhotoFolder.handlePinPlaced(window.__wm.State.pins.find((p) => p.id === 1)).then((h) => { window.__handled1 = h; }); });
  await page.waitForFunction(() => !document.getElementById("photofolder-confirm-modal").classList.contains("hidden"), { timeout: 5000 });
  const msg1 = await page.evaluate(() => document.getElementById("photofolder-confirm-msg").textContent);
  ok(/^1 ← P1\.jpg/.test(msg1), "C 1건+자동OFF → 확인모달 노출(핀 1 ↔ P1.jpg, 표시 접두 없음) — " + msg1);
  await page.evaluate(() => document.getElementById("photofolder-confirm-register").click());
  // [실측] 목 서버엔 /api/r2/upload 가 없어 Cloud.uploadImage 가 실패 → SyncQueue.enqueue 오프라인
  // 폴백(pendingOpId)으로 떨어진다 — _uploadOneRow 의 정상 분기(35_PhotoBatch.js:653-663)이며
  // "등록됨" 판정은 PinSeries.mediaOf 와 동일하게 imageId OR pendingOpId 둘 중 하나로 본다.
  await page.waitForFunction(() => { const p = window.__wm.State.pins.find((p) => p.id === 1); return !!(p.imageId || p.pendingOpId); }, { timeout: 8000 });
  ok(true, "C [등록] 클릭 → 핀1 등록 완료(imageId/pendingOpId)");
  ok((await page.evaluate(() => window.__handled1)) === true, "C handlePinPlaced(핀1) → true(처리함)");

  /* ── [앞으로 자동] 경로: 핀2(p02.jpg 1건 매칭) — 등록 전 자동ON 세팅 ── */
  await page.evaluate((k) => window.__wm.PhotoFolder.setAuto(k, true), DKEY);
  let handled2;
  handled2 = await page.evaluate(async () => { return await window.__wm.PhotoFolder.handlePinPlaced(window.__wm.State.pins.find((p) => p.id === 2)); });
  ok(handled2 === true, "D 자동ON → handlePinPlaced(핀2) → true(즉시 처리)");
  const confirmHiddenD = await page.evaluate(() => document.getElementById("photofolder-confirm-modal").classList.contains("hidden"));
  ok(confirmHiddenD, "D 자동ON → 확인모달 안 띄움(묻지 않고 등록)");
  const pin2 = await page.evaluate(() => window.__wm.State.pins.find((p) => p.id === 2));
  ok(!!(pin2.imageId || pin2.pendingOpId) && !!pin2.imageName, "D 핀2 자동 등록 완료(앞자리0+소문자 'p02.jpg' 정규화 매칭) — " + JSON.stringify({ imageId: pin2.imageId, pendingOpId: pin2.pendingOpId, imageName: pin2.imageName }));

  /* ── 다중 후보: 핀3(P3.jpg + p-3.png 2건) → 선택모달, 자동ON 이어도 즉시등록 0 ── */
  const handled3 = await page.evaluate(async () => { return await window.__wm.PhotoFolder.handlePinPlaced(window.__wm.State.pins.find((p) => p.id === 3)); });
  ok(handled3 === true, "E 다중후보 → true(선택모달로 처리)");
  const pickVisible = await page.evaluate(() => !document.getElementById("photofolder-pick-modal").classList.contains("hidden"));
  ok(pickVisible, "E 다중후보 → 선택모달 노출(자동ON 이어도 묻는다)");
  const pin3Before = await page.evaluate(() => { const p = window.__wm.State.pins.find((p) => p.id === 3); return !!(p.imageId || p.pendingOpId); });
  ok(pin3Before === false, "E 선택 전엔 핀3 미등록(자동등록 0건)");
  const itemCount = await page.evaluate(() => document.querySelectorAll("#photofolder-pick-list .photofolder-pick-item").length);
  ok(itemCount === 2, "E 선택모달 항목 2개(P3.jpg, p-3.png) — " + itemCount);
  await page.evaluate(() => document.querySelectorAll("#photofolder-pick-list .photofolder-pick-item")[0].click());
  await page.waitForFunction(() => { const p = window.__wm.State.pins.find((p) => p.id === 3); return !!(p.imageId || p.pendingOpId); }, { timeout: 8000 });
  ok(true, "E 항목 클릭 → 핀3 등록 완료(선택한 1건만)");

  /* ── 이미 사진 있는 핀(98) → false(덮어쓰지 않음) ── */
  const handled98 = await page.evaluate(async () => { return await window.__wm.PhotoFolder.handlePinPlaced(window.__wm.State.pins.find((p) => p.id === 98)); });
  ok(handled98 === false, "F 이미 사진 있는 핀98 → false(덮어쓰지 않음, 기존 폴백 위임)");

  /* ── 0건 매칭(핀99, 폴더에 P99 없음) → false + 안내 토스트 ── */
  const handled99 = await page.evaluate(async () => { return await window.__wm.PhotoFolder.handlePinPlaced(window.__wm.State.pins.find((p) => p.id === 99)); });
  ok(handled99 === false, "G 0건 매칭(핀99) → false(기존 폴백 — 파일선택창 경로로)");
  await sleep(150);
  const toastText = await page.evaluate(() => { const h = document.getElementById("wm-toast-host"); return h ? Array.from(h.children).map((c) => c.textContent).join(" | ") : ""; });
  ok(/폴더에 99 사진이 없습니다/.test(toastText), "G 안내 토스트에 '폴더에 99 사진이 없습니다'(접두 없음) — " + toastText);

  /* ── 열람자(Auth.readonly) → 기능 0(모든 핀에서 false, 상태바 숨김) ── */
  await page.evaluate(() => { window.__wm.Auth.readonly = true; window.__wm.App._updateCheckboardQuickStatus(1); });
  await sleep(100);
  ok((await page.evaluate(() => document.getElementById("photofolder-bar").classList.contains("hidden"))), "H 열람자 → 상태바 숨김");
  const n4 = P(4, "4"); // 새 핀(아직 폴더에 매칭 파일 있음 — "P4"는 폴더에 없으니 실제로는 0건이지만, readonly 가드가 그보다 먼저 걸려야 한다
  const handledRO = await page.evaluate(async (pin) => { window.__wm.State.pins.push(pin); return await window.__wm.PhotoFolder.handlePinPlaced(pin); }, n4);
  ok(handledRO === false, "H 열람자 → handlePinPlaced 항상 false(폴더 지정돼 있어도 기능 0)");
  await page.evaluate(() => { window.__wm.Auth.readonly = false; });

  /* ── IndexedDB(SyncQueue draft) 저장·복원 라운드트립 — handle 경로는 헤드리스에서 네이티브
     다이얼로그를 띄울 수 없으므로 저장/복원 "단위" 수준만 검증(지시 §, 실제 핸들 객체는 제외). ── */
  const draftKey = await page.evaluate((k) => window.__wm.PhotoFolder._draftKey(k), DKEY);
  ok(draftKey === "photofolder:prjT:" + DKEY, "I draft 키 = 'photofolder:<projectId>:<구역키>' — " + draftKey);
  await page.evaluate(async (key) => { await window.__wm.SyncQueue.saveDraft(key, { name: "RICOH THETA" }); }, draftKey);
  const loaded1 = await page.evaluate(async (key) => await window.__wm.SyncQueue.loadDraft(key), draftKey);
  ok(loaded1 && loaded1.name === "RICOH THETA", "I SyncQueue.saveDraft→loadDraft 즉시 라운드트립 — " + JSON.stringify(loaded1));
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.__wm, { timeout: 20000 });
  const loaded2 = await page.evaluate(async (key) => await window.__wm.SyncQueue.loadDraft(key), draftKey);
  ok(loaded2 && loaded2.name === "RICOH THETA", "I 새로고침(= 다음 방문) 후에도 IndexedDB 에서 복원 — " + JSON.stringify(loaded2));

  const jsErrors = errs.filter((e) => !/favicon/i.test(e));
  ok(jsErrors.length === 0, "콘솔/페이지 JS 에러 0건 — " + JSON.stringify(jsErrors));
} finally {
  await browser.close();
  server.close();
}

console.log("\n" + (failed ? "FAILED " + failed + "건" : "ALL PASS"));
process.exit(failed ? 1 : 0);
