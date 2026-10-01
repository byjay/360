/**
 * p111(헤드리스) — 열람자 요청 폼 375px · 디자이너 요청함 구역별 목록 1280px 실 브라우저 실측 (WO 20261001-viewreq)
 * 프레임워크 0 · 실행: node tests/p111-viewer-requests-screenshot.test.mjs
 *
 * 경계: 서버 API 는 목(p100·p106 과 같은 방식 — 서버 로직은 p111-viewer-requests.test.mjs 가 실 워커로 검증).
 * 클라 = public/ 실 파일 + _manifest 순서 실 모듈 번들 + 실 index.html · 실 Chrome.
 * 대비 = 런타임 computed color/background 실측(p100 SCAN 과 같은 산식, 요청 UI 범위로 한정).
 * 스크린샷: .tmp/fixrequest/*.png
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "public");
const SHOTS = path.join(ROOT, ".tmp", "fixrequest");
fs.mkdirSync(SHOTS, { recursive: true });

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODS = fs.readFileSync(path.join(PUB, "js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const bundle = (() => {
  const b = MODS.map((f) => fs.readFileSync(path.join(PUB, "js/modules", f), "utf8").replace(/\r\n/g, "\n")).join("\n");
  const cut = b.lastIndexOf("})();");
  return b.slice(0, cut) + "\nwindow.__T = { App, State, UI, Projects, Requests, Auth };\n" + b.slice(cut);
})();
const CT = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webmanifest": "application/json" };
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const P = (id, x, y, label) => ({ id, x, y, page: 1, label: String(label), checkboard: true });
const dep = (id, pins) => ({ id, version: 1, title: id, file_name: id + ".pdf", pages_data: JSON.stringify([PNG]), drawing_data: PNG, pins: JSON.stringify(pins), zones: "[]", annotations: "[]" });
const DB = {
  deps: { dep1: dep("dep1", [P(101, 30, 30, "1"), P(102, 75, 75, "2")]), dep2: dep("dep2", [P(201, 50, 50, "9")]) },
  decks: [
    { id: "dk1", project_id: "prjT", name: "구역1 기관실", deployment_id: "dep1", page: 1, crop: null, parent_id: null },
    { id: "dk1a", project_id: "prjT", name: "영역1-1 펌프룸", deployment_id: "dep1", page: 1, crop: { x: 60, y: 60, w: 30, h: 30 }, parent_id: "dk1" },
    { id: "dk2", project_id: "prjT", name: "구역2 갑판", deployment_id: "dep2", page: 1, crop: null, parent_id: null },
  ],
};
const T0 = Date.now() - 3600e3;
const N = (o) => Object.assign({ kind: "request", status: "open", pin_label: "", author_email: null, author_contact: null, created_at: T0, updated_at: T0, resolved_at: null, assignee: null }, o);
const NOTES = [
  N({ id: "n1", deployment_id: "dep1", deck_id: "dk1", pin_id: "", body: "도면 범례(배관 색상) 추가 부탁드립니다.", author: "김현장", author_role: "guest", author_contact: "kim@field.co.kr" }),
  N({ id: "n2", deployment_id: "dep1", deck_id: "dk1", pin_id: "101", pin_label: "1", body: "1번 지점 360 사진이 흐립니다. 재촬영 가능할까요?", author: "이감독", author_role: "viewer", status: "progress" }),
  N({ id: "r2", kind: "reply", parent_id: "n2", deployment_id: "dep1", deck_id: "dk1", pin_id: "101", body: "내일 오전 재촬영 예정입니다.", author: "디자이너 박", author_role: "designer" }),
  N({ id: "n3", kind: "question", deployment_id: "dep1", deck_id: "dk1a", pin_id: "102", pin_label: "2", body: "펌프 흡입측 밸브가 도면과 다르게 설치되어 있는데 맞나요?", author: "최반장", author_role: "guest" }),
  N({ id: "n4", deployment_id: "dep2", deck_id: "dk2", pin_id: "201", pin_label: "9", body: "갑판 9번 확인 완료 처리 부탁", author: "이감독", author_role: "viewer", status: "done" }),
];
const posts = [];
const json = (res, o, st = 200) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
const body = (req) => new Promise((r) => { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => r(Buffer.concat(c).toString())); });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const u = decodeURIComponent(url.pathname);
  const tok = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (u === "/sw.js") { res.writeHead(404); res.end(); return; }
  if (u === "/js/main.js") { res.writeHead(200, { "content-type": "application/javascript" }); res.end(bundle); return; }
  if (u === "/api/auth/auto-entry") return json(res, { token: "tokV", kind: "viewer", readonly: true });
  if (u === "/api/auth/me") {
    if (tok === "tokD") return json(res, { authenticated: true, email: "own@seastar.test", name: "박디자이너", role: "designer", readonly: false });
    return json(res, { authenticated: true, email: "auto@designer.local", name: "", role: "viewer", readonly: true, auto: true });
  }
  if (u === "/api/auth/config") return json(res, { google_client_id: "", demo_login: false });
  if (u === "/api/tenant/resolve") return json(res, { matched: false });
  if (u === "/api/projects") return json(res, { data: [{ id: "prjT", name: "SEASTAR 300K VLCC", created_at: 1, published: false, my_role: "owner", can_manage_members: true }] });
  if (u === "/api/projects/prjT/decks") return json(res, { data: DB.decks });
  if (u === "/api/projects/prjT/requests") return json(res, { data: NOTES, open: NOTES.filter((n) => n.kind !== "reply" && n.status !== "done").length });
  if (u === "/api/notes" && req.method === "GET") {
    const d = url.searchParams.get("deployment_id"), p = url.searchParams.get("pin_id");
    return json(res, { data: NOTES.filter((n) => n.deployment_id === d && (p == null || n.pin_id === p)).map((n) => Object.assign({}, n, { author_contact: undefined })) });
  }
  if (u === "/api/notes" && req.method === "POST") {
    const b = JSON.parse((await body(req)) || "{}");
    posts.push(b);
    return json(res, Object.assign({ id: "new" + posts.length, status: "open", author_role: "guest", created_at: Date.now(), edit_key: "nk-shot" }, b));
  }
  const m = u.match(/^\/tables\/deployments\/(.+)$/);
  if (m && req.method === "GET") { const d = DB.deps[m[1]]; return d ? json(res, d) : json(res, { error: "nf" }, 404); }
  if (u.startsWith("/api/") || u.startsWith("/tables/")) return json(res, { data: [], settings: {}, value: {} });
  const f = path.join(PUB, u === "/" ? "index.html" : u);
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "content-type": CT[path.extname(f)] || "application/octet-stream" }); res.end(fs.readFileSync(f));
});
await listenSafePort(server, "127.0.0.1");
const ORIGIN = "http://127.0.0.1:" + server.address().port;

let puppeteer = null;
try { puppeteer = createRequire("file:///C:/Users/FREE/package.json")("puppeteer"); } catch (e) { puppeteer = null; }
if (!puppeteer) { ok(false, "puppeteer 없음 — 실 브라우저 검증 불가(증거 없는 PASS 금지)"); process.exit(1); }
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const browser = await puppeteer.launch({ headless: "new", ...(fs.existsSync(CHROME) ? { executablePath: CHROME } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 120000 });
const errs = [];

/** 런타임 대비 스캔(p100 SCAN 과 같은 산식) — sel 안의 자기 텍스트 가진 보이는 요소 전부. */
function SCAN(sel) {
  const pc = (s) => { const m = String(s).match(/rgba?\(([^)]+)\)/); if (!m) return null; const a = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: a[0], g: a[1], b: a[2], a: a.length > 3 ? a[3] : 1 }; };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const bgOf = (el) => { const ov = []; for (let e = el; e; e = e.parentElement) { const c = pc(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { ov.push(c); if (c.a >= 1) break; } } let acc = { r: 255, g: 255, b: 255, a: 1 }; for (let i = ov.length - 1; i >= 0; i--) acc = over(ov[i], acc); return acc; };
  const L = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const out = [];
  document.querySelectorAll(sel).forEach((root) => {
    [root, ...root.querySelectorAll("*")].forEach((el) => {
      if (!Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())) return;
      const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      if (r.width <= 0 || r.height <= 0 || cs.display === "none" || cs.visibility === "hidden") return;
      const bg = bgOf(el), fg = over(pc(cs.color), bg);
      const a = L(fg), b = L(bg); const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const fs = parseFloat(cs.fontSize) || 16, fw = parseInt(cs.fontWeight, 10) || 400;
      const th = (fs >= 24 || (fs >= 18.66 && fw >= 700)) ? 3 : 4.5;
      out.push({ text: el.textContent.trim().slice(0, 24), ratio: +ratio.toFixed(2), th, color: cs.color, bg: "rgb(" + [bg.r, bg.g, bg.b].map(Math.round) + ")" });
    });
  });
  return out;
}
const contrast = async (page, sel, tag) => {
  const rows = await page.evaluate(SCAN, sel);
  const bad = rows.filter((x) => x.ratio < x.th - 0.005);
  const min = rows.length ? Math.min(...rows.map((x) => x.ratio)) : 0;
  ok(rows.length > 0 && bad.length === 0, tag + " 런타임 대비 ≥4.5:1 — 텍스트 " + rows.length + "건 · 최소 " + min + (bad.length ? " · 미달 " + JSON.stringify(bad.slice(0, 3)) : ""));
};

/* ══ 1) 열람자(공유 링크 ?d=) · 375×812 ══ */
console.log("\n[V 열람자 375px — 요청 폼]");
{
  const page = await browser.newPage();
  page.on("pageerror", (e) => errs.push("V " + String(e && e.message)));
  await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
  await page.goto(ORIGIN + "/?d=dep1", { waitUntil: "load" });
  await page.waitForFunction(() => window.__T && window.__T.State.currentDeploymentId === "dep1" && document.body.classList.contains("role-viewer"), { timeout: 25000 });
  await sleep(600);
  const pill = await page.evaluate(() => { const b = document.querySelector("[data-req-viewer-entry]"); if (!b) return null; const r = b.getBoundingClientRect(); const h = document.querySelector("[data-help-inquiry-toggle]"); const hr = h ? h.getBoundingClientRect() : null; return { vis: getComputedStyle(b).display !== "none" && r.width > 0, right: r.right, left: r.left, helpRight: hr ? hr.right : 0, inbox: !!document.querySelector("#btn-req-inbox") && getComputedStyle(document.querySelector("#btn-req-inbox")).display !== "none" }; });
  ok(pill && pill.vis && pill.right <= 375 && pill.left >= pill.helpRight, "V1 열람자 화면에 [요청·질문] 버튼 보임 · 뷰포트 안 · 도움말 버튼과 겹침 0 — " + JSON.stringify(pill));
  ok(pill && !pill.inbox, "V1 열람자에게 디자이너 [요청함] 미노출");
  await page.evaluate(() => document.querySelector("[data-req-viewer-entry]").click());
  await page.waitForFunction(() => document.querySelector("[data-req-viewer]"), { timeout: 5000 });
  await sleep(300);
  const geo = await page.evaluate(() => { const p = document.querySelector("[data-req-viewer]"); const r = p.getBoundingClientRect(); return { left: r.left, right: r.right, vw: window.innerWidth, docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, name: !!p.querySelector("[data-req-name]"), contact: !!p.querySelector("[data-req-contact]"), kinds: p.querySelectorAll("[data-req-kind]").length, title: p.querySelector("[data-req-title]").textContent }; });
  ok(geo.left >= 0 && geo.right <= geo.vw + 1 && !geo.docOverflow, "V2 375px 요청 폼 넘침 0 — " + JSON.stringify({ l: geo.left, r: geo.right, vw: geo.vw, o: geo.docOverflow }));
  ok(geo.name && geo.contact && geo.kinds === 2 && geo.title.includes("이 도면"), "V2 익명 = 이름(필수)·회신 이메일(선택) 칸 · 요청/질문 선택 · 도면 단위 제목 — " + geo.title);
  await page.evaluate(() => { document.querySelector("[data-req-body]").value = "도면 범례 추가 요청"; document.querySelector("[data-req-send]").click(); });
  await sleep(300);
  const errShown = await page.evaluate(() => { const e = document.querySelector("[data-req-error]"); return e && e.style.display !== "none" ? e.textContent : ""; });
  ok(errShown.includes("이름") && posts.length === 0, "V3 이름 없이 보내기 → 화면 오류 '" + errShown + "' · 전송 0");
  await page.evaluate(() => { document.querySelector("[data-req-name]").value = "김현장"; document.querySelector('[data-req-kind="question"]').click(); });
  await page.screenshot({ path: path.join(SHOTS, "viewer-request-form-375.png") });
  await contrast(page, "[data-req-viewer], [data-req-viewer-entry]", "V4 열람자 폼");
  await page.evaluate(() => document.querySelector("[data-req-send]").click());
  await sleep(500);
  ok(posts.length === 1 && posts[0].author === "김현장" && posts[0].pin_id === "" && posts[0].kind === "question" && posts[0].deployment_id === "dep1", "V5 실 브라우저 전송 → 서버(목) 수신: " + JSON.stringify(posts[0]));
  const keyKept = await page.evaluate(() => JSON.parse(localStorage.getItem("wm_note_keys") || "{}").new1 === "nk-shot");
  ok(keyKept, "V5 익명 수정키 로컬 보관(본인 수정·삭제용)");
  // 포인트 요청 — 기존 요청 목록(상태 배지 + 디자이너 답변)
  await page.evaluate(() => { const T = window.__T; T.Requests.openViewer({ pin: T.State.pins.find((p) => String(p.id) === "101") }); });
  await page.waitForFunction(() => document.querySelector('[data-req-viewer] [data-req-item="n2"]'), { timeout: 5000 });
  await sleep(200);
  const pinView = await page.evaluate(() => { const c = document.querySelector('[data-req-item="n2"]'); return { st: c.querySelector("[data-req-status]").textContent, reply: !!c.querySelector('[data-req-reply="r2"]'), text: c.innerText }; });
  ok(pinView.st === "처리중" && pinView.reply && pinView.text.includes("내일 오전 재촬영"), "V6 포인트 #1 기존 요청 = 상태 '처리중' + 디자이너 답변 표시");
  await page.screenshot({ path: path.join(SHOTS, "viewer-pin-requests-375.png") });
  await contrast(page, "[data-req-viewer]", "V6 포인트 요청 목록");
  await page.close();
}

/* ══ 2) 디자이너 · 1280×800 — 요청함 구역별 목록 ══ */
console.log("\n[D 디자이너 1280px — 요청함]");
{
  const page = await browser.newPage();
  page.on("pageerror", (e) => errs.push("D " + String(e && e.message)));
  await page.evaluateOnNewDocument(() => { try { sessionStorage.setItem("wm_id_token", "tokD"); } catch (e) {} });
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(ORIGIN + "/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__T && document.querySelector('.hub-tree-deck[data-deck-id="dk1"]'), { timeout: 25000 });
  await page.evaluate(() => document.querySelector('.hub-tree-deck[data-deck-id="dk1"]').click());
  await page.waitForFunction(() => window.__T.State.currentDeploymentId === "dep1" && (window.__T.State.pins || []).length === 2, { timeout: 25000 });
  await page.waitForFunction(() => { const b = document.querySelector("#btn-req-inbox"); return b && getComputedStyle(b).display !== "none"; }, { timeout: 15000 }).catch(() => {});
  await sleep(500);
  const btn = await page.evaluate(() => { const b = document.querySelector("#btn-req-inbox"); if (!b) return null; const c = b.querySelector("[data-req-inbox-count]"); const r = b.getBoundingClientRect(); return { vis: getComputedStyle(b).display !== "none" && r.width > 0, count: c ? c.textContent : "", cvis: c ? getComputedStyle(c).display !== "none" : false, inTop: r.top < 80, viewerPill: getComputedStyle(document.querySelector("[data-req-viewer-entry]")).display !== "none" }; });
  ok(btn && btn.vis && btn.inTop && btn.count === "3" && btn.cvis, "D1 상단 [요청함 3] — 미처리 배지(완료 1건 제외) — " + JSON.stringify(btn));
  ok(btn && !btn.viewerPill, "D1 디자이너에게 열람자 [요청·질문] 플로팅 미노출");
  const badges = await page.evaluate(() => Array.from(document.querySelectorAll(".tree-req-badge")).map((b) => b.getAttribute("data-req-deck") + ":" + b.textContent).sort());
  ok(JSON.stringify(badges) === JSON.stringify(["dk1:2", "dk1a:1"]), "D2 트리 구역/영역 노드 미처리 배지 dk1=2 · dk1a=1 · dk2(완료만)=없음 — " + JSON.stringify(badges));
  await page.evaluate(() => document.querySelector("#btn-req-inbox").click());
  await page.waitForFunction(() => document.querySelector("[data-req-inbox] [data-req-item]"), { timeout: 5000 });
  await page.evaluate(() => document.querySelector('[data-req-filter="all"]').click());
  await sleep(300);
  const inbox = await page.evaluate(() => {
    const p = document.querySelector("[data-req-inbox]");
    const groups = Array.from(p.querySelectorAll("[data-req-group]")).map((g) => g.getAttribute("data-req-group") + "=" + Array.from(g.querySelectorAll("[data-req-item]")).map((i) => i.getAttribute("data-req-item")).join("/"));
    const r = p.getBoundingClientRect();
    return { groups, title: p.querySelector("[data-req-title]").textContent, contact: p.innerText.includes("kim@field.co.kr"), reply: !!p.querySelector('[data-req-item="n2"] [data-req-reply="r2"]'), w: r.width, right: r.right };
  });
  ok(JSON.stringify(inbox.groups) === JSON.stringify(["dk1=n1/n2", "dk1a=n3", "dk2=n4"]), "D3 요청함 그룹 = 구역1(구역 단위 → #1) → 영역1-1(#2) → 구역2 — " + JSON.stringify(inbox.groups));
  ok(inbox.title.includes("미처리 3") && inbox.contact && inbox.reply, "D3 제목 '미처리 3건' · 익명 회신 이메일 · 답변 스레드 표시");
  await page.screenshot({ path: path.join(SHOTS, "designer-inbox-1280.png") });
  await contrast(page, "[data-req-inbox], #btn-req-inbox, .tree-req-badge", "D4 디자이너 요청함");
  // 항목 → 영역 열고 핀으로 이동·강조
  await page.evaluate(() => document.querySelector('[data-req-item="n3"] [data-req-goto]').click());
  await page.waitForFunction(() => window.__T.State.activePin === 102 || window.__T.State.activePin === "102", { timeout: 15000 }).catch(() => {});
  const nav = await page.evaluate(() => ({ deck: window.__T.Projects.currentDeck && window.__T.Projects.currentDeck.id, pin: window.__T.State.activePin, closed: !document.querySelector("[data-req-inbox]") }));
  ok(nav.deck === "dk1a" && String(nav.pin) === "102" && nav.closed, "D5 항목 클릭 → 영역1-1 열림 · 핀 #2 활성(강조) · 패널 닫힘 — " + JSON.stringify(nav));
  await page.close();
}

ok(errs.length === 0, "페이지 예외 0건 — " + JSON.stringify(errs.slice(0, 3)));
await browser.close();
server.close();
console.log("\n" + (failed ? "FAIL: " + failed + "건" : "ALL PASS"));
process.exit(failed ? 1 : 0);
