/** p114 EXPLORE — 오프라인 PinActionPop 라벨 수정이 로컬(draft·번들 스냅샷)에 남는가 + 복귀 시 주석 유실.
 *  실행: P114=1 P114_ROOT=<추출본> P114_EXPLORE=tests/p125-offline-pap-anno-cdp.mjs node tests/p114-mobile-field-flow.test.mjs
 *  복귀 시 도면 PATCH 는 실패(약전파), /ops 응답은 4s 지연 — 그 사이 온라인 주석 B 를 그린다.
 *  HEAD a4c23f2 실측: 라벨 967 → draft·스냅샷 "1", 오프라인 새로고침 후 "1"(되돌아감) · 주석 A(오프라인) 보존,
 *  주석 B(응답 대기 중) 화면·서버 모두 유실.
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

  const stLocal = () => evSafe(`(async function(){ var S = __T.State, dep = S.autoSaveDepId, pin = S.pins[0];
    var d = await __T.SyncQueue.loadDraft(__T.App._draftKey()); var b = await __T.SyncQueue.loadDraft('bundle:dep:' + dep); var o = (await __T.SyncQueue.loadDraft('oplog:' + dep)) || [];
    var bp = []; try { bp = JSON.parse((b && b.pins) || '[]'); } catch (e) {}
    var lab = function(arr){ var q = (arr || []).filter(function(x){ return String(x.id) === String(pin.id); })[0]; return q ? q.label : null; };
    return { pinId: String(pin.id), state: pin.label, draft: lab(d && d.pins), bundle: lab(bp), oplogLabels: o.filter(function(x){ return x.entity === 'pin' && String(x.id) === String(pin.id); }).map(function(x){ return x.data && x.data.label; }),
      annos: (S.annotations || []).map(function(a){ return a.id; }), oplogAnnos: o.filter(function(x){ return x.entity === 'anno'; }).map(function(x){ return x.action + ':' + x.id; }), draftDirty: !!(d && d.dirty) }; })()`);
  const srvAnnos = async () => { try { return JSON.parse((await P.srvDep()).annotations || "[]").filter((a) => !a._deleted).map((a) => String(a.id)); } catch (e) { return []; } };

  /* 4. R1 — 오프라인 PinActionPop 라벨 수정 */
  await P.setNet("offline");
  await P.wait(1500);
  const LBL = String(900 + (Date.now() % 90));   // CHECKER 핀 라벨 = 번호(validateCheckboardLabel) — 숫자여야 저장된다
  const r1 = await evSafe(`(async function(){ var PAP = __T.PinActionPop; if (!PAP) return { err: 'PAP 미노출' }; var pin = __T.State.pins[0];
    PAP.open(pin.id); await new Promise(function(r){ setTimeout(r, 400); });
    var inp = document.getElementById('pap-label-input'); if (!inp) return { err: 'pap-label-input 없음' };
    inp.value = ${J(LBL)}; PAP._saveLabel(); await new Promise(function(r){ setTimeout(r, 2000); }); try { PAP.close(); } catch (e) {} return { ok: true }; })()`);
  const afterLabel = await stLocal();
  rec("R1 pap-label-offline", { r1, st: afterLabel });
  // 오프라인 새로고침 → 재진입
  { const nr = loads.length, tr = Date.now();
    await send("Page.reload", { ignoreCache: false });
    while (loads.length === nr && Date.now() - tr < 90000) await P.wait(150);
    let dd = await waitFor(drawn + " && __T.State.pins.length > 0", 30000);
    if (dd < 0) { await evSafe("(function(){var e=document.querySelector('[data-act=mode-open][data-mode-reg=checkboard]')||document.querySelector('.hub-card-thumb'); e&&e.scrollIntoView({block:'center'}); return 1;})()"); await P.wait(500); await tapSel("[data-act=mode-open][data-mode-reg=checkboard], .hub-card-thumb"); dd = await waitFor(drawn + " && __T.State.pins.length > 0", 60000); }
    await P.wait(2500); }
  const afterReload = await stLocal();
  rec("R1 after-offline-reload", afterReload);
  X.r1 = { want: LBL, afterEdit: afterLabel, afterReload: afterReload && afterReload.state };

  /* 5. R2 — 오프라인 주석 A */
  const annA = "anA-" + Date.now().toString(36);
  await evSafe(`(function(){ __T.State.annotations.push({ id: ${J(annA)}, page: __T.State.pdfPage || 1, type: 'rect', color: '#e11d48', x: 10, y: 10, w: 5, h: 5 }); __T.PdfAnno._persist(); return 1; })()`);
  await P.wait(2000);
  rec("R2 offline-anno", await stLocal());

  /* 6. 복귀 — 도면 PATCH 실패(약전파) + /ops 응답 4s 지연 · 그 사이 온라인 주석 B */
  await ev(`(function(){ window.__failPatch = 50; window.__failed = []; var of = window.fetch;
    window.fetch = function(u, o){ var s = String((u && u.url) || u);
      if (window.__failPatch > 0 && o && o.method === 'PATCH' && /\\/tables\\/deployments\\//.test(s)) { window.__failPatch--; window.__failed.push(s); return Promise.reject(new TypeError('Failed to fetch (probe fault)')); }
      if (o && o.method === 'POST' && /\\/ops$/.test(s)) { window.__opsInFlight = true; var a = arguments, t = this; return new Promise(function(r){ setTimeout(r, 4000); }).then(function(){ return of.apply(t, a); }).finally(function(){ window.__opsInFlight = false; }); }
      return of.apply(this, arguments); }; return 1; })()`);
  await P.setNet("fast3g");
  const annB = "anB-" + Date.now().toString(36);
  const inFlight = await waitFor("window.__opsInFlight === true", 30000);
  await evSafe(`(function(){ __T.State.annotations.push({ id: ${J(annB)}, page: __T.State.pdfPage || 1, type: 'rect', color: '#2563eb', x: 30, y: 30, w: 5, h: 5 }); __T.PdfAnno._persist(); return 1; })()`);
  await waitFor("window.__opsInFlight === false", 30000);
  await P.wait(3000);
  const afterSync = await stLocal();
  rec("after-online-sync", { inFlightMs: inFlight, failed: await evSafe("window.__failed"), st: afterSync, srvAnnos: await srvAnnos() });
  await evSafe("window.__failPatch = 0; 1");

  /* 7. 계속 작업 → 온라인 핀 1개 → [동기화] */
  if (!(await evSafe("!!__T.State.placing"))) { await tapSel("#mobile-dock [data-act=place]"); await P.wait(800); }
  const d3 = await evSafe("__M.drawingRect()");
  await tap(Math.round(d3.x + d3.w * 0.55), Math.round(d3.y + d3.h * 0.8));
  await P.wait(6000);
  await evSafe("Promise.race([__T.App.syncNow ? __T.App.syncNow() : null, new Promise(function(r){ setTimeout(r, 15000); })]).then(function(){ return 1; })");
  await P.wait(4000);
  const fin = await stLocal();
  const sa = await srvAnnos();
  const sp = (await P.srvPins()).filter((p) => String(p.id) === (fin && fin.pinId))[0];
  rec("final", { srvAnnos: sa, localAnnos: fin && fin.annos, srvLabel: sp && sp.label, localLabel: fin && fin.state });
  P.ok(afterLabel && afterLabel.draft === LBL && afterLabel.bundle === LBL, "[Y] R1 오프라인 라벨 수정 → draft·번들 스냅샷 반영", afterLabel);
  P.ok(afterReload && afterReload.state === LBL, "[Y] R1 오프라인 새로고침 후 라벨 유지", { want: LBL, got: afterReload && afterReload.state });
  P.ok(sp && sp.label === LBL, "[Y] R1 최종 서버 라벨 = 수정값", { want: LBL, got: sp && sp.label });
  P.ok(afterSync && afterSync.annos.indexOf(annA) >= 0 && afterSync.annos.indexOf(annB) >= 0, "[Y] R2 복귀 직후 화면 주석 A(오프라인)·B(동기화 중) 유실 0", afterSync && afterSync.annos);
  P.ok(sa.indexOf(annA) >= 0 && sa.indexOf(annB) >= 0, "[Y] R2 최종 서버 주석 A·B 존재", { srv: sa, annA, annB });
  saveReport();
}
