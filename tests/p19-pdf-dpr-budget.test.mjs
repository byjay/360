/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p19-pdf-dpr-budget.test.mjs)
 *
 * [회귀수정 2026-09-28] 직전 커밋(0c5a7b6)의 pageWeightedPxCap()/LARGE_PAGE_SHARE_COUNT 는
 * "A1 이상 대형 페이지는 예산을 무조건 반으로 깎는다"였다 — 마스터 요구(대형 도면일수록
 * 해상도가 더 필요하다)와 정반대 방향이었고, 근거로 든 "base+crop 두 캔버스 동시 상주"도
 * 실제로는 renderCrop() 실행 중에만 성립하는데 평상시에도 무조건 적용돼 있었다.
 *
 * 새 설계: 유효예산(이 캔버스) = 전체예산 / 지금 실제로 동시에 화면에 떠 있는 캔버스 수.
 *   - 평상시(크롭 오버레이 없음) → 상주 1개 → 전체 예산 그대로 (페이지 크기 무관)
 *   - 크롭 오버레이 실존(renderCrop 실행 중) → 상주 2개 → 절반씩
 * 페이지 크기(A1/A4)는 더 이상 예산 산정에 쓰이지 않는다(YAGNI로 제거).
 *
 * 이식 1(residentDpr, 상주 페이지 수 기준 dpr) 은 그대로 유지 — pxCap 인자로
 * effectivePxCap() 결과를 받아 "동시 상주 캔버스 수 나누기" 를 동일하게 반영한다.
 * 출처: PDF VIEW°917 pdfCore.js:331-347 pickDpr() (MIT, 로직만 이식). 본 파일에
 * MuPDF(AGPL-3.0) 관련 코드는 없음(확인 완료, 순수 캔버스/DPR 산술만).
 *
 * 실제 모듈 소스(02_PDF.js)를 그대로 vm 에 평가해 검사한다(목 구현 아님).
 * 뮤테이션 2건이 붙어 있어, 고친 코드를 되돌리면 해당 검사가 실패한다.
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
const A1 = { w: 2384, h: 1684 };   // 대형 도면
const A4 = { w: 595, h: 842 };     // 일반 도면

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

  // A1 은 같은 상주 1장·같은 pxCap 이어도 페이지당 픽셀이 커서 dpr 여유가 A4 이하일 수 있다.
  const a1One = P.residentDpr({ pageW: A1.w, pageH: A1.h, pxCap: cap, residentPages: 1, devicePixelRatio: 2 });
  ok(a1One <= oneResident, `A1 상주 1장 dpr(${a1One.toFixed(3)}) ≤ A4 상주 1장 dpr(${oneResident})`);
}

/* ────────────────────────────────────────────────────────────
 * 2) 🔴 핵심 회귀 검사 — 평상시(크롭 없음) A1 은 A4 와 "같은" 전체 예산을 받는다.
 *    페이지 크기로 깎지 않는다(0c5a7b6 회귀의 반대 방향 확인).
 * ──────────────────────────────────────────────────────────── */
function suiteNoPageSizePenalty(label, P) {
  console.log("\n[" + label + "]");
  const env = { mobile: false, deviceMemory: 8 };
  const cap = P.CANVAS_PX_DESKTOP;
  // residentCanvasCount 생략(기본값 1) = 평상시(크롭 오버레이 없음)
  const a4Normal = P.effectivePxCap(env, 1);
  const a1Normal = P.effectivePxCap(env, 1);
  ok(a4Normal === cap, `A4 평상시 예산 = 전체 예산 그대로 = ${a4Normal} (기대 ${cap})`);
  ok(a1Normal === cap, `A1 평상시 예산 = 전체 예산 그대로(절반 아님) = ${a1Normal} (기대 ${cap}) — 회귀 핵심 검사`);
  ok(a1Normal === a4Normal, `A1·A4 가 같은 상주 조건(1개)에서 같은 예산을 받는다 = ${a1Normal} === ${a4Normal}`);

  const mobCap = P.CANVAS_PX_MOBILE;
  ok(P.effectivePxCap({ mobile: true }, 1) === mobCap, `모바일 평상시 예산도 전체 예산 그대로 = ${mobCap}`);
}

/* ────────────────────────────────────────────────────────────
 * 3) 크롭 오버레이 실존(상주 2개) → 예산이 절반으로 — 메모리 안전은 유지된다.
 * ──────────────────────────────────────────────────────────── */
function suiteCropHalvesBudget(label, P) {
  console.log("\n[" + label + "]");
  const env = { mobile: false, deviceMemory: 8 };
  const cap = P.CANVAS_PX_DESKTOP;
  const withCrop = P.effectivePxCap(env, 2);
  ok(withCrop === cap / 2, `크롭 실존(상주 2개) 예산 = 전체의 절반 = ${withCrop} (기대 ${cap / 2})`);
  ok(withCrop < P.effectivePxCap(env, 1), `크롭 실존 예산(${withCrop}) < 평상시 예산(${P.effectivePxCap(env, 1)})`);
}

/* ────────────────────────────────────────────────────────────
 * 4) 🔴 상한을 절대 넘지 않는다 (가장 중요) — 모바일 16.7M / 데스크톱 40M
 * ──────────────────────────────────────────────────────────── */
function suiteNeverExceedsCap(label, P) {
  console.log("\n[" + label + "]");
  for (const size of [A4, A1, { w: 5000, h: 5000 }]) {
    for (const residentCanvasCount of [1, 2]) {
      const mobCap = P.effectivePxCap({ mobile: true }, residentCanvasCount);
      const deskCap = P.effectivePxCap({ mobile: false, deviceMemory: 8 }, residentCanvasCount);
      ok(mobCap <= P.CANVAS_PX_MOBILE, `모바일 예산(resident=${residentCanvasCount}) ${mobCap} ≤ ${P.CANVAS_PX_MOBILE}`);
      ok(deskCap <= P.CANVAS_PX_DESKTOP, `데스크톱 예산(resident=${residentCanvasCount}) ${deskCap} ≤ ${P.CANVAS_PX_DESKTOP}`);
      // clampScale 로 실제 렌더된 면적도 상한을 넘지 않아야 한다(끝단 확인).
      const rs = P.clampScale(99, size.w, size.h, deskCap, P.MAX_SIDE_HARD);
      const actualPx = (size.w * rs) * (size.h * rs);
      ok(actualPx <= deskCap + 1, `실제 렌더 면적(${Math.round(actualPx)}) ≤ ${deskCap}`);
    }
  }
}

/* ────────────────────────────────────────────────────────────
 * 5) deviceMemory ≤ 4GB → 모바일 상한 강등 (기존 동작 보존, 비회귀)
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
  suiteNoPageSizePenalty("정상", PDF);
  suiteCropHalvesBudget("정상", PDF);
  suiteNeverExceedsCap("정상", PDF);
  suiteLowMemoryPreserved("정상", PDF);
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 1 (회귀 재발 방지): effectivePxCap 이 다시 "상주 수 무시하고 항상 절반" 으로
 *   바뀌면(옛 pageWeightedPxCap 식 고정 삭감) 평상시(resident=1) A1 예산이 전체 예산이어야
 *   하는 검사가 실패해야 한다.
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션1] effectivePxCap 이 상주 수 무시하고 항상 절반 반환(회귀 재발) → 2) 가 실패해야 함");
  const needle = "const n = Math.max(1, residentCanvasCount || 1);\n      return this.canvasPxCap(env) / n;";
  const mutated = pdfSrc.replace(needle, "return this.canvasPxCap(env) / 2;");
  if (mutated === pdfSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PDF } = load(mutated);
    const cap = PDF.CANVAS_PX_DESKTOP;
    const a1Normal = PDF.effectivePxCap({ mobile: false, deviceMemory: 8 }, 1);
    ok(a1Normal !== cap,
      `뮤테이션 적용 시 평상시(resident=1)인데도 예산이 반토막(테스트 실효성 증명) → ${a1Normal} (정상이면 ${cap} 이어야 하는데 아님)`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 2 (상한 불변 증명): effectivePxCap 이 실수로 상한을 "올리는" 방향으로
 *   바뀌면(나누기를 곱하기로) 상한 초과 검사(4)가 실패해야 한다.
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션2] effectivePxCap 이 상한을 올리도록 변형 → 4) 가 실패해야 함");
  const needle = "return this.canvasPxCap(env) / n;";
  const mutated = pdfSrc.replace(needle, "return this.canvasPxCap(env) * 3;");
  if (mutated === pdfSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PDF } = load(mutated);
    const deskCap = PDF.effectivePxCap({ mobile: false, deviceMemory: 8 }, 2);
    ok(!(deskCap <= PDF.CANVAS_PX_DESKTOP),
      `뮤테이션 적용 시 예산이 상한을 초과(테스트 실효성 증명) → ${deskCap} > ${PDF.CANVAS_PX_DESKTOP}`);
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
