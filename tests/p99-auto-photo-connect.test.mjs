/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p99-auto-photo-connect.test.mjs)
 *
 * 대상: WO 20261001-autophoto2 — 마스터 재지시("클릭하고 포인트가 생기면 바로 사진을 등록하게
 * 해야지" / "모바일에서는 360 모드에서는 해당 경로의 사진이 가장 근래에 생성된 걸 추천 등록하라").
 * 라이브 재현(지휘자 b8cd1f2a, 2026-10-01): ±10분 허용오차 기반 자동매칭(WO 20260930-autophoto,
 * 구 p99)이 실사용 핀 8개 전부 미연결로 FAIL. 설계가 바뀌어 **이 테스트의 기대값도 바뀐다**
 * (G-4⑧ — 약화가 아니라 마스터 지시로 동작 자체가 바뀜. 전·후 대조는 WO 발주서 참조).
 *
 * 전(구 p99, 23c0680) → 후(이 파일) 핵심 차이:
 *  - 전: 두 번째 핀은 세션에 후보가 남아 있으면 선택창을 다시 열지 않음 → 후: **매번** 연다.
 *  - 전: ±10분 허용오차 밖이면 미연결 → 후: 허용오차로 탈락시키지 않음(≥30분이면 경고만).
 *  - 신규: 이미 다른 핀에 연결된 파일명은 건너뛰고 다음 최신을 쓴다.
 *  - 신규: 핀 생성 → .click() 호출 경로에 await 없음(동기)을 소스로 확정.
 *  - 유지: CHECKER 계열은 절대 연결 대상이 아니다(SoT: PinSeries.seriesOf).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const seriesSrc = rd("public/js/modules/01b_PinSeries.js");
const pbSrc = rd("public/js/modules/35_PhotoBatch.js");
const appSrc = rd("public/js/modules/20_App.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

function makeRegistryDoc() {
  const registry = new Map();
  function makeElement() {
    const el = { value: "", textContent: "", innerHTML: "", checked: false, style: {}, _listeners: {}, _classes: new Set(), _clickCount: 0 };
    el.classList = {
      add: (c) => el._classes.add(c),
      remove: (c) => el._classes.delete(c),
      contains: (c) => el._classes.has(c),
      toggle: (c, force) => { if (force === undefined) { if (el._classes.has(c)) { el._classes.delete(c); return false; } el._classes.add(c); return true; } if (force) el._classes.add(c); else el._classes.delete(c); return !!force; }
    };
    el.addEventListener = (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); };
    el.click = () => { el._clickCount++; (el._listeners.click || []).forEach((fn) => fn({})); };
    el.setAttribute = () => {};
    el.appendChild = (c) => { if (c && c.id) registry.set(c.id, c); return c; };
    el.remove = () => {};
    return el;
  }
  const document = {
    getElementById: (id) => registry.get(id) || null,
    createElement: (tag) => { const el = makeElement(); el.tagName = tag; return el; },
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    body: { appendChild: (el) => { if (el && el.id) registry.set(el.id, el); } },
    querySelectorAll: () => []
  };
  return { document, registry };
}

function loadEnv(pbSource, pins) {
  const State = { pins: pins || [], pdfPage: 1, checkboard: true };
  const { document, registry } = makeRegistryDoc();
  const toasts = [];
  const uploads = [];
  const detect360Map = {}; // name -> bool
  const Cloud = {
    _cache: {},
    async resizeImage(file) { return { dataURL: "data:image/jpeg;base64,AAA", width: 4000, height: 2000 }; },
    async uploadImage(imgName) { uploads.push(imgName); return "img_" + imgName; }
  };
  const SyncQueue = { async enqueue() { return "op-x"; } };
  const App = {
    _detect360(file, cb) { cb(!!detect360Map[file.name], 4000, 2000); },
    _updateSyncBadge() {}, _markDirty() {}, _updateCheckboardQuickStatus() {}
  };
  const UI = { renderPinList() {}, renderPinsOnMap() {} };
  const Prompt = { toast: (m) => toasts.push(m) };
  const sandbox = {
    console, document, window: { addEventListener() {} }, navigator: { onLine: true },
    State, Cloud, SyncQueue, App, UI, Prompt, PinGrid: undefined,
    JSON, Array, Map, Set, Date, setTimeout, Promise
  };
  vm.createContext(sandbox);
  vm.runInContext(seriesSrc + "\n" + pbSource + "\n;globalThis.__PB = PhotoBatch; globalThis.__PS = PinSeries;", sandbox);
  return { PB: sandbox.__PB, PS: sandbox.__PS, State, registry, toasts, uploads, detect360Map };
}

function makeFile(name, lastModified) {
  return { name, lastModified, slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) };
}

/* ══ ① 핀 생성 → 선택창 즉시(동기) ══════════════════════════════════ */
function testSyncClick() {
  // [재현 요청] 핀 생성(State.pins.push, _placeCheckboardPin) → PhotoBatch.autoConnectPin →
  // input.click() 호출 경로에 await/setTimeout 이 없는지 소스로 확정한다(20_App.js:1697-1709,
  // 35_PhotoBatch.js autoConnectPin). await 가 있으면 모바일에서 user-activation 이 끊겨
  // .click() 이 조용히 무시된다(마스터 라이브 재현 b8cd1f2a 가설①).
  const m = /autoConnectPin\(pin\)\s*\{([\s\S]*?)\n    \},/.exec(pbSrc);
  ok(!!m, "①a autoConnectPin 함수 본문을 소스에서 추출함");
  if (m) {
    ok(!/\basync\b/.test(pbSrc.slice(Math.max(0, m.index - 20), m.index)), "①b autoConnectPin 은 async 가 아님(동기 함수)");
    ok(!/\bawait\b|setTimeout/.test(m[1]), "①c autoConnectPin 본문에 await/setTimeout 없음 → .click() 까지 완전 동기");
  }
  const handlerMatch = /if \(State\.regMode === "photo"\) \{([\s\S]*?)\n      \}/.exec(appSrc);
  ok(!!handlerMatch, "①d 20_App.js _handlePlaceClick 의 photo 분기 본문을 추출함");
  if (handlerMatch) ok(!/\bawait\b|setTimeout/.test(handlerMatch[1]), "①e photo 분기(_placeCheckboardPin→autoConnectPin) 에 await/setTimeout 없음");

  // 동작으로도 확인 — 같은 동기 호출 안에서 click 이 1회 일어남.
  const pin = { id: 1, page: 1, label: "1", createdAt: 1000 };
  const { PB, registry } = loadEnv(pbSrc, [pin]);
  PB.autoConnectPin(pin);
  const input = registry.get("photobatch-auto-files");
  ok(!!input && input._clickCount === 1, "①f 핀 생성 직후 선택창이 동기적으로 열림(click 1회)");
}

/* ══ ② 매번 연다 — 두 번째 핀도 다시 선택창을 연다(구 동작과 반대) ══════════════ */
async function testAlwaysReopens() {
  const pinA = { id: 1, page: 1, label: "1", createdAt: 5 * 60000 };
  const pinB = { id: 2, page: 1, label: "2", createdAt: 8 * 60000 };
  const { PB, registry, detect360Map, uploads } = loadEnv(pbSrc, [pinA, pinB]);

  detect360Map["photoA.jpg"] = true;
  PB.autoConnectPin(pinA);
  const input = registry.get("photobatch-auto-files");
  ok(!!input && input._clickCount === 1, "②a pinA — 선택창 1회째 열림");
  await PB._onAutoFilesChosen([makeFile("photoA.jpg", 5 * 60000)]);
  ok(pinA.imageName === "photoA", "②b pinA 에 photoA 연결됨 → " + pinA.imageName);

  detect360Map["photoB.jpg"] = true;
  PB.autoConnectPin(pinB);
  ok(input._clickCount === 2, "②c pinB — 세션 후보 유무와 무관하게 선택창을 또 연다(click 2회) [마스터: 매번 연다]");
  await PB._onAutoFilesChosen([makeFile("photoB.jpg", 8 * 60000)]);
  ok(pinB.imageName === "photoB", "②d pinB 에 photoB 연결됨 → " + pinB.imageName);
  ok(uploads.includes("photoA") && uploads.includes("photoB"), "②e 업로드 경로(_uploadOneRow) 재사용 확인");

  console.log("\n  [뮤테이션①] '매번 연다'를 되돌려 세션 후보가 있으면 선택창을 건너뛰게 하면 — 실패해야 함");
  const needle = 'this._pendingAutoPin = pin;\n      this._ensureAutoInput();';
  if (!pbSrc.includes(needle)) { console.log("    FAIL 뮤테이션① 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mutated = pbSrc.replace(
      needle,
      'if (this._autoRows && this._autoRows.length) { this._autoRows = []; return; }\n      this._pendingAutoPin = pin;\n      this._ensureAutoInput();'
    );
    const pX = { id: 10, page: 1, label: "10", createdAt: 1000 };
    const pY = { id: 11, page: 1, label: "11", createdAt: 2000 };
    const { PB: PBm, registry: regM, detect360Map: dmM } = loadEnv(mutated, [pX, pY]);
    dmM["x.jpg"] = true;
    PBm.autoConnectPin(pX);
    const inM = regM.get("photobatch-auto-files");
    await PBm._onAutoFilesChosen([makeFile("x.jpg", 1000)]);
    PBm._autoRows = [{ fake: true }]; // 뮤테이션이 참조하는 레거시 필드를 강제로 채워 재현
    PBm.autoConnectPin(pY);
    ok(!!inM && inM._clickCount === 1, "뮤테이션 적용 시 두 번째 핀에서 선택창이 다시 열리지 않음(②c 가 깨짐을 증명) → click=" + (inM && inM._clickCount));
  }
}

/* ══ ③ 허용오차로 탈락시키지 않는다 — ≥30분 차이도 등록 + 경고 ══════════════ */
async function testNoToleranceButWarns() {
  const pin = { id: 1, page: 1, label: "1", createdAt: 0 }; // 핀 생성시각 0
  const { PB, toasts } = loadEnv(pbSrc, [pin]);
  PB._pendingAutoPin = pin;
  const detect360Map = { "old.jpg": true };
  PB._ensureAutoInput = PB._ensureAutoInput; // no-op, keep API
  const Appstub = null;
  // _onAutoFilesChosen 은 loadEnv 가 만든 App._detect360 를 쓰므로 환경을 다시 만든다.
  const env2 = loadEnv(pbSrc, [pin]);
  env2.PB._pendingAutoPin = pin;
  env2.detect360Map["old.jpg"] = true;
  await env2.PB._onAutoFilesChosen([makeFile("old.jpg", 40 * 60000)]); // 핀 시각과 40분 차이(허용오차 밖이던 구간)
  ok(pin.imageName === "old", "③a 40분 차이에도 등록됨(허용오차로 탈락시키지 않음) → " + JSON.stringify(pin.imageName));
  ok(env2.toasts.some((t) => /핀 생성 40분 전 사진/.test(t)), "③b 큰 시간차는 사실만 토스트로 경고 → " + JSON.stringify(env2.toasts));

  console.log("\n  [뮤테이션②] ≥30분 경고를 제거하면 — 실패해야 함(경고 문구 사라짐)");
  const needle = "if (dtMs != null && dtMs >= BIG_GAP_WARN_MS) msg += \" · 핀 생성 \" + Math.round(dtMs / 60000) + \"분 전 사진\";";
  if (!pbSrc.includes(needle)) { console.log("    FAIL 뮤테이션② 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mutated = pbSrc.replace(needle, "/* 경고 제거(뮤테이션) */");
    const pinM = { id: 2, page: 1, label: "2", createdAt: 0 };
    const envM = loadEnv(mutated, [pinM]);
    envM.PB._pendingAutoPin = pinM;
    envM.detect360Map["old2.jpg"] = true;
    await envM.PB._onAutoFilesChosen([makeFile("old2.jpg", 40 * 60000)]);
    ok(!envM.toasts.some((t) => /분 전 사진/.test(t)), "뮤테이션 적용 시 경고 문구가 사라짐(③b 가 깨짐을 증명) → " + JSON.stringify(envM.toasts));
  }
}

/* ══ ④ 가장 최근 사진 선택 + 이미 사용된 사진은 건너뜀 ══════════════════════ */
async function testNewestUnused() {
  const prevPin = { id: 1, page: 1, label: "1", createdAt: 0, origName: "used.jpg" }; // 이미 used.jpg 를 쓴 핀
  const curPin = { id: 2, page: 1, label: "2", createdAt: 100 };
  const { PB, detect360Map, uploads } = loadEnv(pbSrc, [prevPin, curPin]);
  PB._pendingAutoPin = curPin;
  detect360Map["used.jpg"] = true;   // 가장 최근이지만 이미 다른 핀(prevPin)이 사용 중 → 건너뜀
  detect360Map["older.jpg"] = true;  // 그다음 최신 → 선택돼야 함
  detect360Map["oldest.jpg"] = true;
  const files = [
    makeFile("used.jpg", 3000),
    makeFile("older.jpg", 2000),
    makeFile("oldest.jpg", 1000)
  ];
  await PB._onAutoFilesChosen(files);
  ok(curPin.imageName === "older", "④a 가장 최근(used.jpg)은 다른 핀이 이미 사용 중이라 건너뛰고 그다음 최신(older)이 선택됨 → " + curPin.imageName);
  ok(!uploads.includes("used"), "④b 이미 사용된 원본 파일(used.jpg)은 업로드되지 않음");

  console.log("\n  [뮤테이션③] '이미 사용된 사진 건너뛰기'를 제거하면 — 실패해야 함(used.jpg 중복 선택)");
  const needle = "const candidates = (rows || []).filter((r) => !r.excluded && r.is360 === true && !used.has(r.name));";
  if (!pbSrc.includes(needle)) { console.log("    FAIL 뮤테이션③ 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mutated = pbSrc.replace(needle, "const candidates = (rows || []).filter((r) => !r.excluded && r.is360 === true);");
    const prevPinM = { id: 10, page: 1, label: "10", createdAt: 0, origName: "used2.jpg" };
    const curPinM = { id: 11, page: 1, label: "11", createdAt: 100 };
    const envM = loadEnv(mutated, [prevPinM, curPinM]);
    envM.PB._pendingAutoPin = curPinM;
    envM.detect360Map["used2.jpg"] = true;
    envM.detect360Map["older2.jpg"] = true;
    await envM.PB._onAutoFilesChosen([makeFile("used2.jpg", 3000), makeFile("older2.jpg", 2000)]);
    ok(curPinM.imageName === "used2", "뮤테이션 적용 시 이미 사용된 사진이 다시 선택됨(④a 가 깨짐을 증명) → " + curPinM.imageName);
  }
}

/* ══ ⑤ 선택창 취소 → 핀은 남고 미연결 ══════════════════════════════════ */
async function testCancelLeavesUnconnected() {
  const pin = { id: 1, page: 1, label: "1", createdAt: 0 };
  const { PB, toasts } = loadEnv(pbSrc, [pin]);
  PB._pendingAutoPin = pin;
  await PB._onAutoFilesChosen([]); // 취소(파일 0개)
  ok(!pin.imageName, "⑤a 선택창을 취소하면 핀은 번호만 가진 채 미연결로 남음(가짜 연결 금지)");
  ok(toasts.some((t) => /이미지 파일을 찾을 수 없습니다/.test(t)), "⑤b 취소 안내 토스트 노출");
}

/* ══ ⑥ CHECKER 핀은 절대 대상이 아니다(SoT: PinSeries.seriesOf) ══════════════ */
async function testCheckerGuard() {
  const checkerPin = { id: 20, page: 1, label: "C1", checkboard: true, createdAt: 5 * 60000 };
  const { PB, registry } = loadEnv(pbSrc, [checkerPin]);

  PB.autoConnectPin(checkerPin);
  ok(!checkerPin.imageName, "⑥a CHECKER 핀은 연결되지 않음");
  const input = registry.get("photobatch-auto-files");
  ok(!input, "⑥b CHECKER 핀은 파일선택창도 열지 않음(가드가 함수 맨 앞에서 반환)");

  console.log("\n  [뮤테이션④] CHECKER 가드를 제거하면 — 실패해야 함(선택창이 열림)");
  const needle = 'if (typeof PinSeries !== "undefined" && PinSeries.seriesOf && PinSeries.seriesOf(pin) === "checkboard") return;';
  if (!pbSrc.includes(needle)) { console.log("    FAIL 뮤테이션④ 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mutated = pbSrc.replace(needle, "/* 가드 제거(뮤테이션) */");
    const checkerPinM = { id: 21, page: 1, label: "C2", checkboard: true, createdAt: 5 * 60000 };
    const { PB: PBm, registry: regM } = loadEnv(mutated, [checkerPinM]);
    PBm.autoConnectPin(checkerPinM);
    const inM = regM.get("photobatch-auto-files");
    ok(!!inM && inM._clickCount === 1, "뮤테이션 적용 시 CHECKER 핀에도 선택창이 열림(⑥b 가 깨짐을 증명) → click=" + (inM && inM._clickCount));
  }
}

/* ══ ⑦ 20_App.js _handlePlaceClick 이 실제로 autoConnectPin 을 호출한다 ══════════ */
function testHandlePlaceClickRouting() {
  ok(/PhotoBatch\.autoConnectPin/.test(appSrc), "⑦a 20_App.js _handlePlaceClick 이 PhotoBatch.autoConnectPin 을 참조함");
}

(async () => {
  console.log("\n[① 핀 생성 → 선택창 즉시(동기, await 없음)]");
  testSyncClick();
  console.log("\n[② 매번 연다]");
  await testAlwaysReopens();
  console.log("\n[③ 허용오차로 탈락시키지 않음 + 큰 시간차 경고]");
  await testNoToleranceButWarns();
  console.log("\n[④ 최신 미사용 사진 선택]");
  await testNewestUnused();
  console.log("\n[⑤ 취소 → 미연결]");
  await testCancelLeavesUnconnected();
  console.log("\n[⑥ CHECKER 핀 차단]");
  await testCheckerGuard();
  console.log("\n[⑦ _handlePlaceClick 라우팅]");
  testHandlePlaceClickRouting();

  console.log(failed === 0 ? "\nALL PASS" : "\n" + failed + " FAILED");
  process.exit(failed === 0 ? 0 : 1);
})();
