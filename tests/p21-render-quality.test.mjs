/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p21-render-quality.test.mjs)
 *
 * 대상: .claude/WORK_ORDER_20260917_dpr.md — "화질 개선 2건".
 *
 * 건1(ISO 화질): 10_MapCtrl.js 는 이미 will-change:transform 을 "조작 중엔 유지, 조작이
 * 끝나면(설정된 idle 시간 후) auto 로 해제"하는 상태기계(_armWillChange/_scheduleSettle/
 * _markAnimating)를 갖고 있다(5996a22). 이 파일은 그 상태 전이(무장→유지→해제, 애니메이션
 * 중 재무장으로 조기 해제 방지)를 실제 소스를 vm 에 평가해 검증한다.
 * 🔴 정직 고지: 이 처리가 실제 브라우저에서 ISO 확대 화질을 회복시키는지는 라이브 렌더 픽셀
 * 비교가 필요해 이 세션(브라우저 미보유)에서는 [Uncertain] — 상태기계 자체의 정확성만 증명한다.
 *
 * 건2(뷰어 스냅샷 크롭): PDF.snapshotAllPages 에 deckCrop 인자(4번째, 기본 null)를 추가해
 * 구역(deck)에 crop 이 있으면 그 페이지만 PDF.deckSnapshotRect 로 잘라 렌더하고(같은 픽셀
 * 예산을 크롭 영역에 집중), crop 없는 페이지는 종전대로 전체 페이지를 렌더한다(비파괴).
 * [WP1·H7] 20_App.js 저장 경로는 이 크롭을 쓰지 않는다(창 구역 = 원본과 같은 행 → 원본 파괴였다).
 * PDF.snapshotAllPages 의 deckCrop 인자 자체(모듈 기능)는 아래 test1~6 이 그대로 검증한다.
 *
 * 실제 모듈 소스(02_PDF.js/10_MapCtrl.js/20_App.js)를 그대로 vm 에 평가해 검사(목 구현 아님).
 * 뮤테이션 3건: 크롭 배선 제거→①실패 / NULL 폴백 제거→②실패 / will-change 해제 제거→⑨실패.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const pdfSrc = rd("public/js/modules/02_PDF.js");
const mapSrc = rd("public/js/modules/10_MapCtrl.js");
const appSrc = rd("public/js/modules/20_App.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ══════════════════════════════════════════════════════════════════
 * 헬퍼 — PDF 소스만 평가(snapshotAllPages 는 DOM/pdf.js 를 스텁으로 대체)
 * ══════════════════════════════════════════════════════════════════ */
function loadPDF(src = pdfSrc) {
  const sandbox = {
    console, Math, JSON, Promise,
    navigator: { userAgent: "node", platform: "", maxTouchPoints: 0 },
    document: {
      getElementById: () => null,
      createElement: (tag) => {
        if (tag !== "canvas") return { style: {} };
        const cv = { width: 0, height: 0, style: {} };
        cv.getContext = () => ({ fillStyle: "", fillRect() {}, __cv: cv });
        cv.toDataURL = (mime) => {
          // 데이터 길이를 픽셀 수에 비례시켜 SOFT_LIMIT 강등 로직이 실제로 작동하게 한다.
          const n = Math.max(1, Math.round(cv.width * cv.height / 500));
          return "data:" + mime + ";base64," + "A".repeat(Math.min(n, 500));
        };
        return cv;
      }
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__PDF = PDF;", sandbox);
  return sandbox.__PDF;
}

/** pdf.js 페이지 스텁 — getViewport/render 호출을 calls[] 에 기록 */
function makeFakePage(baseW, baseH, calls) {
  return {
    getViewport({ scale }) { return { width: baseW * scale, height: baseH * scale }; },
    render({ canvasContext, viewport, transform }) {
      calls.push({
        scale: viewport.width / baseW,
        transform: transform || null,
        canvasW: canvasContext.__cv.width,
        canvasH: canvasContext.__cv.height
      });
      return { promise: Promise.resolve() };
    }
  };
}

function makeFakeDoc(pages, calls) {
  return {
    numPages: pages.length,
    getPage: async (p) => makeFakePage(pages[p - 1].w, pages[p - 1].h, calls)
  };
}

const A1 = { w: 2384, h: 1684 };
const CROP_PCT = { x: 10, y: 20, w: 20, h: 20 }; // % — 페이지의 20%×20%만 사용

/* ══════════════════════════════════════════════════════════════════
 * ① crop 있는 구역 → 렌더 대상이 크롭 영역과 일치(오프셋 transform 사용)
 * ══════════════════════════════════════════════════════════════════ */
async function test1_cropMatchesRect(PDF) {
  console.log("\n[test1] crop 있는 페이지 → 렌더 오프셋이 deckSnapshotRect 와 일치");
  const calls = [];
  const doc = makeFakeDoc([A1], calls);
  const rectExpect = PDF.deckSnapshotRect(CROP_PCT, A1.w, A1.h);
  await PDF.snapshotAllPages(doc, 800, 0.92, { page: 1, crop: CROP_PCT });
  ok(calls.length >= 1, "render 호출 발생");
  const c = calls[calls.length - 1]; // SOFT_LIMIT 강등 루프 채택 시도(마지막 = 최종 채택)
  ok(!!c.transform, "크롭 페이지는 transform 오프셋을 사용(전면 렌더와 구분됨)");
  const expX = -Math.round(rectExpect.x0 * c.scale), expY = -Math.round(rectExpect.y0 * c.scale);
  ok(c.transform && c.transform[4] === expX && c.transform[5] === expY,
    `transform 오프셋 [-${expX},-${expY}] 과 일치(실제 ${JSON.stringify(c.transform)})`);
  ok(Math.abs(c.canvasW - Math.round(rectExpect.w0 * c.scale)) <= 1 &&
     Math.abs(c.canvasH - Math.round(rectExpect.h0 * c.scale)) <= 1,
    "캔버스 크기 = 크롭 영역×스케일(페이지 전체 크기 아님)");
}

/* ══════════════════════════════════════════════════════════════════
 * ② crop 없으면 전체 페이지(종전 동작) — transform 오프셋 없음
 * ══════════════════════════════════════════════════════════════════ */
async function test2_noCropFullPage(PDF) {
  console.log("\n[test2] crop 없음 → 종전대로 전체 페이지 렌더(오프셋 없음)");
  const calls = [];
  const doc = makeFakeDoc([A1], calls);
  await PDF.snapshotAllPages(doc, 800, 0.92, null);
  const c = calls[calls.length - 1];
  ok(!c.transform, "crop 없으면 transform 오프셋 없음(전면 렌더 그대로)");
  ok(Math.abs(c.canvasW - Math.round(A1.w * c.scale)) <= 1, "캔버스 폭 = 전체 페이지×스케일");

  // 4번째 인자를 아예 생략(구버전 3-인자 호출 — 다른 호출부 하위호환)
  const calls2 = [];
  const doc2 = makeFakeDoc([A1], calls2);
  await PDF.snapshotAllPages(doc2, 800, 0.92);
  ok(!calls2[calls2.length - 1].transform, "deckCrop 인자 생략(구버전 3-인자 호출)도 종전대로 전체 페이지");
}

/* ══════════════════════════════════════════════════════════════════
 * ③ 원본 불변 — source_meta/State.pdfDoc 등 원본 경로는 이 함수가 건드리지 않음
 * ══════════════════════════════════════════════════════════════════ */
function test3_sourceUntouched() {
  console.log("\n[test3] 원본 불변 — snapshotAllPages/새 배선이 source_meta·원본 PDF 경로를 건드리지 않음");
  ok(!/source_meta/.test(pdfSrc), "02_PDF.js 는 source_meta 를 참조하지 않음(원본 메타는 20_App.js 저장 경로 전용)");
  ok(/if \(sourceMeta\) body\.source_meta = sourceMeta;/.test(appSrc),
    "_buildSavePayload 는 source_meta 를 있을 때만 그대로 실어 보냄(값 가공 없음 — 원본 참조 불변)");
}

/* ══════════════════════════════════════════════════════════════════
 * ④ 픽셀 예산 상한 초과 안 함 — 아주 작은 crop 도 scale ≤ 4(기존 안전장치 그대로)
 * ══════════════════════════════════════════════════════════════════ */
async function test4_pixelBudgetCapped(PDF) {
  console.log("\n[test4] 초소형 crop 도 scale ≤ 4(기존 상한 유지, 무한 확대 방지)");
  const calls = [];
  const tinyCrop = { x: 49, y: 49, w: 1, h: 1 }; // 페이지의 1%×1%
  const doc = makeFakeDoc([A1], calls);
  await PDF.snapshotAllPages(doc, 4096, 0.92, { page: 1, crop: tinyCrop });
  ok(calls.every((c) => c.scale <= 4 + 1e-9), `모든 시도의 scale ≤ 4 (실제 최대 ${Math.max(...calls.map(c=>c.scale)).toFixed(3)})`);
}

/* ══════════════════════════════════════════════════════════════════
 * ⑤ 여러 페이지 중 지정된 페이지만 크롭되고 나머지는 영향 없음
 * ══════════════════════════════════════════════════════════════════ */
async function test5_onlyTargetPageCropped(PDF) {
  console.log("\n[test5] 여러 페이지 중 deckCrop.page 로 지정한 페이지만 크롭됨");
  const calls1 = [], calls2 = [];
  const doc = { numPages: 2, getPage: async (p) => p === 1 ? makeFakePage(A1.w, A1.h, calls1) : makeFakePage(A1.w, A1.h, calls2) };
  await PDF.snapshotAllPages(doc, 800, 0.92, { page: 2, crop: CROP_PCT });
  ok(!calls1[calls1.length - 1].transform, "1페이지(대상 아님)는 전체 페이지 그대로");
  ok(!!calls2[calls2.length - 1].transform, "2페이지(deckCrop.page)만 크롭 오프셋 적용");
}

/* ══════════════════════════════════════════════════════════════════
 * ⑥ dims(px.pw/ph) — 크롭 페이지는 크롭 크기, 비크롭 페이지는 전체 페이지 크기로 기록
 * ══════════════════════════════════════════════════════════════════ */
async function test6_dimsReflectCrop(PDF) {
  console.log("\n[test6] lastSnapshotDims(px.pw/ph) 가 크롭 페이지는 크롭 크기를 기록");
  const calls = [];
  const doc = makeFakeDoc([A1], calls);
  const rectExpect = PDF.deckSnapshotRect(CROP_PCT, A1.w, A1.h);
  await PDF.snapshotAllPages(doc, 800, 0.92, { page: 1, crop: CROP_PCT });
  const dims = PDF.lastSnapshotDims;
  ok(!!dims && dims[0].pw === Math.round(rectExpect.w0) && dims[0].ph === Math.round(rectExpect.h0),
    `dims[0] = ${JSON.stringify(dims && dims[0])} (기대 pw=${Math.round(rectExpect.w0)}, ph=${Math.round(rectExpect.h0)})`);
}

/* ══════════════════════════════════════════════════════════════════
 * ⑦ 배선 — 20_App.js 가 _currentDeckCrop/pageToDeckCropPct 를 실제로 사용
 * ══════════════════════════════════════════════════════════════════ */
function test7_wiring() {
  // [WP1·H7] 반전: 창(crop) 구역은 원본과 같은 배포본 행이라, 저장 스냅샷을 크롭하고 핀을 크롭 기준 %로 바꾸면
  //   원본 행의 이미지가 잘리고 크롭 밖 핀이 지워졌다. 저장은 항상 전체 페이지·페이지 기준 %(행동 검증: p25 test5·p93).
  console.log("\n[test7] 배선: 저장 스냅샷(_snapshotPages)은 구역 크롭을 전달하지 않고, 핀 좌표도 재배치하지 않음");
  ok(/return await PDF\.snapshotAllPages\(State\.pdfDoc\);/.test(appSrc),
    "_snapshotPages 는 PDF.snapshotAllPages(State.pdfDoc) — 구역 crop 인자 없음(전체 페이지)");
  ok(!/pageToDeckCropPct/.test(appSrc), "_buildSavePayload 가 핀 좌표를 크롭 기준으로 재매핑하지 않음");
  ok(!/if \(!mapped\) return null;/.test(appSrc), "크롭 밖 핀을 저장에서 제외하는 null 필터 없음");
}

/* ══════════════════════════════════════════════════════════════════
 * 건1 — will-change 상태기계: 조작 중 유지, idle 후 해제, 애니메이션 중 재무장으로 조기해제 방지
 * ══════════════════════════════════════════════════════════════════ */
function loadMap(src = mapSrc) {
  const timers = []; let nextId = 1; const nowBox = { t: 0 };
  const sandbox = {
    console, Math, JSON,
    State: { zoom: 1, pan: { x: 0, y: 0 }, isoView: false, isoDir: 0, panDragging: false, mode: "designer", fileType: "pdf" },
    document: { getElementById: () => null, createElement: () => ({ style: {}, getContext: () => null }) },
    navigator: { userAgent: "node" },
    performance: { now: () => nowBox.t },
    setTimeout: (fn, ms) => { const id = nextId++; timers.push({ id, at: nowBox.t + ms, fn }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__MAP = MapCtrl;", sandbox);
  const MapCtrl = sandbox.__MAP;
  const fakeClassList = () => ({ toggle() {}, add() {}, remove() {} });
  const transform = { style: {}, offsetWidth: 100, offsetHeight: 100, classList: fakeClassList() };
  const viewport = { clientWidth: 100, clientHeight: 100, classList: fakeClassList() };
  MapCtrl.init(viewport, transform);
  // applyTransform 이 참조하는 선택적 전역들 — 없어도 안전하게 no-op
  return {
    MapCtrl, transform, State: sandbox.State,
    advance(ms) {
      nowBox.t += ms;
      // due 순서대로, 재등록(re-schedule)도 반영되도록 반복 처리
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (let i = 0; i < timers.length; i++) {
          if (timers[i].at <= nowBox.t) {
            const t = timers.splice(i, 1)[0];
            t.fn();
            progressed = true;
            break;
          }
        }
      }
    }
  };
}

function test8_willChangeIdleRelease() {
  console.log("\n[test8] will-change: 조작 후 idle 이 지나면 'auto' 로 해제");
  const { MapCtrl, transform, advance } = loadMap();
  MapCtrl.applyTransform(); // 일반 팬/줌(비-ISO) — _scheduleSettle 무장
  ok(transform.style.willChange === "transform", "직후에는 will-change 유지(성능 우선)");
  advance(MapCtrl.SETTLE_IDLE_MS + 10);
  ok(transform.style.willChange === "auto", "idle 시간 경과 후 'auto' 로 해제(재래스터화 유도)");
}

function test9_willChangeStaysDuringIsoAnimation() {
  console.log("\n[test9] will-change: ISO 전환(1s 애니메이션) 중에는 조기 해제되지 않음");
  const { MapCtrl, transform, State, advance } = loadMap();
  MapCtrl.toggleIso(); // ISO 진입 → _applyIso() → _markAnimating(1010) → applyTransform()
  ok(State.isoView === true, "ISO 진입됨");
  ok(transform.style.willChange === "transform", "전환 시작 직후 will-change 유지");
  advance(200); // 기본 idle(180ms) 만 지났지만 애니메이션(1010ms)은 안 끝남
  ok(transform.style.willChange === "transform",
    "애니메이션 진행 중에는 idle 타이머만으론 해제 안 됨(성능 저하·깜빡임 방지)");
  advance(1100); // 애니메이션 종료 + idle 여유
  ok(transform.style.willChange === "auto", "애니메이션 완전 종료 후에는 결국 'auto' 로 해제");
}

function test10_reArmDuringDrag() {
  console.log("\n[test10] will-change: 드래그(panDragging) 중이면 idle 타이머가 재스케줄되어 해제 안 됨");
  const { MapCtrl, transform, State, advance } = loadMap();
  MapCtrl.applyTransform();
  State.panDragging = true;
  advance(MapCtrl.SETTLE_IDLE_MS + 10); // 원래라면 여기서 해제될 시점
  ok(transform.style.willChange === "transform", "panDragging=true 인 동안은 해제되지 않고 재스케줄됨");
  State.panDragging = false;
  advance(MapCtrl.SETTLE_IDLE_MS + 10);
  ok(transform.style.willChange === "auto", "드래그 종료 후에는 정상적으로 'auto' 로 해제");
}

/* ══════════════════════════════════════════════════════════════════
 * 실행
 * ══════════════════════════════════════════════════════════════════ */
console.log("=== 회귀: 화질 개선 2건(ISO will-change 해제 + 뷰어 스냅샷 크롭) ===");
(async () => {
  {
    const PDF = loadPDF();
    await test1_cropMatchesRect(PDF);
    await test2_noCropFullPage(PDF);
    test3_sourceUntouched();
    await test4_pixelBudgetCapped(PDF);
    await test5_onlyTargetPageCropped(PDF);
    await test6_dimsReflectCrop(PDF);
    test7_wiring();
  }
  test8_willChangeIdleRelease();
  test9_willChangeStaysDuringIsoAnimation();
  test10_reArmDuringDrag();

  /* ════════════════════════════════════════════════════════════════
   * 뮤테이션 ① — 크롭 배선 제거(isCropPage 를 항상 false 로) → test1 실패해야 함
   * ════════════════════════════════════════════════════════════════ */
  console.log("\n[뮤테이션①] 크롭 스냅샷 배선 제거 → test1 이 실패해야 함");
  {
    const needle = 'const isCropPage = !!(deckCrop && (deckCrop.page || 1) === p && deckCrop.crop);';
    const mutated = pdfSrc.replace(needle, 'const isCropPage = false;');
    if (mutated === pdfSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
    else {
      const PDF = loadPDF(mutated);
      const calls = [];
      const doc = makeFakeDoc([A1], calls);
      await PDF.snapshotAllPages(doc, 800, 0.92, { page: 1, crop: CROP_PCT });
      const c = calls[calls.length - 1];
      ok(!c.transform, "뮤테이션 적용 시 크롭 페이지도 transform 오프셋 없이 렌더됨(=test1 실패 재현, 테스트 실효성 증명)");
    }
  }

  /* ════════════════════════════════════════════════════════════════
   * 뮤테이션 ② — NULL 폴백 제거(deckCrop 없어도 항상 rect 계산 강제) → test2 실패해야 함
   * ════════════════════════════════════════════════════════════════ */
  console.log("\n[뮤테이션②] NULL 폴백 제거(항상 마지막 crop 값 사용) → test2 가 실패해야 함");
  {
    const needle = '        const isCropPage = !!(deckCrop && (deckCrop.page || 1) === p && deckCrop.crop);\n        const rect = isCropPage ? this.deckSnapshotRect(deckCrop.crop, base.width, base.height)\n                                 : { x0: 0, y0: 0, w0: base.width, h0: base.height };';
    const forcedCrop = { x: 10, y: 20, w: 20, h: 20 };
    const mutated = pdfSrc.replace(needle,
      `        const isCropPage = true;\n        const rect = this.deckSnapshotRect(${JSON.stringify(forcedCrop)}, base.width, base.height);`);
    if (mutated === pdfSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
    else {
      const PDF = loadPDF(mutated);
      const calls = [];
      const doc = makeFakeDoc([A1], calls);
      await PDF.snapshotAllPages(doc, 800, 0.92, null); // crop 없음(NULL) 인데도
      const c = calls[calls.length - 1];
      ok(!!c.transform, "뮤테이션 적용 시 crop=null 인데도 크롭 렌더가 강제됨(=test2 실패 재현, 테스트 실효성 증명)");
    }
  }

  /* ════════════════════════════════════════════════════════════════
   * 뮤테이션 ③ — will-change idle 해제 로직 제거 → test8 실패해야 함
   * ════════════════════════════════════════════════════════════════ */
  console.log("\n[뮤테이션③] _scheduleSettle 호출 제거(applyTransform 에서) → test8 이 실패해야 함");
  {
    const needle = '      this._scheduleSettle();\n    },\n\n    /* ── 확대 종료 후 화질 수렴(settle) ──────────────────────────────────';
    const mutated = mapSrc.replace(needle, '    },\n\n    /* ── 확대 종료 후 화질 수렴(settle) ──────────────────────────────────');
    if (mutated === mapSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
    else {
      const { MapCtrl, transform, advance } = loadMap(mutated);
      MapCtrl.applyTransform();
      advance(2000);
      ok(transform.style.willChange !== "auto", "뮤테이션 적용 시 will-change 가 영원히 해제되지 않음(=test8 실패 재현, 테스트 실효성 증명)");
    }
  }

  console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
  process.exit(failed === 0 ? 0 : 1);
})();
