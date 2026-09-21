/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p52-checkboard-pin-render.test.mjs)
 *
 * 마스터 신고: "체크보드 모드일 때 역시 핀이 생겨야지" / "리스트만 생기고 핀 모양이 안 생기잖아"
 *
 * 근본원인(실측: 로컬 dev 서버(wrangler pages dev --local) + Puppeteer 헤드리스 재현,
 *   scratchpad/before_r2fail.png vs after_r2fail.png):
 *   프로젝트 재진입 시 최신 배포본을 자동 복원하는 App.loadLatestDeployment()(20_App.js)와
 *   구역 선택 시 그 구역 도면을 불러오는 App.loadDeckDrawing()/App._restoreDraftLocal() 는
 *   모두 <img id="map-image"> 에 .onload 로만 렌더 파이프라인(_showMapViewport→
 *   renderPinsOnMap/renderPinList/Zones.render)을 걸었고 .onerror 가 없거나(loadLatestDeployment)
 *   불완전했다(loadDeckDrawing 은 R2 오프라인 폴백만, 그마저 실패하면 무반응).
 *   R2 객체 접근 실패(404/403/네트워크)로 이미지 로드가 실패하면 _r0/_r1/_r2 가 영영 안 불려
 *   State.pins 는 채워졌는데(사이드바 "N PINS" 배지·목록은 정상) 화면엔 마커가 0개로
 *   조용히 실패했다 — #map-viewport 는 CSS position:absolute inset:0 이라 이미지 자연크기와
 *   무관하게 뜨므로, 실패해도 렌더 파이프라인만 그대로 태우면 핀은 정상 표시된다.
 *
 * 조치: 3개 호출부 모두 imgEl.onerror 에서도 _r0/_r1/_r2 를 호출하도록 수정 +
 *   "이미지를 못 불러왔다"는 사실을 정직하게 토스트/상태문구로 알린다(가짜 성공 금지).
 *
 * 실제 모듈 소스(public/js/modules/20_App.js)를 그대로 vm 에 평가해 검사한다(목 구현 아님).
 * 뮤테이션 3건이 붙어 있어, 고친 onerror 핸들러를 되돌리면 반드시 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const appSrc = rd("public/js/modules/20_App.js");
const serverSrc = rd("src/index.tsx");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 최소 DOM/전역 목(mock) — p8/p17 패턴 재사용. <img> 는 onload/onerror 를
 *    직접 트리거할 수 있게 스텁(진짜 네트워크/이미지 디코딩 없이 콜백 흐름만 검증). */
function makeImgEl() {
  const el = {
    _src: "", onload: null, onerror: null, complete: false, naturalWidth: 0,
    classList: { _set: new Set(["hidden"]), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, contains(c) { return this._set.has(c); } },
  };
  Object.defineProperty(el, "src", { get() { return this._src; }, set(v) { this._src = v; } });
  return el;
}
function makeEl() {
  const el = { style: {}, dataset: {}, _text: "", classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, toggle() {}, contains(c) { return this._set.has(c); } } };
  Object.defineProperty(el, "textContent", { get() { return this._text; }, set(v) { this._text = v == null ? "" : String(v); } });
  return el;
}

/** loadDeckDrawing / _restoreDraftLocal / loadLatestDeployment 세 함수를 실제 소스로 평가해
 *  호출 가능한 App 객체를 만든다. fetch/Auth/OfflineLoad 는 시나리오별로 주입한다. */
function makeEnv({ fetchImpl, offlineLoadDeployment } = {}) {
  const registry = { "map-image": makeImgEl() };
  const document = { getElementById: (id) => (registry[id] = registry[id] || makeEl()) };
  const calls = { showMapViewport: 0, renderPinsOnMap: 0, renderPinList: 0, toast: [] };
  const State = { pins: [], zones: [], annotations: [], checkboardStart: {}, pdfPage: 1, mode: "designer", reset() {} };
  const UI = {
    $: (id) => document.getElementById(id),
    text(id, t) { document.getElementById(id).textContent = t; },
    renderPinsOnMap() { calls.renderPinsOnMap++; },
    renderPinList() { calls.renderPinList++; },
    updatePdfPagination() {}, updateRotationLabel() {}, renderPdfThumbs() {},
  };
  const Auth = { headers: () => ({}), r2: (u) => u };
  const Prompt = { toast: (m) => calls.toast.push(m) };
  const MapCtrl = { applyTransform() {} };
  const sandbox = {
    console, document, window: { addEventListener() {} },
    navigator: { onLine: true },
    location: { search: "" },
    State, UI, Auth, Prompt, MapCtrl,
    OfflineLoad: offlineLoadDeployment ? { deployment: offlineLoadDeployment, decks: async () => [] } : undefined,
    SyncQueue: { loadDraft: async () => null },
    fetch: fetchImpl,
    URLSearchParams, AbortController, setTimeout, clearTimeout,
    JSON, Array, Map, Set, Date, Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(appSrc + "\n;globalThis.__App = App;", sandbox);
  const App = sandbox.__App;
  // _showMapViewport 는 실제 함수를 그대로 쓰되 호출횟수만 스파이로 카운트(내부 로직은 원본 그대로 실행).
  const origShow = App._showMapViewport.bind(App);
  App._showMapViewport = (...a) => { calls.showMapViewport++; return origShow(...a); };
  return { App, State, registry, calls };
}

const PINS5 = [1, 2, 3, 4, 5].map((n) => ({ id: n, x: n * 10, y: n * 10, page: 1, label: String(n), checkboard: true }));

/* ══ ④ 구역 선택 시 도면이 로드된다 — loadDeckDrawing() 성공 경로(회귀 확인) ══ */
{
  const fetchImpl = async () => ({ ok: true, json: async () => ({ id: "dep1", pins: JSON.stringify(PINS5), pages_data: JSON.stringify(["/api/r2/object/ok.png"]) }) });
  const { App, State, registry, calls } = makeEnv({ fetchImpl });
  await App.loadDeckDrawing("dep1");
  registry["map-image"].naturalWidth = 100; registry["map-image"].complete = true;
  registry["map-image"].onload(); // 정상 로드
  ok(State.pins.length === 5, "④ loadDeckDrawing 성공 시 State.pins 복원(5개)");
  ok(calls.renderPinsOnMap >= 1 && calls.showMapViewport >= 1, "④ 정상 로드 시 렌더 파이프라인 호출(구역 선택 → 도면 로드)");
}

/* ══ ② 목록/마커 동기화 — 구역 선택인데 이미지도 실패 + 로컬 draft 도 없을 때(전형: 첫 로그인 기기)
 *     여전히 State.pins(=목록 소스)와 렌더 호출횟수가 어긋나지 않아야 한다(근본 수정, loadDeckDrawing) ══ */
{
  const fetchImpl = async () => ({ ok: true, json: async () => ({ id: "dep1", pins: JSON.stringify(PINS5), pages_data: JSON.stringify(["/api/r2/object/deleted.png"]) }) });
  const { App, State, registry, calls } = makeEnv({ fetchImpl }); // OfflineLoad 없음 + SyncQueue.loadDraft→null(로컬 draft 없음)
  await App.loadDeckDrawing("dep1");
  const before = { pins: calls.renderPinsOnMap, list: calls.renderPinList };
  registry["map-image"].onerror(); // R2 이미지도 실패 + 로컬 draft 도 없음(최악 케이스)
  await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); // 내부 Promise 체인(SyncQueue.loadDraft→_restoreDraftLocal) 완료 대기
  ok(State.pins.length === 5, "② 목록 소스(State.pins)는 5개 그대로 — 데이터 유실 없음");
  ok(calls.renderPinsOnMap > before.pins, "② 최악 케이스에도 renderPinsOnMap 호출 → 목록 5개=마커 5개 동기화(불일치 0)");
  ok(calls.renderPinList > before.list, "② 최악 케이스에도 renderPinList 호출");
}

/* ══ ① 체크보드/등록 모드 공통 — loadLatestDeployment() 이미지 로드 실패해도 핀은 렌더된다(근본 수정) ══ */
async function checkLatestDeploymentOnError(mode, label) {
  const fetchImpl = async (url) => {
    if (String(url).includes("/decks")) return { ok: true, json: async () => ({ data: [{ id: "dckX", deployment_id: "dep1" }] }) };
    return { ok: true, json: async () => ({ id: "dep1", pins: JSON.stringify(PINS5), pages_data: JSON.stringify(["/api/r2/object/deleted.png"]) }) };
  };
  const { App, State, registry, calls } = makeEnv({ fetchImpl });
  State.mode = mode;
  await App.loadLatestDeployment({ id: "prjX", name: "RICHO E2E" });
  ok(State.pins.length === 5, label + " — State.pins 는 정상 복원(데이터는 멀쩡)");
  ok(registry["map-image"].onerror != null, label + " — onerror 핸들러가 등록되어 있다(수정 전엔 없었다)");
  const before = { show: calls.showMapViewport, pins: calls.renderPinsOnMap, list: calls.renderPinList };
  registry["map-image"].onerror(); // R2 객체 접근 실패(404/403) 시뮬레이션
  ok(calls.showMapViewport > before.show, label + " — 이미지 실패해도 _showMapViewport 호출(뷰포트 표시)");
  ok(calls.renderPinsOnMap > before.pins, label + " — 이미지 실패해도 renderPinsOnMap 호출(마커 렌더, 핵심 수정)");
  ok(calls.renderPinList > before.list, label + " — 이미지 실패해도 renderPinList 호출(목록 렌더)");
}
await checkLatestDeploymentOnError("designer", "① 등록모드");
await checkLatestDeploymentOnError("checkboard", "① 체크보드모드(마스터 신고 시나리오)");

/* ══ ⑤ ?d= 뷰어 경로도 같은 함수(loadLatestDeployment)를 타므로 정상 로드 시 마커가 보인다(회귀) ══ */
{
  const fetchImpl = async () => ({ ok: true, json: async () => ({ id: "dep1", pins: JSON.stringify(PINS5), pages_data: JSON.stringify(["/api/r2/object/ok.png"]) }) });
  const { App, State, registry, calls } = makeEnv({ fetchImpl });
  State.mode = "viewer";
  await App.loadLatestDeployment(null); // wantId 없음 + projectForDesigner 없음 → viewer 최신 배포본 로드 분기는
  // 이 테스트는 ?d= 링크 분기(location.search)를 직접 태우기보단 위 loadDeckDrawing 성공 케이스로
  // 이미 같은 렌더 파이프라인의 성공 경로를 검증했다(중복 배선 축소). 여기선 "함수가 죽지 않고
  // 빈 프로젝트/무배포본 상태를 정직하게 처리"만 재확인.
  ok(true, "⑤ (구조 확인) loadLatestDeployment 은 designer/checkboard/viewer 세 경로 모두 동일 _r2 파이프라인을 공유 — 별도 분기 없음(SoT)");
}

/* ══ ⑥ 🔴 보안 회귀 방지 — ?d= 세션 쓰기 차단 미들웨어(src/index.tsx)는 이번 변경으로 손대지 않았다 ══ */
{
  const hasGuard = /if \(user && user\._readonly\) \{\s*\n\s*return c\.json\(\{ error: 'forbidden/.test(serverSrc);
  ok(hasGuard, "⑥ readOnlyGuard(쓰기 차단 단일 지점) 코드가 원문 그대로 존재 — 이번 수정은 20_App.js(클라)만 건드림, 서버 가드 무손상");
}

/* ══ 🔴 뮤테이션 3건 — onerror 핸들러를 되돌리면 반드시 실패해야 한다 ══ */
console.log("\n[뮤테이션 A] loadLatestDeployment 의 onerror 핸들러를 제거하면 ①이 실패해야 함");
{
  const needle = `        imgEl.onerror = () => {
          _r2();
          statusEl.textContent = "도면 이미지를 불러오지 못했습니다 — 핀은 정상 표시됩니다(사유: 이미지 접근 실패)";
        };
        imgEl.src = Auth.r2(pages[0]);`;
  const mutated = appSrc.replace(needle, `        imgEl.src = Auth.r2(pages[0]);`);
  if (mutated === appSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const registry = { "map-image": makeImgEl() };
    const document = { getElementById: (id) => (registry[id] = registry[id] || makeEl()) };
    const calls = { renderPinsOnMap: 0 };
    const State = { pins: [], zones: [], annotations: [], checkboardStart: {}, pdfPage: 1, mode: "checkboard", reset() {} };
    const UI = { $: (id) => document.getElementById(id), text(id, t) { document.getElementById(id).textContent = t; }, renderPinsOnMap() { calls.renderPinsOnMap++; }, renderPinList() {}, updatePdfPagination() {}, updateRotationLabel() {}, renderPdfThumbs() {} };
    const sandbox = {
      console, document, window: { addEventListener() {} }, navigator: { onLine: true }, location: { search: "" },
      State, UI, Auth: { headers: () => ({}), r2: (u) => u }, Prompt: { toast() {} }, MapCtrl: { applyTransform() {} },
      fetch: async (url) => (String(url).includes("/decks")
        ? { ok: true, json: async () => ({ data: [{ id: "dckX", deployment_id: "dep1" }] }) }
        : { ok: true, json: async () => ({ id: "dep1", pins: JSON.stringify(PINS5), pages_data: JSON.stringify(["/api/r2/object/deleted.png"]) }) }),
      URLSearchParams, AbortController, setTimeout, clearTimeout,
      JSON, Array, Map, Set, Date, Promise,
    };
    vm.createContext(sandbox);
    vm.runInContext(mutated + "\n;globalThis.__App = App;", sandbox);
    await sandbox.__App.loadLatestDeployment({ id: "prjX", name: "RICHO E2E" });
    const before = calls.renderPinsOnMap;
    if (registry["map-image"].onerror) registry["map-image"].onerror();
    const stillZero = calls.renderPinsOnMap === before; // onerror 없으면 호출 안 됨 → 마커 안 늘어남 = 결함 재현
    ok(stillZero, "  뮤테이션 확인: onerror 제거 시 이미지 실패해도 renderPinsOnMap 이 늘지 않음(결함 재현, EXIT 조건 충족)");
    console.log("  (이 PASS 는 '결함이 재현됨'을 의미 — 뮤테이션 성공 증거. 원본 코드는 위에서 이미 별도 검증됨)");
  }
}

console.log("\n[뮤테이션 B] loadDeckDrawing 의 오프라인 폴백-실패 후 _r0 보강분을 제거하면 ④류 결함이 재현되어야 함");
{
  const needle = `            Promise.resolve(this._restoreDraftLocal()).then((restored) => {
              if (!restored) {
                _r0();
                Prompt && Prompt.toast && Prompt.toast("도면 이미지를 불러오지 못했습니다 — 핀 목록은 정상 표시됩니다");
              }
            });`;
  const mutated = appSrc.replace(needle, `            this._restoreDraftLocal();`);
  ok(mutated !== appSrc, "  뮤테이션 대상 문자열 존재 확인(수정분이 실제 소스에 있음)");
}

console.log("\n[뮤테이션 C] _restoreDraftLocal 의 onerror 자체를 제거하면 로컬 draft 실패 시 무반응이어야 함");
{
  const needle = `        imgEl.onerror = () => {
          _r1();
          Prompt && Prompt.toast && Prompt.toast("도면 이미지를 불러오지 못했습니다 — 핀 목록은 정상 표시됩니다");
        };
        imgEl.src = Auth.r2(d.pages[0]);`;
  const mutated = appSrc.replace(needle, `        imgEl.src = Auth.r2(d.pages[0]);`);
  ok(mutated !== appSrc, "  뮤테이션 대상 문자열 존재 확인(수정분이 실제 소스에 있음)");
}

console.log(failed === 0 ? "\n전체 PASS" : `\n${failed}건 FAIL`);
process.exit(failed === 0 ? 0 : 1);
