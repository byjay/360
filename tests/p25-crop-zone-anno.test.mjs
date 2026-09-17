/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p25-crop-zone-anno.test.mjs)
 *
 * 대상: WORK_ORDER — "배포 페이로드 = 구역 크롭 기준 영역(zone)·주석(annotation) 재매핑".
 *
 * 근본원인: 커밋 388ee4a 로 뷰어 스냅샷을 구역 크롭 기준으로 뜨게 했을 때 핀 좌표는
 * MapCtrl.pageToDeckCropPct(순수함수)로 재매핑했으나 영역(16_Zones.js)·PDF 주석(26_PdfAnno.js)은
 * 재매핑 대상이 아니었다(코드 주석·커밋 메시지에 명시된 미완). 크롭한 페이지에 영역·주석이
 * 있으면 배포 후 위치가 어긋난다.
 *
 * 채택: 20_App.js 에 신규 _mapZoneForCrop/_mapAnnoForCrop(순수함수, 새 변환 로직 없이 기존
 * MapCtrl.pageToDeckCropPct 재사용) 추가 + _buildSavePayload 가 이를 zones/annotations 직렬화에
 * 배선. 영역은 rect{x,y,w,h}/circle{cx,cy,r}/poly{points} 모두 대응(다각형은 전체 점 변환).
 * 주석은 permille(0~1000) 저장 형식이라 /10↔*10 왕복으로 MapCtrl 의 %(0~100) 인터페이스에 맞춘다.
 * 크롭 밖(점 하나라도) 항목은 배포본에서 제외. 원본 State.zones/annotations 는 불변(복사본만 가공).
 *
 * 실제 모듈 소스(10_MapCtrl.js/20_App.js)를 그대로 vm 에 평가해 검사한다(목 구현 아님).
 * 뮤테이션 3건: 영역 변환 제거 → ①실패 / 다각형 점 일부만 변환 → ②실패 / 원본 불변 가드 제거 → ⑤실패.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const mapSrc = rd("public/js/modules/10_MapCtrl.js");
const appSrc = rd("public/js/modules/20_App.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};
const near = (a, b, eps = 1e-2) => Math.abs(a - b) <= eps;

const CROP_PCT = { x: 10, y: 20, w: 40, h: 30 }; // % — 페이지의 40%×30%만 사용
const DECK_CROP = { page: 1, crop: CROP_PCT };

/** App + MapCtrl 을 한 샌드박스에 평가 → App 인스턴스(리프 I/O 는 손대지 않음, 순수 로직만 검사) */
function load(mSrc = mapSrc, aSrc = appSrc, { deck } = {}) {
  const State = {
    mode: "designer", pins: [], zones: [], annotations: [],
    fileName: "d.png", fileType: "image", pdfPage: 1
  };
  const cl = () => ({ add() {}, remove() {}, toggle() {}, contains: () => false });
  const sandbox = {
    console, Math, JSON, Promise, setTimeout, clearTimeout,
    State,
    Projects: { currentDeck: deck || null },
    UI: { $: () => ({ classList: cl(), style: {}, textContent: "", innerHTML: "" }) },
    Auth: { headers: () => ({}) },
    Prompt: { toast() {} },
    Log: { push() {} },
    document: { getElementById: () => null, createElement: () => ({ classList: cl(), style: {} }) },
    navigator: { onLine: true, userAgent: "node" },
    location: { origin: "https://scan360.pages.dev", pathname: "/" },
    performance: { now: () => 0 }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(mSrc + "\n;globalThis.__MAP = MapCtrl;", sandbox);
  vm.runInContext(aSrc + "\n;globalThis.__A = App;", sandbox);
  return { App: sandbox.__A, State };
}

/* ══════════════════════════════════════════════════════════════════
 * ① crop 있는 구역 → rect 영역 좌표가 크롭 기준으로 변환된다
 * ══════════════════════════════════════════════════════════════════ */
function test1_rectZoneMapped() {
  console.log("\n[test1] rect 영역 → 크롭 기준으로 변환");
  const { App, State } = load(mapSrc, appSrc, { deck: { crop: CROP_PCT, page: 1 } });
  // 크롭 중앙 사각형: x=30,y=35,w=... → 크롭 로컬 기준 (30-10)/40*100=50, (35-20)/30*100=50
  const z = { id: "z1", page: 1, shape: "rect", x: 30, y: 35, w: 10, h: 6 };
  State.zones.push(z);
  const body = App._buildSavePayload(null, null);
  const zones = JSON.parse(body.zones);
  ok(zones.length === 1, `배포본 zones 개수 = ${zones.length} (기대 1)`);
  const zz = zones[0];
  ok(near(zz.x, 50) && near(zz.y, 50), `zone.x/y = ${zz.x},${zz.y} (기대 50,50)`);
  ok(near(zz.w, 25) && near(zz.h, 20), `zone.w/h = ${zz.w},${zz.h} (기대 25,20 — w:10/40*100, h:6/30*100)`);
}

/* ══════════════════════════════════════════════════════════════════
 * ② 다각형 영역의 모든 점이 변환된다
 * ══════════════════════════════════════════════════════════════════ */
function test2_polyAllPointsMapped() {
  console.log("\n[test2] poly 영역 → 점 배열 전체가 변환된다");
  const { App, State } = load(mapSrc, appSrc, { deck: { crop: CROP_PCT, page: 1 } });
  const points = [{ x: 20, y: 30 }, { x: 30, y: 30 }, { x: 30, y: 40 }, { x: 20, y: 40 }];
  const z = { id: "z2", page: 1, shape: "poly", points, x: 20, y: 30, w: 10, h: 10 };
  State.zones.push(z);
  const body = App._buildSavePayload(null, null);
  const zones = JSON.parse(body.zones);
  ok(zones.length === 1, `배포본 zones 개수 = ${zones.length} (기대 1)`);
  const pts = zones[0].points;
  const expect = points.map(p => ({
    x: (p.x - CROP_PCT.x) / CROP_PCT.w * 100,
    y: (p.y - CROP_PCT.y) / CROP_PCT.h * 100
  }));
  ok(pts.length === points.length, `점 개수 유지 = ${pts.length} (기대 ${points.length})`);
  const allMapped = pts.every((p, i) => near(p.x, expect[i].x) && near(p.y, expect[i].y));
  ok(allMapped, `모든 점이 변환됨: ${JSON.stringify(pts)} (기대 ${JSON.stringify(expect)})`);
}

/* ══════════════════════════════════════════════════════════════════
 * ③ 주석 좌표(permille)도 변환된다
 * ══════════════════════════════════════════════════════════════════ */
function test3_annotationMapped() {
  console.log("\n[test3] PDF 주석 → 크롭 기준으로 변환(permille ↔ % 왕복)");
  const { App, State } = load(mapSrc, appSrc, { deck: { crop: CROP_PCT, page: 1 } });
  // permille 300,350 = 30%,35% (크롭 중앙) → 크롭 로컬 50%,50% → *10 = 500,500
  const a = { id: "a1", page: 1, type: "text", x: 300, y: 350, text: "메모" };
  State.annotations.push(a);
  const body = App._buildSavePayload(null, null);
  const annos = JSON.parse(body.annotations);
  ok(annos.length === 1, `배포본 annotations 개수 = ${annos.length} (기대 1)`);
  ok(near(annos[0].x, 500) && near(annos[0].y, 500), `anno.x/y(permille) = ${annos[0].x},${annos[0].y} (기대 500,500)`);
}

/* ══════════════════════════════════════════════════════════════════
 * ④ 크롭 밖 영역·주석은 배포본에서 제외된다
 * ══════════════════════════════════════════════════════════════════ */
function test4_outsideCropExcluded() {
  console.log("\n[test4] 크롭 밖 영역/주석 → 배포본에서 제외");
  const { App, State } = load(mapSrc, appSrc, { deck: { crop: CROP_PCT, page: 1 } });
  // crop = {x:10,y:20,w:40,h:30} → 90,90 은 크롭 밖
  State.zones.push({ id: "zOut", page: 1, shape: "rect", x: 90, y: 90, w: 5, h: 5 });
  State.annotations.push({ id: "aOut", page: 1, type: "text", x: 900, y: 900, text: "밖" });
  const body = App._buildSavePayload(null, null);
  ok(JSON.parse(body.zones).length === 0, "크롭 밖 rect 영역 제외됨");
  ok(JSON.parse(body.annotations).length === 0, "크롭 밖 주석 제외됨");
}

/* ══════════════════════════════════════════════════════════════════
 * ⑤ 라이브 State.zones/annotations 원본 불변(복사본만 변경)
 * ══════════════════════════════════════════════════════════════════ */
function test5_originalUnmutated() {
  console.log("\n[test5] 라이브 State.zones/annotations 원본 불변");
  const { App, State } = load(mapSrc, appSrc, { deck: { crop: CROP_PCT, page: 1 } });
  const z = { id: "z1", page: 1, shape: "rect", x: 30, y: 35, w: 10, h: 6 };
  const a = { id: "a1", page: 1, type: "text", x: 300, y: 350, text: "메모" };
  State.zones.push(z);
  State.annotations.push(a);
  const zBefore = JSON.stringify(z), aBefore = JSON.stringify(a);
  App._buildSavePayload(null, null);
  ok(JSON.stringify(z) === zBefore, `원본 zone 불변: ${JSON.stringify(z)}`);
  ok(JSON.stringify(a) === aBefore, `원본 annotation 불변: ${JSON.stringify(a)}`);
}

/* ══════════════════════════════════════════════════════════════════
 * ⑥ crop 없는 구역은 종전대로(회귀 없음) — 재매핑·제외 없음
 * ══════════════════════════════════════════════════════════════════ */
function test6_noCropUnchanged() {
  console.log("\n[test6] crop 없는 구역 → 재매핑/제외 없이 종전대로");
  const { App, State } = load(mapSrc, appSrc, { deck: null }); // crop 없음
  const z = { id: "z1", page: 1, shape: "rect", x: 90, y: 90, w: 5, h: 5 }; // "크롭 밖" 좌표라도
  const a = { id: "a1", page: 1, type: "text", x: 900, y: 900, text: "메모" };
  State.zones.push(z);
  State.annotations.push(a);
  const body = App._buildSavePayload(null, null);
  const zones = JSON.parse(body.zones), annos = JSON.parse(body.annotations);
  ok(zones.length === 1 && zones[0].x === 90 && zones[0].y === 90, `crop 없음 → zone 좌표 그대로: ${JSON.stringify(zones[0])}`);
  ok(annos.length === 1 && annos[0].x === 900 && annos[0].y === 900, `crop 없음 → anno 좌표 그대로: ${JSON.stringify(annos[0])}`);
}

/* ══════════════════════════════════════════════════════════════════
 * 실행
 * ══════════════════════════════════════════════════════════════════ */
console.log("=== 회귀: 배포 페이로드 크롭 재매핑(영역·주석) ===");
test1_rectZoneMapped();
test2_polyAllPointsMapped();
test3_annotationMapped();
test4_outsideCropExcluded();
test5_originalUnmutated();
test6_noCropUnchanged();

/* ════════════════════════════════════════════════════════════════
 * 뮤테이션 ① — 영역 변환 제거(_mapZoneForCrop 가 항상 그대로 반환) → test1 실패해야 함
 * ════════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션①] 영역 변환 제거(_mapZoneForCrop 무력화) → test1 이 실패해야 함");
{
  const needle = "_mapZoneForCrop(z, deckCrop) {\n      const zz = Object.assign({}, z);\n      if (!deckCrop";
  const mutated = appSrc.replace(needle, "_mapZoneForCrop(z, deckCrop) {\n      const zz = Object.assign({}, z);\n      return zz;\n      if (!deckCrop");
  if (mutated === appSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { App, State } = load(mapSrc, mutated, { deck: { crop: CROP_PCT, page: 1 } });
    State.zones.push({ id: "z1", page: 1, shape: "rect", x: 30, y: 35, w: 10, h: 6 });
    const body = App._buildSavePayload(null, null);
    const zz = JSON.parse(body.zones)[0];
    ok(zz.x === 30 && zz.y === 35, `뮤테이션 적용 시 변환 안 됨(x,y=${zz.x},${zz.y}, 기대 30,35 = test1 실패 재현)`);
  }
}

/* ════════════════════════════════════════════════════════════════
 * 뮤테이션 ② — 다각형 점 일부만 변환(마지막 점 스킵) → test2 실패해야 함
 * ════════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션②] poly 점 일부만 변환(마지막 점 원본 유지) → test2 가 실패해야 함");
{
  const needle = "        const mapped = [];\n        for (const p of zz.points) {\n          const m = mapPt(p.x, p.y);\n          if (!m) return null; // 점 하나라도 크롭 밖 — 배포본에서 제외\n          mapped.push({ x: m.x, y: m.y });\n        }\n        zz.points = mapped;";
  const mutatedFn = "        const mapped = [];\n        for (let i = 0; i < zz.points.length; i++) {\n          const p = zz.points[i];\n          if (i === zz.points.length - 1) { mapped.push({ x: p.x, y: p.y }); continue; }\n          const m = mapPt(p.x, p.y);\n          if (!m) return null;\n          mapped.push({ x: m.x, y: m.y });\n        }\n        zz.points = mapped;";
  const mutated = appSrc.replace(needle, mutatedFn);
  if (mutated === appSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { App, State } = load(mapSrc, mutated, { deck: { crop: CROP_PCT, page: 1 } });
    const points = [{ x: 20, y: 30 }, { x: 30, y: 30 }, { x: 30, y: 40 }, { x: 20, y: 40 }];
    State.zones.push({ id: "z2", page: 1, shape: "poly", points, x: 20, y: 30, w: 10, h: 10 });
    const body = App._buildSavePayload(null, null);
    const pts = JSON.parse(body.zones)[0].points;
    const last = pts[pts.length - 1];
    ok(last.x === 20 && last.y === 40, `뮤테이션 적용 시 마지막 점 미변환(x,y=${last.x},${last.y}, 기대 원본 20,40 = test2 실패 재현)`);
  }
}

/* ════════════════════════════════════════════════════════════════
 * 뮤테이션 ③ — 원본 불변 가드 제거(Object.assign 복사 없이 원본 직접 변경) → test5 실패해야 함
 * ════════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션③] 원본 불변 가드 제거(zone 을 복사 없이 직접 변경) → test5 가 실패해야 함");
{
  const needle = "_mapZoneForCrop(z, deckCrop) {\n      const zz = Object.assign({}, z);";
  const mutated = appSrc.replace(needle, "_mapZoneForCrop(z, deckCrop) {\n      const zz = z; // [뮤테이션] 복사 제거 — 원본 직접 변경");
  if (mutated === appSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { App, State } = load(mapSrc, mutated, { deck: { crop: CROP_PCT, page: 1 } });
    const z = { id: "z1", page: 1, shape: "rect", x: 30, y: 35, w: 10, h: 6 };
    State.zones.push(z);
    const zBefore = JSON.stringify(z);
    App._buildSavePayload(null, null);
    ok(JSON.stringify(z) !== zBefore, `뮤테이션 적용 시 원본이 변경됨(전:${zBefore} 후:${JSON.stringify(z)} = test5 실패 재현)`);
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
