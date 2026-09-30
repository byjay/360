/**
 * p98 — 실 브라우저(headless Chrome): 구역 합치기 UI — 트리 진입 버튼 렌더(렌더 고아 방지) · 모달 미리보기 ·
 *        가져오기 → 되돌리기 토스트 · 대비(CSS 3파일 캐스케이드 후 런타임 계산값)
 * (프레임워크 0 · 실행: node tests/p98-merge-ui.test.mjs)
 *
 * 경계: 서버 API 만 목(p83 과 같은 방식). 클라 = public/ 실 파일 + _manifest 순서 실 모듈 번들 + 실 CSS 3개.
 * 스크린샷: .tmp/fixmerge/p98-*.png
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "public");
const SHOTS = path.join(ROOT, ".tmp", "fixmerge");
fs.mkdirSync(SHOTS, { recursive: true });
let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODS = fs.readFileSync(path.join(PUB, "js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const bundle = (() => {
  const b = MODS.map((f) => fs.readFileSync(path.join(PUB, "js/modules", f), "utf8").replace(/\r\n/g, "\n")).join("\n");
  const cut = b.lastIndexOf("})();");
  return b.slice(0, cut) + "\nwindow.__T = { App, Projects, State, UI, RegionMerge, Prompt };\n" + b.slice(cut);
})();
const CT = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/json" };
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const P = (id, x, y, label, extra) => Object.assign({ id, x, y, page: 1, label: String(label), checkboard: true }, extra || {});
const dep = (id, pins) => ({ id, version: 1, title: id, file_name: id + ".pdf", pages_data: JSON.stringify([PNG]), drawing_data: PNG, pins: JSON.stringify(pins), zones: "[]", annotations: "[]" });
const db = {
  deps: {
    dep1: dep("dep1", [P(101, 75, 50, 7), P(102, 10, 10, 8), P(103, 60, 60, 9)]),
    dep2: dep("dep2", [P(201, 25.3, 25.4, 7)]),
  },
  decks: [
    { id: "dk1", project_id: "prjT", name: "구역1 (다른 사람)", deployment_id: "dep1", page: 1, crop: null, parent_id: null, src_dep_id: "orig", src_page: 1, src_crop: { x: 10, y: 20, w: 40, h: 30 } },
    { id: "dk2", project_id: "prjT", name: "구역2", deployment_id: "dep2", page: 1, crop: null, parent_id: null, src_dep_id: "orig", src_page: 1, src_crop: { x: 30, y: 25, w: 40, h: 40 } },
    { id: "dk3", project_id: "prjT", name: "옛 구역(기록 없음)", deployment_id: "dep3", page: 1, crop: null, parent_id: null },
  ],
  dupCalls: 0,
};
db.deps.dep3 = dep("dep3", [P(301, 40, 40, 1)]);
const json = (res, o, st = 200) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
const body = (req) => new Promise((r) => { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => r(Buffer.concat(c).toString())); });
const server = http.createServer(async (req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/sw.js") { res.writeHead(404); res.end(); return; }
  if (u === "/js/main.js") { res.writeHead(200, { "content-type": "application/javascript" }); res.end(bundle); return; }
  if (u === "/api/auth/auto-entry") return json(res, { token: "tokT", kind: "designer" });
  if (u === "/api/auth/me") return json(res, { authenticated: true, email: "auto@test.local", name: "auto", role: "designer", auto: true });
  if (u === "/api/auth/config") return json(res, { google_client_id: "", demo_login: false });
  if (u === "/api/tenant/resolve") return json(res, { matched: false });
  if (u === "/api/projects") return json(res, { data: [{ id: "prjT", name: "tes", created_at: 1, published: false }] });
  if (u === "/api/projects/prjT/decks") return json(res, { data: db.decks });
  if (u === "/api/merge/dup-check") {
    db.dupCalls++;
    const b = JSON.parse((await body(req)) || "{}");
    // Jev 가 0.82 로 "same" 이라 답한 상황 — 「추정」 표시 경로
    return json(res, { ok: true, probes: (b.pairs || []).map((p) => ({ i: p.i, ok: true, label: "same", p: 0.82 })) });
  }
  const m = u.match(/^\/tables\/deployments\/(.+)$/);
  if (m && req.method === "GET") { const d = db.deps[m[1]]; return d ? json(res, d) : json(res, { error: "nf" }, 404); }
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
const page = await browser.newPage();
await page.setViewport({ width: 1366, height: 860 });
await page.setRequestInterception(true);
page.on("request", (r) => (/^https?:\/\/(?!127\.0\.0\.1)/.test(r.url()) ? r.respond({ status: 200, contentType: "text/plain", body: "" }) : r.continue()));
const errs = [];
page.on("pageerror", (e) => errs.push(String(e && e.message)));
await page.goto("http://127.0.0.1:" + server.address().port + "/", { waitUntil: "load" });
await page.waitForFunction(() => window.__T, { timeout: 20000 });

// 대비 계산(런타임 계산값 — CSS 3파일 캐스케이드·!important·var() 해석 후)
const CONTRAST = () => {
  const parse = (s) => { const m = String(s).match(/rgba?\(([^)]+)\)/); if (!m) return null; const a = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: a[0], g: a[1], b: a[2], a: a.length > 3 ? a[3] : 1 }; };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const bgOf = (el) => {
    const stack = [];
    for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } }
    let acc = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) acc = over(stack[i], acc);
    return acc;
  };
  const L = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  window.__ratio = (el) => { const fg = parse(getComputedStyle(el).color), bg = bgOf(el); const fgo = over(fg, bg); const a = L(fgo), b = L(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
};
await page.evaluate(CONTRAST);

// 사용자 동선 그대로 — 첫 화면(프로젝트 허브) 카드 트리의 CHECKER > "구역2" 클릭
await page.waitForSelector('.hub-tree-deck[data-deck-id="dk2"]', { timeout: 15000 });
await page.evaluate(() => document.querySelector('.hub-tree-deck[data-deck-id="dk2"]').click());
await page.waitForFunction(() => window.__T.State.currentDeploymentId === "dep2" && (window.__T.State.pins || []).length === 1, { timeout: 20000 });
await sleep(800);
const btn = await page.evaluate(() => { const b = document.querySelector("#side-tree .rm-open-btn"); return b ? { text: b.textContent, vis: !!(b.offsetWidth || b.offsetHeight), n: document.querySelectorAll("#side-tree .rm-open-btn").length } : null; });
ok(!!btn && btn.vis && btn.n === 1, "트리 진입 버튼 렌더(지금 열린 구역 1곳에만) — " + JSON.stringify(btn));
await page.screenshot({ path: path.join(SHOTS, "p98-1-tree-button.png") });

await page.click("#side-tree .rm-open-btn");
await page.waitForFunction(() => { const e = document.getElementById("rm-preview"); return e && /개 가져옴|없습니다|선택하세요/.test(e.textContent); }, { timeout: 15000 });
await page.evaluate(() => document.getAnimations().forEach((a) => { try { a.finish(); } catch (e) {} }));
await sleep(300);
const pv = await page.evaluate(() => ({
  opts: Array.from(document.querySelectorAll("#rm-src option")).map((o) => o.textContent),
  preview: document.getElementById("rm-preview").textContent,
  dups: Array.from(document.querySelectorAll("#rm-dups .rm-dup")).map((e) => e.textContent.trim()),
  ok: document.getElementById("rm-ok").textContent, disabled: document.getElementById("rm-ok").disabled,
}));
console.log("   측정: " + JSON.stringify(pv));
ok(pv.opts.some((t) => /구역1 \(다른 사람\) · 핀 3개 · 좌표 변환 가능/.test(t)) && pv.opts.some((t) => /옛 구역\(기록 없음\) · 핀 1개 · 좌표 변환 불가/.test(t)) && !pv.opts.some((t) => /^구역2 /.test(t)),
  "① 원본 선택 — 핀 수 + 변환 가능/불가 배지, 대상 자신 제외");
ok(/핀 3개 중 1개 가져옴 · 1개는 대상 범위 밖/.test(pv.preview) && /번호 중복 1건/.test(pv.preview) && /같은 위치 중복 의심 1건/.test(pv.preview),
  "③ 미리보기 문구(N개 중 M개 · 범위 밖 · 번호 중복 · 같은 위치 의심) — " + pv.preview);
ok(pv.dups.length === 1 && /Jev p=0\.82 「추정」/.test(pv.dups[0]) && db.dupCalls >= 1, "Jev 0.70~0.90 → 「추정」 표시 · 기본 선택 해제");
const ratios = await page.evaluate(() => ({
  title: window.__ratio(document.getElementById("rm-title")),
  preview: window.__ratio(document.getElementById("rm-preview")),
  badge: window.__ratio(document.getElementById("rm-badge")),
  chk: window.__ratio(document.querySelector("#rm-modal .rm-chk")),
  dup: window.__ratio(document.querySelector("#rm-dups .rm-dup")),
  sub: window.__ratio(document.getElementById("rm-sub")),
}));
console.log("   측정 대비: " + JSON.stringify(Object.fromEntries(Object.entries(ratios).map(([k, v]) => [k, +v.toFixed(2)]))));
ok(Object.values(ratios).every((r) => r >= 4.5), "모달 글자 대비 ≥ 4.5:1 (런타임 계산값)");
await page.screenshot({ path: path.join(SHOTS, "p98-2-modal-preview.png") });

// 레거시 구역 선택 → 그대로 얹기 전엔 가져오기 비활성
await page.select("#rm-src", "1");
await page.waitForFunction(() => /좌표 그대로 얹기/.test(document.getElementById("rm-preview").textContent), { timeout: 8000 });
const leg = await page.evaluate(() => ({ raw: !document.getElementById("rm-raw-row").classList.contains("hidden"), dis: document.getElementById("rm-ok").disabled, badge: document.getElementById("rm-badge").className }));
ok(leg.raw && leg.dis && /warn/.test(leg.badge), "레거시 → 변환 불가 배지 + '그대로 얹기' 미선택 기본 · 가져오기 비활성");
await page.screenshot({ path: path.join(SHOTS, "p98-3-legacy.png") });
await page.select("#rm-src", "0");
await page.waitForFunction(() => /개 가져옴/.test(document.getElementById("rm-preview").textContent), { timeout: 8000 });

// 가져오기 → 되돌리기 토스트
const beforeN = await page.evaluate(() => window.__T.State.pins.length);
await page.click("#rm-ok");
await page.waitForSelector(".rm-undo-toast .rm-undo-btn", { timeout: 5000 });
await page.evaluate(() => document.getAnimations().forEach((a) => { try { a.finish(); } catch (e) {} }));
const afterN = await page.evaluate(() => window.__T.State.pins.length);
const undoR = await page.evaluate(() => ({ btn: window.__ratio(document.querySelector(".rm-undo-btn")), txt: document.querySelector(".rm-undo-toast").textContent }));
ok(afterN === beforeN + 1, "④ 가져오기 → State +1 (" + beforeN + "→" + afterN + ")");
ok(undoR.btn >= 4.5, "되돌리기 버튼 대비 " + undoR.btn.toFixed(2) + ":1");
await page.screenshot({ path: path.join(SHOTS, "p98-4-undo-toast.png") });
await page.click(".rm-undo-btn");
await sleep(300);
const undoneN = await page.evaluate(() => window.__T.State.pins.length);
ok(undoneN === beforeN, "되돌리기 → 원래 핀 수(" + undoneN + ")");
ok(errs.length === 0, "페이지 예외 0 — " + JSON.stringify(errs.slice(0, 3)));

await browser.close();
server.close();
console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
