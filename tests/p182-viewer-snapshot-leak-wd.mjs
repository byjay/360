/**
 * p182 — viewer-audit: 열람 링크 통행증으로 작업본·설계자 신원이 새는 경로 0 + 쓰기 전 라우트 4xx (실 workerd · 실 D1 · 목 0)
 *
 * 결함(2026-10-23 재현): 배포 후 디자이너가 작업본을 고치면
 *   GET /api/deployments/:id/revisions      → 열람자에게 작업본 제목·버전(LIVESECRETTITLE · v19 vs 동결본 v18) 200
 *   GET /api/deployments/:id/gps-calibration → 열람자에게 작업본 기준점 + created_by(설계자 이메일) 200
 * 근본원인: revGate·gpsCalibGate 가 canReadDepRow(링크 범위 허용)만 보고 작업본 행을 그대로 썼다
 *   — /tables/deployments/:id 의 "멤버 읽기만 작업본" 판정(memberRead)을 공유하지 않았다 → isMemberReadOfDep 로 일원화.
 *
 *  R1 개정 이력 = 열람자 403(작업본 0) · R2 GPS = 열람자 403(이메일 0) · R3 멤버(super)는 둘 다 200(회귀 0)
 *  R4 단건 배포본 = 동결본(작업본 표식 0) · R5 열람자 GET 전 라우트 응답에 작업본 표식·설계자 이메일·프로젝트명 0
 *  R6 열람자 쓰기 전 라우트(allowlist 밖) 4xx · R7 남의 노트 수정·상태·삭제 403 · 답변(reply) 403
 *
 * 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p182-viewer-snapshot-leak-wd.mjs
 *   뮤테이션: P182_MUT=revgate|gpsgate|member → 격리 사본만 고쳐 빌드, EXIT=1 이어야 한다.
 * 사전: .tmp/localdev-state (node build-tools/local-dev.mjs && node build-tools/seed-local.mjs) — 사본만 쓴다.
 */
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = path.join(ROOT, ".tmp");
const MUT = process.env.P182_MUT || "";
const OUT = path.join(TMP, "p182" + (MUT ? "-mut-" + MUT : ""));
const WORK = path.join(OUT, "work"), STATE = path.join(OUT, "state");
const NM = path.join(ROOT, "node_modules");
const PID = "proj_localseed", DEP = "dep_localseed_original", PROJ_NAME = "로컬 테스트 프로젝트";
let failed = 0;
const ok = (c, label, d) => { console.log((c ? "  PASS " : "  FAIL ") + label + (d != null ? " :: " + JSON.stringify(d).slice(0, 400) : "")); if (!c) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
if (!fs.existsSync(path.join(TMP, "localdev-state"))) { console.log("FAIL .tmp/localdev-state 없음"); process.exit(2); }
const watchdog = setTimeout(() => { console.log("WATCHDOG 600s → FAIL"); process.exit(1); }, 600000);

const MUTS = {
  revgate: ["src/index.tsx", "개정 이력은 작업본(제목·버전·핀) 기준이라 링크 열람자에게 내리지 않는다.\n  if (!isMemberReadOfDep(scope, idx, dep)) return { res: c.json({ error: 'forbidden — view link reads the published snapshot only' }, 403) }", "개정 이력은 작업본(제목·버전·핀) 기준이라 링크 열람자에게 내리지 않는다."],
  gpsgate: ["src/index.tsx", "GPS 기준점은 작업본 데이터(+ created_by 설계자 이메일)라 링크 열람자에게 내리지 않는다.\n  if (!isMemberReadOfDep(scope, idx, dep)) return { res: c.json({ error: 'forbidden — view link reads the published snapshot only' }, 403) }", "GPS 기준점은 작업본 데이터(+ created_by 설계자 이메일)라 링크 열람자에게 내리지 않는다."],
  member:  ["src/index.tsx", "if (!dep || s.linkOnly) return false", "if (!dep) return false"],
};
if (MUT && !MUTS[MUT]) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }

fs.rmSync(WORK, { recursive: true, force: true }); fs.mkdirSync(WORK, { recursive: true });
for (const f of ["public", "src", "migrations"]) fs.cpSync(path.join(ROOT, f), path.join(WORK, f), { recursive: true, filter: (s) => !/[\\/]public[\\/]js[\\/]main\.js$/.test(s) });
for (const f of ["vite.config.ts", "package.json", "tsconfig.json", "wrangler.jsonc"]) fs.copyFileSync(path.join(ROOT, f), path.join(WORK, f));
{
  const wj = path.join(WORK, "wrangler.jsonc");
  const txt = fs.readFileSync(wj, "utf8").replace(/,(\s*\/\/[^\r\n]*)*\s*"ai"\s*:\s*\{[^}]*\}/, "");
  if (/"ai"\s*:/.test(txt)) { console.log("FAIL 격리 사본 AI 바인딩 제거 실패"); process.exit(2); }
  fs.writeFileSync(wj, txt);
}
if (MUT) {
  const [file, from, to] = MUTS[MUT];
  const fp = path.join(WORK, file);
  const src = fs.readFileSync(fp, "utf8").replace(/\r\n/g, "\n");
  if (src.indexOf(from) < 0) { console.log("  FAIL 뮤테이션 대상 문자열 없음: " + MUT); process.exit(2); }
  fs.writeFileSync(fp, src.replace(from, to));
  console.log("[MUT] " + MUT + " — " + file + " 의 고친 줄을 되돌림");
}
const man = fs.readFileSync(path.join(WORK, "public/js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
fs.writeFileSync(path.join(WORK, "public/js/main.js"), man.map((f) => fs.readFileSync(path.join(WORK, "public/js/modules", f), "utf8")).join("\n"));
const env = { ...process.env, TEMP: TMP, TMP: TMP };
execSync(`node --max-old-space-size=640 "${path.join(NM, "vite/bin/vite.js")}" build`, { cwd: WORK, env, stdio: "pipe" });
fs.rmSync(STATE, { recursive: true, force: true });
fs.cpSync(path.join(TMP, "localdev-state"), STATE, { recursive: true });
const wr = (args) => execSync(`node "${path.join(NM, "wrangler/bin/wrangler.js")}" ${args}`, { cwd: WORK, env, stdio: "pipe" });
for (const mf of fs.readdirSync(path.join(WORK, "migrations")).filter((f) => /^\d+_.*\.sql$/.test(f) && f >= "0042")) {
  try { wr(`d1 execute webapp-production --local --persist-to "${STATE}" --file "migrations/${mf}"`); } catch (e) { /* ALTER 중복 = 이미 적용 */ }
}
const PORT = process.env.P182_PORT || "18882", BASE = "http://127.0.0.1:" + PORT;
const wrangler = spawn("node", [path.join(NM, "wrangler/bin/wrangler.js"), "pages", "dev", "dist", "--d1=webapp-production", "--local", "--persist-to", STATE, "--ip", "127.0.0.1", "--port", PORT],
  { cwd: WORK, env, stdio: ["ignore", "pipe", "pipe"] });
let wlog = ""; wrangler.stdout.on("data", (d) => (wlog += d)); wrangler.stderr.on("data", (d) => (wlog += d));
async function api(method, url, body, tok) {
  const r = await fetch(BASE + url, { method, redirect: "manual", headers: Object.assign({ "Content-Type": "application/json" }, tok ? { Authorization: "Bearer " + tok } : {}), body: body == null ? undefined : JSON.stringify(body) });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) {}
  return { s: r.status, j, text };
}

try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { const r = await fetch(BASE + "/manifest.webmanifest"); up = !!r.status; } catch (e) {} if (!up) await wait(500); }
  if (!up) { console.log("FAIL wrangler 기동 실패\n" + wlog.slice(-1500)); process.exit(1); }
  const acc = JSON.parse(fs.readFileSync(path.join(TMP, "local-test-accounts.json"), "utf8")).accounts;
  const sup = acc.find((a) => a.role === "super");
  const sTok = (await api("POST", "/api/signup/login", { email: sup.email, password: sup.password })).j.token;
  const pub = await api("POST", "/api/projects/" + PID + "/publish", null, sTok);
  const tok = (pub.j && pub.j.project && pub.j.project.share_path || "").split("/").pop();
  const va = await api("PUT", "/api/projects/" + PID + "/viewer-access", { email_auth: false }, sTok);
  const vt = (await api("POST", "/api/auth/auto-entry", { kind: "viewer", v: tok })).j.token;
  ok(sTok && pub.s === 200 && va.s === 200 && !!vt, "준비 — super 로그인 · 배포 · 무인증 링크 · 열람 통행증");

  // 배포 후 디자이너 작업본 변경 — 열람자에게 보이면 안 되는 표식
  const live = (await api("GET", "/tables/deployments/" + DEP, null, sTok)).j;
  const pins = JSON.parse(live.pins || "[]").concat([{ id: Date.now(), x: 5, y: 5, page: 1, label: "LIVESECRETPIN", author: sup.email }]);
  const pt = await api("PATCH", "/tables/deployments/" + DEP, { pins: JSON.stringify(pins), title: "LIVESECRETTITLE", base_version: live.version }, sTok);
  const gps = await api("POST", "/api/deployments/" + DEP + "/gps-calibration", { page: 1, points: [{ x: 1, y: 1, lat: 35, lng: 129 }, { x: 2, y: 2, lat: 35.1, lng: 129.1 }], matrix: { a: 1 }, residual_m: 0.5 }, sTok);
  ok(pt.s === 200 && gps.s === 200, "준비 — 배포 후 작업본 수정(제목·핀) + GPS 기준점 저장", { patch: pt.s, gps: gps.s });

  const vRev = await api("GET", "/api/deployments/" + DEP + "/revisions", null, vt);
  ok(vRev.s === 403 && !vRev.text.includes("LIVESECRET"), "R1 열람자 개정 이력 = 403(작업본 제목·버전 0)", { s: vRev.s, body: vRev.text.slice(0, 160) });
  const vGps = await api("GET", "/api/deployments/" + DEP + "/gps-calibration?page=1", null, vt);
  ok(vGps.s === 403 && !vGps.text.includes(sup.email), "R2 열람자 GPS 기준점 = 403(설계자 이메일 0)", { s: vGps.s, body: vGps.text.slice(0, 160) });
  const sRev = await api("GET", "/api/deployments/" + DEP + "/revisions", null, sTok);
  const sGps = await api("GET", "/api/deployments/" + DEP + "/gps-calibration?page=1", null, sTok);
  ok(sRev.s === 200 && sRev.j.deployment.title === "LIVESECRETTITLE" && sGps.s === 200 && sGps.j.data && sGps.j.data.points.length === 2, "R3 멤버(super)는 개정 이력·GPS 그대로 200(작업본)", { rev: sRev.s, gps: sGps.s });
  const vDep = await api("GET", "/tables/deployments/" + DEP, null, vt);
  ok(vDep.s === 200 && vDep.j.snapshot_at != null && !vDep.text.includes("LIVESECRET"), "R4 열람자 단건 배포본 = 동결본(작업본 표식 0)", { s: vDep.s, snap: vDep.j && vDep.j.snapshot_at });

  const src = fs.readFileSync(path.join(WORK, "src/index.tsx"), "utf8");
  const sub = (p) => p.replace(/\/tables\/deployments\/:id/, "/tables/deployments/" + DEP).replace(/\/api\/deployments\/:id/, "/api/deployments/" + DEP)
    .replace(/\/api\/projects\/:id/, "/api/projects/" + PID).replace(/:email/, "x%40y.z").replace(/:[a-zA-Z]+/g, "x1").replace(/\*$/, "localseed/ga.pdf");
  const routes = [...src.matchAll(/^\s*app\.(get|post|put|patch|delete)\('([^']+)'/gm)].map((m) => [m[1].toUpperCase(), m[2]]);
  const allow = (src.match(/const READONLY_ALLOWED_WRITE_PREFIXES = \[([^\]]*)\]/) || [, ""])[1].match(/'[^']+'/g).map((s) => s.slice(1, -1));
  const NEEDLES = ["LIVESECRET", PROJ_NAME, sup.email];
  const leaks = [], badWrites = [], allowed2xx = [];
  let nGet = 0, nWrite = 0;
  for (const [m, p] of routes) {
    if (m === "GET") {
      nGet++;
      const r = await api("GET", sub(p), null, vt);
      const hit = NEEDLES.filter((n) => r.text.includes(n));
      if (r.s < 300 && hit.length) leaks.push({ p, s: r.s, hit });
    } else {
      if (p === "/api/signup/logout") continue;   // 통행증 세션 무관(로컬 세션 종료) — 부작용만 있어 제외
      nWrite++;
      const r = await api(m, sub(p), {}, vt);
      const isAllow = allow.some((x) => p === x || p.startsWith(x));
      if (!isAllow && !(r.s >= 400 && r.s < 500)) badWrites.push([m, p, r.s]);
      if (isAllow && r.s < 400) allowed2xx.push([m, p, r.s]);
    }
  }
  ok(nGet > 40 && leaks.length === 0, "R5 열람자 GET 전 라우트(" + nGet + "개) 응답에 작업본 표식·설계자 이메일·프로젝트명 0", leaks);
  ok(nWrite > 60 && badWrites.length === 0 && allowed2xx.length === 0, "R6 열람자 쓰기 전 라우트(" + nWrite + "개) — allowlist 밖 4xx · 빈 본문 allowlist 2xx 0", { badWrites, allowed2xx });

  const pin0 = JSON.parse(vDep.j.pins)[0];
  const n = await api("POST", "/api/notes", { deployment_id: DEP, pin_id: String(pin0.id), kind: "note", body: "designer note" }, sTok);
  const nid = n.j && n.j.id;
  const fx = { patch: (await api("PATCH", "/api/notes/" + nid, { body: "x" }, vt)).s, status: (await api("PATCH", "/api/notes/" + nid, { status: "done" }, vt)).s, del: (await api("DELETE", "/api/notes/" + nid, null, vt)).s,
    reply: (await api("POST", "/api/notes", { deployment_id: DEP, pin_id: String(pin0.id), kind: "reply", parent_id: nid, body: "x" }, vt)).s };
  ok(n.s === 200 && fx.patch === 403 && fx.status === 403 && fx.del === 403 && fx.reply === 403, "R7 열람자 — 남의 노트 수정·상태·삭제·답변 403", fx);
} catch (e) { console.log("  FAIL 예외 " + String(e && e.stack || e).slice(0, 600)); failed++; }
finally { clearTimeout(watchdog); try { wrangler.kill(); } catch (e) {} }
console.log("\n" + (failed ? "FAIL " + failed : "ALL PASS"));
process.exit(failed ? 1 : 0);
