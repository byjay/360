/**
 * p111 — 열람자 요청·질문 + 디자이너 구역별 요청함 + 열람자 번호대역 제외 (WO 20261001-viewreq)
 * 프레임워크 0 · 실행: node tests/p111-viewer-requests.test.mjs
 *
 * 마스터: "열람자는 보기만 할 거다. 단 요청을 할 수 있다. 노트를 하듯이 디자이너에게 요청이나 질문은 가능하게 해"
 *         "그걸 디자이너는 구역별로 리스트해서 볼 수 있게 해" · 열람자는 번호 대역을 배정받지 않는다.
 *
 * S = 서버 src/index.tsx 실 번들 → Miniflare(workerd) + 실 D1(migrations 전부). 목 0.
 * C = 클라 실 소스(11_UI · 13_Notes · 20_App · 42_Requests)를 vm 에 — DOM 은 최소 요소 트리(리프 I/O 대체만).
 *
 * 뮤테이션: P111_MUT=<이름> → 해당 소스를 바꿔 실행 → EXIT=1 이어야 한다(대상 문자열 못 찾으면 EXIT=2).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { Miniflare } from "miniflare";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const M = "public/js/modules/";
const SRC = { srv: rd("src/index.tsx"), ui: rd(M + "11_UI.js"), notes: rd(M + "13_Notes.js"), app: rd(M + "20_App.js"), req: rd(M + "42_Requests.js") };
const MUTS = {
  "allowlist":     ["srv", ", '/api/inquiries', '/api/notes']", ", '/api/inquiries']"],
  "readonly-id":   ["srv", "if (!user || user._readonly) return { user, designer: false, role: 'guest', email: null }", "if (!user) return { user, designer: false, role: 'guest', email: null }"],
  // [WO 20261012-viewlink] 이름 필수 → 선택(비우면 '열람자') 로 계약 변경 — 뮤테이션도 새 계약의 기본값 제거로 바꾼다
  "name-default":  ["srv", "author = String(body.author || '').trim() || VIEW_LINK_USER.name", "author = String(body.author || '').trim()"],
  "viewer-kind":   ["srv", "if (!a.designer && !NOTE_VIEWER_KINDS.includes(kind)) return", "if (false) return"],
  "rate":          ["srv", "if (limiterKey && await overRateLimit(c, 'pin_notes', limiterKey, NOTE_REQUEST_RATE_LIMIT_PER_MIN))", "if (false)"],
  "edit-key":      ["srv", "if (key && note.author_key_hash && (await sha256Hex(key)) === String(note.author_key_hash)) return 'author'", "if (note.author_key_hash) return 'author'"],
  "author-status": ["srv", "if (right === 'author' && String(note.kind || 'note') !== 'note' && (typeof body.status === 'string' || typeof body.assignee === 'string')) {", "if (false) {"],
  "deck-geo":      ["srv", "if (area < bestArea || (area === bestArea && best && !best.parent_id && d.parent_id)) { best = d; bestArea = area }", "if (!best) { best = d; bestArea = area }"],
  "contact-leak":  ["srv", "data: (results || []).map((r: any) => mapNote(r, actor.designer, actor.designer ? undefined : actor.email))", "data: (results || []).map((r: any) => mapNote(r, true, actor.designer ? undefined : actor.email))"],
  "summary-reply": ["srv", "WHERE deleted = 0 AND deployment_id = ? AND kind != 'reply'", "WHERE deleted = 0 AND deployment_id = ?"],
  "inbox-perm":    ["srv", "const denied = await deploymentWriteDenied(c, a.user, pid)\n  if (denied) return c.json({ error: denied.error }, denied.status)\n  const { results } = await c.env.DB.prepare(\n    `SELECT n.* FROM pin_notes n", "const denied = null\n  const { results } = await c.env.DB.prepare(\n    `SELECT n.* FROM pin_notes n"],
  "post-gate":     ["srv", "if (locked) return c.json({ error: 'gate required — invite code', gate_required: true, project_id: locked }, 403)", ""],
  "band-viewer":   ["srv", "const rows = all.filter((m: any) => String(m.role) !== 'viewer')", "const rows = all"],
  "band-release":  ["srv", "await c.env.DB.prepare(\"UPDATE project_members SET num_band = NULL WHERE project_id = ? AND email = ? AND role = 'viewer'\").bind(pid, m.email).run()", "void 0"],
  "group-tree":    ["req", "(G.childrenOf.get(String(d.id)) || []).forEach((c) => walk(c, depth + 1));", ""],
  "viewer-reply":  ["req", "(repliesOf.get(String(n.id)) || []).sort((a, b) => ts(a.created_at) - ts(b.created_at)).forEach((r) => {", "[].forEach((r) => {"],
  "tick":          ["app", "      if (typeof Requests !== \"undefined\" && Requests.refresh) Requests.refresh();\n      if (State.mode !== \"designer\" || !State.autoSaveDepId) return \"idle\";", "      if (State.mode !== \"designer\" || !State.autoSaveDepId) return \"idle\";"],
  "pin-tap":       ["app", "else if (typeof Requests !== \"undefined\" && Requests.openViewer) Requests.openViewer({ pin, noMedia: true });", ""],
  "notes-redirect":["notes", "Requests.openViewer({ pin: this._pin });\n        return;", "void 0;"],
  "tree-badge":    ["ui", "if (reqTag) head.insertAdjacentHTML(\"beforeend\", reqTag);", ""],
  "live-scope":    ["req", "return (proj && this._pid === proj.id) ? this._items : [];", "return this._items;"],
};
const MUT = process.env.P111_MUT || "";
if (MUT) {
  const m = MUTS[MUT];
  if (!m) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }
  if (!SRC[m[0]].includes(m[1])) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함: " + MUT); process.exit(2); }
  SRC[m[0]] = SRC[m[0]].replace(m[1], m[2]);
  console.log("[뮤테이션 적용] " + MUT);
}

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };
const watchdog = setTimeout(() => { console.log("\nWATCHDOG — 180s 초과 → FAIL"); process.exit(1); }, 180000);

/* ══ 최소 DOM(리프 대체) — appendChild · 속성 · [attr] / [attr="v"] 선택자 · textContent 재귀 ══ */
function makeEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(), children: [], parentNode: null, attrs: {}, style: { cssText: "" }, _text: "", _h: {},
    value: "", disabled: false, type: "", maxLength: 0, placeholder: "", title: "", id: "",
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    insertBefore(c, ref) { c.parentNode = this; const i = this.children.indexOf(ref); if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
    insertAdjacentElement(pos, c) { const p = this.parentNode; if (!p) return; const i = p.children.indexOf(this); c.parentNode = p; p.children.splice(i + 1, 0, c); return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null },
    addEventListener(t, f) { (this._h[t] = this._h[t] || []).push(f); },
    click() { (this._h.click || []).forEach((f) => f({ target: this, stopPropagation() {}, preventDefault() {} })); },
    focus() {},
    querySelectorAll(sel) { const out = []; const walk = (n) => n.children.forEach((c) => { if (matches(c, sel)) out.push(c); walk(c); }); walk(this); return out; },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
  };
  Object.defineProperty(el, "textContent", { get() { return this._text + this.children.map((c) => c.textContent).join(""); }, set(v) { this._text = String(v == null ? "" : v); this.children = []; } });
  Object.defineProperty(el, "innerHTML", { get() { return this._text; }, set(v) { this._text = String(v); this.children = []; } });
  return el;
}
function matches(el, sel) {
  const m = sel.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
  if (!m) return false;
  if (!(m[1] in el.attrs)) return false;
  return m[2] == null || el.attrs[m[1]] === m[2];
}
function makeCtx(extra) {
  const reg = {}, ls = {}, calls = { refresh: 0, openViewer: [], toast: [] };
  const body = makeEl("body");
  body.classList = { contains: () => false, toggle() {}, add() {}, remove() {} };
  const document = { body, visibilityState: "visible", activeElement: null, getElementById: (id) => reg[id] || null, createElement: (t) => makeEl(t), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
  const State = { pins: [], mode: "designer", pdfPage: 1, zones: [], currentDeploymentId: null };
  const sandbox = {
    console, document, JSON, Map, Set, Math, Date, Promise, State, setTimeout, clearTimeout, navigator: { onLine: true },
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); } },
    Auth: { user: null, readonly: false, isDesigner: true, headers: () => ({}) },
    Prompt: { toast: (m) => calls.toast.push(m), confirm: async () => true },
    requestAnimationFrame: (f) => f(), window: null,
  };
  Object.assign(sandbox, extra || {});
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC.ui + "\n" + SRC.notes + "\n" + SRC.req + "\n;globalThis.__X = { UI, Notes, Requests };", sandbox);
  return Object.assign({ State, reg, ls, calls, sandbox, document }, sandbox.__X);
}

/* ══ 서버 ══ */
const MIG_DIR = path.join(ROOT, "migrations");
const MIGS = fs.readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
ok(MIGS.includes("0034_note_requests.sql"), "마이그레이션 0034_note_requests.sql 존재");
const stmtsOf = (file) => fs.readFileSync(path.join(MIG_DIR, file), "utf8").replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
const workerOut = path.join(os.tmpdir(), "p111-worker-" + process.pid + ".mjs");
await esbuild.build({
  stdin: { contents: SRC.srv, resolveDir: path.join(ROOT, "src"), sourcefile: "index.tsx", loader: "tsx" },
  bundle: true, format: "esm", platform: "neutral", outfile: workerOut, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
  conditions: ["workerd", "worker", "browser"],
});
const mf = new Miniflare({ modules: true, scriptPath: workerOut, d1Databases: { DB: "p111-" + Date.now() }, r2Buckets: { R2: "p111r2-" + Date.now() }, bindings: { DEMO_LOGIN: "0" }, compatibilityDate: "2025-01-01" });
const BASE = "http://p111.test";
const db = await mf.getD1Database("DB");
try {
  for (const f of MIGS) for (const st of stmtsOf(f)) await db.exec(st);
  const U = { o: "own@seastar.test", d: "dsg@seastar.test", v1: "vw1@outside.test", v2: "vw2@outside.test", v3: "vw3@outside.test" };
  const TOK = {};
  const now0 = Date.now();
  const run = (q, a) => db.prepare(q).bind(...a).run();
  const first = (q, a) => db.prepare(q).bind(...a).first();
  const addUser = async (k, designer) => {
    if (designer) await run("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)", [U[k], k, "designssir@gmail.com", now0, now0]);
    await run("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)", [U[k], "이름" + k, U[k].split("@")[1], "x", "y", now0, now0]);
    TOK[k] = "local-p111-" + k;
    await run("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOK[k], U[k], now0, now0 + 8.64e7]);
  };
  await addUser("o", true);
  for (const k of ["d", "v1", "v2", "v3"]) await addUser(k, false);
  await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES ('prj_R', '요청 프로젝트', '', ?, ?, ?, 0)", [U.o, now0, now0]);
  // 호출마다 다른 IP(레이트리밋 버킷 분리) — 레이트리밋 검사(S3)만 같은 IP 를 명시한다
  let ipSeq = 0;
  const api = async (who, method, url, body, extraH) => {
    ipSeq++;
    const h = Object.assign({ "Content-Type": "application/json", "CF-Connecting-IP": "10.1." + (ipSeq >> 8) + "." + (ipSeq & 255) }, extraH || {});
    const t = who && (TOK[who] || who);
    if (t) h.Authorization = "Bearer " + t;
    const r = await mf.dispatchFetch(BASE + url, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, j };
  };

  // 멤버: d = designer, v1·v2 = viewer
  await api("o", "POST", "/api/projects/prj_R/members", { email: U.d, role: "designer" });
  await api("o", "POST", "/api/projects/prj_R/members", { email: U.v1, role: "viewer" });
  await api("o", "POST", "/api/projects/prj_R/members", { email: U.v2, role: "viewer" });

  // 도면·구역: dep1 = 구역 A(페이지 전체) + 영역 A1(crop 60,60,30,30 창 방식 · 같은 배포본) / dep2 = 구역 B
  const pins1 = [{ id: "p1", page: 1, x: 20, y: 20, label: "1", checkboard: true }, { id: "p2", page: 1, x: 70, y: 70, label: "2", checkboard: true }];
  const PAGE_URL = "/api/r2/object/assets/p111-base.png";
  const dep1 = (await api("o", "POST", "/tables/deployments", { title: "GA", file_name: "GA.pdf", project_id: "prj_R", pins: JSON.stringify(pins1), pages_data: JSON.stringify([PAGE_URL]), drawing_data: PAGE_URL })).j.id;
  const dep2 = (await api("o", "POST", "/tables/deployments", { title: "B", file_name: "B.pdf", project_id: "prj_R", pins: JSON.stringify([{ id: "p9", page: 1, x: 50, y: 50, label: "9", checkboard: true }]), pages_data: JSON.stringify([PAGE_URL]), drawing_data: PAGE_URL })).j.id;
  const deckA = (await api("o", "POST", "/api/projects/prj_R/decks", { name: "구역A", deployment_id: dep1, page: 1 })).j;
  const deckA1 = (await api("o", "POST", "/api/projects/prj_R/decks", { name: "영역A1", deployment_id: dep1, page: 1, crop: { x: 60, y: 60, w: 30, h: 30 }, parent_id: deckA.id })).j;
  const deckB = (await api("o", "POST", "/api/projects/prj_R/decks", { name: "구역B", deployment_id: dep2, page: 1 })).j;
  ok(!!(dep1 && dep2 && deckA.id && deckA1.id && deckB.id && deckA1.parent_id === deckA.id), "전제: 배포본 2 · 구역 A/B · 영역 A1(부모 A)");
  // 공유/배포 링크 열람자 = 서버 서명 열람전용 토큰(두 사람 — 같은 공용 계정 이메일을 쓴다)
  // [WO 20261009-readacl] 열람 토큰은 **배포된 프로젝트의 열람 링크(?d=)** 로만 발급된다 → 배포 후 dep1 링크로 발급.
  const pub = await api("o", "POST", "/api/projects/prj_R/publish", {});
  ok(pub.status === 200, "전제: 프로젝트 배포(열람 링크 활성) — " + pub.status);
  const anon1 = (await api(null, "POST", "/api/auth/auto-entry", { kind: "viewer", d: dep1 })).j.token;
  const anon2 = (await api(null, "POST", "/api/auth/auto-entry", { kind: "viewer", d: dep1 })).j.token;
  ok(typeof anon1 === "string" && anon1.startsWith("ae1.") && anon1 !== anon2, "전제: 공유 링크 열람전용 토큰 2개 발급");

  console.log("\n[S1 viewer 멤버 — 요청 POST 200 · 핀 편집 403]");
  const r1 = await api("v1", "POST", "/api/notes", { deployment_id: dep1, pin_id: "p1", pin_label: "1", kind: "request", body: "<b>1번 사진</b> 다시 찍어주세요", status: "done", assignee: "x" });
  ok(r1.status === 200 && r1.j.kind === "request" && r1.j.author_role === "viewer" && r1.j.status === "open" && r1.j.assignee === null, "S1 viewer 요청 → 200 · kind=request · role=viewer · status 강제 open · assignee 무시 — " + r1.status + " " + JSON.stringify(r1.j && { k: r1.j.kind, r: r1.j.author_role, s: r1.j.status }));
  ok(r1.j.deck_id === deckA.id, "S1 핀 p1(20,20) → 구역 A 로 확정 — " + (r1.j && r1.j.deck_id));
  ok(!r1.j.edit_key, "S1 실계정 viewer 에게는 수정키 미발급(이메일로 본인 판정)");
  const v1Note = r1.j.id;
  const rk = await api("v1", "POST", "/api/notes", { deployment_id: dep1, pin_id: "p1", kind: "note", body: "x" });
  ok(rk.status === 403, "S1 viewer 가 kind=note(이슈) 작성 → 403 — " + rk.status);
  const pe = await api("v1", "PATCH", "/tables/deployments/" + dep1, { pins: JSON.stringify([]), base_version: 0 });
  ok(pe.status === 403, "S1 viewer 멤버 핀 편집 PATCH → 403 — " + pe.status);
  const pa = await api(anon1, "PATCH", "/tables/deployments/" + dep1, { pins: JSON.stringify([]) });
  ok(pa.status === 403, "S1 공유 링크 세션 핀 편집 PATCH → 403(readOnlyGuard 유지) — " + pa.status);

  console.log("\n[S2 공유 링크 익명 — 이름 필수 · 수정키 · 핀 없는 요청]");
  // [WO 20261012-viewlink] 마스터 "뷰어는 ... 코멘트노드의 쓰기 권한으로 작성후 디자이너에게 문의할 권한만" + 열람 세션 = 사람 신원 0
  //   → 이름/소속은 선택, 비우면 '열람자'(종전 계약: 400). 아래 S6 집계를 바꾸지 않도록 만든 글은 수정키로 바로 지운다.
  const n0 = await api(anon1, "POST", "/api/notes", { deployment_id: dep1, pin_id: "p2", body: "질문입니다", kind: "question" });
  ok(n0.status === 200 && n0.j.author === "열람자" && typeof n0.j.edit_key === "string", "S2 익명 이름 없음 → 200 · author='열람자' — " + n0.status + " " + JSON.stringify(n0.j && n0.j.author));
  if (n0.j && n0.j.id && n0.j.edit_key) {
    const del0 = await api(anon1, "DELETE", "/api/notes/" + n0.j.id, null, { "X-Note-Key": n0.j.edit_key });
    ok(del0.status === 200, "S2 이름 없이 쓴 글 → 본인 수정키로 삭제 200 — " + del0.status);
  }
  const nb = await api(anon1, "POST", "/api/notes", { deployment_id: dep1, pin_id: "p2", body: "q", author: "김현장", contact: "not-an-email" });
  ok(nb.status === 400, "S2 회신 이메일 형식 오류 → 400 — " + nb.status);
  const a1 = await api(anon1, "POST", "/api/notes", { deployment_id: dep1, pin_id: "p2", pin_label: "2", body: "배관 위치가 맞나요?", kind: "question", author: "김현장", contact: "kim@field.test" });
  ok(a1.status === 200 && a1.j.author_role === "guest" && a1.j.author_email === null && typeof a1.j.edit_key === "string" && a1.j.edit_key.length > 20, "S2 익명 질문 → 200 · role=guest · author_email NULL(공용계정 기록 금지) · 수정키 발급 — " + a1.status);
  ok(a1.j.deck_id === deckA1.id, "S2 핀 p2(70,70) → 영역 A1(crop 안 · 가장 작은 deck) — " + a1.j.deck_id);
  const keyRow = await first("SELECT author_key_hash, ip FROM pin_notes WHERE id = ?", [a1.j.id]);
  ok(keyRow && keyRow.author_key_hash && keyRow.author_key_hash !== a1.j.edit_key && keyRow.author_key_hash.length === 64, "S2 DB 에는 수정키 해시만(원문 없음)");
  const a2 = await api(anon1, "POST", "/api/notes", { deployment_id: dep1, pin_id: "", body: "도면 전체 범례 추가 요청", author: "김현장" });
  ok(a2.status === 200 && a2.j.pin_id === "" && a2.j.kind === "request" && a2.j.deck_id === deckA.id, "S2 핀 없는 요청(pin_id '') → 200 · 최상위 구역 A — " + a2.status + " " + (a2.j && a2.j.deck_id));
  const a3 = await api(anon1, "POST", "/api/notes", { deployment_id: dep1, pin_id: "", deck_id: deckA1.id, body: "이 영역 치수 요청", author: "김현장" });
  ok(a3.status === 200 && a3.j.deck_id === deckA1.id, "S2 핀 없는 요청 + 보던 영역 hint → 영역 A1 — " + (a3.j && a3.j.deck_id));
  const dn = await api("o", "POST", "/api/notes", { deployment_id: dep1, pin_id: "", kind: "note", body: "x" });
  ok(dn.status === 400, "S2 핀 없는 이슈 노트(kind=note)는 종전대로 400 — " + dn.status);
  const b1 = await api("v2", "POST", "/api/notes", { deployment_id: dep2, pin_id: "p9", pin_label: "9", body: "B 구역 9번 확인 부탁", kind: "request" });
  ok(b1.status === 200 && b1.j.deck_id === deckB.id, "S2 viewer v2 → 구역 B — " + (b1.j && b1.j.deck_id));

  console.log("\n[S3 레이트리밋 — IP 당 분당 5건, 6번째 429 · 디자이너 면제]");
  const IP = { "CF-Connecting-IP": "203.0.113.7" };
  const st = [];
  for (let i = 0; i < 6; i++) st.push((await api(anon2, "POST", "/api/notes", { deployment_id: dep2, pin_id: "p9", body: "연속 " + i, author: "박익명" }, IP)).status);
  ok(st.slice(0, 5).every((s) => s === 200) && st[5] === 429, "S3 같은 IP 6건 → 200×5 + 429 — " + st.join(","));
  const IPD = { "CF-Connecting-IP": "203.0.113.8" };
  const ds = [];
  for (let i = 0; i < 6; i++) ds.push((await api("o", "POST", "/api/notes", { deployment_id: dep2, pin_id: "p9", body: "디자이너 노트 " + i }, IPD)).status);
  ok(ds.every((s) => s === 200), "S3 디자이너 6건 → 전부 200(면제) — " + ds.join(","));
  const lng = await api(anon2, "POST", "/api/notes", { deployment_id: dep2, pin_id: "p9", body: "x".repeat(4001), author: "박" }, { "CF-Connecting-IP": "203.0.113.9" });
  ok(lng.status === 400, "S3 길이 상한 4000 초과 → 400 — " + lng.status);

  console.log("\n[S4 남의 노트 수정 403 · 자기 노트 수정 200]");
  const e1 = await api(anon2, "PATCH", "/api/notes/" + a1.j.id, { body: "남이 고침" });
  ok(e1.status === 403, "S4 다른 익명(같은 공용 계정) 수정키 없이 → 403 — " + e1.status);
  const e2 = await api(anon2, "PATCH", "/api/notes/" + a1.j.id, { body: "남이 고침" }, { "X-Note-Key": "nk-" + "0".repeat(48) });
  ok(e2.status === 403, "S4 틀린 수정키 → 403 — " + e2.status);
  const e3 = await api("v2", "PATCH", "/api/notes/" + v1Note, { body: "남이 고침" });
  ok(e3.status === 403, "S4 viewer v2 → v1 의 요청 수정 403 — " + e3.status);
  const e3d = await api("v2", "DELETE", "/api/notes/" + v1Note);
  ok(e3d.status === 403, "S4 viewer v2 → v1 의 요청 삭제 403 — " + e3d.status);
  const e4 = await api(anon2, "PATCH", "/api/notes/" + a1.j.id, { body: "본인 수정" }, { "X-Note-Key": a1.j.edit_key });
  ok(e4.status === 200 && e4.j.body === "본인 수정", "S4 익명 본인(수정키) 수정 → 200 — " + e4.status);
  const e5 = await api("v1", "PATCH", "/api/notes/" + v1Note, { body: "1번 사진 재촬영 부탁드립니다" });
  ok(e5.status === 200 && e5.j.body === "1번 사진 재촬영 부탁드립니다", "S4 viewer 본인 수정 → 200 — " + e5.status);
  const e6 = await api("v1", "PATCH", "/api/notes/" + v1Note, { status: "done" });
  ok(e6.status === 403, "S4 viewer 본인이라도 처리 상태 변경 → 403(디자이너 몫) — " + e6.status);
  const tmp = await api(anon1, "POST", "/api/notes", { deployment_id: dep1, pin_id: "p1", body: "지울 요청", author: "김현장" });
  const e7 = await api(anon1, "DELETE", "/api/notes/" + tmp.j.id, null, { "X-Note-Key": tmp.j.edit_key });
  ok(e7.status === 200, "S4 익명 본인 삭제 → 200 — " + e7.status);

  console.log("\n[S5 답변·상태 — 디자이너만 · 열람자 화면 반영]");
  const ar = await api(anon1, "POST", "/api/notes", { kind: "reply", parent_id: v1Note, body: "익명 답변", author: "김" });
  ok(ar.status === 403, "S5 익명 답변 → 403 — " + ar.status);
  const vr = await api("v2", "POST", "/api/notes", { kind: "reply", parent_id: v1Note, body: "v2 답변" });
  ok(vr.status === 403, "S5 viewer 답변 → 403 — " + vr.status);
  const rp = await api("o", "POST", "/api/notes", { kind: "reply", parent_id: v1Note, body: "내일 재촬영하겠습니다" });
  ok(rp.status === 200 && rp.j.kind === "reply" && rp.j.parent_id === v1Note && rp.j.pin_id === "p1" && rp.j.deployment_id === dep1 && rp.j.deck_id === deckA.id, "S5 디자이너 답변 → 200 · 원 요청 위치(dep1·p1·구역A) 상속 — " + rp.status);
  const sd = await api("o", "PATCH", "/api/notes/" + v1Note, { status: "done" });
  ok(sd.status === 200 && sd.j.status === "done", "S5 디자이너 완료 처리 → 200");
  const pr = await api("o", "PATCH", "/api/notes/" + a1.j.id, { status: "progress" });
  ok(pr.status === 200 && pr.j.status === "progress", "S5 디자이너 처리중 → 200");
  const seen = await api("v1", "GET", "/api/notes?deployment_id=" + dep1 + "&pin_id=p1");
  const mineRow = (seen.j.data || []).find((n) => n.id === v1Note);
  const replyRow = (seen.j.data || []).find((n) => n.parent_id === v1Note);
  ok(seen.status === 200 && mineRow && mineRow.status === "done" && replyRow && replyRow.body === "내일 재촬영하겠습니다", "S5 열람자 재조회 → 상태 완료 + 디자이너 답변 보임");
  const seenA = await api(anon2, "GET", "/api/notes?deployment_id=" + dep1 + "&pin_id=p2");
  const qRow = (seenA.j.data || []).find((n) => n.id === a1.j.id);
  ok(seenA.status === 200 && qRow && qRow.status === "progress" && !("author_contact" in qRow), "S5 다른 열람자는 남의 회신 이메일을 못 본다(author_contact 미포함)");
  const seenD = await api("o", "GET", "/api/notes?deployment_id=" + dep1 + "&pin_id=p2");
  ok(((seenD.j.data || []).find((n) => n.id === a1.j.id) || {}).author_contact === "kim@field.test", "S5 디자이너는 회신 이메일을 본다");
  const sum = await api("o", "GET", "/api/notes/summary?deployment_id=" + dep1);
  ok(sum.status === 200 && sum.j.data.p1 && sum.j.data.p1.total === 1, "S5 요약 배지는 답변 제외(p1 total=1) — " + JSON.stringify(sum.j && sum.j.data && sum.j.data.p1));

  console.log("\n[S6 디자이너 요청함 — 권한 · 구역/영역 그룹핑 · 개수]");
  const ib = await api("o", "GET", "/api/projects/prj_R/requests");
  const ibD = await api("d", "GET", "/api/projects/prj_R/requests");
  const ibV = await api("v1", "GET", "/api/projects/prj_R/requests");
  const ibA = await api(anon1, "GET", "/api/projects/prj_R/requests");
  ok(ib.status === 200 && ibD.status === 200, "S6 소유자·designer 멤버 요청함 200 — " + ib.status + "/" + ibD.status);
  ok(ibV.status === 403 && ibA.status === 401, "S6 viewer 403 · 공유 링크 401 — " + ibV.status + "/" + ibA.status);
  const items = ib.j.data || [];
  // [WO 20261002-gap 묶음C·3] 🔴 마스터 지시로 뒤집힘 — 전역 목록이 이슈 노트(kind=note)도 포함하도록 확장됐다.
  //   서버는 포함, 클라 탭([요청·질문]/[결함 노트])이 분리해 보여준다(_applyFilters, SoT).
  ok(items.some((n) => n.kind === "note") && items.filter((n) => n.kind === "note").length === 6, "S6 요청함 전역 목록에 이슈 노트(kind=note) 6건 포함(WO 20261002-gap) — " + items.filter((n) => n.kind === "note").length);
  {
    const C0 = makeCtx();
    C0.Requests._tab = "reqq";
    const reqqOnly = C0.Requests._applyFilters(items);
    ok(reqqOnly.every((n) => n.kind !== "note"), "S6 탭[요청·질문] 필터 → 결함 노트 0건 — " + reqqOnly.filter((n) => n.kind === "note").length);
    C0.Requests._tab = "note";
    const noteOnly = C0.Requests._applyFilters(items);
    // reply 는 탭과 무관하게 항상 통과(원 요청에 재부착하기 위해) — kind='note' 가 아닌 top-level 항목은 0건이어야 한다.
    const noteTops = noteOnly.filter((n) => n.kind !== "reply");
    ok(noteTops.length === 6 && noteTops.every((n) => n.kind === "note"), "S6 탭[결함 노트] 필터 → 이슈 노트(top)만 6건 — " + noteTops.length);
  }
  const decks = (await api("o", "GET", "/api/projects/prj_R/decks")).j.data;
  const C = makeCtx();
  const g = C.Requests.groupByTree(items, decks, false);
  const by = Object.fromEntries(g.nodes.map((nd) => [nd.deck.name, nd]));
  const tops = items.filter((n) => n.kind !== "reply");
  ok(g.nodes.map((nd) => nd.deck.name + ":" + nd.depth).join(",") === "구역A:0,영역A1:1,구역B:0", "S6 트리 순서 = 구역A → 영역A1 → 구역B — " + g.nodes.map((nd) => nd.deck.name + ":" + nd.depth).join(","));
  ok(by["구역A"].items.length === 2 && by["구역A"].items[0].pin_id === "" && by["구역A"].items[1].pin_id === "p1", "S6 구역A = [구역 단위 1 · #1 1] (구역 단위 먼저) — " + by["구역A"].items.map((n) => n.pin_id || "∅").join(","));
  ok(by["영역A1"].items.length === 2 && by["영역A1"].items[0].pin_id === "" && by["영역A1"].items[1].pin_id === "p2", "S6 영역A1 = [구역 단위 1 · #2 1] — " + by["영역A1"].items.map((n) => n.pin_id || "∅").join(","));
  // [WO 20261002-gap] 구역B = 요청·질문 6(v2 1 + 익명 5) + 이슈 노트(kind=note) 6(S3 디자이너 루프) = 12.
  ok(by["구역B"].items.length === 12, "S6 구역B = 12(요청·질문 6 + 이슈노트 6, WO 20261002-gap) — " + by["구역B"].items.length);
  ok(g.nodes.reduce((s, nd) => s + nd.items.length, 0) + g.unassigned.length === tops.length && g.unassigned.length === 0, "S6 합계 = 요청 수(" + tops.length + ") · 미지정 0");
  ok(by["구역A"].items[1].replies.length === 1 && by["구역A"].items[1].replies[0].body === "내일 재촬영하겠습니다", "S6 답변은 원 요청 아래(replies)");
  const openN = tops.filter((n) => n.status !== "done").length;
  ok(ib.j.open === openN && g.open === openN && openN === tops.length - 1, "S6 미처리 개수 = 서버 " + ib.j.open + " = 클라 " + g.open + " (완료 1건 제외)");
  const gOpen = C.Requests.groupByTree(items, decks, true);
  ok(gOpen.nodes.find((nd) => nd.deck.name === "구역A").items.length === 1, "S6 '미처리만' 필터 → 구역A 완료 건 숨김");
  C.Requests._items = items; C.Requests._pid = "prj_R";
  C.sandbox.Projects = { decks, currentProject: { id: "prj_R" } };
  // [WO 20261002-gap] 트리 배지 = 요청/질문 + 결함 노트 미완 합산(openCountForDeck._isOpen, SoT) → B=12.
  ok(C.Requests.openCountForDeck(deckA.id) === 1 && C.Requests.openCountForDeck(deckA1.id) === 2 && C.Requests.openCountForDeck(deckB.id) === 12, "S6 트리 배지 개수 A=1 · A1=2 · B=12(WO 20261002-gap 결함노트 합산) — " + [deckA.id, deckA1.id, deckB.id].map((x) => C.Requests.openCountForDeck(x)).join(","));
  C.sandbox.Projects.currentProject = { id: "prj_OTHER" };
  ok(C.Requests.openCountForDeck(deckA.id) === 0 && C.Requests.openCount() === 0, "S6 프로젝트를 바꾸면(갱신 전) 이전 프로젝트 배지·개수 잔류 0");

  console.log("\n[S7 초대코드 게이트 — 코드 미통과 링크 세션은 요청도 못 쓴다]");
  await run("INSERT INTO project_share_codes (id, project_id, label, code_hash, code_hint, created_by, created_at, expires_at, revoked) VALUES ('psc_t', 'prj_R', 't', 'h', 'h', ?, ?, NULL, 0)", [U.o, now0]);
  const gt = await api(anon1, "POST", "/api/notes", { deployment_id: dep1, pin_id: "p1", body: "게이트 뒤", author: "김" }, { "CF-Connecting-IP": "198.51.100.1" });
  ok(gt.status === 403 && gt.j && gt.j.gate_required === true, "S7 게이트 잠긴 프로젝트 → 익명 요청 403 gate_required — " + gt.status);
  const gv = await api("v1", "POST", "/api/notes", { deployment_id: dep1, pin_id: "p1", body: "멤버는 통과", kind: "question" }, { "CF-Connecting-IP": "198.51.100.2" });
  ok(gv.status === 200, "S7 실계정 viewer 멤버는 게이트 대상 아님 → 200 — " + gv.status);
  await run("UPDATE project_share_codes SET revoked = 1 WHERE id = 'psc_t'", []);

  console.log("\n[S8 번호 대역 — viewer 미배정 · designer 로 바뀌면 배정 · 기존 viewer 대역 해제]");
  const dbBand = async (email) => (await first("SELECT num_band FROM project_members WHERE project_id = 'prj_R' AND email = ?", [email]))?.num_band ?? null;
  ok((await dbBand(U.d)) === 2 && (await dbBand(U.v1)) === null && (await dbBand(U.v2)) === null, "S8 designer d=2 · viewer v1·v2 = NULL — " + [await dbBand(U.d), await dbBand(U.v1), await dbBand(U.v2)].join(","));
  const bands = await api("o", "GET", "/api/projects/prj_R/bands");
  ok(bands.status === 200 && !bands.j.bands.some((b) => b.email === U.v1 || b.email === U.v2), "S8 대역표(칩 집계)에 viewer 없음 — " + JSON.stringify(bands.j.bands.map((b) => b.email + ":" + b.band)));
  const vb = await api("v1", "GET", "/api/projects/prj_R/bands");
  ok(vb.status === 200 && vb.j.me.band === null, "S8 viewer 본인 조회 → 내 대역 null — " + JSON.stringify(vb.j && vb.j.me));
  const vput = await api("o", "PUT", "/api/projects/prj_R/members/me/band", { band: 7, email: U.v1 });
  ok(vput.status === 409 && (await dbBand(U.v1)) === null, "S8 viewer 에게 대역 지정 → 409 · 불변 — " + vput.status);
  await api("o", "POST", "/api/projects/prj_R/members", { email: U.v1, role: "designer" });
  ok((await dbBand(U.v1)) === 3, "S8 v1 → designer 로 변경 즉시 빈 대역 3 배정 — " + (await dbBand(U.v1)));
  await run("INSERT INTO project_members (project_id, email, role, granted_by, created_at, num_band) VALUES ('prj_R', ?, 'viewer', 'x', ?, 5)", [U.v3, now0 + 99]);
  await api("o", "GET", "/api/projects/prj_R/bands");
  ok((await dbBand(U.v3)) === null, "S8 이미 대역(5)을 가진 viewer → 조회 시 해제(NULL) — " + (await dbBand(U.v3)));
} finally {
  await mf.dispose();
  try { fs.unlinkSync(workerOut); } catch {}
}

/* ══ 클라 ══ */
console.log("\n[C1 열람자 화면 — 상태 배지 · 디자이너 답변 · 내 글만 수정/삭제]");
{
  const C = makeCtx();
  C.sandbox.Auth.user = null; C.sandbox.Auth.readonly = true;
  C.ls[C.Requests.KEYS_LS] = JSON.stringify({ n1: "nk-mine" });
  const list = makeEl("div");
  const rows = [
    { id: "n1", kind: "request", status: "done", body: "<img src=x onerror=alert(1)> 1번", author: "김", created_at: 1 },
    { id: "n2", kind: "question", status: "progress", body: "남의 질문", author: "박", created_at: 2 },
    { id: "r1", kind: "reply", parent_id: "n1", body: "재촬영 완료", author: "디자이너", created_at: 3 },
    { id: "x9", kind: "note", status: "open", body: "디자이너 이슈", author: "o", created_at: 4 },
  ];
  const n = C.Requests.renderViewerList(list, rows);
  const c1 = list.querySelector('[data-req-item="n1"]'), c2 = list.querySelector('[data-req-item="n2"]');
  ok(n === 2 && !list.querySelector('[data-req-item="x9"]'), "C1 요청·질문 2건만(이슈 노트 제외) — " + n);
  ok(c1 && c1.querySelector('[data-req-status="done"]') && c1.textContent.includes("완료") && c2.textContent.includes("처리중"), "C1 상태 배지 완료/처리중 표시");
  ok(c1.querySelector('[data-req-reply="r1"]') && c1.textContent.includes("재촬영 완료"), "C1 디자이너 답변이 원 요청 아래에 보임");
  ok(c1.querySelector('[data-req-act="edit"]') && c1.querySelector('[data-req-act="delete"]') && !c2.querySelector('[data-req-act="edit"]'), "C1 내 글(수정키 보유)만 [수정][삭제]");
  ok(c1.textContent.includes("<img src=x onerror=alert(1)>") && !c1.children.some((ch) => ch.tagName === "IMG"), "C1 본문은 textContent(HTML 이스케이프) — 태그로 해석 0");
}

console.log("\n[C2 진입 — 뷰어 핀 탭(미디어 없음) · 파노라마 노트 버튼 → 요청 창]");
{
  const opened = [];
  const Req = { openViewer: (o) => opened.push(o), refresh() { Req.n = (Req.n || 0) + 1; return Promise.resolve("idle"); } };
  const sb = { console, JSON, Map, Set, Math, Date, Promise, setTimeout, clearTimeout, navigator: { onLine: true }, Requests: Req,
    document: { visibilityState: "visible", getElementById: () => null, addEventListener() {}, querySelectorAll: () => [], body: { classList: { toggle() {}, contains: () => false } } },
    State: { mode: "viewer", activePin: "p7", pins: [] }, localStorage: { getItem: () => null, setItem() {} }, UI: {}, Prompt: { toast() {} } };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(SRC.app + "\n" + SRC.notes + "\n;globalThis.__X = { App, Notes };", sb);
  const { App, Notes } = sb.__X;
  App.pinHasContent = () => false;
  App.onPinTap({ id: "p7", label: "7" });
  ok(opened.length === 1 && opened[0].pin.id === "p7" && opened[0].noMedia === true, "C2 뷰어 · 미디어 없는 포인트 재탭 → 그 포인트 요청 창 — " + JSON.stringify(opened));
  Notes._pin = { id: "p8", label: "8" };
  Notes.toggle();
  ok(opened.length === 2 && opened[1].pin.id === "p8", "C2 뷰어 파노라마 [노트] → 이슈 패널 대신 요청 창");
  sb.State.mode = "designer"; sb.State.autoSaveDepId = null;
  const before = Req.n || 0;
  const res = await App._liveTick();
  ok((Req.n || 0) === before + 1 && res === "idle", "C3 20초 틱(_liveTick) 1회 = 요청함 refresh 1회(새 폴링 없음) — " + ((Req.n || 0) - before));
}

console.log("\n[C4 트리 구역 노드 배지]");
{
  const src = SRC.ui;
  ok(/Requests\.openCountForDeck\(deck\.id\)/.test(src) && /if \(reqTag\) head\.insertAdjacentHTML\("beforeend", reqTag\);/.test(src), "C4 deckNode 머리에 미처리 요청 배지(reqTag) 렌더(런타임 확인 = 헤드리스 D2)");
  // [p115 지휘자 재현] 🔴 근본원인 — 이전 조건은 "42_Requests.js 바로 다음 줄이 99_footer.js"라는
  // 인접성을 그대로 리터럴 매치했다. 그 사이에 새 모듈(43_ProjectInfo.js 등)이 들어오면 Requests.js
  // 연결 자체는 멀쩡한데도 테스트가 깨졌다(취약 조건). 의도(등록 + footer 이전 + App.init 호출)는
  // 그대로 두고, "바로 다음 줄"이 아니라 "등록돼 있고 99_footer.js 보다 앞"으로 견고화한다.
  const manifest = rd(M + "_manifest.txt");
  const manifestLines = manifest.split("\n").map((l) => l.trim()).filter(Boolean);
  const reqIdx = manifestLines.indexOf("42_Requests.js");
  const footerIdx = manifestLines.indexOf("99_footer.js");
  const registeredBeforeFooter = reqIdx !== -1 && footerIdx !== -1 && reqIdx < footerIdx;
  ok(registeredBeforeFooter && /Requests\.init\(\)/.test(SRC.app), "C4 고아 방지 — _manifest 등록(99_footer.js 이전) + App.init 에서 Requests.init()");
}

clearTimeout(watchdog);
console.log(failed ? `\n총 ${failed}건 실패` : "\n전부 통과");
process.exit(failed ? 1 : 0);
