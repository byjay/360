/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p65-tree-list-expanded.test.mjs)
 *
 * [WO 20260928-tree-expand] 🔴 마스터 스크린샷 지적 — "구역·영역을 리스트로 나오게 하라.
 *  구역 하단에, 영역 하단에." 실태 3가지:
 *   1) 구역 이름이 안 보인다(빈 사각형만) 2) 접혀 있다(펼쳐야 보임) 3) 영역 리스트가 없다.
 *
 * 근본원인(실측 — 프로덕션 D1 조회, RECON 불필요 재확인):
 *  · 프로젝트 "tes"(prj_mualgkjv_iza33imy)의 유일한 구역 이름은 실제로 "ㅁ"(한글 자음, 네모 모양) —
 *    데이터가 비어있는 게 아니라 정직하게 그 값을 렌더한 것이었다(D1: decks.name='ㅁ'). "이름 누락"이
 *    아니라 "이름이 네모처럼 생긴 한 글자"였다. 이름 표시 로직 자체는 이미 폴백이 있었으나
 *    ("구역"/"영역" 이라는 타입명 폴백), 마스터가 요구한 "이름 없음" 문구는 아니었다 → 교체.
 *  · 진짜 결함은 펼침/영역 목록 쪽: deckNode() 가 (loaded || subDecks.length) 조건에서만
 *    "open" 클래스를 주고, 그 조건이 거짓이면 kids 컨테이너 자체를 만들지 않았다(any=false).
 *    이 프로젝트의 구역은 subDecks=0, loaded=false(로드된 배포본 아님) → 열 것도, 보여줄 것도
 *    없어 "접힌 채 아무 내용 없음"으로 보였다 — 캐럿을 눌러도 펼쳐질 콘텐츠가 없었다.
 *
 * 검사:
 *  ① 기본 펼침 상태로 렌더(구역·영역 모두, 클릭 없이 .open)
 *  ② 접기/펼치기 동작 유지 — 클릭으로 토글되고, 재렌더에도 사용자가 닫은 상태가 유지된다
 *  ③ 🔴 구역 이름이 표시된다 — 이름 있으면 그대로, 없으면(빈 문자열/undefined) "이름 없음"
 *  ④ 구역 아래 영역이 리스트로 나열된다
 *  ⑤ 영역 0개면 "영역 없음"으로 표시(숨기지 않음)
 *  ⑥ 구역·영역 시각 구분(.tree-node-deck vs .tree-node-region, 아이콘 다름)
 *  ⑦ 🔴 parent_id NULL 인 deck 40개가 전부 구역으로 표시(데이터 유실 0)
 *  ⑧ 모바일 375x812 실브라우저 — #side-tree scrollHeight > clientHeight, 스크롤 끝 도달
 *  ⑨ 기존 회귀 0(p62·p49·p56 각각 별도 프로세스로 실행, exit 0)
 *
 * 뮤테이션 3건, 각 EXIT=1 확인 후 원복:
 *  ⓐ 기본 접힘으로 되돌림 → ①이 실패해야 함
 *  ⓑ "이름 없음" 대체문구 제거 → ③이 실패해야 함
 *  ⓒ 구역 아래 영역 나열 로직 제거 → ④가 실패해야 함
 *
 * 목(mock) 범위: Part A/뮤테이션은 실제 11_UI.js 소스를 vm 에 그대로 평가(DOM만 최소 목,
 * p62 와 동일 패턴). Part C 는 실제 Chrome(Puppeteer)에서 실제 public/css/style.css 와
 * 실제 public/js/modules/11_UI.js 를 그대로 로드해 레이아웃을 실측한다(다른 팀이 수정 중인
 * public/js/main.js·20_App.js·31_Projects.js 는 로드하지 않는다 — 그 WIP 상태에 결과가
 * 좌우되지 않게 하기 위함. 11_UI.js 는 $/escapeHtml 을 자체 보유해 독립 실행 가능하다).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const uiSrc = rd("public/js/modules/11_UI.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ══════════════════════════════════════════════════════════════════════
 * Part A — 트리 렌더 (실제 11_UI.js · 최소 DOM 목, p62 와 동일 패턴)
 * ══════════════════════════════════════════════════════════════════════ */
function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => x && set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle(c, force) {
      if (force === undefined) { if (set.has(c)) { set.delete(c); return false; } set.add(c); return true; }
      if (force) set.add(c); else set.delete(c);
      return !!force;
    },
    contains: (c) => set.has(c),
    _set: set
  };
}
function makeEl(tag) {
  const el = {
    tagName: tag || "div", style: {}, dataset: {}, title: "", value: "", disabled: false,
    _text: "", _html: "", _children: [], _handlers: {},
    appendChild(c) { this._children.push(c); return c; },
    setAttribute(k, v) { this.dataset["attr_" + k] = String(v); },
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    click(caret) {
      const target = caret ? { closest: (s) => (s === ".tree-caret" ? {} : null) } : { closest: () => null };
      (this._handlers.click || []).forEach((fn) => fn({ target, stopPropagation() {} }));
    },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
  };
  Object.defineProperty(el, "textContent", { get() { return this._text; }, set(v) { this._text = v == null ? "" : String(v); } });
  Object.defineProperty(el, "innerHTML", { get() { return this._html; }, set(v) { this._html = String(v); if (v === "") this._children = []; } });
  Object.defineProperty(el, "className", {
    get() { return Array.from(this.classList._set).join(" "); },
    set(v) { this.classList = makeClassList(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c)); }
  });
  el.classList = makeClassList();
  return el;
}
function makeDoc() {
  const registry = {};
  return {
    registry,
    document: {
      getElementById: (id) => (registry[id] = registry[id] || makeEl()),
      createElement: (t) => makeEl(t),
      querySelectorAll: () => [],
      addEventListener() {}
    }
  };
}
function makeUI(src, ctx) {
  const { document, registry } = makeDoc();
  const sandbox = { console, document, JSON, Map, Set, ...ctx };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__UI = UI;", sandbox);
  return { UI: sandbox.__UI, registry };
}
const has = (el, cls) => new RegExp("(^| )" + cls + "( |$)").test(el.className || "");
const kidsOf = (el) => (el._children || []).find((c) => has(c, "tree-children"));
const pick = (el, cls) => (el._children || []).filter((c) => has(c, cls));
function findAll(el, cls, out) {
  out = out || [];
  (el._children || []).forEach((c) => { if (has(c, cls)) out.push(c); findAll(c, cls, out); });
  return out;
}
function flat(el) { let s = (el._html || "") + (el._text || ""); (el._children || []).forEach((c) => { s += flat(c); }); return s; }

/** 픽스처: 구역 4개 — 영역 있는 구역, 영역 없는 구역, 이름 빈 구역, 이름 null 구역 */
function fx() {
  const State = { mode: "designer", pdfPage: 1, pdfPages: 1, currentDeploymentId: null, activePin: null, zones: [], pins: [] };
  const decks = [
    { id: "d1", name: "메인데크", deployment_id: null, parent_id: null },
    { id: "d1a", name: "평면도", deployment_id: null, parent_id: "d1" },
    { id: "d2", name: "브릿지", deployment_id: null, parent_id: null },
    { id: "d3", name: "", deployment_id: null, parent_id: null },
    { id: "d4", name: null, deployment_id: null, parent_id: null }
  ];
  const selectDeckCalls = [];
  const Projects = { decks, currentProject: { id: "prj1", name: "tes" }, currentDeck: null, selectDeck: (d) => selectDeckCalls.push(d.id) };
  return { State, Projects, selectDeckCalls, Zones: { _contains: () => false, focus() {} }, App: { focusPin() {} } };
}
/** 픽스처: parent_id NULL 인 구역 40개(실측 프로덕션 "40행 전부 구역" 재현) */
function fx40() {
  const State = { mode: "designer", pdfPage: 1, pdfPages: 1, currentDeploymentId: null, activePin: null, zones: [], pins: [] };
  const decks = Array.from({ length: 40 }, (_, i) => ({ id: "dck_" + i, name: "구역" + i, deployment_id: null, parent_id: null }));
  const Projects = { decks, currentProject: { id: "prj1", name: "tes" }, currentDeck: null, selectDeck() {} };
  return { State, Projects, Zones: { _contains: () => false, focus() {} }, App: { focusPin() {} } };
}

console.log("\n[Part A · 트리 렌더 — 실제 11_UI.js]");
{
  const c = fx();
  const { UI, registry } = makeUI(uiSrc, c);
  UI.renderTree();
  const host = registry["side-tree"];
  const proj = pick(host, "tree-project")[0];
  const rootDecks = pick(kidsOf(proj), "tree-deck");
  const d1 = rootDecks.find((d) => /메인데크/.test(d._children[0].innerHTML));
  const d2 = rootDecks.find((d) => /브릿지/.test(d._children[0].innerHTML));
  const d3 = rootDecks[2], d4 = rootDecks[3]; // 이름 순서 보존(d1,d1a는 d1 하위이므로 root는 d1,d2,d3,d4)

  // ① 기본 펼침
  ok(d1.classList.contains("open"), "① 구역(메인데크)이 클릭 없이 기본 .open 상태로 렌더된다");
  ok(d2.classList.contains("open"), "① 영역 없는 구역(브릿지)도 기본 .open 상태다");
  const region1 = pick(kidsOf(d1), "tree-region")[0];
  ok(region1.classList.contains("open"), "① 영역(평면도)도 기본 .open 상태다");

  // ② 접기/펼치기 유지(클릭 토글 + 재렌더에도 유지)
  d1._children[0].click(true); // 캐럿 클릭
  ok(!d1.classList.contains("open"), "② 캐럿 클릭 → 접힘");
  UI.renderTree(); // 재렌더 — 세션 메모리로 접힘 유지되어야 함
  const host2 = registry["side-tree"];
  const proj2 = pick(host2, "tree-project")[0];
  const d1b = pick(kidsOf(proj2), "tree-deck").find((d) => /메인데크/.test(d._children[0].innerHTML));
  ok(!d1b.classList.contains("open"), "② 재렌더 후에도 사용자가 닫은 구역은 닫힌 채로 유지된다(세션 메모리)");
  d1b._children[0].click(true);
  ok(d1b.classList.contains("open"), "② 다시 캐럿 클릭 → 펼침 복귀");

  // ③ 이름 표시 — 있으면 그대로, 없으면 "이름 없음"
  ok(/메인데크/.test(d1._children[0].innerHTML), "③ 이름 있는 구역은 그 이름이 표시된다");
  ok(/이름 없음/.test(d3._children[0].innerHTML), "③ name=''(빈 문자열) 구역은 '이름 없음'으로 표시된다(빈칸 금지)");
  ok(/이름 없음/.test(d4._children[0].innerHTML), "③ name=null 구역도 '이름 없음'으로 표시된다");

  // ④ 구역 아래 영역 리스트
  ok(!!region1 && /평면도/.test(region1._children[0].innerHTML), "④ 구역(메인데크) 아래 영역(평면도)이 리스트로 나열된다");

  // ⑤ 영역 0개 표시
  ok(/영역 없음/.test(flat(kidsOf(d2))), "⑤ 영역이 0개인 구역(브릿지)은 '영역 없음'을 표시한다(숨기지 않음)");
  ok(/영역 없음/.test(flat(kidsOf(d3))), "⑤ 이름 없는 구역도 영역 0개면 '영역 없음' 표시");

  // ⑥ 시각 구분
  ok(d1._children[0].classList.contains("tree-node-deck") && region1._children[0].classList.contains("tree-node-region"),
    "⑥ 구역=.tree-node-deck / 영역=.tree-node-region 으로 클래스가 다르다(아이콘도 ICO.deck/ICO.region 로 다름)");
}

console.log("\n[Part A' · 프로덕션 재현 — parent_id NULL 40개 전부 구역]");
{
  const c = fx40();
  const { UI, registry } = makeUI(uiSrc, c);
  UI.renderTree();
  const host = registry["side-tree"];
  const proj = pick(host, "tree-project")[0];
  const rootDecks = pick(kidsOf(proj), "tree-deck");
  ok(rootDecks.length === 40, "⑦ parent_id NULL 인 deck 40개가 전부 .tree-deck(구역)으로 렌더된다(실제 " + rootDecks.length + "개)");
  const renderedIds = new Set(rootDecks.map((d) => d._children[0].innerHTML.match(/구역(\d+)/)[1]));
  ok(renderedIds.size === 40, "⑦ 40개 전부 이름이 유실 없이 보인다(중복/누락 0)");
}

/* ── 뮤테이션 ⓐ: 기본 접힘으로 되돌림 → ①이 실패해야 한다 ─────────────── */
{
  console.log("\n[뮤테이션ⓐ] 기본 접힘 복원 → ①이 실패해야 함");
  const needle = 'g.className = (isRegion ? "tree-region" : "tree-deck") + (collapsed.has(collapseKey) ? "" : " open");';
  const mut = uiSrc.replace(needle, 'g.className = (isRegion ? "tree-region" : "tree-deck");');
  if (mut === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { UI, registry } = makeUI(mut, fx());
    UI.renderTree();
    const host = registry["side-tree"];
    const proj = pick(host, "tree-project")[0];
    const d1 = pick(kidsOf(proj), "tree-deck").find((d) => /메인데크/.test(d._children[0].innerHTML));
    ok(!d1.classList.contains("open"), "뮤테이션 적용 시 ①이 깨짐(기본 상태가 접힘으로 되돌아감)");
  }
}

/* ── 뮤테이션 ⓑ: "이름 없음" 대체문구 제거 → ③이 실패해야 한다 ───────── */
{
  console.log("\n[뮤테이션ⓑ] '이름 없음' 대체문구 제거 → ③이 실패해야 함");
  const needle = "const _nameLabel = deck.name ? esc(deck.name) : '<span class=\"tree-name-missing\">이름 없음</span>';";
  const mut = uiSrc.replace(needle, "const _nameLabel = esc(deck.name || \"\");");
  if (mut === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { UI, registry } = makeUI(mut, fx());
    UI.renderTree();
    const host = registry["side-tree"];
    const proj = pick(host, "tree-project")[0];
    const rootDecks = pick(kidsOf(proj), "tree-deck");
    const d3 = rootDecks[2];
    ok(!/이름 없음/.test(d3._children[0].innerHTML), "뮤테이션 적용 시 ③이 깨짐(빈 이름 구역이 대체문구 없이 빈칸으로 남는다)");
  }
}

/* ── 뮤테이션 ⓒ: 구역 아래 영역 나열 로직 제거 → ④가 실패해야 한다 ───── */
{
  console.log("\n[뮤테이션ⓒ] 구역 아래 영역 나열 로직 제거 → ④가 실패해야 함");
  const needle = `if (!isRegion) {
          if (subDecks.length) subDecks.forEach((cd) => { kids.appendChild(deckNode(cd, true)); });
          else { const eEl = document.createElement("p"); eEl.className = "tree-empty"; eEl.textContent = "영역 없음"; kids.appendChild(eEl); }
          any = true;
        } else if (subDecks.length) {
          subDecks.forEach((cd) => { kids.appendChild(deckNode(cd, true)); });
          any = true;
        }`;
  const mut = uiSrc.replace(needle, `if (false) { subDecks.forEach(() => {}); }`);
  if (mut === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { UI, registry } = makeUI(mut, fx());
    UI.renderTree();
    const host = registry["side-tree"];
    const proj = pick(host, "tree-project")[0];
    const d1 = pick(kidsOf(proj), "tree-deck").find((d) => /메인데크/.test(d._children[0].innerHTML));
    const regions = kidsOf(d1) ? pick(kidsOf(d1), "tree-region") : [];
    ok(regions.length === 0, "뮤테이션 적용 시 ④가 깨짐(구역 아래 영역 리스트가 사라진다)");
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * Part C — 실제 Chrome(Puppeteer) 375x812 — 실제 CSS + 실제 11_UI.js 로드
 *  (다른 팀이 WIP 중인 main.js/20_App.js/31_Projects.js 는 로드하지 않는다)
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[Part C · 실 브라우저 375x812 — #side-tree 리스트 + 스크롤 도달]");
const require = createRequire("file:///C:/Users/FREE/package.json");
let puppeteer = null;
try { puppeteer = require("puppeteer"); } catch (e) { puppeteer = null; }
if (!puppeteer) {
  console.log("  FAIL ⑧ puppeteer 를 로드할 수 없다 — 실 브라우저 수치 증명 불가(증거 없는 PASS 금지)");
  failed++;
} else {
  const shotDir = process.env.SHOT_DIR || path.join(os.tmpdir(), "p65-tree-shots");
  fs.mkdirSync(shotDir, { recursive: true });
  const HARNESS = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/css/style.css">
<style>body{background:#161514;margin:0}.sidebar{width:320px}</style>
</head><body>
<aside id="sidebar" class="sidebar">
  <div id="side-tree" class="side-tree"></div>
</aside>
<script src="/js/11_UI.js"></script>
</body></html>`;
  const PUB = path.join(ROOT, "public");
  const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    if (u === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(HARNESS); return; }
    if (u === "/js/11_UI.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(rd("public/js/modules/11_UI.js")); return; }
    const f = path.join(PUB, u);
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
    res.end(fs.readFileSync(f));
  });
  await listenSafePort(server, "127.0.0.1");
  const PORT = server.address().port;
  const browser = await puppeteer.launch({ headless: "new", protocolTimeout: 180000, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.on("pageerror", () => {});
  await page.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "load", timeout: 30000 });
  // 🔴 11_UI.js 는 classic <script> 최상위 `const UI = {...}` — window.UI 가 아니라
  // 문서 전역 렉시컬 스코프에 있다(같은 문서의 이후 <script> 블록에서는 UI 로 바로 참조 가능).
  await page.waitForFunction(() => { try { return typeof UI !== "undefined"; } catch (e) { return false; } }, { timeout: 10000 });

  const SETUP = () => {
    window.State = { mode: "designer", pdfPage: 1, pdfPages: 1, currentDeploymentId: null, activePin: null, zones: [], pins: [] };
    const decks = Array.from({ length: 40 }, (_, i) => ({ id: "dck_" + i, name: (i % 7 === 0 ? "" : "구역" + i), deployment_id: null, parent_id: null }));
    decks.push({ id: "dck_r1", name: "평면도", deployment_id: null, parent_id: "dck_1" });
    decks.push({ id: "dck_r2", name: "측면도", deployment_id: null, parent_id: "dck_1" });
    window.Projects = { decks, currentProject: { id: "prj1", name: "tes" }, currentDeck: null, selectDeck() {} };
    window.Zones = { _contains: () => false, focus() {} };
    window.App = { focusPin() {} };
    UI.renderTree();
  };
  const MEASURE = () => {
    const t = document.getElementById("side-tree");
    t.scrollTop = 0;
    const top = { sh: t.scrollHeight, ch: t.clientHeight };
    t.scrollTop = t.scrollHeight;
    const tr = t.getBoundingClientRect();
    const vis = (n) => { const r = n.getBoundingClientRect(); return r.bottom > tr.top - 1 && r.top < tr.bottom + 1; };
    const nodes = Array.from(t.querySelectorAll(".tree-node"));
    const last = nodes[nodes.length - 1];
    return {
      scrollHeight: top.sh, clientHeight: top.ch, nodes: nodes.length,
      scrolledTo: t.scrollTop, maxScroll: t.scrollHeight - t.clientHeight,
      lastLabel: (last ? last.textContent : "").trim(), lastReachable: last ? vis(last) : false,
      decksTop: t.querySelectorAll(".tree-node-deck").length, regions: t.querySelectorAll(".tree-node-region").length,
      emptyMsgs: t.querySelectorAll(".tree-empty").length, missingNames: t.querySelectorAll(".tree-name-missing").length
    };
  };
  await page.evaluate(SETUP);

  try {
    const shotTop = path.join(shotDir, "p65-tree-375x812-top.png");
    await page.screenshot({ path: shotTop, captureBeyondViewport: false });
    await page.evaluate(() => { const t = document.getElementById("side-tree"); t.scrollTop = t.scrollHeight; });
    const shotBottom = path.join(shotDir, "p65-tree-375x812-bottom.png");
    await page.screenshot({ path: shotBottom, captureBeyondViewport: false });
    console.log("  [스크린샷] " + shotTop);
    console.log("  [스크린샷] " + shotBottom);
  } catch (e) { console.log("  [스크린샷 실패 — 판정에는 영향 없음] " + String(e.message).slice(0, 90)); }

  const m = await page.evaluate(MEASURE);
  console.log("  [실측 375x812] scrollHeight=" + m.scrollHeight + " clientHeight=" + m.clientHeight + " nodes=" + m.nodes +
    " decksTop=" + m.decksTop + " regions=" + m.regions + " emptyMsgs=" + m.emptyMsgs + " missingNames=" + m.missingNames);
  ok(m.decksTop === 40, "⑦ 실 브라우저에서 parent_id NULL 구역 40개가 전부 렌더된다 — 실제 " + m.decksTop);
  ok(m.regions === 2, "④ 실 브라우저에서 영역(평면도·측면도) 2개가 구역 아래 나열된다");
  ok(m.emptyMsgs === 39, "⑤ 실 브라우저에서 영역 없는 구역(39개) 마다 '영역 없음' 표시(실제 " + m.emptyMsgs + "개)");
  ok(m.missingNames === 6, "③ 실 브라우저에서 이름 빈 구역(6개)이 '이름 없음'으로 표시(실제 " + m.missingNames + "개)");
  ok(m.clientHeight >= 160, "⑧ #side-tree 가 0 으로 짓눌리지 않는다(clientHeight=" + m.clientHeight + " ≥ 160)");
  ok(m.scrollHeight > m.clientHeight, "⑧ scrollHeight(" + m.scrollHeight + ") > clientHeight(" + m.clientHeight + ") — 스크롤 발생");
  ok(m.scrolledTo === m.maxScroll && m.lastReachable,
    "⑧ 스크롤 끝(" + m.scrolledTo + "/" + m.maxScroll + ")에서 마지막 항목 '" + m.lastLabel + "' 가 보이는 영역 안에 들어온다");

  await browser.close();
  server.close();
}

/* ══════════════════════════════════════════════════════════════════════
 * Part D — ⑨ 기존 회귀 0(p62·p49·p56, 각각 별도 프로세스)
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[Part D · 기존 회귀 0 — p62/p49/p56 별도 실행]");
for (const f of ["p62-tree-3level.test.mjs", "p49-region-to-zone.test.mjs", "p56-deck-from-region.test.mjs"]) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "tests", f)], { cwd: ROOT, encoding: "utf8", timeout: 180000 });
  ok(r.status === 0, "⑨ " + f + " exit 0 (실제 " + r.status + ")");
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
