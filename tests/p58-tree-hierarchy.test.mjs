/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p58-tree-hierarchy.test.mjs)
 *
 * 마스터 지시(2026-09-21):
 *   "1. 프로젝트 생성  2. 도면 등록  3. 구역 설정  4. 구역 내 영역 설정
 *    — 3, 4는 각 하위 리스트가 왼쪽 트리뷰에서 보이게 구성"
 *   → 트리 계층 = 프로젝트 > 도면 > 구역 > 영역 > 핀
 *
 * 근본원인(실측):
 *  · 과거 트리(11_UI.js renderTree)는 구역 > 도면 > 영역 > 핀 이라 2·3단이 뒤바뀌어 있었다.
 *  · extractRegionAsDeck() 이 만드는 "영역"도 decks 행인데 부모-자식 구분 수단이 없었다
 *    (같은 deployment_id + 같은 level_no) → decks.parent_id 를 도입(migrations/0025).
 *
 * 검사(발주서 ①~⑨):
 *  ① 트리가 프로젝트>도면>구역>영역 4단으로 렌더된다
 *  ② parent_id 가 NULL 인 deck 은 도면 바로 아래(최상위 구역)로 표시된다
 *  ③ parent_id 가 있는 deck 은 그 구역 아래(영역)로 표시된다
 *  ④ 도면(deployment)이 여러 장이면 각각 별도 그룹이 된다
 *  ⑤ 접기/펼치기(caret/헤더 클릭)가 각 단에서 동작한다
 *  ⑥ 🔴 실 브라우저 375x812 에서 #side-tree 가 scrollHeight > clientHeight 이고
 *     스크롤 끝에서 마지막 항목까지 도달 가능하다(수치 증명)
 *  ⑦ 구역과 영역이 시각적으로 구분된다(클래스·아이콘·들여쓰기 깊이)
 *  ⑧ API 응답 변경이 기존 호출부를 깨뜨리지 않는다(기존 필드 전부 보존 + 새 필드 추가)
 *  ⑨ 마이그레이션 0025 가 비파괴다(ALTER ADD / CREATE INDEX 만 · 기존 행 보존)
 *
 * 목(mock) 사용 범위:
 *  · Part A 는 실제 11_UI.js 소스를 vm 에 그대로 평가한다(로직은 실물, DOM 만 최소 목 — p22 와 동일 패턴).
 *  · Part B 는 실제 워커(src/index.tsx 번들)를 Miniflare 에 올리고 **실제 D1(SQLite)** 에
 *    실제 마이그레이션 파일을 적용해 HTTP 로 때린다. D1 목 없음.
 *  · Part C 는 실제 Chrome(Puppeteer)에서 실제 public/ 자산을 로드해 레이아웃을 실측한다.
 *
 * 뮤테이션 4건(ⓐ 계층 평탄화→① / ⓑ parent_id 무시→③ / ⓒ 스크롤 제약 제거→⑥ / ⓓ API 필드 제거→⑧).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";
import { Miniflare } from "miniflare";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const uiSrc = rd("public/js/modules/11_UI.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ══════════════════════════════════════════════════════════════════════
 * Part A — 트리 렌더 (실제 11_UI.js · 최소 DOM 목, p22 와 동일 패턴)
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
function runTree(src, ctx) {
  const { document, registry } = makeDoc();
  const sandbox = { console, document, JSON, Map, Set, ...ctx };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__UI = UI;", sandbox);
  sandbox.__UI.renderTree();
  return { host: registry["side-tree"], UI: sandbox.__UI };
}
const has = (el, cls) => new RegExp("(^| )" + cls + "( |$)").test(el.className || "");
const kidsOf = (el) => (el._children || []).find((c) => has(c, "tree-children"));
const pick = (el, cls) => (el._children || []).filter((c) => has(c, cls));
function findAll(el, cls, out) {
  out = out || [];
  (el._children || []).forEach((c) => { if (has(c, cls)) out.push(c); findAll(c, cls, out); });
  return out;
}
function flat(el) { let s = el._html || ""; (el._children || []).forEach((c) => { s += flat(c); }); return s; }

/** 픽스처: 도면 2장 + 도면 미등록 구역 1개. dep1 = 구역1 + 영역3, dep2 = 구역1 + 영역1 */
function fx() {
  const State = {
    mode: "designer", pdfPage: 1, pdfPages: 2, fileName: "A0_주갑판.pdf",
    currentDeploymentId: "dep1", activePin: null,
    zones: [{ id: "z1", label: "00룸", page: 1, color: "#e11d48" }],
    pins: [{ id: "pn1", label: "포인트 1", page: 1, x: 10, y: 10 }]
  };
  const decks = [
    { id: "d1",  name: "메인데크",   deployment_id: "dep1", parent_id: null, deployment_file_name: "A0_주갑판.pdf" },
    { id: "d1a", name: "평면도",     deployment_id: "dep1", parent_id: "d1", deployment_file_name: "A0_주갑판.pdf" },
    { id: "d1b", name: "측면도",     deployment_id: "dep1", parent_id: "d1", deployment_file_name: "A0_주갑판.pdf" },
    { id: "d1c", name: "A-A 단면",   deployment_id: "dep1", parent_id: "d1", deployment_file_name: "A0_주갑판.pdf" },
    { id: "d2",  name: "어퍼데크",   deployment_id: "dep2", parent_id: null, deployment_file_name: "A1_상갑판.pdf" },
    { id: "d2a", name: "기관실",     deployment_id: "dep2", parent_id: "d2", deployment_file_name: "A1_상갑판.pdf" },
    { id: "d3",  name: "브릿지",     deployment_id: null,   parent_id: null }
  ];
  const selectDeckCalls = [];
  const Projects = {
    decks, currentProject: { id: "prj1", name: "HHI-2411 LNG선" }, currentDeck: decks[0],
    selectDeck: (d) => selectDeckCalls.push(d.id)
  };
  return {
    State, Projects, selectDeckCalls,
    Zones: { _contains: () => true, focus() {} },
    App: { focusPin() {} }
  };
}
/** 4단 경로를 실제로 타고 내려간다 — 하나라도 없으면 null */
function path4(host) {
  const proj = pick(host, "tree-project")[0];               if (!proj) return null;
  const doc = kidsOf(proj) && pick(kidsOf(proj), "tree-doc")[0];   if (!doc) return null;
  const deck = kidsOf(doc) && pick(kidsOf(doc), "tree-deck")[0];   if (!deck) return null;
  const region = kidsOf(deck) && pick(kidsOf(deck), "tree-region")[0]; if (!region) return null;
  return { proj, doc, deck, region };
}

console.log("\n[Part A · 트리 렌더 — 실제 11_UI.js]");
{
  const c = fx();
  const { host } = runTree(uiSrc, c);
  const p = path4(host);
  ok(!!p, "① 프로젝트 > 도면 > 구역 > 영역 4단 컨테이너가 실제로 중첩 렌더된다");
  if (p) {
    ok(/HHI-2411 LNG선/.test(p.proj._children[0].innerHTML), "① 1단 = 프로젝트명");
    ok(/A0_주갑판\.pdf/.test(p.doc._children[0].innerHTML), "① 2단 = 도면 파일명(API deployment_file_name)");
    ok(/메인데크/.test(p.deck._children[0].innerHTML), "① 3단 = 구역");
    ok(/평면도/.test(p.region._children[0].innerHTML), "① 4단 = 영역");
  }

  // ② parent_id NULL 인 deck 은 도면 바로 아래
  const docs = findAll(host, "tree-doc");
  const dep1Doc = docs.find((d) => /A0_주갑판/.test(d._children[0].innerHTML));
  const dep1Decks = pick(kidsOf(dep1Doc), "tree-deck").map((d) => d._children[0].innerHTML);
  ok(dep1Decks.length === 1 && /메인데크/.test(dep1Decks[0]),
    "② parent_id=NULL 인 구역(메인데크)만 도면 바로 아래에 온다 — 영역은 오지 않는다");
  const noDoc = docs.find((d) => /도면 미등록/.test(d._children[0].innerHTML));
  ok(!!noDoc && /브릿지/.test(flat(noDoc)),
    "② 도면 미등록 구역도 '도면 미등록' 그룹으로 항상 보인다(숨김 금지)");

  // ③ parent_id 있는 deck 은 그 구역 아래
  const deckD1 = pick(kidsOf(dep1Doc), "tree-deck")[0];
  const regions = pick(kidsOf(deckD1), "tree-region").map((r) => r._children[0].innerHTML);
  ok(regions.length === 3 && /평면도/.test(regions[0]) && /측면도/.test(regions[1]) && /A-A 단면/.test(regions[2]),
    "③ parent_id='d1' 인 deck 3개가 구역 '메인데크' 아래 영역으로 들어간다, 실제 " + regions.length + "개");
  ok(pick(kidsOf(dep1Doc), "tree-region").length === 0,
    "③ 영역은 도면 직하에 중복 렌더되지 않는다");

  // ④ 도면이 여러 장이면 각각 그룹
  const labels = docs.map((d) => (d._children[0].innerHTML.match(/tree-label">([^<]*)</) || [, ""])[1]);
  ok(docs.length === 3 && labels.includes("A0_주갑판.pdf") && labels.includes("A1_상갑판.pdf") && labels.includes("도면 미등록"),
    "④ 도면 2장 + 미등록 = 그룹 3개, 실제 " + docs.length + " [" + labels.join(", ") + "]");
  const dep2Doc = docs.find((d) => /A1_상갑판/.test(d._children[0].innerHTML));
  ok(/어퍼데크/.test(flat(dep2Doc)) && /기관실/.test(flat(dep2Doc)) && !/메인데크/.test(flat(dep2Doc)),
    "④ 두 번째 도면 그룹은 자기 구역/영역만 담는다(그룹 간 누수 없음)");

  // ⑤ 접기/펼치기
  const proj = pick(host, "tree-project")[0];
  ok(proj.classList.contains("open"), "⑤ 프로젝트 단 기본 펼침");
  proj._children[0].click();
  ok(!proj.classList.contains("open"), "⑤ 프로젝트 헤더 클릭 → 접힘(.open 제거)");
  proj._children[0].click();
  ok(proj.classList.contains("open"), "⑤ 다시 클릭 → 펼침");
  const doc1 = docs[0];
  doc1._children[0].click();
  ok(!doc1.classList.contains("open"), "⑤ 도면 헤더 클릭 → 접힘");
  doc1._children[0].click();
  ok(doc1.classList.contains("open"), "⑤ 도면 헤더 다시 클릭 → 펼침");
  const wasOpen = deckD1.classList.contains("open");
  deckD1._children[0].click();  // currentDeck 이므로 토글
  ok(wasOpen && !deckD1.classList.contains("open"), "⑤ 선택된 구역 헤더 클릭 → 접힘(선택 이동 아님)");
  // 미선택 구역은 캐럿으로만 토글, 본문 클릭은 selectDeck
  const deckD2 = pick(kidsOf(dep2Doc), "tree-deck")[0];
  deckD2._children[0].click(true);   // 캐럿 클릭
  ok(!deckD2.classList.contains("open") && c.selectDeckCalls.length === 0,
    "⑤ 미선택 구역 캐럿 클릭 → 접기만(구역 전환 없음)");
  deckD2._children[0].click();
  ok(c.selectDeckCalls.length === 1 && c.selectDeckCalls[0] === "d2",
    "⑤ 미선택 구역 본문 클릭 → 기존대로 Projects.selectDeck 호출(회귀 없음)");

  // ⑦ 구역 · 영역 시각 구분
  const deckHead = deckD1._children[0], regionHead = pick(kidsOf(deckD1), "tree-region")[0]._children[0];
  ok(deckHead.classList.contains("tree-node-deck") && regionHead.classList.contains("tree-node-region"),
    "⑦ 구역=.tree-node-deck / 영역=.tree-node-region 으로 클래스가 다르다");
  const icoDeck = (deckHead.innerHTML.match(/<svg(?!.*tree-caret)[^>]*>[\s\S]*?<\/svg>/g) || []).join("");
  const icoRegion = (regionHead.innerHTML.match(/<svg(?!.*tree-caret)[^>]*>[\s\S]*?<\/svg>/g) || []).join("");
  ok(icoDeck !== icoRegion && /polygon/.test(icoDeck) && !/polygon/.test(icoRegion),
    "⑦ 아이콘이 서로 다르다(구역=레이어 polygon / 영역=크롭 프레임)");
  // 들여쓰기: 영역은 구역보다 .tree-children 한 단 더 깊다
  const depth = (el, target, d) => {
    if (el === target) return d;
    for (const ch of (el._children || [])) { const r = depth(ch, target, d + (has(ch, "tree-children") ? 1 : 0)); if (r >= 0) return r; }
    return -1;
  };
  ok(depth(host, regionHead, 0) === depth(host, deckHead, 0) + 1,
    "⑦ 영역이 구역보다 .tree-children 한 단 더 들여쓰인다(" + depth(host, deckHead, 0) + " → " + depth(host, regionHead, 0) + ")");

  const css = rd("public/css/style.css");
  ok(/\.tree-node-region\s*\{[^}]*\}/.test(css) && /\.tree-region:not\(\.open\)\s*>\s*\.tree-children\s*\{\s*display:\s*none/.test(css),
    "⑦ 영역 전용 CSS(.tree-node-region · .tree-region:not(.open) 접힘)가 존재한다");
}

/* ── 뮤테이션 ⓐ: 도면 단을 없애고 구역을 평탄하게 → ① 실패해야 한다 ─────── */
{
  console.log("\n[뮤테이션ⓐ] 계층 평탄화(도면 단 제거) → ①이 실패해야 함");
  const needle = "groups.forEach((grp) => mount.appendChild(docNode(grp)));";
  const mut = uiSrc.replace(needle, "groups.forEach((grp) => grp.decks.forEach((d) => mount.appendChild(deckNode(d, false))));");
  if (mut === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { host } = runTree(mut, fx());
    ok(path4(host) === null, "뮤테이션 적용 시 ①이 깨짐(도면 단이 사라져 4단 경로가 성립하지 않음)");
  }
}

/* ── 뮤테이션 ⓑ: parent_id 를 무시 → ③ 실패해야 한다 ──────────────────── */
{
  console.log("\n[뮤테이션ⓑ] parent_id 무시(전부 최상위 구역 취급) → ③이 실패해야 함");
  const needle = 'return (pid && pid !== String(d.id) && byId.has(pid)) ? pid : "";';
  const mut = uiSrc.replace(needle, 'return "";');
  if (mut === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { host } = runTree(mut, fx());
    const docs = findAll(host, "tree-doc");
    const dep1Doc = docs.find((d) => /A0_주갑판/.test(d._children[0].innerHTML));
    const deckD1 = pick(kidsOf(dep1Doc), "tree-deck")[0];
    ok(pick(kidsOf(deckD1), "tree-region").length === 0 && findAll(host, "tree-region").length === 0,
      "뮤테이션 적용 시 ③이 깨짐(영역이 구역 아래로 들어가지 않고 전부 평탄해짐)");
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * Part B — 실제 워커(src/index.tsx) + 실제 D1(Miniflare SQLite) + 실제 마이그레이션
 * ══════════════════════════════════════════════════════════════════════ */
const MIG_DIR = path.join(ROOT, "migrations");
const MIGS = fs.readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
const stmtsOf = (file) =>
  fs.readFileSync(path.join(MIG_DIR, file), "utf8")
    .replace(/--[^\n]*/g, "")
    .split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);

async function applyMigrations(db, files) {
  for (const f of files) for (const st of stmtsOf(f)) await db.exec(st);
}
async function buildWorker(transform) {
  const out = path.join(os.tmpdir(), "p58-worker-" + process.pid + "-" + Math.random().toString(36).slice(2) + ".mjs");
  const plugins = transform ? [{
    name: "p58-mutate",
    setup(b) {
      b.onLoad({ filter: /index\.tsx$/ }, (args) => ({
        contents: transform(fs.readFileSync(args.path, "utf8")), loader: "tsx"
      }));
    }
  }] : [];
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/index.tsx")], bundle: true, format: "esm", platform: "neutral",
    outfile: out, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
    conditions: ["workerd", "worker", "browser"], plugins
  });
  return out;
}
const TOK = "local-p58-designer";
const SEED = (now) => [
  ["INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
    ["designer@seastar.test", "설계자", "designssir@gmail.com", now, now]],
  ["INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)",
    ["designer@seastar.test", "설계자", "seastar.test", "x", "y", now, now]],
  ["INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)",
    [TOK, "designer@seastar.test", now, now + 8.64e7]],
  ["INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)",
    ["prj_p58", "P58 프로젝트", "", "designer@seastar.test", now, now]],
  ["INSERT INTO deployments (id, title, file_name, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
    ["dep_p58", "주갑판 배포본", "A0_주갑판.pdf", now, now]],
];
const H = { Authorization: "Bearer " + TOK, "Content-Type": "application/json" };

console.log("\n[Part B · 실제 D1(Miniflare) + 실제 워커]");
{
  /* ⑨ 마이그레이션 비파괴 — 0024 까지 적용해 데이터를 넣은 뒤 0025 를 적용한다. */
  const upTo24 = MIGS.filter((f) => f < "0025");
  const m0025 = MIGS.filter((f) => f.startsWith("0025"));
  ok(m0025.length === 1, "⑨ migrations/0025_decks_parent.sql 존재");
  const sql25 = stmtsOf(m0025[0]);
  ok(sql25.every((s) => /^ALTER TABLE \w+ ADD COLUMN /i.test(s) || /^CREATE (UNIQUE )?INDEX /i.test(s)),
    "⑨ 0025 는 ALTER ADD COLUMN / CREATE INDEX 만 — DROP·DELETE·UPDATE 없음 [" + sql25.map((s) => s.split(" ").slice(0, 3).join(" ")).join(" | ") + "]");

  const mfA = new Miniflare({
    modules: true, script: "export default { fetch: () => new Response('') }",
    d1Databases: { DB: "p58a" }, compatibilityDate: "2025-01-01"
  });
  const dbA = await mfA.getD1Database("DB");
  await applyMigrations(dbA, upTo24);
  const now = Date.now();
  for (const [q, a] of SEED(now)) await dbA.prepare(q).bind(...a).run();
  await dbA.prepare("INSERT INTO decks (id, project_id, name, level_no, deployment_id, page, crop, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?,?,0)")
    .bind("dck_legacy", "prj_p58", "구버전 구역", 1, "dep_p58", 1, null, now, now).run();
  const before = (await dbA.prepare("SELECT * FROM decks").all()).results;
  await applyMigrations(dbA, m0025);
  const after = (await dbA.prepare("SELECT * FROM decks").all()).results;
  ok(before.length === 1 && after.length === 1 && after[0].id === "dck_legacy" && after[0].name === "구버전 구역",
    "⑨ 0025 적용 후 기존 행이 그대로 남는다(행 " + before.length + "→" + after.length + ")");
  ok("parent_id" in after[0] && after[0].parent_id === null,
    "⑨ 기존 행의 parent_id 는 NULL — 도면 바로 아래 최상위 구역으로 남는다");
  const cols = (await dbA.prepare("PRAGMA table_info(decks)").all()).results.map((r) => r.name);
  ["id", "project_id", "name", "level_no", "deployment_id", "page", "crop", "created_at", "updated_at", "deleted", "parent_id"]
    .forEach(() => {});
  ok(["id", "project_id", "name", "level_no", "deployment_id", "page", "crop", "created_at", "updated_at", "deleted"].every((cn) => cols.includes(cn)),
    "⑨ 기존 컬럼이 하나도 사라지지 않았다 [" + cols.join(",") + "]");
  const idx = (await dbA.prepare("PRAGMA index_list(decks)").all()).results.map((r) => r.name);
  ok(idx.includes("idx_decks_parent"), "⑨ parent_id 인덱스 생성됨");
  await mfA.dispose();
}

/** 워커를 띄우고 시나리오를 돌려 API 응답을 돌려준다. */
async function apiRun(transform) {
  const script = await buildWorker(transform);
  const mf = new Miniflare({
    modules: true, scriptPath: script, d1Databases: { DB: "p58-" + Math.random().toString(36).slice(2) },
    r2Buckets: { R2: "p58r2" }, bindings: { DEMO_LOGIN: "0" }, compatibilityDate: "2025-01-01"
  });
  try {
    const db = await mf.getD1Database("DB");
    await applyMigrations(db, MIGS);
    const now = Date.now();
    for (const [q, a] of SEED(now)) await db.prepare(q).bind(...a).run();
    const B = "http://p58.test";
    // 구역(최상위) 생성
    const rZone = await mf.dispatchFetch(B + "/api/projects/prj_p58/decks", {
      method: "POST", headers: H,
      body: JSON.stringify({ name: "메인데크", level_no: 1, deployment_id: "dep_p58", page: 1 })
    });
    const zone = await rZone.json();
    // 영역(자식) 생성 — extractRegionAsDeck 이 보낼 본문과 동일 형태
    const rRegion = await mf.dispatchFetch(B + "/api/projects/prj_p58/decks", {
      method: "POST", headers: H,
      body: JSON.stringify({ name: "평면도", level_no: 1, deployment_id: "dep_p58", page: 1, crop: { x: 4, y: 6, w: 44, h: 38 }, parent_id: zone.id })
    });
    const region = await rRegion.json();
    const rList = await mf.dispatchFetch(B + "/api/projects/prj_p58/decks", { headers: H });
    const list = (await rList.json()).data;
    // PUT 으로 parent_id 재지정 가능한지
    const rPut = await mf.dispatchFetch(B + "/api/decks/" + region.id, {
      method: "PUT", headers: H, body: JSON.stringify({ name: "평면도2" })
    });
    const put = await rPut.json();
    return { zoneStatus: rZone.status, zone, regionStatus: rRegion.status, region, listStatus: rList.status, list, put };
  } finally { await mf.dispose(); try { fs.unlinkSync(script); } catch {} }
}

let baseApi;
{
  baseApi = await apiRun(null);
  const { zone, region, list, put } = baseApi;
  ok(baseApi.zoneStatus === 200 && baseApi.regionStatus === 200 && baseApi.listStatus === 200,
    "⑧ POST/POST/GET 전부 200 (" + baseApi.zoneStatus + "/" + baseApi.regionStatus + "/" + baseApi.listStatus + ")");
  // ⑧-a 기존 호출부가 읽던 필드가 전부 그대로 있다(제거·개명 금지)
  const LEGACY = ["id", "project_id", "name", "level_no", "deployment_id", "page", "crop", "created_at", "updated_at"];
  const row = list.find((d) => d.id === zone.id);
  ok(!!row && LEGACY.every((k) => k in row),
    "⑧ GET /api/projects/:id/decks 응답에 기존 필드 9종이 전부 남아 있다(회귀 0) [" + Object.keys(row || {}).join(",") + "]");
  ok(Array.isArray(list) && list.length === 2 && row.project_id === "prj_p58",
    "⑧ 31_Projects.loadDecks 의 필터(d.project_id === pid)가 그대로 통과한다");
  ok(row.crop === null && list.find((d) => d.id === region.id).crop.w === 44,
    "⑧ crop JSON 파싱 동작 유지(NULL→null, 값→객체)");
  // ⑧-b 새 필드
  ok(row.deployment_file_name === "A0_주갑판.pdf" && row.deployment_title === "주갑판 배포본",
    "⑧ 도면 이름 필드(deployment_file_name/deployment_title)가 추가로 실려 온다");
  ok(row.parent_id === null && list.find((d) => d.id === region.id).parent_id === zone.id,
    "⑧ parent_id 왕복 — 구역=null, 영역=구역id (" + list.find((d) => d.id === region.id).parent_id + ")");
  ok(put.parent_id === zone.id, "⑧ PUT 에서 parent_id 미전송 시 기존값 유지(" + put.parent_id + ")");
}

/* ── 뮤테이션 ⓓ: API 에서 추가 필드를 제거 → ⑧ 실패해야 한다 ───────────── */
{
  console.log("\n[뮤테이션ⓓ] API 응답에서 도면 이름/parent_id 필드 제거 → ⑧이 실패해야 함");
  const mut = await apiRun((src) => src
    .replace("if (r.deployment_title !== undefined) out.deployment_title = r.deployment_title ?? null", "")
    .replace("if (r.deployment_file_name !== undefined) out.deployment_file_name = r.deployment_file_name ?? null", ""));
  const row = mut.list.find((d) => d.id === mut.zone.id);
  ok(row && row.deployment_file_name === undefined,
    "뮤테이션 적용 시 ⑧이 깨짐(도면 이름 필드가 사라져 트리 2단이 파일명을 잃는다)");
}

/* ══════════════════════════════════════════════════════════════════════
 * Part C — 실제 Chrome(Puppeteer) 375x812 레이아웃 실측 (⑥ + 뮤테이션 ⓒ)
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[Part C · 실 브라우저 375x812 — #side-tree 스크롤 도달]");
const require = createRequire("file:///C:/Users/FREE/package.json");
let puppeteer = null;
try { puppeteer = require("puppeteer"); } catch (e) { puppeteer = null; }
if (!puppeteer) {
  console.log("  FAIL ⑥ puppeteer 를 로드할 수 없다 — 실 브라우저 수치 증명 불가(증거 없는 PASS 금지)");
  failed++;
} else {
  const PUB = path.join(ROOT, "public");
  const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
    ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon" };
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    if (u.startsWith("/api/") || u.startsWith("/tables/")) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"data":[]}'); return; }
    const f = path.join(PUB, u === "/" ? "index.html" : u);
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
    res.end(fs.readFileSync(f));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const PORT = server.address().port;
  const browser = await puppeteer.launch({ headless: "new", protocolTimeout: 180000, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.on("pageerror", () => {});
  let firstDoc = true;
  await page.setRequestInterception(true);
  page.on("request", (q) => {
    if (q.resourceType() === "document") { if (firstDoc) { firstDoc = false; q.continue(); } else q.abort(); return; }
    q.continue();
  });
  await page.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => !!window.__wm, { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500)); // 부팅 잔여 렌더/요청이 가라앉을 때까지(스크린샷 프레임 커밋 대기)

  const SETUP = () => {
    const { State, UI, Projects, Zones } = window.__wm;
    const mk = (n, pg) => Array.from({ length: n }, (_, i) => ({ id: "p" + pg + "_" + i, label: "포인트 " + (i + 1), page: pg, x: 10 + i, y: 10 + i }));
    State.mode = "designer"; State.pdfPage = 1; State.pdfPages = 2; State.fileName = "A0_주갑판.pdf";
    State.currentDeploymentId = "dep1"; State.activePin = null;
    State.zones = [{ id: "z1", label: "00룸", page: 1, color: "#e11d48" }, { id: "z2", label: "01룸", page: 2, color: "#0ea5e9" }];
    State.pins = mk(4, 1).concat(mk(3, 2));
    Zones._contains = (z) => z.id === "z1";
    Projects.currentProject = { id: "prj1", name: "HHI-2411 LNG선" };
    Projects.decks = [
      { id: "d1", name: "메인데크", deployment_id: "dep1", parent_id: null, deployment_file_name: "A0_주갑판.pdf" },
      { id: "d1a", name: "평면도", deployment_id: "dep1", parent_id: "d1", deployment_file_name: "A0_주갑판.pdf" },
      { id: "d1b", name: "측면도", deployment_id: "dep1", parent_id: "d1", deployment_file_name: "A0_주갑판.pdf" },
      { id: "d1c", name: "A-A 단면", deployment_id: "dep1", parent_id: "d1", deployment_file_name: "A0_주갑판.pdf" },
      { id: "d2", name: "어퍼데크", deployment_id: "dep2", parent_id: null, deployment_file_name: "A1_상갑판.pdf" },
      { id: "d2a", name: "기관실", deployment_id: "dep2", parent_id: "d2", deployment_file_name: "A1_상갑판.pdf" },
      { id: "d3", name: "브릿지", deployment_id: null, parent_id: null }
    ];
    Projects.currentDeck = Projects.decks[0];
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    document.getElementById("screen-app").classList.add("active");
    document.querySelectorAll(".signin-gate").forEach((e) => e.classList.add("hidden"));
    const sb = document.getElementById("sidebar");
    if (sb) sb.classList.remove("hidden");
    document.body.classList.add("sidebar-open");
    UI.renderTree();
  };
  const MEASURE = () => {
    const t = document.getElementById("side-tree");
    const nodes = Array.from(t.querySelectorAll(".tree-node"));
    t.scrollTop = 0;
    const top = { sh: t.scrollHeight, ch: t.clientHeight };
    t.scrollTop = t.scrollHeight;
    const tr = t.getBoundingClientRect();
    const vis = (n) => { const r = n.getBoundingClientRect(); return r.bottom > tr.top - 1 && r.top < tr.bottom + 1; };
    const last = nodes[nodes.length - 1];
    return {
      scrollHeight: top.sh, clientHeight: top.ch, nodes: nodes.length,
      scrolledTo: t.scrollTop, maxScroll: t.scrollHeight - t.clientHeight,
      lastLabel: (last ? last.textContent : "").trim(), lastReachable: last ? vis(last) : false,
      regions: t.querySelectorAll(".tree-node-region").length,
      docs: t.querySelectorAll(".tree-node-doc").length
    };
  };
  await page.evaluate(SETUP);

  // 스크린샷은 '증거'이지 판정이 아니다 — 먼저 찍고(부팅 직후가 가장 안정), 실패해도 검사는 계속한다.
  const shotDir = process.env.SHOT_DIR || path.join(ROOT, ".shots");
  try {
    fs.mkdirSync(shotDir, { recursive: true });
    const shotTop = path.join(shotDir, "p58-tree-4level-375x812-top.png");
    await page.screenshot({ path: shotTop, captureBeyondViewport: false });
    await page.evaluate(() => { const t = document.getElementById("side-tree"); t.scrollTop = t.scrollHeight; });
    const shotBottom = path.join(shotDir, "p58-tree-4level-375x812-bottom.png");
    await page.screenshot({ path: shotBottom, captureBeyondViewport: false });
    console.log("  [스크린샷] " + shotTop);
    console.log("  [스크린샷] " + shotBottom);
  } catch (e) { console.log("  [스크린샷 실패 — 판정에는 영향 없음] " + String(e.message).slice(0, 90)); }

  // 컨텍스트가 늦은 네비게이션으로 날아갔을 수 있다 → 실측 직전에 한 번 더 셋업(같은 픽스처).
  try { await page.evaluate(SETUP); } catch { await page.waitForFunction(() => !!window.__wm, { timeout: 20000 }); await page.evaluate(SETUP); }
  const m = await page.evaluate(MEASURE);
  console.log("  [실측 375x812] #side-tree scrollHeight=" + m.scrollHeight + " clientHeight=" + m.clientHeight +
    " nodes=" + m.nodes + " maxScroll=" + m.maxScroll + " 마지막='" + m.lastLabel + "'");
  ok(m.docs === 3 && m.regions === 4, "⑥ 실 브라우저에서도 4단이 렌더된다(도면 그룹 " + m.docs + "=3 · 영역 " + m.regions + "=4)");
  ok(m.clientHeight >= 160, "⑥ #side-tree 가 0 으로 짓눌리지 않는다(clientHeight=" + m.clientHeight + " ≥ 160 = clamp 하한)");
  ok(m.scrollHeight > m.clientHeight,
    "⑥ scrollHeight(" + m.scrollHeight + ") > clientHeight(" + m.clientHeight + ") — 세로 스크롤이 실제로 생긴다");
  ok(m.scrolledTo === m.maxScroll && m.lastReachable,
    "⑥ 스크롤 끝(" + m.scrolledTo + "/" + m.maxScroll + ")에서 마지막 항목 '" + m.lastLabel + "' 가 보이는 영역 안에 들어온다");

  /* ── 뮤테이션 ⓒ: .side-tree 의 스크롤 제약(max-height + overflow-y)을 되돌림 → ⑥ 실패 ── */
  console.log("\n[뮤테이션ⓒ] .side-tree 스크롤 제약 제거 → ⑥이 실패해야 함");
  await page.evaluate(() => {
    const s = document.createElement("style");
    s.textContent = ".side-tree{max-height:none !important;flex-basis:auto !important;overflow-y:visible !important;}";
    document.head.appendChild(s);
  });
  const mm = await page.evaluate(MEASURE);
  ok(!(mm.scrollHeight > mm.clientHeight),
    "뮤테이션 적용 시 ⑥이 깨짐(제약 제거 → scrollHeight " + mm.scrollHeight + " == clientHeight " + mm.clientHeight + ", 트리 자체 스크롤 소멸)");

  await browser.close();
  server.close();
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
