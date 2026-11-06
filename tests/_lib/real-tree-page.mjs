/**
 * 실 Chrome(puppeteer) 프로젝트 사이드바 트리 공용 하니스 (WO 20261106-treeui).
 *
 * 왜: tests/_lib/real-map-page.mjs 는 #map-viewport(지도)만 띄우고 #side-tree 를 마운트하지
 *   않는다 — 트리 UX(들여쓰기·행 높이·⋯ 버튼·모바일 가로폭) 판정은 화면 증거가 없었다.
 *   이 하니스는 실제 앱 전체(공개 번들, public/js/modules/_manifest.txt 순서) + 실 CSS 3종
 *   (style.css → seastar-family-tokens.css → seastar-3d-skin.css, index.html 링크 순서 그대로)
 *   + 실 index.html 을 로드하고, 허브 카드를 실제로 클릭해 프로젝트에 진입시켜
 *   11_UI.js 의 실제 renderTree()/deckNode() 가 그린 #side-tree 를 반환한다.
 * 목(mock) 0 범위: HTTP API 응답(/api/*, /tables/*)만 — tests/p166-tree-explorer-look-cdp.mjs
 *   와 동일 경량 패턴(실 모듈 + 실 CSS, API 만 로컬 서버가 고정값으로 답한다).
 * gitignore 로컬 파일 의존 0 — scenario.decks/project 는 이 모듈 호출부가 인자로 준다
 *   (클린 체크아웃에서도 그대로 동작).
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { listenSafePort } from "./safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUB = path.join(ROOT, "public");
const CT = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/json" };

function loadBundle() {
  const manifest = fs.readFileSync(path.join(PUB, "js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return manifest.map((f) => fs.readFileSync(path.join(PUB, "js/modules", f), "utf8").replace(/\r\n/g, "\n")).join("\n");
}

let puppeteerCache;
function requirePuppeteer() {
  if (puppeteerCache !== undefined) return puppeteerCache;
  try { puppeteerCache = createRequire("file:///C:/Users/FREE/package.json")("puppeteer"); }
  catch (e) { puppeteerCache = null; }
  return puppeteerCache;
}

/**
 * @param {object} scenario
 * @param {{id:string,name:string,can_manage_members?:boolean}} scenario.project
 * @param {Array<object>} scenario.decks  /api/projects/:id/decks 가 내려줄 deck 목록(실 필드 그대로)
 * @param {(page:import('puppeteer').Page)=>Promise<void>} [scenario.afterEnter] 프로젝트 진입(#side-tree 첫 마운트) 후 1회 실행할 보강 훅
 *   (예: State.fileType 세팅 후 renderTree() 재호출 — "도면 등록 직후" 상태 재현. 실 함수 호출이라 목이 아니다)
 * @param {object} [opts]
 * @param {number} [opts.width=1280] @param {number} [opts.height=800]
 * @returns {Promise<{page, browser, server, close:()=>Promise<void>}>}
 */
export async function openRealTreePage(scenario, opts = {}) {
  const width = opts.width || 1280, height = opts.height || 800;
  const puppeteer = requirePuppeteer();
  if (!puppeteer) throw new Error("puppeteer 없음 — 실 브라우저 검증 불가(증거 없는 PASS 금지)");

  const bundle = loadBundle();
  const project = scenario.project || { id: "prjT", name: "테스트 프로젝트", can_manage_members: true };
  const decks = scenario.decks || [];
  const json = (res, o, st = 200) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  const server = http.createServer(async (req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    if (u === "/sw.js") { res.writeHead(404); res.end(); return; }
    if (u === "/js/main.js") { res.writeHead(200, { "content-type": "application/javascript" }); res.end(bundle); return; }
    if (u === "/api/auth/auto-entry") return json(res, { token: "tokT", kind: "designer" });
    if (u === "/api/auth/me") return json(res, { authenticated: true, email: "owner@test.local", name: "owner", role: "super", auto: true, readonly: false });
    if (u === "/api/auth/config") return json(res, { google_client_id: "", demo_login: false });
    if (u === "/api/tenant/resolve") return json(res, { matched: false });
    if (u === "/api/projects") return json(res, { data: [Object.assign({ created_at: 1, published: false }, project)] });
    if (u === "/api/projects/" + project.id + "/decks") return json(res, { data: decks });
    if (u === "/api/projects/" + project.id + "/bands") return json(res, { band_size: 100, me: { email: "owner@test.local", band: 1, owner: true }, bands: [] });
    if (u.startsWith("/api/") || u.startsWith("/tables/")) return json(res, { data: [], settings: {}, value: {} });
    const f = path.join(PUB, u === "/" ? "index.html" : u);
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "content-type": CT[path.extname(f)] || "application/octet-stream" }); res.end(fs.readFileSync(f));
  });
  await listenSafePort(server, "127.0.0.1");

  const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  // 🔴 CLAUDE.md §G-5 — userDataDir 미지정 시 puppeteer 가 OS 기본 TEMP(C:)에 프로필을 만든다.
  const profileDir = path.join(ROOT, ".tmp", "treeui-chrome-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({ headless: "new", userDataDir: profileDir, ...(fs.existsSync(CHROME) ? { executablePath: CHROME } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 120000 });
  const pageErrors = [];
  let page;
  try {
    page = await browser.newPage();
    page.on("pageerror", (e) => pageErrors.push(String(e && e.message)));
    await page.setViewport({ width, height });
    await page.goto("http://127.0.0.1:" + server.address().port + "/", { waitUntil: "load" });
    await page.waitForFunction(() => window.__wm, { timeout: 20000 });
    await page.evaluate(() => sessionStorage.setItem("wm_id_token", "tokT"));
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => window.__wm && window.__wm.UI, { timeout: 20000 });
    // 허브 카드 → 프로젝트 진입(클릭해야 #side-tree 가 채워진다, p166 과 동일 경로).
    await page.waitForSelector(".hub-card-name", { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 200));
    await page.evaluate(() => { const el = document.querySelector(".hub-card-name"); if (el) el.click(); });
    await page.waitForSelector("#side-tree", { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 300));
    if (typeof scenario.afterEnter === "function") await scenario.afterEnter(page);
  } catch (e) {
    await browser.close().catch(() => {});
    server.close();
    throw e;
  }

  const close = async () => {
    try { await browser.close(); } catch (e) {}
    server.close();
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
  };
  return { page, browser, server, close, pageErrors };
}
