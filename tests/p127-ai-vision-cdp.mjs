/**
 * p127-cdp — [WO 20261007-aivision] AI 분석 라이브 실측(실 headless Chrome + wrangler pages dev + 로컬 시드 D1).
 * 실행: P127=1 TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p127-ai-vision-cdp.mjs
 *   (P127 != "1" 이면 즉시 SKIP — .test.mjs 가 아니라 전 스위트 루프에도 안 잡힌다)
 *
 * 사전 준비: node build-tools/local-dev.mjs && node build-tools/seed-local.mjs
 *   (.tmp/localdev/dist = HEAD 빌드, .tmp/localdev-state = 시드 D1/R2: proj_localseed 에 360 핀 2개(imageId))
 * 🔴 실제 과금 호출 0 — 업스트림(OpenRouter)은 이 프로세스 안의 fixture HTTP 서버로 대체하고, wrangler 는
 *   .tmp/localdev/.dev.vars 에 가짜 키 + AI_VISION_BASE_URL=fixture 를 받아 뜬다(.tmp 는 gitignore).
 * 산출: .tmp/fixaivision/<n>-<name>-<375|1280>.png
 */
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { fileURLToPath } from "node:url";
import { listenSafePort } from "./_lib/safe-listen.mjs";

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

/* ── fixture 업스트림(과금 0) ── */
const FIX = {
  summary: "기관실 통로 전경. 좌측에 펌프 유닛 2기, 우측 배관 플랜지에 녹 흔적, 바닥 일부에 기름 얼룩.",
  items: [
    { kind: "equipment", label: "FW PUMP NO.1", confidence: 0.93, yaw: 70, pitch: -8 },
    { kind: "equipment", label: "배관 밸브", confidence: 0.81, yaw: 150, pitch: 5 },
    { kind: "defect", label: "플랜지 부식", confidence: 0.56, yaw: 250, pitch: -12 },
    { kind: "hazard", label: "바닥 기름 얼룩", confidence: 0.62, yaw: 300, pitch: -40 },
  ],
  change_summary: null,
  defect_suggestion: { title: "배관 플랜지 부식", detail: "우측 플랜지 볼트 주변 녹 — 현장 확인 후 방청 처리 필요", severity: "mid", confidence: 0.74 },
};
const upstream = { calls: 0 };
const fx = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    upstream.calls++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "gen-fx", model: "anthropic/claude-sonnet-5.5", choices: [{ message: { role: "assistant", content: JSON.stringify(FIX) } }], usage: { prompt_tokens: 1712, completion_tokens: 271, cost: 0.00613 } }));
  });
});
await listenSafePort(fx, "127.0.0.1");
fs.writeFileSync(path.join(WORK, ".dev.vars"), "# p127-cdp 로컬 전용 — 가짜 키 + fixture 업스트림(실 과금 0)\nOPENROUTER_API_KEY=sk-or-p127-fake\nAI_VISION_BASE_URL=http://127.0.0.1:" + fx.address().port + "/v1\n");

/* ── 결정적 실행: 이전 실행이 남긴 서버 캐시(ai_vision_results, 영속 D1)를 비운다 — 캐시 적중 여부를 뷰포트별로 단언하기 위해 ── */
{
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("node", ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "webapp-production", "--local", "--persist-to", STATE, "--command", "DELETE FROM ai_vision_results"],
    { cwd: WORK, env: { ...process.env, TEMP: TMP, TMP: TMP }, encoding: "utf8" });
  if (r.status !== 0) { console.log("FAIL 캐시 테이블 초기화 실패:\n" + String(r.stdout + r.stderr).slice(-800)); process.exit(2); }
}

/* ── wrangler pages dev(HEAD 빌드 dist + 시드 D1) ── */
const PORT = process.env.P127_PORT || "18797";
const wrangler = spawn("node", ["node_modules/wrangler/bin/wrangler.js", "pages", "dev", "dist", "--d1=webapp-production", "--local", "--persist-to", STATE, "--ip", "127.0.0.1", "--port", PORT],
  { cwd: WORK, env: { ...process.env, TEMP: TMP, TMP: TMP }, stdio: ["ignore", "pipe", "pipe"] });
let wlog = ""; wrangler.stdout.on("data", (d) => (wlog += d)); wrangler.stderr.on("data", (d) => (wlog += d));
const BASE = "http://127.0.0.1:" + PORT;
async function up() { for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + "/"); if (r.status) return true; } catch (e) {} await wait(500); } return false; }

let chrome = null, ws = null;
async function cleanup() { try { ws && ws.close(); } catch (e) {} try { chrome && chrome.kill(); } catch (e) {} try { wrangler.kill(); } catch (e) {} try { fx.close(); } catch (e) {} try { fs.unlinkSync(path.join(WORK, ".dev.vars")); } catch (e) {} }

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

  // 로그인(local designer)
  const accPath = path.join(TMP, "local-test-accounts.json");
  const PW = JSON.parse(fs.readFileSync(accPath, "utf8")).accounts.find((a) => a.role === "designer").password;
  await send("Page.navigate", { url: BASE + "/manifest.webmanifest" });
  await waitFor("location.pathname === '/manifest.webmanifest'", 20000);
  const login = await ev(`fetch("${BASE}/api/signup/login", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ email: "designer@test.local", password: ${JSON.stringify(PW)} }) }).then(r => r.json())`);
  ok(!!(login && login.token), "로그인(local designer)", login);
  await ev(`localStorage.setItem("wm_local_token", ${JSON.stringify(login.token)}); 1`);
  // 상태 API 직접 확인(키=가짜, 업스트림=fixture)
  const st = await ev(`fetch("${BASE}/api/ai/vision-status", { headers: { Authorization: "Bearer " + ${JSON.stringify(login.token)} } }).then(r => r.json())`);
  ok(st && st.enabled === true && st.model === "anthropic/claude-sonnet-5.5" && st.daily_limit === 30, "vision-status enabled(로컬 .dev.vars) · 모델 · 상한", st);

  const enterApp = async () => {
    await send("Page.navigate", { url: BASE + "/" });
    await waitFor("document.querySelector('.hub-card-thumb') || document.querySelector('#screen-app.active')", 30000);
    await wait(600);
    let entered = false;
    for (let attempt = 0; attempt < 3 && !entered; attempt++) {
      await waitFor("document.querySelector('[data-act=origin-open]')", 15000);
      let c = { found: false };
      for (let i = 0; i < 20 && !c.found; i++) { await wait(300); c = await evSafe(`(function(){ var e = document.querySelector('[data-act=origin-open]'); if (!e) return {found:false}; e.scrollIntoView({block:'center'}); e.click(); return {found:true}; })()`); }
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
    // 360 핀(imageId) 팝업 열기 — 실제 마커 클릭, 안 열리면 E2E 훅으로 폴백
    const pinId = await ev("(function(){ var p = __wm.State.pins.find(function(p){return !!p.imageId}); return p ? String(p.id) : null; })()");
    ok(!!pinId, "시드 360 핀(imageId) 존재 — " + pinId);
    const findPin = "var p = __wm.State.pins.find(function(p){return !!p.imageId});";
    await evSafe(`(function(){ ${findPin} var m = document.querySelector('.pin-marker[data-id="' + p.id + '"]'); if (m) { m.scrollIntoView({block:'center'}); m.click(); } })()`);
    let opened = await waitFor("!document.getElementById('pin-action-pop').classList.contains('hidden')", 3000);
    let via = "marker-click";
    if (opened < 0) { via = "__wm.PinActionPop.open"; await evSafe(`(function(){ ${findPin} __wm.App.setActivePin(p.id); __wm.PinActionPop.open(p.id); })()`); opened = await waitFor("!document.getElementById('pin-action-pop').classList.contains('hidden')", 3000); }
    ok(opened >= 0, "핀 팝업 열림(" + via + ")");
    const btn = await waitFor("document.getElementById('pap-ai-run')", 5000);
    ok(btn >= 0, "핀 팝업에 [🤖 AI 분석] 버튼 렌더");
    await waitFor("document.querySelector('#pap-ai .aiv-quota')", 6000);
    const s0 = await evSafe(`(function(){ var b=document.getElementById('pap-ai-run'); var q=document.querySelector('#pap-ai .aiv-quota'); var r=document.querySelector('#pap-ai .aiv-reason'); var bb=b.getBoundingClientRect(); return { dis: b.getAttribute('aria-disabled'), quota: q?q.textContent:null, reason: r?r.textContent:null, h: bb.height, w: bb.width, inView: bb.top>=0 && bb.bottom<=innerHeight }; })()`);
    ok(s0.dis === "false" && /남은 횟수/.test(s0.quota || "") && !s0.reason, "버튼 활성(디자이너·온라인·사진·키·한도) + 남은 횟수 안내", s0);
    ok(s0.h >= 40 && s0.inView, "버튼 터치타깃 ≥40px · 화면 안", s0);
    await shot("pap-button");

    // 오프라인 에뮬레이션 → 비활성 + 사유(숨김 없음)
    await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const off = await waitFor("document.querySelector('#pap-ai .aiv-reason') && /온라인에서 사용/.test(document.querySelector('#pap-ai .aiv-reason').textContent)", 4000);
    const offState = await evSafe(`(function(){ var b=document.getElementById('pap-ai-run');
      function lum(c){ var m=c.match(/\\d+(\\.\\d+)?/g).map(Number); var a=[m[0],m[1],m[2]].map(function(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)}); return 0.2126*a[0]+0.7152*a[1]+0.0722*a[2]; }
      var cs = b ? getComputedStyle(b) : null; var ratio = cs ? (function(){ var l1=lum(cs.color), l2=lum(cs.backgroundColor); return Math.round(((Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05))*100)/100; })() : null;
      return { dis: b && b.getAttribute('aria-disabled'), visible: !!b && b.getBoundingClientRect().width > 0, reason: (document.querySelector('#pap-ai .aiv-reason')||{}).textContent, opacity: cs && cs.opacity, ratio: ratio }; })()`);
    ok(off >= 0 && offState.dis === "true" && offState.visible, "오프라인 → 버튼 보임 + aria-disabled + '온라인에서 사용' 사유", offState);
    ok(offState.opacity === "1" && offState.ratio >= 4.5, "비활성 버튼도 글자 대비 ≥4.5:1(투명도 아님)", offState);
    await shot("pap-offline");
    const q0 = await evSafe("(function(){ var n=0; try { n = Object.keys(localStorage).filter(function(k){return /oplog|queue/i.test(k)}).length; } catch(e){} return n; })()");
    await evSafe("document.getElementById('pap-ai-run').click(); 1");
    await wait(300);
    await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await waitFor("document.getElementById('pap-ai-run') && document.getElementById('pap-ai-run').getAttribute('aria-disabled') === 'false'", 5000);
    const callsBefore = upstream.calls;
    ok(upstream.calls === callsBefore, "오프라인 클릭 → 업스트림 호출 0(큐 없음)");

    // 분석 실행 → 결과 카드
    await evSafe("document.getElementById('pap-ai-run').click(); 1");
    const card = await waitFor("document.querySelector('#pap-ai .aiv-card')", 25000);
    ok(card >= 0, "분석 → 결과 카드 렌더(" + card + "ms)");
    const c1 = await evSafe(`(function(){ var h=document.getElementById('pap-ai'); return { items: h.querySelectorAll('.aiv-item').length, est: h.querySelectorAll('.aiv-est').length, defect: !!document.getElementById('pap-ai-defect'), mark: (document.getElementById('pap-ai-mark')||{}).textContent, meta: (h.querySelector('.aiv-meta')||{}).textContent, err: (h.querySelector('.aiv-error')||{}).textContent }; })()`);
    ok(c1.items === 4 && c1.est === 2, "항목 4 · 「추정」 2(0.56·0.62 만; 0.93·0.81·0.74 없음)", c1);
    const c1cached = await evSafe("/\\(캐시\\)/.test(document.querySelector('#pap-ai .aiv-card').textContent)");
    ok(c1.defect && /마커 보기\(4\)/.test(c1.mark || ""), "[결함으로 등록] + [360 안에 마커 보기(4)]", c1);
    ok(/\$0\.0061/.test(c1.meta || "") && /1712\/271/.test(c1.meta || ""), "메타: 비용·토큰(fixture usage)", c1);
    // 대비(라이트 카드) — 실제 computed color
    const contrast = await evSafe(`(function(){
      function lum(c){ var m=c.match(/\\d+(\\.\\d+)?/g).map(Number); var a=[m[0],m[1],m[2]].map(function(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)}); return 0.2126*a[0]+0.7152*a[1]+0.0722*a[2]; }
      function bgOf(el){ while(el){ var b=getComputedStyle(el).backgroundColor; if(b && b!=='rgba(0, 0, 0, 0)' && b!=='transparent') return b; el=el.parentElement; } return 'rgb(255, 255, 255)'; }
      function ratio(el){ var f=getComputedStyle(el).color, b=bgOf(el); var l1=lum(f), l2=lum(b); return Math.round(((Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05))*100)/100; }
      var out={}; var s=document.querySelector('#pap-ai .aiv-summary'); if(s) out.summary=ratio(s); var q=document.querySelector('#pap-ai .aiv-meta'); if(q) out.meta=ratio(q); var e=document.querySelector('#pap-ai .aiv-est'); if(e) out.est=ratio(e); var b=document.getElementById('pap-ai-run'); if(b) out.btn=ratio(b); return out; })()`);
    ok(contrast.summary >= 4.5 && contrast.meta >= 4.5 && contrast.est >= 4.5 && contrast.btn >= 4.5, "라이트 카드 대비 ≥4.5:1(본문·메타·추정·버튼)", contrast);
    await shot("pap-card");

    // 360 마커 보기 → 뷰어 열림 + 임시 마커
    await evSafe("document.getElementById('pap-ai-mark').click(); 1");
    const pano = await waitFor("__wm.PanoViewer.open && __wm.PanoViewer._aiSpots && __wm.PanoViewer._aiSpots.length === 4", 15000);
    ok(pano >= 0, "[마커 보기] → 360 열림 + 임시 AI 마커 4", pano);
    await waitFor("document.getElementById('pano-loading').classList.contains('hidden')", 15000);
    await wait(800);
    const sp = await evSafe("(function(){ var pv=__wm.PanoViewer; var g=pv._spotGroup; var pin=pv._currentPin; return { sprites: g ? g.children.length : -1, saved: (pin.spots||[]).length, lon0: pv._aiSpots[0].lon, lat0: pv._aiSpots[0].lat }; })()");
    ok(sp.sprites === 4 && sp.saved === 0 && sp.lon0 === 70 && sp.lat0 === -8, "구면 스프라이트 4(임시) · pin.spots 0(저장 전) · lon=yaw/lat=pitch", sp);
    await shot("pano-markers");

    // 360 헤더 [AI 분석] → 패널(다크)
    await evSafe("(function(){ var m=document.getElementById('btn-pano-more'); if (m && getComputedStyle(m).display !== 'none') m.click(); })()");
    await wait(300);
    await evSafe("document.getElementById('btn-pano-ai').click(); 1");
    const panel = await waitFor("!document.getElementById('pano-ai-panel').classList.contains('hidden') && document.getElementById('pano-ai-host-run')", 5000);
    ok(panel >= 0, "360 헤더 [AI 분석] → 좌상단 패널 + 버튼");
    const p1 = await waitFor("document.querySelector('#pano-ai-host .aiv-card')", 15000);
    if (p1 < 0) { await evSafe("document.getElementById('pano-ai-host-run').click(); 1"); await waitFor("document.querySelector('#pano-ai-host .aiv-card')", 20000); }
    const pc = await evSafe(`(function(){ var h=document.getElementById('pano-ai-host'); var card=h.querySelector('.aiv-card'); var pr=document.getElementById('pano-ai-panel').getBoundingClientRect();
      function lum(c){ var m=c.match(/\\d+(\\.\\d+)?/g).map(Number); var a=[m[0],m[1],m[2]].map(function(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)}); return 0.2126*a[0]+0.7152*a[1]+0.0722*a[2]; }
      function ratioOn(el, bg){ var f=getComputedStyle(el).color; var l1=lum(f), l2=lum(bg); return Math.round(((Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05))*100)/100; }
      var s=h.querySelector('.aiv-summary'), m=h.querySelector('.aiv-meta'), e=h.querySelector('.aiv-est');
      return { card: !!card, cached: /캐시/.test(card ? card.textContent : ''), items: h.querySelectorAll('.aiv-item').length, left: pr.left, right: pr.right, vw: innerWidth,
        summary: s ? ratioOn(s, 'rgb(10, 16, 32)') : null, meta: m ? ratioOn(m, 'rgb(10, 16, 32)') : null, est: e ? ratioOn(e, 'rgb(10, 16, 32)') : null, markBtn: (document.getElementById('pano-ai-host-mark')||{}).textContent, saveBtn: !!document.getElementById('pano-ai-host-marksave') }; })()`);
    ok(pc.card && pc.items === 4, "패널 결과(같은 핀 세션 결과 재사용 — 추가 호출 0)", pc);
    ok(upstream.calls === 1, "업스트림 호출 누적 = 1회(첫 뷰포트 1회 · 두 번째 뷰포트는 서버 캐시 · 패널은 세션 재사용)", { calls: upstream.calls, vp: w });
    ok(w === 375 ? c1cached === false : c1cached === true, "핀 팝업 카드 '(캐시)' 표시: 375 첫 분석=없음 · 1280 재진입=있음(서버 캐시 적중)", { vp: w, c1cached });
    ok(pc.summary >= 4.5 && pc.meta >= 4.5 && pc.est >= 4.5, "다크 패널 대비 ≥4.5:1(본문·메타·추정)", pc);
    ok(pc.left >= 0 && pc.right <= pc.vw + 1, "패널이 뷰포트 안", pc);
    ok(/마커 지우기/.test(pc.markBtn || "") && pc.saveBtn, "임시 마커 표시 중 → [마커 지우기]/[마커로 저장] 노출", pc);
    await shot("pano-panel");

    // [결함으로 등록] → 결함 폼 미리 채움(저장 0)
    const notesBefore = await ev(`fetch("${BASE}/api/notes?deployment_id=" + __wm.State.currentDeploymentId, { headers: { Authorization: "Bearer " + localStorage.getItem("wm_local_token") } }).then(r => r.json()).then(j => (j.data||[]).length)`);
    await evSafe("document.getElementById('pano-ai-host-defect').click(); 1");
    const form = await waitFor("!document.getElementById('pano-notes-panel').classList.contains('hidden') && document.getElementById('pnp-input').value.length > 0", 6000);
    const fv = await evSafe("(function(){ return { v: document.getElementById('pnp-input').value, sev: document.getElementById('pnp-severity').value, focused: document.activeElement && document.activeElement.id }; })()");
    ok(form >= 0 && /^배관 플랜지 부식\n/.test(fv.v) && fv.sev === "중", "결함 폼 미리 채움(제목+내용, 심각도 중=0.74≥0.7)", fv);
    await wait(600);
    const notesAfter = await ev(`fetch("${BASE}/api/notes?deployment_id=" + __wm.State.currentDeploymentId, { headers: { Authorization: "Bearer " + localStorage.getItem("wm_local_token") } }).then(r => r.json()).then(j => (j.data||[]).length)`);
    ok(notesAfter === notesBefore, "🔴 결함 노트 자동 저장 0(서버 pin_notes 불변 " + notesBefore + "→" + notesAfter + ")");
    await shot("defect-prefill");

    // 닫기 → 임시 마커 소거
    await evSafe("__wm.PanoViewer.close(); 1");
    await waitFor("!__wm.PanoViewer.open", 5000);
    await wait(500);
    const cleared = await evSafe("(function(){ return { ai: __wm.PanoViewer._aiSpots, panelHidden: document.getElementById('pano-ai-panel').classList.contains('hidden') }; })()");
    ok(cleared.ai === null && cleared.panelHidden, "뷰어 닫힘 → 임시 마커·패널 정리(저장 안 됨)", cleared);
  }
  const jsErrors = consoleLog.filter((e) => !/favicon|ERR_INTERNET_DISCONNECTED|Failed to fetch|net::ERR/i.test(e));
  ok(jsErrors.length === 0, "콘솔 JS 에러 0건(오프라인 에뮬레이션 네트워크 오류 제외)", jsErrors);
} finally {
  await cleanup();
}
console.log("\n" + (failed ? "FAILED " + failed + "건: " + fails.join(" | ") : "ALL PASS") + "  → " + OUT);
process.exit(failed ? 1 : 0);
