/**
 * 실 Chrome(헤드리스 CDP) 지도 페이지 — 핀/선 "실제 화면 px" 단언용 공용 하니스(WO 20261019-pinpx).
 *
 * 왜: 수학 함수(pinScreenScale() × 40)만 검사하면 #map-transform 의 scale(zoom) 중첩을 못 본다
 *   (ae36a91 실사고: 함수 값은 30px 인데 실제 화면 3.76px). 그래서 브라우저 레이아웃 엔진이 계산한
 *   getBoundingClientRect() 로만 판정한다.
 * 목 0 범위: CSS 3종(public/css/style.css → seastar-family-tokens.css → seastar-3d-skin.css, index.html 링크 순서)
 *   + public/index.html 의 #map-viewport 블록 원문(DOM 구조 SoT — 핀 레이어가 transform 밖으로 빠지면 테스트도 그대로 반영)
 *   + 실제 모듈 소스. 가짜는 이 화면과 무관한 협력 객체(App 저장·토스트) 셸뿐.
 * Chrome 이 없으면 FAIL(조용한 SKIP 금지 — 증거 없는 PASS 방지).
 */
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export const DEFAULT_MODULES = ["01_State.js", "01b_PinSeries.js", "02_PDF.js", "10_MapCtrl.js", "11_UI.js", "23c_PinSizePrefs.js", "26_PdfAnno.js", "63_RouteDraw.js"];

/** index.html 의 #map-viewport 블록 원문(hidden 클래스 제거 — 표시 상태로). */
function viewportBlock() {
  const html = rd("public/index.html");
  const a = html.indexOf('<div id="map-viewport"');
  const b = html.indexOf("<!-- 멀티페이지 PDF 썸네일 스트립");
  if (a < 0 || b < 0 || b <= a) throw new Error("public/index.html 에서 #map-viewport 블록을 찾지 못함");
  return html.slice(a, b).replace('class="map-viewport hidden"', 'class="map-viewport"').replace('class="pdf-canvas hidden"', 'class="pdf-canvas"');
}

/**
 * @param {object} o
 * @param {number} [o.width=1280] @param {number} [o.height=800] 뷰포트(데스크톱 마우스)
 * @param {{w:number,h:number}} [o.canvas] #pdf-canvas CSS 크기(도면 크기)
 * @param {(name:string, src:string)=>string} [o.mutate] 모듈 소스 변형(뮤테이션 증명용)
 * @returns {Promise<{ev:(expr:string)=>Promise<any>, close:()=>Promise<void>}>}
 */
export async function openRealMap(o = {}) {
  const width = o.width || 1280, height = o.height || 800;
  const cv = o.canvas || { w: 8000, h: 6000 };
  if (!fs.existsSync(CHROME)) throw new Error("Chrome 없음: " + CHROME + " (CHROME_PATH 지정) — 실제 화면 px 단언은 브라우저 없이 판정 불가");
  const mods = (o.modules || DEFAULT_MODULES).map((f) => { const s = rd("public/js/modules/" + f); return o.mutate ? o.mutate(f, s) : s; });
  const css = ["public/css/style.css", "public/css/seastar-family-tokens.css", "public/css/seastar-3d-skin.css"].map(rd).join("\n");
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style>
<style>html,body{margin:0;padding:0;} #map-viewport{position:relative;width:${width}px;height:${height}px;overflow:hidden;}</style>
</head><body>
${viewportBlock()}
<script>
window.App = { _markDirty(){}, _autoSave(){}, setActivePin(){}, onPinTap(){}, deletePins: async()=>0, canBulkDeletePins: ()=>true };
window.Prompt = { toast(){} };
window.Zones = { render(){}, updateLabelScale(){} };
window.PinIcons = { headMarkup: ()=>"" };
</script>
<script>
${mods.join("\n;\n")}
window.__T = { State, MapCtrl, UI, PDF, PinLabelPrefs, Routes, PdfAnno };
(function(){
  var cv = document.getElementById("pdf-canvas");
  cv.width = 16; cv.height = 12; cv.style.width = "${cv.w}px"; cv.style.height = "${cv.h}px"; cv.style.display = "block";
  MapCtrl.init(document.getElementById("map-viewport"), document.getElementById("map-transform"));
  State.pdfPage = 1; State.mode = "designer";
})();
</script></body></html>`;
  const dir = path.join(ROOT, ".tmp"); // 🔴 CLAUDE.md §G-5 — 프로젝트 안 .tmp
  fs.mkdirSync(dir, { recursive: true });
  const tag = "realmap-" + process.pid + "-" + Date.now();
  const htmlPath = path.join(dir, tag + ".html");
  fs.writeFileSync(htmlPath, page, "utf8");
  const profileDir = path.join(dir, tag + "-chrome");
  const proc = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", "--user-data-dir=" + profileDir, "--window-size=" + width + "," + height, "about:blank"], { stdio: "ignore" });
  process.on("exit", () => { try { proc.kill(); } catch (e) {} }); // 예외로 끝나도 Chrome 고아 금지
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) { try { port = parseInt(fs.readFileSync(path.join(profileDir, "DevToolsActivePort"), "utf8").split("\n")[0], 10) || 0; } catch (e) {} if (!port) await wait(150); }
  if (!port) { proc.kill(); throw new Error("DevToolsActivePort 없음"); }
  const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej));
  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i++) { try { const l = await getJson("http://127.0.0.1:" + port + "/json/list"); const pg = l.find((t) => t.type === "page"); if (pg) wsUrl = pg.webSocketDebuggerUrl; } catch (e) {} if (!wsUrl) await wait(250); }
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  let idc = 0; const pending = new Map(); const evs = [];
  ws.on("message", (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.j(new Error(JSON.stringify(m.error))) : p.r(m.result); } else if (m.method) evs.push(m); });
  const send = (method, params = {}) => new Promise((r, j) => { const id = ++idc; pending.set(id, { r, j }); ws.send(JSON.stringify({ id, method, params })); });
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: "file:///" + htmlPath.replace(/\\/g, "/") });
  for (let i = 0; i < 100; i++) { if (evs.some((m) => m.method === "Page.loadEventFired")) break; await wait(100); }
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails).slice(0, 600));
    return r.result.value;
  };
  const exc = evs.find((m) => m.method === "Runtime.exceptionThrown");
  if (exc) throw new Error("페이지 로드 예외: " + JSON.stringify(exc.params.exceptionDetails).slice(0, 600));
  if ((await ev("typeof window.__T")) !== "object") throw new Error("모듈 로드 실패(__T 없음)");
  await ev(PROBE);
  const close = async () => { try { ws.close(); } catch (e) {} try { proc.kill(); } catch (e) {} await wait(300); try { fs.rmSync(htmlPath, { force: true }); fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {} };
  return { ev, close };
}

/** 페이지 안 측정 도구 — 전부 getBoundingClientRect/getScreenCTM(상위 transform 포함 실제 화면값). */
const PROBE = String.raw`(function(){
  var M = window.__M = {};
  var S = __T.State, MC = __T.MapCtrl;
  M.pins = function(list){ S.pins = list; __T.UI.renderPinsOnMap(); MC.applyTransform(); return S.pins.length; };
  M.zoom = function(z){ S.zoom = z; MC.applyTransform(); return S.zoom; };
  M.fit = function(){ var z = MC.computeFitZoom(); S.zoom = z; MC.applyTransform(); return z; };
  M.heads = function(){ return Array.from(document.querySelectorAll('#pins-layer > .pin-marker')).filter(function(m){ return m.style.display !== 'none'; }).map(function(m){ var r = (m.querySelector('.pin-pin svg') || m.querySelector('svg')).getBoundingClientRect(); return Math.round(r.height * 1000) / 1000; }); };
  M.head = function(){ var h = M.heads(); return h.length ? Math.max.apply(null, h) : null; };
  M.label = function(id){ var t = document.querySelector('#pins-layer > .pin-marker[data-id="' + id + '"] .pin-num-text'); if (!t) return null; var r = t.getBoundingClientRect(); return { h: Math.round(r.height * 1000) / 1000, display: getComputedStyle(t).display }; };
  M.numOff = function(){ return document.getElementById('pins-layer').classList.contains('pin-num-off'); };
  M.bubble = function(){ var b = document.querySelector('#pins-layer > .pin-leader-bubble'); if (!b) return null; return Math.round(b.getBoundingClientRect().height * 1000) / 1000; };
  /** 탭 패드(::after 44px, 머리 상단 중심) — 머리 밖 (중심+dx, 상단+2) 지점이 여전히 그 핀인가. 화면 안 좌표만 쓴다. */
  M.tapSide = function(dx, anyPin){ var m = Array.from(document.querySelectorAll('#pins-layer > .pin-marker')).filter(function(x){ return x.style.display !== 'none'; })[0]; if (!m) return null; var r = (m.querySelector('.pin-pin svg') || m).getBoundingClientRect(); var x = r.left + r.width / 2 + dx, y = r.top + 2; if (x < 0 || y < 0 || x > innerWidth || y > innerHeight || dx <= r.width / 2) return 'OFFSCREEN_OR_INSIDE'; var h = document.elementFromPoint(x, y); var hm = h && h.closest ? h.closest('.pin-marker') : null; return anyPin ? !!hm : hm === m; };
  /** 선 두께 화면 px = computed stroke-width(사용자 단위) × 화면 CTM 배율(기하평균). */
  M.line = function(svgId, cls){ var svg = document.getElementById(svgId); var el = svg.querySelector('.rm-probe.' + cls); if (!el) { el = document.createElementNS('http://www.w3.org/2000/svg', 'path'); el.setAttribute('class', 'rm-probe ' + cls); el.setAttribute('d', svgId === 'anno-svg' ? 'M 400 400 L 600 400' : 'M 40 40 L 60 40'); svg.appendChild(el); } var sw = parseFloat(getComputedStyle(el).strokeWidth); var m = el.getScreenCTM(); return Math.round(sw * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) * 1000) / 1000; };
})();`;
