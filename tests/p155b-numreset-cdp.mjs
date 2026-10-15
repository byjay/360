/**
 * p155b-cdp — WO 20261015-numunify 번호 리셋 E2E (실 Chrome · 실 모듈 번들(_manifest.txt 순서) · 실 CSS 3파일 · 목 서버 API)
 * 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p155b-numreset-cdp.mjs
 *
 * 경계(p152b 관례): 서버 API 는 목(저장 PATCH 는 받은 pins 를 그대로 보관 — 저장 경로 실측용), 클라이언트는 public/ 실 모듈.
 * 마스터: "번호 리셋기능도 구현하고" — 발주: 미리보기(옛 → 새) → 확인 2회 → 1부터 연속 → 되돌리기 원복 ·
 *   권한 소유자·super · 오프라인 비활성 · 열람자 0 · 사진 매칭 키 변경 경고 · 대비 4.5:1.
 *
 * 흐름: 기능 메뉴 [번호 리셋(1부터)] 실클릭 → 시트 미리보기 → [리셋 실행] → 확인1 [다음] → 확인2 [취소](변경 0 확인)
 *       → 다시 [리셋 실행] → [다음] → [리셋 실행] → 라벨 1…4 · 지도 마커 1…4 · 서버 저장본에 스냅샷 →
 *       기능 메뉴 [번호 리셋 되돌리기] → 확인 → 옛 번호 복원 · 서버 저장본 복원 → 권한·오프라인·열람자 사유.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "public");
const SHOT = path.join(ROOT, ".tmp", "p155b");
fs.mkdirSync(SHOT, { recursive: true });

let failed = 0;
const ok = (cond, label, detail) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail).slice(0, 300) : "")); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODS = fs.readFileSync(path.join(PUB, "js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
ok(MODS.includes("61_NumReset.js"), "사전 — _manifest.txt 에 61_NumReset.js 등록");
let bundle = MODS.map((f) => fs.readFileSync(path.join(PUB, "js/modules", f), "utf8").replace(/\r\n/g, "\n")).join("\n");
// 뮤테이션: P155B_MUT=<이름> → 번들 치환 후 실행, EXIT=1 이어야 한다(대상 못 찾으면 EXIT=2).
const MUTS = {
  "confirm2": ["      if (!ok2) return 0;\n", "      if (false) return 0;\n"],   // 2번째 확인을 무시 → 3c(취소 → 변경 0) 실패
  "undo-noop": ["      PinSeries.applyUndoReset(State.pins, plan);\n", "\n"],   // 되돌리기 적용 제거 → 5b 실패
  "preview-none": ["      prev.innerHTML = plan.changes.slice(0, LIMIT).map((c) =>", "      prev.innerHTML = [].map((c) =>"],   // 미리보기 제거 → 1b 실패
};
if (process.env.P155B_MUT) {
  const m = MUTS[process.env.P155B_MUT];
  if (!m || !bundle.includes(m[0])) { console.log("뮤테이션 대상 없음: " + process.env.P155B_MUT); process.exit(2); }
  bundle = bundle.replace(m[0], m[1]);
  console.log("[뮤테이션 적용] " + process.env.P155B_MUT);
}

const CT = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webmanifest": "application/json" };
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// 위치·번호가 뒤섞인 체커/360 혼합 4개 — 위치순 기대: b(10,10)→1 · a(80,10)→2 · d(20,40)→3 · c(50,60)→4
const PINS0 = [
  { id: 11, x: 80, y: 10, page: 1, label: "103", checkboard: true },
  { id: 12, x: 10, y: 10, page: 1, label: "7" },
  { id: 13, x: 50, y: 60, page: 1, label: "101", checkboard: true },
  { id: 14, x: 20, y: 40, page: 1, label: "102" },
];
const dep = { id: "dep1", version: 1, title: "dep1", file_name: "dep1.pdf", pages_data: JSON.stringify([PNG]), drawing_data: PNG, pins: JSON.stringify(PINS0), zones: "[]", annotations: "[]" };
const decks = [{ id: "dk1", project_id: "prjT", name: "구역1", deployment_id: "dep1", page: 1, crop: null, parent_id: null }];
const patches = [];
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
  if (u === "/tables/deployments/dep1" && req.method === "GET") return json(res, dep);
  if (u === "/tables/deployments/dep1" && req.method === "PATCH") {
    const body = JSON.parse((await readBody(req)) || "{}");
    if (typeof body.pins === "string") dep.pins = body.pins;
    dep.version += 1;
    patches.push(JSON.parse(dep.pins));
    return json(res, dep);
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

const labelsById = (page) => page.evaluate(() => Object.fromEntries(window.__wm.State.pins.map((p) => [p.id, p.label])));
const srvLabels = () => Object.fromEntries(JSON.parse(dep.pins).map((p) => [p.id, p.label]));
const clickFeature = (page, id) => page.evaluate((fid) => {
  window.__wm.App && document.getElementById("btn-feature-menu").click();
  const b = document.querySelector('#feature-menu .fm-item[data-feature="' + fid + '"]');
  if (!b) return "no-item";
  const dis = b.getAttribute("aria-disabled") === "true";
  b.click();
  return dis ? "disabled" : "clicked";
}, id);
const confirmShown = (page) => page.evaluate(() => { const m = document.getElementById("wm-confirm-modal"); return m && !m.classList.contains("hidden") && m.classList.contains("on") ? document.getElementById("wm-confirm-title").textContent : null; });
const waitConfirm = async (page, re) => { await page.waitForFunction((src) => { const m = document.getElementById("wm-confirm-modal"); return m && m.classList.contains("on") && new RegExp(src).test(document.getElementById("wm-confirm-title").textContent); }, { timeout: 5000 }, re); };

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
  ok(await page.evaluate(() => !!window.__wm.NumReset), "__wm.NumReset 노출(99_footer)");
  await page.waitForSelector(".hub-tree-deck", { timeout: 15000 }).catch(() => {});
  await sleep(300);
  await page.evaluate(() => document.querySelector('.hub-tree-deck[data-deck-id="dk1"]').click());
  await page.waitForFunction(() => window.__wm.State.currentDeploymentId === "dep1" && (window.__wm.State.pins || []).length === 4, { timeout: 20000 });
  await page.evaluate(() => { if (window.__wm.App._setRegMode) window.__wm.App._setRegMode("checkboard"); });
  await sleep(300);
  // [측정 환경] SW·캐시는 목 서버가 /sw.js 404 로 차단. 애니메이션은 확인창 판정 전 강제 종료.

  /* ── 1) 기능 메뉴 실클릭 → 미리보기 시트 ── */
  const r1 = await clickFeature(page, "num-reset");
  ok(r1 === "clicked", "1 기능 메뉴 [번호 리셋(1부터)] 활성·실클릭 — " + r1);
  await page.waitForFunction(() => { const m = document.getElementById("numreset-sheet"); return m && !m.classList.contains("hidden"); }, { timeout: 5000 });
  const pv = await page.evaluate(() => Array.from(document.querySelectorAll("#nrs-preview .allpins-arn-pair")).map((e) => e.textContent));
  ok(JSON.stringify(pv) === JSON.stringify(["7 → 1", "103 → 2", "102 → 3", "101 → 4"]), "1b 미리보기(위치순) 옛 → 새 전부 — " + JSON.stringify(pv));
  const warn = await page.evaluate(() => document.getElementById("nrs-photo-warn").textContent);
  ok(/매칭 키/.test(warn) && /007 → 001/.test(warn), "1c 사진 매칭 키 변경 경고(예: 인식 007 → 001) — " + warn);
  await page.evaluate(() => { document.querySelector('#numreset-sheet input[name="nrs-order"][value="no"]').click(); });
  const pvNo = await page.evaluate(() => Array.from(document.querySelectorAll("#nrs-preview .allpins-arn-pair")).map((e) => e.textContent));
  ok(JSON.stringify(pvNo) === JSON.stringify(["7 → 1", "101 → 2", "102 → 3", "103 → 4"]), "1d [기존 번호 순서] 전환 → 미리보기 갱신 — " + JSON.stringify(pvNo));
  await page.evaluate(() => { document.querySelector('#numreset-sheet input[name="nrs-order"][value="pos"]').click(); });
  ok(JSON.stringify(await labelsById(page)) === JSON.stringify({ 11: "103", 12: "7", 13: "101", 14: "102" }), "1e 미리보기만으로는 라벨 변경 0");

  /* ── 2) 대비 실측(실 CSS 3파일 런타임) ── */
  const contrast = await page.evaluate(() => {
    function lum(c) { const m = String(c).match(/rgba?\(([^)]+)\)/); if (!m) return null; const v = m[1].split(",").map(parseFloat); const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return { L: 0.2126 * f(v[0]) + 0.7152 * f(v[1]) + 0.0722 * f(v[2]), a: v.length > 3 ? v[3] : 1 }; }
    function ratio(el) { const fg = lum(getComputedStyle(el).color); let n = el, bg = null; while (n && n.nodeType === 1) { const b = lum(getComputedStyle(n).backgroundColor); if (b && b.a > 0.5) { bg = b; break; } n = n.parentElement; } if (!fg || !bg) return 0; const hi = Math.max(fg.L, bg.L), lo = Math.min(fg.L, bg.L); return +((hi + 0.05) / (lo + 0.05)).toFixed(2); }
    const sel = ["#nrs-title", "#nrs-sub", "#numreset-sheet .allpins-arn-row label", "#nrs-preview .allpins-arn-pair", "#nrs-photo-warn", "#nrs-apply", "#nrs-cancel"];
    return sel.map((s) => { const el = document.querySelector(s); return [s, el ? ratio(el) : -1]; });
  });
  ok(contrast.every(([, r]) => r >= 4.5), "2 시트 글자 대비 ≥ 4.5:1(실 CSS) — " + contrast.map(([s, r]) => s.replace("#numreset-sheet ", "") + "=" + r).join(" · "));
  await page.screenshot({ path: path.join(SHOT, "p155b-preview.png") });

  /* ── 3) [리셋 실행] → 확인1 [다음] → 확인2 [취소] → 변경 0 ── */
  await page.evaluate(() => document.getElementById("nrs-apply").click());
  await waitConfirm(page, "번호 리셋 \\(1/2\\)");
  ok(true, "3 확인 1/2 표시");
  await page.evaluate(() => document.getElementById("wm-confirm-ok").click());
  await waitConfirm(page, "번호 리셋 \\(2/2\\)");
  const msg2 = await page.evaluate(() => document.getElementById("wm-confirm-msg").textContent);
  ok(/매칭 키/.test(msg2) && /되돌리기/.test(msg2), "3b 확인 2/2 — 매칭 키 경고 + 되돌리기 안내 — " + msg2.replace(/\n/g, " / "));
  await page.evaluate(() => document.getElementById("wm-confirm-cancel").click());
  await sleep(400);
  ok(JSON.stringify(await labelsById(page)) === JSON.stringify({ 11: "103", 12: "7", 13: "101", 14: "102" }), "3c 확인 2에서 [취소] → 라벨 변경 0");

  /* ── 4) [리셋 실행] → [다음] → [리셋 실행] → 1…4 ── */
  const patchesBefore = patches.length;
  await page.evaluate(() => document.getElementById("nrs-apply").click());
  await waitConfirm(page, "번호 리셋 \\(1/2\\)");
  await page.evaluate(() => document.getElementById("wm-confirm-ok").click());
  await waitConfirm(page, "번호 리셋 \\(2/2\\)");
  await page.evaluate(() => document.getElementById("wm-confirm-ok").click());
  await page.waitForFunction(() => window.__wm.State.pins.find((p) => p.id === 12).label === "1", { timeout: 5000 });
  ok(JSON.stringify(await labelsById(page)) === JSON.stringify({ 11: "2", 12: "1", 13: "4", 14: "3" }), "4 확인 2회 후 적용 — 위치순 1…4 연속");
  ok(await page.evaluate(() => document.getElementById("numreset-sheet").classList.contains("hidden")), "4b 시트 닫힘");
  await sleep(200);
  const marks = await page.evaluate(() => Array.from(document.querySelectorAll("#pins-layer [data-id]")).map((m) => m.dataset.id + ":" + ((m.querySelector("svg text") || {}).textContent || "")).sort());
  ok(JSON.stringify(marks) === JSON.stringify(["11:2", "12:1", "13:4", "14:3"]), "4c 지도 마커 번호 = 1…4(접두 없음) — " + JSON.stringify(marks));
  ok(await page.evaluate(() => window.__wm.PinSeries.duplicateNoIds(window.__wm.State.pins, 1).size === 0), "4d 리셋 후 중복 0");
  await page.waitForFunction((n) => true, {}, patchesBefore);
  for (let i = 0; i < 40 && patches.length === patchesBefore; i++) await sleep(250);
  const saved = JSON.parse(dep.pins);
  ok(patches.length > patchesBefore && JSON.stringify(srvLabels()) === JSON.stringify({ 11: "2", 12: "1", 13: "4", 14: "3" }) && saved.every((p) => p.numReset && p.numReset.batch),
    "4e 서버 저장본(PATCH) = 새 번호 + 되돌리기 스냅샷(numReset) — 저장 " + (patches.length - patchesBefore) + "회", saved);
  await page.screenshot({ path: path.join(SHOT, "p155b-after-reset.png") });

  /* ── 5) 되돌리기(기능 메뉴) → 확인 → 옛 번호 복원 · 서버 저장 ── */
  const pb2 = patches.length;
  const r5 = await clickFeature(page, "num-reset-undo");
  ok(r5 === "clicked", "5 기능 메뉴 [번호 리셋 되돌리기] 활성·실클릭 — " + r5);
  await waitConfirm(page, "번호 리셋 되돌리기");
  await page.evaluate(() => document.getElementById("wm-confirm-ok").click());
  await page.waitForFunction(() => window.__wm.State.pins.find((p) => p.id === 12).label === "7", { timeout: 5000 });
  ok(JSON.stringify(await labelsById(page)) === JSON.stringify({ 11: "103", 12: "7", 13: "101", 14: "102" }), "5b 옛 번호 복원(103·7·101·102)");
  for (let i = 0; i < 40 && patches.length === pb2; i++) await sleep(250);
  ok(patches.length > pb2 && JSON.stringify(srvLabels()) === JSON.stringify({ 11: "103", 12: "7", 13: "101", 14: "102" }) && JSON.parse(dep.pins).every((p) => !p.numReset),
    "5c 서버 저장본도 옛 번호 · 스냅샷 제거");
  ok((await clickFeature(page, "num-reset-undo")) === "disabled", "5d 되돌린 뒤 [되돌리기] 비활성(되돌릴 리셋 없음)");
  await page.evaluate(() => { const p = document.getElementById("feature-menu"); if (p) p.classList.add("hidden"); });

  /* ── 6) 권한·오프라인·열람자 ── */
  const why = await page.evaluate(() => {
    const W = window.__wm, out = {};
    W.Projects.currentProject.can_manage_members = false; const role = W.Auth.role; W.Auth.role = "designer";   // isSuper = getter(role==="super")
    out.nonOwner = W.NumReset.reason();
    W.Projects.currentProject.can_manage_members = true; W.Auth.role = role;
    W.Auth.readonly = true; out.readonly = W.NumReset.reason(); out.readonlyOpen = W.NumReset.open(); W.Auth.readonly = false;
    return out;
  });
  ok(/소유자·관리자 전용/.test(why.nonOwner), "6 비소유자 → '소유자·관리자 전용' — " + why.nonOwner);
  ok(/열람/.test(why.readonly) && why.readonlyOpen === false, "6b 열람자 → 사유 + open() 실행 0 — " + why.readonly);
  await page.setOfflineMode(true);
  await sleep(200);
  const off = await page.evaluate(() => ({ r: window.__wm.NumReset.reason(), o: window.__wm.NumReset.open(), hidden: document.getElementById("numreset-sheet").classList.contains("hidden") }));
  ok(/오프라인/.test(off.r) && off.o === false && off.hidden, "6c 오프라인 → 비활성 사유 · 시트 안 열림 — " + off.r);
  await page.setOfflineMode(false);

  const jsErrors = errs.filter((e) => !/favicon/i.test(e));
  ok(jsErrors.length === 0, "콘솔/페이지 JS 에러 0건 — " + JSON.stringify(jsErrors));
} finally {
  await browser.close();
  server.close();
}

console.log("\n" + (failed ? "FAILED " + failed + "건" : "ALL PASS"));
process.exit(failed ? 1 : 0);
