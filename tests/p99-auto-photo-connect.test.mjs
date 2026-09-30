/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p99-auto-photo-connect.test.mjs)
 *
 * 대상: WO 20260930-autophoto — "360 모드는 사진이 자동 등록되는 로직, 여기만 필요해" /
 * "포인트 생성 시간을 기록해 … 제일 근사한 시간에 저장된 360 그림을 찾아서 연동되게".
 * PhotoBatch.autoConnectPin/_onAutoFilesChosen/_autoTryConnect(35_PhotoBatch.js) +
 * 20_App.js _handlePlaceClick photo 분기의 실제 소스를 그대로 vm 에 평가한다(목 구현 아님).
 * 기존 시각매칭 정본(_buildTimeMatches/_sortRows/_uploadOneRow)만 재사용 — 새 매칭 로직 없음.
 *
 * 검증 대상:
 *  ① 360 핀 생성 → 최근접 사진 자동 연결(저장명 imageName)
 *  ② 두 번째 핀은 재선택 없이(파일 입력 재오픈 없이) 매칭되고, 같은 사진이 중복 연결되지 않음
 *  ③ 허용오차 밖이면 미연결 + 안내 토스트
 *  ④ CHECKER 핀에는 절대 연결되지 않음(+ 뮤테이션: 가드 제거 시 연결됨을 증명)
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const seriesSrc = rd("public/js/modules/01b_PinSeries.js");
const pbSrc = rd("public/js/modules/35_PhotoBatch.js");

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

/* ══ ①~③ 정상 흐름: 세션 1회 선택 → 여러 핀 순차 자동매칭 ══════════════════ */
async function testAutoFlow() {
  const pinA = { id: 1, page: 1, label: "1", createdAt: 5 * 60000 };   // 5분
  const pinB = { id: 2, page: 1, label: "2", createdAt: 8 * 60000 };   // 8분
  const pinC = { id: 3, page: 1, label: "3", createdAt: 100 * 60000 }; // 100분(허용오차 밖)
  const pins = [pinA, pinB, pinC];
  const { PB, registry, toasts, uploads, detect360Map } = loadEnv(pbSrc, pins);

  // ① pinA 생성 직후 — 세션에 사진이 없으므로 파일선택창이 열려야 한다.
  PB.autoConnectPin(pinA);
  const input = registry.get("photobatch-auto-files");
  ok(!!input && input._clickCount === 1, "①a 첫 360 핀 — 다중 파일선택창이 동기적으로 열림(click 1회)");

  // 사용자가 4장을 골랐다고 가정(파일 대화상자 응답, 1회만).
  detect360Map["photoA.jpg"] = true;   // 5.5분 · 360 · pinA 최근접
  detect360Map["photoB.jpg"] = true;   // 8.33분 · 360 · pinB 최근접
  detect360Map["photoC_flat.jpg"] = false; // 5.17분 · 360 아님 → 제외
  detect360Map["photoD.jpg"] = true;   // 50분 · 360 · pinC 와는 오차초과
  const files = [
    makeFile("photoA.jpg", 5 * 60000 + 30000),
    makeFile("photoB.jpg", 8 * 60000 + 20000),
    makeFile("photoC_flat.jpg", 5 * 60000 + 10000),
    makeFile("photoD.jpg", 50 * 60000)
  ];
  await PB._onAutoFilesChosen(files); // change 핸들러가 실제로 호출하는 함수(대기 중인 pinA 에 바로 매칭 시도)

  ok(pinA.imageName === "photoA", "①b pinA 에 가장 가까운 360 사진(photoA)이 자동 연결됨 → " + pinA.imageName);
  ok(uploads.includes("photoA"), "①c 업로드 경로(_uploadOneRow→Cloud.uploadImage) 재사용 확인");

  // ② pinB — 세션에 이미 사진이 있으므로 파일선택창을 다시 열지 않고 바로 매칭.
  const clicksBefore = input._clickCount;
  PB.autoConnectPin(pinB);
  await new Promise((r) => setTimeout(r, 0)); // _autoTryConnect 는 async
  ok(input._clickCount === clicksBefore, "②a 두 번째 핀 — 파일선택창을 다시 열지 않음(click 횟수 불변) → " + input._clickCount);
  ok(pinB.imageName === "photoB", "②b pinB 에 photoB 가 연결됨(재선택 없이 세션 목록에서 매칭) → " + pinB.imageName);
  ok(pinB.imageName !== pinA.imageName, "②c 같은 사진이 중복 연결되지 않음(pinA=photoA, pinB=photoB)");

  // ③ pinC — 남은 후보(photoD, 50분)와 100분 차이가 10분 허용오차를 초과 → 미연결 + 안내.
  PB.autoConnectPin(pinC);
  await new Promise((r) => setTimeout(r, 0));
  ok(!pinC.imageName, "③a pinC 는 연결되지 않음(허용오차 밖, 가짜 연결 금지) → " + JSON.stringify(pinC.imageName));
  ok(toasts.some((t) => /안에 촬영된 360 사진 없음/.test(t) && /사진 선택/.test(t)),
    "③b 허용오차 밖 안내 토스트 노출 → " + JSON.stringify(toasts));

  /* [뮤테이션①] pinA 매칭 후 사용된 row 를 세션에서 제거하지 않으면(중복 재사용) — 실패해야 함 */
  console.log("\n  [뮤테이션①] 매칭된 사진을 세션에서 제거하지 않도록 되돌리면 — 실패해야 함");
  const needle = "this._autoRows = (this._autoRows || []).filter((x) => x !== m.row);";
  if (!pbSrc.includes(needle)) { console.log("    FAIL 뮤테이션① 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mutated = pbSrc.replace(needle, "/* 제거 안 함(뮤테이션) */");
    const pinX = { id: 10, page: 1, label: "10", createdAt: 5 * 60000 };
    const pinY = { id: 11, page: 1, label: "11", createdAt: 5 * 60000 };
    const { PB: PBm, detect360Map: dmM } = loadEnv(mutated, [pinX, pinY]);
    dmM["single.jpg"] = true;
    PBm._autoRows = [{ file: makeFile("single.jpg", 5 * 60000), name: "single.jpg", lastModified: 5 * 60000, sortKey: 5 * 60000, exif: null, excluded: false, is360: true, thetaSignal: false }];
    await PBm._autoTryConnect(pinX);
    await PBm._autoTryConnect(pinY);
    ok(pinX.imageName === pinY.imageName && !!pinX.imageName,
      "뮤테이션 적용 시 같은 사진이 두 핀에 중복 연결됨(②c 가 깨짐을 증명) → pinX=" + pinX.imageName + " pinY=" + pinY.imageName);
  }
}

/* ══ ④ CHECKER 핀은 절대 대상이 아니다(SoT: PinSeries.seriesOf) ══════════════ */
async function testCheckerGuard() {
  const checkerPin = { id: 20, page: 1, label: "C1", checkboard: true, createdAt: 5 * 60000 };
  const { PB, registry, detect360Map } = loadEnv(pbSrc, [checkerPin]);
  detect360Map["near.jpg"] = true;
  PB._autoRows = [{ file: makeFile("near.jpg", 5 * 60000 + 1000), name: "near.jpg", lastModified: 5 * 60000 + 1000, sortKey: 5 * 60000 + 1000, exif: null, excluded: false, is360: true, thetaSignal: false }];

  PB.autoConnectPin(checkerPin);
  await new Promise((r) => setTimeout(r, 0));
  ok(!checkerPin.imageName, "④a CHECKER 핀은 세션에 딱 맞는 사진이 있어도 연결되지 않음");
  ok(PB._autoRows.length === 1, "④b CHECKER 핀 호출로 세션 후보 사진이 소비되지 않음");
  const input = registry.get("photobatch-auto-files");
  ok(!input, "④c CHECKER 핀은 파일선택창도 열지 않음(가드가 함수 맨 앞에서 반환)");

  console.log("\n  [뮤테이션②] CHECKER 가드를 제거하면 — 실패해야 함(연결됨)");
  const needle = 'if (typeof PinSeries !== "undefined" && PinSeries.seriesOf && PinSeries.seriesOf(pin) === "checkboard") return;';
  if (!pbSrc.includes(needle)) { console.log("    FAIL 뮤테이션② 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mutated = pbSrc.replace(needle, "/* 가드 제거(뮤테이션) */");
    const checkerPinM = { id: 21, page: 1, label: "C2", checkboard: true, createdAt: 5 * 60000 };
    const { PB: PBm, detect360Map: dmM } = loadEnv(mutated, [checkerPinM]);
    dmM["near2.jpg"] = true;
    PBm._autoRows = [{ file: makeFile("near2.jpg", 5 * 60000 + 1000), name: "near2.jpg", lastModified: 5 * 60000 + 1000, sortKey: 5 * 60000 + 1000, exif: null, excluded: false, is360: true, thetaSignal: false }];
    PBm.autoConnectPin(checkerPinM);
    await new Promise((r) => setTimeout(r, 0));
    ok(!!checkerPinM.imageName, "뮤테이션 적용 시 CHECKER 핀에도 360 사진이 자동 연결됨(④가 깨짐을 증명) → " + checkerPinM.imageName);
  }
}

/* ══ ⑤ 20_App.js _handlePlaceClick 이 실제로 autoConnectPin 을 호출한다 ══════════ */
async function testHandlePlaceClickRouting() {
  const appSrc = rd("public/js/modules/20_App.js");
  ok(/PhotoBatch\.autoConnectPin/.test(appSrc), "⑤a 20_App.js _handlePlaceClick 이 PhotoBatch.autoConnectPin 을 참조함");
  ok(!/State\.regMode === "photo"[\s\S]{0,120}this\._openPinMediaPicker\(pin\);\s*\n\s*return;/.test(appSrc),
    "⑤b photo 분기가 더 이상 무조건 _openPinMediaPicker 만 호출하지 않음(자동연결 우선)");
}

(async () => {
  console.log("\n[①②③ 360 핀 생성 → 세션 자동 시각매칭]");
  await testAutoFlow();
  console.log("\n[④ CHECKER 핀 차단]");
  await testCheckerGuard();
  console.log("\n[⑤ _handlePlaceClick 라우팅]");
  await testHandlePlaceClickRouting();

  console.log(failed === 0 ? "\nALL PASS" : "\n" + failed + " FAILED");
  process.exit(failed === 0 ? 0 : 1);
})();
