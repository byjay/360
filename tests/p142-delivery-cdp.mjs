/**
 * p142-cdp — WO 20261010-delivery 실 Chrome 실측(목 0 — 음성 인식 결과 주입만 예외, 아래 ④ 참고).
 *   ① 서버: 프로젝트 정보 선명·호선 저장/조회(PATCH → GET) · 결함/요청 노트 생성(API)
 *   ② 납품 보고서: [납품 보고서] → 새 창 → print 미디어 실측(블록 높이 ≤ A4 본문, 가로 넘침 0, 이미지 로드·해상도 상한)
 *      → Page.printToPDF(preferCSSPageSize) → pdfjs 로 쪽 수·쪽번호·핀 칸 분할 0 측정
 *   ③ 묶음 zip: bundleBlob → 파일 저장 → 독립 파서 + zlib.crc32 + python zipfile -t → 풀어서 file:// 로 열어 이미지 전부 로드
 *   ④ 음성: 노트·결함·요청 칸 [🎤] · 미지원(API 제거) = 비활성 + 사유 글자 · 오프라인 = 경고 · 인식 결과 = 입력칸만(노트 수 불변)
 *      🔴 헤드리스엔 마이크가 없어 실제 인식은 불가 — SpeechRecognition 생성자만 결과를 내는 가짜로 바꿔 "채우기만" 경로를 잰다.
 *   ⑤ 열람자: 다른 프로젝트 배포본을 가리키는 구역 = 서버 403 → "권한 밖 제외", HTML 이메일 0
 * 실행: P142=1 TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p142-delivery-cdp.mjs   (P142 != "1" 이면 SKIP)
 * 사전: .tmp/localdev-state (node build-tools/local-dev.mjs && node build-tools/seed-local.mjs) — 사본(.tmp/fixreport2/state)만 쓴다.
 * 산출: .tmp/fixreport2/*.png · report-*.pdf · bundle.zip · unzip/
 */
import { execSync, spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import WebSocket from "ws";
import { FIND_SEED_ORIGIN } from "./_lib/seed-origin.mjs";

if (process.env.P142 !== "1") { console.log("[SKIP] p142-cdp 는 P142=1 일 때만 실행"); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = path.join(ROOT, ".tmp");
const OUT = path.join(TMP, "fixreport2");
const WORK = path.join(OUT, "work");
const STATE_SRC = path.join(TMP, "localdev-state");
const STATE = path.join(OUT, "state");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const NODE_MODULES = path.join(ROOT, "node_modules");
const PID = "proj_localseed", VEC = "dep_p142_vec", FOREIGN = "dep_p142_foreign";
let failed = 0;
const ok = (c, label, d) => { console.log((c ? "  PASS " : "  FAIL ") + label + (d != null ? " :: " + JSON.stringify(d).slice(0, 500) : "")); if (!c) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
if (!fs.existsSync(STATE_SRC)) { console.log("FAIL .tmp/localdev-state 없음"); process.exit(2); }
if (!fs.existsSync(CHROME)) { console.log("FAIL Chrome 없음"); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (/\.(png|pdf|zip)$/.test(f)) fs.rmSync(path.join(OUT, f), { force: true });

// ── 격리 빌드(작업트리 모듈 → WORK) + 상태 사본 ──
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
for (const f of ["public", "src", "migrations"]) fs.cpSync(path.join(ROOT, f), path.join(WORK, f), { recursive: true, filter: (s) => !/[\\/]public[\\/]js[\\/]main\.js$/.test(s) });
for (const f of ["vite.config.ts", "package.json", "tsconfig.json", "wrangler.jsonc"]) fs.copyFileSync(path.join(ROOT, f), path.join(WORK, f));
// 격리 사본에서만 AI 바인딩 제거 — env.AI 는 remote 바인딩이라 OAuth 없이는 pages dev 기동이 실패한다(p138 실사고).
//   이 테스트는 AI 를 쓰지 않으므로 시크릿 없이 로컬만으로 돈다. 원본 wrangler.jsonc 는 건드리지 않는다.
{
  const wj = path.join(WORK, "wrangler.jsonc");
  const txt = fs.readFileSync(wj, "utf8").replace(/,(\s*\/\/[^\r\n]*)*\s*"ai"\s*:\s*\{[^}]*\}/, "");
  if (/"ai"\s*:/.test(txt)) { console.log("FAIL 격리 사본 AI 바인딩 제거 실패"); process.exit(2); }
  fs.writeFileSync(wj, txt);
}
const man = fs.readFileSync(path.join(WORK, "public/js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
fs.writeFileSync(path.join(WORK, "public/js/main.js"), man.map((f) => fs.readFileSync(path.join(WORK, "public/js/modules", f), "utf8")).join("\n"));
const env = { ...process.env, TEMP: TMP, TMP: TMP };
execSync(`node --max-old-space-size=640 "${path.join(NODE_MODULES, "vite/bin/vite.js")}" build`, { cwd: WORK, env, stdio: "pipe" });
fs.rmSync(STATE, { recursive: true, force: true });
fs.cpSync(STATE_SRC, STATE, { recursive: true });
const d1 = (file) => execSync(`node "${path.join(NODE_MODULES, "wrangler/bin/wrangler.js")}" d1 execute webapp-production --local --persist-to "${STATE}" --file "${file}"`, { cwd: WORK, env, stdio: "pipe" });
try { d1(path.join(WORK, "migrations/0039_pin_bulk_deletes.sql")); } catch (e) { /* 이미 적용 */ }
{
  const now = Date.now();
  const vecPins = JSON.stringify([{ id: 9001, x: 20, y: 30, page: 1, label: "1", checkboard: true }, { id: 9002, x: 40, y: 30, page: 1, label: "2", checkboard: true }]);
  const forPins = JSON.stringify([{ id: 9101, x: 50, y: 50, page: 1, label: "1", checkboard: true, author: "secret@other.test" }]);
  const sql = path.join(OUT, "_p142.sql");
  fs.writeFileSync(sql,
    // 벡터 복사 영역(별도 배포본) — A구역 하위
    `INSERT OR REPLACE INTO deployments (id, title, file_name, pages_data, pins, zones, annotations, created_at, updated_at, deleted, tenant_id, version, project_id) ` +
    `SELECT '${VEC}', 'C영역(벡터 복사)', 'c.png', pages_data, '${vecPins}', '[]', '[]', ${now}, ${now}, 0, 'tnt_default', 0, '${PID}' FROM deployments WHERE id = 'dep_localseed_original';\n` +
    `INSERT OR REPLACE INTO decks (id, project_id, name, deployment_id, page, parent_id, created_at, updated_at, deleted) VALUES ('dk_p142_C', '${PID}', 'C영역(벡터 복사)', '${VEC}', 1, (SELECT id FROM decks WHERE project_id='${PID}' AND name='A구역' AND deleted=0 LIMIT 1), ${now}, ${now}, 0);\n` +
    // 다른 프로젝트 배포본을 가리키는 구역 — 열람자는 서버 canReadDepRow 에서 403 이어야 한다
    `INSERT OR REPLACE INTO deployments (id, title, file_name, pages_data, pins, zones, annotations, created_at, updated_at, deleted, tenant_id, version, project_id) ` +
    `SELECT '${FOREIGN}', '외부 배포본', 'x.png', pages_data, '${forPins}', '[]', '[]', ${now}, ${now}, 0, 'tnt_default', 0, 'proj_p142_other' FROM deployments WHERE id = 'dep_localseed_original';\n` +
    `INSERT OR REPLACE INTO decks (id, project_id, name, deployment_id, page, parent_id, created_at, updated_at, deleted) VALUES ('dk_p142_F', '${PID}', 'F구역(외부)', '${FOREIGN}', 1, NULL, ${now}, ${now}, 0);\n`);
  d1(sql);
}

const PORT = process.env.P142_PORT || "18842";
const wrangler = spawn("node", [path.join(NODE_MODULES, "wrangler/bin/wrangler.js"), "pages", "dev", "dist", "--d1=webapp-production", "--local", "--persist-to", STATE, "--ip", "127.0.0.1", "--port", PORT],
  { cwd: WORK, env, stdio: ["ignore", "pipe", "pipe"] });
let wlog = ""; wrangler.stdout.on("data", (d) => (wlog += d)); wrangler.stderr.on("data", (d) => (wlog += d));
const BASE = "http://127.0.0.1:" + PORT;
let chrome = null; const sockets = [];
async function cleanup() { sockets.forEach((s) => { try { s.close(); } catch (e) {} }); try { chrome && chrome.kill(); } catch (e) {} try { wrangler.kill(); } catch (e) {} }

const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej));
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl, { maxPayload: 512 * 1024 * 1024 }); sockets.push(ws);
  await new Promise((r) => ws.on("open", r));
  let idc = 0; const pend = new Map(); const errs = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
    if (m.method === "Runtime.exceptionThrown") errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300));
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++idc; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr, gesture, ms) => { const r = await Promise.race([send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, userGesture: !!gesture }), wait(ms || 60000).then(() => { throw new Error("evaluate 무응답"); })]); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
  const evS = async (e) => { try { return await ev(e); } catch (x) { return { __err: String(x.message).slice(0, 200) }; } };
  const waitFor = async (cond, t = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if ((await evS("(function(){try{return !!(" + cond + ")}catch(e){return false}})()")) === true) return Date.now() - t0; await wait(150); } return -1; };
  return { ws, send, ev, evS, waitFor, errs };
}
let shotN = 0;
async function shot(P, name) { const s = await P.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, String(++shotN).padStart(2, "0") + "-" + name + ".png"), Buffer.from(s.data, "base64")); }
async function viewport(P, w, h, mobile) { await P.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile: !!mobile }); }
const CONTRAST_JS = `function(fg,bg){function L(c){var m=c.match(/\\d+(\\.\\d+)?/g).map(Number);function ch(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)}return 0.2126*ch(m[0])+0.7152*ch(m[1])+0.0722*ch(m[2])}var a=L(fg),b=L(bg);return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)}`;

/* ── 독립 zip 파서(p142 단위 테스트와 같은 규칙) ── */
function parseZip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eo = -1;
  for (let i = u8.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eo = i; break; }
  const n = dv.getUint16(eo + 10, true), cdOff = dv.getUint32(eo + 16, true);
  const out = []; let p = cdOff;
  for (let i = 0; i < n; i++) {
    const crc = dv.getUint32(p + 16, true), csz = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), lho = dv.getUint32(p + 42, true);
    const name = Buffer.from(u8.subarray(p + 46, p + 46 + nl)).toString("utf8");
    const lnl = dv.getUint16(lho + 26, true), lel = dv.getUint16(lho + 28, true);
    const data = u8.subarray(lho + 30 + lnl + lel, lho + 30 + lnl + lel + csz);
    out.push({ name, crc, ok: dv.getUint32(lho, true) === 0x04034b50 && zlib.crc32(data) === crc });
    p += 46 + nl;
  }
  return { n, entries: out, cdEndOk: p === eo };
}

/** PDF 측정 — pdfjs(legacy)로 쪽 수·쪽별 텍스트 */
async function pdfText(file) {
  const require = createRequire(import.meta.url);
  const pdfjs = require(path.join(NODE_MODULES, "pdfjs-dist/legacy/build/pdf.js"));
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), disableWorker: true, isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i);
    const tc = await pg.getTextContent();
    pages.push(tc.items.map((it) => it.str).join(" "));
  }
  return pages;
}

/** 보고서 창(print 미디어) 실측 */
const MEASURE_JS = `(function(){
  var mm = 96/25.4, pageH = (297-32)*mm, rpt = document.querySelector('.rpt'), rr = rpt.getBoundingClientRect();
  var units = [].slice.call(document.querySelectorAll('.blk, .pin-top, .cover, tr'));
  var tall = units.filter(function(e){ return e.getBoundingClientRect().height > pageH + 0.5; }).map(function(e){ return (e.className||e.tagName)+':'+Math.round(e.getBoundingClientRect().height); });
  var wide = [].slice.call(rpt.querySelectorAll('*')).filter(function(e){ var r=e.getBoundingClientRect(); return r.width>0 && (r.right > rr.right + 0.5 || r.left < rr.left - 0.5); }).map(function(e){ return e.tagName+'.'+e.className; });
  var imgs = [].slice.call(document.images);
  var maps = imgs.filter(function(i){ return /위치도/.test(i.alt); }), photos = imgs.filter(function(i){ return !/위치도/.test(i.alt); });
  return { pageH: Math.round(pageH), rptW: Math.round(rr.width), tall: tall, wide: wide.slice(0,10), wideN: wide.length,
    docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    imgs: imgs.length, loaded: imgs.filter(function(i){ return i.complete && i.naturalWidth > 0; }).length,
    maxMap: Math.max.apply(null, [0].concat(maps.map(function(i){ return Math.max(i.naturalWidth, i.naturalHeight); }))),
    maxPhotoW: Math.max.apply(null, [0].concat(photos.map(function(i){ return i.naturalWidth; }))),
    maxPhotoH: Math.max.apply(null, [0].concat(photos.map(function(i){ return i.naturalHeight; }))),
    maps: maps.length, photos: photos.length, pins: document.querySelectorAll('[data-rpt=pin]').length,
    nos: [].slice.call(document.querySelectorAll('[data-rpt=pin]')).map(function(a){ return a.getAttribute('data-no'); }),
    cover: (document.querySelector('[data-rpt=cover]')||{}).innerText || '' };
})()`;

try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { const r = await fetch(BASE + "/"); up = !!r.status; } catch (e) {} if (!up) await wait(500); }
  if (!up) { console.log("FAIL wrangler 기동 실패\n" + wlog.slice(-1500)); process.exit(1); }

  const profile = path.join(TMP, "p142-chrome-" + Date.now());
  chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", "--user-data-dir=" + profile, "--window-size=1280,800", "about:blank"], { stdio: "ignore" });
  let port = 0;
  for (let i = 0; i < 80 && !port; i++) { try { port = parseInt(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0], 10); } catch (e) {} if (!port) await wait(150); }
  let pageWs = null, mainId = null;
  for (let i = 0; i < 40 && !pageWs; i++) { try { const l = await getJson("http://127.0.0.1:" + port + "/json/list"); const pg = l.find((t) => t.type === "page"); if (pg) { pageWs = pg.webSocketDebuggerUrl; mainId = pg.id; } } catch (e) {} if (!pageWs) await wait(250); }
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
  await viewport(P, 1280, 900, false);

  const acc = JSON.parse(fs.readFileSync(path.join(TMP, "local-test-accounts.json"), "utf8")).accounts;
  const pw = (role) => acc.find((a) => a.role === role).password;
  const em = (role) => acc.find((a) => a.role === role).email;
  await P.send("Page.navigate", { url: BASE + "/manifest.webmanifest" });
  await P.waitFor("location.pathname === '/manifest.webmanifest'");
  const login = async (role) => (await P.ev(`fetch("/api/signup/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:${JSON.stringify(em(role))},password:${JSON.stringify(pw(role))}})}).then(r=>r.json())`)).token;
  const api = (tok, method, url, body) => P.ev(`fetch(${JSON.stringify(url)},{method:${JSON.stringify(method)},headers:{"Content-Type":"application/json",Authorization:"Bearer "+${JSON.stringify(tok)}},body:${body ? JSON.stringify(JSON.stringify(body)) : "undefined"}}).then(async r=>({status:r.status, j:await r.json().catch(()=>null)}))`);
  const sTok = await login("super"), vTok = await login("viewer");
  ok(!!sTok && !!vTok, "준비 — 로컬 super·viewer 로그인");

  /* ── ① 서버: 선명·호선 저장 + 노트 생성 ── */
  console.log("\n[① 서버 — 프로젝트 정보 선명·호선 · 노트]");
  const today = new Date(); const ymd = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const yest = new Date(Date.now() - 86400000), past = new Date(Date.now() - 20 * 86400000), fut = new Date(Date.now() + 20 * 86400000);
  const pr = await api(sTok, "PATCH", "/api/projects/" + PID, { info_json: { note: "p142", vessel: "SEASTAR PIONEER", hull: "H.2451", staleDays: 14,
    schedule: [{ id: "s1", date: ymd(past), kind: "방선", content: "1차", done: true }, { id: "s2", date: ymd(yest), kind: "방선", content: "2차 점검", done: false }, { id: "s3", date: ymd(fut), kind: "방선", content: "3차", done: false }] } });
  ok(pr.status === 200, "PATCH info_json(선명·호선) 200", pr.status);
  const pg = await api(sTok, "GET", "/api/projects");
  const gi = ((((pg.j && (pg.j.data || pg.j.projects)) || []).find((x) => x.id === PID) || {}).info_json) || {};
  ok(gi.vessel === "SEASTAR PIONEER" && gi.hull === "H.2451", "GET 으로 선명·호선 조회(서버 parseProjectInfo 보존)", gi);
  const dep = await api(sTok, "GET", "/tables/deployments/dep_localseed_original");
  const pins = JSON.parse(dep.j.pins || "[]");
  const p360 = pins.filter((p) => !p.checkboard), pChk = pins.filter((p) => p.checkboard);
  const mk = (pin, body, extra) => api(sTok, "POST", "/api/notes", Object.assign({ deployment_id: "dep_localseed_original", pin_id: String(pin.id), pin_label: pin.label, body }, extra));
  const n1 = await mk(p360[0], "도장 벗겨짐 — 우현 외판", { kind: "note", status: "open", severity: "상", due_at: Date.now() - 2 * 86400000, assignee: "designer@test.local" });
  const n2 = await mk(p360[1], "배관 누수 의심", { kind: "note", status: "progress", severity: "중", due_at: Date.now() + 3 * 86400000 });
  const n3 = await mk(pChk[0], "용접 비드 확인", { kind: "note", status: "done" });
  const n4 = await mk(pChk[1], "사진 추가 요청", { kind: "request" });
  ok([n1, n2, n3, n4].every((r) => r.status === 200 || r.status === 201), "노트 4건 생성(결함 open/progress/done + 요청)", [n1.status, n2.status, n3.status, n4.status]);

  // SW 선설치
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
      if ((await P.waitFor("window.__wm && __wm.State.pins.length > 0 && __wm.Projects.decks && __wm.Projects.decks.length >= 3", 15000)) >= 0) { await wait(1200); return true; }
    }
    return false;
  };
  ok(await enterApp(sTok), "super 허브 → 시드 원본 열기(구역 로드)");

  /* ── ④ 음성 — 숨김 금지·사유·채우기만 ── */
  console.log("\n[④ 음성 메모]");
  const vrows = await P.ev(`(function(){ return ['input-pin-note','pnp-input'].map(function(id){ var r=document.querySelector('[data-voice-row="'+id+'"]'); return r ? {id:id, state:r.dataset.voiceState, prev:r.previousElementSibling && r.previousElementSibling.id} : null; }); })()`);
  ok(vrows.every((r) => r && r.prev === r.id), "노트(#input-pin-note)·결함(#pnp-input) 바로 뒤에 [🎤] 줄", vrows);
  const hasApi = await P.ev(`!!(window.SpeechRecognition || window.webkitSpeechRecognition)`);
  console.log("    (참고) 헤드리스 Chrome SpeechRecognition 존재 = " + hasApi + " · 초기 상태 = " + vrows.map((r) => r && r.state).join(","));
  // 요청·질문 작성창(열람자 폼과 같은 생성 경로) — 보이는 모달에서 스크린샷·대비
  await P.ev(`__wm.Requests.openViewer({}); 1`);
  await P.waitFor("document.querySelector('[data-req-body]') && document.querySelector('[data-req-body]').nextElementSibling && document.querySelector('[data-req-body]').nextElementSibling.matches('[data-voice-row]')", 8000);
  // 미지원 브라우저 흉내 — API 를 지우고 재계산
  await P.ev(`window.__savedSR = window.webkitSpeechRecognition; try{ delete window.SpeechRecognition; }catch(e){} window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; __wm.Voice.refreshAll(); 1`);
  const uns = await P.ev(`(function(){ var row=document.querySelector('[data-req-body]').nextElementSibling, b=row.querySelector('[data-voice-btn]'), s=row.querySelector('[data-voice-status]');
    var cb=getComputedStyle(b), cs=getComputedStyle(s), cr=${CONTRAST_JS};
    return { state:row.dataset.voiceState, aria:b.getAttribute('aria-disabled'), visible: b.offsetWidth>0 && s.offsetWidth>0, text:s.textContent,
      btnC: cr(cb.color, cb.backgroundColor), chipC: cr(cs.color, cs.backgroundColor) }; })()`);
  ok(uns.state === "unsupported" && uns.aria === "true" && uns.visible && /지원하지 않습니다/.test(uns.text), "미지원 = 버튼 보임 + 비활성(aria-disabled) + 사유 글자", uns);
  ok(uns.btnC >= 4.5 && uns.chipC >= 4.5, "대비 — 비활성 버튼 " + (uns.btnC || 0).toFixed(1) + ":1 · 사유칩 " + (uns.chipC || 0).toFixed(1) + ":1 (≥4.5)");
  await shot(P, "1280-voice-unsupported");
  // 가짜 인식기(결과만 냄) → 채우기만, 노트 수 불변
  const notesBefore = (await api(sTok, "GET", "/api/notes?deployment_id=dep_localseed_original")).j.data.length;
  await P.ev(`window.webkitSpeechRecognition = function(){ var self=this; this.start=function(){ setTimeout(function(){ self.onresult && self.onresult({resultIndex:0, results:[[{transcript:'용접 비드 불량 확인 필요'}]]}); self.onend && self.onend(); }, 120); }; this.stop=function(){ self.onend && self.onend(); }; }; __wm.Voice.refreshAll(); 1`);
  const ready = await P.ev(`(function(){ var row=document.querySelector('[data-req-body]').nextElementSibling, b=row.querySelector('[data-voice-btn]'), cb=getComputedStyle(b), cr=${CONTRAST_JS}; return {state:row.dataset.voiceState, c: cr(cb.color, cb.backgroundColor)}; })()`);
  ok(ready.state === "ready" && ready.c >= 4.5, "API 있음 = 준비(활성) · 버튼 대비 " + (ready.c || 0).toFixed(1) + ":1", ready);
  await P.ev(`(function(){ var ta=document.querySelector('[data-req-body]'); ta.value='기존 메모'; ta.nextElementSibling.querySelector('[data-voice-btn]').click(); return 1 })()`);
  await P.waitFor("document.querySelector('[data-req-body]').value.indexOf('용접') >= 0", 5000);
  const filled = await P.ev(`document.querySelector('[data-req-body]').value`);
  await wait(800);
  const notesAfter = (await api(sTok, "GET", "/api/notes?deployment_id=dep_localseed_original")).j.data.length;
  ok(filled === "기존 메모 용접 비드 불량 확인 필요" && notesAfter === notesBefore, "인식 결과 = 기존 글 뒤에 채우기만 · 서버 노트 수 불변(" + notesBefore + "→" + notesAfter + ")", filled);
  // 오프라인 정직 표시
  await P.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await P.waitFor("navigator.onLine === false", 5000);
  await wait(300);
  const off = await P.ev(`(function(){ var row=document.querySelector('[data-req-body]').nextElementSibling; return {state:row.dataset.voiceState, text:row.querySelector('[data-voice-status]').textContent, aria:row.querySelector('[data-voice-btn]').getAttribute('aria-disabled')}; })()`);
  ok(off.state === "offline" && /오프라인/.test(off.text) && off.aria === "false", "오프라인 = 활성 유지 + '동작하지 않을 수 있습니다' 경고", off);
  await shot(P, "1280-voice-offline");
  await P.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await P.ev(`window.webkitSpeechRecognition = window.__savedSR; __wm.Voice.refreshAll(); (function(){ var c=[].slice.call(document.querySelectorAll('button')).find(function(b){return b.textContent.trim()==='닫기' && b.offsetWidth>0}); if(c) c.click(); })(); 1`);
  await wait(400);

  /* ── 프로젝트 정보 패널 — 선명·호선 칸 ── */
  await P.ev(`__wm.ProjectInfo.open(__wm.Projects.currentProject); 1`);
  await P.waitFor("document.querySelector('[data-pinfo-vessel]')", 5000);
  const pinfo = await P.ev(`(function(){ var v=document.querySelector('[data-pinfo-vessel]'), h=document.querySelector('[data-pinfo-hull]'), cs=getComputedStyle(v), cr=${CONTRAST_JS}; return {v:v.value, h:h.value, c:cr(cs.color, cs.backgroundColor)}; })()`);
  ok(pinfo.v === "SEASTAR PIONEER" && pinfo.h === "H.2451" && pinfo.c >= 4.5, "프로젝트 정보 패널 선명·호선 칸(값·대비 " + (pinfo.c || 0).toFixed(1) + ":1)", pinfo);
  await shot(P, "1280-projectinfo-vessel");
  await P.ev(`__wm.ProjectInfo.closePanel(); 1`);

  /* ── ② 납품 보고서 — 버튼 → 새 창 → print 실측 → PDF ── */
  console.log("\n[② 납품 보고서(프로젝트 전체)]");
  const btns = await P.ev(`(function(){ return ['rpt-delivery-btn','rpt-bundle-btn'].map(function(id){ return !!document.getElementById(id); }); })()`);
  ok(btns[0] && btns[1], "보고서 버튼 줄에 [납품 보고서]·[묶음 zip] 존재", btns);
  await P.ev(`(function(){ var s=document.getElementById('rpt-scope'); s.value='project'; document.getElementById('rpt-delivery-btn').click(); return 1 })()`, true);
  let popWs = null;
  for (let i = 0; i < 60 && !popWs; i++) { const l = await getJson("http://127.0.0.1:" + port + "/json/list"); const t = l.find((x) => x.type === "page" && x.id !== mainId); if (t) popWs = t.webSocketDebuggerUrl; else await wait(250); }
  ok(!!popWs, "새 창(인쇄 보고서) 열림 — 팝업 차단 회피(클릭 즉시 창)");
  const W = await connect(popWs);
  await W.send("Runtime.enable"); await W.send("Page.enable");
  const tReady = await W.waitFor("document.querySelector('[data-rpt=pins]') && [].slice.call(document.images).every(function(i){return i.complete})", 90000);
  ok(tReady >= 0, "보고서 작성 완료(" + tReady + "ms)");
  await W.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await wait(300);
  for (const [sel, name] of [[null, "report-cover"], ["[data-rpt=summary]", "report-summary"], ["[data-rpt=map]", "report-map"], ["[data-rpt=pin] .photos .ph + .ph", "report-pin-beforeafter"]]) {
    if (sel) await W.ev(`(function(){ var e=document.querySelector(${JSON.stringify(sel)}); if(e) (e.closest('[data-rpt=pin]')||e).scrollIntoView({block:'start'}); window.scrollBy(0,-50); return 1 })()`);
    await wait(200);
    const s = await W.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, String(++shotN).padStart(2, "0") + "-" + name + ".png"), Buffer.from(s.data, "base64"));
  }
  await W.send("Emulation.setEmulatedMedia", { media: "print" });
  await wait(300);
  const meas = await W.ev(MEASURE_JS);
  console.log("    측정: " + JSON.stringify({ pageH: meas.pageH, rptW: meas.rptW, imgs: meas.imgs, loaded: meas.loaded, maps: meas.maps, photos: meas.photos, pins: meas.pins, maxMap: meas.maxMap, maxPhoto: meas.maxPhotoW + "x" + meas.maxPhotoH }));
  ok(meas.tall.length === 0, "넘침 0 — 쪽 나눔 금지 블록 중 A4 본문 높이(" + meas.pageH + "px) 초과 0", meas.tall);
  ok(meas.wideN === 0 && meas.docOverflowX <= 0, "가로 넘침 0(본문 186mm 밖 요소 0)", { wide: meas.wide, x: meas.docOverflowX });
  ok(meas.imgs > 0 && meas.loaded === meas.imgs, "이미지 전부 로드(" + meas.loaded + "/" + meas.imgs + ")");
  ok(meas.maxMap > 0 && meas.maxMap <= 1600 && meas.maxPhotoW <= 640 && meas.maxPhotoH <= 480, "해상도 상한 — 위치도 긴 변 " + meas.maxMap + "≤1600 · 사진 " + meas.maxPhotoW + "×" + meas.maxPhotoH + "≤640×480");
  ok(/SEASTAR PIONEER/.test(meas.cover) && /H\.2451/.test(meas.cover) && /2회차 \/ 총 3회/.test(meas.cover), "표지 — 선명·호선·방선 2회차/3", meas.cover.slice(0, 300));
  ok(meas.pins === 10 && meas.maps >= 3, "핀 칸 10(원본 7 + 벡터 복사 2 + 외부 1 — super 는 전부 읽음) · 위치도 " + meas.maps, { pins: meas.pins, nos: meas.nos });
  const pdf = await W.send("Page.printToPDF", { preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
  const pdfFile = path.join(OUT, "report-project.pdf");
  fs.writeFileSync(pdfFile, Buffer.from(pdf.data, "base64"));
  const pages = await pdfText(pdfFile);
  const N = pages.length;
  const footerOk = pages.every((t, i) => t.replace(/\s+/g, " ").indexOf((i + 1) + " / " + N) >= 0);
  ok(N >= 4 && footerOk, "PDF " + N + "쪽 · 모든 쪽 꼬리말 쪽번호 'n / " + N + "'", pages.map((t) => t.slice(-40)));
  ok(/납품 보고서/.test(pages[0]) && /SEASTAR PIONEER/.test(pages[0]) && /1차|2차 점검/.test(pages[0]), "1쪽 = 표지(제목·선명·방선)");
  ok(pages.slice(1).every((t) => /SEASTAR 납품 보고서/.test(t)), "2쪽부터 머리말 'SEASTAR 납품 보고서'");
  // 핀 칸 머리(번호+구역) 가 정확히 한 쪽에만 — 블록이 쪽 경계에서 갈라지지 않음
  const pinSplit = meas.nos.filter((no) => pages.filter((t) => new RegExp("(^|\\s)" + no.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s").test(t)).length === 0);
  ok(pinSplit.length === 0, "모든 핀 번호가 PDF 본문에 존재", pinSplit);
  ok(/도장 벗겨짐/.test(pages.join(" ")) && /지남/.test(pages.join(" ")), "결함 노트·기한 지남 표시가 PDF 에 존재");
  await W.send("Emulation.setEmulatedMedia", { media: "" });
  ok(W.errs.length === 0, "보고서 창 예외 0", W.errs);
  await W.send("Page.close").catch(() => {});

  /* ── ③ 묶음 zip ── */
  console.log("\n[③ 오프라인 묶음 zip]");
  const zb = await P.ev(`__wm.Delivery.bundleBlob('project').then(async function(r){ var b=new Uint8Array(await r.blob.arrayBuffer()), s=''; for (var i=0;i<b.length;i+=0x8000) s+=String.fromCharCode.apply(null, b.subarray(i,i+0x8000)); return {name:r.name, count:r.count, size:b.length, b64:btoa(s)}; })`, false, 120000);
  const zipFile = path.join(OUT, "bundle.zip");
  fs.writeFileSync(zipFile, Buffer.from(zb.b64, "base64"));
  const pz = parseZip(new Uint8Array(fs.readFileSync(zipFile)));
  ok(pz.n === zb.count && pz.cdEndOk && pz.entries.every((e) => e.ok), "zip 구조 — 항목 " + pz.n + " · 중앙 디렉터리 정합 · CRC32(zlib) 전부 일치", pz.entries.filter((e) => !e.ok));
  ok(/^seastar_납품_/.test(zb.name) && pz.entries[0].name === "report.html" && pz.entries.some((e) => /^photos\//.test(e.name)) && pz.entries.some((e) => /^maps\//.test(e.name)), "파일명·구성(report.html + photos/ + maps/)", { name: zb.name, files: pz.entries.map((e) => e.name) });
  const unz = path.join(OUT, "unzip");
  fs.rmSync(unz, { recursive: true, force: true });
  const py = spawnSync("python", ["-I", "-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); bad=z.testzip(); z.extractall(sys.argv[2]); print('BAD' if bad else 'OK', len(z.namelist()))", zipFile, unz], { encoding: "utf8" });
  ok(py.status === 0 && /^OK /.test(py.stdout), "python zipfile.testzip(CRC 재검) + 풀기 — " + (py.stdout || py.stderr).trim());
  const rhtml = fs.readFileSync(path.join(unz, "report.html"), "utf8");
  const refs = Array.from(rhtml.matchAll(/src="([^"]+)"/g)).map((m) => m[1]);
  ok(refs.length > 0 && refs.every((r) => !/^(blob:|data:|https?:)/.test(r) && fs.existsSync(path.join(unz, r))), "report.html 이미지 참조 " + refs.length + "개 = 전부 묶음 안 상대경로", refs.filter((r) => !fs.existsSync(path.join(unz, r))));
  await P.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const fileUrl = pathToFileURL(path.join(unz, "report.html")).href;
  await P.send("Page.navigate", { url: fileUrl });
  await P.waitFor("document.querySelector('[data-rpt=pins]') && [].slice.call(document.images).every(function(i){return i.complete})", 20000);
  const offRep = await P.ev(`({n:document.images.length, ok:[].slice.call(document.images).filter(function(i){return i.naturalWidth>0}).length})`);
  ok(offRep.n > 0 && offRep.ok === offRep.n, "네트워크 차단 + file:// 로 연 묶음 보고서 — 이미지 " + offRep.ok + "/" + offRep.n + " 표시");
  await shot(P, "1280-bundle-offline");
  await P.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  /* ── ⑤ 열람자 — 자기 범위만, 이메일 0 ── */
  console.log("\n[⑤ 열람자]");
  await P.send("Page.navigate", { url: BASE + "/manifest.webmanifest" });   // file:// 에서 앱 출처로 복귀(API 호출용)
  await P.waitFor("location.pathname === '/manifest.webmanifest'");
  const fv = await api(vTok, "GET", "/tables/deployments/" + FOREIGN);
  ok(fv.status === 403, "서버 — 열람자 외부 배포본 403(canReadDepRow)", fv.status);
  // 열람자는 허브 원본 열기가 아니라 App.openApp("viewer", {project}) 로 들어간다(허브 카드가 부르는 같은 진입점 — p92/p106 관례)
  await P.ev(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem("wm_local_token", ${JSON.stringify(vTok)}); 1`);
  await P.send("Page.navigate", { url: BASE + "/" });
  await P.waitFor("window.__wm && document.querySelector('.hub-card')", 30000);
  await P.ev(`__wm.App.openApp("viewer", { project: { id: ${JSON.stringify(PID)}, name: "로컬 테스트 프로젝트" } }); 1`);
  const vIn = (await P.waitFor("__wm.Projects.decks && __wm.Projects.decks.length >= 3 && __wm.State.currentProjectId", 30000)) >= 0;
  ok(vIn, "열람자 허브 → 시드 원본 열기", vIn ? null : await P.evS(`({screen:(document.querySelector('.screen.active')||{}).id, role:__wm.Auth.role, proj:__wm.Projects.currentProject&&__wm.Projects.currentProject.id, decks:(__wm.Projects.decks||[]).map(function(d){return d.name}), pins:__wm.State.pins.length, cards:document.querySelectorAll('.hub-card').length, origin:!!${FIND_SEED_ORIGIN}})`));
  const vm = await P.ev(`__wm.Delivery.prepare('project').then(function(p){ var h=__wm.Delivery.html(p.model, function(){return null}, {mode:'bundle'}); return {role:p.input.role, project:p.model.cover.project, skipped:p.model.cover.skipped, pins:p.model.pins.length, emails:(h.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g)||[]), secret:h.indexOf('secret@')>=0, masked:p.model.cover.masked}; })`, false, 120000);
  ok(vm.role === "viewer" && vm.skipped.some((s) => /F구역/.test(s.name) && s.reason === "읽기 권한 없음"), "열람자 보고서 — 외부 구역 '읽기 권한 없음'으로 제외(지어내지 않음)", vm.skipped);
  ok(vm.project === "로컬 테스트 프로젝트" && vm.pins === 9, "열람자 보고서 — 프로젝트명(State 폴백) · 포인트 9(외부 1 제외)", { project: vm.project, pins: vm.pins });
  ok(vm.emails.length === 0 && !vm.secret && vm.masked, "열람자 HTML 이메일 0건 · 외부 핀 작성자 미노출", vm.emails);
  ok(P.errs.length === 0, "앱 콘솔 예외 0", P.errs);
} catch (e) {
  console.log("FAIL 예외: " + (e && e.stack || e));
  failed++;
} finally {
  await cleanup();
}
console.log("\n" + (failed ? "FAIL " + failed : "ALL PASS") + " — 산출물 " + OUT);
process.exit(failed ? 1 : 0);
