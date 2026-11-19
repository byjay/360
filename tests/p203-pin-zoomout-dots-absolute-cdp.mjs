/**
 * p203 — WO 20261119-pinzoomdots2: 전역 줌아웃 페이드 게이트를 "절대 zoom"(State.zoom, 화면표시
 * % 그대로) 기준으로 재보정한다(실 Chrome, CDP, tests/_lib/real-map-page.mjs 하니스 재사용 — p202
 * 와 같은 패턴).
 *
 * [재현 R47] 지휘자 EGO 실측(2026-11-19, scan.seastar.work, 커밋 84cd99c, SB_ARCTIC VOYAGER, fitZoom≈0.78):
 *   맞춤(78%) 핀 거의 전부 번호 풍선, 36% 줌아웃에도 고립 핀(411·460·101·420)이 여전히 번호 풍선.
 *   근본원인: 전역 페이드 게이트가 _pinRawScreenPx()(fit **상대** 비율, zoom/fitZoom)를 8px 임계와
 *   비교 — fitZoom=0.78 문서에서 "rawPx<8"은 절대 zoom<20.8%에서만 발동해 마스터 요구("zoom≤50%")
 *   와 괴리가 컸다. 또한 고립 핀(이웃 없음, best=Infinity)의 지름은 밀도 알고리즘이 전혀 못 봐서
 *   항상 PIN_DOT_MAX_PX(28) 고정 — 줌아웃해도 전역 게이트 발동 전까지 "연속적으로 작아지지" 않았다.
 *
 * 검증(canvas 1510×900, 뷰포트 1280×800 → fitZoom≈0.78, 재현과 동일):
 *  (A) zoom=172% → 고립 핀 28px+번호, 페이드 없음(기존 p202 영역, 회귀 확인)
 *  (B)(C) zoom 78%→60%로 내려가며 고립 핀 지름이 "연속적으로" 감소(바닥에 눌려 평평하지 않음)
 *  (D) zoom=50%(경계, 포함) → 고립 핀 포함 전체 핀 pin-dot-faded(번호 0)
 *  (E) zoom=36% → 여전히 전체 페이드
 *  (F) 밀집 군집(zoom=78%, 비페이드) → 점 겹침 0쌍(§발주 ②, p177 패턴 재사용·회귀 확인)
 *  (G) 히스테리시스 — 36%(페이드)→55%(경계 안, 유지)→60%(경계 밖, 복귀)
 *  (H) 모바일 375×812·태블릿 884×1100 — 절대 zoom 50%/36%/172% 기준 동일(기기 독립 — 발주 §4)
 *  (I) 숨김 0 (markers.length == PINS.length, 항상)
 *
 * 실행: CHROME_PATH=... TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p203-pin-zoomout-dots-absolute-cdp.mjs
 * 뮤테이션(반드시 EXIT=1):
 *  P203_MUT=oldmetric      → 전역 게이트 지표를 fit-상대(_pinRawScreenPx)로 되돌림 → (D) zoom=50%에서
 *    고립 핀이 페이드되지 않아야(마스터가 본 결함 재현) — FAIL.
 *  P203_MUT=nocontinuous   → 고립 핀 연속감소 클램프 제거(diamScaled=diam) → (C) 60%/78% 지름이
 *    똑같이 28px로 평평 — FAIL.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openRealMap } from "./_lib/real-map-page.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (cond, label, d) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (d !== undefined ? " :: " + JSON.stringify(d) : "")); if (!cond) failed++; return cond; };

const MUT = process.env.P203_MUT || "";
const MUTS = {
  oldmetric: {
    file: "10_MapCtrl.js",
    needle: "const fadeMetricPx = this._zoomFadeMetricPx();",
    to: "const fadeMetricPx = this._pinRawScreenPx();",
  },
  nocontinuous: {
    file: "10_MapCtrl.js",
    needle: "const diamScaled = (best === Infinity) ? Math.min(diam, Math.max(this.PIN_DOT_MIN_PX, this._pinRawScreenPx())) : diam;",
    to: "const diamScaled = diam;",
  },
};
if (MUT && !MUTS[MUT]) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }
const mutate = (name, src) => {
  if (!MUT || MUTS[MUT].file !== name) return src;
  const { needle, to } = MUTS[MUT];
  if (!src.includes(needle)) { console.log("FAIL 뮤테이션 대상 없음(" + MUT + ")"); process.exit(2); }
  return src.replace(needle, to);
};

// 밀집(10×10=100개, 0.4% 간격) + 고립 1개(구석) — 점 개수를 충분히 키워 격자 셀(cell=sqrt(면적/n))을
// 작게 만든다. 고립 핀까지 포함한 전체 바운딩박스가 커서(이웃 탐색 한계 MAX_RING=8 셀) 실제로
// best=Infinity(진짜 이웃 없음)가 되는지 .tmp/debug203.mjs 로 사전 실측 확인(40개는 best 유한값으로
// 오염 — ring=8 이 군집까지 닿아버림, 100개로 셀이 작아져야 안 닿음).
const dense = [];
for (let iy = 0; iy < 10; iy++) for (let ix = 0; ix < 10; ix++) dense.push({ id: "d" + iy + "_" + ix, x: 10 + ix * 1.5, y: 10 + iy * 1.5, page: 1 });
const isolated = [{ id: "iso1", x: 95, y: 95, page: 1 }];
const PINS = [...dense, ...isolated];

const PROBE = String.raw`(function(){
  var P = window.__P203 = {};
  P.markers = function(){
    return Array.from(document.querySelectorAll('#pins-layer > .pin-marker')).map(function(m){
      var d = m.querySelector('.pin-dot');
      var r = d ? d.getBoundingClientRect() : null;
      return { id: m.dataset.id, faded: m.classList.contains('pin-dot-faded'), showNum: m.classList.contains('dot-show-num'), w: r ? r.width : null, cx: r ? r.left + r.width/2 : null, cy: r ? r.top + r.height/2 : null };
    });
  };
  P.one = function(id){ return P.markers().find(function(x){ return x.id === id; }); };
})();`;

async function runScenario(label, viewport, checkShrink) {
  console.log("── " + label + " ──");
  const page = await openRealMap({ width: viewport.w, height: viewport.h, canvas: { w: 1510, h: 900 }, mutate });
  const ev = page.ev;
  try {
    await ev(`__M.pins(${JSON.stringify(PINS)}, { noFocus: true })`);
    await ev(PROBE);

    // (A) zoom=172% — 고립 핀 풀 사이즈, 페이드 없음
    await ev(`__M.zoom(1.72)`);
    await new Promise((r) => setTimeout(r, 350));
    let iso = await ev(`__P203.one('iso1')`);
    ok(iso && !iso.faded && iso.w >= 27, label + " (A) zoom=172% 고립 핀 28px 비페이드", iso);
    const w172 = iso.w;

    // (B)(C) 78% → 60% 연속 감소(바닥에 눌리지 않음)
    await ev(`__M.zoom(0.78)`);
    await new Promise((r) => setTimeout(r, 350));
    iso = await ev(`__P203.one('iso1')`);
    const w78 = iso.w;
    ok(iso && !iso.faded, label + " (B) zoom=78% 고립 핀 비페이드", iso);

    await ev(`__M.zoom(0.60)`);
    await new Promise((r) => setTimeout(r, 350));
    iso = await ev(`__P203.one('iso1')`);
    const w60 = iso.w;
    if (checkShrink) {
      // [연속감소 윈도우는 fitZoom 의존] "비페이드(zoom>50%)이면서 28px 상한에 덜 눌린" 구간은
      // zoom 범위가 (0.5, 0.933×fitZoom) 일 때만 존재한다(0.933=28/30, §_pinRawScreenPx 주석).
      // fitZoom≈0.78(데스크톱, 재현과 동일)이면 (0.5,0.728) 구간이 50%보다 위라 보이지만, fitZoom
      // 이 작은 기기(모바일 0.228·태블릿 0.539)는 그 구간이 0.5 밑이라 전역 페이드가 먼저 켜져
      // "눌린 28px" 상태를 볼 일이 없다(메커니즘은 동일 코드, 그냥 안 보일 뿐 — 발주 §1 의도 충족).
      // 그래서 이 연속감소 단언은 데스크톱(재현 fitZoom)에서만 확인한다.
      ok(iso && !iso.faded, label + " (C-전제) zoom=60% 아직 비페이드", iso);
      ok(w60 < w78 - 0.3 && w78 <= w172 + 0.3, label + " (C) 연속 감소(172%>=78%>60%, 바닥에 눌리지 않음)", { w172, w78, w60 });
    }

    // (D) zoom=50%(경계, 포함) — 전체 핀 페이드
    await ev(`__M.zoom(0.50)`);
    await new Promise((r) => setTimeout(r, 350));
    let mk = await ev("__P203.markers()");
    ok(mk.length === PINS.length, label + " (I) zoom=50% 숨김 0(핀 " + PINS.length + "개 전부 마커)");
    ok(mk.every((m) => m.faded), label + " (D) zoom=50%(경계 포함) 전체 핀 pin-dot-faded", { faded: mk.filter((m) => m.faded).length, total: mk.length });
    const isoD = mk.find((m) => m.id === "iso1");
    ok(isoD && isoD.faded && isoD.w <= 8.5, label + " (D) 고립 핀도 50%에서 페이드(결함 재현 포인트)", isoD);

    // (E) zoom=36% — 여전히 페이드
    await ev(`__M.zoom(0.36)`);
    await new Promise((r) => setTimeout(r, 350));
    mk = await ev("__P203.markers()");
    ok(mk.every((m) => m.faded), label + " (E) zoom=36% 전체 페이드 유지");

    // (G) 히스테리시스 — 36%(페이드) → 55%(경계 안, 유지) → 60%(경계 밖, 복귀)
    await ev(`__M.zoom(0.55)`);
    await new Promise((r) => setTimeout(r, 350));
    iso = await ev(`__P203.one('iso1')`);
    ok(iso && iso.faded, label + " (G1) 36%→55%(히스테리시스 밴드 안) 페이드 유지", iso);
    await ev(`__M.zoom(0.60)`);
    await new Promise((r) => setTimeout(r, 350));
    iso = await ev(`__P203.one('iso1')`);
    ok(iso && !iso.faded, label + " (G2) 55%→60%(경계 밖) 페이드 해제", iso);

    // (F) 밀집 군집(zoom=78%, 비페이드) — 점 겹침 0쌍
    await ev(`__M.zoom(0.78)`);
    await new Promise((r) => setTimeout(r, 350));
    mk = await ev("__P203.markers()");
    const dots = mk.filter((m) => m.id.startsWith("d") && m.cx != null);
    let overlaps = 0;
    for (let i = 0; i < dots.length; i++) for (let j = i + 1; j < dots.length; j++) {
      const a = dots[i], b = dots[j];
      const d = Math.hypot(a.cx - b.cx, a.cy - b.cy);
      if (d < (a.w + b.w) / 2 - 0.5) overlaps++;
    }
    ok(overlaps === 0, label + " (F) 밀집 군집 zoom=78% 겹침 0쌍(실측 " + overlaps + "/" + (dots.length * (dots.length - 1) / 2) + ")");
  } finally {
    await page.close();
  }
}

await runScenario("데스크톱 1280x800", { w: 1280, h: 800 }, true);
await runScenario("모바일 375x812", { w: 375, h: 812 }, false);       // (H) — (C)는 위 주석 이유로 생략
await runScenario("태블릿 884x1100", { w: 884, h: 1100 }, false);     // (H) — (C)는 위 주석 이유로 생략

console.log(MUT ? `\n[MUT=${MUT}] 의도적 되돌림 — 위 단언 중 일부는 반드시 FAIL 이어야 정상` : "");
console.log(failed ? `\n❌ p203 ${failed}건 FAIL` : "\n✅ p203 전체 PASS");
process.exit(failed ? 1 : 0);
