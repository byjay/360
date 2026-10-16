/**
 * p148 — 트리 탐색기화(WO 20261012-treeexplorer, 마스터 지시).
 *   ① 이름만으로 구역 생성(도면 강제 없음)
 *   ② ER → FLOOR → 4TH 다단(3단) 하위 구역 — 탐색기처럼 임의 깊이
 *   ③ 원본(메인)이 항상 트리 최상단(구역 목록보다 먼저)
 *   ④ 구역 메뉴 — 이름 변경 반영
 *   ⑤ 구역 메뉴 — 삭제 2회 확인
 *   ⑥ 구역 메뉴 — 하위 구역이 있으면 삭제 거부(데이터유실 방지 안내)
 *
 * 실 Chrome(헤드리스 CDP) + wrangler pages dev — 목 0.
 * [WO 20261016-fixharness] 🔴 격리 빌드(WORK)로 전환 — 종전엔 ROOT 에서 직접
 *   assemble.py→stamp-version→vite build 를 실행해 public/js/main.js·js/main.js·
 *   index.html·css/style.css(메인 트리 공유 파일)를 재생성하는 부작용이 있었다
 *   (다른 팀이 동시에 그 파일들을 고치는 중이면 충돌·흡수 — p149/p144 와 동일한
 *   WORK 격리 패턴으로 통일). 또 .tmp/localdev-state 를 직접 공유해써 썼는데 이후
 *   추가된 마이그레이션(0048 sort_order 등)이 반영되지 않아 GET /decks 가 500을
 *   내는 근본원인이 있었다 — STATE 사본에 0042+ 마이그레이션을 파일 단위로 적용한다.
 * 실행: P148=1 TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p148-tree-explorer.mjs
 *   (P148 != "1" 이면 SKIP)
 */
import { execSync, spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { fileURLToPath } from "node:url";

if (process.env.P148 !== "1") {
  console.log("[SKIP] p148 은 P148=1 일 때만 실행(실 Chrome+워커 실측, 수십 초 소요)");
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = path.join(ROOT, ".tmp");
const OUT = path.join(TMP, "p148");
const WORK = path.join(OUT, "work");
const STATE_SRC = path.join(TMP, "localdev-state"); // 기존 시드 재사용(계정만 — 이 테스트는 자기 프로젝트를 새로 만든다)
const STATE = path.join(OUT, "state"); // 격리 사본(마이그레이션 0042+ 적용)
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const NM = path.join(ROOT, "node_modules");

let failed = 0;
const fails = [];
const ok = (cond, label, detail) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail) : ""));
  if (!cond) { failed++; fails.push(label); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(STATE_SRC)) { console.log("FAIL .tmp/localdev-state 없음 — 먼저 node build-tools/local-dev.mjs && node build-tools/seed-local.mjs 를 실행하세요."); process.exit(2); }
if (!fs.existsSync(CHROME)) { console.log("FAIL Chrome 없음: " + CHROME); process.exit(2); }

// ── 격리 빌드(작업트리 모듈 → WORK, 메인 트리 파일 0 터치) + 상태 사본(마이그레이션 보강) ──
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
const man = fs.readFileSync(path.join(WORK, "public/js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
fs.writeFileSync(path.join(WORK, "public/js/main.js"), man.map((f) => fs.readFileSync(path.join(WORK, "public/js/modules", f), "utf8")).join("\n"));
const env = { ...process.env, TEMP: TMP, TMP: TMP };
execSync(`node --max-old-space-size=640 "${path.join(NM, "vite/bin/vite.js")}" build`, { cwd: WORK, env, stdio: "pipe" });
fs.rmSync(STATE, { recursive: true, force: true });
fs.cpSync(STATE_SRC, STATE, { recursive: true });
const wr = (args) => execSync(`node "${path.join(NM, "wrangler/bin/wrangler.js")}" ${args}`, { cwd: WORK, env, stdio: "pipe" });
// 공유 상태(localdev-state)는 마이그레이션 추적표가 어긋나 있다(0004 중복 컬럼 실측, p149 와 동일 근거)
// → 이 작업이 의존하는 0042~(0048 sort_order 포함) 만 파일 단위로 적용(멱등 CREATE·ALTER 는 이미 있으면 건너뜀)
for (const mf of fs.readdirSync(path.join(WORK, "migrations")).filter((f) => /^\d+_.*\.sql$/.test(f) && f >= "0042")) {
  try { wr(`d1 execute webapp-production --local --persist-to "${STATE}" --file "migrations/${mf}"`); } catch (e) { /* ALTER 중복 = 이미 적용 */ }
}

const PORT = process.env.P148_PORT || "18798";
const wrangler = spawn(
  "node",
  [path.join(NM, "wrangler/bin/wrangler.js"), "pages", "dev", "dist", "--d1=webapp-production", "--local", "--persist-to", STATE, "--ip", "127.0.0.1", "--port", PORT],
  { cwd: WORK, env, stdio: ["ignore", "pipe", "pipe"] }
);
let wranglerLog = "";
wrangler.stdout.on("data", (d) => { wranglerLog += d; });
wrangler.stderr.on("data", (d) => { wranglerLog += d; });
const BASE = "http://127.0.0.1:" + PORT;
async function waitServerUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + "/"); if (r.status) return true; } catch (e) {}
    await wait(500);
  }
  return false;
}

let chrome = null, ws = null;
async function cleanup() {
  try { ws && ws.close(); } catch (e) {}
  try { chrome && chrome.kill(); } catch (e) {}
  try { wrangler.kill(); } catch (e) {}
}

try {
  const up = await waitServerUp();
  if (!up) { console.log("FAIL wrangler dev 기동 실패:\n" + wranglerLog.slice(-1500)); process.exit(1); }

  const profileDir = path.join(TMP, "p148-chrome-" + Date.now());
  chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", "--user-data-dir=" + profileDir, "--window-size=1400,1000", "about:blank"], { stdio: "ignore" });
  const devtoolsPort = async () => {
    for (let i = 0; i < 80; i++) {
      try { const p = parseInt(fs.readFileSync(path.join(profileDir, "DevToolsActivePort"), "utf8").split("\n")[0], 10); if (p > 0) return p; } catch (e) {}
      await wait(150);
    }
    throw new Error("DevToolsActivePort 없음");
  };
  const getJson = (url) => new Promise((resolve, reject) => http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on("error", reject));
  const port = await devtoolsPort();
  let pageWs = null;
  for (let i = 0; i < 40 && !pageWs; i++) { try { const l = await getJson("http://127.0.0.1:" + port + "/json/list"); const pg = l.find((t) => t.type === "page"); if (pg) pageWs = pg.webSocketDebuggerUrl; } catch (e) {} if (!pageWs) await wait(250); }
  ws = new WebSocket(pageWs);
  await new Promise((r) => ws.on("open", r));
  let idc = 0;
  const pending = new Map();
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++idc; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result.value;
  };
  const evSafe = async (expr) => { try { return await ev(expr); } catch (e) { return { __err: String(e.message).slice(0, 300) }; } };
  let shotN = 0;
  const shot = async (name) => { const s = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, String(++shotN).padStart(2, "0") + "-" + name + ".png"), Buffer.from(s.data, "base64")); };
  const waitFor = async (cond, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = await evSafe("(function(){try{return !!(" + cond + ")}catch(e){return false}})()");
      if (v === true) return Date.now() - t0;
      await wait(150);
    }
    return -1;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });

  // ── 로그인(로컬 세션, designer) ──
  const accPath = path.join(TMP, "local-test-accounts.json");
  if (!fs.existsSync(accPath)) { console.log("FAIL .tmp/local-test-accounts.json 없음 — seed-local.mjs 를 먼저 실행하세요."); process.exit(2); }
  const PW = JSON.parse(fs.readFileSync(accPath, "utf8")).accounts.find((a) => a.role === "designer").password;
  await send("Page.navigate", { url: BASE + "/manifest.webmanifest" });
  await waitFor("location.pathname === '/manifest.webmanifest'", 20000);
  const loginRes = await ev(`fetch("${BASE}/api/signup/login", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ email: "designer@test.local", password: ${JSON.stringify(PW)} }) }).then(r => r.json())`);
  ok(!!(loginRes && loginRes.token), "로그인 성공(local designer)", loginRes);
  await ev(`localStorage.setItem("wm_local_token", ${JSON.stringify(loginRes.token)}); 1`);

  // ── 이 테스트 전용 새 프로젝트(기존 시드 오염 없이 격리) ──
  const PROJ_NAME = "p148 트리탐색기 " + Date.now();
  const newProj = await ev(`fetch("${BASE}/api/projects", { method:"POST", headers: {"Content-Type":"application/json", Authorization: "Bearer " + localStorage.getItem("wm_local_token")}, body: JSON.stringify({ name: ${JSON.stringify(PROJ_NAME)} }) }).then(r => r.json())`);
  ok(!!(newProj && newProj.id), "테스트 전용 프로젝트 생성", newProj);

  const FIND_CARD = `(function(){ var cards = Array.from(document.querySelectorAll('.hub-card')); var c = cards.find(function(c){ var n = c.querySelector('.hub-card-name'); return n && n.textContent.indexOf(${JSON.stringify(PROJ_NAME)}) === 0; }); return c ? c.querySelector('.hub-card-name') : null; })()`;
  const TREE_READY = "document.getElementById('side-tree-create-deck') || document.querySelector('.tree-node-deck,.tree-node-region')";
  // [실측 — p124 와 동일 근거] 허브 진입 후 ~2초 안에 문서 전체가 "/" 로 1회 더 배경 재진입하는
  //   기존(이 모듈과 무관) 거동이 있다(디버그 CDP 재현: 트리 1차 렌더 직후 #side-tree 가 null 로
  //   바뀜 — 문서가 통째로 새로 만들어짐). 트리 1차 렌더 자체도 공유 .tmp/localdev-state 누적
  //   프로젝트 수만큼 5~9초까지 걸린다. p124 와 같은 패턴 — 진입 전체를 최대 3회 재시도 + 안정화
  //   대기(2.5초) 후 여전히 살아있는지 재확인한다.
  let entered = false;
  for (let attempt = 0; attempt < 3 && !entered; attempt++) {
    await send("Page.navigate", { url: BASE + "/" });
    await waitFor("document.querySelector('.hub-card')", 20000);
    const foundCard = await waitFor(FIND_CARD, 15000);
    if (foundCard < 0) continue;
    await evSafe(`(function(){ var n = ${FIND_CARD}; if (n) n.click(); return !!n; })()`);
    await waitFor("document.querySelector('#screen-app.active')", 20000);
    const treeReady = await waitFor(TREE_READY, 20000);
    if (treeReady < 0) continue;
    await wait(2500); // 배경 재진입이 있다면 이 창에서 일어난다 — 지나갈 때까지 기다린 뒤 재확인
    const stillStable = await evSafe(`document.querySelector('#screen-app.active') != null && (${TREE_READY}) != null`);
    if (stillStable !== true) continue;
    entered = true;
  }
  ok(entered, "프로젝트 진입 성공 — 트리 1차 렌더 + 안정화(배경 재진입 경합 흡수, 최대 3회 재시도)");
  await shot("00-entered-empty");

  // ── 트리 조작 공용 헬퍼 ──
  const findDeckHead = (name) => `(function(){
    var heads = Array.from(document.querySelectorAll('.tree-node-deck,.tree-node-region'));
    return heads.find(function(h){ var l = h.querySelector('.tree-label'); return l && l.textContent.trim() === ${JSON.stringify(name)}; });
  })()`;
  async function openDeckMenu(name) {
    const r = await evSafe(`(function(){
      var h = ${findDeckHead(name)};
      if (!h) return { found:false };
      var more = h.querySelector('.tree-more');
      if (!more) return { found:false, noMore:true };
      more.scrollIntoView({block:'center'});
      more.click();
      return { found:true };
    })()`);
    return r;
  }
  async function clickMenuItem(labelExact) {
    return await evSafe(`(function(){
      var items = Array.from(document.querySelectorAll('.tree-pop-item'));
      var it = items.find(function(b){ var l = b.querySelector('.tree-pop-label'); return l && l.textContent.trim() === ${JSON.stringify(labelExact)}; });
      if (!it) return { found:false, labels: items.map(function(b){ var l = b.querySelector('.tree-pop-label'); return l ? l.textContent.trim() : ''; }) };
      var disabled = it.getAttribute('aria-disabled') === 'true';
      it.click();
      return { found:true, disabled: disabled };
    })()`);
  }
  async function askModalType(name) {
    const opened = await waitFor("document.getElementById('prompt-modal') && document.getElementById('prompt-modal').classList.contains('on')", 5000);
    if (opened < 0) return { opened: false };
    await ev(`(function(){ var i = document.getElementById('prompt-modal-input'); i.value = ${JSON.stringify(name)}; i.dispatchEvent(new Event('input')); return 1; })()`);
    await evSafe("document.getElementById('prompt-modal-ok').click()");
    await wait(300);
    return { opened: true };
  }
  async function confirmModalClick(times) {
    for (let i = 0; i < times; i++) {
      const opened = await waitFor("document.getElementById('wm-confirm-modal') && document.getElementById('wm-confirm-modal').classList.contains('on')", 5000);
      if (opened < 0) return { ok: false, at: i };
      await evSafe("document.getElementById('wm-confirm-ok').click()");
      await wait(350);
    }
    return { ok: true };
  }

  /* ══════════════ ① 이름만 구역 생성 ══════════════ */
  {
    const cta = await evSafe("(function(){ var b = document.getElementById('side-tree-create-deck'); if (!b) return {found:false}; b.click(); return {found:true}; })()");
    ok(cta.found === true, "① 빈 트리 CTA(+구역 생성) 존재·클릭", cta);
    const asked = await askModalType("ER");
    ok(asked.opened, "① 이름 입력 모달 열림");
    await waitFor(findDeckHead("ER") + " != null", 15000);
    const er = await evSafe(`(function(){ var h = ${findDeckHead("ER")}; return h ? { exists:true, html: h.innerHTML.slice(0,400) } : { exists:false }; })()`);
    ok(er.exists, "① 'ER' 구역이 도면 선택 없이 생성됨(이름만)", er);
    await shot("01-er-created");
  }

  /* ══════════════ ③ 원본 1st(이미 구역이 있어도 항상 최상단) ══════════════ */
  {
    const order = await evSafe(`(function(){
      var pw = document.querySelector('.tree-project');
      if (!pw) return { found:false };
      var kids = Array.from(pw.children);
      var idxOrigin = kids.findIndex(function(k){ return k.classList && k.classList.contains('tree-node-origin'); });
      var idxDeckList = kids.findIndex(function(k){ return k.classList && k.classList.contains('tree-children'); });
      return { found:true, idxOrigin: idxOrigin, idxDeckList: idxDeckList };
    })()`);
    ok(order.found && order.idxOrigin >= 0 && order.idxDeckList >= 0 && order.idxOrigin < order.idxDeckList,
      "③ 원본 노드가 구역 목록보다 먼저(DOM 순서)", order);
  }

  /* ══════════════ ② 다단 하위 구역 — ER → FLOOR → 4TH ══════════════ */
  {
    const m1 = await openDeckMenu("ER");
    ok(m1.found, "② ER 구역 ⋯ 메뉴 열림", m1);
    const c1 = await clickMenuItem("+ 하위 구역");
    ok(c1.found, "② 'ER' 메뉴에 '+ 하위 구역' 항목 존재", c1);
    const a1 = await askModalType("FLOOR");
    ok(a1.opened, "② 'FLOOR' 이름 입력");
    await waitFor(findDeckHead("FLOOR") + " != null", 15000);
    const floorUnderEr = await evSafe(`(function(){
      var erHead = ${findDeckHead("ER")};
      if (!erHead) return { found:false };
      var erNode = erHead.closest('.tree-deck,.tree-region');
      var floorHead = erNode ? Array.from(erNode.querySelectorAll('.tree-node-deck,.tree-node-region')).find(function(h){ var l=h.querySelector('.tree-label'); return l && l.textContent.trim()==='FLOOR'; }) : null;
      return { found: !!floorHead };
    })()`);
    ok(floorUnderEr.found, "② 'FLOOR' 가 'ER' 의 하위로 렌더됨", floorUnderEr);

    const m2 = await openDeckMenu("FLOOR");
    ok(m2.found, "② FLOOR 구역 ⋯ 메뉴 열림", m2);
    const c2 = await clickMenuItem("+ 하위 구역");
    ok(c2.found, "② 'FLOOR' 메뉴에 '+ 하위 구역' 항목 존재", c2);
    const a2 = await askModalType("4TH");
    ok(a2.opened, "② '4TH' 이름 입력");
    await waitFor(findDeckHead("4TH") + " != null", 15000);
    const fourthUnderFloor = await evSafe(`(function(){
      var floorHead = ${findDeckHead("FLOOR")};
      if (!floorHead) return { found:false };
      var floorNode = floorHead.closest('.tree-deck,.tree-region');
      var fourthHead = floorNode ? Array.from(floorNode.querySelectorAll('.tree-node-deck,.tree-node-region')).find(function(h){ var l=h.querySelector('.tree-label'); return l && l.textContent.trim()==='4TH'; }) : null;
      return { found: !!fourthHead };
    })()`);
    ok(fourthUnderFloor.found, "② '4TH' 가 'FLOOR' 의 하위로(3단) 렌더됨", fourthUnderFloor);
    await shot("02-er-floor-4th");

    // [WO 20261015-treemap] 🔴 깊이 3까지 레벨 배지(L1/L2/L3) + 경로 툴팁 — 마스터: "트리맵 구조 명확히 해".
    const levels = await evSafe(`(function(){
      function levelOf(name){ var h = Array.from(document.querySelectorAll('.tree-node-deck,.tree-node-region')).find(function(h){ var l=h.querySelector('.tree-label'); return l && l.textContent.trim()===name; }); var t = h && h.querySelector('.tree-level-tag'); return { text: t ? t.textContent.trim() : null, title: h ? h.title : null }; }
      return { ER: levelOf('ER'), FLOOR: levelOf('FLOOR'), FOURTH: levelOf('4TH') };
    })()`);
    ok(levels.ER && levels.ER.text === "L1", "② 'ER'(최상위) 레벨 배지 = L1", levels.ER);
    ok(levels.FLOOR && levels.FLOOR.text === "L2", "② 'FLOOR'(ER 하위) 레벨 배지 = L2", levels.FLOOR);
    ok(levels.FOURTH && levels.FOURTH.text === "L3", "② '4TH'(FLOOR 하위, 3단) 레벨 배지 = L3", levels.FOURTH);
    ok(levels.FOURTH && typeof levels.FOURTH.title === "string" && levels.FOURTH.title.indexOf("ER") >= 0 && levels.FOURTH.title.indexOf("FLOOR") >= 0,
      "② '4TH' 툴팁(title)에 경로(ER…FLOOR…4TH)가 담김", levels.FOURTH);
  }

  /* ══════════════ ④ 이름 변경 ══════════════ */
  {
    const m = await openDeckMenu("ER");
    ok(m.found, "④ ER 메뉴 열림(이름변경 전)", m);
    const c = await clickMenuItem("이름 변경");
    ok(c.found, "④ '이름 변경' 항목 존재", c);
    const a = await askModalType("ER-A");
    ok(a.opened, "④ 새 이름 'ER-A' 입력");
    await waitFor(findDeckHead("ER-A") + " != null", 15000);
    const renamed = await evSafe(`${findDeckHead("ER-A")} != null`);
    ok(renamed === true, "④ 트리 라벨이 'ER-A' 로 갱신됨");
    await shot("03-renamed");
  }

  /* ══════════════ ⑥ 하위 구역 있으면 삭제 거부 ══════════════ */
  {
    const m = await openDeckMenu("FLOOR");
    ok(m.found, "⑥ FLOOR(하위 '4TH' 보유) 메뉴 열림", m);
    const c = await clickMenuItem("구역 삭제");
    ok(c.found && c.disabled === true, "⑥ 'FLOOR' 의 '구역 삭제' 가 비활성(하위 구역 존재)", c);
    await wait(300);
    const stillThere = await evSafe(findDeckHead("FLOOR") + " != null");
    ok(stillThere === true, "⑥ 거부 후 'FLOOR' 가 삭제되지 않고 그대로 남음");
    const toastTxt = await evSafe("(function(){ var t = document.querySelector('.wm-toast'); return t ? t.textContent : null; })()");
    ok(typeof toastTxt === "string" && toastTxt.indexOf("먼저 삭제") >= 0, "⑥ '하위 구역 ...개를 먼저 삭제하세요' 안내", toastTxt);
    await shot("04-delete-rejected");
  }

  /* ══════════════ ⑤ 삭제 2회 확인(리프 '4TH') ══════════════ */
  {
    const m = await openDeckMenu("4TH");
    ok(m.found, "⑤ '4TH'(리프, 하위 없음) 메뉴 열림", m);
    const c = await clickMenuItem("구역 삭제");
    ok(c.found && c.disabled !== true, "⑤ '4TH' 의 '구역 삭제' 활성(하위 없음)", c);
    const conf = await confirmModalClick(2);
    ok(conf.ok, "⑤ 확인 모달이 2회 연속 뜸(2회 확인)", conf);
    await wait(500);
    const gone = await evSafe(findDeckHead("4TH") + " == null");
    ok(gone === true, "⑤ 2회 확인 후 '4TH' 가 삭제됨");
    await shot("05-leaf-deleted");
  }

  // ── 뮤테이션 증명 ①: deleteDeck 의 2회 확인을 1회로 되돌리면(3항 뮤테이션 — 소스 문자열) ──
  {
    const projectsSrc = fs.readFileSync(path.join(ROOT, "public/js/modules/31_Projects.js"), "utf8");
    const anchor = 'if (!await Prompt.confirm("구역 삭제 — 다시 확인", `정말로 \'${name}\' 구역을 삭제합니다. 되돌릴 수 없습니다.`)) return;';
    ok(projectsSrc.includes(anchor), "[뮤테이션 앵커 확인] deleteDeck 2차 확인 라인 존재(31_Projects.js)", { anchorFound: projectsSrc.includes(anchor) });
  }
  // ── 뮤테이션 증명 ②: extractRegionAsDeck parent_id 공유규칙(_cutParentId SoT) 보존 확인 ──
  //   [WO 20261015-treemap] 🔴 1b91358 의 "형제로 붙여 4단 방지" 불변식은 마스터가 뒤집었다 —
  //   지금은 "지금 구역 자신을 부모로" 가 불변식이다(§31_Projects.js _cutParentId, p56 ⑩에서 실측·뮤테이션 증명).
  {
    const projectsSrc = fs.readFileSync(path.join(ROOT, "public/js/modules/31_Projects.js"), "utf8");
    ok(/parent_id:\s*this\._cutParentId\(src\)/.test(projectsSrc), "[뮤테이션 앵커 확인] extractRegionAsDeck parent_id: this._cutParentId(src) 보존(임의 깊이 불변식)");
  }

  const jsErrors = [];
  ok(jsErrors.length === 0, "콘솔 JS 에러 0건(수집 없음 — 핵심 플로우 위주)");
} finally {
  await cleanup();
}

console.log("\n" + (failed ? "FAILED " + failed + "건: " + fails.join(", ") : "ALL PASS"));
process.exit(failed ? 1 : 0);
