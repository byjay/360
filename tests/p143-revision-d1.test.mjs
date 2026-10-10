/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p143-revision-d1.test.mjs)
 *
 * WO 20261010-revision — 도면 개정(Rev) 관리. 서버 = src/index.tsx 실 번들 → Miniflare(workerd) + 실 D1(migrations 전부) + 실 R2. 목 0.
 *
 *  A 권한: 이력 읽기(소유자·멤버 디자이너·멤버 열람자 200 / 비멤버 403) · 적용(멤버 디자이너·열람자 403) · 미리보기(열람자 403)
 *  B 미리보기: 2점 → 변환 + 핀 이월 좌표(쓰기 0)
 *  C 적용 안전장치: base_version 없음/어긋남 409 · 개정 번호 중복 409 · 도면 없음 400 → 전부 0건
 *  D 적용: 새 도면 · 핀/영역/주석 이월 + 검토 배지 · tombstone 불변 · 구역 윤곽(창 crop·벡터 src_crop) 이월 · 스냅샷 보존 · 이전 R2 원본 보존 · 감사 기록
 *  E 이력: 기준/현재/다음 번호 · 되돌리기 기한 · 한 개정 조회(이전 도면·이전 핀·diff)
 *  F R2: 더는 배포본이 참조하지 않는 이전 개정 도면 = 그 배포본 읽기 범위면 200, 범위 밖 403
 *  G 되돌리기(정확): 핀 수·좌표·영역·주석·도면·원본·구역 윤곽 원복 · 두 번째 409 · 디자이너 403
 *  H 되돌리기(병합): 적용 뒤 남의 저장(사진 첨부·핀 이동·새 핀) 보존 + 좌표는 이전 개정 좌표계로
 *  I 10분 경과 410 · 이후 개정이 있으면 409
 *  J 제안: 디자이너 제안(배포본 불변) → 소유자 적용(from_proposal) → accepted · 열람자에겐 제안 안 보임
 *  K 종전 [도면 교체] 저장(PATCH pages_data) → 이전 도면 자동 보관(replaced) · 같은 도면(토큰만 다른 URL) 중복 보관 0
 *  L 마이그레이션 미적용(테이블 없음) → 적용 503·0건, 종전 PATCH 는 그대로 200
 *
 * 뮤테이션: MUT=<이름> → src 사본에 치환(치환 대상 없음 = EXIT 3). 각 뮤테이션은 EXIT=1 이어야 한다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { Miniflare } from "miniflare";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
let failed = 0;
const ok = (cond, label, d) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (!cond && d !== undefined ? " :: " + JSON.stringify(d).slice(0, 400) : "")); if (!cond) failed++; };
const watchdog = setTimeout(() => { console.log("\nWATCHDOG — 180s 초과 → FAIL"); process.exit(1); }, 180000);

const MUTS = {
  perm:     ["if (mode === 'apply' && !canApply) return { res:", "if (false) return { res:"],
  read:     ["if (!canReadDepRow(scope, idx, dep)) return { res: c.json({ error: 'forbidden' }, 403) }", ""],
  lock:     ["if (body.base_version == null || Number(body.base_version) !== cur) {", "if (false) {"],
  dup:      ["if (used.has(revLabelKey(label))) return", "if (false) return"],
  snapshot: ["JSON.stringify(t), JSON.stringify(snapshot), await revPagesHash(dep.pages_data)", "JSON.stringify(t), null, await revPagesHash(dep.pages_data)"],
  r2del:    ["const livePins = nextPins.filter(revLive)", "for (const u of (revJson(dep.pages_data, []) as any[])) { const k = String(u).split('?')[0].replace('/api/r2/object/', ''); await c.env.R2.delete(k) } const livePins = nextPins.filter(revLive)"],
  flag:     ["const nextPins = carryPins(pinsArr, t, flag)", "const nextPins = carryPins(pinsArr, t, null)"],
  decks:    ["if (!changed) continue\n    deckSnap.push(s)", "continue\n    deckSnap.push(s)"],
  exact:    ["const exact = cur === Number(row.dep_version_after)", "const exact = true"],
  window:   ["if (now - Number(row.applied_at || row.created_at) > REV_UNDO_MS)", "if (false)"],
  later:    ["if (later) return c.json({ error: '이후 개정이 있습니다", "if (false) return c.json({ error: '이후 개정이 있습니다"],
  archive:  ["if (oldH && oldH !== (await revPagesHash(body.pages_data)) && (await revTableReady(c))) {", "if (false) {"],
  r2read:   ["if (ids.length && await revsMention(c, ids, key)) return true", ""],
  table:    ["if (!(await revTableReady(c))) return c.json({ error: 'migration 0040_drawing_revisions 미적용 — 개정을 저장하지 않았습니다' }, 503)", ""],
  propose:  ["if (mode === 'propose' && !canPropose) return { res:", "if (false) return { res:"],
};
const MUT = process.env.MUT || "";
let entry = path.join(ROOT, "src/index.tsx");
if (MUT) {
  const m = MUTS[MUT];
  if (!m) { console.log("unknown MUT " + MUT); process.exit(3); }
  const dir = path.join(ROOT, ".tmp", "p143src-" + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, "src"), dir, { recursive: true });
  const f = path.join(dir, "index.tsx");
  const s = fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  if (!s.includes(m[0])) { console.log("MUT " + MUT + " 치환 대상 없음"); process.exit(3); }
  fs.writeFileSync(f, s.replace(m[0], m[1]));
  entry = f;
  console.log("[MUT=" + MUT + "]");
}

const SECRET = "p143-signing-secret-0123456789abcdef";
const SUPER = "sup@seastar.test";
const workerOut = path.join(os.tmpdir(), "p143-worker-" + process.pid + ".mjs");
await esbuild.build({
  entryPoints: [entry], bundle: true, format: "esm", platform: "neutral",
  outfile: workerOut, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
  conditions: ["workerd", "worker", "browser"],
});
const mf = new Miniflare({
  modules: true, scriptPath: workerOut, d1Databases: { DB: "p143-" + Date.now() }, r2Buckets: { R2: "p143r2-" + Date.now() },
  bindings: { DEMO_LOGIN: "0", AUTO_ENTRY_SECRET: SECRET, SUPER_ADMIN_EMAIL: SUPER, SUPER_ADMIN_EMAILS: SUPER },
  compatibilityDate: "2025-01-01",
});
const BASE = "http://p143.test";
const db = await mf.getD1Database("DB");
const r2 = await mf.getR2Bucket("R2");
for (const f of fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()) {
  for (const st of rd("migrations/" + f).replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean)) await db.exec(st);
}
const run = (q, a = []) => db.prepare(q).bind(...a).run();
const first = (q, a = []) => db.prepare(q).bind(...a).first();
const all = async (q, a = []) => (await db.prepare(q).bind(...a).all()).results || [];

// o 소유자 · m 멤버 디자이너 · x 다른 프로젝트 디자이너 · v 멤버 열람자(디자이너 아님) · s super
const U = { o: "owner@seastar.test", m: "member@seastar.test", x: "outsider@seastar.test", v: "viewer@seastar.test", s: SUPER };
const TOK = {};
for (const k of Object.keys(U)) {
  const now = Date.now(), salt = crypto.randomBytes(16).toString("hex");
  if (k !== "v") await run("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, 'seed', ?, ?, 0)", [U[k], k, now, now]);
  await run("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, 'seastar.test', ?, ?, 1, ?, ?, 0)", [U[k], k, "x", salt, now, now]);
  TOK[k] = "local-p143-" + k + "-" + crypto.randomBytes(6).toString("hex");
  await run("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOK[k], U[k], now, now + 8.64e7]);
}
const api = async (tok, method, url, body) => {
  const headers = Object.assign({ "Content-Type": "application/json" }, tok ? { Authorization: "Bearer " + tok } : {});
  const r = await mf.dispatchFetch(BASE + url, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
};
const r2get = async (tok, key) => (await mf.dispatchFetch(BASE + "/api/r2/object/" + key, { headers: { Authorization: "Bearer " + tok } })).status;

/* ── 시드 ── */
const PID = "prj_p143", PID2 = "prj_p143_x", MAIN = "dep_p143_main", VEC = "dep_p143_vec", XDEP = "dep_p143_x";
const OLD_KEY = "assets/p143-old-1.png", OLD_KEY2 = "assets/p143-old-2.png", NEW_KEY = "assets/p143-new-1.png", OLD_PDF = "assets/p143-old.pdf";
for (const k of [OLD_KEY, OLD_KEY2, NEW_KEY, OLD_PDF]) await r2.put(k, "bytes-of-" + k);
const OLD_PAGES = JSON.stringify(["/api/r2/object/" + OLD_KEY, "/api/r2/object/" + OLD_KEY2]);
const OLD_META = JSON.stringify({ v: 1, pdf_url: "/api/r2/object/" + OLD_PDF, pages: [{ w: 4096, h: 2896, pw: 2384, ph: 1684 }] });
const PINS0 = [
  { id: 1, x: 10.5, y: 20.25, page: 1, label: "1", checkboard: true },
  { id: 2, x: 40, y: 60, page: 1, label: "P1", imageId: "img_a", author: "owner@seastar.test" },
  { id: 3, x: 85, y: 85, page: 2, label: "P2" },
  { id: 99, _deleted: true, ts: 5 },
];
const ZONES0 = [{ id: "z1", page: 1, label: "A", x: 10, y: 10, w: 20, h: 10 }, { id: "z2", shape: "circle", cx: 50, cy: 50, r: 5, x: 45, y: 45, w: 10, h: 10 }];
const ANNOS0 = [{ id: "a1", page: 1, type: "pen", pts: [{ x: 1, y: 1 }, { x: 5, y: 5 }] }, { id: "a2", page: 1, type: "text", x: 30, y: 30, text: "주석" }];
const CROP_WIN = JSON.stringify({ x: 50, y: 50, w: 20, h: 20 }), CROP_SRC = JSON.stringify({ x: 5, y: 5, w: 30, h: 30 });
{
  const now = Date.now();
  await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, 'P142 선박', '', ?, ?, ?, 0)", [PID, U.o, now, now]);
  await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, 'OTHER', '', ?, ?, ?, 0)", [PID2, U.x, now, now]);
  await run("INSERT INTO project_members (project_id, email, role, granted_by, created_at) VALUES (?, ?, 'designer', ?, ?)", [PID, U.m, U.o, now]);
  await run("INSERT INTO project_members (project_id, email, role, granted_by, created_at) VALUES (?, ?, 'viewer', ?, ?)", [PID, U.v, U.o, now]);
  const dep = (id, pid, pins, pages, meta) => run("INSERT INTO deployments (id, title, file_name, drawing_data, pages_data, source_meta, pins, zones, annotations, created_at, updated_at, deleted, version, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 4, ?)",
    [id, "T-" + id, id + ".pdf", JSON.parse(pages)[0], pages, meta, JSON.stringify(pins), JSON.stringify(ZONES0), JSON.stringify(ANNOS0), now, now, pid]);
  await dep(MAIN, PID, PINS0, OLD_PAGES, OLD_META);
  await dep(VEC, PID, [{ id: 7, x: 1, y: 1, page: 1 }], JSON.stringify(["/api/r2/object/assets/p143-vec.png"]), null);
  await dep(XDEP, PID2, [], JSON.stringify(["/api/r2/object/assets/p143-x.png"]), null);
  await run("UPDATE projects SET original_deployment_id = ? WHERE id = ?", [MAIN, PID]);
  const deck = (id, pid, depId, crop, srcDep, srcCrop) => run("INSERT INTO decks (id, project_id, name, deployment_id, crop, src_dep_id, src_page, src_crop, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
    [id, pid, id, depId, crop, srcDep, srcDep ? 1 : null, srcCrop, now, now]);
  await deck("dk_main", PID, MAIN, null, null, null);
  await deck("dk_win", PID, MAIN, CROP_WIN, null, null);
  await deck("dk_vec", PID, VEC, null, MAIN, CROP_SRC);
  await deck("dk_x", PID2, XDEP, null, null, null);
}
const depRow = (id) => first("SELECT * FROM deployments WHERE id = ?", [id]);
const deckRow = (id) => first("SELECT crop, src_crop FROM decks WHERE id = ?", [id]);
const revUrl = "/api/deployments/" + MAIN + "/revisions";
const NEW_PAGES = JSON.stringify(["/api/r2/object/" + NEW_KEY]);
const NEW_META = JSON.stringify({ v: 1, pdf_url: "/api/r2/object/assets/p143-new.pdf", pages: [{ w: 4096, h: 2896, pw: 2384, ph: 1684 }] });
const SD = { w: 2384, h: 1684 }, DD = { w: 2384, h: 1684 };
const SRC_PTS = [{ x: 10, y: 10 }, { x: 90, y: 80 }], DST_PTS = [{ x: 15, y: 12 }, { x: 88, y: 85 }];
const snapState = async () => {
  const d = await depRow(MAIN);
  return JSON.stringify([d.pins, d.zones, d.annotations, d.pages_data, d.source_meta, d.drawing_data, d.file_name, await deckRow("dk_win"), await deckRow("dk_vec")]);
};
const BEFORE = await snapState();

console.log("\n[A. 권한]");
{
  const o = await api(TOK.o, "GET", revUrl);
  ok(o.status === 200 && o.j.can_apply === true && o.j.can_propose === true && o.j.ready === true, "A1 소유자 이력 200 · 적용 가능", o.j);
  const m = await api(TOK.m, "GET", revUrl);
  ok(m.status === 200 && m.j.can_apply === false && m.j.can_propose === true, "A2 멤버 디자이너 200 · 적용 불가 · 제안 가능", m.j);
  const v = await api(TOK.v, "GET", revUrl);
  ok(v.status === 200 && v.j.can_apply === false && v.j.can_propose === false, "A3 멤버 열람자 200 · 보기만", v.j);
  const x = await api(TOK.x, "GET", revUrl);
  ok(x.status === 403, "A4 다른 프로젝트 디자이너 → 403(읽기 SoT)", x.status);
  ok((await api(null, "GET", revUrl)).status === 401, "A5 비로그인 → 401");
  const body = { base_version: 4, rev_label: "Rev.1", pages_data: NEW_PAGES, transform: null };
  ok((await api(TOK.m, "POST", revUrl, body)).status === 403, "A6 멤버 디자이너 적용 → 403");
  ok((await api(TOK.v, "POST", revUrl, body)).status === 403, "A7 열람자 적용 → 403");
  ok((await api(TOK.x, "POST", revUrl, body)).status === 403, "A8 다른 프로젝트 디자이너 적용 → 403");
  ok((await api(TOK.v, "POST", revUrl + "/preview", { src_dims: SD, dst_dims: DD, src_pts: SRC_PTS, dst_pts: DST_PTS })).status === 403, "A9 열람자 미리보기 → 403");
  ok((await api(TOK.v, "POST", revUrl, Object.assign({ propose: true }, body))).status === 403, "A10 열람자 제안 → 403");
  ok(await snapState() === BEFORE && (await depRow(MAIN)).version === 4, "A 거부된 요청 = 배포본 0건 변경");
}

console.log("\n[B. 미리보기]");
let T = null;
{
  const p = await api(TOK.m, "POST", revUrl + "/preview", { src_dims: SD, dst_dims: DD, src_pts: SRC_PTS, dst_pts: DST_PTS });
  T = p.j && p.j.transform;
  const p1 = p.j && p.j.pins.find((q) => q.id === 1);
  const want = T && { x: T.a * 10.5 + T.c * 20.25 + T.e, y: T.b * 10.5 + T.d * 20.25 + T.f };
  ok(p.status === 200 && p.j.kind === "similarity" && p.j.pins.length === 3, "B 2점 → 닮음 · 살아있는 핀 3개(tombstone 제외)", p.j);
  ok(p1 && Math.abs(p1.nx - want.x) < 1e-3 && Math.abs(p1.ny - want.y) < 1e-3 && p1.x === 10.5, "B 핀 이월 좌표 = 변환 적용값", { p1, want });
  ok(p.j.summary.zones === 2 && p.j.summary.annotations === 2 && p.j.summary.decks === 2, "B 요약: 영역 2 · 주석 2 · 구역 윤곽 2(창 crop·벡터 src_crop)", p.j.summary);
  const a = await api(TOK.o, "POST", revUrl + "/preview", { mode: "auto", src_dims: SD, dst_dims: { w: 4096, h: 2893.5 } });
  ok(a.status === 200 && a.j.identity === true && a.j.kind === "identity", "B 자동 제안 — 비율 같음(해상도만 다름) → 그대로", a.j && a.j.kind);
  const bad = await api(TOK.o, "POST", revUrl + "/preview", { src_dims: SD, dst_dims: DD, src_pts: [SRC_PTS[0]], dst_pts: [DST_PTS[0]] });
  ok(bad.status === 400 && /2쌍/.test(bad.j.error), "B 기준점 1개 → 400 + 사유", bad.j);
  ok(await snapState() === BEFORE, "B 미리보기 = 쓰기 0");
}

console.log("\n[C. 적용 안전장치 — 전부 0건]");
{
  const base = { rev_label: "Rev.1", prev_label: "Rev.0", rev_date: "2026-10-10", memo: "선체 블록 B12 개정", file_name: "new.pdf", pages_data: NEW_PAGES, source_meta: NEW_META, transform: T };
  const nb = await api(TOK.o, "POST", revUrl, base);
  ok(nb.status === 409, "C1 base_version 없음 → 409", nb);
  const st = await api(TOK.o, "POST", revUrl, Object.assign({ base_version: 3 }, base));
  ok(st.status === 409 && st.j.version === 4, "C2 base_version 어긋남 → 409 + 현재 version", st.j);
  const du = await api(TOK.o, "POST", revUrl, Object.assign({}, base, { base_version: 4, rev_label: "rev 0" }));
  ok(du.status === 409 && du.j.duplicate_label, "C3 새 번호 = 기준 번호(rev 0 ≡ Rev.0) → 409", du.j);
  const np = await api(TOK.o, "POST", revUrl, Object.assign({}, base, { base_version: 4, pages_data: "[]" }));
  ok(np.status === 400, "C4 도면 없음 → 400", np.status);
  const bt = await api(TOK.o, "POST", revUrl, Object.assign({}, base, { base_version: 4, transform: { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 } }));
  ok(bt.status === 400, "C5 퇴화 변환 → 400", bt.status);
  ok(await snapState() === BEFORE && (await all("SELECT id FROM drawing_revisions")).length === 0, "C 거부 = 배포본·이력 0건");
}

console.log("\n[D. 적용]");
let REV1 = null;
{
  const r = await api(TOK.o, "POST", revUrl, { base_version: 4, rev_label: "rev 1", prev_label: "0", rev_date: "2026-10-10", memo: "선체 블록 B12 개정", file_name: "new.pdf", pages_data: NEW_PAGES, source_meta: NEW_META, transform: T });
  REV1 = r.j && r.j.id;
  ok(r.status === 200 && r.j.rev_label === "Rev.1" && r.j.prev_label === "Rev.0" && r.j.version === 5, "D1 적용 200 · 번호 정규화 Rev.1(기준 Rev.0) · version 5", r.j);
  ok(r.j.carried && r.j.carried.pins === 3 && r.j.carried.zones === 2 && r.j.carried.annotations === 2 && r.j.carried.decks === 2, "D2 이월 수: 핀 3 · 영역 2 · 주석 2 · 구역 윤곽 2", r.j.carried);
  ok(r.j.undo_until - Date.now() > 9 * 60 * 1000, "D3 되돌리기 기한 ≈ 10분", r.j.undo_until);
  const d = await depRow(MAIN);
  const pins = JSON.parse(d.pins);
  ok(d.pages_data === NEW_PAGES && d.source_meta === NEW_META && d.file_name === "new.pdf" && d.drawing_data === "/api/r2/object/" + NEW_KEY, "D4 배포본 도면 = 새 개정", { p: d.pages_data, f: d.file_name });
  const p1 = pins.find((p) => p.id === 1);
  ok(Math.abs(p1.x - (T.a * 10.5 + T.c * 20.25 + T.e)) < 1e-3 && p1.revReview && p1.revReview.rev === REV1 && p1.checkboard === true, "D5 핀 이월 + 검토 배지(revReview.rev = 이 개정) · 다른 필드 보존", p1);
  ok(JSON.stringify(pins.find((p) => p.id === 99)) === JSON.stringify(PINS0[3]) && pins.length === 4, "D6 tombstone 불변 · 핀 수 4 그대로", pins.length);
  const z = JSON.parse(d.zones), a = JSON.parse(d.annotations);
  ok(Math.abs(z[1].cx - (T.a * 50 + T.c * 50 + T.e)) < 1e-2 && Math.abs(a[1].x - (T.a * 30 + T.c * 30 + T.e)) < 1e-2, "D7 영역·주석 이월", { z: z[1], a: a[1] });
  const win = JSON.parse((await deckRow("dk_win")).crop), vec = JSON.parse((await deckRow("dk_vec")).src_crop);
  ok(win.x !== 50 && vec.x !== 5 && (await deckRow("dk_main")).crop === null, "D8 구역 윤곽 이월(창 crop · 벡터 src_crop) · 전체 구역은 그대로", { win, vec });
  const row = await first("SELECT * FROM drawing_revisions WHERE id = ?", [REV1]);
  const snap = JSON.parse(row.prev_snapshot || "null") || { decks: [] };
  ok(row.status === "applied" && snap.pages_data === OLD_PAGES && snap.source_meta === OLD_META && snap.pins === JSON.stringify(PINS0) && snap.version === 4, "D9 적용 전 스냅샷(이전 도면·원본·핀) 보관", { status: row.status, v: snap.version });
  ok(snap.decks.length === 2 && row.dep_version_after === 5 && row.memo === "선체 블록 B12 개정" && row.author_email === U.o, "D10 구역 윤곽 스냅샷 · 메모 · 작성자", row);
  let r2ok = true; for (const k of [OLD_KEY, OLD_KEY2, OLD_PDF]) if (!(await r2.get(k))) r2ok = false;
  ok(r2ok, "D11 이전 개정 R2 원본(페이지 2 · PDF) 그대로 존재");
  const log = await first("SELECT detail, actor_email FROM activity_log WHERE action = 'drawing.revision.apply' ORDER BY ts DESC LIMIT 1");
  ok(!!log && /Rev\.1/.test(log.detail), "D12 감사 기록 drawing.revision.apply", log);
}

console.log("\n[E. 이력]");
{
  const l = await api(TOK.v, "GET", revUrl);
  const cur = l.j.revisions.find((r) => r.id === REV1);
  ok(l.j.base_label === "Rev.0" && l.j.current_label === "Rev.1" && l.j.next_label === "Rev.2" && l.j.review_pins === 3, "E1 기준 Rev.0 · 현재 Rev.1 · 다음 Rev.2 · 검토 필요 핀 3", l.j);
  ok(cur && cur.current && cur.undo_until > Date.now() && cur.memo === "선체 블록 B12 개정" && cur.rev_date === "2026-10-10", "E2 현재 개정 · 되돌리기 기한 · 메모·일자", cur);
  ok(cur && /^o\*\*\*/.test(cur.author || ""), "E3 열람자에게 작성자 이메일 마스킹", cur && cur.author);
  const one = await api(TOK.v, "GET", revUrl + "/" + REV1);
  ok(one.status === 200 && one.j.prev.pages_data === OLD_PAGES && one.j.next.pages_data === NEW_PAGES && one.j.prev.label === "Rev.0", "E4 한 개정 — 이전 도면(Rev.0)·새 도면(Rev.1)", one.j && one.j.prev);
  ok(one.j.diff && one.j.diff.moved.length === 0 && one.j.diff.added.length === 0 && one.j.diff.removed.length === 0 && one.j.diff.unchanged === 3, "E5 diff — 이월만 했으면 moved/added/removed 0 · unchanged 3", one.j.diff);
  ok(!/owner@seastar\.test/.test(one.j.prev.pins), "E6 열람자 응답 핀 JSON 이메일 마스킹");
  ok((await api(TOK.x, "GET", revUrl + "/" + REV1)).status === 403, "E7 다른 프로젝트 디자이너 개정 조회 → 403");
}

console.log("\n[F. 이전 개정 R2 읽기]");
{
  ok(await r2get(TOK.m, OLD_KEY) === 200 && await r2get(TOK.v, OLD_PDF) === 200, "F1 같은 프로젝트 멤버(디자이너·열람자) → 보관된 이전 도면·원본 200");
  ok(await r2get(TOK.x, OLD_KEY) === 403, "F2 다른 프로젝트 디자이너 → 403");
}

console.log("\n[G. 되돌리기(정확)]");
{
  ok((await api(TOK.m, "POST", revUrl + "/" + REV1 + "/undo")).status === 403, "G1 멤버 디자이너 되돌리기 → 403");
  const u = await api(TOK.o, "POST", revUrl + "/" + REV1 + "/undo");
  ok(u.status === 200 && u.j.exact === true && u.j.restored.pins === 3 && u.j.version === 6, "G2 되돌리기 200 · 정확 원복 · 핀 3", u.j);
  ok(await snapState() === BEFORE, "G3 핀·영역·주석·도면·원본·파일명·구역 윤곽 = 적용 전과 바이트 동일");
  ok((await first("SELECT status FROM drawing_revisions WHERE id = ?", [REV1])).status === "reverted", "G4 이력 상태 reverted");
  const u2 = await api(TOK.o, "POST", revUrl + "/" + REV1 + "/undo");
  ok(u2.status === 409 && u2.j.already, "G5 두 번째 되돌리기 → 409", u2.j);
  const l = await api(TOK.o, "GET", revUrl);
  ok(l.j.current_label === "Rev.0" && l.j.next_label === "Rev.1", "G6 되돌린 뒤 현재 = 기준 Rev.0 · 다음 Rev.1(번호 재사용 가능)", l.j);
}

console.log("\n[H. 되돌리기(병합) — 적용 뒤 남의 저장 보존]");
{
  const v0 = (await depRow(MAIN)).version;
  const r = await api(TOK.o, "POST", revUrl, { base_version: v0, rev_label: "Rev.1", rev_date: "2026-10-10", file_name: "new.pdf", pages_data: NEW_PAGES, source_meta: NEW_META, transform: T });
  ok(r.status === 200, "H1 다시 적용(Rev.1 재사용) 200", r.j);
  const d = await depRow(MAIN);
  const pins = JSON.parse(d.pins);
  pins.find((p) => p.id === 1).imageId = "img_after";                // 사진만 붙임(위치 그대로)
  Object.assign(pins.find((p) => p.id === 2), { x: 33, y: 44, revReview: null });   // 사람이 옮기고 확정
  pins.push({ id: 50, x: 70, y: 70, page: 1, label: "NEW" });         // 새 개정 위에 새로 찍음
  const pt = await api(TOK.m, "PATCH", "/tables/deployments/" + MAIN, { base_version: d.version, pins: JSON.stringify(pins) });
  ok(pt.status === 200, "H2 멤버 디자이너가 적용 뒤 저장", pt.status);
  const u = await api(TOK.o, "POST", revUrl + "/" + r.j.id + "/undo");
  ok(u.status === 200 && u.j.exact === false, "H3 되돌리기 = 병합 모드(exact=false)", u.j);
  const back = JSON.parse((await depRow(MAIN)).pins);
  const b1 = back.find((p) => p.id === 1), b2 = back.find((p) => p.id === 2), b50 = back.find((p) => p.id === 50);
  ok(b1.x === 10.5 && b1.y === 20.25 && b1.imageId === "img_after" && !("revReview" in b1), "H4 위치 안 바꾼 핀 = 이전 좌표 정확 + 적용 뒤 붙인 사진 보존", b1);
  const D = T.a * T.d - T.b * T.c, ix = (x, y) => ({ x: (T.d * (x - T.e) - T.c * (y - T.f)) / D, y: (-T.b * (x - T.e) + T.a * (y - T.f)) / D });
  ok(Math.abs(b2.x - ix(33, 44).x) < 1e-3 && Math.abs(b50.x - ix(70, 70).x) < 1e-3 && b50.label === "NEW", "H5 옮긴 핀·새 핀 = 역변환(이전 개정 좌표계)", { b2, b50 });
  ok(back.length === 5 && (await depRow(MAIN)).pages_data === OLD_PAGES, "H6 핀 5(새 핀 포함) · 도면 = 이전 개정", back.length);
}

console.log("\n[I. 10분 경과 · 이후 개정]");
{
  let v = (await depRow(MAIN)).version;
  const a = await api(TOK.o, "POST", revUrl, { base_version: v, rev_label: "Rev.1", pages_data: NEW_PAGES, transform: T });
  await run("UPDATE drawing_revisions SET applied_at = ? WHERE id = ?", [Date.now() - 11 * 60 * 1000, a.j.id]);
  const before = (await depRow(MAIN)).pins;
  const u = await api(TOK.o, "POST", revUrl + "/" + a.j.id + "/undo");
  ok(u.status === 410 && u.j.expired && (await depRow(MAIN)).pins === before, "I1 10분 지남 → 410 · 핀 그대로", u.j);
  v = (await depRow(MAIN)).version;
  const b = await api(TOK.o, "POST", revUrl, { base_version: v, rev_label: "Rev.2", pages_data: JSON.stringify(["/api/r2/object/assets/p143-rev2.png"]), transform: null });
  v = (await depRow(MAIN)).version;
  const c3 = await api(TOK.o, "POST", revUrl, { base_version: v, rev_label: "Rev.3", pages_data: JSON.stringify(["/api/r2/object/assets/p143-rev3.png"]), transform: null });
  ok(b.status === 200 && c3.status === 200, "I2 Rev.2 · Rev.3 연속 적용", [b.j, c3.j]);
  const u2 = await api(TOK.o, "POST", revUrl + "/" + b.j.id + "/undo");
  ok(u2.status === 409 && u2.j.later === c3.j.id, "I3 Rev.3 가 있는데 Rev.2 되돌리기 → 409(최근 것부터)", u2.j);
  const dupe = await api(TOK.o, "POST", revUrl, { base_version: (await depRow(MAIN)).version, rev_label: "REV 2", pages_data: NEW_PAGES });
  ok(dupe.status === 409 && dupe.j.duplicate_label, "I4 적용 중인 번호 재사용(REV 2) → 409", dupe.j);
  ok((await api(TOK.o, "POST", revUrl + "/" + c3.j.id + "/undo")).status === 200 && (await api(TOK.o, "POST", revUrl + "/" + b.j.id + "/undo")).status === 200, "I5 최근 것부터 차례로 되돌리기 200");
}

console.log("\n[J. 제안]");
{
  const before = await depRow(MAIN);
  const p = await api(TOK.m, "POST", revUrl, { propose: true, rev_label: "Rev.9", memo: "현장 수정 반영 제안", file_name: "prop.pdf", pages_data: NEW_PAGES, source_meta: NEW_META, transform: T });
  ok(p.status === 200 && p.j.proposed, "J1 멤버 디자이너 제안 200", p.j);
  const after = await depRow(MAIN);
  ok(after.version === before.version && after.pins === before.pins && after.pages_data === before.pages_data, "J2 제안 = 배포본 불변");
  const lo = await api(TOK.o, "GET", revUrl), lv = await api(TOK.v, "GET", revUrl);
  ok(lo.j.revisions.some((r) => r.id === p.j.id && r.status === "proposed") && !lv.j.revisions.some((r) => r.kind === "proposal"), "J3 소유자에겐 제안 보임 · 열람자에겐 안 보임", lv.j.revisions.map((r) => r.kind));
  ok((await api(TOK.v, "GET", revUrl + "/" + p.j.id)).status === 404, "J4 열람자 제안 조회 → 404");
  ok((await api(TOK.m, "POST", revUrl, { from_proposal: p.j.id, base_version: after.version })).status === 403, "J5 제안자(디자이너)가 직접 적용 → 403");
  const a = await api(TOK.o, "POST", revUrl, { from_proposal: p.j.id, base_version: after.version });
  ok(a.status === 200 && a.j.rev_label === "Rev.9", "J6 소유자가 제안 적용 200", a.j);
  const prow = await first("SELECT status, ref_id FROM drawing_revisions WHERE id = ?", [p.j.id]);
  const arow = await first("SELECT author_email, applied_by, ref_id, memo FROM drawing_revisions WHERE id = ?", [a.j.id]);
  ok(prow.status === "accepted" && prow.ref_id === a.j.id && arow.author_email === U.m && arow.applied_by === U.o && arow.ref_id === p.j.id && arow.memo === "현장 수정 반영 제안", "J7 제안 accepted · 작성자=제안자 · 적용자=소유자", { prow, arow });
  ok((await api(TOK.o, "POST", revUrl, { from_proposal: p.j.id, base_version: a.j.version })).status === 409, "J8 같은 제안 두 번 적용 → 409");
  await api(TOK.o, "POST", revUrl + "/" + a.j.id + "/undo");
}

console.log("\n[K. 종전 [도면 교체] 저장 — 이전 도면 자동 보관]");
{
  const cnt = async () => (await all("SELECT id FROM drawing_revisions WHERE kind = 'replaced'")).length;
  const n0 = await cnt();
  const d = await depRow(MAIN);
  const rep1 = JSON.stringify(["/api/r2/object/assets/p143-replace1.png"]), rep2 = JSON.stringify(["/api/r2/object/assets/p143-replace2.png"]);
  const p1 = await api(TOK.m, "PATCH", "/tables/deployments/" + MAIN, { base_version: d.version, pages_data: rep1, drawing_data: JSON.parse(rep1)[0] });
  const kept = (await all("SELECT prev_snapshot FROM drawing_revisions WHERE kind = 'revision'")).some((r) => JSON.parse(r.prev_snapshot).pages_data === d.pages_data);
  ok(p1.status === 200 && kept && (await cnt()) === n0, "K1 이미 개정 스냅샷에 보관된 도면을 교체 → 중복 보관 0(보관본은 그대로)", { kept });
  const d1 = await depRow(MAIN);
  const p2 = await api(TOK.m, "PATCH", "/tables/deployments/" + MAIN, { base_version: d1.version, pages_data: rep2 });
  const rows = await all("SELECT prev_snapshot, status, author_email FROM drawing_revisions WHERE kind = 'replaced' ORDER BY created_at");
  const last = rows[rows.length - 1] || {};
  ok(p2.status === 200 && rows.length === n0 + 1 && JSON.parse(last.prev_snapshot || "{}").pages_data === rep1 && last.status === "archived" && last.author_email === U.m, "K2 교체 저장 → 밀려난 도면 참조 보관(replaced·archived·저장자)", rows.length);
  const l = await api(TOK.v, "GET", revUrl);
  ok(l.j.revisions.some((r) => r.kind === "replaced"), "K3 이력 목록에 '교체로 보관' 항목", l.j.revisions.map((r) => r.kind));
  const d2 = await depRow(MAIN);
  await api(TOK.m, "PATCH", "/tables/deployments/" + MAIN, { base_version: d2.version, pages_data: JSON.stringify(["/api/r2/object/assets/p143-replace2.png?t=abc"]), pins: d2.pins });
  ok((await cnt()) === n0 + 1, "K4 같은 도면(토큰만 다른 URL) 저장 → 추가 보관 0");
  const d3 = await depRow(MAIN);
  await api(TOK.m, "PATCH", "/tables/deployments/" + MAIN, { base_version: d3.version, pins: d3.pins });
  ok((await cnt()) === n0 + 1, "K5 핀만 저장 → 보관 0");
}

console.log("\n[L. 마이그레이션 미적용]");
{
  await db.exec("DROP TABLE drawing_revisions");
  const d = await depRow(MAIN);
  const r = await api(TOK.o, "POST", revUrl, { base_version: d.version, rev_label: "Rev.7", pages_data: NEW_PAGES });
  ok(r.status === 503 && (await depRow(MAIN)).version === d.version, "L1 테이블 없음 → 적용 503 · 0건", r);
  const l = await api(TOK.o, "GET", revUrl);
  ok(l.status === 200 && l.j.ready === false, "L2 이력 = ready:false(클라가 사유 표시)", l.j && l.j.ready);
  const pt = await api(TOK.m, "PATCH", "/tables/deployments/" + MAIN, { base_version: d.version, pages_data: JSON.stringify(["/api/r2/object/assets/p143-z.png"]) });
  ok(pt.status === 200, "L3 종전 교체 저장은 그대로 200(보관만 건너뜀)", pt.status);
}

clearTimeout(watchdog);
await mf.dispose();
console.log("\n" + (failed ? "FAIL " + failed : "ALL PASS"));
process.exit(failed ? 1 : 0);
