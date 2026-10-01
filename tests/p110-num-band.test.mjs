/**
 * p110 — 100 단위 번호 대역(WO 20261001-startno) · 프레임워크 0 · 실행: node tests/p110-num-band.test.mjs
 *   (p104 는 db36244 p104-inquiries, p107 은 bulkreauth 팀 예약 — 혼동 방지로 p110. 내부 식별자 P104_MUT 는 유지)
 *
 * 마스터: "체크나 360 모두 시작번호 세팅 메뉴를 직관적으로" · "0~100, 101~200 … 100 단위"
 *         (확정) 멤버별 자동 배정 + 본인 변경, 서버 저장.
 *
 * U = 클라 실 소스(01b_PinSeries · 20_App · 24b_NumBand)를 vm 에 · S = 서버 src/index.tsx 실 번들 → Miniflare + 실 D1(migrations 전부).
 *   U1 대역 내 다음 번호(남의 핀 포함) · U2 다른 대역 핀 무시 · U3 대역 가득 → 확인창 · 넘침 0
 *   U4 같은 대역 동시 생성 → 대역 안 다음 빈 번호 · U5 다른 대역 동시 생성 → 충돌 0 · U6 가득 → 옮기지 않고 중복 표시
 *   U7 수동 번호 보호 · U8 모드별 독립(CHECKER 101 / 360 P101) · U9 칩에 작성자·개수 · 내 대역 강조
 *   S1 소유자=1 · S2 멤버 추가 시 빈 대역 자동 배정(추가 즉시 DB) · S3 초대 수락 · S4 가입 자동 편입(claimPendingInvites)
 *   S5 기존 NULL 멤버 지연 백필(추가 순서·결정론) · S6 본인 변경 / 남의 대역은 소유자·super 만 · S7 비멤버 403
 *
 * 뮤테이션: P104_MUT=<이름> 이면 해당 소스를 바꿔 실행 → EXIT=1 이어야 한다(대상 문자열 못 찾으면 EXIT=2).
 *   band-filter · full-overflow · resolve-page-max · resolve-overflow · mode-shared · numbers-content · chip-meta ·
 *   server-assign · backfill-order · put-perm
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
const MUT = process.env.P104_MUT || "";
const SRC = { series: rd("public/js/modules/01b_PinSeries.js"), app: rd("public/js/modules/20_App.js"), nb: rd("public/js/modules/24b_NumBand.js"), srv: rd("src/index.tsx") };
const MUTS = {
  "band-filter":      ["series", "if (Number.isFinite(n) && n >= r.lo && n <= r.hi && n > maxNo) maxNo = n;", "if (Number.isFinite(n) && n > maxNo) maxNo = n;"],
  "full-overflow":    ["series", "const full = no > r.hi;", "const full = false;"],
  "resolve-page-max": ["series", 'const bk = ser + "|" + pg + "|" + this.bandOf(n);', 'const bk = ser + "|" + pg;'],
  "resolve-overflow": ["series", "if (to > hi) return;                                  // 대역 가득", "// 대역 가득"],
  "mode-shared":      ["series", "        if (this.seriesOf(p) !== ser) return;\n        const n = parseInt(p.label, 10);", "        const n = parseInt(p.label, 10);"],
  "numbers-content":  ["series", "no = /^\\d+$/.test(raw) ? parseInt(raw, 10) : nContent;", "no = nContent;"],
  "chip-meta":        ["nb", 'r.count ? (r.count + "개") : (r.free ? "" : "0개")', '""'],
  "server-assign":    ["srv", "  await projectBands(c, pid)   // [WO 20261001-startno] 새 멤버", "  // [뮤테이션] 새 멤버"],
  "backfill-order":   ["srv", "FROM project_members WHERE project_id = ? ORDER BY created_at, email').bind(pid).all()", "FROM project_members WHERE project_id = ? ORDER BY email DESC').bind(pid).all()"],
  "put-perm":         ["srv", "if (target !== me && !(await canManageMembers(c, user, pid)))", "if (false)"],
};
if (MUT) {
  const m = MUTS[MUT];
  if (!m) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }
  if (!SRC[m[0]].includes(m[1])) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함: " + MUT); process.exit(2); }
  SRC[m[0]] = SRC[m[0]].replace(m[1], m[2]);
  console.log("[뮤테이션 적용] " + MUT);
}

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };

/* ══ 클라: 실 소스 vm ══ */
function makeEl() {
  const el = { style: {}, dataset: {}, value: "", disabled: false, _text: "", _html: "", _h: {}, classList: null,
    addEventListener(t, f) { (this._h[t] = this._h[t] || []).push(f); }, setAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; }, focus() {} };
  Object.defineProperty(el, "textContent", { get() { return this._text; }, set(v) { this._text = String(v == null ? "" : v); } });
  Object.defineProperty(el, "innerHTML", { get() { return this._html; }, set(v) { this._html = String(v); } });
  const s = new Set(["hidden"]);
  el.classList = { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c), toggle: (c, f) => (f === undefined ? (s.has(c) ? s.delete(c) : s.add(c)) : (f ? s.add(c) : s.delete(c))) };
  return el;
}
function makeCtx(email) {
  const reg = {}, ls = {}, confirms = [];
  const document = { getElementById: (id) => (reg[id] = reg[id] || makeEl()), createElement: () => makeEl(), body: { appendChild() {} }, activeElement: null, querySelector: () => null, querySelectorAll: () => [] };
  const State = { pins: [], pdfPage: 1, checkboard: true, checkboardStart: {}, activePin: null, mode: "designer", regMode: "checkboard", pdfDoc: {}, currentProjectId: "prj_U" };
  const sandbox = {
    console, document, JSON, Map, Set, Math, State, navigator: { onLine: true }, SyncQueue: { count: () => Promise.resolve(0) }, Promise,
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); } },
    Auth: { user: email ? { email } : null, headers: () => ({}) },
    UI: { $: (id) => document.getElementById(id), renderPinList() {}, renderPinsOnMap() {} },
    Prompt: { toast() {}, confirm: async (t, m) => { confirms.push(String(m)); return false; } },
  };
  let t = 1790000000000;
  sandbox.Date = class extends Date { static now() { return t++; } };   // 핀 id = Date.now() — 같은 ms 충돌 방지(p8 과 동일)
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC.series + "\n" + SRC.app + "\n" + SRC.nb + "\n;globalThis.__X = { PinSeries, App, NumBand };", sandbox);
  return Object.assign({ State, reg, confirms, sandbox }, sandbox.__X);
}
const cb = (id, label, extra = {}) => Object.assign({ id, page: 1, x: 1, y: 1, checkboard: true, label: String(label), createdAt: id }, extra);

console.log("\n[U1·U2·U3 대역 안 다음 번호]");
{
  const { PinSeries: PS } = makeCtx("a@t");
  const r1 = PS.nextInBand([cb(1, 101, { author: "a@t" }), cb(2, 105, { author: "b@t" })], 1, "checkboard", 2, 101);
  ok(r1.no === 106, "U1 대역 101–200 · 내 101 + 남의 105 → 다음 106 — " + r1.no);
  const r2 = PS.nextInBand([cb(1, 101), cb(2, 250), cb(3, 999), cb(4, 100)], 1, "checkboard", 2, 101);
  ok(r2.no === 102, "U2 다른 대역 핀(100·250·999) 무시 → 102 — " + r2.no);
  const r3 = PS.nextInBand([cb(1, 200)], 1, "checkboard", 2, 101);
  ok(r3.full === true && r3.no === null, "U3 대역 끝(200) 도달 → full · 번호 없음 — " + JSON.stringify(r3));
  const c = makeCtx("a@t");
  c.App._setNumBand(2);
  c.State.pins.push(cb(9, 200, { author: "z@t" }));
  const ret = c.App._placeCheckboardPin({ x: 2, y: 2 });
  ok(ret === null && c.State.pins.length === 1 && !c.State.pins.some((p) => p.label === "201"), "U3 가득 → 핀 생성 0 · 201 넘침 0");
  ok(c.confirms.length === 1 && c.confirms[0].includes("대역이 가득 찼습니다") && c.confirms[0].includes("201–300"), "U3 확인창 '대역이 가득 찼습니다 — 다음 대역(201–300)…' — " + JSON.stringify(c.confirms));
}

console.log("\n[U4·U5·U6·U7 동시 생성 재채번 — 대역 안]");
{
  const { PinSeries: PS } = makeCtx("a@t");
  const pins4 = [cb(1, 150), cb(10, 101), cb(20, 101), cb(30, 201)];
  const ch4 = PS.resolveConcurrentNos(pins4, ["1", "30"], null);
  ok(ch4.length === 1 && ch4[0].id === 20 && ch4[0].to === "151", "U4 같은 대역 101 두 개 → 나중 핀이 대역 안 최댓값+1 = 151 (다른 대역 201 무시) — " + JSON.stringify(ch4));
  const pins5 = [cb(10, 101), cb(20, 201)];
  ok(PS.resolveConcurrentNos(pins5, [], null).length === 0, "U5 다른 대역 동시 생성(101·201) → 재채번 0");
  const pins6 = [cb(1, 199), cb(10, 200), cb(20, 200)];
  const ch6 = PS.resolveConcurrentNos(pins6, ["1"], null);
  const dup6 = [...PS.duplicateCheckboardIds(pins6, 1)].sort();
  ok(ch6.length === 0 && pins6.every((p) => +p.label <= 200) && dup6.join() === "10,20", "U6 대역 가득(200 중복) → 옮기지 않음(201 넘침 0) · 중복 표시 — " + JSON.stringify({ ch6, dup6 }));
  const pins7 = [cb(10, 101), cb(20, 101, { labelManual: true })];
  const ch7 = PS.resolveConcurrentNos(pins7, [], null);
  ok(ch7.length === 1 && ch7[0].id === 10 && pins7[1].label === "101", "U7 수동(101)은 보존 · 먼저 만든 자동 핀이 옮김 — " + JSON.stringify(ch7));
  const pinsC = [{ id: 10, page: 1, label: "101", createdAt: 10 }, { id: 20, page: 1, label: "101", createdAt: 20 }];
  const chC = PS.resolveConcurrentNos(pinsC, [], null);
  ok(chC.length === 1 && chC[0].series === "content" && chC[0].to === "102", "U4' 360 계열도 같은 대역 동시 생성 → P102 — " + JSON.stringify(chC));
}

console.log("\n[U8 모드별 독립 — 같은 대역 번호, 계열별 증가]");
{
  const c = makeCtx("a@t");
  c.App._setNumBand(2);
  c.App._placeCheckboardPin({ x: 1, y: 1 });
  c.State.regMode = "photo";
  c.App._placeCheckboardPin({ x: 2, y: 2 });
  c.App._placeCheckboardPin({ x: 3, y: 3 });
  c.State.regMode = "checkboard";
  c.App._placeCheckboardPin({ x: 4, y: 4 });
  const show = c.State.pins.map((p) => { const m = c.PinSeries.numbers(c.State.pins, 1).get(p.id); return c.PinSeries.formatNo(m.no, m.series); });
  ok(JSON.stringify(show) === JSON.stringify(["101", "P101", "P102", "102"]), "U8 CHECKER 101 → 360 P101·P102 → CHECKER 102 (표시 번호) — " + JSON.stringify(show));
  ok(c.State.pins[1].checkboard === undefined && c.State.pins[1].label === "101", "U8 360 핀은 checkboard 플래그 없음 · label 101");
}

console.log("\n[U9 칩 — 작성자·개수 · 내 대역 강조 · 다음 빈 대역]");
{
  const c = makeCtx("kim@t");
  c.NumBand._data = { band_size: 100, me: { email: "kim@t", band: 2 }, bands: [{ band: 1, email: "own@t", name: "오너", owner: true }, { band: 2, email: "kim@t", name: "김철수", owner: false }] };
  c.NumBand._pid = "prj_U";
  c.PinSeries.setMyBand("kim@t", 2);
  c.State.pins.push(cb(1, 101, { author: "kim@t" }), cb(2, 102, { author: "kim@t" }), cb(3, 103, { author: "kim@t" }), cb(4, 201, { author: "lee@t" }));
  c.NumBand._renderSheet();
  const html = c.reg["numband-chips"].innerHTML;
  console.log("   칩 HTML: " + html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|"));
  ok(/101–200<\/span><span class="numband-chip-meta">김철수 3개</.test(html), "U9 101–200 칩 = '김철수 3개'");
  ok(/class="numband-chip is-mine"[^>]*data-band="2"/.test(html) && /내 대역/.test(html), "U9 내 대역(2) 강조(is-mine · '내 대역')");
  ok(/201–300<\/span><span class="numband-chip-meta">lee 1개</.test(html) && /is-taken" data-band="3"/.test(html), "U9 배정 없는 대역은 실제 작성자(lee)·개수 · 남이 쓰는 대역 표시");
  ok(/1–100<\/span><span class="numband-chip-meta">오너 0개</.test(html) && /301–400<\/span><span class="numband-chip-meta">비어 있음</.test(html), "U9 소유자 대역 + 다음 빈 대역 1개(301–400 비어 있음)");
  ok(c.reg["numband-next"].textContent === "다음 핀 = 104", "U9 미리보기 '다음 핀 = 104' — " + c.reg["numband-next"].textContent);
  c.State.regMode = "photo";
  c.NumBand._renderSheet();
  ok(c.reg["numband-next"].textContent === "다음 핀 = P101" && c.reg["numband-mode"].textContent === "360", "U9 360 모드 → '다음 핀 = P101' · 모드 표시 360 — " + c.reg["numband-next"].textContent);
}

/* ══ 서버: 실 번들 + 실 D1 ══ */
console.log("\n[S 서버 대역 배정]");
const MIG_DIR = path.join(ROOT, "migrations");
const MIGS = fs.readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
ok(MIGS.includes("0032_member_num_band.sql"), "마이그레이션 0032_member_num_band.sql 존재");
const stmtsOf = (file) => fs.readFileSync(path.join(MIG_DIR, file), "utf8").replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
const workerOut = path.join(os.tmpdir(), "p104-worker-" + process.pid + ".mjs");
await esbuild.build({
  stdin: { contents: SRC.srv, resolveDir: path.join(ROOT, "src"), sourcefile: "index.tsx", loader: "tsx" },
  bundle: true, format: "esm", platform: "neutral", outfile: workerOut, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
  conditions: ["workerd", "worker", "browser"],
});
const mf = new Miniflare({ modules: true, scriptPath: workerOut, d1Databases: { DB: "p104-" + Date.now() }, r2Buckets: { R2: "p104r2-" + Date.now() }, bindings: { DEMO_LOGIN: "0" }, compatibilityDate: "2025-01-01" });
const BASE = "http://p104.test";
const db = await mf.getD1Database("DB");
try {
  for (const f of MIGS) for (const st of stmtsOf(f)) await db.exec(st);
  const U = { o: "own@seastar.test", m1: "m1@seastar.test", m2: "m2@seastar.test", out: "out@seastar.test", inv: "inv@seastar.test", clm: "clm@seastar.test" };
  const TOK = (k) => "local-p104-" + k;
  const now0 = Date.now();
  const run = (q, a) => db.prepare(q).bind(...a).run();
  const addUser = async (k, verified = 1) => {
    await run("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)", [U[k], k, "designssir@gmail.com", now0, now0]);
    await run("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)", [U[k], "이름" + k, "seastar.test", "x", "y", verified, now0, now0]);
    await run("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOK(k), U[k], now0, now0 + 8.64e7]);
  };
  for (const k of ["o", "m1", "m2", "out"]) await addUser(k);
  for (const pid of ["prj_S", "prj_L"]) await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, ?, '', ?, ?, ?, 0)", [pid, pid, U.o, now0, now0]);
  const api = async (k, method, url, body) => {
    const h = { "Content-Type": "application/json" };
    if (k) h.Authorization = "Bearer " + TOK(k);
    const r = await mf.dispatchFetch(BASE + url, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, j };
  };
  const bandOf = (j, email) => ((j && j.bands) || []).find((b) => b.email === email)?.band;
  const dbBand = async (pid, email) => (await db.prepare("SELECT num_band FROM project_members WHERE project_id = ? AND email = ?").bind(pid, email).first())?.num_band ?? null;

  const g1 = await api("o", "GET", "/api/projects/prj_S/bands");
  ok(g1.status === 200 && g1.j.me.band === 1 && g1.j.me.owner === true && bandOf(g1.j, U.o) === 1 && g1.j.band_size === 100, "S1 소유자 = 대역 1 · band_size 100 — " + JSON.stringify(g1.j && g1.j.me));

  await api("o", "POST", "/api/projects/prj_S/members", { email: U.m1, role: "designer" });
  const m1Now = await dbBand("prj_S", U.m1);
  // [WO 20261001-viewreq] 마스터 확정: viewer 는 대역을 배정받지 않는다 → m2 를 designer 로(이후 단언 전부 불변).
  //   viewer 미배정·해제·designer 전환 시 배정은 p111 S8 이 지킨다.
  await api("o", "POST", "/api/projects/prj_S/members", { email: U.m2, role: "designer" });
  const m2Now = await dbBand("prj_S", U.m2);
  ok(m1Now === 2 && m2Now === 3, "S2 멤버 추가 즉시(조회 전) DB 배정: m1=2 · m2=3 (추가 순서·빈 대역) — " + m1Now + "," + m2Now);
  const g2 = await api("m1", "GET", "/api/projects/prj_S/bands");
  ok(g2.status === 200 && g2.j.me.band === 2 && bandOf(g2.j, U.m2) === 3 && (g2.j.bands.find((b) => b.email === U.m1) || {}).name === "이름m1", "S2 멤버 본인 조회 = 2 · 이름 포함");

  const invR = await api("o", "POST", "/api/projects/prj_S/members", { email: U.inv, role: "designer" });
  const tok = String((invR.j && invR.j.invite_url) || "").split("invite=")[1];
  const acc = await api(null, "POST", "/api/invite/" + tok + "/accept", { name: "초대", password: "password123" });
  ok(acc.status === 200 && (await dbBand("prj_S", U.inv)) === 4, "S3 초대 수락 → 대역 4 자동 배정 — " + acc.status + " band=" + (await dbBand("prj_S", U.inv)));

  await api("o", "POST", "/api/projects/prj_S/members", { email: U.clm, role: "designer" });   // 계정 없음 → 대기 초대
  await addUser("clm", 1);                                                                      // 가입 완료(인증된 이메일)
  const me = await api("clm", "GET", "/api/auth/me");
  ok(me.status === 200 && (await dbBand("prj_S", U.clm)) === 5, "S4 가입 자동 편입(claimPendingInvites) → 대역 5 — band=" + (await dbBand("prj_S", U.clm)));

  // S5 지연 백필: 0032 이전 행(num_band NULL) — 추가 순서(created_at)대로 빈 대역
  await run("INSERT INTO project_members (project_id, email, role, granted_by, created_at, num_band) VALUES ('prj_L', ?, 'designer', 'x', ?, 2)", [U.m2, now0 + 5]);
  await run("INSERT INTO project_members (project_id, email, role, granted_by, created_at) VALUES ('prj_L', ?, 'designer', 'x', ?)", [U.out, now0 + 9]);
  await run("INSERT INTO project_members (project_id, email, role, granted_by, created_at) VALUES ('prj_L', ?, 'designer', 'x', ?)", [U.m1, now0 + 1]);
  const l1 = await api("o", "GET", "/api/projects/prj_L/bands");
  const l2 = await api("o", "GET", "/api/projects/prj_L/bands");
  ok(bandOf(l1.j, U.m1) === 3 && bandOf(l1.j, U.out) === 4 && bandOf(l1.j, U.m2) === 2, "S5 NULL 멤버 백필 = 추가 순서(m1 먼저 → 3, out → 4) · 기존 2 유지 — " + JSON.stringify(l1.j && l1.j.bands));
  ok(JSON.stringify(l1.j.bands) === JSON.stringify(l2.j.bands) && (await dbBand("prj_L", U.m1)) === 3, "S5 결정론(재조회 동일) · DB 저장됨");

  const p1 = await api("m1", "PUT", "/api/projects/prj_S/members/me/band", { band: 7 });
  ok(p1.status === 200 && p1.j.me.band === 7 && (await dbBand("prj_S", U.m1)) === 7, "S6 본인 대역 변경 → 7 저장");
  const p2 = await api("m1", "PUT", "/api/projects/prj_S/members/me/band", { band: 9, email: U.m2 });
  ok(p2.status === 403 && (await dbBand("prj_S", U.m2)) === 3, "S6 멤버가 남의 대역 변경 → 403 · 불변 — " + p2.status);
  const p3 = await api("o", "PUT", "/api/projects/prj_S/members/me/band", { band: 9, email: U.m2 });
  ok(p3.status === 200 && (await dbBand("prj_S", U.m2)) === 9, "S6 소유자는 남의 대역 변경 가능 → 9");
  const p4 = await api("o", "PUT", "/api/projects/prj_S/members/me/band", { band: 2 });
  const own = await db.prepare("SELECT owner_num_band FROM projects WHERE id = 'prj_S'").first();
  ok(p4.status === 200 && own.owner_num_band === 2 && p4.j.me.band === 2, "S6 소유자 본인 변경 → projects.owner_num_band=2 (남과 같은 대역 허용)");
  const p5 = await api("m1", "PUT", "/api/projects/prj_S/members/me/band", { band: 0 });
  ok(p5.status === 400, "S6 잘못된 대역(0) → 400");
  const o1 = await api("out", "GET", "/api/projects/prj_S/bands");
  const o2 = await api("out", "PUT", "/api/projects/prj_S/members/me/band", { band: 3 });
  ok(o1.status === 403 && o2.status === 404, "S7 비멤버 조회 403 · 본인 변경 404 — " + o1.status + "/" + o2.status);
} finally {
  await mf.dispose();
  try { fs.unlinkSync(workerOut); } catch {}
}

console.log(failed ? `\n총 ${failed}건 실패` : "\n전부 통과");
process.exit(failed ? 1 : 0);
