/**
 * p167-capture-session-pure — WO 20261019-capsession (순수 함수 단위검증, 실행: node tests/p167-capture-session-pure.test.mjs)
 *
 * 대상: 69_CaptureSession.js — 정지점 탭↔사진 단조 매칭 + 시계 오프셋 자동추정(흐름A),
 * 연속촬영 정지점 군집화 + 동선 시간비율 배치 + 기준점 재보간(흐름B), 번호(PinSeries.nextInBand
 * 재사용, 접두 A→A1~A5), 세션 영속화(SyncQueue.saveDraft/loadDraft 재사용), 되돌리기.
 *
 * 실 소스(01b_PinSeries.js/69_CaptureSession.js)를 그대로 vm 에 평가(목 구현 아님). 뮤테이션 4건은
 * 각각 해당 assertion 이 EXIT=1 로 실패함을 증명한다(원복 후 재확인).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const seriesSrc = rd("public/js/modules/01b_PinSeries.js");
const csSrc = rd("public/js/modules/69_CaptureSession.js");

let failed = 0;
const ok = (cond, label, detail) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail).slice(0, 300) : ""));
  if (!cond) failed++;
};

/* ── 간단 in-memory SyncQueue(draft) mock — p88 패턴과 동일(IndexedDB 대신 메모리로 대체,
   "새로고침 후 복원"은 CaptureSession 인스턴스를 새로 로드해 같은 store 를 다시 가리키게 해 시뮬레이션). */
function makeDraftStore() {
  const store = new Map();
  return {
    async saveDraft(key, data) { store.set(key, JSON.parse(JSON.stringify(data))); return true; },
    async loadDraft(key) { return store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : null; },
    async removeDraft(key) { store.delete(key); }
  };
}

function loadCS(csSource, extra) {
  const sandbox = Object.assign({ console, JSON, Map, Set, Date }, extra || {});
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(seriesSrc + "\n" + csSource + "\n;globalThis.__CS = CaptureSession; globalThis.__PS = PinSeries;", sandbox);
  return { CS: sandbox.__CS, PS: sandbox.__PS, sandbox };
}

/* ══ A. 정지점 탭 — 5탭 + 5사진(시계 +7초 오차) → 정확 매칭 + 오프셋 자동보정 ══ */
{
  const { CS } = loadCS(csSrc);
  const T = (s) => s * 1000;
  const taps = [0, 10, 20, 30, 40].map((s, i) => ({ no: i + 1, t: T(s) }));
  // THETA 시계가 실제보다 7초 빠름(앞섬) → EXIF 기록시각 = 탭시각 + 7000
  const photos = [0, 10, 20, 30, 40].map((s, i) => ({ t: T(s) + 7000, row: { name: "p" + (i + 1) + ".jpg" } }));

  const auto = CS._estimateOffsetMs(taps[0].t, photos[0].t);
  ok(auto === -7000, "A1 오프셋 자동추정 = -7000(탭-사진) → " + auto);

  const result = CS._assignTapPhotos(taps, photos, auto, 60000);
  const pairs = result.matches.map((m) => m.tap.no + "<->" + m.photo.name).join(",");
  ok(pairs === "1<->p1.jpg,2<->p2.jpg,3<->p3.jpg,4<->p4.jpg,5<->p5.jpg", "A2 보정 후 정확 1:1 매칭 → " + pairs);
  ok(result.matches.every((m) => m.dtMs === 0), "A3 보정 후 Δt=0(정확 보정) → " + result.matches.map((m) => m.dtMs).join(","));
  ok(result.unmatchedTaps.length === 0 && result.unmatchedPhotos.length === 0, "A4 전원 매칭(미연결 없음)");
}

/* ══ 뮤테이션① — 단조 순서 제약 제거 시 "뒤바뀜" 발생 ══════════════════════════ */
{
  const { CS } = loadCS(csSrc);
  const taps = [{ no: 1, t: 10000 }, { no: 2, t: 11000 }];
  const photos = [{ t: 0, row: { name: "a.jpg" } }, { t: 10500, row: { name: "b.jpg" } }];
  const r = CS._assignTapPhotos(taps, photos, 0, 15000);
  const pairs = r.matches.map((m) => m.tap.no + "<->" + m.photo.name).join(",");
  ok(pairs === "1<->b.jpg", "뮤테이션前 1탭=b.jpg 만 매칭 → " + pairs);
  ok(r.unmatchedTaps.length === 1 && r.unmatchedTaps[0].no === 2, "뮤테이션前 2탭은 미연결(단조 제약, a.jpg 재사용 금지) → " + JSON.stringify(r.unmatchedTaps));

  console.log("\n[뮤테이션①] 단조 순서 제약(cursor 전진)을 제거하면 2탭이 a.jpg(시간상 더 앞선 사진)을 부당히 가져간다");
  const needle = "cursor = bestJ + 1;";
  const occ = (csSrc.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
  const mutated = csSrc.split(needle).join("/* cursor frozen */");
  if (occ === 0) { console.log("  FAIL 뮤테이션 대상 못 찾음"); failed++; }
  else {
    const { CS: CSm } = loadCS(mutated);
    const rm = CSm._assignTapPhotos(taps, photos, 0, 15000);
    ok(rm.unmatchedTaps.length === 0, "뮤테이션 적용 시 2탭도 매칭됨(a.jpg 를 부당 사용, 테스트 실효성 증명) → unmatchedTaps=" + rm.unmatchedTaps.length);
  }
}

/* ══ 뮤테이션② — 오프셋 추정 제거 시 보정 실패 ══════════════════════════════ */
{
  const { CS } = loadCS(csSrc);
  const base = CS._estimateOffsetMs(0, 7000);
  ok(base === -7000, "뮤테이션前 오프셋 = -7000");

  console.log("\n[뮤테이션②] _estimateOffsetMs 가 0만 반환하면 +7초 시계오차가 보정되지 않는다");
  const needle = "return firstTapMs - firstPhotoMs;";
  const mutated = csSrc.replace(needle, "return 0;");
  if (mutated === csSrc) { console.log("  FAIL 뮤테이션 대상 못 찾음"); failed++; }
  else {
    const { CS: CSm } = loadCS(mutated);
    const offM = CSm._estimateOffsetMs(0, 7000);
    const taps = [0, 10, 20].map((s, i) => ({ no: i + 1, t: s * 1000 }));
    const photos = [0, 10, 20].map((s, i) => ({ t: s * 1000 + 7000, row: { name: "p" + i } }));
    const rm = CSm._assignTapPhotos(taps, photos, offM, 5000); // 보정 없음 + 허용오차 5초 < 7초 오차 → 미연결 발생
    const base2 = CS._assignTapPhotos(taps, photos, CS._estimateOffsetMs(taps[0].t, photos[0].t), 5000);
    ok(base2.unmatchedTaps.length === 0, "대조(보정 적용) → 전원 매칭 → unmatchedTaps=" + base2.unmatchedTaps.length);
    ok(offM === 0 && rm.unmatchedTaps.length > base2.unmatchedTaps.length,
      "뮤테이션 적용 시 오프셋=0 → 7초 오차가 허용오차(5초)를 넘어 보정 적용 대비 미연결 발생(테스트 실효성 증명) → " + rm.unmatchedTaps.length + " vs " + base2.unmatchedTaps.length);
  }
}

/* ══ B. 동선 — 12장(4정지점×3연사) → 4정지점, 시간비율 배치 + 기준점 재보간 ══ */
{
  const { CS } = loadCS(csSrc, { Routes: { pointAtRatio(points, t) {
    // 직선 (0,0)→(100,0) 보간(실제 63_RouteDraw.js pointAtRatio 와 동일 수학)
    const a = points[0], b = points[1];
    const r = Math.max(0, Math.min(1, t));
    return { x: a.x + (b.x - a.x) * r, y: a.y + (b.y - a.y) * r };
  } } });
  const route = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const burstTimes = [[9800, 10000, 10200], [39800, 40000, 40200], [69800, 70000, 70200], [99800, 100000, 100200]];
  const photos = [];
  burstTimes.forEach((burst, bi) => burst.forEach((t, j) => photos.push({ t, row: { name: "b" + bi + "_" + j } })));

  const stops = CS._clusterStops(photos, 3000);
  ok(stops.length === 4, "B1 12장 → 정지점 4개(연속촬영 간격<3초 묶음) → " + stops.length);
  ok(stops.every((s) => s.photos.length === 3), "B2 정지점마다 사진 3장 → " + stops.map((s) => s.photos.length).join(","));

  const sessionStart = 0, sessionEnd = 120000;
  const before = CS._placeStops(stops, route, sessionStart, sessionEnd, []);
  const expectBefore = stops.map((s) => +(s.tMid / sessionEnd * 100).toFixed(1));
  ok(before.every((p, i) => Math.abs(p.x - expectBefore[i]) < 0.1), "B3 기준점 없음 → 단순 시간비율 배치 → " + JSON.stringify(before.map((p) => p.x)) + " vs " + JSON.stringify(expectBefore));

  // 기준점 추가(두번째 정지점 실제 위치 ratio=0.6) → 재보간
  const anchors = [{ t: stops[1].tMid, r: 0.6 }];
  const after = CS._placeStops(stops, route, sessionStart, sessionEnd, anchors);
  const changed = before.map((p, i) => Math.abs(p.x - after[i].x) > 0.5);
  ok(changed.every(Boolean), "B4 기준점 추가 후 4개 정지점 전부 위치 재보간(달라짐) → Δx=" + JSON.stringify(before.map((p, i) => +(after[i].x - p.x).toFixed(2))));
  ok(Math.abs(after[1].x - 60) < 0.1, "B5 기준점 자체는 지정 ratio(0.6→x=60) 그대로 → " + after[1].x);
}

/* ══ 뮤테이션③ — 정지점 묶음(군집화) 제거 시 12개로 부풀어 오름 ══════════════ */
{
  console.log("\n[뮤테이션③] 연속촬영 간격<gapMs 묶음 조건을 제거하면 사진마다 별도 정지점이 된다");
  const needle = "if (cur && (p.t - cur.tEnd) <= g) { cur.photos.push(p); cur.tEnd = p.t; }\n        else stops.push({ photos: [p], tStart: p.t, tEnd: p.t });";
  const occ = (csSrc.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
  const mutated = csSrc.split(needle).join("stops.push({ photos: [p], tStart: p.t, tEnd: p.t });");
  if (occ === 0) { console.log("  FAIL 뮤테이션 대상 못 찾음"); failed++; }
  else {
    const { CS: CSm } = loadCS(mutated);
    const burstTimes = [[9800, 10000, 10200], [39800, 40000, 40200], [69800, 70000, 70200], [99800, 100000, 100200]];
    const photos = [];
    burstTimes.forEach((burst, bi) => burst.forEach((t, j) => photos.push({ t, row: { name: "b" + bi + "_" + j } })));
    const stopsM = CSm._clusterStops(photos, 3000);
    ok(stopsM.length === 12, "뮤테이션 적용 시 정지점 12개로 부풀어 오름(테스트 실효성 증명) → " + stopsM.length);
  }
}

/* ══ 뮤테이션④ — 기준점 재보간 제거 시 추가해도 위치 불변 ══════════════════════ */
{
  const { CS } = loadCS(csSrc, { Routes: { pointAtRatio(points, t) {
    const a = points[0], b = points[1]; const r = Math.max(0, Math.min(1, t));
    return { x: a.x + (b.x - a.x) * r, y: a.y + (b.y - a.y) * r };
  } } });
  const route = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const stops = CS._clusterStops(
    [[9800, 10000, 10200], [39800, 40000, 40200], [69800, 70000, 70200], [99800, 100000, 100200]]
      .flatMap((b, bi) => b.map((t, j) => ({ t, row: { name: "b" + bi + "_" + j } }))),
    3000
  );
  console.log("\n[뮤테이션④] anchors 를 무시하면 기준점 추가 후에도 위치가 그대로다");
  const needle = "const f = this._timeToRatioFn(sessionStartMs, sessionEndMs, anchors);";
  const mutated = csSrc.replace(needle, "const f = this._timeToRatioFn(sessionStartMs, sessionEndMs, []);");
  if (mutated === csSrc) { console.log("  FAIL 뮤테이션 대상 못 찾음"); failed++; }
  else {
    const { CS: CSm } = loadCS(mutated, { Routes: { pointAtRatio(points, t) {
      const a = points[0], b = points[1]; const r = Math.max(0, Math.min(1, t));
      return { x: a.x + (b.x - a.x) * r, y: a.y + (b.y - a.y) * r };
    } } });
    const before = CSm._placeStops(stops, route, 0, 120000, []);
    const after = CSm._placeStops(stops, route, 0, 120000, [{ t: stops[1].tMid, r: 0.6 }]);
    const allSame = before.every((p, i) => Math.abs(p.x - after[i].x) < 0.001);
    ok(allSame, "뮤테이션 적용 시 기준점 추가해도 위치 불변(테스트 실효성 증명) → Δx=" + JSON.stringify(before.map((p, i) => +(after[i].x - p.x).toFixed(3))));
  }
}

/* ══ C. 번호 — PinSeries.nextInBand 재사용, 접두 A → A1~A5 ══════════════════ */
{
  const { CS } = loadCS(csSrc);
  const pins = [];
  const labels = [];
  CS.start({ mode: "tap", page: 1, prefix: "A", startNo: 1, zoneName: "엔진룸" });
  for (let i = 0; i < 5; i++) {
    const r = CS.addTap(pins, { x: i * 10, y: 0 });
    labels.push(r.pin.label);
  }
  ok(labels.join(",") === "A1,A2,A3,A4,A5", "C1 접두 A → A1~A5 순차 채번(PinSeries.nextInBand 재사용) → " + labels.join(","));
  ok(pins.every((p) => /^엔진룸-A\d$/.test(p.name)), "C2 이름 규칙 <구역명>-<번호> 적용 → " + pins.map((p) => p.name).join(","));
}

/* ══ D. 세션 유지(새로고침 후 복원) ══════════════════════════════════════ */
async function testPersist() {
  const draftStore = makeDraftStore();
  const { CS: CS1 } = loadCS(csSrc, { SyncQueue: draftStore });
  await CS1.start({ mode: "tap", page: 1, zoneName: "1구역" });
  CS1.addTap([], { x: 1, y: 1 });
  CS1.addTap([], { x: 2, y: 2 });
  await CS1._persist();

  // "새로고침" 시뮬레이션 — 완전히 새 vm 컨텍스트(새 CaptureSession 인스턴스)가 같은 draftStore 를 가리킴
  const { CS: CS2 } = loadCS(csSrc, { SyncQueue: draftStore });
  ok(CS2.current() === null, "D1 새 인스턴스는 메모리 상태 없음(복원 전)");
  const restored = await CS2.restore();
  ok(!!restored && restored.id === CS1.current().id, "D2 restore() 후 같은 세션 id 복원 → " + (restored && restored.id));
  ok(restored.taps.length === 2, "D3 탭 2건 그대로 복원 → " + restored.taps.length);
}

/* ══ E. 되돌리기 — 세션 생성 핀 전부 취소 ══════════════════════════════════ */
async function testUndo() {
  const draftStore = makeDraftStore();
  const { CS } = loadCS(csSrc, { SyncQueue: draftStore });
  const pins = [{ id: 999, label: "미리있던핀" }];
  await CS.start({ mode: "tap", page: 1 });
  CS.addTap(pins, { x: 1, y: 1 });
  CS.addTap(pins, { x: 2, y: 2 });
  ok(pins.length === 3, "E1 탭 2회로 핀 2개 추가(기존 1개+2) → " + pins.length);
  const state = { pins };
  const r = CS._undoApply(CS.current(), state);
  ok(r.removed === 2, "E2 되돌리기 → 세션 생성 핀 2개만 제거 → " + r.removed);
  ok(pins.length === 1 && pins[0].id === 999, "E3 기존 핀은 보존 → " + JSON.stringify(pins));
}

await testPersist();
await testUndo();

console.log(failed === 0 ? "\n전체 PASS" : `\n${failed}건 FAIL`);
process.exit(failed === 0 ? 0 : 1);
