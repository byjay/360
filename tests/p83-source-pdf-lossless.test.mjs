/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p83-source-pdf-lossless.test.mjs)
 *
 * 대상: 마스터 원문(2026-09-29) "벡터 방식으로 확대하더라도 절대 화질 안 깨지게 해".
 *   prod dep_muksj6py_jybyrh2n = drawing_data JPEG 2000×667 base64 + source_meta null (원본 PDF 무음 폐기).
 *   prod 29건 중 base64 도면 16건 전부 source_meta null, R2 URL 도면만 원본 보유(지휘자·coder 실측).
 *
 * 실 Chrome(puppeteer) + 실제 public/js/modules 전체 번들 + 실제 index.html/CSS.
 * API 는 로컬 목 서버(배포본·구역·R2 를 메모리에 저장 — 저장된 값을 그대로 검사한다).
 * 도면 = prod R2 의 실제 GA PDF(.tmp/ga.pdf, 7143×2384pt, 2,096,687B). 없으면 FAIL(증거 없는 PASS 금지).
 *
 *  S1 도면 등록 → 저장: source_meta 존재 + R2 원본 바이트 = 업로드 파일 바이트
 *  S2 등록 → (저장 안 함) → 새로고침 → 로컬 복원 → 자동/수동 저장: 원본이 살아 있고 스냅샷 재압축 없음
 *  S3 원본 업로드 실패 주입(R2 PDF PUT 500): 저장 중단 + 명시 오류 + 재시도로 복구
 *  S4 이미지 도면(PNG/JPG): 업로드 바이트 무손실(재압축 금지)
 *  S5 원본 보유 배포본 확대 100%/400%/1600%: 화면 픽셀×DPR 이상의 실제 캔버스 해상도
 *  S6 원본 없는 배포본 → [원본 PDF 연결] → PATCH source_meta + 즉시 선명
 *  S7 창 방식 구역(crop) 안에서 1600%: 보이는 부분만 고해상도(한 변 상한에 막히지 않음)
 * 뮤테이션 — 번들을 메모리에서만 되돌려 각 검사가 실패함을 증명(파일 미변경).
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "public");
const GA = path.join(ROOT, ".tmp", "ga.pdf");
const SHOTS = path.join(ROOT, ".tmp", "fix6");
const PDFJS = path.join(ROOT, "node_modules", "pdfjs-dist", "build", "pdf.min.js");
const ONLY = (process.env.P83_ONLY || "").split(",").filter(Boolean);
let SHOOT = process.env.P83_SHOTS === "1";   // 뮤테이션 실행 중엔 끈다(정상 번들 증거 스크린샷을 덮어쓰지 않게)

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex").slice(0, 16);

const MODS = fs.readFileSync(path.join(PUB, "js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
function buildBundle(mutate = (f, s) => s) {
  const b = MODS.map((f) => mutate(f, fs.readFileSync(path.join(PUB, "js/modules", f), "utf8").replace(/\r\n/g, "\n"))).join("\n");
  const cut = b.lastIndexOf("})();");
  return b.slice(0, cut) + "\nwindow.__T = { MapCtrl, App, Projects, State, PDF, Prompt, SyncQueue };\n" + b.slice(cut);
}
const CT = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webmanifest": "application/json", ".pdf": "application/pdf" };

/** 목 서버 — 저장소(db)를 테스트가 직접 들여다본다. */
async function serve(bundle, seed) {
  const db = {
    deps: {}, decks: JSON.parse(JSON.stringify(seed.decks || [])), r2: {}, posts: [], patches: [], puts: [],
    flags: { failPdf: false }, n: 0,
  };
  for (const d of seed.deps || []) db.deps[d.id] = Object.assign({ version: 1, pins: "[]", zones: "[]", annotations: "[]" }, d);
  for (const [k, v] of Object.entries(seed.r2 || {})) db.r2[k] = v;
  const json = (res, o, st = 200) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  const body = (req) => new Promise((r) => { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => r(Buffer.concat(c))); });
  const server = http.createServer(async (req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    if (u === "/sw.js") { res.writeHead(404); res.end(); return; }   // SW 캐시 측정 오염 차단(§G-4④)
    if (u === "/js/main.js") { res.writeHead(200, { "content-type": "application/javascript" }); res.end(bundle); return; }
    if (u === "/__fx/ga.pdf") { res.writeHead(200, { "content-type": "application/pdf" }); res.end(fs.readFileSync(GA)); return; }
    if (u === "/__fx/logo.png") { res.writeHead(200, { "content-type": "image/png" }); res.end(fs.readFileSync(path.join(PUB, "images/logo.png"))); return; }
    if (u === "/api/auth/auto-entry") return json(res, { token: "tokT", kind: "designer" });
    if (u === "/api/auth/me") return json(res, { authenticated: true, email: "auto@test.local", name: "auto", role: "designer", auto: true });
    if (u === "/api/auth/config") return json(res, { google_client_id: "", demo_login: false });
    if (u === "/api/tenant/resolve") return json(res, { matched: false });
    if (u === "/api/projects") return json(res, { data: [{ id: "prjT", name: "tes", created_at: 1, published: false }] });
    if (u === "/api/projects/prjT/decks" && req.method === "GET") return json(res, { data: db.decks });
    if (u === "/api/projects/prjT/decks" && req.method === "POST") {
      const b = JSON.parse((await body(req)).toString() || "{}");
      const d = Object.assign({ id: "dk" + (++db.n), project_id: "prjT", deleted: 0 }, b);
      db.decks.push(d); return json(res, d);
    }
    let m = u.match(/^\/api\/decks\/(.+)$/);
    if (m && req.method === "PUT") {
      const b = JSON.parse((await body(req)).toString() || "{}");
      const d = db.decks.find((x) => x.id === m[1]); if (d) Object.assign(d, b);
      return json(res, d || {});
    }
    if (u === "/api/r2/upload" && req.method === "PUT") {
      const ct = req.headers["content-type"] || "";
      const buf = await body(req);
      db.puts.push({ ct, size: buf.length });
      if (db.flags.failPdf && /pdf/.test(ct)) return json(res, { error: "injected" }, 500);
      const ext = /png/.test(ct) ? "png" : /jpe?g/.test(ct) ? "jpg" : /pdf/.test(ct) ? "pdf" : "bin";
      const key = "assets/t" + (++db.n) + "." + ext;
      db.r2[key] = { ct, buf };
      return json(res, { key, url: "/api/r2/object/" + key, size: buf.length, contentType: ct });
    }
    m = u.match(/^\/api\/r2\/object\/(.+)$/);
    if (m && req.method === "GET") {
      const o = db.r2[m[1]]; if (!o) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": o.ct, "content-length": o.buf.length }); res.end(o.buf); return;
    }
    if (u === "/tables/deployments" && req.method === "POST") {
      const b = JSON.parse((await body(req)).toString() || "{}");
      const id = "dep" + (++db.n);
      db.deps[id] = Object.assign({ id, version: 1 }, b); db.posts.push(b);
      return json(res, db.deps[id]);
    }
    m = u.match(/^\/tables\/deployments\/(.+)$/);
    if (m && req.method === "GET") { const d = db.deps[m[1]]; return d ? json(res, d) : json(res, { error: "nf" }, 404); }
    if (m && req.method === "PATCH") {
      const b = JSON.parse((await body(req)).toString() || "{}");
      db.patches.push(Object.assign({ id: m[1] }, b));
      const d = db.deps[m[1]]; if (!d) return json(res, { error: "nf" }, 404);
      delete b.base_version; Object.assign(d, b); d.version = (d.version || 1) + 1;
      return json(res, d);
    }
    if (u === "/tables/deployments" && req.method === "GET") return json(res, { data: Object.values(db.deps) });
    if (u.startsWith("/api/") || u.startsWith("/tables/")) return json(res, { data: [], settings: {}, value: {} });
    const f = path.join(PUB, u === "/" ? "index.html" : u);
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "content-type": CT[path.extname(f)] || "application/octet-stream" }); res.end(fs.readFileSync(f));
  });
  await listenSafePort(server, "127.0.0.1");
  server.db = db;
  return server;
}

let puppeteer = null;
try { puppeteer = createRequire("file:///C:/Users/FREE/package.json")("puppeteer"); } catch (e) { puppeteer = null; }
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
let browser = null;
if (puppeteer) {
  browser = await puppeteer.launch({ headless: "new", ...(fs.existsSync(CHROME) ? { executablePath: CHROME } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 240000 });
}

/** 새 격리 컨텍스트(IndexedDB 분리) + 앱 진입(디자이너, 프로젝트 prjT). */
async function open(server, ctx, opts = {}) {
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: opts.dpr || 1 });
  await page.setRequestInterception(true);
  page.on("request", (r) => {
    const url = r.url();
    // CDN pdf.js 를 같은 버전(3.11.174) 로컬 사본으로 — 네트워크 의존 0
    if (/cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js\/3\.11\.174\/pdf\.min\.js/.test(url)) return r.respond({ status: 200, contentType: "application/javascript", body: fs.readFileSync(PDFJS) });
    if (/^https?:\/\/(?!127\.0\.0\.1)/.test(url)) return r.respond({ status: 200, contentType: "application/javascript", body: "" });
    return r.continue();
  });
  // [WO 20261001-invite ④] 공용석 종료 — 로그인한 디자이너로 진입(세션 토큰 보유 → 목 /api/auth/me 인증). 없으면 로그인 게이트가 덮는다.
  await page.evaluateOnNewDocument(() => { try { sessionStorage.setItem("wm_id_token", "tokT"); } catch (e) {} });
  await page.goto("http://127.0.0.1:" + server.address().port + "/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__T && window.pdfjsLib, { timeout: 20000 });
  await page.evaluate(() => {
    window.__toasts = [];
    const P = window.__T.Prompt; const o = P.toast;
    P.toast = function (m) { window.__toasts.push(String(m)); try { return o.apply(P, arguments); } catch (e) {} };
  });
  return page;
}
async function enterProject(page, deckId) {
  await page.evaluate(async (deckId) => {
    const { App, Projects } = window.__T;
    const p = { id: "prjT", name: "tes" };
    Projects.currentProject = p;
    App.openApp("designer", { project: p });
    for (let i = 0; i < 60 && !(Projects.decks && Projects.decks.length); i++) await new Promise((r) => setTimeout(r, 100));
    if (deckId) Projects.currentDeck = (Projects.decks || []).find((d) => d.id === deckId) || null;
  }, deckId || null);
  await sleep(800);
}
async function loadFile(page, url, name, type) {
  await page.evaluate(async (url, name, type) => {
    const ab = await (await fetch(url)).arrayBuffer();
    await window.__T.App._loadDrawing(new File([ab], name, { type }));
  }, url, name, type);
  await page.waitForFunction(() => { const s = window.__T.State; return s.fileType === "image" || (s.pdfDoc && !document.getElementById("pdf-canvas").classList.contains("hidden")); }, { timeout: 30000 });
  await sleep(1500);   // _afterDrawingLoaded(스냅샷 → 로컬 draft) 완료 대기
}
const imgDims = (page, dataUrl) => page.evaluate((u) => new Promise((r) => { const i = new Image(); i.onload = () => r({ w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => r(null); i.src = u; }), dataUrl);
/** 저장된 첫 페이지(dataURL 또는 R2 URL) → { kind, mime, bytes } */
function pageBytes(db, p) {
  if (typeof p !== "string") return null;
  const r = p.match(/^\/api\/r2\/object\/(.+)$/);
  if (r) { const o = db.r2[r[1]]; return o ? { kind: "r2", mime: o.ct, bytes: o.buf } : null; }
  const d = p.match(/^data:([^;,]+);base64,(.*)$/);
  if (d) return { kind: "base64", mime: d[1], bytes: Buffer.from(d[2], "base64") };
  return null;
}
function srcOf(dep) { try { return JSON.parse(dep.source_meta || "null"); } catch (e) { return null; } }

const DECK_A = { id: "dkA", project_id: "prjT", name: "구역A", parent_id: null, deployment_id: null, crop: null, page: 1, deleted: 0 };
const gaBytes = fs.existsSync(GA) ? fs.readFileSync(GA) : null;

/* ══════════════════════════ 시나리오 ══════════════════════════ */
const R = {};
async function scenario(name, fn) {
  if (ONLY.length && !ONLY.includes(name)) return;
  const ctx = await browser.createBrowserContext();
  try { await fn(ctx); } catch (e) { ok(false, name + " 예외: " + (e && e.message || e).toString().slice(0, 200)); }
  finally { await ctx.close(); }
}

async function S1(bundle) {
  await scenario("S1", async (ctx) => {
    const sv = await serve(bundle, { decks: [DECK_A] });
    try {
      const page = await open(sv, ctx);
      await enterProject(page, "dkA");
      await loadFile(page, "/__fx/ga.pdf", "ga.pdf", "application/pdf");
      const saved = await page.evaluate(() => window.__T.App._saveNow());
      const dep = Object.values(sv.db.deps)[0];
      const meta = dep && srcOf(dep);
      const src = meta && pageBytes(sv.db, meta.pdf_url);
      ok(saved === true && !!dep, `S1 저장 성공 · 배포본 생성 (saved=${saved}, deps=${Object.keys(sv.db.deps).length})`);
      ok(!!(src && src.bytes.length === gaBytes.length && sha(src.bytes) === sha(gaBytes)),
        `S1 source_meta 존재 + R2 원본 = 업로드 파일(${src ? src.bytes.length : 0}B / ${gaBytes.length}B)`);
      const pg = dep && pageBytes(sv.db, JSON.parse(dep.pages_data || "[]")[0]);
      const dim = pg && await imgDims(page, "data:" + pg.mime + ";base64," + pg.bytes.toString("base64"));
      R.S1 = { dim, kind: pg && pg.kind, mime: pg && pg.mime, size: pg && pg.bytes.length, pages: meta && meta.pages };
      ok(!!(dim && dim.w >= 4096), `S1 스냅샷 해상도 ${dim && dim.w}×${dim && dim.h} (${pg && pg.kind}, ${pg && pg.mime}, ${pg && pg.bytes.length}B)`);
      await page.close();
      // 편집모드(원본 PDF 전면 캔버스) 확대 — DPR2
      const p2 = await open(sv, ctx, { dpr: 2 });
      await enterProject(p2, "dkA");
      await loadFile(p2, "/__fx/ga.pdf", "ga.pdf", "application/pdf");
      const z = R.S1.edit = await zoomSeries(p2, "s1-edit");
      ok(z.every((m) => m.density >= 0.99), `S1 편집모드(원본 PDF) 확대 밀도 ≥1 (DPR2) :: ${fmtZ(z)}`);
      await p2.close();
    } finally { sv.close(); }
  });
}

async function S2(bundle) {
  await scenario("S2", async (ctx) => {
    const sv = await serve(bundle, { decks: [DECK_A] });
    try {
      let page = await open(sv, ctx);
      await enterProject(page, "dkA");
      await loadFile(page, "/__fx/ga.pdf", "ga.pdf", "application/pdf");
      await page.close();                                  // 저장 버튼을 누르지 않고 떠난다(자동저장 OFF 정책)
      page = await open(sv, ctx);                          // 재진입 → _restoreProjectDraft → 로컬 draft 복원
      await enterProject(page, null);
      await sleep(2500);                                   // 복원 직후 자동 업로드(_flushDirtyDrafts 400ms) 여유
      let saved = null;
      if (!Object.keys(sv.db.deps).length) saved = await page.evaluate(() => window.__T.App._saveNow());
      // prod version=1 재현: 복원 후 편집(_autoSave → draft 재스냅샷) → 다음 자동 업로드(PATCH)가 도면을 덮는다
      await page.evaluate(async () => { const { App } = window.__T; App._autoSave(); await new Promise((r) => setTimeout(r, 1500)); await App._flushDirtyDrafts(); });
      await sleep(500);
      const st = await page.evaluate(() => ({ ft: window.__T.State.fileType, hasData: !!window.__T.State.fileData }));
      const dep = Object.values(sv.db.deps)[0];
      const meta = dep && srcOf(dep);
      const src = meta && pageBytes(sv.db, meta.pdf_url);
      const pg = dep && pageBytes(sv.db, JSON.parse(dep.pages_data || "[]")[0]);
      const dim = pg && await imgDims(page, "data:" + pg.mime + ";base64," + pg.bytes.toString("base64"));
      R.S2 = { dim, kind: pg && pg.kind, size: pg && pg.bytes.length, st, saved, posts: sv.db.posts.length, patches: sv.db.patches.length };
      ok(!!dep, `S2 복원 후 배포본 생성됨 (posts=${sv.db.posts.length}, 수동저장=${saved}, 복원 fileType=${st.ft}, fileData=${st.hasData})`);
      ok(!!(src && src.bytes.length === gaBytes.length), `S2 복원 경로도 원본 PDF 보관 (source=${meta ? "있음" : "null"}, ${src ? src.bytes.length : 0}B)`);
      ok(!!(dim && dim.w >= 4096), `S2 복원 후 편집·자동업로드(PATCH ${sv.db.patches.length}회)에도 스냅샷 재압축 없음 ${dim && dim.w}×${dim && dim.h} (${pg && pg.kind}, ${pg && pg.mime})`);
      const sent = sv.db.posts.concat(sv.db.patches).filter((b) => b.drawing_data);
      ok(sent.length > 0 && sent.every((b) => b.source_meta), `S2 도면을 실은 전송 ${sent.length}건 전부 source_meta 동반`);
      await page.close();
    } finally { sv.close(); }
  });
}

async function S3(bundle) {
  await scenario("S3", async (ctx) => {
    const sv = await serve(bundle, { decks: [DECK_A] });
    try {
      const page = await open(sv, ctx);
      await enterProject(page, "dkA");
      await loadFile(page, "/__fx/ga.pdf", "ga.pdf", "application/pdf");
      sv.db.flags.failPdf = true;
      const saved = await page.evaluate(() => window.__T.App._saveNow());
      const toasts = await page.evaluate(() => window.__toasts.slice());
      const banner = await page.evaluate(() => { const e = document.getElementById("src-keep-fail"); return e ? { text: e.textContent, vis: !!(e.offsetWidth || e.offsetHeight) } : null; });
      ok(saved === false && Object.keys(sv.db.deps).length === 0, `S3 원본 업로드 실패 → 저장 중단(무음 진행 없음) saved=${saved} deps=${Object.keys(sv.db.deps).length}`);
      ok(toasts.some((t) => /원본 PDF/.test(t) && /실패/.test(t)) || !!(banner && /원본 PDF/.test(banner.text)),
        `S3 명시 오류 표시: ${JSON.stringify(banner ? banner.text : toasts.slice(-1))}`.slice(0, 220));
      if (SHOOT) await page.screenshot({ path: path.join(SHOTS, "s3-source-fail.png") });
      sv.db.flags.failPdf = false;
      // 재시도 경로 = 배너의 [재시도] 버튼(없으면 저장 재실행)
      const retried = await page.evaluate(async () => {
        const b = document.querySelector("#src-keep-fail button[data-act='retry']");
        if (b) { b.click(); for (let i = 0; i < 100 && !window.__T.State.autoSaveDepId; i++) await new Promise((r) => setTimeout(r, 100)); return "button"; }
        return (await window.__T.App._saveNow()) ? "save" : "fail";
      });
      await sleep(500);
      const dep = Object.values(sv.db.deps)[0];
      const meta = dep && srcOf(dep);
      ok(!!(meta && pageBytes(sv.db, meta.pdf_url)), `S3 재시도(${retried}) → 원본 포함 저장 복구 (deps=${Object.keys(sv.db.deps).length})`);
      await page.close();
    } finally { sv.close(); }
  });
}

async function S4(bundle) {
  await scenario("S4", async (ctx) => {
    const sv = await serve(bundle, { decks: [DECK_A] });
    try {
      const page = await open(sv, ctx);
      await enterProject(page, "dkA");
      await loadFile(page, "/__fx/logo.png", "logo.png", "image/png");
      const saved = await page.evaluate(() => window.__T.App._saveNow());
      const dep = Object.values(sv.db.deps)[0];
      const pg = dep && pageBytes(sv.db, JSON.parse(dep.pages_data || "[]")[0]);
      const orig = fs.readFileSync(path.join(PUB, "images/logo.png"));
      R.S4 = { size: pg && pg.bytes.length, orig: orig.length, mime: pg && pg.mime };
      ok(saved === true && !!(pg && sha(pg.bytes) === sha(orig)), `S4 이미지 도면 무손실 보관 (저장 ${pg ? pg.bytes.length : 0}B ${pg && pg.mime} / 원본 ${orig.length}B)`);
      await page.close();
    } finally { sv.close(); }
  });
}

/* 확대 측정 — 화면 가운데 지점(도면 비율 fx,fy)을 줌 z 로 맞추고, 그 지점을 덮는 캔버스의 실제 픽셀 밀도를 잰다.
   density = 캔버스 내부 픽셀 / (화면 CSS 픽셀 × DPR). ≥ 1 이면 화면 픽셀 하나에 캔버스 픽셀이 1개 이상 = 깨짐 없음. */
async function zoomMeasure(page, z, fx, fy, shot) {
  await page.evaluate((z, fx, fy) => {
    const { MapCtrl, State } = window.__T;
    const vw = MapCtrl.viewport.clientWidth, vh = MapCtrl.viewport.clientHeight;
    const cw = MapCtrl.transform.offsetWidth, ch = MapCtrl.transform.offsetHeight;
    State.zoom = z; State.pan = { x: vw / 2 - z * fx * cw, y: vh / 2 - z * fy * ch };
    MapCtrl.applyTransform();
  }, z, fx, fy);
  // 원본 지연 로드(다운로드·파싱) + 디바운스 렌더 대기 — 캔버스가 목표에 수렴할 때까지
  let m = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    m = await page.evaluate(() => {
      const { MapCtrl, State } = window.__T;
      const vp = MapCtrl.viewport.getBoundingClientRect();
      const cx = vp.left + vp.width / 2, cy = vp.top + vp.height / 2;
      const dpr = window.devicePixelRatio || 1;
      const cands = ["pdf-canvas-hi", "pdf-canvas", "map-image"].map((id) => document.getElementById(id))
        .filter((e) => e && !e.classList.contains("hidden") && e.getBoundingClientRect().width > 0);
      for (const e of cands) {
        const r = e.getBoundingClientRect();
        if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue;
        const iw = e.width || e.naturalWidth;
        // 그려졌는가(크기만 키우고 비어 있는 캔버스 = 가짜 PASS 방지): 화면 중앙에 해당하는 캔버스 부분의 잉크(어두운 픽셀) 수
        let ink = -1;
        if (e.tagName === "CANVAS") {
          try {
            // 뷰포트에 실제로 보이는 캔버스 부분 전체(1600% 에서는 화면 중앙 한 점이 여백일 수 있다)
            const k = e.width / r.width;
            const sx = Math.max(0, Math.round((vp.left - r.left) * k)), sy = Math.max(0, Math.round((vp.top - r.top) * k));
            const ex = Math.min(e.width, Math.round((vp.right - r.left) * k)), ey = Math.min(e.height, Math.round((vp.bottom - r.top) * k));
            const d = e.getContext("2d").getImageData(sx, sy, Math.max(1, ex - sx), Math.max(1, ey - sy)).data;
            ink = 0; for (let i = 0; i < d.length; i += 16) if (d[i] + d[i + 1] + d[i + 2] < 300) ink++;
          } catch (err) { ink = -2; }
        }
        return { el: e.id, density: iw / (r.width * dpr), zoom: State.zoom, busy: !!(window.__T.App._srcBusy), innerW: iw, screenW: Math.round(r.width), ink };
      }
      return { el: null, density: 0, zoom: State.zoom };
    });
    if (m.density >= 1 && !m.busy && m.ink !== 0) break;
  }
  if (m.ink === 0) m.density = 0;   // 빈 캔버스는 선명한 게 아니다
  if (!(m.density >= 0.99)) {   // 실패 진단(원본 로드 여부·렌더 상태·마지막 토스트)
    m.diag = await page.evaluate(() => {
      const { State, PDF } = window.__T; const st = PDF._renderState;
      return { src: !!State.srcPdfDoc, url: State.sourcePdfUrl, failed: State.srcFailed, ov: st.overlayOnly, rs: st.renderScale && +st.renderScale.toFixed(3),
        cs: st.cropScale && +st.cropScale.toFixed(3), base: st.baseCssScale && +st.baseCssScale.toFixed(3), toast: (window.__toasts || []).slice(-2) };
    });
    console.log("    diag z=" + z + " " + JSON.stringify(m.diag));
  }
  if (SHOOT && shot) await page.screenshot({ path: path.join(SHOTS, shot), clip: { x: 440, y: 250, width: 400, height: 300 } });
  return m;
}
const FX = 0.42, FY = 0.55;   // GA 도면 안쪽(글자·선 밀집) 한 지점
async function zoomSeries(page, tag, zs = [1, 4, 16]) {
  const out = [];
  for (const z of zs) out.push(Object.assign({ z }, await zoomMeasure(page, z, FX, FY, tag + "-" + Math.round(z * 100) + ".png")));
  return out;
}
const fmtZ = (a) => a.map((m) => `${m.z * 100}%:${m.el}=${m.density ? m.density.toFixed(2) : 0}(${m.innerW}px/${m.screenW}css,ink ${m.ink})`).join(" ");

async function S5(bundle) {
  await scenario("S5", async (ctx) => {
    // 원본 보유 배포본(GA 스냅샷 4096px + R2 원본) 을 구역 열람 경로로 연다(loadDeckDrawing = 뷰어와 같은 스냅샷+오버레이)
    const snap = SNAP.s4096;
    const sv = await serve(bundle, {
      decks: [Object.assign({}, DECK_A, { deployment_id: "depS" })],
      deps: [{ id: "depS", title: "ga.pdf", file_name: "ga.pdf", pages_data: JSON.stringify(["/api/r2/object/assets/snap.jpg"]),
        source_meta: JSON.stringify({ v: 1, pdf_url: "/api/r2/object/assets/src.pdf", pages: [] }) }],
      r2: { "assets/src.pdf": { ct: "application/pdf", buf: gaBytes }, "assets/snap.jpg": { ct: "image/jpeg", buf: snap } },
    });
    try {
      const page = await open(sv, ctx, { dpr: 2 });
      await enterProject(page, "dkA");
      await page.evaluate(() => window.__T.App.loadDeckDrawing("depS"));
      await sleep(1500);
      const a = R.S5 = await zoomSeries(page, "s5-source");
      ok(a.every((m) => m.density >= 0.99), `S5 원본 보유 확대 — 전 배율 캔버스 밀도 ≥1 (DPR2) :: ${fmtZ(a)}`);
      await page.close();
    } finally { sv.close(); }
  });
}

async function S6(bundle) {
  await scenario("S6", async (ctx) => {
    const snap = SNAP.s2000;   // prod dep_muksj6py 와 같은 조건: 2000×667 JPEG 0.8 스냅샷 + 원본 없음
    const sv = await serve(bundle, {
      decks: [Object.assign({}, DECK_A, { deployment_id: "depN" })],
      deps: [{ id: "depN", title: "ga.pdf", file_name: "ga.pdf", pages_data: JSON.stringify(["/api/r2/object/assets/snapN.jpg"]), source_meta: null }],
      r2: { "assets/snapN.jpg": { ct: "image/jpeg", buf: snap } },
    });
    try {
      const page = await open(sv, ctx, { dpr: 2 });
      await enterProject(page, "dkA");
      await page.evaluate(() => window.__T.App.loadDeckDrawing("depN"));
      await sleep(1500);
      const before = await zoomSeries(page, "s6-before", [16]);
      const btn = await page.evaluate(() => { const b = document.querySelector("#src-link-bar button[data-act='link']"); return b ? { text: document.getElementById("src-link-bar").textContent, vis: !!(b.offsetWidth && b.offsetHeight) } : null; });
      ok(!!(btn && btn.vis && /원본 PDF 연결/.test(btn.text)), `S6 원본 없는 배포본 → [원본 PDF 연결] 버튼 표시: ${btn ? JSON.stringify(btn.text).slice(0, 80) : "없음"}`);
      if (btn) {
        if (SHOOT) await page.screenshot({ path: path.join(SHOTS, "s6-link-bar.png") });
        const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 8000 }), page.click("#src-link-bar button[data-act='link']")]);
        await chooser.accept([GA]);
        for (let i = 0; i < 60 && !sv.db.patches.some((p) => p.source_meta); i++) await sleep(250);
        // 같은 도면(GA 3:1 · 1쪽)이면 확인창 없이 바로 연결돼야 한다 — 확인창이 떴다면 검사 오판
        const warned = await page.evaluate(() => { const m = document.getElementById("wm-confirm-modal"); return !!(m && !m.classList.contains("hidden")); });
        ok(!warned, "S6 같은 도면 → 불일치 경고 없음");
      }
      const patch = sv.db.patches.find((p) => p.source_meta);
      const meta = patch && JSON.parse(patch.source_meta);
      ok(!!(meta && pageBytes(sv.db, meta.pdf_url) && pageBytes(sv.db, meta.pdf_url).bytes.length === gaBytes.length)
        && patch && patch.pins === undefined && patch.zones === undefined,
        `S6 PATCH = source_meta 한 칸만(핀·구역 미전송) + R2 원본 ${meta ? pageBytes(sv.db, meta.pdf_url).bytes.length : 0}B`);
      const after = await zoomSeries(page, "s6-after", [16]);
      R.S6 = { before, after };
      ok(after[0].density >= 0.99 && before[0].density < 0.99, `S6 연결 전후 1600% 밀도 ${before[0].density.toFixed(2)} → ${after[0].density.toFixed(2)}`);
      const gone = await page.evaluate(() => !document.getElementById("src-link-bar"));
      ok(gone, "S6 연결 후 버튼 사라짐");
      await page.close();
    } finally { sv.close(); }
  });
}

async function S7(bundle) {
  await scenario("S7", async (ctx) => {
    const snap = SNAP.s4096;
    const CROP = { x: 10, y: 10, w: 60, h: 80 };   // 넓은 창 방식 구역 — 크롭 전체를 그리면 한 변 상한(8192)에 막힌다
    const sv = await serve(bundle, {
      decks: [Object.assign({}, DECK_A, { deployment_id: "depC", crop: CROP })],
      deps: [{ id: "depC", title: "ga.pdf", file_name: "ga.pdf", pages_data: JSON.stringify(["/api/r2/object/assets/snapC.jpg"]),
        source_meta: JSON.stringify({ v: 1, pdf_url: "/api/r2/object/assets/srcC.pdf", pages: [] }) }],
      r2: { "assets/srcC.pdf": { ct: "application/pdf", buf: gaBytes }, "assets/snapC.jpg": { ct: "image/jpeg", buf: snap } },
    });
    try {
      const page = await open(sv, ctx, { dpr: 2 });
      await enterProject(page, "dkA");
      await page.evaluate(async () => { const { Projects } = window.__T; await Projects.selectDeck(Projects.decks[0]); });
      await sleep(2500);
      const a = R.S7 = [Object.assign({ z: 16 }, await zoomMeasure(page, 16, 0.4, 0.5, "s7-crop-1600.png"))];
      ok(a[0].density >= 0.99, `S7 창 방식 구역 1600% 밀도 ≥1 :: ${fmtZ(a)}`);
      await page.close();
    } finally { sv.close(); }
  });
}

/** GA 스냅샷 픽스처 — 앱의 실제 스냅샷 함수(PDF.snapshotAllPages)로 4096px, prod 와 같은 2000px JPEG 0.8 도 만든다. */
const SNAP = {};
async function makeSnaps() {
  const ctx = await browser.createBrowserContext();
  const sv = await serve(buildBundle(), { decks: [] });
  try {
    const page = await open(sv, ctx);
    const r = await page.evaluate(async () => {
      const { PDF } = window.__T;
      const doc = await PDF.load(await (await fetch("/__fx/ga.pdf")).arrayBuffer());
      const [s4096] = await PDF.snapshotAllPages(doc);
      const img = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = s4096; });
      const cv = document.createElement("canvas"); const k = 2000 / Math.max(img.naturalWidth, img.naturalHeight);
      cv.width = Math.round(img.naturalWidth * k); cv.height = Math.round(img.naturalHeight * k);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      return { s4096, s2000: cv.toDataURL("image/jpeg", 0.8) };
    });
    for (const k of ["s4096", "s2000"]) SNAP[k] = Buffer.from(r[k].split(",")[1], "base64");
  } finally { sv.close(); await ctx.close(); }
}

async function all(label, bundle, which = ["S1", "S2", "S3", "S4", "S5", "S6", "S7"]) {
  console.log("\n[" + label + "]");
  const F = { S1, S2, S3, S4, S5, S6, S7 };
  for (const k of which) await F[k](bundle);
}

console.log("=== 회귀: 원본 PDF 보관·무손실·확대 재렌더 — 실 Chrome ===");
if (!browser) { console.log("  FAIL puppeteer 를 로드할 수 없다 — 실 브라우저 검증 불가"); failed++; }
else if (!gaBytes) { console.log("  FAIL .tmp/ga.pdf 없음 — prod R2 에서 받을 것(발주서 테스트 자료)"); failed++; }
else {
  if (SHOOT) fs.mkdirSync(SHOTS, { recursive: true });
  await makeSnaps();
  await all("A. 정상 번들", buildBundle());
  if (process.env.P83_JSON) fs.writeFileSync(process.env.P83_JSON, JSON.stringify(R, null, 1));
}

/* ══════════════════════════ 뮤테이션(메모리에서만) ══════════════════════════ */
async function mutate(label, file, needle, repl, which) {
  const src = fs.readFileSync(path.join(PUB, "js/modules", file), "utf8").replace(/\r\n/g, "\n");
  const hit = src.includes(needle);
  ok(hit, label + " — 대상 존재");
  if (!hit) return;
  const before = failed;
  SHOOT = false;
  const logs = []; const orig = console.log; console.log = (...a) => logs.push(a.join(" "));
  try { await all(label, buildBundle((f, s) => (f === file ? s.replace(needle, repl) : s)), which); } catch (e) { failed++; logs.push("  FAIL(throw) " + e.message); }
  console.log = orig;
  const caught = failed > before; failed = before;
  ok(caught, label + (caught ? " → 실패함(실효성 증명): " + (logs.find((l) => /FAIL/.test(l)) || "").trim().slice(0, 170) : " → 🔴 잡지 못함"));
}
if (browser && gaBytes && !process.env.P83_NOMUT && !ONLY.length) {
  console.log("\n[뮤테이션]");
  const MUT = [
    // M1 원본 보관 공유 지점(draft ↔ 원본 연결) 되돌림 → 복원 경로가 원본 없이 저장(prod 재현)
    { label: "M1 draft 원본 연결고리 제거(_draftSrcFields → {})", file: "20_App.js",
      needle: "      const ab = State.fileData;\n      if (State.fileType !== \"pdf\" || !ab",
      repl: "      const ab = State.fileData;\n      if (true || State.fileType !== \"pdf\" || !ab", which: ["S2"] },
    // M2 무음 실패 복원 — 원본 업로드 실패를 종전처럼 조용히 null
    { label: "M2 원본 보관 실패 무음 복원(throw → return null)", file: "20_App.js",
      needle: "if (!url) throw this._sourceKeepFailed();", repl: "if (!url) return null;", which: ["S3"] },
    // M3 확대 재렌더 제거 — 스냅샷 위 원본 크롭 오버레이를 그리지 않음
    { label: "M3 확대 재렌더(오버레이 renderCrop) 제거", file: "02_PDF.js",
      needle: "if (cropTarget > (st.renderScale || 0)) await this.renderCrop(page, canvas, cropTarget, rot);",
      repl: "if (false) await this.renderCrop(page, canvas, cropTarget, rot);", which: ["S5"] },
    // M4 크롭 목표를 페이지 예산 dpr(residentDpr)로 되돌림 — DPR2 밀도 0.77 근본원인
    { label: "M4 크롭 목표 dpr → residentDpr(plan.target) 복원", file: "02_PDF.js",
      needle: "const cropTarget = (st.baseCssScale || 1) * Math.max(1, st.lastZoom || 1) * rawDpr;",
      repl: "const cropTarget = plan.target;", which: ["S5"] },
    // M5 이미지 도면 재압축(2000px JPEG 0.8) 복원
    { label: "M5 이미지 원본 무손실 경로 제거", file: "20_App.js",
      needle: "if (State.fileData && typeof Blob !== \"undefined\" && State.fileData instanceof Blob) {",
      repl: "if (false) {", which: ["S4"] },
    // M6 원본 PDF 연결 버튼 제거
    { label: "M6 [원본 PDF 연결] 표시 동기화 제거", file: "20_App.js",
      needle: "setTimeout(() => { try { this._syncSourceLinkBar(); } catch (e) {} }, 0);", repl: "", which: ["S6"] },
    // M7 구역 크롭 ∩ 보이는 영역 축소 제거 → 넓은 구역 안 1600% 흐림
    { label: "M7 크롭 예산 집중(보이는 영역으로 축소) 제거", file: "02_PDF.js",
      needle: "      if (!fits(rect)) {\n        const base = st.deckCrop", repl: "      if (false) {\n        const base = st.deckCrop", which: ["S7"] },
    // M8 원본 지연 로드 임계를 종전(CSS px · ×1.5)으로 복원 → DPR2 100% 에서 스냅샷(밀도 0.5) 방치
    { label: "M8 원본 로드 임계 종전 복원(dpr 무시·×1.5)", file: "02_PDF.js",
      needle: "return (cssPx * zoom * dpr) > (snapPx * gain);", repl: "return (cssPx * zoom) > (snapPx * 1.5);", which: ["S5"] },
  ];
  for (const m of MUT) await mutate(m.label, m.file, m.needle, m.repl, m.which);
}

if (browser) await browser.close();
console.log("\n" + (failed ? `❌ FAIL: ${failed}건` : "✅ ALL PASS"));
process.exit(failed ? 1 : 0);
