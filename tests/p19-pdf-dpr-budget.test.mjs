/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p19-pdf-dpr-budget.test.mjs)
 *
 * 작업지시서(2026-09-17, WORK_ORDER_20260917_dpr.md) — PDF 캔버스 DPR·픽셀예산 전략 이식.
 * 출처: E:\code-project\PDF VIEW\260917\public\static\js\pdfCore.js:314~408
 *   - pickDpr()          (:331~347) → residentDpr()      로 이식
 *   - largePagePenalty() (:319~329) → pageWeightedPxCap() 로 이식
 * 본체 MIT. MuPDF(AGPL-3.0) 관련 코드는 이 구간에 없음(확인 완료, 순수 캔버스/DPR 산술만).
 *
 * 이식 1 — dpr 은 "전체 페이지 수" 가 아니라 "실제 상주(화면에 뜬) 페이지 수" 기준.
 * 이식 2 — 픽셀 예산은 "페이지 크기 무관 고정값" 이 아니라 대형 페이지일수록 보수적으로 가중.
 *
 * 실제 모듈 소스(02_PDF.js)를 그대로 vm 에 평가해 검사한다(목 구현 아님).
 * 뮤테이션 3건이 붙어 있어, 고친 코드를 되돌리면 해당 검사가 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const pdfSrc = rd("public/js/modules/02_PDF.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/** 02_PDF.js 를 샌드박스에 평가 → { PDF } (p11 과 동일한 로드 패턴) */
function load(pdfS = pdfSrc) {
  const State = { zoom: 1, pan: { x: 0, y: 0 }, isoView: false, isoDir: 0, mode: "designer", fileType: "pdf" };
  const sandbox = {
    console, State, Math, JSON, Promise, setTimeout, clearTimeout,
    document: { getElementById: () => null, createElement: () => ({ style: {}, getContext: () => null }) },
    navigator: { userAgent: "node", platform: "", maxTouchPoints: 0 },
    performance: { now: () => 0 }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(pdfS + "\n;globalThis.__PDF = PDF;", sandbox);
  return { PDF: sandbox.__PDF };
}

/* 실제 현장 규격 */
const A1 = { w: 2384, h: 1684 };   // 대형 도면(짧은 변 1684pt ≥ LARGE_PAGE_CAP_PT 900)
const A4 = { w: 595, h: 842 };     // 일반 도면(짧은 변 595pt < 900)

/* ────────────────────────────────────────────────────────────
 * 1) 상주 페이지 기준 dpr — 100장 중 1장만 떠 있으면 깎이지 않는다
 * ──────────────────────────────────────────────────────────── */
function suiteResidentDpr(label, P) {
  console.log("\n[" + label + "]");
  const cap = P.CANVAS_PX_DESKTOP;
  const oneResident = P.residentDpr({ pageW: A4.w, pageH: A4.h, pxCap: cap, residentPages: 1, devicePixelRatio: 2 });
  ok(oneResident === 2, `100장짜리 PDF 라도 상주 1장(A4) → dpr 안 깎임 = ${oneResident} (기대 2)`);

  // 30장이 "동시에" 상주한다고 가정하면(가상 시나리오) 같은 페이지·같은 예산에서 dpr 이 낮아져야 한다.
  const manyResident = P.residentDpr({ pageW: A4.w, pageH: A4.h, pxCap: cap, residentPages: 30, devicePixelRatio: 2 });
  ok(manyResident < oneResident, `상주 30장 → dpr(${manyResident.toFixed(3)}) < 상주 1장 dpr(${oneResident}) (예산을 나눠 씀)`);
  ok(manyResident >= 1, `dpr 하한 1 보장(그 아래는 육안 열화) = ${manyResident.toFixed(3)}`);

  // 대형 페이지(A1)는 같은 상주 1장이어도 A4보다 dpr 여유가 적을 수 있다(페이지당 픽셀이 크므로).
  const a1One = P.residentDpr({ pageW: A1.w, pageH: A1.h, pxCap: cap, residentPages: 1, devicePixelRatio: 2 });
  ok(a1One <= oneResident, `A1 상주 1장 dpr(${a1One.toFixed(3)}) ≤ A4 상주 1장 dpr(${oneResident}) (페이지가 클수록 보수적)`);
}

/* ────────────────────────────────────────────────────────────
 * 2) 대형 페이지 가중 픽셀 예산 — A1 이 A4 보다 더 보수적으로 산정된다
 * ──────────────────────────────────────────────────────────── */
function suiteLargePageBudget(label, P) {
  console.log("\n[" + label + "]");
  const cap = P.CANVAS_PX_DESKTOP;
  const a4Cap = P.pageWeightedPxCap(A4.w, A4.h, cap);
  const a1Cap = P.pageWeightedPxCap(A1.w, A1.h, cap);
  ok(a4Cap === cap, `A4(일반 도면) → 가중 없음, 예산 그대로 = ${a4Cap} (기대 ${cap})`);
  ok(a1Cap < a4Cap, `A1(대형 도면) 예산(${a1Cap}) < A4 예산(${a4Cap}) — 대형 페이지일수록 보수적`);
  ok(a1Cap >= cap * P.LARGE_PAGE_MIN_WEIGHT - 1, `A1 예산이 하한(${(cap * P.LARGE_PAGE_MIN_WEIGHT).toFixed(0)}) 이상 = ${a1Cap}`);

  // effectivePxCap = canvasPxCap + pageWeightedPxCap 합성 진입점(clampScale 3개 호출부가 공유)
  const eff = P.effectivePxCap({ mobile: false, deviceMemory: 8 }, A1.w, A1.h);
  ok(eff === a1Cap, `effectivePxCap(A1) 가 pageWeightedPxCap 결과와 일치 = ${eff}`);
}

/* ────────────────────────────────────────────────────────────
 * 3) 🔴 상한을 절대 넘지 않는다 (가장 중요) — 모바일 16.7M / 데스크톱 40M
 * ──────────────────────────────────────────────────────────── */
function suiteNeverExceedsCap(label, P) {
  console.log("\n[" + label + "]");
  for (const size of [A4, A1, { w: 5000, h: 5000 }]) {
    const mobCap = P.effectivePxCap({ mobile: true }, size.w, size.h);
    const deskCap = P.effectivePxCap({ mobile: false, deviceMemory: 8 }, size.w, size.h);
    ok(mobCap <= P.CANVAS_PX_MOBILE, `모바일 예산(${size.w}x${size.h}) ${mobCap} ≤ ${P.CANVAS_PX_MOBILE}`);
    ok(deskCap <= P.CANVAS_PX_DESKTOP, `데스크톱 예산(${size.w}x${size.h}) ${deskCap} ≤ ${P.CANVAS_PX_DESKTOP}`);
    // clampScale 로 실제 렌더된 면적도 상한을 넘지 않아야 한다(끝단 확인).
    const rs = P.clampScale(99, size.w, size.h, deskCap, P.MAX_SIDE_HARD);
    const actualPx = (size.w * rs) * (size.h * rs);
    ok(actualPx <= P.CANVAS_PX_DESKTOP + 1, `실제 렌더 면적(${Math.round(actualPx)}) ≤ ${P.CANVAS_PX_DESKTOP}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 4) deviceMemory ≤ 4GB → 모바일 상한 강등 (기존 동작 보존, 비회귀)
 * ──────────────────────────────────────────────────────────── */
function suiteLowMemoryPreserved(label, P) {
  console.log("\n[" + label + "]");
  ok(P.canvasPxCap({ mobile: false, deviceMemory: 4 }) === P.CANVAS_PX_MOBILE,
    "저사양 데스크톱(4GB) → 모바일 상한으로 강등(기존 동작 유지)");
  ok(P.canvasPxCap({ mobile: false, deviceMemory: 8 }) === P.CANVAS_PX_DESKTOP,
    "8GB 데스크톱 → 데스크톱 상한 유지(비회귀)");
}

{
  const { PDF } = load();
  suiteResidentDpr("정상", PDF);
  suiteLargePageBudget("정상", PDF);
  suiteNeverExceedsCap("정상", PDF);
  suiteLowMemoryPreserved("정상", PDF);
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 1 (이식 1 증명): 상주 페이지 기준을 "전체 페이지 수" 기준으로 되돌리면
 *   1장만 상주해도 매개변수로 총 페이지 수가 들어오는 구 방식이 되어, 상주=1 케이스의
 *   "안 깎임" 보장이 깨져야 한다 — residentPages 를 그대로 버리고 항상 30 취급.
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션1] residentPages 무시하고 항상 30(전체 페이지 수 취급) → 1) 이 실패해야 함");
  const needle = "const resident = Math.max(1, opt.residentPages || 1);";
  const mutated = pdfSrc.replace(needle, "const resident = 30;");
  if (mutated === pdfSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PDF } = load(mutated);
    const cap = PDF.CANVAS_PX_DESKTOP;
    const oneResident = PDF.residentDpr({ pageW: A4.w, pageH: A4.h, pxCap: cap, residentPages: 1, devicePixelRatio: 2 });
    ok(oneResident !== 2,
      `뮤테이션 적용 시 상주 1장인데도 dpr 이 깎임(테스트 실효성 증명) → ${oneResident.toFixed(3)} (정상이면 2 여야 하는데 아님)`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 2 (이식 2 증명): 대형 페이지 가중을 제거(항상 cap 그대로 반환)하면
 *   A1 예산이 A4 와 같아져야(=보수적으로 줄지 않아야) 한다.
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션2] 대형 페이지 가중 제거(항상 cap 반환) → 2) 가 실패해야 함");
  const needle = "if (Math.max(w, h) < this.LARGE_PAGE_CAP_PT) return cap;";
  const mutated = pdfSrc.replace(needle, "return cap;");
  if (mutated === pdfSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PDF } = load(mutated);
    const cap = PDF.CANVAS_PX_DESKTOP;
    const a4Cap = PDF.pageWeightedPxCap(A4.w, A4.h, cap);
    const a1Cap = PDF.pageWeightedPxCap(A1.w, A1.h, cap);
    ok(a1Cap === a4Cap,
      `뮤테이션 적용 시 A1 예산이 A4 와 동일(가중 소실, 테스트 실효성 증명) → a1=${a1Cap}, a4=${a4Cap}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 3 (상한 불변 증명): pageWeightedPxCap 이 실수로 cap 을 "올리는" 방향으로
 *   바뀌면(가중치를 배수로 적용) 상한 초과 검사(3)가 실패해야 한다.
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션3] pageWeightedPxCap 이 cap 을 올리도록 변형 → 3) 이 실패해야 함");
  const needle = "return Math.min(cap, cap * weight);";
  const mutated = pdfSrc.replace(needle, "return cap * 3;");
  if (mutated === pdfSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PDF } = load(mutated);
    const deskCap = PDF.effectivePxCap({ mobile: false, deviceMemory: 8 }, A1.w, A1.h);
    ok(!(deskCap <= PDF.CANVAS_PX_DESKTOP),
      `뮤테이션 적용 시 A1 예산이 상한을 초과(테스트 실효성 증명) → ${deskCap} > ${PDF.CANVAS_PX_DESKTOP}`);
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
