/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p23-spot-list-by-photo.test.mjs)
 *
 * 마스터 지시: "마커목록은 해당 사진에서만 뜨게 하고, 다른 사진에 있다면 구역 이동을 하게 하고,
 *              목록을 사진별로 소트되게 해".
 *
 * [현황 확인] App.renderSpotList()(20_App.js)는 이미 PanoViewer._currentPin.spots 만 읽어
 * "현재 사진의 마커만" 표시한다(①은 이미 충족 — 아래 test1 이 소스로 이를 확인·고정한다).
 * 이 테스트가 검증하는 실 구현 대상은 새로 추가한 PanoViewer.buildSpotGroups()/spotRowAction()
 * (public/js/modules/06_PanoViewer.js) 이다 — 20_App.js 의 renderSpotList 는 다른 에이전트가
 * 동시 작업 중이라 이번 작업에서 건드리지 않는다(파일 충돌 방지 지시 준수).
 * App.renderSpotList()가 이 두 함수를 호출하도록 배선하는 것이 남은 통합 작업이다.
 *
 * 실제 모듈 소스를 vm에 그대로 평가해 검사(목 구현 아님). 뮤테이션 2건 포함.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pvSrc = fs.readFileSync(path.join(ROOT, "public/js/modules/06_PanoViewer.js"), "utf8").replace(/\r\n/g, "\n");
const appSrc = fs.readFileSync(path.join(ROOT, "public/js/modules/20_App.js"), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

function loadPV(src) {
  const sandbox = { console, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, performance };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__PV = PanoViewer;", sandbox);
  return sandbox.__PV;
}

/* 테스트 데이터: 3개 핀 — 현재 핀(2 마커), B동(1 마커), A동(1 마커), C동(마커 0개) */
function makePins() {
  const cur = { id: "p-cur", label: "현재사진", spots: [{ id: "s1", lon: 1, lat: 1, label: "결함1" }, { id: "s2", lon: 2, lat: 2, label: "결함2" }] };
  const bdong = { id: "p-b", label: "B동", spots: [{ id: "s3", lon: 3, lat: 3, label: "장비1" }] };
  const adong = { id: "p-a", label: "A동", spots: [{ id: "s4", lon: 4, lat: 4, label: "장비2" }] };
  const cdong = { id: "p-c", label: "C동", spots: [] };
  return { pins: [cur, bdong, adong, cdong], cur, bdong, adong, cdong };
}

/* ────────────────────────────────────────────────────────────
 * test1: [배선 후] renderSpotList가 현재 핀을 기준(currentPin)으로 buildSpotGroups에 넘기는지 고정
 *  (①"해당 사진에서만" 은 이제 buildSpotGroups가 담당 — groups[0]이 항상 현재 핀이고 isCurrent=true.
 *   State.pins를 buildSpotGroups에 넘기는 것은 "다른 사진 그룹도 함께 나열"하기 위한 의도된 변경이다.)
 * ──────────────────────────────────────────────────────────── */
function test1_currentPinOnlyAlready() {
  console.log("\n[test1] 배선: App.renderSpotList는 PanoViewer._currentPin을 currentPin으로 buildSpotGroups에 전달");
  const m = appSrc.match(/renderSpotList\(\) \{([\s\S]*?)\n    \},/);
  ok(!!m, "renderSpotList() 함수를 찾음");
  const body = m ? m[1] : "";
  ok(/const pin = \(typeof PanoViewer[\s\S]*?PanoViewer\._currentPin/.test(body),
    "pin = PanoViewer._currentPin (현재 핀을 명시적으로 식별)");
  ok(/PanoViewer\.buildSpotGroups\(State\.pins \|\| \[\], pin\)/.test(body),
    "buildSpotGroups(State.pins, pin) — pin이 currentPin으로 전달되어 groups[0]이 항상 현재 사진(①은 buildSpotGroups가 보장)");
}

/* ────────────────────────────────────────────────────────────
 * test2: buildSpotGroups — 현재 사진 그룹 우선 + 사진별 그룹핑
 * ──────────────────────────────────────────────────────────── */
function test2_groupsCurrentFirst(src) {
  console.log("\n[test2] buildSpotGroups: 현재 사진 그룹이 먼저, 마커 있는 다른 사진만 포함");
  const PV = loadPV(src);
  const { pins, cur, bdong, adong, cdong } = makePins();
  const groups = PV.buildSpotGroups(pins, cur);
  ok(groups.length === 3, `그룹 3개(현재+A동+B동, C동은 마커 0개라 제외) — 실제 ${groups.length}`);
  ok(groups[0].isCurrent === true && groups[0].pin.id === cur.id, "그룹[0] = 현재 사진");
  ok(groups[0].spots.length === 2, "현재 사진 그룹에 마커 2개 그대로");
  ok(!groups.some((g) => g.pin.id === cdong.id), "마커 0개인 C동은 목록에서 제외됨");
}

/* ────────────────────────────────────────────────────────────
 * test3: 사진별 소트 — 현재 사진 다음은 label 오름차순(A동 → B동)
 * ──────────────────────────────────────────────────────────── */
function test3_sortedByLabel(src) {
  console.log("\n[test3] 정렬: 현재 사진 다음은 A동 → B동 순(오름차순)");
  const PV = loadPV(src);
  const { pins, cur, adong, bdong } = makePins();
  const groups = PV.buildSpotGroups(pins, cur);
  ok(groups[1] && groups[1].pin.id === adong.id, "groups[1] = A동(먼저)");
  ok(groups[2] && groups[2].pin.id === bdong.id, "groups[2] = B동(다음)");
}

/* ────────────────────────────────────────────────────────────
 * test4: 다른 사진 마커 선택 → App.openPano 이동 경로 재사용(spotRowAction)
 * ──────────────────────────────────────────────────────────── */
function test4_navigateReusesOpenPano(src) {
  console.log("\n[test4] spotRowAction: 다른 사진 그룹 선택 → {type:'openPano', pin} (App.openPano 재사용 계약)");
  const PV = loadPV(src);
  const { pins, cur, bdong } = makePins();
  const groups = PV.buildSpotGroups(pins, cur);
  const otherGroup = groups.find((g) => g.pin.id === bdong.id);
  const action = PV.spotRowAction(otherGroup, otherGroup.spots[0]);
  ok(!!action && action.type === "openPano", "다른 사진 그룹 → type=openPano");
  ok(action.pin === bdong, "action.pin 이 실제 그 핀 객체(App.openPano(pin) 그대로 재사용 가능)");

  const curGroup = groups[0];
  const curAction = PV.spotRowAction(curGroup, curGroup.spots[0]);
  ok(curAction.type === "look" && curAction.lon === curGroup.spots[0].lon && curAction.lat === curGroup.spots[0].lat,
    "현재 사진 그룹 → type=look(기존 lookAtSpot 재사용 계약)");
  ok(typeof PV.lookAtSpot === "function", "PanoViewer.lookAtSpot 재사용(신규 이동 로직 만들지 않음)");
}

/* ────────────────────────────────────────────────────────────
 * test5: 빈 상태 정직 표시 — 현재 사진 마커 0개면 groups[0].spots=[] 로 정직 표시(조용한 실패 아님)
 * ──────────────────────────────────────────────────────────── */
function test5_honestEmptyState(src) {
  console.log("\n[test5] 빈 상태: 현재 사진 마커 0개 → groups[0].spots=[] (숨기지 않고 정직 표시)");
  const PV = loadPV(src);
  const empty = { id: "p-empty", label: "빈사진", spots: [] };
  const groups = PV.buildSpotGroups([empty], empty);
  ok(groups.length === 1 && groups[0].isCurrent === true, "빈 사진이어도 현재 그룹은 항상 포함됨");
  ok(Array.isArray(groups[0].spots) && groups[0].spots.length === 0, "spots=[] 로 정직하게 표시(렌더 쪽이 '마커 없음' 안내를 그릴 수 있음)");
}

/* ────────────────────────────────────────────────────────────
 * test6: 배선 확인 — App.renderSpotList()가 buildSpotGroups/spotRowAction을 호출/참조
 * ──────────────────────────────────────────────────────────── */
function test6_wiredToGroupHelpers() {
  console.log("\n[test6] 배선: renderSpotList가 buildSpotGroups·spotRowAction을 사용");
  const m = appSrc.match(/renderSpotList\(\) \{([\s\S]*?)\n    \},/);
  ok(!!m, "renderSpotList() 함수를 찾음(배선 후)");
  const body = m ? m[1] : "";
  ok(/PanoViewer\.buildSpotGroups\(/.test(body), "buildSpotGroups(...) 호출");
  ok(/PanoViewer\.spotRowAction\(/.test(body), "spotRowAction(...) 호출");
  ok(/this\.openPano\(a\.pin\)/.test(body), "openPano(a.pin) — openPano 분기에서 실제 pin으로 이동");
  ok(/PanoViewer\.lookAtSpot\(a\.lon, a\.lat\)/.test(body), "look 분기는 기존 lookAtSpot(lon, lat) 그대로 재사용");
  ok(/pano-spot-list-body/.test(appSrc) && /psl-table/.test(body), "기존 표 구조(psl-table) 유지");
}

/* ────────────────────────────────────────────────────────────
 * test7: spotRowAction 계약대로 App.openPano/lookAtSpot 재사용 경로가 실제로 동작하는지 검증
 * ──────────────────────────────────────────────────────────── */
function test7_renderWiringBehavior(src) {
  console.log("\n[test7] 배선 동작: 다른 사진 클릭→openPano(그 핀) / 같은 사진 클릭→lookAtSpot 유지 / 빈 상태");
  const PV = loadPV(src);
  const { pins, cur, bdong } = makePins();
  let lookCalled = null, openCalled = null;
  PV.lookAtSpot = (lon, lat) => { lookCalled = { lon, lat }; };
  const AppStub = { openPano(pin) { openCalled = pin; } };

  const groups = PV.buildSpotGroups(pins, cur);
  const otherGroup = groups.find((g) => g.pin.id === bdong.id);
  const otherAction = PV.spotRowAction(otherGroup, otherGroup.spots[0]);
  if (otherAction.type === "openPano") AppStub.openPano(otherAction.pin);
  ok(openCalled === bdong, "다른 사진 마커 클릭 시뮬 → App.openPano(그 핀 객체) 호출됨");

  const curGroup = groups[0];
  const curAction = PV.spotRowAction(curGroup, curGroup.spots[0]);
  if (curAction.type === "look") PV.lookAtSpot(curAction.lon, curAction.lat);
  ok(lookCalled && lookCalled.lon === curGroup.spots[0].lon && lookCalled.lat === curGroup.spots[0].lat,
    "같은 사진 마커 클릭 시뮬 → 기존 lookAtSpot(lon, lat) 경로 유지");

  const empty = { id: "p-empty", label: "빈사진", spots: [] };
  const emptyGroups = PV.buildSpotGroups([empty], empty);
  ok(emptyGroups.length === 1 && emptyGroups[0].spots.length === 0,
    "현재 사진 마커 0개 → 그룹은 존재(빈 상태를 조용히 숨기지 않고 렌더 쪽에서 표시 가능)");
}

test1_currentPinOnlyAlready();
test2_groupsCurrentFirst(pvSrc);
test3_sortedByLabel(pvSrc);
test4_navigateReusesOpenPano(pvSrc);
test5_honestEmptyState(pvSrc);
test6_wiredToGroupHelpers();
test7_renderWiringBehavior(pvSrc);

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 ①: 현재 핀 필터를 제거(모든 핀의 spots를 한 그룹에 합침) → test2가 실패해야 함
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션①] 현재 핀 필터 제거 → 그룹 구분 없이 전부 합치면 test2가 실패해야 함");
  const needle = `    buildSpotGroups(pins, currentPin) {
      const list = Array.isArray(pins) ? pins : [];
      const cur = currentPin || null;
      const groups = [];
      if (cur) groups.push({ pin: cur, spots: Array.isArray(cur.spots) ? cur.spots : [], isCurrent: true });
      const others = list.filter((p) => p && p !== cur && (!cur || p.id !== cur.id) &&
        Array.isArray(p.spots) && p.spots.length > 0);
      others.sort((a, b) => String(a.label || a.id || "").localeCompare(String(b.label || b.id || ""), "ko"));
      others.forEach((p) => groups.push({ pin: p, spots: p.spots, isCurrent: false }));
      return groups;
    },`;
  const replacement = `    buildSpotGroups(pins, currentPin) {
      const list = Array.isArray(pins) ? pins : [];
      const allSpots = list.reduce((acc, p) => acc.concat(Array.isArray(p.spots) ? p.spots : []), []);
      return [{ pin: currentPin, spots: allSpots, isCurrent: true }];
    },`;
  const mutated = pvSrc.replace(needle, replacement);
  if (mutated === pvSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const PV = loadPV(mutated);
    const { pins, cur } = makePins();
    const groups = PV.buildSpotGroups(pins, cur);
    ok(groups.length !== 3, "뮤테이션 적용 시 그룹 3개가 아니게 뒤집힘(=test2가 실패, 테스트 실효성 증명)");
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 ②: 정렬 제거 → test3(A동→B동 순서)가 실패해야 함
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션②] 정렬 제거 → test3의 순서 검증이 실패해야 함");
  const needle = `      others.sort((a, b) => String(a.label || a.id || "").localeCompare(String(b.label || b.id || ""), "ko"));\n`;
  const mutated = pvSrc.replace(needle, "");
  if (mutated === pvSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const PV = loadPV(mutated);
    const { pins, cur, adong } = makePins();
    const groups = PV.buildSpotGroups(pins, cur);
    // 정렬 없으면 pins 배열 순서(B동이 A동보다 먼저 들어있음) 그대로 유지됨 → A동이 먼저가 아니게 됨
    ok(!(groups[1] && groups[1].pin.id === adong.id), "뮤테이션 적용 시 A동이 더 이상 먼저가 아니게 뒤집힘(테스트 실효성 증명)");
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 ③(배선): renderSpotList에서 buildSpotGroups 호출 제거 → test6 실패해야 함
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션③] renderSpotList의 buildSpotGroups 호출 제거 → test6이 실패해야 함");
  const needle = "PanoViewer.buildSpotGroups(State.pins || [], pin);";
  const mutated = appSrc.replace(needle, "(pin.spots || []).map((s) => ({ pin, spots: [s], isCurrent: true }));");
  if (mutated === appSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const m = mutated.match(/renderSpotList\(\) \{([\s\S]*?)\n    \},/);
    const body = m ? m[1] : "";
    ok(!/PanoViewer\.buildSpotGroups\(/.test(body), "뮤테이션 적용 시 buildSpotGroups 호출이 사라짐(=test6이 실패, 테스트 실효성 증명)");
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 ④(배선): openPano 분기 제거 → test6이 실패해야 함
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션④] openPano 분기 제거 → test6이 실패해야 함");
  const needle = 'else if (a.type === "openPano") { this.openPano(a.pin); }';
  const mutated = appSrc.replace(needle, "");
  if (mutated === appSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const m = mutated.match(/renderSpotList\(\) \{([\s\S]*?)\n    \},/);
    const body = m ? m[1] : "";
    ok(!/this\.openPano\(a\.pin\)/.test(body), "뮤테이션 적용 시 openPano(a.pin) 분기가 사라짐(=test6이 실패, 테스트 실효성 증명)");
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
