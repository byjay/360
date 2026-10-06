/** p114 EXPLORE — 오프라인 CHECKER 핀/PhotoBatch 가 OpLog 를 남기는가 + 온라인 복귀 시 유실되는가.
 *  실행: P114=1 P114_ROOT=<추출본> P114_EXPLORE=tests/p125-offline-oplog-cdp.mjs [XOP_FAULT=50] node tests/p114-mobile-field-flow.test.mjs
 *  XOP_FAULT=N : 온라인 복귀 동기화 동안 도면 PATCH N회를 네트워크 실패로 만든다(항구 약전파 — 큰 PATCH 만 끊김), 동기화 후 회복.
 *  HEAD 19daa4a 실측(XOP_FAULT=50): R1 oplog 0 · R2 oplog 0 · 화면 5→1핀 · 최종 서버 2 / 기대 6 (오프라인 4핀 영구 유실).
 */
const MLIB = String.raw`(function(){
  if (window.__M) return;
  var M = window.__M = {};
  M.visible = function(el){ if (!el) return false; var r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; var cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05; };
  M.mv = function(){ return document.getElementById('map-viewport'); };
  M.mapRect = function(){ var a = document.getElementById('map-area'); var e = (a && a.getBoundingClientRect().width > 0 ? a : M.mv()); if (!e) return null; var r = e.getBoundingClientRect(); return { x: Math.max(0, r.left), y: Math.max(0, r.top), r: Math.min(innerWidth, r.right), b: Math.min(innerHeight, r.bottom) }; };
  M.drawingRect = function(){ var c = [document.getElementById('map-image'), document.getElementById('pdf-canvas')].filter(function(e){ return e && M.visible(e); })[0]; if (!c) return null; var r = c.getBoundingClientRect(), R = M.mapRect(); if (!R) return null; var x = Math.max(r.left, R.x), y = Math.max(r.top, R.y), rr = Math.min(r.right, R.r), b = Math.min(r.bottom, R.b); return { x: x, y: y, w: rr - x, h: b - y }; };
  M.center = function(sel){ var e = document.querySelector(sel); if (!e || !M.visible(e)) return null; var r = e.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; };
})();`;

const ST = `(function(){ var S = __T.State; var dep = S.autoSaveDepId;
  return __T.SyncQueue.loadDraft('oplog:' + dep).then(function(ops){ ops = ops || [];
    return { pins: S.pins.length, ids: S.pins.map(function(p){ return String(p.id); }), dep: dep, ver: S.depVersion,
      oplog: ops.length, oplogPin: ops.filter(function(o){ return o.entity === 'pin'; }).map(function(o){ return o.action + ':' + o.id; }) }; }); })()`;

export default async function explore(P) {
  const { ev, evSafe, send, BASE, TOKEN, tap, waitFor, loads, report, saveReport } = P;
  const J = (o) => JSON.stringify(o);
  const X = (report.xoplog = { steps: [], fault: Number(process.env.XOP_FAULT || 0) });
  const rec = (n, d) => { X.steps.push({ n, d }); console.log("[X] " + n + " " + J(d)); };
  const st = () => evSafe(ST);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: MLIB });
  const tapSel = async (sel) => { const c = await evSafe(`__M.center(${J(sel)})`); if (!c || !c.x) { console.log("[X] tapSel 없음: " + sel); return null; } await tap(c.x, c.y); return c; };
  const drawn = "window.__M && __M.drawingRect() && ((document.getElementById('map-image')||{}).complete !== false)";
  const srvIds = async () => (await P.srvPins()).filter((p) => !p._deleted).map((p) => String(p.id));

  /* 1. 콜드 로드 + SW 캐시 */
  await P.setNet("fast3g");
  await send("Page.navigate", { url: BASE + "/manifest.webmanifest" });
  await waitFor("location.pathname === '/manifest.webmanifest'", 60000);
  await ev(`localStorage.setItem("wm_local_token", ${J(TOKEN)}); 1`);
  const n0 = loads.length, t0 = Date.now();
  await send("Page.navigate", { url: BASE + "/" });
  while (loads.length === n0 && Date.now() - t0 < 120000) await P.wait(100);
  await waitFor("document.querySelector('[data-act=mode-open][data-mode-reg=checkboard]')", 90000);
  await waitFor("navigator.serviceWorker && navigator.serviceWorker.controller", 90000);
  await P.wait(3000);

  /* 2. 다운로드 */
  let dl = -1;
  for (let a = 0; a < 8 && dl < 0; a++) {
    await evSafe("(function(){ var b=document.querySelector('.hub-card-dl'); if (b) b.scrollIntoView({block:'center'}); return !!b; })()");
    await P.wait(500);
    const c = await evSafe("__M.center('.hub-card-dl')");
    if (c && c.x) await tap(c.x, c.y); else await evSafe("(function(){var b=document.querySelector('.hub-card-dl'); if(b)b.click(); return !!b;})()");
    for (let i = 0; i < 60 && dl < 0; i++) {
      const v = await evSafe("Promise.race([__T.OfflineBundle.verify(" + J(P.PRJ) + ").then(function(v){return !!(v&&v.ok);}), new Promise(function(r){setTimeout(function(){r(false);},3000);})])");
      if (v === true) dl = i; else await P.wait(500);
    }
  }
  rec("download", { ok: dl >= 0 });
  if (dl < 0) { X.fatal = "다운로드 실패"; P.ok(false, "[X] 다운로드"); saveReport(); return; }

  /* 3. 도면 열기 → 온라인 핀 1개 */
  await evSafe("(function(){var e=document.querySelector('[data-act=mode-open][data-mode-reg=checkboard]'); e&&e.scrollIntoView({block:'center'}); return 1;})()");
  await P.wait(400);
  await tapSel("[data-act=mode-open][data-mode-reg=checkboard]");
  rec("open-drawing", { ms: await waitFor(drawn, 120000) });
  await P.wait(1500);
  if (!(await evSafe("!!__T.State.placing"))) { await tapSel("#mobile-dock [data-act=place]"); await P.wait(800); }
  const d1 = await evSafe("__M.drawingRect()");
  await tap(Math.round(d1.x + d1.w * 0.2), Math.round(d1.y + d1.h * 0.25));
  for (let i = 0; i < 60; i++) { if ((await srvIds()).length >= 1) break; await P.wait(500); }
  await P.wait(2000);
  rec("online-1pin", { srv: (await srvIds()).length, st: await st() });

  /* 4. 오프라인 → CHECKER 연속 탭 4개 */
  await P.setNet("offline");
  await P.wait(1500);
  if (!(await evSafe("!!__T.State.placing"))) { await tapSel("#mobile-dock [data-act=place]"); await P.wait(800); }
  const d2 = await evSafe("__M.drawingRect()");
  for (const [fx, fy] of [[0.30, 0.55], [0.45, 0.45], [0.65, 0.65], [0.75, 0.35]]) { await tap(Math.round(d2.x + d2.w * fx), Math.round(d2.y + d2.h * fy)); await P.wait(700); }
  await P.wait(2500);
  const afterTaps = await st();
  rec("R1 offline-checker-4taps", afterTaps);
  X.r1 = { pins: afterTaps.pins, oplog: afterTaps.oplog };

  /* 5. 오프라인 PhotoBatch._uploadOneRow (+ 호출부가 하는 _markUnsaved) — 마지막 CHECKER 핀에 사진 연결 */
  const pb = await evSafe(`(async function(){
    var PB = __T.PhotoBatch; if (!PB) return { err: 'PhotoBatch 미노출' };
    var pin = __T.State.pins[__T.State.pins.length - 1];
    var cv = document.createElement('canvas'); cv.width = 64; cv.height = 32; var g = cv.getContext('2d'); g.fillStyle = '#3a6'; g.fillRect(0, 0, 64, 32);
    var blob = await new Promise(function(r){ cv.toBlob(r, 'image/jpeg', 0.8); });
    var file = new File([blob], 'R0010001.JPG', { type: 'image/jpeg', lastModified: Date.now() });
    var before = ((await __T.SyncQueue.loadDraft('oplog:' + __T.State.autoSaveDepId)) || []).length;
    var r = await PB._uploadOneRow(pin, { file: file, name: 'R0010001.JPG', is360: false, sortKey: NaN }, true, new Set(), 'probe');
    PB._markUnsaved();
    await new Promise(function(r){ setTimeout(r, 1500); });
    var after = ((await __T.SyncQueue.loadDraft('oplog:' + __T.State.autoSaveDepId)) || []);
    return { r: r, pinId: String(pin.id), pendingOpId: pin.pendingOpId || null, oplogBefore: before, oplogAfter: after.length,
      pinOpsForPin: after.filter(function(o){ return o.entity === 'pin' && String(o.id) === String(pin.id); }).length };
  })()`);
  rec("R2 offline-photobatch", pb);
  X.r2 = pb;

  /* 6. 오프라인 핀 편집 1건(기록하는 진입점과 같은 호출 모양: OpLog.recordCurrent + _autoSave) — 온라인 핀의 라벨 변경 */
  const ed = await evSafe(`(async function(){
    var S = __T.State; var pin = S.pins[0];
    pin.note = 'offline-edit';
    await __T.OpLog.recordCurrent('pin', 'upsert', pin.id, pin);
    __T.App._autoSave();
    await new Promise(function(r){ setTimeout(r, 1500); });
    return { pinId: String(pin.id) };
  })()`);
  const beforeOnline = await st();
  rec("offline-before-online", { edit: ed, st: beforeOnline });

  /* 7. 온라인 복귀(옵션: 첫 draft PATCH 를 네트워크 실패로) */
  if (X.fault) {
    await ev(`(function(){ window.__failPatch = ${X.fault}; window.__failed = []; var of = window.fetch;
      window.fetch = function(u, o){ var s = String((u && u.url) || u); if (window.__failPatch > 0 && o && o.method === 'PATCH' && /\\/tables\\/deployments\\//.test(s)) { window.__failPatch--; window.__failed.push(s); return Promise.reject(new TypeError('Failed to fetch (probe fault)')); } return of.apply(this, arguments); };
      return 1; })()`);
  }
  const tOn = Date.now();
  await P.setNet("fast3g");
  let synced = -1;
  for (let i = 0; i < 240 && synced < 0; i++) {
    const s = await evSafe("(function(){ return __T.SyncQueue.loadDraft('oplog:' + __T.State.autoSaveDepId).then(function(o){ return { n: (o||[]).length, rc: !!__T.SyncQueue._reconnecting }; }); })()");
    const pc = await evSafe("__T.State.pins.length"); if (typeof pc === "number") { X.minPins = Math.min(X.minPins == null ? 1e9 : X.minPins, pc); }
    if (s && s.n === 0 && !s.rc && Date.now() - tOn > 4000) synced = Date.now() - tOn; else await P.wait(300);
  }
  await P.wait(2500);
  const afterOnline = await st();
  const srvA = await srvIds();
  const lostScreen = beforeOnline.ids.filter((i) => afterOnline.ids.indexOf(i) < 0);
  rec("after-online-sync", { syncedMs: synced, failed: X.fault ? await evSafe("window.__failed") : null, local: afterOnline.pins, minPinsDuringSync: X.minPins, server: srvA.length, lostFromScreen: lostScreen });
  X.afterOnline = { local: afterOnline.pins, server: srvA.length, lostScreen };

  if (X.fault) await evSafe("window.__failPatch = 0; 1");   // 약전파 회복 — 이후 PATCH 정상
  /* 8. 사용자가 계속 작업: 온라인 핀 1개 추가 → 자동저장(1.5s 디바운스) → 서버 */
  if (!(await evSafe("!!__T.State.placing"))) { await tapSel("#mobile-dock [data-act=place]"); await P.wait(800); }
  const d3 = await evSafe("__M.drawingRect()");
  await tap(Math.round(d3.x + d3.w * 0.55), Math.round(d3.y + d3.h * 0.8));
  await P.wait(8000);
  // 수동 [동기화] 1회 더(재시도 기회 부여 — draft 가 아직 dirty 면 여기서 올라가야 한다)
  await evSafe("Promise.race([__T.App.syncNow ? __T.App.syncNow() : null, new Promise(function(r){ setTimeout(r, 15000); })]).then(function(){ return 1; })");
  await P.wait(4000);
  const fin = await st();
  const srvF = await srvIds();
  const expected = beforeOnline.ids.length + 1;
  const missing = beforeOnline.ids.filter((i) => srvF.indexOf(i) < 0);
  rec("final", { expected, local: fin.pins, server: srvF.length, missingOnServer: missing });
  X.final = { expected, local: fin.pins, server: srvF.length, missing };
  P.ok(afterTaps.oplog >= 4, "[X] R1 오프라인 CHECKER 4탭 → oplog pin op ≥ 4", afterTaps);
  P.ok(pb && pb.pinOpsForPin >= 1, "[X] R2 오프라인 PhotoBatch → 그 핀 oplog ≥ 1", pb);
  P.ok(lostScreen.length === 0, "[X] 온라인 복귀 후 화면 핀 유실 0", X.afterOnline);
  P.ok(missing.length === 0 && srvF.length === expected, "[X] 최종 서버 핀 수 = 기대(오프라인 핀 전부 서버에)", X.final);
  saveReport();
}
