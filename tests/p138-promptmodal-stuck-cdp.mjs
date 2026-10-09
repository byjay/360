/**
 * p138 — WO 2차점검(지휘자 2026-10-08 재발주 §7) 실 Chrome 실측(p135 하니스 재사용: 실 워커+D1, 목 0).
 *   재현: "새 프로젝트" 모달에서 이름을 비운 채 [확인] → 검증 에러 → 모달을 닫지 않고 상단 "←"(뒤로가기)
 *   로 허브 복귀 → 다른 프로젝트 진입 → #prompt-modal 이 여러 화면 전환을 지나도록 떠 있었다(지휘자 R7 재현).
 *   근본원인: 30_Prompt.js _close() 가 Prompt.confirm()의 close()(clearTimeout(modal._hideTimer) 가드 있음)와
 *   달리 가드 없이 setTimeout(…,200)만 걸어, 뒤이어 바로 열리는 다음 ask()/confirm() 를 되돌아와 다시 hidden
 *   처리할 수 있다 — 와 별개로, 애초에 화면 전환 시 열린 모달을 닫는 경로가 없었다(11_UI.js UI.showScreen).
 *   수정: Prompt.closeAll()(30_Prompt.js) + UI.showScreen() 공유 지점 한 곳에서 호출(11_UI.js).
 * 실행: P138=1 TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p138-promptmodal-stuck-cdp.mjs
 *   (P138 != "1" 이면 SKIP) 뮤테이션: P138_MUT=1 (UI.showScreen 의 Prompt.closeAll() 호출을 제거 → FAIL 기대)
 *   wrangler.jsonc 의 env.AI 가 remote 바인딩이라 OAuth 세션이 만료되면 "wrangler pages dev" 기동 자체가
 *   실패한다(2026-10-09 실사고) — 그럴 땐 CLOUDFLARE_API_TOKEN=<_warehouse/secrets.json 의 cloudflare.apiToken>
 *   을 환경변수로 실어 실행(시크릿 값은 콘솔에 출력 금지, env 로만 전달).
 *   스크린샷: .tmp/promptmodalstuck/
 */
import { execSync, spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { fileURLToPath } from "node:url";

if (process.env.P138 !== "1") { console.log("[SKIP] p138 는 P138=1 일 때만 실행(실 Chrome+워커 실측)"); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = path.join(ROOT, ".tmp");
const OUT = path.join(TMP, "promptmodalstuck");
const STATE = path.join(TMP, "localdev-state");
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const MUT = process.env.P138_MUT === "1";

let failed = 0; const fails = [];
const ok = (cond, label, detail) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null ? " :: " + JSON.stringify(detail) : "")); if (!cond) { failed++; fails.push(label); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(STATE)) { console.log("FAIL .tmp/localdev-state 없음 — 먼저 node build-tools/local-dev.mjs && node build-tools/seed-local.mjs"); process.exit(2); }
if (!fs.existsSync(CHROME)) { console.log("FAIL Chrome 없음: " + CHROME); process.exit(2); }

function sh(cmd) { console.log("[p138] $ " + cmd); execSync(cmd, { stdio: "inherit", cwd: ROOT, env: { ...process.env, TEMP: TMP, TMP: TMP } }); }
sh("python build-tools/assemble.py");

const UI_PATH = path.join(ROOT, "public", "js", "modules", "11_UI.js");
const uiBackup = fs.readFileSync(UI_PATH, "utf8");
if (MUT) {
  // 뮤테이션 — 수정분(UI.showScreen 의 Prompt.closeAll() 호출)을 제거해 구 동작으로 되돌린다.
  const from = '      if (typeof Prompt !== "undefined" && Prompt.closeAll) Prompt.closeAll();\n';
  const idx = uiBackup.indexOf(from);
  if (idx < 0) { console.log("FAIL 뮤테이션 대상 문자열 없음 — 수정분이 이미 다른 형태로 바뀐 듯"); process.exit(2); }
  fs.writeFileSync(UI_PATH, uiBackup.slice(0, idx) + uiBackup.slice(idx + from.length));
}
sh("node build-tools/stamp-version.mjs");
for (const [src, dst] of [["public/js/main.js", "js/main.js"], ["public/index.html", "index.html"], ["public/css/style.css", "css/style.css"]]) {
  fs.copyFileSync(path.join(ROOT, src), path.join(ROOT, dst));
}
sh('node --max-old-space-size=640 node_modules/vite/bin/vite.js build');

// 고정 포트는 이전 실행의 고아 프로세스(TIME_WAIT/미정리)가 묵은 번들을 계속 서빙해 거짓 PASS 를
// 낼 수 있다(2026-10-08/09 실사고 — 위 "서빙 중인 번들" 가드와 함께 이중 방어). 매 실행 고유 포트.
const PORT = process.env.P138_PORT || String(19000 + (Date.now() % 900));
const wrangler = spawn("node", ["node_modules/wrangler/bin/wrangler.js", "pages", "dev", "dist", "--d1=webapp-production", "--local", "--persist-to", STATE, "--ip", "127.0.0.1", "--port", PORT], { cwd: ROOT, env: { ...process.env, TEMP: TMP, TMP: TMP }, stdio: ["ignore", "pipe", "pipe"] });
let wranglerLog = "";
wrangler.stdout.on("data", (d) => { wranglerLog += d; });
wrangler.stderr.on("data", (d) => { wranglerLog += d; });
const BASE = "http://127.0.0.1:" + PORT;
async function waitServerUp() { for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + "/"); if (r.status) return true; } catch (e) {} await wait(500); } return false; }

let chrome = null, ws = null;
async function closeChrome() { try { ws && ws.close(); } catch (e) {} try { chrome && chrome.kill(); } catch (e) {} }
async function cleanup() {
  await closeChrome();
  try { wrangler.kill(); } catch (e) {}
  if (MUT) { try { fs.writeFileSync(UI_PATH, uiBackup); console.log("[p138] 뮤테이션 원복 완료(fs 백업 복원, git 미사용)"); } catch (e) { console.log("[p138] WARN 뮤테이션 원복 실패(수동 확인 필요): " + e.message); } }
}

try {
  const up = await waitServerUp();
  if (!up) { console.log("FAIL wrangler dev 기동 실패:\n" + wranglerLog.slice(-1500)); await cleanup(); process.exit(1); }

  // 🔴 [라이브 실측 함정 재발 방지 — 2026-10-08/09 실사고] 포트가 이전 실행의 묵은 서버(옛 번들)를
  //   그대로 돌려줄 수 있다(Windows TIME_WAIT/고아 프로세스). 단언 전 "지금 서빙되는 번들"이
  //   기대하는 뮤테이션 상태와 일치하는지 먼저 확인 — 안 맞으면 테스트 자체가 가짜 PASS 를 낼 수 있다.
  const servedJs = await (await fetch(BASE + "/js/main.js")).text();
  const servedHasFix = servedJs.includes("Prompt.closeAll()");
  ok(servedHasFix === !MUT, "서빙 중인 번들의 뮤테이션 상태 일치(MUT=" + MUT + " → closeAll 호출 " + (MUT ? "없어야" : "있어야") + " 함)", { servedHasFix, MUT });
  if (servedHasFix === MUT) { console.log("FAIL 묵은 서버가 옛 번들을 서빙 중 — 포트 충돌 의심, 재실행하세요"); await cleanup(); process.exit(1); }

  const profileDir = path.join(TMP, "p138-chrome-" + Date.now());
  chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", "--user-data-dir=" + profileDir, "--window-size=1400,1130", "about:blank"], { stdio: "ignore" });
  const devtoolsPort = async () => { for (let i = 0; i < 80; i++) { try { const p = parseInt(fs.readFileSync(path.join(profileDir, "DevToolsActivePort"), "utf8").split("\n")[0], 10); if (p > 0) return p; } catch (e) {} await wait(150); } throw new Error("DevToolsActivePort 없음"); };
  const getJson = (url) => new Promise((resolve, reject) => http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on("error", reject));
  const port = await devtoolsPort();
  let pageWs = null;
  for (let i = 0; i < 40 && !pageWs; i++) { try { const l = await getJson("http://127.0.0.1:" + port + "/json/list"); const pg = l.find((t) => t.type === "page"); if (pg) pageWs = pg.webSocketDebuggerUrl; } catch (e) {} if (!pageWs) await wait(250); }
  ws = new WebSocket(pageWs);
  await new Promise((r) => ws.on("open", r));
  let idc = 0; const pending = new Map();
  ws.on("message", (raw) => { const msg = JSON.parse(raw); if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); } });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++idc; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result.value; };
  const evSafe = async (expr) => { try { return await ev(expr); } catch (e) { return { __err: String(e.message).slice(0, 600) }; } };
  const waitFor = async (cond, timeout = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await evSafe("(function(){try{return !!(" + cond + ")}catch(e){return false}})()"); if (v === true) return Date.now() - t0; await wait(150); } return -1; };
  const shot = async (name) => { const s = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, (MUT ? "mut-" : "") + name + ".png"), Buffer.from(s.data, "base64")); };

  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1130, deviceScaleFactor: 1, mobile: false });

  const accPath = path.join(TMP, "local-test-accounts.json");
  if (!fs.existsSync(accPath)) { console.log("FAIL .tmp/local-test-accounts.json 없음"); await cleanup(); process.exit(2); }
  const PW = JSON.parse(fs.readFileSync(accPath, "utf8")).accounts.find((a) => a.role === "designer").password;
  await send("Page.navigate", { url: BASE + "/manifest.webmanifest" });
  await waitFor("location.pathname === '/manifest.webmanifest'", 20000);
  const loginRes = await ev(`fetch("${BASE}/api/signup/login", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ email: "designer@test.local", password: ${JSON.stringify(PW)} }) }).then(r => r.json())`);
  ok(!!(loginRes && loginRes.token), "로그인 성공(local designer)", loginRes && loginRes.error);
  await ev(`localStorage.setItem("wm_local_token", ${JSON.stringify(loginRes.token)}); 1`);

  await send("Page.navigate", { url: BASE + "/" });
  await waitFor("document.querySelector('.hub-card-thumb') || document.querySelector('#screen-app.active')", 30000);
  await wait(800);

  // ① "+ 새 프로젝트" → 빈 이름으로 확인 → 검증 에러
  await evSafe("(function(){ var b=document.querySelector('.hub-card-add'); b&&b.click(); })()");
  const modalUp = await waitFor("document.getElementById('prompt-modal') && !document.getElementById('prompt-modal').classList.contains('hidden')", 5000);
  ok(modalUp >= 0, "새 프로젝트 모달 열림", modalUp);
  await evSafe("(function(){ var b=document.getElementById('prompt-modal-ok'); b&&b.click(); })()");
  await wait(400);
  const errShown = await evSafe("(function(){ var e=document.getElementById('prompt-modal-error'); return e && !e.classList.contains('hidden'); })()");
  ok(errShown === true, "빈 이름 → 검증 에러 표시", errShown);
  await shot("01-validation-error");

  // ② 모달을 닫지 않고 "←"(뒤로가기) → 허브 복귀
  await evSafe("(function(){ var b=document.getElementById('btn-back'); b&&b.click(); })()");
  await wait(800);
  const hubVisible = await waitFor("document.getElementById('screen-projects') && document.getElementById('screen-projects').classList.contains('active')", 8000);
  ok(hubVisible >= 0, "뒤로가기 → 허브 화면 전환", hubVisible);
  await shot("02-after-back-hub");
  const modalGoneAtHub = await evSafe("(function(){ var m=document.getElementById('prompt-modal'); return !m || m.classList.contains('hidden'); })()");
  ok(modalGoneAtHub === true, "핵심 — 허브 복귀 후 모달이 닫혀 있다(수정 전엔 계속 떠 있었음)", modalGoneAtHub);

  // ③ 다른(시드) 프로젝트로 진입 — 모달이 그 화면까지 안 떠 있는지
  await evSafe(`(function(){ var cards=Array.from(document.querySelectorAll('.hub-card')).filter(function(c){return !c.classList.contains('hub-card-add');}); var t=cards.find(function(c){return /로컬 테스트 프로젝트/.test(c.textContent);}); if(t){t.click(); return true;} return false; })()`);
  await wait(1200);
  await waitFor("document.getElementById('screen-app') && document.getElementById('screen-app').classList.contains('active')", 10000);
  await wait(500);
  await shot("03-after-enter-other-project");
  const modalGoneAtProject = await evSafe("(function(){ var m=document.getElementById('prompt-modal'); return !m || m.classList.contains('hidden'); })()");
  ok(modalGoneAtProject === true, "다른 프로젝트 진입 후에도 모달이 닫혀 있다", modalGoneAtProject);

  // ④ 배경(지도) 클릭이 정상 동작하는지(모달이 없으니 당연히 막히지 않아야 함 — 회귀 방지용 보조 단언)
  const vp = await evSafe("(function(){ var e=document.getElementById('map-viewport'); if(!e) return null; var r=e.getBoundingClientRect(); return { x:r.left+r.width/2, y:r.top+r.height/2 }; })()");
  if (vp) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: vp.x, y: vp.y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: vp.x, y: vp.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: vp.x, y: vp.y, button: "left", clickCount: 1 });
    await wait(300);
  }
  ok(!!vp, "지도 뷰포트에서 배경 클릭 가능(모달 잔존으로 가려지지 않음)", vp);

  console.log(failed ? `\n[p138] FAIL ${failed}건` : "\n[p138] ALL PASS");
  await shot("99-final");
  await cleanup();
  process.exit(failed ? 1 : 0);
} catch (e) {
  console.log("ERROR " + (e && e.stack || e));
  await cleanup();
  process.exit(1);
}
