/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p91-mode-workspace.test.mjs)
 *
 * [WO 20260930-fixmode] 마스터(같은 요구 두 번째): "모드를 체커와 360으로 구분 — 완전히 다른 프로젝트처럼.
 *   별도의 트리부터 구분해" / "프로젝트 하단 최상단에 체커와 360으로 구분하고 그 하위로 구역-영역으로 가자"
 * 재현(지휘자, 라이브 103a60fc sunbo): [CHECKER]/[360] 세그먼트를 바꿔도 트리·지도 핀·필터 칩이 완전히 동일.
 *
 * 설계(SoT 1곳 = 01b_PinSeries.js DECK_MODES/activeMode/filter()/modePins/deckInMode/withDeckMode):
 *  · 모드 = 작업공간 — 활성 모드(State.regMode)의 핀 계열만 지도 마커·미니맵(filter())·칩·핀 목록·"N PINS"에 보인다.
 *  · 트리: 프로젝트 → CHECKER / 360 → 구역 → 영역 → 핀(그 모드 계열만). 모드 노드 클릭 = App._setRegMode.
 *  · decks.mode(마이그레이션 0029): 'checker' | '360' | NULL. NULL(기존 구역)은 두 모드 트리에 모두 보인다(유실 0).
 *  · 새 구역 = 활성 모드 태그, 영역 = 부모 구역 mode 상속(부모 NULL 이면 활성 모드). 서버는 그 외 값 400.
 *
 * Part A  (vm · 실 소스 01b_PinSeries.js + 11_UI.js + 12_ProjectHub.js)  — 트리·지도·칩·목록·태그
 * Part B  (실 워커 src/index.tsx esbuild + 실 D1 Miniflare + 실 마이그레이션 전부) — mode 검증·상속·NULL 보존
 * Part C  (실 Chrome · 실 CSS 3파일) — 전환 전·후 스크린샷(.tmp/fixmode/) + 모드 노드 글자 대비 실측
 * 뮤테이션 M1~M8 — 각각 해당 검사가 FAIL 로 뒤집혀야 PASS.
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
const seriesSrc = rd("public/js/modules/01b_PinSeries.js");
const hubSrc = rd("public/js/modules/12_ProjectHub.js");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };
const mutate = (src, needle, repl, name) => {
  const out = src.replace(needle, repl);
  if (out === src) throw new Error("뮤테이션 대상 문자열을 찾지 못함: " + name);
  return out;
};

/* ── 최소 DOM 목(p73 과 동일 패턴) ── */
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
    contains: (c) => set.has(c), _set: set
  };
}
function makeEl(tag) {
  const el = {
    tagName: tag || "div", style: {}, dataset: {}, title: "", value: "", disabled: false, type: "",
    _text: "", _html: "", _children: [], _handlers: {},
    appendChild(c) { this._children.push(c); return c; },
    insertBefore(c) { this._children.unshift(c); return c; },
    insertAdjacentHTML() {},
    setAttribute(k, v) { this.dataset["attr_" + k] = String(v); },
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    querySelector() { return makeEl(); }, querySelectorAll() { return []; }, closest() { return null; },
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
  return { registry, document: {
    getElementById: (id) => (registry[id] = registry[id] || makeEl()),
    createElement: (t) => makeEl(t), querySelectorAll: () => [], addEventListener() {}
  } };
}
const has = (el, cls) => new RegExp("(^| )" + cls + "( |$)").test(el.className || "");
const kidsOf = (el) => (el && el._children || []).find((c) => has(c, "tree-children"));
const pick = (el, cls) => (el && el._children || []).filter((c) => has(c, cls));
const headOf = (el) => (el._children || []).find((c) => has(c, "tree-node"));
const labelOf = (node) => { const m = /class="tree-label">([^<]*)</.exec(headOf(node)._html); return m ? m[1] : ""; };

/* ── 픽스처 ──
   구역: floor(mode NULL — 0029 이전 기존 구역, sunbo 역) · 체커구역(checker) + 그 영역 체커영역(checker) · 360구역(360)
   핀(floor 도면 dep1 에 로드됨): CHECKER 계열 3개(1,2,3) + 360 계열 2개 */
function fixture(regMode, viewer) {
  const decks = [
    { id: "dNull", name: "floor", mode: null, deployment_id: "dep1", parent_id: null },
    { id: "dChk", name: "체커구역", mode: "checker", deployment_id: "dep2", parent_id: null },
    { id: "dChkR", name: "체커영역", mode: "checker", deployment_id: "dep2", parent_id: "dChk" },
    { id: "d360", name: "360구역", mode: "360", deployment_id: "dep3", parent_id: null }
  ];
  const State = {
    mode: viewer ? "viewer" : "designer", regMode, pdfPage: 1, pdfPages: 1, currentDeploymentId: "dep1",
    activePin: null, zones: [], zoneView: null, editMode: false, placing: false,
    pins: [
      { id: "c1", page: 1, x: 10, y: 10, checkboard: true, label: "1" },
      { id: "c2", page: 1, x: 20, y: 20, checkboard: true, label: "2" },
      { id: "c3", page: 1, x: 30, y: 30, checkboard: true, label: "3" },
      { id: "q1", page: 1, x: 60, y: 60, label: "현장A" },
      { id: "q2", page: 1, x: 70, y: 70, label: "현장B" }
    ]
  };
  const calls = { setRegMode: [], selectDeck: [] };
  const Projects = { decks, currentProject: { id: "prj1", name: "sunbo" }, currentDeck: decks[0],
    selectDeck(d) { calls.selectDeck.push(d.id); } };
  const App = { _setRegMode: (m) => calls.setRegMode.push(m), pinHasContent: () => false, focusPin() {}, isDeckUnsaved: () => false };
  return { State, Projects, App, calls };
}
function runUI(fx, srcs) {
  const { document, registry } = makeDoc();
  const sandbox = { console, document, JSON, Map, Set, Math, Number, String, Array, Object, Date, RegExp,
    localStorage: { getItem: () => null, setItem() {} },
    State: fx.State, Projects: fx.Projects, App: fx.App,
    Zones: { _contains: () => false, focus() {}, render() {} }, PinActionPop: { open() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext((srcs.series || seriesSrc) + "\n" + (srcs.ui || uiSrc) + "\n" + (srcs.hub || hubSrc) +
    "\n;globalThis.__UI = UI; globalThis.__PS = PinSeries; globalThis.__HUB = ProjectHub;", sandbox);
  return { UI: sandbox.__UI, PS: sandbox.__PS, HUB: sandbox.__HUB, registry };
}
/** 한 모드 상태를 전부 렌더하고 관측값을 뽑는다 */
function observe(regMode, srcs, viewer) {
  const fx = fixture(regMode, viewer);
  const { UI, PS, HUB, registry } = runUI(fx, srcs || {});
  UI.renderPinsOnMap();
  UI.renderPinList(); // 내부에서 renderTree() 까지 호출
  const markers = (registry["pins-layer"]._children || []).length;
  const chips = registry["pin-filter-bar"]._html;
  const badge = registry["pin-count-badge"]._text;
  const proj = pick(registry["side-tree"], "tree-project")[0];
  const modes = pick(kidsOf(proj), "tree-mode");
  const modeInfo = {};
  modes.forEach((mw) => {
    const tag = mw.dataset.mode;
    const decks = pick(kidsOf(mw), "tree-deck");
    const deckNames = decks.map(labelOf);
    const byName = {};
    decks.forEach((d) => {
      const k = kidsOf(d);
      byName[labelOf(d)] = {
        pins: pick(k, "tree-node-pin").map((n) => (/tree-pin-no">([^<]*)</.exec(n._html) || [])[1]),
        regions: pick(k, "tree-region").map(labelOf)
      };
    });
    modeInfo[tag] = { head: headOf(mw), deckNames, byName, open: has(mw, "open") };
  });
  const hubHtml = HUB._renderDeckTreeHtml.call(Object.assign(Object.create(HUB), { _deckTreeCache: { prj1: fx.Projects.decks } }), { id: "prj1" });
  return { fx, PS, markers, chips, badge, modes: modes.map((m) => m.dataset.mode), modeInfo, hubHtml };
}

/* ══════════════════ Part A — 모드 = 작업공간 (실 소스) ══════════════════ */
console.log("\n[Part A · CHECKER ↔ 360 전환 시 지도·칩·목록·트리 분리]");
function checkA(label, srcs) {
  const r = { checks: [] };
  const push = (c, l) => r.checks.push([c, l]);
  const C = observe("checkboard", srcs);
  const P = observe("photo", srcs);
  push(C.markers === 3 && P.markers === 2, `A1 지도 마커: CHECKER=${C.markers}(기대 3) · 360=${P.markers}(기대 2)`);
  push(/data-series="checkboard"/.test(C.chips) && !/data-series="content"/.test(C.chips) && /zpager-cnt">3</.test(C.chips)
    && /data-series="content"/.test(P.chips) && !/data-series="checkboard"/.test(P.chips) && /zpager-cnt">2</.test(P.chips),
    "A2 필터 칩·카운트: CHECKER 모드엔 [CHECKER 3]만, 360 모드엔 [360 2]만");
  push(C.badge === "3 PINS" && P.badge === "2 PINS", `A3 핀 목록 "N PINS": CHECKER='${C.badge}' · 360='${P.badge}'`);
  push(C.modes.join(",") === "checker,360", `A4 트리: 프로젝트 바로 아래 모드 노드 2개(CHECKER, 360) → [${C.modes}]`);
  const cc = C.modeInfo.checker || {}, c3 = C.modeInfo["360"] || {};
  push(!!cc.head && has(cc.head, "active") && !has(c3.head, "active"), "A5 CHECKER 모드 → CHECKER 노드만 강조(.active)");
  const pc = P.modeInfo.checker || {}, p3 = P.modeInfo["360"] || {};
  push(!!p3.head && has(p3.head, "active") && !has(pc.head, "active"), "A5 360 모드 → 360 노드만 강조(.active)");
  push(JSON.stringify(cc.deckNames) === JSON.stringify(["floor", "체커구역"]) && JSON.stringify(c3.deckNames) === JSON.stringify(["floor", "360구역"]),
    `A6 구역 소속: CHECKER=[${cc.deckNames}] · 360=[${c3.deckNames}] (floor=NULL 은 양쪽)`);
  push(cc.byName && cc.byName["체커구역"] && cc.byName["체커구역"].regions.join() === "체커영역", "A6 영역은 부모 구역 아래(CHECKER → 체커구역 → 체커영역)");
  const fC = cc.byName && cc.byName.floor, f3 = c3.byName && c3.byName.floor;
  push(!!fC && fC.pins.join() === "#1,#2,#3" && !!f3 && f3.pins.join() === "#P1,#P2",
    `A7 NULL 구역(floor) 핀: CHECKER 트리=[${fC && fC.pins}] · 360 트리=[${f3 && f3.pins}] — 어느 쪽에서도 유실 없음`);
  push(!!(C.modeInfo.checker || {}).open && !(C.modeInfo["360"] || {}).open, "A8 활성 모드 가지만 기본 펼침(비활성은 접힘, 캐럿으로 열 수 있음)");
  // 모드 노드 클릭 = App._setRegMode (상단 세그먼트와 같은 SoT)
  c3.head._handlers.click.forEach((fn) => fn({ target: { closest: () => null } }));
  push(C.fx.calls.setRegMode.join() === "photo", `A9 CHECKER 모드에서 [360] 노드 클릭 → App._setRegMode('photo') → [${C.fx.calls.setRegMode}]`);
  // 뷰어(모드 없음)는 분리 없이 전부
  const V = observe("checkboard", srcs, true);
  push(V.markers === 5, `A10 뷰어(편집 모드 아님) → 분리 없음, 마커 5 (실제 ${V.markers})`);
  // 허브 카드 트리도 같은 구조
  const h = C.hubHtml;
  const seg = (tag) => { const i = h.indexOf('data-mode-reg="' + tag + '"'); const j = h.indexOf("</li></ul></li>", i); return i < 0 ? "" : h.slice(i, j < 0 ? undefined : j); };
  const hc = seg("checkboard"), h3 = seg("photo");
  push(/hub-tree-modes/.test(h) && />CHECKER</.test(hc) && />360</.test(h3)
    && /floor/.test(hc) && /체커구역/.test(hc) && /체커영역/.test(hc) && !/360구역/.test(hc)
    && /floor/.test(h3) && /360구역/.test(h3) && !/체커구역/.test(h3),
    "A11 허브 카드 트리: 프로젝트 → CHECKER(floor·체커구역>체커영역) / 360(floor·360구역)");
  // 새 구역·영역 태그
  const PS = C.PS;
  const t1 = PS.withDeckMode({ name: "a" });
  const t2 = PS.withDeckMode({ name: "b" }, { id: "dChk", mode: "checker" });
  const t3 = PS.withDeckMode({ name: "c" }, { id: "dNull", mode: null });
  push(t1.mode === "checker" && t2.mode === "checker" && t3.mode === "checker", "A12 CHECKER 모드: 새 구역 mode='checker' · 영역은 부모 상속");
  const PS3 = P.PS;
  const u2 = PS3.withDeckMode({ name: "b" }, { id: "dChk", mode: "checker" });
  const u3 = PS3.withDeckMode({ name: "c" }, { id: "dNull", mode: null });
  push(PS3.withDeckMode({ name: "a" }).mode === "360" && u2.mode === "checker" && u3.mode === "360",
    `A13 360 모드: 새 구역 '360' · 태그된 부모(checker) 아래 영역은 부모 상속('${u2.mode}') · NULL 부모 아래는 활성 모드('${u3.mode}')`);
  return r.checks;
}
{
  const checks = checkA("정상");
  checks.forEach(([c, l]) => ok(c, l));
}
/* 뮤테이션 — 각각 지정 검사가 FAIL 로 뒤집혀야 한다 */
function mutation(name, srcs, mustFailPrefix) {
  let checks;
  try { checks = checkA(name, srcs); } catch (e) { ok(true, name + " → 예외로 깨짐(" + String(e.message).slice(0, 60) + ")"); return; }
  const broke = checks.filter(([c, l]) => !c && l.startsWith(mustFailPrefix));
  ok(broke.length > 0, name + " → " + mustFailPrefix + " FAIL 로 뒤집힘(" + broke.length + "건)");
}
console.log("\n[Part A 뮤테이션]");
mutation("M1 filter() 모드 게이트 제거(구 동작: 모드 무관 전부 표시)",
  { series: mutate(seriesSrc, "      if (act) return { checkboard: act === \"checkboard\", content: act === \"content\" };\n", "", "M1") }, "A1");
mutation("M2 deckInMode 가 모드 무시(모든 구역이 양쪽 트리)",
  { series: mutate(seriesSrc, "deckInMode(deck, tag) { return !!deck && (deck.mode == null || deck.mode === \"\" || deck.mode === tag); },", "deckInMode(deck, tag) { return !!deck; },", "M2") }, "A6");
mutation("M3 NULL 구역 양쪽 표시 제거(기존 구역 유실)",
  { series: mutate(seriesSrc, "deckInMode(deck, tag) { return !!deck && (deck.mode == null || deck.mode === \"\" || deck.mode === tag); },", "deckInMode(deck, tag) { return !!deck && deck.mode === tag; },", "M3") }, "A7");
mutation("M4 modePins 가 전부 반환(핀 목록 분리 제거)",
  { series: mutate(seriesSrc, "modePins(pins) { return (pins || []).filter((p) => p && this.inMode(p)); },", "modePins(pins) { return (pins || []).slice(); },", "M4") }, "A3");
mutation("M5 영역 부모 mode 상속 제거",
  { series: mutate(seriesSrc, "const tag = (parentDeck && parentDeck.mode) || this.deckModeTag();", "const tag = this.deckModeTag();", "M5") }, "A13");
mutation("M6 트리 핀 나열을 모드 계열로 거르지 않음",
  { ui: mutate(uiSrc, "modePinsHere.forEach((p) => {", "(State.pins || []).forEach((p) => {", "M6") }, "A7");
mutation("M7 트리 모드 단 제거(구역을 프로젝트 직속으로 — 종전 구조)",
  { ui: mutate(uiSrc, "const MODES = (typeof PinSeries !== \"undefined\" && PinSeries.DECK_MODES) || null;\n      if (!MODES) {", "const MODES = null;\n      if (!MODES) {", "M7") }, "A4");

/* ══════════════════ Part B — 서버 + 실 D1 ══════════════════ */
console.log("\n[Part B · 실제 워커(src/index.tsx) + 실제 D1(Miniflare) — decks.mode]");
const MIG_DIR = path.join(ROOT, "migrations");
const MIGS = fs.readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
ok(MIGS.includes("0029_deck_mode.sql"), "B0 마이그레이션 0029_deck_mode.sql 존재");
const stmtsOf = (file) => fs.readFileSync(path.join(MIG_DIR, file), "utf8").replace(/--[^\n]*/g, "")
  .split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
async function buildWorker(transform) {
  const out = path.join(os.tmpdir(), "p91-worker-" + process.pid + "-" + Math.random().toString(36).slice(2) + ".mjs");
  const plugins = transform ? [{ name: "p91-mutate", setup(b) { b.onLoad({ filter: /index\.tsx$/ }, (a) => ({ contents: transform(fs.readFileSync(a.path, "utf8")), loader: "tsx" })); } }] : [];
  await esbuild.build({ entryPoints: [path.join(ROOT, "src/index.tsx")], bundle: true, format: "esm", platform: "neutral",
    outfile: out, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent", conditions: ["workerd", "worker", "browser"], plugins });
  return out;
}
const TOK = "local-p91-designer";
const H = { Authorization: "Bearer " + TOK, "Content-Type": "application/json" };
async function apiRun(transform) {
  const script = await buildWorker(transform);
  const mf = new Miniflare({ modules: true, scriptPath: script, d1Databases: { DB: "p91-" + Math.random().toString(36).slice(2) },
    r2Buckets: { R2: "p91r2" }, bindings: { DEMO_LOGIN: "0" }, compatibilityDate: "2025-01-01" });
  try {
    const db = await mf.getD1Database("DB");
    const now = Date.now();
    // 0028 까지 적용 → 기존(마이그레이션 이전) 구역 1행 삽입 → 0029 적용: 기존 행 유실 0·mode NULL 확인
    for (const f of MIGS.filter((f) => f < "0029")) for (const st of stmtsOf(f)) await db.exec(st);
    const seed = [
      ["INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)", ["designer@seastar.test", "설계자", "designssir@gmail.com", now, now]],
      ["INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)", ["designer@seastar.test", "설계자", "seastar.test", "x", "y", now, now]],
      ["INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOK, "designer@seastar.test", now, now + 8.64e7]],
      ["INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)", ["prj_p91", "sunbo", "", "designer@seastar.test", now, now]],
      ["INSERT INTO deployments (id, title, file_name, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)", ["dep_p91", "도면", "floor.pdf", now, now]],
      ["INSERT INTO decks (id, project_id, name, level_no, deployment_id, page, crop, parent_id, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,0)", ["dck_legacy", "prj_p91", "floor", 1, "dep_p91", 1, null, null, now, now]]
    ];
    for (const [q, a] of seed) await db.prepare(q).bind(...a).run();
    for (const f of MIGS.filter((f) => f >= "0029")) for (const st of stmtsOf(f)) await db.exec(st);
    const B = "http://p91.test";
    const post = async (body) => { const r = await mf.dispatchFetch(B + "/api/projects/prj_p91/decks", { method: "POST", headers: H, body: JSON.stringify(body) }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
    const put = async (id, body) => { const r = await mf.dispatchFetch(B + "/api/decks/" + id, { method: "PUT", headers: H, body: JSON.stringify(body) }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
    const out = {};
    out.chk = await post({ name: "체커구역", deployment_id: "dep_p91", mode: "checker" });
    out.m360 = await post({ name: "360구역", deployment_id: "dep_p91", mode: "360" });
    out.bogus = await post({ name: "x", mode: "CHECKER" });
    out.nul = await post({ name: "x", mode: null });
    out.empty = await post({ name: "x", mode: "" });
    out.none = await post({ name: "모드없음", deployment_id: "dep_p91" });
    out.regInherit = await post({ name: "체커영역", deployment_id: "dep_p91", parent_id: out.chk.j.id });
    out.regConflict = await post({ name: "충돌영역", deployment_id: "dep_p91", parent_id: out.chk.j.id, mode: "360" });
    out.regUnderNull = await post({ name: "레거시아래360영역", deployment_id: "dep_p91", parent_id: "dck_legacy", mode: "360" });
    out.putBad = await put(out.none.j.id, { mode: "photo" });
    out.putOk = await put(out.none.j.id, { mode: "360" });
    out.putKeep = await put(out.none.j.id, { name: "이름만변경" });
    const lr = await mf.dispatchFetch(B + "/api/projects/prj_p91/decks", { headers: H });
    out.list = (await lr.json()).data || [];
    return out;
  } finally { await mf.dispose(); try { fs.unlinkSync(script); } catch {} }
}
function checkB(o) {
  const L = (id) => o.list.find((d) => d.id === id) || {};
  return [
    [o.chk.s === 200 && o.chk.j.mode === "checker" && o.m360.s === 200 && o.m360.j.mode === "360", `B1 POST mode 'checker'/'360' → 200 · 저장(${o.chk.j.mode}/${o.m360.j.mode})`],
    [o.bogus.s === 400 && o.nul.s === 400 && o.empty.s === 400, `B2 POST mode 'CHECKER'/null/'' → 400 (실제 ${o.bogus.s}/${o.nul.s}/${o.empty.s})`],
    [o.none.s === 200 && o.none.j.mode === null, `B3 POST mode 미전송 → 200 · NULL(구버전 호환, 실제 ${o.none.s}/${o.none.j.mode})`],
    [o.regInherit.s === 200 && o.regInherit.j.mode === "checker", `B4 영역(mode 미전송) → 부모 'checker' 상속 (실제 ${o.regInherit.s}/${o.regInherit.j.mode})`],
    [o.regConflict.s === 400, `B4 영역 mode 가 부모 태그와 다르면 400 (실제 ${o.regConflict.s})`],
    [o.regUnderNull.s === 200 && o.regUnderNull.j.mode === "360", `B5 NULL 부모 아래 영역은 보낸 활성 모드 저장 (실제 ${o.regUnderNull.s}/${o.regUnderNull.j.mode})`],
    [o.putBad.s === 400 && o.putOk.s === 200 && o.putOk.j.mode === "360" && o.putKeep.s === 200 && L(o.none.j.id).mode === "360",
      `B6 PUT mode 'photo' → 400 · '360' → 200 · 미전송 PUT 은 기존값 유지 (실제 ${o.putBad.s}/${o.putOk.s}/${L(o.none.j.id).mode})`],
    [!!L("dck_legacy").id && L("dck_legacy").mode === null && L("dck_legacy").name === "floor", `B7 0029 이전 기존 구역(floor) 유실 0 · mode NULL (목록 ${o.list.length}행)`]
  ];
}
{
  const o = await apiRun(null);
  checkB(o).forEach(([c, l]) => ok(c, l));
}
console.log("\n[Part B 뮤테이션]");
for (const [name, needle, repl, prefix] of [
  ["M8 서버 mode 허용값 검사 제거(아무 값이나 저장)", "if (typeof v === 'string' && (DECK_MODES as readonly string[]).includes(v)) return { mode: v }", "return { mode: v }", "B2"],
  ["M9 서버 영역 부모 mode 상속 제거", "      return { mode: pm }\n", "", "B4"]
]) {
  try {
    const o = await apiRun((s) => mutate(s, needle, repl, name));
    const broke = checkB(o).filter(([c, l]) => !c && l.startsWith(prefix));
    ok(broke.length > 0, name + " → " + prefix + " FAIL 로 뒤집힘(" + broke.length + "건)");
  } catch (e) { ok(false, name + " 실행 실패: " + e.message); }
}

/* ══════════════════ Part C — 실 Chrome · 실 CSS 3파일 · 스크린샷 ══════════════════ */
console.log("\n[Part C · 실 Chrome 375x812 · CSS 3파일 · 전환 전/후 스크린샷 + 모드 노드 대비]");
const SHOT_DIR = path.join(ROOT, ".tmp", "fixmode");
fs.mkdirSync(SHOT_DIR, { recursive: true });
const require = createRequire("file:///C:/Users/FREE/package.json");
let puppeteer = null;
try { puppeteer = require("puppeteer"); } catch (e) { puppeteer = null; }
if (!puppeteer) { ok(false, "C puppeteer 로드 불가 — 실 브라우저 검증 불가(증거 없는 PASS 금지)"); }
else {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/css/style.css"><link rel="stylesheet" href="/css/seastar-family-tokens.css"><link rel="stylesheet" href="/css/seastar-3d-skin.css">
<style>#stage{display:flex;gap:8px;padding:8px}#map{position:relative;width:170px;height:260px;background:#fff;flex:0 0 auto}#side-tree{width:190px;max-height:none;flex-basis:auto}</style>
</head><body><div id="stage"><div id="tree-wrap"><div id="side-tree" class="side-tree"></div></div>
<div><div id="pin-filter-bar"></div><div id="map"><div id="pins-layer"></div></div><div id="pin-count-badge"></div></div></div>
<div id="hub" class="hub-card"></div><div id="pin-list"></div><div id="pin-empty"></div><div id="section-export"></div><div id="pin-list-count"></div>
<script>
const FX = ${JSON.stringify({ decks: fixture("checkboard").Projects.decks, pins: fixture("checkboard").State.pins })};
window.State = { mode: "designer", regMode: "checkboard", pdfPage: 1, pdfPages: 1, currentDeploymentId: "dep1", activePin: null, zones: [], pins: FX.pins, editMode: false, placing: false };
window.Projects = { decks: FX.decks, currentProject: { id: "prj1", name: "sunbo" }, currentDeck: FX.decks[0], selectDeck() {} };
window.App = { _setRegMode(m) { State.regMode = m; UI.renderPinsOnMap(); UI.renderPinList(); }, pinHasContent: () => false, focusPin() {}, isDeckUnsaved: () => false };
window.Zones = { _contains: () => false, focus() {}, render() {} };
window.Auth = { isDesigner: true, headers() { return {}; } };
</script>
<script src="/bundle.js"></script>
<script>window.__render = () => { UI.renderPinsOnMap(); UI.renderPinList();
  document.getElementById("hub").innerHTML = ProjectHub._renderDeckTreeHtml.call(Object.assign(Object.create(ProjectHub), { _deckTreeCache: { prj1: FX.decks } }), { id: "prj1" }); };</script>
</body></html>`;
  const bundle = seriesSrc + "\n" + uiSrc + "\n" + hubSrc + "\nwindow.PinSeries = PinSeries; window.UI = UI; window.ProjectHub = ProjectHub;\n";
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    if (u === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(html); return; }
    if (u === "/bundle.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(bundle); return; }
    const f = path.join(ROOT, "public", u);
    if (u.startsWith("/css/") && fs.existsSync(f)) { res.writeHead(200, { "content-type": "text/css" }); res.end(fs.readFileSync(f)); return; }
    res.writeHead(404); res.end("nf");
  });
  await listenSafePort(server, "127.0.0.1");
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e.message)));
    await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2 });
    await page.goto("http://127.0.0.1:" + server.address().port + "/", { waitUntil: "load" });
    const measure = () => page.evaluate(() => {
      const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(",").map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
      const bgOf = (el) => { const stack = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } }
        let out = { r: 255, g: 255, b: 255 }; for (let i = stack.length - 1; i >= 0; i--) { const c = stack[i]; out = { r: c.r * c.a + out.r * (1 - c.a), g: c.g * c.a + out.g * (1 - c.a), b: c.b * c.a + out.b * (1 - c.a) }; } return out; };
      const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
      const ratio = (el) => { if (!el) return 0; const fg = parse(getComputedStyle(el).color), bg = bgOf(el); const a = lum(fg), b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
      const heads = [...document.querySelectorAll(".tree-node-mode")];
      return {
        markers: document.querySelectorAll("#pins-layer .pin-marker").length,
        modeHeads: heads.map((h) => h.querySelector(".tree-label").textContent.trim() + (h.classList.contains("active") ? "*" : "")),
        ratioActive: ratio(document.querySelector(".tree-node-mode.active")),
        ratioIdle: ratio(document.querySelector(".tree-node-mode:not(.active)")),
        ratioHub: ratio(document.querySelector(".hub-tree-mode-label")),
        visibleDecksActive: [...document.querySelectorAll(".tree-mode.open > .tree-children > .tree-deck > .tree-node .tree-label")].filter((e) => e.offsetParent).map((e) => e.textContent)
      };
    });
    await page.evaluate(() => window.__render());
    const before = await measure();
    await page.screenshot({ path: path.join(SHOT_DIR, "p91-before-checker.png"), fullPage: true });
    // 트리의 [360] 모드 노드를 실제 클릭 → App._setRegMode('photo') → 재렌더
    await page.evaluate(() => { const h = [...document.querySelectorAll(".tree-node-mode")].find((b) => /360/.test(b.textContent)); h.click(); });
    const after = await measure();
    await page.screenshot({ path: path.join(SHOT_DIR, "p91-after-360.png"), fullPage: true });
    ok(errs.length === 0, "C0 페이지 오류 없음 " + JSON.stringify(errs.slice(0, 2)));
    ok(before.markers === 3 && after.markers === 2, `C1 실 DOM 지도 마커: 전환 전 CHECKER ${before.markers} → 후 360 ${after.markers}`);
    ok(before.modeHeads.join() === "CHECKER*,360" && after.modeHeads.join() === "CHECKER,360*", `C2 트리 모드 노드 강조 전 [${before.modeHeads}] → 후 [${after.modeHeads}]`);
    ok(before.visibleDecksActive.join() === "floor,체커구역" && after.visibleDecksActive.join() === "floor,360구역",
      `C3 보이는(펼친) 모드 가지의 구역: 전 [${before.visibleDecksActive}] → 후 [${after.visibleDecksActive}]`);
    ok(before.ratioActive >= 4.5 && before.ratioIdle >= 4.5 && before.ratioHub >= 4.5,
      `C4 글자 대비(실 CSS 3파일 런타임) 활성 ${before.ratioActive.toFixed(2)} · 비활성 ${before.ratioIdle.toFixed(2)} · 허브 ${before.ratioHub.toFixed(2)} ≥ 4.5`);
    ok(fs.existsSync(path.join(SHOT_DIR, "p91-before-checker.png")) && fs.existsSync(path.join(SHOT_DIR, "p91-after-360.png")), "C5 스크린샷 저장 .tmp/fixmode/p91-{before-checker,after-360}.png");
  } finally { await browser.close(); server.close(); }
}

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
