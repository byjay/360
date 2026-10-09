/**
 * p127-cdp — [WO 20261007-aivision · 무료] AI 분석 라이브 실측(실 headless Chrome + wrangler pages dev + 로컬 시드 D1 + 🔴 실 Workers AI 1회).
 * 실행: P127=1 TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p127-ai-vision-cdp.mjs
 *   (P127 != "1" 이면 즉시 SKIP — .test.mjs 가 아니라 전 스위트 루프에도 안 잡힌다)
 *
 * 사전 준비: node build-tools/local-dev.mjs && node build-tools/seed-local.mjs
 *   (.tmp/localdev/dist = HEAD 빌드, .tmp/localdev-state = 시드 D1/R2: proj_localseed 에 360 핀 2개(imageId))
 * 🔴 비용: wrangler.jsonc 의 ai 바인딩으로 로컬 dev 도 실 Workers AI 를 호출한다(지휘자 승인 2026-10-07 "무료라면 1회 허용").
 *   실행 전 GraphQL(aiInferenceAdaptiveGroups)로 계정의 당일 Neurons 사용량을 읽어 무료 할당(10,000/일) 안인지 확인하고,
 *   아니면 실호출 없이 FAIL 로 멈춘다. 실행 후 같은 쿼리로 소모 Neurons 를 보고한다(비용 0 근거).
 *   토큰은 _warehouse/secrets.json cloudflare.apiToken 에서만 읽고 출력하지 않는다. 없으면 GraphQL 확인 없이 호출하지 않는다(SKIP → EXIT=2).
 * 산출: .tmp/fixaivision/<n>-<name>-<375|1280>.png + .tmp/fixaivision/realcall.json(응답 구조·품질)
 */
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { fileURLToPath } from "node:url";
import { FIND_SEED_ORIGIN } from "./_lib/seed-origin.mjs";   // [2026-10-10] 시드 카드 스코프(누적 D1 의 빈 프로젝트 오클릭 방지)

if (process.env.P127 !== "1") { console.log("[SKIP] p127-cdp 는 P127=1 일 때만 실행"); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = path.join(ROOT, ".tmp");
const WORK = path.join(TMP, "localdev");
const STATE = path.join(TMP, "localdev-state");
const OUT = path.join(TMP, "fixaivision");
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
if (!fs.existsSync(path.join(WORK, "dist", "_worker.js")) || !fs.existsSync(STATE)) { console.log("FAIL .tmp/localdev(dist)·localdev-state 없음 — local-dev.mjs && seed-local.mjs 먼저"); process.exit(2); }
if (!fs.existsSync(CHROME)) { console.log("FAIL Chrome 없음: " + CHROME); process.exit(2); }

let failed = 0; const fails = [];
const ok = (cond, label, detail) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail).slice(0, 400) : "")); if (!cond) { failed++; fails.push(label); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 비용 0 근거: 계정 당일 Workers AI Neurons(GraphQL). 토큰 값은 출력하지 않는다. ── */
const SECRETS = process.env.SECRETS_JSON || "E:/code-project/_warehouse/secrets.json";
let cf = null;
try { cf = JSON.parse(fs.readFileSync(SECRETS, "utf8")).cloudflare; } catch (e) {}
if (!cf || !cf.apiToken || !cf.accountId) { console.log("FAIL cloudflare.apiToken/accountId 없음 — 무료 할당 확인 없이는 실호출하지 않는다"); process.exit(2); }
const FREE_NEURONS_PER_DAY = 10000;
async function neuronsToday() {
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const q = { query: "query($a:String!,$s:Time!){ viewer { accounts(filter:{accountTag:$a}) { aiInferenceAdaptiveGroups(limit:200, filter:{datetime_geq:$s}) { count sum { totalNeurons totalInputTokens totalOutputTokens } dimensions { modelId } } } } }", variables: { a: cf.accountId, s: dayStart.toISOString() } };
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { Authorization: "Bearer " + cf.apiToken, "Content-Type": "application/json" }, body: JSON.stringify(q) });
  const j = await r.json();
  const groups = (((j.data || {}).viewer || {}).accounts || [{}])[0].aiInferenceAdaptiveGroups || [];
  const total = groups.reduce((s, g) => s + Number(g.sum.totalNeurons || 0), 0);
  return { total, groups: groups.map((g) => ({ model: g.dimensions.modelId, n: g.count, neurons: g.sum.totalNeurons, in: g.sum.totalInputTokens, out: g.sum.totalOutputTokens })), errors: j.errors || null };
}
const before = await neuronsToday();
console.log("[비용 0 근거] UTC 당일 계정 Workers AI Neurons 사용량(실행 전) = " + before.total + " / 무료 " + FREE_NEURONS_PER_DAY + "  " + JSON.stringify(before.groups));
ok(!before.errors && before.total < FREE_NEURONS_PER_DAY - 1000, "무료 할당 안(실행 전 " + before.total + " < " + (FREE_NEURONS_PER_DAY - 1000) + ") — 아니면 실호출하지 않는다", before);
if (failed) { console.log("\n실호출 중단(무료 할당 확인 실패)"); process.exit(1); }

/* ── 결정적 실행: 이전 실행이 남긴 서버 캐시(ai_vision_results, 영속 D1)를 비운다 ── */
{
  const r = spawnSync("node", ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "webapp-production", "--local", "--persist-to", STATE, "--command", "DELETE FROM ai_vision_results"],
    { cwd: WORK, env: { ...process.env, TEMP: TMP, TMP: TMP }, encoding: "utf8" });
  if (r.status !== 0) { console.log("FAIL 캐시 테이블 초기화 실패:\n" + String(r.stdout + r.stderr).slice(-800)); process.exit(2); }
}

/* ── wrangler pages dev(HEAD 빌드 dist + 시드 D1 + wrangler.jsonc ai 바인딩 → 실 Workers AI) ── */
const PORT = process.env.P127_PORT || "18797";
const wrangler = spawn("node", ["node_modules/wrangler/bin/wrangler.js", "pages", "dev", "dist", "--d1=webapp-production", "--ai=AI", "--local", "--persist-to", STATE, "--ip", "127.0.0.1", "--port", PORT],
  { cwd: WORK, env: { ...process.env, TEMP: TMP, TMP: TMP }, stdio: ["ignore", "pipe", "pipe"] });
let wlog = ""; wrangler.stdout.on("data", (d) => (wlog += d)); wrangler.stderr.on("data", (d) => (wlog += d));
const BASE = "http://127.0.0.1:" + PORT;
async function up() { for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + "/"); if (r.status) return true; } catch (e) {} await wait(500); } return false; }

let chrome = null, ws = null;
async function cleanup() { try { ws && ws.close(); } catch (e) {} try { chrome && chrome.kill(); } catch (e) {} try { wrangler.kill(); } catch (e) {} }

const real = { calls: 0, results: [] };
try {
  if (!(await up())) { console.log("FAIL wrangler 기동 실패:\n" + wlog.slice(-1500)); process.exit(1); }
  const profileDir = path.join(TMP, "p127-chrome-" + Date.now());
  chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", "--user-data-dir=" + profileDir, "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
  const devtoolsPort = async () => { for (let i = 0; i < 80; i++) { try { const p = parseInt(fs.readFileSync(path.join(profileDir, "DevToolsActivePort"), "utf8").split("\n")[0], 10); if (p > 0) return p; } catch (e) {} await wait(150); } throw new Error("DevToolsActivePort 없음"); };
  const getJson = (url) => new Promise((resolve, reject) => http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on("error", reject));
  const port = await devtoolsPort();
  let pageWs = null;
  for (let i = 0; i < 40 && !pageWs; i++) { try { const l = await getJson("http://127.0.0.1:" + port + "/json/list"); const pg = l.find((t) => t.type === "page"); if (pg) pageWs = pg.webSocketDebuggerUrl; } catch (e) {} if (!pageWs) await wait(200); }
  ws = new WebSocket(pageWs);
  await new Promise((r) => ws.on("open", r));
  let idc = 0; const pending = new Map(); const consoleLog = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); return; }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") consoleLog.push(msg.params.args.map((a) => a.value || a.description || "").join(" ").slice(0, 300));
    if (msg.method === "Runtime.exceptionThrown") consoleLog.push("EXC: " + JSON.stringify(msg.params.exceptionDetails).slice(0, 400));
  });
  const send = (m, p = {}) => new Promise((resolve, reject) => { const id = ++idc; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method: m, params: p })); });
  const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result.value; };
  const evSafe = async (expr) => { try { return await ev(expr); } catch (e) { return { __err: String(e.message).slice(0, 300) }; } };
  let shotN = 0; let vp = 375;
  const shot = async (name) => { const s = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, String(++shotN).padStart(2, "0") + "-" + name + "-" + vp + ".png"), Buffer.from(s.data, "base64")); };
  const waitFor = async (cond, timeout = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await evSafe("(function(){try{return !!(" + cond + ")}catch(e){return false}})()"); if (v === true) return Date.now() - t0; await wait(150); } return -1; };
  const setVp = async (w, h, mobile) => { vp = w; await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile }); };
  await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
  // [WO 20261009-installgate 정비] 현장 실제 환경 = 설치된 앱(standalone). CDP 공식 Emulation
  // 커맨드로는 display-mode 를 바꿀 수 없어(p114 실측과 동일 근거) 신호 자체를 패치한다.
  await send("Page.addScriptToEvaluateOnNewDocument", { source: String.raw`(function(){
    var realMM = window.matchMedia.bind(window);
    window.matchMedia = function (q) {
      if (typeof q === "string" && q.indexOf("display-mode: standalone") >= 0) {
        return { matches: true, media: q, onchange: null, addListener: function(){}, removeListener: function(){}, addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){ return true; } };
      }
      return realMM(q);
    };
  })();` });

  const accPath = path.join(TMP, "local-test-accounts.json");
  const PW = JSON.parse(fs.readFileSync(accPath, "utf8")).accounts.find((a) => a.role === "designer").password;
  await send("Page.navigate", { url: BASE + "/manifest.webmanifest" });
  await waitFor("location.pathname === '/manifest.webmanifest'", 20000);
  const login = await ev(`fetch("${BASE}/api/signup/login", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ email: "designer@test.local", password: ${JSON.stringify(PW)} }) }).then(r => r.json())`);
  ok(!!(login && login.token), "로그인(local designer)", login);
  await ev(`localStorage.setItem("wm_local_token", ${JSON.stringify(login.token)}); 1`);
  const st = await ev(`fetch("${BASE}/api/ai/vision-status", { headers: { Authorization: "Bearer " + ${JSON.stringify(login.token)} } }).then(r => r.json())`);
  ok(st && st.enabled === true && st.provider === "workers-ai" && /^@cf\//.test(st.model || "") && st.daily_limit === 30 && st.neuron_cap < FREE_NEURONS_PER_DAY, "vision-status enabled · provider workers-ai · 무료 모델(@cf/) · 상한", st);

  const enterApp = async () => {
    await send("Page.navigate", { url: BASE + "/" });
    await waitFor("document.querySelector('.hub-card-thumb') || document.querySelector('#screen-app.active')", 30000);
    await wait(600);
    let entered = false;
    for (let attempt = 0; attempt < 3 && !entered; attempt++) {
      await waitFor(FIND_SEED_ORIGIN, 15000);
      let c = { found: false };
      for (let i = 0; i < 20 && !c.found; i++) { await wait(300); c = await evSafe(`(function(){ var e = ${FIND_SEED_ORIGIN}; if (!e) return {found:false}; e.scrollIntoView({block:'center'}); e.click(); return {found:true}; })()`); }
      if (!c.found) continue;
      await waitFor("document.querySelector('#screen-app.active')", 20000);
      if ((await waitFor("document.querySelectorAll('.pin-marker').length > 0 && window.__wm && __wm.State.pins.some(function(p){return !!p.imageId})", 12000)) < 0) continue;
      await wait(1500);
      entered = (await evSafe("document.querySelector('#screen-app.active') && document.querySelectorAll('.pin-marker').length > 0")) === true;
    }
    return entered;
  };

  for (const [w, h, mobile] of [[375, 812, true], [1280, 900, false]]) {
    await setVp(w, h, mobile);
    console.log("\n[뷰포트 " + w + "]");
    ok(await enterApp(), "허브 → 원본 열기 → 핀 로딩");
    const findPin = "var p = __wm.State.pins.find(function(p){return !!p.imageId});";
    await evSafe(`(function(){ ${findPin} var m = document.querySelector('.pin-marker[data-id="' + p.id + '"]'); if (m) { m.scrollIntoView({block:'center'}); m.click(); } })()`);
    let opened = await waitFor("!document.getElementById('pin-action-pop').classList.contains('hidden')", 3000);
    let via = "marker-click";
    if (opened < 0) { via = "__wm.PinActionPop.open"; await evSafe(`(function(){ ${findPin} __wm.App.setActivePin(p.id); __wm.PinActionPop.open(p.id); })()`); opened = await waitFor("!document.getElementById('pin-action-pop').classList.contains('hidden')", 3000); }
    ok(opened >= 0, "핀 팝업 열림(" + via + ")");
    ok((await waitFor("document.getElementById('pap-ai-run')", 5000)) >= 0, "핀 팝업에 [🤖 AI 분석] 버튼 렌더");
    await waitFor("document.querySelector('#pap-ai .aiv-quota')", 6000);
    const s0 = await evSafe(`(function(){ var b=document.getElementById('pap-ai-run'); var q=document.querySelector('#pap-ai .aiv-quota'); var r=document.querySelector('#pap-ai .aiv-reason'); var bb=b.getBoundingClientRect(); return { dis: b.getAttribute('aria-disabled'), quota: q?q.textContent:null, reason: r?r.textContent:null, h: bb.height, inView: bb.top>=0 && bb.bottom<=innerHeight }; })()`);
    ok(s0.dis === "false" && /남은 횟수/.test(s0.quota || "") && /무료 할당/.test(s0.quota || "") && /비용 \$0/.test(s0.quota || "") && !s0.reason, "버튼 활성 + 남은 횟수·무료 할당 Neurons·비용 $0 안내", s0);
    ok(s0.h >= 40 && s0.inView, "버튼 터치타깃 ≥40px · 화면 안", s0);
    await shot("pap-button");

    // 오프라인 → 비활성 + 사유(숨김 없음), 요청 0
    await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const off = await waitFor("document.querySelector('#pap-ai .aiv-reason') && /온라인에서 사용/.test(document.querySelector('#pap-ai .aiv-reason').textContent)", 4000);
    const offState = await evSafe(`(function(){ var b=document.getElementById('pap-ai-run');
      function lum(c){ var m=c.match(/\\d+(\\.\\d+)?/g).map(Number); var a=[m[0],m[1],m[2]].map(function(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)}); return 0.2126*a[0]+0.7152*a[1]+0.0722*a[2]; }
      var cs = b ? getComputedStyle(b) : null; var ratio = cs ? (function(){ var l1=lum(cs.color), l2=lum(cs.backgroundColor); return Math.round(((Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05))*100)/100; })() : null;
      return { dis: b && b.getAttribute('aria-disabled'), visible: !!b && b.getBoundingClientRect().width > 0, reason: (document.querySelector('#pap-ai .aiv-reason')||{}).textContent, opacity: cs && cs.opacity, ratio: ratio }; })()`);
    ok(off >= 0 && offState.dis === "true" && offState.visible, "오프라인 → 버튼 보임 + aria-disabled + '온라인에서 사용' 사유", offState);
    ok(offState.opacity === "1" && offState.ratio >= 4.5, "비활성 버튼도 글자 대비 ≥4.5:1(투명도 아님)", offState);
    await shot("pap-offline");
    await evSafe("document.getElementById('pap-ai-run').click(); 1");
    await wait(300);
    await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await waitFor("document.getElementById('pap-ai-run') && document.getElementById('pap-ai-run').getAttribute('aria-disabled') === 'false'", 5000);

    // 🔴 분석 실행 — 첫 뷰포트만 실 Workers AI 1회(둘째 뷰포트는 서버 캐시 적중이어야 한다)
    const t0 = Date.now();
    await evSafe("document.getElementById('pap-ai-run').click(); 1");
    const done = await waitFor("document.querySelector('#pap-ai .aiv-card') || document.querySelector('#pap-ai .aiv-error')", 120000);
    const c1 = await evSafe(`(function(){ var h=document.getElementById('pap-ai'); var card=h.querySelector('.aiv-card'); return { card: !!card, err: (h.querySelector('.aiv-error')||{}).textContent || null, cached: card ? /\\(캐시\\)/.test(card.textContent) : null,
      items: h.querySelectorAll('.aiv-item').length, est: h.querySelectorAll('.aiv-est').length, defect: !!document.getElementById('pap-ai-defect'), mark: (document.getElementById('pap-ai-mark')||{}).textContent || null, meta: (h.querySelector('.aiv-meta')||{}).textContent || null,
      summary: (h.querySelector('.aiv-summary')||{}).textContent || null }; })()`);
    const serverRows = await ev(`fetch("${BASE}/api/ai/vision-status", { headers: { Authorization: "Bearer " + localStorage.getItem("wm_local_token") } }).then(r => r.json())`);
    real.results.push({ vp: w, ms: Date.now() - t0, ...c1, status_after: serverRows });
    if (w === 375) {
      ok(done >= 0 && c1.card && c1.cached === false, "🔴 실 Workers AI 1회 → 결과 카드(" + (Date.now() - t0) + "ms) — 오류면 정직 표시: " + (c1.err || "없음"), c1);
      ok(c1.card ? (/Neurons/.test(c1.meta || "") && /비용 \$0\(무료 할당\)/.test(c1.meta || "") && /@cf\//.test(c1.meta || "")) : false, "메타: 무료 모델(@cf/)·Neurons·비용 $0", c1);
      ok(serverRows.neurons_used_today > 0 && serverRows.neurons_used_today < serverRows.neuron_cap, "서버 Neurons 집계 증가(" + serverRows.neurons_used_today + " / 상한 " + serverRows.neuron_cap + ")", serverRows);
    } else {
      ok(done >= 0 && c1.card && c1.cached === true, "재진입(1280) → 서버 캐시 적중 '(캐시)' — 실호출 추가 0", c1);
    }
    await shot("pap-card");
    if (!c1.card) continue;   // 실모델 실패 시 나머지 UI 단계는 건너뛴다(정직 보고)

    const hasPos = await evSafe("!!document.getElementById('pap-ai-mark')");
    if (hasPos) {
      await evSafe("document.getElementById('pap-ai-mark').click(); 1");
      const pano = await waitFor("__wm.PanoViewer.open && __wm.PanoViewer._aiSpots && __wm.PanoViewer._aiSpots.length > 0", 15000);
      ok(pano >= 0, "[마커 보기] → 360 열림 + 임시 AI 마커", pano);
      await waitFor("document.getElementById('pano-loading').classList.contains('hidden')", 15000);
      await wait(800);
      const sp = await evSafe("(function(){ var pv=__wm.PanoViewer; var g=pv._spotGroup; var pin=pv._currentPin; return { sprites: g ? g.children.length : -1, ai: pv._aiSpots ? pv._aiSpots.length : 0, saved: (pin.spots||[]).length }; })()");
      ok(sp.sprites === sp.ai && sp.saved === 0, "구면 스프라이트 = 임시 마커 수 · pin.spots 0(저장 전)", sp);
      await shot("pano-markers");
    } else {
      // 위치 없는 결과 — 360 을 직접 열어 패널만 확인
      await evSafe(`(function(){ ${findPin} __wm.PinActionPop.close(); __wm.App.openPano(p); })()`);
      await waitFor("__wm.PanoViewer.open", 10000);
      await waitFor("document.getElementById('pano-loading').classList.contains('hidden')", 15000);
      ok(true, "위치(yaw/pitch) 있는 항목 없음 — 마커 단계 생략(정직)");
    }
    await evSafe("(function(){ var m=document.getElementById('btn-pano-more'); if (m && getComputedStyle(m).display !== 'none') m.click(); })()");
    await wait(300);
    await evSafe("document.getElementById('btn-pano-ai').click(); 1");
    ok((await waitFor("!document.getElementById('pano-ai-panel').classList.contains('hidden') && document.getElementById('pano-ai-host-run')", 5000)) >= 0, "360 헤더 [AI 분석] → 좌상단 패널 + 버튼");
    const pc = await evSafe(`(function(){ var h=document.getElementById('pano-ai-host'); var pr=document.getElementById('pano-ai-panel').getBoundingClientRect();
      function lum(c){ var m=c.match(/\\d+(\\.\\d+)?/g).map(Number); var a=[m[0],m[1],m[2]].map(function(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)}); return 0.2126*a[0]+0.7152*a[1]+0.0722*a[2]; }
      function ratioOn(el, bg){ var f=getComputedStyle(el).color; var l1=lum(f), l2=lum(bg); return Math.round(((Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05))*100)/100; }
      var s=h.querySelector('.aiv-summary'), m=h.querySelector('.aiv-meta');
      return { card: !!h.querySelector('.aiv-card'), left: pr.left, right: pr.right, vw: innerWidth, summary: s ? ratioOn(s, 'rgb(10, 16, 32)') : null, meta: m ? ratioOn(m, 'rgb(10, 16, 32)') : null }; })()`);
    ok(pc.card && pc.left >= 0 && pc.right <= pc.vw + 1, "패널에 세션 결과 재사용(추가 호출 0) · 뷰포트 안", pc);
    ok(pc.summary >= 4.5 && pc.meta >= 4.5, "다크 패널 대비 ≥4.5:1(본문·메타)", pc);
    await shot("pano-panel");
    const hasDefect = await evSafe("!!document.getElementById('pano-ai-host-defect')");
    if (hasDefect) {
      const notesBefore = await ev(`fetch("${BASE}/api/notes?deployment_id=" + __wm.State.currentDeploymentId, { headers: { Authorization: "Bearer " + localStorage.getItem("wm_local_token") } }).then(r => r.json()).then(j => (j.data||[]).length)`);
      await evSafe("document.getElementById('pano-ai-host-defect').click(); 1");
      const form = await waitFor("!document.getElementById('pano-notes-panel').classList.contains('hidden') && document.getElementById('pnp-input').value.length > 0", 6000);
      const fv = await evSafe("(function(){ return { v: document.getElementById('pnp-input').value.slice(0,80), sev: document.getElementById('pnp-severity').value }; })()");
      ok(form >= 0 && fv.v.length > 0, "결함 폼 미리 채움(제목+내용" + (fv.sev ? ", 심각도 " + fv.sev : ", 심각도 비움(추정)") + ")", fv);
      await wait(600);
      const notesAfter = await ev(`fetch("${BASE}/api/notes?deployment_id=" + __wm.State.currentDeploymentId, { headers: { Authorization: "Bearer " + localStorage.getItem("wm_local_token") } }).then(r => r.json()).then(j => (j.data||[]).length)`);
      ok(notesAfter === notesBefore, "🔴 결함 노트 자동 저장 0(서버 pin_notes 불변 " + notesBefore + "→" + notesAfter + ")");
      await shot("defect-prefill");
    } else ok(true, "결함 제안 없음(모델이 결함을 보지 않음) — 폼 단계 생략(정직)");
    await evSafe("__wm.PanoViewer.close(); 1");
    await waitFor("!__wm.PanoViewer.open", 5000);
    await wait(500);
    const cleared = await evSafe("(function(){ return { ai: __wm.PanoViewer._aiSpots, panelHidden: document.getElementById('pano-ai-panel').classList.contains('hidden') }; })()");
    ok(cleared.ai === null && cleared.panelHidden, "뷰어 닫힘 → 임시 마커·패널 정리", cleared);
  }
  const jsErrors = consoleLog.filter((e) => !/favicon|ERR_INTERNET_DISCONNECTED|Failed to fetch|net::ERR/i.test(e));
  ok(jsErrors.length === 0, "콘솔 JS 에러 0건(오프라인 에뮬레이션 네트워크 오류 제외)", jsErrors);
} finally {
  await cleanup();
}

/* ── 실행 후 Neurons(계정) — 비용 0 근거 마무리 ── */
await wait(3000);
let after = null;
try { after = await neuronsToday(); } catch (e) {}
const used = after ? after.total - before.total : null;
console.log("[비용 0 근거] 실행 후 당일 Neurons = " + (after ? after.total : "?") + " (이번 실행 소모 ≈ " + used + ", 무료 " + FREE_NEURONS_PER_DAY + "/일 안 → $0)  " + JSON.stringify(after ? after.groups : null));
fs.writeFileSync(path.join(OUT, "realcall.json"), JSON.stringify({ at: new Date().toISOString(), before, after, used_neurons: used, results: real.results }, null, 2));
ok(after && after.total < FREE_NEURONS_PER_DAY, "실행 후에도 무료 할당 안(" + (after && after.total) + " < " + FREE_NEURONS_PER_DAY + ") → 비용 $0", after);
console.log("\n" + (failed ? "FAILED " + failed + "건: " + fails.join(" | ") : "ALL PASS") + "  → " + OUT);
process.exit(failed ? 1 : 0);
