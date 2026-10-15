/** p151 CDP(라이브) — 원본 ↔ 벡터 복사 구역 핀 연동(WO 20261012-pinsync · 설계 .tmp/design-pinsync.md §6 라이브).
 *  실 Chrome(모바일 CDP) + 실 번들(P114_ROOT/dist) + 실 workerd(Miniflare) + 실 D1/R2 — p114 하니스 재사용. 목 0.
 *  실행: P114=1 P114_ROOT=<추출본> P114_OUT=p151cdp P114_EXPLORE=tests/p151-region-pin-alias-cdp.mjs \
 *        TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p114-mobile-field-flow.test.mjs
 *  L1 원본에 핀 → 구역 열기 → 그 핀이 보인다(화면 마커) + 같은 번호(data-no)
 *  L2 구역에서 핀 탭 → 자동저장 → 원본 행(D1 DB)에 역변환 좌표로 저장 · 원본 다시 열면 상자 안에 보인다
 *  L3 오프라인 구역 핀 탭 → 온라인 복귀 → 원본 반영(OpLog → /ops 역변환)
 *  L4 자기 핀이 있는 구역(pending) = 하단 안내 바 + 글자 대비 ≥ 4.5:1
 */
const MLIB = String.raw`(function(){
  if (window.__M) return;
  var M = window.__M = {};
  M.visible = function(el){ if (!el) return false; var r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; var cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05; };
  M.mv = function(){ return document.getElementById('map-viewport'); };
  M.mapRect = function(){ var a = document.getElementById('map-area'); var e = (a && a.getBoundingClientRect().width > 0 ? a : M.mv()); if (!e) return null; var r = e.getBoundingClientRect(); return { x: Math.max(0, r.left), y: Math.max(0, r.top), r: Math.min(innerWidth, r.right), b: Math.min(innerHeight, r.bottom) }; };
  M.drawingRect = function(){ var c = [document.getElementById('map-image'), document.getElementById('pdf-canvas')].filter(function(e){ return e && M.visible(e); })[0]; if (!c) return null; var r = c.getBoundingClientRect(), R = M.mapRect(); if (!R) return null; var x = Math.max(r.left, R.x), y = Math.max(r.top, R.y), rr = Math.min(r.right, R.r), b = Math.min(r.bottom, R.b); return { x: x, y: y, w: rr - x, h: b - y }; };
  M.center = function(sel){ var e = document.querySelector(sel); if (!e || !M.visible(e)) return null; var r = e.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; };
  M.lum = function(c){ var m = String(c).match(/[\d.]+/g); if (!m) return null; var a = m.slice(0,3).map(function(v){ v = +v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126*a[0] + 0.7152*a[1] + 0.0722*a[2]; };
  M.contrast = function(el){ var cs = getComputedStyle(el); var bgEl = el, bg = cs.backgroundColor; while (bgEl && (/rgba\(.*, 0\)$/.test(bg) || bg === 'transparent')) { bgEl = bgEl.parentElement; bg = bgEl ? getComputedStyle(bgEl).backgroundColor : 'rgb(255,255,255)'; } var L1 = M.lum(cs.color), L2 = M.lum(bg); var hi = Math.max(L1, L2), lo = Math.min(L1, L2); return { fg: cs.color, bg: bg, ratio: (hi + 0.05) / (lo + 0.05) }; };
})();`;

export default async function explore(P) {
  const { ev, evSafe, send, BASE, TOKEN, tap, waitFor, loads, report, saveReport } = P;
  const J = (o) => JSON.stringify(o);
  const X = (report.p151 = { steps: [] });
  const rec = (n, d) => { X.steps.push({ n, d }); console.log("[L] " + n + " " + J(d)); };
  const tapSel = async (sel) => { const c = await evSafe(`__M.center(${J(sel)})`); if (!c || !c.x) return null; await tap(c.x, c.y); return c; };
  const drawn = "window.__M && __M.drawingRect() && ((document.getElementById('map-image')||{}).complete !== false)";
  const D0 = P.DEP_ID;
  const BOX = { x: 20, y: 20, w: 40, h: 30 };
  const toBase = (x, y) => ({ x: BOX.x + x / 100 * BOX.w, y: BOX.y + y / 100 * BOX.h });
  const d0Pins = async () => JSON.parse(((await P.db.prepare("SELECT pins FROM deployments WHERE id = ?").bind(D0).first()) || {}).pins || "[]").filter((p) => p && !p._deleted);

  /* 시드 — 원본 핀 5개(상자 안 2 · 밖 3) + 벡터 복사 구역(핀 0 → 연동) + 자기 핀 있는 구역(pending) */
  const srv = await P.srvDep();
  const PINS0 = [
    { id: "o3", x: 70, y: 10, page: 1, label: "P-X" },
    { id: "a", x: 30, y: 30, page: 1, label: "P-A" },
    { id: "o1", x: 5, y: 5, page: 1, label: "1", checkboard: true },
    { id: "b", x: 50, y: 45, page: 1, label: "3", checkboard: true },
    { id: "o2", x: 80, y: 80, page: 1, label: "5", checkboard: true },
  ];
  const pv = await P.api("PATCH", "/tables/deployments/" + D0, { base_version: srv.version, pins: J(PINS0) });
  const r1 = await P.api("POST", "/tables/deployments", { title: "ER", file_name: "ER.pdf", project_id: P.PRJ, pages_data: srv.pages_data, drawing_data: srv.drawing_data });
  const D1 = r1.j && r1.j.id;
  const k1 = await P.api("POST", "/api/projects/" + P.PRJ + "/decks", { name: "ER", page: 1, crop: null, deployment_id: D1, src_dep_id: D0, src_page: 1, src_crop: BOX });
  const r2 = await P.api("POST", "/tables/deployments", { title: "OLD", file_name: "OLD.pdf", project_id: P.PRJ, pages_data: srv.pages_data, drawing_data: srv.drawing_data, pins: J([{ id: "own1", x: 50, y: 50, page: 1, label: "2", checkboard: true }]) });
  const D2 = r2.j && r2.j.id;
  const k2 = await P.api("POST", "/api/projects/" + P.PRJ + "/decks", { name: "OLD", page: 1, crop: null, deployment_id: D2, src_dep_id: D0, src_page: 1, src_crop: { x: 60, y: 60, w: 30, h: 30 } });
  rec("seed", { pv: pv.status, D1, deck1: k1.status, D2, deck2: k2.status });
  P.ok(pv.status === 200 && !!D1 && k1.status === 200 && !!D2 && k2.status === 200, "[L] 시드 — 원본 핀 5 · 연동 구역 · pending 구역");

  /* 콜드 로드 → 도면 열기(설계 모드) */
  await send("Page.addScriptToEvaluateOnNewDocument", { source: MLIB });
  await send("Page.navigate", { url: BASE + "/manifest.webmanifest" });
  await waitFor("location.pathname === '/manifest.webmanifest'", 60000);
  await ev(`localStorage.setItem("wm_local_token", ${J(TOKEN)}); 1`);
  const n0 = loads.length, t0 = Date.now();
  await send("Page.navigate", { url: BASE + "/" });
  while (loads.length === n0 && Date.now() - t0 < 120000) await P.wait(100);
  await waitFor("document.querySelector('[data-act=mode-open][data-mode-reg=checkboard]')", 90000);
  await P.wait(1500);
  await evSafe("(function(){var e=document.querySelector('[data-act=mode-open][data-mode-reg=checkboard]'); e&&e.scrollIntoView({block:'center'}); return 1;})()");
  await P.wait(400);
  await tapSel("[data-act=mode-open][data-mode-reg=checkboard]");
  await waitFor(drawn, 120000);
  await P.wait(1500);

  const open = async (depId) => {
    await evSafe(`(async function(){ await __T.App.loadDeckDrawing(${J(depId)}); return 1; })()`);
    await waitFor(drawn, 60000);
    await P.wait(1200);
  };
  const markers = () => evSafe("Array.from(document.querySelectorAll('.pin-marker[data-id]')).map(function(m){ return { id: m.dataset.id, no: m.dataset.no }; })");

  /* L1 — 원본 번호 → 구역에서 같은 번호. 화면 마커 = 현재 모드(CHECKER) 핀만 그려진다 → 체크 핀 b 는 마커 data-no,
   *       360 핀 a(비숫자 라벨 = 순번)는 화면이 쓰는 번호 SoT(PinSeries.numbers(State.pins) — 기본값 경로)로 대조 */
  const nosNow = "(function(){ var m = __T.PinSeries.numbers(__T.State.pins, 1); var g = function(id){ var v = m.get(id); return v ? v.no : null; }; return { a: g('a'), b: g('b') }; })()";
  await open(D0);
  const mo = await markers(), no0 = await evSafe(nosNow);
  await open(D1);
  const mr = await markers(), no1 = await evSafe(nosNow);
  const st1 = await evSafe("({ ids: __T.State.pins.map(function(p){ return String(p.id); }), base: (__T.State.basePins || []).length, ver: __T.State.depVersion })");
  rec("L1", { orig: mo, region: mr, no0, no1, st1 });
  const no = (arr, id) => (arr.find((m) => m.id === id) || {}).no;
  P.ok(st1 && st1.ids.join(",") === "a,b" && st1.base === 5, "[L1] 구역 열기 → 원본 상자 안 핀 a,b 가 화면 상태에 · 번호 기준 5", st1);
  // [WO 20261015-numunify 계약 변경] 모드가 가시성을 잠그지 않는다 — 구역 화면(CHECKER 모드)에 상자 안 핀 a(360)·b(체커) 둘 다 보인다.
  //   전·후 대조: 종전 mr = [b] 1개(360 핀 a 숨김) → 새 mr = [a, b] 2개 · 원본과 같은 번호 · 상자 밖 o1 은 여전히 0.
  P.ok(mr.length === 2 && no(mr, "a") === no(mo, "a") && no(mr, "b") != null && no(mr, "b") === no(mo, "b") && !mr.some((m) => m.id === "o1"), "[L1] 구역 화면 마커 = 상자 안 a·b 2개(모드 무관) · 같은 번호(a " + no(mo, "a") + "/" + no(mr, "a") + " · b " + no(mo, "b") + "/" + no(mr, "b") + ")");
  P.ok(no0 && no1 && no0.a === 2 && no1.a === no0.a && no1.b === no0.b, "[L1] 360 핀 a 번호 원본 " + (no0 && no0.a) + " == 구역 " + (no1 && no1.a));

  /* L2 — 구역에서 핀 탭 → 원본에 역변환 저장 → 원본 화면에 보임 */
  if (!(await evSafe("!!__T.State.placing"))) { await tapSel("#mobile-dock [data-act=place]"); await P.wait(800); }
  const dr = await evSafe("__M.drawingRect()");
  const before = (await d0Pins()).map((p) => String(p.id));
  await tap(Math.round(dr.x + dr.w * 0.5), Math.round(dr.y + dr.h * 0.5));
  let added = null;
  for (let i = 0; i < 60 && !added; i++) { added = (await d0Pins()).find((p) => !before.includes(String(p.id))) || null; if (!added) await P.wait(500); }
  const regionNew = added && await evSafe(`(function(){ var p = __T.State.pins.filter(function(q){ return String(q.id) === ${J(String(added && added.id))}; })[0]; return p ? { x: p.x, y: p.y } : null; })()`);
  const want = regionNew && toBase(regionNew.x, regionNew.y);
  const d1row = await P.db.prepare("SELECT pins FROM deployments WHERE id = ?").bind(D1).first();
  rec("L2", { added, regionNew, want, d1pins: d1row && d1row.pins });
  P.ok(!!added && !!want && Math.abs(added.x - want.x) < 1e-6 && Math.abs(added.y - want.y) < 1e-6 && d1row.pins === "[]", "[L2] 구역 탭 핀 → 원본 행에 역변환 좌표 저장 · 구역 행 pins 비저작", { added, want });
  await open(D0);
  const mo2 = await markers();
  P.ok(!!added && mo2.some((m) => m.id === String(added.id)), "[L2] 원본 다시 열기 → 구역에서 박은 핀이 보인다");

  /* L3 — 오프라인 구역 편집 → 온라인 복귀 → 원본 반영 */
  await open(D1);
  await P.setNet("offline");
  await P.wait(1200);
  if (!(await evSafe("!!__T.State.placing"))) { await tapSel("#mobile-dock [data-act=place]"); await P.wait(800); }
  const dr3 = await evSafe("__M.drawingRect()");
  const before3 = (await d0Pins()).map((p) => String(p.id));
  await tap(Math.round(dr3.x + dr3.w * 0.3), Math.round(dr3.y + dr3.h * 0.7));
  await P.wait(2500);
  const off = await evSafe(`__T.SyncQueue.loadDraft('oplog:' + ${J(D1)}).then(function(o){ return (o || []).length; })`);
  await P.setNet("fast3g");
  await P.wait(1000);
  await evSafe("(async function(){ try { if (__T.App._flushOpLogs) await __T.App._flushOpLogs(); } catch (e) {} return 1; })()");
  let added3 = null;
  for (let i = 0; i < 80 && !added3; i++) { added3 = (await d0Pins()).find((p) => !before3.includes(String(p.id))) || null; if (!added3) await P.wait(500); }
  rec("L3", { oplog: off, added3 });
  P.ok(off >= 1 && !!added3 && added3.x >= BOX.x && added3.x <= BOX.x + BOX.w && added3.y >= BOX.y && added3.y <= BOX.y + BOX.h, "[L3] 오프라인 구역 핀 → 복귀 후 원본 상자 안에 반영(oplog " + off + ")", added3);

  /* L4 — pending 구역 안내 바 + 대비 */
  await open(D2);
  await P.wait(800);
  const bar = await evSafe("(function(){ var b = document.getElementById('pin-alias-bar'); if (!b || !__M.visible(b)) return null; var m = b.querySelector('.pin-alias-msg'), k = b.querySelector('.pin-alias-merge'); var d = document.getElementById('mobile-dock'), br = b.getBoundingClientRect(), dr = d && d.getBoundingClientRect(); return { text: m && m.textContent, msg: m && __M.contrast(m), btn: k && __M.contrast(k), overDock: !!(dr && dr.height > 0 && br.bottom > dr.top + 0.5) }; })()");
  rec("L4", bar);
  P.ok(!!bar && /핀 1개/.test(bar.text || "") && bar.msg && bar.msg.ratio >= 4.5 && bar.btn && bar.btn.ratio >= 4.5 && !bar.overDock, "[L4] 자기 핀 있는 구역 = 하단 [원본과 합치기] 안내(도크 겹침 0) · 대비 msg " + (bar && bar.msg && bar.msg.ratio.toFixed(2)) + " btn " + (bar && bar.btn && bar.btn.ratio.toFixed(2)), bar);
  try { await P.shot("p151-L4-banner"); } catch (e) {}
  saveReport();
}
