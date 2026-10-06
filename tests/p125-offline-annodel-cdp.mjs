/** p114 EXPLORE — 오프라인 주석 삭제 → 도면 PATCH 실패 → 복귀 시 주석 부활 여부.
 *  실행: P114=1 P114_ROOT=<추출본> P114_EXPLORE=tests/p125-offline-annodel-cdp.mjs node tests/p114-mobile-field-flow.test.mjs
 *  HEAD 164ee62 실측: 오프라인 삭제 → oplog 에 남은 주석 upsert 만(delete 0) → 복귀 직후 화면 부활 → 최종 서버·화면 모두 부활.
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

  const annoState = () => evSafe(`(async function(){ var S = __T.State, dep = S.autoSaveDepId; var o = (await __T.SyncQueue.loadDraft('oplog:' + dep)) || [];
    var b = await __T.SyncQueue.loadDraft('bundle:dep:' + dep); var ba = []; try { ba = JSON.parse((b && b.annotations) || '[]'); } catch (e) {}
    return { annos: (S.annotations || []).map(function(a){ return a.id; }), bundle: ba.map(function(a){ return a.id; }),
      oplogAnnos: o.filter(function(x){ return x.entity === 'anno'; }).map(function(x){ return x.action + ':' + x.id; }) }; })()`);
  const srvAnnoAll = async () => { try { return JSON.parse((await P.srvDep()).annotations || "[]"); } catch (e) { return []; } };
  const srvLive = async () => (await srvAnnoAll()).filter((a) => !a._deleted).map((a) => String(a.id));
  const AD = "anDel-" + Date.now().toString(36), AK = "anKeep-" + Date.now().toString(36);

  /* 4. 온라인 주석 2개(삭제 대상 AD · 유지 AK) → 서버 자동반영 대기 */
  await evSafe(`(function(){ var pg = __T.State.pdfPage || 1;
    __T.State.annotations.push({ id: ${J(AD)}, page: pg, type: 'rect', color: '#e11d48', x: 10, y: 10, w: 5, h: 5 });
    __T.State.annotations.push({ id: ${J(AK)}, page: pg, type: 'rect', color: '#2563eb', x: 30, y: 30, w: 5, h: 5 });
    __T.PdfAnno._persist(); return 1; })()`);
  let srvOk = false;
  for (let i = 0; i < 60 && !srvOk; i++) { const l = await srvLive(); srvOk = l.indexOf(AD) >= 0 && l.indexOf(AK) >= 0; if (!srvOk) await P.wait(500); }
  await P.wait(1500);
  rec("online-annos", { srvOk, srv: await srvLive(), st: await annoState() });

  /* 5. 오프라인 → AD 삭제(개별 삭제 경로) */
  await P.setNet("offline");
  await P.wait(1500);
  await evSafe(`(function(){ __T.PdfAnno._removeById(${J(AD)}); return 1; })()`);
  await P.wait(2000);
  const afterDel = await annoState();
  rec("offline-delete", afterDel);

  /* 6. 복귀 — 도면 PATCH 전부 실패(약전파), /ops 만 성공 */
  await ev(`(function(){ window.__failPatch = 50; window.__failed = []; var of = window.fetch;
    window.fetch = function(u, o){ var s = String((u && u.url) || u); if (window.__failPatch > 0 && o && o.method === 'PATCH' && /\\/tables\\/deployments\\//.test(s)) { window.__failPatch--; window.__failed.push(s); return Promise.reject(new TypeError('Failed to fetch (probe fault)')); } return of.apply(this, arguments); };
    return 1; })()`);
  const tOn = Date.now();
  await P.setNet("fast3g");
  let synced = -1;
  for (let i = 0; i < 240 && synced < 0; i++) {
    const s = await evSafe("(function(){ return __T.SyncQueue.loadDraft('oplog:' + __T.State.autoSaveDepId).then(function(o){ return { n: (o||[]).length, rc: !!__T.SyncQueue._reconnecting }; }); })()");
    if (s && s.n === 0 && !s.rc && Date.now() - tOn > 4000) synced = Date.now() - tOn; else await P.wait(300);
  }
  await P.wait(2500);
  const afterSync = await annoState();
  rec("after-online-sync", { syncedMs: synced, failed: await evSafe("window.__failed"), st: afterSync, srvLive: await srvLive(), srvAll: (await srvAnnoAll()).map((a) => a.id + (a._deleted ? "(†)" : "")) });
  await evSafe("window.__failPatch = 0; 1");

  /* 7. 계속 작업(온라인 핀 1개) → [동기화] */
  if (!(await evSafe("!!__T.State.placing"))) { await tapSel("#mobile-dock [data-act=place]"); await P.wait(800); }
  const d3 = await evSafe("__M.drawingRect()");
  await tap(Math.round(d3.x + d3.w * 0.55), Math.round(d3.y + d3.h * 0.8));
  await P.wait(6000);
  await evSafe("Promise.race([__T.App.syncNow ? __T.App.syncNow() : null, new Promise(function(r){ setTimeout(r, 15000); })]).then(function(){ return 1; })");
  await P.wait(4000);
  const fin = await annoState();
  const fsrv = await srvLive();
  rec("final", { local: fin && fin.annos, srvLive: fsrv });
  P.ok(srvOk, "[Z] 전제: 온라인 주석 2개 서버 반영");
  P.ok(afterDel && afterDel.oplogAnnos.indexOf("delete:" + AD) >= 0, "[Z] 오프라인 삭제 → oplog anno delete 기록", afterDel);
  P.ok(afterSync && afterSync.annos.indexOf(AD) < 0, "[Z] 복귀 직후 화면 부활 0", afterSync && afterSync.annos);
  P.ok(fsrv.indexOf(AD) < 0 && fin.annos.indexOf(AD) < 0, "[Z] 최종 서버·화면 부활 0", { srv: fsrv, local: fin && fin.annos });
  P.ok(fsrv.indexOf(AK) >= 0 && fin.annos.indexOf(AK) >= 0, "[Z] 안 지운 주석 유지", { srv: fsrv, local: fin && fin.annos });
  saveReport();
}
