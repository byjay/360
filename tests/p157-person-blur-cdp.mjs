/**
 * p157-person-blur-cdp — WO 20261015-personblur (실 Chrome · 실 모듈 번들(_manifest.txt 순서) · 목 서버 API)
 * 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p157-person-blur-cdp.mjs
 *
 * 경계(p152b 와 같은 관례): 서버 API 는 목, 클라이언트는 public/ 실 모듈을 _manifest.txt 순서로
 * 번들해 실행. 모델(TF.js/COCO-SSD) 네트워크 로드는 헤드리스 테스트에서 불가 → PersonBlur.setDetector
 * 로 결정적 스텁을 주입(실제 모델 1회 수동 확인은 별도 보고 — 정직하게 표시). 캔버스 디코딩·블러
 * 픽셀 연산·업로드/저장·되돌리기·열람자 게이트는 전부 실 브라우저 DOM/캔버스로 검증한다.
 *
 * 검증: 박스 적용 → 처리본 픽셀이 원본과 다르고 박스 밖은 동일 · 원본 보존(blurOrigUrl) ·
 *   [적용] 저장(imageId 교체) · [원본으로 되돌리기] · 열람자(canEdit:false) 버튼 0 · 오프라인 비활성.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "public");

let failed = 0;
const ok = (cond, label, detail) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail).slice(0, 300) : "")); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PANO = path.join(PUB, "samples", "pano-test-1.jpg");
if (!fs.existsSync(PANO)) { console.log("FAIL public/samples/pano-test-1.jpg 없음"); process.exit(2); }
const PANO_DATAURL = "data:image/jpeg;base64," + fs.readFileSync(PANO).toString("base64");

/* ── 실 모듈 번들(_manifest.txt 순서) ── */
const MODS = fs.readFileSync(path.join(PUB, "js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const rdMod = (f) => fs.readFileSync(path.join(PUB, "js/modules", f), "utf8").replace(/\r\n/g, "\n");
ok(MODS.includes("62_PersonBlur.js"), "사전 — _manifest.txt 에 62_PersonBlur.js 등록");
{ // [WO 20261019-gap1] p127 과 같은 교정 — AiVision 등록 + footer 마지막 줄(진짜 불변)만 본다.
  const mf = fs.readFileSync(path.join(PUB, "js/modules/_manifest.txt"), "utf8");
  ok(/49_AiVision\.js/.test(mf) && /\n99_footer\.js\s*$/.test(mf), "사전 — 49_AiVision 등록 + 99_footer.js 마지막 줄(p127 불변 교정판)");
}
const bundle = MODS.map((f) => rdMod(f)).join("\n");

const CT = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webmanifest": "application/json" };
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const store = { images: { img0: PANO_DATAURL }, r2: {}, seq: 1 };
const N1 = { id: 1, x: 30, y: 30, page: 1, label: "1", imageId: "img0" };
const dep = { id: "dep1", version: 1, title: "dep1", file_name: "dep1.pdf", pages_data: JSON.stringify([PNG]), drawing_data: PNG, pins: JSON.stringify([N1]), zones: "[]", annotations: "[]" };
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
  if (u === "/tables/pano_images" && req.method === "POST") {
    let body = ""; req.on("data", (c) => body += c); await new Promise((r) => req.on("end", r));
    let j = {}; try { j = JSON.parse(body); } catch (e) {}
    const id = "img" + (store.seq++);
    store.images[id] = j.image_data;
    return json(res, { id });
  }
  const mImg = u.match(/^\/tables\/pano_images\/(.+)$/);
  if (mImg && req.method === "GET") { const d = store.images[mImg[1]]; return d ? json(res, { image_data: d }) : json(res, { error: "nf" }, 404); }
  if (u === "/api/r2/upload" && req.method === "PUT") {
    const chunks = []; req.on("data", (c) => chunks.push(c)); await new Promise((r) => req.on("end", r));
    const id = "orig" + (store.seq++);
    store.r2[id] = Buffer.concat(chunks);
    return json(res, { url: "/api/r2/object/" + id });
  }
  const mR2 = u.match(/^\/api\/r2\/object\/(.+)$/);
  if (mR2) { const b = store.r2[mR2[1]]; if (!b) return json(res, { error: "nf" }, 404); res.writeHead(200, { "content-type": "image/jpeg" }); res.end(b); return; }
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

  ok((await page.evaluate(() => !!(window.__wm && window.__wm.PersonBlur))), "__wm.PersonBlur 노출(99_footer)");

  await page.waitForSelector(".hub-tree-deck", { timeout: 15000 }).catch(() => {});
  await sleep(300);
  await page.evaluate(() => document.querySelector('.hub-tree-deck[data-deck-id="dk1"]').click());
  await page.waitForFunction(() => window.__wm.State.currentDeploymentId === "dep1" && (window.__wm.State.pins || []).length === 1, { timeout: 20000 });
  await sleep(200);

  /* ── 결정적 감지 스텁 주입(모델 네트워크 로드 0) ── */
  await page.evaluate(() => {
    let n = 0;
    window.__wm.PersonBlur.setDetector(async () => {
      n++;
      return n === 1 ? [{ class: "person", score: 0.9, bbox: [10, 10, 40, 60] }] : [];
    });
  });

  /* ── A. 핀 팝업에서 [사람 흐리게] 버튼(디자이너) → 편집 모달 ── */
  await page.evaluate(() => window.__wm.PinActionPop.open(1));
  await page.waitForSelector("#pap-personblur-open", { timeout: 8000 });
  ok(true, "A 핀 팝업에 [사람 흐리게] 버튼 노출(디자이너)");
  await page.evaluate(() => document.getElementById("pap-personblur-open").click());
  await page.waitForSelector("#pbl-modal #pbl-canvas", { timeout: 8000 });
  await page.waitForFunction(() => { const ed = window.__wm.PersonBlur._editors[1]; return ed && Array.isArray(ed.boxes) && ed.boxes.length > 0 && !ed.busy; }, { timeout: 8000 });
  const box0 = await page.evaluate(() => window.__wm.PersonBlur._editors[1].boxes[0]);
  ok(box0 && box0.width > 0 && box0.height > 0, "A 스텁 감지 결과로 박스 1개 이상 생성", box0);

  /* ── B. applyBoxBlur 실 캔버스(실 디코딩된 JPEG) 픽셀 검증 — 박스 안 변화, 박스 밖 불변 ── */
  const pixelCheck = await page.evaluate((b) => {
    const ed = window.__wm.PersonBlur._editors[1];
    const PB = window.__wm.PersonBlur;
    const W = ed.canvas.width, H = ed.canvas.height;
    const copy = document.createElement("canvas"); copy.width = W; copy.height = H;
    copy.getContext("2d").drawImage(ed.canvas, 0, 0);
    PB.applyBlur(copy, [b], {});
    const origCtx = ed.canvas.getContext("2d"), newCtx = copy.getContext("2d");
    const cx = Math.min(W - 1, b.x + Math.floor(b.width / 2)), cy = Math.min(H - 1, b.y + Math.floor(b.height / 2));
    const inOrig = origCtx.getImageData(cx, cy, 1, 1).data, inNew = newCtx.getImageData(cx, cy, 1, 1).data;
    // 박스 밖 — 박스에서 충분히 떨어진 좌상단 모서리(박스가 보통 왼쪽 위 근처라 우하단 모서리로 비교)
    const ox = W - 2, oy = H - 2;
    const outOrig = origCtx.getImageData(ox, oy, 1, 1).data, outNew = newCtx.getImageData(ox, oy, 1, 1).data;
    return { inOrig: Array.from(inOrig), inNew: Array.from(inNew), outOrig: Array.from(outOrig), outNew: Array.from(outNew) };
  }, box0);
  const inChanged = pixelCheck.inOrig.join() !== pixelCheck.inNew.join();
  const outSame = pixelCheck.outOrig.join() === pixelCheck.outNew.join();
  ok(inChanged, "B 박스 내부 픽셀이 원본과 다름(블러 적용됨)", pixelCheck);
  ok(outSame, "B 박스 밖(모서리) 픽셀은 원본과 동일", pixelCheck);

  /* ── C. [적용] → 원본 보존(blurOrigUrl) + pin.imageId 교체(처리본 기본표시) ── */
  const beforeImageId = await page.evaluate(() => window.__wm.State.pins.find((p) => p.id === 1).imageId);
  await page.evaluate(() => document.getElementById("pbl-apply").click());
  await page.waitForFunction(() => { const p = window.__wm.State.pins.find((p) => p.id === 1); return !!p.blurOrigUrl && p.imageId && p.imageId !== "img0"; }, { timeout: 8000 });
  const pinAfter = await page.evaluate(() => window.__wm.State.pins.find((p) => p.id === 1));
  ok(pinAfter.imageId !== beforeImageId, "C [적용] → pin.imageId 가 처리본으로 교체됨", { beforeImageId, after: pinAfter.imageId });
  ok(!!pinAfter.blurOrigUrl && /^\/api\/r2\/object\//.test(pinAfter.blurOrigUrl), "C 블러 전 원본이 R2 로 보관(blurOrigUrl)", pinAfter.blurOrigUrl);
  ok(pinAfter.blurOrigImageId === "img0", "C 블러 전 원본의 imageId 도 함께 보관(blurOrigImageId)", pinAfter.blurOrigImageId);
  const modalGone = await page.evaluate(() => !document.getElementById("pbl-modal"));
  ok(modalGone, "C 적용 완료 후 모달 닫힘");

  /* ── D. [원본으로 되돌리기] ── */
  await page.waitForSelector("#pap-personblur-revert", { timeout: 8000 });
  await page.evaluate(() => document.getElementById("pap-personblur-revert").click());
  await page.waitForFunction(() => { const p = window.__wm.State.pins.find((p) => p.id === 1); return p.imageId === "img0" && !p.blurOrigUrl; }, { timeout: 5000 });
  ok(true, "D [원본으로 되돌리기] → pin.imageId 가 블러 전 원본(img0)으로 복원, blurOrigUrl 비움");
  const r2StillThere = await page.evaluate(async (url) => { const r = await fetch(url); return r.ok; }, pinAfter.blurOrigUrl);
  ok(r2StillThere, "D 되돌린 뒤에도 원본 R2 객체는 삭제되지 않음(/api/r2/object/* 여전히 200)");

  /* ── E. 열람자(canEdit:false) — 버튼 0 ── */
  await page.evaluate(() => { document.getElementById("pbl-scratch") && document.getElementById("pbl-scratch").remove(); const d = document.createElement("div"); d.id = "pbl-scratch"; document.body.appendChild(d); });
  await page.evaluate(() => window.__wm.PersonBlur.mount("pbl-scratch", window.__wm.State.pins.find((p) => p.id === 1), { theme: "light", canEdit: false }));
  const viewerHtml = await page.evaluate(() => document.getElementById("pbl-scratch").innerHTML.trim());
  ok(viewerHtml === "", "E 열람자(canEdit:false) → 호스트 비어있음(버튼 0)", viewerHtml);
  await page.evaluate(() => { window.__wm.PersonBlur.unmount("pbl-scratch"); document.getElementById("pbl-scratch").remove(); });

  /* ── F. 오프라인 → 비활성 + 사유 ── */
  const offState = await page.evaluate(() => window.__wm.PersonBlur.buttonState({ canEdit: true, online: false, pin: { imageId: "img0" } }));
  ok(offState.disabled === true && /온라인/.test(offState.reason), "F 오프라인 → 비활성 + 사유 표시", offState);

  ok(errs.length === 0, "G 페이지 런타임 오류 0건", errs);
} catch (e) {
  console.log("FAIL 예외: " + (e && e.stack || e));
  failed++;
} finally {
  await browser.close();
  server.close();
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
