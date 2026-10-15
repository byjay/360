/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p159-pin-scale.test.mjs)
 *
 * 대상: 마스터 지시(2026-10-16) "핀 크기도 도면 배율에 맞게 완벽하게" — "도면과 완전 비례 +
 * 최소 크기 보장" 정책. 2026-08-31 절충안(2·zoom^-0.6, 부분 역보정)을 대체한다.
 *
 * [재현] 교체 전 수치(지휘자 발주서 R1 인용, 10_MapCtrl.js:367-375 구 코드):
 *   zoom=0.5 → scale = 2*0.5^-0.6 = 2.954(클램프 無 영향)
 *   zoom=1   → scale = 2
 *   zoom=4   → scale = 2*4^-0.6 = 0.871 → clamp[0.8,4.5] = 0.871
 *   화면px(zoom·scale) = 1.477 / 2 / 3.484 — zoom 8배인데 화면px 는 2.36배만 변함(비례 아님, R1 확인).
 *
 * 근본원인: 부분 지수(0.6)는 "줌과 함께 완전히 커지고 작아짐"이 아니라 그 중간이다. 구역(fitZone)
 * 화면은 같은 핀을 원본보다 더 확대된 zoom 으로 보므로, 부분보정 상태에서는 원본·구역의 "도면 대비
 * 핀 비율"이 달라진다(R2). 채택: 지수 1(완전 비례) + 절대 px 바닥(터치18/마우스14, 상한 없음) +
 * 구역(crop 창·벡터 복사 src_crop 모두) scaleRef 보정 — 단일 진입점 PDF.setDeckCrop(crop, scaleRef)
 * → MapCtrl.setCropBoundary(crop, scaleRef) → pinScreenScale()·lineScreenScale() 공유(§G-2-5).
 *
 * 실제 모듈 소스(02_PDF.js / 10_MapCtrl.js)를 그대로 vm 에 평가해 검사(목 구현 아님).
 * 뮤테이션 3건 — 고친 부분을 되돌리면 반드시 EXIT=1:
 *   P159_MUT=exp06   → 지수 1→0.6 복원(부분보정 재현) — 비례 단언 실패
 *   P159_MUT=nofloor → Math.max(raw, floor) 제거(바닥 삭제) — 저줌 최소크기 단언 실패
 *   P159_MUT=nocrop  → scaleRef 무시(항상 1) — 구역 보정 단언 실패
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const pdfSrcOrig = rd("public/js/modules/02_PDF.js");
const mapSrcOrig = rd("public/js/modules/10_MapCtrl.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

const MUT = process.env.P159_MUT || "";
function mutate(mapSrc) {
  if (MUT === "exp06") {
    // 지수 1(완전 비례)을 구 지수 0.6(부분보정)으로 되돌린다.
    return mapSrc.replace(
      "const raw = base * effZoom; // 도면과 완전 비례(지수 1)",
      "const raw = base * Math.pow(effZoom, 0.6); // [MUT exp06] 부분보정 복원"
    );
  }
  if (MUT === "nofloor") {
    // 바닥(Math.max) 제거 — 저줌에서 핀이 끝없이 작아진다.
    return mapSrc.replace(
      "return Math.max(raw, floor); // 상한 없음",
      "return raw; // [MUT nofloor] 바닥 제거"
    );
  }
  if (MUT === "nocrop") {
    // 구역 보정(scaleRef) 무시 — 항상 1.
    return mapSrc.replace(
      "const effZoom = zoom * (this._pinScaleRef || 1); // 구역이면 원본 대비 보정",
      "const effZoom = zoom; // [MUT nocrop] 구역 보정 무시"
    );
  }
  return mapSrc;
}

function load(pdfS, mapS) {
  const State = { zoom: 1, pan: { x: 0, y: 0 }, isoView: false, isoDir: 0, mode: "designer", fileType: "pdf", pdfDoc: null, srcPdfDoc: null };
  const viewport = { clientWidth: 375, clientHeight: 812, style: {} };
  const transform = { offsetWidth: 2384, offsetHeight: 1684, style: {}, children: [] };
  const sandbox = {
    console, State, Math, JSON, Promise, setTimeout, clearTimeout,
    document: { getElementById: () => null, createElement: () => ({ style: {}, getContext: () => null }) },
    navigator: { userAgent: "node", platform: "", maxTouchPoints: 0 },
    performance: { now: () => 0 }
    // window 미제공 → MapCtrl._coarsePointer() 가 false(마우스 바닥 14px) 로 수렴(예측 가능한 결정론).
  };
  vm.createContext(sandbox);
  vm.runInContext(pdfS + "\n" + mapS + "\n;globalThis.__PDF = PDF; globalThis.__MAP = MapCtrl;", sandbox);
  const PDF = sandbox.__PDF, MapCtrl = sandbox.__MAP;
  MapCtrl.init(viewport, transform);
  return { PDF, MapCtrl, State, viewport, transform };
}

const mapSrc = mutate(mapSrcOrig);
const ctx = load(pdfSrcOrig, mapSrc);
const { PDF, MapCtrl, State } = ctx;

/* ══════════════════════════════════════════════════════════════════
 * 1. 완전 비례 — zoom 비율 그대로 화면 배율 비율(바닥 구간 제외)
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[① 완전 비례(지수 1)]");
State.zoom = 1; const s1 = MapCtrl.pinScreenScale();
State.zoom = 2; const s2 = MapCtrl.pinScreenScale();
State.zoom = 4; const s4 = MapCtrl.pinScreenScale();
ok(near(s1, 2, 1e-6), `zoom=1 → scale=${s1} (기준 배율 PIN_SCALE=2)`);
ok(near(s2 / s1, 2, 1e-6), `zoom 1→2(×2) → scale ${s1}→${s2}(×${(s2/s1).toFixed(3)}) 완전 비례`);
ok(near(s4 / s2, 2, 1e-6), `zoom 2→4(×2) → scale ${s2}→${s4}(×${(s4/s2).toFixed(3)}) 완전 비례`);
// [재현 R1 대조] 구 지수 0.6 이면 zoom 1→4(×4)에 scale 은 ×0.436(작아짐) — 새 정책은 ×4(커짐).
ok(near(s4 / s1, 4, 1e-6), `[R1 대조] zoom 1→4(×4) → scale ×${(s4/s1).toFixed(3)} (구 정책 0.6 승은 ×0.436 — 반대 방향이었다)`);

/* ══════════════════════════════════════════════════════════════════
 * 2. 최소 크기 보장 — zoom 을 한없이 낮춰도 화면 배율은 바닥에서 멈춘다(상한은 없음)
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[② 최소 크기 보장(바닥) · 상한 없음]");
State.zoom = 0.001; const sTiny = MapCtrl.pinScreenScale();
const floorExpect = MapCtrl.PIN_MIN_PX_MOUSE / MapCtrl.PIN_NATIVE_PX; // 테스트 환경=마우스(window 無)
ok(near(sTiny, floorExpect, 1e-6), `zoom=0.001(극저) → scale=${sTiny.toFixed(4)} = 바닥 ${floorExpect.toFixed(4)}(마우스 ${MapCtrl.PIN_MIN_PX_MOUSE}px/native ${MapCtrl.PIN_NATIVE_PX}px) 에서 멈춤`);
State.zoom = 16; const sBig = MapCtrl.pinScreenScale();
ok(sBig > 30, `zoom=16(최대) → scale=${sBig.toFixed(2)} (상한 無 — 2026-08-31 PIN_MAX_SCALE 4.5 폐기 확인)`);

/* ══════════════════════════════════════════════════════════════════
 * 3. 구역(crop 창) 보정 — PDF.setDeckCrop(crop, scaleRef) 단일 진입점
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[③ 구역 보정 — crop 창(같은 페이지 클리핑)]");
State.zoom = 1;
const sBefore = MapCtrl.pinScreenScale();
PDF.setDeckCrop({ x: 10, y: 20, w: 25, h: 25 }, 0.25); // 원본의 25% 폭만 담은 구역
State.zoom = 4; // fitZone 이 1/0.25=4배 확대해 화면을 채웠다고 가정(경계 cover 배율과 무관하게 공식만 검사)
const sZoneCrop = MapCtrl.pinScreenScale();
ok(near(sZoneCrop, sBefore, 1e-6), `구역(zoom=4, scaleRef=0.25) scale=${sZoneCrop.toFixed(4)} = 원본(zoom=1) scale=${sBefore.toFixed(4)} — 원본 대비 같은 크기`);

console.log("\n[③b 구역 보정 — 벡터 복사(crop 없음, src_crop 만)]");
PDF.setDeckCrop(null, 1); // crop 해제 + 보정 해제(일반 페이지로 돌아간 것처럼)
State.zoom = 1;
ok(near(MapCtrl.pinScreenScale(), sBefore, 1e-6), "크롭 해제(scaleRef=1) → 보정 없음(원래 공식)");
PDF.setDeckCrop(null, 0.1); // 벡터 복사 구역: crop(클리핑 경계)은 없지만 src_crop 비율만 있음
State.zoom = 10;
ok(near(MapCtrl.pinScreenScale(), sBefore, 1e-6), `벡터 복사(crop=null, scaleRef=0.1, zoom=10) scale=${MapCtrl.pinScreenScale().toFixed(4)} = 원본 scale=${sBefore.toFixed(4)}`);

/* ══════════════════════════════════════════════════════════════════
 * 4. 선(동선·주석) 공유 — lineScreenScale(바닥 비율)
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[④ 선 두께 바닥(비율) — lineScreenScale]");
PDF.setDeckCrop(null, 1);
State.zoom = 0.01;
ok(near(MapCtrl.lineScreenScale(0.4), 0.4, 1e-6), `zoom 극저 → lineScreenScale(0.4)=${MapCtrl.lineScreenScale(0.4)} = 바닥 0.4`);
State.zoom = 3;
ok(near(MapCtrl.lineScreenScale(0.4), 3, 1e-6), `zoom=3 → lineScreenScale(0.4)=${MapCtrl.lineScreenScale(0.4)} = 비례(3)`);

/* ══════════════════════════════════════════════════════════════════
 * 5. zoom 0.2~16 전범위 스윕 — 공식이 항상 max(바닥, base×effZoom) 과 일치
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[⑤ zoom 0.2~16 스윕]");
PDF.setDeckCrop(null, 1);
let sweepOk = true;
for (let z = 0.2; z <= 16; z *= 1.37) {
  State.zoom = z;
  const got = MapCtrl.pinScreenScale();
  const want = Math.max(MapCtrl.PIN_SCALE * z, MapCtrl.PIN_MIN_PX_MOUSE / MapCtrl.PIN_NATIVE_PX);
  if (!near(got, want, 1e-6)) { sweepOk = false; console.log(`    zoom=${z.toFixed(3)} got=${got} want=${want}`); }
}
ok(sweepOk, "zoom 0.2~16 전범위 — pinScreenScale() = max(바닥, base×zoom) 일치");

console.log(MUT ? `\n[MUT=${MUT}] 의도적 되돌림 — 위 단언 중 최소 1개는 FAIL 이어야 정상(뮤테이션이 진짜로 잡혔다는 증거)` : "");
process.exit(failed ? 1 : 0);
