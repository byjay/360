/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p152-photo-folder-match.test.mjs)
 *
 * 대상: WO 20261015-photofolder2 — public/js/modules/60_PhotoFolder.js (845a081 위에 확장)
 * 마스터 요청(2026-10-15, 음성) 3건 + 확정 1건:
 *  ① "파일 이름 앞에 알파벳이 있더라도 뒤에 숫자 세 자리만 일치하면 완벽하게 갖다 꽂도록 해."
 *  ② "각 구역별로 폴더 지정을 먼저 일괄적으로 하면, 일괄 등록 기능과 하나씩 등록하는 기능을
 *     체크박스 옵션으로 구분하도록 해."
 *  ③ "체크보드 모드에서 번호만 일괄적으로 찍고 나서 사진 폴더나 특정 경로를 지정해서 … 일치하면
 *     바로 그 위치에 360도 사진이 일괄적으로 들어가게."
 *  ④ "핀 번호는 1 2 3 4 처럼 한 자리로 보여주지만, 인식할 때는 001, 002, 003 처럼 세 자리로
 *     인식하고, 파일 이름도 그런 식으로 매칭할 수 있도록 해." → 표시 불변, 매칭 키만 3자리 0채움.
 *
 * A. 순수 매칭(_matchKey/_fileKey/isMatch/findMatches/_keyAmbiguous) — 3자리 0채움, 끝 숫자열,
 *    앞자리 문자 무시, 999 초과 모호성.
 * B. handlePinPlaced() 분기 — 단일 구역(__root__)에서의 기존 845a081 흐름(체크박스 ON 전제).
 * C. 구역별 폴더 해석 — _deckForPin/_deckChainForPin/_resolveFolderKeyForPin(구역→부모→원본 폴백).
 * D. 레거시(845a081 프로젝트 단위 키) → __root__ 1회 마이그레이션(데이터 유실 0).
 * E. 일괄 등록 — previewBatch(상태 분류)·runBatchConfirmed(순차 등록, "일치"만 적용) 순수 로직.
 *
 * 실 모듈 소스(60_PhotoFolder.js)를 vm 에 그대로 평가한다(재구현 금지, 목 아님).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const pfSrc = rd("public/js/modules/60_PhotoFolder.js");

let failed = 0;
const ok = (cond, label, detail) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail).slice(0, 300) : "")); if (!cond) failed++; };

/* ── 최소 가짜 DOM(p99 makeRegistryDoc 관례와 동일) ── */
function makeFakeDoc() {
  const registry = new Map();
  function makeElement() {
    const el = {
      value: "", textContent: "", innerHTML: "", checked: false, style: {}, dataset: {}, disabled: false,
      _listeners: {}, _classes: new Set(), _children: [],
      classList: {
        add: (c) => el._classes.add(c), remove: (c) => el._classes.delete(c), contains: (c) => el._classes.has(c),
        toggle: (c, force) => { if (force === undefined) { if (el._classes.has(c)) { el._classes.delete(c); return false; } el._classes.add(c); return true; } if (force) el._classes.add(c); else el._classes.delete(c); return !!force; }
      }
    };
    el.addEventListener = (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); };
    el.click = (ev) => { (el._listeners.click || []).forEach((fn) => fn(ev || {})); if (typeof el.onclick === "function") el.onclick(ev || {}); };
    el.setAttribute = (k, v) => { el[k === "class" ? "className" : k] = v; };
    el.appendChild = (c) => { el._children.push(c); if (c && c.id) registry.set(c.id, c); return c; };
    el.querySelector = (sel) => el._children.find((c) => c && c.className && String(c.className).split(/\s+/).includes(sel.replace(".", ""))) || null;
    el.querySelectorAll = () => [];
    el.remove = () => {};
    return el;
  }
  const document = {
    getElementById: (id) => registry.get(id) || null,
    createElement: (tag) => { const el = makeElement(); el.tagName = tag; return el; },
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    body: Object.assign(makeElement(), { id: undefined }),
    querySelectorAll: () => []
  };
  document.body.appendChild = (c) => { if (c && c.id) registry.set(c.id, c); return c; };
  return { document, registry };
}

function makeLocalStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

function makeSyncQueue() {
  const m = new Map();
  return { _m: m, saveDraft: async (k, v) => { m.set(k, v); }, loadDraft: async (k) => (m.has(k) ? m.get(k) : null) };
}

function loadPF(src, opts = {}) {
  const { document } = makeFakeDoc();
  const toasts = [];
  const uploadCalls = [];
  const State = Object.assign({ pins: [], pdfPage: 1, checkboard: true, regMode: "photo" }, opts.state || {});
  const Auth = Object.assign({ readonly: false }, opts.auth || {});
  const PinSeries = Object.assign({
    seriesOf: (p) => (p && p.checkboard) ? "checkboard" : "content",
    mediaOf: (p) => !!(p && (p.imageId || p.pendingOpId)),
    formatNo: (no, series) => (series === "checkboard" ? String(no) : ("P" + no)),
    numbers: (pins, page) => {
      const map = new Map();
      let n = 0;
      (pins || []).forEach((p) => { if ((p.page || 1) !== page) return; n++; map.set(p.id, { no: n, series: "content" }); });
      return map;
    }
  }, opts.pinSeries || {});
  const App = { _detect360: (file, cb) => cb(file.__is360 !== false, 4096, 2048) };
  const PhotoBatch = {
    _usedPhotoNames: () => new Set(),
    _uploadOneRow: async (pin, row, overwrite, usedNames, source) => {
      uploadCalls.push({ pinId: pin.id, name: row.name, source });
      pin.imageId = "img_" + row.name;
      return { status: "done" };
    },
    _markUnsaved: () => {}
  };
  const UI = { renderPinList: () => {}, renderPinsOnMap: () => {} };
  const Prompt = { toast: (msg) => toasts.push(String(msg)) };
  const Projects = Object.assign({
    currentProject: { id: "projT" },
    currentDeck: null,
    decks: [],
    pinsForDeck(pins, deck) {
      if (!deck || !deck.crop || !(deck.crop.w > 0) || !(deck.crop.h > 0)) return Array.isArray(pins) ? pins : [];
      const x1 = deck.crop.x + deck.crop.w, y1 = deck.crop.y + deck.crop.h;
      return (pins || []).filter((p) => p && (p.page || 1) === (deck.page || 1) && p.x >= deck.crop.x && p.x <= x1 && p.y >= deck.crop.y && p.y <= y1);
    }
  }, opts.projects || {});
  const localStorage = opts.localStorage || makeLocalStorage();
  const SyncQueue = opts.syncQueue; // undefined 기본(기존 B-시나리오와 동일 — 복원 경로를 안 탄다)
  const sandbox = {
    console, Map, Set, Promise, document,
    window: { showDirectoryPicker: undefined },
    localStorage, State, Auth, PinSeries, App, PhotoBatch, UI, Prompt, Projects, SyncQueue
  };
  sandbox.window.document = document;
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__PF = PhotoFolder;", sandbox);
  return { PF: sandbox.__PF, toasts, uploadCalls, State, Auth, Projects, document, localStorage };
}

/* ══ A. 순수 매칭(2026-10-15 지휘자 정정 — 2단계, 다중유저 번호 대역 오매칭 방지) ══════════ */
{
  const { PF } = loadPF(pfSrc);
  const cases = [
    // 기존(845a081) 사례 — 2단계 규칙에서도 1차(전체 정수 비교)로 동일 결과
    [12, "P12.jpg", true], [12, "p012.JPG", true], [12, "12.jpg", true], [12, "P-12.jpeg", true],
    [12, "P_12.jpg", true], [12, "P120.jpg", false], [12, "P1.jpg", false], [12, "p13.jpg", false],
    // 마스터 확정 예시(1차 — 전체 정수 비교, 앞자리 0 무시)
    [1, "A001.jpg", true], [1, "ER_001.JPG", true], [1, "0000000001.jpg", true], [1, "1.jpg", true],
    [1, "A010.jpg", false], [1, "A100.jpg", false],
    [10, "X010.jpg", true]
  ];
  cases.forEach(([no, name, expect]) => {
    ok(PF.isMatch(no, name) === expect, "A isMatch(" + no + ", '" + name + "') = " + expect);
  });
  // [지휘자 정정 2026-10-15] 다중유저 번호 대역(대역11=1001~1100) — 1001핀 ↔ A1001.jpg 는 1차로 직접 일치.
  ok(PF.isMatch(1001, "A1001.jpg") === true, "A 1001 ↔ 'A1001.jpg' = true(1차, 전체 정수 비교)");
  // 1001번 핀이 "이 페이지에 실제로 존재"하면, 1번 핀은 끝 3자리 폴백으로 그 파일을 가로채지 않는다.
  ok(PF.isMatch(1, "A1001.jpg", new Set([1, 1001])) === false, "A 1 ↔ 'A1001.jpg'(1001핀 존재) = false(폴백 억제 — 그 사진은 1001번 핀 것)");
  // existingNumbers 를 안 넘기면(단일 핀만 보는 순수 호출) 억제하지 않음 — 2차 폴백이 그대로 적용된다.
  ok(PF.isMatch(1, "A1001.jpg") === true, "A existingNumbers 미전달 시 폴백 억제 없음(2차: 끝 3자리 '001'=1)");
  // 2차(폴백) — 숫자열이 3자리를 넘고, 그 전체 정수(3005)에 해당하는 핀이 없을 때만 끝 3자리로 재비교.
  ok(PF.isMatch(5, "ER3005.jpg", new Set([5])) === true, "A 5 ↔ 'ER3005.jpg'(3005핀 없음) = true(2차, 끝 3자리 '005')");
  ok(PF.isMatch(5, "ER3005.jpg", new Set([5, 3005])) === false, "A 5 ↔ 'ER3005.jpg'(3005핀 존재) = false(폴백 억제)");
  ok(PF._matchKey(1) === "001" && PF._matchKey(1001) === "001", "A _matchKey — 표시 전용 3자리 0채움(비교에는 안 씀, 1과 1001이 같은 라벨)");
  ok(PF._fileFullNo("A001.jpg") === 1 && PF._fileFullNo("X010.jpg") === 10, "A _fileFullNo — 끝 숫자열 전체 정수(앞자리0 무시)");
  ok(PF._fileFallbackNo("A001.jpg") === null, "A _fileFallbackNo — 숫자열 3자리 이하는 폴백 비대상(null)");
  ok(PF._fileFallbackNo("ER3005.jpg") === 5, "A _fileFallbackNo('ER3005.jpg') = 5(끝 3자리)");
  ok(PF._fileFullNo("12A.jpg") === null, "A _fileFullNo('12A.jpg') = null(끝이 숫자가 아님)");
  ok(PF.findMatches(12, [{ name: "P12.jpg" }, { name: "P12.txt" }, { name: "p012.png" }]).length === 2,
    "A findMatches — 확장자 필터(jpg/png만, txt 제외) + 번호일치 2건");
}

/* ══ B. handlePinPlaced 분기(단일 구역 __root__, 체크박스 전제) ══════════════════ */
async function runB() {
  // B1: 폴더 미지정 → false(폴백)
  {
    const { PF } = loadPF(pfSrc);
    const handled = await PF.handlePinPlaced({ id: "p1", page: 1 });
    ok(handled === false, "B1 폴더 미지정 → false(기존 폴백으로)");
  }
  const mkPF = (state) => {
    const { PF, toasts, uploadCalls, Auth, document } = loadPF(pfSrc, { state });
    PF._entry("__root__").mode = "fallback";
    PF._entry("__root__").fallbackFiles = [{ name: "a" }]; // hasFolder() true 용(실제 getFile 안 씀)
    PF._listEntries = async () => [
      { name: "P1.jpg", getFile: async () => ({ lastModified: 1, __is360: true, name: "P1.jpg" }) },
      { name: "p02.jpg", getFile: async () => ({ lastModified: 2, __is360: true, name: "p02.jpg" }) },
      { name: "P3.jpg", getFile: async () => ({ lastModified: 3, __is360: true, name: "P3.jpg" }) },
      { name: "p-3.png", getFile: async () => ({ lastModified: 4, __is360: true, name: "p-3.png" }) }
    ];
    PF.setSingleOn("__root__", true); // [WO 20261015] 새 기본값은 OFF — 이 시나리오군은 "하나씩 등록" 켜짐 전제
    return { PF, toasts, uploadCalls, Auth, document };
  };

  // B1b: 폴더는 있지만 "하나씩 등록" 체크박스 꺼짐 → false(기존 폴백)
  {
    const { PF } = loadPF(pfSrc, { state: { pins: [{ id: "p1", page: 1 }] } });
    PF._entry("__root__").mode = "fallback";
    PF._entry("__root__").fallbackFiles = [{ name: "a" }];
    PF._listEntries = async () => [{ name: "P1.jpg", getFile: async () => ({ lastModified: 1, __is360: true, name: "P1.jpg" }) }];
    // setSingleOn 호출 안 함(기본 false)
    const handled = await PF.handlePinPlaced({ id: "p1", page: 1 });
    ok(handled === false, "B1b 폴더 있어도 '하나씩 등록' OFF(기본값) → false");
  }

  // B2: 🔴 [WO 20261015-numunify 계약 반전] CHECKER 계열 핀도 대상 — 244c5d8 "CHECKER 예외 미구현, 결정 대기" → 결정 = 허용.
  //   전·후 대조: 종전 handled===false(대상 아님) → 새 handled===true(폴더·하나씩 ON 이면 번호 1 ↔ P1.jpg 매칭 처리).
  //   (종전 B2 는 폴더 없는 mkPF() 로 불러 게이트가 없어도 false 가 나와 약했다 — 이제 핀 목록에 넣어 번호가 잡히게 한다.)
  {
    const c1 = { id: "c1", page: 1, checkboard: true };
    const { PF } = mkPF({ pins: [c1] });
    const handled = await PF.handlePinPlaced(c1);
    ok(handled === true, "B2 CHECKER 계열 핀 → true(사진 폴더 매칭 대상 — 번호 통합)");
  }
  // B3: 열람자 → false
  {
    const { PF, Auth } = mkPF();
    Auth.readonly = true;
    const handled = await PF.handlePinPlaced({ id: "p1", page: 1 });
    ok(handled === false, "B3 Auth.readonly → false(열람자 0)");
  }
  // B4: 이미 사진 있는 핀 → false(덮어쓰지 않음)
  {
    const { PF } = mkPF();
    const handled = await PF.handlePinPlaced({ id: "p1", page: 1, imageId: "old" });
    ok(handled === false, "B4 이미 사진 있는 핀 → false(덮어쓰지 않음)");
  }
  // B5: 0건 매칭(핀 번호 999는 폴더 안에 없음) → toast + false
  {
    const { PF, toasts } = mkPF({ pins: Array.from({ length: 999 }, (_, i) => ({ id: "x" + i, page: 1 })) });
    const pin = { id: "x998", page: 1 }; // 999번째 핀 → no=999, 폴더엔 1~3만 있음
    const handled = await PF.handlePinPlaced(pin);
    ok(handled === false && toasts.some((t) => /999/.test(t) && /없습니다/.test(t)), "B5 0건 매칭 → false + 안내 토스트 — " + JSON.stringify(toasts));
  }
  // B6: 1건 매칭 + 자동OFF → 확인모달 노출(3버튼), [등록] 클릭 전엔 업로드 0
  {
    const { PF, uploadCalls, document } = mkPF({ pins: [{ id: "p1", page: 1 }] }); // no=1 → "P1.jpg" 1건
    const pin = { id: "p1", page: 1 };
    const handled = await PF.handlePinPlaced(pin);
    ok(handled === true, "B6a 1건+자동OFF → true(이 모듈이 처리)");
    ok(uploadCalls.length === 0, "B6b 확인 클릭 전엔 업로드 0건(묻기만 함)");
    const regBtn = document.getElementById("photofolder-confirm-register");
    ok(!!regBtn, "B6c 확인모달 [등록] 버튼 존재");
    await regBtn.onclick();
    ok(uploadCalls.length === 1 && uploadCalls[0].name === "P1.jpg", "B6d [등록] 클릭 → _uploadOneRow(P1.jpg) 1회 — " + JSON.stringify(uploadCalls));
  }
  // B7: 1건 매칭 + 자동ON → 묻지 않고 즉시 등록
  {
    const { PF, uploadCalls } = mkPF({ pins: [{ id: "p2", page: 1 }] });
    PF.setAuto("__root__", true);
    const pin = { id: "p2", page: 1 };
    const handled = await PF.handlePinPlaced(pin);
    ok(handled === true && uploadCalls.length === 1 && uploadCalls[0].source === "폴더자동",
      "B7 1건+자동ON → 확인 없이 즉시 등록(source=폴더자동) — " + JSON.stringify(uploadCalls));
  }
  // B8: 다중 후보(핀 번호 3 → P3.jpg·p-3.png 2건) → 선택모달, 자동등록 0
  {
    const { PF, uploadCalls } = mkPF({ pins: [{}, {}, { id: "p3", page: 1 }] }); // no=3
    PF.setAuto("__root__", true); // 자동ON 이어도 다중 후보는 묻는다
    const pin = { id: "p3", page: 1 };
    const handled = await PF.handlePinPlaced(pin);
    ok(handled === true, "B8a 다중 후보 → true(선택모달로 처리)");
    ok(uploadCalls.length === 0, "B8b 다중 후보 → 자동ON 이어도 즉시 등록 0건(선택 전)");
  }
  // B9: [지휘자 정정 2026-10-15] 다중유저 번호 대역 — 페이지에 1001번 핀이 실제로 있으면, 1번 핀은
  // "A1001.jpg"를 끝 3자리 폴백으로 가로채지 않는다(0건 → 기존 폴백). 1001번 핀은 1차로 직접 매칭된다.
  {
    const numbersMock = () => new Map([["a", { no: 1 }], ["b", { no: 1001 }]]);
    const { PF, toasts, uploadCalls, document } = loadPF(pfSrc, {
      state: { pins: [{ id: "a", page: 1 }, { id: "b", page: 1 }] },
      pinSeries: { numbers: numbersMock }
    });
    PF._entry("__root__").mode = "fallback"; PF._entry("__root__").fallbackFiles = [{ name: "x" }];
    PF._listEntries = async () => [{ name: "A1001.jpg", getFile: async () => ({ lastModified: 1, __is360: true, name: "A1001.jpg" }) }];
    PF.setSingleOn("__root__", true);

    const handledA = await PF.handlePinPlaced({ id: "a", page: 1 }); // no=1
    ok(handledA === false && toasts.some((t) => /없습니다/.test(t)), "B9a 1번 핀 → 'A1001.jpg' 폴백 억제(1001번 핀이 진짜 주인) → false + 안내 — " + JSON.stringify(toasts));
    ok(uploadCalls.length === 0, "B9b 억제 상태에선 업로드 0건");

    const handledB = await PF.handlePinPlaced({ id: "b", page: 1 }); // no=1001
    ok(handledB === true, "B9c 1001번 핀 → 'A1001.jpg' 1차 직접 매칭 → 확인모달(true)");
    await document.getElementById("photofolder-confirm-register").onclick();
    ok(uploadCalls.length === 1 && uploadCalls[0].pinId === "b" && uploadCalls[0].name === "A1001.jpg", "B9d [등록] → 1001번 핀에 등록 — " + JSON.stringify(uploadCalls));
  }

  // B10: [지휘자 정정] 2차 폴백 — 3005번 핀이 없으면 'ER3005.jpg' 끝 3자리로 5번 핀과 매칭된다.
  {
    const numbersMock = () => new Map([["c", { no: 5 }]]);
    const { PF, uploadCalls, document } = loadPF(pfSrc, { state: { pins: [{ id: "c", page: 1 }] }, pinSeries: { numbers: numbersMock } });
    PF._entry("__root__").mode = "fallback"; PF._entry("__root__").fallbackFiles = [{ name: "x" }];
    PF._listEntries = async () => [{ name: "ER3005.jpg", getFile: async () => ({ lastModified: 1, __is360: true, name: "ER3005.jpg" }) }];
    PF.setSingleOn("__root__", true);
    const handled = await PF.handlePinPlaced({ id: "c", page: 1 });
    ok(handled === true, "B10a 5번 핀 → 'ER3005.jpg' 2차 폴백(3005핀 없음) → 확인모달");
    await document.getElementById("photofolder-confirm-register").onclick();
    ok(uploadCalls.length === 1 && uploadCalls[0].name === "ER3005.jpg", "B10b [등록] → 5번 핀에 등록 — " + JSON.stringify(uploadCalls));
  }
}
await runB();

/* ══ C. 구역별 폴더 해석 — _deckForPin/_deckChainForPin/_resolveFolderKeyForPin ══════ */
async function runC() {
  const deckA = { id: "dA", page: 1, crop: { x: 0, y: 0, w: 50, h: 50 }, parent_id: null };
  const deckB = { id: "dB", page: 1, crop: { x: 50, y: 50, w: 50, h: 50 }, parent_id: null };
  const projects = { decks: [deckA, deckB], currentDeck: null };

  // C1: 핀이 구역A 안 → 구역A 폴더로 해석(구역B 폴더는 무시)
  {
    const { PF } = loadPF(pfSrc, { projects });
    PF._entry("dA").mode = "fallback"; PF._entry("dA").fallbackFiles = [{ name: "fA" }];
    PF._entry("dB").mode = "fallback"; PF._entry("dB").fallbackFiles = [{ name: "fB" }];
    const pinInA = { id: "a1", page: 1, x: 10, y: 10 };
    const key = await PF._resolveFolderKeyForPin(pinInA);
    ok(key === "dA", "C1 구역A 안 핀 → 구역A 폴더 키 — " + key);
  }
  // C2: 핀이 구역B 안, 구역B엔 폴더 없음 · 원본(__root__)엔 있음 → __root__ 로 폴백
  {
    const { PF } = loadPF(pfSrc, { projects });
    PF._entry("dA").mode = "fallback"; PF._entry("dA").fallbackFiles = [{ name: "fA" }];
    PF._entry("__root__").mode = "fallback"; PF._entry("__root__").fallbackFiles = [{ name: "fRoot" }];
    const pinInB = { id: "b1", page: 1, x: 60, y: 60 };
    const key = await PF._resolveFolderKeyForPin(pinInB);
    ok(key === "__root__", "C2 구역B(폴더 없음) → 원본(__root__) 폴백 — " + key);
  }
  // C3: 어느 구역에도 폴더 없음 → null(기존 폴백 경로로)
  {
    const { PF } = loadPF(pfSrc, { projects });
    const pinInB = { id: "b1", page: 1, x: 60, y: 60 };
    const key = await PF._resolveFolderKeyForPin(pinInB);
    ok(key === null, "C3 어디에도 폴더 없음 → null");
  }
  // C4: 부모/자식 구역 — 자식(dChild, parent=dA)엔 폴더 없음, 부모(dA)엔 있음 → 부모로 폴백
  {
    const deckChild = { id: "dChild", page: 1, crop: { x: 0, y: 0, w: 10, h: 10 }, parent_id: "dA" };
    const { PF } = loadPF(pfSrc, { projects: { decks: [deckA, deckChild], currentDeck: null } });
    PF._entry("dA").mode = "fallback"; PF._entry("dA").fallbackFiles = [{ name: "fA" }];
    const pinInChild = { id: "c1", page: 1, x: 5, y: 5 }; // dChild(면적100) < dA(면적2500) → 가장 구체적인 구역은 dChild
    const key = await PF._resolveFolderKeyForPin(pinInChild);
    ok(key === "dA", "C4 자식 구역(폴더 없음) → 부모 구역(dA) 폴백 — " + key);
  }
}
await runC();

/* ══ D. 레거시(845a081) 단일 폴더 키 → __root__ 1회 마이그레이션 ══════════════════ */
async function runD() {
  const syncQueue = makeSyncQueue();
  const legacyHandle = { name: "LegacyDir", queryPermission: async () => "granted" };
  await syncQueue.saveDraft("photofolder:projT", { name: "LegacyDir", handle: legacyHandle }); // 845a081 레거시 키(구역 없음)
  const localStorage = makeLocalStorage();
  localStorage.setItem("wm_photofolder_auto_projT", "1"); // 845a081 레거시 자동등록 플래그

  const { PF } = loadPF(pfSrc, { syncQueue, localStorage });
  await PF._restoreKey("__root__");

  ok(PF.hasFolder("__root__") === true, "D1 레거시 폴더 → __root__ 로 마이그레이션(hasFolder=true)");
  ok(PF._entry("__root__").folderLabel === "LegacyDir", "D2 마이그레이션된 폴더 이름 보존 — " + PF._entry("__root__").folderLabel);
  ok(syncQueue._m.has("photofolder:projT") === true, "D3 레거시 레코드는 삭제하지 않음(데이터 유실 0)");
  ok(syncQueue._m.has("photofolder:projT:__root__") === true, "D4 새 구역별 키에도 복제 저장됨");
  ok(PF.isSingleOn("__root__") === true, "D5 레거시 사용자는 '하나씩 등록' 기본 ON(체감 변화 0)");
  ok(PF.isAutoOn("__root__") === true, "D6 레거시 '자동등록' 플래그가 __root__ 로 이관됨");
}
await runD();

/* ══ E. 일괄 등록 — previewBatch(상태 분류) · runBatchConfirmed(순차 등록) ══════════ */
async function runE() {
  // E1: 4개 핀(사진없음) — 1(일치) · 2(없음) · 3(다중) · 1001(모호, 후보1건이어도 확인필요)
  const pins = [
    { id: "p1", page: 1, x: 1, y: 1 },
    { id: "p2", page: 1, x: 1, y: 1 },
    { id: "p3", page: 1, x: 1, y: 1 },
    { id: "p4", page: 1, x: 1, y: 1, imageId: "already" } // 이미 사진 있음 — 일괄 대상에서 빠져야 함(덮어쓰기 금지)
  ];
  const pinSeries = {
    seriesOf: (p) => (p && p.checkboard) ? "checkboard" : "content",
    mediaOf: (p) => !!(p && p.imageId),
    formatNo: (no) => "P" + no,
    numbers: (list, page) => {
      const map = new Map();
      (list || []).forEach((p, i) => { if ((p.page || 1) === page) map.set(p.id, { no: i + 1 }); });
      return map;
    }
  };
  const { PF, uploadCalls } = loadPF(pfSrc, { state: { pins: pins }, pinSeries: pinSeries });
  PF._entry("__root__").mode = "fallback";
  PF._entry("__root__").fallbackFiles = [{ name: "x" }];
  PF._listEntries = async () => [
    { name: "P1.jpg", getFile: async () => ({ lastModified: 1, __is360: true, name: "P1.jpg" }) }, // 핀1(no=1) 1건
    { name: "P3.jpg", getFile: async () => ({ lastModified: 2, __is360: true, name: "P3.jpg" }) },  // 핀3(no=3) 다중후보①
    { name: "p-3.png", getFile: async () => ({ lastModified: 3, __is360: true, name: "p-3.png" }) }, // 핀3(no=3) 다중후보②
    { name: "P4.jpg", getFile: async () => ({ lastModified: 4, __is360: true, name: "P4.jpg" }) } // 핀4(이미 사진 있음) — 일치하는 파일이 있어도 대상 제외돼야 함
    // 핀2(no=2) 매칭 파일 없음(0건 경로)
  ];
  const rows = await PF.previewBatch("__root__", null);
  ok(rows.length === 3, "E1 대상 3건(이미 사진 있는 핀4는 제외) — " + rows.length);
  const byId = Object.fromEntries(rows.map((r) => [r.pin.id, r]));
  ok(byId.p1.status === "일치" && byId.p1.key === "001", "E1a 핀1 → 일치(인식 001) — " + JSON.stringify(byId.p1.status));
  ok(byId.p2.status === "없음", "E1b 핀2 → 없음");
  ok(byId.p3.status === "다중/확인필요" && byId.p3.candidates.length === 2, "E1c 핀3 → 다중/확인필요(2건)");
  ok(byId.p4 === undefined, "E1d 핀4(이미 사진 있음) → 일괄 대상에서 빠짐(덮어쓰기 금지)");

  const summary = await PF.runBatchConfirmed(rows);
  ok(summary.done === 1 && summary.excluded === 2, "E2 runBatchConfirmed — '일치'만 적용(done=1, excluded=2) — " + JSON.stringify(summary));
  ok(uploadCalls.length === 1 && uploadCalls[0].pinId === "p1" && uploadCalls[0].source === "폴더일괄", "E3 핀1만 등록(source=폴더일괄) — " + JSON.stringify(uploadCalls));
  ok(pins[0].imageId === "img_P1.jpg", "E4 핀1.imageId 설정됨 — " + pins[0].imageId);
  ok(pins[1].imageId == null && pins[2].imageId == null, "E5 핀2·핀3은 미등록(건너뜀)");
}
await runE();

/* ══ F. 체크박스(일괄/하나씩/자동) 구역별 저장·복원 ══════════════════════════════ */
{
  const { PF } = loadPF(pfSrc);
  ok(PF.isBatchOn("dA") === false && PF.isSingleOn("dA") === false, "F1 기본값은 OFF(구역별)");
  PF.setBatchOn("dA", true); PF.setSingleOn("dB", true);
  ok(PF.isBatchOn("dA") === true && PF.isBatchOn("dB") === false, "F2 일괄등록 — dA만 ON(구역 독립)");
  ok(PF.isSingleOn("dB") === true && PF.isSingleOn("dA") === false, "F3 하나씩등록 — dB만 ON(구역 독립)");
}

console.log("\n" + (failed ? "FAILED " + failed + "건" : "ALL PASS"));
console.log(
  "\n[뮤테이션 — 지휘자 자동 실행·EXIT=1 확인·원복, §G-2-5]\n" +
  "MUT1(1차를 끝3자리로 자름 — 지휘자 정정 2026-10-15) _fileFullNo: `const n = parseInt(d, 10);` → `const n = parseInt(d.length > 3 ? d.slice(-3) : d, 10);`  (A의 '1↔A1001.jpg(1001핀 존재)=false' 가 true로 깨짐 — 1001번 핀의 사진을 1번 핀이 가로챔)\n" +
  "MUT2(구역 키를 프로젝트 키로 되돌림) _deckKey: `(deck && deck.id != null) ? String(deck.id) : \"__root__\"` → `\"__root__\"`always (C1이 깨짐 — 구역A 핀이 구역B 폴더 안 쓰는지 구분 못 함)\n" +
  "MUT3(일괄등록 시 기존 사진 덮어쓰기) _batchTargets 필터의 mediaOf 가드 제거 → (E1 대상이 3건에서 전체 핀으로 늘어 깨짐, 기존 사진 덮어쓰기)"
);
process.exit(failed ? 1 : 0);
