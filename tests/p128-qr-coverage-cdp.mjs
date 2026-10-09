/**
 * p128-cdp — WO 20261007-qrcov 실 Chrome 실측(목 0): QR 딥링크 → 로그인 게이트 → 로그인 후 해당 핀 팝업,
 *   권한(뷰어 계정=기존 접근 게이트, ?d= 열람 링크 우회 0, 없는 프로젝트=사유), QR 인쇄 창 실제 DOM(칸 수),
 *   촬영 현황 오버레이·범례·트리 배지·전체 포인트 요약·CHECKER 비활성 + 계산 대비(getComputedStyle).
 * 실행: P128=1 TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p128-qr-coverage-cdp.mjs   (P128 != "1" 이면 SKIP)
 * 사전: .tmp/localdev-state (node build-tools/local-dev.mjs && node build-tools/seed-local.mjs) — 이 테스트는
 *   그 사본(.tmp/fixqr/state)만 쓴다(원본 불변). 빌드도 격리 사본(.tmp/fixqr/work)에서 — 작업트리의 번들·미러를 건드리지 않는다.
 * 스크린샷: .tmp/fixqr/*.png (375 · 1280)
 */
import { execSync, spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { fileURLToPath } from "node:url";

if (process.env.P128 !== "1") { console.log("[SKIP] p128-cdp 는 P128=1 일 때만 실행"); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = path.join(ROOT, ".tmp");
const OUT = path.join(TMP, "fixqr");
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

// ── ① 격리 빌드: 작업트리 소스 → WORK (assemble 은 WORK 안에서) ──
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
for (const f of ["public", "src"]) fs.cpSync(path.join(ROOT, f), path.join(WORK, f), { recursive: true, filter: (s) => !/[\\/]public[\\/]js[\\/]main\.js$/.test(s) });
for (const f of ["vite.config.ts", "package.json", "tsconfig.json", "wrangler.jsonc"]) fs.copyFileSync(path.join(ROOT, f), path.join(WORK, f));
const man = fs.readFileSync(path.join(WORK, "public/js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
fs.writeFileSync(path.join(WORK, "public/js/main.js"), man.map((f) => fs.readFileSync(path.join(WORK, "public/js/modules", f), "utf8")).join("\n"));
const env = { ...process.env, TEMP: TMP, TMP: TMP };
execSync(`node --max-old-space-size=640 "${path.join(NODE_MODULES, "vite/bin/vite.js")}" build`, { cwd: WORK, env, stdio: "inherit" });
fs.rmSync(STATE, { recursive: true, force: true });
fs.cpSync(STATE_SRC, STATE, { recursive: true });

const PORT = process.env.P128_PORT || "18828";
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
  // 평가 중 페이지가 새로고침되면 응답이 오지 않는다 → 20초 상한(무한 대기 금지)
  const ev = async (expr) => { const r = await Promise.race([send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }), wait(20000).then(() => { throw new Error("evaluate 20s 무응답(페이지 재시작?)"); })]); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
  const evS = async (e) => { try { return await ev(e); } catch (x) { return { __err: String(x.message).slice(0, 200) }; } };
  const waitFor = async (cond, t = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if ((await evS("(function(){try{return !!(" + cond + ")}catch(e){return false}})()")) === true) return Date.now() - t0; await wait(150); } return -1; };
  return { ws, send, ev, evS, waitFor, errs };
}
let shotN = 0;
async function shot(P, name) { const s = await P.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, String(++shotN).padStart(2, "0") + "-" + name + ".png"), Buffer.from(s.data, "base64")); }
async function viewport(P, w, h, mobile) { await P.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile: !!mobile }); }

/* 대비(WCAG) — 브라우저가 계산한 rgb 문자열 둘 */
const CONTRAST_JS = `function(fg,bg){function L(c){var m=c.match(/\\d+(\\.\\d+)?/g).map(Number);function ch(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)}return 0.2126*ch(m[0])+0.7152*ch(m[1])+0.0722*ch(m[2])}var a=L(fg),b=L(bg);return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)}`;

try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { const r = await fetch(BASE + "/"); up = !!r.status; } catch (e) {} if (!up) await wait(500); }
  if (!up) { console.log("FAIL wrangler 기동 실패\n" + wlog.slice(-1500)); process.exit(1); }

  const profile = path.join(TMP, "p128-chrome-" + Date.now());
  chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--disable-popup-blocking", "--remote-debugging-port=0", "--user-data-dir=" + profile, "--window-size=1280,800", "about:blank"], { stdio: "ignore" });
  let port = 0;
  for (let i = 0; i < 80 && !port; i++) { try { port = parseInt(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0], 10); } catch (e) {} if (!port) await wait(150); }
  let pageWs = null;
  for (let i = 0; i < 40 && !pageWs; i++) { try { const l = await getJson("http://127.0.0.1:" + port + "/json/list"); const pg = l.find((t) => t.type === "page"); if (pg) pageWs = pg.webSocketDebuggerUrl; } catch (e) {} if (!pageWs) await wait(250); }
  const P = await connect(pageWs);
  await P.send("Page.enable"); await P.send("Runtime.enable");
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
  const login = (role) => P.ev(`fetch("/api/signup/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:${JSON.stringify(em(role))},password:${JSON.stringify(pw(role))}})}).then(r=>r.json())`);
  const dTok = (await login("designer")).token;
  ok(!!dTok, "준비 — 로컬 디자이너 로그인 토큰");
  // 대상: 크롭 구역(B구역) + 그 크롭 안 CHECKER 핀 1개
  const target = await P.ev(`(async()=>{const h={Authorization:"Bearer "+${JSON.stringify(dTok)}};
    const ds=(await (await fetch("/api/projects/proj_localseed/decks",{headers:h})).json()).data||[];
    const deck=ds.find(d=>d.crop&&d.crop.w>0); const dep=await (await fetch("/tables/deployments/"+deck.deployment_id,{headers:h})).json();
    const pins=Array.isArray(dep.pins)?dep.pins:JSON.parse(dep.pins||"[]"); const c=deck.crop;
    const pin=pins.find(p=>p.checkboard&&(p.page||1)===(deck.page||1)&&p.x>=c.x&&p.x<=c.x+c.w&&p.y>=c.y&&p.y<=c.y+c.h);
    return {deck:deck.id, deckName:deck.name, dep:deck.deployment_id, pin:pin&&pin.id, pinLabel:pin&&pin.label};})()`);
  ok(!!(target && target.deck && target.pin), "준비 — 크롭 구역·그 안의 핀 확보", target);
  const DL = BASE + "/?qp=proj_localseed&qk=" + encodeURIComponent(target.deck) + "&qpin=" + encodeURIComponent(target.pin);

  // SW 선설치 — 첫 방문은 SW 가 제어권을 잡으며 1회 새로고침한다(index.html controllerchange). 시나리오 도중 재시작 방지.
  await P.send("Page.navigate", { url: BASE + "/" });
  ok(await P.waitFor("navigator.serviceWorker && navigator.serviceWorker.controller", 30000) >= 0, "준비 — 서비스워커 제어 상태");
  await wait(1500);

  /* ── 1. 비로그인 딥링크 → 로그인 게이트(진입 0) ── */
  await P.ev("localStorage.clear(); sessionStorage.clear(); 1");
  await P.send("Page.navigate", { url: DL });
  ok(await P.waitFor("document.querySelector('#login-gate') && !document.querySelector('#login-gate').classList.contains('hidden')", 20000) >= 0, "1 비로그인 QR → 로그인 게이트 표시");
  await wait(1200);
  const pre = await P.ev(`({pop: !document.getElementById('pin-action-pop').classList.contains('hidden'), app: !!document.querySelector('#screen-app.active'), pend: !!sessionStorage.getItem('wm_pending_deeplink'), q: location.search})`);
  ok(!pre.pop && !pre.app && pre.pend && /qpin=/.test(pre.q), "1 🔴 로그인 전 프로젝트·팝업 노출 0, 딥링크 보류", pre);
  await shot(P, "375-1-qr-login-gate");

  /* ── 2. 로그인(회사 이메일 로그인 완료 경로 그대로) → 원래 딥링크 복귀 → 핀 팝업 ── */
  await P.ev(`window.__wm.CompanyAuth._onAuthed(${JSON.stringify(dTok)}, "디자이너", {email:${JSON.stringify(em("designer"))}, name:"디자이너", role:"designer"}); 1`);
  const tPop = await P.waitFor(`!document.getElementById('pin-action-pop').classList.contains('hidden') && window.__wm.PinActionPop._pinId == ${JSON.stringify(target.pin)}`, 30000);
  ok(tPop >= 0, "2 로그인 후 QR 핀 팝업 자동 열림 (" + tPop + "ms)");
  const st = await P.ev(`({deck: window.__wm.Projects.currentDeck && window.__wm.Projects.currentDeck.id, active: window.__wm.State.activePin, q: location.search, mode: window.__wm.State.regMode, title: document.getElementById('pap-title').textContent, placing: window.__wm.State.placing, focused: !!document.querySelector('.pin-marker.focused[data-id="${target.pin}"]')})`);
  ok(st.deck === target.deck && String(st.active) === String(target.pin) && st.focused, "2 해당 구역·핀 강조(.focused) " + JSON.stringify(st));
  ok(/qpin=/.test(st.q) && !st.placing, "2 주소 유지 · 배치모드 꺼짐");
  await shot(P, "375-2-qr-deeplink-pin-popup");
  // SW 갱신 새로고침(배포 직후 실사용 경로)과 같은 재시작 → 같은 핀으로 복귀해야 한다
  await P.send("Page.reload", {});
  const tRe = await P.waitFor(`window.__wm && !document.getElementById('pin-action-pop').classList.contains('hidden') && window.__wm.PinActionPop._pinId == ${JSON.stringify(target.pin)}`, 30000);
  ok(tRe >= 0, "2 새로고침(SW 갱신 재시작) 후에도 같은 핀 팝업 (" + tRe + "ms)");

  /* ── 3. QR 인쇄 — 실제 인쇄 창 DOM ── */
  await P.ev(`(function(){var o=window.open;window.open=function(){var w=o.apply(window,arguments);window.__qrWin=w;return w;};return 1})()`);
  const hasBtn = await P.ev(`!!document.getElementById('pap-qr')`);
  ok(hasBtn, "3 핀 팝업 [QR] 버튼 존재");
  const btnBox = await P.ev(`(function(){var a=document.getElementById('pap-qr').getBoundingClientRect(),r=document.querySelector('#pin-action-pop .pap-actions').getBoundingClientRect();return {w:a.width,h:a.height,inRow:a.left>=r.left-1&&a.right<=r.right+1, vw:innerWidth, right:a.right}})()`);
  ok(btnBox.w >= 32 && btnBox.h >= 32 && btnBox.inRow && btnBox.right <= btnBox.vw, "3 [QR] 버튼 375 화면 안·행 안(잘림 0) " + JSON.stringify(btnBox));
  await P.ev(`document.getElementById('pap-qr').click(); 1`);
  ok(await P.waitFor(`window.__qrWin && window.__qrWin.document && window.__qrWin.document.querySelectorAll('.qr-cell').length === 1`, 15000) >= 0, "3 핀 [QR] → 인쇄 창 1칸");
  const one = await P.ev(`(function(){var d=window.__qrWin.document;return {svg:d.querySelectorAll('.qr-cell svg path').length, no:d.querySelector('.qr-no').textContent, alt:(d.querySelector('svg description')||{}).textContent||''}})()`);
  ok(one.svg === 1 && /qpin=/.test(one.alt) && one.alt.indexOf(BASE) === 0, "3 QR 내용 = 지금 접속 주소 기반 딥링크 " + JSON.stringify(one));
  await P.ev(`window.__qrWin.close(); window.__qrWin=null; 1`);
  // 구역 ⋯ → [이 구역 QR 일괄 인쇄]
  await P.ev(`window.__wm.PinActionPop.close(); 1`);
  await viewport(P, 1280, 800, false);
  await wait(500);
  const expectPins = await P.ev(`window.__wm.Projects.pinsForDeck(window.__wm.State.pins, window.__wm.Projects.currentDeck).length`);
  const menuOk = await P.ev(`(function(){var heads=[].slice.call(document.querySelectorAll('.tree-node-deck,.tree-node-region'));var h=heads.find(function(x){return x.classList.contains('active')});if(!h)return 'no-head';h.querySelector('.tree-more').click();var it=[].slice.call(document.querySelectorAll('.tree-pop-item')).find(function(b){return /QR 일괄/.test(b.textContent)});if(!it)return 'no-item';if(it.getAttribute('aria-disabled')==='true')return 'disabled:'+it.textContent;it.click();return 'clicked'})()`);
  ok(menuOk === "clicked", "3 구역 ⋯ 메뉴 [이 구역 QR 일괄 인쇄] 활성·클릭", menuOk);
  ok(await P.waitFor(`window.__qrWin && window.__qrWin.document && window.__qrWin.document.querySelectorAll('.qr-cell').length === ${expectPins + 1}`, 15000) >= 0, "3 일괄 인쇄 칸 = 구역 1 + 핀 " + expectPins);
  // 인쇄 창 스크린샷(별도 타깃)
  try {
    const l = await getJson("http://127.0.0.1:" + port + "/json/list");
    const pop = l.find((t) => t.type === "page" && t.webSocketDebuggerUrl !== pageWs);
    if (pop) { const Q = await connect(pop.webSocketDebuggerUrl); await Q.send("Page.enable"); await viewport(Q, 1280, 900, false); await wait(300); await shot(Q, "1280-3-qr-print-sheet"); await viewport(Q, 375, 812, true); await wait(300); await shot(Q, "375-3-qr-print-sheet"); }
  } catch (e) { console.log("  INFO 인쇄 창 스크린샷 실패: " + e.message); }
  await P.ev(`window.__qrWin.close(); 1`);

  /* ── 4. 촬영 현황 — 360 모드, 오버레이·범례·트리 배지·요약, 대비 ── */
  // 원본(루트) 구역으로 — 360 시드 핀은 B구역 크롭 밖에 있다(요약 범위 = 지금 구역, Projects.pinsForDeck)
  await P.ev(`window.__wm.Projects.openOriginal(); 1`);
  await P.waitFor(`window.__wm.Projects.currentDeck && !(window.__wm.Projects.currentDeck.crop && window.__wm.Projects.currentDeck.crop.w > 0) && document.querySelectorAll('.pin-marker').length > 0`, 20000);
  await wait(800);
  await P.ev(`document.getElementById('btn-regmode-photo').click(); 1`);
  await wait(400);
  await P.ev(`(function(){var W=window.__wm,S=W.State;if(S.placing)W.App._togglePlacing();var now=Date.now(),D=86400000;var c=S.pins.filter(function(p){return !p.checkboard});
    if(c[0])c[0].shotAt=now-2*D; if(c[1])c[1].shotAt=now-20*D; W.addPin({x:62,y:40,page:1,label:'미촬영 테스트'}); return c.length})()`);
  const covBtn = await P.waitFor(`document.getElementById('cov-toggle') && document.getElementById('cov-toggle').getAttribute('aria-disabled')!=='true'`, 8000);
  ok(covBtn >= 0, "4 360 모드 — [◔ 촬영 현황] 토글 활성(필터 바)");
  const offState = await P.ev(`({badges: document.querySelectorAll('.cov-badge').length, pressed: document.getElementById('cov-toggle').getAttribute('aria-pressed')})`);
  ok(offState.badges === 0 && offState.pressed === "false", "4 기본 끔 — 배지 0", offState);
  await P.ev(`document.getElementById('cov-toggle').click(); 1`);
  await wait(300);
  const cov = await P.ev(`(function(){var C=${CONTRAST_JS};var ms=[].slice.call(document.querySelectorAll('#pins-layer .pin-marker[data-cov]'));var by={};ms.forEach(function(m){by[m.dataset.cov]=(by[m.dataset.cov]||0)+1});
    var vis=ms.every(function(m){var s=getComputedStyle(m);return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0.5});
    var cr=[].slice.call(document.querySelectorAll('.cov-badge')).map(function(b){var s=getComputedStyle(b);return Math.round(C(s.color,s.backgroundColor)*10)/10});
    var lg=[].slice.call(document.querySelectorAll('.cov-legend')).map(function(b){var s=getComputedStyle(b);return Math.round(C(s.color,s.backgroundColor)*10)/10});
    var tb=document.querySelector('.tree-cov-badge');var tbc=tb?(function(s){return Math.round(C(s.color,s.backgroundColor)*10)/10})(getComputedStyle(tb)):0;
    var glyphs={};[].slice.call(document.querySelectorAll('.cov-badge')).forEach(function(b){glyphs[b.className]=b.textContent});
    var chk=[].slice.call(document.querySelectorAll('#pins-layer .pin-marker.pin-mode-checker[data-cov]')).length;
    return {by:by,vis:vis,cr:cr,lg:lg,tree:tb?tb.textContent:null,tbc:tbc,glyphs:glyphs,chk:chk,legendN:document.querySelectorAll('.cov-legend').length}})()`);
  ok(cov.by.fresh >= 1 && cov.by.stale >= 1 && cov.by.none >= 1, "4 핀 분류 최신·오래됨·미촬영 " + JSON.stringify(cov.by));
  ok(cov.vis && cov.chk === 0, "4 🔴 숨김 0(표시만 덧입힘) · CHECKER 핀 미대상");
  ok(cov.cr.length > 0 && cov.cr.every((x) => x >= 4.5), "4 배지 글리프 대비 ≥4.5 " + JSON.stringify(cov.cr));
  ok(cov.legendN === 4 && cov.lg.every((x) => x >= 4.5), "4 범례 칩 4종 대비 ≥4.5 " + JSON.stringify(cov.lg));
  ok(Object.keys(cov.glyphs).length >= 3 && new Set(Object.values(cov.glyphs)).size >= 3, "4 상태별 글리프 다름(색만 아님) " + JSON.stringify(cov.glyphs));
  ok(!!cov.tree && cov.tbc >= 4.5, "4 트리 구역 배지 " + cov.tree + " 대비 " + cov.tbc);
  // 트리 배지 = 구역별 SoT(Projects.pinsForDeck) — 크롭 구역은 그 크롭 안 360 핀만
  const perDeck = await P.ev(`(function(){var W=window.__wm;return (W.Projects.decks||[]).map(function(d){var s=W.Coverage.deckSummary(d);
    var head=[].slice.call(document.querySelectorAll('.tree-node-deck,.tree-node-region')).find(function(h){return (h.title||'').split(String.fromCharCode(10))[0]===(d.name||'(이름 없음)')});
    var b=head&&head.querySelector('.tree-cov-badge');return {name:d.name,crop:!!(d.crop&&d.crop.w>0),none:s&&s.none,stale:s&&s.stale,badge:b?b.textContent:''}})})()`);
  ok(perDeck.length >= 2 && perDeck.every((d) => (d.none || d.stale) ? d.badge === "✕" + d.none + "!" + d.stale || d.badge.replace(/\s/g, "") === (d.none ? "✕" + d.none : "") + (d.stale ? "!" + d.stale : "") : d.badge === ""), "4 트리 배지 = 구역별 집계(크롭 구역은 크롭 안만) " + JSON.stringify(perDeck));
  await shot(P, "1280-4-coverage-on");
  await P.ev(`document.getElementById('cov-toggle') && window.__wm.AllPins.show(); 1`);
  await wait(500);
  const sum = await P.ev(`(function(){var e=document.getElementById('allpins-cov');if(!e)return null;var C=${CONTRAST_JS};var s=getComputedStyle(e);return {t:e.textContent,c:Math.round(C(s.color,s.backgroundColor)*10)/10}})()`);
  ok(!!sum && /미촬영 [1-9]/.test(sum.t) && /오래됨 [1-9]/.test(sum.t) && /최신 [1-9]/.test(sum.t) && sum.c >= 4.5, "4 전체 포인트 패널 요약(지도와 같은 분류) " + JSON.stringify(sum));
  await shot(P, "1280-4b-coverage-allpins");
  await P.ev(`window.__wm.AllPins.hide(); 1`);
  await viewport(P, 375, 812, true);
  await wait(500);
  await shot(P, "375-4-coverage-on");
  const mob = await P.ev(`(function(){var bar=document.getElementById('pin-filter-bar');var r=bar.getBoundingClientRect();
    var kids=[].slice.call(bar.querySelectorAll('.zpager-tab,#cov-toggle'));var covered=kids.filter(function(k){var b=k.getBoundingClientRect();var e=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);return !(e&&(e===k||k.contains(e)))}).map(function(k){return k.id||k.className});
    var lg=document.getElementById('cov-legend');var lr=lg&&lg.getBoundingClientRect();
    var lgCovered=lg?[].slice.call(lg.querySelectorAll('.cov-legend')).filter(function(c){lg.style.pointerEvents='auto';var b=c.getBoundingClientRect();var e=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);lg.style.pointerEvents='none';return !(e&&(e===c||c.contains(e)))}).length:-1;var tb=document.querySelector('#topbar');var tr=tb?tb.getBoundingClientRect():{bottom:0};
    return {h:Math.round(r.height),covered:covered,lgCovered:lgCovered,legend:lg?lg.querySelectorAll('.cov-legend').length:0,legendTop:lr?Math.round(lr.top):null,legendBottom:lr?Math.round(lr.bottom):null,barTop:Math.round(r.top)}})()`);
  ok(mob.h <= 52 && mob.covered.length === 0, "4 375 — 칩 바 한 줄 유지·FAB 에 가린 칩 0 " + JSON.stringify(mob));
  ok(mob.legend === 4 && mob.legendBottom < mob.barTop && mob.lgCovered === 0, "4 375 — 범례는 지도 상단 별도 줄(칩 바와 분리)·다른 컨트롤에 가린 칩 0");
  // CHECKER → 비활성 + 사유, 배지 사라짐
  await P.ev(`document.getElementById('btn-regmode-checkboard').click(); 1`);
  await wait(500);
  await P.ev(`(function(){var W=window.__wm;if(W.State.placing)W.App._togglePlacing();return 1})()`);
  const ck = await P.ev(`(function(){var t=document.getElementById('cov-toggle');return {dis:t&&t.getAttribute('aria-disabled'),txt:t&&t.textContent,title:t&&t.title,badges:document.querySelectorAll('.cov-badge').length}})()`);
  ok(ck.dis === "true" && /360 전용/.test(ck.txt) && /CHECKER/.test(ck.title) && ck.badges === 0, "4 CHECKER — 토글 비활성 + 사유 표시, 오버레이 0 " + JSON.stringify(ck));
  await shot(P, "375-4b-coverage-checker-disabled");
  await viewport(P, 1280, 800, false); await wait(400);
  await shot(P, "1280-4c-coverage-checker-disabled");

  /* ── 5. 뷰어 계정(비디자이너) 딥링크 → 기존 접근 게이트, 팝업 0 ── */
  const vTok = (await P.ev(`fetch("/api/signup/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:${JSON.stringify(em("viewer"))},password:${JSON.stringify(pw("viewer"))}})}).then(r=>r.json())`)).token;
  await P.ev("localStorage.clear(); sessionStorage.clear(); 1");
  await P.send("Page.navigate", { url: DL });
  await P.waitFor("document.querySelector('#login-gate') && !document.querySelector('#login-gate').classList.contains('hidden')", 20000);
  await P.ev(`window.__wm.CompanyAuth._onAuthed(${JSON.stringify(vTok)}, "뷰어", {email:${JSON.stringify(em("viewer"))}, name:"뷰어", role:"viewer"}); 1`);
  const gateMs = await P.waitFor("!document.getElementById('access-gate').classList.contains('hidden')", 20000);
  await wait(1500);
  const vs = await P.ev(`({pop: !document.getElementById('pin-action-pop').classList.contains('hidden'), active: window.__wm.State.activePin, designer: window.__wm.Auth.isDesigner})`);
  ok(gateMs >= 0 && !vs.pop && !vs.designer, "5 🔴 뷰어 계정 QR → 기존 권한 게이트(사용 신청), 핀 팝업 0 " + JSON.stringify(vs));
  await shot(P, "375-5-qr-viewer-gated");

  /* ── 6. ?d= 열람 링크 + 딥링크 파라미터 → 열람 경로 그대로(딥링크 우회 0) ── */
  await P.ev("localStorage.clear(); sessionStorage.clear(); 1");
  await P.send("Page.navigate", { url: BASE + "/?d=" + encodeURIComponent(target.dep) + "&qp=proj_localseed&qk=" + encodeURIComponent(target.deck) + "&qpin=" + encodeURIComponent(target.pin) });
  await wait(6000);
  const dv = await P.ev(`({locked: !!window.__wm.State.viewerLocked, pop: !document.getElementById('pin-action-pop').classList.contains('hidden'), pend: sessionStorage.getItem('wm_pending_deeplink'), designer: window.__wm.Auth.isDesigner, mode: window.__wm.State.mode})`);
  ok(dv.locked && !dv.pop && !dv.pend && !dv.designer, "6 🔴 ?d= 와 함께 → 열람 전용 그대로, 딥링크 미실행·편집권한 0 " + JSON.stringify(dv));

  /* ── 7. 없는 프로젝트 QR(로그인 상태) → 사유 안내, 진입 0 ── */
  await P.ev("localStorage.clear(); sessionStorage.clear(); 1");
  await P.ev(`localStorage.setItem("wm_local_token", ${JSON.stringify(dTok)}); 1`);
  await P.send("Page.navigate", { url: BASE + "/?qp=proj_doesnotexist&qpin=x1" });
  const missMs = await P.waitFor(`[].slice.call(document.querySelectorAll('.wm-toast, [class*=toast]')).some(function(e){return /열 수 없습니다/.test(e.textContent)})`, 20000);
  const mv = await P.ev(`({app: !!document.querySelector('#screen-app.active'), hub: !!document.querySelector('#screen-projects.active')})`);
  ok(missMs >= 0 && !mv.app, "7 없는 프로젝트 QR → '열 수 없습니다' 안내, 진입 0 " + JSON.stringify(mv));

  ok(P.errs.length === 0, "콘솔 예외 0", P.errs.slice(0, 3));
} catch (e) {
  console.log("FAIL 예외: " + (e && e.stack || e));
  failed++;
} finally {
  await cleanup();
}
console.log(failed ? "\n" + failed + " FAIL" : "\nALL PASS");
process.exit(failed ? 1 : 0);
