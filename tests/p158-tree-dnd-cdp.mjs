/**
 * p158-cdp — 트리 구역 "끌어서 순서·위치 바꾸기"(WO 20261016-treednd) 실 포인터 드래그 CDP.
 *   p158-tree-dnd.test.mjs 는 순수 함수(vm)·실 워커+Miniflare(API) 만 검사한다 — 실제 마우스
 *   pointerdown→move→up 입력으로 64_TreeDnD.js 의 전체 경로(attach→_beginDrag→_onDragMove→
 *   _onDrop→_applyMove→PATCH /api/decks/:id/move)를 실 Chrome 으로 재현한다(목 0).
 *
 * 시나리오: 형제 구역 B 를 A 뒤(after)로 실제 드래그 → 즉시 반영 → 새로고침 후에도 순서 유지.
 * 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p158-tree-dnd-cdp.mjs
 *   뮤테이션: P158CDP_MUT=cycle → 격리 사본만 고쳐 빌드, EXIT=1 이어야 한다(§G-2-5, 지휘자 수행).
 * 사전: .tmp/localdev-state (node build-tools/local-dev.mjs && node build-tools/seed-local.mjs)
 */
import { execSync, spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = path.join(ROOT, ".tmp");
const MUT = process.env.P158CDP_MUT || "";
const OUT = path.join(TMP, "p158cdp" + (MUT ? "-mut-" + MUT : ""));
const WORK = path.join(OUT, "work");
const STATE_SRC = path.join(TMP, "localdev-state");
const STATE = path.join(OUT, "state");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const NM = path.join(ROOT, "node_modules");
const PID = "proj_localseed";
let failed = 0;
const ok = (c, label, d) => { console.log((c ? "  PASS " : "  FAIL ") + label + (d != null ? " :: " + JSON.stringify(d).slice(0, 500) : "")); if (!c) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
if (!fs.existsSync(STATE_SRC)) { console.log("FAIL .tmp/localdev-state 없음"); process.exit(2); }
if (!fs.existsSync(CHROME)) { console.log("FAIL Chrome 없음: " + CHROME); process.exit(2); }
const watchdog = setTimeout(() => { console.log("\nWATCHDOG — 180s 초과 → FAIL"); process.exit(1); }, 180000);

/* ── 뮤테이션(격리 사본만) — 이 CDP 테스트가 실제로 거치는 경로(실 드래그→_applyMove→PATCH)
 *   위에 있어야 한다(순환검사 뮤테이션은 p158-tree-dnd.test.mjs Part B 가 API 레벨로 이미 맡는다 —
 *   이 시나리오의 드래그는 형제 재배치뿐이라 순환검사를 지나지 않는다, 실측 확인). ── */
const MUTS = {
  // 드롭 시 서버 PATCH 호출 메서드를 깨면(PATCH→GET) 라우트가 받지 않아 실제 드래그가 화면상
  // 끝나도 서버에는 반영되지 않는다 — "드롭→즉시 반영"을 검증하는 ③·④가 바로 잡아낸다.
  nopersist: ["public/js/modules/64_TreeDnD.js", 'method: "PATCH",\n          headers: Object.assign({ "Content-Type": "application/json" }, (typeof Auth !== "undefined" && Auth.headers) ? Auth.headers() : {}),\n          body: JSON.stringify({ parent_id: target.parent_id, index: target.index })', 'method: "GET"'],
};
if (MUT && !MUTS[MUT]) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }

// ── 격리 빌드(작업트리 모듈 → WORK, 메인 트리 파일 0 터치) ──
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
if (!man.includes("64_TreeDnD.js")) { console.log("FAIL _manifest.txt 에 64_TreeDnD.js 없음"); process.exit(2); }
fs.writeFileSync(path.join(WORK, "public/js/main.js"), man.map((f) => fs.readFileSync(path.join(WORK, "public/js/modules", f), "utf8")).join("\n"));
const env = { ...process.env, TEMP: TMP, TMP: TMP };
execSync(`node --max-old-space-size=640 "${path.join(NM, "vite/bin/vite.js")}" build`, { cwd: WORK, env, stdio: "pipe" });
fs.rmSync(STATE, { recursive: true, force: true });
fs.cpSync(STATE_SRC, STATE, { recursive: true });
const wr = (args) => execSync(`node "${path.join(NM, "wrangler/bin/wrangler.js")}" ${args}`, { cwd: WORK, env, stdio: "pipe" });
for (const mf of fs.readdirSync(path.join(WORK, "migrations")).filter((f) => /^\d+_.*\.sql$/.test(f) && f >= "0042")) {
  try { wr(`d1 execute webapp-production --local --persist-to "${STATE}" --file "migrations/${mf}"`); } catch (e) {}
}

const PORT = process.env.P158CDP_PORT || "18859";
const wrangler = spawn("node", [path.join(NM, "wrangler/bin/wrangler.js"), "pages", "dev", "dist", "--d1=webapp-production", "--local", "--persist-to", STATE, "--ip", "127.0.0.1", "--port", PORT],
  { cwd: WORK, env, stdio: ["ignore", "pipe", "pipe"] });
let wlog = ""; wrangler.stdout.on("data", (d) => (wlog += d)); wrangler.stderr.on("data", (d) => (wlog += d));
const BASE = "http://127.0.0.1:" + PORT;
let chrome = null; const sockets = [];
async function cleanup() { sockets.forEach((s) => { try { s.close(); } catch (e) {} }); try { chrome && chrome.kill(); } catch (e) {} try { wrangler.kill(); } catch (e) {} }

async function api(method, url, body, tok) {
  const r = await fetch(BASE + url, { method, headers: Object.assign({ "Content-Type": "application/json" }, tok ? { Authorization: "Bearer " + tok } : {}), body: body == null ? undefined : JSON.stringify(body) });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) {}
  return { s: r.status, j, text };
}
const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej));
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 }); sockets.push(ws);
  await new Promise((r) => ws.on("open", r));
  let idc = 0; const pend = new Map(); const errs = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
    if (m.method === "Runtime.exceptionThrown") errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300));
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++idc; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr, ms) => { const r = await Promise.race([send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }), wait(ms || 20000).then(() => { throw new Error("evaluate 무응답"); })]); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
  const evS = async (e) => { try { return await ev(e, 10000); } catch (x) { return { __err: String(x.message).slice(0, 200) }; } };
  const waitFor = async (cond, t = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if ((await evS("(function(){try{return !!(" + cond + ")}catch(e){return false}})()")) === true) return Date.now() - t0; await wait(120); } return -1; };
  return { ws, send, ev, evS, waitFor, errs };
}
async function mouseStep(P, type, x, y, buttons) {
  await P.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: buttons || 0, clickCount: 1 });
}
let shotN = 0;
async function shot(P, name) { const s = await P.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, String(++shotN).padStart(2, "0") + "-" + name + ".png"), Buffer.from(s.data, "base64")); }

try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { const r = await fetch(BASE + "/manifest.webmanifest"); up = !!r.status; } catch (e) {} if (!up) await wait(500); }
  if (!up) { console.log("FAIL wrangler 기동 실패\n" + wlog.slice(-1500)); process.exit(1); }

  const acc = JSON.parse(fs.readFileSync(path.join(TMP, "local-test-accounts.json"), "utf8")).accounts;
  const sup = acc.find((a) => a.role === "super");
  const sTok = (await api("POST", "/api/signup/login", { email: sup.email, password: sup.password })).j.token;
  ok(!!sTok, "준비 — 로컬 super 로그인");

  // 이 테스트 전용 구역 3개(형제, 같은 부모 null, 순서대로 생성 A→M→B) — 기존 시드를 건드리지 않는다.
  // 🔴 A·B 만 만들면 created_at 폴백 정렬상 이미 서로 인접해 "드래그 없이도 통과"하는 거짓양성이
  //   생긴다(1차 작성에서 실측) — 사이에 M 을 둬서 실제 드래그가 있어야만 B가 A 다음으로 온다.
  const now = Date.now();
  const mkDeck = async (name) => (await api("POST", "/api/projects/" + PID + "/decks", { name }, sTok)).j;
  const dA = await mkDeck("p158cdp-A-" + now);
  const dM = await mkDeck("p158cdp-M-" + now);
  const dB = await mkDeck("p158cdp-B-" + now);
  ok(!!(dA && dA.id) && !!(dM && dM.id) && !!(dB && dB.id), "준비 — 형제 구역 A·M·B 생성(순서대로)", { a: dA && dA.id, m: dM && dM.id, b: dB && dB.id });
  const initRoots = (await api("GET", "/api/projects/" + PID + "/decks", null, sTok)).j.data.filter((d) => d.parent_id == null);
  const i0A = initRoots.findIndex((d) => d.id === dA.id), i0M = initRoots.findIndex((d) => d.id === dM.id), i0B = initRoots.findIndex((d) => d.id === dB.id);
  ok(i0A >= 0 && i0M === i0A + 1 && i0B === i0M + 1, "준비 — 생성 직후 기본 순서 = A,M,B(드래그 전 B 는 A 와 인접하지 않음)", { i0A, i0M, i0B });

  const profile = path.join(TMP, "p158cdp-chrome-" + Date.now());
  chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", "--user-data-dir=" + profile, "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
  let port = 0;
  for (let i = 0; i < 80 && !port; i++) { try { port = parseInt(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0], 10); } catch (e) {} if (!port) await wait(150); }
  let pageWs = null;
  for (let i = 0; i < 40 && !pageWs; i++) { try { const l = await getJson("http://127.0.0.1:" + port + "/json/list"); const pg = l.find((t) => t.type === "page"); if (pg) pageWs = pg.webSocketDebuggerUrl; } catch (e) {} if (!pageWs) await wait(250); }
  const P = await connect(pageWs);
  await P.send("Page.enable"); await P.send("Runtime.enable");
  await P.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  await P.send("Page.navigate", { url: BASE + "/manifest.webmanifest" });
  await P.waitFor("location.pathname === '/manifest.webmanifest'");
  await P.ev(`localStorage.setItem("wm_local_token", ${JSON.stringify(sTok)}); 1`);
  await P.send("Page.navigate", { url: BASE + "/" });
  const entered = await P.waitFor(`window.__wm && __wm.ProjectHub && __wm.ProjectHub.list && __wm.ProjectHub.list.some(function(p){return p.id==='${PID}'})`, 30000);
  ok(entered >= 0, "준비 — 허브 로드");
  await P.ev(`(async function(){ var p=__wm.ProjectHub.list.find(function(x){return x.id==='${PID}'}); await __wm.ProjectHub.openProject(p); return 1; })()`, 30000);
  await P.waitFor(`document.getElementById('side-tree')`, 20000);
  await wait(1500);

  const findHead = (name) => `(function(){ var hs=Array.from(document.querySelectorAll('.tree-node-deck,.tree-node-region')); return hs.find(function(h){ var l=h.querySelector('.tree-label'); return l && l.textContent.trim()===${JSON.stringify(name)}; }); })()`;
  const domOrder = () => P.evS(`(function(){ var hs=Array.from(document.querySelectorAll('[data-deck-id]')); return hs.map(function(h){ var l=h.querySelector('.tree-label'); return l?l.textContent.trim():'?'; }); })()`);
  const foundAll = await P.waitFor(`${findHead(dA.name)} != null && ${findHead(dM.name)} != null && ${findHead(dB.name)} != null`, 15000);
  ok(foundAll >= 0, "① 트리에 구역 A·M·B 가 렌더됨");

  const beforeOrder = await domOrder();
  console.log("    (진단) 드래그 전 DOM 순서: " + JSON.stringify(beforeOrder));

  // B·M 은 생성 순서상 서로 인접하므로 B 를 뷰포트로 스크롤하면 M 도 함께 보인다(스크롤 1회).
  const rects = await P.ev(`(function(){
    var hb=${findHead(dB.name)}; hb.scrollIntoView({block:'center'});
    var ha=${findHead(dA.name)}, hm=${findHead(dM.name)};
    function R(h){ var r=h.getBoundingClientRect(); return {cx:r.left+r.width/2, cy:r.top+r.height/2, top:r.top, bottom:r.bottom, h:r.height}; }
    return { a: ha?R(ha):null, m: hm?R(hm):null, b: hb?R(hb):null };
  })()`);
  ok(!!(rects.a && rects.m && rects.b && rects.a.h > 0 && rects.m.h > 0 && rects.b.h > 0), "준비 — A·M·B 가 한 화면에 실제 크기로 보임(스크롤 1회)", rects);
  const rM = rects.m, rB = rects.b;

  /* ══ ② 실제 포인터 드래그 — B 를 M 의 위쪽(before) 1/4 지점으로(= A 바로 다음) ══ */
  console.log("\n[②] 실제 pointerdown→move→up 드래그 — B → M 바로 위(= A 다음)");
  await mouseStep(P, "mouseMoved", rB.cx, rB.cy, 0);
  await wait(80);
  await mouseStep(P, "mousePressed", rB.cx, rB.cy, 1);
  await wait(150);
  // 임계값(6px) 넘겨 드래그 시작 인식 — 중간 지점을 여러 번 거쳐 실 드래그처럼 이동
  const targetY = rM.top + 4; // M 의 위쪽 1/4 지점 = before
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = rB.cx + (rM.cx - rB.cx) * t;
    const y = rB.cy + (targetY - rB.cy) * t;
    await mouseStep(P, "mouseMoved", x, y, 1);
    await wait(90);
  }
  const dragging1 = await P.evS(`document.body.classList.contains('tree-dnd-active') || !!(window.TreeDnD && window.TreeDnD._session)`);
  ok(dragging1 === true, "②a 6px 이상 이동 → 드래그 시작(body.tree-dnd-active)");

  await mouseStep(P, "mouseMoved", rM.cx, targetY, 1);
  await wait(400);
  const indicatorChk = await P.evS(`(function(){ var el=document.querySelector('.tree-dnd-indicator'); if(!el) return null; return { display: el.style.display, invalid: el.classList.contains('tree-dnd-invalid'), cls: el.className }; })()`);
  ok(indicatorChk && indicatorChk.display === "block" && !indicatorChk.invalid, "②b M 위에 드롭 표시기(유효) 렌더", indicatorChk);
  await shot(P, "dragging-over-M");

  await mouseStep(P, "mouseReleased", rM.cx, targetY, 0);
  await wait(800);
  const dragging2 = await P.evS(`document.body.classList.contains('tree-dnd-active')`);
  ok(dragging2 === false, "②c 드롭 후 드래그 세션 종료");

  /* ══ ③ 즉시 반영 — 순서가 A, B, M 으로(드래그 없인 절대 A,M,B 순서를 못 바꾼다) ══ */
  const roots3 = (await api("GET", "/api/projects/" + PID + "/decks", null, sTok)).j.data.filter((d) => d.parent_id == null);
  const idxA = roots3.findIndex((d) => d.id === dA.id), idxM = roots3.findIndex((d) => d.id === dM.id), idxB = roots3.findIndex((d) => d.id === dB.id);
  ok(idxA >= 0 && idxB === idxA + 1 && idxM === idxB + 1, "③ 서버 순서 — 드래그로 B 가 A 와 M 사이로 즉시 반영(A,B,M)", { idxA, idxB, idxM });

  /* ══ ④ 새로고침 후에도 유지 ══ */
  console.log("\n[④] 새로고침 후에도 순서 유지");
  await P.send("Page.navigate", { url: BASE + "/" });
  await P.waitFor(`window.__wm && __wm.ProjectHub && __wm.ProjectHub.list && __wm.ProjectHub.list.some(function(p){return p.id==='${PID}'})`, 20000);
  await P.ev(`(async function(){ var p=__wm.ProjectHub.list.find(function(x){return x.id==='${PID}'}); await __wm.ProjectHub.openProject(p); return 1; })()`, 30000);
  await P.waitFor(`${findHead(dA.name)} != null && ${findHead(dB.name)} != null`, 15000);
  const afterReload = await domOrder();
  const ia = afterReload.indexOf(dA.name), ib = afterReload.indexOf(dB.name), im = afterReload.indexOf(dM.name);
  ok(ia >= 0 && ib === ia + 1 && im === ib + 1, "④ 새로고침 후에도 A,B,M 순서 유지(DOM)", { order: afterReload, ia, ib, im });

  ok(P.errs.length === 0, "콘솔 예외 0건", P.errs);
} catch (e) {
  console.log("FAIL 예외: " + (e && e.stack || e));
  failed++;
} finally {
  clearTimeout(watchdog);
  await cleanup();
}
console.log("\n" + (failed ? "FAIL " + failed : "ALL PASS") + " — 산출물 " + OUT);
process.exit(failed ? 1 : 0);
