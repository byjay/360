/**
 * 회귀 테스트 — FLS 폴더(.e57) 일괄 등록 (프레임워크 0 · 실행: node tests/p175-photofolder-e57.test.mjs)
 *
 * [재현] R1~R3(지휘자 실측, 발주서) — .e57 은 60_PhotoFolder._EXT_RE 가 걸러서 폴더 일괄등록에서
 * 빠졌었다. 추출 엔진(09_FLS._parseE57 grid:true + 39_FlsPano.fromGrid/toJpegBlob)은 p174 로 검증됨.
 *
 * 대상: public/js/modules/60_PhotoFolder.js — _EXT_RE(.e57 추가)·_materializeFile(E57→jpg 변환,
 * 등록 직전·매칭된 파일만)·_flsDirNotice(*.fls 원본 디렉터리 안내)·runBatchConfirmed(failures 수집).
 *
 * 실 모듈 소스(09_FLS.js·39_FlsPano.js·60_PhotoFolder.js)를 vm 에 그대로 평가한다(재구현 금지, 목 아님).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const FLS_SRC = rd("public/js/modules/09_FLS.js");
const PANO_SRC = rd("public/js/modules/39_FlsPano.js");
const pfSrc = rd("public/js/modules/60_PhotoFolder.js");

let failed = 0;
const ok = (cond, label, detail) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail).slice(0, 400) : "")); if (!cond) failed++; };

/* ══════════════════════════════════════════════════════════════
   합성 E57 빌더(p174-fls-pano.test.mjs 와 동일 바이너리 포맷 — fields 파라미터로 grid/no-grid 선택)
   ══════════════════════════════════════════════════════════════ */
function f32bits(v) { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v, true); return d.getUint32(0, true); }
function wu64(dv, off, v) { dv.setUint32(off, v >>> 0, true); dv.setUint32(off + 4, Math.floor(v / 4294967296), true); }
function align4(v) { return Math.ceil(v / 4) * 4; }

function packStream(f, values) {
  const buf = new Uint8Array(Math.ceil(f.bits * values.length / 8) + 1);
  let bit = 0;
  for (const v of values) {
    const raw = f.kind === "f32" ? f32bits(v) : (v - f.min);
    for (let i = 0; i < f.bits; i++) {
      if (Math.floor(raw / Math.pow(2, i)) % 2 === 1) buf[bit >> 3] |= 1 << (bit & 7);
      bit++;
    }
  }
  return buf.subarray(0, Math.ceil(bit / 8));
}
function dataPacket(parts) {
  const n = parts.length;
  const len = align4(6 + n * 2 + parts.reduce((s, p) => s + p.length, 0));
  const p = new Uint8Array(len);
  const dv = new DataView(p.buffer);
  p[0] = 1; p[1] = 0;
  dv.setUint16(2, len - 1, true);
  dv.setUint16(4, n, true);
  let cur = 6 + n * 2;
  parts.forEach((s, i) => { dv.setUint16(6 + i * 2, s.length, true); p.set(s, cur); cur += s.length; });
  return p;
}

/** fields: [{name,kind,bits[,min,max]}], records: [{...}], opts: {rows,cols}(격자 메타 포함 여부) */
function buildE57(fields, records, opts) {
  const proto = fields.map((f) => f.kind === "f32"
    ? `<${f.name} type="Float" precision="single"/>`
    : `<${f.name} type="Integer" minimum="${f.min}" maximum="${f.max}"/>`).join("");
  let extra = "";
  if (opts && opts.rows != null) {
    extra = '<indexBounds type="Structure"><rowMinimum type="Integer">0</rowMinimum><rowMaximum type="Integer">' + (opts.rows - 1) + '</rowMaximum>'
      + '<columnMinimum type="Integer">0</columnMinimum><columnMaximum type="Integer">' + (opts.cols - 1) + '</columnMaximum></indexBounds>'
      + '<pose type="Structure"><rotation type="Structure">'
      + '<w type="Float">1</w><x type="Float">0</x><y type="Float">0</y><z type="Float">0</z>'
      + '</rotation><translation type="Structure"><x type="Float">0</x><y type="Float">0</y><z type="Float">0</z></translation></pose>';
  }
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<e57Root type="Structure"><data3D type="Vector" allowHeterogeneousChildren="1"><vectorChild type="Structure">'
    + '<name type="String"><![CDATA[synthetic]]></name>'
    + extra
    + `<points type="CompressedVector" fileOffset="CVOFFSET__" recordCount="${records.length}">`
    + `<prototype>${proto}</prototype><codecs type="Vector" allowHeterogeneousChildren="1"/></points>`
    + '</vectorChild></data3D></e57Root>';

  const pageSize = 1024, USABLE = pageSize - 4;
  const logToPhys = (l) => Math.floor(l / USABLE) * pageSize + (l % USABLE);
  const xmlLen = Buffer.byteLength(xml, "utf8");
  const cvLogical = align4(48 + xmlLen);
  const dataLogical = cvLogical + 32;
  const xmlFinal = xml.replace("CVOFFSET__", String(logToPhys(cvLogical)).padStart(10, "0"));
  const xmlLenFinal = Buffer.byteLength(xmlFinal, "utf8");
  if (xmlLenFinal !== xmlLen) throw new Error("합성 실패: 치환 전후 길이 불일치");

  const packed = fields.map((f) => packStream(f, records.map((r) => r[f.name])));
  const N = records.length, perPacket = 6;
  const packets = [];
  for (let start = 0; start < N; start += perPacket) {
    const end = Math.min(start + perPacket, N), last = end === N;
    packets.push(dataPacket(fields.map((f, i) => packed[i].subarray(
      Math.floor(start * f.bits / 8),
      last ? Math.ceil(N * f.bits / 8) : Math.floor(end * f.bits / 8)
    ))));
  }
  const secLen = packets.reduce((s, p) => s + p.length, 0);
  const logicalLen = dataLogical + secLen;
  const pages = Math.ceil(logicalLen / USABLE);
  const physLen = pages * pageSize;
  const logical = new Uint8Array(logicalLen);
  const hdv = new DataView(logical.buffer);
  for (let i = 0; i < 8; i++) logical[i] = "ASTM-E57".charCodeAt(i);
  hdv.setUint32(8, 1, true); hdv.setUint32(12, 0, true);
  wu64(hdv, 16, physLen); wu64(hdv, 24, logToPhys(48)); wu64(hdv, 32, xmlLen); wu64(hdv, 40, pageSize);
  logical.set(new TextEncoder().encode(xmlFinal), 48);
  logical[cvLogical] = 1;
  const cdv = new DataView(logical.buffer, cvLogical, 32);
  wu64(cdv, 8, secLen); wu64(cdv, 16, logToPhys(dataLogical)); wu64(cdv, 24, 0);
  let o = dataLogical;
  for (const pk of packets) { logical.set(pk, o); o += pk.length; }

  const out = new Uint8Array(physLen);
  for (let p = 0; p < pages; p++) {
    out.set(logical.subarray(p * USABLE, Math.min((p + 1) * USABLE, logicalLen)), p * pageSize);
    out.set([0xDE, 0xAD, 0xBE, 0xEF], p * pageSize + USABLE);
  }
  return out.buffer;
}

const FIELDS_GRID = [
  { name: "cartesianX", kind: "f32", bits: 32 },
  { name: "cartesianY", kind: "f32", bits: 32 },
  { name: "cartesianZ", kind: "f32", bits: 32 },
  { name: "colorRed", kind: "int", min: 0, max: 255, bits: 8 },
  { name: "colorGreen", kind: "int", min: 0, max: 255, bits: 8 },
  { name: "colorBlue", kind: "int", min: 0, max: 255, bits: 8 },
  { name: "rowIndex", kind: "int", min: 0, max: 255, bits: 8 },
  { name: "columnIndex", kind: "int", min: 0, max: 255, bits: 8 },
  { name: "cartesianInvalidState", kind: "int", min: 0, max: 2, bits: 2 }
];
const FIELDS_NOGRID = [
  { name: "cartesianX", kind: "f32", bits: 32 },
  { name: "cartesianY", kind: "f32", bits: 32 },
  { name: "cartesianZ", kind: "f32", bits: 32 },
  { name: "colorRed", kind: "int", min: 0, max: 255, bits: 8 },
  { name: "colorGreen", kind: "int", min: 0, max: 255, bits: 8 },
  { name: "colorBlue", kind: "int", min: 0, max: 255, bits: 8 },
  { name: "cartesianInvalidState", kind: "int", min: 0, max: 2, bits: 2 }
];

function buildGridRecords(rows, cols) {
  const elOf = { 0: -45, 1: 0, 2: 45 };
  const records = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const az = c * 45 * Math.PI / 180, el = (elOf[r] || 0) * Math.PI / 180;
      const cs = Math.cos(el);
      records.push({
        cartesianX: cs * Math.cos(az), cartesianY: cs * Math.sin(az), cartesianZ: Math.sin(el),
        colorRed: 120, colorGreen: 120, colorBlue: 120, rowIndex: r, columnIndex: c, cartesianInvalidState: 0
      });
    }
  }
  return records;
}

function buildGridE57Buf() { return buildE57(FIELDS_GRID, buildGridRecords(3, 8), { rows: 3, cols: 8 }); }
function buildNoGridE57Buf() {
  return buildE57(FIELDS_NOGRID, [{ cartesianX: 1, cartesianY: 0, cartesianZ: 0, colorRed: 10, colorGreen: 10, colorBlue: 10, cartesianInvalidState: 0 }]);
}

/* ══════════════════════════════════════════════════════════════
   최소 가짜 document — canvas(FlsPano) + 일반 DOM(60_PhotoFolder, p152 관례와 동일)
   ══════════════════════════════════════════════════════════════ */
function makeFakeDoc() {
  const registry = new Map();
  function makeCanvas() {
    const c = { width: 0, height: 0, _pixels: null,
      getContext(kind) {
        if (kind !== "2d") return null;
        return {
          createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
          putImageData(imgData) { c._pixels = { width: imgData.width, height: imgData.height, data: imgData.data }; },
          getImageData(x, y, w, h) { return c._pixels || { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
          fillStyle: "", fillRect() {}, drawImage() {},
          toBlob(cb, type) { cb(new Blob([Buffer.from([0xFF, 0xD8, 0xFF, 0xD9])], { type: type || "image/jpeg" })); }
        };
      },
      toBlob(cb, type) { cb(new Blob([Buffer.from([0xFF, 0xD8, 0xFF, 0xD9])], { type: type || "image/jpeg" })); }
    };
    return c;
  }
  function makeElement(tag) {
    const el = {
      tagName: tag, value: "", textContent: "", innerHTML: "", checked: false, style: {}, dataset: {}, disabled: false,
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
    createElement: (tag) => (tag === "canvas" ? makeCanvas() : makeElement(tag)),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    body: Object.assign(makeElement("body"), {}),
    querySelectorAll: () => []
  };
  document.body.appendChild = (c) => { if (c && c.id) registry.set(c.id, c); return c; };
  return document;
}

function makeLocalStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

/** 60_PhotoFolder.js + 09_FLS.js + 39_FlsPano.js 를 같은 vm 컨텍스트에 순차 평가(실 소스, 목 아님). */
function loadPF(opts = {}) {
  const document = makeFakeDoc();
  const toasts = [];
  const uploadCalls = [];
  const State = Object.assign({ pins: [], pdfPage: 1, checkboard: true, regMode: "photo" }, opts.state || {});
  const Auth = { readonly: false };
  const PinSeries = Object.assign({
    seriesOf: (p) => (p && p.checkboard) ? "checkboard" : "content",
    mediaOf: (p) => !!(p && (p.imageId || p.pendingOpId)),
    formatNo: (no) => String(no),
    numbers: (pins, page) => new Map()
  }, opts.pinSeries || {});
  const App = { _detect360: (file, cb) => cb(true, 4096, 2048) };
  const PhotoBatch = {
    _usedPhotoNames: () => new Set(),
    _uploadOneRow: async (pin, row) => {
      uploadCalls.push({ pinId: pin.id, name: row.name });
      pin.imageId = "img_" + row.name;
      return { status: "done" };
    },
    _markUnsaved: () => {}
  };
  const UI = { renderPinList: () => {}, renderPinsOnMap: () => {} };
  const Prompt = { toast: (msg) => toasts.push(String(msg)) };
  const Projects = Object.assign({ currentProject: { id: "projT" }, currentDeck: null, decks: [], pinsForDeck: (pins) => pins }, opts.projects || {});
  const localStorage = makeLocalStorage();
  const sandbox = {
    console, Map, Set, Promise, Buffer, File, Blob, TextEncoder, TextDecoder,
    document, window: { showDirectoryPicker: undefined, document },
    localStorage, State, Auth, PinSeries, App, PhotoBatch, UI, Prompt, Projects, SyncQueue: undefined,
    THREE: undefined, Cloud: undefined
  };
  vm.createContext(sandbox);
  vm.runInContext(FLS_SRC + "\n;globalThis.FLS = FLS;", sandbox);
  vm.runInContext(PANO_SRC + "\n;globalThis.FlsPano = FlsPano;", sandbox);
  vm.runInContext(pfSrc + "\n;globalThis.__PF = PhotoFolder;", sandbox);
  return { PF: sandbox.__PF, toasts, uploadCalls, State };
}

/* ══════════════════════════════════════════════════════════════
   ① _EXT_RE — .e57 이 열거/매칭 대상 확장자에 포함됨
   ══════════════════════════════════════════════════════════════ */
console.log("\n[① _EXT_RE — .e57 포함]");
{
  const { PF } = loadPF();
  ok(PF._EXT_RE.test("X_301.e57"), "①: _EXT_RE.test('X_301.e57') = true");
  ok(PF.findMatches(301, [{ name: "X_301.e57" }]).length === 1, "①: findMatches 가 .e57 파일명을 후보로 인식");
}

/* ══════════════════════════════════════════════════════════════
   ② 가짜 폴더(핀 301·302·303 + 디렉터리 .fls) → previewBatch/runBatchConfirmed
   ══════════════════════════════════════════════════════════════ */
console.log("\n[② 가짜 FLS 폴더 — 301/302 변환·등록, noise(격자없음) 실패목록, .fls 안내]");
{
  const gridBuf1 = buildGridE57Buf();
  const gridBuf2 = buildGridE57Buf();
  const noGridBuf = buildNoGridE57Buf();

  const file301 = new File([gridBuf1], "X_301.e57", { type: "application/octet-stream" });
  const file302 = new File([gridBuf2], "X_302.e57", { type: "application/octet-stream" });
  const fileNoise = new File([noGridBuf], "noise_303.e57", { type: "application/octet-stream" });
  const flsDummy = { name: "data.wsp", webkitRelativePath: "root/scan1.fls/data.wsp" };

  const pins = [
    { id: "p301", page: 1 }, { id: "p302", page: 1 }, { id: "p303", page: 1 }
  ];
  const numbersMock = () => new Map([["p301", { no: 301 }], ["p302", { no: 302 }], ["p303", { no: 303 }]]);
  const { PF, uploadCalls } = loadPF({ state: { pins }, pinSeries: { numbers: numbersMock } });

  PF._entry("__root__").mode = "fallback";
  PF._entry("__root__").fallbackFiles = [file301, file302, fileNoise, flsDummy];

  const rows = await PF.previewBatch("__root__", null);
  ok(rows.length === 3, "②a 대상 3건(301/302/303) — " + rows.length);
  ok(rows.every((r) => r.status === "일치"), "②b 전부 '일치' 상태(파일명 매칭은 변환 전 단계) — " + JSON.stringify(rows.map((r) => r.status)));
  ok(typeof rows.notice === "string" && /FLS 원본 1개/.test(rows.notice), "②c .fls 디렉터리 안내 1줄 존재 — " + rows.notice);

  const labels = [];
  const summary = await PF.runBatchConfirmed(rows, (p) => { if (p.label) labels.push(p.label); });
  ok(summary.done === 2, "②d done=2(301·302 변환·등록 성공) — " + JSON.stringify(summary));
  ok(summary.fail === 1, "②e fail=1(noise, 격자 없음) — " + JSON.stringify(summary));
  ok(Array.isArray(summary.failures) && summary.failures.length === 1 && summary.failures[0].name === "noise_303.e57"
    && /구조화 격자 없음/.test(summary.failures[0].reason),
    "②f failures 에 noise_303.e57 사유 포함 — " + JSON.stringify(summary.failures));
  ok(labels.some((l) => /추출 중/.test(l)), "②g 진행표시에 '추출 중 n/N' 라벨 존재 — " + JSON.stringify(labels));

  ok(uploadCalls.length === 2, "②h 업로드 호출 2건(301·302) — " + JSON.stringify(uploadCalls));
  ok(uploadCalls.every((c) => /\.jpg$/.test(c.name)), "②i 등록된 파일명이 .jpg 로 변환됨 — " + JSON.stringify(uploadCalls));
  ok(uploadCalls.some((c) => c.name === "X_301.jpg") && uploadCalls.some((c) => c.name === "X_302.jpg"),
    "②j 301→X_301.jpg, 302→X_302.jpg — " + JSON.stringify(uploadCalls));
}

/* ══════════════════════════════════════════════════════════════
   ③ 일반 이미지(.jpg)는 변환 없이 그대로 통과(회귀 — 기존 동작 불변)
   ══════════════════════════════════════════════════════════════ */
console.log("\n[③ 일반 jpg 는 _materializeFile 통과(변환 없음)]");
{
  const { PF, uploadCalls } = loadPF({ state: { pins: [{ id: "p1", page: 1 }] }, pinSeries: { numbers: () => new Map([["p1", { no: 1 }]]) } });
  PF._entry("__root__").mode = "fallback";
  PF._entry("__root__").fallbackFiles = [new File([Buffer.from([1, 2, 3])], "P1.jpg", { type: "image/jpeg" })];
  const rows = await PF.previewBatch("__root__", null);
  const summary = await PF.runBatchConfirmed(rows);
  ok(summary.done === 1 && uploadCalls[0].name === "P1.jpg", "③ jpg 는 이름 불변으로 그대로 등록 — " + JSON.stringify(uploadCalls));
}

/* ══════════════════════════════════════════════════════════════
   뮤테이션 증명 — _EXT_RE 에서 e57 제거 → ① 이 실패해야 함
   ══════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션] _EXT_RE 에서 e57 를 제거하면 ①이 뒤집혀야 함");
{
  const needle = "_EXT_RE: /\\.(jpe?g|png|heic|e57)$/i,";
  const mutated = pfSrc.replace(needle, "_EXT_RE: /\\.(jpe?g|png|heic)$/i,");
  if (mutated === pfSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const document = makeFakeDoc();
    const sandbox = {
      console, Map, Set, Promise, Buffer, File, Blob, TextEncoder, TextDecoder,
      document, window: { showDirectoryPicker: undefined, document },
      localStorage: makeLocalStorage(),
      State: { pins: [], pdfPage: 1, checkboard: true, regMode: "photo" },
      Auth: { readonly: false },
      PinSeries: { seriesOf: () => "content", mediaOf: () => false, formatNo: (n) => String(n), numbers: () => new Map() },
      App: { _detect360: (f, cb) => cb(true, 4096, 2048) },
      PhotoBatch: { _usedPhotoNames: () => new Set(), _uploadOneRow: async () => ({ status: "done" }), _markUnsaved: () => {} },
      UI: { renderPinList: () => {}, renderPinsOnMap: () => {} },
      Prompt: { toast: () => {} },
      Projects: { currentProject: { id: "projT" }, currentDeck: null, decks: [], pinsForDeck: (p) => p },
      SyncQueue: undefined, THREE: undefined, Cloud: undefined
    };
    vm.createContext(sandbox);
    vm.runInContext(FLS_SRC + "\n;globalThis.FLS = FLS;", sandbox);
    vm.runInContext(PANO_SRC + "\n;globalThis.FlsPano = FlsPano;", sandbox);
    vm.runInContext(mutated + "\n;globalThis.__PF = PhotoFolder;", sandbox);
    const PF2 = sandbox.__PF;
    const broke = PF2.findMatches(301, [{ name: "X_301.e57" }]).length === 0;
    ok(broke, "_EXT_RE 에서 e57 제거 시 .e57 파일이 매칭 후보에서 빠짐(뒤집힘 확인) → got " + PF2.findMatches(301, [{ name: "X_301.e57" }]).length);
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
