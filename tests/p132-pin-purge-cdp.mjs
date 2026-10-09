/**
 * p132-cdp — WO 20261008-pinpurge 실 Chrome 실측(목 0): 프로젝트 모든 핀 삭제 → 되돌리기.
 *   디자이너(멤버) = 트리 원본 ⋯ · 전체 기능 메뉴에서 비활성 + "소유자·관리자 전용" / 오프라인 = "온라인에서만"
 *   소유자(super) = ① 미리보기(서버 집계와 같은 문구) → ② 이름 불일치 0건 → ② 이름 입력 → ③ 본인 확인(로컬 비밀번호)
 *   → 메인 + 벡터 복사 구역 배포본 전부 tombstone → 하단 바 [되돌리기] → 복원 수 = 삭제 수. 바 글자·버튼 대비(getComputedStyle).
 * 실행: P132=1 TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p132-pin-purge-cdp.mjs   (P132 != "1" 이면 SKIP)
 * 사전: .tmp/localdev-state (node build-tools/local-dev.mjs && node build-tools/seed-local.mjs) — 사본(.tmp/fixdelall/state)만 쓴다.
 *   사본에 마이그레이션 0039 적용 + 벡터 복사 구역(별도 배포본, CHECKER 2) 1개를 추가한다.
 * 스크린샷: .tmp/fixdelall/*.png (375 · 1280)
 */
import { execSync, spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { fileURLToPath } from "node:url";
import { FIND_SEED_ORIGIN } from "./_lib/seed-origin.mjs";   // [2026-10-10] 시드 카드 스코프(누적 D1 의 빈 프로젝트 오클릭 방지)

if (process.env.P132 !== "1") { console.log("[SKIP] p132-cdp 는 P132=1 일 때만 실행"); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = path.join(ROOT, ".tmp");
const OUT = path.join(TMP, "fixdelall");
const WORK = path.join(OUT, "work");
const STATE_SRC = path.join(TMP, "localdev-state");
const STATE = path.join(OUT, "state");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const NODE_MODULES = path.join(ROOT, "node_modules");
const PID = "proj_localseed", VEC = "dep_fixdelall_vec";
let failed = 0;
const ok = (c, label, d) => { console.log((c ? "  PASS " : "  FAIL ") + label + (d != null && !c ? " :: " + JSON.stringify(d).slice(0, 400) : "")); if (!c) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
if (!fs.existsSync(STATE_SRC)) { console.log("FAIL .tmp/localdev-state 없음"); process.exit(2); }
if (!fs.existsSync(CHROME)) { console.log("FAIL Chrome 없음"); process.exit(2); }

// ── ① 격리 빌드(작업트리 소스 → WORK) + 상태 사본 ──
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
for (const f of ["public", "src", "migrations"]) fs.cpSync(path.join(ROOT, f), path.join(WORK, f), { recursive: true, filter: (s) => !/[\\/]public[\\/]js[\\/]main\.js$/.test(s) });
for (const f of ["vite.config.ts", "package.json", "tsconfig.json", "wrangler.jsonc"]) fs.copyFileSync(path.join(ROOT, f), path.join(WORK, f));
const man = fs.readFileSync(path.join(WORK, "public/js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
fs.writeFileSync(path.join(WORK, "public/js/main.js"), man.map((f) => fs.readFileSync(path.join(WORK, "public/js/modules", f), "utf8")).join("\n"));
const env = { ...process.env, TEMP: TMP, TMP: TMP };
execSync(`node --max-old-space-size=640 "${path.join(NODE_MODULES, "vite/bin/vite.js")}" build`, { cwd: WORK, env, stdio: "inherit" });
fs.rmSync(STATE, { recursive: true, force: true });
fs.cpSync(STATE_SRC, STATE, { recursive: true });
const d1 = (file) => execSync(`node "${path.join(NODE_MODULES, "wrangler/bin/wrangler.js")}" d1 execute webapp-production --local --persist-to "${STATE}" --file "${file}"`, { cwd: WORK, env, stdio: "pipe" });
d1(path.join(WORK, "migrations/0039_pin_bulk_deletes.sql"));
{
  const now = Date.now();
  const vecPins = JSON.stringify([{ id: 9001, x: 20, y: 30, page: 1, label: "1", checkboard: true }, { id: 9002, x: 40, y: 30, page: 1, label: "2", checkboard: true }]);
  const sql = path.join(OUT, "_vec.sql");
  fs.writeFileSync(sql,
    `INSERT OR REPLACE INTO deployments (id, title, file_name, pages_data, pins, zones, annotations, created_at, updated_at, deleted, tenant_id, version, project_id) ` +
    `SELECT '${VEC}', 'C구역(벡터 복사)', 'c.png', pages_data, '${vecPins}', '[]', '[]', ${now}, ${now}, 0, 'tnt_default', 0, '${PID}' FROM deployments WHERE id = 'dep_localseed_original';\n` +
    `INSERT OR REPLACE INTO decks (id, project_id, name, deployment_id, page, parent_id, created_at, updated_at, deleted) VALUES ('dk_fixdelall_C', '${PID}', 'C구역(벡터 복사)', '${VEC}', 1, NULL, ${now}, ${now}, 0);\n`);
  d1(sql);
}

const PORT = process.env.P132_PORT || "18832";
const wrangler = spawn("node", [path.join(NODE_MODULES, "wrangler/bin/wrangler.js"), "pages", "dev", "dist", "--d1=webapp-production", "--local", "--persist-to", STATE, "--ip", "127.0.0.1", "--port", PORT],
  { cwd: WORK, env, stdio: ["ignore", "pipe", "pipe"] });
let wlog = ""; wrangler.stdout.on("data", (d) => (wlog += d)); wrangler.stderr.on("data", (d) => (wlog += d));
const BASE = "http://127.0.0.1:" + PORT;
let chrome = null; const sockets = [];
async function cleanup() { sockets.forEach((s) => { try { s.close(); } catch (e) {} }); try { chrome && chrome.kill(); } catch (e) {} try { wrangler.kill(); } catch (e) {} }

const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej));
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl); sockets.push(ws);
  await new Promise((r) => ws.on("open", r));
  let idc = 0; const pend = new Map(); const errs = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
    if (m.method === "Runtime.exceptionThrown") errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300));
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++idc; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => { const r = await Promise.race([send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }), wait(20000).then(() => { throw new Error("evaluate 20s 무응답"); })]); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
  const evS = async (e) => { try { return await ev(e); } catch (x) { return { __err: String(x.message).slice(0, 200) }; } };
  const waitFor = async (cond, t = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if ((await evS("(function(){try{return !!(" + cond + ")}catch(e){return false}})()")) === true) return Date.now() - t0; await wait(150); } return -1; };
  return { ws, send, ev, evS, waitFor, errs };
}
let shotN = 0;
async function shot(P, name) { const s = await P.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, String(++shotN).padStart(2, "0") + "-" + name + ".png"), Buffer.from(s.data, "base64")); }
async function viewport(P, w, h, mobile) { await P.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile: !!mobile }); }
const CONTRAST_JS = `function(fg,bg){function L(c){var m=c.match(/\\d+(\\.\\d+)?/g).map(Number);function ch(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)}return 0.2126*ch(m[0])+0.7152*ch(m[1])+0.0722*ch(m[2])}var a=L(fg),b=L(bg);return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)}`;

try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { const r = await fetch(BASE + "/"); up = !!r.status; } catch (e) {} if (!up) await wait(500); }
  if (!up) { console.log("FAIL wrangler 기동 실패\n" + wlog.slice(-1500)); process.exit(1); }

  const profile = path.join(TMP, "p132-chrome-" + Date.now());
  chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", "--user-data-dir=" + profile, "--window-size=1280,800", "about:blank"], { stdio: "ignore" });
  let port = 0;
  for (let i = 0; i < 80 && !port; i++) { try { port = parseInt(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0], 10); } catch (e) {} if (!port) await wait(150); }
  let pageWs = null;
  for (let i = 0; i < 40 && !pageWs; i++) { try { const l = await getJson("http://127.0.0.1:" + port + "/json/list"); const pg = l.find((t) => t.type === "page"); if (pg) pageWs = pg.webSocketDebuggerUrl; } catch (e) {} if (!pageWs) await wait(250); }
  const P = await connect(pageWs);
  await P.send("Page.enable"); await P.send("Runtime.enable"); await P.send("Network.enable");
  // [WO 20261009-installgate 정비] 현장 실제 환경 = 설치된 앱(standalone). CDP 공식 Emulation
  // 커맨드로는 display-mode 를 바꿀 수 없어(p114 실측과 동일 근거) 신호 자체를 패치한다.
  await P.send("Page.addScriptToEvaluateOnNewDocument", { source: String.raw`(function(){
    var realMM = window.matchMedia.bind(window);
    window.matchMedia = function (q) {
      if (typeof q === "string" && q.indexOf("display-mode: standalone") >= 0) {
        return { matches: true, media: q, onchange: null, addListener: function(){}, removeListener: function(){}, addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){ return true; } };
      }
      return realMM(q);
    };
  })();` });
  await viewport(P, 375, 812, true);

  const acc = JSON.parse(fs.readFileSync(path.join(TMP, "local-test-accounts.json"), "utf8")).accounts;
  const pw = (role) => acc.find((a) => a.role === role).password;
  const em = (role) => acc.find((a) => a.role === role).email;
  await P.send("Page.navigate", { url: BASE + "/manifest.webmanifest" });
  await P.waitFor("location.pathname === '/manifest.webmanifest'");
  const login = async (role) => (await P.ev(`fetch("/api/signup/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:${JSON.stringify(em(role))},password:${JSON.stringify(pw(role))}})}).then(r=>r.json())`)).token;
  const preview = (tok) => P.ev(`fetch("/api/projects/${PID}/pins/purge",{headers:{Authorization:"Bearer "+${JSON.stringify(tok)}}}).then(async r=>({status:r.status, j:await r.json()}))`);
  const sTok = await login("super"), dTok = await login("designer");
  ok(!!sTok && !!dTok, "준비 — 로컬 super(소유자)·디자이너 로그인");
  const pv0 = await preview(sTok);
  const t0 = pv0.j.totals || {};
  ok(pv0.status === 200 && t0.pins > 0 && (pv0.j.deployments || []).some((d) => d.id === VEC && d.pins === 2), "준비 — 미리보기 API: 메인 + 벡터 복사 배포본(핀 2) 포함", pv0.j);
  const pvD = await preview(dTok);
  ok(pvD.status === 403, "서버 — 디자이너 미리보기 403", pvD.status);

  // SW 선설치(첫 방문 controllerchange 새로고침을 시나리오 밖에서)
  await P.send("Page.navigate", { url: BASE + "/" });
  await P.waitFor("navigator.serviceWorker && navigator.serviceWorker.controller", 30000);
  await wait(1200);

  const enterApp = async (tok) => {
    await P.ev(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem("wm_local_token", ${JSON.stringify(tok)}); 1`);
    await P.send("Page.navigate", { url: BASE + "/" });
    await P.waitFor("document.querySelector('.hub-card-thumb') || document.querySelector('#screen-app.active')", 30000);
    for (let attempt = 0; attempt < 3; attempt++) {
      await P.waitFor(FIND_SEED_ORIGIN, 15000);
      await P.evS(`(function(){var e=${FIND_SEED_ORIGIN}; if(!e) return 0; e.scrollIntoView({block:'center'}); e.click(); return 1})()`);
      await P.waitFor("document.querySelector('#screen-app.active')", 20000);
      if ((await P.waitFor("window.__wm && __wm.State.pins.length > 0 && document.querySelector('.tree-node-origin .tree-more')", 15000)) >= 0) { await wait(1200); return true; }
    }
    return false;
  };
  const openOriginMenu = async () => {
    await P.ev(`(function(){ if (window.innerWidth < 900) document.body.classList.add('sidebar-open'); return 1 })()`);
    await wait(500);
    await P.ev(`(function(){ var m=document.querySelector('.tree-node-origin .tree-more'); m.scrollIntoView({block:'center'}); m.click(); return 1 })()`);
    await P.waitFor("document.querySelector('.tree-pop')", 5000);
    return P.ev(`(function(){ var b=[].slice.call(document.querySelectorAll('.tree-pop .tree-pop-item')).find(function(x){return /모든 핀 삭제/.test(x.textContent)}); if(!b) return null;
      return {dis: b.classList.contains('is-disabled'), aria: b.getAttribute('aria-disabled'), why: (b.querySelector('.tree-pop-why')||{}).textContent||'', text: b.textContent} })()`);
  };
  const featureItem = async () => {
    // 모바일 [더보기] 시트는 앱 시작 때 미리 그려 둔 목록이 있다 — 사용자가 여는 것과 같게 [전체 기능] 패널(#feature-menu)을 열어 그 안을 본다.
    const via = await P.ev(`(function(){ var b=document.getElementById('btn-feature-menu'); if (b) { b.click(); return 'panel' } var t=document.getElementById('mdock-more-toggle'); if (t) { t.click(); return 'sheet' } return 'none' })()`);
    await P.waitFor("document.querySelector('#feature-menu:not(.hidden) [data-feature=pin-purge]') || document.querySelector('[data-feature=pin-purge]')", 5000);
    const r = await P.ev(`(function(){ var b=document.querySelector('#feature-menu:not(.hidden) [data-feature=pin-purge]') || [].slice.call(document.querySelectorAll('[data-feature=pin-purge]')).pop(); if(!b) return null; return {via:${JSON.stringify(via)}, dis:b.classList.contains('is-disabled'), why:(b.querySelector('.fm-why')||{}).textContent||''} })()`);
    await P.ev(`(function(){ try { document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); } catch(e){} var c=document.querySelector('.fm-close'); if (c) c.click(); return 1 })()`);
    return r;
  };

  /* ── 1. 디자이너(멤버) — 숨김 금지, 비활성 + 사유 ── */
  console.log("\n[1. 디자이너 — 비활성 + 소유자·관리자 전용]");
  ok(await enterApp(dTok), "1 디자이너 허브 → 원본 열기");
  const dm = await openOriginMenu();
  ok(dm && dm.dis && dm.aria === "true" && dm.why === "소유자·관리자 전용", "1 트리 원본 ⋯ [모든 핀 삭제] 보임·비활성·'소유자·관리자 전용'", dm);
  await shot(P, "375-1-designer-disabled");
  await P.ev(`__wm.UI.closeTreeMenu(); 1`);
  const df = await featureItem();
  ok(df && df.dis && df.why === "소유자·관리자 전용", "1 전체 기능 메뉴 [모든 핀 삭제] 비활성 + 같은 사유", df);

  /* ── 2. 소유자(super) — 오프라인 비활성 ── */
  console.log("\n[2. 소유자 — 오프라인]");
  ok(await enterApp(sTok), "2 소유자 허브 → 원본 열기");
  const mode = await P.ev(`__wm.State.mode`);
  ok(mode === "designer", "2 편집 화면(designer)", mode);
  const pinsBefore = await P.ev(`__wm.State.pins.length`);
  const treeBefore = await P.ev(`[].map.call(document.querySelectorAll('#side-tree .tree-cnt'), function(e){return e.textContent}).join(',')`);
  await P.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await P.waitFor("navigator.onLine === false", 5000);
  const om = await openOriginMenu();
  ok(om && om.dis && /온라인에서만/.test(om.why), "2 오프라인 → 비활성 + '온라인에서만'", om);
  await shot(P, "375-2-offline-disabled");
  await P.ev(`__wm.UI.closeTreeMenu(); 1`);
  await P.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await P.waitFor("navigator.onLine === true", 5000);

  /* ── 3. ① 미리보기 → ② 이름 불일치 → 0건 ── */
  console.log("\n[3. 확인 단계 — 이름 불일치 0건]");
  const sm = await openOriginMenu();
  ok(sm && !sm.dis, "3 소유자 → 활성", sm);
  await P.ev(`(function(){ var b=[].slice.call(document.querySelectorAll('.tree-pop .tree-pop-item')).find(function(x){return /모든 핀 삭제/.test(x.textContent)}); b.click(); return 1 })()`);
  ok(await P.waitFor("document.getElementById('wm-confirm-modal') && !document.getElementById('wm-confirm-modal').classList.contains('hidden') && /미리보기/.test(document.getElementById('wm-confirm-title').textContent)", 10000) >= 0, "3 ① 미리보기 모달");
  const msg = await P.ev(`document.getElementById('wm-confirm-msg').textContent`);
  const want = "구역 " + pv0.j.decks + "개 · 핀 " + t0.pins + "개(CHECKER " + t0.checker + " / 360 " + t0.pano + ") · 사진 연결 " + t0.photos + "개";
  ok(msg.split("\n")[0] === want, "3 미리보기 첫 줄 = 서버 집계 '" + want + "'", msg);
  ok(/C구역\(벡터 복사\) — 핀 2개/.test(msg) && /지우지 않는 것/.test(msg) && /10분/.test(msg), "3 배포본별 목록(벡터 복사 포함)·보존 범위·10분 안내", msg);
  await shot(P, "375-3-preview");
  await P.ev(`document.getElementById('wm-confirm-ok').click(); 1`);
  ok(await P.waitFor("!document.getElementById('prompt-modal').classList.contains('hidden') && /2\\/3/.test(document.getElementById('prompt-modal-title').textContent)", 8000) >= 0, "3 ② 이름 입력 모달");
  await shot(P, "375-4-name");
  await P.ev(`document.getElementById('prompt-modal-input').value = '틀린 이름'; document.getElementById('prompt-modal-ok').click(); 1`);
  ok(await P.waitFor("[].some.call(document.querySelectorAll('.wm-toast'), function(t){return /일치하지 않아/.test(t.textContent)})", 5000) >= 0, "3 이름 불일치 → 안내 토스트");
  const pvN = await preview(sTok);
  ok(pvN.j.totals.pins === t0.pins, "3 이름 불일치 → 서버 핀 0건 삭제", pvN.j.totals);

  /* ── 4. 전체 삭제 ── */
  console.log("\n[4. 전체 삭제 — 메인 + 벡터 복사]");
  await wait(2400);
  await openOriginMenu();
  await P.ev(`(function(){ var b=[].slice.call(document.querySelectorAll('.tree-pop .tree-pop-item')).find(function(x){return /모든 핀 삭제/.test(x.textContent)}); b.click(); return 1 })()`);
  await P.waitFor("!document.getElementById('wm-confirm-modal').classList.contains('hidden')", 8000);
  await P.ev(`document.getElementById('wm-confirm-ok').click(); 1`);
  await P.waitFor("!document.getElementById('prompt-modal').classList.contains('hidden') && /2\\/3/.test(document.getElementById('prompt-modal-title').textContent)", 8000);
  const projName = pv0.j.project.name;
  await P.ev(`document.getElementById('prompt-modal-input').value = ${JSON.stringify(projName)}; document.getElementById('prompt-modal-ok').click(); 1`);
  ok(await P.waitFor("!document.getElementById('prompt-modal').classList.contains('hidden') && /본인 확인/.test(document.getElementById('prompt-modal-title').textContent) && document.getElementById('prompt-modal-input').type === 'password'", 8000) >= 0, "4 ③ 본인 확인(비밀번호) 모달");
  await P.ev(`document.getElementById('prompt-modal-input').value = ${JSON.stringify(pw("super"))}; document.getElementById('prompt-modal-ok').click(); 1`);
  ok(await P.waitFor("document.getElementById('pin-purge-bar')", 15000) >= 0, "4 하단 결과·되돌리기 바");
  const pv1 = await preview(sTok);
  ok(pv1.j.totals.pins === 0 && pv1.j.deployments.every((d) => d.pins === 0), "4 서버 — 모든 배포본 핀 0(메인·벡터 복사)", pv1.j.deployments);
  ok(await P.waitFor("__wm.State.pins.length === 0 && document.querySelectorAll('.pin-marker').length === 0", 15000) >= 0, "4 화면 — 열린 도면 핀 0(병합 SoT)");
  ok(!(await P.ev(`[].some.call(document.querySelectorAll('.wm-toast'), function(t){return /다른 사용자/.test(t.textContent)})`)), "4 내 작업을 '다른 사용자 변경' 으로 알리지 않음");
  const bar = await P.ev(`(function(){ var b=document.getElementById('pin-purge-bar'), m=b.querySelector('.pin-purge-msg'), u=b.querySelector('.pin-purge-undo'); var cs=getComputedStyle(b), cm=getComputedStyle(m), cu=u&&getComputedStyle(u); var C=${CONTRAST_JS}; var r=b.getBoundingClientRect();
    return {text:m.textContent, undo:u&&u.textContent, cMsg:C(cm.color, cs.backgroundColor), cUndo:cu?C(cu.color, cu.backgroundColor):0, inView: r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight} })()`);
  ok(new RegExp("핀 " + t0.pins + "개 삭제").test(bar.text) && /^되돌리기 \d+:\d\d$/.test(bar.undo || ""), "4 바 문구 = 삭제 " + t0.pins + " · [되돌리기 m:ss]", bar);
  ok(bar.cMsg >= 4.5 && bar.cUndo >= 4.5 && bar.inView, "4 바 대비(글자 " + (bar.cMsg || 0).toFixed(1) + " · 버튼 " + (bar.cUndo || 0).toFixed(1) + ") ≥4.5 · 375 화면 안", bar);
  await shot(P, "375-5-purged-bar");
  await viewport(P, 1280, 800, false);
  await wait(600);
  await shot(P, "1280-6-purged-bar");

  /* ── 5. 되돌리기 ── */
  console.log("\n[5. 되돌리기]");
  await P.ev(`document.querySelector('#pin-purge-bar .pin-purge-undo').click(); 1`);
  ok(await P.waitFor("/복원/.test(document.querySelector('#pin-purge-bar .pin-purge-msg').textContent)", 15000) >= 0, "5 바 '복원' 표시");
  const btext = await P.ev(`document.querySelector('#pin-purge-bar .pin-purge-msg').textContent`);
  const pv2 = await preview(sTok);
  ok(pv2.j.totals.pins === t0.pins && pv2.j.totals.checker === t0.checker && pv2.j.totals.pano === t0.pano && pv2.j.totals.photos === t0.photos, "5 서버 — 복원 수 = 삭제 수(" + t0.pins + ")", pv2.j.totals);
  ok(new RegExp("핀 " + t0.pins + "개 복원").test(btext), "5 바 문구 '핀 " + t0.pins + "개 복원'", btext);
  ok(await P.waitFor("__wm.State.pins.length === " + pinsBefore + " && document.querySelectorAll('.pin-marker').length > 0", 15000) >= 0, "5 화면 — 열린 도면 핀 " + pinsBefore + "개 복귀");
  await wait(300);
  const treeAfter = await P.ev(`[].map.call(document.querySelectorAll('#side-tree .tree-cnt'), function(e){return e.textContent}).join(',')`);
  ok(treeAfter === treeBefore, "5 트리 개수 배지 원상(" + treeBefore + ")", treeAfter);
  await wait(400);
  await shot(P, "1280-7-undone");
  const logs = await P.ev(`fetch("/api/activity-logs?limit=20",{headers:{Authorization:"Bearer "+${JSON.stringify(sTok)}}}).then(r=>r.json()).catch(()=>null)`);
  const rows = (logs && (logs.data || logs.logs || logs.results)) || [];
  const acts = rows.map((r) => r.action);
  ok(acts.includes("pins.purge") && acts.includes("pins.purge.undo"), "5 감사 기록(activity) pins.purge · pins.purge.undo", acts.slice(0, 8));

  /* ── 6. 1280 미리보기 화면(스크린샷) — 취소 = 0건 ── */
  await openOriginMenu();
  await P.ev(`(function(){ var b=[].slice.call(document.querySelectorAll('.tree-pop .tree-pop-item')).find(function(x){return /모든 핀 삭제/.test(x.textContent)}); b.click(); return 1 })()`);
  await P.waitFor("!document.getElementById('wm-confirm-modal').classList.contains('hidden')", 8000);
  await wait(300);
  await shot(P, "1280-8-preview");
  await P.ev(`document.getElementById('wm-confirm-cancel').click(); 1`);
  await wait(500);
  ok((await preview(sTok)).j.totals.pins === t0.pins, "6 미리보기 취소 → 0건");
  ok(P.errs.length === 0, "콘솔 예외 0", P.errs);
} catch (e) {
  console.log("FAIL 예외: " + (e && e.stack || e));
  failed++;
} finally {
  await cleanup();
}
console.log("\n" + (failed ? "FAIL " + failed : "ALL PASS") + " — 스크린샷 " + OUT);
process.exit(failed ? 1 : 0);
