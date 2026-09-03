/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p11-pdf-zoom-quality.test.mjs)
 *
 * 마스터 지시(2026-09-03): "클릭했을때 화질이 너무깨지는데" — 구역을 클릭해 확대한 ISO 화면에서
 * 도면 선이 번지고 글자가 판독 불가.
 *
 * 근본원인(코드 산술로 확정):
 *   전면 캔버스 한 장이 페이지 전체를 담아야 하는데 면적 상한이 전 기기 공통 16.7M px 였다.
 *   A1(2384×1684pt) → 상한 렌더배율 √(16.7M/4.01M) ≈ 2.04.
 *   retina(dpr2) 에서 첫 렌더가 이미 1.5×2 = 3.0 → 2.04 로 클램프 = **시작부터 상한**.
 *   이후 확대하면 재렌더 임계(1.15)는 통과하지만 결과가 다시 2.04 로 잘려
 *   화질은 1도 안 오르고 대형 PDF 재렌더만 반복했다.
 *
 * 검사:
 *   A 기기별 캔버스 면적 상한(모바일/저사양 보호)
 *   B 상한 클램프 산술
 *   C 🔴 이득 없는 재렌더를 하지 않는다(성능 보호) + 상한에 막히면 크롭 경로로 간다
 *   D 확대 종료 시 목표 스케일 = 실제 화면 배율(줌×dpr), 그리고 절대 상한을 넘지 않는다
 *   E 크게 축소하면 과잉 해상도 캔버스를 회수한다(메모리)
 *   F 보이는 도면 영역 산출(평면·ISO·퇴화 입력)
 *
 * 실제 모듈 소스(02_PDF.js / 10_MapCtrl.js)를 그대로 vm 에 평가해 검사한다(목 구현 아님).
 * 뮤테이션 3건이 붙어 있어, 고친 코드를 되돌리면 해당 검사가 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const pdfSrc = rd("public/js/modules/02_PDF.js");
const mapSrc = rd("public/js/modules/10_MapCtrl.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

/** 두 모듈을 한 샌드박스에 평가 → { PDF, MapCtrl, State } */
function load(pdfS = pdfSrc, mapS = mapSrc) {
  const State = { zoom: 1, pan: { x: 0, y: 0 }, isoView: false, isoDir: 0, mode: "designer", fileType: "pdf" };
  const sandbox = {
    console, State, Math, JSON, Promise, setTimeout, clearTimeout,
    document: { getElementById: () => null, createElement: () => ({ style: {}, getContext: () => null }) },
    navigator: { userAgent: "node", platform: "", maxTouchPoints: 0 },
    performance: { now: () => 0 }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(pdfS + "\n" + mapS + "\n;globalThis.__PDF = PDF; globalThis.__MAP = MapCtrl;", sandbox);
  return { PDF: sandbox.__PDF, MapCtrl: sandbox.__MAP, State };
}

/* 실제 현장 규격: A1 가로 도면(2384×1684pt) — 씨스타 엔지니어링 도면의 대표 크기 */
const A1 = { w: 2384, h: 1684 };
const A4 = { w: 595, h: 842 };

/* ────────────────────────────────────────────────────────────
 * A. 기기별 캔버스 면적 상한
 * ──────────────────────────────────────────────────────────── */
function suiteCap(label, P) {
  console.log("\n[" + label + "]");
  ok(P.canvasPxCap({ mobile: true, deviceMemory: 8 }) === P.CANVAS_PX_MOBILE,
    `모바일 → ${P.canvasPxCap({ mobile: true })} (기대 ${P.CANVAS_PX_MOBILE} · iOS 캔버스 하드 제한)`);
  ok(P.canvasPxCap({ mobile: false, deviceMemory: 8 }) === P.CANVAS_PX_DESKTOP,
    `데스크톱(8GB) → ${P.canvasPxCap({ mobile: false, deviceMemory: 8 })} (기대 ${P.CANVAS_PX_DESKTOP})`);
  ok(P.canvasPxCap({ mobile: false, deviceMemory: 4 }) === P.CANVAS_PX_MOBILE,
    "저사양(deviceMemory 4GB) → 모바일 상한으로 강등(메모리 보호)");
  ok(P.canvasPxCap({}) === P.CANVAS_PX_DESKTOP, "정보 없음 → 데스크톱 상한(기본)");
}

/* ────────────────────────────────────────────────────────────
 * B. 상한 클램프 산술
 * ──────────────────────────────────────────────────────────── */
function suiteClamp(label, P) {
  console.log("\n[" + label + "]");
  const mob = P.clampScale(99, A1.w, A1.h, P.CANVAS_PX_MOBILE, P.MAX_SIDE_HARD);
  const desk = P.clampScale(99, A1.w, A1.h, P.CANVAS_PX_DESKTOP, P.MAX_SIDE_HARD);
  ok(near(mob, Math.sqrt(P.CANVAS_PX_MOBILE / (A1.w * A1.h)), 1e-6), `A1 모바일 상한 배율 = ${mob.toFixed(4)} (면적 상한)`);
  ok(near(desk, Math.sqrt(P.CANVAS_PX_DESKTOP / (A1.w * A1.h)), 1e-6), `A1 데스크톱 상한 배율 = ${desk.toFixed(4)}`);
  ok(desk > mob * 1.5, `데스크톱이 모바일보다 ${(desk / mob).toFixed(2)}배 선명 (근본원인 완화)`);
  // 한 변 하드 상한도 반드시 지킨다 (A4 는 면적보다 변이 먼저 걸린다)
  const a4 = P.clampScale(99, A4.w, A4.h, P.CANVAS_PX_DESKTOP, P.MAX_SIDE_HARD);
  ok(a4 * Math.max(A4.w, A4.h) <= P.MAX_SIDE_HARD + 1e-6, `A4 한 변 = ${(a4 * A4.h).toFixed(0)}px ≤ ${P.MAX_SIDE_HARD}`);
  ok(P.clampScale(0.0001, A1.w, A1.h, P.CANVAS_PX_DESKTOP, P.MAX_SIDE_HARD) >= 0.1, "하한 0.1 보장(0 캔버스 방지)");
}

/* ────────────────────────────────────────────────────────────
 * C. 🔴 이득 없는 재렌더 금지 + 상한에 막히면 크롭 경로
 * ──────────────────────────────────────────────────────────── */
function suiteNoGain(label, P) {
  console.log("\n[" + label + "]");
  // (구 동작 재현) 모바일 상한 + A1 → 첫 렌더부터 상한에 붙는다
  const cap = P.CANVAS_PX_MOBILE;
  const init = P.clampScale(1.5 * 2, A1.w, A1.h, cap, P.MAX_SIDE_HARD);   // 초기 렌더 1.5×dpr2
  const atZoom6 = P.clampScale(6 * 2, A1.w, A1.h, cap, P.MAX_SIDE_HARD);  // 6배 확대 목표
  ok(near(init, atZoom6, 1e-9),
    `A1·모바일 상한: 초기(${init.toFixed(3)}) 와 6배 확대 목표(${atZoom6.toFixed(3)}) 가 동일 → 재렌더해도 이득 0`);

  const plan = P.planRerender({
    zoom: 6, dpr: 2, baseCssScale: 1, renderScale: init,
    pageW: A1.w, pageH: A1.h, pxCap: cap, maxSide: P.MAX_SIDE_HARD
  });
  ok(plan.worth === false,
    `🔴 이득 0 인데 전면 재렌더를 하지 않는다 (worth=${plan.worth}, reason=${plan.reason}) — 확대할 때마다 멈추던 원인 제거`);
  ok(plan.target > plan.capped * P.RERENDER_GAIN,
    `목표(${plan.target}) 가 상한(${plan.capped.toFixed(3)}) 을 초과 → 크롭 렌더 경로로 넘어간다`);

  // 데스크톱 상한에서도 A1 6배 확대는 전면 캔버스로 불가능 → 크롭이 필요하다(구조적 한계 증명)
  const deskPlan = P.planRerender({
    zoom: 6, dpr: 2, baseCssScale: 1, renderScale: 3.0,
    pageW: A1.w, pageH: A1.h, pxCap: P.CANVAS_PX_DESKTOP, maxSide: P.MAX_SIDE_HARD
  });
  ok(deskPlan.target > deskPlan.capped * P.RERENDER_GAIN,
    `데스크톱 상한에서도 A1 6배(목표 ${deskPlan.target}) 는 전면 캔버스(${deskPlan.capped.toFixed(2)}) 로 불가 → 크롭 필수`);

  // 반대로 A4 소형 도면은 전면 캔버스만으로 4배까지 선명하다 → 크롭 불필요
  const a4Plan = P.planRerender({
    zoom: 4, dpr: 2, baseCssScale: 1, renderScale: 3.0,
    pageW: A4.w, pageH: A4.h, pxCap: P.CANVAS_PX_DESKTOP, maxSide: P.MAX_SIDE_HARD
  });
  ok(a4Plan.worth === true && a4Plan.reason === "sharpen" && near(a4Plan.capped, a4Plan.target, 1e-9),
    `A4 4배 확대는 전면 재렌더로 목표(${a4Plan.target}) 달성 → 선명해진다 (reason=${a4Plan.reason})`);
}

/* ────────────────────────────────────────────────────────────
 * D. 목표 스케일 = 확대 종료 시점의 실제 화면 배율 · 상한 준수
 * ──────────────────────────────────────────────────────────── */
function suiteTarget(label, P) {
  console.log("\n[" + label + "]");
  [1, 1.7, 2.2, 4, 6, 8].forEach((z) => {
    [1, 2].forEach((dpr) => {
      const p = P.planRerender({
        zoom: z, dpr: dpr, baseCssScale: 1, renderScale: 0.5,
        pageW: A1.w, pageH: A1.h, pxCap: P.CANVAS_PX_DESKTOP, maxSide: P.MAX_SIDE_HARD
      });
      ok(near(p.target, z * dpr, 1e-9), `zoom ${z} · dpr ${dpr} → 목표 스케일 ${p.target} (= 화면 배율)`);
      const px = (p.capped * A1.w) * (p.capped * A1.h);
      ok(px <= P.CANVAS_PX_DESKTOP + 1 && p.capped * A1.w <= P.MAX_SIDE_HARD + 1,
        `  └ 상한 준수: ${(px / 1e6).toFixed(1)}M px · 한 변 ${(p.capped * A1.w).toFixed(0)}px`);
    });
  });
}

/* ────────────────────────────────────────────────────────────
 * E. 축소 후 과잉 해상도 회수(메모리 보호)
 * ──────────────────────────────────────────────────────────── */
function suiteShrink(label, P) {
  console.log("\n[" + label + "]");
  const p = P.planRerender({
    zoom: 1, dpr: 1, baseCssScale: 1, renderScale: 8,
    pageW: A4.w, pageH: A4.h, pxCap: P.CANVAS_PX_DESKTOP, maxSide: P.MAX_SIDE_HARD
  });
  ok(p.worth === true && p.reason === "shrink", `8배 렌더 상태에서 1배로 축소 → 회수(reason=${p.reason})`);
  const q = P.planRerender({
    zoom: 4, dpr: 1, baseCssScale: 1, renderScale: 8,
    pageW: A4.w, pageH: A4.h, pxCap: P.CANVAS_PX_DESKTOP, maxSide: P.MAX_SIDE_HARD
  });
  ok(q.worth === false, `살짝만 축소(8→4)하면 재렌더하지 않는다 (히스테리시스 ${P.SHRINK_RATIO}배 · 진동 방지)`);
}

/* ────────────────────────────────────────────────────────────
 * F. 보이는 도면 영역 산출
 * ──────────────────────────────────────────────────────────── */
function suiteVisible(label, M) {
  console.log("\n[" + label + "]");
  const base = { contentW: A1.w, contentH: A1.h, viewW: 1600, viewH: 900 };

  // 퇴화 입력 → 전면 폴백(조용히 틀린 영역을 그리지 않는다)
  const deg = M.computeVisibleRect({ contentW: 0, contentH: 0, viewW: 0, viewH: 0, zoom: 1, panX: 0, panY: 0 });
  ok(deg.w === 1 && deg.h === 1, "퇴화 입력(0 크기) → 전면 폴백");

  // 축소해서 도면 전체가 화면 안 → 전면
  const zAll = Math.min(base.viewW / A1.w, base.viewH / A1.h);
  const all = M.computeVisibleRect(Object.assign({}, base, { zoom: zAll, panX: 0, panY: 0 }));
  ok(all.w >= 0.99 && all.h >= 0.99, `전체가 보이는 배율(${zAll.toFixed(2)}) → 전면 (w=${all.w.toFixed(2)})`);

  // 평면 6배 확대 · 도면 중앙 정렬 → 보이는 영역이 전면보다 훨씬 작다 + 중앙을 포함
  const z = 6, cx = A1.w / 2, cy = A1.h / 2;
  const flat = M.computeVisibleRect(Object.assign({}, base, {
    zoom: z, panX: base.viewW / 2 - z * cx, panY: base.viewH / 2 - z * cy
  }));
  ok(flat.w < 0.35 && flat.h < 0.35, `평면 6배 → 보이는 영역 ${(flat.w * 100).toFixed(1)}%×${(flat.h * 100).toFixed(1)}% (전면 대비 대폭 축소)`);
  ok(flat.x < 0.5 && flat.x + flat.w > 0.5 && flat.y < 0.5 && flat.y + flat.h > 0.5, "평면 6배 → 화면 중앙(도면 50%,50%)을 포함");
  const gain = 1 / Math.max(flat.w, flat.h);
  ok(gain > 3, `크롭으로 확보되는 해상도 여유 ≈ ${gain.toFixed(1)}배 (같은 캔버스 면적으로 그만큼 선명)`);

  // ISO(rotateX54·rotateZ-32) 에서도 중앙을 포함하고 전면보다 작다
  const ang = M.ISO_ANGLES[0], th = ang * Math.PI / 180;
  const cs = Math.cos(th), sn = Math.sin(th), cosX = Math.cos(M.ISO_TILT_DEG * Math.PI / 180);
  const sx = cx * cs - cy * sn, sy = (cx * sn + cy * cs) * cosX;
  const iso = M.computeVisibleRect(Object.assign({}, base, {
    zoom: z, panX: base.viewW / 2 - z * sx, panY: base.viewH / 2 - z * sy,
    iso: true, isoAngleDeg: ang
  }));
  ok(iso.w < 1 && iso.h < 1, `ISO 6배 → 보이는 영역 ${(iso.w * 100).toFixed(1)}%×${(iso.h * 100).toFixed(1)}% (전면 아님)`);
  ok(iso.x < 0.5 && iso.x + iso.w > 0.5 && iso.y < 0.5 && iso.y + iso.h > 0.5,
    "ISO 6배 → 화면 중앙에 놓인 도면 지점을 크롭이 포함(빈 영역을 그리지 않는다)");

  // projectPoint: ISO 역산 없이도 focusZoneIso 와 같은 모델인지 확인
  const p = M.projectPoint(cx, cy, { zoom: z, panX: base.viewW / 2 - z * sx, panY: base.viewH / 2 - z * sy, iso: true, isoAngleDeg: ang });
  ok(near(p.x, base.viewW / 2, 1e-6) && near(p.y, base.viewH / 2, 1e-6),
    "projectPoint: focusZoneIso 가 중앙정렬한 지점이 실제로 뷰포트 중앙에 투영됨");
}

/* ── 실행: 정상 소스 ─────────────────────────────────────────── */
{
  const { PDF, MapCtrl } = load();
  suiteCap("A 기기별 캔버스 상한 (정상 소스)", PDF);
  suiteClamp("B 상한 클램프 (정상 소스)", PDF);
  suiteNoGain("C 이득 없는 재렌더 금지 (정상 소스)", PDF);
  suiteTarget("D 목표 스케일 = 화면 배율 (정상 소스)", PDF);
  suiteShrink("E 축소 시 메모리 회수 (정상 소스)", PDF);
  suiteVisible("F 보이는 도면 영역 (정상 소스)", MapCtrl);
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 P1: 실익 판정을 구 코드(상한 적용 전 target 기준)로 되돌리면
 *              "이득 0 인데 재렌더" 가 되살아나 C 가 실패해야 한다.
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션P1] 실익 판정을 상한 적용 전 target 기준으로 되돌림 → C 가 실패해야 함");
  const needle = 'if (capped > cur * gain) return { target: target, capped: capped, worth: true, reason: "sharpen" };';
  const mutated = pdfSrc.replace(needle,
    'if (target > cur * gain) return { target: target, capped: capped, worth: true, reason: "sharpen" };');
  if (mutated === pdfSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PDF } = load(mutated);
    const init = PDF.clampScale(3.0, A1.w, A1.h, PDF.CANVAS_PX_MOBILE, PDF.MAX_SIDE_HARD);
    const plan = PDF.planRerender({
      zoom: 6, dpr: 2, baseCssScale: 1, renderScale: init,
      pageW: A1.w, pageH: A1.h, pxCap: PDF.CANVAS_PX_MOBILE, maxSide: PDF.MAX_SIDE_HARD
    });
    ok(plan.worth === true,
      `뮤테이션 적용 시 이득 0 인 재렌더가 되살아남(테스트 실효성 증명) → worth=${plan.worth}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 P2: 상한을 전 기기 공통 16.7M 으로 되돌리면(구 코드)
 *              데스크톱 선명도 이득이 사라져 B 가 실패해야 한다.
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션P2] 캔버스 상한을 전 기기 공통 16.7M 으로 되돌림 → B 가 실패해야 함");
  const mutated = pdfSrc.replace("CANVAS_PX_DESKTOP: 40000000,", "CANVAS_PX_DESKTOP: 16777216,");
  if (mutated === pdfSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PDF } = load(mutated);
    const mob = PDF.clampScale(99, A1.w, A1.h, PDF.CANVAS_PX_MOBILE, PDF.MAX_SIDE_HARD);
    const desk = PDF.clampScale(99, A1.w, A1.h, PDF.CANVAS_PX_DESKTOP, PDF.MAX_SIDE_HARD);
    ok(!(desk > mob * 1.5),
      `뮤테이션 적용 시 데스크톱 선명도 이득이 사라짐(테스트 실효성 증명) → ${desk.toFixed(3)} vs ${mob.toFixed(3)}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 P3: 보이는 영역 산출을 항상 전면(FULL)으로 되돌리면
 *              크롭이 무력화돼 F 가 실패해야 한다.
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션P3] computeVisibleRect 가 항상 전면 반환 → F 가 실패해야 함");
  const needle = "      if (hit < 2) return FULL;";
  const mutated = mapSrc.replace(needle, "      return FULL;");
  if (mutated === mapSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { MapCtrl } = load(pdfSrc, mutated);
    const z = 6;
    const r = MapCtrl.computeVisibleRect({
      contentW: A1.w, contentH: A1.h, viewW: 1600, viewH: 900,
      zoom: z, panX: 800 - z * A1.w / 2, panY: 450 - z * A1.h / 2
    });
    ok(!(r.w < 0.35 && r.h < 0.35),
      `뮤테이션 적용 시 6배 확대에서도 전면을 반환(테스트 실효성 증명) → w=${r.w}, h=${r.h}`);
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
