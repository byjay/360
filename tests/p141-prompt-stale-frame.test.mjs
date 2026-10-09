/**
 * p141 — Prompt 모달: 프레임 전에 닫힌 모달이 늦은 프레임에 다시 열려 남는 결함(R3, 2026-10-10) 회귀.
 * 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p141-prompt-stale-frame.test.mjs
 *
 * [재현] p132-pin-purge-cdp "4 화면 — 열린 도면 핀 0" 4회 중 3회 FAIL(6020dc9·2f98e7a·b7b0e4c 동일).
 *   진단(DIAG): 전체삭제 직후 #prompt-modal 클래스 "admin-gate on"(숨김 안 됨) · activeElement=#prompt-modal-input
 *   · App._liveEditingNow()=true → _afterServerChange·라이브폴이 계속 "editing" 으로 건너뜀 → 화면 핀 7개 잔류.
 * 근본원인: ask()/confirm() 이 requestAnimationFrame 으로 "on" 을 붙이는데, 그 프레임 전에 닫히면(빠른 확인·느린 기기)
 *   늦은 프레임이 닫힌 모달에 "on" 을 다시 붙이고, _close() 의 지연 숨김은 "on" 이 있으면 숨기지 않는다(5eea645 가드).
 *
 * 환경: 실 Chrome 헤드리스(CDP) + 실 30_Prompt.js. 프레임 시점만 테스트가 쥔다(requestAnimationFrame 을 큐로 바꿔
 *   "닫힘 뒤에 프레임"을 결정적으로 만든다 — 실측에서 우연히 나던 순서를 매번 재현). DOM·포커스·타이머는 실물.
 * 뮤테이션: P141_MUT=ask|confirm → 해당 수정만 되돌린 사본으로 실행, EXIT=1 기대.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = path.join(ROOT, ".tmp");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
if (!fs.existsSync(CHROME)) { console.log("FAIL Chrome 없음: " + CHROME); process.exit(2); }
let failed = 0;
const ok = (c, label, d) => { console.log((c ? "  PASS " : "  FAIL ") + label + (!c && d !== undefined ? " :: " + JSON.stringify(d) : "")); if (!c) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const watchdog = setTimeout(() => { console.log("WATCHDOG 90s → FAIL"); process.exit(1); }, 90000);

let src = fs.readFileSync(path.join(ROOT, "public/js/modules/30_Prompt.js"), "utf8").replace(/\r\n/g, "\n");
const MUTS = {
  ask: ["requestAnimationFrame(() => { if (this._resolve === resolve) m.classList.add(\"on\"); });", "requestAnimationFrame(() => m.classList.add(\"on\"));"],
  confirm: ["requestAnimationFrame(() => { if (!closed) modal.classList.add(\"on\"); });", "requestAnimationFrame(() => modal.classList.add(\"on\"));"],
};
const MUT = process.env.P141_MUT || "";
if (MUT) {
  if (!MUTS[MUT] || !src.includes(MUTS[MUT][0])) { console.log("P141_MUT 치환 대상 없음: " + MUT); process.exit(3); }
  src = src.replace(MUTS[MUT][0], MUTS[MUT][1]);
  console.log("[P141_MUT=" + MUT + "]");
}

const html = `<!doctype html><html><head><meta charset="utf-8"><style>.hidden{display:none}</style></head><body>
<div id="prompt-modal" class="admin-gate hidden"><div class="admin-gate-backdrop"></div><div class="admin-gate-card">
<h2 id="prompt-modal-title"></h2><p id="prompt-modal-sub"></p><input id="prompt-modal-input"><input id="prompt-modal-input2" class="hidden">
<label id="prompt-modal-checkbox-wrap" class="hidden"><input type="checkbox" id="prompt-modal-checkbox"><span id="prompt-modal-checkbox-label"></span></label>
<div id="prompt-modal-error" class="hidden"></div><button id="prompt-modal-ok">ok</button><button id="prompt-modal-cancel">cancel</button></div></div>
<script>
  window.__raf = []; window.requestAnimationFrame = function (cb) { window.__raf.push(cb); return window.__raf.length; };
  window.__flush = function () { var q = window.__raf.splice(0); q.forEach(function (f) { f(0); }); };
  (function(){ ${src.replace(/<\/script/gi, "<\\/script")}
  ; window.Prompt = Prompt; })();
  Prompt.init();
</script></body></html>`;
fs.mkdirSync(TMP, { recursive: true });
const page = path.join(TMP, "p141-" + process.pid + ".html");
fs.writeFileSync(page, html);

const profile = path.join(TMP, "p141-chrome-" + Date.now());
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"], { stdio: "ignore" });
const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej));
let ws = null;
try {
  let port = 0;
  for (let i = 0; i < 80 && !port; i++) { try { port = parseInt(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0], 10); } catch (e) {} if (!port) await wait(150); }
  let pageWs = null;
  for (let i = 0; i < 40 && !pageWs; i++) { try { const l = await getJson("http://127.0.0.1:" + port + "/json/list"); const pg = l.find((t) => t.type === "page"); if (pg) pageWs = pg.webSocketDebuggerUrl; } catch (e) {} if (!pageWs) await wait(200); }
  ws = new WebSocket(pageWs);
  await new Promise((r) => ws.on("open", r));
  let idc = 0; const pend = new Map();
  ws.on("message", (raw) => { const m = JSON.parse(raw); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++idc; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
  await send("Page.enable");
  await send("Page.navigate", { url: "file:///" + page.replace(/\\/g, "/") });
  for (let i = 0; i < 50; i++) { if (await ev("!!(window.Prompt && document.getElementById('prompt-modal'))").catch(() => false)) break; await wait(100); }
  const S = (id) => `(function(){ var m=document.getElementById(${JSON.stringify(id)}); var a=document.activeElement; return { on: m.classList.contains('on'), hidden: m.classList.contains('hidden'), focusIn: !!(a && m.contains(a)) }; })()`;
  const sleep = (ms) => `new Promise(function(r){ setTimeout(r, ${ms}); })`;

  console.log("\n[A ask — 프레임 전에 확인(빠른 Enter·자동제출)]");
  {
    const r = await ev(`(async function(){
      var done = Prompt.ask({ title: '본인 확인', password: true });
      await ${sleep(120)};                                         // 포커스 타이머(60ms) 경과 — 입력칸 포커스
      var focused = document.activeElement && document.activeElement.id;
      document.getElementById('prompt-modal-input').value = 'pw';
      Prompt._submit();                                            // 첫 프레임 전에 제출
      var v = await done;
      __flush();                                                   // 늦게 온 프레임
      await ${sleep(300)};                                         // 지연 숨김(200ms) 경과
      return { focused: focused, value: v && v.value, st: ${S("prompt-modal")} };
    })()`);
    ok(r.focused === "prompt-modal-input" && r.value === "pw", "A0 입력칸 포커스·값 반환(정상 흐름)", r);
    ok(r.st.hidden && !r.st.on, "A1 🔴 닫힌 뒤 늦은 프레임이 와도 모달은 숨김(종전: 'on' 재부착 → 열린 채 잔류)", r.st);
    ok(!r.st.focusIn, "A2 🔴 닫힌 모달 안에 포커스 없음(_liveEditingNow 오판 방지)", r.st);
  }

  console.log("\n[B ask 정상·연속(5eea645 가드 유지)]");
  {
    const r = await ev(`(async function(){
      var a = Prompt.ask({ title: '1' }); __flush(); await ${sleep(80)};
      var openA = ${S("prompt-modal")};
      document.getElementById('prompt-modal-input').value = 'x'; Prompt._submit(); await a;
      var b = Prompt.ask({ title: '2' });                          // 지연 숨김 타이머가 돌기 전에 다음 ask
      __flush(); await ${sleep(300)};
      var openB = ${S("prompt-modal")};
      Prompt._close(null); await b; await ${sleep(300)};
      return { openA: openA, openB: openB, end: ${S("prompt-modal")} };
    })()`);
    ok(r.openA.on && !r.openA.hidden, "B1 프레임 뒤 정상 열림", r.openA);
    ok(r.openB.on && !r.openB.hidden, "B2 연속 ask: 두 번째 모달이 열린 채 유지", r.openB);
    ok(r.end.hidden && !r.end.on, "B3 닫으면 숨김", r.end);
  }

  console.log("\n[C confirm — 프레임 전에 확인 · 연속]");
  {
    const r = await ev(`(async function(){
      var p = Prompt.confirm('확인', '본문');
      var m = document.getElementById('wm-confirm-modal');
      document.getElementById('wm-confirm-ok').focus();
      document.getElementById('wm-confirm-ok').click();            // 첫 프레임 전에 확인
      var v = await p; __flush(); await ${sleep(300)};
      var st1 = ${S("wm-confirm-modal")};
      var p2 = Prompt.confirm('a', 'b'); __flush(); await ${sleep(50)};
      document.getElementById('wm-confirm-ok').click(); await p2;
      var p3 = Prompt.confirm('c', 'd'); __flush(); await ${sleep(300)};
      var st3 = ${S("wm-confirm-modal")};
      document.getElementById('wm-confirm-cancel').click(); var v3 = await p3; await ${sleep(300)};
      return { v: v, st1: st1, st3: st3, v3: v3, end: ${S("wm-confirm-modal")} };
    })()`);
    ok(r.v === true && r.st1.hidden && !r.st1.on && !r.st1.focusIn, "C1 🔴 confirm 프레임 전 확인 → 숨김·포커스 없음", r.st1);
    ok(r.st3.on && !r.st3.hidden, "C2 연속 confirm: 세 번째 창 열린 채 유지(종전 가드)", r.st3);
    ok(r.v3 === false && r.end.hidden, "C3 취소 → false · 숨김", r.end);
  }
} catch (e) {
  console.log("  FAIL 예외: " + String(e && e.message).slice(0, 300)); failed++;
} finally {
  try { ws && ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
  try { fs.unlinkSync(page); } catch (e) {}
}
clearTimeout(watchdog);
console.log("\n" + (failed ? "FAIL " + failed : "ALL PASS"));
process.exit(failed ? 1 : 0);
