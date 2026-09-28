/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p62-tree-3level.test.mjs)
 *
 * [WO 20260921-tree3] 🔴 마스터 정정 — "1.프로젝트 2.구역 3.영역"이지 "도면"은 트리 단계가 아니다.
 *  직전 커밋(eeeab36)이 세운 4단(프로젝트>도면>구역>영역)을 3단(프로젝트>구역>영역)으로 되돌린다.
 *  tests/p58-tree-hierarchy.test.mjs 를 대체한다(이름 변경, 코디네이터 확정).
 *
 * 근본원인(실측):
 *  · 이전 WO 가 "1.프로젝트 2.도면 3.구역 4.영역" 이라 잘못 해석해 도면을 트리 한 단으로 세웠다.
 *  · 마스터는 도면을 "구역을 잘라내는 원본 파일"이라 규정했다 — 트리 단계가 아니라 부가 정보다.
 *  · decks.parent_id(마이그레이션 0025, 프로덕션 적용 완료)는 그대로 쓴다:
 *    parent_id NULL = 구역(2단), parent_id 있음 = 영역(3단).
 *
 * 검사(코디네이터 확정 ①~⑤):
 *  ① 트리가 프로젝트>구역>영역 3단으로 렌더된다(도면 그룹핑 단 없음 — 구역이 프로젝트 바로 아래)
 *  ② parent_id 의미 유지 — NULL=구역(프로젝트 직속), 있음=영역(그 구역 아래)
 *  ③ 도면 출처 정보 유실 0 — 구역/영역 노드 안에 원본 도면 파일명이 부가 표시(.tree-doc-src)로 남는다
 *  ④ 🔴 실 브라우저 375x812 에서 #side-tree 가 scrollHeight > clientHeight 이고
 *     스크롤 끝에서 마지막 항목까지 도달 가능하다(수치 증명)
 *  ⑤ 기존 회귀 0 — p56·p49 는 별도 실행(본 파일은 UI 트리 전용), Part B 는 API/마이그레이션 회귀 담당
 *
 * 뮤테이션 3건 (ⓐ 4단 복원→① / ⓑ parent_id 무시→② / ⓒ 도면정보 삭제→③), 각 EXIT=1 확인 후 원복.
 *
 * 목(mock) 사용 범위:
 *  · Part A 는 실제 11_UI.js 소스를 vm 에 그대로 평가한다(로직은 실물, DOM 만 최소 목 — p22/구 p58 과 동일 패턴).
 *  · Part B 는 실제 워커(src/index.tsx 번들)를 Miniflare 에 올리고 실제 D1(SQLite)에
 *    실제 마이그레이션 파일을 적용해 HTTP 로 때린다. D1 목 없음.
 *  · Part C 는 실제 Chrome(Puppeteer)에서 실제 public/ 자산(조립된 public/js/main.js 포함)을
 *    로드해 레이아웃을 실측한다.
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
 * Part A — 트리 렌더 (실제 11_UI.js · 최소 DOM 목, p22/구 p58 과 동일 패턴)
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
/** 3단 경로를 실제로 타고 내려간다 — 프로젝트 > 구역 > 영역. 하나라도 없으면 null */
function path3(host) {
  const proj = pick(host, "tree-project")[0];               if (!proj) return null;
  const deck = kidsOf(proj) && pick(kidsOf(proj), "tree-deck")[0];   if (!deck) return null;
  const region = kidsOf(deck) && pick(kidsOf(deck), "tree-region")[0]; if (!region) return null;
  return { proj, deck, region };
}

console.log("\n[Part A · 트리 렌더 — 실제 11_UI.js]");
{
  const c = fx();
  const { host } = runTree(uiSrc, c);
  const p = path3(host);
  ok(!!p, "① 프로젝트 > 구역 > 영역 3단 컨테이너가 실제로 중첩 렌더된다(도면 그룹핑 단 없음)");
  if (p) {
    ok(/HHI-2411 LNG선/.test(p.proj._children[0].innerHTML), "① 1단 = 프로젝트명");
    ok(/메인데크/.test(p.deck._children[0].innerHTML), "① 2단 = 구역 — 프로젝트 바로 아래(도면 단 경유 없음)");
    ok(/평면도/.test(p.region._children[0].innerHTML), "① 3단 = 영역");
    // 프로젝트 직속 children 안에 .tree-doc 래퍼가 전혀 없다 — 4단 흔적 없음
    ok(findAll(host, "tree-doc").length === 0, "① .tree-doc(도면 그룹핑 단) 컨테이너가 전혀 렌더되지 않는다");
  }

  // ② parent_id 의미 유지 — NULL=구역(프로젝트 직속), 있음=영역(그 구역 아래)
  const rootDeckEls = pick(kidsOf(pick(host, "tree-project")[0]), "tree-deck");
  const rootLabels = rootDeckEls.map((d) => d._children[0].innerHTML);
  ok(rootDeckEls.length === 3
      && rootLabels.some((h) => /메인데크/.test(h))
      && rootLabels.some((h) => /어퍼데크/.test(h))
      && rootLabels.some((h) => /브릿지/.test(h)),
    "② parent_id=NULL 인 구역 3개(메인데크·어퍼데크·브릿지)만 프로젝트 바로 아래에 온다 — 영역은 오지 않는다, 실제 " + rootLabels.join(","));
  const deckD1 = rootDeckEls.find((d) => /메인데크/.test(d._children[0].innerHTML));
  const regions = pick(kidsOf(deckD1), "tree-region").map((r) => r._children[0].innerHTML);
  ok(regions.length === 3 && /평면도/.test(regions[0]) && /측면도/.test(regions[1]) && /A-A 단면/.test(regions[2]),
    "② parent_id='d1' 인 deck 3개가 구역 '메인데크' 아래 영역으로 들어간다, 실제 " + regions.length + "개");
  const deckD2 = rootDeckEls.find((d) => /어퍼데크/.test(d._children[0].innerHTML));
  ok(/기관실/.test(flat(deckD2)) && !/메인데크/.test(flat(deckD2)),
    "② 두 번째 구역 그룹은 자기 영역만 담는다(그룹 간 누수 없음)");

  // ③ 도면 출처 정보 유실 0 — 구역/영역 노드에 원본 파일명 부가 표시(.tree-doc-src)
  ok(/tree-doc-src[^>]*>A0_주갑판\.pdf</.test(deckD1._children[0].innerHTML),
    "③ 구역 '메인데크' 헤더 안에 원본 도면 파일명(A0_주갑판.pdf)이 .tree-doc-src 로 남아 있다");
  const regionD1a = pick(kidsOf(deckD1), "tree-region")[0];
  ok(/tree-doc-src[^>]*>A0_주갑판\.pdf</.test(regionD1a._children[0].innerHTML),
    "③ 영역 '평면도' 헤더에도 원본 도면 파일명이 남아 있다(영역도 같은 도면을 가리킨다)");
  const deckD3 = rootDeckEls.find((d) => /브릿지/.test(d._children[0].innerHTML));
  ok(!/tree-doc-src/.test(deckD3._children[0].innerHTML) && /도면없음/.test(deckD3._children[0].innerHTML),
    "③ 도면 미등록 구역('브릿지')은 출처 라벨 대신 기존 '도면없음' 태그를 유지한다(없는 이름 지어내지 않음)");

  // ⑤(부분) 접기/펼치기 · 시각 구분 — 3단 구조에서도 회귀 없음
  const proj = pick(host, "tree-project")[0];
  ok(proj.classList.contains("open"), "⑤ 프로젝트 단 기본 펼침");
  proj._children[0].click();
  ok(!proj.classList.contains("open"), "⑤ 프로젝트 헤더 클릭 → 접힘(.open 제거)");
  proj._children[0].click();
  ok(proj.classList.contains("open"), "⑤ 다시 클릭 → 펼침");
  const wasOpen = deckD1.classList.contains("open");
  deckD1._children[0].click(); // currentDeck 이므로 토글
  ok(wasOpen && !deckD1.classList.contains("open"), "⑤ 선택된 구역 헤더 클릭 → 접힘(선택 이동 아님)");
  deckD2._children[0].click(true); // 캐럿 클릭(미선택 구역)
  ok(!deckD2.classList.contains("open") && c.selectDeckCalls.length === 0,
    "⑤ 미선택 구역 캐럿 클릭 → 접기만(구역 전환 없음)");
  deckD2._children[0].click();
  ok(c.selectDeckCalls.length === 1 && c.selectDeckCalls[0] === "d2",
    "⑤ 미선택 구역 본문 클릭 → 기존대로 Projects.selectDeck 호출(회귀 없음)");
  const deckHead = deckD1._children[0], regionHead = pick(kidsOf(deckD1), "tree-region")[0]._children[0];
  ok(deckHead.classList.contains("tree-node-deck") && regionHead.classList.contains("tree-node-region"),
    "⑤ 구역=.tree-node-deck / 영역=.tree-node-region 으로 클래스가 다르다(시각 구분 유지)");
}

/* ── 뮤테이션 ⓐ: 도면 그룹핑 단(.tree-doc)을 되살림 → ①이 실패해야 한다 ─────── */
{
  console.log("\n[뮤테이션ⓐ] 4단 복원(도면 그룹핑 단 재도입) → ①이 실패해야 함");
  const needle = "rootDecks.forEach((d) => mount.appendChild(deckNode(d, false)));";
  const mut = uiSrc.replace(needle,
    "rootDecks.forEach((d) => { var w = document.createElement('div'); w.className = 'tree-doc open'; w.appendChild(deckNode(d, false)); mount.appendChild(w); });");
  if (mut === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { host } = runTree(mut, fx());
    ok(path3(host) === null, "뮤테이션 적용 시 ①이 깨짐(구역이 .tree-doc 래퍼 아래로 들어가 프로젝트 직속이 아니게 됨)");
  }
}

/* ── 뮤테이션 ⓑ: parent_id 를 무시 → ②가 실패해야 한다 ──────────────────── */
{
  console.log("\n[뮤테이션ⓑ] parent_id 무시(전부 최상위 구역 취급) → ②가 실패해야 함");
  const needle = 'return (pid && pid !== String(d.id) && byId.has(pid)) ? pid : "";';
  const mut = uiSrc.replace(needle, 'return "";');
  if (mut === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { host } = runTree(mut, fx());
    const proj = pick(host, "tree-project")[0];
    const deckD1 = pick(kidsOf(proj), "tree-deck").find((d) => /메인데크/.test(d._children[0].innerHTML));
    ok(pick(kidsOf(deckD1), "tree-region").length === 0 && findAll(host, "tree-region").length === 0,
      "뮤테이션 적용 시 ②가 깨짐(영역이 구역 아래로 들어가지 않고 전부 평탄해짐)");
  }
}

/* ── 뮤테이션 ⓒ: 도면 출처 라벨(srcTag)을 제거 → ③이 실패해야 한다 ──────── */
{
  console.log("\n[뮤테이션ⓒ] 도면 출처 정보(srcTag) 삭제 → ③이 실패해야 함");
  const needle = "const srcTag = docName ? '<span class=\"tree-label-sub tree-doc-src\" title=\"원본 도면: ' + esc(docName) + '\">' + esc(docName) + '</span>' : \"\";";
  const mut = uiSrc.replace(needle, 'const srcTag = "";');
  if (mut === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { host } = runTree(mut, fx());
    ok(!/tree-doc-src/.test(flat(host)), "뮤테이션 적용 시 ③이 깨짐(도면 출처 라벨이 트리 어디에도 없다)");
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * Part B — 실제 워커(src/index.tsx) + 실제 D1(Miniflare SQLite) + 실제 마이그레이션
 *  (트리 UI 와 무관 — parent_id API 왕복·마이그레이션 비파괴 회귀. 3단 전환에 영향받지 않는다)
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
  const out = path.join(os.tmpdir(), "p62-worker-" + process.pid + "-" + Math.random().toString(36).slice(2) + ".mjs");
  const plugins = transform ? [{
    name: "p62-mutate",
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
const TOK = "local-p62-designer";
const SEED = (now) => [
  ["INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
    ["designer@seastar.test", "설계자", "designssir@gmail.com", now, now]],
  ["INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)",
    ["designer@seastar.test", "설계자", "seastar.test", "x", "y", now, now]],
  ["INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)",
    [TOK, "designer@seastar.test", now, now + 8.64e7]],
  ["INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)",
    ["prj_p62", "P62 프로젝트", "", "designer@seastar.test", now, now]],
  ["INSERT INTO deployments (id, title, file_name, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
    ["dep_p62", "주갑판 배포본", "A0_주갑판.pdf", now, now]],
];
const H = { Authorization: "Bearer " + TOK, "Content-Type": "application/json" };

console.log("\n[Part B · 실제 D1(Miniflare) + 실제 워커 — API/마이그레이션 회귀]");
{
  const upTo24 = MIGS.filter((f) => f < "0025");
  const m0025 = MIGS.filter((f) => f.startsWith("0025"));
  ok(m0025.length === 1, "migrations/0025_decks_parent.sql 존재(프로덕션 적용 완료·비파괴 재확인)");
  const sql25 = stmtsOf(m0025[0]);
  ok(sql25.every((s) => /^ALTER TABLE \w+ ADD COLUMN /i.test(s) || /^CREATE (UNIQUE )?INDEX /i.test(s)),
    "0025 는 ALTER ADD COLUMN / CREATE INDEX 만 — DROP·DELETE·UPDATE 없음");

  const mfA = new Miniflare({
    modules: true, script: "export default { fetch: () => new Response('') }",
    d1Databases: { DB: "p62a" }, compatibilityDate: "2025-01-01"
  });
  const dbA = await mfA.getD1Database("DB");
  await applyMigrations(dbA, upTo24);
  const now = Date.now();
  for (const [q, a] of SEED(now)) await dbA.prepare(q).bind(...a).run();
  await dbA.prepare("INSERT INTO decks (id, project_id, name, level_no, deployment_id, page, crop, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?,?,0)")
    .bind("dck_legacy", "prj_p62", "구버전 구역", 1, "dep_p62", 1, null, now, now).run();
  const before = (await dbA.prepare("SELECT * FROM decks").all()).results;
  await applyMigrations(dbA, m0025);
  const after = (await dbA.prepare("SELECT * FROM decks").all()).results;
  ok(before.length === 1 && after.length === 1 && after[0].id === "dck_legacy",
    "0025 적용 후 기존 행이 그대로 남는다(행 " + before.length + "→" + after.length + ")");
  ok("parent_id" in after[0] && after[0].parent_id === null,
    "기존 행의 parent_id 는 NULL — 프로젝트 직속 구역으로 남는다");
  await mfA.dispose();
}

async function apiRun(transform) {
  const script = await buildWorker(transform);
  const mf = new Miniflare({
    modules: true, scriptPath: script, d1Databases: { DB: "p62-" + Math.random().toString(36).slice(2) },
    r2Buckets: { R2: "p62r2" }, bindings: { DEMO_LOGIN: "0" }, compatibilityDate: "2025-01-01"
  });
  try {
    const db = await mf.getD1Database("DB");
    await applyMigrations(db, MIGS);
    const now = Date.now();
    for (const [q, a] of SEED(now)) await db.prepare(q).bind(...a).run();
    const B = "http://p62.test";
    const rZone = await mf.dispatchFetch(B + "/api/projects/prj_p62/decks", {
      method: "POST", headers: H,
      body: JSON.stringify({ name: "메인데크", level_no: 1, deployment_id: "dep_p62", page: 1 })
    });
    const zone = await rZone.json();
    const rRegion = await mf.dispatchFetch(B + "/api/projects/prj_p62/decks", {
      method: "POST", headers: H,
      body: JSON.stringify({ name: "평면도", level_no: 1, deployment_id: "dep_p62", page: 1, crop: { x: 4, y: 6, w: 44, h: 38 }, parent_id: zone.id })
    });
    const region = await rRegion.json();
    const rList = await mf.dispatchFetch(B + "/api/projects/prj_p62/decks", { headers: H });
    const list = (await rList.json()).data;
    return { zoneStatus: rZone.status, zone, regionStatus: rRegion.status, region, listStatus: rList.status, list };
  } finally { await mf.dispose(); try { fs.unlinkSync(script); } catch {} }
}
{
  const { zoneStatus, regionStatus, listStatus, zone, region, list } = await apiRun(null);
  ok(zoneStatus === 200 && regionStatus === 200 && listStatus === 200, "POST/POST/GET 전부 200");
  const row = list.find((d) => d.id === zone.id);
  ok(row && row.deployment_file_name === "A0_주갑판.pdf",
    "도면 이름 필드(deployment_file_name)가 실려 온다(트리 부가 라벨의 데이터 소스)");
  ok(row.parent_id === null && list.find((d) => d.id === region.id).parent_id === zone.id,
    "parent_id 왕복 — 구역=null, 영역=구역id");
}

/* ══════════════════════════════════════════════════════════════════════
 * Part C — 실제 Chrome(Puppeteer) 375x812 레이아웃 실측 (④)
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[Part C · 실 브라우저 375x812 — #side-tree 3단 렌더 + 스크롤 도달]");
const require = createRequire("file:///C:/Users/FREE/package.json");
let puppeteer = null;
try { puppeteer = require("puppeteer"); } catch (e) { puppeteer = null; }
if (!puppeteer) {
  console.log("  FAIL ④ puppeteer 를 로드할 수 없다 — 실 브라우저 수치 증명 불가(증거 없는 PASS 금지)");
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
  await listenSafePort(server, "127.0.0.1");
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
  await new Promise((r) => setTimeout(r, 2500));

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
      decksTop: t.querySelectorAll(".tree-node-deck").length,
      docWrap: t.querySelectorAll(".tree-doc").length
    };
  };
  await page.evaluate(SETUP);

  const shotDir = process.env.SHOT_DIR || path.join(os.tmpdir(), "p62-tree-shots");
  try {
    fs.mkdirSync(shotDir, { recursive: true });
    const shotTop = path.join(shotDir, "p62-tree-3level-375x812-top.png");
    await page.screenshot({ path: shotTop, captureBeyondViewport: false });
    await page.evaluate(() => { const t = document.getElementById("side-tree"); t.scrollTop = t.scrollHeight; });
    const shotBottom = path.join(shotDir, "p62-tree-3level-375x812-bottom.png");
    await page.screenshot({ path: shotBottom, captureBeyondViewport: false });
    console.log("  [스크린샷] " + shotTop);
    console.log("  [스크린샷] " + shotBottom);
  } catch (e) { console.log("  [스크린샷 실패 — 판정에는 영향 없음] " + String(e.message).slice(0, 90)); }

  try { await page.evaluate(SETUP); } catch { await page.waitForFunction(() => !!window.__wm, { timeout: 20000 }); await page.evaluate(SETUP); }
  const m = await page.evaluate(MEASURE);
  console.log("  [실측 375x812] #side-tree scrollHeight=" + m.scrollHeight + " clientHeight=" + m.clientHeight +
    " nodes=" + m.nodes + " maxScroll=" + m.maxScroll + " 마지막='" + m.lastLabel + "'");
  ok(m.docWrap === 0, "④ 실 브라우저에서 .tree-doc(도면 그룹핑 단) 컨테이너가 전혀 없다(3단 확정)");
  ok(m.decksTop === 3 && m.regions === 4, "④ 실 브라우저에서 3단이 렌더된다(구역 " + m.decksTop + "=3 · 영역 " + m.regions + "=4)");
  ok(m.clientHeight >= 160, "④ #side-tree 가 0 으로 짓눌리지 않는다(clientHeight=" + m.clientHeight + " ≥ 160 = clamp 하한)");
  ok(m.scrollHeight > m.clientHeight,
    "④ scrollHeight(" + m.scrollHeight + ") > clientHeight(" + m.clientHeight + ") — 세로 스크롤이 실제로 생긴다");
  ok(m.scrolledTo === m.maxScroll && m.lastReachable,
    "④ 스크롤 끝(" + m.scrolledTo + "/" + m.maxScroll + ")에서 마지막 항목 '" + m.lastLabel + "' 가 보이는 영역 안에 들어온다");

  await browser.close();
  server.close();
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
