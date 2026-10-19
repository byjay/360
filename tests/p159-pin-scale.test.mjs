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
 * 근본원인(1차): "완전 비례"는 하한만 두고 상한을 폐기해, 과도줌에서 핀이 무한히 커진다.
 * 채택(1차): 기준배율 2→0.75(zoom=1 화면 약 30px, 기존 80px 대비 축소) + 절대 px 상한(PIN_MAX_PX) +
 * 1~상한 구간은 여전히 비례. 선(동선·주석, lineScreenScale)도 같은 원칙(비율 상한).
 *
 * ── WO 20261019-pinscale3 (마스터 "핀이, 포인트가 너무 크기가 작아서 안 보여. 전체 비율을 봐,
 *    너무 작게 만들어 버렸어") ──
 * [재현] 실제 도면을 화면 맞춤으로 열면 zoom≈0.16(큰 PDF, 지휘자 라이브 실측) — 1차 정책의 기준인
 * "zoom=1"은 이 상태에서 전혀 쓰이지 않는다: raw=0.75×0.16×40≈4.8px 가 바닥(옛 14px)에 깔려 핀이
 * 거의 안 보였다. 근본원인(2차): 기준을 "zoom=1"(절대 배율)로 잡은 것 자체가 틀렸다 — 실제 화면에서
 * zoom 값은 도면 크기·창 크기에 따라 천차만별이라, "화면 맞춤 상태"를 기준으로 잡아야 한다.
 * 채택(2차): 분모를 "화면 맞춤 배율"(MapCtrl.computeFitZoom(), fit()·_fitBoundary() 와 동일 공식,
 * §G-2-5 단일 진입점)로 바꾼다 — effZoom = (zoom/fitZoom) × scaleRef. fitZoom 을 모르면(로드 전·
 * 테스트 환경처럼 content 크기가 없음) 1 로 폴백(= 1차 정책과 동일 수식, 아래 ①~⑤·⑥b·⑦·⑧이
 * 전부 이 폴백 경로를 타므로 숫자 그대로 보존됨 — PIN_SCALE=0.75 는 "맞춤 상태 기준 30px"로 재해석).
 * 바닥/상한 px 도 20/56(터치 24)로 올림(기존 14~48) — fitZoom 기준에서도 축소·과도줌 보호가
 * 충분하도록. 구역 "경계"(크롭 보기, _cropBoundary)는 fitZoom 자체가 computeCoverZoom 으로 그
 * 경계의 확대비를 이미 반영하므로 scaleRef 를 또 곱하면 이중보정(⑥, nofit 뮤테이션이 증명) —
 * 경계 없는 벡터복사 구역(scaleRef<1, crop=null)만 scaleRef 를 유지한다(⑥b, 변경 없음).
 *
 * 실제 모듈 소스(02_PDF.js / 10_MapCtrl.js)를 그대로 vm 에 평가해 검사(목 구현 아님).
 * 뮤테이션 6건 — 고친 부분을 되돌리면 반드시 EXIT=1:
 *   P159_MUT=noceil   → pin 상한(Math.min(...,ceil)) 제거 — zoom=16 56px 초과 단언 실패
 *   P159_MUT=nolinecap→ line 상한(Math.min(...,LINE_MAX_RATIO)) 제거 — 선 두께 상한 단언 실패
 *   P159_MUT=nofloor  → Math.max(raw, floor) 제거(바닥 삭제) — 저줌 최소크기 단언 실패
 *   P159_MUT=nocrop   → scaleRef 무시(항상 1) — 구역 보정 단언 실패
 *   P159_MUT=nofit    → [신규 20261019] fitZoom 나누기 제거(zoom 직접 기준으로 되돌림) — 경계
 *                        맞춤(⑥) 단언 실패(비경계 구간은 fitZoom 폴백=1 이라 차이가 안 드러남)
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
/** 대상 문자열이 실제 소스에 없으면 조용히 no-op 하지 않고 즉시 에러(가짜 PASS 방지). */
function mustReplace(src, from, to, label) {
  if (!src.includes(from)) { console.log("FAIL 뮤테이션 대상 없음(" + label + "): " + JSON.stringify(from)); process.exit(2); }
  return src.replace(from, to);
}
function mutate(mapSrc) {
  if (MUT === "noceil") {
    // 핀 상한(ceil) 제거 — 과도줌에서 핀이 끝없이 커진다(2026-10-16 마스터 지적 재현).
    return mustReplace(mapSrc,
      "return Math.min(Math.max(raw, floor), ceil);",
      "return Math.max(raw, floor); // [MUT noceil] 상한 제거",
      "noceil"
    );
  }
  if (MUT === "nolinecap") {
    // 선 두께 상한(LINE_MAX_RATIO) 제거.
    return mustReplace(mapSrc,
      "return Math.min(Math.max(effZoom, floor), this.LINE_MAX_RATIO);",
      "return Math.max(effZoom, floor); // [MUT nolinecap] 상한 제거",
      "nolinecap"
    );
  }
  if (MUT === "nofloor") {
    // 바닥(Math.max) 제거 — 저줌에서 핀이 끝없이 작아진다.
    return mustReplace(mapSrc,
      "return Math.min(Math.max(raw, floor), ceil);",
      "return Math.min(raw, ceil); // [MUT nofloor] 바닥 제거",
      "nofloor"
    );
  }
  if (MUT === "nocrop") {
    // 구역 보정(scaleRef) 무시 — 항상 1(첫 등장 = pinScreenScale 안의 scaleRef 선언).
    return mustReplace(mapSrc,
      "const scaleRef = this._cropBoundary ? 1 : (this._pinScaleRef || 1);",
      "const scaleRef = 1; // [MUT nocrop] 구역 보정 무시",
      "nocrop"
    );
  }
  if (MUT === "nofit") {
    // [신규 WO 20261019-pinscale3] fitZoom 나누기 제거 — zoom 을 그대로 기준으로 되돌림.
    return mustReplace(mapSrc,
      "const effZoom = (zoom / fitZoom) * scaleRef; // 기준: 화면맞춤(fitZoom) 대비 현재 줌",
      "const effZoom = zoom * scaleRef; // [MUT nofit] fitZoom 무시(종전 zoom 직접 기준)",
      "nofit"
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
 * 6. 구역(crop 창=경계) 보정 — [WO 20261019-pinscale3 전·후 대조]
 *    전(1차 정책): zoom=4 를 "fitZone 이 1/scaleRef=4배 확대한 결과"라고 가정해 scaleRef(0.25)를
 *    곱해 역산했다 — 임의의 zoom 값과 scaleRef 를 짝지은 가짜 전제였다.
 *    후(2차 정책): 이 구역을 "진짜로 화면에 맞춘"(F) 상태 = zoom === computeFitZoom() 이다. 그 배율은
 *    fit()·_fitBoundary() 가 실제로 쓰는 값(computeCoverZoom)과 같다 — scaleRef 없이도 원본과 같은
 *    기준px 가 나와야 한다(이중보정 제거 판단, 헤더 주석 참조).
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[⑥ 구역 보정 — crop 창(경계), 화면 맞춤 기준으로 계산]");
State.zoom = 1;
const sBefore = MapCtrl.pinScreenScale();
PDF.setDeckCrop({ x: 10, y: 20, w: 25, h: 25 }, 0.25); // 원본의 25% 폭만 담은 구역(경계 활성)
const fitZ6 = MapCtrl.computeFitZoom(); // 이 경계를 화면에 맞추는 배율(= fit() 이 실제로 쓸 값)
ok(fitZ6 > 0, `사전조건: computeFitZoom() = ${fitZ6 && fitZ6.toFixed(4)}(경계 cover 배율, >0)`);
State.zoom = fitZ6; // "방금 이 구역에 맞춤(F)했다"를 흉내
const sZoneFit = MapCtrl.pinScreenScale();
ok(near(sZoneFit, sBefore, 1e-6), `경계 맞춤(zoom=fitZoom=${fitZ6.toFixed(4)}) scale=${sZoneFit.toFixed(4)} = 원본 맞춤 scale=${sBefore.toFixed(4)} — scaleRef 없이도 일치`);
ok(near(sZoneFit * MapCtrl.PIN_NATIVE_PX, 30, 1), `구역 맞춤 화면px=${(sZoneFit * MapCtrl.PIN_NATIVE_PX).toFixed(2)} ≈ 30px(원본 맞춤과 동일)`);

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
// [WO 20261019-pinscale3 전·후] 전: effZoom=zoom 직접, zoom=0.6 → 비례 0.6. 후: effZoom=
// (zoom/fitZoom)×LINE_FIT_RATIO(0.5) — zoom=0.6 은 이제 0.3(<바닥 0.4)이라 바닥에 깔린다.
// "맞춤 상태"(fitZoom 폴백=1 과 같은 zoom=1)에서 비율이 정확히 0.5(=기준선 3px→1.5px, 마스터
// 요구 "맞춤 상태 1.5px 쯤")가 되는 걸 비례 구간 대표값으로 쓴다.
PDF.setDeckCrop(null, 1);
State.zoom = 0.01;
ok(near(MapCtrl.lineScreenScale(0.4), 0.4, 1e-6), `zoom 극저 → lineScreenScale(0.4)=${MapCtrl.lineScreenScale(0.4)} = 바닥 0.4`);
State.zoom = 1;
ok(near(MapCtrl.lineScreenScale(0.4), 0.5, 1e-6), `zoom=1(=맞춤, fitZoom 폴백 1) → lineScreenScale(0.4)=${MapCtrl.lineScreenScale(0.4)} = 0.5(기준선 3px→1.5px, "맞춤 상태 1.5px 쯤" 충족)`);
State.zoom = 3;
ok(near(MapCtrl.lineScreenScale(0.4), MapCtrl.LINE_MAX_RATIO, 1e-6), `zoom=3(effZoom×0.5=1.5>상한) → lineScreenScale(0.4)=${MapCtrl.lineScreenScale(0.4)} = 상한(${MapCtrl.LINE_MAX_RATIO}, 기준선 3px*1=최대 약 3px)`);

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

/* ══════════════════════════════════════════════════════════════════
 * 9. [신규 WO 20261019-pinscale3] 비경계(전체 도면) computeFitZoom() 실측 — "맞춤 상태 약 30px",
 *    2배 확대 시 56px 상한, 0.5배 축소 시 20px 바닥. ①~⑧은 테스트 하니스에 content 크기가 없어
 *    fitZoom 이 항상 1(폴백)이었다 — 이 섹션만 _contentSize() 를 오버라이드해 실제 "큰 도면을
 *    화면 맞춤으로 열었을 때"(지휘자 라이브 재현: zoom≈0.16)와 같은 상황을 흉내낸다.
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[⑨ 비경계 전체 맞춤 — computeFitZoom() 실측]");
PDF.setDeckCrop(null, 1);
const origContentSize = MapCtrl._contentSize;
MapCtrl._contentSize = () => ({ w: 4000, h: 3000 }); // 큰 PDF 흉내(viewport 375x812 대비 매우 큼)
const fitZ9 = MapCtrl.computeFitZoom();
const expFitZ9 = Math.min(375 / 4000, 812 / 3000) * MapCtrl.FIT_PAD;
ok(near(fitZ9, expFitZ9, 1e-6), `computeFitZoom()=${fitZ9.toFixed(4)} = min(vw/w,vh/h)*FIT_PAD=${expFitZ9.toFixed(4)}(실제 재현의 zoom≈0.16 과 같은 크기 자릿수)`);
State.zoom = fitZ9; // "방금 F(화면맞춤)을 눌렀다"
const px9fit = MapCtrl.pinScreenScale() * MapCtrl.PIN_NATIVE_PX;
ok(near(px9fit, 30, 1), `맞춤 상태(zoom=fitZoom) 화면px=${px9fit.toFixed(2)} ≈ 30px(마스터 "핀이 안 보여" 재현 해소 — 종전엔 zoom=0.16 이 바닥 14px 에 깔렸었다)`);
State.zoom = fitZ9 * 2; // 맞춤 대비 2배 확대
const px9x2 = MapCtrl.pinScreenScale() * MapCtrl.PIN_NATIVE_PX;
ok(near(px9x2, MapCtrl.PIN_MAX_PX, 1e-6), `맞춤×2 확대 화면px=${px9x2.toFixed(2)} = 상한 ${MapCtrl.PIN_MAX_PX}px 에서 멈춤("비례해서 커지다가 최대 56px")`);
State.zoom = fitZ9 * 0.5; // 맞춤 대비 0.5배 축소
const px9half = MapCtrl.pinScreenScale() * MapCtrl.PIN_NATIVE_PX;
ok(near(px9half, MapCtrl.PIN_MIN_PX_MOUSE, 1e-6), `맞춤×0.5 축소 화면px=${px9half.toFixed(2)} = 바닥 ${MapCtrl.PIN_MIN_PX_MOUSE}px 에서 멈춤("작아지다가 최소 20px")`);
MapCtrl._contentSize = origContentSize; // 원복(이후 구역 테스트에 영향 없게)

console.log(MUT ? `\n[MUT=${MUT}] 의도적 되돌림 — 위 단언 중 최소 1개는 FAIL 이어야 정상(뮤테이션이 진짜로 잡혔다는 증거)` : "");
process.exit(failed ? 1 : 0);
