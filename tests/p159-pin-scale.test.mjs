/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p159-pin-scale.test.mjs)
 *
 * 대상: 마스터 지시(2026-10-16) "핀이 너무 커지는 거 아니니" — WO 20261016-pinscale2.
 * 선행 정책(WO 20261016-pinscale, "도면과 완전 비례 + 최소 크기 보장")이 상한을 없앤 결과
 * zoom=16 에서 화면 1280px(핀 하나가 도면을 가림)까지 커지는 문제를 고친다.
 *
 * [재현] 교체 전(커밋 5e4ce97, 지휘자 발주서 인용, 10_MapCtrl.js:382-399 구 코드):
 *   PIN_SCALE=2, PIN_NATIVE_PX=40, 상한 없음(Math.max(raw, floor)).
 *   화면px = 40×scale → zoom 1→80px, zoom 4→320px, zoom 16→1280px. 판정: 확대하면 핀이 도면을 가린다.
 *
 * 근본원인: "완전 비례"는 하한만 두고 상한을 폐기해, 과도줌에서 핀이 무한히 커진다.
 * 채택: 기준배율 2→0.75(zoom=1 화면 약 30px, 기존 80px 대비 축소) + 절대 px 상한(PIN_MAX_PX=48,
 * 터치/마우스 바닥 18/14px 유지) + 1~상한 구간은 여전히 비례. 선(동선·주석, lineScreenScale)도
 * 같은 원칙 — 비율 상한(LINE_MAX_RATIO=1)으로 기준선(route-line 3px)이 최대 약 3px에서 멈춘다.
 * 구역(scaleRef) 보정은 그대로 유지(§G-2-5 단일 진입점 불변).
 *
 * 실제 모듈 소스(02_PDF.js / 10_MapCtrl.js)를 그대로 vm 에 평가해 검사(목 구현 아님).
 * 뮤테이션 4건 — 고친 부분을 되돌리면 반드시 EXIT=1:
 *   P159_MUT=noceil   → pin 상한(Math.min(...,ceil)) 제거 — zoom=16 48px 초과 단언 실패
 *   P159_MUT=nolinecap→ line 상한(Math.min(...,LINE_MAX_RATIO)) 제거 — 선 두께 상한 단언 실패
 *   P159_MUT=nofloor  → Math.max(raw, floor) 제거(바닥 삭제) — 저줌 최소크기 단언 실패
 *   P159_MUT=nocrop   → scaleRef 무시(항상 1) — 구역 보정 단언 실패
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
  if (MUT === "noceil") {
    // 핀 상한(ceil) 제거 — 과도줌에서 핀이 끝없이 커진다(2026-10-16 마스터 지적 재현).
    return mapSrc.replace(
      "return Math.min(Math.max(raw, floor), ceil);",
      "return Math.max(raw, floor); // [MUT noceil] 상한 제거"
    );
  }
  if (MUT === "nolinecap") {
    // 선 두께 상한(LINE_MAX_RATIO) 제거.
    return mapSrc.replace(
      "return Math.min(Math.max(effZoom, floor), this.LINE_MAX_RATIO);",
      "return Math.max(effZoom, floor); // [MUT nolinecap] 상한 제거"
    );
  }
  if (MUT === "nofloor") {
    // 바닥(Math.max) 제거 — 저줌에서 핀이 끝없이 작아진다.
    return mapSrc.replace(
      "return Math.min(Math.max(raw, floor), ceil);",
      "return Math.min(raw, ceil); // [MUT nofloor] 바닥 제거"
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
 * 1. zoom 0.2/1/4/16 — 화면 px 가 [바닥px, 상한px] 범위 안(G-4⑦ 요구 수치 그대로)
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[① zoom 0.2/1/4/16 — 화면 px 범위]");
const floorPx = MapCtrl.PIN_MIN_PX_MOUSE; // 테스트 환경=마우스(window 無) = 14px
const ceilPx = MapCtrl.PIN_MAX_PX;        // 48px
for (const z of [0.2, 1, 4, 16]) {
  State.zoom = z;
  const px = MapCtrl.pinScreenScale() * MapCtrl.PIN_NATIVE_PX;
  ok(px >= floorPx - 1e-6 && px <= ceilPx + 1e-6, `zoom=${z} → 화면px=${px.toFixed(2)} ∈ [${floorPx}, ${ceilPx}]`);
}

/* ══════════════════════════════════════════════════════════════════
 * 2. zoom=1 → 기준값 약 30px (PIN_SCALE=0.75 × PIN_NATIVE_PX=40)
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[② zoom=1 기준값 ≈30px]");
State.zoom = 1;
const px1 = MapCtrl.pinScreenScale() * MapCtrl.PIN_NATIVE_PX;
ok(px1 >= 28 && px1 <= 32, `zoom=1 → 화면px=${px1.toFixed(2)} ∈ [28, 32]`);
ok(near(MapCtrl.pinScreenScale(), MapCtrl.PIN_SCALE, 1e-6), `zoom=1 → scale=${MapCtrl.pinScreenScale()} = PIN_SCALE(${MapCtrl.PIN_SCALE})`);

/* ══════════════════════════════════════════════════════════════════
 * 3. 1~상한 구간은 여전히 비례(바닥·상한에 아직 안 닿는 중간 구간)
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[③ 1~상한 구간 비례]");
State.zoom = 1; const s1 = MapCtrl.pinScreenScale();
State.zoom = 1.5; const s15 = MapCtrl.pinScreenScale(); // raw=1.125 < ceil(1.2) → 아직 비례 구간
ok(near(s15 / s1, 1.5, 1e-6), `zoom 1→1.5(×1.5, 둘 다 바닥/상한 밖) → scale ${s1}→${s15}(×${(s15 / s1).toFixed(3)}) 비례`);

/* ══════════════════════════════════════════════════════════════════
 * 4. 최소 크기 보장(바닥) — 여전히 유지
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[④ 최소 크기 보장(바닥)]");
State.zoom = 0.001; const sTiny = MapCtrl.pinScreenScale();
const floorExpect = MapCtrl.PIN_MIN_PX_MOUSE / MapCtrl.PIN_NATIVE_PX;
ok(near(sTiny, floorExpect, 1e-6), `zoom=0.001(극저) → scale=${sTiny.toFixed(4)} = 바닥 ${floorExpect.toFixed(4)}(마우스 ${MapCtrl.PIN_MIN_PX_MOUSE}px/native ${MapCtrl.PIN_NATIVE_PX}px) 에서 멈춤`);

/* ══════════════════════════════════════════════════════════════════
 * 5. 최대 크기 상한 — [신규] WO 20261016-pinscale2
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[⑤ 최대 크기 상한(신규)]");
State.zoom = 16; const sBig = MapCtrl.pinScreenScale();
const ceilExpect = MapCtrl.PIN_MAX_PX / MapCtrl.PIN_NATIVE_PX;
ok(near(sBig, ceilExpect, 1e-6), `zoom=16(최대) → scale=${sBig.toFixed(4)} = 상한 ${ceilExpect.toFixed(4)}(${MapCtrl.PIN_MAX_PX}px/native ${MapCtrl.PIN_NATIVE_PX}px) 에서 멈춤(2026-10-16 "너무 커지는 거 아니니" 재도입)`);
State.zoom = 4; const sMid = MapCtrl.pinScreenScale();
ok(near(sMid, ceilExpect, 1e-6), `zoom=4(구 정책 320px 유발 지점) → scale=${sMid.toFixed(4)} = 상한에서 멈춤(구 320px → 신규 48px)`);

/* ══════════════════════════════════════════════════════════════════
 * 6. 구역(crop 창) 보정 — PDF.setDeckCrop(crop, scaleRef) 단일 진입점(회귀 — 상한과 무관하게 유지)
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[⑥ 구역 보정 — crop 창(같은 페이지 클리핑)]");
State.zoom = 1;
const sBefore = MapCtrl.pinScreenScale();
PDF.setDeckCrop({ x: 10, y: 20, w: 25, h: 25 }, 0.25); // 원본의 25% 폭만 담은 구역
State.zoom = 4; // fitZone 이 1/0.25=4배 확대해 화면을 채웠다고 가정
const sZoneCrop = MapCtrl.pinScreenScale();
ok(near(sZoneCrop, sBefore, 1e-6), `구역(zoom=4, scaleRef=0.25) scale=${sZoneCrop.toFixed(4)} = 원본(zoom=1) scale=${sBefore.toFixed(4)} — 원본 대비 같은 크기`);

console.log("\n[⑥b 구역 보정 — 벡터 복사(crop 없음, src_crop 만)]");
PDF.setDeckCrop(null, 1); // crop 해제 + 보정 해제(일반 페이지로 돌아간 것처럼)
State.zoom = 1;
ok(near(MapCtrl.pinScreenScale(), sBefore, 1e-6), "크롭 해제(scaleRef=1) → 보정 없음(원래 공식)");
PDF.setDeckCrop(null, 0.1); // 벡터 복사 구역: crop(클리핑 경계)은 없지만 src_crop 비율만 있음
State.zoom = 10;
ok(near(MapCtrl.pinScreenScale(), sBefore, 1e-6), `벡터 복사(crop=null, scaleRef=0.1, zoom=10) scale=${MapCtrl.pinScreenScale().toFixed(4)} = 원본 scale=${sBefore.toFixed(4)}`);

/* ══════════════════════════════════════════════════════════════════
 * 7. 선(동선·주석) 공유 — lineScreenScale(바닥 비율) + 상한(신규)
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[⑦ 선 두께 바닥/상한(비율) — lineScreenScale]");
PDF.setDeckCrop(null, 1);
State.zoom = 0.01;
ok(near(MapCtrl.lineScreenScale(0.4), 0.4, 1e-6), `zoom 극저 → lineScreenScale(0.4)=${MapCtrl.lineScreenScale(0.4)} = 바닥 0.4`);
State.zoom = 0.6;
ok(near(MapCtrl.lineScreenScale(0.4), 0.6, 1e-6), `zoom=0.6(바닥·상한 밖) → lineScreenScale(0.4)=${MapCtrl.lineScreenScale(0.4)} = 비례(0.6)`);
State.zoom = 3;
ok(near(MapCtrl.lineScreenScale(0.4), MapCtrl.LINE_MAX_RATIO, 1e-6), `zoom=3(구 정책 비율 3 → 기준선 9px 유발) → lineScreenScale(0.4)=${MapCtrl.lineScreenScale(0.4)} = 상한(${MapCtrl.LINE_MAX_RATIO}, 기준선 3px*1=최대 약 3px)`);

/* ══════════════════════════════════════════════════════════════════
 * 8. zoom 0.2~16 전범위 스윕 — 공식이 항상 min(상한, max(바닥, base×effZoom)) 과 일치
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[⑧ zoom 0.2~16 스윕]");
PDF.setDeckCrop(null, 1);
let sweepOk = true;
for (let z = 0.2; z <= 16; z *= 1.37) {
  State.zoom = z;
  const got = MapCtrl.pinScreenScale();
  const floor = MapCtrl.PIN_MIN_PX_MOUSE / MapCtrl.PIN_NATIVE_PX;
  const ceil = MapCtrl.PIN_MAX_PX / MapCtrl.PIN_NATIVE_PX;
  const want = Math.min(Math.max(MapCtrl.PIN_SCALE * z, floor), ceil);
  if (!near(got, want, 1e-6)) { sweepOk = false; console.log(`    zoom=${z.toFixed(3)} got=${got} want=${want}`); }
}
ok(sweepOk, "zoom 0.2~16 전범위 — pinScreenScale() = min(상한, max(바닥, base×zoom)) 일치");

console.log(MUT ? `\n[MUT=${MUT}] 의도적 되돌림 — 위 단언 중 최소 1개는 FAIL 이어야 정상(뮤테이션이 진짜로 잡혔다는 증거)` : "");
process.exit(failed ? 1 : 0);
