/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p69-deck-lock-release.test.mjs)
 *
 * 원장 항목 AM — "_creatingDeck 영구 잠김으로 구역 생성이 전부 조용히 무시되는 버그" 재조사.
 *
 * 🔴 재현 결과: "영구" 잠김 자체는 이미 해결돼 있었다. WO 20260918 이 붙인 60초 상한
 * 타임아웃(20_App.js _pickDrawingFile 의 hardTimer)이 파일선택창이 응답하지 않는 경로까지
 * 이미 덮고 있고, 그 회귀는 tests/p43-reachability-and-silent-failures.test.mjs ⑥⑦에서
 * 이미 검증 중이다(31_Projects.js createDeck 의 try/finally 는 그대로).
 *
 * 남아 있던 진짜 결함: 31_Projects.js:119 의 연타 가드
 *   `if (this._creatingDeck) { return null; }`
 * 가 아무 안내 없이 조용히 무시했다 — 최대 60초의 "생성 진행 중" 창에서 사용자가 버튼을
 * 다시 누르면(또는 다른 진입경로가 겹쳐 호출하면) 아무 반응이 없어 "고장났다"로 보였다
 * (§5 조용한 실패가 최악). 이 파일은 그 가드에 토스트를 붙인 수정만 검증한다.
 *
 * 검사:
 *  ① 정상 완료 → _creatingDeck 해제(회귀 확인, p43⑦a 와 동형)
 *  ② 사용자 취소(_pickDrawingFile → null) → _creatingDeck 해제(회귀 확인, p43⑦b 와 동형)
 *  ③ 파일창이 영영 응답하지 않음(_pickDrawingFile 이 실제 20_App.js 소스 그대로, change/cancel/
 *     focus 신호 전혀 없음) → 60초 상한 뒤 resolve(null) + 사유 토스트 + _creatingDeck 해제
 *  ④ 잠긴 상태(_creatingDeck=true)에서 재호출 → null 반환 + "구역을 만드는 중입니다" 토스트
 *     (조용히 무시하지 않는다 — 이번에 고친 부분)
 *
 * 🔴 뮤테이션 2건:
 *  ⓐ 20_App.js 의 hardTimer(60000ms 상한) 블록을 제거 → ③이 300ms 레이스에서도 resolve 되지
 *     않아(영구 교착 재현) 실패해야 한다.
 *  ⓑ 31_Projects.js 의 재진입 토스트 문구를 제거 → ④가 실패해야 한다(조용한 실패 재현).
 *
 * 실제 모듈 소스(20_App.js _pickDrawingFile + 31_Projects.js createDeck)를 그대로 하나의 vm
 * 컨텍스트에 평가한다(실제 번들처럼 두 스크립트가 같은 전역 스코프를 공유 — 목 구현 아님).
 * 60초 실대기를 피하기 위해 setTimeout/clearTimeout 만 제어 가능한 가짜 시계로 주입한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const appSrc = rd("public/js/modules/20_App.js");
const projectsSrc = rd("public/js/modules/31_Projects.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 가짜 시계 — 60초 실대기 없이 setTimeout 체인을 수동으로 흘려보낸다 ── */
function makeFakeClock() {
  let now = 0;
  let seq = 1;
  const tasks = new Map();
  const fakeSetTimeout = (fn, ms) => {
    const id = seq++;
    tasks.set(id, { at: now + (ms || 0), fn });
    return id;
  };
  const fakeClearTimeout = (id) => { tasks.delete(id); };
  const advance = (ms) => {
    now += ms;
    let progressed = true;
    while (progressed) {
      progressed = false;
      const due = [...tasks.entries()].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at);
      for (const [id, t] of due) { tasks.delete(id); progressed = true; t.fn(); }
    }
  };
  return { fakeSetTimeout, fakeClearTimeout, advance };
}

/* ── 가짜 <input type=file> — change/cancel 이벤트를 수동으로 발화 가능 ── */
function makeFakeInput() {
  const listeners = {};
  return {
    type: "", accept: "", style: {}, files: null,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    click() {},
    remove() {},
    _fire(type) { (listeners[type] || []).slice().forEach((fn) => fn()); },
  };
}

/** appSrc(20_App.js) + projectsSrc(31_Projects.js) 를 실제 번들과 같은 방식(한 전역 스코프)으로
 *  같은 vm 컨텍스트에 평가해, Projects.createDeck() 이 실제 App._pickDrawingFile() 을 그대로 쓰게 한다. */
function makeSandbox({ online = true } = {}) {
  const clock = makeFakeClock();
  const toastCalls = [];
  const decksOnServer = [];
  const inputsCreated = [];
  const windowListeners = {};
  const el = () => ({
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, dataset: {}, textContent: "", click() {},
    innerHTML: "", addEventListener() {}, appendChild() {}, querySelector: () => el(),
    style: {},
  });
  const sandbox = {
    console,
    setTimeout: clock.fakeSetTimeout,
    clearTimeout: clock.fakeClearTimeout,
    alert: () => {},
    navigator: { onLine: online },
    document: {
      getElementById: () => null,
      createElement: () => { const inp = makeFakeInput(); inputsCreated.push(inp); return inp; },
      body: { appendChild() {} },
    },
    Auth: { headers: () => ({}), isDesigner: true },
    Prompt: { ask: async () => ({ value: "TEST ZONE" }), toast: (t) => toastCalls.push(String(t)) },
    UI: { renderTree() {} },
    State: { mode: "designer" },
    fetch: async (url, opt) => {
      const method = (opt && opt.method) || "GET";
      if (method === "POST" && /\/decks$/.test(url)) {
        const d = { id: "deck_" + (decksOnServer.length + 1), name: "TEST ZONE", project_id: "p1" };
        decksOnServer.push(d);
        return { ok: true, json: async () => d };
      }
      if (method === "GET" && /\/decks$/.test(url)) return { ok: true, json: async () => ({ data: decksOnServer.slice() }) };
      return { ok: true, json: async () => ({}) };
    },
  };
  sandbox.window = {
    addEventListener(type, fn) { (windowListeners[type] = windowListeners[type] || []).push(fn); },
    removeEventListener(type, fn) { if (windowListeners[type]) windowListeners[type] = windowListeners[type].filter((f) => f !== fn); },
  };
  vm.createContext(sandbox);
  // 실제 번들 순서와 동일: App 정의 뒤 Projects 정의 → 같은 전역 렉시컬 스코프 공유.
  vm.runInContext(appSrc + "\n;globalThis.__App = App;", sandbox);
  vm.runInContext(projectsSrc + "\n;globalThis.__Projects = Projects;", sandbox);
  const App = sandbox.__App;
  const P = sandbox.__Projects;
  P.currentProject = { id: "p1", name: "P1" };
  return { App, P, toastCalls, inputsCreated, clock };
}

/* ① 정상 완료 → 해제 ─────────────────────────────────────────── */
{
  const { P, inputsCreated } = makeSandbox();
  const p = P.createDeck({ name: "Z1", source: "upload" });
  await Promise.resolve(); await Promise.resolve(); // _pickDrawingFile 의 executor·click 까지 흘려보냄
  const inp = inputsCreated[inputsCreated.length - 1];
  inp.files = [{ name: "a.pdf" }];
  inp._fire("change");
  await p;
  ok(P._creatingDeck === false, "① 정상 완료 후 _creatingDeck 해제됨");
}

/* ② 사용자 취소 → 해제 ───────────────────────────────────────── */
{
  const { P, inputsCreated } = makeSandbox();
  const p = P.createDeck({ name: "Z2", source: "upload" });
  await Promise.resolve(); await Promise.resolve();
  const inp = inputsCreated[inputsCreated.length - 1];
  inp._fire("cancel");
  const r = await p;
  ok(r === null, "② 취소 시 createDeck() 이 null 반환");
  ok(P._creatingDeck === false, "② 취소 후 _creatingDeck 해제됨");
}

/* ③ 파일창 무응답 → 60초 상한 뒤 해제 + 사유 토스트 ─────────────── */
{
  const { P, toastCalls, clock } = makeSandbox();
  const p = P.createDeck({ name: "Z3", source: "upload" });
  await Promise.resolve(); await Promise.resolve();
  // change/cancel/focus 신호를 전혀 주지 않는다 — 60초 하드타이머만 신뢰.
  clock.advance(60000);
  const r = await p;
  ok(r === null, "③ 무응답 60초 후 createDeck() 이 null 반환");
  ok(P._creatingDeck === false, "③ 무응답 60초 후 _creatingDeck 해제됨");
  ok(toastCalls.some((t) => /응답이 없어/.test(t)), "③ 사유 토스트 발생 → " + JSON.stringify(toastCalls));
}

/* ④ 잠긴 상태에서 재호출 → 조용히 무시하지 않는다 ────────────────── */
{
  const { P, toastCalls } = makeSandbox();
  P._creatingDeck = true; // 진행 중 상태를 직접 재현
  const r = await P.createDeck({ name: "Z4", source: "upload" });
  ok(r === null, "④ 잠긴 상태 재호출은 null 반환(중복 생성 차단, 회귀)");
  ok(toastCalls.some((t) => /만드는 중/.test(t)), "④ 재호출 시 안내 토스트 발생(조용한 실패 0) → " + JSON.stringify(toastCalls));
}

/* ══ 뮤테이션 ⓐ — 60초 상한 타이머 제거 → ③이 실패해야 한다(영구 교착 재현) ══ */
{
  const needle = `        hardTimer = setTimeout(() => {
          if (settled) return;
          Prompt && Prompt.toast && Prompt.toast("파일 선택 창 응답이 없어 취소로 처리했습니다. 다시 시도해주세요.");
          finish(null);
        }, 60000);`;
  const mutated = appSrc.split(needle).join("        /* hardTimer 제거됨 */");
  if (mutated === appSrc) { console.log("  FAIL 뮤테이션ⓐ 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    console.log("\n[뮤테이션ⓐ] hardTimer(60초 상한)를 제거하면 ③이 실패해야 함(영구 교착 재현)");
    const clock = makeFakeClock();
    const windowListeners = {};
    const inputsCreated = [];
    const sandbox = {
      console, setTimeout: clock.fakeSetTimeout, clearTimeout: clock.fakeClearTimeout,
      navigator: { onLine: true },
      document: { getElementById: () => null, createElement: () => { const i = makeFakeInput(); inputsCreated.push(i); return i; }, body: { appendChild() {} } },
      Auth: { headers: () => ({}), isDesigner: true },
      Prompt: { ask: async () => ({ value: "X" }), toast: () => {} },
      UI: { renderTree() {} }, State: { mode: "designer" },
      fetch: async () => ({ ok: true, json: async () => ({}) }),
    };
    sandbox.window = {
      addEventListener(type, fn) { (windowListeners[type] = windowListeners[type] || []).push(fn); },
      removeEventListener() {},
    };
    vm.createContext(sandbox);
    vm.runInContext(mutated + "\n;globalThis.__App = App;", sandbox);
    vm.runInContext(projectsSrc + "\n;globalThis.__Projects = Projects;", sandbox);
    const P = sandbox.__Projects;
    P.currentProject = { id: "p1" };
    const raced = await Promise.race([
      (async () => { await P.createDeck({ name: "M", source: "upload" }); return "resolved"; })(),
      new Promise((r) => setTimeout(() => r("timeout"), 300)),
    ]);
    ok(raced === "timeout", "뮤테이션ⓐ 적용 시 300ms 안에도 resolve 되지 않음(상한 제거로 영구 교착) → " + raced);
  }
}

/* ══ 뮤테이션ⓑ — 재진입 안내 토스트 제거 → ④가 실패해야 한다(조용한 실패 재현) ══ */
{
  const needle = 'if (this._creatingDeck) { Prompt.toast && Prompt.toast("구역을 만드는 중입니다 — 잠시 후 다시 시도하세요"); return null; }';
  const mutated = projectsSrc.split(needle).join('if (this._creatingDeck) { return null; }');
  if (mutated === projectsSrc) { console.log("  FAIL 뮤테이션ⓑ 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    console.log("\n[뮤테이션ⓑ] 재진입 안내 토스트를 제거하면 ④가 실패해야 함(조용한 실패 재현)");
    const clock = makeFakeClock();
    const inputsCreated = [];
    const toastCallsM2 = [];
    const sandbox2 = {
      console, setTimeout: clock.fakeSetTimeout, clearTimeout: clock.fakeClearTimeout,
      navigator: { onLine: true },
      document: { getElementById: () => null, createElement: () => { const i = makeFakeInput(); inputsCreated.push(i); return i; }, body: { appendChild() {} } },
      Auth: { headers: () => ({}), isDesigner: true },
      Prompt: { ask: async () => ({ value: "X" }), toast: (t) => toastCallsM2.push(String(t)) },
      UI: { renderTree() {} }, State: { mode: "designer" },
      fetch: async () => ({ ok: true, json: async () => ({}) }),
    };
    sandbox2.window = { addEventListener() {}, removeEventListener() {} };
    vm.createContext(sandbox2);
    vm.runInContext(appSrc + "\n;globalThis.__App = App;", sandbox2);
    vm.runInContext(mutated + "\n;globalThis.__Projects = Projects;", sandbox2);
    const P2 = sandbox2.__Projects;
    P2.currentProject = { id: "p1" };
    P2._creatingDeck = true;
    const r = await P2.createDeck({ name: "M2", source: "upload" });
    ok(r === null, "뮤테이션ⓑ 적용 후에도 null 반환은 유지(가드 자체는 살아있음)");
    const stillHasToast = toastCallsM2.some((t) => /만드는 중/.test(t));
    ok(stillHasToast === false, "뮤테이션ⓑ 적용 시 재호출 안내 토스트가 사라짐(조용한 실패 재현) → " + JSON.stringify(toastCallsM2));
  }
}

console.log(failed === 0 ? "\n전체 PASS" : `\n${failed}건 FAIL`);
process.exit(failed === 0 ? 0 : 1);
