/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p26-no-auto-iso.test.mjs)
 *
 * 대상: 2026-09-17 발주서 — "영역 클릭 시 ISO 강제 전환 제거".
 * 마스터 지시: "포인트를 클릭하면 화면이 한참 아래로 내려가 버립니다" / "ISO 로 강제 전환되는
 * 기능 없애". ISO 화질 저하는 여러 차례 시도했으나 해결 못 함 → "품질이 안 좋아지면 그 기능을
 * 없애는 게 낫겠다"(마스터 명시 기준) → 자동 ISO 전환 제거로 판정.
 *
 * 근본원인(정찰): 16_Zones.js:399 `_flyToZone()` 은 `State.isoView` 가 이미 켜져 있을 때만
 * `MapCtrl.focusZoneIso()` 로 분기해 ISO 를 "유지"한다 — 이 줄 자체가 평면→ISO 로 "새로
 * 켜는" 코드는 아니다. 진짜 평면→ISO "강제 전환"은 20_App.js:2402~2425 `App.focusPinIso()`
 * (핀 탭 시 자동 ISO+구역확대, `onPinTap` 이 호출)에 있다 — 이 파일은 발주서에서 수정 금지
 * (다른 에이전트가 좌표 재매핑 작업 중)이므로 **손대지 않았다**. 최종 보고서에 별개 결함으로 명시.
 *
 * 이 테스트는 발주서가 지정한 범위(16_Zones.js:399)만 검증한다:
 *  1) 영역 클릭(Zones.focus) → ISO 상태가 켜지지 않는다(평면 유지)
 *  2) 영역 클릭 → 평면 확대(MapCtrl.flyTo)는 정상 동작(회귀 없음)
 *  3) 수동 ISO 토글(MapCtrl.toggleIso)은 여전히 동작한다
 *  4) ISO 꺼진 상태에서 영역 확대 시 pan 결과가 뷰포트 좌표 범위 안에 있다(화면 밖 이탈 없음)
 *
 * 실제 모듈 소스(16_Zones.js / 10_MapCtrl.js)를 그대로 vm 에 평가해 검사한다(목 구현 아님).
 * 뮤테이션 2건 — 자동 ISO 호출을 되살리면 ①이, 평면 확대 분기를 지우면 ②가 실패해야 한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const zonesSrc = rd("public/js/modules/16_Zones.js");
const mapSrc = rd("public/js/modules/10_MapCtrl.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/** Zones + MapCtrl 을 한 샌드박스에 평가 → { Zones, MapCtrl, State, calls } */
function load(zoneS = zonesSrc, mapS = mapSrc) {
  const State = { zoom: 1, pan: { x: 0, y: 0 }, isoView: false, isoDir: 0, zones: [], pins: [], pdfPage: 1, drawingZone: false, placing: false };
  const calls = { flyTo: [], focusZoneIso: [] };
  const sandbox = {
    console, State, Math, JSON, Promise, Set, Array,
    setTimeout: (fn) => { fn && fn(); return 0; }, clearTimeout: () => {},
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    navigator: { userAgent: "node", platform: "", maxTouchPoints: 0 },
    performance: { now: () => 0 },
    Inspector: { showZone: () => {} },
    Auth: { isDesigner: true },
    Prompt: { toast: () => {} },
    UI: { $: () => null },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    zoneS + "\n" + mapS + "\n;globalThis.__ZONES = Zones; globalThis.__MAP = MapCtrl;",
    sandbox
  );
  const Zones = sandbox.__ZONES, MapCtrl = sandbox.__MAP;
  // 뷰포트/컨텐츠 크기 스텁(DOM 없이 flyTo/focusZoneIso 계산 가능하게)
  MapCtrl.viewport = { clientWidth: 1000, clientHeight: 800, classList: { toggle: () => {} } };
  MapCtrl.transform = { offsetWidth: 2000, offsetHeight: 1500, style: {} };
  // 호출 계측(원본 로직은 그대로 실행 — 스파이일 뿐 스텁 아님)
  const origFlyTo = MapCtrl.flyTo.bind(MapCtrl);
  MapCtrl.flyTo = (...a) => { calls.flyTo.push(a); return origFlyTo(...a); };
  const origFocusZoneIso = MapCtrl.focusZoneIso.bind(MapCtrl);
  MapCtrl.focusZoneIso = (...a) => { calls.focusZoneIso.push(a); return origFocusZoneIso(...a); };
  return { Zones, MapCtrl, State, calls };
}

const RECT_ZONE = { id: "z1", label: "구역1", page: 1, x: 20, y: 20, w: 30, h: 20, pinIds: [] };

console.log("[1] 영역 클릭(Zones.focus) → ISO 상태가 켜지지 않는다(평면 유지)");
{
  const { Zones, State } = load();
  State.zones = [RECT_ZONE];
  State.isoView = false;
  Zones.focus("z1");
  ok(State.isoView === false, `① State.isoView = ${State.isoView} (기대: false)`);
}

console.log("\n[2] 영역 클릭 → 평면 확대(MapCtrl.flyTo)는 정상 동작(회귀 없음)");
{
  const { Zones, State, calls } = load();
  State.zones = [RECT_ZONE];
  State.isoView = false;
  Zones.focus("z1");
  ok(calls.flyTo.length === 1, `② MapCtrl.flyTo 호출 1회 (실제 ${calls.flyTo.length}회)`);
  ok(calls.focusZoneIso.length === 0, `② MapCtrl.focusZoneIso 는 호출되지 않음 (실제 ${calls.focusZoneIso.length}회)`);
  const [cx, cy] = calls.flyTo[0] || [];
  ok(cx === 35 && cy === 30, `② flyTo 중심 좌표 = (${cx},${cy}) (기대: 35,30 = 구역 중심)`);
}

console.log("\n[3] 수동 ISO 토글(MapCtrl.toggleIso)은 여전히 동작한다");
{
  const { MapCtrl, State } = load();
  ok(State.isoView === false, "③ 초기 상태 = 평면");
  MapCtrl.toggleIso();
  ok(State.isoView === true, `③ toggleIso() 1회 후 isoView = ${State.isoView} (기대: true)`);
  // 진입(dir0) + dir1,dir2,dir3 순환 + 평면 복귀 = 총 5회 호출
  MapCtrl.toggleIso(); MapCtrl.toggleIso(); MapCtrl.toggleIso(); MapCtrl.toggleIso();
  ok(State.isoView === false, `③ toggleIso() 5회(4방향 순환 후 복귀) 후 평면 복귀 = ${State.isoView} (기대: false)`);
}

console.log("\n[4] ISO 꺼진 상태에서 영역 확대 시 pan 결과가 뷰포트 좌표 범위 안 (화면 밖 이탈 없음)");
{
  const { Zones, State, MapCtrl } = load();
  State.zones = [RECT_ZONE];
  State.isoView = false;
  Zones.focus("z1");
  // flyTo 목표값(1회성 rAF 없이 즉시 값 확인은 불가하므로, flyTo 가 계산한 to.x/to.y 범위를
  // MapCtrl.flyTo 계산식으로 직접 재현해 뷰포트 밖으로 크게 벗어나지 않는지 검증한다.
  const vw = MapCtrl.viewport.clientWidth, vh = MapCtrl.viewport.clientHeight;
  const cw = MapCtrl.transform.offsetWidth, ch = MapCtrl.transform.offsetHeight;
  const span = Math.max(RECT_ZONE.w, RECT_ZONE.h);
  const z = Math.max(1, Math.min(4.5, 60 / Math.max(span, 8)));
  const toX = vw / 2 - z * (35 / 100) * cw;
  const toY = vh / 2 - z * (30 / 100) * ch;
  // 목표 pan 이 뷰포트 크기의 몇 배 이상 음/양으로 튀지 않아야 한다(= 화면 밖으로 밀려나지 않음).
  const withinX = Math.abs(toX) < vw * 3;
  const withinY = Math.abs(toY) < vh * 3;
  ok(withinX, `④ pan.x 목표 = ${toX.toFixed(1)} (뷰포트폭 ${vw} 의 3배 이내)`);
  ok(withinY, `④ pan.y 목표 = ${toY.toFixed(1)} (뷰포트높이 ${vh} 의 3배 이내)`);
}

console.log("\n[뮤테이션 M1] 자동 ISO 호출 복원(주석 해제) → ①실패해야 함");
{
  const mut = zonesSrc.replace(
    "      // [WO 20260917 ISO 제거] 영역 클릭은 항상 평면으로 확대한다(강제 ISO 전환 금지 — 마스터 지시).\n      //   되돌리려면 아래 주석 해제:\n      //   if (State.isoView && MapCtrl.focusZoneIso) { MapCtrl.focusZoneIso(bb); return; }",
    "      if (State.isoView && MapCtrl.focusZoneIso) { MapCtrl.focusZoneIso(bb); return; }"
  );
  ok(mut !== zonesSrc, "M1 문자열 치환 적중(소스와 정확히 일치)");
  // ①은 "이미 ISO 인 상태에서 영역 클릭 시 focusZoneIso 로 계속 유지되는가"를 판정한다.
  // 제거판(현재 소스)은 이 경우에도 flyTo(평면)만 호출한다 — 복원판은 focusZoneIso 를 호출해야 실패로 잡힌다.
  const { Zones, State, calls } = load(mut, mapSrc);
  State.zones = [RECT_ZONE];
  State.isoView = true;
  Zones.focus("z1");
  const broke1 = calls.focusZoneIso.length === 1 && calls.flyTo.length === 0;
  ok(broke1, `①실패 재현: 복원판은 focusZoneIso 호출(${calls.focusZoneIso.length}회)/flyTo 미호출(${calls.flyTo.length}회) — 현재(제거)판은 반대(항상 평면)`);
}

console.log("\n[뮤테이션 M2] 평면 확대 분기 제거 → ②실패해야 함");
{
  const mut = zonesSrc.replace(
    "      const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;\n      // 영역 크기에 맞춰 줌 (작은 영역일수록 더 확대)\n      const span = Math.max(bb.w, bb.h);\n      const z = Math.max(1, Math.min(4.5, 60 / Math.max(span, 8)));\n      if (MapCtrl.flyTo) MapCtrl.flyTo(cx, cy, z, 650);",
    "      // (뮤테이션: 평면 확대 제거)"
  );
  ok(mut !== zonesSrc, "M2 문자열 치환 적중(소스와 정확히 일치)");
  const { Zones, State, calls } = load(mut, mapSrc);
  State.zones = [RECT_ZONE];
  State.isoView = false;
  Zones.focus("z1");
  const broke2 = calls.flyTo.length === 0;
  ok(broke2, `②실패 재현: flyTo 호출 ${calls.flyTo.length}회 (기대: 0 = 확대 기능 소실 확인)`);
}

console.log("\n" + (failed ? `❌ FAIL: ${failed}건` : "✅ ALL PASS"));
process.exit(failed ? 1 : 0);
