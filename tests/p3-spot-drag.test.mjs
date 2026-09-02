/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p3-spot-drag.test.mjs)
 *
 * 마스터 지시 "마크때문에 가려지는 경우가 있으니 드래그로 가능하게해":
 *  360 파노라마 안 숫자 마커를 끌어서 위치(lon/lat)를 옮길 수 있어야 한다.
 *  ① 마커 위 pointerdown이 카메라 드래그(S.dragging)로 안 넘어감(편집권한 있을 때)
 *  ② 이동 후 spot.lon/lat 갱신 + onPointerUp이 저장 신호를 반환 + App.js가 그 신호로 _saveSpots를 호출하도록 배선됨
 *  ③ 이동 없이 놓으면(탭) 카메라 드래그로 안 넘어가되, wasTap()=true → 기존 노트 열기 경로 보존
 *  ④ 뷰어 권한(State.mode!=="designer")에서는 마커 위에서도 이동이 시작되지 않고 종전처럼 카메라 드래그로 처리됨
 *
 * 실제 모듈 소스(public/js/modules/06_PanoViewer.js)를 그대로 vm에 평가해 검사한다(목 구현 아님).
 * public/js/modules/20_App.js 는 초대형 God-object라 전체를 vm으로 구동하는 대신,
 * 저장 신호(onPointerUp 반환값) → _finalizeSpotDrag → _saveSpots 로 이어지는 배선을
 * 실제 소스 문자열에서 확인한다(②의 "저장 호출" 증거).
 * 각 검사에는 뮤테이션(수정 무력화) 케이스가 붙어 있어, 고친 코드를 되돌리면 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// [견고화] 소스 파일의 CRLF/LF 혼재(Windows 편집 이력)로 인해 멀티라인 뮤테이션 needle이
// 어긋나지 않도록 \n으로 통일한 뒤 비교/치환한다(실행 의미는 동일 — 순수 텍스트 정규화).
const pvSrc = fs.readFileSync(path.join(ROOT, "public/js/modules/06_PanoViewer.js"), "utf8").replace(/\r\n/g, "\n");
const appSrc = fs.readFileSync(path.join(ROOT, "public/js/modules/20_App.js"), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 최소 THREE 목(mock) — 실제 기하는 검증 대상이 아니므로 결정적 값만 보장 ───────── */
function makeThreeMock() {
  const state = { nextHit: null }; // hitSpotAt()가 맞힐 spotId. null이면 "빈 곳"
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone() { return new Vector3(this.x, this.y, this.z); }
    normalize() { return this; } // 목 방향벡터는 이미 정규화된 상수(0,0,1) 사용
  }
  class Vector2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } }
  class Raycaster {
    setFromCamera() { this.ray = { direction: new Vector3(0, 0, 1) }; }
    intersectObjects(children) {
      const id = state.nextHit;
      if (id == null) return [];
      const obj = children.find((c) => c.userData && c.userData.spotId === id);
      return obj ? [{ object: obj }] : [];
    }
  }
  const THREE = {
    MathUtils: {
      degToRad: (d) => (d * Math.PI) / 180,
      radToDeg: (r) => (r * 180) / Math.PI
    },
    Vector3, Vector2, Raycaster
  };
  return { THREE, state };
}

/** PanoViewer 모듈을 새 vm 컨텍스트에 평가하고, 이미 spots 1개가 렌더된 상태로 세팅한다. */
function makePV(src, { role = "designer" } = {}) {
  const { THREE, state } = makeThreeMock();
  const toasts = [];
  const State = { mode: role === "designer" ? "designer" : "viewer" };
  const Auth = { isDesigner: role === "designer" };
  const Prompt = { toast: (m) => toasts.push(m) };
  const Radar = { spin() {} };
  const sandbox = { console, THREE, State, Auth, Prompt, Radar, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__PV = PanoViewer;", sandbox);
  const PV = sandbox.__PV;

  // 이미 렌더된 마커 1개(sp1)를 흉내: 실제 renderSpots()가 만들어내는 최소 형태
  const spotData = { id: "sp1", lon: 10, lat: 5 };
  const sprite = { userData: { spotId: "sp1" }, position: new THREE.Vector3(0, 0, 0) };
  PV._spots = [spotData];
  PV._spotGroup = { children: [sprite] };
  PV.camera = {};
  PV.renderer = {};
  PV.canvas = { style: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };

  return { PV, hitState: state, spotData, sprite, toasts };
}

/* ────────────────────────────────────────────────────────────
 * ① 마커 위 pointerdown → 카메라 드래그(S.dragging)로 안 넘어감
 * ──────────────────────────────────────────────────────────── */
function suiteNoCamera(label, src) {
  console.log("\n[" + label + "]");
  const { PV, hitState } = makePV(src, { role: "designer" });
  hitState.nextHit = "sp1";
  PV.onPointerDown(50, 50);
  ok(PV.S.dragging === false, "마커 위 pointerdown → S.dragging=false(카메라 회전 안 함)");
  ok(PV._dragSpotId === "sp1", "마커 위 pointerdown → _dragSpotId=sp1 로 드래그 대상 확정");
}

/* ────────────────────────────────────────────────────────────
 * ② 이동 후 spot.lon/lat 갱신 + onPointerUp 저장신호 + App.js가 그 신호로 저장 호출
 * ──────────────────────────────────────────────────────────── */
function suiteMoveAndSave(label, src) {
  console.log("\n[" + label + "]");
  const { PV, hitState, spotData } = makePV(src, { role: "designer" });
  hitState.nextHit = "sp1";
  PV.onPointerDown(50, 50);
  PV.onPointerMove(90, 50); // 40px 이동 → 임계값(6px) 초과
  ok(PV._moved === true, "6px 초과 이동 → _moved=true");
  ok(spotData.lon !== 10 || spotData.lat !== 5, `spot 데이터 갱신됨 (lon=${spotData.lon}, lat=${spotData.lat})`);
  const r = PV.onPointerUp();
  ok(!!(r && r.spotMoved === "sp1"), "onPointerUp() → { spotMoved: 'sp1' } 반환(저장 확정 신호)");
  ok(PV._dragSpotId === null, "onPointerUp 후 _dragSpotId 초기화");

  // App.js 배선: 그 신호를 받아 _saveSpots까지 이어지는지 소스로 확인
  ok(/const r = PanoViewer\.onPointerUp\(\);\s*\n\s*if \(r && r\.spotMoved\) this\._finalizeSpotDrag\(r\.spotMoved\);/.test(appSrc),
    "App.js mouseup 핸들러가 onPointerUp() 반환값을 보고 _finalizeSpotDrag를 호출함");
  ok(/if \(r && r\.spotMoved\) \{ this\._finalizeSpotDrag\(r\.spotMoved\); return; \}/.test(appSrc),
    "App.js touchend 핸들러도 동일하게 배선됨");
  const finalizeMatch = appSrc.match(/_finalizeSpotDrag\(id\) \{([\s\S]*?)\n    \},/);
  ok(!!finalizeMatch && /this\._saveSpots\(pin\)/.test(finalizeMatch[1]),
    "App.js _finalizeSpotDrag()가 this._saveSpots(pin)을 호출함(저장 확정)");
}

/* ────────────────────────────────────────────────────────────
 * ③ 이동 없이 놓으면(탭) → wasTap()=true 로 기존 '노트 열기' 경로 보존
 * ──────────────────────────────────────────────────────────── */
function suiteTapStillOpens(label, src) {
  console.log("\n[" + label + "]");
  const { PV, hitState } = makePV(src, { role: "designer" });
  hitState.nextHit = "sp1";
  PV.onPointerDown(50, 50);
  // 이동 이벤트 없이 바로 뗌
  const r = PV.onPointerUp();
  ok(r === null, "이동 없이 놓으면 onPointerUp()이 저장신호를 반환하지 않음");
  ok(PV.wasTap() === true, "이동 없이 놓으면 wasTap()=true → _onPanoTap이 hitSpotAt으로 노트를 염(회귀 없음)");
  ok(PV.hitSpotAt(50, 50) === "sp1", "탭 위치에 hitSpotAt이 여전히 sp1을 반환(_openSpot 경로 유지)");
}

/* ────────────────────────────────────────────────────────────
 * ④ 뷰어 권한 — 마커 위에서도 이동 시작 안 되고 종전처럼 카메라 드래그
 * ──────────────────────────────────────────────────────────── */
function suiteViewerBlocked(label, src) {
  console.log("\n[" + label + "]");
  const { PV, hitState } = makePV(src, { role: "viewer" });
  hitState.nextHit = "sp1"; // 뷰어라도 커서 아래 마커는 있음
  PV.onPointerDown(50, 50);
  ok(PV._dragSpotId === null, "뷰어 권한 → pointerdown이 마커를 드래그 대상으로 잡지 않음");
  ok(PV.S.dragging === true, "뷰어 권한 → 종전처럼 카메라 드래그(S.dragging=true)로 처리");
}

/* ────────────────────────────────────────────────────────────
 * 실행: 정상 소스
 * ──────────────────────────────────────────────────────────── */
suiteNoCamera("① 마커 드래그 시작 시 카메라 회전 차단", pvSrc);
suiteMoveAndSave("② 드래그 이동 → 데이터 갱신 + 저장 배선", pvSrc);
suiteTapStillOpens("③ 이동 없는 탭은 기존 노트 열기 유지", pvSrc);
suiteViewerBlocked("④ 뷰어 권한은 마커 이동 불가", pvSrc);

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 증명: onPointerDown이 hit 여부와 무관하게 항상 카메라 드래그로 넘어가면 ①이 실패해야 함
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션] onPointerDown 분기를 제거하면 ①이 실패해야 함");
  const needle = `    onPointerDown(x, y) {
      this._downX = x; this._downY = y; this._moved = false;
      const hitId = this.canEditSpots() ? this.hitSpotAt(x, y) : null;
      this._dragSpotId = hitId || null;
      if (hitId) {
        // 마커를 잡은 동안엔 카메라가 회전하면 안 됨
        this.S.dragging = false;
        if (this.canvas) this.canvas.style.cursor = "grabbing";
      } else {
        this.S.dragging = true; this.S.lx = x; this.S.ly = y;
      }
    },`;
  const replacement = `    onPointerDown(x, y) {
      this._downX = x; this._downY = y; this._moved = false;
      this.S.dragging = true; this.S.lx = x; this.S.ly = y;
    },`;
  const mutated = pvSrc.replace(needle, replacement);
  if (mutated === pvSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PV, hitState } = makePV(mutated, { role: "designer" });
    hitState.nextHit = "sp1";
    PV.onPointerDown(50, 50);
    ok(PV.S.dragging !== false, "뮤테이션 적용 시 마커 위에서도 카메라 드래그로 뒤집힘(테스트가 실효성 있음을 증명)");
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 증명: moveSpot이 데이터(this._spots)를 갱신하지 않으면 ②가 실패해야 함
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션] moveSpot의 데이터 갱신을 제거하면 ②가 실패해야 함");
  const needle = `      const data = (this._spots || []).find(s => s.id === id);
      if (data) { data.lon = lon; data.lat = lat; }
      this._invalidate();`;
  const replacement = `      this._invalidate();`;
  const mutated = pvSrc.replace(needle, replacement);
  if (mutated === pvSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PV, hitState, spotData } = makePV(mutated, { role: "designer" });
    hitState.nextHit = "sp1";
    PV.onPointerDown(50, 50);
    PV.onPointerMove(90, 50);
    const unchanged = (spotData.lon === 10 && spotData.lat === 5);
    ok(unchanged === true, "뮤테이션 적용 시 spot 데이터가 갱신되지 않게 뒤집힘(테스트가 실효성 있음을 증명)");
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 증명: canEditSpots가 항상 true면 뷰어에서도 드래그가 시작되어 ④가 실패해야 함
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션] canEditSpots를 항상 true로 만들면 ④가 실패해야 함");
  const needle = `    canEditSpots() {
      return typeof State !== "undefined" && State.mode === "designer" &&
        (typeof Auth === "undefined" || Auth.isDesigner);
    },`;
  const replacement = `    canEditSpots() { return true; },`;
  const mutated = pvSrc.replace(needle, replacement);
  if (mutated === pvSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PV, hitState } = makePV(mutated, { role: "viewer" });
    hitState.nextHit = "sp1";
    PV.onPointerDown(50, 50);
    ok(PV._dragSpotId !== null, "뮤테이션 적용 시 뷰어도 마커를 드래그 대상으로 잡게 뒤집힘(테스트가 실효성 있음을 증명)");
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
