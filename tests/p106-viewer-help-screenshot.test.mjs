/**
 * p106 — 공유 뷰어 화면 [?] 도움말 패널 + 개발자 문의 폼(375px) 헤드리스 실측
 * (프레임워크 0 · 실행: node tests/p106-viewer-help-screenshot.test.mjs)
 *
 * WO 20261001-viewerhelp 검증 항목: "헤드리스: 공유 뷰어에서 [?] 표시와 열람자용 내용,
 * 편집 전용 항목 숨김을 확인한다" + "모바일 375px에서 폼이 화면을 넘치지 않는다".
 *
 * 경계: 서버 API 는 목(p100 과 같은 방식). 클라 = public/ 실 파일 + _manifest 순서 실 모듈
 * 번들 + 실 index.html. role-viewer 는 실 App.openApp('viewer', ...) 로 진입(가짜 아님).
 *
 * 스크린샷: .tmp/fixhelp/*.png
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "public");
const SHOTS = path.join(ROOT, ".tmp", "fixhelp");
fs.mkdirSync(SHOTS, { recursive: true });

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODS = fs.readFileSync(path.join(PUB, "js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const bundle = (() => {
  const b = MODS.map((f) => fs.readFileSync(path.join(PUB, "js/modules", f), "utf8").replace(/\r\n/g, "\n")).join("\n");
  const cut = b.lastIndexOf("})();");
  return b.slice(0, cut) + "\nwindow.__T = { App, State, UI, Help };\n" + b.slice(cut);
})();
const CT = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webmanifest": "application/json" };
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const inquiryPosts = [];
const json = (res, o, st = 200) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
const body = (req) => new Promise((r) => { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => r(Buffer.concat(c).toString())); });
const server = http.createServer(async (req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/sw.js") { res.writeHead(404); res.end(); return; }
  if (u === "/js/main.js") { res.writeHead(200, { "content-type": "application/javascript" }); res.end(bundle); return; }
  if (u === "/api/auth/auto-entry") return json(res, { token: "tokV", kind: "viewer", readonly: true });
  if (u === "/api/auth/me") return json(res, { authenticated: true, email: null, name: "", role: "viewer", readonly: true });
  if (u === "/api/auth/config") return json(res, { google_client_id: "", demo_login: false });
  if (u === "/api/tenant/resolve") return json(res, { matched: false });
  if (u === "/api/projects") return json(res, { data: [{ id: "prjT", name: "tes", created_at: 1, published: false }] });
  if (u === "/api/inquiries" && req.method === "POST") {
    const b = JSON.parse((await body(req)) || "{}");
    inquiryPosts.push(b);
    return json(res, { success: true, id: "inq-shot1", mail_sent: true });
  }
  if (u.startsWith("/tables/deployments/")) return json(res, { id: "dep1", version: 1, title: "dep1", file_name: "dep1.pdf", pages_data: JSON.stringify([PNG]), drawing_data: PNG, pins: "[]", zones: "[]", annotations: "[]" });
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

const errs = [];

/* [p100 관례] 뷰포트마다 새 page — 헤드리스 Chrome 이 isMobile 전환 시 모바일 레이아웃을
 * 통째로 다시 그려(실측: body.innerHTML 178765자로 재구성) 기존에 띄운 오버레이가 같이
 * 사라진다(앱의 반응형 재배치 동작 — Help 모듈 결함 아님). 뷰포트 전환 자체를 하지 않는다. */
async function newPage(vw, vh, extra) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errs.push(String(e && e.message)));
  await page.setViewport({ width: vw, height: vh, ...(extra || {}) });
  await page.goto("http://127.0.0.1:" + server.address().port + "/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__T, { timeout: 20000 });
  await page.evaluate(() => window.__T.App.openApp("viewer", { project: { id: "prjT", name: "tes" } }));
  return page;
}

/* ══ 1280x800 — [?] 토글 노출 + 열람자용 섹션 패널 ══ */
const pageDesktop = await newPage(1280, 800);
const isViewer = await pageDesktop.evaluate(() => document.body.classList.contains("role-viewer"));
ok(isViewer === true, "뷰어 진입 — body.role-viewer 세팅됨");

const toggleVisible = await pageDesktop.evaluate(() => {
  const b = document.querySelector('[data-help-toggle]');
  if (!b) return false;
  const r = b.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(b).display !== "none";
});
ok(toggleVisible, "공유 뷰어 화면에 [?] 도움말 토글이 보임");

await pageDesktop.evaluate(() => document.querySelector('[data-help-toggle]').click());
await sleep(200);
const panelState = await pageDesktop.evaluate(() => {
  const panel = document.querySelector('[data-help-viewer-panel]');
  const badges = document.querySelectorAll('[data-help-badge]').length;
  const text = panel ? panel.innerText : "";
  const sections = (window.__T.Help.VIEWER_SECTIONS || []).map((s) => s.title);
  const sectionsPresent = sections.every((t) => text.includes(t));
  const forbidden = ["핀 생성", "핀 삭제", "정렬", "합치기"].filter((w) => text.includes(w));
  return { hasPanel: !!panel, badges, sectionsPresent, forbidden, text: text.slice(0, 400) };
});
ok(panelState.hasPanel, "토글 클릭 → 열람자용 도움말 패널이 뜸(배지모드 아님)");
ok(panelState.badges === 0, "배지 모드는 동작하지 않음(배지 0개, 실제 " + panelState.badges + ")");
ok(panelState.sectionsPresent, "패널에 VIEWER_SECTIONS 전 항목 노출: " + panelState.text.slice(0, 120));
ok(panelState.forbidden.length === 0, "편집 전용 어휘 노출 0개(발견: " + JSON.stringify(panelState.forbidden) + ")");
await pageDesktop.screenshot({ path: path.join(SHOTS, "viewer-help-panel-1280.png") }).catch(() => {});
await pageDesktop.close();

/* ══ 375x812 — 패널 하단 "개발자에게 문의" → 폼 진입, 넘침 없는지 확인 ══ */
const pageMobile = await newPage(375, 812, { isMobile: true, hasTouch: true });
await pageMobile.evaluate(() => document.querySelector('[data-help-toggle]').click());
await sleep(200);
await pageMobile.evaluate(() => document.querySelector('[data-help-inquiry-open]').click());
await sleep(200);
const overflowInfo = await pageMobile.evaluate(() => {
  const form = document.querySelector('[data-help-inquiry-form]');
  if (!form) return { hasForm: false };
  const r = form.getBoundingClientRect();
  const docOverflow = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
  return { hasForm: true, right: r.right, vw: window.innerWidth, docOverflow };
});
ok(overflowInfo.hasForm, "375px 에서도 문의 폼이 열림");
ok(!overflowInfo.docOverflow, "375px 에서 문서 가로 스크롤(넘침) 없음");
ok(overflowInfo.right <= overflowInfo.vw + 1, "폼 우측 경계가 뷰포트를 넘지 않음(right=" + overflowInfo.right + ", vw=" + overflowInfo.vw + ")");
await pageMobile.screenshot({ path: path.join(SHOTS, "inquiry-form-375.png") }).catch(() => {});

/* ══ 제출까지 — 서버(목) 왕복 확인 ══ */
await pageMobile.evaluate(() => {
  document.querySelector('[data-help-inquiry-title]').value = "헤드리스 실측 제목";
  document.querySelector('[data-help-inquiry-body]').value = "헤드리스 실측 본문";
});
await pageMobile.evaluate(() => document.querySelector('[data-help-inquiry-send]').click());
await sleep(300);
ok(inquiryPosts.length === 1 && inquiryPosts[0].title === "헤드리스 실측 제목", "실 브라우저 제출 → 서버(목) 수신 확인: " + JSON.stringify(inquiryPosts[0] || {}));
const closedAfterSend = await pageMobile.evaluate(() => !document.querySelector('[data-help-inquiry-form]'));
ok(closedAfterSend, "제출 성공 후 폼이 닫힘");
await pageMobile.screenshot({ path: path.join(SHOTS, "inquiry-sent-375.png") }).catch(() => {});
await pageMobile.close();

ok(errs.length === 0, "페이지 예외 0건 — " + JSON.stringify(errs.slice(0, 3)));

await browser.close();
server.close();

console.log("\n" + (failed ? "FAIL: " + failed + "건" : "ALL PASS"));
process.exit(failed ? 1 : 0);
