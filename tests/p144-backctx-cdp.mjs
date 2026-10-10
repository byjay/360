/**
 * p144-cdp — WO 20261010-backctx 실 Chrome 실측(목 0).
 *   A. 뒤로가기 이탈 방지(58_BackGuard): 허브 → 프로젝트(원본) → 구역 → 영역 → 360 을 **실제 마우스 입력**으로 진입한 뒤
 *      브라우저 측 history 이동(Page.navigateToHistoryEntry = 브라우저가 시작한 뒤로)으로 한 단계씩 앱 안 이전 화면,
 *      허브에서 한 번 더 → 앱 확인창([머무르기] 기본 포커스) · 머무르기 = URL·화면 유지 + 가드 재설치 · 나가기 = 그때만 이탈.
 *      beforeunload: 조작 전 = 브라우저가 확인을 띄우지 않음(표준 한계 기록) · 조작 후 새로고침 = 브라우저 확인 · 앱이 시작한 이동 = 확인 없음.
 *   B. 전역 우클릭 = 앱 메뉴: 대상 10곳 이상 contextmenu(실제 우클릭) → defaultPrevented + 앱 메뉴 항목 수 + 하단 안내,
 *      입력창 · 선택한 글자 · Shift+우클릭 = 브라우저 메뉴(preventDefault 0), 375 길게 누르기 = 앱 메뉴.
 *   🔴 한계(정직): CDP 로는 브라우저 UI 뒤로 버튼의 "조작 없는 항목 건너뛰기"(Chrome history manipulation intervention)를
 *      재현할 수 없다 — navigateToHistoryEntry 는 건너뛰기 없이 그 항목으로 간다. 그 판정은 headful 실측(보고서)으로 따로 한다.
 *   navigator.webdriver(자동화)에서는 BackGuard 가 beforeunload 를 걸지 않는다 → 이 테스트는 localStorage "bg-force-guard"=1 로 강제.
 * 실행: P144=1 TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p144-backctx-cdp.mjs   (P144 != "1" 이면 SKIP)
 *   뮤테이션: P144_MUT=nopush|noexit|nounload|ctxpage|noshift  → 격리 사본만 고쳐 빌드, EXIT=1 이어야 한다.
 * 사전: .tmp/localdev-state (node build-tools/local-dev.mjs && node build-tools/seed-local.mjs) — 사본(.tmp/fixbackctx/state)만 쓴다.
 * 산출: .tmp/fixbackctx/*.png
 */
import { execSync, spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { FIND_SEED_ORIGIN } from "./_lib/seed-origin.mjs";

if (process.env.P144 !== "1") { console.log("[SKIP] p144-cdp 는 P144=1 일 때만 실행"); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = path.join(ROOT, ".tmp");
const MUT = process.env.P144_MUT || "";
const OUT = path.join(TMP, "fixbackctx" + (MUT ? "-mut-" + MUT : ""));
const WORK = path.join(OUT, "work");
const STATE_SRC = path.join(TMP, "localdev-state");
const STATE = path.join(OUT, "state");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const NODE_MODULES = path.join(ROOT, "node_modules");
const PID = "proj_localseed";
let failed = 0;
const ok = (c, label, d) => { console.log((c ? "  PASS " : "  FAIL ") + label + (d != null ? " :: " + JSON.stringify(d).slice(0, 600) : "")); if (!c) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
if (!fs.existsSync(STATE_SRC)) { console.log("FAIL .tmp/localdev-state 없음"); process.exit(2); }
if (!fs.existsSync(CHROME)) { console.log("FAIL Chrome 없음"); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (/\.png$/.test(f)) fs.rmSync(path.join(OUT, f), { force: true });

/* ── 뮤테이션(격리 사본만) — 고친 줄을 되돌리면 이 테스트가 FAIL 해야 한다 ── */
const MUTS = {
  nopush: ["58_BackGuard.js", 'this._origPush(this._state(s), "");', "void 0;"],
  noexit: ["58_BackGuard.js", "leave = await pr;", "leave = true;"],
  nounload: ["58_BackGuard.js", 'window.addEventListener("beforeunload", (e) => this._onBeforeUnload(e));', ""],
  ctxpage: ["11_UI.js", 'if (!vp || !vp.contains(target)) return { kind: "page" };', "if (!vp || !vp.contains(target)) return null;"],
  noshift: ["11_UI.js", "if (!e || e.shiftKey || this._isEditable(e.target)) return true;", "if (!e || this._isEditable(e.target)) return true;"]
};
if (MUT && !MUTS[MUT]) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }

// ── 격리 빌드(작업트리 모듈 → WORK) + 상태 사본 ──
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
  const fp = path.join(WORK, "public/js/modules", file);
  const src = fs.readFileSync(fp, "utf8");
  if (src.indexOf(from) < 0) { console.log("  FAIL 뮤테이션 대상 문자열 없음: " + MUT); process.exit(2); }
  fs.writeFileSync(fp, src.replace(from, to));
  console.log("[MUT] " + MUT + " — " + file + " 의 고친 줄을 되돌림");
}
const man = fs.readFileSync(path.join(WORK, "public/js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
if (!man.includes("58_BackGuard.js")) { console.log("FAIL _manifest.txt 에 58_BackGuard.js 없음"); process.exit(2); }
fs.writeFileSync(path.join(WORK, "public/js/main.js"), man.map((f) => fs.readFileSync(path.join(WORK, "public/js/modules", f), "utf8")).join("\n"));
const env = { ...process.env, TEMP: TMP, TMP: TMP };
execSync(`node --max-old-space-size=640 "${path.join(NODE_MODULES, "vite/bin/vite.js")}" build`, { cwd: WORK, env, stdio: "pipe" });
fs.rmSync(STATE, { recursive: true, force: true });
fs.cpSync(STATE_SRC, STATE, { recursive: true });

const PORT = process.env.P144_PORT || "18844";
const wrangler = spawn("node", [path.join(NODE_MODULES, "wrangler/bin/wrangler.js"), "pages", "dev", "dist", "--d1=webapp-production", "--local", "--persist-to", STATE, "--ip", "127.0.0.1", "--port", PORT],
  { cwd: WORK, env, stdio: ["ignore", "pipe", "pipe"] });
let wlog = ""; wrangler.stdout.on("data", (d) => (wlog += d)); wrangler.stderr.on("data", (d) => (wlog += d));
const BASE = "http://127.0.0.1:" + PORT;
let chrome = null; const sockets = [];
async function cleanup() { sockets.forEach((s) => { try { s.close(); } catch (e) {} }); try { chrome && chrome.kill(); } catch (e) {} try { wrangler.kill(); } catch (e) {} }

const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej));
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
async function viewport(P, w, h, mobile) {
  await P.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile: !!mobile });
  await P.send("Emulation.setTouchEmulationEnabled", { enabled: !!mobile, maxTouchPoints: mobile ? 5 : 1 });
}
/** 글자 대비(그라디언트 배경 포함) — 버튼의 글자 줄(텍스트 Range 상·하단) 위치에서 linear-gradient 색을 계산해 가장 나쁜 값.
 *  backgroundColor 가 투명이고 배경이 이미지(그라디언트)인 버튼(.admin-gate-btn.primary — seastar-family-tokens.css !important)을 바로 잰다. */
const TEXT_CONTRAST_JS = `function(el){
  function rgb(s){ var m=String(s).match(/\\d+(\\.\\d+)?/g); return m ? m.slice(0,4).map(Number) : [0,0,0,0]; }
  function lum(c){ function ch(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)} return 0.2126*ch(c[0])+0.7152*ch(c[1])+0.0722*ch(c[2]); }
  function cr(a,b){ var x=lum(a), y=lum(b); return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05); }
  function bgOf(e){ while(e){ var c=rgb(getComputedStyle(e).backgroundColor); if(c.length<4||c[3]>0.5) return c; e=e.parentElement; } return [255,255,255]; }
  var cs=getComputedStyle(el), fg=rgb(cs.color), img=cs.backgroundImage, r=el.getBoundingClientRect();
  var rg=document.createRange(); rg.selectNodeContents(el); var tr=rg.getBoundingClientRect();
  if(!img || img==='none') return { ratio: cr(fg,bgOf(el)), how:'color' };
  var body=img.slice(img.indexOf('(')+1, img.lastIndexOf(')')); var parts=body.split(/,(?![^(]*\\))/).map(function(x){return x.trim()});
  if(/^(to |\\d+deg)/.test(parts[0])) parts.shift();
  var stops=parts.map(function(p,i){ var c=rgb(p.slice(0,p.indexOf(')')+1)); var m=p.slice(p.indexOf(')')+1).match(/([\\d.]+)%/); return {c:c, pos: m? parseFloat(m[1])/100 : null}; });
  stops.forEach(function(s,i){ if(s.pos==null) s.pos = i===0?0:(i===stops.length-1?1:null); });
  for(var i=1;i<stops.length-1;i++) if(stops[i].pos==null){ var j=i; while(stops[j].pos==null) j++; for(var k=i;k<j;k++) stops[k].pos=stops[i-1].pos+(stops[j].pos-stops[i-1].pos)*(k-i+1)/(j-i+1); }
  function at(f){ for(var i=1;i<stops.length;i++){ if(f<=stops[i].pos){ var a=stops[i-1], b=stops[i], t=(f-a.pos)/((b.pos-a.pos)||1); return [0,1,2].map(function(k){return a.c[k]+(b.c[k]-a.c[k])*t}); } } return stops[stops.length-1].c; }
  var f1=(tr.top-r.top)/r.height, f2=(tr.bottom-r.top)/r.height;
  var worst=Math.min(cr(fg,at(Math.max(0,f1))), cr(fg,at((f1+f2)/2)), cr(fg,at(Math.min(1,f2))));
  return { ratio: worst, how:'gradient', fg: fg.slice(0,3), span:[+f1.toFixed(2), +f2.toFixed(2)] };
}`;
const CONTRAST_JS = `function(fg,bg){function L(c){var m=c.match(/\\d+(\\.\\d+)?/g).map(Number);function ch(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)}return 0.2126*ch(m[0])+0.7152*ch(m[1])+0.0722*ch(m[2])}var a=L(fg),b=L(bg);return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)}`;

/* ── 실제 입력(신뢰 이벤트 = 사용자 활성화) ── */
async function rectOf(P, expr) {
  return P.ev(`(async function(){var e=${expr}; if(!e) return null; if(e.scrollIntoView) e.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}); await new Promise(function(r){setTimeout(r,350)}); e=${expr}||e; if(e.scrollIntoView) e.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}); var r=e.getBoundingClientRect(); if(r.top<0||r.bottom>innerHeight) return {miss:1, offscreen:[Math.round(r.top),Math.round(r.bottom),innerHeight]}; if(!r.width||!r.height) return {miss:1, w:r.width, h:r.height, disp:getComputedStyle(e).display, html:e.outerHTML.slice(0,160)}; return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+Math.min(r.height/2, 14)), w:r.width, h:r.height}})()`);
}
async function mouseAt(P, x, y, button, shift) {
  const modifiers = shift ? 8 : 0;
  await P.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
  await P.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: button === "right" ? 2 : 1, clickCount: 1, modifiers });
  await P.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: 1, modifiers });
}
async function tap(P, expr) { let r = null; for (let i = 0; i < 6 && (!r || r.miss); i++) { await P.waitFor(expr, 15000); r = await rectOf(P, expr); if (!r || r.miss) await wait(400); } if (!r || r.miss) { console.log("    (tap 대상 없음) " + JSON.stringify(r)); return null; } await mouseAt(P, r.x, r.y, "left"); return r; }
async function key(P, k) {
  const code = { Escape: 27 }[k] || 0;
  await P.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: code });
  await P.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: code });
}
/** 브라우저가 시작한 뒤로(항목 하나 뒤) — Page.navigateToHistoryEntry. 건너뛰기 개입은 재현되지 않는다(머리말 한계). */
async function browserBack(P) {
  const h = await P.send("Page.getNavigationHistory");
  const prev = h.entries[h.currentIndex - 1];
  if (!prev) return false;
  P.send("Page.navigateToHistoryEntry", { entryId: prev.id }).catch(() => {});
  return true;
}
const CTX_PROBE = `(function(){ if (window.__ctxProbe) return 1; window.__ctxProbe = 1; window.__ctxLog = [];
  window.addEventListener('contextmenu', function(e){ var t=e.target; setTimeout(function(){ var pop=document.querySelector('.tree-pop');
    window.__ctxLog.push({ prevented: e.defaultPrevented, tag: t && t.tagName, title: pop ? (pop.querySelector('.tree-pop-title')||{}).textContent : null,
      items: pop ? pop.querySelectorAll('.tree-pop-item').length : 0, labels: pop ? [].slice.call(pop.querySelectorAll('.tree-pop-label')).map(function(x){return x.textContent}).slice(0,14) : [],
      foot: !!(pop && /Shift\\+우클릭/.test(pop.textContent)) }); }, 30); }, false); return 1; })()`;
async function rclick(P, name, expr, opts) {
  opts = opts || {};
  await P.evS(`window.__wm && __wm.UI && __wm.UI.closeTreeMenu && __wm.UI.closeTreeMenu(); 1`);
  const n0 = await P.ev(`(window.__ctxLog||[]).length`);
  let r = null;
  if (opts.at) r = opts.at; else r = await rectOf(P, expr);
  if (!r || r.miss) return { name, missing: true, diag: r };
  await mouseAt(P, r.x, r.y, "right", !!opts.shift);
  await wait(160);
  const log = await P.ev(`(window.__ctxLog||[]).slice(${n0})`);
  const last = log[log.length - 1] || null;
  return Object.assign({ name }, last || { none: true });
}

try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { const r = await fetch(BASE + "/"); up = !!r.status; } catch (e) {} if (!up) await wait(500); }
  if (!up) { console.log("FAIL wrangler 기동 실패\n" + wlog.slice(-1500)); process.exit(1); }

  const profile = path.join(TMP, "p144-chrome-" + Date.now());
  chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", "--user-data-dir=" + profile, "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
  let port = 0;
  for (let i = 0; i < 80 && !port; i++) { try { port = parseInt(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0], 10); } catch (e) {} if (!port) await wait(150); }
  let pageWs = null;
  for (let i = 0; i < 40 && !pageWs; i++) { try { const l = await getJson("http://127.0.0.1:" + port + "/json/list"); const pg = l.find((t) => t.type === "page"); if (pg) pageWs = pg.webSocketDebuggerUrl; } catch (e) {} if (!pageWs) await wait(250); }
  const P = await connect(pageWs);
  await P.send("Page.enable"); await P.send("Runtime.enable"); await P.send("DOM.enable"); await P.send("DOMDebugger.enable").catch(() => {});
  const dialogs = []; let dialogAccept = true;
  P.listeners.push((m) => {
    if (m.method !== "Page.javascriptDialogOpening") return;
    dialogs.push({ t: Date.now(), type: m.params.type, message: m.params.message });
    P.send("Page.handleJavaScriptDialog", { accept: dialogAccept }).catch(() => {});
  });
  await viewport(P, 1280, 900, false);

  const acc = JSON.parse(fs.readFileSync(path.join(TMP, "local-test-accounts.json"), "utf8")).accounts;
  const pw = (role) => acc.find((a) => a.role === role).password;
  const em = (role) => acc.find((a) => a.role === role).email;
  await P.send("Page.navigate", { url: BASE + "/manifest.webmanifest" });
  await P.waitFor("location.pathname === '/manifest.webmanifest'");
  const sTok = (await P.ev(`fetch("/api/signup/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:${JSON.stringify(em("super"))},password:${JSON.stringify(pw("super"))}})}).then(r=>r.json())`)).token;
  ok(!!sTok, "준비 — 로컬 super 로그인");
  // 요청함 행(우클릭 대상)용 결함 노트 1건
  const note = await P.ev(`fetch("/tables/deployments/dep_localseed_original",{headers:{Authorization:"Bearer "+${JSON.stringify(sTok)}}}).then(r=>r.json()).then(function(d){ var pin=JSON.parse(d.pins||"[]").find(function(p){return p.imageId});
    return fetch("/api/notes",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+${JSON.stringify(sTok)}},body:JSON.stringify({deployment_id:"dep_localseed_original",pin_id:String(pin.id),pin_label:pin.label,body:"p144 우클릭 대상 결함",kind:"note",status:"open"})}).then(function(r){return r.status}); })`);
  ok(note === 200 || note === 201, "준비 — 결함 노트 생성", note);
  await P.ev(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem("wm_local_token", ${JSON.stringify(sTok)}); localStorage.setItem("bg-force-guard","1"); 1`);

  const BG = `window.BackGuard`;
  const stackBg = () => P.ev(`${BG}._stack.map(function(s){return s.bg+(s.dk&&s.dk!=='o'?'#'+s.dk.slice(-6):'')})`);
  const settle = (ms) => wait(ms || 700);

  /* ══ A. 뒤로가기 ══ */
  console.log("\n[A0] 첫 화면 — 조작 전");
  await P.send("Page.navigate", { url: BASE + "/" });
  await P.waitFor(FIND_SEED_ORIGIN, 30000);
  await settle(800);
  await P.ev(CTX_PROBE);
  const pre = await P.ev(`({ has: !!${BG}, stack: ${BG}._stack.length, act: navigator.userActivation ? navigator.userActivation.hasBeenActive : null, hist: history.length, wd: navigator.webdriver })`);
  ok(pre.has && pre.stack === 0 && pre.act === false, "조작 전 = 가드 0개(사용자 활성화 없음) — 이 상태의 뒤로가기는 브라우저 표준대로 이탈(한계 기록)", pre);
  {
    const win = await P.send("Runtime.evaluate", { expression: "window" });
    const ls = await P.send("DOMDebugger.getEventListeners", { objectId: win.result.objectId });
    const bu = ls.listeners.filter((l) => l.type === "beforeunload");
    const ps = ls.listeners.filter((l) => l.type === "popstate");
    ok(bu.length === 1 && ps.length === 1, "beforeunload 1개(SoT = 58_BackGuard, 20_App 중복 0) · popstate 1개 등록", { beforeunload: bu.length, popstate: ps.length });
  }
  // 조작 전 새로고침 = 브라우저가 확인을 띄우지 않는다(사용자 활성화 없음 — Chrome 표준)
  {
    const d0 = dialogs.length;
    await P.ev(`window.__marker = 1; 1`);
    P.send("Page.reload", {}).catch(() => {});
    await P.waitFor(`!window.__marker && document.readyState === 'complete'`, 20000);
    ok(dialogs.length === d0, "[한계] 조작 전 새로고침 = 확인창 없음(브라우저가 활성화 없는 페이지의 beforeunload 를 무시)", dialogs.slice(d0));
    await P.waitFor(FIND_SEED_ORIGIN, 30000); await settle(800); await P.ev(CTX_PROBE);
  }

  console.log("\n[A1] 허브 → 프로젝트 → 구역 → 영역 → 360 (실제 마우스)");
  const r0 = await tap(P, FIND_SEED_ORIGIN);
  ok(!!r0, "허브 시드 원본 클릭(실제 입력)");
  await P.waitFor("document.querySelector('#screen-app.active') && __wm.Projects.decks && __wm.Projects.decks.length >= 3 && __wm.State.pins.length > 0", 30000);
  await settle(1500);
  console.log("    (진단) " + JSON.stringify(await P.evS(`({scr:(document.querySelector('.screen.active')||{}).id, proj:__wm.Projects.currentProject&&__wm.Projects.currentProject.id, decks:(__wm.Projects.decks||[]).length, pins:__wm.State.pins.length, snap:window.BackGuard.snapshot(), modal:[].slice.call(document.querySelectorAll('.admin-gate:not(.hidden)')).map(function(m){return m.id}), r0:${JSON.stringify(JSON.stringify(r0))}})`)));
  const s1 = await stackBg();
  ok(s1.length === 2 && s1[0] === "0" && s1[1] === "1", "첫 클릭 = 가드(허브 수준 0) + 프로젝트(1) 두 항목", s1);
  const treeNode = (re) => `[].slice.call(document.querySelectorAll('#side-tree .tree-node-deck, #side-tree .tree-node-region')).find(function(n){ return ${re}.test((n.querySelector('.tree-label')||{}).textContent||''); })`;
  ok(!!(await tap(P, treeNode("/^B구역/"))), "트리 B구역 클릭");
  await P.waitFor("__wm.Projects.currentDeck && /^B구역/.test(__wm.Projects.currentDeck.name)", 20000); await settle(1500);
  ok(!!(await tap(P, treeNode("/A구역-1영역/"))), "트리 A구역-1영역 클릭");
  await P.waitFor("__wm.Projects.currentDeck && /A구역-1영역/.test(__wm.Projects.currentDeck.name)", 20000); await settle(1500);
  // 360 — 시드 360 핀(imageId). 열기 = 기존 진입점 App.openPano(핀 탭과 같은 함수). 앞의 실제 클릭으로 활성화는 이미 있다.
  await P.ev(`(function(){ var p=__wm.State.pins.find(function(x){return x.imageId}); __wm.App.openPano(p); return 1 })()`);
  await P.waitFor("__wm.PanoViewer.open", 20000); await settle(900);
  const s2 = await stackBg();
  ok(s2.length === 5 && s2[2].indexOf("2#") === 0 && s2[3].indexOf("2#") === 0 && s2[2] !== s2[3] && s2[4].indexOf("3") === 0, "history = [허브0, 프로젝트1, B구역2, 영역2, 360 3] — 같은 깊이의 구역 이동도 한 칸", s2);
  const path0 = await P.ev("location.pathname + location.search");

  console.log("\n[A2] 뒤로(브라우저 시작) — 한 단계씩 앱 안");
  const step = async (label, cond, t) => { await browserBack(P); const ms = await P.waitFor(cond, t || 15000); await settle(900); return ms; };
  ok((await step("360 닫힘", "!__wm.PanoViewer.open && document.getElementById('pano-overlay').classList.contains('hidden')")) >= 0
    && /A구역-1영역/.test(await P.ev("__wm.Projects.currentDeck.name")), "뒤로 1 = 360 닫힘(영역 그대로)", await P.evS("({open:__wm.PanoViewer.open, deck:__wm.Projects.currentDeck&&__wm.Projects.currentDeck.name})"));
  ok((await step("B구역", "__wm.Projects.currentDeck && /^B구역/.test(__wm.Projects.currentDeck.name)")) >= 0, "뒤로 2 = 직전 구역(B구역)", await P.evS("__wm.Projects.currentDeck&&__wm.Projects.currentDeck.name"));
  ok((await step("원본", "window.BackGuard._deckKey() === 'o' && document.querySelector('#screen-app.active')")) >= 0, "뒤로 3 = 프로젝트 원본(메인 도면)", await P.evS("__wm.Projects.currentDeck&&__wm.Projects.currentDeck.name"));
  ok((await step("허브", "document.querySelector('#screen-projects.active')")) >= 0, "뒤로 4 = 프로젝트 목록(허브)", await P.evS("(document.querySelector('.screen.active')||{}).id"));
  const d1 = dialogs.length;
  await browserBack(P);
  const cf = await P.waitFor("document.querySelector('#wm-confirm-modal.on[data-confirm-kind=exit]')", 8000);
  await settle(400);
  const cinfo = await P.ev(`(function(){ var m=document.getElementById('wm-confirm-modal'), ok=document.getElementById('wm-confirm-ok'), ca=document.getElementById('wm-confirm-cancel'), cr=${CONTRAST_JS};
    var co=getComputedStyle(ok), cc=getComputedStyle(ca);
    return { title:(document.getElementById('wm-confirm-title')||{}).textContent, ok:ok.textContent, cancel:ca.textContent, focus:document.activeElement && document.activeElement.id,
      path: location.pathname + location.search, hub: !!document.querySelector('#screen-projects.active'), okC: (${TEXT_CONTRAST_JS})(ok), cancelC: (${TEXT_CONTRAST_JS})(ca) }; })()`);
  cinfo.cOk = cinfo.okC.ratio; cinfo.cCancel = cinfo.cancelC.ratio;
  ok(cf >= 0 && /정말 SEASTAR 360을 나가시겠습니까/.test(cinfo.title) && cinfo.ok === "나가기" && cinfo.cancel === "머무르기" && cinfo.focus === "wm-confirm-cancel",
    "뒤로 5(허브에서) = 앱 확인창 [머무르기][나가기] · 기본 포커스 머무르기", cinfo);
  ok(cinfo.path === path0 && cinfo.hub && dialogs.length === d1, "확인창 동안 URL·화면 그대로 · 브라우저 대화상자 0", { path: cinfo.path, path0, dialogs: dialogs.slice(d1) });
  ok(cinfo.cOk >= 4.5 && cinfo.cCancel >= 4.5, "확인창 버튼 대비 나가기 " + (cinfo.cOk || 0).toFixed(1) + ":1 · 머무르기 " + (cinfo.cCancel || 0).toFixed(1) + ":1 (≥4.5)");
  await shot(P, "1280-exit-confirm");
  await tap(P, "document.getElementById('wm-confirm-cancel')");
  await settle(900);
  const stay = await P.ev(`({ open: !!document.querySelector('#wm-confirm-modal.on'), path: location.pathname + location.search, hub: !!document.querySelector('#screen-projects.active'), stack: ${BG}._stack.length })`);
  ok(!stay.open && stay.path === path0 && stay.hub && stay.stack === 1, "머무르기 = 창 닫힘 · URL·허브 유지 · 가드 1개 재설치", stay);

  console.log("\n[A3] 다시 뒤로 → [나가기] = 그때만 이탈(확인창 1회 · 브라우저 대화상자 0)");
  await browserBack(P);
  ok((await P.waitFor("document.querySelector('#wm-confirm-modal.on[data-confirm-kind=exit]')", 8000)) >= 0, "재차 뒤로 = 확인창");
  await settle(300);
  const d2 = dialogs.length;
  await tap(P, "document.getElementById('wm-confirm-ok')");
  const left = await P.waitFor("location.pathname === '/manifest.webmanifest'", 10000);
  ok(left >= 0 && dialogs.length === d2, "나가기 = 직전 페이지로 실제 이탈 · beforeunload 대화상자 0(명시적 나가기)", { path: await P.evS("location.pathname"), dialogs: dialogs.slice(d2) });

  console.log("\n[A4] beforeunload — 조작 후 새로고침 = 브라우저 확인 · 앱이 시작한 이동 = 확인 없음");
  await P.send("Page.navigate", { url: BASE + "/" });
  await P.waitFor(FIND_SEED_ORIGIN, 30000); await settle(800);
  await tap(P, "document.querySelector('#screen-projects h1, #screen-projects .hub-title, #screen-projects header') || document.querySelector('#screen-projects')");
  await settle(400);
  await P.ev(`window.__marker = 2; 1`);
  dialogAccept = false;
  const d3 = dialogs.length;
  P.send("Page.reload", {}).catch(() => {});
  for (let i = 0; i < 40 && dialogs.length === d3; i++) await wait(100);
  await settle(600);
  const still = await P.evS(`window.__marker`);
  ok(dialogs.length > d3 && dialogs[d3].type === "beforeunload" && still === 2, "조작 후 새로고침 = 브라우저 '나가시겠습니까' 확인 → 취소 시 페이지 유지", { dialogs: dialogs.slice(d3).map((d) => d.type), marker: still });
  dialogAccept = true;
  const d4 = dialogs.length;
  await P.ev(`setTimeout(function(){ location.reload(); }, 0); 1`);
  await P.waitFor(`!window.__marker && document.readyState === 'complete'`, 20000);
  ok(dialogs.length === d4, "앱이 시작한 이동(location.reload — 로그아웃 등) = 확인 없이 통과", dialogs.slice(d4));

  /* ══ B. 우클릭 ══ */
  console.log("\n[B1] 허브 — 카드·빈 배경·선택 글자·Shift");
  await P.waitFor(FIND_SEED_ORIGIN, 30000); await settle(800); await P.ev(CTX_PROBE);
  const R = [];
  const seedCard = `(function(){var e=${FIND_SEED_ORIGIN}; return e && e.closest('.hub-card') && e.closest('.hub-card').querySelector('.hub-card-name')})()`;
  R.push(await rclick(P, "허브 카드", seedCard));
  await shot(P, "1280-hub-card-ctx");
  R.push(await rclick(P, "허브 빈 배경", null, { at: { x: 1260, y: 880 } }));
  // 선택한 글자 = 브라우저 메뉴(복사)
  await P.ev(`(function(){ var e=${seedCard}; var r=document.createRange(); r.selectNodeContents(e); var s=getSelection(); s.removeAllRanges(); s.addRange(r); return String(s).length })()`);
  const selR = await rclick(P, "선택한 글자", seedCard);
  await P.ev(`getSelection().removeAllRanges(); 1`);
  const shiftR = await rclick(P, "Shift+우클릭(허브 카드)", seedCard, { shift: true });

  console.log("\n[B2] 프로젝트 화면 — 상단바·트리·사이드 빈 곳·도면·핀·전체 기능·입력창·요청함·360");
  await tap(P, FIND_SEED_ORIGIN);
  await P.waitFor("document.querySelector('#screen-app.active') && __wm.State.pins.length > 0 && document.querySelector('.pin-marker')", 30000); await settle(1500);
  R.push(await rclick(P, "상단바", "document.getElementById('topbar-title') || document.querySelector('#topbar .topbar-title') || document.getElementById('topbar')"));
  R.push(await rclick(P, "사이드 트리 노드", treeNode("/^B구역/")));
  R.push(await rclick(P, "사이드바 빈 곳", null, { at: await P.ev(`(function(){ var s=document.getElementById('sidebar'); var r=s.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.bottom-6)} })()`) }));
  R.push(await rclick(P, "빈 도면", null, { at: await P.ev(`(function(){ var r=document.getElementById('map-viewport').getBoundingClientRect(); return {x:Math.round(r.left+r.width*0.88), y:Math.round(r.top+r.height*0.12)} })()`) }));
  R.push(await rclick(P, "핀", "document.querySelector('.pin-marker[data-id]')"));
  await shot(P, "1280-pin-ctx");
  await P.evS(`__wm.UI.closeTreeMenu(); 1`);
  await tap(P, "document.getElementById('btn-feature-menu')");
  await P.waitFor("document.querySelector('#feature-menu:not(.hidden)')", 5000); await settle(300);
  R.push(await rclick(P, "전체 기능 패널(모달)", "document.querySelector('#feature-menu .fm-title')"));
  const inputR = await rclick(P, "입력창(기능 검색)", "document.querySelector('#feature-menu .fm-search')");
  await P.evS(`__wm.UI.closeTreeMenu(); __wm.FeatureMenu.close(); 1`);
  await settle(500);
  await P.ev(`__wm.Requests.openInbox(); 1`);
  await P.ev(`(function(){ var b=document.querySelector('[data-req-filter=all]'); if(b) b.click(); var t=document.querySelector('[data-req-tab=note]'); if(t) t.click(); return 1 })()`);
  await P.waitFor("document.querySelector('[data-req-item]')", 10000); await settle(300);
  R.push(await rclick(P, "요청함·결함 행", "document.querySelector('[data-req-item]')"));
  await shot(P, "1280-request-ctx");
  await P.evS(`__wm.UI.closeTreeMenu(); __wm.Requests.closePanel(); 1`);
  await settle(500);
  await P.ev(`(function(){ var p=__wm.State.pins.find(function(x){return x.imageId}); __wm.App.openPano(p); return 1 })()`);
  await P.waitFor("__wm.PanoViewer.open", 20000); await settle(1200);
  R.push(await rclick(P, "360 뷰어", null, { at: { x: 640, y: 420 } }));
  await shot(P, "1280-pano-ctx");
  await P.evS(`__wm.UI.closeTreeMenu(); 1`);
  const mapShift = await rclick(P, "Shift+우클릭(360)", null, { at: { x: 640, y: 420 }, shift: true });
  await P.evS(`__wm.UI.closeTreeMenu(); __wm.PanoViewer.close(); 1`);
  await settle(1200);
  R.push(await rclick(P, "도면 툴바 버튼", "document.querySelector('#pdf-toolbar:not(.hidden) button, #zone-pager button, #topbar button')"));
  await shot(P, "1280-page-ctx");
  await P.evS(`__wm.UI.closeTreeMenu(); 1`);

  const appMenus = R.filter((r) => r.prevented && r.items > 0 && r.foot);
  console.log("    대상별: " + R.map((r) => r.name + "=" + (r.missing ? "요소없음" : (r.prevented ? "앱" + r.items : "브라우저"))).join(" · "));
  ok(appMenus.length >= 10 && appMenus.length === R.length, "앱 메뉴 대상 " + appMenus.length + "/" + R.length + "곳 — 전부 preventDefault + 항목 + 하단 'Shift+우클릭' 안내(≥10)", R.filter((r) => !(r.prevented && r.items > 0 && r.foot)));
  const byName = (n) => R.find((r) => r.name === n) || {};
  ok(["열기", "프로젝트 정보", "멤버 관리", "오프라인 보관(다운로드)", "프로젝트 삭제"].every((l) => (byName("허브 카드").labels || []).includes(l)), "허브 카드 = 열기·정보·멤버·다운로드·삭제 …", byName("허브 카드").labels);
  ok(["360 안에 마커 추가", "AI 사진 분석", "사진 이력(재방선)", "360 전체화면"].every((l) => (byName("360 뷰어").labels || []).includes(l)), "360 뷰어 = 마커·AI 분석·사진 이력·전체화면 …(전체 기능 SoT)", byName("360 뷰어").labels);
  ok((byName("요청함·결함 행").labels || []).some((l) => /^열기/.test(l)) && (byName("요청함·결함 행").labels || []).some((l) => /상태/.test(l)), "요청함 행 = 열기·상태 변경 …", byName("요청함·결함 행").labels);
  ok((byName("상단바").labels || []).includes("뒤로(이전 화면)") && (byName("상단바").labels || []).includes("화면 맞춤"), "상단바 = [뒤로]·도면(화면) 맞춤 … · 새로고침 항목 없음", byName("상단바").labels);
  ok(selR.prevented === false && !selR.items, "선택한 글자 우클릭 = 브라우저 메뉴(복사)", selR);
  ok(inputR.prevented === false && !inputR.items, "입력창 우클릭 = 브라우저 메뉴(붙여넣기)", inputR);
  ok(shiftR.prevented === false && mapShift.prevented === false, "Shift+우클릭 = 브라우저 메뉴(탈출구)", [shiftR, mapShift]);

  console.log("\n[B3] 375 모바일(브라우저) — 설치 게이트 위에서 뒤로 = 확인창이 게이트 위로");
  const touchTap = async (expr) => { let r = null; for (let i = 0; i < 6 && (!r || r.miss); i++) { r = await rectOf(P, expr); if (!r || r.miss) await wait(400); } if (!r || r.miss) return null;
    await P.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: r.x, y: r.y }] });
    await P.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); return r; };
  await viewport(P, 375, 812, true);
  await P.send("Page.navigate", { url: BASE + "/" });
  await P.waitFor("window.__wm && document.readyState === 'complete'", 30000); await settle(2500);
  const gateUp = await P.ev(`(function(){ var g=document.getElementById('install-gate'); return !!(g && g.getClientRects().length && !g.classList.contains('hidden')) })()`);
  console.log("    (참고) 375 브라우저 설치 게이트 표시 = " + gateUp);
  if (gateUp) {
    await touchTap("document.querySelector('#install-gate h2') || document.getElementById('install-gate')");
    await settle(600);
    ok((await P.ev(`${BG}._stack.length`)) === 1, "375 게이트 첫 탭 = 가드 설치");
    await browserBack(P);
    const gcf = await P.waitFor("document.querySelector('#wm-confirm-modal.on[data-confirm-kind=exit]')", 8000);
    await settle(500);
    const top = await P.ev(`(function(){ var c=document.getElementById('wm-confirm-cancel'), r=c.getBoundingClientRect(), hit=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
      return { hit: hit && (hit.id || hit.className), inert: document.getElementById('wm-confirm-modal').hasAttribute('inert'), focus: document.activeElement && document.activeElement.id } })()`);
    ok(gcf >= 0 && top.hit === "wm-confirm-cancel" && !top.inert, "게이트 위 뒤로 = 확인창이 게이트 위(가려짐·inert 0)", top);
    await shot(P, "375-exit-confirm-over-installgate");
    await touchTap("document.getElementById('wm-confirm-cancel')");
    await settle(800);
    ok(!(await P.ev(`!!document.querySelector('#wm-confirm-modal.on')`)) && (await P.ev(`${BG}._stack.length`)) === 1, "게이트 위 머무르기 = 유지 + 가드 재설치");
  }

  console.log("\n[B4] 375 설치된 앱(standalone) — 길게 누르기 = 앱 메뉴 · 허브 뒤로 확인창");
  await P.send("Page.addScriptToEvaluateOnNewDocument", { source: `(function(){ var realMM = window.matchMedia.bind(window);
    window.matchMedia = function (q) { if (typeof q === "string" && q.indexOf("display-mode: standalone") >= 0) return { matches: true, media: q, onchange: null, addListener: function(){}, removeListener: function(){}, addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){ return true; } }; return realMM(q); }; })();` });
  await P.send("Page.navigate", { url: BASE + "/" });
  await P.waitFor(FIND_SEED_ORIGIN, 30000); await settle(1500); await P.ev(CTX_PROBE);
  const lr = await rectOf(P, seedCard);
  await P.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: lr.x, y: lr.y }] });
  await wait(900);
  await P.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await settle(400);
  const lp = await P.ev(`(function(){ var p=document.querySelector('.tree-pop'); return { open: !!p, items: p ? p.querySelectorAll('.tree-pop-item').length : 0, title: p ? (p.querySelector('.tree-pop-title')||{}).textContent : null, foot: !!(p && /Shift/.test(p.textContent)) } })()`);
  ok(lp.open && lp.items >= 8 && /^프로젝트 /.test(lp.title || ""), "375 허브 카드 길게 누르기 = 그 카드의 앱 메뉴", lp);
  await shot(P, "375-hub-longpress");
  await P.evS(`__wm.UI.closeTreeMenu(); 1`);
  await touchTap("document.querySelector('#screen-projects h1, #screen-projects .hub-title, #screen-projects header') || document.querySelector('#screen-projects')");
  await settle(600);
  ok((await P.ev(`${BG}._stack.length`)) === 1, "375 첫 탭 = 가드 설치");
  await browserBack(P);
  const mcf = await P.waitFor("document.querySelector('#wm-confirm-modal.on[data-confirm-kind=exit]')", 8000);
  await settle(400);
  ok(mcf >= 0, "375 허브 뒤로 = 앱 확인창");
  await shot(P, "375-exit-confirm");
  await touchTap("document.getElementById('wm-confirm-cancel')");
  await settle(800);
  ok(!(await P.ev(`!!document.querySelector('#wm-confirm-modal.on')`)) && (await P.ev(`${BG}._stack.length`)) === 1, "375 머무르기 = 유지 + 가드 재설치");

  // 공개 API(안드로이드 앱 backButton) — 허브 = 확인창, 머무르기
  const hb = await P.ev(`${BG}.handleBack()`);
  ok(hb === "history" || hb === "confirm", "BackGuard.handleBack() 공개 API(Capacitor backButton 용) 동작", hb);
  await P.waitFor("document.querySelector('#wm-confirm-modal.on[data-confirm-kind=exit]')", 8000);
  await P.ev(`document.getElementById('wm-confirm-cancel').click(); 1`);

  ok(P.errs.length === 0, "앱 콘솔 예외 0", P.errs);
} catch (e) {
  console.log("FAIL 예외: " + (e && e.stack || e));
  failed++;
} finally {
  await cleanup();
}
console.log("\n" + (failed ? "FAIL " + failed : "ALL PASS") + " — 산출물 " + OUT);
process.exit(failed ? 1 : 0);
