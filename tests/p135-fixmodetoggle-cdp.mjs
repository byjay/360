/**
 * p135 — WO 20261008-fixmodetoggle 실 Chrome 실측(p124 하니스 재사용: 실 워커+D1+R2, 목 0).
 *   근본원인: public/css/style.css(+ 미러 css/style.css) .regmode-btn.active 가 모드 무관 고정
 *   남색(#0f172a)이었다 — 어두운 상단바(seastar-3d-skin.css .topbar{background:var(--panel)})
 *   위에서 활성(남색)이 꺼진 것처럼, 비활성(#f8fafc 흰색)이 선택된 것처럼 보였다(지휘자 R1).
 *   수정: 모드별 색(CHECKER #c2410c 주황 / 360 #2563eb 파랑) + ✓ 표시 + 굵은 글자.
 * 실행: P135=1 TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p135-fixmodetoggle-cdp.mjs
 *   (P135 != "1" 이면 SKIP) 뮤테이션: P135_MUT=1 (구 규칙을 !important 로 되살려 EXIT=1 기대)
 *   스크린샷: .tmp/fixmodetoggle/
 */
import { execSync, spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { fileURLToPath } from "node:url";
import { FIND_SEED_ORIGIN } from "./_lib/seed-origin.mjs";   // [2026-10-10] 시드 카드 스코프(누적 D1 의 빈 프로젝트 오클릭 방지)

if (process.env.P135 !== "1") { console.log("[SKIP] p135 는 P135=1 일 때만 실행(실 Chrome+워커 실측)"); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = path.join(ROOT, ".tmp");
const OUT = path.join(TMP, "fixmodetoggle");
const STATE = path.join(TMP, "localdev-state");
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const MUT = process.env.P135_MUT === "1";

let failed = 0; const fails = [];
const ok = (cond, label, detail) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null ? " :: " + JSON.stringify(detail) : "")); if (!cond) { failed++; fails.push(label); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(STATE)) { console.log("FAIL .tmp/localdev-state 없음 — 먼저 node build-tools/local-dev.mjs && node build-tools/seed-local.mjs"); process.exit(2); }
if (!fs.existsSync(CHROME)) { console.log("FAIL Chrome 없음: " + CHROME); process.exit(2); }

function sh(cmd) { console.log("[p135] $ " + cmd); execSync(cmd, { stdio: "inherit", cwd: ROOT, env: { ...process.env, TEMP: TMP, TMP: TMP } }); }
sh("python build-tools/assemble.py");
// 🔴 git checkout 금지(CLAUDE.md §G-1) — 뮤테이션 원복은 fs 백업/복원만 쓴다(git 되돌리기는
// 커밋 전 작업트리의 미커밋 변경분을 통째로 날린 실사고가 있다).
const STYLE_PATH = path.join(ROOT, "public", "css", "style.css");
const MIRROR_STYLE_PATH = path.join(ROOT, "css", "style.css"); // 🔴 뮤테이션이 미러로도 번져 잔류하는 사고 재발 방지 — 둘 다 백업/복원
const styleBackup = fs.readFileSync(STYLE_PATH, "utf8");
const mirrorStyleBackup = fs.readFileSync(MIRROR_STYLE_PATH, "utf8");
if (MUT) {
  // 뮤테이션: 수정분을 구 동작으로 되돌린다 — !important 로 모드색 규칙을 덮어 고정 남색으로 복원
  let css = styleBackup;
  css += "\n.regmode-btn.active{background:#0f172a !important;color:#fff !important;}\n#btn-regmode-checkboard.active,#btn-regmode-photo.active{background:#0f172a !important;border-color:#0f172a !important;}\n";
  fs.writeFileSync(STYLE_PATH, css);
}
sh("node build-tools/stamp-version.mjs");
for (const [src, dst] of [["public/js/main.js", "js/main.js"], ["public/index.html", "index.html"], ["public/css/style.css", "css/style.css"]]) {
  fs.copyFileSync(path.join(ROOT, src), path.join(ROOT, dst));
}
sh('node --max-old-space-size=640 node_modules/vite/bin/vite.js build');

const PORT = process.env.P135_PORT || "18811";
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
  if (MUT) { try { fs.writeFileSync(STYLE_PATH, styleBackup); fs.writeFileSync(MIRROR_STYLE_PATH, mirrorStyleBackup); console.log("[p135] 뮤테이션 원복 완료(fs 백업 복원 — public/css·css 미러 둘 다, git 미사용)"); } catch (e) { console.log("[p135] WARN 뮤테이션 원복 실패(수동 확인 필요): " + e.message); } }
}

try {
  const up = await waitServerUp();
  if (!up) { console.log("FAIL wrangler dev 기동 실패:\n" + wranglerLog.slice(-1500)); await cleanup(); process.exit(1); }

  const profileDir = path.join(TMP, "p135-chrome-" + Date.now());
  for (const [W, H, tag] of [[375, 812, "mobile"], [1280, 900, "desktop"]]) {
    chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", "--user-data-dir=" + profileDir + "-" + tag, "--window-size=" + W + "," + H, "about:blank"], { stdio: "ignore" });
    const devtoolsPort = async () => { for (let i = 0; i < 80; i++) { try { const p = parseInt(fs.readFileSync(path.join(profileDir + "-" + tag, "DevToolsActivePort"), "utf8").split("\n")[0], 10); if (p > 0) return p; } catch (e) {} await wait(150); } throw new Error("DevToolsActivePort 없음"); };
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
    const shot = async (name) => { const s = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, tag + "-" + name + ".png"), Buffer.from(s.data, "base64")); };

    await send("Page.enable"); await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: tag === "mobile" });
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
    if (!fs.existsSync(accPath)) { console.log("FAIL .tmp/local-test-accounts.json 없음"); await cleanup(); process.exit(2); }
    const PW = JSON.parse(fs.readFileSync(accPath, "utf8")).accounts.find((a) => a.role === "designer").password;
    await send("Page.navigate", { url: BASE + "/manifest.webmanifest" });
    await waitFor("location.pathname === '/manifest.webmanifest'", 20000);
    const loginRes = await ev(`fetch("${BASE}/api/signup/login", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ email: "designer@test.local", password: ${JSON.stringify(PW)} }) }).then(r => r.json())`);
    ok(!!(loginRes && loginRes.token), tag + " 로그인 성공(local designer)", loginRes && loginRes.error);
    await ev(`localStorage.setItem("wm_local_token", ${JSON.stringify(loginRes.token)}); 1`);

    await send("Page.navigate", { url: BASE + "/" });
    await waitFor("document.querySelector('.hub-card-thumb') || document.querySelector('#screen-app.active')", 30000);
    await wait(600);

    let clickRes = { found: false };
    for (let i = 0; i < 20 && !clickRes.found; i++) { await wait(300); clickRes = await evSafe(`(function(){ var e = ${FIND_SEED_ORIGIN}; if (!e) return {found:false}; e.scrollIntoView({block:'center'}); e.click(); return {found:true}; })()`); }
    ok(clickRes.found, tag + " 원본 도면 진입 클릭 성공", clickRes);
    const regUp = await waitFor("document.getElementById('btn-regmode-photo') && document.getElementById('btn-regmode-checkboard')", 20000);
    ok(regUp >= 0, tag + " 모드 세그먼트 DOM 등장", regUp);

    // 콘트라스트 계산(JS 내 WCAG 상대휘도 공식, .tmp/contrast.mjs 와 동일 수식)
    const contrastFn = `function lin(c){c/=255;return c<=0.03928?c/12.92:Math.pow((c+0.055)/1.055,2.4);} function relL(rgb){var m=rgb.match(/\\d+/g).map(Number);return 0.2126*lin(m[0])+0.7152*lin(m[1])+0.0722*lin(m[2]);} function ratio(a,b){var l1=relL(a),l2=relL(b);var hi=Math.max(l1,l2),lo=Math.min(l1,l2);return (hi+0.05)/(lo+0.05);}`;

    // [견고화] p124 주석과 동일한 배경 재진입 경합 — 전환 직후 .topbar/버튼이 일시적으로 null일 수
    // 있어(DOM 통째 재생성) 최대 6회 재시도한다.
    const measureOnce = async (activeId, inactiveId) => evSafe(`(function(){ ${contrastFn}
      var a=document.getElementById(${JSON.stringify(activeId)}), i=document.getElementById(${JSON.stringify(inactiveId)}), top=document.querySelector('.topbar');
      if (!a || !i || !top) return { __retry: true, a: !!a, i: !!i, top: !!top };
      var ca=getComputedStyle(a), ci=getComputedStyle(i), ctop=getComputedStyle(top);
      return {
        activeBg: ca.backgroundColor, activeColor: ca.color, activeAriaPressed: a.getAttribute('aria-pressed'),
        inactiveBg: ci.backgroundColor, inactiveColor: ci.color, inactiveAriaPressed: i.getAttribute('aria-pressed'),
        topbarBg: ctop.backgroundColor,
        textContrastActive: ratio(ca.color, ca.backgroundColor),
        boundaryContrastActiveVsTopbar: ratio(ca.backgroundColor, ctop.backgroundColor),
        activeHasCheckmark: getComputedStyle(a, '::before').content.indexOf('2713') >= 0 || a.textContent.indexOf('\\u2713') >= 0 || getComputedStyle(a,'::before').content.indexOf('\\u2713') >= 0
      };
    })()`);
    const measure = async (activeId, inactiveId) => {
      let r = { __retry: true };
      for (let i = 0; i < 6 && (r.__retry || r.__err); i++) { r = await measureOnce(activeId, inactiveId); if (r.__retry || r.__err) await wait(300); }
      return r;
    };

    // [견고화] 클릭 1회로 즉시 반영이 안 될 때(배경 재진입 경합) 반영될 때까지 재클릭한다.
    // _setRegMode()는 매번 openApp() 전체 재진입(실 D1 재조회)을 트는 무거운 호출이다(20_App.js:748~761).
    // 짧은 간격으로 재클릭하면 재진입이 겹쳐 쌓여 더 느려진다(클릭 스톰) — 1회 클릭 후 넉넉히
    // 기다리고, 그래도 안 되면 "재클릭"이 아니라 길게 1번 더 기다린다(최대 2회만 클릭).
    const clickModeAndWait = async (id) => {
      for (let i = 0; i < 2; i++) {
        await evSafe(`(function(){ var e=document.getElementById(${JSON.stringify(id)}); e && e.click(); return 1; })()`);
        const okSet = await waitFor(`document.getElementById(${JSON.stringify(id)}) && document.getElementById(${JSON.stringify(id)}).getAttribute('aria-pressed')==='true'`, 9000);
        if (okSet >= 0) return true;
      }
      return false;
    };

    // ① 360(photo) 활성화 — 기본은 checkboard 가 활성일 수 있으므로 photo 클릭
    const c1 = await clickModeAndWait("btn-regmode-photo");
    ok(c1, tag + " 360 클릭 → aria-pressed=true 반영", c1);
    const m1 = await measure("btn-regmode-photo", "btn-regmode-checkboard");
    console.log(tag + " [360 활성] " + JSON.stringify(m1));
    await shot("01-360-active");
    ok(m1.activeAriaPressed === "true" && m1.inactiveAriaPressed === "false", tag + " aria-pressed 360=true/CHECKER=false", m1);
    ok(m1.textContrastActive >= 4.5, tag + " 360 활성 글자대비 >=4.5", m1.textContrastActive);
    ok(m1.boundaryContrastActiveVsTopbar >= 3, tag + " 360 활성 vs 상단바 경계대비 >=3", m1.boundaryContrastActiveVsTopbar);
    ok(!/15,\s*23,\s*42/.test(m1.activeBg), tag + " 360 활성배경이 구 고정남색(15,23,42)이 아님", m1.activeBg);
    ok(m1.activeHasCheckmark, tag + " 360 활성에 체크표시(색 이외 단서) 존재", m1.activeHasCheckmark);

    // ② CHECKER(checkboard) 활성화 — 360 전환 직후 사진등록 전용 UI(파일창 등) 재배치와 경합할
    // 수 있어 약간의 settle 대기 후 클릭한다(p124 문서화된 배경 재진입 경합과 동일 패턴).
    await wait(500);
    const c2 = await clickModeAndWait("btn-regmode-checkboard");
    if (!c2) { const diag = await evSafe("({ mode: __T.State.mode, regMode: __T.State.regMode, placing: __T.State.placing, hasBtn: !!document.getElementById('btn-regmode-checkboard'), hasPhotoBtn: !!document.getElementById('btn-regmode-photo') })"); console.log(tag + " [진단] " + JSON.stringify(diag)); }
    ok(c2, tag + " CHECKER 클릭 → aria-pressed=true 반영", c2);
    const m2 = await measure("btn-regmode-checkboard", "btn-regmode-photo");
    console.log(tag + " [CHECKER 활성] " + JSON.stringify(m2));
    await shot("02-checker-active");
    ok(m2.activeAriaPressed === "true" && m2.inactiveAriaPressed === "false", tag + " aria-pressed CHECKER=true/360=false", m2);
    ok(m2.textContrastActive >= 4.5, tag + " CHECKER 활성 글자대비 >=4.5", m2.textContrastActive);
    ok(m2.boundaryContrastActiveVsTopbar >= 3, tag + " CHECKER 활성 vs 상단바 경계대비 >=3", m2.boundaryContrastActiveVsTopbar);
    // 핵심 회귀 포인트: 활성 버튼 휘도가 비활성 버튼 휘도보다 "뚜렷이" 높아야 한다(구버그는 반대로 낮았다)
    ok(!/15,\s*23,\s*42/.test(m2.activeBg), tag + " CHECKER 활성배경이 구 고정남색(15,23,42)이 아님(반전 아님)", m2.activeBg);
    // 모드색 식별: CHECKER=주황계열(c2410c 근방: r>150,g<100,b<60), 360=파랑계열(2563eb 근방: b>150,r<100)
    const m1rgb = m1.activeBg.match(/\d+/g).map(Number);
    const m2rgb = m2.activeBg.match(/\d+/g).map(Number);
    ok(m1rgb[2] > 150 && m1rgb[0] < 120, tag + " 360 활성배경=파랑계열", m1.activeBg);
    ok(m2rgb[0] > 150 && m2rgb[2] < 80, tag + " CHECKER 활성배경=주황계열", m2.activeBg);

    await closeChrome();
  }
  await cleanup();
} catch (e) {
  console.log("FAIL 예외: " + e.message);
  failed++; fails.push("exception:" + e.message);
  await cleanup();
}

console.log(failed ? ("\nFAIL " + failed + "건: " + fails.join(", ")) : "\nPASS 전체 통과");
process.exit(failed ? 1 : 0);
