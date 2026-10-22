/**
 * p172 CDP — 핀 "실제 화면 px" 실측 (WO pinpx · 목 0, p114 하니스 재사용: 실 번들 + 실 워커 + D1/R2 + 실 Chrome).
 *
 * [재현] HEAD ae36a91: #pins-layer 는 #map-transform(scale(State.zoom)) 의 자손인데 pinScreenScale() 이
 *   "화면 배율"을 그대로 --pin-scale 로 넣어, 실제 화면 px = zoom × pinScreenScale() × 40 (zoom 이 한 번 더 곱해짐).
 *   큰 PDF(ga.pdf, fitZoom≈0.09) 맞춤 상태에서 머리 svg 높이 ≈ 2.5px(사양 30px).
 *
 * 측정 = `.pin-marker` 머리 svg 의 getBoundingClientRect().height (상위 transform 전부 포함, 브라우저 레이아웃 그대로).
 * 사양(마스터 확정, 데스크톱 마우스 1280×800):
 *   맞춤 ≈ 30px · 확대 비례 → 상한 56px · 축소 비례 → 하한 8px · 16px 미만이면 번호 숨김(auto) ·
 *   탭 패드 44px(머리 위 12px 지점도 그 핀) · 리더 풍선/머리 비 = 22/40 · 동선/주석 선 맞춤 ≈ 1.5px(상한 3px).
 * 경우: 보통 도면(시드 PNG 2400px) · 큰 PDF(.tmp/ga.pdf, fitZoom < 0.15) × 원본 · 구역(크롭 창).
 *
 * 실행: P172=1 [P172_ROOT=<assemble+stamp+vite build 된 추출본>] [P172_SHOT=.tmp/pinpx-after.png]
 *       TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p172-pin-screen-px-cdp.mjs      (P172!=1 → SKIP)
 * 뮤테이션(페이지 안에서 MapCtrl 수정분을 되돌림 — 반드시 EXIT=1):
 *   P172_MUT=nocancel → pinScreenScale 의 상위 scale(zoom) 상쇄 제거
 *   P172_MUT=nofloor  → pinScreenPx 하한(Math.max) 제거
 *   P172_MUT=noceil   → pinScreenPx 상한(Math.min) 제거
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), "..");

if (!globalThis.__P114) {
  if (process.env.P172 !== "1") { console.log("[SKIP] p172-cdp 는 P172=1 일 때만 실행"); process.exit(0); }
  const env = Object.assign({}, process.env, { P114: "1", P114_ROOT: process.env.P172_ROOT || ".", P114_EXPLORE: SELF, P114_OUT: "p172" + (process.env.P172_MUT ? "-mut-" + process.env.P172_MUT : "") });
  const r = spawnSync(process.execPath, [path.join(ROOT, "tests", "p114-mobile-field-flow.test.mjs")], { env, stdio: "inherit", cwd: ROOT });
  console.log("[p172-cdp] EXIT=" + r.status);
  process.exit(r.status === 0 ? 0 : (r.status || 1));
}

/** 페이지 안 측정 — 머리 svg 높이(상위 transform 포함 실제 화면 px)·번호 표시·탭 패드·풍선·선 두께. */
const PROBE = String.raw`(function(){
  if (window.__P172) return;
  var P = window.__P172 = {};
  P.heads = function(){
    return Array.from(document.querySelectorAll('#pins-layer > .pin-marker')).filter(function(m){ return m.style.display !== 'none'; }).map(function(m){
      var svg = m.querySelector('.pin-pin svg') || m.querySelector('svg');
      var r = svg.getBoundingClientRect();
      var t = m.querySelector('.pin-num-text');
      return { id: m.dataset.id, h: Math.round(r.height * 100) / 100, top: r.top, cx: r.left + r.width / 2, num: t ? getComputedStyle(t).display : null };
    });
  };
  P.tapAbove = function(dy){
    var m = Array.from(document.querySelectorAll('#pins-layer > .pin-marker')).filter(function(x){ return x.style.display !== 'none'; })[0];
    if (!m) return null;
    var r = (m.querySelector('.pin-pin svg') || m).getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top - dy;
    var h = document.elementFromPoint(x, y);
    var hm = h && h.closest ? h.closest('.pin-marker') : null;
    return { x: Math.round(x), y: Math.round(y), hit: hm === m, anyPin: !!hm, el: h ? (h.id || String(h.getAttribute('class') || h.tagName).slice(0, 40)) : null };
  };
  P.bubble = function(){ var b = document.querySelector('#pins-layer > .pin-leader-bubble'); if (!b) return null; var r = b.getBoundingClientRect(); return Math.round(r.height * 100) / 100; };
  /** 선 두께(화면 px) = computed stroke-width(SVG user unit) × 화면 CTM 배율(기하평균 — viewBox preserveAspectRatio=none 은 축마다 다름). */
  P.line = function(svgId, cls){
    var svg = document.getElementById(svgId); if (!svg) return null;
    var el = svg.querySelector('.p172-probe.' + cls);
    if (!el) { el = document.createElementNS('http://www.w3.org/2000/svg', svgId === 'routes-svg' ? 'polyline' : 'path'); el.setAttribute('class', 'p172-probe ' + cls); if (svgId === 'routes-svg') el.setAttribute('points', '40,40 60,40'); else el.setAttribute('d', 'M 400 400 L 600 400'); svg.appendChild(el); }
    var sw = parseFloat(getComputedStyle(el).strokeWidth);
    var m = el.getScreenCTM(); if (!m) return null;
    var k = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
    return Math.round(sw * k * 100) / 100;
  };
  P.state = function(){ var L = document.getElementById('pins-layer'); return { zoom: __T.State.zoom, fitZoom: __T.MapCtrl.computeFitZoom(), pinScale: L.style.getPropertyValue('--pin-scale'), numOff: L.classList.contains('pin-num-off') }; };
})();`;

export default async function (P) {
  const { ev, evSafe, send, BASE, TOKEN, waitFor, wait, ok } = P;
  const J = (o) => JSON.stringify(o);
  const MUT = process.env.P172_MUT || "";
  const R = { mut: MUT, cases: {} };
  const rec = (k, v) => { console.log("[R] " + k + " " + J(v).slice(0, 900)); return v; };
  const settle = async (ms = 700) => { await wait(ms); await evSafe("document.getAnimations && document.getAnimations().forEach(function(a){ try { a.finish(); } catch (e) {} }); 1"); await wait(120); };

  // 데스크톱 1280×800 마우스(하한 = PIN_MIN_PX_MOUSE 8px)
  await send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, screenWidth: 1280, screenHeight: 800 });
  await send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36", platform: "Win32" });
  await send("Page.navigate", { url: BASE + "/manifest.webmanifest" });
  await waitFor("location.pathname === '/manifest.webmanifest'", 60000);
  await ev(`localStorage.setItem("wm_local_token", ${J(TOKEN)}); 1`);
  await send("Page.navigate", { url: BASE + "/" });
  await waitFor("navigator.serviceWorker && navigator.serviceWorker.controller", 60000);
  await wait(3500);
  await waitFor("document.querySelector('.hub-tree-deck[data-act=deck-open]')", 60000);
  await ev(PROBE);
  await evSafe("(function(){ var e=document.querySelector('.hub-tree-deck[data-act=deck-open]'); e && e.scrollIntoView({block:'center'}); e && e.click(); return 1; })()");
  const drawn = "window.__T && [document.getElementById('map-image'),document.getElementById('pdf-canvas')].some(function(e){ return e && !e.classList.contains('hidden') && e.getBoundingClientRect().width > 0 && e.complete !== false; })";
  ok((await waitFor(drawn, 90000)) >= 0, "디자이너 화면 + 시드 도면 표시");
  await settle(2500);
  await evSafe("__T.State.placing && __T.App._togglePlacing && __T.App._togglePlacing(); 1");
  await ev(PROBE);

  // 뮤테이션 — 수정분(MapCtrl)을 페이지 안에서 구 동작으로 되돌린다. 대상 문자열이 없으면 EXIT=2(가짜 통과 차단).
  if (MUT) {
    const MUTS = {
      nocancel: ["pinScreenScale", "/ this.parentScale()", ""],
      nofloor: ["pinScreenPx", "Math.max(raw, minPx)", "raw"],
      noceil: ["pinScreenPx", "Math.min(px, this.PIN_MAX_PX)", "px"],
    };
    const m = MUTS[MUT];
    if (!m) { console.log("알 수 없는 뮤테이션 " + MUT); process.exit(2); }
    const res = await ev(`(function(){ var MC = __T.MapCtrl; var src = String(MC[${J(m[0])}]); if (src.indexOf(${J(m[1])}) < 0) return 'MISSING';
      var body = src.slice(src.indexOf('{')); body = body.replace(${J(m[1])}, ${J(m[2])}).replace(/\bState\./g, '__T.State.');
      MC[${J(m[0])}] = new Function('return function ' + ${J(m[0])} + '(' + src.slice(src.indexOf('(') + 1, src.indexOf(')')) + ') ' + body)();
      MC.applyTransform(); return 'OK'; })()`);
    if (res !== "OK") { console.log("  FAIL 뮤테이션 대상 문자열 없음: " + MUT + " → " + res); process.exit(2); }
    rec("mutation", { MUT, res });
  }

  // 핀 3개(머리) + 리더 핀 1개(풍선) — 앱 렌더 함수(UI.renderPinsOnMap) 그대로
  const seedPins = async () => {
    await ev(`(function(){ var S = __T.State; var pg = S.pdfPage || 1;
      S.pins = [
        { id: "p172a", x: 44, y: 46, page: pg, label: "1", checkboard: true },
        { id: "p172b", x: 50, y: 50, page: pg, label: "2", checkboard: true },
        { id: "p172c", x: 56, y: 54, page: pg, label: "3", checkboard: true },
        { id: "p172d", x: 30, y: 60, page: pg, label: "4", checkboard: true, leader: true, callout: { x: 36, y: 56 } }
      ];
      __T.UI.renderPinsOnMap();
      // [WO 20261022-pindots] teardrop 공식(pinScreenPx) 측정 범위 — 점(dot) 기본표시는 별도(p177).
      // 평면 기본이 점으로 바뀌어도 이 테스트는 teardrop 을 그대로 측정하도록 고정한다(회귀 0).
      // 🔴 .focused 클래스가 아니라 테스트 전용 .force-pin — .pin-marker-teardrop.focused
      // .pin-pin{transform:scale(1.25)}(선택 강조, 기존 규칙)까지 같이 걸려 측정값이 25% 부푼다
      // (tests/_lib/real-map-page.mjs 주석 참조 — 같은 함정, p159 실측으로 확인).
      Array.prototype.forEach.call(document.querySelectorAll('#pins-layer > .pin-marker'), function(m){ m.classList.add("force-pin"); });
      __T.MapCtrl.applyTransform(); return S.pins.length; })()`);
  };
  const at = async (z) => { await ev(`(function(){ __T.State.zoom = ${z}; __T.MapCtrl.applyTransform(); return 1; })()`); await settle(150); };
  const snap = async () => ({ st: await ev("__P172.state()"), heads: await ev("__P172.heads()"), bubble: await ev("__P172.bubble()"), route: await ev("__P172.line('routes-svg','route-line-halo')"), anno: await ev("__P172.line('anno-svg','anno-pen-line')") });
  const near = (a, b, t) => Math.abs(a - b) <= t;
  const hRange = (s) => { const hs = s.heads.map((h) => h.h); return { min: Math.min(...hs), max: Math.max(...hs), n: hs.length }; };

  /** 한 화면(원본 또는 구역)의 맞춤·배율별 실측 + 단언. zone=true 면 경계(cover) 아래 축소는 불가(앱 사양) → 확대만 단언. */
  const measure = async (tag, zone) => {
    await seedPins();
    await settle(400);
    const fitZ = await ev("__T.State.zoom");
    const C = (R.cases[tag] = { fitZ });
    const factors = zone ? [1, 2, 4] : [1, 2, 4, 0.5, 0.25, 0.1];
    for (const f of factors) {
      await at(fitZ * f);
      const s = await snap();
      if (f === 1 || f === 0.1) s.tap = await ev("__P172.tapAbove(12)");
      C["x" + f] = s;
      rec(tag + " x" + f, { zoom: s.st.zoom, fitZoom: s.st.fitZoom, pinScale: s.st.pinScale, head: hRange(s), numOff: s.st.numOff, bubble: s.bubble, route: s.route, anno: s.anno, tap: s.tap });
    }
    const H = (f) => C["x" + f] && hRange(C["x" + f]);
    ok(H(1).n === 3, `[${tag}] 머리 핀 3개 표시`, H(1));
    ok(H(1).min >= 27 && H(1).max <= 33, `[${tag}] 맞춤 머리 높이 ≈ 30px (실측 ${H(1).min}~${H(1).max})`, H(1));
    ok(C.x1.st.numOff === false && C.x1.heads.every((h) => h.num !== "none"), `[${tag}] 맞춤 = 번호 표시`, C.x1.st);
    ok(near(H(2).max, 56, 1), `[${tag}] 2배 확대 머리 = 상한 56px (실측 ${H(2).max})`, H(2));
    ok(near(H(4).max, 56, 1), `[${tag}] 4배 확대 머리 = 상한 56px (실측 ${H(4) && H(4).max})`, H(4));
    if (C.x1.bubble) ok(near(C.x1.bubble / H(1).max, 22 / 40, 0.06), `[${tag}] 리더 풍선/머리 = 22/40 (실측 ${C.x1.bubble}/${H(1).max})`, C.x1.bubble);
    if (C.x1.route != null) ok(near(C.x1.route, 1.5, 0.35), `[${tag}] 동선(halo 3px) 맞춤 ≈ 1.5px (실측 ${C.x1.route})`, C.x1.route);
    if (C.x1.anno != null) ok(near(C.x1.anno, 1.5, 0.35), `[${tag}] 주석 펜(3px) 맞춤 ≈ 1.5px (실측 ${C.x1.anno})`, C.x1.anno);
    if (C.x4.route != null) ok(near(C.x4.route, 3, 0.35), `[${tag}] 동선 4배 = 상한 3px (실측 ${C.x4.route})`, C.x4.route);
    ok(C.x1.tap && C.x1.tap.hit, `[${tag}] 맞춤 머리 위 12px 탭 = 그 핀`, C.x1.tap);
    if (!zone) {
      ok(near(H(0.5).max, H(1).max * 0.5, Math.max(0.6, H(1).max * 0.06)), `[${tag}] 0.5배 축소 = 맞춤의 절반 (실측 ${H(0.5).max})`, H(0.5));
      ok(C["x0.5"].st.numOff === true && C["x0.5"].heads.every((h) => h.num === "none"), `[${tag}] 16px 미만(0.5배) = 번호 숨김(auto)`, C["x0.5"].st);
      ok(H(0.1).min >= 7.5 && H(0.1).max <= 8.5, `[${tag}] 0.1배 축소 = 하한 8px (실측 ${H(0.1).min}~${H(0.1).max})`, H(0.1));
      ok(C["x0.1"].tap && C["x0.1"].tap.anyPin, `[${tag}] 하한(8px) 머리 위 12px 탭 = 핀(탭 패드 44px · 0.1배에선 핀 3개가 겹쳐 어느 핀이든)`, C["x0.1"].tap);
    }
    await at(fitZ);
    return C;
  };

  const zoneOpen = async () => {
    await ev(`(function(){ var c = { x: 30, y: 30, w: 40, h: 40 }; __T.MapCtrl.setCropBoundary(c, 1); __T.MapCtrl.fitZone(c, 0.14, 640); return 1; })()`);
    await settle(1200);
  };
  const zoneClose = async () => { await ev("(function(){ __T.MapCtrl.setCropBoundary(null); __T.MapCtrl.fit(); return 1; })()"); await settle(1200); };

  // ── 1) 보통 도면(시드 PNG) ──
  await ev("__T.MapCtrl.fit(); 1"); await settle(1200);
  await measure("png-original", false);
  await zoneOpen(); await measure("png-zone", true); await zoneClose();

  // ── 2) 큰 PDF(.tmp/ga.pdf) — 앱 도면 등록 진입점(App._loadDrawing) 그대로 ──
  const pdfB64 = fs.readFileSync(path.join(ROOT, ".tmp", "ga.pdf")).toString("base64");
  await ev(`(function(){ var b = atob(${J(pdfB64)}); var u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    __T.App._drawingTarget = { kind: "main", depId: __T.State.currentDeploymentId }; // [메인 도면 교체] 진입점과 같은 대상 지정(registerDrawingFor)
    window.__P172pdf = __T.App._loadDrawing(new File([u], "GA-big.pdf", { type: "application/pdf" })); return 1; })()`);
  const pdfShown = await waitFor("__T.State.pdfDoc && !document.getElementById('pdf-canvas').classList.contains('hidden') && document.getElementById('pdf-canvas').getBoundingClientRect().width > 0", 90000);
  ok(pdfShown >= 0, "큰 PDF(ga.pdf) 등록·표시");
  await settle(2500);
  await ev(PROBE);
  await ev("__T.MapCtrl.fit(); 1"); await settle(1500);
  const fz = await ev("__T.State.zoom");
  ok(fz > 0 && fz < 0.15, `큰 PDF 맞춤 fitZoom < 0.15 (실측 ${fz})`, fz);
  await measure("pdf-original", false);
  if (process.env.P172_SHOT) {
    await settle(300);
    const s = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.resolve(ROOT, process.env.P172_SHOT), Buffer.from(s.data, "base64"));
    rec("shot", { file: process.env.P172_SHOT });
  }
  // ISO 빌보드 — 맞춤 상태에서 기울여도 머리가 보이는 크기(기록 + 하한 단언)
  await ev("(function(){ __T.State.isoView = true; __T.MapCtrl.applyTransform(); return 1; })()"); await settle(1300);
  const iso = rec("pdf-iso x1", { heads: hRange({ heads: await ev("__P172.heads()") }) });
  ok(iso.heads.min >= 16, `[pdf-iso] ISO 맞춤 머리 ≥ 16px (실측 ${iso.heads.min}~${iso.heads.max})`, iso);
  await ev("(function(){ __T.State.isoView = false; __T.MapCtrl.applyTransform(); return 1; })()"); await settle(1300);
  await zoneOpen(); await measure("pdf-zone", true); await zoneClose();

  fs.mkdirSync(P.OUT, { recursive: true });
  fs.writeFileSync(path.join(P.OUT, "p172-report.json"), JSON.stringify(R, null, 1));
}
