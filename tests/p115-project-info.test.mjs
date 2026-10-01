/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p115-project-info.test.mjs)
 *
 * [WO 20261001-projectinfo] 원본 PDF 트리 고정 · 프로젝트 이름 변경 · 프로젝트 정보(메모+일정).
 * Part A — 실제 11_UI.js(VM) — 원본 노드(ICO.origin, 최상단) 렌더 + 미지정 "지정" 버튼 노출 게이트.
 * Part B — 실제 워커(src/index.tsx 번들) + 실제 D1(Miniflare SQLite) + 실제 마이그레이션 0035 —
 *   PATCH /api/projects/:id 의 세 필드(name/original_deployment_id/info_json) 권한·검증·LWW.
 *
 * 목(mock) 사용 범위: Part A 는 11_UI.js 소스를 그대로 vm 평가(p62 와 동일 패턴, DOM 만 최소 목).
 * Part B 는 실제 워커 + 실제 D1(Miniflare) — D1 목 없음.
 *
 * 뮤테이션 4건, 각 EXIT=1 확인 후 원복:
 *  ⓐ name 권한 체크 제거 → 멤버(비소유자)도 200 되면 안 되는데 됨(①실패)
 *  ⓑ info_json 권한 체크를 canManageMembersOf 로 바꿈(디자이너 멤버도 막힘) → ②실패
 *  ⓒ LWW base_updated_at 비교 제거 → 충돌이 조용히 덮어써짐(409 안 남) → ③실패
 *  ⓓ ProjectInfo.nextLine 의 done 필터 제거 → 완료된 일정도 "다음 일정"에 뜸 → ④실패
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { Miniflare } from "miniflare";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const uiSrc = rd("public/js/modules/11_UI.js");
const infoSrc = rd("public/js/modules/43_ProjectInfo.js");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };

/* ══════════════════════════════════════════════════════════════════════
 * Part A — 원본 노드 렌더(최소 DOM 목, p62 패턴 재사용)
 * ══════════════════════════════════════════════════════════════════════ */
function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => x && set.add(x)), remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle(c, force) { if (force === undefined) { if (set.has(c)) { set.delete(c); return false; } set.add(c); return true; } if (force) set.add(c); else set.delete(c); return !!force; },
    contains: (c) => set.has(c), _set: set
  };
}
function makeEl(tag) {
  const el = {
    tagName: tag || "div", style: {}, dataset: {}, title: "", value: "", disabled: false,
    _text: "", _html: "", _children: [], _handlers: {},
    appendChild(c) { this._children.push(c); return c; },
    setAttribute(k, v) { this.dataset["attr_" + k] = String(v); },
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; this._children = []; },
    get textContent() { return this._text || this._html.replace(/<[^>]+>/g, ""); }, set textContent(v) { this._text = String(v); },
  };
  Object.defineProperty(el, "className", {
    get() { return Array.from(this.classList._set).join(" "); },
    set(v) { this.classList = makeClassList(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c)); }
  });
  el.classList = makeClassList();
  return el;
}
function runTree(src, ctx) {
  const host = makeEl("div");
  const doc = {
    createElement: (t) => makeEl(t),
    getElementById: (id) => (id === "side-tree" ? host : null),
  };
  const sandbox = {
    document: doc, console, State: ctx.State, Projects: ctx.Projects, PinSeries: ctx.PinSeries || {},
    App: {}, RegionMerge: undefined, Requests: undefined, Notes: undefined, ProjectInfo: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(src + "\nthis.UI = UI;", sandbox);
  sandbox.UI.renderTree();
  return { host, UI: sandbox.UI };
}
console.log("\n[Part A · 원본 노드 — 실제 11_UI.js]");
{
  const proj = { id: "prj_a1", name: "테스트", can_manage_members: false, my_role: "viewer" };
  const decks = [{ id: "d1", project_id: "prj_a1", name: "메인데크", parent_id: null, deployment_id: "dep1" }];
  const Projects = { currentProject: proj, decks, currentDeck: null, pickOriginalDeck: () => null, openOriginal: () => { Projects._opened = (Projects._opened || 0) + 1; }, setOriginalToCurrent: () => { Projects._setCalled = true; } };
  const State = { pdfPage: 1, pdfPages: 1, mode: "designer", pins: [], zones: [] };
  const { host } = runTree(uiSrc, { State, Projects });
  const findAll = (node, cls) => { let out = []; (node._children || []).forEach((c) => { if (c.classList && c.classList.contains(cls)) out.push(c); out = out.concat(findAll(c, cls)); }); return out; };
  const originNodes = findAll(host, "tree-node-origin");
  ok(originNodes.length === 1, "① 원본 노드가 트리에 정확히 1개 렌더된다(원본 미지정 상태)");
  const txt = originNodes[0] ? originNodes[0].innerHTML : "";
  ok(/미지정/.test(txt), "① 원본 미지정 문구가 보인다");
  ok(!/tree-origin-set/.test(txt), "① can_manage_members=false 면 '지정' 버튼이 없다");

  // 최상단 보장 — 프로젝트 children 중 첫 child 가 origin 노드
  const projWrap = findAll(host, "tree-project")[0];
  const firstChild = projWrap && projWrap._children && projWrap._children.find((c) => c.classList && (c.classList.contains("tree-node-project") === false));
  ok(!!firstChild && firstChild.classList.contains("tree-node-origin"), "② 프로젝트 헤더 바로 다음(구역 묶음보다 위)이 원본 노드다");
}
{
  const proj2 = { id: "prj_a2", name: "테스트2", can_manage_members: true, my_role: "designer" };
  const decks2 = [{ id: "d2", project_id: "prj_a2", name: "구역A", parent_id: null, deployment_id: "dep2" }];
  const Projects2 = { currentProject: proj2, decks: decks2, currentDeck: null, pickOriginalDeck: () => null, openOriginal: () => {}, setOriginalToCurrent: () => { Projects2._setCalled = true; } };
  const State2 = { pdfPage: 1, pdfPages: 1, mode: "designer", pins: [], zones: [] };
  const { host } = runTree(uiSrc, { State: State2, Projects: Projects2 });
  const findAll = (node, cls) => { let out = []; (node._children || []).forEach((c) => { if (c.classList && c.classList.contains(cls)) out.push(c); out = out.concat(findAll(c, cls)); }); return out; };
  const originNode = findAll(host, "tree-node-origin")[0];
  ok(!!originNode && /tree-origin-set/.test(originNode.innerHTML), "③ can_manage_members=true 면 '지정' 버튼이 보인다");
  const setBtn = (originNode._children || []).find((c) => c.classList && c.classList.contains("tree-origin-set"));
  if (originNode._handlers && originNode._handlers.click) originNode._handlers.click[0]({ stopPropagation() {} });
  ok(Projects2._setCalled === true, "④ 원본 미지정 노드 클릭 → Projects.setOriginalToCurrent() 호출");
}

/* ── 뮤테이션 ⓓ: ProjectInfo.nextLine 의 done 필터 제거 ────────────── */
{
  console.log("\n[뮤테이션ⓓ] nextLine 의 done 필터 제거 → ④가 실패해야 함(완료 일정이 다음 일정에 뜸)");
  const needle = "const upcoming = list.filter((s) => s && !s.done && s.date && s.date >= todayKey).sort((a, b) => (a.date < b.date ? -1 : 1));";
  const mut = infoSrc.replace(needle, "const upcoming = list.filter((s) => s && s.date && s.date >= todayKey).sort((a, b) => (a.date < b.date ? -1 : 1));");
  if (mut === infoSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(mut + "\nthis.ProjectInfo = ProjectInfo;", sandbox);
    const todayKey = new Date().toISOString().slice(0, 10);
    const line = sandbox.ProjectInfo.nextLine({ schedule: [{ date: todayKey, kind: "방선", done: true }] });
    ok(line !== null, "뮤테이션 적용 시 완료된 일정도 다음 일정으로 표시된다(④가 깨짐)");
  }
  // 원본 동작 확인(뮤테이션 없이) — 완료 일정은 제외돼야 한다
  const sandbox2 = { console };
  vm.createContext(sandbox2);
  vm.runInContext(infoSrc + "\nthis.ProjectInfo = ProjectInfo;", sandbox2);
  const todayKey = new Date().toISOString().slice(0, 10);
  const line2 = sandbox2.ProjectInfo.nextLine({ schedule: [{ date: todayKey, kind: "방선", done: true }] });
  ok(line2 === null, "④ 원본 동작 — 완료된 일정은 '다음 일정'에 뜨지 않는다");
  const line3 = sandbox2.ProjectInfo.nextLine({ schedule: [{ date: todayKey, kind: "방선", done: false }] });
  ok(line3 && /방선/.test(line3), "④ 원본 동작 — 미완료 당일 일정은 뜬다(실제: " + line3 + ")");
}

/* ══════════════════════════════════════════════════════════════════════
 * Part B — 실제 워커(src/index.tsx) + 실제 D1(Miniflare) + 실제 마이그레이션
 * ══════════════════════════════════════════════════════════════════════ */
const MIG_DIR = path.join(ROOT, "migrations");
const MIGS = fs.readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
const stmtsOf = (file) =>
  fs.readFileSync(path.join(MIG_DIR, file), "utf8")
    .replace(/--[^\n]*/g, "")
    .split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
async function applyMigrations(db, files) { for (const f of files) for (const st of stmtsOf(f)) await db.exec(st); }
async function buildWorker(transform) {
  const out = path.join(os.tmpdir(), "p115-worker-" + process.pid + "-" + Math.random().toString(36).slice(2) + ".mjs");
  const plugins = transform ? [{
    name: "p115-mutate",
    setup(b) { b.onLoad({ filter: /index\.tsx$/ }, (args) => ({ contents: transform(fs.readFileSync(args.path, "utf8")), loader: "tsx" })); }
  }] : [];
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/index.tsx")], bundle: true, format: "esm", platform: "neutral",
    outfile: out, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
    conditions: ["workerd", "worker", "browser"], plugins
  });
  return out;
}
const now0 = Date.now();
const TOK_OWNER = "local-p115-owner";
const TOK_MEMBER = "local-p115-designer-member";
const TOK_VIEWER = "local-p115-viewer-member";
const SEED = (now) => [
  ["INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)", ["owner@p115.test", "오너", "designssir@gmail.com", now, now]],
  ["INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)", ["member@p115.test", "멤버디자이너", "project-invite:prj_p115 by owner", now, now]],
  ["INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)", ["owner@p115.test", "오너", "p115.test", "x", "y", now, now]],
  ["INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)", ["member@p115.test", "멤버", "p115.test", "x", "y", now, now]],
  ["INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)", ["viewer@p115.test", "뷰어", "p115.test", "x", "y", now, now]],
  ["INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOK_OWNER, "owner@p115.test", now, now + 8.64e7]],
  ["INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOK_MEMBER, "member@p115.test", now, now + 8.64e7]],
  ["INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOK_VIEWER, "viewer@p115.test", now, now + 8.64e7]],
  ["INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)", ["prj_p115", "P115 프로젝트", "", "owner@p115.test", now, now]],
  ["INSERT INTO deployments (id, title, file_name, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)", ["dep_p115", "배포본", "A0.pdf", now, now]],
  ["INSERT INTO project_members (project_id, email, role, granted_by, created_at) VALUES (?, ?, ?, ?, ?)", ["prj_p115", "member@p115.test", "designer", "owner@p115.test", now]],
  ["INSERT INTO project_members (project_id, email, role, granted_by, created_at) VALUES (?, ?, ?, ?, ?)", ["prj_p115", "viewer@p115.test", "viewer", "owner@p115.test", now]],
];
const H = (tok) => ({ Authorization: "Bearer " + tok, "Content-Type": "application/json" });

async function apiRun(transform) {
  const script = await buildWorker(transform);
  const mf = new Miniflare({
    modules: true, scriptPath: script, d1Databases: { DB: "p115-" + Math.random().toString(36).slice(2) },
    r2Buckets: { R2: "p115r2" }, bindings: { DEMO_LOGIN: "0" }, compatibilityDate: "2025-01-01"
  });
  try {
    const db = await mf.getD1Database("DB");
    await applyMigrations(db, MIGS);
    const now = now0;
    for (const [q, a] of SEED(now)) await db.prepare(q).bind(...a).run();
    const B = "http://p115.test";
    const fetchJson = async (p, opts) => { const r = await mf.dispatchFetch(B + p, opts); let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j }; };
    return { mf, db, fetchJson };
  } catch (e) { await mf.dispose(); throw e; }
}

console.log("\n[Part B · 실제 D1(Miniflare) + 실제 워커 — PATCH /api/projects/:id]");
{
  const { mf, fetchJson } = await apiRun();
  try {
    // ① 마이그레이션 0035 비파괴 확인
    const m0035 = MIGS.filter((f) => f.startsWith("0035"));
    ok(m0035.length === 1, "① migrations/0035_project_info.sql 존재");

    // ② 이름 변경 — 비멤버/멤버(디자이너) 403, 소유자 200
    const r1 = await fetchJson("/api/projects/prj_p115", { method: "PATCH", headers: H(TOK_MEMBER), body: JSON.stringify({ name: "바뀐이름" }) });
    ok(r1.status === 403, "② 디자이너 멤버는 이름 변경 403(소유자/super 만)");
    const r2 = await fetchJson("/api/projects/prj_p115", { method: "PATCH", headers: H(TOK_OWNER), body: JSON.stringify({ name: "바뀐이름" }) });
    ok(r2.status === 200 && r2.body.data.name === "바뀐이름", "② 소유자는 200 + 즉시 반영된 이름 반환");
    const r3 = await fetchJson("/api/projects/prj_p115", { method: "PATCH", headers: H(TOK_OWNER), body: JSON.stringify({ name: "" }) });
    ok(r3.status === 400, "② 빈 이름은 400");
    const r4 = await fetchJson("/api/projects/prj_p115", { method: "PATCH", headers: H(TOK_OWNER), body: JSON.stringify({ name: "x".repeat(81) }) });
    ok(r4.status === 400, "② 81자 이름은 400(상한 80)");

    // ③ 원본 지정 — 디자이너 멤버 403, 소유자 200
    const r5 = await fetchJson("/api/projects/prj_p115", { method: "PATCH", headers: H(TOK_MEMBER), body: JSON.stringify({ original_deployment_id: "dep_p115" }) });
    ok(r5.status === 403, "③ 디자이너 멤버는 원본 지정 403");
    const r6 = await fetchJson("/api/projects/prj_p115", { method: "PATCH", headers: H(TOK_OWNER), body: JSON.stringify({ original_deployment_id: "dep_p115" }) });
    ok(r6.status === 200 && r6.body.data.original_deployment_id === "dep_p115", "③ 소유자는 200 + original_deployment_id 반영");

    // ④ info_json — 뷰어 403, 디자이너 멤버 200(메모+일정 저장), 조회 시 info_json 에 반영
    const r7 = await fetchJson("/api/projects/prj_p115", { method: "PATCH", headers: H(TOK_VIEWER), body: JSON.stringify({ info_json: { note: "몰래", schedule: [] } }) });
    ok(r7.status === 403, "④ 열람자는 정보메모 편집 403");
    const sch = [{ id: "sch1", date: "2026-12-01", kind: "방선", content: "1차 방선", done: false }];
    const r8 = await fetchJson("/api/projects/prj_p115", { method: "PATCH", headers: H(TOK_MEMBER), body: JSON.stringify({ info_json: { note: "현장 메모", schedule: sch } }) });
    ok(r8.status === 200 && r8.body.data.info_json.note === "현장 메모" && r8.body.data.info_json.schedule.length === 1, "④ 디자이너 멤버는 정보메모 저장 200 + 즉시 반영");
    ok(r8.body.data.info_json.updatedBy === "member@p115.test", "④ updatedBy 가 저장한 사용자 이메일");
    const baseTs = r8.body.data.info_json.updatedAt;

    // ⑤ LWW 충돌 — 다른 updatedAt(오래된 base)로 저장 시도 → 409 + 서버 최신값 반환
    const r9 = await fetchJson("/api/projects/prj_p115", { method: "PATCH", headers: H(TOK_OWNER), body: JSON.stringify({ info_json: { note: "덮어쓰기 시도", schedule: [] }, base_updated_at: baseTs - 1 }) });
    ok(r9.status === 409, "⑤ base_updated_at 불일치 → 409(조용히 덮어쓰지 않는다)");
    const r10 = await fetchJson("/api/projects/prj_p115", { method: "PATCH", headers: H(TOK_OWNER), body: JSON.stringify({ info_json: { note: "정상 저장", schedule: [] }, base_updated_at: baseTs }) });
    ok(r10.status === 200 && r10.body.data.info_json.note === "정상 저장", "⑤ 올바른 base_updated_at 이면 200 저장");

    // ⑥ GET /api/projects 목록에도 info_json 이 실린다(허브 카드 '다음 일정' 데이터 소스)
    const list = await fetchJson("/api/projects", { headers: H(TOK_OWNER) });
    const row = (list.body.data || []).find((p) => p.id === "prj_p115");
    ok(!!row && row.info_json && typeof row.info_json.note === "string", "⑥ /api/projects 목록 응답에 info_json 이 포함된다");
  } finally { await mf.dispose(); }
}

/* ── 뮤테이션 ⓐ: name 권한 체크 제거 ──────────────────────────────── */
{
  console.log("\n[뮤테이션ⓐ] name 권한 체크 제거 → 디자이너 멤버도 이름 변경 가능해지면 안 되는데 가능해짐");
  const needle = "if (body.name !== undefined) {\n    if (!canManageMembersOf(c, user, proj.owner)) return c.json({ error: 'forbidden — owner/super only' }, 403)";
  const transform = (src) => {
    const mut = src.replace(needle, "if (body.name !== undefined) {\n    if (false) return c.json({ error: 'forbidden — owner/super only' }, 403)");
    if (mut === src) throw new Error("NEEDLE_NOT_FOUND_A");
    return mut;
  };
  try {
    const { mf, fetchJson } = await apiRun(transform);
    try {
      const r = await fetchJson("/api/projects/prj_p115", { method: "PATCH", headers: H(TOK_MEMBER), body: JSON.stringify({ name: "해킹된이름" }) });
      ok(r.status === 200, "뮤테이션 적용 시 디자이너 멤버도 200(권한 체크가 사라졌음을 확인 — ②가 깨짐)");
    } finally { await mf.dispose(); }
  } catch (e) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함: " + e.message); failed++; }
}

/* ── 뮤테이션 ⓑ: info_json 권한을 canManageMembersOf 로 바꿈(디자이너 멤버도 막힘) ── */
{
  console.log("\n[뮤테이션ⓑ] info_json 권한을 소유자 전용으로 좁힘 → 디자이너 멤버가 403 되어야 하는데 원래는 200");
  const needle = "if (!(await canManageProject(c, user, id))) return c.json({ error: 'forbidden — designer+ only' }, 403)";
  const transform = (src) => {
    const mut = src.replace(needle, "if (!canManageMembersOf(c, user, proj.owner)) return c.json({ error: 'forbidden — designer+ only' }, 403)");
    if (mut === src) throw new Error("NEEDLE_NOT_FOUND_B");
    return mut;
  };
  try {
    const { mf, fetchJson } = await apiRun(transform);
    try {
      const r = await fetchJson("/api/projects/prj_p115", { method: "PATCH", headers: H(TOK_MEMBER), body: JSON.stringify({ info_json: { note: "뮤테이션", schedule: [] } }) });
      ok(r.status === 403, "뮤테이션 적용 시 디자이너 멤버가 403(원래 200 이어야 하는 경로가 깨짐 — ④가 깨짐을 확인)");
    } finally { await mf.dispose(); }
  } catch (e) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함: " + e.message); failed++; }
}

/* ── 뮤테이션 ⓒ: LWW base_updated_at 비교 제거 ──────────────────────── */
{
  console.log("\n[뮤테이션ⓒ] LWW 비교 제거 → 충돌이 조용히 덮어써짐(409 안 남)");
  const needle = "if (body.base_updated_at !== undefined && cur.updatedAt && Number(body.base_updated_at) !== Number(cur.updatedAt)) {\n      return c.json({ error: 'conflict — modified by someone else', data: cur }, 409)\n    }";
  const transform = (src) => {
    const mut = src.replace(needle, "");
    if (mut === src) throw new Error("NEEDLE_NOT_FOUND_C");
    return mut;
  };
  try {
    const { mf, fetchJson } = await apiRun(transform);
    try {
      await fetchJson("/api/projects/prj_p115", { method: "PATCH", headers: H(TOK_OWNER), body: JSON.stringify({ info_json: { note: "첫 저장", schedule: [] } }) });
      const r = await fetchJson("/api/projects/prj_p115", { method: "PATCH", headers: H(TOK_OWNER), body: JSON.stringify({ info_json: { note: "조용히 덮어씀", schedule: [] }, base_updated_at: 1 }) });
      ok(r.status === 200, "뮤테이션 적용 시 잘못된 base_updated_at 로도 200(충돌 경고가 사라짐 — ⑤가 깨짐을 확인)");
    } finally { await mf.dispose(); }
  } catch (e) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함: " + e.message); failed++; }
}

console.log(failed ? ("\n[" + failed + " FAILED]") : "\n[ALL PASSED]");
process.exit(failed ? 1 : 0);
