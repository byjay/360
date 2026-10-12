/**
 * p149-cdp — WO 20261012-viewlink 열람 링크 비식별·즉시 뷰어·360 전용·읽기 전용·사진 안 요청·고정 스냅샷·배포 취소/재배포 (실 Chrome · 실 워커 · 목 0)
 *
 * 마스터 원문(2026-10-12):
 *   "배포시 회사이름이나 프로젝트는 전체 보안화해 https://scan.seastar.work/까지만 노출하고"
 *   "배포후에 링크있는사람은 그냥 뷰어를 자동으로 볼수있게해" · "배포시에는 360만 배포하는거다"
 *   "해당 특정프로젝트 위로만 배포가 되는데 프로젝트 선택은 나올필요가없겠지" · "뷰어전용인데 이런게 나올필요는없겠지"
 *   "뷰어는 디자이너가 지정한 구역트리별로 트리만 읽기 전용으로 보고 코멘트노드의 쓰기 권한으로 작성후 디자이너에게 문의할 권한만 있어"
 *   "이때는 반드시 디자이너의 프로젝트의 수정내용이 반영돼서는 안돼" · "요청질문은 사진이 나온상태로 하고 사진내에서 가능하게해"
 *   "배포취소도 기능구현하고 이거한후 재배포하면 업데이트되게해"
 *
 *  A. 서버(API) — 링크 경로 /v/<토큰>(이름 0) · 공개 응답 이름 0 · 열람 셸(중립 제목·wm-view-link) · 통행증 신원 0 · 360 강제(구 체커 링크 포함)
 *     · 열람자 쓰기(핀·구역·배포본·업로드) 4xx · 코멘트 200(이름 생략=열람자) · 코멘트 전후 배포본 해시 동일 · 디자이너 요청함 노출(link_ref·pano_view)
 *  S. 고정 스냅샷 — 배포 후 디자이너 핀 추가·이동·삭제 + 구역 추가 → 열람 변화 0 · 다시 배포(업데이트) → 같은 링크로 반영
 *  C. 배포 취소 — /v 410 화면(데이터 0) · 이미 받은 통행증 410 · 코멘트 보존 · 재배포 → 같은 링크 200 + 최신 스냅샷 · 새 링크 발급 → 옛 링크 404
 *  B. 브라우저 — 구 /srview/<이름>-<토큰> → /v/<토큰> replace · 첫 로드 1회(재로드 0) · 허브 미표시(첫 페인트부터) · 제목·URL·DOM 에 프로젝트명·We:are 0
 *     · 편집 UI 0(⋯·정보·다운로드·삭제·구역 만들기·도구·내보내기·CHECKER 잎) · 우클릭 편집 항목 0 · CHECKER 핀 0 · 게이트 0
 *     · 이 기기의 디자이너 draft 를 두고 열어도 PUT /api/r2/upload 0 · #src-keep-fail 0 · 뒤로가기·로고·ProjectHub.open() 후에도 허브 0
 *     · 사진 밖 요청 진입 0(안내) · 사진 안 [요청·질문] → 사진 유지한 채 작성 200 · 저장된 사진 id·방향 일치 · 디자이너 요청함 → 같은 사진·방향
 *     · Request Access Phone 칸 배경 = 다른 칸 · 대비 ≥ 4.5 · 배포 취소 후 [최신 배포본 다시 불러오기] → "배포가 중단된 링크입니다"(핀 0)
 *
 * 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p149-viewlink-anon-cdp.mjs
 *   뮤테이션: P149_MUT=<이름> → 격리 사본만 고쳐 빌드, EXIT=1 이어야 한다(목록 = MUTS).
 * 사전: .tmp/localdev-state (node build-tools/local-dev.mjs && node build-tools/seed-local.mjs) — 사본(.tmp/p149/state)만 쓴다.
 */
import { execSync, spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = path.join(ROOT, ".tmp");
const MUT = process.env.P149_MUT || "";
const OUT = path.join(TMP, "p149" + (MUT ? "-mut-" + MUT : ""));
const WORK = path.join(OUT, "work");
const STATE_SRC = path.join(TMP, "localdev-state");
const STATE = path.join(OUT, "state");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const NM = path.join(ROOT, "node_modules");
const PID = "proj_localseed", DEP = "dep_localseed_original", PROJ_NAME = "로컬 테스트 프로젝트";
let failed = 0;
const ok = (c, label, d) => { console.log((c ? "  PASS " : "  FAIL ") + label + (d != null ? " :: " + JSON.stringify(d).slice(0, 500) : "")); if (!c) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
if (!fs.existsSync(STATE_SRC)) { console.log("FAIL .tmp/localdev-state 없음"); process.exit(2); }
if (!fs.existsSync(CHROME)) { console.log("FAIL Chrome 없음"); process.exit(2); }
const watchdog = setTimeout(() => { console.log("\nWATCHDOG — 600s 초과 → FAIL"); process.exit(1); }, 600000);

/* ── 뮤테이션(격리 사본만) — 고친 줄을 되돌리면 이 테스트가 FAIL 해야 한다 ── */
const MUTS = {
  slug:      ["src/index.tsx", "return (r && r.share_token) ? viewPath(String(r.share_token)) : null", "return (r && r.share_token) ? '/srview/' + encodeURIComponent(String(r.name)) + '-' + String(r.share_token) : null"],
  roui:      ["public/css/style.css", "body.role-viewer #rpt-bundle-btn { display: none !important; }", "body.role-viewer #rpt-bundle-btn { }"],
  hubcss:    ["public/css/style.css", "html.wm-view-link #screen-projects { display: none !important; }", ""],
  swreload:  ["public/index.html", "if (!swHadController) return;", ""],
  rosync:    ["public/js/modules/20_App.js", "_readonlySession() { return typeof Auth !== \"undefined\" && !!Auth.readonly; },", "_readonlySession() { return false; },"],
  notes:     ["src/index.tsx", "author = String(body.author || '').trim() || VIEW_LINK_USER.name", "return c.json({ error: 'mutated — viewer comment blocked' }, 403)"],
  hubguard:  ["public/js/modules/12_ProjectHub.js", "if (this._isShareEntry()) { if (typeof UI !== \"undefined\" && UI.showScreen) UI.showScreen(\"screen-app\"); return; }", ""],
  mode360:   ["src/index.tsx", "const LINK_VIEW_MODE = '360'", "const LINK_VIEW_MODE: any = null"],
  liveread:  ["src/index.tsx", "if (!memberRead && linkReadPids(scope).length) {", "if (false) {"],
  nocancel:  ["src/index.tsx", "if (!p || !Number(p.published)) continue                                       // 배포 취소·삭제 → 즉시 무효", "if (!p) continue"],
  nosnapupd: ["src/index.tsx", "try { snapDeps = await captureSnapshot(c, pid, String(user.email || '')) }", "try { snapDeps = 0 }"],
  panoview:  ["public/js/modules/42_Requests.js", "if (ctx.view) payload.view = ctx.view;", ""],
  identity:  ["src/index.tsx", "return { ...(p.k === 'designer' ? AUTO_DESIGNER_USER : VIEW_LINK_USER), _auto: true", "return { ...AUTO_DESIGNER_USER, _auto: true"],
  projname:  ["src/index.tsx", "if (linkReadPids(s).includes(String(p.id))) return { ...stripShareKey(base), name: '', description: null, info_json: parseProjectInfo(null) }", ""],
  phone:     ["public/css/style.css", "input[type=\"text\"], input[type=\"email\"], input[type=\"password\"], input[type=\"tel\"],", "input[type=\"text\"], input[type=\"email\"], input[type=\"password\"],"],
};
if (MUT && !MUTS[MUT]) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }

// ── 격리 빌드(작업트리 모듈 → WORK) + 상태 사본 ──
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (/\.png$/.test(f)) fs.rmSync(path.join(OUT, f), { force: true });
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
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
fs.cpSync(STATE_SRC, STATE, { recursive: true });
const wr = (args) => execSync(`node "${path.join(NM, "wrangler/bin/wrangler.js")}" ${args}`, { cwd: WORK, env, stdio: "pipe" });
// 공유 상태(localdev-state)는 마이그레이션 추적표가 어긋나 있다(0004 중복 컬럼 실측) → 이 작업이 의존하는 0042~ 만 파일 단위로 적용(멱등 CREATE·ALTER 는 이미 있으면 건너뜀)
for (const mf of fs.readdirSync(path.join(WORK, "migrations")).filter((f) => /^\d+_.*\.sql$/.test(f) && f >= "0042")) {
  try { wr(`d1 execute webapp-production --local --persist-to "${STATE}" --file "migrations/${mf}"`); } catch (e) { /* ALTER 중복 = 이미 적용 */ }
}
// 구버전 클라가 만든 "CHECKER 전용" 뷰어 링크(0042 시절 데이터) — 360 강제가 기존 링크에도 적용되는지 본다
const now0 = Date.now();
wr(`d1 execute webapp-production --local --persist-to "${STATE}" --command "INSERT OR REPLACE INTO view_links (id, dep_id, mode, created_by, created_at) VALUES ('lk_legacy_chk1', '${DEP}', 'checker', 'seed', ${now0})"`);

const PORT = process.env.P149_PORT || "18849";
const wrangler = spawn("node", [path.join(NM, "wrangler/bin/wrangler.js"), "pages", "dev", "dist", "--d1=webapp-production", "--local", "--persist-to", STATE, "--ip", "127.0.0.1", "--port", PORT],
  { cwd: WORK, env, stdio: ["ignore", "pipe", "pipe"] });
let wlog = ""; wrangler.stdout.on("data", (d) => (wlog += d)); wrangler.stderr.on("data", (d) => (wlog += d));
const BASE = "http://127.0.0.1:" + PORT;
let chrome = null; const sockets = [];
async function cleanup() { sockets.forEach((s) => { try { s.close(); } catch (e) {} }); try { chrome && chrome.kill(); } catch (e) {} try { wrangler.kill(); } catch (e) {} }

const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej));
async function api(method, url, body, tok, extra) {
  const r = await fetch(BASE + url, { method, redirect: "manual", headers: Object.assign({ "Content-Type": "application/json" }, tok ? { Authorization: "Bearer " + tok } : {}, extra || {}), body: body == null ? undefined : (typeof body === "string" ? body : JSON.stringify(body)) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch (e) {}
  return { s: r.status, j, text };
}
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 }); sockets.push(ws);
  await new Promise((r) => ws.on("open", r));
  let idc = 0; const pend = new Map(); const errs = []; const listeners = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
    if (m.method === "Runtime.exceptionThrown") errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300));
    listeners.forEach((f) => { try { f(m); } catch (e) {} });
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++idc; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr, ms) => { const r = await Promise.race([send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }), wait(ms || 60000).then(() => { throw new Error("evaluate 무응답"); })]); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
  const evS = async (e) => { try { return await ev(e, 15000); } catch (x) { return { __err: String(x.message).slice(0, 200) }; } };
  const waitFor = async (cond, t = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if ((await evS("(function(){try{return !!(" + cond + ")}catch(e){return false}})()")) === true) return Date.now() - t0; await wait(120); } return -1; };
  return { ws, send, ev, evS, waitFor, errs, listeners };
}
let shotN = 0;
async function shot(P, name) { const s = await P.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, String(++shotN).padStart(2, "0") + "-" + name + ".png"), Buffer.from(s.data, "base64")); }
async function click(P, x, y, button) {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await P.send("Input.dispatchMouseEvent", { type, x, y, button: button || "left", buttons: type === "mousePressed" ? (button === "right" ? 2 : 1) : 0, clickCount: 1 });
}
const VIS = `function vis(e){ if(!e) return false; var r=e.getBoundingClientRect(); if(!r.width||!r.height) return false; var s=getComputedStyle(e); if(s.visibility==='hidden'||s.display==='none'||+s.opacity<0.05) return false; var p=e.parentElement; while(p){ var ps=getComputedStyle(p); if(ps.display==='none'||ps.visibility==='hidden') return false; p=p.parentElement; } return true; }`;
const depHash = (j) => crypto.createHash("sha256").update(JSON.stringify([j.pins, j.zones, j.annotations, j.version, j.updated_at, j.title, j.pages_data])).digest("hex").slice(0, 16);
const pinsOf = (j) => { try { return JSON.parse(j.pins || "[]"); } catch (e) { return null; } };

try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { const r = await fetch(BASE + "/manifest.webmanifest"); up = !!r.status; } catch (e) {} if (!up) await wait(500); }
  if (!up) { console.log("FAIL wrangler 기동 실패\n" + wlog.slice(-1500)); process.exit(1); }

  const acc = JSON.parse(fs.readFileSync(path.join(TMP, "local-test-accounts.json"), "utf8")).accounts;
  const sup = acc.find((a) => a.role === "super");
  const sTok = (await api("POST", "/api/signup/login", { email: sup.email, password: sup.password })).j.token;
  ok(!!sTok, "준비 — 로컬 super(시드 프로젝트 소유자) 로그인");

  /* ══ A. 서버 ══ */
  console.log("\n[A] 링크 비식별 · 열람 셸 · 신원 0 · 360 강제 · 쓰기 거부 · 코멘트");
  const pub = await api("POST", "/api/projects/" + PID + "/publish", null, sTok);
  const sp = pub.j && pub.j.project && pub.j.project.share_path;
  const tok = sp ? sp.split("/").pop() : "";
  ok(pub.s === 200 && /^\/v\/[a-z2-7]{16}$/.test(sp || ""), "A1 배포 → 링크 = /v/<불투명 토큰 16자>(이름·슬러그 0)", sp);
  ok(!!sp && !decodeURIComponent(sp).includes("로컬") && !decodeURIComponent(sp).includes("테스트"), "A1b 링크 경로에 프로젝트명 0", decodeURIComponent(sp || ""));
  const sh = await api("GET", "/api/share/" + tok);
  ok(sh.s === 200 && sh.j.project && sh.j.project.id === PID && !sh.text.includes(PROJ_NAME) && !("name" in sh.j.project), "A2 공개 /api/share/:t = 이름 없음(id·배포본만)", sh.j);
  const sg = await api("GET", "/api/share-gate?t=" + tok);
  ok(sg.s === 200 && !sg.text.includes(PROJ_NAME), "A3 공개 share-gate 응답에도 이름 0", sg.j);
  const vShell = await api("GET", "/v/" + tok);
  const vTitle = (vShell.text.match(/<title>([^<]*)<\/title>/) || [])[1];
  ok(vShell.s === 200 && /<html class="wm-view-link"/.test(vShell.text) && vTitle && !vTitle.includes("We:are") && !vTitle.includes(PROJ_NAME), "A4 /v/<토큰> 셸 = 중립 제목 + html.wm-view-link", { s: vShell.s, title: vTitle });
  const legacyPath = "/srview/" + encodeURIComponent("로컬-테스트-프로젝트") + "-" + tok;
  const sShell = await api("GET", legacyPath);
  ok(sShell.s === 200 && /<html class="wm-view-link"/.test(sShell.text), "A4b 구 /srview/<이름>-<토큰> 하위호환 200", sShell.s);
  const bad = await api("GET", "/v/aaaaaaaaaaaaaaaa");
  ok(bad.s === 404, "A4c 모르는 토큰 /v = 404", bad.s);

  const ae = await api("POST", "/api/auth/auto-entry", { kind: "viewer", v: tok });
  const vt = ae.j && ae.j.token;
  const me = await api("GET", "/api/auth/me", null, vt);
  ok(ae.s === 200 && me.j && me.j.readonly === true && me.j.email === "" && me.j.name === "열람자" && !me.text.includes("seastargo") && !me.text.includes("설계자"),
    "A5 열람 통행증 세션 = 사람 신원 0(이메일 빈값·'열람자') · readonly", me.j);

  const vProj = await api("GET", "/api/projects", null, vt);
  ok(vProj.s === 200 && !vProj.text.includes(PROJ_NAME) && !vProj.text.includes(tok), "A5b 열람 세션 /api/projects 응답에도 프로젝트명·공유 토큰 0", { s: vProj.s, n: (vProj.j && vProj.j.data || []).length });

  const vDep = await api("GET", "/tables/deployments/" + DEP, null, vt);
  const vPins = vDep.j ? pinsOf(vDep.j) : null;
  ok(vDep.s === 200 && Array.isArray(vPins) && vPins.length > 0 && vPins.every((p) => !p.checkboard) && vDep.j.view_mode === "360", "A6 공유 링크 열람 = 360 핀만(CHECKER 0)", { s: vDep.s, n: vPins && vPins.length, chk: vPins && vPins.filter((p) => p.checkboard).length });
  const aeLegacy = await api("POST", "/api/auth/auto-entry", { kind: "viewer", lk: "lk_legacy_chk1" });
  const lgDep = await api("GET", "/tables/deployments/" + DEP, null, aeLegacy.j && aeLegacy.j.token);
  const lgPins = lgDep.j ? pinsOf(lgDep.j) : null;
  ok(lgDep.s === 200 && Array.isArray(lgPins) && lgPins.length > 0 && lgPins.every((p) => !p.checkboard), "A6b 기존 'CHECKER 전용' 링크(m=checker)도 360 강제", { s: lgDep.s, chk: lgPins && lgPins.filter((p) => p.checkboard).length, n: lgPins && lgPins.length });
  const aeD = await api("POST", "/api/auth/auto-entry", { kind: "viewer", d: DEP });
  const dDep = await api("GET", "/tables/deployments/" + DEP, null, aeD.j && aeD.j.token);
  ok(dDep.s === 200 && (pinsOf(dDep.j) || [{ checkboard: 1 }]).every((p) => !p.checkboard), "A6c 구 ?d= 링크도 360 강제", dDep.s);
  const vl = await api("POST", "/api/view-links", { dep_id: DEP, mode: "checker" }, sTok);
  ok(vl.s === 200 && vl.j.mode === "360" && /^\/v\/[a-z2-7]{16}$/.test(vl.j.path || ""), "A6d 새 뷰어 링크 발급 = 모드 무관 '360' 저장 + /v/<80비트 토큰>", vl.j);

  const supDep0 = (await api("GET", "/tables/deployments/" + DEP, null, sTok)).j;
  const h0 = depHash(supDep0);
  const writes = {
    patchDep: (await api("PATCH", "/tables/deployments/" + DEP, { pins: "[]", base_version: supDep0.version }, vt)).s,
    postDep: (await api("POST", "/tables/deployments", { title: "x", pins: "[]", project_id: PID }, vt)).s,
    postDeck: (await api("POST", "/api/projects/" + PID + "/decks", { name: "열람자 구역" }, vt)).s,
    putDeck: (await api("PUT", "/api/decks/dk_localseed_zoneA", { name: "x" }, vt)).s,
    upload: (await fetch(BASE + "/api/r2/upload", { method: "PUT", headers: { Authorization: "Bearer " + vt, "Content-Type": "application/pdf" }, body: "%PDF-1.4 x" })).status,
    publish: (await api("POST", "/api/projects/" + PID + "/unpublish", null, vt)).s,
  };
  ok(Object.values(writes).every((s) => s >= 400 && s < 500), "A7 열람자 쓰기(배포본 PATCH·생성·구역 생성/수정·R2 업로드·배포 취소) 전부 4xx", writes);

  const cBody = "p149 열람자 요청 " + Date.now();
  const pin360 = vPins.find((p) => p.imageId) || vPins[0];
  const cm = await api("POST", "/api/notes", { deployment_id: DEP, pin_id: String(pin360.id), pin_label: pin360.label, kind: "request", body: cBody,
    view: { image_id: String(pin360.imageId), yaw: 123.4, pitch: -12.5, fov: 70 } }, vt);
  ok(cm.s === 200 && cm.j && cm.j.author === "열람자", "A8 열람자 코멘트(요청) 작성 200 — 이름 생략 = '열람자'", { s: cm.s, j: cm.j && { author: cm.j.author, error: cm.j.error } });
  const h1 = depHash((await api("GET", "/tables/deployments/" + DEP, null, sTok)).j);
  ok(h0 === h1, "A8b 코멘트 전후 배포본 행(핀·구역·주석·버전·수정시각) 해시 동일 — 코멘트는 pin_notes 에만", { h0, h1 });
  const inbox = await api("GET", "/api/projects/" + PID + "/requests", null, sTok);
  const hit = inbox.j && (inbox.j.data || []).find((n) => n.body === cBody);
  ok(!!hit && /^share:[0-9a-f]{24}$/.test(hit.link_ref || "") && hit.pano_view && hit.pano_view.image_id === String(pin360.imageId) && Math.abs(hit.pano_view.yaw - 123.4) < 0.01 && Math.abs(hit.pano_view.pitch + 12.5) < 0.01,
    "A9 디자이너 요청함 노출 + 출처(link_ref=링크 지문) + 사진·방향(pano_view)", hit && { link_ref: hit.link_ref, pano_view: hit.pano_view });

  /* ══ S. 고정 스냅샷 ══ */
  console.log("\n[S] 배포 = 고정 스냅샷");
  const vBefore = JSON.stringify(pinsOf((await api("GET", "/tables/deployments/" + DEP, null, vt)).j));
  const decksBefore = JSON.stringify(((await api("GET", "/api/projects/" + PID + "/decks", null, vt)).j || {}).data || []);
  const work = pinsOf(supDep0);
  const content = work.filter((p) => !p.checkboard);
  const moved = content[0], removed = content[1];
  const newPin = { id: Date.now() + 777, createdAt: Date.now(), x: 30, y: 80, page: 1, label: "S-NEW", imageId: "pano_localseed_2", author: sup.email };
  const edited = work.filter((p) => p !== removed).map((p) => p === moved ? Object.assign({}, p, { x: 11, y: 12 }) : p).concat([newPin]);
  const pt = await api("PATCH", "/tables/deployments/" + DEP, { pins: JSON.stringify(edited), base_version: supDep0.version }, sTok);
  const dk = await api("POST", "/api/projects/" + PID + "/decks", { name: "S-배포후 구역" }, sTok);
  ok(pt.s === 200 && dk.s === 200, "S0 디자이너가 배포 후 핀 추가·이동·삭제 + 구역 추가(작업본)", { patch: pt.s, deck: dk.s });
  const vAfter = (await api("GET", "/tables/deployments/" + DEP, null, vt)).j;
  const decksAfter = JSON.stringify(((await api("GET", "/api/projects/" + PID + "/decks", null, vt)).j || {}).data || []);
  ok(JSON.stringify(pinsOf(vAfter)) === vBefore && decksAfter === decksBefore, "S1 열람자 화면 변화 0(핀·구역 트리 = 배포 시점 동결본)",
    { same_pins: JSON.stringify(pinsOf(vAfter)) === vBefore, same_decks: decksAfter === decksBefore, hasNew: (pinsOf(vAfter) || []).some((p) => p.label === "S-NEW") });
  const vList = await api("GET", "/tables/deployments?limit=50", null, vt);
  ok(vList.s === 200 && !(vList.j.data || []).some((r) => (pinsOf(r) || []).some((p) => p.label === "S-NEW")), "S1b 목록 경로도 동결본", vList.s);
  const r2new = await api("GET", "/api/r2/object/localseed/ga.pdf?t=" + encodeURIComponent(vt));
  ok(r2new.s === 200, "S1c 동결본이 참조하는 원본 PDF(R2) 열람 200", r2new.s);
  const repub = await api("POST", "/api/projects/" + PID + "/publish", null, sTok);
  const vUpd = (await api("GET", "/tables/deployments/" + DEP, null, vt)).j;
  const updPins = pinsOf(vUpd) || [];
  const decksUpd = (((await api("GET", "/api/projects/" + PID + "/decks", null, vt)).j || {}).data || []);
  ok(repub.s === 200 && repub.j.project.share_path === sp && updPins.some((p) => p.label === "S-NEW") && !updPins.some((p) => String(p.id) === String(removed.id)) &&
     updPins.some((p) => String(p.id) === String(moved.id) && p.x === 11) && decksUpd.some((d) => d.name === "S-배포후 구역"),
    "S2 다시 배포(업데이트) → 같은 링크·같은 통행증으로 새 스냅샷 반영(추가·이동·삭제·구역)", { same_link: repub.j && repub.j.project.share_path === sp, n: updPins.length });

  /* ══ C. 배포 취소 · 재배포 ══ */
  console.log("\n[C] 배포 취소 · 재배포 · 새 링크");
  const un = await api("POST", "/api/projects/" + PID + "/unpublish", null, sTok);
  const cV = await api("GET", "/v/" + tok);
  const cDep = await api("GET", "/tables/deployments/" + DEP, null, vt);
  const cDecks = await api("GET", "/api/projects/" + PID + "/decks", null, vt);
  const cShare = await api("GET", "/api/share/" + tok);
  const cR2 = await api("GET", "/api/r2/object/localseed/ga.pdf?t=" + encodeURIComponent(vt));
  ok(un.s === 200 && cV.s === 410 && cV.text.includes("배포가 중단된 링크입니다") && !cV.text.includes(PROJ_NAME) && !cV.text.includes("ga.pdf"),
    "C1 취소 → /v/<토큰> 410 '배포가 중단된 링크입니다'(프로젝트·데이터 0)", { s: cV.s });
  ok([cDep.s, cDecks.s, cR2.s].every((s) => s === 410) && !cDep.text.includes("pins") && cShare.s === 410,
    "C1b 이미 받은 통행증 = 410(배포본·구역·R2) · 공개 해석 410 — 데이터 0", { dep: cDep.s, decks: cDecks.s, r2: cR2.s, share: cShare.s });
  const keep = await api("GET", "/api/projects/" + PID + "/requests", null, sTok);
  ok((keep.j.data || []).some((n) => n.body === cBody), "C2 취소해도 열람자 코멘트 보존", keep.s);
  // 취소 중 디자이너가 또 고침 → 재배포 시 그 시점이 반영돼야 한다
  const supDep2 = (await api("GET", "/tables/deployments/" + DEP, null, sTok)).j;
  const work2 = (pinsOf(supDep2) || []).concat([{ id: Date.now() + 888, createdAt: Date.now(), x: 40, y: 85, page: 1, label: "C-NEW", imageId: "pano_localseed_1", author: sup.email }]);
  await api("PATCH", "/tables/deployments/" + DEP, { pins: JSON.stringify(work2), base_version: supDep2.version }, sTok);
  const rp = await api("POST", "/api/projects/" + PID + "/publish", null, sTok);
  const rV = await api("GET", "/v/" + tok);
  const ae2 = await api("POST", "/api/auth/auto-entry", { kind: "viewer", v: tok });
  const rDep = await api("GET", "/tables/deployments/" + DEP, null, ae2.j && ae2.j.token);
  ok(rp.s === 200 && rp.j.project.share_path === sp && rV.s === 200 && (pinsOf(rDep.j) || []).some((p) => p.label === "C-NEW"), "C3 재배포 → 같은 링크 200 + 최신 스냅샷(취소 중 편집 포함)", { rp: rp.s, v: rV.s, dep: rDep.s });

  /* ══ B. 브라우저 ══ */
  console.log("\n[B] 실 브라우저 — 열람 링크 세션");
  const profile = path.join(TMP, "p149-chrome-" + Date.now());
  chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", "--user-data-dir=" + profile, "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
  let port = 0;
  for (let i = 0; i < 80 && !port; i++) { try { port = parseInt(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0], 10); } catch (e) {} if (!port) await wait(150); }
  let pageWs = null;
  for (let i = 0; i < 40 && !pageWs; i++) { try { const l = await getJson("http://127.0.0.1:" + port + "/json/list"); const pg = l.find((t) => t.type === "page"); if (pg) pageWs = pg.webSocketDebuggerUrl; } catch (e) {} if (!pageWs) await wait(250); }
  const P = await connect(pageWs);
  await P.send("Page.enable"); await P.send("Runtime.enable"); await P.send("Network.enable");
  await P.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const reqLog = []; let loads = 0;
  P.listeners.push((m) => {
    if (m.method === "Network.requestWillBeSent") reqLog.push(m.params.request.method + " " + m.params.request.url.replace(BASE, ""));
    if (m.method === "Page.loadEventFired") loads++;
  });
  // 첫 페인트부터 허브 표시 여부 + 문서 로드 횟수(재로드 감지) — sessionStorage 에 누적(재로드에도 유지)
  await P.send("Page.addScriptToEvaluateOnNewDocument", { source: `(function(){ if(!/^\\/(v|srview)\\//.test(location.pathname)) return;
    try{ sessionStorage.setItem('__p149loads', String(+(sessionStorage.getItem('__p149loads')||0)+1)); }catch(e){}
    function chk(){ try{ var h=document.getElementById('screen-projects'); if(!h) return; var cs=getComputedStyle(h); if(cs.display!=='none' && h.getBoundingClientRect().height>0) sessionStorage.setItem('__p149hub','1'); }catch(e){} }
    new MutationObserver(chk).observe(document,{subtree:true,childList:true,attributes:true});
    (function loop(){ chk(); if(performance.now()<20000) requestAnimationFrame(loop); })(); })();` });

  // 이 기기에 남은 디자이너 작업본(dirty draft + 원본 PDF 바이트) — 열람 세션이 이걸 올리면 안 된다(PUT 403 → 배너 → Request Access 의 근본 경로)
  await P.send("Page.navigate", { url: BASE + "/manifest.webmanifest" });
  await P.waitFor("location.pathname === '/manifest.webmanifest'");
  const seeded = await P.ev(`new Promise(function(res){ var rq=indexedDB.open('wm_sync',5); rq.onupgradeneeded=function(){ var db=rq.result; ['sources','drafts','authlocal'].forEach(function(n){ if(!db.objectStoreNames.contains(n)) db.createObjectStore(n,{keyPath:'key'}); }); ['ops','origs'].forEach(function(n){ if(!db.objectStoreNames.contains(n)) db.createObjectStore(n,{keyPath:'opId'}); }); };
    rq.onsuccess=function(){ var db=rq.result; var tx=db.transaction(['drafts','sources'],'readwrite'); var enc=new TextEncoder().encode('%PDF-1.4\\n% p149 leftover\\n');
      tx.objectStore('sources').put({key:'p149src', bytes: enc.buffer, savedAt: Date.now()});
      tx.objectStore('drafts').put({key:'${PID}::dk_localseed_zoneA', data:{ dirty:true, fileName:'leftover.pdf', pages:['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='], pins:[], zones:[], annotations:[], srcKey:'p149src', depId:'${DEP}' }, savedAt: Date.now()});
      tx.oncomplete=function(){ res(true); }; tx.onerror=function(){ res(false); }; }; rq.onerror=function(){ res(false); }; })`);
  ok(seeded === true, "B0 준비 — 이 기기에 디자이너 dirty draft + 원본 PDF 바이트(IndexedDB wm_sync)");

  loads = 0; reqLog.length = 0;
  await P.send("Page.navigate", { url: BASE + legacyPath });
  const tLoad = await P.waitFor("window.__wm && __wm.State.pins && __wm.State.pins.length > 0 && !document.getElementById('map-viewport').classList.contains('hidden')", 40000);
  await wait(7000);   // SW 설치·claim(controllerchange) + 자동 동기화 타이머(1.5s) 이후까지 관찰
  const docLoads = await P.evS(`+(sessionStorage.getItem('__p149loads')||0)`);
  ok(tLoad >= 0 && loads === 1 && docLoads === 1, "B1 첫 로드 1회 — 재로드 0(서비스워커 첫 설치 controllerchange 무시)", { tLoad, loadEvents: loads, docLoads });
  const authN = reqLog.filter((r) => /\/api\/auth\/me|\/api\/share\//.test(r)).length;
  ok(authN <= 2, "B1b auth/me·share 요청 중복 0", { authN });
  const B = await P.ev(`(function(){ ${VIS}
    var txt=document.body.innerText, all=document.documentElement.textContent;
    var sel=['.tree-more','.tree-project-actions button','.side-tree-empty','#side-tree-make-deck-region','#side-tree-create-deck','#tb-pin-edit','#tb-setdir','#pin-grid-csv','#rpt-print-btn','#rpt-delivery-btn','#rpt-bundle-btn','#btn-deploy','.deck-del','#section-export','#section-upload','.tree-mode-leaf-checker','.pinfilter-chip.pf-checkboard','[data-act=delete]','#btn-back'];
    var editVis={}; sel.forEach(function(s){ var n=[].slice.call(document.querySelectorAll(s)).filter(vis).length; if(n) editVis[s]=n; });
    var hubEl=document.getElementById('screen-projects');
    return { path: location.pathname, href: decodeURIComponent(location.href), title: document.title, cls: document.documentElement.className,
      nameInTitle: document.title.indexOf(${JSON.stringify(PROJ_NAME)})>=0, nameInUrl: decodeURIComponent(location.href).indexOf('로컬')>=0,
      nameInText: txt.indexOf(${JSON.stringify(PROJ_NAME)})>=0, nameInDom: all.indexOf(${JSON.stringify(PROJ_NAME)})>=0,
      weareTitle: /We:are/.test(document.title), weareText: /We:are/.test(txt), idText: /auto\\.designer/.test(all) || /seastargo/.test((document.getElementById('access-gate-email')||{}).textContent||''),
      email: __wm.Auth.user && __wm.Auth.user.email, ro: __wm.Auth.readonly,
      hubSeen: sessionStorage.getItem('__p149hub'), hubActive: !!(hubEl && hubEl.classList.contains('active')), hubVis: vis(hubEl), cards: document.querySelectorAll('#hub-grid .hub-card').length,
      editVis: editVis, treeDecks: [].slice.call(document.querySelectorAll('.tree-node-deck,.tree-node-region')).filter(vis).length,
      chkPins: __wm.State.pins.filter(function(p){return p.checkboard}).length, pins: __wm.State.pins.length,
      gates: ['access-gate','login-gate','share-gate-modal'].filter(function(id){ var e=document.getElementById(id); return e && vis(e); }),
      keepFail: !!document.getElementById('src-keep-fail'), unsavedTags: [].slice.call(document.querySelectorAll('.tree-tag-unsaved,.deck-unsaved-tag')).filter(vis).length,
      syncPending: (function(){ var b=document.getElementById('net-badge'); return !!(b && vis(b) && /동기화|업로드|대기/.test(b.textContent||'')); })(), drawEntry: [].slice.call(document.querySelectorAll('[data-req-viewer-entry]')).filter(vis).length }; })()`);
  await shot(P, "viewer-first");
  ok(B.path === "/v/" + tok && !B.nameInUrl, "B2 구 /srview/<이름>-<토큰> → /v/<토큰> 으로 replace(주소창 이름 0)", { path: B.path });
  ok(!B.nameInTitle && !B.nameInText && !B.nameInDom && !B.weareTitle && !B.weareText && !B.idText && B.email === "" && B.ro === true,
    "B3 제목·URL·DOM 에 프로젝트명·We:are·예약계정 0 · 세션 이메일 빈값", { title: B.title, nameInDom: B.nameInDom, weare: B.weareText, id: B.idText, email: B.email });
  ok(!B.hubSeen && !B.hubActive && !B.hubVis && B.cards === 0, "B4 허브(프로젝트 선택) — 첫 페인트부터 한 번도 안 보임 · 카드 0", { hubSeen: B.hubSeen, active: B.hubActive, cards: B.cards });
  ok(Object.keys(B.editVis).length === 0, "B5 편집·관리·내보내기 UI 0(⋯·정보·다운로드·삭제·구역 만들기·도구·CSV/보고서/zip·CHECKER 잎)", B.editVis);
  ok(B.treeDecks >= 2, "B5b 구역 트리(배포 시점 동결본) 읽기 전용 탐색 노드 표시", { treeDecks: B.treeDecks });
  ok(B.chkPins === 0 && B.pins > 0, "B6 CHECKER 핀 0(360 핀만)", { chk: B.chkPins, pins: B.pins });
  const puts = reqLog.filter((r) => /^PUT \/api\/r2\/upload/.test(r)).length;
  ok(B.gates.length === 0 && !B.keepFail && puts === 0, "B7 남은 디자이너 draft 가 있어도 업로드 0 · '원본 PDF 보관 실패' 배너 0 · 로그인/Request Access 게이트 0", { gates: B.gates, keepFail: B.keepFail, puts });
  ok(B.unsavedTags === 0 && !B.syncPending, "B7c 이 기기 작업본의 '미저장' 표시·'동기화 중' 배지 0(열람 세션은 동기화 주체가 아님)", { unsaved: B.unsavedTags, sync: B.syncPending });
  ok(!reqLog.some((r) => /\/bands/.test(r)), "B7b 번호 대역(/bands) 호출 0(403 2회 제거)", reqLog.filter((r) => /bands/.test(r)));

  // 우클릭 = 편집 항목 0
  const nodeR = await P.ev(`(function(){ ${VIS} var n=[].slice.call(document.querySelectorAll('.tree-node-deck')).filter(vis)[0]; if(!n) return null; var r=n.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  let ctx = null;
  if (nodeR) {
    await click(P, nodeR.x, nodeR.y, "right"); await wait(300);
    ctx = await P.ev(`(function(){ ${VIS} var items=[].slice.call(document.querySelectorAll('.tree-pop-item')).filter(vis); return items.map(function(b){ return (b.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40); }); })()`);
    await P.evS(`__wm.UI && __wm.UI.closeTreeMenu && __wm.UI.closeTreeMenu(); 1`);
  }
  ok(!!nodeR && Array.isArray(ctx) && !ctx.some((l) => /삭제|이름 ?변경|교체|등록|개정|지정|만들|추가|이동|복사|붙여/.test(l)), "B8 트리 우클릭 메뉴 = 편집 항목 0(보기 항목만)", ctx);

  // 허브로 가는 모든 경로: 뒤로가기 · 로고 클릭 · ProjectHub.open() 직접
  await click(P, 900, 500); await wait(400);   // 사용자 활성화(BackGuard 가드 설치)
  const hist = await P.send("Page.getNavigationHistory");
  if (hist.currentIndex > 0) { await P.send("Page.navigateToHistoryEntry", { entryId: hist.entries[hist.currentIndex - 1].id }); await wait(1200); }
  await P.evS(`(function(){ var c=document.getElementById('wm-confirm-cancel'); if(c && document.querySelector('#wm-confirm-modal.on')) c.click(); return 1; })()`);
  const logo = await P.ev(`(function(){ var e=document.getElementById('brand-logo-top'); if(!e) return null; var r=e.getBoundingClientRect(); return r.width?{x:r.left+r.width/2,y:r.top+r.height/2}:null; })()`);
  if (logo) { await click(P, logo.x, logo.y); await wait(600); }
  await P.evS(`__wm.ProjectHub.open(); 1`); await wait(800);
  const H = await P.ev(`(function(){ ${VIS} var h=document.getElementById('screen-projects'); return { path: location.pathname, active: h.classList.contains('active'), vis: vis(h), seen: sessionStorage.getItem('__p149hub'), app: document.getElementById('screen-app').classList.contains('active'), cards: document.querySelectorAll('#hub-grid .hub-card').length }; })()`);
  ok(H.path === "/v/" + tok && !H.active && !H.vis && !H.seen && H.app && H.cards === 0, "B9 뒤로가기·로고 클릭·ProjectHub.open() 후에도 허브 DOM 0 · 열람 화면 유지", H);
  await shot(P, "after-back-logo");

  // 사진 밖 요청 = 진입점 0(안내) · 사진 안 요청 = 사진 유지 + 사진·방향 저장
  const outside = await P.ev(`(function(){ __wm.Requests.openViewer({}); return !!document.querySelector('[data-req-viewer]'); })()`);
  ok(outside === false && B.drawEntry === 0, "B10 사진 밖(도면 화면) 요청·질문 진입 0 — 도면 플로팅 버튼 0 · 다른 진입점은 '사진을 열어 주세요' 안내", { panel: outside, drawEntry: B.drawEntry });
  await P.ev(`(function(){ var p=__wm.State.pins.find(function(x){return x.imageId==='pano_localseed_1'}) || __wm.State.pins.find(function(x){return x.imageId}); __wm.App.openPano(p); return 1; })()`);
  const panoT = await P.waitFor(`__wm.PanoViewer.open && document.getElementById('pano-loading').classList.contains('hidden')`, 20000);
  await wait(1500);   // 360 진입 전환(Dive) 종료 대기
  await P.ev(`(function(){ Object.assign(__wm.PanoViewer.S,{lon:211.25,lat:-17.5}); __wm.PanoViewer._invalidate && __wm.PanoViewer._invalidate(); return 1; })()`);
  const entry = await P.ev(`(function(){ ${VIS} var b=document.querySelector('[data-req-pano-entry]'); if(!b||!vis(b)) return null; var r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  console.log("    (진단 B11) " + JSON.stringify(await P.evS(`({ view: __wm.Requests.panoView(), guest: __wm.Requests._isGuest(), dep: __wm.State.currentDeploymentId, top: (function(){ var b=document.querySelector('[data-req-pano-entry]'); if(!b) return null; var r=b.getBoundingClientRect(); var t=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2); return t ? (t.id||t.className||t.tagName) : null; })() })`)));
  if (entry) { await click(P, entry.x, entry.y); await wait(500); }
  const pBody = "p149 사진 안 요청 " + Date.now();
  const sent = await P.ev(`(async function(){ var pn=document.querySelector('[data-req-viewer]'); if(!pn) return {panel:false};
    var ta=pn.parentNode.querySelector('[data-req-body]'); ta.value=${JSON.stringify(pBody)};
    var n0=__wm.PanoViewer.open; pn.parentNode.querySelector('[data-req-send]').click();
    for(var i=0;i<60;i++){ await new Promise(function(r){setTimeout(r,150)}); if([].slice.call(document.querySelectorAll('[data-req-item]')).some(function(c){return c.textContent.indexOf(${JSON.stringify(pBody)})>=0})) break; }
    return { panel:true, listed:[].slice.call(document.querySelectorAll('[data-req-item]')).some(function(c){return c.textContent.indexOf(${JSON.stringify(pBody)})>=0}), panoOpenBefore:n0, panoOpenAfter: __wm.PanoViewer.open,
      shot: (__wm.TimeLapse.currentShot()||{}).imageId || null }; })()`, 30000);
  await shot(P, "pano-request");
  ok(panoT >= 0 && !!entry && sent.panel && sent.listed && sent.panoOpenAfter === true, "B11 사진 열린 상태에서 [요청·질문] → 작성 성공(목록 표시) · 사진 유지", { panoT, entry: !!entry, sent });
  const inbox2 = await api("GET", "/api/projects/" + PID + "/requests", null, sTok);
  const pn = (inbox2.j.data || []).find((n) => n.body === pBody);
  ok(!!pn && pn.pano_view && pn.pano_view.image_id === sent.shot && Math.abs(pn.pano_view.yaw - 211.25) < 0.05 && Math.abs(pn.pano_view.pitch + 17.5) < 0.05,
    "B12 저장된 사진 id·방향 = 작성 당시 사진(타임랩스 현재 시점)·카메라 방향", pn && { pano_view: pn.pano_view, shot: sent.shot });

  // Request Access Phone 칸 — 다른 칸과 같은 배경 · 대비 ≥ 4.5
  const ph = await P.ev(`(function(){ var g=document.getElementById('access-gate'); g.classList.remove('hidden'); g.classList.add('on');
    function rgb(s){ var m=String(s).match(/[\\d.]+/g)||[0,0,0,1]; return [+m[0],+m[1],+m[2],m.length>3?+m[3]:1]; }
    function bgOf(e){ var stack=[]; while(e){ var c=rgb(getComputedStyle(e).backgroundColor); if(c[3]>0) stack.push(c); if(c[3]>=1) break; e=e.parentElement; } var out=[255,255,255]; for(var i=stack.length-1;i>=0;i--){ var c=stack[i]; out=[c[0]*c[3]+out[0]*(1-c[3]),c[1]*c[3]+out[1]*(1-c[3]),c[2]*c[3]+out[2]*(1-c[3])]; } return out; }
    function lum(c){ function ch(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)} return 0.2126*ch(c[0])+0.7152*ch(c[1])+0.0722*ch(c[2]); }
    function cr(a,b){ var x=lum(a),y=lum(b); return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05); }
    var p=document.getElementById('ar-phone'), c=document.getElementById('ar-company');
    var r={ phoneBg:getComputedStyle(p).backgroundColor, companyBg:getComputedStyle(c).backgroundColor, phoneCr: Math.round(cr(rgb(getComputedStyle(p).color), bgOf(p))*100)/100 };
    g.classList.remove('on'); g.classList.add('hidden'); return r; })()`);
  ok(ph.phoneBg === ph.companyBg && ph.phoneCr >= 4.5, "B13 Request Access Phone 칸 배경 = 다른 칸 · 글자 대비 ≥ 4.5", ph);

  // 디자이너 요청함 → 같은 사진·같은 방향
  const P2tab = await new Promise((res) => { const rq = http.request("http://127.0.0.1:" + port + "/json/new?about:blank", { method: "PUT" }, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { res(null); } }); }); rq.on("error", () => res(null)); rq.end(); });
  let D = null;
  if (P2tab && P2tab.webSocketDebuggerUrl) {
    D = await connect(P2tab.webSocketDebuggerUrl);
    await D.send("Page.enable"); await D.send("Runtime.enable");
    await D.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await D.send("Page.navigate", { url: BASE + "/manifest.webmanifest" });
    await D.waitFor("location.pathname === '/manifest.webmanifest'");
    await D.ev(`sessionStorage.clear(); localStorage.setItem("wm_local_token", ${JSON.stringify(sTok)}); 1`);
    await D.send("Page.navigate", { url: BASE + "/" });
    await D.waitFor("window.__wm && __wm.ProjectHub && __wm.ProjectHub.list && __wm.ProjectHub.list.some(function(p){return p.id==='" + PID + "'})", 30000);
    await D.ev(`(async function(){ var p=__wm.ProjectHub.list.find(function(x){return x.id==='${PID}'}); await __wm.ProjectHub.openProject(p); return 1; })()`, 30000);
    await D.waitFor(`__wm.State.pins && __wm.State.pins.some(function(p){return String(p.id)===${JSON.stringify(String(pn ? pn.pin_id : ""))}})`, 30000);
    const gone = await D.ev(`(async function(){ var r=await fetch('/api/projects/${PID}/requests',{headers:__wm.Auth.headers()}); var j=await r.json(); var n=(j.data||[]).find(function(x){return x.body===${JSON.stringify(pBody)}}); if(!n) return {found:false};
      var ok=await __wm.Requests.goTo(n); var shot=(__wm.TimeLapse.currentShot()||{}).imageId||null;
      return { found:true, ok:ok, open:__wm.PanoViewer.open, lon:__wm.PanoViewer.S.lon, lat:__wm.PanoViewer.S.lat, shot:shot, want:n.pano_view }; })()`, 40000);
    await shot(D, "designer-goto");
    ok(gone.found && gone.ok === true && gone.open && Math.abs(((gone.lon % 360) + 360) % 360 - 211.25) < 0.1 && Math.abs(gone.lat + 17.5) < 0.1 && gone.shot === gone.want.image_id,
      "B14 디자이너 요청함 → 그 사진·그 방향으로 360 열림", gone);
  } else ok(false, "B14 디자이너 탭 열기 실패");

  // 배포 취소 → 열려 있던 열람 화면 [최신 배포본 다시 불러오기] = 중단 화면(데이터 0)
  await P.evS(`__wm.Requests.closePanel(); __wm.PanoViewer.close(); 1`); await wait(600);
  const un2 = await api("POST", "/api/projects/" + PID + "/unpublish", null, sTok);
  await P.evS(`document.getElementById('btn-reload-deploy').click(); 1`);
  const wd = await P.waitFor(`document.getElementById('view-withdrawn')`, 15000);
  const W = await P.ev(`(function(){ ${VIS} return { overlay: vis(document.getElementById('view-withdrawn')), text: (document.getElementById('view-withdrawn')||{}).textContent||'', pins: __wm.State.pins.length, decks: (__wm.Projects.decks||[]).length }; })()`);
  await shot(P, "withdrawn");
  ok(un2.s === 200 && wd >= 0 && W.overlay && /배포가 중단된 링크입니다/.test(W.text) && W.pins === 0 && W.decks === 0, "C4 배포 취소 후 열린 화면 [다시 불러오기] → '배포가 중단된 링크입니다' · 핀·트리 0", W);
  await P.send("Page.navigate", { url: BASE + "/v/" + tok });
  await wait(1500);
  const W2 = await P.ev(`({ t: document.body.innerText, wm: !!window.__wm })`);
  ok(/배포가 중단된 링크입니다/.test(W2.t) && !W2.wm && !W2.t.includes(PROJ_NAME), "C4b 취소된 링크 새로 열기 = 410 화면(앱·데이터 로드 0)", { wm: W2.wm });
  const rp2 = await api("POST", "/api/projects/" + PID + "/publish", null, sTok);
  const rot = await api("POST", "/api/projects/" + PID + "/share-token/rotate", null, sTok);
  const oldV = await api("GET", "/v/" + tok);
  const newV = await api("GET", rot.j && rot.j.share_path);
  ok(rp2.s === 200 && rot.s === 200 && rot.j.share_path !== sp && oldV.s === 404 && newV.s === 200, "C5 새 링크 발급(선택) → 옛 링크 404 · 새 링크 200", { old: oldV.s, neu: newV.s });

  ok(P.errs.length === 0, "앱 콘솔 예외 0(열람 탭)", P.errs);
} catch (e) {
  console.log("FAIL 예외: " + (e && e.stack || e));
  failed++;
} finally {
  clearTimeout(watchdog);
  await cleanup();
}
console.log("\n" + (failed ? "FAIL " + failed : "ALL PASS") + " — 산출물 " + OUT);
process.exit(failed ? 1 : 0);
