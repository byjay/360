/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p76-no-native-confirm.test.mjs)
 *
 * 마스터 원문(2회 지적): "포인트 삭제도 안됨" / "삭제도 안되네 핀이 삭제안돼"
 *
 * 근본원인: window.confirm()/confirm() 은 PWA 독립실행모드(display:standalone, iOS/WebKit 등)에서
 *   창 없이 즉시 false 를 반환한다(30_Prompt.js:92-97 주석, p59 에서 배포 버튼으로 이미 실증됨).
 *   그런데 같은 문제가 있던 17개 호출부 중 배포 버튼(12_ProjectHub.js togglePublish) 1곳만 고쳐지고
 *   포인트 삭제(20_App.js deletePin) 등 나머지 16곳은 방치돼 있었다 — 이번 WO 로 전부 교체.
 *
 * 검사:
 *  Part A(정적) — public/js/modules/*.js 전체(30_Prompt.js 정의 파일 제외)에서 네이티브
 *    confirm()/window.confirm() 호출이 0건. 주석 전용 줄(// , /* , * 로 시작)은 스캔에서 제외해
 *    "주석 안에서 confirm() 을 언급"하는 것을 오탐으로 잡지 않는다.
 *  Part B(실 소스 vm 실행, 20_App.js + 00_header.js._revokeVideoBlob 그대로 로드) —
 *    App.deletePin() ① Prompt.confirm→true 면 삭제+autoSave ② false 면 유지 ③ 네이티브 confirm 을
 *    "항상 false" 로 막아 둔 PWA 재현 환경에서도 Prompt 경로로 정상 삭제된다(native confirm 미사용 증명)
 *  뮤테이션 ⓐ deletePin 을 confirm() 으로 되돌리면 Part A 가 실패 + PWA 재현 환경에서 삭제가 막힘(Part B③ 회귀)
 *  뮤테이션 ⓑ 17곳 중 1곳(13_Notes.js)을 되돌리면 Part A 가 실패
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOD_DIR = path.join(ROOT, "public/js/modules");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };

/* ══════════════════════════════════════════════════════════════════
 * 공통 — 주석 전용 줄을 제거한 뒤 네이티브 confirm() 호출 패턴을 찾는다
 * ══════════════════════════════════════════════════════════════════ */
function stripCommentLines(src) {
  return src.split("\n").map((l) => {
    const t = l.trim();
    if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) return "";
    return l;
  }).join("\n");
}
const NATIVE_CONFIRM_RE = /(^|[^.\w])confirm\(|window\.confirm\(/gm;
function nativeConfirmMatches(src) {
  return stripCommentLines(src).match(NATIVE_CONFIRM_RE) || [];
}

/* ══════════════════════════════════════════════════════════════════
 * Part A — 정적 스캔: public/js/modules/*.js 전체(30_Prompt.js 제외)
 * ══════════════════════════════════════════════════════════════════ */
console.log("[Part A · 정적 스캔 — 네이티브 confirm() 0건]");
const allModuleFiles = fs.readdirSync(MOD_DIR).filter((f) => f.endsWith(".js") && f !== "30_Prompt.js");
ok(allModuleFiles.length >= 30, "사전조건 — 스캔 대상 모듈 파일을 찾았다(실제 " + allModuleFiles.length + "개)");
{
  const offenders = [];
  for (const f of allModuleFiles) {
    const src = rd("public/js/modules/" + f);
    const m = nativeConfirmMatches(src);
    if (m.length) offenders.push(f + " (" + m.length + "건)");
  }
  ok(offenders.length === 0, offenders.length === 0
    ? "30_Prompt.js 를 제외한 모든 모듈에서 네이티브 confirm()/window.confirm() 호출이 0건"
    : "다음 파일에 네이티브 confirm() 이 남아있다 → " + offenders.join(", "));
}

/* ══════════════════════════════════════════════════════════════════
 * Part B — 실 소스 vm 실행: App.deletePin() 동작 검증
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[Part B · 실 소스(vm) — App.deletePin()]");

// 00_header.js 는 전체 번들 공용 IIFE 의 시작부라 단독 로드 불가 — deletePin 이 참조하는
// _revokeVideoBlob 함수 정의만 실제 소스에서 그대로 잘라내 사용한다(로직 변경 없음, 발췌만).
const headerSrc = rd("public/js/modules/00_header.js");
const revokeFnMatch = headerSrc.match(/function _revokeVideoBlob\([\s\S]*?\n  \}/);
if (!revokeFnMatch) { console.log("  FAIL 사전조건 — 00_header.js 에서 _revokeVideoBlob 정의를 찾지 못함(소스 변경?)"); failed++; }
const revokeFnSrc = revokeFnMatch ? revokeFnMatch[0] : "function _revokeVideoBlob(){}";
const appSrc = rd("public/js/modules/20_App.js");
ok(/async deletePin\(id\) \{/.test(appSrc), "사전조건 — deletePin() 이 async 로 전환되어 있다");

function makeSandbox(appSource, { promptConfirmValue = true, nativeConfirmAlwaysFalse = true } = {}) {
  const pins = [{ id: "pinX", label: "테스트포인트", x: 10, y: 10, page: 1 }];
  const State = { pins, activePin: null, editingPinId: null };
  const uiCalls = { renderPinList: 0, renderPinsOnMap: 0 };
  const toastCalls = [];
  let autoSaveCalls = 0;
  let nativeConfirmCalls = 0;
  const sandbox = {
    console, JSON, Map, Set, Array, Date, Math, String,
    State,
    URL: { revokeObjectURL() {} },
    navigator: { onLine: true },
    // PWA 재현 — 네이티브 confirm() 은 항상 무음 false (호출되면 카운트만 증가)
    confirm: () => { nativeConfirmCalls++; return nativeConfirmAlwaysFalse ? false : true; },
    Prompt: {
      confirm: async () => promptConfirmValue,
      toast: (t) => toastCalls.push(t),
    },
    UI: {
      renderPinList() { uiCalls.renderPinList++; },
      renderPinsOnMap() { uiCalls.renderPinsOnMap++; },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    revokeFnSrc + "\n" + appSource + "\nglobalThis.__App = App;",
    sandbox
  );
  const App = sandbox.__App;
  // _autoSave 는 서버 저장·로컬 초안 저장 등 무거운 경로라 스파이로 대체(deletePin 이
  // this._autoSave() 를 "호출했는지"만 검증 대상 — 저장 로직 자체는 다른 테스트의 책임).
  App._autoSave = () => { autoSaveCalls++; };
  return { App, State, toastCalls, uiCalls, getAutoSaveCalls: () => autoSaveCalls, getNativeConfirmCalls: () => nativeConfirmCalls };
}

// ① Prompt.confirm → true 면 삭제 + autoSave 호출
{
  const { App, State, toastCalls, getAutoSaveCalls } = makeSandbox(appSrc, { promptConfirmValue: true });
  const result = await App.deletePin("pinX");
  ok(result === true, "① deletePin() 이 true 를 반환한다(삭제 성공 신호)");
  ok(State.pins.length === 0, "① Prompt.confirm→true 면 State.pins 에서 제거됨");
  ok(getAutoSaveCalls() === 1, "① 삭제 후 autoSave 가 호출됨");
  ok(toastCalls.some((t) => /삭제됨/.test(t)), "① 삭제 완료 토스트가 뜬다 → " + JSON.stringify(toastCalls));
}

// ② Prompt.confirm → false 면 그대로(취소)
{
  const { App, State, getAutoSaveCalls } = makeSandbox(appSrc, { promptConfirmValue: false });
  const result = await App.deletePin("pinX");
  ok(result === false, "② deletePin() 이 false 를 반환한다(취소 신호)");
  ok(State.pins.length === 1, "② Prompt.confirm→false 면 핀이 그대로 남는다");
  ok(getAutoSaveCalls() === 0, "② 취소 시 autoSave 가 호출되지 않는다");
}

// ③ PWA 재현 — 네이티브 confirm() 이 항상 무음 false 인 환경에서도 Prompt 경로로 정상 삭제
{
  const { App, State, getAutoSaveCalls, getNativeConfirmCalls } = makeSandbox(appSrc, {
    promptConfirmValue: true, nativeConfirmAlwaysFalse: true,
  });
  const result = await App.deletePin("pinX");
  ok(result === true && State.pins.length === 0, "③ PWA 재현(네이티브 confirm 무음 false) 환경에서도 Prompt.confirm 경로로 정상 삭제됨");
  ok(getNativeConfirmCalls() === 0, "③ 네이티브 confirm() 이 단 한 번도 호출되지 않았다(전적으로 Prompt.confirm 경로)");
  ok(getAutoSaveCalls() === 1, "③ 삭제 후 autoSave 도 정상 호출됨");
}

/* ══════════════════════════════════════════════════════════════════
 * 뮤테이션 ⓐ — deletePin() 을 confirm() 으로 되돌리면
 *   Part A 가 실패 + PWA 재현 환경(③)에서 삭제가 막혀야 함
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션ⓐ] deletePin() 의 Prompt.confirm() 을 네이티브 confirm() 으로 되돌리면 실패해야 함");
{
  const needle = 'if (!await Prompt.confirm("포인트 삭제", `\'${removed.label}\' 포인트를 삭제할까요?\\n(첨부된 사진·노트·문서 정보도 함께 제거됩니다)`)) return false;';
  const mutated = appSrc.replace(needle, 'if (!confirm(`\'${removed.label}\' 포인트를 삭제할까요?\\n(첨부된 사진·노트·문서 정보도 함께 제거됩니다)`)) return false;');
  if (mutated === appSrc) { console.log("  FAIL 뮤테이션ⓐ 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const offendersM = nativeConfirmMatches(mutated);
    ok(offendersM.length > 0, "뮤테이션ⓐ 적용 시 Part A 정적 스캔이 네이티브 confirm() 을 다시 잡아낸다(" + offendersM.length + "건)");

    const { App, State, getNativeConfirmCalls } = makeSandbox(mutated, { promptConfirmValue: true, nativeConfirmAlwaysFalse: true });
    const result = await App.deletePin("pinX");
    ok(result !== true, "뮤테이션ⓐ 적용 시 PWA 재현 환경(네이티브 confirm 무음 false)에서 삭제가 조용히 막힌다(③이 깨짐을 확인) → result=" + result);
    ok(State.pins.length === 1, "뮤테이션ⓐ 적용 시 핀이 삭제되지 않고 남는다(마스터가 보고한 '삭제 안 됨' 증상 재현)");
    ok(getNativeConfirmCalls() === 1, "뮤테이션ⓐ 적용 시 네이티브 confirm() 이 실제로 호출된다(무음 false 경로를 탐)");
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 뮤테이션 ⓑ — 17곳 중 1곳(13_Notes.js remove())을 되돌리면 Part A 가 실패
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션ⓑ] 13_Notes.js remove() 를 네이티브 confirm() 으로 되돌리면 Part A 가 실패해야 함");
{
  const notesSrc = rd("public/js/modules/13_Notes.js");
  const needle = 'if (!await Prompt.confirm("노트 삭제", "이 이슈/노트를 삭제할까요?")) return;';
  const mutated = notesSrc.replace(needle, 'if (!confirm("이 이슈/노트를 삭제할까요?")) return;');
  if (mutated === notesSrc) { console.log("  FAIL 뮤테이션ⓑ 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const offendersM = nativeConfirmMatches(mutated);
    ok(offendersM.length > 0, "뮤테이션ⓑ 적용 시 13_Notes.js 에서 네이티브 confirm() 이 다시 잡힌다(" + offendersM.length + "건, Part A 회귀 확인)");
  }
}

console.log(failed === 0 ? "\n[ALL PASS]" : "\n[" + failed + " FAILED]");
process.exit(failed === 0 ? 0 : 1);
