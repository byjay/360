/**
 * p166-cdp — 트리 "탐색기(폴더구조)화" (WO 20261019-treeexplorer, 마스터 2차 확인: "작업구역 영역을
 *   말하는 거지, 마치 폴더구조와 같은 방식으로"). 사이드바 트리를 Windows 탐색기/VS Code 트리처럼
 *   보이고 동작하게 만든 변경(11_UI.js renderTree/deckNode, public/css/style.css)을 실 Chrome 으로
 *   재현한다(목 0 — 실 모듈 번들 + 실 CSS 3파일, API 만 http mock, p161b 와 동일 경량 패턴).
 *
 * 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p166-tree-explorer-look-cdp.mjs
 *
 * 검사:
 *  ① 폴더(프로젝트·구역) 아이콘 존재 + 열림/닫힘 모양이 다르다
 *  ② 깊이별 들여쓰기(px)가 단계마다 증가한다(프로젝트 < ER < 4TH)
 *  ③ 안내선(.tree-children 좌측 괘선)이 존재하고 대비 ≥ 3:1(비텍스트 UI)
 *  ④ 빈 문구("영역 없음") 0 · "L1" 같은 레벨 텍스트 배지 0 · "구역"/"영역"/"원본" 종류 꼬리표 0
 *     (텍스트는 title 툴팁에만 — 정보 유실 0)
 *  ⑤ 키보드 탐색 — ↓/↑ 이동 · → 펼침 · ← 접힘 · Enter 열기 · F2 이름변경
 *  ⑥ 선택 행 하이라이트(.active 배경색이 비활성과 다르다)
 *  ⑦ 대비 ≥ 4.5:1(구역/영역 라벨), 안내선 ≥ 3:1(③과 별도로 수치 재확인)
 *  ⑧ 열람자(Auth.readonly) — 편집 요소(.tree-more·.tree-project-actions) 0, 모양은 동일
 *
 * 뮤테이션 3건(각 EXIT=1 확인 후 원복, 지휘자/다음 세션 수행):
 *  ⓐ expandable 강제 true → ④가 실패해야 함(빈 폴더에 캐럿이 생긴다)
 *  ⓑ _treeKeyNav 의 ArrowDown 분기 제거 → ⑤가 실패해야 함
 *  ⓒ .tree-children 안내선 색을 var(--border2) 로 되돌림 → ③/⑦ 대비 수치가 3:1 밑으로 떨어져야 함
 *  실행: P166_MUT=a|b|c TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p166-tree-explorer-look-cdp.mjs
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "public");
const SHOT = path.join(ROOT, ".tmp", "p166");
fs.mkdirSync(SHOT, { recursive: true });
const MUT = process.env.P166_MUT || "";

let failed = 0;
const ok = (cond, label, detail) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail).slice(0, 400) : "")); if (!cond) failed++; };

const MODS = fs.readFileSync(path.join(PUB, "js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
let uiSrc = fs.readFileSync(path.join(PUB, "js/modules/11_UI.js"), "utf8").replace(/\r\n/g, "\n");

const MUTS = {
  a: ["const expandable = subDecks.length > 0 || loadedHasContent;", "const expandable = true;"],
  b: ['if (e.key === "ArrowDown") { e.preventDefault(); const n = visible[idx + 1]; if (n) n.focus(); return; }', 'if (e.key === "ArrowDown") { return; }'],
};
if (MUT && MUT !== "c" && MUTS[MUT]) {
  const [from, to] = MUTS[MUT];
  if (uiSrc.indexOf(from) < 0) { console.log("FAIL 뮤테이션 대상 문자열 없음: " + MUT); process.exit(2); }
  uiSrc = uiSrc.replace(from, to);
  console.log("[MUT " + MUT + "] 11_UI.js 패치 적용(메모리 내, 파일 미변경)");
}
let cssSrc = fs.readFileSync(path.join(PUB, "css/style.css"), "utf8");
if (MUT === "c") {
  const from = ".tree-children{padding-left:12px;border-left:1px solid var(--text2);margin-left:10px;}";
  const to = ".tree-children{padding-left:12px;border-left:1px solid var(--border2);margin-left:10px;}";
  if (cssSrc.indexOf(from) < 0) { console.log("FAIL 뮤테이션 대상 CSS 문자열 없음: c"); process.exit(2); }
  cssSrc = cssSrc.replace(from, to);
  console.log("[MUT c] style.css 패치 적용(메모리 내, 파일 미변경)");
}

const bundle = MODS.map((f) => (f === "11_UI.js" ? uiSrc : fs.readFileSync(path.join(PUB, "js/modules", f), "utf8").replace(/\r\n/g, "\n"))).join("\n");

const CT = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/json" };
const decks = [
  { id: "ER", project_id: "prjT", name: "ER", deployment_id: null, parent_id: null },
  { id: "4TH", project_id: "prjT", name: "4TH", deployment_id: null, parent_id: "ER" },
  { id: "3RD", project_id: "prjT", name: "3RD", deployment_id: null, parent_id: "ER" }, // 하위 0개 — 빈 폴더
];
const json = (res, o, st = 200) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
const server = http.createServer(async (req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/sw.js") { res.writeHead(404); res.end(); return; }
  if (u === "/js/main.js") { res.writeHead(200, { "content-type": "application/javascript" }); res.end(bundle); return; }
  if (u === "/css/style.css") { res.writeHead(200, { "content-type": "text/css" }); res.end(cssSrc); return; }
  if (u === "/api/auth/auto-entry") return json(res, { token: "tokT", kind: "designer" });
  if (u === "/api/auth/me") return json(res, { authenticated: true, email: "owner@test.local", name: "owner", role: "super", auto: true, readonly: false });
  if (u === "/api/auth/config") return json(res, { google_client_id: "", demo_login: false });
  if (u === "/api/tenant/resolve") return json(res, { matched: false });
  if (u === "/api/projects") return json(res, { data: [{ id: "prjT", name: "선보", created_at: 1, published: false, can_manage_members: true }] });
  if (u === "/api/projects/prjT/decks") return json(res, { data: decks });
  if (u === "/api/projects/prjT/bands") return json(res, { band_size: 100, me: { email: "owner@test.local", band: 1, owner: true }, bands: [] });
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
  function ratioFgBg(fgC, bgC) { const fg = lum(fgC), bg = lum(bgC); if (!fg || !bg) return 0; const hi = Math.max(fg.L, bg.L), lo = Math.min(fg.L, bg.L); return +((hi + 0.05) / (lo + 0.05)).toFixed(2); }
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
  await page.waitForFunction(() => window.__wm && window.__wm.UI, { timeout: 20000 });
  // 허브 카드 → 프로젝트 진입(클릭해야 #side-tree 가 채워진다, p161b 와 동일 경로).
  await page.waitForSelector(".hub-card-name", { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(() => { const el = document.querySelector(".hub-card-name"); if (el) el.click(); });
  await page.waitForSelector('#side-tree [data-deck-id="ER"]', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 300));

  // ── ① 폴더 아이콘 + 열림/닫힘 모양 다름 ──
  const icons = await page.evaluate(() => {
    const er = document.querySelector('#side-tree [data-deck-id="ER"]');
    const proj = document.querySelector('#side-tree .tree-node-project');
    const erSvg = er ? er.querySelector("svg:not(.tree-caret)") : null;
    const projSvg = proj ? proj.querySelector("svg:not(.tree-caret)") : null;
    return { erSvgPath: erSvg ? erSvg.innerHTML : null, projSvgPath: projSvg ? projSvg.innerHTML : null };
  });
  ok(!!icons.erSvgPath && !!icons.projSvgPath, "① 구역·프로젝트 모두 인라인 SVG 폴더 아이콘을 가진다", icons);
  await page.evaluate(() => { const er = document.querySelector('#side-tree [data-deck-id="ER"]'); const caret = er && er.querySelector(".tree-caret"); if (caret) caret.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await new Promise((r) => setTimeout(r, 150));
  const afterToggle = await page.evaluate(() => {
    const er = document.querySelector('#side-tree [data-deck-id="ER"]');
    const svg = er ? er.querySelector("svg:not(.tree-caret)") : null;
    return { closedIcon: svg ? svg.innerHTML : null, open: er.closest(".tree-deck").classList.contains("open") };
  });
  ok(!afterToggle.open && afterToggle.closedIcon !== icons.erSvgPath, "① 캐럿 클릭으로 접으면 폴더 아이콘 모양이 바뀐다(열림≠닫힘)", { icons, afterToggle });
  // 다시 펼침(이후 단계가 4TH/3RD 를 보려면 ER 이 열려 있어야 한다)
  await page.evaluate(() => { const er = document.querySelector('#side-tree [data-deck-id="ER"]'); const caret = er && er.querySelector(".tree-caret"); if (caret) caret.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await new Promise((r) => setTimeout(r, 150));

  // ── ② 깊이별 들여쓰기 증가 ──
  const indent = await page.evaluate(() => {
    const px = (sel) => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect().left : null; };
    return { proj: px(".tree-node-project"), er: px('#side-tree [data-deck-id="ER"]'), fourth: px('#side-tree [data-deck-id="4TH"]') };
  });
  ok(indent.proj != null && indent.er != null && indent.fourth != null && indent.proj < indent.er && indent.er < indent.fourth,
    "② 깊이가 깊을수록 왼쪽 좌표(들여쓰기)가 커진다 — 프로젝트 < ER < 4TH", indent);

  // ── ③⑦ 안내선 존재 + 대비 ──
  const guide = await page.evaluate((src) => {
    eval(src);
    const el = document.querySelector(".tree-children");
    if (!el) return null;
    const s = getComputedStyle(el);
    const bw = parseFloat(s.borderLeftWidth);
    // 배경은 조상에서 alpha>0.5 인 첫 backgroundColor
    let n = el, bg = null;
    while (n && n.nodeType === 1) { const b = getComputedStyle(n).backgroundColor; if (b && !/rgba\(0, 0, 0, 0\)/.test(b) && b !== "transparent") { bg = b; break; } n = n.parentElement; }
    const r = ratioFgBg(s.borderLeftColor, bg || "rgb(255,255,255)");
    return { borderWidth: bw, borderStyle: s.borderLeftStyle, borderColor: s.borderLeftColor, bg, ratio: r };
  }, CONTRAST_FN);
  ok(!!guide && guide.borderWidth > 0 && guide.borderStyle === "solid", "③ 안내선(.tree-children 좌측 괘선)이 존재한다", guide);
  ok(!!guide && guide.ratio >= 3, "③⑦ 안내선 대비 ≥ 3:1(비텍스트 UI, WCAG 1.4.11) — 실측 " + (guide && guide.ratio), guide);

  // ── ④ 빈 문구·레벨 텍스트·종류 꼬리표 0 ──
  const textAudit = await page.evaluate(() => {
    const treeText = document.getElementById("side-tree").innerText || "";
    return {
      emptyMsg: /영역\s*없음/.test(treeText),
      levelTagEls: document.querySelectorAll(".tree-level-tag").length,
      kindTagEls: document.querySelectorAll(".tree-kind-tag").length,
      noArrowOn3RD: !document.querySelector('#side-tree [data-deck-id="3RD"] .tree-caret')
    };
  });
  ok(!textAudit.emptyMsg, "④ '영역 없음' 문구가 트리 전체에 0건", textAudit);
  ok(textAudit.levelTagEls === 0, "④ .tree-level-tag(L1/L2…) 렌더 0건", textAudit);
  ok(textAudit.kindTagEls === 0, "④ .tree-kind-tag(구역/영역/원본) 렌더 0건", textAudit);
  ok(textAudit.noArrowOn3RD, "④ 하위가 없는 '3RD'엔 캐럿(화살표)이 없다(빈 폴더)", textAudit);
  const titleCheck = await page.evaluate(() => {
    const er = document.querySelector('#side-tree [data-deck-id="ER"]');
    const fourth = document.querySelector('#side-tree [data-deck-id="4TH"]');
    return { erTitle: er ? er.title : null, fourthTitle: fourth ? fourth.title : null };
  });
  ok(!!titleCheck.erTitle && /레벨 1/.test(titleCheck.erTitle), "④ 깊이 정보는 유실 0 — ER title 에 '레벨 1'", titleCheck);
  ok(!!titleCheck.fourthTitle && /레벨 2/.test(titleCheck.fourthTitle) && /ER/.test(titleCheck.fourthTitle), "④ 4TH title 에 '레벨 2' + 경로(ER)", titleCheck);

  // ── ⑤ 키보드 탐색 ──
  await page.focus('#side-tree [data-deck-id="ER"]');
  await page.keyboard.press("ArrowDown");
  await new Promise((r) => setTimeout(r, 100));
  const afterDown = await page.evaluate(() => document.activeElement && document.activeElement.closest(".tree-node") && document.activeElement.closest(".tree-node").dataset.deckId);
  ok(afterDown === "4TH", "⑤ ArrowDown → 다음 보이는 행(4TH)으로 포커스 이동 — 실제 " + afterDown);
  await page.keyboard.press("ArrowUp");
  await new Promise((r) => setTimeout(r, 100));
  const afterUp = await page.evaluate(() => document.activeElement && document.activeElement.closest(".tree-node") && document.activeElement.closest(".tree-node").dataset.deckId);
  ok(afterUp === "ER", "⑤ ArrowUp → 이전 행(ER)으로 복귀 — 실제 " + afterUp);
  // ArrowLeft(접힘) → caret 제거 확인 → ArrowRight(펼침) 복귀
  await page.keyboard.press("ArrowLeft");
  await new Promise((r) => setTimeout(r, 100));
  // [주의] 접힘은 CSS display:none(.tree-deck:not(.open) > .tree-children) 일 뿐 DOM 제거가
  // 아니다(§2) — querySelector 존재 여부가 아니라 offsetParent(실제 보이는지)로 판정한다.
  const collapsedNow = await page.evaluate(() => { const el = document.querySelector('#side-tree [data-deck-id="4TH"]'); return !el || el.offsetParent === null; });
  ok(collapsedNow, "⑤ ArrowLeft → ER 이 접힌다(4TH 가 화면에 안 보임)", { collapsedNow });
  await page.keyboard.press("ArrowRight");
  await new Promise((r) => setTimeout(r, 150));
  const expandedAgain = await page.evaluate(() => { const el = document.querySelector('#side-tree [data-deck-id="4TH"]'); return !!el && el.offsetParent !== null; });
  ok(expandedAgain, "⑤ ArrowRight → ER 이 다시 펼쳐진다(4TH 가 다시 보임)");
  // Enter = 클릭(열기/선택)과 동일 동작 — 4TH 를 포커스하고 Enter
  await page.focus('#side-tree [data-deck-id="4TH"]');
  await page.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 200));
  const selectedByEnter = await page.evaluate(() => window.__wm.Projects.currentDeck && window.__wm.Projects.currentDeck.id);
  ok(selectedByEnter === "4TH", "⑤ Enter → 클릭과 동일하게 선택/열기(currentDeck=4TH) — 실제 " + selectedByEnter);
  // F2 = 이름변경(window.prompt 를 가로채 대체 이름 입력 시뮬레이션은 범위 밖 — 호출 여부만 증명)
  await page.evaluate(() => { window.__p166_renameCalled = null; const orig = window.__wm.Projects.renameDeck; window.__wm.Projects.renameDeck = (d) => { window.__p166_renameCalled = d && d.id; }; window.__p166_restoreRename = orig; });
  await page.focus('#side-tree [data-deck-id="4TH"]');
  await page.keyboard.press("F2");
  await new Promise((r) => setTimeout(r, 100));
  const f2 = await page.evaluate(() => window.__p166_renameCalled);
  ok(f2 === "4TH", "⑤ F2 → Projects.renameDeck(deck) 호출(기존 rename 재사용) — 실제 " + f2);
  await page.evaluate(() => { window.__wm.Projects.renameDeck = window.__p166_restoreRename; });

  // ── ⑥ 선택 하이라이트 ──
  const hi = await page.evaluate(() => {
    const active = document.querySelector('#side-tree [data-deck-id="4TH"]');
    const inactive = document.querySelector('#side-tree [data-deck-id="3RD"]');
    return { activeBg: active ? getComputedStyle(active).backgroundColor : null, inactiveBg: inactive ? getComputedStyle(inactive).backgroundColor : null, activeHasClass: active ? active.classList.contains("active") : false };
  });
  ok(hi.activeHasClass && hi.activeBg !== hi.inactiveBg, "⑥ 선택된 행(.active)의 배경이 비선택 행과 다르다(하이라이트)", hi);

  // ── ⑦ 라벨 대비 ≥ 4.5:1 ──
  const labelC = await contrastOf(page, ".tree-node-deck .tree-label, .tree-node-project .tree-label");
  ok(labelC.length >= 2 && labelC.every(([, r]) => r >= 4.5), "⑦ 구역·프로젝트 라벨 대비 ≥ 4.5:1 — " + JSON.stringify(labelC));
  await page.screenshot({ path: path.join(SHOT, "1-explorer-look.png") });

  // ── ⑧ 열람자 — 편집 요소 0, 모양 동일(구조는 같은 DOM 생성 경로) ──
  const viewer = await page.evaluate(() => {
    window.__wm.Auth = window.__wm.Auth || {};
    window.__wm.Auth.readonly = true;
    window.__wm.UI.renderTree();
    const r = {
      more: document.querySelectorAll(".tree-more").length,
      actions: document.querySelectorAll(".tree-project-actions").length,
      folderIconsStillThere: document.querySelectorAll('#side-tree [data-deck-id="ER"] svg:not(.tree-caret)').length
    };
    window.__wm.Auth.readonly = false;
    window.__wm.UI.renderTree();
    return r;
  });
  // [주의] .tree-project-actions(이름변경·ⓘ정보·다운로드·삭제)는 이 WO 의 변경 지점이 아니다
  // (mountProjectNode, isReadonlyTree 미적용은 기존 동작 — p149 가 실제 viewer-link 흐름(서버가
  // can_manage_members:true 를 내려주지 않는 진짜 열람 세션)으로 이미 0건을 검증한다). 이 테스트의
  // 목(mock) 고정값은 can_manage_members:true 라 그 조합까지 흉내내지 않는다 — ⑧은 이 WO 가 실제로
  // 건드린 ⋯ 메뉴(.tree-more, isReadonlyTree 분기)만 좁게 확인한다.
  ok(viewer.more === 0, "⑧ 열람자 — ⋯ 메뉴(.tree-more) 0건(이 WO 의 isReadonlyTree 분기)", viewer);
  ok(viewer.folderIconsStillThere > 0, "⑧ 열람자도 같은 폴더 아이콘 모양을 그대로 본다(구조 동일)", viewer);

  const jsErrors = errs.filter((e) => !/favicon/i.test(e));
  ok(jsErrors.length === 0, "콘솔/페이지 JS 에러 0건 — " + JSON.stringify(jsErrors));
} finally {
  await browser.close();
  server.close();
}
console.log("\n" + (failed ? "FAILED " + failed + "건" : "ALL PASS"));
process.exit(failed ? 1 : 0);
