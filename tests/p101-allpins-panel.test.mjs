/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p101-allpins-panel.test.mjs)
 *
 * 대상: WORK_ORDER_20261001_allpins.md — 전체 포인트 패널: 모드 탭(CHECKER/360) · 전체/부분 선택 ·
 *   선택 삭제(기존 일괄삭제 재인증 경로 재사용) · 번호 다시 매기기(시작번호·순서·대역/중복 경고·되돌리기).
 *
 * 실 Chrome(puppeteer) + 실 모듈 번들(public/js/modules/*, _manifest.txt 순서) + 실 index.html +
 * 실 CSS 3개. 서버 API 만 목(p92/p98/p100 과 같은 경계). 권한 분기(소유자·일반 디자이너·열람전용)는
 * 실제 네트워크 재로그인 왕복 대신 window.__T.Auth/State 필드를 직접 바꾸고 실제 렌더 함수
 * (AllPins.render/App.canBulkDeletePins)를 다시 불러 검사한다 — 판정 로직 자체는 실 소스.
 *
 * 뮤테이션(지휘자 수동 확인, 코드 복구 후 재실행):
 *  ① 21_AllPins.js _confirmRenumber() 의 `pin.labelManual = true;` 를 지우면 "라벨매뉴얼 유지" 단언 FAIL.
 *  ② 01b_PinSeries.js renumberSelection() 의 duplicateIds 로직 주석 처리하면 "중복 경고 표시" FAIL.
 *  ③ 21_AllPins.js _canDelete()/_canSelect() 가 항상 true 를 돌려주게 바꾸면 "열람자 버튼 숨김" FAIL.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "public");
const SHOTS = path.join(ROOT, ".tmp", "fixallpins");
fs.mkdirSync(SHOTS, { recursive: true });

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODS = fs.readFileSync(path.join(PUB, "js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const rdMod = (f) => fs.readFileSync(path.join(PUB, "js/modules", f), "utf8").replace(/\r\n/g, "\n");
const bundle = (() => {
  const b = MODS.map((f) => rdMod(f)).join("\n");
  const cut = b.lastIndexOf("})();");
  return b.slice(0, cut) +
    "\nwindow.__T = { App, State, UI, Projects, Prompt, PinSeries, AllPins, Auth, NumBand, OpLog };\n" +
    b.slice(cut);
})();
const CT = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webmanifest": "application/json" };

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const P = (id, x, y, label, extra) => Object.assign({ id, x, y, page: 1, label: String(label) }, extra || {});
// CHECKER 3개(인덱스 순서 ≠ 공간순서 — 목록순/위치순 차이를 드러내려는 의도적 배치)
const C1 = P(11, 80, 50, "1", { checkboard: true });   // idx0, y=50(중간)
const C2 = P(12, 10, 90, "2", { checkboard: true });   // idx1, y=90(아래)
const C3 = P(13, 50, 10, "3", { checkboard: true });   // idx2, y=10(위) → 위치순 1번째
const CD = P(14, 95, 95, "102", { checkboard: true }); // 대상 밖 고정 핀 — 재채번 결과 102 와 충돌 유도
// 360(content) 2개
const N1 = P(21, 30, 30, "1", { imageUrl: "/images/a.jpg" });
const N2 = P(22, 40, 40, "2", { imageUrl: "/images/b.jpg" });
const dep = (id, pins) => ({ id, version: 1, title: id, file_name: id + ".pdf", pages_data: JSON.stringify([PNG]), drawing_data: PNG, pins: JSON.stringify(pins), zones: "[]", annotations: "[]" });
const db = {
  deps: { dep1: dep("dep1", [C1, C2, C3, CD, N1, N2]) },
  decks: [{ id: "dk1", project_id: "prjT", name: "구역1", deployment_id: "dep1", page: 1, crop: null, parent_id: null, src_dep_id: "orig", src_page: 1, src_crop: { x: 10, y: 20, w: 40, h: 30 } }],
};
const json = (res, o, st = 200) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
const server = http.createServer(async (req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/sw.js") { res.writeHead(404); res.end(); return; }
  if (u === "/js/main.js") { res.writeHead(200, { "content-type": "application/javascript" }); res.end(bundle); return; }
  if (u === "/api/auth/auto-entry") return json(res, { token: "tokT", kind: "designer" });
  if (u === "/api/auth/me") return json(res, { authenticated: true, email: "owner@test.local", name: "owner", role: "super", auto: true });
  if (u === "/api/auth/config") return json(res, { google_client_id: "", demo_login: false });
  if (u === "/api/tenant/resolve") return json(res, { matched: false });
  if (u === "/api/projects") return json(res, { data: [{ id: "prjT", name: "tes", created_at: 1, published: false, can_manage_members: true }] });
  if (u === "/api/projects/prjT/decks") return json(res, { data: db.decks });
  if (u === "/api/projects/prjT/bands") return json(res, { band_size: 100, me: { email: "owner@test.local", band: 1, owner: true }, bands: [] });
  const m = u.match(/^\/tables\/deployments\/(.+)$/);
  if (m && req.method === "GET") { const d = db.deps[m[1]]; return d ? json(res, d) : json(res, { error: "nf" }, 404); }
  // [WO 20261015-bulkdel-undo] deletePins 가 로컬(_removePins) 대신 서버 /pins/bulk-delete 를 탄다 — D 섹션이
  // "App.deletePins 경로로 실제 삭제" 를 검증하려면 이 목 서버가 실제로 db.deps 핀을 지워야 한다(PinPurge.
  // _afterServerChange 가 뒤이어 GET 으로 다시 읽어 State.pins 에 반영).
  if (u === "/api/projects/prjT/pins/bulk-delete" && req.method === "POST") {
    let body = ""; for await (const c of req) body += c;
    let b = {}; try { b = JSON.parse(body || "{}"); } catch (e) {}
    const d = db.deps[b.deployment_id];
    if (!d) return json(res, { error: "nf" }, 404);
    let pins = []; try { pins = JSON.parse(d.pins || "[]"); } catch (e) {}
    const want = new Set((b.ids || []).map(String));
    const dead = pins.filter((p) => p && p.id != null && !p._deleted && want.has(String(p.id)));
    pins = pins.map((p) => (p && dead.some((x) => String(x.id) === String(p.id))) ? { id: p.id, _deleted: true, ts: Date.now() } : p);
    d.pins = JSON.stringify(pins); d.version = Number(d.version || 0) + 1;
    return json(res, { ok: true, deleted: dead.length, batch: "b1", undo_until: Date.now() + 60000,
      results: [{ id: b.deployment_id, ok: true, status: 200, deleted: dead.length, version: d.version }] });
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

const page = await browser.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e && e.message)));
await page.setViewport({ width: 1280, height: 900 });
await page.goto("http://127.0.0.1:" + server.address().port + "/", { waitUntil: "load" });
await page.waitForFunction(() => window.__T, { timeout: 20000 });
await page.evaluate(() => sessionStorage.setItem("wm_id_token", "tokT"));
await page.reload({ waitUntil: "load" });
await page.waitForFunction(() => window.__T, { timeout: 20000 });

// Auth.ensureReauth 는 실제론 구글 팝업 — 헤드리스에서 쓸 수 없으니 호출 여부/결과만 스텁으로 관찰(지시 §검증: "스텁").
await page.evaluate(() => {
  window.__reauthCalls = 0;
  window.__T.Auth.ensureReauth = async () => { window.__reauthCalls++; return window.__reauthAns !== false; };
  window.__confirmLog = [];
  window.__T.Prompt.confirm = async (title, msg) => { window.__confirmLog.push(String(msg || title || "")); return window.__confirmAns !== false; };
});

await page.waitForSelector(".hub-tree-deck", { timeout: 15000 }).catch(() => {});
await sleep(300);
await page.evaluate(() => document.querySelector('.hub-tree-deck[data-deck-id="dk1"]').click());
await page.waitForFunction(() => window.__T.State.currentDeploymentId === "dep1" && (window.__T.State.pins || []).length === 6, { timeout: 20000 });
await sleep(400);

/* ══ A. 모드 탭 — 기본 활성 모드 + 카운트 + 탭=모드전환 ══ */
await page.evaluate(() => document.getElementById("btn-all-pins").click());
await page.waitForFunction(() => document.getElementById("allpins-drawer").classList.contains("on"), { timeout: 8000 });
await sleep(250);
{
  const t = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll("#allpins-tabs [data-series]"));
    return { n: tabs.length, active: tabs.find((b) => b.classList.contains("active"))?.dataset.series, cnts: tabs.map((b) => b.textContent.trim()) };
  });
  ok(t.n === 2, "A 모드 탭 2개(CHECKER/360) — " + t.n);
  ok(t.active === "checkboard", "A 기본 탭 = 현재 활성 모드(checkboard) — " + t.active);
  ok(/4/.test(t.cnts[0] || ""), "A CHECKER 탭 카운트 4(C1·C2·C3·CD) — " + JSON.stringify(t.cnts));
}
// 탭 전환 → App._setRegMode 가 실제로 State.regMode 를 바꾼다(SoT 재사용 확인)
await page.evaluate(() => document.querySelector('#allpins-tabs [data-series="content"]').click());
await page.waitForFunction(() => document.getElementById("allpins-drawer").classList.contains("on"), { timeout: 8000 }).catch(() => {});
await sleep(400);
ok((await page.evaluate(() => window.__T.State.regMode)) === "photo", "A 탭 클릭 = App._setRegMode('photo') 로 실제 모드 전환(SoT 통일)");
ok((await page.evaluate(() => document.getElementById("allpins-count").textContent)) === "2", "A 360 탭 카운트 2(N1·N2)");
await page.evaluate(() => document.querySelector('#allpins-tabs [data-series="checkboard"]').click());
await page.waitForFunction(() => document.getElementById("allpins-drawer").classList.contains("on"), { timeout: 8000 }).catch(() => {});
await sleep(400);

/* ══ B. 검색 중 전체 선택 = 보이는 것만 ══ */
// 라벨 "3" 은 C3("3") 하나만 포함(다른 라벨 1·2·102 는 "3"을 포함하지 않음 — 유일 매치 보장)
await page.evaluate(() => { const i = document.getElementById("allpins-search-input"); i.value = "3"; i.dispatchEvent(new Event("input")); });
await sleep(150);
await page.evaluate(() => document.getElementById("allpins-select-all").click());
await sleep(100);
{
  const n = await page.evaluate(() => window.__T.AllPins.selected.size);
  ok(n === 1, "B 검색('3') 중 전체 선택 → 보이는 1개만 선택됨 — " + n);
}
await page.evaluate(() => { const i = document.getElementById("allpins-search-input"); i.value = ""; i.dispatchEvent(new Event("input")); });
await page.evaluate(() => document.getElementById("allpins-select-clear").click());
await sleep(100);
ok((await page.evaluate(() => window.__T.AllPins.selected.size)) === 0, "B 선택 해제 → 0개");

/* ══ C. 번호 다시 매기기 — 순서(목록/위치) · 대역 밖 경고 · 중복 경고 · 적용(labelManual) · 되돌리기 ══ */
// CD(id14, label "102")는 선택하지 않는다 — "대상 밖" 핀으로 남겨 재채번 결과(102)와의 충돌을 유도.
await page.evaluate(() => {
  [11, 12, 13].forEach((id) => {
    const cb = document.querySelector('.allpins-sel[data-id="' + id + '"]');
    if (cb) { cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); }
  });
});
await sleep(100);
ok((await page.evaluate(() => window.__T.AllPins.selected.size)) === 3, "C 사전 선택: C1·C2·C3 3개(CD 제외)");
await page.evaluate(() => document.getElementById("allpins-btn-renumber").click());
await page.waitForFunction(() => { const m = document.getElementById("allpins-renumber-sheet"); return m && !m.classList.contains("hidden"); }, { timeout: 5000 });
await sleep(150);
{
  const startDefault = await page.evaluate(() => document.getElementById("arn-start").value);
  ok(startDefault === "1", "C 기본 시작번호 = 내 번호 대역 시작(대역1 → 1) — " + startDefault);
}
// 목록순(기본) 미리보기: idx 순서 C1(11)→C2(12)→C3(13)→CD 는 선택 없음=전체 4개 대상
await sleep(100);
const listPreview = await page.evaluate(() => document.getElementById("arn-preview").textContent);
ok(/1 → 1/.test(listPreview) && /2 → 2/.test(listPreview), "C 목록순 미리보기: 1→1, 2→2(변화 없음, idx 순서) — " + listPreview);
// 위치순으로 바꾸면 C3(y=10, 맨 위)가 1번째로 와서 미리보기가 달라진다
await page.evaluate(() => { const r = document.querySelector('input[name="arn-order"][value="pos"]'); r.checked = true; r.dispatchEvent(new Event("change")); });
await sleep(100);
const posPreview = await page.evaluate(() => document.getElementById("arn-preview").textContent);
ok(posPreview !== listPreview, "C 위치순 미리보기가 목록순과 다르다(공간순 재정렬 확인) — " + posPreview);
// 시작번호 101(대역1 밖) + 결과 102 가 CD(기존 102)와 충돌 → 두 경고 모두 노출
await page.evaluate(() => document.querySelector('input[name="arn-order"][value="list"]').click());
await page.evaluate(() => { const i = document.getElementById("arn-start"); i.value = "101"; i.dispatchEvent(new Event("input")); });
await sleep(120);
{
  const bandHidden = await page.evaluate(() => document.getElementById("arn-band-warn").classList.contains("hidden"));
  const dupHidden = await page.evaluate(() => document.getElementById("arn-dup-warn").classList.contains("hidden"));
  const dupText = await page.evaluate(() => document.getElementById("arn-dup-warn").textContent);
  ok(!bandHidden, "C 대역 밖(101, 내 대역 1) 경고 노출");
  ok(!dupHidden && /1개/.test(dupText), "C 중복 경고 노출(CD=102 와 충돌 1건) — " + dupText);
}
await page.evaluate(() => { window.__confirmLog.length = 0; });
await page.evaluate(() => document.getElementById("arn-apply").click());
await sleep(250);
{
  const confirmN = await page.evaluate(() => window.__confirmLog.length);
  ok(confirmN === 2, "C 적용 시 대역+중복 확인창 2회(Prompt.confirm) — " + confirmN);
  const pins = await page.evaluate(() => window.__T.State.pins.filter((p) => [11, 12, 13].includes(p.id)).map((p) => [p.id, p.label, !!p.labelManual]));
  ok(pins.every((p) => p[2] === true), "C 적용 후 labelManual=true(동시생성 재채번 보호) — " + JSON.stringify(pins));
  ok(pins.find((p) => p[0] === 11)[1] === "101" && pins.find((p) => p[0] === 13)[1] === "103", "C 라벨 101~103 연속 적용 — " + JSON.stringify(pins));
}
await sleep(150);
const undoBtnExists = await page.evaluate(() => !!document.querySelector(".wm-toast-action"));
ok(undoBtnExists, "C 적용 후 토스트에 [되돌리기] 버튼 노출");
await page.evaluate(() => document.querySelector(".wm-toast-action").click());
await sleep(150);
{
  const pins = await page.evaluate(() => window.__T.State.pins.filter((p) => [11, 12, 13].includes(p.id)).map((p) => [p.id, p.label]));
  ok(pins.find((p) => p[0] === 11)[1] === "1" && pins.find((p) => p[0] === 13)[1] === "3", "C 되돌리기 → 원래 라벨 복원 — " + JSON.stringify(pins));
}

/* ══ D. 선택 삭제 — 기존 일괄삭제 재인증 경로(Auth.ensureReauth)를 탄다(스텁) ══ */
// 드로어는 C 구간 이후로도 계속 열려 있다 — 여기서 다시 toggle()하면 닫혀버린다(toggle = open?hide:show).
ok((await page.evaluate(() => window.__T.AllPins.open)) === true, "D 드로어가 계속 열려 있음(토글 금지 확인)");
await page.evaluate(() => { const cb = document.querySelector('.allpins-sel[data-id="12"]'); if (cb) { cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); } });
await sleep(100);
ok((await page.evaluate(() => document.getElementById("allpins-btn-delete").textContent)) === "선택 삭제 1개", "D 선택 1개 → 버튼 라벨 '선택 삭제 1개'");
await page.evaluate(() => { window.__reauthAns = false; window.__confirmAns = true; window.__reauthCalls = 0; });
await page.evaluate(() => document.getElementById("allpins-btn-delete").click());
await sleep(200);
{
  const still = await page.evaluate(() => window.__T.State.pins.some((p) => p.id === 12));
  const calls = await page.evaluate(() => window.__reauthCalls);
  ok(calls >= 1, "D 삭제 클릭 → Auth.ensureReauth 호출됨(재인증 경로 탐) — 호출 " + calls + "회");
  ok(still, "D 재인증 거부(false) → 삭제되지 않음(핀 12 그대로)");
}
await page.evaluate(() => { window.__reauthAns = true; });
await page.evaluate(() => document.getElementById("allpins-btn-delete").click());
await sleep(250);
{
  const gone = await page.evaluate(() => !window.__T.State.pins.some((p) => p.id === 12));
  ok(gone, "D 재인증 성공 → App.deletePins 경로로 실제 삭제(핀 12 제거)");
}

/* ══ E. 권한 — 열람자/일반 디자이너는 버튼 숨김 ══ */
await page.evaluate(() => {
  window.__T.Auth.projectCanManage = false; // 소유자·super 아님
  window.__T.AllPins.render();
});
await sleep(100);
ok((await page.evaluate(() => document.getElementById("allpins-btn-delete").classList.contains("hidden"))), "E 일반 디자이너(소유자 아님) → 선택 삭제 버튼 숨김");
ok(!(await page.evaluate(() => document.getElementById("allpins-btn-renumber").classList.contains("hidden"))), "E 일반 디자이너 → 번호 다시 매기기는 보임(디자이너 이상 허용)");
await page.evaluate(() => {
  window.__T.Auth.readonly = true; // 열람전용 세션
  window.__T.AllPins.render();
});
await sleep(100);
{
  const cbCount = await page.evaluate(() => document.querySelectorAll(".allpins-sel").length);
  const selbarHidden = await page.evaluate(() => document.getElementById("allpins-selectbar").classList.contains("hidden"));
  const actHidden = await page.evaluate(() => document.getElementById("allpins-actions").classList.contains("hidden"));
  ok(cbCount === 0, "E 열람전용 → 카드 체크박스 0개 — " + cbCount);
  ok(selbarHidden, "E 열람전용 → 선택 바 숨김");
  ok(actHidden, "E 열람전용 → 액션 바(삭제·재채번) 숨김");
}
await page.evaluate(() => { window.__T.Auth.projectCanManage = true; window.__T.Auth.readonly = false; window.__T.AllPins.render(); });

/* ══ F. 대비 — [이름순] 활성 상태 ≥4.5:1(p100 전수 감사와 별개로 이 파일에서도 1건 직접 실측) ══ */
await sleep(100);
await page.evaluate(() => document.querySelector('.allpins-sort-btn[data-sort="name"]').click());
await sleep(100);
{
  const r = await page.evaluate(() => {
    function parse(s) { const m = s.match(/rgba?\(([^)]+)\)/); const a = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: a[0], g: a[1], b: a[2], a: a.length > 3 ? a[3] : 1 }; }
    function over(f, b) { return { r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a) }; }
    function L(c) { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); }
    const el = document.querySelector('.allpins-sort-btn[data-sort="name"]');
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    let bg = { r: 255, g: 255, b: 255 };
    for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; const p = parse(c); if (p.a > 0) { bg = over(p, bg); if (p.a >= 1) break; } }
    const a = L(over(fg, bg)), b = L(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  ok(r >= 4.5, "F [이름순] 활성 버튼 글자 대비 ≥4.5:1 — 실측 " + r.toFixed(2) + ":1");
}
await page.screenshot({ path: path.join(SHOTS, "desktop-renumber-and-tabs.png") }).catch(() => {});

/* ══ G. 모바일 375 — 체크박스 터치 타깃 ≥32px, 모드탭/시트 스크린샷 ══ */
// [주의] 같은 페이지에서 isMobile/hasTouch 를 뒤늦게 바꾸면 puppeteer 가 내부적으로
//  navigation 대기를 걸어 타임아웃이 난다(p100 은 newPage() 직후, 아직 goto 전에만 지정) —
//  여기서는 단순 폭만 줄여 측정한다(터치 에뮬레이션은 측정에 불필요).
await page.setViewport({ width: 375, height: 812 });
await sleep(200);
{
  const sz = await page.evaluate(() => { const l = document.querySelector(".allpins-sel-wrap"); if (!l) return null; const r = l.getBoundingClientRect(); return { w: r.width, h: r.height }; });
  ok(sz && sz.w >= 32 && sz.h >= 32, "G 모바일 375: 체크박스 터치 타깃 ≥32px — " + JSON.stringify(sz));
}
await page.screenshot({ path: path.join(SHOTS, "mobile-375-allpins.png") }).catch(() => {});

ok(errs.length === 0, "페이지 예외 0건 — " + JSON.stringify(errs.slice(0, 3)));
await browser.close();
server.close();

console.log(failed ? `\n${failed} FAIL` : "\nALL PASS");
process.exit(failed ? 1 : 0);
