/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p152-photo-folder-match.test.mjs)
 *
 * 대상: WO 20261013-photofolder — public/js/modules/60_PhotoFolder.js
 * 마스터 요청(2026-10-13, 음성): "지정한 폴더에서 핀 번호와 일치하는 360 사진 — 핀만 찍으면
 * 바로 찾아서 '이 사진을 등록할까요?' … 다음부터 핀만 찍으면 … 자동으로 등록하는 기능까지".
 *
 * A. 순수 매칭(_normalizeToken/isMatch/findMatches) — 대소문자·앞자리0·구분자·P접두·확장자 필터.
 * B. handlePinPlaced() 분기 — 폴더 미지정/CHECKER계열/열람자/기존사진 있음 → false(폴백).
 *    0건 → toast + false. 1건+자동OFF → 확인모달(3버튼). 1건+자동ON → 묻지 않고 즉시 등록.
 *    다중후보 → 선택모달(모달에서 고른 것만 등록, 자동등록 금지).
 * C. 뮤테이션 3건(실제 파일을 일시적으로 고쳐 재실행 → FAIL(EXIT=1) 확인 후 즉시 원복) —
 *    지휘자가 수동으로 수행(이 파일은 패치 대상 문자열만 안내). 아래 MUT1/2/3 참조.
 *
 * 실 모듈 소스(60_PhotoFolder.js)를 vm 에 그대로 평가한다(재구현 금지, 목 아님) — 기존 p6 관례와 동일.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const pfSrc = rd("public/js/modules/60_PhotoFolder.js");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };

/* ── 최소 가짜 DOM(p99 makeRegistryDoc 관례와 동일) ── */
function makeFakeDoc() {
  const registry = new Map();
  function makeElement() {
    const el = {
      value: "", textContent: "", innerHTML: "", checked: false, style: {}, dataset: {},
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
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

function loadPF(src, opts = {}) {
  const { document } = makeFakeDoc();
  const toasts = [];
  const uploadCalls = [];
  const State = Object.assign({ pins: [], pdfPage: 1, checkboard: true, regMode: "photo" }, opts.state || {});
  const Auth = Object.assign({ readonly: false }, opts.auth || {});
  const PinSeries = {
    seriesOf: (p) => (p && p.checkboard) ? "checkboard" : "content",
    mediaOf: (p) => !!(p && (p.imageId || p.pendingOpId)),
    formatNo: (no, series) => (series === "checkboard" ? String(no) : ("P" + no)),
    numbers: (pins, page) => {
      const map = new Map();
      let n = 0;
      (pins || []).forEach((p) => { if ((p.page || 1) !== page) return; n++; map.set(p.id, { no: n, series: "content" }); });
      return map;
    }
  };
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
  const Projects = { currentProject: { id: "projT" } };
  const sandbox = {
    console, Map, Set, Promise, document,
    window: { showDirectoryPicker: undefined },
    localStorage: makeLocalStorage(),
    State, Auth, PinSeries, App, PhotoBatch, UI, Prompt, Projects,
    SyncQueue: undefined
  };
  sandbox.window.document = document;
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__PF = PhotoFolder;", sandbox);
  return { PF: sandbox.__PF, toasts, uploadCalls, State, Auth, document };
}

/* ══ A. 순수 매칭 ══════════════════════════════════════════════ */
{
  const { PF } = loadPF(pfSrc);
  const cases = [
    [12, "P12.jpg", true], [12, "p012.JPG", true], [12, "12.jpg", true], [12, "P-12.jpeg", true],
    [12, "P_12.jpg", true], [12, "P120.jpg", false], [12, "P1.jpg", false], [12, "p13.jpg", false]
  ];
  cases.forEach(([no, name, expect]) => {
    ok(PF.isMatch(no, name) === expect, "A isMatch(" + no + ", '" + name + "') = " + expect);
  });
  ok(PF.findMatches(12, [{ name: "P12.jpg" }, { name: "P12.txt" }, { name: "p012.png" }]).length === 2,
    "A findMatches — 확장자 필터(jpg/png만, txt 제외) + 번호일치 2건");
}

/* ══ B. handlePinPlaced 분기 ══════════════════════════════════ */
async function run() {
  // B1: 폴더 미지정 → false(폴백)
  {
    const { PF } = loadPF(pfSrc);
    const pin = { id: "p1", page: 1 };
    const handled = await PF.handlePinPlaced(pin);
    ok(handled === false, "B1 폴더 미지정 → false(기존 폴백으로)");
  }
  // 공통: fallback 폴더 지정 — P1/P2(1매치) + P3 2매치(dup12/dup12b) 시나리오
  const mkPF = (state) => {
    const { PF, toasts, uploadCalls, Auth, document } = loadPF(pfSrc, { state });
    PF._mode = "fallback";
    PF._fallbackFiles = [{ name: "a" }]; // hasFolder() true 용(실제 getFile 안 씀, _listEntries 직접 오버라이드)
    PF._listEntries = async () => [
      { name: "P1.jpg", getFile: async () => ({ lastModified: 1, __is360: true, name: "P1.jpg" }) },
      { name: "p02.jpg", getFile: async () => ({ lastModified: 2, __is360: true, name: "p02.jpg" }) },
      { name: "P3.jpg", getFile: async () => ({ lastModified: 3, __is360: true, name: "P3.jpg" }) },
      { name: "p-3.png", getFile: async () => ({ lastModified: 4, __is360: true, name: "p-3.png" }) }
    ];
    return { PF, toasts, uploadCalls, Auth, document };
  };

  // B2: CHECKER 계열 핀 → false
  {
    const { PF } = mkPF();
    const handled = await PF.handlePinPlaced({ id: "c1", page: 1, checkboard: true });
    ok(handled === false, "B2 CHECKER 계열 핀 → false(대상 아님)");
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
    PF.setAuto(true);
    const pin = { id: "p2", page: 1 };
    const handled = await PF.handlePinPlaced(pin);
    ok(handled === true && uploadCalls.length === 1 && uploadCalls[0].source === "폴더자동",
      "B7 1건+자동ON → 확인 없이 즉시 등록(source=폴더자동) — " + JSON.stringify(uploadCalls));
  }
  // B8: 다중 후보(핀 번호 3 → P3.jpg·p-3.png 2건) → 선택모달, 자동등록 0
  {
    const { PF, uploadCalls } = mkPF({ pins: [{}, {}, { id: "p3", page: 1 }] }); // no=3
    PF.setAuto(true); // 자동ON 이어도 다중 후보는 묻는다
    const pin = { id: "p3", page: 1 };
    const handled = await PF.handlePinPlaced(pin);
    ok(handled === true, "B8a 다중 후보 → true(선택모달로 처리)");
    ok(uploadCalls.length === 0, "B8b 다중 후보 → 자동ON 이어도 즉시 등록 0건(선택 전)");
  }
}
await run();

console.log("\n" + (failed ? "FAILED " + failed + "건" : "ALL PASS"));
console.log(
  "\n[뮤테이션 지침 — 지휘자 수동 3건, 각각: 파일 수정 → 재실행 FAIL(EXIT=1) 확인 → 즉시 원복 → 재실행 PASS]\n" +
  "MUT1(앞자리0 무시 제거)  _normalizeToken: `return String(parseInt(t, 10));` → `return t;`  (A의 'p012.JPG'→true 케이스가 false로 깨짐)\n" +
  "MUT2(자동ON 무시)        handlePinPlaced: `if (this.isAutoOn()) {` → `if (false) {`        (B7이 즉시등록 대신 확인모달로 깨짐)\n" +
  "MUT3(다중후보 자동등록)  handlePinPlaced: `if (candidates.length > 1) {` → `if (false) {`   (B8b 업로드 0건 기대가 1건으로 깨짐)"
);
process.exit(failed ? 1 : 0);
