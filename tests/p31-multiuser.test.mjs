/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p31-multiuser.test.mjs)
 *
 * 마스터 지시(2026-09-17, 재설계 확정):
 *   "시작번호는 사용자별 번호 대역이다 — 사용자A=100, 사용자B=200 처럼 겹치지 않는 번호
 *    대역을 나눠 쓴다. 번호만 봐도 누가 찍은 핀인지 알 수 있고, 색으로도 구분되게 해라."
 *
 * 근본원인(재설계 전):
 *   ① State.checkboardStart 는 "페이지별" 값만 있었고 메모리 전용이라 세션을 닫으면 사라졌다.
 *   ② nextCheckboardNo() 가 "페이지 전체" 최댓값을 봤다 — 서로 다른 대역(100대/200대)을 쓰는
 *      두 사용자가 같은 페이지에서 작업하면, 한쪽이 찍은 큰 번호가 다른 쪽의 다음 번호 계산에
 *      섞여 "대역 침범"이 발생한다(A: 100,101 → B: 200 → A 의 다음 번호가 201 이 되어버림).
 *   ③ 사용자 구분 축이 아예 없었다(색·번호 모두).
 *
 * 조치(01b_PinSeries.js 정본):
 *   - userBandStart/setUserBandStart: 대역 시작값을 "사용자 이메일" 키로 localStorage 에 저장
 *     (배포본 단일 필드에 저장하면 다른 사용자가 저장할 때 덮어써지므로, 사용자별 값은
 *      그 사용자에게 붙는 저장소를 쓴다 — 브라우저 localStorage 는 구조적으로 공유되지 않는다).
 *   - nextCheckboardNo(pins, page, start, author): author 지정 시 "같은 작성자가 찍은 핀"만으로
 *     최댓값을 계산 — 대역 침범을 원천 차단.
 *   - userMark(pin, no): 체크보드 핀은 번호 대역(100단위)에서 색을 파생, 그 외 계열은 작성자
 *     이메일 해시로 폴백. 팔레트는 USER_MARK_PALETTE 하나뿐(SoT).
 *   - 20_App.js _checkboardStart()/_setCheckboardStart(): 사용자 대역이 있으면 최우선,
 *     없으면 기존 페이지별 값(State.checkboardStart)으로 폴백(하위호환).
 *
 * 🔴 [WO 20261001-startno] 정책 갱신(마스터 확정: 100 단위 대역, 서버 배정 + 본인 변경):
 *   - 대역 k = (k-1)*100+1 … k*100. 시작값 101 → 대역 2(101–200), 201 → 대역 3. (구 기대 "100/200" 은
 *     새 대역에서 1–100 의 마지막 칸 / 101–200 의 끝이라 픽스처를 101/201 로 옮겼다)
 *   - 다음 번호 = 내 대역 안 전원 핀 최댓값+1(다른 대역 무시) → ③ 기대 201(603f9b9 대역 침범) → 103.
 *   - 대역 가득 → 핀 생성 안 함 + 확인창(③-d) · 같은 대역 다른 사람 → 남의 핀 포함 이어 씀(③-c).
 *   - 영속화는 PinSeries.myBand/setMyBand(서버 값 캐시, 프로젝트+사용자 키) + userStart(직접 입력 하한).
 *
 * 실제 모듈 소스(01b_PinSeries.js / 20_App.js)를 그대로 vm 에 평가한다(목 구현 아님).
 * 뮤테이션 6건이 붙어 있어, 고친 코드를 되돌리면 해당 검사가 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const seriesSrc = rd("public/js/modules/01b_PinSeries.js");
const appSrc    = rd("public/js/modules/20_App.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── WCAG 2.1 대비비 (의존성 0 · 전역 CLAUDE.md §4 체커, p9 와 동일 계산식) ───── */
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

/* ── 최소 mock: localStorage(공유 store 가능) · UI(무동작) ───────────────── */
function makeLocalStorage(store) {
  const s = store || {};
  return { getItem: (k) => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); }, _store: s };
}
function makeUI() { return { $: () => null, renderPinList() {}, renderPinsOnMap() {} }; }

/** 실제 01b_PinSeries.js + 20_App.js 를 평가한 새 실행 컨텍스트.
 *  sharedStore 를 넘기면 "세션을 새로 연" 상황(다른 컨텍스트가 같은 localStorage 를 공유)을 재현한다. */
function makeCtx(sSrc, aSrc, sharedStore) {
  const State = { pins: [], pdfPage: 1, checkboard: true, checkboardStart: {}, activePin: null };
  const Auth = { user: null };
  const ls = makeLocalStorage(sharedStore);
  const confirms = [];
  const sandbox = {
    console, document: {}, JSON, Map, Set,
    localStorage: ls, State, Auth, UI: makeUI(),
    Prompt: { toast() {}, confirm: async (t, m) => { confirms.push(String(m)); return false; } }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(sSrc + "\n" + aSrc + "\n;globalThis.__APP=App; globalThis.__PS=PinSeries;", sandbox);
  return { State, Auth, App: sandbox.__APP, PS: sandbox.__PS, store: ls._store, confirms };
}

/* ────────────────────────────────────────────────────────────
 * ①~③ 사용자별 번호 대역 + 대역 침범 방지 (정상 소스)
 * ──────────────────────────────────────────────────────────── */
function suiteBandCore(label, sSrc, aSrc) {
  console.log("\n[" + label + "]");
  const ctx = makeCtx(sSrc, aSrc);

  ctx.Auth.user = { email: "a@seastar.test" };
  ctx.App._setCheckboardStart(1, 101);
  ctx.App._placeCheckboardPin({ x: 1, y: 1 });
  ok(ctx.State.pins[0].label === "101", `① 사용자A 시작 101(대역 101–200) → 첫 핀 = ${ctx.State.pins[0].label} (기대 101)`);
  ctx.App._placeCheckboardPin({ x: 2, y: 2 });
  ok(ctx.State.pins[1].label === "102", `사용자A 두 번째 핀 = ${ctx.State.pins[1].label} (기대 102)`);

  ctx.Auth.user = { email: "b@seastar.test" };
  ctx.App._setCheckboardStart(1, 201);
  ctx.App._placeCheckboardPin({ x: 3, y: 3 });
  ok(ctx.State.pins[2].label === "201", `② 사용자B 시작 201(대역 201–300) → 첫 핀 = ${ctx.State.pins[2].label} (기대 201)`);

  ctx.Auth.user = { email: "a@seastar.test" };
  ctx.App._placeCheckboardPin({ x: 4, y: 4 });
  // 🔴 [WO 20261001-startno] 의미 변경(마스터 확정 — 대역 우선): 603f9b9 의 기대 201(전원 최댓값+1 = B 대역 침범)을
  //   폐기한다. 다음 번호 = 내 대역(101–200) 안 최댓값+1 = 103, 다른 대역(B 의 201)은 무시.
  const p3 = ctx.State.pins[3];
  ok(!!p3 && p3.label === "103",
    `③ 대역 우선: A(101,102)+B(201) 이후 A 가 찍으면 = ${p3 && p3.label} (기대 103 — 다른 대역 핀 무시, 침범 0)`);

  // ③-c 같은 대역을 고른 다른 사람은 남의 핀까지 포함해 이어 쓴다(대역 내 유일)
  ctx.Auth.user = { email: "b@seastar.test" };
  ctx.App._setNumBand(2);
  ctx.App._placeCheckboardPin({ x: 5, y: 5 });
  const p4 = ctx.State.pins[4];
  ok(!!p4 && p4.label === "104", `③-c B 가 A 의 대역(101–200)으로 옮기면 = ${p4 && p4.label} (기대 104 — A 의 101~103 포함 최댓값+1)`);

  // ③-d 대역 가득 → 핀을 만들지 않고 확인창(넘침 0)
  const c3 = makeCtx(sSrc, aSrc);
  c3.Auth.user = { email: "a@seastar.test" };
  c3.State.pins.push({ id: 1, page: 1, checkboard: true, label: "100", author: "z@seastar.test" });
  const before = c3.State.pins.length;
  const r = c3.App._placeCheckboardPin({ x: 1, y: 1 });
  ok(r === null && c3.State.pins.length === before, `③-d 대역 1–100 에 100 이 있으면 새 핀 0개(넘침 0) — 반환=${r} 핀수 ${before}→${c3.State.pins.length}`);
  ok(c3.confirms.length === 1 && /가득 찼습니다/.test(c3.confirms[0]) && /101–200/.test(c3.confirms[0]),
    `③-d 확인창 "대역이 가득 찼습니다 — 다음 대역(101–200)…" 1회 — ${JSON.stringify(c3.confirms)}`);

  // ③-b 대역 없이: A 가 1,2 → B 가 찍으면 3 (author 필터면 B 자기 핀 0개 → 1 = A 의 1 과 중복)
  const c2 = makeCtx(sSrc, aSrc);
  c2.Auth.user = { email: "a@seastar.test" };
  c2.App._placeCheckboardPin({ x: 1, y: 1 });
  c2.App._placeCheckboardPin({ x: 2, y: 2 });
  c2.Auth.user = { email: "b@seastar.test" };
  c2.App._placeCheckboardPin({ x: 3, y: 3 });
  ok(c2.State.pins[2].label === "3",
    `③-b 남의 핀(1,2) 로드 후 B 첫 핀 = ${c2.State.pins[2].label} (기대 3, 1 이면 중복 버그)`);
}

/* ────────────────────────────────────────────────────────────
 * ④ 영속화 — 세션(컨텍스트) 재개 후에도 대역 유지
 * ⑤ 다른 사용자가 저장해도 내 대역이 사라지지 않는다
 * ──────────────────────────────────────────────────────────── */
function suitePersistence(label, sSrc, aSrc) {
  console.log("\n[" + label + "]");
  const ctx1 = makeCtx(sSrc, aSrc);
  ctx1.Auth.user = { email: "a@seastar.test" };
  ctx1.App._setCheckboardStart(1, 101);

  // "세션 재개" = 같은 localStorage store 를 공유하는 새 vm 컨텍스트(State.pins 는 초기화됨)
  const ctx2 = makeCtx(sSrc, aSrc, ctx1.store);
  ctx2.Auth.user = { email: "a@seastar.test" };
  ok(ctx2.App._checkboardStart(1) === 101 && ctx2.App._numBand() === 2,
    `④ 설정 영속: 새 세션에서 재설정 없이 조회 = ${ctx2.App._checkboardStart(1)} · 대역 ${ctx2.App._numBand()} (기대 101 · 2)`);

  // 다른 사용자(B)가 자기 대역을 저장 — 같은 store 공유
  ctx2.Auth.user = { email: "b@seastar.test" };
  ctx2.App._setCheckboardStart(1, 201);
  ok(ctx2.App._checkboardStart(1) === 201, "사용자B 조회 = 201 (자기 자신 대역 확인)");

  // A 로 다시 전환 — B 의 저장이 A 의 대역을 지우지 않아야 한다
  ctx2.Auth.user = { email: "a@seastar.test" };
  ok(ctx2.App._checkboardStart(1) === 101,
    `⑤ 다른 사용자(B) 저장 후에도 A 대역 유지 = ${ctx2.App._checkboardStart(1)} (기대 101, B 저장에 의해 사라지면 안 됨)`);

  // 완전히 새로운 컨텍스트(같은 store)에서도 여전히 두 사용자 값이 독립적으로 유지
  const ctx3 = makeCtx(sSrc, aSrc, ctx1.store);
  ctx3.Auth.user = { email: "a@seastar.test" };
  ok(ctx3.App._checkboardStart(1) === 101, "제3 세션에서도 A=101 유지");
  ctx3.Auth.user = { email: "b@seastar.test" };
  ok(ctx3.App._checkboardStart(1) === 201, "제3 세션에서도 B=201 유지(서로 다른 키에 독립 저장 — SoT 충돌 없음)");
}

/* ────────────────────────────────────────────────────────────
 * ⑥ 대역 설정 없음(비로그인/구버전) → 기본 1
 * ──────────────────────────────────────────────────────────── */
function suiteDefault(label, sSrc, aSrc) {
  console.log("\n[" + label + "]");
  const ctx = makeCtx(sSrc, aSrc);
  ctx.Auth.user = null; // 비로그인
  ok(ctx.App._checkboardStart(1) === 1, `⑥ 대역/페이지값 모두 없음 → 기본 1 (실제 ${ctx.App._checkboardStart(1)})`);
  ctx.App._placeCheckboardPin({ x: 1, y: 1 });
  ok(ctx.State.pins[0].label === "1", `비로그인 첫 핀 번호 = ${ctx.State.pins[0].label} (기대 1)`);
  ok(ctx.State.pins[0].author === undefined, "비로그인 핀은 author 필드 자체가 없음(구버전 호환)");
}

/* ────────────────────────────────────────────────────────────
 * ⑦ 기존 3축(계열색·등록여부·형태 패턴) 불변 회귀
 * ──────────────────────────────────────────────────────────── */
function suiteAxesUnchanged(label, sSrc) {
  console.log("\n[" + label + "]");
  const ctx = makeCtx(sSrc, appSrc);
  const PS = ctx.PS;
  ok(PS.EMPTY_COLOR.text === "#991b1b", "미배치(empty) 색 정본 불변");
  // [WO 20260930-pinstyle] 지휘자 발주("핀 색이나 형태를 모드별로 구분") — CHECKER 색이 구 인디고
  // 블루에서 주황/앰버 계열로 의도적으로 바뀌었다(01b_PinSeries.js 실측 주석 참조). 값만 새 SoT로 갱신.
  ok(PS.CHECKBOARD_COLOR.text === "#431407", "체크보드(등록) 색 정본 불변");
  ok(PS.CHECKBOARD_EMPTY_COLOR.text === "#9a3412", "체크보드(미등록) 색 정본 불변");
  ok(PS.patternOf("checkboard", true) === "dashed" && PS.patternOf("checkboard", false) === "dotted",
    "체크보드 형태 패턴(dashed/dotted) 불변");
  ok(PS.patternOf("content", true) === "solid" && PS.patternOf("empty", false) === "dotted",
    "일반 핀 형태 패턴(solid/dotted) 불변");
  // 사용자 구분(4번째 축) 도입 후에도 filled(등록여부) 판정은 media/info 유무로만 결정된다
  const withMedia = { checkboard: true, label: "100", imageId: "shot" };
  const withoutMedia = { checkboard: true, label: "100" };
  ok(PS.markerStyle(withMedia).filled === true && PS.markerStyle(withoutMedia).filled === false,
    "등록여부(filled) 축은 userMark 도입과 무관하게 media/info 유무로만 결정");
}

/* ────────────────────────────────────────────────────────────
 * ⑧ 대역이 다른 핀은 색이 다르다 · ⑨ 미등록(속 빈 원)에서도 사용자 색 노출
 * ⑩ 사용자 색을 넣어도 등록/미등록 도형 구분은 그대로(p9 회귀와 동일 취지, 여기서 재확인)
 * ──────────────────────────────────────────────────────────── */
function suiteUserColor(label, sSrc) {
  console.log("\n[" + label + "]");
  const ctx = makeCtx(sSrc, appSrc);
  const PS = ctx.PS;

  const band100 = PS.userMark({ checkboard: true, label: "100" }, 100);
  const band200 = PS.userMark({ checkboard: true, label: "200" }, 200);
  ok(!!band100 && !!band200, "대역 100/200 모두 userMark 반환");
  ok(band100.color !== band200.color, `⑧ 대역 다른 핀 색 다름: 100대 ${band100.color} ≠ 200대 ${band200.color}`);

  // 미등록(사진/정보 없음) 체크보드 핀 — filled=false 이어도 userMark 는 그려진다
  const hollowPin = { checkboard: true, label: "150" };
  ok(PS.markerStyle(hollowPin).filled === false, "픽스처 확인: 이 핀은 미등록(filled=false)");
  const hollowMark = PS.userMark(hollowPin, 150);
  ok(!!hollowMark && !!hollowMark.color, `⑨ 미등록(속 빈 원) 핀에도 사용자 색 노출: ${hollowMark && hollowMark.color}`);

  // filled 축 자체는 그대로(⑩) — 같은 대역이라도 media 유무에 따라 filled 가 갈린다
  const filledPin = { checkboard: true, label: "150", imageId: "x" };
  ok(PS.markerStyle(filledPin).filled === true && PS.markerStyle(hollowPin).filled === false,
    "⑩ 같은 대역이어도 등록(filled=true)/미등록(filled=false) 구분은 그대로 유지");
}

/* ────────────────────────────────────────────────────────────
 * ⑪ 대역→색 팔레트 정의는 한 곳뿐(SoT) · ⑫ 대비 ≥3:1 실측
 * ──────────────────────────────────────────────────────────── */
function suitePaletteSoT(label, sSrc) {
  console.log("\n[" + label + "]");
  const PS_match = sSrc.match(/USER_MARK_PALETTE:\s*\[[^\]]*\]/g) || [];
  ok(PS_match.length === 1, `⑪ USER_MARK_PALETTE 배열 선언 = ${PS_match.length}곳 (기대 1 — SoT)`);
  // 🔴 문서 주석에 "#0072B2 5.19 · ..." 처럼 실측값 설명이 나올 수 있어 단순 hex 문자열 카운트는
  //   오탐(주석)을 만든다 — 배열 리터럴 형태(대괄호+따옴표 시작)로 한정해 실제 코드 중복만 잡는다.
  const arrLiteralOccurrences = (sSrc.match(/\[\s*"#0072B2",\s*"#5B2C87"/g) || []).length;
  ok(arrLiteralOccurrences === 1, `팔레트 배열 리터럴(코드) 등장 횟수 = ${arrLiteralOccurrences} (기대 1)`);

  const palette = ["#0072B2", "#5B2C87", "#1B4965", "#8B3A3A", "#2E5E4E", "#6B4226", "#264653"];
  const WHITE = "#ffffff";
  palette.forEach((hex) => {
    const r = contrast(hex, WHITE);
    ok(r >= 3, `⑫ [UI 3:1] 사용자색 ${hex} ↔ 흰 도면 #fff = ${r.toFixed(2)}:1`);
  });
}

/* ── 실행: 정상 소스 ─────────────────────────────────────────── */
suiteBandCore("①②③ 100 단위 대역 + 침범 방지 + 같은 대역 이어 쓰기 + 가득 (정상 소스)", seriesSrc, appSrc);
suitePersistence("④⑤ 영속화 + 타 사용자 저장 무간섭 (정상 소스)", seriesSrc, appSrc);
suiteDefault("⑥ 설정 없으면 기본 1 (정상 소스)", seriesSrc, appSrc);
suiteAxesUnchanged("⑦ 기존 3축 불변 (정상 소스)", seriesSrc);
suiteUserColor("⑧⑨⑩ 사용자 색 + 미등록에서도 노출 + filled 축 불변 (정상 소스)", seriesSrc);
suitePaletteSoT("⑪⑫ 팔레트 SoT + 대비 실측 (정상 소스)", seriesSrc);

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 A: [WO 20260930-numdup] nextSeriesNo 에 author 필터 복원 → ③·③-b 가 실패해야 함
 * ──────────────────────────────────────────────────────────── */
{
  // [WO 20261001-startno] nextInBand 에는 author 인자가 없다 — "내 핀만 봄" 을 Auth.user 비교로 주입한다.
  console.log("\n[뮤테이션A] author 필터(내 핀만 봄) 주입 → ③-b 가 실패해야 함");
  const needle = "        if (this.seriesOf(p) !== ser) return;\n        const n = parseInt(p.label, 10);";
  const mutated = seriesSrc.replace(needle, "        if (this.seriesOf(p) !== ser) return;\n        if (p.author && Auth.user && p.author !== Auth.user.email) return;\n        const n = parseInt(p.label, 10);");
  if (mutated === seriesSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const c2 = makeCtx(mutated, appSrc);
    c2.Auth.user = { email: "a@seastar.test" };
    c2.App._placeCheckboardPin({ x: 1, y: 1 });
    c2.App._placeCheckboardPin({ x: 2, y: 2 });
    c2.Auth.user = { email: "b@seastar.test" };
    c2.App._placeCheckboardPin({ x: 3, y: 3 });
    ok(c2.State.pins[2].label === "1",
      `뮤테이션 적용 시 ③-b 에서 A 의 1 과 중복(테스트 실효성 증명) → ${c2.State.pins[2].label} (기대 1)`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 A2: [WO 20261001-startno] 대역 범위 필터 제거(603f9b9 전원 최댓값 복귀) → ③ 이 실패해야 함
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션A2] 대역 범위 필터 제거(다른 대역 핀도 최댓값에 섞음) → ③ 이 실패해야 함");
  const needle = "if (Number.isFinite(n) && n >= r.lo && n <= r.hi && n > maxNo) maxNo = n;";
  const mutated = seriesSrc.replace(needle, "if (Number.isFinite(n) && n > maxNo) maxNo = n;");
  if (mutated === seriesSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const ctx = makeCtx(mutated, appSrc);
    ctx.Auth.user = { email: "a@seastar.test" };
    ctx.App._setCheckboardStart(1, 101);
    ctx.App._placeCheckboardPin({ x: 1, y: 1 });
    ctx.App._placeCheckboardPin({ x: 2, y: 2 });
    ctx.Auth.user = { email: "b@seastar.test" };
    ctx.App._setCheckboardStart(1, 201);
    ctx.App._placeCheckboardPin({ x: 3, y: 3 });
    ctx.Auth.user = { email: "a@seastar.test" };
    ctx.App._placeCheckboardPin({ x: 4, y: 4 });
    const p3 = ctx.State.pins[3];
    ok(!p3 || p3.label !== "103",
      `뮤테이션 적용 시 ③ 기대(103)와 달라짐(테스트 실효성 증명) → ${p3 ? p3.label : "핀 없음(B 대역 202 를 가득으로 오판)"}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 B: 대역 캐시 영속화(localStorage 저장) 제거 → ④가 실패해야 함
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션B] 대역 캐시 영속화 제거(저장 안 함) → ④가 실패해야 함");
  const needle = "this._lsSet(this.BAND_CACHE_PREFIX + this._scope(author), b);";
  const mutated = seriesSrc.replace(needle, '/* [뮤테이션] 영속화 제거 */');
  if (mutated === seriesSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const ctx1 = makeCtx(mutated, appSrc);
    ctx1.Auth.user = { email: "a@seastar.test" };
    ctx1.App._setCheckboardStart(1, 101);
    const ctx2 = makeCtx(mutated, appSrc, ctx1.store);
    ctx2.Auth.user = { email: "a@seastar.test" };
    ok(ctx2.App._checkboardStart(1) !== 101,
      `뮤테이션 적용 시 새 세션에서 대역이 사라짐(테스트 실효성 증명) → ${ctx2.App._checkboardStart(1)} (기대 101 아님)`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 C: 사용자별 저장을 단일 키(author 무시)로 바꿈 → ⑤가 실패해야 함
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션C] 사용자별 저장 키를 단일 키로 축소(author 무시) → ⑤가 실패해야 함");
  const needle = 'return pid + ":" + (author || "-");';
  const mutated = seriesSrc.replace(needle, 'return pid + ":-";');
  if (mutated === seriesSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const ctx = makeCtx(mutated, appSrc);
    ctx.Auth.user = { email: "a@seastar.test" };
    ctx.App._setCheckboardStart(1, 101);
    ctx.Auth.user = { email: "b@seastar.test" };
    ctx.App._setCheckboardStart(1, 201); // 단일 키이므로 A 값을 덮어씀
    ctx.Auth.user = { email: "a@seastar.test" };
    ok(ctx.App._checkboardStart(1) !== 101,
      `뮤테이션 적용 시 B 저장이 A 대역을 덮어씀(테스트 실효성 증명) → A 조회 = ${ctx.App._checkboardStart(1)} (기대 101 아님)`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 D: 사용자 색 파생(대역 인덱스) 제거 → ⑧이 실패해야 함
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션D] 대역→색 파생 제거(항상 팔레트[0]) → ⑧이 실패해야 함");
  const needle = "const color = this.USER_MARK_PALETTE[band % this.USER_MARK_PALETTE.length];";
  const mutated = seriesSrc.replace(needle, "const color = this.USER_MARK_PALETTE[0];");
  if (mutated === seriesSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const ctx = makeCtx(mutated, appSrc);
    const PS = ctx.PS;
    const b100 = PS.userMark({ checkboard: true, label: "100" }, 100);
    const b200 = PS.userMark({ checkboard: true, label: "200" }, 200);
    ok(b100.color === b200.color,
      `뮤테이션 적용 시 대역이 달라도 색이 같아짐(테스트 실효성 증명) → ${b100.color} == ${b200.color}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 E: 팔레트를 두 곳에 중복 정의 → ⑪이 실패해야 함
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션E] 팔레트 정의를 두 곳으로 쪼갬(SoT 위반) → ⑪이 실패해야 함");
  const mutated = seriesSrc + '\n  // [뮤테이션] 중복 정의\n  PinSeries.DUP_PALETTE = ["#0072B2", "#5B2C87"];\n';
  const arrLiteralOccurrences = (mutated.match(/\[\s*"#0072B2",\s*"#5B2C87"/g) || []).length;
  ok(arrLiteralOccurrences > 1,
    `뮤테이션 적용 시 팔레트 배열 리터럴이 두 곳 이상에 등장(테스트 실효성 증명) → ${arrLiteralOccurrences}곳 (기대 >1)`);
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
