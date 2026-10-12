/**
 * p151 — 원본 ↔ 벡터 복사 구역 핀 연동(WO 20261012-pinsync · 설계 .tmp/design-pinsync.md A★)
 * (프레임워크 0 · 실행: node tests/p151-region-pin-alias.test.mjs)
 *
 * 마스터 "전체 PDF에서 구역을 지정하고 그 구역에 핀을 박았는데 구역의 페이지에서는 그게 연동이 안되네 서로 연동되게해야지."
 * 서버 = src/index.tsx 실 번들 → Miniflare(workerd) + 실 D1(migrations 전부). 클라 = 10_MapCtrl.js · 01b_PinSeries.js 실 소스(vm). 목 0.
 *
 *  ⓪ 재현: 원본 상자 안 핀이 구역 GET pins 에 투영돼 보인다(상자 밖·다른 페이지 제외)
 *  ① 교차구현 일치: regionAlias.toBase/fromBase == MapCtrl.deckCropPctToPage/pageToDeckCropPct (3상자×121점)
 *  ② 투영 왕복: unproject(project(p)) == p · 상자 밖 부재
 *  ③ PATCH 번역: 원본 5핀(안 2·밖 3) + 구역이 1핀만 PATCH → 원본 = 밖 3 + 1 = 4 · 밖 3핀 바이트 동일 · 순서 보존 · 새 핀 역변환 · 409/400 가드
 *  ④ /ops 번역 + 응답 current 재투영
 *  ⑤ 번호 일치(비숫자 label 360 핀 — 원본·구역 같은 no)
 *  ⑥ 채번 비충돌(원본 체크보드 1·3·5 중 밖 2개 → 구역 다음 번호 6)
 *  ⑦ 모호(2 deck → 1 배포본) · 원본 삭제됨 · 다른 프로젝트 원본 → 별칭 거부, 핀 유실 0
 *  ⑧ 이관 멱등 + 되돌리기(보관 원문 복원)
 *  ⑨ 노트 별칭 · ⑩ 경량 버전 폴링 · ⑪ 별칭 구역 개정 차단 · ⑫ 원본 삭제 가드 · ⑬ 목록 투영
 *
 * 뮤테이션: MUT=<M1..M5> → src 사본에 치환(치환 대상 없음 = EXIT 3). 각 뮤테이션은 EXIT=1 이어야 한다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { Miniflare } from "miniflare";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
let failed = 0;
const ok = (cond, label, d) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (!cond && d !== undefined ? " :: " + JSON.stringify(d).slice(0, 500) : "")); if (!cond) failed++; };
const watchdog = setTimeout(() => { console.log("\nWATCHDOG — 180s 초과 → FAIL"); process.exit(1); }, 180000);

const MUTS = {
  // M1 서버 toBase 항등 → ③④
  M1: ["lib/regionAlias.ts", "return { x: crop.x + (x / 100) * crop.w, y: crop.y + (y / 100) * crop.h }", "return { x, y }"],
  // M2 mergeIntoHome 전량 치환(상자 밖 보존 규칙 제거) → ③
  M2: ["lib/regionAlias.ts", "    if (inBox(h, box)) continue\n    out.push(h)", "    continue"],
  // M3 응답에서 base_pins_min 제거 → ⑤⑥
  M3: ["index.tsx", "  o.base_pins_min = base\n", ""],
  // M4 /ops 응답 재투영 제거(원본 좌표 그대로) → ④
  M4: ["index.tsx", "const cur2 = mapAliasedFor(Object.assign({}, dep, {", "const cur2 = mapDeployment(Object.assign({}, dep, { pins: nh.pins, version: nh.version }, {"],
  // M5 resolvePinHome 의 원본 live 검사 제거 → ⑦
  M5: ["index.tsx", "const home: any = await c.env.DB.prepare('SELECT * FROM deployments WHERE id = ? AND deleted = 0').bind(b.home).first()\n  if (!home) return null",
    "const home: any = await c.env.DB.prepare('SELECT * FROM deployments WHERE id = ?').bind(b.home).first()\n  if (!home) return null"],
};
const MUT = process.env.MUT || "";
let srcDir = path.join(ROOT, "src");
if (MUT) {
  const m = MUTS[MUT];
  if (!m) { console.log("unknown MUT " + MUT); process.exit(3); }
  const dir = path.join(ROOT, ".tmp", "p151src-" + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, "src"), dir, { recursive: true });
  const f = path.join(dir, m[0]);
  const s = fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  if (!s.includes(m[1])) { console.log("MUT " + MUT + " 치환 대상 없음"); process.exit(3); }
  fs.writeFileSync(f, s.replace(m[1], m[2]));
  srcDir = dir;
  console.log("[MUT=" + MUT + "]");
}

/* ── 서버 순수 모듈(regionAlias) — 테스트에서 직접 쓰기 위해 번들 ── */
const aliasOut = path.join(os.tmpdir(), "p151-alias-" + process.pid + ".mjs");
await esbuild.build({ entryPoints: [path.join(srcDir, "lib/regionAlias.ts")], bundle: true, format: "esm", platform: "neutral", outfile: aliasOut, logLevel: "silent" });
const RA = await import(pathToFileURL(aliasOut).href);

/* ── 클라 실 소스(vm) ── */
const extractBalanced = (src, head) => {
  const i = src.indexOf(head);
  if (i < 0) throw new Error("not found: " + head);
  let d = 0, j = src.indexOf("{", i);
  for (let k = j; k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}") { d--; if (d === 0) return src.slice(i, k + 1); } }
  throw new Error("unbalanced " + head);
};
const mapSrc = rd("public/js/modules/10_MapCtrl.js");
const sand = { console, Math, Object, JSON, Array, Number, String, Map, Set, parseInt, isFinite };
sand.State = { pins: [], basePins: null };
vm.createContext(sand);
vm.runInContext("const MapCtrl = {" + extractBalanced(mapSrc, "pageToDeckCropPct(x, y, crop) {") + "," + extractBalanced(mapSrc, "deckCropPctToPage(x, y, crop) {") + "};\nglobalThis.__M = MapCtrl;", sand);
vm.runInContext(rd("public/js/modules/01b_PinSeries.js") + "\nglobalThis.__P = PinSeries;", sand);
const M = sand.__M, PS = sand.__P;

/* ── 워커 ── */
const SUPER = "sup@seastar.test";
const workerOut = path.join(os.tmpdir(), "p151-worker-" + process.pid + ".mjs");
await esbuild.build({
  entryPoints: [path.join(srcDir, "index.tsx")], bundle: true, format: "esm", platform: "neutral",
  outfile: workerOut, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent", conditions: ["workerd", "worker", "browser"],
});
const mf = new Miniflare({
  modules: true, scriptPath: workerOut, d1Databases: { DB: "p151-" + Date.now() }, r2Buckets: { R2: "p151r2-" + Date.now() },
  bindings: { DEMO_LOGIN: "0", SUPER_ADMIN_EMAIL: SUPER, SUPER_ADMIN_EMAILS: SUPER }, compatibilityDate: "2025-01-01",
});
const BASE = "http://p151.test";
const db = await mf.getD1Database("DB");
for (const f of fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()) {
  for (const st of rd("migrations/" + f).replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean)) await db.exec(st);
}
const run = (q, a = []) => db.prepare(q).bind(...a).run();
const first = (q, a = []) => db.prepare(q).bind(...a).first();
const all = async (q, a = []) => (await db.prepare(q).bind(...a).all()).results || [];

const U = { o: "owner@seastar.test", x: "outsider@seastar.test" };
const TOK = {};
for (const k of Object.keys(U)) {
  const now = Date.now();
  await run("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, 'seed', ?, ?, 0)", [U[k], k, now, now]);
  await run("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, 'seastar.test', 'x', 's', 1, ?, ?, 0)", [U[k], k, now, now]);
  TOK[k] = "local-p151-" + k + "-" + crypto.randomBytes(6).toString("hex");
  await run("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOK[k], U[k], now, now + 8.64e7]);
}
const api = async (tok, method, url, body) => {
  const r = await mf.dispatchFetch(BASE + url, { method, headers: Object.assign({ "Content-Type": "application/json" }, tok ? { Authorization: "Bearer " + tok } : {}), body: body == null ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
};

/* ── 시드 ── */
const PID = "prj_p151", PID2 = "prj_p151_x";
const MAIN = "dep_main", VEC = "dep_vec", PEND = "dep_pend", AMB = "dep_amb", DEAD = "dep_dead", DEADHOME = "dep_deadhome", XP = "dep_xp", XDEP = "dep_x";
const BOX = { x: 20, y: 20, w: 40, h: 30 }, BOX2 = { x: 60, y: 60, w: 30, h: 30 };
const PINS0 = [
  { id: "o3", x: 70, y: 10, page: 1, label: "P-X", imageId: "img_o3" },              // 밖 · 360(비숫자)
  { id: "a", x: 30, y: 30, page: 1, label: "P-A", imageId: "img_a", author: "owner@seastar.test" },  // 안 · 360(비숫자)
  { id: "o1", x: 5, y: 5, page: 1, label: "1", checkboard: true },                     // 밖
  { id: "b", x: 50, y: 45, page: 1, label: "3", checkboard: true },                    // 안
  { id: "o2", x: 80, y: 80, page: 1, label: "5", checkboard: true },                   // 밖(BOX2 안)
  { id: "p2", x: 30, y: 30, page: 2, label: "9", checkboard: true },                   // 다른 페이지
  { id: "t", _deleted: true, ts: 5 },
];
const PEND_PINS = [{ id: "a", x: 50, y: 50, page: 1, label: "7", checkboard: true }, { id: "q", x: 10, y: 90, page: 1, label: "P-Q" }];
{
  const now = Date.now();
  await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, 'P151', '', ?, ?, ?, 0)", [PID, U.o, now, now]);
  await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, 'OTHER', '', ?, ?, ?, 0)", [PID2, U.x, now, now]);
  const dep = (id, pid, pins, deleted = 0) => run("INSERT INTO deployments (id, title, file_name, drawing_data, pages_data, pins, zones, annotations, created_at, updated_at, deleted, version, project_id) VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?, 4, ?)",
    [id, "T-" + id, id + ".pdf", "/api/r2/object/" + id + ".png", JSON.stringify(["/api/r2/object/" + id + ".png"]), JSON.stringify(pins), now, now, deleted, pid]);
  await dep(MAIN, PID, PINS0); await dep(VEC, PID, []); await dep(PEND, PID, PEND_PINS); await dep(AMB, PID, []);
  await dep(DEAD, PID, []); await dep(DEADHOME, PID, [{ id: "zz", x: 30, y: 30, page: 1, label: "1", checkboard: true }], 1);
  await dep(XP, PID, []); await dep(XDEP, PID2, [{ id: "secret", x: 30, y: 30, page: 1, label: "S" }]);
  await run("UPDATE projects SET original_deployment_id = ? WHERE id = ?", [MAIN, PID]);
  const deck = (id, pid, depId, srcDep, srcCrop) => run("INSERT INTO decks (id, project_id, name, deployment_id, page, crop, src_dep_id, src_page, src_crop, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, 0)",
    [id, pid, id, depId, srcDep, srcDep ? 1 : null, srcCrop ? JSON.stringify(srcCrop) : null, now, now]);
  await deck("dk_main", PID, MAIN, null, null);
  await deck("dk_vec", PID, VEC, MAIN, BOX);
  await deck("dk_pend", PID, PEND, MAIN, BOX2);
  await deck("dk_amb1", PID, AMB, MAIN, BOX);
  await deck("dk_amb2", PID, AMB, MAIN, BOX2);
  await deck("dk_dead", PID, DEAD, DEADHOME, BOX);
  await deck("dk_xp", PID, XP, XDEP, BOX);
  const note = (id, depId, pinId) => run("INSERT INTO pin_notes (id, deployment_id, pin_id, pin_label, body, status, author, author_role, created_at, updated_at, deleted) VALUES (?, ?, ?, '', ?, 'open', 'o', 'designer', ?, ?, 0)", [id, depId, pinId, "note " + id, now, now]);
  await note("n_o1", MAIN, "o1"); await note("n_a", MAIN, "a"); await note("n_pa", PEND, "a"); await note("n_pq", PEND, "q");
}
const depRow = (id) => first("SELECT * FROM deployments WHERE id = ?", [id]);
const pinsOf = async (id) => JSON.parse((await depRow(id)).pins || "[]");
const get = async (id) => { const r = await api(TOK.o, "GET", "/tables/deployments/" + id); return Object.assign({ pinsArr: JSON.parse((r.j && r.j.pins) || "[]") }, r); };
const near = (a, b) => Math.abs(a - b) <= 1e-9;

console.log("\n[⓪ 재현 — 원본 상자 안 핀이 구역 화면(GET)에 보이는가]");
{
  const g = await get(VEC);
  const ids = g.pinsArr.filter((p) => !p._deleted).map((p) => p.id);
  const a = g.pinsArr.find((p) => p.id === "a");
  ok(g.status === 200 && ids.join(",") === "a,b", "⓪ 구역 GET pins = 상자 안 원본 핀 a,b (원본 순서)", ids);
  ok(a && near(a.x, 25) && near(a.y, (30 - 20) / 30 * 100) && a.page === 1 && a.imageId === "img_a", "⓪ 좌표 = 구역 1페이지 % · 첨부 보존", a);
  ok(!ids.includes("p2") && !ids.includes("o1"), "⓪ 다른 페이지·상자 밖 원본 핀은 구역에 없음");
  ok(g.j.pin_alias === "on" && g.j.pin_home === MAIN, "⓪ 응답 메타 pin_alias=on · pin_home=원본", { a: g.j.pin_alias, h: g.j.pin_home });
}

console.log("\n[① 교차구현 일치 — 서버 regionAlias vs 클라 MapCtrl]");
{
  let worst = 0, n = 0, nullMis = 0;
  for (const c of [BOX, BOX2, { x: 3.3, y: 47.25, w: 12.125, h: 50.5 }]) {
    for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
      const px = c.x + (c.w * i) / 10, py = c.y + (c.h * j) / 10;
      const s = RA.fromBase(px, py, c), k = M.pageToDeckCropPct(px, py, c);
      if ((s === null) !== (k === null)) { nullMis++; continue; }
      worst = Math.max(worst, Math.abs(s.x - k.x), Math.abs(s.y - k.y));
      const sb = RA.toBase(s.x, s.y, c), kb = M.deckCropPctToPage(k.x, k.y, c);
      worst = Math.max(worst, Math.abs(sb.x - kb.x), Math.abs(sb.y - kb.y));
      n++;
    }
    const sOut = RA.fromBase(c.x - 0.01, c.y, c), kOut = M.pageToDeckCropPct(c.x - 0.01, c.y, c);
    if (sOut !== null || kOut !== null) nullMis++;
  }
  ok(n === 363 && nullMis === 0, "① 3상자×121점 · 상자 밖 판정 일치(" + n + "점, 불일치 " + nullMis + ")");
  ok(worst <= 1e-9, "① 정·역 max|Δ| = " + worst.toExponential(2) + " ≤ 1e-9 %p");
}

console.log("\n[② 투영 왕복]");
{
  const box = { page: 1, crop: BOX };
  const pr = RA.projectPins(PINS0, box);
  const back = RA.unprojectPins(pr, box, PINS0).filter((p) => !p._deleted);
  const orig = PINS0.filter((p) => p.id === "a" || p.id === "b");
  ok(back.length === 2 && back.every((p, i) => p.x === orig[i].x && p.y === orig[i].y && p.page === 1), "② unproject(project(p)) == p (원본 좌표 바이트 그대로)", back);
  const bare = RA.unprojectPins(pr, box).filter((p) => !p._deleted);
  ok(bare.every((p, i) => near(p.x, orig[i].x) && near(p.y, orig[i].y)), "② 원본 힌트 없이도 왕복 오차 ≤1e-9");
  ok(!pr.some((p) => ["o1", "o2", "o3", "p2"].includes(p.id)), "② 상자 밖·다른 페이지 = 투영 결과에 부재");
}

console.log("\n[③ PATCH 번역 — 구역 저장이 원본 상자 밖 핀을 건드리지 않는다]");
{
  const before = await pinsOf(MAIN);
  const g = await get(VEC);
  const V = g.j.version;
  ok(V === 1_000_000_000 + 4, "③ 구역 version = 별칭 버전(원본 기준 오프셋)", V);
  // 구역에서 b 삭제 + 새 핀 n1(구역 50,50) 추가, a 는 그대로
  const keep = g.pinsArr.filter((p) => p.id === "a");
  const body = { base_version: V, pins: JSON.stringify(keep.concat([{ id: "n1", x: 50, y: 50, page: 1, label: "P-N" }])), zones: JSON.stringify([{ id: "z1", x: 1, y: 1, w: 5, h: 5 }]) };
  const p = await api(TOK.o, "PATCH", "/tables/deployments/" + VEC, body);
  const after = await pinsOf(MAIN);
  const byId = (arr) => Object.fromEntries(arr.filter((x) => x.id != null).map((x) => [x.id, x]));
  const A = byId(after), B = byId(before);
  const live1 = after.filter((x) => !x._deleted && (x.page || 1) === 1).map((x) => x.id);
  ok(p.status === 200, "③ PATCH 200", p.status);
  ok(live1.length === 5 && ["o3", "o1", "o2"].every((k) => live1.includes(k)) && live1.includes("a") && !live1.includes("b") && live1.includes("n1"),
    "③ 원본 1페이지 = 밖 3 + 구역 본문 2(a·새 n1) = 5 (b 는 구역에서 지워 제거)", live1);
  ok(["o1", "o2", "o3", "p2", "t"].every((k) => JSON.stringify(A[k]) === JSON.stringify(B[k])), "③ 상자 밖·다른 페이지·tombstone 원본 핀 바이트 동일");
  ok(JSON.stringify(A.a) === JSON.stringify(B.a), "③ 구역에서 안 움직인 a = 원본 바이트 그대로(부동소수 흔들림 0)", A.a);
  ok(A.n1 && near(A.n1.x, 40) && near(A.n1.y, 35) && A.n1.page === 1, "③ 새 핀 n1 = 원본 좌표로 역변환(40,35)", A.n1);
  ok(after.map((x) => x.id).join(",").startsWith("o3,a,o1,o2,p2,t"), "③ 원본 순서 보존(번호 순번이 배열 순서에 묶임)", after.map((x) => x.id));
  const vrow = await depRow(VEC);
  ok(vrow.pins === "[]" && JSON.parse(vrow.zones)[0].id === "z1", "③ 구역 행 pins 는 저작 안 함('[]' 유지) · zones 는 구역 행에", { pins: vrow.pins });
  ok(p.j && p.j.version === 1_000_000_000 + 5 && JSON.parse(p.j.pins).some((x) => x.id === "n1" && near(x.x, 50)), "③ 응답 = 투영 + 새 별칭 버전", p.j && p.j.version);
  // 가드: 옛 버전(구역 자기 version 4) → 409 + 재투영 current
  const st = await api(TOK.o, "PATCH", "/tables/deployments/" + VEC, { base_version: 4, pins: "[]" });
  const cur = st.j && st.j.current;
  ok(st.status === 409 && cur && cur.version === 1_000_000_000 + 5 && JSON.parse(cur.pins).every((x) => x._deleted || (x.x >= 0 && x.x <= 100)) && !JSON.parse(cur.pins).some((x) => x.id === "o1"),
    "③ 옛 base_version → 409 · current 는 구역 좌표로 재투영", st.status);
  const nb = await api(TOK.o, "PATCH", "/tables/deployments/" + VEC, { pins: "[]" });
  ok(nb.status === 409, "③ 별칭 + 핀 본문 + base_version 없음 → 409(잠금 없는 전량 치환 금지)", nb.status);
  const bad = await api(TOK.o, "PATCH", "/tables/deployments/" + VEC, { base_version: 1_000_000_000 + 5, pins: "{not json" });
  ok(bad.status === 400 && JSON.stringify(await pinsOf(MAIN)) === JSON.stringify(after), "③ 깨진 pins → 400 · 원본 0건 변경", bad.status);
}

console.log("\n[④ /ops 번역 + 응답 재투영]");
{
  const now = Date.now();
  const r = await api(TOK.o, "POST", "/tables/deployments/" + VEC + "/ops", { base_version: null, ops: [
    { opId: "op-n2", entity: "pin", action: "upsert", id: "n2", data: { id: "n2", x: 25, y: 75, page: 1, label: "P-N2", updatedAt: now }, ts: now },
    { opId: "op-zone", entity: "zone", action: "upsert", id: "z2", data: { id: "z2", x: 2, y: 2, w: 3, h: 3 }, ts: now },
  ] });
  const after = await pinsOf(MAIN);
  const n2 = after.find((x) => x.id === "n2");
  const cur = r.j && r.j.current;
  const cn2 = cur && JSON.parse(cur.pins).find((x) => x.id === "n2");
  ok(r.status === 200 && n2 && near(n2.x, 30) && near(n2.y, 42.5) && n2.page === 1, "④ op 핀 = 원본 좌표로 역변환 저장(30,42.5)", n2);
  ok(cn2 && near(cn2.x, 25) && near(cn2.y, 75) && !JSON.parse(cur.pins).some((x) => x.id === "o1"), "④ 응답 current = 구역 좌표 재투영(상자 밖 원본 핀 없음)", cn2);
  ok(r.j && r.j.version === 1_000_000_000 + 6 && cur.version === r.j.version, "④ 응답 version = 별칭 버전", r.j && r.j.version);
  const vz = JSON.parse((await depRow(VEC)).zones).map((z) => z.id), mz = JSON.parse((await depRow(MAIN)).zones);
  ok(vz.includes("z2") && mz.length === 0, "④ 영역 op = 구역 행(원본 영역 불변)", { vz, mz });
  const ap = await first("SELECT deployment_id FROM applied_ops WHERE op_id = 'op-n2'");
  ok(ap && ap.deployment_id === MAIN, "④ applied_ops 키 = 핀 정본(원본)", ap);
  const d = await api(TOK.o, "POST", "/tables/deployments/" + VEC + "/ops", { ops: [{ opId: "op-del-a", entity: "pin", action: "delete", id: "a", ts: Date.now() }] });
  ok(d.status === 200 && (await pinsOf(MAIN)).find((x) => x.id === "a")._deleted === true, "④ 구역에서 지운 핀 = 원본 tombstone");
}

console.log("\n[⑤⑥ 번호 일치 · 채번 비충돌(클라 PinSeries 실 소스 + 서버 base_pins_min)]");
{
  // 깨끗한 상태로: 원본 핀 초기화 → 구역 GET
  await run("UPDATE deployments SET pins = ? WHERE id = ?", [JSON.stringify(PINS0), MAIN]);
  const g = await get(VEC);
  const base = g.j.base_pins_min;
  const regionPins = g.pinsArr.filter((p) => !p._deleted);
  const orig = PINS0.filter((p) => !p._deleted);
  const noOrig = PS.numbers(orig, 1).get("a"), noReg = PS.numbers(regionPins, 1, base).get("a");
  ok(Array.isArray(base) && base.length === 5 && base.every((x) => x.page === 1 && x.author === undefined), "⑤ base_pins_min = 원본 그 페이지 살아있는 핀 5개(구역 좌표계 page=1 · author 미포함)", base);
  ok(noOrig && noReg && noOrig.no === 2 && noReg.no === noOrig.no, "⑤ 비숫자 360 핀 a — 원본 no " + (noOrig && noOrig.no) + " == 구역 no " + (noReg && noReg.no));
  sand.State.pins = regionPins; sand.State.basePins = base;
  const noDef = PS.numbers(sand.State.pins, 1).get("a");
  ok(noDef && noDef.no === 2, "⑤ 기본값 경로(State.pins + State.basePins) 도 같은 번호", noDef);
  ok(PS.numbers(regionPins.slice(), 1).get("a").no === 1, "⑤ 대조: State.pins 가 아닌 배열은 base 미적용(종전 동작 불변)");
  ok(!PS.numbers(regionPins, 1, base).has("o3"), "⑤ 결과 맵엔 구역 핀만(원본 전용 핀은 순번 계산에만)");
  const nxReg = PS.nextInBand(regionPins, 1, "checkboard", 1, 1, base).no, nxOrig = PS.nextInBand(orig, 1, "checkboard", 1, 1).no;
  ok(nxOrig === 6 && nxReg === 6, "⑥ 구역 다음 체크보드 번호 = " + nxReg + " (원본 " + nxOrig + ", 상자 밖 5 와 비충돌)");
  ok(PS.nextSeriesNo(sand.State.pins, 1, 1, null, "checkboard") === 6, "⑥ nextSeriesNo 기본값 경로 = 6");
  ok(PS.duplicateCheckboardIds(regionPins.concat([{ id: "dupe", page: 1, x: 1, y: 1, label: "5", checkboard: true }]), 1, base).has("dupe"), "⑥ 중복 판정도 원본 기준(상자 밖 5 와 겹침 표시)");
  sand.State.pins = []; sand.State.basePins = null;
}

console.log("\n[⑦ 별칭 거부 — 모호 · 원본 삭제 · 다른 프로젝트]");
{
  const before = JSON.stringify(await pinsOf(MAIN));
  const amb = await get(AMB);
  ok(amb.j.pin_alias === "ambiguous" && amb.pinsArr.length === 0 && amb.j.version === 4, "⑦ 2 deck → 1 배포본(상자 다름) = ambiguous · 자기 핀 · 자기 버전", amb.j && amb.j.pin_alias);
  const pa = await api(TOK.o, "PATCH", "/tables/deployments/" + AMB, { base_version: 4, pins: JSON.stringify([{ id: "m1", x: 10, y: 10, page: 1 }]) });
  ok(pa.status === 200 && JSON.parse((await depRow(AMB)).pins)[0].id === "m1" && JSON.stringify(await pinsOf(MAIN)) === before, "⑦ 모호 구역 저장 = 자기 행에만(원본 0건 변경)");
  const dead = await get(DEAD);
  ok(dead.status === 200 && dead.j.pin_alias === undefined && dead.pinsArr.length === 0, "⑦ 원본 삭제됨 → 별칭 거부(삭제된 원본 핀 노출 0)", { a: dead.j && dead.j.pin_alias, n: dead.pinsArr.length });
  const xp = await get(XP);
  ok(xp.j.pin_alias === undefined && !xp.pinsArr.some((p) => p.id === "secret"), "⑦ 다른 프로젝트 배포본을 src 로 가리킨 구역 → 별칭 거부(누출 0)");
  const xpw = await api(TOK.o, "PATCH", "/tables/deployments/" + XP, { base_version: 4, pins: JSON.stringify([{ id: "w", x: 1, y: 1, page: 1 }]) });
  ok(xpw.status === 200 && JSON.parse((await depRow(XDEP)).pins).length === 1, "⑦ 그 구역 저장이 남의 배포본에 쓰지 않음");
}

console.log("\n[⑧ 이관 — 미리보기 · 실행 · 멱등 · 되돌리기]");
{
  const homeBefore = await pinsOf(MAIN);
  const g0 = await get(PEND);
  ok(g0.j.pin_alias === "pending" && g0.j.pin_alias_pending === 2 && g0.pinsArr.length === 2, "⑧ 자기 핀 있는 구역 = pending(자동 변환 금지 · 자기 핀 그대로)", g0.j && g0.j.pin_alias);
  const pv = await api(TOK.o, "GET", "/tables/deployments/" + PEND + "/pin-alias");
  ok(pv.status === 200 && pv.j.state === "pending" && pv.j.count === 2 && pv.j.inside === 2 && pv.j.renamed === 1 && pv.j.notes === 2 && pv.j.ready === true, "⑧ 미리보기 2개 · 안 2 · id 재발급 1 · 노트 2", pv.j);
  ok(JSON.stringify(await pinsOf(MAIN)) === JSON.stringify(homeBefore), "⑧ 미리보기 = 쓰기 0");
  const r1 = await api(TOK.o, "POST", "/tables/deployments/" + PEND + "/pin-alias", { version: pv.j.version });
  const home1 = await pinsOf(MAIN);
  const notes1 = await all("SELECT id, deployment_id, pin_id FROM pin_notes ORDER BY id");
  const moved = home1.filter((p) => !homeBefore.some((h) => h.id === p.id));
  const rg = moved.find((p) => String(p.id).startsWith("rgdk_pend-"));
  ok(r1.status === 200 && r1.j.moved === 2 && moved.length === 2, "⑧ 실행 → 원본에 2개 추가", r1.j);
  ok(rg && rg.srcPinId === "a" && rg.srcDeckId === "dk_pend" && near(rg.x, 75) && near(rg.y, 75), "⑧ id 충돌 핀 = rg<deck>-n 재발급 + provenance + 원본 좌표(75,75)", rg);
  ok(homeBefore.every((h) => JSON.stringify(home1.find((x) => x.id === h.id)) === JSON.stringify(h)), "⑧ 기존 원본 핀 바이트 불변");
  const np = notes1.find((n) => n.id === "n_pa"), nq = notes1.find((n) => n.id === "n_pq");
  ok(np.deployment_id === MAIN && np.pin_id === rg.id && nq.deployment_id === MAIN && nq.pin_id === "q", "⑧ 노트가 핀을 따라 원본으로(재발급 id 치환)", { np, nq });
  const arch = await first("SELECT * FROM region_pin_migration WHERE deployment_id = ?", [PEND]);
  ok(arch && arch.pins_json === JSON.stringify(PEND_PINS) && JSON.parse(arch.notes_json).length === 2, "⑧ 원본 blob 그대로 보관(region_pin_migration)");
  const g1 = await get(PEND);
  ok((await depRow(PEND)).pins === "[]" && g1.j.pin_alias === "on" && g1.pinsArr.some((p) => p.id === rg.id && near(p.x, 50)), "⑧ 이관 후 구역 = 별칭(원본에서 투영)", g1.j && g1.j.pin_alias);
  const r2 = await api(TOK.o, "POST", "/tables/deployments/" + PEND + "/pin-alias", {});
  const home2 = await pinsOf(MAIN);
  const nc2 = (await first("SELECT COUNT(*) AS n FROM pin_notes")).n;
  ok(r2.status === 200 && r2.j.already === true && r2.j.moved === 0 && JSON.stringify(home2) === JSON.stringify(home1) && nc2 === notes1.length, "⑧ 2회 실행 = 0건(원본 핀 수·노트 수 1회차와 동일)", r2.j);
  const u = await api(TOK.o, "POST", "/tables/deployments/" + PEND + "/pin-alias/undo", { migration_id: r1.j.migration_id });
  const home3 = await pinsOf(MAIN);
  const npu = await first("SELECT deployment_id, pin_id FROM pin_notes WHERE id = 'n_pa'");
  ok(u.status === 200 && u.j.restored === 2 && (await depRow(PEND)).pins === JSON.stringify(PEND_PINS), "⑧ 되돌리기 → 구역 핀 원문 복원", u.j);
  ok(home3.filter((p) => moved.some((m) => m.id === p.id)).every((p) => p._deleted) && npu.deployment_id === PEND && npu.pin_id === "a", "⑧ 원본 추가분 tombstone · 노트 복귀", npu);
  ok((await get(PEND)).j.pin_alias === "pending", "⑧ 되돌린 뒤 = 다시 pending");
}

console.log("\n[⑨ 노트 별칭 · ⑩ 경량 버전 · ⑪ 개정 차단 · ⑫ 원본 삭제 가드 · ⑬ 목록]");
{
  await run("UPDATE deployments SET pins = ? WHERE id = ?", [JSON.stringify(PINS0), MAIN]);
  const pn = await api(TOK.o, "POST", "/api/notes", { deployment_id: VEC, pin_id: "a", body: "구역에서 쓴 노트", kind: "note" });
  const row = pn.j && pn.j.id ? await first("SELECT deployment_id FROM pin_notes WHERE id = ?", [pn.j.id]) : null;
  ok(pn.status === 200 && row && row.deployment_id === MAIN, "⑨ 구역 화면 핀 노트 = 원본 소속 저장", { s: pn.status, row });
  const ln = await api(TOK.o, "GET", "/api/notes?deployment_id=" + VEC);
  const lids = ((ln.j && ln.j.data) || []).map((n) => n.pin_id);
  ok(ln.status === 200 && lids.includes("a") && !lids.includes("o1"), "⑨ 구역 노트 목록 = 상자 안 원본 핀 노트만(o1 제외)", lids);
  const sm = await api(TOK.o, "GET", "/api/notes/summary?deployment_id=" + VEC);
  ok(sm.status === 200 && sm.j.data.a && !sm.j.data.o1, "⑨ 노트 요약 배지도 같은 범위", sm.j && Object.keys(sm.j.data));
  const v1 = (await api(TOK.o, "GET", "/tables/deployments/" + VEC + "?fields=version")).j.version;
  const mv = (await get(MAIN)).j.version;
  await api(TOK.o, "PATCH", "/tables/deployments/" + MAIN, { base_version: mv, pins: JSON.stringify(PINS0) });
  const v2 = (await api(TOK.o, "GET", "/tables/deployments/" + VEC + "?fields=version")).j.version;
  ok(v1 === 1_000_000_000 + mv && v2 === v1 + 1, "⑩ 경량 버전 = 별칭 버전 · 원본 저장 시 증가(구역 폴링이 원본 변경을 감지)", { v1, v2, mv });
  const rv = await api(TOK.o, "POST", "/api/deployments/" + VEC + "/revisions", { base_version: v2, rev_label: "Rev.1", pages_data: "[]" });
  ok(rv.status === 409 && rv.j.pin_alias === "on", "⑪ 별칭 구역에 개정 적용 → 409(원본에서 개정)", rv.status);
  const del = await api(TOK.o, "DELETE", "/tables/deployments/" + MAIN);
  ok(del.status === 409 && (await depRow(MAIN)).deleted === 0, "⑫ 핀 정본(원본) 삭제 → 409 · 삭제 0건", del.status);
  const ls = await api(TOK.o, "GET", "/tables/deployments?limit=100");
  const lv = ((ls.j && ls.j.data) || []).find((d) => d.id === VEC);
  ok(lv && lv.pin_alias === "on" && JSON.parse(lv.pins).some((p) => p.id === "a" && near(p.x, 25)), "⑬ 목록 응답도 같은 투영", lv && lv.pin_alias);
}

await mf.dispose();
clearTimeout(watchdog);
console.log("\n" + (failed ? "FAIL " + failed + "건" : "ALL PASS"));
process.exit(failed ? 1 : 0);
