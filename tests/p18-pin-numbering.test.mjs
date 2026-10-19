/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p18-pin-numbering.test.mjs)
 *
 * 대상: .claude/WORK_ORDER_20260917_pin.md — 마스터 원문:
 *  "번호가 중복이 되어서는 절대 안 돼. 삭제된 번호를 채워서도 안 돼.
 *   최상위 번호 다음 번호로 되게 하고, 각 공의 크기도 달라서는 안 돼.
 *   정보가 있거나 사진이 등록된 건 없는 거와 색이나 상태를 다르게 표시해"
 * 🔴 증거: 마스터 스크린샷 핀 2·3·4·3(3번 중복) — 재현된 데이터 정합 결함.
 *
 * 근본원인(scout 실측): 01b_PinSeries.js nextCheckboardNo() 가 "개수" 로 채번했다.
 *   1,2,3,4 존재 → 3번 삭제 → 남은 개수 3 → 다음 번호 1+3=4 (이미 있는 4와 중복).
 *   수정: 같은 페이지 체크보드 핀들의 label 숫자 최댓값 + 1 로 변경(하한 = 시작번호).
 *   삭제로 생긴 구멍은 재사용하지 않는다(마스터 명시 — 현장 기록과 연결된 값).
 *
 * 실제 모듈 소스(01b_PinSeries.js / 10_MapCtrl.js)를 그대로 vm 에 평가해 검사한다(목 구현 아님).
 * 뮤테이션 3건: 최댓값→개수로 되돌림 / NaN 필터 제거 / 콘텐츠 색 분기 제거.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const seriesSrc = rd("public/js/modules/01b_PinSeries.js");
const mapSrc = rd("public/js/modules/10_MapCtrl.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── WCAG 2.1 대비비 (의존성 0 · 전역 CLAUDE.md §4 체커, tests/p9 와 동일 공식) ── */
const lum = (hex) => {
  const v = String(hex).replace("#", "");
  const c = [0, 2, 4].map((i) => parseInt(v.substr(i, 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => {
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

const AppMock = {
  pinHasContent(pin) {
    return !!(pin && (pin.imageId || pin.imageUrl || pin.videoId ||
      pin.note || (pin.attachments && pin.attachments.length) || pin.has3D));
  }
};

/** PinSeries 단독 로드(순수 로직 — DOM 불필요) */
function loadSeries(sSrc = seriesSrc) {
  const sandbox = { console, App: AppMock, JSON, Map, Set, localStorage: { getItem: () => null, setItem() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(sSrc + "\n;globalThis.__PS = PinSeries;", sandbox);
  return sandbox.__PS;
}

/* ────────────────────────────────────────────────────────────
 * ①②③④⑤ 채번 — nextCheckboardNo / duplicateCheckboardIds
 * ──────────────────────────────────────────────────────────── */
function suiteNumbering(label, sSrc) {
  console.log("\n[" + label + "]");
  const PS = loadSeries(sSrc);

  // ① 1,2,3,4 → 3번 삭제 → 새 핀 = 5 (4 가 아님)
  let pins = [1, 2, 3, 4].map((n, i) => ({ id: "p" + n, page: 1, checkboard: true, label: String(n) }));
  pins = pins.filter((p) => p.label !== "3"); // 3번 삭제 → 남은 [1,2,4]
  const next1 = PS.nextCheckboardNo(pins, 1, 1);
  ok(next1 === 5, `1,2,4 남은 상태(3번 삭제)에서 다음 번호 = ${next1} (기대 5, 개수+1=4 는 오답)`);

  // ② 연속 생성·삭제 20회 시뮬레이션 — 절대 중복 없음
  let sim = [];
  const seen = new Set();
  let dupFound = false;
  for (let i = 0; i < 20; i++) {
    const no = PS.nextCheckboardNo(sim, 1, 1);
    if (seen.has(no)) dupFound = true;
    seen.add(no);
    sim.push({ id: "s" + i, page: 1, checkboard: true, label: String(no) });
    if (i % 3 === 1) sim = sim.slice(1); // 주기적으로 가장 오래된 핀 삭제(구멍 생성)
  }
  ok(!dupFound, `연속 생성·삭제 20회 중 중복 발생 = ${dupFound} (기대 false)`);

  // ③ 삭제된 번호를 재사용하지 않는다
  const afterHole = [
    { id: "h1", page: 1, checkboard: true, label: "1" },
    { id: "h2", page: 1, checkboard: true, label: "5" }
  ]; // 2,3,4 는 삭제되어 구멍
  const next3 = PS.nextCheckboardNo(afterHole, 1, 1);
  ok(next3 === 6, `구멍(2,3,4 삭제) 있어도 다음 번호 = ${next3} (기대 6 — 구멍 재사용 금지)`);

  // ④ 핀이 0개면 시작번호부터
  ok(PS.nextCheckboardNo([], 1, 1) === 1, "핀 0개 · 시작번호 1 → 다음 번호 1");
  ok(PS.nextCheckboardNo([], 1, 10) === 10, "핀 0개 · 시작번호 10 → 다음 번호 10");

  // ⑤ label 이 비었거나 숫자가 아닌 핀이 섞여도 최댓값 계산이 깨지지 않는다(NaN 오염 금지)
  const messy = [
    { id: "m1", page: 1, checkboard: true, label: "3" },
    { id: "m2", page: 1, checkboard: true, label: "" },
    { id: "m3", page: 1, checkboard: true, label: "abc" },
    { id: "m4", page: 1, checkboard: true, label: undefined }
  ];
  const next5 = PS.nextCheckboardNo(messy, 1, 1);
  ok(next5 === 4, `비정상 label 혼재(""/"abc"/undefined) → 다음 번호 = ${next5} (기대 4, NaN 오염이면 NaN)`);

  // 중복 탐지(표시용) — 기존 저장된 중복은 그대로 두고 탐지만
  const dupFixture = [
    { id: "d1", page: 1, checkboard: true, label: "3" },
    { id: "d2", page: 1, checkboard: true, label: "2" },
    { id: "d3", page: 1, checkboard: true, label: "3" }, // d1 과 중복
    { id: "d4", page: 1, checkboard: true, label: "4" }
  ];
  const dupIds = PS.duplicateCheckboardIds(dupFixture, 1);
  ok(dupIds.has("d1") && dupIds.has("d3") && !dupIds.has("d2") && !dupIds.has("d4"),
    `중복 탐지 = {${Array.from(dupIds).join(",")}} (기대 d1,d3 만)`);
}

/* ────────────────────────────────────────────────────────────
 * ⑥ 콘텐츠 있는 핀과 없는 핀의 markerStyle 이 서로 다른 값을 낸다 + WCAG 실측
 * ──────────────────────────────────────────────────────────── */
function suiteMarkerStyle(label, sSrc) {
  console.log("\n[" + label + "]");
  const PS = loadSeries(sSrc);
  const filled = { id: "f1", page: 1, checkboard: true, imageId: "img1" };
  const empty = { id: "f2", page: 1, checkboard: true };
  const stF = PS.markerStyle(filled);
  const stE = PS.markerStyle(empty);
  ok(stF.filled === true && stE.filled === false, `filled 판정 = ${stF.filled}/${stE.filled} (기대 true/false)`);
  ok(JSON.stringify(stF.colors) !== JSON.stringify(stE.colors),
    "등록/미등록 markerStyle.colors 가 서로 다른 값");
  ok(stF.dash !== stE.dash, `형태(ring dash) 도 다르다: "${stF.dash}" vs "${stE.dash}"`);

  // WCAG 실측: 등록↔미등록 상호 분리도(비텍스트 UI 요소, head/head2 — 시각적으로 지배적인 부분)
  const sepHead = contrast(stF.colors.head, stE.colors.head);
  const sepHead2 = contrast(stF.colors.head2, stE.colors.head2);
  ok(sepHead >= 3, `등록↔미등록 head 상호 분리도 = ${sepHead.toFixed(2)}:1 (WCAG 1.4.11 비텍스트 3:1 이상)`);
  ok(sepHead2 >= 3, `등록↔미등록 head2 상호 분리도 = ${sepHead2.toFixed(2)}:1 (WCAG 1.4.11 비텍스트 3:1 이상)`);
  // 흰 도면 위 자체 시인성(라이트/다크 공통 — 리터럴 hex)
  const WHITE = "#ffffff";
  ok(contrast(stE.colors.head2, WHITE) >= 3, `미등록 head2 ↔ 흰 도면 = ${contrast(stE.colors.head2, WHITE).toFixed(2)}:1 (≥3:1)`);
  ok(contrast(stF.colors.text, WHITE) >= 4.5 && contrast(stE.colors.text, WHITE) >= 4.5,
    `숫자 텍스트 ↔ 흰 디스크 ≥4.5:1 (등록 ${contrast(stF.colors.text, WHITE).toFixed(2)}:1 · 미등록 ${contrast(stE.colors.text, WHITE).toFixed(2)}:1)`);
}

/* ────────────────────────────────────────────────────────────
 * ⑦ 모든 핀이 같은 크기 스케일을 받는다(구조 확인 — pinScreenScale 공유)
 * ──────────────────────────────────────────────────────────── */
function suitePinScale(label) {
  console.log("\n[" + label + "]");
  // [WO 20261016-pinscale §4] 평면(비-ISO) 핀 크기는 더는 마커마다 JS 가 inline transform 을 쓰지
  // 않는다 — #pins-layer 에 CSS 변수(--pin-scale) 하나만 세팅하고, 정적 스타일시트 규칙
  // (#pins-layer:not(.iso-mode) > .pin-marker { transform: ... scale(var(--pin-scale)) })이
  // 마커 전체에 똑같이 전파한다(성능: 핀치/줌 중 매 프레임 마커 순회 제거). 그래서 "핀 크기 실제
  // 적용"은 이제 ① 마커에 inline transform 이 0건(CSS 가 전담) ② --pin-scale 값이 pinScreenScale()
  // 과 일치 — 두 가지로 검사한다(종전 "transform 문자열에 scale() 포함"보다 더 강한 단언).
  function makeMarker() { return { style: {}, classList: { contains: () => false } }; }
  const State = { zoom: 1.7, pan: { x: 0, y: 0 }, isoView: false, isoDir: 0 };
  const cssVars = {};
  const layer = {
    children: [makeMarker(), makeMarker(), makeMarker()], // 라벨 길이·콘텐츠 유무와 무관 — 인자 자체가 없음
    classList: { add() {}, remove() {}, toggle() {} }, // [WO 20261019-pinscale4] _applyPinBillboard 가 pin-num-off 토글 호출(실 DOM 과 동일한 최소 API)
    style: { setProperty(k, v) { cssVars[k] = v; } }
  };
  const sandbox = {
    console, State, Math, JSON,
    document: { getElementById: (id) => (id === "pins-layer" ? layer : null) },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(mapSrc + "\n;globalThis.__MAP = MapCtrl;", sandbox);
  const MapCtrl = sandbox.__MAP;
  // 🔴 [b0d24ad 재도입] 기대값은 리터럴이 아니라 MapCtrl.pinScreenScale()(바닥·상한 포함 산식) 호출
  // 결과로 계산한다 — PIN_SCALE·PIN_MAX_PX 등 상수가 또 바뀌어도 이 테스트가 따라간다(하드코딩 금지).
  const expectScale = MapCtrl.pinScreenScale();
  MapCtrl._applyPinBillboard();
  const transforms = layer.children.map((m) => m.style.transform);
  const allSame = transforms.every((t) => t === transforms[0]);
  ok(allSame, `핀 3개(핀별 속성 무관) 동일 transform(0건) = ${allSame} → "${transforms[0]}"`);
  ok(transforms.every((t) => t === undefined), "평면 모드 — 마커 inline transform 0건(CSS 정적 규칙이 전담, 성능개선)");
  ok(cssVars["--pin-scale"] === expectScale.toFixed(4), `--pin-scale="${cssVars["--pin-scale"]}" = pinScreenScale()(zoom=1.7)=${expectScale.toFixed(4)}(핀 크기 실제 적용 확인)`);
}

/* ── 실행: 정상 소스 ─────────────────────────────────────────── */
suiteNumbering("①②③④⑤ 채번 · 중복 방지 · 구멍 미재사용 (정상 소스)", seriesSrc);
suiteMarkerStyle("⑥ 콘텐츠 유무 색/형태 구분 (정상 소스)", seriesSrc);
suitePinScale("⑦ 핀 크기 균일 (정상 소스)");

/* ────────────────────────────────────────────────────────────
 * 🔴 뮤테이션 3건 — 되돌리면 실패해야 한다(테스트 실효성 증명)
 * ──────────────────────────────────────────────────────────── */
console.log("\n[뮤테이션A] 최댓값 채번 → 개수 채번으로 되돌림 → ①②③ 실패해야 함");
{
  // 🔴 [WO 20260917 멀티유저 ①] nextCheckboardNo 에 author 4번째 인자가 추가되어 시그니처가
  //   바뀌었다(대역 침범 방지 — tests/p31-multiuser.test.mjs) — 정규식을 그 변경에 맞춰 갱신.
  const needle = /nextCheckboardNo\(pins, page, start(?:, author)?\) \{[\s\S]*?\n    \},/;
  const oldImpl = `nextCheckboardNo(pins, page, start) {
      const pg = page || 1;
      const s = (Number.isFinite(start) && start >= 1) ? start : 1;
      const n = (pins || []).filter(p => p && (p.page || 1) === pg && p.checkboard).length;
      return s + n;
    },`;
  const mutated = seriesSrc.replace(needle, oldImpl);
  ok(mutated !== seriesSrc, "뮤테이션A 적용 확인(치환 발생)");
  const PS = loadSeries(mutated);
  let pins = [1, 2, 3, 4].map((n) => ({ id: "p" + n, page: 1, checkboard: true, label: String(n) }));
  pins = pins.filter((p) => p.label !== "3");
  const next1 = PS.nextCheckboardNo(pins, 1, 1);
  ok(next1 === 4, `뮤테이션 적용 시 개수 기반 채번으로 회귀(다음 번호 = ${next1}, 4=중복 재현) → ①이 실패할 조건 재현`);
}

console.log("\n[뮤테이션B] NaN 필터 제거(Number.isFinite 체크 삭제 → 순진하게 Math.max 사용) → ⑤ 실패해야 함");
{
  // ponytail: `n > maxNo` 단독 치환은 NaN 비교가 항상 false 라 우연히 안전하다(JS 의미론).
  // isFinite 가드가 실제로 막는 실수 = "Math.max(maxNo, n)" 로 단순화하는 흔한 리팩터 —
  // Math.max(x, NaN) = NaN 이라 한 번 오염되면 그 뒤로 계속 NaN 이 전파된다.
  // [WO 20261001-startno] 최댓값 계산이 nextInBand(대역 범위 필터 포함)로 옮겨졌다 — 같은 가드 라인을 대상으로 한다.
  //   대역 코드는 maxNo 가 NaN(거짓)이면 대역 시작값으로 떨어지므로 결과는 NaN 이 아니라 "1"(= 기존 3 과 무관한 오답)이다.
  //   전: Number.isNaN(next5) · 후: next5 !== 4(⑤ 의 정답) — 어느 쪽이든 ⑤ 가 실패하는 조건을 재현한다.
  const needle = "if (Number.isFinite(n) && n >= r.lo && n <= r.hi && n > maxNo) maxNo = n; // 다른 대역 핀 무시";
  ok(seriesSrc.indexOf(needle) >= 0, "뮤테이션B 대상 라인 존재 확인");
  const mutated = seriesSrc.replace(needle, "maxNo = Math.max(maxNo, n);");
  ok(mutated !== seriesSrc, "뮤테이션B 적용 확인(치환 발생)");
  const PS = loadSeries(mutated);
  const messy = [
    { id: "m1", page: 1, checkboard: true, label: "3" },
    { id: "m2", page: 1, checkboard: true, label: "" },
    { id: "m3", page: 1, checkboard: true, label: "abc" }
  ];
  const next5 = PS.nextCheckboardNo(messy, 1, 1);
  ok(next5 !== 4, `뮤테이션 적용 시 NaN 오염으로 정답(4)이 깨짐(다음 번호 = ${next5}) → ⑤가 실패할 조건 재현`);
}

console.log("\n[뮤테이션C] 콘텐츠 등록/미등록 색 분기 제거 → ⑥ 실패해야 함");
{
  const needle = 'if (kind === "checkboard") return (filled === false) ? this.CHECKBOARD_EMPTY_COLOR : this.CHECKBOARD_COLOR;';
  ok(seriesSrc.indexOf(needle) >= 0, "뮤테이션C 대상 라인 존재 확인");
  const mutated = seriesSrc.replace(needle, 'if (kind === "checkboard") return this.CHECKBOARD_COLOR;');
  ok(mutated !== seriesSrc, "뮤테이션C 적용 확인(치환 발생)");
  const PS = loadSeries(mutated);
  const stF = PS.markerStyle({ id: "f1", page: 1, checkboard: true, imageId: "img1" });
  const stE = PS.markerStyle({ id: "f2", page: 1, checkboard: true });
  const same = JSON.stringify(stF.colors) === JSON.stringify(stE.colors);
  ok(same, `뮤테이션 적용 시 등록/미등록 색이 같아짐(colors 동일 = ${same}) → ⑥이 실패할 조건 재현`);
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
