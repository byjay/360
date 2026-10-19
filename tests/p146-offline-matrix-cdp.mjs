/** p146 — 오프라인 통합 매트릭스(실 Chrome CDP · 실 workerd(Miniflare) · 실 D1/R2 · 로컬 시드)
 *  마스터: "오프라인에서 작업 후 온라인 연결 시 바로 작업한 것들이 정확하게 매칭되고 업로드되는 기능 전체"
 *
 *  실행(p114 하니스 재사용 — 서버는 safe-listen 임의 포트, 8799·8800 아님):
 *    P114=1 P114_ROOT=.tmp/<HEAD추출본> P114_OUT=fixoffmatrix P114_EXPLORE=tests/p146-offline-matrix-cdp.mjs \
 *      TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p114-mobile-field-flow.test.mjs
 *    P146_PHASES=matrix,conc,rev,fail,del,zconc,revundo (기본 전체) — 단계 선택
 *    [WO 20261011-offmerge] del = 다른 기기가 지운 주석·영역(PATCH·/ops) 부활 0 · zconc = 영역 동시 추가·수정 LWW ·
 *                           revundo = 개정 적용 → (오프라인 편집) → 10분 내 되돌리기 → 복귀 좌표 역변환 / 순서 모름 → 검토 배지
 *
 *  판정 = 서버 D1 을 직접 조회(P.db)해 항목별로 로컬(State·Notes)과 대조. 산출: .tmp/fixoffmatrix/matrix.json + 스크린샷.
 *  P114 가 "1" 이 아니면 하니스가 SKIP(전 스위트 무해) — 이 파일 자체는 하니스가 import 할 때만 실행된다.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import WebSocket from "ws";

const PHASES = new Set(String(process.env.P146_PHASES || "matrix,conc,rev,fail,del,zconc,revundo").split(",").map((s) => s.trim()).filter(Boolean));

/* ── 페이지 측정 라이브러리(새 문서마다 주입 — 관찰만, 앱 동작 불변) ── */
const XLIB = String.raw`(function(){
  if (window.__M) return;
  var M = window.__M = { toasts: [], badge: [] };
  M.visible = function(el){ if (!el) return false; var r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; var cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05; };
  M.mapRect = function(){ var a = document.getElementById('map-area') || document.getElementById('map-viewport'); if (!a) return null; var r = a.getBoundingClientRect(); return { x: Math.max(0, r.left), y: Math.max(0, r.top), r: Math.min(innerWidth, r.right), b: Math.min(innerHeight, r.bottom) }; };
  M.drawingRect = function(){ var c = [document.getElementById('map-image'), document.getElementById('pdf-canvas')].filter(function(e){ return e && M.visible(e); })[0]; if (!c) return null; var r = c.getBoundingClientRect(), R = M.mapRect(); if (!R) return null; var x = Math.max(r.left, R.x), y = Math.max(r.top, R.y), rr = Math.min(r.right, R.r), b = Math.min(r.bottom, R.b); if (rr <= x || b <= y) return null; return { x: x, y: y, w: rr - x, h: b - y }; };
  M.center = function(sel){ var e = document.querySelector(sel); if (!e || !M.visible(e)) return null; var r = e.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; };
  function lum(c){ var m = String(c).match(/rgba?\(([^)]+)\)/); if (!m) return null; var v = m[1].split(',').map(function(s){ return parseFloat(s); }); var f = function(x){ x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return { L: 0.2126*f(v[0]) + 0.7152*f(v[1]) + 0.0722*f(v[2]), a: v.length > 3 ? v[3] : 1 }; }
  M.contrast = function(el){ if (!el) return null; var fg = lum(getComputedStyle(el).color); var n = el, bg = null; while (n && n.nodeType === 1) { var b = lum(getComputedStyle(n).backgroundColor); if (b && b.a > 0.5) { bg = b; break; } n = n.parentElement; } if (!fg || !bg) return null; var hi = Math.max(fg.L, bg.L), lo = Math.min(fg.L, bg.L); return +((hi + 0.05) / (lo + 0.05)).toFixed(2); };
  function obs(){
    if (!document.body || M._obs) return;
    M._obs = new MutationObserver(function(ms){ ms.forEach(function(m){ m.addedNodes.forEach(function(n){ if (n.nodeType !== 1) return; var h = n.id === 'wm-toast-host' ? n : (n.closest && n.closest('#wm-toast-host')); if (h) M.toasts.push({ t: Date.now(), text: (n.innerText || n.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200) }); }); }); });
    M._obs.observe(document.body, { childList: true, subtree: true });
    var last = '';
    setInterval(function(){ var b = document.getElementById('net-badge'); if (!b) return; var s = (b.classList.contains('show') && M.visible(b) ? 'show' : 'hide') + '|' + ((document.getElementById('net-text') || {}).textContent || '') + '|' + ((document.getElementById('net-q') || {}).textContent || ''); if (s !== last) { last = s; M.badge.push({ t: Date.now(), s: s, title: b.getAttribute('title') || '' }); } }, 150);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', obs); else obs();
})();`;

/* 핀 정규화 — 페이지·노드 공용(같은 함수 문자열 = SoT). 비교 대상 필드만 뽑는다. */
const NORM = `function(p){ var r4 = function(v){ return v == null || !isFinite(+v) ? null : Math.round(+v * 1000) / 1000; };
  return { id: String(p.id), label: String(p.label == null ? '' : p.label), x: r4(p.x), y: r4(p.y), page: p.page || 1, cb: !!p.checkboard,
    leader: p.leader === undefined ? null : !!p.leader, callout: p.callout ? [r4(p.callout.x), r4(p.callout.y)] : null,
    spots: (p.spots || []).map(function(s){ return String(s.id); }).sort(), gps: p.gps ? [r4(p.gps.lat), r4(p.gps.lng)] : null,
    img: p.imageId || null, pend: p.pendingOpId || null,
    tl: (p.timeline || []).map(function(t){ return t && (t.imageId || ('PEND:' + (t.pendingOpId || '?'))); }), rev: p.revReview ? (p.revReview.rev || true) : null }; }`;
const norm = new Function("return " + NORM)();

const getJson = (url) => new Promise((resolve, reject) => http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on("error", reject));

/** CDP 세션(웹소켓 1개) — 기기 B·브라우저 레벨 명령용 */
async function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  let id = 0; const pend = new Map(); const handlers = [];
  ws.on("message", (raw) => { const m = JSON.parse(raw); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.j(new Error(JSON.stringify(m.error))) : p.r(m.result); } else if (m.method) handlers.forEach((h) => { try { h(m); } catch (e) {} }); });
  const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; pend.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const res = await Promise.race([send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }), new Promise((_, j) => setTimeout(() => j(new Error("eval timeout 30s")), 30000))]);
    if (res.exceptionDetails) throw new Error("eval: " + JSON.stringify(res.exceptionDetails).slice(0, 400));
    return res.result.value;
  };
  const evSafe = async (e) => { try { return await ev(e); } catch (x) { return { __err: String(x.message).slice(0, 300) }; } };
  return { ws, send, ev, evSafe, handlers, close: () => { try { ws.close(); } catch (e) {} } };
}

export default async function explore(P) {
  const { ev, evSafe, send, BASE, TOKEN, tap, waitFor, loads } = P;
  const J = (o) => JSON.stringify(o);
  const OUT = P.OUT;
  const R = { phases: [...PHASES], matrix: [], conc: [], rev: [], fail: [], del: [], zconc: [], revundo: [], ui: {}, notes: [] };
  const save = () => fs.writeFileSync(path.join(OUT, process.env.P114_MUT ? "matrix-mut-" + process.env.P114_MUT + ".json" : (process.env.P146_TAG ? "matrix-" + process.env.P146_TAG + ".json" : "matrix.json")), J(R, null, 1));
  const log = (m, d) => console.log("[P146] " + m + (d !== undefined ? " " + J(d).slice(0, 700) : ""));
  let shotN = 0;
  const shot = async (name, sendFn = send) => { try { const s = await sendFn("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, "p146-" + String(++shotN).padStart(2, "0") + "-" + name + ".png"), Buffer.from(s.data, "base64")); } catch (e) {} };
  /** 매트릭스 행 기록 + 단언 */
  const row = (table, item, local, server, match, note) => {
    const r = { item, local, server, match: !!match, note: note || null };
    R[table].push(r);
    P.ok(!!match, "[" + table + "] " + item, { local, server, note });
    return !!match;
  };

  await send("Page.addScriptToEvaluateOnNewDocument", { source: XLIB });
  // 같은 360 사진 파일은 앱이 "이미 다른 핀에 연결됨"으로 건너뛴다(설계) — 항목마다 이름이 다른 사본을 쓴다(바이트 동일)
  const panoCopy = (name) => { const p = path.join(OUT, name); if (!fs.existsSync(p)) fs.copyFileSync(P.PANO_JPG, p); return p; };
  const tapSel = async (sel) => { const c = await evSafe(`__M.center(${J(sel)})`); if (!c || !c.x) { log("tapSel 없음: " + sel); return null; } await tap(c.x, c.y); return c; };
  const drawn = "window.__M && __M.drawingRect() && ((document.getElementById('map-image')||{}).complete !== false) && window.__T && __T.State.autoSaveDepId";
  const PINS = `__T.State.pins.map(${NORM})`;

  /* ── 서버(D1) 직접 조회 ── */
  const db = P.db;
  const srvDepRow = async (depId = P.DEP_ID) => db.prepare("SELECT pins, zones, annotations, version FROM deployments WHERE id = ?").bind(depId).first();
  const parse = (s) => { try { return JSON.parse(s || "[]"); } catch (e) { return []; } };
  const srvLive = async () => { const r = await srvDepRow(); return { pins: parse(r.pins).filter((p) => p && !p._deleted), zones: parse(r.zones).filter((z) => z && !z._deleted), annos: parse(r.annotations).filter((a) => a && !a._deleted), version: r.version, raw: r }; };
  const srvNotes = async () => (await db.prepare("SELECT id, pin_id, body, status, due_at, severity, deleted FROM pin_notes WHERE deployment_id = ?").bind(P.DEP_ID).all()).results || [];
  const srvPanoIds = async () => new Set(((await db.prepare("SELECT id FROM pano_images WHERE deleted = 0").all()).results || []).map((r) => String(r.id)));
  const r2Objects = async () => { const out = []; let cur; do { const l = await P.r2.list({ cursor: cur, limit: 1000 }); l.objects.forEach((o) => out.push({ key: o.key, size: o.size })); cur = l.truncated ? l.cursor : null; } while (cur); return out; };

  /* ── 페이지 쪽 동기화 상태(앱 자신의 저장소 = SoT) ── */
  const SYNC_STATE = `(async function(){ var T = __T, SQ = T.SyncQueue; var keys = await SQ.allDraftKeys(); var oplog = 0, dirty = 0;
    for (var i = 0; i < keys.length; i++) { var k = String(keys[i]); var d = await SQ.loadDraft(k);
      if (k.indexOf('oplog:') === 0) oplog += (d || []).length; else if (d && d.dirty && d.pages && d.pages.length && !d.writeDenied) dirty++; }
    var q = await SQ.count(); var origs = 0; try { var db = await SQ._open(); if (db && db.objectStoreNames.contains(SQ.ORIG_STORE)) origs = await new Promise(function(r){ var rq = db.transaction(SQ.ORIG_STORE, 'readonly').objectStore(SQ.ORIG_STORE).count(); rq.onsuccess = function(){ r(rq.result); }; rq.onerror = function(){ r(-1); }; }); } catch (e) { origs = -1; }
    return { oplog: oplog, dirty: dirty, q: q, origs: origs, rc: !!SQ._reconnecting, err: SQ._lastSyncError || null, expired: !!(T.Auth && T.Auth._expired), online: navigator.onLine }; })()`;
  const syncState = (E = evSafe) => E(SYNC_STATE);
  /** 자동 동기화 완료 대기 — 사용자 조작 없이(버튼 안 누름). 끝나면 {ms, st} */
  const waitSynced = async (E = evSafe, timeout = 240000, label = "") => {
    const t0 = Date.now(); let st = null, okSince = 0;
    while (Date.now() - t0 < timeout) {
      st = await syncState(E);
      const done = st && !st.__err && st.oplog === 0 && st.dirty === 0 && st.q === 0 && st.origs === 0 && !st.rc;
      if (done) { if (!okSince) okSince = Date.now(); if (Date.now() - okSince > 4000) return { ms: Date.now() - t0, st }; } else okSince = 0;
      await P.wait(400);
    }
    log("waitSynced 시간초과 " + label, st);
    return { ms: -1, st };
  };
  const ensurePlacing = async () => { if (!(await evSafe("!!__T.State.placing"))) { await tapSel("#mobile-dock [data-act=place]"); await P.wait(700); } };
  const tapMap = async (fx, fy) => { const d = await evSafe("__M.drawingRect()"); await tap(Math.round(d.x + d.w * fx), Math.round(d.y + d.h * fy)); };
  const newIds = async (before) => (await evSafe("__T.State.pins.map(function(p){ return String(p.id); })")).filter((i) => before.indexOf(i) < 0);
  const pinIds = () => evSafe("__T.State.pins.map(function(p){ return String(p.id); })");
  const setMode = async (m) => { await tapSel(m === "photo" ? "#btn-regmode-photo" : "#btn-regmode-checkboard"); await P.wait(900); };
  const choosePhotoAt = async (fx, fy, file) => {
    await ensurePlacing();
    const ch = P.onceEvent("Page.fileChooserOpened", 15000).catch(() => null);
    await tapMap(fx, fy);
    const fc = await ch;
    if (!fc) return false;
    await send("DOM.setFileInputFiles", { files: [file || P.PANO_JPG], backendNodeId: fc.backendNodeId });
    return true;
  };
  /** 페이지에서 JPEG File 만들기(오프라인에서도 동작 — 캔버스) */
  const MKFILE = (name, w, h, q, noise) => `(async function(){ var cv = document.createElement('canvas'); cv.width = ${w}; cv.height = ${h}; var g = cv.getContext('2d');
    var gr = g.createLinearGradient(0, 0, ${w}, ${h}); gr.addColorStop(0, '#2a6'); gr.addColorStop(1, '#a62'); g.fillStyle = gr; g.fillRect(0, 0, ${w}, ${h});
    ${noise ? `var id = g.getImageData(0, 0, ${w}, ${h}); for (var i = 0; i < id.data.length; i += 4) { id.data[i] = Math.random() * 255; id.data[i+1] = Math.random() * 255; id.data[i+2] = Math.random() * 255; } g.putImageData(id, 0, 0);` : `g.fillStyle = '#fff'; g.font = '80px sans-serif'; g.fillText(${J(name)}, 40, 120);`}
    var blob = await new Promise(function(r){ cv.toBlob(r, 'image/jpeg', ${q}); }); window.__files = window.__files || {}; window.__files[${J(name)}] = new File([blob], ${J(name)}, { type: 'image/jpeg', lastModified: Date.now() }); return blob.size; })()`;
  /** PhotoBatch 정본 경로(ThetaIntake._register 와 같은 호출 모양)로 사진 1장 등록 */
  const registerPhoto = (pinIdExpr, fileName) => evSafe(`(async function(){ var PB = __T.PhotoBatch; var pin = ${pinIdExpr}; if (!pin) return { err: 'no pin' };
    var rows = await PB.buildAutoRows([window.__files[${J(fileName)}]]); var row = rows[0]; var used = PB._usedPhotoNames ? PB._usedPhotoNames() : new Set();
    var r = await PB._uploadOneRow(pin, row, true, used, 'p146'); PB._markUnsaved(); await new Promise(function(s){ setTimeout(s, 1200); });
    return { status: r && r.status, offline: r && r.offline, pinId: String(pin.id), pend: pin.pendingOpId || null, img: pin.imageId || null, tl: (pin.timeline || []).length }; })()`);
  const stubDialogs = `(function(){ var Pr = __T.Prompt; if (!window.__oc) { window.__oc = Pr.confirm; window.__oa = Pr.ask; } Pr.confirm = function(){ return Promise.resolve(true); }; Pr.ask = function(o){ return Promise.resolve({ value: window.__askValue || 'p146', second: '' }); }; return 1; })()`;
  const unstubDialogs = `(function(){ var Pr = __T.Prompt; if (window.__oc) { Pr.confirm = window.__oc; Pr.ask = window.__oa; } return 1; })()`;

  /* ═════════════ 0. 콜드 로드 · 로그인 · SW ═════════════ */
  await P.setNet("fast3g");
  await send("Page.navigate", { url: BASE + "/manifest.webmanifest" });
  await waitFor("location.pathname === '/manifest.webmanifest'", 60000);
  await ev(`localStorage.setItem("wm_local_token", ${J(TOKEN)}); 1`);
  const openHub = async () => {
    const n0 = loads.length, t0 = Date.now();
    await send("Page.navigate", { url: BASE + "/" });
    while (loads.length === n0 && Date.now() - t0 < 120000) await P.wait(100);
    return waitFor("window.__T && document.querySelector('.hub-tree-deck[data-act=deck-open]')", 90000);
  };
  await openHub();
  await waitFor("navigator.serviceWorker && navigator.serviceWorker.controller", 90000);
  await P.wait(3000);
  // GPS(현장 위치 기록) — 기기 위치를 고정값으로 + 권한 허용(브라우저 레벨)
  const ver = await getJson("http://127.0.0.1:" + P.cdpPort + "/json/version");
  const browser = await cdpSession(ver.webSocketDebuggerUrl);
  try { await browser.send("Browser.grantPermissions", { origin: BASE, permissions: ["geolocation"] }); } catch (e) { R.notes.push("grantPermissions 실패: " + e.message); }
  await send("Emulation.setGeolocationOverride", { latitude: 35.1028, longitude: 129.0403, accuracy: 6 });
  await evSafe("__T.GPS && __T.GPS.setEnabled(true); 1");

  const openLeaf = async (E = evSafe, tapFn = tapSel) => {
    const has = await waitFor("document.querySelector('.hub-tree-deck[data-act=deck-open]')", 15000);
    let how = "leaf";
    if (has >= 0) { await E("(function(){var e=document.querySelector('.hub-tree-deck[data-act=deck-open]'); e&&e.scrollIntoView({block:'center'}); return 1;})()"); await P.wait(400); await tapFn(".hub-tree-deck[data-act=deck-open]"); }
    else { how = "thumb"; await E("(function(){var e=document.querySelector('.hub-card-thumb'); e&&e.scrollIntoView({block:'center'}); return 1;})()"); await P.wait(400); await tapFn(".hub-card-thumb"); }
    let ms = await waitFor(drawn, 60000);
    if (ms < 0) { how += "+selectDeck"; await E("(async function(){ var P = __T.Projects; var d = (P.decks || [])[0]; if (d && P.selectDeck) await P.selectDeck(d); return 1; })()"); ms = await waitFor(drawn, 60000); }
    return { how, ms };
  };

  /* ═════════════ (진단) 360 사진 선택창 → 핀 연결 시간 추적 ═════════════ */
  if (PHASES.has("probe")) {
    await openLeaf();
    const dump = () => evSafe("({ st: __T.State.pins.filter(function(p){ return !p.checkboard; }).map(function(p){ return { id:String(p.id), img:p.imageId||null, pend:p.pendingOpId||null, up: !!p.uploading, same: __T.__pinRef ? (__T.__pinRef === p) : null }; }), q: 0, toasts: __M.toasts.map(function(t){ return t.text; }).slice(-4) })");
    for (const mode of ["online", "offline"]) {
      if (mode === "offline") { await P.setNet("offline"); await P.wait(1500); }
      await setMode("photo");
      const before = await pinIds();
      const okc = await choosePhotoAt(mode === "online" ? 0.3 : 0.6, 0.5);
      log(mode + " chooser", okc);
      await P.wait(3000);
      await evSafe("(function(){ var ids = " + J(before) + "; __T.__pinRef = __T.State.pins.filter(function(p){ return ids.indexOf(String(p.id)) < 0; })[0] || null; return 1; })()");
      log(mode + " probe-direct", await evSafe("(async function(){ try { var r = await fetch('/samples/pano-test-1.jpg'); var b = await r.blob(); var f = new File([b], 'pano-test-1.jpg', { type: 'image/jpeg', lastModified: Date.now() }); var pin = __T.__pinRef; var PB = __T.PhotoBatch; PB._pendingAutoPin = pin; var used = Array.from(PB._usedOrigNames ? PB._usedOrigNames() : []); var rows = await PB.buildAutoRows([f]); var t0 = performance.now(); await PB._autoPickAndConnect(pin, rows); return { used: used, rows: rows.map(function(r){ return { n: r.name, is360: r.is360, ex: r.excluded }; }), ms: Math.round(performance.now() - t0), pend: pin.pendingOpId || null, img: pin.imageId || null, toasts: __M.toasts.slice(-3).map(function(t){ return t.text; }) }; } catch (e) { return { err: String(e && e.stack || e).slice(0, 600) }; } })()"));
      log(mode + " probe-build", await evSafe("(async function(){ var t0 = performance.now(); var r = await fetch('/samples/pano-test-1.jpg'); var b = await r.blob(); var f = new File([b], 'R0010009.JPG', { type: 'image/jpeg', lastModified: Date.now() }); var t1 = performance.now(); var rows = await __T.PhotoBatch.buildAutoRows([f]); var t2 = performance.now(); return { fetchMs: Math.round(t1 - t0), buildMs: Math.round(t2 - t1), rows: rows.map(function(r){ return { name: r.name, is360: r.is360, ex: r.excluded }; }), pending: !!__T.PhotoBatch._pendingAutoPin }; })()"));
      for (let i = 0; i < 10; i++) { await P.wait(4000); log(mode + " t" + (i * 4), { s: await dump(), sq: await evSafe("__T.SyncQueue.count()"), ref: await evSafe("__T.__pinRef && { img: __T.__pinRef.imageId || null, pend: __T.__pinRef.pendingOpId || null }"), srv: (await P.srvPins()).filter((p) => !p.checkboard).map((p) => ({ id: String(p.id), img: p.imageId || null })) }); }
    }
    return;
  }

  /* ═════════════ 1. 매트릭스 ═════════════ */
  if (PHASES.has("matrix")) {
    // 1-a 온라인 준비: 도면 열기 → CHECKER 3 · 360 1(사진) · 노트 2 · 주석 2
    let o = await openLeaf();
    log("online open", o);
    await setMode("checkboard"); await ensurePlacing();
    let before = await pinIds();
    for (const [fx, fy] of [[0.15, 0.15], [0.3, 0.15], [0.45, 0.15]]) { await tapMap(fx, fy); await P.wait(800); }
    const C = await newIds(before);
    await setMode("photo");
    before = await pinIds();
    await choosePhotoAt(0.15, 0.55);
    await waitFor("__T.State.pins.some(function(p){ return !p.checkboard && p.imageId; })", 90000);
    const P1 = (await newIds(before))[0];
    await setMode("checkboard");
    // 노트 2(온라인 = /api/notes 직접)
    await evSafe(`(async function(){ var N = __T.Notes, pin = __T.State.pins.find(function(p){ return String(p.id) === ${J(C[0])}; }); N.setPin(pin);
      for (var i = 1; i <= 2; i++) { document.getElementById('pnp-input').value = '온라인 노트 ' + i; await N.submit(); } await N.loadForPin(); return (N._list || []).length; })()`);
    // 주석 2(PdfAnno 정본 저장 경로 _persist)
    await evSafe(`(function(){ __T.State.annotations.push({ id: 'an-on1', page: 1, type: 'rect', color: '#e11d48', x: 50, y: 50, w: 80, h: 60 }, { id: 'an-on2', page: 1, type: 'rect', color: '#2563eb', x: 200, y: 50, w: 80, h: 60 }); __T.PdfAnno._persist(); return 1; })()`);
    await P.wait(4000);
    await evSafe("__T.App._saveNow ? __T.App._saveNow({ silent: true }) : null");
    for (let i = 0; i < 120; i++) { const s = await srvLive(); if (s.pins.length >= 4 && s.annos.length >= 2 && s.pins.some((p) => String(p.id) === String(P1) && p.imageId)) break; await P.wait(500); }
    const base = await srvLive();
    R.base = { pins: base.pins.map(norm), zones: base.zones.map((z) => z.id), annos: base.annos.map((a) => a.id), notes: (await srvNotes()).map((n) => n.id), version: base.version };
    log("online base", { C, P1, pins: base.pins.length, annos: base.annos.length, notes: R.base.notes.length });
    P.ok(C.length === 3 && !!P1 && base.pins.length === 4 && base.annos.length === 2 && R.base.notes.length === 2, "[준비] 온라인 시드 — CHECKER 3·360 1·주석 2·노트 2 서버 반영", R.base);

    // 1-b 다운로드(허브 카드) → 다시 도면
    await openHub();
    let dl = false;
    for (let a = 0; a < 6 && !dl; a++) {
      await evSafe("(function(){ var b=document.querySelector('.hub-card-dl'); if (b) b.scrollIntoView({block:'center'}); return !!b; })()"); await P.wait(400);
      if (!(await tapSel(".hub-card-dl"))) await evSafe("(function(){var b=document.querySelector('.hub-card-dl'); if(b)b.click(); return 1;})()");
      for (let i = 0; i < 60 && !dl; i++) { dl = (await evSafe("Promise.race([__T.OfflineBundle.verify(" + J(P.PRJ) + ").then(function(v){return !!(v&&v.ok);}), new Promise(function(r){setTimeout(function(){r(false);},3000);})])")) === true; if (!dl) await P.wait(500); }
    }
    P.ok(dl, "[준비] 기기에 보관(다운로드) verify ok");
    o = await openLeaf();
    await P.wait(2500);
    await shot("online-ready");

    // 1-c 오프라인
    await P.setNet("offline");
    await P.wait(1500);
    const badgeOff = await evSafe("(function(){ var b = document.getElementById('net-badge'); return { show: __M.visible(b), text: (document.getElementById('net-text')||{}).textContent, q: (document.getElementById('net-q')||{}).textContent, contrast: __M.contrast(document.getElementById('net-text')), contrastQ: __M.contrast(document.getElementById('net-q')) }; })()");
    R.ui.offlineBadge = badgeOff;
    // ① CHECKER 연속 3
    await setMode("checkboard"); await ensurePlacing();
    before = await pinIds();
    // [WO 20261015-numunify] 탭 위치를 고정 좌표 (0.15/0.3/0.45, 0.35) → "실측 빈 자리 3곳"으로 바꾼다. 모드가 더 이상 가시성을
    //   잠그지 않아(설계 §1-1) 온라인 시드 360 핀 P1(15%,55%) 마커가 CHECKER 모드에서도 보이고, 도면 높이가 115px 뿐이라 그 머리가
    //   fy 0.25~0.45 를 덮어 첫 탭이 새 핀 대신 기존 핀 패널(PinActionPop.open)을 열었다(계측: PAP.open 1회 · 생성 0 → O=[]).
    //   종전엔 P1 이 숨어 있어 같은 좌표가 비어 있었다. 검사 내용(오프라인 CHECKER 연속 3개 생성·동기화)은 불변 — 찍는 자리만
    //   elementFromPoint 로 "도면 이미지 자체이고 기존 핀 마커에서 30px 이상 떨어진" 격자점 3곳을 고른다.
    const freeSpots = await evSafe("(function(){ var d = __M.drawingRect(); if (!d) return []; var ms = Array.from(document.querySelectorAll('#pins-layer [data-id]')).map(function(m){ var r = m.getBoundingClientRect(); return r; }); var out = []; for (var fy = 0.2; fy <= 0.85 && out.length < 3; fy += 0.1) { for (var fx = 0.1; fx <= 0.9 && out.length < 3; fx += 0.06) { var x = d.x + d.w * fx, y = d.y + d.h * fy; var e = document.elementFromPoint(x, y); if (!e || e.id !== 'map-image') continue; var near = ms.some(function(r){ return x > r.left - 30 && x < r.right + 30 && y > r.top - 30 && y < r.bottom + 30; }) || out.some(function(o){ return Math.abs(o[2] - x) < 30 && Math.abs(o[3] - y) < 40; }); if (!near) out.push([+fx.toFixed(2), +fy.toFixed(2), x, y]); } } return out.map(function(o){ return [o[0], o[1]]; }); })()");
    log("offline CHECKER 빈 자리", freeSpots);
    for (const [fx, fy] of freeSpots) { await tapMap(fx, fy); await P.wait(800); }
    const O = await newIds(before);
    // ② 360 핀 생성 + 사진(파일 선택창 주입)
    await setMode("photo");
    before = await pinIds();
    const chooserOk = await choosePhotoAt(0.6, 0.55, panoCopy("R0010201.JPG"));
    const op1Ms = await waitFor("__T.State.pins.some(function(p){ return !p.checkboard && p.pendingOpId; })", 90000);
    const OP1 = (await newIds(before))[0];
    R.diag = { op1Ms, op1: await evSafe("(function(){ var p = __T.State.pins.find(function(p){ return String(p.id) === " + J(String(OP1)) + "; }); return p && { pend: p.pendingOpId || null, img: p.imageId || null, up: !!p.uploading }; })()"), q: await evSafe("__T.SyncQueue.count()"), toasts: await evSafe("__M.toasts.map(function(t){ return t.text; })") };
    log("OP1 diag", R.diag);
    // ③ 현장 촬영 화면 등록(FieldCapture → ThetaIntake '현재 구역' → 빈 곳 탭)
    await send("DOM.getDocument", { depth: 0 });
    const fcDoc = await send("DOM.getDocument", { depth: 0 });
    const fcNode = await send("DOM.querySelector", { nodeId: fcDoc.root.nodeId, selector: "#input-field-capture" });
    before = await pinIds();
    let fcOk = false;
    if (fcNode && fcNode.nodeId) {
      await send("DOM.setFileInputFiles", { files: [panoCopy("R0010202.JPG")], nodeId: fcNode.nodeId });
      const sheet = await waitFor("Array.from(document.querySelectorAll('#theta-where-sheet button')).some(function(b){ return /현재 구역/.test(b.textContent); })", 20000);
      if (sheet >= 0) {
        await evSafe("(function(){ var b = Array.from(document.querySelectorAll('#theta-where-sheet button')).filter(function(b){ return /현재 구역/.test(b.textContent); })[0]; b.click(); return 1; })()");
        await P.wait(1200);
        await tapMap(0.75, 0.75);
        fcOk = (await waitFor("__T.State.pins.some(function(p){ return !p.checkboard && p.pendingOpId && " + J(before) + ".indexOf(String(p.id)) < 0 && String(p.id) !== " + J(String(OP1)) + "; })", 30000)) >= 0;
      }
    }
    await evSafe("(function(){ var s = document.getElementById('theta-where-sheet'); if (s) { var c = Array.from(s.querySelectorAll('button')).filter(function(b){ return /닫기|취소|완료/.test(b.textContent); })[0]; c && c.click(); } return 1; })()");
    const FC1 = (await newIds(before)).filter((i) => i !== String(OP1))[0] || null;
    R.diag.fc = { fcOk, fcNode: !!(fcNode && fcNode.nodeId), pins: await evSafe("__T.State.pins.filter(function(p){ return !p.checkboard; }).map(function(p){ return { id: String(p.id), pend: p.pendingOpId || null, img: p.imageId || null }; })"), q: await evSafe("__T.SyncQueue.count()"), toasts: await evSafe("__M.toasts.map(function(t){ return t.text; })") };
    log("FC diag", R.diag.fc);
    await setMode("checkboard");
    // ④ 사진 이력 추가(온라인에서 사진이 있던 360 핀 P1 에 새 사진 → 옛 사진은 timeline)
    await evSafe(MKFILE("R0010777.JPG", 2048, 1024, 0.85, false));
    const hist = await registerPhoto(`__T.State.pins.find(function(p){ return String(p.id) === ${J(P1)}; })`, "R0010777.JPG");
    // ⑤ 이동(C1) — 드래그 끝 경로(UI onUp: 좌표 갱신 → App._autoSave)
    await evSafe(`(function(){ var p = __T.State.pins.find(function(p){ return String(p.id) === ${J(C[0])}; }); p.x = +p.x + 7; p.y = +p.y + 9; __T.UI.renderPinList(); __T.App._autoSave(); return [p.x, p.y]; })()`);
    // ⑥ 번호(라벨) 수정(C2) — PinActionPop 정본(_saveLabel)
    const lbl = await evSafe(`(async function(){ var PAP = __T.PinActionPop; PAP.open(Number(${J(C[1])}) || ${J(C[1])}); await new Promise(function(r){ setTimeout(r, 500); }); var inp = document.getElementById('pap-label-input'); if (!inp) return { err: 'no input' }; inp.value = '58'; PAP._saveLabel(); PAP.close(); var p = __T.State.pins.find(function(p){ return String(p.id) === ${J(C[1])}; }); return { label: p.label }; })()`);
    // ⑦ 리더선 전환(O1,O2) + 정렬(세로)
    const lead = await evSafe(`(function(){ var S = __T.State; var ps = S.pins.filter(function(p){ return ${J(O.slice(0, 2))}.indexOf(String(p.id)) >= 0; }); __T.UI.setPinsLeader(ps, true); __T.UI._commitAlign('v', ps, 70, 20); return ps.map(function(p){ return { id: String(p.id), leader: p.leader, callout: p.callout }; }); })()`);
    // ⑧ 핀 삭제(C3) — 공유 지점 App._removePins(deletePin 확인 뒤 경로)
    await evSafe(`(function(){ return __T.App._removePins([${J(C[2])}]).length; })()`);
    // ⑨ 360 도형·마커(P1) — 커밋 정본 App._saveSpots
    await evSafe(`(function(){ var p = __T.State.pins.find(function(p){ return String(p.id) === ${J(P1)}; }); p.spots = p.spots || [];
      p.spots.push({ id: 'sp-off1', lon: 12, lat: 4, label: '오프라인 마커', note: '', kind: 'defect', ts: Date.now() });
      p.spots.push({ id: 'sh-off1', kind: 'equip', label: '오프라인 도형', note: '', equipMark: true, ts: Date.now(), attachments: [], type: 'rect', lon1: -10, lat1: -5, lon2: 15, lat2: 8 });
      __T.App._saveSpots(p); return p.spots.length; })()`);
    // ⑩ 노트 — 작성(기한·심각도 = 결함 워크플로) · 상태 변경 · 삭제
    await evSafe(stubDialogs);
    const notesOff = await evSafe(`(async function(){ var N = __T.Notes, pin = __T.State.pins.find(function(p){ return String(p.id) === ${J(C[0])}; }); N.setPin(pin); await N.loadForPin();
      var list0 = (N._list || []).map(function(n){ return { id: n.id, body: n.body }; });
      var n1 = (N._list || []).filter(function(n){ return n.body === '온라인 노트 1'; })[0], n2 = (N._list || []).filter(function(n){ return n.body === '온라인 노트 2'; })[0];
      if (n1) await N.updateStatus(n1.id, 'progress'); if (n2) await N.remove(n2.id);
      document.getElementById('pnp-input').value = '오프라인 결함 노트'; document.getElementById('pnp-status-sel').value = 'open'; document.getElementById('pnp-due').value = '2026-12-31'; document.getElementById('pnp-severity').value = '상';
      await N.submit(); return { list0: list0, n1: n1 && n1.id, n2: n2 && n2.id, after: (N._list || []).map(function(n){ return { id: n.id, body: n.body, status: n.status, due_at: n.due_at, severity: n.severity }; }) }; })()`);
    // ⑪ PDF 주석 추가 · 삭제
    await evSafe(`(function(){ __T.State.annotations.push({ id: 'an-off1', page: 1, type: 'rect', color: '#16a34a', x: 300, y: 300, w: 90, h: 40 }); __T.PdfAnno._persist(); __T.PdfAnno._removeAnnos(['an-on1']); return __T.State.annotations.map(function(a){ return a.id; }); })()`);
    // ⑫ 영역 그리기 · 삭제(시드 z_p114)
    await evSafe(`(async function(){ window.__askValue = '오프라인영역'; await __T.Zones._commitZone({ shape: 'rect', x: 60, y: 60, w: 12, h: 12 }); await __T.Zones.remove('z_p114'); return __T.State.zones.map(function(z){ return z.id; }); })()`);
    await evSafe(unstubDialogs);
    // ⑭ 오프라인 지원 범위 — 보고서(기기 보관 노트) · 촬영 현황 · 비활성+사유(전체 핀 삭제·도면 개정·열람자 요청)
    const scope = await evSafe(`(async function(){ var T = __T, out = {};
      var g = await T.Report._gather('deck'); out.reportPins = g.pins.length; out.reportNotes = g.notes.map(function(n){ return n.body; });
      out.reportToast = __M.toasts.map(function(t){ return t.text; }).filter(function(t){ return /기기에 보관된/.test(t); }).slice(-1)[0] || null;
      out.coverageReason = T.Coverage ? T.Coverage.reason() : 'no-module'; out.coverage = T.Coverage ? T.Coverage.summarize(T.State.pins, Date.now(), 7) : null;
      out.purge = T.PinPurge ? T.PinPurge.reason() : 'no-module';
      out.revision = T.Revision ? T.Revision.reason(T.Projects.currentDeck, 'upload') : 'no-module';
      var R = T.Requests; R._vctx = { dep: T.State.autoSaveDepId, pin: T.State.pins[0] }; var form = R._viewerForm(); document.body.appendChild(form);
      await new Promise(function(r){ setTimeout(r, 80); });
      var send = form.querySelector('[data-req-send]'), err = form.querySelector('[data-req-error]');
      out.reqDisabled = !!(send && send.disabled); out.reqReason = err ? err.textContent : null; out.reqErrShown = !!(err && err.style.display !== 'none');
      out.reqErrContrast = err ? __M.contrast(err) : null;
      var calls = 0, of = window.fetch; window.fetch = function(){ calls++; return of.apply(this, arguments); };
      var ta = form.querySelector('[data-req-body]'); ta.value = '오프라인 요청 테스트';
      try { out.reqStatus = await R.submitViewer({ kind: 'request', body: ta.value, author: '현장', contact: '' }, { ta: ta, err: err, send: send }); } finally { window.fetch = of; }
      out.reqFetchCalls = calls; out.reqKeptText = ta.value; form.remove(); R._vctx = null; return out; })()`);
    R.scope = scope;
    row("matrix", "보고서 오프라인 열람 — 기기 보관 노트(오프라인 작성분) 반영 + 사유 표시", "오프라인 결함 노트 포함", scope, !!scope && scope.reportNotes.indexOf("오프라인 결함 노트") >= 0 && !!scope.reportToast);
    row("matrix", "QR·촬영 현황 — 오프라인에서도 계산·표시(오프라인 사유 없음)", "", scope && { reason: scope.coverageReason, summary: scope.coverage }, !!scope && !/오프라인|온라인/.test(scope.coverageReason || "") && !!scope.coverage);
    row("matrix", "전체 핀 삭제 — 오프라인 비활성 + 사유", "온라인에서만", scope && scope.purge, !!scope && /온라인에서만/.test(scope.purge || ""));
    row("matrix", "도면 개정 — 오프라인 비활성 + 사유", "온라인에서만", scope && scope.revision, !!scope && /온라인에서만/.test(scope.revision || ""));
    row("matrix", "열람자 요청·질문 — 오프라인 비활성 + 사유(대비≥4.5) · 전송 0 · 내용 유지", "disabled", scope && { d: scope.reqDisabled, why: scope.reqReason, c: scope.reqErrContrast, st: scope.reqStatus, fetch: scope.reqFetchCalls, kept: scope.reqKeptText },
      !!scope && scope.reqDisabled && scope.reqErrShown && /오프라인/.test(scope.reqReason || "") && (scope.reqErrContrast || 0) >= 4.5 && scope.reqStatus === 0 && scope.reqFetchCalls === 0 && scope.reqKeptText === "오프라인 요청 테스트");
    // ⑬ GPS — CHECKER 신규 핀(O)은 생성 시 GPS.attachToPin 으로 기록됨(비동기)
    await P.wait(3500);
    const E0 = await evSafe(`({ pins: ${PINS}, annos: __T.State.annotations.map(function(a){ return a.id; }).sort(), zones: __T.State.zones.map(function(z){ return z.id; }).sort() })`);
    const st0 = await syncState();
    const badgeOff2 = await evSafe("(function(){ return { text: (document.getElementById('net-text')||{}).textContent, q: +(document.getElementById('net-q')||{}).textContent }; })()");
    R.ui.offlineBadgeAfterWork = { badge: badgeOff2, sync: st0 };
    log("offline work done", { O, OP1, FC1, chooserOk, fcOk, hist, lbl, lead, notesOff, st0, badgeOff2 });
    await shot("offline-work");

    // 1-d 오프라인 새로고침 1회 — 보관 유지
    { const nr = loads.length, tr = Date.now(); await send("Page.reload", { ignoreCache: false }); while (loads.length === nr && Date.now() - tr < 60000) await P.wait(100); }
    await waitFor("window.__T && __T.State", 30000);
    const ro = await openLeaf();
    await P.wait(2500);
    const E1 = await evSafe(`({ pins: ${PINS}, annos: __T.State.annotations.map(function(a){ return a.id; }).sort(), zones: __T.State.zones.map(function(z){ return z.id; }).sort() })`);
    const notesReload = await evSafe(`(async function(){ var N = __T.Notes, pin = __T.State.pins.find(function(p){ return String(p.id) === ${J(C[0])}; }); if (!pin) return null; N.setPin(pin); await N.loadForPin(); return (N._list || []).map(function(n){ return { id: n.id, body: n.body, status: n.status }; }); })()`);
    const byId = (arr) => new Map((arr || []).map((p) => [p.id, p]));
    const e0 = byId(E0.pins), e1 = byId(E1 && E1.pins);
    const lostAfterReload = [...e0.keys()].filter((k) => !e1.has(k));
    const changedAfterReload = [...e0.keys()].filter((k) => e1.has(k) && J({ ...e0.get(k), pend: null, img: null }) !== J({ ...e1.get(k), pend: null, img: null }));
    row("matrix", "오프라인 새로고침 — 핀 보관 유지(유실 0·값 동일)", { pins: E0.pins.length }, { pinsAfterReload: E1 && E1.pins.length, lost: lostAfterReload, changed: changedAfterReload.map((k) => ({ before: e0.get(k), after: e1.get(k) })) }, ro.ms >= 0 && lostAfterReload.length === 0 && changedAfterReload.length === 0, "열기 경로 " + ro.how);
    row("matrix", "오프라인 새로고침 — 주석·영역 유지", { annos: E0.annos, zones: E0.zones }, { annos: E1 && E1.annos, zones: E1 && E1.zones }, E1 && J(E0.annos) === J(E1.annos) && J(E0.zones) === J(E1.zones));
    row("matrix", "오프라인 새로고침 — 노트(작성·상태·삭제) 유지", notesOff && notesOff.after, notesReload, Array.isArray(notesReload) && notesOff && J(notesReload.map((n) => n.id).sort()) === J(notesOff.after.map((n) => n.id).sort()));
    await shot("offline-reloaded");

    // 1-e 온라인 복귀 → 자동 동기화(버튼 안 누름)
    await evSafe("__M.toasts = []; __M.badge = []; 1");
    const tOn = Date.now();
    await P.setNet("fast3g");
    const ws1 = await waitSynced(evSafe, 240000, "matrix");
    await P.wait(3000);
    const toasts = await evSafe("__M.toasts"); const badgeLog = await evSafe("__M.badge");
    R.ui.reconnect = { syncedMs: ws1.ms, st: ws1.st, toasts, badgeLog: (badgeLog || []).map((b) => ({ dt: b.t - tOn, s: b.s, title: b.title })) };
    R.ui.dirtyDrafts = await evSafe("(async function(){ var SQ = __T.SyncQueue, out = []; var ks = await SQ.allDraftKeys(); for (var i = 0; i < ks.length; i++) { var k = String(ks[i]); if (k.indexOf('oplog:') === 0 || k.indexOf('bundle:') === 0) continue; var d = await SQ.loadDraft(k); if (d && d.dirty) out.push({ key: k, depId: d.depId || null, pages: (d.pages || []).length, pins: (d.pins || []).length, wd: !!d.writeDenied }); } return { cur: __T.App._draftKey(), list: out }; })()");
    log("online synced", R.ui.reconnect);
    log("dirty drafts", R.ui.dirtyDrafts);
    await shot("online-synced");

    // 1-f 서버 D1 대조
    const L = await evSafe(`({ pins: ${PINS}, annos: __T.State.annotations.map(function(a){ return a.id; }).sort(), zones: __T.State.zones.map(function(z){ return z.id; }).sort(), panoIds: __T.State.pins.map(function(p){ return [p.imageId].concat((p.timeline||[]).map(function(t){ return t.imageId; })); }) })`);
    const S = await srvLive();
    const sp = byId(S.pins.map(norm)), lp = byId(L.pins);
    const panoIds = await srvPanoIds();
    const ids = (m) => [...m.keys()].sort();
    const dupSrv = S.pins.length !== new Set(S.pins.map((p) => String(p.id))).size;
    row("matrix", "핀 집합 — 로컬 = 서버(유실 0·중복 0)", ids(lp), ids(sp), J(ids(lp)) === J(ids(sp)) && !dupSrv);
    const cmp = (id, fields) => { const a = lp.get(String(id)), b = sp.get(String(id)); if (!a || !b) return { a, b, ok: false }; const pick = (o) => fields.reduce((m, f) => (m[f] = o[f], m), {}); return { a: pick(a), b: pick(b), ok: J(pick(a)) === J(pick(b)) }; };
    const rowPin = (item, id, fields, extra) => { const c = cmp(id, fields); return row("matrix", item, c.a, c.b, c.ok && (extra ? extra(c.a, c.b) : true)); };
    for (const id of O) rowPin("CHECKER 연속 생성 " + id, id, ["label", "x", "y", "cb", "gps"], (a) => !!a.gps);
    const labels = S.pins.filter((p) => p.checkboard).map((p) => String(p.label));
    row("matrix", "CHECKER 번호 중복 0(대역 규칙)", labels, labels, new Set(labels).size === labels.length);
    rowPin("360 핀 생성 + 사진 연결(파일 주입)", OP1, ["label", "x", "y", "img", "pend"], (a, b) => !!b.img && !b.pend && panoIds.has(String(b.img)));
    rowPin("현장 촬영 화면 등록", FC1, ["label", "x", "y", "img", "pend"], (a, b) => !!FC1 && !!b.img && !b.pend && panoIds.has(String(b.img)));
    rowPin("사진 이력 추가(P1 timeline)", P1, ["img", "pend", "tl"], (a, b) => b.tl.length >= 1 && b.tl.every((t) => !String(t).startsWith("PEND:") && panoIds.has(String(t))) && panoIds.has(String(b.img)));
    rowPin("핀 이동(C1)", C[0], ["x", "y"]);
    rowPin("번호(라벨) 수정(C2)", C[1], ["label"], (a) => a.label === "58");
    rowPin("리더선 전환 O1", O[0], ["leader", "callout"], (a) => a.leader === true && !!a.callout);
    rowPin("리더선 정렬 O2", O[1], ["leader", "callout"], (a) => a.leader === true && !!a.callout);
    row("matrix", "핀 삭제(C3) — 서버 tombstone·부활 0", { local: lp.has(String(C[2])) }, { server: sp.has(String(C[2])) }, !lp.has(String(C[2])) && !sp.has(String(C[2])));
    rowPin("360 도형·마커(P1 spots)", P1, ["spots"], (a) => a.spots.indexOf("sp-off1") >= 0 && a.spots.indexOf("sh-off1") >= 0);
    row("matrix", "PDF 주석 추가·삭제", L.annos, S.annos.map((a) => a.id).sort(), J(L.annos) === J(S.annos.map((a) => a.id).sort()) && L.annos.indexOf("an-off1") >= 0 && L.annos.indexOf("an-on1") < 0);
    const srvZ = S.zones.map((z) => z.id).sort();
    row("matrix", "영역 그리기·삭제", L.zones, srvZ, J(L.zones) === J(srvZ) && srvZ.indexOf("z_p114") < 0 && S.zones.some((z) => z.label === "오프라인영역"));
    const sn = await srvNotes();
    const live = sn.filter((n) => !n.deleted);
    const n3 = live.filter((n) => n.body === "오프라인 결함 노트");
    row("matrix", "노트 작성(오프라인) — 1건·기한·심각도", notesOff && notesOff.after.filter((n) => n.body === "오프라인 결함 노트"), n3, n3.length === 1 && Number(n3[0].due_at) > 0 && n3[0].severity === "상");
    const n1 = sn.filter((n) => n.body === "온라인 노트 1")[0], n2 = sn.filter((n) => n.body === "온라인 노트 2")[0];
    row("matrix", "노트 상태 변경(결함 상태)", "progress", n1 && n1.status, n1 && n1.status === "progress");
    row("matrix", "노트 삭제", "deleted", n2 && n2.deleted, n2 && Number(n2.deleted) === 1);
    const pendLeft = S.pins.filter((p) => p.pendingOpId || (p.timeline || []).some((t) => t && t.pendingOpId && !t.imageId));
    row("matrix", "서버에 미치환 pendingOpId 0", 0, pendLeft.map((p) => p.id), pendLeft.length === 0);
    const r2o = await r2Objects();
    R.r2 = r2o;
    // UI 표시
    const bOff = R.ui.offlineBadge || {};
    row("matrix", "[표시] 오프라인 배지 보임 · 대비 ≥4.5", bOff, bOff, bOff.show === true && /오프라인/.test(bOff.text || "") && (bOff.contrast || 0) >= 4.5 && (bOff.contrastQ || 0) >= 4.5);
    const pendShown = R.ui.offlineBadgeAfterWork.badge, ss = R.ui.offlineBadgeAfterWork.sync;
    row("matrix", "[표시] 대기 건수 > 0 (오프라인 작업 후)", ss, pendShown, pendShown && pendShown.q > 0);
    const tl = (R.ui.reconnect.toasts || []).map((t) => t.text).join(" | ");
    const bl = (R.ui.reconnect.badgeLog || []).map((b) => b.s).join(" > ");
    // 정확도: 시작 "N건 업로드 중" 의 N = 완료 토스트들이 알린 건수 합(부분 완료 + 남은 건 재시도 완료), 마지막은 전체 완료
    const startN = ((tl.match(/(\d+)건 업로드 중/) || [])[1]) | 0;
    const doneN = [...tl.matchAll(/업로드 (\d+)건 완료|변경 (\d+)건 서버 반영/g)].reduce((a, m) => a + Number(m[1] || m[2] || 0), 0);
    row("matrix", "[표시] 복귀 시 'N건 업로드 중 → 완료' 진행 표시(건수 정확)", { startN, badgeUploading: /업로드 중/.test(bl) }, { doneN, toasts: tl, badge: bl }, startN > 0 && doneN === startN && /업로드 중/.test(bl) && /업로드 완료/.test(tl));
    const idsNow = await evSafe("(function(){ var b = document.getElementById('net-badge'); return __M.visible(b); })()");
    row("matrix", "[표시] 동기화 끝나면 배지 해제", false, idsNow, idsNow === false);
    save();
  }

  /* ═════════════ 2. 동시 편집(기기 A 오프라인 · 기기 B 온라인) ═════════════ */
  let B = null;
  const openDeviceB = async () => {
    if (B) return B;
    const ctx = await browser.send("Target.createBrowserContext", {});
    const tg = await browser.send("Target.createTarget", { url: "about:blank", browserContextId: ctx.browserContextId });
    let wsUrl = null;
    for (let i = 0; i < 40 && !wsUrl; i++) { const l = await getJson("http://127.0.0.1:" + P.cdpPort + "/json/list"); const t = l.find((x) => x.id === tg.targetId); if (t) wsUrl = t.webSocketDebuggerUrl; else await P.wait(200); }
    const s = await cdpSession(wsUrl);
    const loadsB = [];
    s.handlers.push((m) => { if (m.method === "Page.loadEventFired") loadsB.push(Date.now()); });
    await s.send("Page.enable"); await s.send("Runtime.enable"); await s.send("Network.enable");
    await s.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
    await s.send("Page.addScriptToEvaluateOnNewDocument", { source: XLIB });
    await s.send("Page.navigate", { url: BASE + "/manifest.webmanifest" });
    await P.wait(1500);
    const TOKB = "local-p146b-" + Date.now().toString(36);
    await P.run("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOKB, P.DESIGNER, Date.now(), Date.now() + 8.64e7]);
    await s.ev(`localStorage.setItem("wm_local_token", ${J(TOKB)}); 1`);
    await s.send("Page.navigate", { url: BASE + "/" });
    const waitB = async (cond, to) => { const t0 = Date.now(); while (Date.now() - t0 < to) { const v = await s.evSafe("(function(){try{return !!(" + cond + ")}catch(e){return false}})()"); if (v === true) return Date.now() - t0; await P.wait(150); } return -1; };
    await waitB("window.__T && document.querySelector('.hub-tree-deck[data-act=deck-open]')", 90000);
    // [WO 20261011-offmerge] 허브가 첫 렌더 직후 다시 그려지면 그 사이 클릭이 떨어진 노드에 간다(실측: del 단계가 첫 B 진입일 때 허브에 머묾,
    //   스크린샷 p146-deviceB-fail) — 같은 클릭을 최대 5회(매번 새로 찾은 노드)까지 반복한다. 앱 동작은 그대로(사용자 재클릭과 같다).
    const clickLeafB = "(function(){ var e = document.querySelector('.hub-tree-deck[data-act=deck-open]'); if (!e) return 0; e.scrollIntoView({block:'center'}); e.click(); return 1; })()";
    let okB = -1;
    for (let i = 0; i < 5 && okB < 0; i++) { await s.evSafe(clickLeafB); okB = await waitB(drawn, i < 4 ? 12000 : 40000); }
    if (okB < 0) { await shot("deviceB-fail", s.send); log("device B 본문", await s.evSafe("({ decks: window.__T && __T.Projects ? (__T.Projects.decks || []).length : -1, cur: window.__T && __T.Projects && __T.Projects.currentProject ? __T.Projects.currentProject.id : null, mode: window.__T && __T.State.mode, toasts: (window.__M ? __M.toasts : []).slice(-5).map(function(t){ return t.text; }), body: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400) })")); }
    if (okB < 0) log("device B 진단", await s.evSafe("({ href: location.href, T: !!window.__T, dep: window.__T && __T.State.autoSaveDepId || null, rect: !!(window.__M && __M.drawingRect()), img: (function(){ var i = document.getElementById('map-image'); return i ? { c: i.complete, w: i.naturalWidth, src: String(i.src).slice(0, 80) } : null; })(), modal: Array.from(document.querySelectorAll('.modal, [role=dialog], .wm-gate, #install-gate')).filter(function(e){ return __M.visible(e); }).map(function(e){ return (e.id || e.className) + ':' + (e.innerText || '').slice(0, 80); }) })"));
    B = Object.assign(s, { waitB, ok: okB >= 0, TOKB });
    log("device B open", { ok: okB });
    return B;
  };
  const aOffline = async (on) => { await send("Network.emulateNetworkConditions", on ? { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } : { offline: false, latency: 40, downloadThroughput: -1, uploadThroughput: -1 }); };
  /** A 가 지금 도면을 연 상태인지 — 아니면 연다(온라인) */
  const ensureADrawing = async () => { if ((await waitFor(drawn, 3000)) < 0) { await openHub(); await openLeaf(); await P.wait(2000); } };
  const placeVia = (E, fx, fy, mode) => E(`(function(){ var A = __T.App; if (${J(mode || "checkboard")} === 'photo' && __T.State.regMode !== 'photo') A._setRegMode('photo'); var p = A._placeCheckboardPin({ x: ${fx}, y: ${fy} }); return p ? { id: String(p.id), label: p.label } : null; })()`);
  const editVia = (E, id, js) => E(`(function(){ var p = __T.State.pins.find(function(p){ return String(p.id) === ${J(String(id))}; }); if (!p) return null; ${js}; __T.App._autoSave(); return ${NORM}(p); })()`);

  if (PHASES.has("conc")) {
    await ensureADrawing();
    await waitSynced(evSafe, 60000, "pre-conc");
    // 공용 핀 3개를 온라인에서 만든다(X: A 먼저·B 나중 / W: B 먼저·A 나중 / Y: B 가 지움)
    const X = await placeVia(evSafe, 20, 80), W = await placeVia(evSafe, 30, 80), Y = await placeVia(evSafe, 40, 80);
    await evSafe(`(function(){ __T.State.annotations.push({ id: 'an-base', page: 1, type: 'rect', color: '#111', x: 10, y: 400, w: 50, h: 20 }); __T.PdfAnno._persist(); return 1; })()`);
    await P.wait(2500);
    await waitSynced(evSafe, 60000, "conc-seed");
    const b = await openDeviceB();
    P.ok(b.ok, "[conc] 기기 B(별도 브라우저 컨텍스트) 도면 열림");
    await b.waitB(`__T.State.pins.some(function(p){ return String(p.id) === ${J(Y.id)}; })`, 30000);
    // A 오프라인(페이지 단위 — B 는 계속 온라인)
    await aOffline(true); await P.wait(1200);
    const AO1 = await placeVia(evSafe, 55, 85);
    await P.wait(300);
    await editVia(evSafe, X.id, "p.label = 'A-X'; p.labelManual = true");
    await evSafe(`(function(){ __T.State.annotations.push({ id: 'an-A', page: 1, type: 'rect', color: '#16a34a', x: 400, y: 400, w: 50, h: 20 }); __T.PdfAnno._persist(); return 1; })()`);
    await P.wait(1500);
    // B 온라인 — X 를 더 나중에 수정 · W 먼저 수정 · Y 삭제 · 새 핀 · 주석 · 영역
    await editVia(b.evSafe, W.id, "p.label = 'B-W'; p.labelManual = true");
    await P.wait(300);
    await editVia(b.evSafe, X.id, "p.label = 'B-X'; p.labelManual = true");
    const BO1 = await placeVia(b.evSafe, 65, 85);
    await b.evSafe(`(function(){ return __T.App._removePins([${J(Y.id)}]).length; })()`);
    await b.evSafe(`(function(){ __T.State.annotations.push({ id: 'an-B', page: 1, type: 'rect', color: '#2563eb', x: 500, y: 400, w: 50, h: 20 }); __T.PdfAnno._persist(); return 1; })()`);
    await b.evSafe(`(async function(){ var Pr = __T.Prompt; var oa = Pr.ask; Pr.ask = function(){ return Promise.resolve({ value: 'B영역' }); }; try { await __T.Zones._commitZone({ shape: 'rect', x: 5, y: 5, w: 8, h: 8 }); } finally { Pr.ask = oa; } return 1; })()`);
    for (let i = 0; i < 40; i++) { const s = await srvLive(); if (s.pins.some((p) => String(p.id) === BO1.id) && !s.pins.some((p) => String(p.id) === Y.id) && s.annos.some((a) => a.id === "an-B") && s.zones.some((z) => z.label === "B영역")) break; await P.wait(500); }
    await P.wait(1500);
    // A 가 W 를 더 나중에 수정(오프라인)
    await editVia(evSafe, W.id, "p.label = 'A-W'; p.labelManual = true");
    await P.wait(1500);
    // A 복귀
    await aOffline(false);
    const wc = await waitSynced(evSafe, 180000, "conc");
    await P.wait(2500);
    const S = await srvLive();
    const sp = new Map(S.pins.map((p) => [String(p.id), p]));
    const Lp = new Map(((await evSafe(PINS)) || []).map((p) => [p.id, p]));
    row("conc", "A 오프라인 새 핀 + B 온라인 새 핀 — 둘 다 보존", [AO1 && AO1.id, BO1 && BO1.id], [sp.has(AO1.id), sp.has(BO1.id)], sp.has(AO1.id) && sp.has(BO1.id));
    const labs = S.pins.filter((p) => p.checkboard && (p.page || 1) === 1).map((p) => String(p.label));
    row("conc", "번호 충돌 → 대역 재채번(resolveConcurrentNos)", { A: AO1 && AO1.label, B: BO1 && BO1.label }, { A: sp.get(AO1.id) && sp.get(AO1.id).label, B: sp.get(BO1.id) && sp.get(BO1.id).label, dup: labs.length - new Set(labs).size }, new Set(labs).size === labs.length);
    row("conc", "같은 핀(X) 두 기기 수정 → 나중(B) 이 이김", "B-X", sp.get(X.id) && sp.get(X.id).label, sp.get(X.id) && sp.get(X.id).label === "B-X");
    row("conc", "같은 핀(W) 두 기기 수정 → 나중(A 오프라인) 이 이김", "A-W", sp.get(W.id) && sp.get(W.id).label, sp.get(W.id) && sp.get(W.id).label === "A-W");
    row("conc", "B 가 지운 핀(Y) — A 복귀 후에도 삭제 유지(부활 0)", false, sp.has(Y.id), !sp.has(Y.id) && !Lp.has(Y.id));
    const aIds = S.annos.map((a) => a.id);
    row("conc", "주석: A 오프라인 추가 + B 온라인 추가 — 둘 다 보존", ["an-A", "an-B", "an-base"], aIds, ["an-A", "an-B", "an-base"].every((k) => aIds.indexOf(k) >= 0));
    row("conc", "영역: B 온라인 추가 — A 복귀 후 보존", "B영역", S.zones.map((z) => z.label), S.zones.some((z) => z.label === "B영역"));
    const lIds = [...Lp.keys()].sort(), sIds = [...sp.keys()].sort();
    row("conc", "A 로컬 = 서버(동기화 후)", lIds, sIds, J(lIds) === J(sIds));
    // B 가 서버 최신을 받는가(라이브 폴 = 정본 _liveTick 1회)
    await b.evSafe("__T.App._liveTick ? __T.App._liveTick() : null");
    await P.wait(1500);
    const bIds = ((await b.evSafe("__T.State.pins.map(function(p){ return String(p.id); })")) || []).sort();
    row("conc", "B 화면 = 서버(라이브 반영 후)", bIds, sIds, J(bIds) === J(sIds));
    R.concDetail = { wc, X, W, Y, AO1, BO1 };
    save();
  }

  /* ═════════════ 3. S-REV — A 오프라인 편집 중 B(소유자)가 도면 개정 적용 ═════════════ */
  if (PHASES.has("rev")) {
    await ensureADrawing();
    await aOffline(false);
    await waitSynced(evSafe, 90000, "pre-rev");
    const R1 = await placeVia(evSafe, 22, 62), R2 = await placeVia(evSafe, 32, 62), R3 = await placeVia(evSafe, 42, 62);
    await P.wait(2500);
    await waitSynced(evSafe, 60000, "rev-seed");
    const s0 = await srvLive();
    const orig = new Map(s0.pins.map((p) => [String(p.id), p]));
    await aOffline(true); await P.wait(1200);
    // A 오프라인: R1 라벨만 · R2 이동 · 새 핀 RN
    await editVia(evSafe, R1.id, "p.label = 'REV-A1'; p.labelManual = true");
    await editVia(evSafe, R2.id, "p.x = +p.x + 3; p.y = +p.y + 2");
    const RN = await placeVia(evSafe, 52, 62);
    await P.wait(1500);
    const aLocal = new Map(((await evSafe(PINS)) || []).map((p) => [p.id, p]));
    // B(소유자) 개정 적용 — 이동(+5, -3) 아핀
    const cur = await srvDepRow();
    const T = { a: 1, b: 0, c: 0, d: 1, e: 5, f: -3 };
    const pages = parse((await db.prepare("SELECT pages_data FROM deployments WHERE id = ?").bind(P.DEP_ID).first()).pages_data);
    const ap = await P.api("POST", "/api/deployments/" + P.DEP_ID + "/revisions", { rev_label: "Rev.B", pages_data: pages, transform: T, base_version: cur.version, file_name: "GA-revB.pdf" });
    log("revision apply", { status: ap.status, j: ap.j });
    P.ok(ap.status === 200 && ap.j && ap.j.ok, "[rev] B 개정 적용(서버 200)", ap);
    const s1 = await srvLive();
    const carried = new Map(s1.pins.map((p) => [String(p.id), p]));
    // A 복귀
    await aOffline(false);
    const wr = await waitSynced(evSafe, 180000, "rev");
    await P.wait(2500);
    const S = await srvLive();
    const sp = new Map(S.pins.map((p) => [String(p.id), p]));
    const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;
    const ex = (o) => ({ x: Number(o.x) + T.e, y: Number(o.y) + T.f });
    const r1 = sp.get(R1.id), r2 = sp.get(R2.id), rn = sp.get(RN && RN.id);
    const e1 = ex(orig.get(R1.id)), e2 = ex(aLocal.get(R2.id)), en = ex(aLocal.get(RN.id));
    const flagged = (p) => !!(p && p.revReview);
    row("rev", "R1(A 라벨만 수정) — 라벨 보존 + 개정 좌표", { label: "REV-A1", x: e1.x, y: e1.y }, r1 && { label: r1.label, x: r1.x, y: r1.y, rev: r1.revReview || null }, r1 && r1.label === "REV-A1" && near(r1.x, e1.x) && near(r1.y, e1.y));
    row("rev", "R2(A 오프라인 이동) — 이동을 개정 기준으로 변환(또는 검토 표시)", { x: e2.x, y: e2.y }, r2 && { x: r2.x, y: r2.y, rev: r2.revReview || null }, r2 && ((near(r2.x, e2.x) && near(r2.y, e2.y)) || flagged(r2)) && !(near(r2.x, aLocal.get(R2.id).x) && near(r2.y, aLocal.get(R2.id).y) && !flagged(r2)));
    row("rev", "RN(A 오프라인 새 핀) — 변환 또는 검토 표시(조용한 옛 좌표 0)", { x: en.x, y: en.y }, rn && { x: rn.x, y: rn.y, rev: rn.revReview || null }, rn && ((near(rn.x, en.x) && near(rn.y, en.y)) || flagged(rn)));
    const r3 = sp.get(R3.id), e3 = ex(orig.get(R3.id));
    row("rev", "R3(A 미수정) — 개정 좌표 유지", e3, r3 && { x: r3.x, y: r3.y }, r3 && near(r3.x, e3.x) && near(r3.y, e3.y));
    const Lp = new Map(((await evSafe(PINS)) || []).map((p) => [p.id, p]));
    const lr1 = Lp.get(R1.id);
    row("rev", "A 로컬 화면도 개정 좌표(R1)", e1, lr1 && { x: lr1.x, y: lr1.y }, lr1 && near(lr1.x, e1.x) && near(lr1.y, e1.y));
    R.revDetail = { wr, carried: [...carried.values()].filter((p) => [R1.id, R2.id, R3.id].indexOf(String(p.id)) >= 0).map(norm), final: [r1, r2, r3, rn].map((p) => p && norm(p)) };
    save();
  }

  /* ═════════════ 5~7 공용(주석·영역) — 앱 정본 경로만 쓴다(Zones._commitZone · Zones.remove · PdfAnno._persist/_removeAnnos · App._autoSave) ═════════════ */
  const commitZoneVia = (E, label, geom) => E(`(async function(){ var Pr = __T.Prompt; var oa = Pr.ask; Pr.ask = function(){ return Promise.resolve({ value: ${J(label)} }); };
    try { await __T.Zones._commitZone(${J(geom)}); } finally { Pr.ask = oa; }
    var z = __T.State.zones.filter(function(z){ return z.label === ${J(label)}; }).pop(); return z ? { id: String(z.id), label: z.label } : null; })()`);
  const removeZoneVia = (E, id) => E(`(async function(){ var Pr = __T.Prompt; var oc = Pr.confirm; Pr.confirm = function(){ return Promise.resolve(true); };
    try { return await __T.Zones.remove(${J(id)}); } finally { Pr.confirm = oc; } })()`);
  const editZoneVia = (E, id, js) => E(`(function(){ var z = __T.State.zones.find(function(z){ return String(z.id) === ${J(String(id))}; }); if (!z) return null; ${js}; __T.App._autoSave(); return { id: String(z.id), label: z.label, x: z.x, y: z.y, w: z.w, h: z.h, upd: z.updatedAt || null }; })()`);
  const addAnnoVia = (E, a) => E(`(function(){ __T.State.annotations.push(${J(a)}); __T.PdfAnno._persist(); return 1; })()`);
  const localSets = (E = evSafe) => E("({ annos: __T.State.annotations.map(function(a){ return { id: String(a.id), x: a.x, y: a.y, w: a.w, h: a.h }; }), zones: __T.State.zones.map(function(z){ return { id: String(z.id), label: z.label, x: z.x, y: z.y, w: z.w, h: z.h, pinIds: (z.pinIds || []).map(String) }; }) })");
  /** B 화면이 서버를 따라오게(라이브폴 정본 _liveTick) — 조건이 참이 될 때까지 */
  const bCatchUp = async (b, cond, tries = 30) => { for (let i = 0; i < tries; i++) { await b.evSafe("__T.App._liveTick ? __T.App._liveTick() : null"); if ((await b.evSafe("(function(){try{return !!(" + cond + ")}catch(e){return false}})()")) === true) return true; await P.wait(700); } return false; };
  const srvWait = async (pred, tries = 40) => { for (let i = 0; i < tries; i++) { const s = await srvLive(); if (pred(s)) return s; await P.wait(500); } return srvLive(); };
  const idsOf = (arr) => (arr || []).map((o) => String(o.id)).sort();

  /* ═════════════ 5. del — 다른 기기가 지운 주석·영역(저장 PATCH 경로 · /ops 경로) → A 오프라인 복귀 → 부활 0 ═════════════ */
  if (PHASES.has("del")) {
    await ensureADrawing();
    await aOffline(false);
    await waitSynced(evSafe, 90000, "pre-del");
    const ts = Date.now().toString(36);
    const AN = { d1: "an-d1-" + ts, d2: "an-d2-" + ts, k: "an-k-" + ts, a: "an-Aoff-" + ts };
    const rect = (id, x) => ({ id, page: 1, type: "rect", color: "#1f2937", x, y: 620, w: 40, h: 20 });
    await addAnnoVia(evSafe, rect(AN.d1, 100)); await addAnnoVia(evSafe, rect(AN.d2, 160)); await addAnnoVia(evSafe, rect(AN.k, 220));
    const ZD1 = await commitZoneVia(evSafe, "D1영역-" + ts, { shape: "rect", x: 60, y: 62, w: 5, h: 5 });
    const ZD2 = await commitZoneVia(evSafe, "D2영역-" + ts, { shape: "rect", x: 68, y: 62, w: 5, h: 5 });
    await P.wait(2500);
    await waitSynced(evSafe, 60000, "del-seed");
    const s0 = await srvLive();
    P.ok([AN.d1, AN.d2, AN.k].every((k) => s0.annos.some((a) => a.id === k)) && ZD1 && ZD2 && s0.zones.some((z) => String(z.id) === ZD1.id) && s0.zones.some((z) => String(z.id) === ZD2.id), "[del] 시드: 주석 3 · 영역 2 서버 반영", { annos: idsOf(s0.annos), zones: idsOf(s0.zones) });
    // 앞 단계(rev)의 복귀 직후 첫 온라인 저장이 새 항목을 지난 개정으로 다시 옮기지 않는다(depRebase 해제 — 이중 이월 0)
    const sd1 = s0.annos.find((a) => a.id === AN.d1), sz1 = s0.zones.find((z) => ZD1 && String(z.id) === ZD1.id);
    row("del", "새로 만든 주석·영역 좌표 그대로 저장(지난 개정 재이월 0)", { anno: [100, 620], zone: [60, 62] }, { anno: sd1 && [sd1.x, sd1.y], zone: sz1 && [sz1.x, sz1.y] }, sd1 && sd1.x === 100 && sd1.y === 620 && sz1 && sz1.x === 60 && sz1.y === 62);
    const b = await openDeviceB();
    const bSeen = await bCatchUp(b, `__T.State.annotations.some(function(a){ return a.id === ${J(AN.d2)}; }) && __T.State.zones.some(function(z){ return String(z.id) === ${J(ZD2 && ZD2.id)}; })`);
    P.ok(bSeen, "[del] 기기 B 가 시드 주석·영역을 받음(라이브폴)");
    if (process.env.P146_DBG) log("del bundle before offline", await evSafe(`(async function(){ var b = await __T.SyncQueue.loadDraft('bundle:dep:' + __T.State.autoSaveDepId); var pa = function(s){ try { return JSON.parse(s || '[]').map(function(o){ return o.id; }); } catch (e) { return 'ERR'; } }; var one = function(s, id){ try { return JSON.parse(s || '[]').filter(function(o){ return String(o.id) === id; })[0] || null; } catch (e) { return null; } }; return b ? { annos: pa(b.annotations), zones: pa(b.zones), d1: one(b.annotations, ${J(AN.d1)}), z1: one(b.zones, ${J(ZD1 && ZD1.id)}), sd1: __T.State.annotations.filter(function(a){ return a.id === ${J(AN.d1)}; })[0] || null, ver: b.version } : null; })()`));
    // A 오프라인 — 다른 항목 편집(draft dirty + oplog 둘 다 생기게): 주석 추가 · 주석 수정 · 영역 추가
    await aOffline(true); await P.wait(1200);
    await addAnnoVia(evSafe, rect(AN.a, 300));
    await evSafe(`(function(){ var a = __T.State.annotations.find(function(a){ return a.id === ${J(AN.k)}; }); a.x = 260; __T.PdfAnno._persist(); return 1; })()`);
    const ZA = await commitZoneVia(evSafe, "A오프영역-" + ts, { shape: "rect", x: 76, y: 62, w: 5, h: 5 });
    await P.wait(1500);
    // B 온라인 — 저장(PATCH) 경로 삭제(정본 삭제 함수 → _autoSave → PATCH: 서버엔 tombstone 이 남지 않는다)
    await b.evSafe(`(function(){ __T.PdfAnno._removeAnnos([${J(AN.d1)}]); return 1; })()`);
    const bz = await removeZoneVia(b.evSafe, ZD1.id);
    const sP = await srvWait((s) => !s.annos.some((a) => a.id === AN.d1) && !s.zones.some((z) => String(z.id) === ZD1.id));
    const rawP = { annos: parse(sP.raw.annotations).filter((a) => a && a.id === AN.d1), zones: parse(sP.raw.zones).filter((z) => z && String(z.id) === ZD1.id) };
    P.ok(bz === true && rawP.annos.length === 0 && rawP.zones.length === 0, "[del] B 저장(PATCH)으로 삭제 — 서버에 tombstone 없이 사라짐(기준 목록 없이는 구분 불가한 경로)", rawP);
    // /ops 경로 삭제 — 다른 기기의 오프라인 복귀 op 와 같은 본문(OpLog._mkOp 모양)
    const opsR = await P.api("POST", "/tables/deployments/" + P.DEP_ID + "/ops", { base_version: null, ops: [
      { opId: "p146-del-a-" + ts, entity: "anno", action: "delete", id: AN.d2, data: null, ts: Date.now(), author: P.DESIGNER },
      { opId: "p146-del-z-" + ts, entity: "zone", action: "delete", id: ZD2.id, data: null, ts: Date.now(), author: P.DESIGNER }] });
    const rawO = await srvDepRow();
    const tombs = { anno: parse(rawO.annotations).some((a) => a && a.id === AN.d2 && a._deleted), zone: parse(rawO.zones).some((z) => z && String(z.id) === ZD2.id && z._deleted) };
    P.ok(opsR.status === 200 && tombs.anno && tombs.zone, "[del] /ops 로 삭제 — 서버 tombstone 남음", { status: opsR.status, tombs });
    await bCatchUp(b, `!__T.State.annotations.some(function(a){ return a.id === ${J(AN.d2)}; }) && !__T.State.zones.some(function(z){ return String(z.id) === ${J(ZD2.id)}; })`, 10);
    // 진단(관찰만): 복귀 직전 A 의 병합 기준·draft 메타 — 실패 시 원인 구분용
    const diagA = await evSafe(`(async function(){ var S = __T.State, A = __T.App, d = await __T.SyncQueue.loadDraft(A._draftKey()); var ops = ((await __T.SyncQueue.loadDraft('oplog:' + S.autoSaveDepId)) || []).map(function(o){ return o.entity + ':' + o.action + ':' + o.id + (${J(!!process.env.P146_DBG)} ? ' ' + JSON.stringify(o.data) : ''); }); return { ops: ops, ver: S.depVersion, dep: S.autoSaveDepId, rebase: S.depRebase || null, aBase: S.annoBaseIds, zBase: S.zoneBaseIds, dKey: A._draftKey(), d: d ? { dirty: d.dirty, baseVer: d.baseVer, depId: d.depId, baseAnno: d.baseAnnoIds, baseZone: d.baseZoneIds } : null }; })()`);
    log("del diagA", diagA);
    const apiN0 = P.net.api.length;
    // A 복귀(사용자 조작 없음) → 동기화 끝 → 라이브폴·다음 저장 기회까지 준 뒤 판정
    await aOffline(false);
    const wd = await waitSynced(evSafe, 180000, "del");
    if (process.env.P146_DBG) log("del dbg", (P.consoleLog || []).filter((l) => /P146DBG/.test(l)));
    log("del api after return", P.net.api.slice(apiN0).filter((a) => a.m !== "GET").map((a) => a.m + " " + a.p.replace(/^\/tables\/deployments\/[^/]+/, "/dep") + " " + a.s));
    await P.wait(2500);
    await evSafe("__T.App._liveTick ? __T.App._liveTick() : null"); await P.wait(3500);
    await waitSynced(evSafe, 60000, "del-after");
    const S = await srvLive(), L = await localSets();
    const sa = new Set(S.annos.map((a) => String(a.id))), sz = new Set(S.zones.map((z) => String(z.id)));
    const la = new Set((L.annos || []).map((a) => a.id)), lz = new Set((L.zones || []).map((z) => z.id));
    row("del", "주석: B 저장(PATCH)으로 지움 → A 오프라인 복귀 후 부활 0(서버·A 화면)", false, { srv: sa.has(AN.d1), local: la.has(AN.d1) }, !sa.has(AN.d1) && !la.has(AN.d1));
    row("del", "영역: B 저장(PATCH)으로 지움 → A 오프라인 복귀 후 부활 0(서버·A 화면)", false, { srv: sz.has(ZD1.id), local: lz.has(ZD1.id) }, !sz.has(ZD1.id) && !lz.has(ZD1.id));
    row("del", "주석: /ops 로 지움 → 부활 0(서버·A 화면)", false, { srv: sa.has(AN.d2), local: la.has(AN.d2) }, !sa.has(AN.d2) && !la.has(AN.d2));
    row("del", "영역: /ops 로 지움 → 부활 0(서버·A 화면)", false, { srv: sz.has(ZD2.id), local: lz.has(ZD2.id) }, !sz.has(ZD2.id) && !lz.has(ZD2.id));
    const kx = (S.annos.find((a) => a.id === AN.k) || {}).x;
    row("del", "A 오프라인 주석 추가·수정 + 영역 추가 — 보존(삭제 규칙이 남의 것만 지움)", { add: AN.a, kx: 260, zone: ZA && ZA.id }, { add: sa.has(AN.a), kx, zone: ZA && sz.has(ZA.id), syncedMs: wd.ms }, sa.has(AN.a) && kx === 260 && ZA && sz.has(ZA.id));
    row("del", "A 로컬 주석·영역 id = 서버", { a: [...la].sort(), z: [...lz].sort() }, { a: [...sa].sort(), z: [...sz].sort() }, J([...la].sort()) === J([...sa].sort()) && J([...lz].sort()) === J([...sz].sort()));
    R.delDetail = { AN, ZD1, ZD2, ZA, wd };
    save();
  }

  /* ═════════════ 6. zconc — 영역 동시 추가·수정(A 오프라인 · B 온라인) → 둘 다 보존 · 같은 영역은 나중 수정이 이김 ═════════════ */
  if (PHASES.has("zconc")) {
    await ensureADrawing();
    await aOffline(false);
    await waitSynced(evSafe, 90000, "pre-zconc");
    const ts = Date.now().toString(36);
    const ZA = await commitZoneVia(evSafe, "ZA-" + ts, { shape: "rect", x: 10, y: 70, w: 5, h: 5 });
    const ZB = await commitZoneVia(evSafe, "ZB-" + ts, { shape: "rect", x: 18, y: 70, w: 5, h: 5 });
    const ZC = await commitZoneVia(evSafe, "ZC-" + ts, { shape: "rect", x: 26, y: 70, w: 8, h: 8 });
    await P.wait(2500);
    await waitSynced(evSafe, 60000, "zconc-seed");
    const b = await openDeviceB();
    P.ok(await bCatchUp(b, `__T.State.zones.some(function(z){ return String(z.id) === ${J(ZC && ZC.id)}; })`), "[zconc] 기기 B 가 시드 영역을 받음");
    await aOffline(true); await P.wait(1200);
    // ZB: A 먼저(오프라인) · B 나중 → B 가 이김
    await editZoneVia(evSafe, ZB.id, "z.label = 'A-ZB'");
    await P.wait(400);
    // ZA: B 먼저 · A 나중(오프라인) → A 가 이김 / ZC: B 만 수정(이름) — A 는 그 안에 핀만 둔다(파생 pinIds 변화는 수정이 아니다)
    await editZoneVia(b.evSafe, ZA.id, "z.label = 'B-ZA'");
    await editZoneVia(b.evSafe, ZC.id, "z.label = 'B-ZC'");
    const BZ = await commitZoneVia(b.evSafe, "B새영역-" + ts, { shape: "rect", x: 34, y: 70, w: 5, h: 5 });
    await srvWait((s) => s.zones.some((z) => z.label === "B-ZA") && s.zones.some((z) => z.label === "B-ZC") && s.zones.some((z) => BZ && String(z.id) === BZ.id));
    await P.wait(800);
    await editZoneVia(evSafe, ZA.id, "z.label = 'A-ZA'");
    const pinInC = await placeVia(evSafe, 29, 73);
    await P.wait(600);
    const aZC = await evSafe(`(function(){ var z = __T.State.zones.find(function(z){ return String(z.id) === ${J(ZC.id)}; }); return z ? { label: z.label, pinIds: (z.pinIds || []).map(String), upd: z.updatedAt || null } : null; })()`);
    const AZ = await commitZoneVia(evSafe, "A새영역-" + ts, { shape: "rect", x: 42, y: 70, w: 5, h: 5 });
    await P.wait(1000);
    await editZoneVia(b.evSafe, ZB.id, "z.label = 'B-ZB'");
    await srvWait((s) => s.zones.some((z) => z.label === "B-ZB"));
    // A 복귀
    await aOffline(false);
    const wz = await waitSynced(evSafe, 180000, "zconc");
    await P.wait(2500);
    const S = await srvLive();
    const byId = new Map(S.zones.map((z) => [String(z.id), z]));
    const lab = (z) => (byId.get(z && z.id) || {}).label;
    row("zconc", "영역 동시 추가 — A 오프라인 새 영역 + B 온라인 새 영역 둘 다 보존", [AZ && AZ.id, BZ && BZ.id], [AZ && byId.has(AZ.id), BZ && byId.has(BZ.id)], AZ && BZ && byId.has(AZ.id) && byId.has(BZ.id));
    row("zconc", "같은 영역(ZA) 두 기기 수정 → 나중(A 오프라인) 이 이김", "A-ZA", lab(ZA), lab(ZA) === "A-ZA");
    row("zconc", "같은 영역(ZB) 두 기기 수정 → 나중(B 온라인) 이 이김", "B-ZB", lab(ZB), lab(ZB) === "B-ZB");
    row("zconc", "ZC: B 이름 수정 보존 — A 가 그 안에 핀만 둔 것(파생 pinIds)은 수정으로 치지 않음", { label: "B-ZC", aLocalBefore: aZC, pin: pinInC && pinInC.id }, lab(ZC), lab(ZC) === "B-ZC" && aZC && aZC.pinIds.indexOf(String(pinInC && pinInC.id)) >= 0);
    const L = await localSets();
    const lz = (L.zones || []).map((z) => z.id + ":" + z.label).sort(), szs = S.zones.map((z) => String(z.id) + ":" + z.label).sort();
    row("zconc", "A 로컬 영역(id·이름) = 서버", lz, szs, J(lz) === J(szs));
    await bCatchUp(b, `__T.State.zones.some(function(z){ return z.label === 'A-ZA'; })`, 10);
    const bz = ((await b.evSafe("__T.State.zones.map(function(z){ return String(z.id) + ':' + z.label; })")) || []).sort();
    row("zconc", "B 화면 영역 = 서버(라이브 반영 후)", bz, szs, J(bz) === J(szs));
    R.zconcDetail = { ZA, ZB, ZC, AZ, BZ, wz };
    save();
  }

  /* ═════════════ 7. revundo — 개정 적용(A 반영) → A 오프라인 편집 → B 가 10분 안에 되돌림 → A 복귀: 역변환 / 순서 모름 → 검토 배지 ═════════════ */
  if (PHASES.has("revundo")) {
    await ensureADrawing();
    await aOffline(false);
    await waitSynced(evSafe, 90000, "pre-revundo");
    const ts = Date.now().toString(36);
    const U1 = await placeVia(evSafe, 24, 30), U2 = await placeVia(evSafe, 32, 30), U3 = await placeVia(evSafe, 40, 30);
    const ZU = await commitZoneVia(evSafe, "ZU-" + ts, { shape: "rect", x: 50, y: 26, w: 6, h: 6 });
    await P.wait(2500);
    await waitSynced(evSafe, 60000, "revundo-seed");
    const s0 = await srvLive();
    const orig = new Map(s0.pins.map((p) => [String(p.id), p]));
    const T = { a: 0.9, b: 0, c: 0, d: 0.9, e: 0, f: 0 };   // 배율만 — 좌표 단위(핀·영역 %, 주석 ‰)와 무관하게 역변환 판정이 같다
    const pages = parse((await db.prepare("SELECT pages_data FROM deployments WHERE id = ?").bind(P.DEP_ID).first()).pages_data);
    /** B(소유자) 개정 적용 → A 가 라이브폴(정본 _liveTick)로 개정 좌표를 받을 때까지 */
    const applyRev = async (label) => {
      const cur = await srvDepRow();
      const ap = await P.api("POST", "/api/deployments/" + P.DEP_ID + "/revisions", { rev_label: label, pages_data: pages, transform: T, base_version: cur.version, file_name: "GA-" + label + ".pdf" });
      let got = false;
      for (let i = 0; i < 30 && ap.j && ap.j.version != null; i++) { await evSafe("__T.App._liveTick ? __T.App._liveTick() : null"); if (Number(await evSafe("__T.State.depVersion")) === Number(ap.j.version)) { got = true; break; } await P.wait(700); }
      return { status: ap.status, id: ap.j && ap.j.id, version: ap.j && ap.j.version, aAdopted: got };
    };
    const undo = (rid) => P.api("POST", "/api/deployments/" + P.DEP_ID + "/revisions/" + rid + "/undo", {});
    const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;
    const inv = (v) => Number(v) / T.a;
    // 7-a 정확한 역변환
    const ap1 = await applyRev("Rev.C");
    P.ok(ap1.status === 200 && ap1.aAdopted, "[revundo] 개정 적용 + A 화면 개정 좌표 반영(라이브폴)", ap1);
    await aOffline(true); await P.wait(1200);
    await editVia(evSafe, U1.id, "p.x = +p.x + 2; p.y = +p.y + 1");
    await editVia(evSafe, U2.id, "p.label = 'UNDO-2'; p.labelManual = true");
    const UN = await placeVia(evSafe, 60, 40);
    await editZoneVia(evSafe, ZU.id, "z.x = +z.x + 2");
    const AUN = "an-undo-" + ts;
    await addAnnoVia(evSafe, { id: AUN, page: 1, type: "rect", color: "#1f2937", x: 500, y: 300, w: 40, h: 20 });
    await P.wait(1500);
    const aL = new Map(((await evSafe(PINS)) || []).map((p) => [p.id, p]));
    const aLs = await localSets();
    const aZU = (aLs.zones || []).find((z) => z.id === ZU.id), aAN = (aLs.annos || []).find((a) => a.id === AUN);
    const ud = await undo(ap1.id);
    P.ok(ud.status === 200 && ud.j && ud.j.ok, "[revundo] B 가 10분 안에 되돌림(서버 200)", ud);
    await aOffline(false);
    const wu = await waitSynced(evSafe, 180000, "revundo");
    await P.wait(2500);
    const S = await srvLive();
    const sp = new Map(S.pins.map((p) => [String(p.id), p]));
    const xy = (p) => p && { x: p.x, y: p.y, label: p.label, rev: p.revReview || null };
    const u1 = sp.get(U1.id), u2 = sp.get(U2.id), u3 = sp.get(U3.id), un = sp.get(UN && UN.id);
    const l1 = aL.get(U1.id), ln = aL.get(UN && UN.id);
    row("revundo", "U1(A 오프라인 이동, 개정 좌표계) → 되돌린 도면 좌표로 역변환", { x: inv(l1.x), y: inv(l1.y) }, xy(u1), u1 && near(u1.x, inv(l1.x)) && near(u1.y, inv(l1.y)));
    row("revundo", "U2(A 라벨만 수정) → 라벨 보존 + 원래 좌표", { label: "UNDO-2", x: orig.get(U2.id).x, y: orig.get(U2.id).y }, xy(u2), u2 && u2.label === "UNDO-2" && near(u2.x, orig.get(U2.id).x) && near(u2.y, orig.get(U2.id).y));
    row("revundo", "UN(A 오프라인 새 핀) → 역변환", { x: inv(ln.x), y: inv(ln.y) }, xy(un), un && near(un.x, inv(ln.x)) && near(un.y, inv(ln.y)));
    row("revundo", "U3(A 미수정) → 원래 좌표 그대로", { x: orig.get(U3.id).x, y: orig.get(U3.id).y }, xy(u3), u3 && near(u3.x, orig.get(U3.id).x) && near(u3.y, orig.get(U3.id).y));
    const zu = S.zones.find((z) => String(z.id) === ZU.id), an = S.annos.find((a) => a.id === AUN);
    row("revundo", "영역 ZU(A 오프라인 이동) → 역변환", aZU && { x: inv(aZU.x), w: inv(aZU.w) }, zu && { x: zu.x, w: zu.w }, zu && aZU && near(zu.x, inv(aZU.x)) && near(zu.w, inv(aZU.w)));
    row("revundo", "주석(A 오프라인 추가) → 역변환", aAN && { x: inv(aAN.x), w: inv(aAN.w) }, an && { x: an.x, w: an.w }, an && aAN && near(an.x, inv(aAN.x)) && near(an.w, inv(aAN.w)));
    const Lp = new Map(((await evSafe(PINS)) || []).map((p) => [p.id, p]));
    const lu1 = Lp.get(U1.id);
    row("revundo", "A 화면도 역변환 좌표(U1)", { x: inv(l1.x), y: inv(l1.y) }, lu1 && { x: lu1.x, y: lu1.y }, lu1 && near(lu1.x, inv(l1.x)) && near(lu1.y, inv(l1.y)));
    // 7-b 되돌림 시점을 모르는 기록(0041 전 되돌림) — 순서가 섞였는지 알 수 없으므로 좌표를 추정 변환하지 않고 검토 배지
    const ap2 = await applyRev("Rev.E");
    P.ok(ap2.status === 200 && ap2.aAdopted, "[revundo] 개정 2 적용 + A 반영", ap2);
    await aOffline(true); await P.wait(1200);
    await editVia(evSafe, U3.id, "p.x = +p.x + 1; p.y = +p.y + 1");
    await P.wait(1500);
    const l3 = ((await evSafe(PINS)) || []).find((p) => p.id === U3.id);
    const ud2 = await undo(ap2.id);
    let legacy = "ok";
    //   0041 전 되돌림 행 = 정확한 버전 없음 + 마이그레이션이 채운 상한(그 시점 배포본 버전) — 마이그레이션의 UPDATE 와 같은 식으로 흉내낸다
    try { await P.run("UPDATE drawing_revisions SET reverted_version = NULL, reverted_version_max = (SELECT d.version FROM deployments d WHERE d.id = drawing_revisions.deployment_id) WHERE id = ?", [ap2.id]); } catch (e) { legacy = "no column: " + String(e.message).slice(0, 80); }
    await aOffline(false);
    const wu2 = await waitSynced(evSafe, 180000, "revundo-amb");
    await P.wait(2500);
    const S2 = await srvLive();
    const u3b = S2.pins.find((p) => String(p.id) === U3.id);
    const lu3 = await evSafe(`(function(){ var p = __T.State.pins.find(function(p){ return String(p.id) === ${J(U3.id)}; }); var m = document.querySelector('.pin-marker[data-id="' + ${J(U3.id)} + '"] .pin-rev-badge, [data-pin-id="' + ${J(U3.id)} + '"] .pin-rev-badge'); return p ? { x: p.x, y: p.y, rev: p.revReview || null, badge: !!m } : null; })()`);
    row("revundo", "되돌림 시점 모름 → 좌표 추정 변환 0 + 검토 표시(revReview.ambiguous) · A 화면에도", { x: l3.x, y: l3.y, ambiguous: true, undo: ud2.status, legacy },
      { srv: xy(u3b), local: lu3 }, u3b && near(u3b.x, l3.x) && near(u3b.y, l3.y) && u3b.revReview && u3b.revReview.ambiguous === true && lu3 && lu3.rev && lu3.rev.ambiguous === true);
    // 7-c 그 뒤(상한보다 새 기준)의 오프라인 편집은 되돌림 이후가 확실 — 표시·변환 0(영구 표시가 LWW 로 이후 편집을 덮던 결함 방지, 실측 F1 사진 연결 유실)
    //   (검토 표시는 사람이 확정할 때까지 남는 필드라, 앞 단계에서 표시된 핀이 아니라 새 핀으로 본다)
    await aOffline(true); await P.wait(1200);
    const UC = await placeVia(evSafe, 64, 34);
    await P.wait(1500);
    const lc = ((await evSafe(PINS)) || []).find((p) => p.id === (UC && UC.id));
    await aOffline(false);
    await waitSynced(evSafe, 180000, "revundo-after");
    await P.wait(2500);
    const ucS = (await srvLive()).pins.find((p) => String(p.id) === (UC && UC.id));
    row("revundo", "상한보다 새 기준의 오프라인 편집(새 핀) → 좌표 그대로 · 순서 모름 표시 0", { x: lc && lc.x, y: lc && lc.y, ambiguous: false }, xy(ucS), ucS && lc && near(ucS.x, lc.x) && near(ucS.y, lc.y) && !(ucS.revReview && ucS.revReview.ambiguous));
    // 손대지 않은 핀(U1)은 7-b 에서 op 로 다시 올라가지 않는다(번들 스냅샷이 병합본으로 갱신 — 남이 바꾼 항목을 내 upsert 로 기록 0)
    const u1b = S2.pins.find((p) => String(p.id) === U1.id);
    row("revundo", "7-b 손대지 않은 핀(U1) — 되돌린 좌표 유지 · 표시 0(남의 변경을 내 op 로 재기록 0)", { x: u1 && u1.x, y: u1 && u1.y }, xy(u1b), u1b && u1 && near(u1b.x, u1.x) && near(u1b.y, u1.y) && !(u1b.revReview && u1b.revReview.ambiguous));
    R.revundoDetail = { ap1, ap2, wu, wu2, legacy };
    save();
  }

  /* ═════════════ 4. 실패·복구 경로 ═════════════ */
  if (PHASES.has("fail")) {
    await ensureADrawing();
    await aOffline(false);
    await waitSynced(evSafe, 90000, "pre-fail");
    const fetchRules = { failSync: 0, failPatch: 0, failOps: 0, status500Sync: false, on409: null };
    const seen = [];
    const onPaused = async (m) => {
      if (m.method !== "Fetch.requestPaused") return;
      const rq = m.params.request, u = rq.url, meth = rq.method, rid = m.params.requestId;
      try {
        if (/\/api\/sync\/batch/.test(u) && fetchRules.status500Sync) { seen.push("500 " + u); return void (await send("Fetch.fulfillRequest", { requestId: rid, responseCode: 500, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(J({ error: "p146 injected 500" })).toString("base64") })); }
        if (/\/api\/sync\/batch/.test(u) && fetchRules.failSync > 0) { fetchRules.failSync--; seen.push("reset " + u); return void (await send("Fetch.failRequest", { requestId: rid, errorReason: "ConnectionReset" })); }
        if (meth === "PATCH" && /\/tables\/deployments\/[^/]+$/.test(u) && fetchRules.on409) { const f = fetchRules.on409; fetchRules.on409 = null; await f(); seen.push("409-inject " + u); }
        if (meth === "PATCH" && /\/tables\/deployments\/[^/]+$/.test(u) && fetchRules.failPatch > 0) { fetchRules.failPatch--; seen.push("reset " + meth + " " + u); return void (await send("Fetch.failRequest", { requestId: rid, errorReason: "ConnectionReset" })); }
        if (meth === "POST" && /\/ops$/.test(u) && fetchRules.failOps > 0) { fetchRules.failOps--; seen.push("reset ops " + u); return void (await send("Fetch.failRequest", { requestId: rid, errorReason: "ConnectionReset" })); }
        await send("Fetch.continueRequest", { requestId: rid });
      } catch (e) { try { await send("Fetch.continueRequest", { requestId: rid }); } catch (e2) {} }
    };
    P.evHandlers.push(onPaused);
    await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/sync/batch*" }, { urlPattern: "*/tables/deployments/*" }] });
    const offlinePinWithPhoto = async (fx, fy, fileName, w, h, q, noise) => {
      await aOffline(true); await P.wait(1000);
      const pin = await placeVia(evSafe, fx, fy, "photo");
      await evSafe(MKFILE(fileName, w, h, q, noise));
      const size = await evSafe(`window.__files[${J(fileName)}].size`);
      const r = await registerPhoto(`__T.State.pins.find(function(p){ return String(p.id) === ${J(pin && pin.id)}; })`, fileName);
      await evSafe("__T.App._setRegMode('checkboard'); 1");
      return { pin, r, size };
    };
    const srvHasPhoto = async (pinId) => { const s = await srvLive(); const p = s.pins.find((x) => String(x.id) === String(pinId)); const ids = await srvPanoIds(); return { pin: !!p, img: p && p.imageId, inDb: !!(p && p.imageId && ids.has(String(p.imageId))), pend: p && p.pendingOpId || null }; };

    // F1 업로드 중 연결 끊김 → 자동 재시도(사용자 조작 없이)
    { const f = await offlinePinWithPhoto(25, 45, "F1.JPG", 2048, 1024, 0.85, false);
      fetchRules.failSync = 1; fetchRules.failPatch = 1; fetchRules.failOps = 1;
      await aOffline(false);
      const w = await waitSynced(evSafe, 120000, "F1");
      const h = await srvHasPhoto(f.pin.id);
      row("fail", "F1 업로드 중 연결 끊김(사진·도면·ops 각 1회) → 자동 재시도로 완료", { pin: f.pin && f.pin.id }, { syncedMs: w.ms, st: w.st, srv: h, injected: seen.slice(-6) }, w.ms >= 0 && h.pin && h.inDb && !h.pend);
    }
    // F2 서버 409(GET~PATCH 사이 다른 사용자 저장) → 병합 후 재시도
    { await aOffline(true); await P.wait(800);
      const pa = await placeVia(evSafe, 35, 45); await P.wait(1500);
      const extId = 9e12 + Math.floor(Math.random() * 1e6);
      fetchRules.on409 = async () => { const cur = await srvDepRow(); const pins = parse(cur.pins); pins.push({ id: extId, x: 90, y: 90, page: 1, label: "SRV409", createdAt: Date.now(), updatedAt: Date.now() }); const r = await P.api("PATCH", "/tables/deployments/" + P.DEP_ID, { pins: J(pins), base_version: cur.version }); seen.push("ext PATCH " + r.status); };
      await aOffline(false);
      const w = await waitSynced(evSafe, 120000, "F2");
      const S = await srvLive(); const has = (id) => S.pins.some((p) => String(p.id) === String(id));
      row("fail", "F2 409(동시 저장) → 병합 후 재시도 — 양쪽 보존", { mine: pa && pa.id, other: extId }, { mine: has(pa && pa.id), other: has(extId), syncedMs: w.ms, injected: seen.filter((s) => /409|ext/.test(s)) }, w.ms >= 0 && has(pa && pa.id) && has(extId));
    }
    // F4 큰 사진(4MB 근처) — 원본 R2 보관 포함
    { const f = await offlinePinWithPhoto(45, 45, "BIG4MB.JPG", 2600, 1300, 0.97, true);
      const r2Before = await r2Objects();
      await aOffline(false);
      const w = await waitSynced(evSafe, 240000, "F4");
      const h = await srvHasPhoto(f.pin.id);
      const r2After = await r2Objects();
      const newObjs = r2After.filter((o) => !r2Before.some((x) => x.key === o.key));
      const origOk = newObjs.some((o) => o.size === f.size);
      row("fail", "F4 큰 사진(~4MB) 오프라인 → 업로드 + 원본 R2 보관(바이트 동일)", { size: f.size }, { syncedMs: w.ms, srv: h, newR2: newObjs }, f.size > 3e6 && w.ms >= 0 && h.inDb && origOk);
    }
    // F5 동기화 실패(서버 500) → '동기화 실패' 배지 + 사유 + 대비 / 복구 후 자동 해제
    { const f = await offlinePinWithPhoto(55, 45, "F5.JPG", 2048, 1024, 0.85, false);
      fetchRules.status500Sync = true;
      await evSafe("__M.toasts = []; 1");
      await aOffline(false);
      const failShown = await waitFor("(document.getElementById('net-text')||{}).textContent === '동기화 실패' && __M.visible(document.getElementById('net-badge'))", 60000);
      const b = await evSafe("(function(){ var e = document.getElementById('net-badge'); return { text: (document.getElementById('net-text')||{}).textContent, title: e.getAttribute('title'), contrast: __M.contrast(document.getElementById('net-text')), contrastQ: __M.contrast(document.getElementById('net-q')), toasts: __M.toasts.map(function(t){ return t.text; }) }; })()");
      await shot("sync-failed-badge");
      row("fail", "F5 서버 500 → '동기화 실패' 배지 + 사유(title·토스트) + 대비 ≥4.5", "동기화 실패", b, failShown >= 0 && /동기화 실패 — /.test(b.title || "") && (b.contrast || 0) >= 4.5 && (b.contrastQ || 0) >= 4.5 && b.toasts.some((t) => /동기화 실패/.test(t)));
      fetchRules.status500Sync = false;
      const w = await waitSynced(evSafe, 120000, "F5-recover");
      const h = await srvHasPhoto(f.pin.id);
      const hidden = await evSafe("!__M.visible(document.getElementById('net-badge'))");
      row("fail", "F5 서버 회복 → 자동 재시도로 업로드 + 배지 해제", true, { syncedMs: w.ms, srv: h, hidden }, w.ms >= 0 && h.inDb && hidden === true);
    }
    await send("Fetch.disable");
    // F3 토큰 만료 중 복귀 → 401 → '인증 필요' → 재로그인 → 자동 재시도
    { await aOffline(true); await P.wait(800);
      const pa = await placeVia(evSafe, 65, 45); await P.wait(1500);
      await P.run("UPDATE local_sessions SET revoked = 1 WHERE token = ?", [TOKEN]);
      await aOffline(false);
      const exp = await waitFor("__T.Auth && __T.Auth._expired === true", 60000);
      await waitFor("(document.getElementById('net-text')||{}).textContent === '인증 필요'", 6000);   // 배지 반영(표시 지연 상한 6s)
      const bt = await evSafe("(function(){ return { text: (document.getElementById('net-text')||{}).textContent, show: __M.visible(document.getElementById('net-badge')), contrast: __M.contrast(document.getElementById('net-text')) }; })()");
      await shot("auth-expired");
      const S0 = await srvLive();
      row("fail", "F3 토큰 만료 복귀 → '인증 필요' 배지(조용한 실패 0) · 데이터 보존", "인증 필요", { badge: bt, onServer: S0.pins.some((p) => String(p.id) === pa.id) }, exp >= 0 && bt.show && bt.text === "인증 필요" && (bt.contrast || 0) >= 4.5);
      const TOK2 = "local-p146r-" + Date.now().toString(36);
      await P.run("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOK2, P.DESIGNER, Date.now(), Date.now() + 8.64e7]);
      // 재로그인 = 회사 이메일 로그인 성공 경로(CompanyAuth._onAuthed — 토큰 저장 → Auth.refresh)
      await evSafe(`(function(){ __T.CompanyAuth._onAuthed(${J(TOK2)}, '현장', { email: ${J(P.DESIGNER)}, name: '현장', role: 'designer' }); return 1; })()`);
      const w = await waitSynced(evSafe, 120000, "F3");
      const S1 = await srvLive();
      row("fail", "F3 재로그인 → 자동 재시도로 업로드", pa && pa.id, { syncedMs: w.ms, onServer: S1.pins.some((p) => String(p.id) === pa.id), expired: w.st && w.st.expired }, w.ms >= 0 && S1.pins.some((p) => String(p.id) === pa.id));
      await P.run("UPDATE local_sessions SET revoked = 0 WHERE token = ?", [TOKEN]);
    }
    R.failInjected = seen;
    save();
  }

  /* ── 요약 표 ── */
  for (const t of ["matrix", "conc", "rev", "fail", "del", "zconc", "revundo"]) {
    if (!R[t].length) continue;
    console.log("\n[P146] ── " + t + " " + R[t].filter((r) => r.match).length + "/" + R[t].length + " PASS");
    R[t].forEach((r) => console.log("   " + (r.match ? "PASS" : "FAIL") + " | " + r.item));
  }
  save();
  try { if (B) B.close(); browser.close(); } catch (e) {}
}
