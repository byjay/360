/**
 * p179b — WO 20261022-pinprefs 추가 §3: 비로그인 공유 열람 링크(/v/<토큰>, p149-viewlink-anon-cdp.mjs
 * 와 같은 격리 빌드+실 wrangler dev+실 D1+실 Chrome 패턴 재사용 — p163/p163b 처럼 무거운 서버 검증은
 * 별 파일로 분리)에서 핀 크기 슬라이더·번호 표시 옵션에 접근 가능한지 실측한다.
 *
 * [재현] 지휘자 지시 원문: "뷰어 전용 모드는 설정 버튼(#btn-settings)을 숨기는 것으로 알려져 있다 —
 *   숨겨져 있으면 뷰어 화면에 작은 '표시' 컨트롤을 추가해라." 지휘자 직접 재실행(p149 01-viewer-first.png,
 *   .tmp\p149\01-viewer-first.png)로 실측: 비로그인 공유 링크(/v/<토큰>) 화면 우상단에 "⚙ 설정" 버튼이
 *   그대로 보인다(public/index.html #btn-settings 는 "designer-only" 클래스가 없고, 20_App.js openApp()
 *   은 "설정 버튼은 항상 노출"이라며 매번 .hidden 을 제거, public/css/style.css 에도 wm-view-link·
 *   role-viewer 조건부로 #btn-settings 를 숨기는 규칙이 0건 — 3곳 grep 확인). 또한 24_Settings.js
 *   Settings.init() 은 App.init() 부트스트랩에서 **역할과 무관하게 1회** 호출되며 그 안에서
 *   PinSizePrefs.initSlider()/PinLabelPrefs.initToggle() 을 이미 무조건 실행한다 — 즉 설정 UI 는
 *   로그인·디자이너 여부와 상관없이 이미 뷰어 링크에도 꽂혀 있었다(새 "표시" 컨트롤 추가 불필요,
 *   발주서의 조건부 지시 "숨겨져 있으면"이 거짓으로 판명 — 아래 (i)가 그 실측 단언).
 *
 * 검증(실 서버, 실 Chrome):
 *  (i)   /v/<토큰> 화면에서 #btn-settings 가 보인다(편집 기능은 아님 — 열람자 쓰기는 p149 A7 이 이미
 *        전 구간 4xx 로 검증).
 *  (ii)  설정 버튼 클릭 → 모달 안에 #pinsize-slider·[data-pinlabel-opt] 3개 존재.
 *  (iii) 슬라이더를 움직이면 점 지름이 즉시 반영(화면 getBoundingClientRect), 번호 옵션 클릭도 즉시 반영.
 *  (iv)  새로고침(같은 통행증) 후에도 설정값 유지(localStorage, 디자이너 데이터 PATCH 는 아님 — p149 A7
 *        계약과 무관, 기기별 표시 설정).
 *  (v)   편집 전용 버튼([data-regmethod]·#btn-go-edit 등)은 여전히 비노출/비활성 — 새 컨트롤이 편집 권한을
 *        누수시키지 않았다는 안전망.
 *
 * 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p179b-viewlink-pinprefs-cdp.mjs
 *   뮤테이션(반드시 EXIT=1): P179B_MUT=removeinject → 24_Settings.js 에서 PinSizePrefs.initSlider()/
 *   PinLabelPrefs.initToggle() 호출을 제거 → (ii) 컨트롤이 모달에 없어 FAIL.
 * 사전: .tmp/localdev-state (p149 와 동일 — node build-tools/local-dev.mjs && node build-tools/seed-local.mjs)
 */
import { execSync, spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = path.join(ROOT, ".tmp");
const MUT = process.env.P179B_MUT || "";
const OUT = path.join(TMP, "p179b" + (MUT ? "-mut-" + MUT : ""));
const WORK = path.join(OUT, "work");
const STATE_SRC = path.join(TMP, "localdev-state");
const STATE = path.join(OUT, "state");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const NM = path.join(ROOT, "node_modules");
const PID = "proj_localseed";
let failed = 0;
const ok = (c, label, d) => { console.log((c ? "  PASS " : "  FAIL ") + label + (d != null ? " :: " + JSON.stringify(d).slice(0, 400) : "")); if (!c) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
if (!fs.existsSync(STATE_SRC)) { console.log("FAIL .tmp/localdev-state 없음"); process.exit(2); }
if (!fs.existsSync(CHROME)) { console.log("FAIL Chrome 없음"); process.exit(2); }
const watchdog = setTimeout(() => { console.log("\nWATCHDOG — 300s 초과 → FAIL"); process.exit(1); }, 300000);

const MUTS = {
  removeinject: ["public/js/modules/24_Settings.js",
    '      if (typeof PinSizePrefs !== "undefined" && PinSizePrefs.initSlider) PinSizePrefs.initSlider();\n      // [WO 20261019-pinscale4] 핀 번호 표시 옵션(항상/자동/숨김) — 슬라이더 바로 뒤, 같은 런타임 주입 패턴.\n      if (typeof PinLabelPrefs !== "undefined" && PinLabelPrefs.initToggle) PinLabelPrefs.initToggle();',
    "      // [MUT removeinject] 주입 제거"],
};
if (MUT && !MUTS[MUT]) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }

fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
for (const f of ["public", "src", "migrations"]) fs.cpSync(path.join(ROOT, f), path.join(WORK, f), { recursive: true, filter: (s) => !/[\\/]public[\\/]js[\\/]main\.js$/.test(s) });
for (const f of ["vite.config.ts", "package.json", "tsconfig.json", "wrangler.jsonc"]) fs.copyFileSync(path.join(ROOT, f), path.join(WORK, f));
{
  const wj = path.join(WORK, "wrangler.jsonc");
  const txt = fs.readFileSync(wj, "utf8").replace(/,(\s*\/\/[^\r\n]*)*\s*"ai"\s*:\s*\{[^}]*\}/, "");
  fs.writeFileSync(wj, txt);
}
if (MUT) {
  const [file, from, to] = MUTS[MUT];
  const fp = path.join(WORK, file);
  const src = fs.readFileSync(fp, "utf8").replace(/\r\n/g, "\n");
  if (src.indexOf(from) < 0) { console.log("  FAIL 뮤테이션 대상 문자열 없음: " + MUT); process.exit(2); }
  fs.writeFileSync(fp, src.replace(from, to));
  console.log("[MUT] " + MUT + " — " + file + " 의 설정 UI 주입 호출 제거");
}
const man = fs.readFileSync(path.join(WORK, "public/js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
fs.writeFileSync(path.join(WORK, "public/js/main.js"), man.map((f) => fs.readFileSync(path.join(WORK, "public/js/modules", f), "utf8")).join("\n"));
const env = { ...process.env, TEMP: TMP, TMP: TMP };
execSync(`node --max-old-space-size=640 "${path.join(NM, "vite/bin/vite.js")}" build`, { cwd: WORK, env, stdio: "pipe" });
fs.rmSync(STATE, { recursive: true, force: true });
fs.cpSync(STATE_SRC, STATE, { recursive: true });
const wr = (args) => execSync(`node "${path.join(NM, "wrangler/bin/wrangler.js")}" ${args}`, { cwd: WORK, env, stdio: "pipe" });
for (const mf of fs.readdirSync(path.join(WORK, "migrations")).filter((f) => /^\d+_.*\.sql$/.test(f) && f >= "0042")) {
  try { wr(`d1 execute webapp-production --local --persist-to "${STATE}" --file "migrations/${mf}"`); } catch (e) {}
}

const PORT = process.env.P179B_PORT || "18879";
const wrangler = spawn("node", [path.join(NM, "wrangler/bin/wrangler.js"), "pages", "dev", "dist", "--d1=webapp-production", "--local", "--persist-to", STATE, "--ip", "127.0.0.1", "--port", PORT],
  { cwd: WORK, env, stdio: ["ignore", "pipe", "pipe"] });
let wlog = ""; wrangler.stdout.on("data", (d) => (wlog += d)); wrangler.stderr.on("data", (d) => (wlog += d));
const BASE = "http://127.0.0.1:" + PORT;
let chrome = null; const sockets = [];
async function cleanup() { sockets.forEach((s) => { try { s.close(); } catch (e) {} }); try { chrome && chrome.kill(); } catch (e) {} try { wrangler.kill(); } catch (e) {} }

const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej));
async function api(method, url, body, tok) {
  const r = await fetch(BASE + url, { method, redirect: "manual", headers: Object.assign({ "Content-Type": "application/json" }, tok ? { Authorization: "Bearer " + tok } : {}), body: body == null ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch (e) {}
  return { s: r.status, j, text };
}
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
  const ev = async (expr, ms) => { const r = await Promise.race([send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }), wait(ms || 30000).then(() => { throw new Error("evaluate 무응답"); })]); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
  const waitFor = async (cond, t = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { try { if ((await ev("(function(){try{return !!(" + cond + ")}catch(e){return false}})()", 8000)) === true) return Date.now() - t0; } catch (e) {} await wait(150); } return -1; };
  return { send, ev, waitFor, errs };
}

try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { const r = await fetch(BASE + "/manifest.webmanifest"); up = !!r.status; } catch (e) {} if (!up) await wait(500); }
  if (!up) { console.log("FAIL wrangler 기동 실패\n" + wlog.slice(-1500)); process.exit(1); }

  const acc = JSON.parse(fs.readFileSync(path.join(TMP, "local-test-accounts.json"), "utf8")).accounts;
  const sup = acc.find((a) => a.role === "super");
  const sTok = (await api("POST", "/api/signup/login", { email: sup.email, password: sup.password })).j.token;
  ok(!!sTok, "준비 — 로컬 super 로그인");

  const pub = await api("POST", "/api/projects/" + PID + "/publish", null, sTok);
  const sp = pub.j && pub.j.project && pub.j.project.share_path;
  ok(pub.s === 200 && !!sp, "준비 — 배포 → 열람 링크 발급", sp);
  await api("PUT", "/api/projects/" + PID + "/viewer-access", { email_auth: false }, sTok); // p149 A1c 와 동일(무인증 링크)

  const profile = path.join(TMP, "p179b-chrome-" + Date.now());
  chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", "--user-data-dir=" + profile, "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
  let port = 0;
  for (let i = 0; i < 80 && !port; i++) { try { port = parseInt(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0], 10); } catch (e) {} if (!port) await wait(150); }
  let pageWs = null;
  for (let i = 0; i < 40 && !pageWs; i++) { try { const l = await getJson("http://127.0.0.1:" + port + "/json/list"); const pg = l.find((t) => t.type === "page"); if (pg) pageWs = pg.webSocketDebuggerUrl; } catch (e) {} if (!pageWs) await wait(250); }
  const P = await connect(pageWs);
  await P.send("Page.enable"); await P.send("Runtime.enable");
  await P.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  await P.send("Page.navigate", { url: BASE + sp });
  const loadedPins = await P.waitFor("window.__wm && __wm.State.pins && __wm.State.pins.length > 0", 40000);
  ok(loadedPins >= 0, "준비 — /v/<토큰> 열람 세션 로드(핀 렌더됨)");

  // ── (i) 설정 버튼 가시성 ──
  const btnVis = await P.ev(`(function(){ var b = document.getElementById('btn-settings'); if (!b) return { exists: false }; var r = b.getBoundingClientRect(); var s = getComputedStyle(b); return { exists: true, visible: r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden', readonly: __wm.Auth.readonly }; })()`);
  ok(btnVis.exists && btnVis.visible === true && btnVis.readonly === true, "(i) 비로그인 열람 링크에서도 #btn-settings 노출(readonly 세션)", btnVis);

  // ── (ii) 설정 모달 → 핀 크기/번호 컨트롤 존재 ──
  await P.ev(`document.getElementById('btn-settings').click(); 1`);
  await wait(300);
  const ctrl = await P.ev(`(function(){ var s = document.getElementById('pinsize-slider'); var btns = document.querySelectorAll('[data-pinlabel-opt]'); return { slider: !!s, sliderVis: s ? (s.getBoundingClientRect().width > 0) : false, labelBtns: btns.length }; })()`);
  ok(ctrl.slider && ctrl.sliderVis && ctrl.labelBtns === 3, "(ii) 설정 모달에 핀 크기 슬라이더 + 번호 표시 3단 버튼 존재", ctrl);

  if (ctrl.slider) {
    // ── (iii) 즉시 반영 ──
    const before = await P.ev(`(function(){ var m = document.querySelector('#pins-layer > .pin-marker'); var d = m && m.querySelector('.pin-dot'); return d ? d.getBoundingClientRect().width : null; })()`);
    await P.ev(`(function(){ var s = document.getElementById('pinsize-slider'); s.value = s.max; s.dispatchEvent(new Event('input')); })()`);
    await wait(300);
    const after = await P.ev(`(function(){ var m = document.querySelector('#pins-layer > .pin-marker'); var d = m && m.querySelector('.pin-dot'); return d ? d.getBoundingClientRect().width : null; })()`);
    ok(before != null && after != null && after > before, "(iii) 슬라이더(MAX) 조작 → 점 지름 즉시 증가(마커 재생성 없이)", { before, after });

    await P.ev(`(function(){ document.querySelector('[data-pinlabel-opt="hidden"]').click(); })()`);
    await wait(300);
    const hidden = await P.ev(`(function(){ var m = document.querySelector('#pins-layer > .pin-marker'); return m ? m.classList.contains('dot-show-num') : null; })()`);
    ok(hidden === false, "(iii) 번호 '숨김' 클릭 → dot-show-num 즉시 제거", { hidden });

    // ── (iv) 새로고침 후 유지 ── (PinSizePrefs/PinLabelPrefs 는 window.__wm 미노출 — 실제 SoT인
    // localStorage 키로 직접 확인. 키 포맷은 23c_PinSizePrefs.js _key() 그대로: wm_pinsize_<projectId>)
    const prefKeys = `(function(){ var pid = (__wm.Projects.currentProject && __wm.Projects.currentProject.id) || 'default'; return { size: localStorage.getItem('wm_pinsize_' + pid), label: localStorage.getItem('wm_pinlabel_' + pid) }; })()`;
    const stored = await P.ev(prefKeys);
    await P.send("Page.navigate", { url: BASE + sp });
    await P.waitFor("window.__wm && __wm.State.pins && __wm.State.pins.length > 0", 40000);
    const storedAfter = await P.ev(prefKeys);
    ok(storedAfter.size === stored.size && storedAfter.label === stored.label, "(iv) 새로고침(같은 통행증) 후에도 설정값 유지", { stored, storedAfter });

    // ── (v) 편집 전용 요소는 여전히 비노출(권한 누수 안전망) ──
    const editLeak = await P.ev(`(function(){ var sel = ['#btn-go-edit', '[data-regmethod]', '#btn-open-designers', '#btn-settings-checkboard-renumber']; function vis(e){ if(!e) return false; var r=e.getBoundingClientRect(); var s=getComputedStyle(e); return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden'; } var out={}; sel.forEach(function(s){ document.querySelectorAll(s).forEach(function(e){ if (vis(e)) out[s]=(out[s]||0)+1; }); }); return out; })()`);
    ok(Object.keys(editLeak).length === 0, "(v) 편집 전용 버튼(설계자 모드 전환·등록 방식·디자이너 관리) 여전히 비노출", editLeak);
  }

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
