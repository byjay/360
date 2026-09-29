/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p81-deck-crop-fit-race.test.mjs)
 *
 * 대상: 마스터 라이브 재현 — 옛 창 방식(crop 있음) 구역/영역을 열면 클리핑은 정확한데
 *   줌/팬이 identity(matrix(1,0,0,1,0,0))로 남아 잘린 영역이 원래 크기로 좌하단에 작게 보인다.
 *   [화면 맞춤] 버튼을 누르면(MapCtrl._fitBoundary) 정상 작동 — 경계 로직 자체는 정상.
 *
 * 근본원인(31_Projects.js:688 _applyDeckCropView): App.loadDeckDrawing() 은 <img id="map-image">
 *   의 src 만 설정하고 실제 네트워크 로드(load 이벤트)를 기다리지 않은 채 즉시 반환한다
 *   (imgEl.onload = _r0 는 나중에 비동기로 발화). selectDeck() 이 그 반환을 await 한 직후
 *   곧바로 MapCtrl.fitZone(crop,...) 을 불렀는데, 이 시점엔 #map-transform 이 아직 이미지
 *   자연크기를 모르는 0×0 이라 fitZone 내부 가드(!cw || !ch → return)가 조용히 아무 일도
 *   안 한다. 뒤늦게 이미지가 load 되면 loadDeckDrawing 의 onload(_r0→_showMapViewport)가
 *   zoom=1/pan={0,0}으로 되돌려 화면은 계속 identity 로 남는다.
 *
 * 채택: 크롭 분기도 이미 존재하던 "복사본(crop 없음)" 분기의 "로드 완료 이벤트에 건다" 패턴
 *   (img.complete 체크 → 아니면 addEventListener('load', ...))을 그대로 재사용한다(공유 지점,
 *   §G-2-5 — 두 분기가 따로 타이밍을 잡으면 반드시 갈라진다). 추가로 빠른 연속 전환 가드
 *   (this.currentDeck === d) 를 둬 늦게 도착한 이전 구역의 fitZone 이 최신 구역을 덮지 않게 한다.
 *
 * selectDeck() 은 허브 진입(openProjectAtDeck)·사이드바 트리 선택(31_Projects.js:751)·
 *   새로고침 후 재진입(재클릭 — 이 SPA 는 App.init() 이 프로젝트/구역을 URL·localStorage 로
 *   복원하지 않고 항상 허브로 돌아간다, grep 확인: 20_App.js App.init/openApp 어디에도
 *   deck 자동복원 없음) 셋의 **공유 진입점**이다 — 여기 한 곳을 고치면 세 경로가 전부 고쳐진다.
 *   "새 벡터복사 구역"(crop:null) 경로는 이미 같은 패턴으로 구현돼 있었다(p74 suiteFitOnOpen 회귀 보호).
 *
 * 실제 31_Projects.js 소스를 그대로 vm 에 평가해 selectDeck()→_applyDeckCropView() 흐름을
 * 통합 검증한다(목 구현 아님, App/MapCtrl 의 I/O 경계만 기록하는 얇은 스텁).
 * 뮤테이션 2건 — 되돌리면 해당 검사가 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const projSrc = rd("public/js/modules/31_Projects.js");
const appSrc = rd("public/js/modules/20_App.js");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };

/** selectDeck() 을 실제로 태우는 통합 하네스 — App.loadDeckDrawing 을 "src 만 걸고 즉시 반환"하는
 *  실제 동작대로 스텁한다(이미지 load 이벤트는 별도 triggerLoad() 로 수동 발화). */
function makeHarness(src = projSrc) {
  const calls = { fitZone: [], fit: 0 };
  const loadListeners = []; // { fn } — {once:true} 라 발화 후 제거
  const imgState = { complete: false, naturalWidth: 0 };
  const img = {
    get complete() { return imgState.complete; },
    get naturalWidth() { return imgState.naturalWidth; },
    addEventListener: (t, f) => { if (t === "load") loadListeners.push(f); }
  };
  const sb = {
    console, JSON, Math, Promise, setTimeout,
    document: { getElementById: (id) => (id === "map-image" ? img : null), body: { classList: { toggle() {} } } },
    UI: { text() {} },
    PDF: { setDeckCrop() {} },
    MapCtrl: {
      fitZone: (crop) => { calls.fitZone.push(crop); },
      fit: () => { calls.fit++; }
    },
    Prompt: { toast() {} },
    State: { mode: "designer" },
  };
  sb.App = {
    // 실제 loadDeckDrawing 의 관찰된 동작: src 설정 + onload 등록만 하고 이미지 로드를 기다리지 않고 반환.
    loadDeckDrawing: async (depId) => { imgState._depId = depId; return; },
    _gotoPage: async () => {},
  };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(src + "\n;globalThis.__J = Projects;", sb);
  const J = sb.__J;
  J._renderDecks = () => {};
  return {
    J, calls,
    /** 이미지가 네트워크에서 실제로 로드 완료됐다고 통지(등록된 모든 load 리스너 발화 후 비움) */
    fireImageLoad() {
      imgState.complete = true; imgState.naturalWidth = 100;
      const ls = loadListeners.splice(0);
      ls.forEach((f) => f());
    },
    /** 이미 캐시돼 있던 상황(동기 complete=true)을 흉내 */
    setCached() { imgState.complete = true; imgState.naturalWidth = 100; }
  };
}

const CROP_A = { x: 1.587, y: 64.375, w: 10.718, h: 31.602 }; // 마스터 라이브 재현 값(ㅁㄴㅇ)
const CROP_B = { x: 50, y: 50, w: 10, h: 10 };

/* ══════════════════════════════════════════════════════════════════
 * 1. 네트워크 로드(캐시 미스) — fitZone 은 load 이벤트 뒤에만 불린다
 * ══════════════════════════════════════════════════════════════════ */
async function suite1(label, src) {
  console.log("\n[" + label + " · ① 네트워크 로드 — 로드 완료 전 fitZone 0회]");
  const h = makeHarness(src);
  const deck = { id: "dck_mukvctz3_kk0jinti", name: "ㅁㄴㅇ", deployment_id: "dep1", crop: CROP_A };
  await h.J.selectDeck(deck);
  ok(h.calls.fitZone.length === 0, `selectDeck() 반환 직후(await 완료) fitZone 0회 — 이미지 아직 0×0 (${h.calls.fitZone.length})`);
  h.fireImageLoad();
  ok(h.calls.fitZone.length === 1 && h.calls.fitZone[0].w === CROP_A.w, `이미지 load 이벤트 뒤 fitZone 1회, crop.w=${h.calls.fitZone[0] && h.calls.fitZone[0].w} = ${CROP_A.w}`);
}

/* ══════════════════════════════════════════════════════════════════
 * 2. 캐시 히트 — 종전처럼 곧바로 적용(회귀 0)
 * ══════════════════════════════════════════════════════════════════ */
async function suite2(label, src) {
  console.log("\n[" + label + " · ② 캐시 히트 — 즉시 적용]");
  const h = makeHarness(src);
  h.setCached();
  const deck = { id: "d2", deployment_id: "dep2", crop: CROP_A };
  await h.J.selectDeck(deck);
  ok(h.calls.fitZone.length === 1, `캐시된 이미지 — selectDeck() 안에서 곧바로 fitZone 1회(${h.calls.fitZone.length})`);
}

/* ══════════════════════════════════════════════════════════════════
 * 3. 빠른 연속 전환 — 늦게 도착한 이전 구역의 fitZone 이 최신 구역을 덮지 않는다
 * ══════════════════════════════════════════════════════════════════ */
async function suite3(label, src) {
  console.log("\n[" + label + " · ③ 빠른 연속 전환 가드]");
  const h = makeHarness(src);
  const deckA = { id: "a", deployment_id: "depA", crop: CROP_A };
  const deckB = { id: "b", deployment_id: "depB", crop: CROP_B };
  await h.J.selectDeck(deckA);   // A 의 load 리스너 등록(아직 미발화)
  await h.J.selectDeck(deckB);   // 사용자가 A 로드가 끝나기 전에 B 로 전환 — B 의 load 리스너도 등록
  h.fireImageLoad();             // 같은 img 엘리먼트 — 등록된 리스너(A,B) 전부 발화
  ok(h.calls.fitZone.length === 1 && h.calls.fitZone[0].w === CROP_B.w,
    `늦게 도착한 A 는 스킵, 최신 B(w=${CROP_B.w})만 적용 — 총 ${h.calls.fitZone.length}회, 적용된 crop.w=${h.calls.fitZone[0] && h.calls.fitZone[0].w}`);
}

/* ══════════════════════════════════════════════════════════════════
 * 4. 모드 전환(keepDrawing) 경로는 selectDeck/_applyDeckCropView 를 아예 타지 않는다
 *   (구조 확인 — 20_App.js 를 손대지 않았으므로 정적 검사로 불변 확인)
 * ══════════════════════════════════════════════════════════════════ */
function suite4(label, src) {
  console.log("\n[" + label + " · ④ 모드 전환은 별도 경로(줌 유지, 재적용 없음)]");
  const m = src.match(/if \(opts\.keepDrawing && State\.fileType\) \{[\s\S]*?return;\s*\n\s*\}[\s\S]*?this\.loadLatestDeployment/);
  ok(!!m && !/_applyDeckCropView|selectDeck/.test(m[0]), "openApp: keepDrawing 조기 반환 블록에 _applyDeckCropView/selectDeck 호출 없음(줌 유지)");
}

console.log("=== 회귀: 구역/영역 진입 시 크롭 맞춤(fitZone) 레이스 — 라이브 재현(ㅁㄴㅇ, matrix identity) ===");
await suite1("정상", projSrc);
await suite2("정상", projSrc);
await suite3("정상", projSrc);
suite4("정상", appSrc);

/* ══════════════════════════════════════════════════════════════════
 * 뮤테이션 2건 — 되돌리면 각각 실패해야 한다(파일은 미변경, in-memory 뮤테이션)
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션 M1] 로드-완료 가드 제거(옛 즉시호출로 복귀) → ①실패해야 함");
{
  const needle = `      if (crop && typeof MapCtrl !== "undefined" && MapCtrl.fitZone) {
        const img = document.getElementById("map-image");
        // 빠른 연속 전환 가드 — load 이벤트가 늦게 도착했을 때 그 사이 다른 구역으로 바뀌었으면
        // (this.currentDeck.id !== d.id) 낡은 crop 을 적용하지 않는다(loadDeckDrawing 의 _isCurrentLoad 와
        // 같은 취지). currentDeck 이 아직 세팅 안 된 호출(직접 호출)은 통과시킨다(id 로 비교 — 다른 곳의
        // 기존 관용구와 동일, 31_Projects.js:660 참조).
        const doFit = () => {
          if (this.currentDeck && d && this.currentDeck.id !== d.id) return;
          if (MapCtrl.fitZone) MapCtrl.fitZone(crop, 0.14, 640);
        };
        if (img && img.complete && img.naturalWidth) doFit();
        else if (img && img.addEventListener) img.addEventListener("load", doFit, { once: true });
      }`;
  ok(projSrc.includes(needle), "M1 대상 존재(소스와 정확히 일치)");
  const mut = projSrc.replace(needle, '      if (crop && typeof MapCtrl !== "undefined" && MapCtrl.fitZone) MapCtrl.fitZone(crop, 0.14, 640);');
  ok(mut !== projSrc, "M1 치환 적중");
  const before = failed;
  const h = makeHarness(mut);
  const deck = { id: "dck_mukvctz3_kk0jinti", name: "ㅁㄴㅇ", deployment_id: "dep1", crop: CROP_A };
  await h.J.selectDeck(deck);
  const broke1 = h.calls.fitZone.length !== 0; // 옛 코드는 즉시 호출(이미지 미로드 상태에서도 불림)
  ok(broke1, `① 실패 재현: 이미지 로드 전인데도 fitZone ${h.calls.fitZone.length}회 호출(대기 없이 즉시 실행)`);
}

console.log("\n[뮤테이션 M2] 빠른 연속 전환 가드 제거 → ③실패해야 함");
{
  const needle = `        const doFit = () => {
          if (this.currentDeck && d && this.currentDeck.id !== d.id) return;
          if (MapCtrl.fitZone) MapCtrl.fitZone(crop, 0.14, 640);
        };`;
  ok(projSrc.includes(needle), "M2 대상 존재");
  const mut = projSrc.replace(needle, "        const doFit = () => { if (MapCtrl.fitZone) MapCtrl.fitZone(crop, 0.14, 640); };");
  ok(mut !== projSrc, "M2 치환 적중");
  const h = makeHarness(mut);
  const deckA = { id: "a", deployment_id: "depA", crop: CROP_A };
  const deckB = { id: "b", deployment_id: "depB", crop: CROP_B };
  await h.J.selectDeck(deckA);
  await h.J.selectDeck(deckB);
  h.fireImageLoad();
  const broke3 = h.calls.fitZone.length !== 1; // 가드 없으면 A·B 둘 다 적용되어 2회
  ok(broke3, `③ 실패 재현: 가드 없이 fitZone ${h.calls.fitZone.length}회(늦게 도착한 A 도 적용됨)`);
}

console.log("\n" + (failed ? `❌ FAIL: ${failed}건` : "✅ ALL PASS"));
process.exit(failed ? 1 : 0);
