/**
 * p143-cdp — WO 20261010-revision 실 Chrome 실측(목 0): 도면 개정 정렬 UI → 적용 → 검토 배지 → 이력·겹쳐 비교 → 되돌리기 → 확정.
 *   디자이너 = 트리 원본 ⋯ [새 개정 올리기] 활성(제안) / 오프라인 = 비활성 + "온라인에서만"
 *   소유자(super) = 정렬 화면: 이전 도면을 이동·축소해 만든 "새 개정" 이미지 → 기준점 2쌍 → 서버 미리보기 변환 = 참값
 *   → [적용] 확인창 → 하단 [되돌리기 m:ss] · 핀 검토 배지 · 서버 이력 Rev.1 → 이력·겹쳐 비교 → 되돌리기 = 핀 좌표 원복
 *   → 다시 적용 → [검토 필요 핀 모두 확정] = 배지 0 · 서버 review_pins 0. 대비(getComputedStyle)·터치 크기 실측.
 * 실행: P143=1 TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p143-revision-cdp.mjs   (P143 != "1" 이면 SKIP)
 * 사전: .tmp/localdev-state (node build-tools/local-dev.mjs && node build-tools/seed-local.mjs) — 사본(.tmp/fixrev/state)만 쓴다(0040 적용).
 * 스크린샷: .tmp/fixrev/*.png (1280 · 375)
 */
import { execSync, spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { fileURLToPath } from "node:url";
import { FIND_SEED_ORIGIN } from "./_lib/seed-origin.mjs";

if (process.env.P143 !== "1") { console.log("[SKIP] p143-cdp 는 P143=1 일 때만 실행"); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = path.join(ROOT, ".tmp");
const OUT = path.join(TMP, "fixrev");
const WORK = path.join(OUT, "work");
const STATE_SRC = path.join(TMP, "localdev-state");
const STATE = path.join(OUT, "state");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const NODE_MODULES = path.join(ROOT, "node_modules");
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
// 격리 사본에서만 AI 바인딩 제거(p142-delivery-cdp 와 같은 처리) — env.AI 는 remote 바인딩이라 OAuth 없이는 pages dev 가 못 뜬다. 원본 불변.
{
  const wj = path.join(WORK, "wrangler.jsonc");
  const txt = fs.readFileSync(wj, "utf8").replace(/,(\s*\/\/[^\r\n]*)*\s*"ai"\s*:\s*\{[^}]*\}/, "");
  if (/"ai"\s*:/.test(txt)) { console.log("FAIL 격리 사본 AI 바인딩 제거 실패"); process.exit(2); }
  fs.writeFileSync(wj, txt);
}
// 뮤테이션(MUT=<이름>) — WORK 사본에만 치환(치환 대상 없음 = EXIT 3). 각 뮤테이션은 EXIT=1 이어야 한다.
const MUTS = {
  badge:   ["public/js/modules/11_UI.js", "if (pin.revReview) {\n          marker.classList.add(\"pin-rev-review\");", "if (false) {\n          marker.classList.add(\"pin-rev-review\");"],
  matrix:  ["public/js/modules/58_Revision.js", "t.e * W / 100, t.f * H / 100", "t.e, t.f"],
  confirm: ["public/js/modules/58_Revision.js", "{ p.revReview = null; n++; }", "{ n++; }"],
  offline: ["public/js/modules/58_Revision.js", "if (!this._online()) return \"온라인에서만 — 개정은 오프라인에서 적용·제안하지 않습니다\";", ""],
};
if (process.env.MUT) {
  const m = MUTS[process.env.MUT];
  if (!m) { console.log("unknown MUT"); process.exit(3); }
  const f = path.join(WORK, m[0]); const s = fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  if (!s.includes(m[1])) { console.log("MUT 치환 대상 없음"); process.exit(3); }
  fs.writeFileSync(f, s.replace(m[1], m[2]));
  console.log("[MUT=" + process.env.MUT + "]");
}
const man = fs.readFileSync(path.join(WORK, "public/js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
fs.writeFileSync(path.join(WORK, "public/js/main.js"), man.map((f) => fs.readFileSync(path.join(WORK, "public/js/modules", f), "utf8")).join("\n"));
const env = { ...process.env, TEMP: TMP, TMP: TMP };
execSync(`node --max-old-space-size=640 "${path.join(NODE_MODULES, "vite/bin/vite.js")}" build`, { cwd: WORK, env, stdio: "inherit" });
fs.rmSync(STATE, { recursive: true, force: true });
fs.cpSync(STATE_SRC, STATE, { recursive: true });
const d1 = (file) => execSync(`node "${path.join(NODE_MODULES, "wrangler/bin/wrangler.js")}" d1 execute webapp-production --local --persist-to "${STATE}" --file "${file}"`, { cwd: WORK, env, stdio: "pipe" });
d1(path.join(WORK, "migrations/0040_drawing_revisions.sql"));

const PORT = process.env.P143_PORT || "18843";
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
  const ev = async (expr) => { const r = await Promise.race([send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }), wait(30000).then(() => { throw new Error("evaluate 30s 무응답"); })]); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
  const evS = async (e) => { try { return await ev(e); } catch (x) { return { __err: String(x.message).slice(0, 200) }; } };
  const waitFor = async (cond, t = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if ((await evS("(function(){try{return !!(" + cond + ")}catch(e){return false}})()")) === true) return Date.now() - t0; await wait(150); } return -1; };
  return { ws, send, ev, evS, waitFor, errs };
}
let shotN = 0;
async function shot(P, name) { const s = await P.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); fs.writeFileSync(path.join(OUT, String(++shotN).padStart(2, "0") + "-" + name + ".png"), Buffer.from(s.data, "base64")); }
async function viewport(P, w, h, mobile) { await P.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile: !!mobile }); }
const CONTRAST_JS = `function(fg,bg){function L(c){var m=c.match(/\\d+(\\.\\d+)?/g).map(Number);function ch(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)}return 0.2126*ch(m[0])+0.7152*ch(m[1])+0.0722*ch(m[2])}var a=L(fg),b=L(bg);return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)}`;

try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { const r = await fetch(BASE + "/"); up = !!r.status; } catch (e) {} if (!up) await wait(500); }
  if (!up) { console.log("FAIL wrangler 기동 실패\n" + wlog.slice(-1500)); process.exit(1); }
  const profile = path.join(TMP, "p143-chrome-" + Date.now());
  chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", "--user-data-dir=" + profile, "--window-size=1280,800", "about:blank"], { stdio: "ignore" });
  let port = 0;
  for (let i = 0; i < 80 && !port; i++) { try { port = parseInt(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0], 10); } catch (e) {} if (!port) await wait(150); }
  let pageWs = null;
  for (let i = 0; i < 40 && !pageWs; i++) { try { const l = await getJson("http://127.0.0.1:" + port + "/json/list"); const pg = l.find((t) => t.type === "page"); if (pg) pageWs = pg.webSocketDebuggerUrl; } catch (e) {} if (!pageWs) await wait(250); }
  const P = await connect(pageWs);
  await P.send("Page.enable"); await P.send("Runtime.enable"); await P.send("Network.enable");
  await P.send("Page.addScriptToEvaluateOnNewDocument", { source: String.raw`(function(){
    var realMM = window.matchMedia.bind(window);
    window.matchMedia = function (q) {
      if (typeof q === "string" && q.indexOf("display-mode: standalone") >= 0) {
        return { matches: true, media: q, onchange: null, addListener: function(){}, removeListener: function(){}, addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){ return true; } };
      }
      return realMM(q);
    };
  })();` });
  await viewport(P, 1280, 800, false);
  const acc = JSON.parse(fs.readFileSync(path.join(TMP, "local-test-accounts.json"), "utf8")).accounts;
  const pw = (role) => acc.find((a) => a.role === role).password;
  const em = (role) => acc.find((a) => a.role === role).email;
  await P.send("Page.navigate", { url: BASE + "/manifest.webmanifest" });
  await P.waitFor("location.pathname === '/manifest.webmanifest'");
  const login = async (role) => (await P.ev(`fetch("/api/signup/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:${JSON.stringify(em(role))},password:${JSON.stringify(pw(role))}})}).then(r=>r.json())`)).token;
  const sTok = await login("super"), dTok = await login("designer");
  ok(!!sTok && !!dTok, "준비 — 로컬 super(소유자)·디자이너 로그인");
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
  const originItem = async (re) => {
    await P.ev(`(function(){ if (window.innerWidth < 900) document.body.classList.add('sidebar-open'); return 1 })()`);
    await wait(400);
    await P.ev(`(function(){ var m=document.querySelector('.tree-node-origin .tree-more'); m.scrollIntoView({block:'center'}); m.click(); return 1 })()`);
    await P.waitFor("document.querySelector('.tree-pop')", 5000);
    return P.ev(`(function(){ var b=[].slice.call(document.querySelectorAll('.tree-pop .tree-pop-item')).find(function(x){return ${re}.test(x.textContent)}); if(!b) return null;
      var r=b.getBoundingClientRect(); return {dis: b.classList.contains('is-disabled'), why: (b.querySelector('.tree-pop-why')||{}).textContent||'', text: b.textContent, h: r.height} })()`);
  };
  const revInfo = (tok, depId) => P.ev(`fetch("/api/deployments/"+${JSON.stringify(depId)}+"/revisions",{headers:{Authorization:"Bearer "+${JSON.stringify(tok)}}}).then(async r=>({status:r.status, j:await r.json()}))`);
  const depPins = (tok, depId) => P.ev(`fetch("/tables/deployments/"+${JSON.stringify(depId)},{headers:{Authorization:"Bearer "+${JSON.stringify(tok)}}}).then(r=>r.json()).then(d=>JSON.parse(d.pins||"[]").filter(p=>p&&!p._deleted).map(p=>({id:p.id,x:p.x,y:p.y,rr:!!p.revReview})))`);

  /* ── 1. 디자이너 — 메뉴 노출(숨김 금지) + 오프라인 사유 ── */
  console.log("\n[1. 디자이너 — 트리 ⋯ · 오프라인]");
  ok(await enterApp(dTok), "1 디자이너 허브 → 원본 열기");
  const dm = await originItem("/새 개정 올리기/");
  ok(dm && !dm.dis, "1 트리 원본 ⋯ [새 개정 올리기] 보임·활성(디자이너 = 제안)", dm);
  const dh = await P.ev(`(function(){ var b=[].slice.call(document.querySelectorAll('.tree-pop .tree-pop-item')).find(function(x){return /개정 이력/.test(x.textContent)}); return b ? {dis:b.classList.contains('is-disabled')} : null })()`);
  ok(dh && !dh.dis, "1 [개정 이력·비교] 보임·활성", dh);
  await P.ev(`__wm.UI.closeTreeMenu(); 1`);
  await P.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await P.waitFor("navigator.onLine === false", 5000);
  const om = await originItem("/새 개정 올리기/");
  ok(om && om.dis && /온라인에서만/.test(om.why), "1 오프라인 → 비활성 + '온라인에서만'", om);
  await shot(P, "1280-1-offline-disabled");
  await P.ev(`__wm.UI.closeTreeMenu(); 1`);
  await P.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await P.waitFor("navigator.onLine === true", 5000);

  /* ── 2. 소유자 — 정렬 화면 ── */
  console.log("\n[2. 소유자 — 정렬 화면(기준점 2쌍)]");
  ok(await enterApp(sTok), "2 소유자 허브 → 원본 열기");
  const depId = await P.ev(`__wm.App._mainDepId()`);
  const pins0 = await depPins(sTok, depId);
  ok(!!depId && pins0.length > 0, "2 메인 배포본 · 핀 " + pins0.length + "개", { depId, n: pins0.length });
  // "새 개정" = 이전 도면을 0.8배 축소 + (10%,6%) 이동해 그린 PNG(같은 크기) — 참값 변환 T: x' = 0.8x + 10, y' = 0.8y + 6
  const made = await P.ev(`(async function(){
    var pages = __wm.State.viewerPages || []; var src = pages[(__wm.State.pdfPage||1)-1] || pages[0];
    var url = /^data:/.test(src) ? src : (__wm.Auth.r2 ? __wm.Auth.r2(src) : src);
    var img = new Image(); img.crossOrigin = 'anonymous';
    await new Promise(function(res, rej){ img.onload = res; img.onerror = rej; img.src = url; });
    var c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    var g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0,0,c.width,c.height);
    g.setTransform(0.8, 0, 0, 0.8, 0.10*c.width, 0.06*c.height); g.drawImage(img, 0, 0);
    var blob = await new Promise(function(r){ c.toBlob(r, 'image/png'); });
    window.__revFile = new File([blob], 'rev1-test.png', {type:'image/png'});
    return {w:c.width, h:c.height, size: blob.size};
  })()`);
  ok(made && made.size > 1000, "2 새 개정 이미지 생성(이전 도면 0.8배 + 이동)", made);
  const info = await revInfo(sTok, depId);
  ok(info.status === 200 && info.j.ready && info.j.can_apply && info.j.next_label, "2 서버 이력 준비(0040) · 적용 가능 · 다음 번호 " + (info.j && info.j.next_label), info.j);
  await P.ev(`(function(){ var R=__wm.Revision; window.__revStudio = R.openStudio(R.resolve({kind:'main'}), ${JSON.stringify(info.j)}, window.__revFile); return 1 })()`);
  ok(await P.waitFor("document.getElementById('rev-studio') && __wm.Revision._studio && __wm.Revision._studio.pv", 30000) >= 0, "2 정렬 화면 열림 + 자동 제안 미리보기");
  const autoKind = await P.ev(`__wm.Revision._studio.pv.kind`);
  ok(autoKind === "identity", "2 자동 제안 = 같은 크기 → 좌표 그대로(identity)", autoKind);
  await P.ev(`(function(){ var R=__wm.Revision; R.addPoint('old',{x:20,y:20}); R.addPoint('new',{x:26,y:22}); R.addPoint('old',{x:80,y:75}); R.addPoint('new',{x:74,y:66}); return 1 })()`);
  ok(await P.waitFor("__wm.Revision._studio.pv && __wm.Revision._studio.pv.kind === 'similarity'", 15000) >= 0, "2 기준점 2쌍 → 서버 닮음변환");
  const tr = await P.ev(`__wm.Revision._studio.pv.transform`);
  ok(Math.abs(tr.a - 0.8) < 1e-6 && Math.abs(tr.d - 0.8) < 1e-6 && Math.abs(tr.e - 10) < 1e-4 && Math.abs(tr.f - 6) < 1e-4 && Math.abs(tr.b) < 1e-9, "2 변환 = 참값(×0.8, +10%, +6%)", tr);
  await P.waitFor("document.querySelectorAll('#rev-studio .rev-pv-now').length > 0 && document.querySelector('#rev-studio .rev-pv-old')", 10000);
  const st = await P.ev(`(function(){ var s=document.getElementById('rev-studio'), C=${CONTRAST_JS}; var cs=getComputedStyle(s); var b=document.getElementById('rev-apply'); var cb=getComputedStyle(b);
    var sum=document.getElementById('rev-summary'); var old=document.querySelector('#rev-studio .rev-pv-old');
    return {cText:C(cs.color, cs.backgroundColor), cBtn:C(cb.color, cb.backgroundColor), btnH:b.getBoundingClientRect().height, btn:b.textContent, dis:b.disabled,
      pts:document.querySelectorAll('#rev-studio .rev-pt').length, was:document.querySelectorAll('#rev-studio .rev-pv-was').length, now:document.querySelectorAll('#rev-studio .rev-pv-now').length,
      sum:sum.textContent, oldT: old && old.style.transform, boxW: document.querySelector('#rev-studio .rev-preview').clientWidth, boxH: old && parseFloat(old.style.height)} })()`);
  const mx = ((st.oldT || '').match(/matrix\(([^)]+)\)/) || [, ''])[1].split(',').map(Number);
  ok(st.cText >= 4.5 && st.cBtn >= 4.5 && st.btnH >= 32, "2 대비(본문 " + st.cText.toFixed(1) + " · 버튼 " + st.cBtn.toFixed(1) + ") ≥4.5 · 버튼 높이 " + st.btnH + "px ≥32", st);
  ok(st.pts === 4 && st.was > 0 && st.was === st.now && Math.abs(mx[0] - 0.8) < 1e-6 && Math.abs(mx[4] - 0.10 * st.boxW) < 1 && Math.abs(mx[5] - 0.06 * st.boxH) < 1, "2 기준점 4개 · 핀 이전(흐림)/새 위치 " + st.now + "쌍 · 이전 도면 겹침 CSS matrix = 참값(×0.8, +" + (mx[4] || 0).toFixed(1) + "px)", { st, mx });
  ok(/이동·회전·배율/.test(st.sum) && /핀 \d+개/.test(st.sum) && st.btn === "적용" && !st.dis, "2 요약(종류·이월 수) · [적용] 활성", st.sum);
  await shot(P, "1280-2-studio");
  await viewport(P, 375, 812, true); await wait(700);
  await shot(P, "375-3-studio");
  const mob = await P.ev(`(function(){ var b=document.getElementById('rev-apply').getBoundingClientRect(); var s=document.getElementById('rev-studio'); return {w:s.scrollWidth, vw:innerWidth, bh:b.height} })()`);
  ok(mob.w <= mob.vw + 1 && mob.bh >= 32, "2 375 — 가로 넘침 없음 · 버튼 ≥32px", mob);
  await viewport(P, 1280, 800, false); await wait(500);

  /* ── 3. 적용 ── */
  console.log("\n[3. 적용 → 되돌리기 바 · 검토 배지]");
  await P.ev(`document.getElementById('rev-in-memo').value = 'CDP 개정 테스트'; document.getElementById('rev-apply').click(); 1`);
  ok(await P.waitFor("!document.getElementById('wm-confirm-modal').classList.contains('hidden') && /개정 적용/.test(document.getElementById('wm-confirm-title').textContent)", 8000) >= 0, "3 확인창(개정 적용)");
  const cmsg = await P.ev(`document.getElementById('wm-confirm-msg').textContent`);
  ok(/→/.test(cmsg) && /검토 필요/.test(cmsg) && /10분/.test(cmsg) && /보관/.test(cmsg), "3 확인창 문구 — 번호·이월·보관·10분", cmsg);
  await shot(P, "1280-4-confirm");
  await P.ev(`document.getElementById('wm-confirm-ok').click(); 1`);
  ok(await P.waitFor("document.getElementById('rev-undo-bar') && !document.getElementById('rev-studio')", 30000) >= 0, "3 하단 결과·되돌리기 바");
  const info1 = await revInfo(sTok, depId);
  ok(info1.j.current_label === info.j.next_label && info1.j.review_pins === pins0.length, "3 서버 — 현재 " + info1.j.current_label + " · 검토 필요 핀 " + info1.j.review_pins, info1.j);
  const pins1 = await depPins(sTok, depId);
  const p0 = pins0[0], p1 = pins1.find((p) => p.id === p0.id);
  ok(p1 && Math.abs(p1.x - (0.8 * p0.x + 10)) < 1e-3 && Math.abs(p1.y - (0.8 * p0.y + 6)) < 1e-3 && p1.rr, "3 핀 좌표 이월 = T(p) · revReview", { p0, p1 });
  ok(await P.waitFor("document.querySelectorAll('.pin-marker .pin-rev-badge').length > 0", 20000) >= 0, "3 화면 — 핀 '검토' 배지");
  const bar = await P.ev(`(function(){ var b=document.getElementById('rev-undo-bar'), m=b.querySelector('.rev-undo-msg'), u=b.querySelector('.rev-undo'); var C=${CONTRAST_JS};
    var bd=document.querySelector('.pin-marker .pin-rev-badge'), cbd=getComputedStyle(bd), r=b.getBoundingClientRect();
    return {text:m.textContent, undo:u&&u.textContent, cMsg:C(getComputedStyle(m).color, getComputedStyle(b).backgroundColor), cUndo:C(getComputedStyle(u).color, getComputedStyle(u).backgroundColor),
      cBadge:C(cbd.color, cbd.backgroundColor), badges:document.querySelectorAll('.pin-marker .pin-rev-badge').length, inView:r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight, uh:u.getBoundingClientRect().height} })()`);
  ok(/적용/.test(bar.text) && /^되돌리기 \d+:\d\d$/.test(bar.undo || "") && bar.cMsg >= 4.5 && bar.cUndo >= 4.5 && bar.cBadge >= 4.5 && bar.inView && bar.uh >= 32, "3 바 문구·[되돌리기 m:ss]·대비(" + bar.cMsg.toFixed(1) + "/" + bar.cUndo.toFixed(1) + ") · 배지 대비 " + bar.cBadge.toFixed(1), bar);
  await wait(800);
  await shot(P, "1280-5-applied-badges");

  /* ── 4. 이력 · 겹쳐 비교 ── */
  console.log("\n[4. 이력 · 겹쳐 비교]");
  await P.ev(`__wm.Revision.openHistory({kind:'main'}); 1`);
  ok(await P.waitFor("document.querySelectorAll('#rev-history .rev-row').length >= 2", 10000) >= 0, "4 이력 — 개정 행 + 기준 개정 행");
  const hist = await P.ev(`[].map.call(document.querySelectorAll('#rev-history .rev-row'), function(r){return r.textContent}).join(' | ')`);
  ok(new RegExp(info1.j.current_label).test(hist) && /현행/.test(hist) && /기준 개정/.test(hist) && /CDP 개정 테스트/.test(hist), "4 이력 행 — 번호·현행·기준·메모", hist);
  await shot(P, "1280-6-history");
  const rid = info1.j.revisions.find((r) => r.current).id;
  await P.ev(`__wm.Revision.openViewer(__wm.Revision.resolve({kind:'main'}), ${JSON.stringify(rid)}, 'compare'); 1`);
  ok(await P.waitFor("document.querySelector('#rev-viewer .rev-viewer-old') && document.getElementById('rev-viewer-opacity')", 15000) >= 0, "4 겹쳐 비교 — 이전 도면 변환 겹침 + 투명도 슬라이더");
  const vi = await P.ev(`(function(){ var s=document.getElementById('rev-viewer-opacity'); s.value='80'; s.dispatchEvent(new Event('input')); return {op:document.querySelector('#rev-viewer .rev-viewer-old').style.opacity, info:document.querySelector('#rev-viewer .rev-viewer-info').textContent} })()`);
  ok(vi.op === "0.8" && /이동 0 · 추가 0 · 삭제 0/.test(vi.info), "4 슬라이더 → 투명도 0.8 · diff 요약(이월만 = 이동 0)", vi);
  await shot(P, "1280-7-compare");
  await P.ev(`__wm.Revision.closeViewer(); __wm.Revision.openViewer(__wm.Revision.resolve({kind:'main'}), ${JSON.stringify(rid)}, 'prev'); 1`);
  ok(await P.waitFor("document.querySelectorAll('#rev-viewer .rev-viewer-pin').length > 0", 15000) >= 0, "4 이전 개정 보기 — 그때 핀(읽기 전용)");
  await shot(P, "1280-8-prev-view");
  await P.ev(`__wm.Revision.closeViewer(); __wm.Revision.closeHistory(); 1`);

  /* ── 5. 되돌리기 ── */
  console.log("\n[5. 되돌리기]");
  await P.ev(`document.querySelector('#rev-undo-bar .rev-undo').click(); 1`);
  ok(await P.waitFor("/되돌렸습니다/.test(document.querySelector('#rev-undo-bar .rev-undo-msg').textContent)", 20000) >= 0, "5 바 '되돌렸습니다'");
  const pins2 = await depPins(sTok, depId);
  const same = pins2.length === pins0.length && pins0.every((p) => { const q = pins2.find((x) => x.id === p.id); return q && q.x === p.x && q.y === p.y && !q.rr; });
  ok(same, "5 서버 핀 수·좌표 = 적용 전과 동일 · 배지 0", { before: pins0.slice(0, 3), after: pins2.slice(0, 3) });
  ok(await P.waitFor("document.querySelectorAll('.pin-marker .pin-rev-badge').length === 0 && document.querySelectorAll('.pin-marker').length > 0", 15000) >= 0, "5 화면 배지 0 · 핀 표시");
  const info2 = await revInfo(sTok, depId);
  ok(info2.j.current_label === info.j.base_label || info2.j.current_label === "Rev.0", "5 서버 현재 개정 = 기준", info2.j.current_label);
  await shot(P, "1280-9-undone");
  await P.ev(`__wm.Revision.closeBar(); 1`);

  /* ── 6. 다시 적용 → 모두 확정 ── */
  console.log("\n[6. 다시 적용 → 검토 필요 핀 모두 확정]");
  const info3 = await revInfo(sTok, depId);
  await P.ev(`(function(){ var R=__wm.Revision; R.openStudio(R.resolve({kind:'main'}), ${JSON.stringify(info3.j)}, window.__revFile); return 1 })()`);
  await P.waitFor("__wm.Revision._studio && __wm.Revision._studio.pv", 30000);
  await P.ev(`(function(){ var R=__wm.Revision; R.addPoint('old',{x:20,y:20}); R.addPoint('new',{x:26,y:22}); R.addPoint('old',{x:80,y:75}); R.addPoint('new',{x:74,y:66}); return 1 })()`);
  await P.waitFor("__wm.Revision._studio.pv && __wm.Revision._studio.pv.kind === 'similarity'", 15000);
  await P.ev(`document.getElementById('rev-apply').click(); 1`);
  await P.waitFor("!document.getElementById('wm-confirm-modal').classList.contains('hidden')", 8000);
  await P.ev(`document.getElementById('wm-confirm-ok').click(); 1`);
  ok(await P.waitFor("document.getElementById('rev-undo-bar') && document.querySelectorAll('.pin-marker .pin-rev-badge').length > 0", 30000) >= 0, "6 재적용 · 배지 표시");
  await P.ev(`__wm.Revision.closeBar(); __wm.Revision.openHistory({kind:'main'}); 1`);
  ok(await P.waitFor("document.getElementById('rev-confirm-all') && !document.getElementById('rev-confirm-all').disabled && document.querySelectorAll('#rev-review-list .rev-review-one').length > 0", 10000) >= 0, "6 이력 — [모두 확정] 활성 · 핀별 [확정] 목록");
  await shot(P, "1280-10-review-list");
  await P.ev(`document.getElementById('rev-confirm-all').click(); 1`);
  ok(await P.waitFor("document.querySelectorAll('.pin-marker .pin-rev-badge').length === 0", 15000) >= 0, "6 확정 → 화면 배지 0");
  let rp = -1;
  for (let i = 0; i < 40 && rp !== 0; i++) { rp = (await revInfo(sTok, depId)).j.review_pins; if (rp !== 0) await wait(400); }
  ok(rp === 0, "6 서버 review_pins 0(저장 반영)", rp);
  const pins3 = await depPins(sTok, depId);
  ok(pins3.every((p) => !p.rr) && pins3.length === pins0.length, "6 서버 핀 revReview 전부 해제 · 핀 수 그대로", pins3.length);
  await P.ev(`__wm.Revision.closeHistory(); 1`);
  ok(P.errs.length === 0, "콘솔 예외 0", P.errs);
} catch (e) {
  console.log("FAIL 예외: " + (e && e.stack || e));
  failed++;
} finally {
  await cleanup();
}
console.log("\n" + (failed ? "FAIL " + failed : "ALL PASS") + " — 스크린샷 " + OUT);
process.exit(failed ? 1 : 0);
