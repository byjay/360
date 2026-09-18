/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p44-checkboard-renumber.test.mjs)
 *
 * 발주서(WO 20260918, 마스터 원문): "버튼을 클릭하면 시작번호를 세팅하고, 전체를
 * (예: 1~40개면) 101부터 변경 가능하게 한 번에 다 가능하고, 한 개씩 변경 가능하게도 해"
 *
 *  ⑫ 40개(1~40) + 시작 101 → 101~140, 순서 보존
 *  ⑬ 일괄 변경 후 중복 0
 *  ⑭ 중복이 생기는 입력은 적용 거부 + 사용자 알림
 *  ⑮ 개별 변경이 동작하고, 사용된 번호로는 거부
 *  ⑯ 번호가 바뀌어도 사진·노트 연결이 유지된다(핀 id 불변)
 *  ⑰ 자동 재채번 경로가 존재하지 않는다(사용자 조작 없이는 번호가 안 바뀐다)
 *  ⑱ 오프라인에서 일괄 변경 → OpLog 에 기록
 *
 * 실제 모듈 소스(01b_PinSeries.js/20_App.js/27_PinActionPop.js)를 그대로 vm 에 평가한다
 * (목 구현 아님). ⑫⑬⑭⑯ 에 뮤테이션 케이스가 붙는다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const seriesSrc = rd("public/js/modules/01b_PinSeries.js");
const appSrc = rd("public/js/modules/20_App.js");
const papSrc = rd("public/js/modules/27_PinActionPop.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

function loadSeries(source) {
  const sandbox = { console, JSON, Object, Array, Map, Set, Math, Number, String, Date, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
  vm.createContext(sandbox);
  vm.runInContext(source + "\n;globalThis.__PS = PinSeries;", sandbox);
  return sandbox.__PS;
}

/* ══ ⑫ 40개(1~40) + 시작 101 → 101~140, 순서 보존(+ 뮤테이션ⓑ 순서보존 제거) ══ */
{
  const PS = loadSeries(seriesSrc);
  // 삽입 순서를 일부러 뒤섞어 "현재 번호 순서"(정렬)를 실제로 타는지 증명한다(1~40 각 1회).
  const nums = Array.from({ length: 40 }, (_, i) => i + 1);
  const shuffled = nums.slice(20).concat(nums.slice(0, 20).reverse()); // [21..40, 20,19,...,1]
  const pins = shuffled.map((n) => ({ id: "p" + n, page: 1, checkboard: true, label: String(n) }));
  const res = PS.renumberCheckboardRange(pins, 1, 101);
  ok(res.ok === true, "⑫ 40개 재채번 요청이 승인됨 → " + JSON.stringify(res.reason || "ok"));
  ok(res.changes.length === 40, "⑫ 변경 대상 40건, 실제 " + res.changes.length);
  const byOld = new Map(res.changes.map((c) => [parseInt(c.oldLabel, 10), c.newLabel]));
  ok(byOld.get(1) === "101" && byOld.get(40) === "140" && byOld.get(20) === "120",
    "⑫ 순서 보존 — 1→101, 20→120, 40→140 → " + JSON.stringify([byOld.get(1), byOld.get(20), byOld.get(40)]));
  const labels = res.changes.map((c) => parseInt(c.newLabel, 10));
  ok(labels.join(",") === Array.from({ length: 40 }, (_, i) => 101 + i).join(","),
    "⑫ 연속 101~140, 뒤섞이지 않음");

  console.log("\n[뮤테이션ⓑ] 정렬(순서 보존)을 제거하면 ⑫가 실패해야 함");
  const needleB = `      targets.sort((a, b) => {
        const ai = map.get(a.id), bi = map.get(b.id);
        return (ai ? ai.no : 0) - (bi ? bi.no : 0);
      });`;
  const mutatedB = seriesSrc.replace(needleB, "      /* 정렬 제거됨 */");
  if (mutatedB === seriesSrc) { console.log("  FAIL 뮤테이션ⓑ 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const PSm = loadSeries(mutatedB);
    const resM = PSm.renumberCheckboardRange(pins.map((p) => ({ ...p })), 1, 101);
    const byOldM = new Map(resM.changes.map((c) => [parseInt(c.oldLabel, 10), c.newLabel]));
    ok(!(byOldM.get(1) === "101" && byOldM.get(40) === "140"),
      "뮤테이션ⓑ 적용 시 삽입순서 그대로 처리돼 순서가 뒤섞임(⑫가 깨짐) → 1→" + byOldM.get(1) + ", 40→" + byOldM.get(40));
  }
}

/* ══ ⑬ 일괄 변경 후 중복 0(+ 뮤테이션ⓐ 중복 검사 제거) ══════════════════ */
{
  const PS = loadSeries(seriesSrc);
  const pins = Array.from({ length: 10 }, (_, i) => ({ id: "q" + i, page: 1, checkboard: true, label: String(i + 1) }));
  const res = PS.renumberCheckboardRange(pins, 1, 500);
  const applied = pins.map((p) => { const c = res.changes.find((x) => x.id === p.id); return c ? { ...p, label: c.newLabel } : p; });
  const dup = PS.duplicateCheckboardIds(applied, 1);
  ok(dup.size === 0, "⑬ 일괄 변경 적용 후 중복 0건, 실제 " + dup.size);

  console.log("\n[뮤테이션ⓐ] 중복 검사(newLabelSet.size !== changes.length)를 제거하면 ⑬⑭가 실패해야 함");
  const needleA = `      const newLabelSet = new Set(changes.map((c) => c.newLabel));
      if (newLabelSet.size !== changes.length) return { ok: false, changes: [], reason: "변경 결과에 번호 중복이 발생합니다 — 적용하지 않았습니다" };
      const targetIdSet = new Set(targets.map((p) => p.id));
      const collide = (pins || []).some((p) => p && (p.page || 1) === pg && p.checkboard && !targetIdSet.has(p.id) && newLabelSet.has(String(p.label)));
      if (collide) return { ok: false, changes: [], reason: "기존 다른 체크보드 핀과 번호가 겹칩니다 — 적용하지 않았습니다" };`;
  const mutatedA = seriesSrc.replace(needleA, `      const newLabelSet = new Set(changes.map((c) => c.newLabel));`);
  if (mutatedA === seriesSrc) { console.log("  FAIL 뮤테이션ⓐ 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const PSm = loadSeries(mutatedA);
    // ⑭용 시나리오: 부분 대상(targetIds)만 101~102 로 옮기려는데, 대상 밖 핀이 이미 101/102 를 쓰고 있어 충돌.
    const pinsCollide = [
      { id: "keepA", page: 1, checkboard: true, label: "101" },
      { id: "keepB", page: 1, checkboard: true, label: "102" },
      { id: "moveA", page: 1, checkboard: true, label: "1" },
      { id: "moveB", page: 1, checkboard: true, label: "2" }
    ];
    const resM = PSm.renumberCheckboardRange(pinsCollide, 1, 101, ["moveA", "moveB"]);
    ok(resM.ok === true, "뮤테이션ⓐ 적용 시 충돌 검사가 사라져 위험한 변경이 승인됨(⑭가 깨짐, 실제 ok=" + resM.ok + ")");
  }
}

/* ══ ⑭ 중복이 생기는 입력은 적용 거부 + 사용자 알림(현재 코드 기준) ══════════ */
{
  const PS = loadSeries(seriesSrc);
  const pinsCollide = [
    { id: "keepA", page: 1, checkboard: true, label: "101" },
    { id: "keepB", page: 1, checkboard: true, label: "102" },
    { id: "moveA", page: 1, checkboard: true, label: "1" },
    { id: "moveB", page: 1, checkboard: true, label: "2" }
  ];
  const res = PS.renumberCheckboardRange(pinsCollide, 1, 101, ["moveA", "moveB"]);
  ok(res.ok === false && /겹칩니다/.test(res.reason || ""),
    "⑭ 대상 밖 핀과 겹치는 변경은 거부 + 이유 제공 → " + JSON.stringify(res));
}

/* ══ ⑮ App._renumberCheckboard() 통합 — 개별 변경 동작 + 사용된 번호 거부 ══════ */
function makeAppSandbox(pins, { online = true, promptValue = "101", confirmYes = true } = {}) {
  const toastCalls = [];
  const State = { pins, pdfPage: 1, mode: "designer" };
  const UI = { $: () => null, renderPinsOnMap() {}, renderPinList() {} };
  const logCalls = [];
  const opLogCalls = [];
  const sandbox = {
    console, JSON, Map, Set, Date, Array,
    navigator: { onLine: online },
    confirm: () => confirmYes,
    State, UI,
    Prompt: { ask: async () => (promptValue == null ? null : { value: promptValue }), toast: (t) => toastCalls.push(t) },
    Log: { push: (...a) => logCalls.push(a) },
    OpLog: { recordCurrent: (...a) => { opLogCalls.push(a); } }
  };
  vm.createContext(sandbox);
  vm.runInContext(seriesSrc + "\n" + appSrc + "\n;globalThis.__App = App; globalThis.__PS = PinSeries;", sandbox);
  return { App: sandbox.__App, PS: sandbox.__PS, State, toastCalls, logCalls, opLogCalls };
}
{
  // 개별 변경: PinSeries.validateCheckboardLabel 을 직접 재사용해 27_PinActionPop._saveLabel() 과 동일 검증
  const PS = loadSeries(seriesSrc);
  const pins = [
    { id: "a", page: 1, checkboard: true, label: "1" },
    { id: "b", page: 1, checkboard: true, label: "2" }
  ];
  const okRes = PS.validateCheckboardLabel(pins, 1, "a", "5");
  ok(okRes.ok === true && okRes.newLabel === "5", "⑮a 개별 변경 — 미사용 번호는 승인 → " + JSON.stringify(okRes));
  const dupRes = PS.validateCheckboardLabel(pins, 1, "a", "2");
  ok(dupRes.ok === false && /이미 사용 중/.test(dupRes.reason), "⑮b 개별 변경 — 이미 쓰는 번호(2)는 거부 + 이유 → " + JSON.stringify(dupRes));

  // 27_PinActionPop.js 실제 코드가 이 검증을 통과 못 하면 저장을 중단하는지 정적 확인
  ok(/validateCheckboardLabel/.test(papSrc), "⑮c 27_PinActionPop.js 가 validateCheckboardLabel 을 호출한다(정적 확인)");
}

/* ══ ⑯ 번호가 바뀌어도 사진·노트 연결(핀 id) 이 유지된다(+ 뮤테이션ⓒ id 를 번호로 대체) ══ */
{
  const pins = [
    { id: "PIN_WITH_PHOTO", page: 1, checkboard: true, label: "1", imageId: "img-abc" },
    { id: "PIN_PLAIN", page: 1, checkboard: true, label: "2" }
  ];
  const { App, State } = makeAppSandbox(pins, { promptValue: "101" });
  await App._renumberCheckboard();
  const photoPin = State.pins.find((p) => p.imageId === "img-abc");
  ok(!!photoPin && photoPin.id === "PIN_WITH_PHOTO", "⑯ 사진이 연결된 핀의 id 는 재채번 후에도 불변 → " + (photoPin && photoPin.id));
  ok(photoPin && (photoPin.label === "101" || photoPin.label === "102"), "⑯ 번호(label)만 바뀜 → " + (photoPin && photoPin.label));

  console.log("\n[뮤테이션ⓒ] pin.label 대신 pin.id 를 새 번호로 바꾸면 ⑯이 실패해야 함(치명적 연결 끊김 재현)");
  const needleC = "        pin.label = c.newLabel;";
  const mutatedC = appSrc.replace(needleC, "        pin.id = c.newLabel; pin.label = c.newLabel;");
  if (mutatedC === appSrc) { console.log("  FAIL 뮤테이션ⓒ 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const pins2 = [{ id: "PIN_WITH_PHOTO", page: 1, checkboard: true, label: "1", imageId: "img-abc" }];
    const State2 = { pins: pins2, pdfPage: 1, mode: "designer" };
    const sandboxM = {
      console, JSON, Map, Set, Date, Array,
      navigator: { onLine: true }, confirm: () => true,
      State: State2, UI: { $: () => null, renderPinsOnMap() {}, renderPinList() {} },
      Prompt: { ask: async () => ({ value: "101" }), toast: () => {} },
      Log: { push() {} }, OpLog: { recordCurrent() {} }
    };
    vm.createContext(sandboxM);
    vm.runInContext(seriesSrc + "\n" + mutatedC + "\n;globalThis.__App = App;", sandboxM);
    await sandboxM.__App._renumberCheckboard();
    const stillLinked = State2.pins.find((p) => p.id === "PIN_WITH_PHOTO" && p.imageId === "img-abc");
    ok(!stillLinked, "뮤테이션ⓒ 적용 시 원래 id(PIN_WITH_PHOTO)가 사라져 사진 연결이 끊김(⑯이 깨짐 재현) → 남은 id=" + JSON.stringify(State2.pins.map((p) => p.id)));
  }
}

/* ══ ⑰ 자동 재채번 경로가 존재하지 않는다(사용자 조작 없이는 번호가 안 바뀐다) ══════ */
{
  // App._renumberCheckboard 를 제외한 20_App.js 전역에서 자동(비-사용자-트리거) 호출부가 있는지
  // 정적으로 확인 — 호출은 _renumberCheckboard() 메서드 본문 안에서만 있어야 하고, 그 메서드는
  // 오직 버튼 클릭 리스너(_bindSidebar)에서만 호출돼야 한다.
  const callSites = (appSrc.match(/PinSeries\.renumberCheckboardRange\(State\.pins/g) || []).length;
  ok(callSites === 1, "⑰ PinSeries.renumberCheckboardRange() 실 호출부가 20_App.js 에 정확히 1곳(App._renumberCheckboard 본문)뿐(주석 언급 제외) → 실제 " + callSites + "곳");
  const bindCallSites = (appSrc.match(/this\._renumberCheckboard\(\)/g) || []).length;
  ok(bindCallSites === 1, "⑰ App._renumberCheckboard() 호출부가 20_App.js 에 정확히 1곳(버튼 클릭 리스너)뿐 → 실제 " + bindCallSites + "곳");
}

/* ══ ⑱ 오프라인에서 일괄 변경 → OpLog 기록 ══════════════════════════════ */
{
  const pins = [
    { id: "o1", page: 1, checkboard: true, label: "1" },
    { id: "o2", page: 1, checkboard: true, label: "2" }
  ];
  const { App, opLogCalls, toastCalls } = makeAppSandbox(pins, { online: false, promptValue: "101" });
  await App._renumberCheckboard();
  ok(opLogCalls.length === 2, "⑱ 오프라인에서 재채번 시 변경된 핀 수만큼 OpLog.recordCurrent 호출 → " + opLogCalls.length);
  ok(opLogCalls.every((a) => a[0] === "pin" && a[1] === "upsert"), "⑱ OpLog 기록이 기존 pin/upsert 경로를 그대로 재사용 → " + JSON.stringify(opLogCalls.map((a) => [a[0], a[1]])));
  ok(toastCalls.some((t) => /오프라인/.test(t)), "⑱ 오프라인 완료 안내에도 그 사실이 드러남 → " + JSON.stringify(toastCalls));
}

console.log(failed === 0 ? "\n[ALL PASS]" : "\n[" + failed + " FAILED]");
process.exit(failed === 0 ? 0 : 1);
