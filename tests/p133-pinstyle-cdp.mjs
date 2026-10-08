/**
 * p133-cdp — WO 20261008-pinstyle 실 Chrome 실측(목 0, p114 하니스 재사용: 실 워커+D1+R2+실도면 ga.pdf).
 *   R5/R4: 360 진입(허브 잎) → 도면 탭 = 파일 선택창 · 360 세그먼트 → [포인트] → 탭 = 파일 선택창 ·
 *          CHECKER 배너 문구 · CHECKER 핀 팝업 사진 섹션 없음(의도)
 *   R1: 기본 핀만(리더 0) · 핀별 리더선 → 마커 숨김 + 리더 1
 *   R3: 리더선 핀 화살촉/풍선 화면 비율 — 맞춤(fit)·400%
 * 실행: P133=1 [P133_ROOT=.tmp/hfPS] TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p133-pinstyle-cdp.mjs   (P133!=1 → SKIP)
 *   375(모바일 터치) · 1280(데스크톱 마우스) 두 번 돈다. 스크린샷·리포트: .tmp/fixpinstyle/
 * 뮤테이션(페이지 안에서 수정분을 구 동작으로 되돌림 — 반드시 EXIT=1): P133_MUT=autotoggle|touchstart|dual|nofabcss|r7|r8css
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), "..");

if (!globalThis.__P114) {
  if (process.env.P133 !== "1") { console.log("[SKIP] p133-cdp 는 P133=1 일 때만 실행"); process.exit(0); }
  let failed = 0;
  for (const w of (process.env.P133_W ? process.env.P133_W.split(",") : ["375", "1280", "r7"])) {
    const env = Object.assign({}, process.env, { P114: "1", P114_ROOT: process.env.P133_ROOT || ".", P114_EXPLORE: SELF, FPS_W: (w === "375" || w === "r7") ? "" : w, FPS_R7: w === "r7" ? "1" : "", FPS_H: "800", FPS_TAG: "p133-" + w + (process.env.P133_MUT ? "-mut-" + process.env.P133_MUT : "") });
    const r = spawnSync(process.execPath, [path.join(ROOT, "tests", "p114-mobile-field-flow.test.mjs")], { env, stdio: "inherit", cwd: ROOT });
    console.log("[p133-cdp " + w + "] EXIT=" + r.status);
    if (r.status !== 0) failed++;
  }
  process.exit(failed ? 1 : 0);
}

export default async function (P) {
  const { ev, evSafe, send, BASE, TOKEN, tap, waitFor, wait, ok } = P;
  const OUTD = path.join(ROOT, ".tmp", "fixpinstyle");
  const TAG = process.env.FPS_TAG || "p133";
  fs.mkdirSync(OUTD, { recursive: true });
  const R = { tag: TAG, steps: [] };
  let n = 0;
  const shot = async (name) => { await evSafe("document.getAnimations && document.getAnimations().forEach(function(a){ try { a.finish(); } catch (e) {} }); 1"); const s = await send("Page.captureScreenshot", { format: "png" }); const f = path.join(OUTD, TAG + "-" + String(++n).padStart(2, "0") + "-" + name + ".png"); fs.writeFileSync(f, Buffer.from(s.data, "base64")); R.steps.push({ shot: path.basename(f) }); return path.basename(f); };
  const rec = (name, data) => { R.steps.push(Object.assign({ name }, data)); console.log("[R] " + name + " " + JSON.stringify(data).slice(0, 700)); return data; };
  const chooser = async (fn, ms = 2500) => { const p = P.onceEvent("Page.fileChooserOpened", ms).then(() => true, () => false); await fn(); return p; };
  const st = () => evSafe("({ regMode: __T.State.regMode, placing: !!__T.State.placing, pins: __T.State.pins.length, markersShown: Array.from(document.querySelectorAll('#pins-layer .pin-marker')).filter(function(m){ return m.style.display !== 'none' && m.getBoundingClientRect().width > 0; }).length, leaderG: document.querySelectorAll('#leader-layer .pin-leader-g').length, bubbles: document.querySelectorAll('#pins-layer .pin-leader-bubble').length, banner: ((document.querySelector('#crosshair-overlay .crosshair-msg')||{}).textContent||''), bannerVisible: (function(){ var o=document.getElementById('crosshair-overlay'); var m=document.querySelector('#crosshair-overlay .crosshair-msg'); if(!o||o.classList.contains('hidden')||!m) return false; var r=m.getBoundingClientRect(); return r.width>0 && r.left>=0 && r.right<=innerWidth; })() })");
  const center = (sel) => evSafe(`(function(){ var e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; var r=e.getBoundingClientRect(); var cs=getComputedStyle(e); var vis = r.width>0&&r.height>0&&cs.display!=='none'&&cs.visibility!=='hidden'; var x=r.left+r.width/2,y=r.top+r.height/2; var h=document.elementFromPoint(x,y); return { x:x, y:y, vis:vis, hitOk: !!h && (h===e||e.contains(h)) }; })()`);
  const drawPt = (fx, fy) => evSafe(`(function(){ var c=[document.getElementById('map-image'),document.getElementById('pdf-canvas')].filter(function(e){return e&&e.getBoundingClientRect().width>0;})[0]; var r=c.getBoundingClientRect(); var v=document.getElementById('map-viewport').getBoundingClientRect(); var x0=Math.max(r.left,v.left), y0=Math.max(r.top,v.top), x1=Math.min(r.right,v.right), y1=Math.min(r.bottom,v.bottom); return { x: x0+(x1-x0)*${fx}, y: y0+(y1-y0)*${fy} }; })()`);
  const pap = () => evSafe(`(function(){ var el=document.getElementById('pin-action-pop'); if(!el) return null; var open = !el.classList.contains('hidden') && el.getBoundingClientRect().height>0; var b=document.getElementById('pap-bottom'); var regs=Array.from(el.querySelectorAll('.pap-reg-btn')).filter(function(x){return x.getBoundingClientRect().width>0;}).map(function(x){return x.dataset.reg;}); return { open: open, bottomVisible: !!(b && b.getBoundingClientRect().height>0), regBtns: regs }; })()`);
  const closePap = () => evSafe("(function(){ var c=document.getElementById('pap-close')||document.querySelector('#pin-action-pop [data-act=close]'); c&&c.click(); return 1; })()");

  await send("Emulation.setCPUThrottlingRate", { rate: 1 });
  const DESK = !!process.env.FPS_W && +process.env.FPS_W >= 760;
  if (DESK) {
    const w = +process.env.FPS_W, h = +(process.env.FPS_H || 800);
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false, screenWidth: w, screenHeight: h });
    await send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36", platform: "Win32" });
  }
  const click = async (x, y) => {
    if (!DESK) return tap(x, y);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  const clickSel = async (sel) => { const c = await center(sel); if (!c || !c.vis) return { missing: true }; await click(c.x, c.y); return c; };
  const PT = DESK ? "#btn-quickpoint" : '#mobile-dock [data-act="place"]';

  const MUT = process.env.P133_MUT || "";
  if (process.env.FPS_R7) return r7Scenario();
  await send("Page.navigate", { url: BASE + "/manifest.webmanifest" });
  await waitFor("location.pathname === '/manifest.webmanifest'", 60000);
  await ev(`localStorage.setItem("wm_local_token", ${JSON.stringify(TOKEN)}); 1`);
  await send("Page.navigate", { url: BASE + "/" });
  await waitFor("navigator.serviceWorker && navigator.serviceWorker.controller", 60000);
  await wait(3500); // SW 첫 설치 controllerchange 새로고침 대기
  await waitFor("document.querySelector('[data-act=mode-open][data-mode-reg=photo]')", 60000);
  // 뮤테이션 — 수정분을 페이지 안에서 구 동작으로 되돌린다(단언이 진짜 결함을 잡는지)
  const applyMut = async () => {
    if (MUT === "autotoggle") await ev("__T.App._onPlaceButton = function(){ return this._togglePlacing(); }; __T.App._autoStartPlacing = function(){}; 1");
    if (MUT === "touchstart") await ev("__T.App._placeTouchStart = function(e){ e.preventDefault(); var t=e.touches[0]; this._handlePlaceClick({ clientX: t.clientX, clientY: t.clientY }); }; __T.App._placeTouchEnd = function(){ return false; }; 1");
    if (MUT === "nofabcss") await ev("(function(){ var s=document.createElement('style'); s.textContent='html body:has(#screen-app.active):has(.tree-pop) [data-help-toggle], html body:has(#screen-app.active):has(.tree-pop) [data-help-inquiry-toggle] { bottom: calc(var(--pinfilter-bottom-mobile) + var(--pinfilter-h-mobile) + 8px) !important; }'; document.head.appendChild(s); return 1; })()");
    if (MUT === "dual") await ev("__T.UI.Leader.wants = function(p){ return !!p && (p.checkboard === true || p.leader === true); }; 1");
  };
  await applyMut();
  // 허브 잎(360)으로 진입 — 진입 자체는 측정 대상이 아니라 요소 click()(설치 배너 가림 회피)
  await evSafe("(function(){ var e=document.querySelector('[data-act=mode-open][data-mode-reg=photo]'); e && e.scrollIntoView({block:'center'}); e && e.click(); return 1; })()");
  await waitFor("window.__T && __T.State.regMode === 'photo' && [document.getElementById('map-image'),document.getElementById('pdf-canvas')].some(function(e){ return e && e.getBoundingClientRect().width > 0 && e.complete !== false; })", 90000);
  await wait(2500);
  const s0 = rec("enter-360-leaf", await st());
  ok(s0.placing === true, "[R5] 허브 잎(360) 진입 → 배치 시작", s0);
  let p = await drawPt(0.35, 0.4);
  let ch = await chooser(() => click(p.x, p.y)); await wait(600);
  rec("tap-after-enter", Object.assign({ chooser: ch }, await st()));
  ok(ch === true, "[R4] 360 진입 직후 도면 탭 → 사진 선택창 열림");
  await shot("360-after-enter-tap");
  // CHECKER 로 전환 → 핀 2개(기본 = 핀 1종)
  await clickSel("#btn-regmode-checkboard"); await wait(1200);
  for (const [fx, fy] of [[0.3, 0.3], [0.45, 0.6]]) { p = await drawPt(fx, fy); await click(p.x, p.y); await wait(500); }
  const sc = rec("checker-2pins", await st());
  ok(/CHECKER: 번호만 · 사진은 360 모드에서/.test(sc.banner) && sc.bannerVisible, "[R4] CHECKER 배치 배너 = 사진은 360 모드에서(화면 안)", sc);
  ok(sc.leaderG === 0 && sc.bubbles === 0, "[R1] CHECKER 기본 = 핀만(리더 0)", sc);
  // 배너가 다른 UI 에 가려지지 않는가(구역 페이저는 2.8s 뒤 사라지는 일시 팝업 — 그 뒤 실측)
  await wait(3500);
  const bh = await evSafe("(function(){ var m=document.querySelector('#crosshair-overlay .crosshair-msg'); var o=document.getElementById('crosshair-overlay'); var pe=[o.style.pointerEvents, m.style.pointerEvents]; o.style.pointerEvents='auto'; m.style.pointerEvents='auto'; var r=m.getBoundingClientRect(); var h=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); o.style.pointerEvents=pe[0]; m.style.pointerEvents=pe[1]; return { hitSelf: !!h && (h===m||m.contains(h)), hit: h && (h.id||String(h.className).slice(0,30)), rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)] }; })()");
  ok(bh && bh.hitSelf, "[R4] CHECKER 배너가 다른 요소에 가려지지 않음", bh);
  await shot("checker-default-pins");
  // CHECKER 핀 팝업 — 사진 등록 섹션 없음(의도, 마스터 2026-10-01)
  await evSafe("__T.State.placing && __T.App._togglePlacing(); 1"); await wait(300);
  const mk = await center("#pins-layer .pin-marker.pin-mode-checker");
  if (mk && mk.vis) { await click(mk.x, mk.y - 6); await wait(900); }
  const pc = rec("checker-popup", { pap: await pap() });
  ok(pc.pap && pc.pap.open && !pc.pap.bottomVisible, "[R4] CHECKER 핀 팝업 = 번호·위치만(사진 섹션 없음 — 의도)", pc);
  await closePap(); await wait(300);
  // 360 세그먼트 → [포인트] → 도면 탭 (0b4d262: placing=false, 선택창 0)
  await clickSel("#btn-regmode-photo"); await wait(1000);
  await clickSel(PT); await wait(500);
  const s5 = await st();
  p = await drawPt(0.7, 0.4);
  ch = await chooser(() => click(p.x, p.y)); await wait(600);
  rec("seg360-point-tap", Object.assign({ chooser: ch, before: s5 }, await st()));
  ok(s5.placing === true && ch === true, "[R5] 360 세그먼트 → [포인트] → 도면 탭 = 사진 선택창 열림", { s5, ch });
  const s5b = await st();
  ok(/^360:/.test(s5b.banner), "[R4] 360 배너 문구", s5b.banner);
  await shot("360-point-tap");
  // 360 핀 팝업 = 사진 등록 버튼 있음
  await evSafe("__T.State.placing && __T.App._togglePlacing(); 1"); await wait(300);
  const m3 = await center("#pins-layer .pin-marker.pin-mode-360");
  if (m3 && m3.vis) { await click(m3.x, m3.y - 6); await wait(900); }
  const p3 = rec("360-popup", { pap: await pap() });
  ok(p3.pap && p3.pap.open && p3.pap.regBtns.includes("photo") && p3.pap.regBtns.includes("theta"), "[R4] 360 핀 팝업 = [사진]·[360] 등록 버튼", p3);
  await closePap(); await wait(300);
  // R1/R3 — CHECKER 핀 하나를 리더선으로(핀별 선택) → 마커 숨김 + 리더 1, 화살촉/풍선 비율 fit·400%
  await clickSel("#btn-regmode-checkboard"); await wait(1000);
  await evSafe("__T.State.placing && __T.App._togglePlacing(); 1");
  await ev("(function(){ var c = __T.State.pins.filter(function(p){ return p.checkboard; })[0]; __T.UI.setPinsLeader([c], true); return 1; })()");
  await wait(400);
  const geom = () => evSafe(`(function(){ var c = __T.State.pins.filter(function(p){ return p.checkboard; })[0]; var id=String(c.id); var m=document.querySelector('#pins-layer .pin-marker[data-id="'+id+'"]'); var g=document.querySelector('#leader-layer .pin-leader-g[data-id="'+id+'"]'); var b=document.querySelector('#pins-layer .pin-leader-bubble[data-id="'+id+'"]'); var a=g&&g.querySelector('.pin-leader-arrow'); var ar=a&&a.getBoundingClientRect(), br=b&&b.getBoundingClientRect(); var pts = a ? a.points : null; var len=null; if (pts && pts.numberOfItems===3) { var ctm=a.getScreenCTM(); var P=function(i){ var q=pts.getItem(i).matrixTransform(ctm); return [q.x,q.y]; }; var t=P(0), b1=P(1), b2=P(2); len=Math.hypot((b1[0]+b2[0])/2-t[0], (b1[1]+b2[1])/2-t[1]); } return { zoom: __T.State.zoom, markerShown: !!m && m.style.display!=='none' && m.getBoundingClientRect().width>0, leaders: document.querySelectorAll('#leader-layer .pin-leader-g').length, arrowLen: len && +len.toFixed(2), arrowBox: ar ? [+ar.width.toFixed(1), +ar.height.toFixed(1)] : null, bubble: br ? +br.width.toFixed(2) : null, ratio: (len && br) ? +(len / br.width).toFixed(4) : null }; })()`);
  await evSafe("(function(){ var b=document.getElementById('tb-fit')||document.getElementById('btn-fit'); b && b.click(); return 1; })()"); await wait(700);
  const gFit = rec("leader-fit", await geom());
  await shot("leader-fit");
  await ev("(function(){ var M=__T.MapCtrl; var c = __T.State.pins.filter(function(p){ return p.checkboard; })[0]; if (M.flyTo) M.flyTo(c.x, c.y, 4); else { __T.State.zoom = 4; M.applyTransform(); } return 1; })()");
  await wait(1200);
  await ev("(function(){ if (Math.abs(__T.State.zoom - 4) > 0.01) { __T.State.zoom = 4; __T.MapCtrl.applyTransform(); } return 1; })()"); await wait(400);
  const g4 = rec("leader-400", await geom());
  await shot("leader-400");
  ok(gFit.leaders === 1 && gFit.markerShown === false, "[R1] 핀별 리더선 → 리더 1 + 그 핀 마커 숨김(두 표현 동시 0)", gFit);
  ok(gFit.ratio && g4.ratio && Math.abs(gFit.ratio - g4.ratio) < 0.02, "[R3] 화살촉/풍선 화면 비율 fit " + gFit.ratio + " vs 400% " + g4.ratio + " (줌 무관)", { gFit, g4 });
  /* ── R2 우클릭 = 앱 메뉴 · FAB 가림 ── */
  await evSafe("__T.MapCtrl.fit ? __T.MapCtrl.fit() : (document.getElementById('tb-fit')||{click(){}}).click(); 1"); await wait(600);
  await ev("window.__ctx = []; window.addEventListener('contextmenu', function(e){ window.__ctx.push({ tag: e.target && e.target.tagName, cls: String(e.target && e.target.className || '').slice(0, 40), prevented: e.defaultPrevented }); }); 1");
  const popInfo = () => evSafe(`(function(){ var p=document.querySelector('.tree-pop'); if(!p) return null; var r=p.getBoundingClientRect(); var items=Array.from(p.querySelectorAll('.tree-pop-item')); var cs=function(e){ return getComputedStyle(e); }; var lum=function(c){ var m=c.match(/\\d+(\\.\\d+)?/g).map(Number); var f=function(v){ v/=255; return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }; return 0.2126*f(m[0])+0.7152*f(m[1])+0.0722*f(m[2]); }; var ratio=function(a,b){ var x=lum(a), y=lum(b); return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05); }; var bgOf=function(e){ for (var n=e; n; n=n.parentElement){ var b=cs(n).backgroundColor; if (b && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(b)) return b; } return 'rgb(255,255,255)'; }; var minC=99, minH=99, blocked=[]; items.forEach(function(b){ var c=ratio(cs(b).color, bgOf(b)); var why=b.querySelector('.tree-pop-why'); if (why) c=Math.min(c, ratio(cs(why).color, bgOf(why))); minC=Math.min(minC,c); var rr=b.getBoundingClientRect(); minH=Math.min(minH, rr.height); [[rr.left+8,rr.top+rr.height/2],[rr.left+rr.width/2,rr.top+rr.height/2],[rr.right-8,rr.top+rr.height/2]].forEach(function(pt){ var h=document.elementFromPoint(pt[0],pt[1]); if (h && !(h===b||b.contains(h))) blocked.push((b.innerText||'').split('\\n')[0].slice(0,16)+'→'+(h.getAttribute('aria-label')||h.className||h.tagName)); }); }); return { title:(p.querySelector('.tree-pop-title')||{}).textContent, labels: items.map(function(b){ return (b.querySelector('.tree-pop-label')||b).textContent + (b.getAttribute('aria-disabled')==='true' ? '[x]' : ''); }), inView: r.left>=0 && r.top>=0 && r.right<=innerWidth && r.bottom<=innerHeight, rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)], minContrast:+minC.toFixed(2), minItemH:Math.round(minH), blocked: blocked, focused: document.activeElement && document.activeElement.classList.contains('tree-pop-item') ? (document.activeElement.innerText||'').split('\\n')[0] : null }; })()`);
  const rclick = async (x, y) => {
    if (DESK) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "right", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "right", clickCount: 1 });
    } else { // 모바일 = 길게 누르기
      await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, radiusX: 4, radiusY: 4, force: 1, id: 1 }] });
      await wait(900);
      await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    await wait(400);
  };
  // 핀(리더선 핀의 풍선) 우클릭 / 길게 누르기
  const bub = await center("#pins-layer .pin-leader-bubble");
  if (bub && bub.vis) await rclick(bub.x, bub.y);
  const mPin = rec("ctx-pin", await popInfo());
  ok(mPin && /^포인트/.test(mPin.title) && mPin.labels.some((l) => /핀으로 표시/.test(l)) && mPin.labels.some((l) => /^열기/.test(l)) && mPin.labels.some((l) => /^삭제/.test(l)), "[R2] 핀 " + (DESK ? "우클릭" : "길게 누르기") + " → 앱 메뉴(열기·핀으로 표시·삭제…)", mPin);
  ok(mPin && mPin.inView && mPin.minContrast >= 4.5 && mPin.minItemH >= 32 && !mPin.blocked.length, "[R2] 메뉴 화면 안 · 대비 " + (mPin && mPin.minContrast) + ":1 ≥4.5 · 항목 높이 " + (mPin && mPin.minItemH) + "px ≥32 · 가림 0", mPin);
  if (DESK) {
    const ctx1 = await evSafe("window.__ctx.slice(-1)[0]");
    ok(ctx1 && ctx1.prevented === true, "[R2] 핀 우클릭 = 브라우저 메뉴 차단(preventDefault)", ctx1);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
    await wait(150);
    const k = await popInfo();
    ok(k && k.focused && k.focused !== mPin.focused, "[R2] 키보드 ↓ = 다음 항목 포커스(" + (mPin && mPin.focused) + " → " + (k && k.focused) + ")", k);
  }
  await shot("ctx-pin");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await wait(200);
  ok((await evSafe("!document.querySelector('.tree-pop')")) === true, "[R2] Esc = 메뉴 닫힘");
  // 빈 도면 우클릭(오른쪽 아래 구석 — 화면 밖 보정 확인)
  p = await drawPt(0.97, 0.95);
  await rclick(p.x, p.y);
  const mMap = rec("ctx-map", await popInfo());
  ok(mMap && mMap.title === "도면" && mMap.labels.some((l) => /^여기에 핀 추가\(CHECKER\)/.test(l)) && mMap.labels.some((l) => /전체 기능 메뉴 열기/.test(l)) && mMap.inView && !mMap.blocked.length, "[R2] 빈 도면 → 도면 메뉴(핀 추가·전체 기능…), 구석에서도 화면 안 · 가림 0", mMap);
  await shot("ctx-map");
  // 메뉴로 핀 추가 → 실제 핀 1개 증가
  const before = await evSafe("__T.State.pins.length");
  await evSafe("(function(){ var b=Array.from(document.querySelectorAll('.tree-pop .tree-pop-item')).filter(function(x){ return /여기에 핀 추가/.test(x.innerText); })[0]; b && b.click(); return 1; })()");
  await wait(500);
  ok((await evSafe("__T.State.pins.length")) === before + 1, "[R2] [여기에 핀 추가] → 핀 +1");
  await evSafe("__T.UI.closeTreeMenu(); 1");
  if (DESK) {
    // 트리 노드 우클릭 = 그 노드의 ⋯ 메뉴
    const tn = await center("#side-tree .tree-node-deck");
    if (tn && tn.vis) await rclick(tn.x, tn.y);
    const mTree = rec("ctx-tree", await popInfo());
    ok(mTree && /^구역/.test(mTree.title) && mTree.labels.some((l) => /도면|QR/.test(l)), "[R2] 트리 구역 노드 우클릭 → 기존 ⋯ 메뉴(구역 도면·QR)", mTree);
    await shot("ctx-tree");
    await evSafe("__T.UI.closeTreeMenu(); 1");
    // 입력창 = 브라우저 메뉴 유지
    const inp = await center("#tb-page-input");
    if (inp && inp.vis) await rclick(inp.x, inp.y);
    const last = await evSafe("window.__ctx.slice(-1)[0]");
    ok(last && last.tag === "INPUT" && last.prevented === false && (await evSafe("!document.querySelector('.tree-pop')")) === true, "[R2] 입력창 우클릭 = 브라우저 메뉴(preventDefault 없음)", last);
  } else {
    // 375 — 사이드 시트의 트리 ⋯ 메뉴가 ?·✉ 버튼에 가리지 않는다(0b4d262: '원본 전체 도면 열기' 좌측이 '?' 에 가림)
    const mc = await center('#mobile-dock [data-act="menu"]');
    if (mc && mc.vis) { await tap(mc.x, mc.y); await wait(900); }
    const nMore = await evSafe("document.querySelectorAll('#side-tree .tree-more').length");
    const res = [];
    for (let i = 0; i < nMore; i++) {
      await evSafe(`(function(){ var e=document.querySelectorAll('#side-tree .tree-more')[${i}]; e.scrollIntoView({block:'end'}); return 1; })()`);
      await wait(300);
      const c = await evSafe(`(function(){ var e=document.querySelectorAll('#side-tree .tree-more')[${i}]; var r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
      await tap(c.x, c.y); await wait(500);
      res.push(await popInfo());
      if (i === 0) await shot("tree-more-fab");
      await evSafe("__T.UI.closeTreeMenu(); 1"); await wait(200);
    }
    rec("tree-more-375", { res });
    const fabs = await evSafe("Array.from(document.querySelectorAll('[data-help-toggle],[data-help-inquiry-toggle]')).filter(function(b){ return b.getBoundingClientRect().width>0; }).length");
    ok(nMore > 0 && res.every((m) => m && m.inView && !m.blocked.length) && fabs === 2, "[FAB] 375 트리 ⋯ 메뉴 " + nMore + "개 — ?·✉ 가림 0 · 화면 안 · FAB 2개 그대로 보임", { res, fabs });
  }
  fs.writeFileSync(path.join(OUTD, TAG + "-report.json"), JSON.stringify(R, null, 1));

  /* ── R7·R8·R9 (375): 전역 viewer + 이 프로젝트 designer 멤버 · 메인 도면 위 구역(crop) 윤곽 라벨 · 리스트 패널 ── */
  async function r7Scenario() {
    const email = "field@seastar.test";
    const dk = await P.api("POST", "/api/projects/" + P.PRJ + "/decks", { name: "B구역", deployment_id: P.DEP_ID, page: 1, crop: { x: 52, y: 22, w: 24, h: 34 } });
    await P.db.prepare("DELETE FROM designers WHERE email = ?").bind(email).run();
    await P.db.prepare("UPDATE projects SET owner = ? WHERE id = ?").bind("owner@else.test", P.PRJ).run();
    await P.db.prepare("INSERT INTO project_members (project_id, email, role, granted_by, created_at) VALUES (?, ?, 'designer', 'designssir@gmail.com', ?)").bind(P.PRJ, email, Date.now()).run();
    rec("r7-seed", { cropDeck: dk.status });
    await send("Page.navigate", { url: BASE + "/manifest.webmanifest" });
    await waitFor("location.pathname === '/manifest.webmanifest'", 60000);
    await ev(`localStorage.setItem("wm_local_token", ${JSON.stringify(TOKEN)}); 1`);
    await send("Page.navigate", { url: BASE + "/" });
    await waitFor("navigator.serviceWorker && navigator.serviceWorker.controller", 60000);
    await wait(3500);
    const leafSel = '[data-act=mode-open][data-mode-reg=checkboard][data-deck-id="' + P.DECK_ID + '"]';
    await waitFor("document.querySelector(" + JSON.stringify(leafSel) + ")", 60000);
    if (MUT === "r7") await ev("Object.defineProperty(__T.Auth, 'isDesigner', { configurable: true, get: function(){ return this.role === 'super' || this.role === 'admin' || this.role === 'designer'; } }); 1");
    // r8css = 0b4d262 상태(라벨 선택자가 안 맞아 배치 중에도 pointer-events:auto)로 되돌림. 클릭 통과 JS 는 p133 단위 r8.
    if (MUT === "r8css") await ev("(function(){ var s=document.createElement('style'); s.textContent='html body #map-area .deck-outline-label{pointer-events:auto !important}'; document.head.appendChild(s); return 1; })()");
    await evSafe("(function(){ var e=document.querySelector(" + JSON.stringify(leafSel) + "); e && e.click(); return 1; })()");
    await waitFor("window.__T && __T.State.mode === 'designer' && document.getElementById('map-image') && document.getElementById('map-image').getBoundingClientRect().width > 0", 30000);
    await wait(2500);
    const a = rec("r7-enter", await evSafe("({ mode: __T.State.mode, role: __T.Auth.role, projectRole: __T.Auth.projectRole, isDesigner: __T.Auth.isDesigner, perm: __T.UI.permCheck('designer'), placing: __T.State.placing })"));
    ok(a && a.mode === "designer" && a.role === "viewer" && a.projectRole === "designer" && a.perm === "", "[R7] 전역 viewer + 프로젝트 designer 멤버 → 편집 화면 진입 · 편집 권한(0b4d262: 허브에 머묾·메뉴 51개 비활성)", a);
    await evSafe("(function(){ var b=document.getElementById('mdock-more-toggle'); b && b.click(); return 1; })()");
    await wait(800);
    const fm = rec("r7-menu", await evSafe("(function(){ var all=Array.from(document.querySelectorAll('.fm-item')); var bad=all.filter(function(e){ return /디자이너\\(편집\\) 전용/.test(e.innerText||''); }).map(function(e){ return (e.querySelector('.fm-label')||e).innerText.slice(0,30); }); return { items: all.length, designerOnlyDisabled: bad.length, sample: bad.slice(0,5) }; })()"));
    ok(fm && fm.items > 0 && fm.designerOnlyDisabled === 0, "[R7] 더보기(전체 기능) — '디자이너(편집) 전용' 비활성 0개 / 전체 " + (fm && fm.items), fm);
    await shot("r7-more-sheet");
    await evSafe("(function(){ var b=document.getElementById('mdock-more-toggle'); b && b.click(); return 1; })()"); await wait(500);
    // R9 — 리스트 패널을 연 채 [포인트] → 패널 접힘
    await evSafe("__T.State.placing && __T.App._togglePlacing(); 1"); await wait(300);
    await evSafe("(function(){ var b=document.getElementById('pin-grid-reopen'); b && b.click(); return 1; })()"); await wait(500);
    const g0 = await evSafe("(function(){ var p=document.getElementById('pin-grid-panel'); var r=p.getBoundingClientRect(); return { open: !p.classList.contains('collapsed') && r.height > 40, h: Math.round(r.height) }; })()");
    await clickSel('#mobile-dock [data-act="place"]'); await wait(600);
    const g1 = rec("r9", { before: g0, after: await evSafe("(function(){ var p=document.getElementById('pin-grid-panel'); var r=p.getBoundingClientRect(); var vis=Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)); var ro=document.getElementById('pin-grid-reopen'); return { open: !p.classList.contains('collapsed') && vis > 2000, visArea: Math.round(vis), reopenShown: !!(ro && !ro.classList.contains('hidden')), placing: __T.State.placing }; })()") });
    ok(g0 && g0.open && g1.after && g1.after.placing === true && g1.after.open === false && g1.after.reopenShown, "[R9] 리스트 패널 열린 채 [포인트] → 배치 ON + 패널 접힘(다시 열기 버튼 그대로)", g1);
    // R8 — 배치 중 윤곽 라벨 위 탭 = 핀 생성(라벨이 가로채 이동하지 않음)
    const lab = await center("[data-deck-outline-label]");
    const before = await evSafe("__T.State.pins.length");
    const depBefore = await evSafe("__T.State.currentDeploymentId");
    const hitInfo = lab ? await evSafe(`(function(){ var h=document.elementFromPoint(${lab.x}, ${lab.y}); return h ? (h.id || String(h.className).slice(0,40)) : null; })()`) : null;
    if (lab && lab.vis) { await tap(lab.x, lab.y); await wait(1500); }
    const r8 = rec("r8", { label: lab, hitWhilePlacing: hitInfo, pinsBefore: before, pinsAfter: await evSafe("__T.State.pins.length"), outlineStill: await evSafe("!!document.querySelector('[data-deck-outline-label]')"), depSame: (await evSafe("__T.State.currentDeploymentId")) === depBefore });
    ok(lab && lab.vis && r8.hitWhilePlacing !== "deck-outline-label" && r8.pinsAfter === before + 1 && r8.outlineStill, "[R8] 배치 중 구역 윤곽 라벨 위 탭 → 핀 +1 · 구역 이동 0 · 배치 중 라벨 pointer-events 통과(elementFromPoint≠라벨)", r8);
    await shot("r8-after-label-tap");
    fs.writeFileSync(path.join(OUTD, TAG + "-report.json"), JSON.stringify(R, null, 1));
  }
}
