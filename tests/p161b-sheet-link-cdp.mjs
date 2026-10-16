/**
 * p161b-cdp — WO 20261016-multisheet 도면 간 핀 번호 연결 · 영숫자 번호 UI (실 Chrome · 실 모듈 번들(_manifest.txt 순서) · 실 CSS 3파일 · 목 서버 API)
 * 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p161b-sheet-link-cdp.mjs
 *
 * 경계(p155b 관례): 서버 API 는 목(구역 PUT 은 받은 값을 그대로 보관). 서버·D1 실측은 p161 S 단계(실 워커 + Miniflare D1).
 * 흐름: 트리에서 ELEVATION 시트 클릭 → 배치 바 [기존 번호에 연결] 실클릭 → 칩(2) 실클릭 → 도면 실클릭(배치)
 *       → 멤버 핀 = 대표 번호 2 · 연결 글리프 · 대표 사진 → 팝업 [다른 도면에서 보기] 실클릭 → PLAN 으로 이동
 *       → [새 번호] → 접두 A → A1 · 구역 ⋯ 메뉴 체크 항목 · 대비 4.5:1 · 모바일 390px 폭 · 열람자 = 보기·이동만.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "public");
const SHOT = path.join(ROOT, ".tmp", "p161b");
fs.mkdirSync(SHOT, { recursive: true });

let failed = 0;
const ok = (cond, label, detail) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail).slice(0, 300) : "")); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODS = fs.readFileSync(path.join(PUB, "js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
ok(MODS.includes("66_PinLink.js"), "사전 — _manifest.txt 에 66_PinLink.js 등록");
const bundle = MODS.map((f) => fs.readFileSync(path.join(PUB, "js/modules", f), "utf8").replace(/\r\n/g, "\n")).join("\n");

const CT = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webmanifest": "application/json" };
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PINS0 = [
  { id: 101, x: 20, y: 20, page: 1, label: "1", checkboard: true },
  { id: 102, x: 40, y: 30, page: 1, label: "2", checkboard: true, imageUrl: PNG, imageName: "head.jpg" },
];
const dep = { id: "dep1", version: 1, title: "A DK.pdf", file_name: "A DK.pdf", pages_data: JSON.stringify([PNG, PNG, PNG]), drawing_data: PNG, pins: JSON.stringify(PINS0), zones: "[]", annotations: "[]" };
const decks = [
  { id: "B", project_id: "prjT", name: "A DK", deployment_id: null, page: null, crop: null, parent_id: null, sheet_link: 1, num_prefix: "A" },
  { id: "S1", project_id: "prjT", name: "A DK PLAN", deployment_id: "dep1", page: 1, crop: null, parent_id: "B" },
  { id: "S2", project_id: "prjT", name: "A DK SECTION", deployment_id: "dep1", page: 2, crop: null, parent_id: "B" },
  { id: "S3", project_id: "prjT", name: "A DK ELEVATION", deployment_id: "dep1", page: 3, crop: null, parent_id: "B" },
];
const json = (res, o, st = 200) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => r(b)); });
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
  if (u.startsWith("/api/decks/") && req.method === "PUT") {
    const id = u.split("/")[3]; const body = JSON.parse((await readBody(req)) || "{}");
    const d = decks.find((x) => x.id === id); if (!d) return json(res, { error: "nf" }, 404);
    Object.assign(d, body); return json(res, d);
  }
  if (u === "/tables/deployments/dep1" && req.method === "GET") return json(res, dep);
  if (u === "/tables/deployments/dep1" && req.method === "PATCH") {
    const body = JSON.parse((await readBody(req)) || "{}");
    if (typeof body.pins === "string") dep.pins = body.pins;
    dep.version += 1; return json(res, dep);
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
const browser = await puppeteer.launch({ headless: "new", ...(fs.existsSync(CHROME) ? { executablePath: CHROME } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 120000 });

const CONTRAST_FN = `
  function lum(c) { const m = String(c).match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const v = m[1].split(",").map(parseFloat); const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return { L: 0.2126 * f(v[0]) + 0.7152 * f(v[1]) + 0.0722 * f(v[2]), a: v.length > 3 ? v[3] : 1 }; }
  function ratio(el) { const fg = lum(getComputedStyle(el).color); let n = el, bg = null; while (n && n.nodeType === 1) { const b = lum(getComputedStyle(n).backgroundColor); if (b && b.a > 0.5) { bg = b; break; } n = n.parentElement; } if (!fg || !bg) return 0; const hi = Math.max(fg.L, bg.L), lo = Math.min(fg.L, bg.L); return +((hi + 0.05) / (lo + 0.05)).toFixed(2); }
`;
const contrastOf = (page, sel) => page.evaluate((src, s) => { eval(src); return Array.from(document.querySelectorAll(s)).map((el) => [el.textContent.trim().slice(0, 14), ratio(el)]); }, CONTRAST_FN, sel);

try {
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e && e.message)));
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto("http://127.0.0.1:" + server.address().port + "/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__wm, { timeout: 20000 });
  await page.evaluate(() => sessionStorage.setItem("wm_id_token", "tokT"));
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.__wm && window.PinLink, { timeout: 20000 });
  await page.waitForSelector('.hub-tree-region[data-deck-id="S3"]', { timeout: 15000 }).catch(() => {});
  await sleep(300);
  const clicked = await page.evaluate(() => { const el = document.querySelector('.hub-tree-region[data-deck-id="S3"]'); if (!el) return false; el.click(); return true; });
  ok(clicked, "1 트리에서 ELEVATION 시트 실클릭");
  await page.waitForFunction(() => window.__wm.State.currentDeploymentId === "dep1" && (window.__wm.State.pins || []).length === 2 && window.__wm.State.pdfPage === 3, { timeout: 20000 }).catch(() => {});
  const st0 = await page.evaluate(() => ({ pg: window.__wm.State.pdfPage, scope: window.__wm.PinSeries.scopePages(window.__wm.State.pdfPage), deck: window.__wm.Projects.currentDeck && window.__wm.Projects.currentDeck.id }));
  ok(st0.pg === 3 && JSON.stringify(st0.scope) === "[1,2,3]" && st0.deck === "S3", "1 ELEVATION(3쪽) · 번호 공간 = [1,2,3] — " + JSON.stringify(st0));

  // 배치 모드(체크 모드 번호 핀) — 실제 버튼 경로
  await page.evaluate(() => { const A = window.__wm.App; if (A._setRegMode) A._setRegMode("checkboard"); });
  await page.evaluate(() => { const S = window.__wm.State; if (!S.placing) { const b = document.getElementById("btn-place"); if (b) b.click(); } });
  await sleep(200);
  await page.evaluate(() => { const S = window.__wm.State; S.placing = true; S.checkboard = true; window.__wm.App._updateCheckboardQuickStatus(3); });
  const barShown = await page.evaluate(() => { const b = document.getElementById("pinlink-bar"); return !!b && b.style.display !== "none" && !b.classList.contains("hidden"); });
  ok(barShown, "2 배치 바(#pinlink-bar) 표시 — 연결 묶음 + 배치 중");
  await page.click('#pinlink-bar button[data-pl="link"]');
  await sleep(100);
  const chips = await page.evaluate(() => Array.from(document.querySelectorAll('#pinlink-bar button[data-pl="pick"]')).map((b) => b.textContent));
  ok(chips.length === 2 && /^1 \(다음\)$/.test(chips[0]) && chips[1] === "2", "2 [기존 번호에 연결] 실클릭 → 칩 1(다음)·2 — " + JSON.stringify(chips));
  await page.click('#pinlink-bar button[data-pl="pick"][data-id="102"]');
  await sleep(100);
  // 도면 실클릭(배치) — 지도 뷰포트 중앙
  const vp = await page.evaluate(() => { const r = document.getElementById("map-viewport").getBoundingClientRect(); return { x: r.left + r.width * 0.55, y: r.top + r.height * 0.6 }; });
  const before = await page.evaluate(() => window.__wm.State.pins.length);
  await page.mouse.click(vp.x, vp.y);
  await sleep(400);
  const mem = await page.evaluate((n0) => { const S = window.__wm.State; const p = S.pins[S.pins.length - 1]; return { n: S.pins.length, n0, id: p.id, page: p.page, label: p.label, linkId: p.linkId, head: S.pins.find((q) => q.id === 102).linkId }; }, before);
  ok(mem.n === mem.n0 + 1 && mem.page === 3 && mem.label === "2" && mem.linkId === "102" && mem.head === "102", "3 🔴 도면 클릭 → ELEV 멤버 핀 = 대표 번호 2 · linkId — " + JSON.stringify(mem));
  await page.evaluate(() => window.__wm.UI.renderPinsOnMap());
  const mk = await page.evaluate((id) => { const m = document.querySelector('.pin-marker[data-id="' + id + '"]'); if (!m) return null; const t = m.querySelector("text"); return { glyph: !!m.querySelector(".pin-link-glyph"), filled: m.dataset.filled, no: t ? t.textContent : null }; }, mem.id);
  ok(mk && mk.glyph && mk.filled === "1" && mk.no === "2", "3 멤버 마커 — 연결 글리프 · 대표 사진으로 filled · 번호 2 — " + JSON.stringify(mk));
  const gc = await contrastOf(page, ".pin-link-glyph");
  ok(gc.length >= 1 && gc.every(([, r]) => r >= 4.5), "3 연결 글리프 대비 ≥ 4.5:1(실 CSS) — " + JSON.stringify(gc));
  await page.click('#pinlink-bar button[data-pl="link"]').catch(() => {});
  const barC = await contrastOf(page, "#pinlink-bar button, #pinlink-bar span");
  ok(barC.length >= 3 && barC.every(([, r]) => r >= 4.5), "2 배치 바 글자 대비 ≥ 4.5:1 — " + JSON.stringify(barC));
  await page.screenshot({ path: path.join(SHOT, "1-elev-linked.png") });

  // 팝업 — 대표 사진 · [다른 도면에서 보기]
  await page.evaluate((id) => window.__wm.PinActionPop.open(id), mem.id);
  await sleep(200);
  const pop = await page.evaluate(() => ({ no: document.getElementById("pap-no").textContent, photo: !document.getElementById("pap-photo-preview").classList.contains("hidden"),
    row: Array.from(document.querySelectorAll("#pap-link-row button")).map((b) => b.textContent) }));
  ok(pop.no === "#2" && pop.photo, "4 팝업 — #2 · 대표 사진 미리보기 표시(멤버에 사진 0이어도) — " + JSON.stringify(pop));
  ok(pop.row.some((t) => /A DK PLAN/.test(t)) && pop.row.some((t) => /A DK ELEVATION ●/.test(t)) && pop.row.some((t) => /연결 해제/.test(t)), "4 [다른 도면에서 보기] PLAN · ELEVATION● · 연결 해제(편집자) — " + JSON.stringify(pop.row));
  const rowC = await contrastOf(page, "#pap-link-row button, #pap-link-row span");
  ok(rowC.every(([, r]) => r >= 4.5), "4 팝업 연결 줄 대비 ≥ 4.5:1 — " + JSON.stringify(rowC));
  await page.screenshot({ path: path.join(SHOT, "2-popup.png") });
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll('#pap-link-row button[data-plr="go"]')).find((x) => /PLAN/.test(x.textContent)); b.click(); });
  await page.waitForFunction(() => window.__wm.State.pdfPage === 1, { timeout: 10000 }).catch(() => {});
  await sleep(300);
  const nav = await page.evaluate(() => ({ popHidden: document.getElementById("pin-action-pop").classList.contains("hidden"), pg: window.__wm.State.pdfPage, deck: window.__wm.Projects.currentDeck && window.__wm.Projects.currentDeck.id, act: window.__wm.State.activePin, pins: window.__wm.State.pins.length }));
  ok(nav.pg === 1 && nav.deck === "S1" && nav.act === 102 && nav.pins === 3, "5 [PLAN] 실클릭 → 1쪽 · 구역 S1 · 대표 포커스 · 미저장 편집 보존(핀 3) — " + JSON.stringify(nav));

  // 새 번호 — 접두 A
  await page.evaluate(() => { const S = window.__wm.State; S.placing = true; S.checkboard = true; window.__wm.App._updateCheckboardQuickStatus(1); });
  await page.click('#pinlink-bar button[data-pl="new"]');
  await sleep(900);   // flyTo 애니메이션 종료 대기(이동 직후 클릭은 팬 제스처로 소비된다)
  const vp2 = await page.evaluate(() => { const r = document.getElementById("map-viewport").getBoundingClientRect(); return { x: r.left + r.width * 0.3, y: r.top + r.height * 0.7 }; });
  const hitBefore = await page.evaluate((v) => { let el = document.elementFromPoint(v.x, v.y); const out = []; for (let i = 0; el && i < 6; i++, el = el.parentElement) out.push(el.tagName + "#" + el.id + "." + (el.getAttribute("class") || "") + (el.dataset && el.dataset.id ? "[" + el.dataset.id + "]" : "")); return out.join(" < "); }, vp2);
  console.log("    (클릭 전 대상: " + hitBefore + ")");
  // 1px 목 도면이라 확대 후 대표 마커가 클릭 지점을 덮는다(실측: 클릭 대상 = .pin-marker[102]) — 지도 클릭 경로는 3단계에서 실증했으므로
  //   여기는 같은 생성 지점(App._placeCheckboardPin — 클릭 핸들러가 부르는 유일한 생성 지점)을 직접 호출한다.
  if (/pin-marker/.test(hitBefore)) await page.evaluate(() => window.__wm.App._placeCheckboardPin({ x: 85, y: 85 }));
  else await page.mouse.click(vp2.x, vp2.y);
  await sleep(300);
  const np = await page.evaluate((v) => { const S = window.__wm.State; const p = S.pins[S.pins.length - 1]; const el = document.elementFromPoint(v.x, v.y);
    return { label: p.label, page: p.page, linkId: p.linkId || null, placing: S.placing, reg: S.regMode, mode: window.PinLink._mode, hit: el && (el.id || el.className), pct: window.__wm.MapCtrl.viewportToPercent(v.x, v.y) }; }, vp2);
  ok(np.label === "A1" && np.page === 1 && np.linkId === null, "6 [새 번호] + 구역 접두 A → A1 — " + JSON.stringify(np));
  await page.evaluate(() => window.__wm.UI.renderPinsOnMap());
  const mk2 = await page.evaluate(() => { const S = window.__wm.State; const p = S.pins[S.pins.length - 1]; const m = document.querySelector('.pin-marker[data-id="' + p.id + '"]'); const t = m && m.querySelector("text"); return t ? t.textContent : null; });
  ok(mk2 === "A1", "6 도면 마커 표시 = A1 — " + mk2);

  // 구역 ⋯ 메뉴
  const menu = await page.evaluate(() => window.__wm.UI.deckMenuItems(window.__wm.Projects.decks.find((d) => d.id === "B"), null).map((i) => [i.label, i.reason || ""]));
  ok(menu.some(([l, r]) => /^☑ 도면 간 핀 번호 연결$/.test(l) && !r) && menu.some(([l]) => /번호 접두사 \(현재 A\)/.test(l)), "7 구역 ⋯ 메뉴 — ☑ 도면 간 핀 번호 연결 · 번호 접두사(현재 A) — " + JSON.stringify(menu.slice(0, 4)));

  // 번호 일괄 편집(WO 20261016-bulkedit) — 기능 메뉴 실클릭 → 미리보기 → 중복 빨강·적용 차단 → 앞 글자 B → 확인 2회 → 되돌리기
  const fm = await page.evaluate(() => { document.getElementById("btn-feature-menu").click(); const b = document.querySelector('#feature-menu .fm-item[data-feature="num-edit"]'); if (!b) return "no-item"; const dis = b.getAttribute("aria-disabled") === "true"; b.click(); return dis ? "disabled" : "clicked"; });
  ok(fm === "clicked", "10 기능 메뉴 [번호 일괄 편집] 실클릭 — " + fm);
  await page.waitForFunction(() => { const m = document.getElementById("numedit-sheet"); return m && !m.classList.contains("hidden"); }, { timeout: 5000 }).catch(() => {});
  const labels1 = await page.evaluate(() => window.__wm.State.pins.filter((p) => (p.page || 1) === 1).map((p) => p.label));
  await page.click("#nes-strip-pre");
  await sleep(150);
  const bad = await page.evaluate(() => ({ red: document.querySelectorAll("#numedit-sheet .nes-bad").length, dis: document.getElementById("nes-apply").disabled, msg: document.getElementById("nes-block").textContent }));
  ok(bad.red >= 2 && bad.dis && /중복/.test(bad.msg), "10 🔴 앞 글자 제거 → 1·1 중복 빨강 + [적용] 차단 — " + JSON.stringify(bad) + " 원래 " + JSON.stringify(labels1));
  const redC = await contrastOf(page, "#numedit-sheet .nes-bad, #nes-block");
  ok(redC.length && redC.every(([, r]) => r >= 4.5), "10 빨강 표시 대비 ≥ 4.5:1 — " + JSON.stringify(redC));
  await page.click("#nes-strip-pre");
  await page.type("#nes-pre", "B");
  await sleep(150);
  const pv = await page.evaluate(() => Array.from(document.querySelectorAll("#nes-preview .allpins-arn-pair")).map((e) => e.textContent));
  ok(pv.length === labels1.length && pv.every((t) => / → B/.test(t)), "10 미리보기 옛 → 새(앞 글자 B) — " + JSON.stringify(pv));
  const sheetC = await contrastOf(page, "#numedit-sheet .numband-title, #numedit-sheet label, #nes-preview .allpins-arn-pair, #nes-apply");
  ok(sheetC.every(([, r]) => r >= 4.5), "10 시트 글자 대비 ≥ 4.5:1 — " + JSON.stringify(sheetC.slice(0, 8)));
  await page.click("#nes-apply");
  await page.waitForFunction(() => { const m = document.getElementById("wm-confirm-modal"); return m && m.classList.contains("on"); }, { timeout: 5000 });
  await page.evaluate(() => document.getElementById("wm-confirm-ok").click());
  await sleep(250);
  await page.evaluate(() => document.getElementById("wm-confirm-ok").click());
  await sleep(300);
  const after = await page.evaluate(() => ({ p1: window.__wm.State.pins.filter((p) => (p.page || 1) === 1).map((p) => p.label), mem: window.__wm.State.pins.filter((p) => p.linkId === "102").map((p) => p.label) }));
  ok(after.p1.every((l) => /^B/.test(l)) && after.mem.every((l) => l === after.mem[0]) && after.mem.length === 2 && /^B/.test(after.mem[0]), "10 확인 2회 → 적용(연결 멤버 ELEV 도 같이 B2) — " + JSON.stringify(after));
  await page.evaluate(() => window.__wm.NumReset.undo(true));
  await sleep(200);
  const undone = await page.evaluate(() => window.__wm.State.pins.filter((p) => (p.page || 1) === 1).map((p) => p.label));
  ok(JSON.stringify(undone) === JSON.stringify(labels1), "10 되돌리기 → 옛 label 복원 — " + JSON.stringify(undone));

  // 모바일 폭
  await page.setViewport({ width: 390, height: 844 });   // isMobile 변경은 puppeteer 가 페이지를 다시 불러 상태가 사라진다 — 폭만 바꾼다(미디어쿼리 720px 이하)
  await sleep(300);
  await page.evaluate(() => { const S = window.__wm.State; S.placing = true; S.checkboard = true; window.__wm.App._updateCheckboardQuickStatus(S.pdfPage); window.PinLink.setMode("link"); });
  const mob = await page.evaluate(() => { const el = document.getElementById("pinlink-bar"); if (!el) return { missing: true, placing: window.__wm.State.placing, mode: window.__wm.State.mode, pg: window.__wm.State.pdfPage }; const b = el.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), w: innerWidth, shown: el.style.display }; });
  ok(mob.l >= 0 && mob.r <= mob.w, "8 모바일 390px — 배치 바가 화면 안(가로 넘침 0) — " + JSON.stringify(mob));
  await page.screenshot({ path: path.join(SHOT, "3-mobile.png") });
  await page.setViewport({ width: 1280, height: 900 });

  // 열람자 — 보기·이동만
  const viewer = await page.evaluate((id) => {
    const S = window.__wm.State; const prev = S.mode; S.mode = "viewer"; S.placing = false;
    window.__wm.PinActionPop.open(id);
    const btns = Array.from(document.querySelectorAll("#pap-link-row button")).map((b) => b.getAttribute("data-plr"));
    window.PinLink.renderBar();
    const bar = document.getElementById("pinlink-bar");
    const r = { btns, bar: bar ? bar.style.display : "none" };
    window.__wm.PinActionPop.close(); S.mode = prev; return r;
  }, mem.id);
  ok(viewer.btns.length >= 2 && viewer.btns.every((t) => t === "go") && viewer.bar === "none", "9 열람자 — [다른 도면에서 보기]만(해제 0) · 배치 바 0 — " + JSON.stringify(viewer));

  const jsErrors = errs.filter((e) => !/favicon/i.test(e));
  ok(jsErrors.length === 0, "콘솔/페이지 JS 에러 0건 — " + JSON.stringify(jsErrors));
} finally {
  await browser.close();
  server.close();
}
console.log("\n" + (failed ? "FAILED " + failed + "건" : "ALL PASS"));
process.exit(failed ? 1 : 0);
