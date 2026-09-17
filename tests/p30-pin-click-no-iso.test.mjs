/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p30-pin-click-no-iso.test.mjs)
 *
 * 대상: 2026-09-17 발주서(WO 20260917_pin) — "포인트 클릭 시 ISO 자동전환 제거 + 화면 밀림 방지".
 * 마스터 지시: "포인트를 클릭하면 화면이 한참 아래로 내려가 버립니다" / "포인트를 클릭하면
 * ISO 전환 없애고, 오른쪽에 상·하단 창을 띄우고…" — ISO 자동전환만 제거하고 평면 이동/확대는 유지한다.
 *
 * 근본원인(발주서 확정): 20_App.js:2402~2425 `App.focusPinIso()` 가 핀 탭 시 자동으로
 * `MapCtrl.focusZoneIso()`(ISO 강제 전환 + 구역확대)를 호출한다 — `onPinTap` 이 그 진입점.
 * 16_Zones.js:397 의 영역-클릭 ISO 제거(a23d26d)와는 별개 결함(그건 "유지" 분기였을 뿐
 * 평면→ISO 로 새로 켜는 코드가 아니었다).
 *
 * 수정: focusPinIso() 내부의 `MapCtrl.focusZoneIso(bbox)` 호출을 `MapCtrl.fitZone(bbox)`
 * (평면 전용 확대, ISO 미관여)로 교체. onPinTap 의 "focused" 판정에서 `State.isoView` 조건도
 * 제거(더 이상 ISO 를 자동으로 켜지 않으므로 activePin 일치만으로 2-tap 판정).
 *
 * 검증 항목(발주서 5종):
 *  1) 핀 클릭 → ISO 가 켜지지 않는다
 *  2) 핀 클릭 → 평면 상태로 그 핀(구역 중심)으로 이동한다(MapCtrl.fitZone 호출, 회귀 없음)
 *  3) 이동 후 뷰포트가 도면 범위를 벗어나지 않는다(fitZone 의 줌 클램프가 살아있어 pan 이
 *     뷰포트 크기의 3배 이내 — 화면 밖 이탈 없음)
 *  4) 수동 ISO 토글(MapCtrl.toggleIso)은 여전히 동작한다
 *  5) 이미 ISO 인 상태에서 핀을 클릭해도 focusZoneIso 가 호출되지 않는다(강제로 새로 켜지 않음,
 *     isoDir 도 그대로 유지)
 *
 * 실제 모듈 소스(20_App.js / 10_MapCtrl.js)를 그대로 vm 에 평가해 검사한다(목 구현 아님).
 * 뮤테이션 2건:
 *   M1 — focusPinIso 내부를 다시 MapCtrl.focusZoneIso(bbox) 호출로 되돌리면 ①이 실패해야 한다.
 *   M2 — MapCtrl.fitZone 의 줌 클램프(`z = Math.max(0.3, Math.min(8, z))`)를 제거하면
 *        ③(뷰포트 범위 이내)이 실패해야 한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const appSrc = rd("public/js/modules/20_App.js");
const mapSrc = rd("public/js/modules/10_MapCtrl.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/** App + MapCtrl 을 한 샌드박스에 평가 → { App, MapCtrl, State, calls } */
function load(appS = appSrc, mapS = mapSrc) {
  const State = {
    zoom: 1, pan: { x: 0, y: 0 }, isoView: false, isoDir: 0,
    zones: [], pins: [], pdfPage: 1, activePin: null, mode: "viewer",
    drawingZone: false, placing: false,
  };
  const calls = { flyTo: [], focusZoneIso: [], fitZone: [] };
  const sandbox = {
    console, State, Math, JSON, Promise, Set, Array,
    setTimeout: (fn) => { fn && fn(); return 0; }, clearTimeout: () => {},
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { toggle() {}, add() {}, remove() {} } }),
      body: { appendChild() {}, removeChild() {} },
    },
    window: {},
    navigator: { userAgent: "node", platform: "", maxTouchPoints: 0 },
    performance: { now: () => 0 },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
    Blob: function () {},
    UI: { $: () => null, renderPinList: () => {}, renderPinsOnMap: () => {} },
    Zones: { _contains: () => false },
    Auth: { isDesigner: true, r2: (u) => u },
    Prompt: { toast: () => {} },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    appS + "\n" + mapS + "\n;globalThis.__APP = App; globalThis.__MAP = MapCtrl;",
    sandbox
  );
  const App = sandbox.__APP, MapCtrl = sandbox.__MAP;
  // 뷰포트/컨텐츠 크기 스텁(DOM 없이 flyTo/fitZone/focusZoneIso 계산 가능하게)
  MapCtrl.viewport = { clientWidth: 1000, clientHeight: 800, classList: { toggle: () => {} } };
  MapCtrl.transform = { offsetWidth: 2000, offsetHeight: 1500, style: {} };
  // 호출 계측(원본 로직은 그대로 실행 — 스파이일 뿐 스텁 아님)
  const origFlyTo = MapCtrl.flyTo.bind(MapCtrl);
  MapCtrl.flyTo = (...a) => { calls.flyTo.push(a); return origFlyTo(...a); };
  const origFocusZoneIso = MapCtrl.focusZoneIso.bind(MapCtrl);
  MapCtrl.focusZoneIso = (...a) => { calls.focusZoneIso.push(a); return origFocusZoneIso(...a); };
  const origFitZone = MapCtrl.fitZone.bind(MapCtrl);
  MapCtrl.fitZone = (...a) => { calls.fitZone.push(a); return origFitZone(...a); };
  return { App, MapCtrl, State, calls };
}

const ZONE = { id: "z1", label: "구역1", page: 1, x: 20, y: 20, w: 30, h: 20, pinIds: ["p1"] };
const PIN = { id: "p1", page: 1, x: 30, y: 25, label: "P1" };
// 클램프 검증용: 극단적으로 작은 구역(z 가 클램프 없이는 폭주하도록)
const ZONE_TINY = { id: "zt", label: "미세구역", page: 1, x: 10, y: 10, w: 0.5, h: 0.5, pinIds: ["pt"] };
const PIN_TINY = { id: "pt", page: 1, x: 10.25, y: 10.25, label: "PT" };

console.log("[1] 핀 클릭 → ISO 가 켜지지 않는다");
{
  const { App, State } = load();
  State.zones = [ZONE]; State.pins = [PIN];
  App.onPinTap(PIN);
  ok(State.isoView === false, `① State.isoView = ${State.isoView} (기대: false)`);
}

console.log("\n[2] 핀 클릭 → 평면 상태로 그 핀(구역 중심)으로 이동한다(회귀 없음)");
{
  const { App, State, calls } = load();
  State.zones = [ZONE]; State.pins = [PIN];
  App.onPinTap(PIN);
  ok(calls.fitZone.length === 1, `② MapCtrl.fitZone 호출 1회 (실제 ${calls.fitZone.length}회)`);
  ok(calls.focusZoneIso.length === 0, `② MapCtrl.focusZoneIso 는 호출되지 않음 (실제 ${calls.focusZoneIso.length}회)`);
  const bbox = calls.fitZone[0] && calls.fitZone[0][0];
  ok(bbox && bbox.x === 20 && bbox.y === 20 && bbox.w === 30 && bbox.h === 20, `② fitZone bbox = ${JSON.stringify(bbox)} (기대: 구역 z1 그대로)`);
  ok(State.activePin === "p1", `② State.activePin = ${State.activePin} (기대: p1)`);
}

console.log("\n[3] 이동 후 뷰포트가 도면 범위를 벗어나지 않는다(줌 클램프 생존 확인)");
{
  const { App, State, MapCtrl, calls } = load();
  State.zones = [ZONE_TINY]; State.pins = [PIN_TINY];
  App.onPinTap(PIN_TINY);
  ok(calls.flyTo.length === 1, `③ MapCtrl.flyTo 호출 1회 (실제 ${calls.flyTo.length}회, fitZone 경유)`);
  const [cx, cy, z] = calls.flyTo[0] || [];
  const vw = MapCtrl.viewport.clientWidth, vh = MapCtrl.viewport.clientHeight;
  const cw = MapCtrl.transform.offsetWidth, ch = MapCtrl.transform.offsetHeight;
  const toX = vw / 2 - z * (cx / 100) * cw;
  const toY = vh / 2 - z * (cy / 100) * ch;
  ok(z <= 8, `③ 클램프된 줌 z = ${z} (기대: <= 8)`);
  ok(Math.abs(toX) < vw * 3, `③ pan.x 목표 = ${toX.toFixed(1)} (뷰포트폭 ${vw} 의 3배 이내)`);
  ok(Math.abs(toY) < vh * 3, `③ pan.y 목표 = ${toY.toFixed(1)} (뷰포트높이 ${vh} 의 3배 이내)`);
}

console.log("\n[4] 수동 ISO 토글(MapCtrl.toggleIso)은 여전히 동작한다");
{
  const { MapCtrl, State } = load();
  ok(State.isoView === false, "④ 초기 상태 = 평면");
  MapCtrl.toggleIso();
  ok(State.isoView === true, `④ toggleIso() 1회 후 isoView = ${State.isoView} (기대: true)`);
  MapCtrl.toggleIso(); MapCtrl.toggleIso(); MapCtrl.toggleIso(); MapCtrl.toggleIso();
  ok(State.isoView === false, `④ toggleIso() 5회(4방향 순환 후 복귀) 후 평면 복귀 = ${State.isoView} (기대: false)`);
}

console.log("\n[5] 이미 ISO 인 상태에서 핀을 클릭해도 강제로 ISO 를 새로 켜지 않는다");
{
  const { App, State, calls } = load();
  State.zones = [ZONE]; State.pins = [PIN];
  State.isoView = true; State.isoDir = 2; // 수동으로 이미 ISO 켜둔 상태(방향 2)
  App.onPinTap(PIN);
  ok(calls.focusZoneIso.length === 0, `⑤ MapCtrl.focusZoneIso 호출 안 함 (실제 ${calls.focusZoneIso.length}회)`);
  ok(State.isoView === true, `⑤ State.isoView 그대로 유지 = ${State.isoView} (기대: true, 강제 변경 없음)`);
  ok(State.isoDir === 2, `⑤ State.isoDir 그대로 유지 = ${State.isoDir} (기대: 2, focusZoneIso 가 0으로 리셋하지 않음)`);
}

console.log("\n[뮤테이션 M1] focusPinIso 를 다시 MapCtrl.focusZoneIso(bbox) 호출로 되돌리면 → ①실패해야 함");
{
  const NEEDLE =
    "      // [WO 20260917-pin ISO 제거] 핀 탭은 항상 평면으로 확대한다(강제 ISO 전환 금지 — 마스터 지시).\n" +
    "      //   되돌리려면 아래 주석 해제(16_Zones.js:397 와 동일 패턴):\n" +
    "      //   MapCtrl.focusZoneIso(bbox); return;\n" +
    "      if (MapCtrl.fitZone) MapCtrl.fitZone(bbox);";
  const REPLACEMENT = "      MapCtrl.focusZoneIso(bbox);";
  const mut = appSrc.replace(NEEDLE, REPLACEMENT);
  ok(mut !== appSrc, "M1 문자열 치환 적중(소스와 정확히 일치)");
  const { App, State, calls } = load(mut, mapSrc);
  State.zones = [ZONE]; State.pins = [PIN];
  App.onPinTap(PIN);
  const broke1 = State.isoView === true && calls.focusZoneIso.length === 1;
  ok(broke1, `①실패 재현: 복원판은 isoView=${State.isoView}·focusZoneIso 호출 ${calls.focusZoneIso.length}회 — 현재(제거)판은 반대(평면 유지)`);
}

console.log("\n[뮤테이션 M2] MapCtrl.fitZone 의 줌 클램프 제거 → ③실패해야 함");
{
  const NEEDLE = "      z = Math.max(0.3, Math.min(8, z)); // MapCtrl 줌 한계 내로";
  const REPLACEMENT = "      // (뮤테이션: 줌 클램프 제거)";
  const mut = mapSrc.replace(NEEDLE, REPLACEMENT);
  ok(mut !== mapSrc, "M2 문자열 치환 적중(소스와 정확히 일치)");
  const { App, State, MapCtrl, calls } = load(appSrc, mut);
  State.zones = [ZONE_TINY]; State.pins = [PIN_TINY];
  App.onPinTap(PIN_TINY);
  const [cx, cy, z] = calls.flyTo[0] || [];
  const vw = MapCtrl.viewport.clientWidth, cw = MapCtrl.transform.offsetWidth;
  const toX = vw / 2 - z * (cx / 100) * cw;
  const broke3 = z > 8 && Math.abs(toX) >= vw * 3;
  ok(broke3, `③실패 재현: 클램프 제거판은 z=${z}(>8), pan.x=${toX.toFixed(1)}(뷰포트폭 3배 밖) — 현재(클램프)판은 범위 내`);
}

console.log("\n" + (failed ? `❌ FAIL: ${failed}건` : "✅ ALL PASS"));
process.exit(failed ? 1 : 0);
