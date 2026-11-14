/**
 * p202 — WO 20261114-pinzoomdots: 「자동」 모드 — 줌아웃/혼잡 시 핀을 연한 고정 점으로 줄인다
 * (실 Chrome, CDP, tests/_lib/real-map-page.mjs 하니스 재사용 — p177/p179/p183 과 같은 패턴).
 *
 * [재현] 마스터(2026-11-14, 휴대폰/태블릿 스크린샷): "줌 아웃시에 이런 포인트 너무 커서 보기 안
 *   좋아. 작아지면 연한 점만" — 도면 줌아웃 상태에서 대역 101~200(핀 88개) 중 번호를 담은 큰
 *   원(.pin-dot, 밀도 알고리즘이 "이웃이 멀다"고 판단한 고립 핀은 상한 PIN_DOT_MAX_PX=28px까지
 *   커진다 — 10_MapCtrl.js _computePinDotPxScaled)가 전체 화면이 줌아웃된 것과 무관하게 계속
 *   크게 유지되어 번호 풍선처럼 보이고 뭉친다. 근본원인: 기존 밀도 알고리즘은 "이웃과의 상대
 *   거리"만 보고 "전체 줌 수준(저작 크기×도면줌×사용자 설정)"은 전혀 보지 않았다 — 고립 핀은
 *   아무리 줌아웃해도 diam=PIN_DOT_MAX_PX 로 고정(§아래 (ii) 고립 핀 시나리오로 직접 재현).
 *
 * 검증:
 *  (i)   줌아웃(저작 크기 임계 미만) → 전체 핀(밀집+희소+고립 모두) pin-dot-faded + 번호(.pin-dot-num)
 *        숨김 + box-shadow:none + 지름 6~8px + 핀 수(markers)==점 수(숨김 0).
 *  (ii)  고립 핀(이웃 없음, best=Infinity → 밀도 알고리즘은 항상 상한 28px) — 전역 줌아웃 게이트가
 *        없으면 줌아웃해도 계속 28px+번호인 채(마스터가 본 그 결함) 머문다 — 이 핀이 faded 로
 *        전환되는지가 전역 게이트의 존재를 직접 증명.
 *  (iii) 확대(임계 이상) → 핀·번호 복귀(고립 핀은 28px+번호, pin-dot-faded 제거).
 *  (iv)  선택(.focused) 핀은 전역 줌아웃 중에도 항상 teardrop(.pin-pin) 풀 핀.
 *  (v)   강제 모드 "점"(PinShapePrefs=dot)·"핀"(=pin) — 줌아웃과 무관(기존 동작 불변, pin-dot-faded
 *        미적용).
 *  (vi)  연한 점 vs 흰 도면 대비 ≥ 3:1(배경색×실제 합성 투명도, 서술 라벨 값이 아니라 opacity 곱 반영).
 *  (vii) 모바일 375×812 뷰포트에서도 동일(밀도/대비).
 *
 * 실행: CHROME_PATH=... TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p202-pin-zoomout-dots-cdp.mjs
 *   P202_SHOT=1 → .tmp/p202/{before-zoomed-in,after-zoomed-out,reverted}.png
 * 뮤테이션(반드시 EXIT=1):
 *   P202_MUT=nothreshold → 전역 줌아웃 게이트(rawPx<PIN_DOT_MAX_SCREEN_PX) 비활성 → (ii) 고립 핀이
 *     줌아웃해도 계속 28px+번호(마스터가 본 결함 그대로 재현) — FAIL.
 *   P202_MUT=nofade      → faded 판정 자체를 항상 false → (i) 번호·그림자 숨김이 전부 깨짐 — FAIL.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openRealMap } from "./_lib/real-map-page.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (cond, label, d) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (d !== undefined ? " :: " + JSON.stringify(d) : "")); if (!cond) failed++; return cond; };

const MUT = process.env.P202_MUT || "";

const MUTS = {
  nothreshold: {
    file: "10_MapCtrl.js",
    needle: "if (rawPx < this.PIN_DOT_MAX_SCREEN_PX) this._dotFadeZoomOut = true;",
    to: "if (false) this._dotFadeZoomOut = true;",
  },
  nofade: {
    file: "10_MapCtrl.js",
    needle: "const faded = zoomFaded || crowded;",
    to: "const faded = false;",
  },
};
if (MUT && !MUTS[MUT]) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }
const mutate = (name, src) => {
  if (!MUT || MUTS[MUT].file !== name) return src;
  const { needle, to } = MUTS[MUT];
  if (!src.includes(needle)) { console.log("FAIL 뮤테이션 대상 없음(" + MUT + ")"); process.exit(2); }
  return src.replace(needle, to);
};

// 마스터 스크린샷 재현: 청록(콘텐츠 등록, imageId 부여) 대역 101~150(50개, 밀집) + 빨강(미등록)
// 대역 151~188(38개, 밀집) — 총 88개(대역 101~200 범위, 핀수 축소는 속도를 위함, 밀집 재현은
// 간격(screen ≈16px)으로 이미 충분). + 고립 핀 1개(화면 반대편 구석, 이웃 없음 — (ii) 전용).
const teal = [];
for (let iy = 0; iy < 5; iy++) for (let ix = 0; ix < 10; ix++) teal.push({ id: "t" + (101 + iy * 10 + ix), x: 8 + ix * 0.9, y: 8 + iy * 0.9, page: 1, imageId: "img1" });
const red = [];
for (let iy = 0; iy < 4; iy++) for (let ix = 0; ix < 10; ix++) { if (red.length >= 38) break; red.push({ id: "r" + (151 + iy * 10 + ix), x: 30 + ix * 0.9, y: 8 + iy * 0.9, page: 1 }); }
const isolated = [{ id: "iso1", x: 95, y: 95, page: 1 }]; // 구석, 이웃 없음 — best=Infinity
const PINS = [...teal, ...red, ...isolated];

const PROBE = String.raw`(function(){
  var P = window.__P202 = {};
  P.markers = function(){
    return Array.from(document.querySelectorAll('#pins-layer > .pin-marker')).map(function(m){
      var d = m.querySelector('.pin-dot');
      var r = d ? d.getBoundingClientRect() : null;
      var cs = d ? getComputedStyle(d) : null;
      return {
        id: m.dataset.id,
        faded: m.classList.contains('pin-dot-faded'),
        showNum: m.classList.contains('dot-show-num'),
        numDisplay: (m.querySelector('.pin-dot-num') ? getComputedStyle(m.querySelector('.pin-dot-num')).display : null),
        w: r ? r.width : null,
        boxShadow: cs ? cs.boxShadow : null,
        bg: cs ? cs.backgroundColor : null,
        dotOpacity: cs ? parseFloat(cs.opacity) : null,
        markerOpacity: parseFloat(getComputedStyle(m).opacity)
      };
    });
  };
  P.one = function(id){ return P.markers().find(function(x){ return x.id === id; }); };
  P.tapAt = function(x, y){
    var el = document.elementFromPoint(x, y);
    var m = el && el.closest ? el.closest('.pin-marker') : null;
    return m ? m.dataset.id : null;
  };
})();`;

/** sRGB 상대휘도(WCAG) → 흰(#fff) 배경에 opacity 로 합성한 뒤의 대비비. */
const relLum = (r, g, b) => {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const compositeContrastVsWhite = (rgbStr, effOpacity) => {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(rgbStr || "");
  if (!m) return null;
  const op = Math.max(0, Math.min(1, effOpacity == null ? 1 : effOpacity));
  // 흰(255) 배경 위에 opacity 로 합성 — "서술 라벨" 이 아니라 실제 렌더 합성값.
  const r = 255 * (1 - op) + (+m[1]) * op;
  const g = 255 * (1 - op) + (+m[2]) * op;
  const b = 255 * (1 - op) + (+m[3]) * op;
  const L = relLum(r, g, b);
  return (1.05) / (L + 0.05);
};

async function runScenario(label, viewport) {
  console.log("── " + label + " ──");
  const page = await openRealMap({ width: viewport.w, height: viewport.h, canvas: { w: 2000, h: 1500 }, mutate });
  const ev = page.ev;
  try {
    await ev(`__M.pins(${JSON.stringify(PINS)}, { noFocus: true })`);
    await ev(PROBE);

    // ── (iii 선-조건) 줌인(맞춤 근처) — 정상 상태: 고립 핀은 28px + 번호 ──
    await ev(`__M.zoom(1)`);
    await new Promise((r) => setTimeout(r, 400));
    let mk = await ev("__P202.markers()");
    ok(mk.length === PINS.length, label + " 핀 " + PINS.length + "개 전부 마커 렌더(숨김 0, 실측 " + mk.length + ")");
    const isoNormal = mk.find((m) => m.id === "iso1");
    ok(isoNormal && !isoNormal.faded && isoNormal.w >= 27, label + " (iii 선-조건) 줌인 상태 고립 핀 = 28px(비페이드)", isoNormal);
    if (process.env.P202_SHOT && viewport.shot) {
      const dir = path.join(ROOT, ".tmp", "p202"); fs.mkdirSync(dir, { recursive: true });
      const s = await page.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(dir, "before-zoomed-in.png"), Buffer.from(s.data, "base64"));
    }

    // ── (i)(ii) 줌아웃 — 저작 크기(raw) 임계 미만으로 ──
    await ev(`__M.zoom(0.01)`);
    await new Promise((r) => setTimeout(r, 400));
    mk = await ev("__P202.markers()");
    ok(mk.length === PINS.length, label + " 줌아웃 후에도 핀 " + PINS.length + "개 전부 마커 렌더(숨김 0)");
    const allFaded = mk.every((m) => m.faded);
    ok(allFaded, label + " (i) 줌아웃 → 전체 핀 pin-dot-faded", { fadedCount: mk.filter((m) => m.faded).length, total: mk.length });
    const noNum = mk.every((m) => !m.showNum && m.numDisplay !== "block");
    ok(noNum, label + " (i) 줌아웃 → 번호(.pin-dot-num) 전부 숨김");
    const noShadow = mk.every((m) => m.boxShadow === "none");
    ok(noShadow, label + " (i) 줌아웃 → box-shadow 전부 제거");
    const sizeOk = mk.every((m) => m.w >= 5.5 && m.w <= 8.5);
    ok(sizeOk, label + " (i) 줌아웃 → 지름 6~8px 고정(허용오차, 실측 범위 " + Math.min(...mk.map((m) => m.w)).toFixed(2) + "~" + Math.max(...mk.map((m) => m.w)).toFixed(2) + "px)");
    const isoFaded = mk.find((m) => m.id === "iso1");
    ok(isoFaded && isoFaded.faded, label + " (ii) 고립 핀도 전역 줌아웃 게이트로 faded(결함 재현 포인트)", isoFaded);
    if (process.env.P202_SHOT && viewport.shot) {
      const dir = path.join(ROOT, ".tmp", "p202");
      const s = await page.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(dir, "after-zoomed-out.png"), Buffer.from(s.data, "base64"));
    }

    // ── (iv) 선택 핀은 전역 줌아웃 중에도 풀 핀 ──
    const pickId = teal[0].id;
    await ev(`(function(){ var m = document.querySelector('#pins-layer > .pin-marker[data-id="${pickId}"]'); m.classList.add('focused'); return 1; })()`);
    await new Promise((r) => setTimeout(r, 150));
    const focVisible = await ev(`(function(){ var m = document.querySelector('#pins-layer > .pin-marker[data-id="${pickId}"]'); var p = m.querySelector('.pin-pin'); return p && getComputedStyle(p).display !== 'none'; })()`);
    ok(focVisible === true, label + " (iv) 전역 줌아웃 중 선택 핀 = teardrop(.pin-pin) 풀 핀");
    await ev(`(function(){ var m = document.querySelector('#pins-layer > .pin-marker[data-id="${pickId}"]'); m.classList.remove('focused'); return 1; })()`);

    // ── (vi) 연한 점 대비(실제 합성 opacity) ──
    const sample = mk.find((m) => m.id === teal[0].id) || mk[0];
    const effOp = (sample.markerOpacity == null ? 1 : sample.markerOpacity) * (sample.dotOpacity == null ? 1 : sample.dotOpacity);
    const cr = compositeContrastVsWhite(sample.bg, effOp);
    ok(cr != null && cr >= 3, label + " (vi) 연한 점(bg=" + sample.bg + ", 실합성opacity=" + effOp.toFixed(2) + ") vs 흰 배경 대비 ≥ 3:1(실측 " + (cr == null ? "?" : cr.toFixed(2)) + ":1)");

    // ── 탭(클릭) 여전히 가능 ──
    const hitDot = mk[0];
    const tapRes = await ev(`(function(){ var m = document.querySelector('#pins-layer > .pin-marker[data-id="${mk[0].id}"] .pin-dot'); var r = m.getBoundingClientRect(); return __P202.tapAt(r.left + r.width/2, r.top + r.height/2); })()`);
    ok(!!tapRes, label + " 페이드 상태에서도 점 탭 = 핀 선택(실측 hit=" + tapRes + ")");

    // ── (iii) 확대 복귀 — 핀·번호 복귀, pin-dot-faded 제거 ──
    await ev(`__M.zoom(1)`);
    await new Promise((r) => setTimeout(r, 400));
    mk = await ev("__P202.markers()");
    const isoReverted = mk.find((m) => m.id === "iso1");
    ok(isoReverted && !isoReverted.faded && isoReverted.w >= 27 && isoReverted.showNum, label + " (iii) 확대 복귀 → 고립 핀 = 28px+번호, pin-dot-faded 제거", isoReverted);
    if (process.env.P202_SHOT && viewport.shot) {
      const dir = path.join(ROOT, ".tmp", "p202");
      const s = await page.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(dir, "reverted.png"), Buffer.from(s.data, "base64"));
    }

    // ── (v) 강제 모드 — 줌아웃과 무관 ──
    await ev(`PinShapePrefs.set('dot')`);
    await ev(`__M.zoom(0.01)`);
    await new Promise((r) => setTimeout(r, 400));
    mk = await ev("__P202.markers()");
    const forcedDotNoFade = mk.every((m) => !m.faded);
    ok(forcedDotNoFade, label + " (v) 강제 '점' 모드 — 전역 줌아웃에도 pin-dot-faded 미적용(기존 동작 불변)");
    await ev(`PinShapePrefs.set('pin')`);
    await new Promise((r) => setTimeout(r, 400));
    mk = await ev("__P202.markers()");
    const forcedPinNoFade = mk.every((m) => !m.faded);
    ok(forcedPinNoFade, label + " (v) 강제 '핀' 모드 — 전역 줌아웃에도 pin-dot-faded 미적용(기존 동작 불변)");
    await ev(`PinShapePrefs.set('auto')`);
  } finally {
    await page.close();
  }
}

await runScenario("데스크톱 1280x800", { w: 1280, h: 800, shot: true });
await runScenario("모바일 375x812", { w: 375, h: 812, shot: false }); // (vii)

console.log(MUT ? `\n[MUT=${MUT}] 의도적 되돌림 — 위 단언 중 일부는 반드시 FAIL 이어야 정상` : "");
console.log(failed ? `\n❌ p202 ${failed}건 FAIL` : "\n✅ p202 전체 PASS");
process.exit(failed ? 1 : 0);
