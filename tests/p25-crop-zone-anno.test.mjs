/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p25-crop-zone-anno.test.mjs)
 *
 * 대상: WP1 · H7 — "창(crop) 구역에서 저장하면 원본의 크롭 밖 핀/영역/주석이 지워진다".
 *
 * 근본원인: 창 방식 구역(decks.crop 보유)은 원본과 **같은 deployment_id** 를 가리킨다(31_Projects.js).
 *   그런데 저장(_buildSavePayload)이 핀·영역·주석을 크롭 기준 %로 바꾸고 크롭 밖 항목을 `return null`
 *   로 빼서, 스냅샷(_snapshotPages)도 크롭한 이미지로 그 **원본 행**을 PATCH 했다 → 크롭 밖 데이터 영구 삭제.
 *   역변환(MapCtrl.deckCropPctToPage) 호출부가 0 이라 재로드 시 crop 이 한 번 더 적용돼 좌표도 이중 변환.
 * 조치: 저장은 항상 원본(페이지 기준 %) 좌표·전체 페이지. crop 은 보기 창(PDF.setDeckCrop/MapCtrl.fitZone)일 뿐.
 *
 * [G-4⑧ 전·후] 종전 이 파일은 "크롭 기준으로 변환·크롭 밖 제외"를 기대했다(= H7 결함 자체를 고정).
 *   test1~4 의 기대가 반전됐다: 변환 없음 · 제외 없음 · 전체 페이지 스냅샷. test5(원본 불변)·test6(crop 없음) 유지.
 *
 * 실제 모듈 소스(10_MapCtrl.js/20_App.js)를 그대로 vm 에 평가(목은 DOM/PDF 경계만).
 * 뮤테이션: 파일 내 3건(M1 핀 변환 복원 · M2 영역 제외 복원 · M3 스냅샷 크롭 복원) +
 *   P25_APP_SRC=<변형 20_App.js> 로 주입하면 본 검사가 FAIL → EXIT=1.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const mapSrc = rd("public/js/modules/10_MapCtrl.js");
const appSrc = process.env.P25_APP_SRC
  ? fs.readFileSync(process.env.P25_APP_SRC, "utf8").replace(/\r\n/g, "\n")
  : rd("public/js/modules/20_App.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

const CROP_PCT = { x: 10, y: 20, w: 40, h: 30 }; // % — 페이지의 40%×30%만 보는 창
const DECK = { id: "dck_win", crop: CROP_PCT, page: 1, deployment_id: "dep_orig" };

/** App + MapCtrl 을 한 샌드박스에 평가. PDF 는 snapshotAllPages 인자만 기록하는 경계 스텁. */
function load(aSrc = appSrc, { deck } = {}) {
  const State = {
    mode: "designer", pins: [], zones: [], annotations: [],
    fileName: "d.pdf", fileType: "image", pdfPage: 1, pdfDoc: null
  };
  const snapCalls = [];
  const cl = () => ({ add() {}, remove() {}, toggle() {}, contains: () => false });
  const sandbox = {
    console, Math, JSON, Promise, setTimeout, clearTimeout,
    State,
    Projects: { currentDeck: deck || null },
    PDF: { lastSnapshotDims: null, snapshotAllPages: async (...a) => { snapCalls.push(a); return ["data:image/jpeg;base64,x"]; } },
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
  vm.runInContext(mapSrc + "\n;globalThis.__MAP = MapCtrl;", sandbox);
  vm.runInContext(aSrc + "\n;globalThis.__A = App;", sandbox);
  return { App: sandbox.__A, State, snapCalls };
}

// 창 구역 안·밖에 걸친 표본(페이지 기준 %). crop = x10~50, y20~50.
const fixture = () => ({
  pins: [
    { id: 1, page: 1, x: 30, y: 35, label: "안" },
    { id: 2, page: 1, x: 90, y: 90, label: "밖" },
    { id: 3, page: 2, x: 5, y: 5, label: "다른 페이지" }
  ],
  zones: [
    { id: "z1", page: 1, shape: "rect", x: 30, y: 35, w: 10, h: 6 },
    { id: "z2", page: 1, shape: "poly", points: [{ x: 20, y: 30 }, { x: 30, y: 30 }, { x: 30, y: 40 }], x: 20, y: 30, w: 10, h: 10 },
    { id: "zOut", page: 1, shape: "rect", x: 90, y: 90, w: 5, h: 5 },
    { id: "zc", page: 1, shape: "circle", cx: 70, cy: 70, r: 3 }
  ],
  annotations: [
    { id: "a1", page: 1, type: "text", x: 300, y: 350, text: "안" },
    { id: "aOut", page: 1, type: "text", x: 900, y: 900, text: "밖" },
    { id: "aPen", page: 1, type: "pen", pts: [{ x: 100, y: 100 }, { x: 950, y: 950 }] }
  ]
});

function checkPayloadKeepsOriginal(App, State, tag) {
  const fx = fixture();
  State.pins = fx.pins; State.zones = fx.zones; State.annotations = fx.annotations;
  const body = App._buildSavePayload(null, null);
  const pins = JSON.parse(body.pins), zones = JSON.parse(body.zones), annos = JSON.parse(body.annotations);
  ok(pins.length === 3 && zones.length === 4 && annos.length === 3,
    `${tag} 크롭 밖 항목도 저장됨 — 핀 ${pins.length}/3 · 영역 ${zones.length}/4 · 주석 ${annos.length}/3`);
  const p1 = pins.find((p) => p.id === 1), p2 = pins.find((p) => p.id === 2);
  ok(p1 && p1.x === 30 && p1.y === 35 && p2 && p2.x === 90 && p2.y === 90,
    `${tag} 핀 좌표 = 페이지 기준 % 그대로(1:${p1 && p1.x},${p1 && p1.y} 2:${p2 && p2.x},${p2 && p2.y})`);
  ok(JSON.stringify(zones) === JSON.stringify(fixture().zones), `${tag} 영역 좌표·도형 원본 그대로`);
  ok(JSON.stringify(annos) === JSON.stringify(fixture().annotations), `${tag} 주석 좌표(permille) 원본 그대로`);
}

/* ① 창(crop) 구역에서 저장해도 원본 좌표·항목 수 그대로 (종전: 변환 + 크롭 밖 제외) */
console.log("=== WP1·H7: 창 구역 저장 = 원본(페이지 기준) 좌표 그대로 ===");
console.log("\n[test1] 창(crop) 구역 → 핀/영역/주석 변환·제외 없음");
{
  const { App, State } = load(appSrc, { deck: DECK });
  checkPayloadKeepsOriginal(App, State, "test1");
}

/* ② crop 없는 구역 → 종전과 동일(회귀 없음) */
console.log("\n[test2] crop 없는 구역 → 동일 결과(회귀 없음)");
{
  const { App, State } = load(appSrc, { deck: { id: "d", crop: null, page: 1 } });
  checkPayloadKeepsOriginal(App, State, "test2");
}

/* ③ 직렬화 위생(blob 미리보기 제거 · videoUrl → localOnly · uploading 제거)은 유지 */
console.log("\n[test3] 직렬화 위생 유지");
{
  const { App, State } = load(appSrc, { deck: DECK });
  State.pins = [{ id: 9, page: 1, x: 1, y: 1, localPreview: "blob:x", imageUrl: "blob:y", videoUrl: "blob:v", uploading: true }];
  const q = JSON.parse(App._buildSavePayload(null, null).pins)[0];
  ok(q && !("localPreview" in q) && !("imageUrl" in q) && !("videoUrl" in q) && q.localOnly === true && !("uploading" in q),
    "test3 blob URL·uploading 제거, videoUrl → localOnly — " + JSON.stringify(q));
}

/* ④ 저장 스냅샷은 전체 페이지 — 구역 crop 을 PDF.snapshotAllPages 에 넘기지 않는다 */
console.log("\n[test4] _snapshotPages(PDF) 는 창 구역에서도 crop 인자 없이 전체 페이지");
{
  const { App, State, snapCalls } = load(appSrc, { deck: DECK });
  State.fileType = "pdf"; State.pdfDoc = { numPages: 1 };
  await App._snapshotPages();
  const a = snapCalls[0] || [];
  ok(snapCalls.length === 1 && a[0] === State.pdfDoc && a[3] == null,
    "test4 snapshotAllPages 4번째 인자(deckCrop) = " + JSON.stringify(a[3]) + " (기대 없음)");
}

/* ⑤ 라이브 State 불변 */
console.log("\n[test5] 라이브 State.pins/zones/annotations 원본 불변");
{
  const { App, State } = load(appSrc, { deck: DECK });
  const fx = fixture();
  State.pins = fx.pins; State.zones = fx.zones; State.annotations = fx.annotations;
  const before = JSON.stringify([State.pins, State.zones, State.annotations]);
  App._buildSavePayload(null, null);
  ok(JSON.stringify([State.pins, State.zones, State.annotations]) === before, "test5 저장 페이로드 생성이 State 를 변형하지 않음");
}

/* ══ 파일 내 뮤테이션 — 종전 결함을 되살리면 위 검사가 잡아야 한다 ══ */
function caught(label, mutated, run) {
  if (mutated === appSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함 — " + label); failed++; return; }
  const before = failed;
  const silent = console.log; console.log = () => {};
  try { run(mutated); } finally { console.log = silent; }
  const hit = failed > before;
  failed = before;
  ok(hit, label + " → 검사가 실패함(실효성 증명)");
}
console.log("\n[뮤테이션]");
caught("M1 핀 크롭 변환·크롭 밖 제외 복원",
  appSrc.replace("        const q = Object.assign({}, p);\n        if (q.videoUrl)",
    "        const q = Object.assign({}, p);\n        const cd = Projects.currentDeck;\n" +
    "        if (cd && cd.crop && (q.page || 1) === (cd.page || 1)) { const m = MapCtrl.pageToDeckCropPct(q.x, q.y, cd.crop); if (!m) return null; q.x = m.x; q.y = m.y; }\n" +
    "        if (q.videoUrl)").replace("      });\n      return this._deploymentBody({", "      }).filter(Boolean);\n      return this._deploymentBody({"),
  (m) => { const { App, State } = load(m, { deck: DECK }); checkPayloadKeepsOriginal(App, State, "M1"); });
caught("M2 영역 크롭 밖 제외 복원",
  appSrc.replace("zones: State.zones || []", "zones: (State.zones || []).filter(z => z.x == null || !!MapCtrl.pageToDeckCropPct(z.x, z.y, (Projects.currentDeck || {}).crop))"),
  (m) => { const { App, State } = load(m, { deck: DECK }); checkPayloadKeepsOriginal(App, State, "M2"); });
caught("M3 저장 스냅샷 crop 전달 복원",
  appSrc.replace("return await PDF.snapshotAllPages(State.pdfDoc);", "return await PDF.snapshotAllPages(State.pdfDoc, undefined, undefined, { page: 1, crop: Projects.currentDeck.crop });"),
  (m) => {
    const { App, State, snapCalls } = load(m, { deck: DECK });
    State.fileType = "pdf"; State.pdfDoc = { numPages: 1 };
    // 동기 판정을 위해 호출 직후 인자를 본다(스텁은 즉시 기록)
    App._snapshotPages();
    const a = snapCalls[0] || [];
    ok(a[3] == null, "M3 deckCrop 인자 없음");
  });

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
