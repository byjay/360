/**
 * 회귀 테스트 — 핀 팝업 단건 첨부 3종 (프레임워크 0 · 실행: node tests/p181-singleattach.test.mjs)
 *
 * [재현] 발주서(지휘자 실측 + 직전 에이전트 보고 근거):
 *   R1 27_PinActionPop.js:442 _registerPhotoFile(file) — 360 판정은 App._detect360(2:1 이미지)만.
 *      .fls/.e57 파일을 핀 팝업에서 첨부하면 이미지가 아니라 실패(변환 SoT 는 39_FlsPano.js 에
 *      이미 있음 — fromFlsOle/fromGrid/padToEquirect/toJpegBlob, 60_PhotoFolder._materializeFile 이
 *      묶어 쓰던 로직을 FlsPano.toPanoFile(file) 로 끌어올려 27 에서도 재사용).
 *   R2 6f7afb6(offlinephoto 에이전트 보고) — 핀 팝업 단건 업로드(_registerPhotoFile → Cloud.uploadImage)는
 *      오프라인 큐가 없음(업로드 실패 표시만). 사진 폴더/촬영 경로가 쓰는 같은 SyncQueue(05_SyncQueue.js,
 *      enqueue→pendingOpId)로 통일.
 *   R3 7cafcbb(pindots 에이전트 보고) — 점 마커 탭 히트영역(24px 패드)이 겹치면 DOM 적층(topmost) 순서로
 *      선택 — 가장 가까운 핀이 아님. 10_MapCtrl.nearestByRect(순수 거리계산, SoT)로 화면 거리 최솟값을 고른다.
 *
 * 🔴 목 금지 — 실제 소스(39_FlsPano.js·09_FLS.js·05_SyncQueue.js·13_Notes.js·27_PinActionPop.js·
 *   10_MapCtrl.js·11_UI.js)를 vm 에 그대로 평가해 검증한다(p178/p87/p117 관례와 동일). canvas(npm,
 *   기존 설치)로 실제 JPEG 인코딩을 수행 — drawImage/toBlob 을 가짜로 흉내내지 않는다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "canvas";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const FLS_SRC = rd("public/js/modules/09_FLS.js");
const PANO_SRC = rd("public/js/modules/39_FlsPano.js");
const SQ_SRC = rd("public/js/modules/05_SyncQueue.js");
const NOTES_SRC = rd("public/js/modules/13_Notes.js");
const PAP_SRC = rd("public/js/modules/27_PinActionPop.js");
const MAPCTRL_SRC = rd("public/js/modules/10_MapCtrl.js");
const UI_SRC = rd("public/js/modules/11_UI.js");

let failed = 0;
const ok = (cond, label, detail) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail).slice(0, 400) : ""));
  if (!cond) failed++;
};

/* ══════════════════════════════════════════════════════════════
   .fls(OLE2) 합성 픽스처 — p178-fls-ole-preview.test.mjs 와 동일(재구현 금지, 복붙 재사용)
   ══════════════════════════════════════════════════════════════ */
function buildFlsFixture(mainBytes, jpgBytes) {
  const SECTOR = 512, MINI = 64, CUTOFF = 4096;
  const FREE = 0xFFFFFFFF, EOC = 0xFFFFFFFE;
  const main = { name: "Main", data: mainBytes };
  const jpg = { name: "previewColor.jpg", data: jpgBytes };
  const nonEmpty = [main, jpg].filter((s) => s.data.length > 0);
  const miniArr = nonEmpty.filter((s) => s.data.length < CUTOFF);
  const regularArr = nonEmpty.filter((s) => s.data.length >= CUTOFF);

  let moff = 0;
  miniArr.forEach((s) => { s._miniStart = moff / MINI; s._miniCount = Math.ceil(s.data.length / MINI); moff += s._miniCount * MINI; });
  const miniContainerLen = moff;
  const miniContainer = new Uint8Array(miniContainerLen);
  miniArr.forEach((s) => miniContainer.set(s.data, s._miniStart * MINI));
  const numMiniSectorsUsed = miniContainerLen / MINI;
  const miniFat = new Int32Array(numMiniSectorsUsed);
  miniArr.forEach((s) => { for (let i = 0; i < s._miniCount; i++) miniFat[s._miniStart + i] = (i < s._miniCount - 1) ? (s._miniStart + i + 1) : EOC; });
  const miniFatBytes = new Uint8Array(Math.max(1, Math.ceil(numMiniSectorsUsed * 4 / SECTOR)) * SECTOR);
  { const dv = new DataView(miniFatBytes.buffer); for (let i = 0; i < numMiniSectorsUsed; i++) dv.setUint32(i * 4, miniFat[i], true); }

  const D = 1;
  const MF = Math.ceil(miniFatBytes.length / SECTOR);
  const MS = Math.max(1, Math.ceil(miniContainerLen / SECTOR));
  const idDir = 1, idMiniFat = idDir + D, idMiniStream = idMiniFat + MF, idRegularBase = idMiniStream + MS;

  let roff = 0;
  regularArr.forEach((s) => { s._regStart = idRegularBase + roff; s._regCount = Math.ceil(s.data.length / SECTOR); roff += s._regCount; });
  const BS = Math.max(1, roff);

  const fat = new Int32Array(128).fill(FREE);
  fat[0] = 0xFFFFFFFD;
  fat[idDir] = EOC;
  for (let i = 0; i < MF; i++) fat[idMiniFat + i] = (i < MF - 1) ? (idMiniFat + i + 1) : EOC;
  for (let i = 0; i < MS; i++) fat[idMiniStream + i] = (i < MS - 1) ? (idMiniStream + i + 1) : EOC;
  regularArr.forEach((s) => { for (let i = 0; i < s._regCount; i++) fat[s._regStart + i] = (i < s._regCount - 1) ? (s._regStart + i + 1) : EOC; });

  const dirBuf = new Uint8Array(D * SECTOR);
  const dv = new DataView(dirBuf.buffer);
  function writeName(off, name) {
    for (let i = 0; i < name.length; i++) dv.setUint16(off + i * 2, name.charCodeAt(i), true);
    dv.setUint16(off + 64, (name.length + 1) * 2, true);
  }
  function entryFor(s) {
    if (!s || s.data.length === 0) return { startSector: -1, size: 0 };
    if (s._miniStart != null) return { startSector: s._miniStart, size: s.data.length };
    return { startSector: s._regStart, size: s.data.length };
  }
  function writeEntry(idx, name, type, left, right, child, startSector, size) {
    const off = idx * 128;
    writeName(off, name);
    dv.setUint8(off + 66, type);
    dv.setUint8(off + 67, 1);
    dv.setInt32(off + 68, left, true);
    dv.setInt32(off + 72, right, true);
    dv.setInt32(off + 76, child, true);
    dv.setInt32(off + 116, startSector, true);
    dv.setUint32(off + 120, size >>> 0, true);
    dv.setUint32(off + 124, 0, true);
  }
  const mainE = entryFor(main), jpgE = entryFor(jpg);
  writeEntry(0, "Root Entry", 5, -1, -1, 1, idMiniStream, miniContainerLen);
  writeEntry(1, "Main", 2, -1, 2, -1, mainE.startSector, mainE.size);
  writeEntry(2, "Previews", 1, -1, -1, 3, -1, 0);
  writeEntry(3, "previewColor.jpg", 2, -1, -1, -1, jpgE.startSector, jpgE.size);

  const headerLen = SECTOR;
  const fatSectorBytes = new Uint8Array(SECTOR);
  { const fdv = new DataView(fatSectorBytes.buffer); for (let i = 0; i < 128; i++) fdv.setInt32(i * 4, fat[i], true); }

  const msBuf = new Uint8Array(MS * SECTOR);
  msBuf.set(miniContainer, 0);
  const regularBuf = new Uint8Array(BS * SECTOR);
  regularArr.forEach((s) => regularBuf.set(s.data, (s._regStart - idRegularBase) * SECTOR));

  const total = headerLen + SECTOR + dirBuf.length + miniFatBytes.length + msBuf.length + regularBuf.length;
  const out = new Uint8Array(total);
  const hdv = new DataView(out.buffer);
  const SIG = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
  SIG.forEach((b, i) => out[i] = b);
  hdv.setUint16(24, 0x003E, true);
  hdv.setUint16(26, 3, true);
  hdv.setUint16(28, 0xFFFE, true);
  hdv.setUint16(30, 9, true);
  hdv.setUint16(32, 6, true);
  hdv.setUint32(40, 0, true);
  hdv.setUint32(44, 1, true);
  hdv.setInt32(48, idDir, true);
  hdv.setUint32(56, CUTOFF, true);
  hdv.setInt32(60, idMiniFat, true);
  hdv.setUint32(64, MF, true);
  hdv.setInt32(68, EOC, true);
  hdv.setUint32(72, 0, true);
  hdv.setInt32(76, 0, true);
  for (let i = 1; i < 109; i++) hdv.setInt32(76 + i * 4, FREE, true);

  let o = headerLen;
  out.set(fatSectorBytes, o); o += SECTOR;
  out.set(dirBuf, o); o += dirBuf.length;
  out.set(miniFatBytes, o); o += miniFatBytes.length;
  out.set(msBuf, o); o += msBuf.length;
  out.set(regularBuf, o); o += regularBuf.length;
  return out.buffer;
}
function mainText(startThetaRad, endThetaRad) {
  return new TextEncoder().encode("/** iQscene: Scan Data **/\nStartTheta " + startThetaRad + "\nEndTheta " + endThetaRad + "\n");
}
async function makeJpeg(w, h, rgb) {
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  const id = ctx.createImageData(w, h);
  for (let i = 0; i < id.data.length; i += 4) {
    id.data[i] = (rgb[0] + Math.floor(Math.random() * 256)) % 256;
    id.data[i + 1] = (rgb[1] + Math.floor(Math.random() * 256)) % 256;
    id.data[i + 2] = (rgb[2] + Math.floor(Math.random() * 256)) % 256;
    id.data[i + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return c.toBuffer("image/jpeg", { quality: 1 });
}
function makeCanvasDoc() {
  return {
    createElement(tag) {
      if (tag !== "canvas") return { style: {} };
      const c = createCanvas(1, 1);
      c.toBlob = (cb, type, q) => cb(c.toBuffer(type === "image/png" ? "image/png" : "image/jpeg", { quality: q == null ? 0.92 : q }));
      return c;
    }
  };
}

/* ══════════════════════════════════════════════════════════════
   E57 구조화 격자 합성 픽스처 — p174-fls-pano.test.mjs 와 동일(재구현 금지, 복붙 재사용).
   withGrid=false 면 rowIndex/columnIndex 필드를 빼 "격자 없음"(토PanoFile 실패 사유)을 만든다.
   ══════════════════════════════════════════════════════════════ */
function f32bits(v) { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v, true); return d.getUint32(0, true); }
function wu64(dv, off, v) { dv.setUint32(off, v >>> 0, true); dv.setUint32(off + 4, Math.floor(v / 4294967296), true); }
function align4(v) { return Math.ceil(v / 4) * 4; }
function fieldsFor(withGrid) {
  const base = [
    { name: "cartesianX", kind: "f32", bits: 32 },
    { name: "cartesianY", kind: "f32", bits: 32 },
    { name: "cartesianZ", kind: "f32", bits: 32 },
    { name: "colorRed", kind: "int", min: 0, max: 255, bits: 8 },
    { name: "colorGreen", kind: "int", min: 0, max: 255, bits: 8 },
    { name: "colorBlue", kind: "int", min: 0, max: 255, bits: 8 }
  ];
  if (withGrid) base.push({ name: "rowIndex", kind: "int", min: 0, max: 255, bits: 8 }, { name: "columnIndex", kind: "int", min: 0, max: 255, bits: 8 });
  return base;
}
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
function buildE57({ withGrid }) {
  const FIELDS = fieldsFor(withGrid);
  const rows = 2, cols = 4;
  const records = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const rec = { cartesianX: 1 + c * 0.1, cartesianY: 0.5 + r * 0.1, cartesianZ: 0.2, colorRed: 10 + c * 10, colorGreen: 20, colorBlue: 30 };
      if (withGrid) { rec.rowIndex = r; rec.columnIndex = c; }
      records.push(rec);
    }
  }
  const proto = FIELDS.map((f) => f.kind === "f32"
    ? `<${f.name} type="Float" precision="single"/>`
    : `<${f.name} type="Integer" minimum="${f.min}" maximum="${f.max}"/>`).join("");
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<e57Root type="Structure"><data3D type="Vector" allowHeterogeneousChildren="1"><vectorChild type="Structure">'
    + '<name type="String"><![CDATA[synthetic]]></name>'
    + (withGrid
      ? ('<indexBounds type="Structure"><rowMinimum type="Integer">0</rowMinimum><rowMaximum type="Integer">' + (rows - 1)
        + '</rowMaximum><columnMinimum type="Integer">0</columnMinimum><columnMaximum type="Integer">' + (cols - 1) + '</columnMaximum></indexBounds>')
      : '')
    + `<points type="CompressedVector" fileOffset="CVOFFSET__" recordCount="${records.length}">`
    + `<prototype>${proto}</prototype><codecs type="Vector" allowHeterogeneousChildren="1"/></points>`
    + '</vectorChild></data3D></e57Root>';

  const pageSize = 1024, USABLE = pageSize - 4;
  const logToPhys = (l) => Math.floor(l / USABLE) * pageSize + (l % USABLE);
  const xmlLen = Buffer.byteLength(xml, "utf8");
  const cvLogical = align4(48 + xmlLen);
  const dataLogical = cvLogical + 32;
  const xmlFinal = xml.replace("CVOFFSET__", String(logToPhys(cvLogical)).padStart(10, "0"));
  const packed = FIELDS.map((f) => packStream(f, records.map((r) => r[f.name])));
  const N = records.length, perPacket = 6;
  const packets = [];
  for (let start = 0; start < N; start += perPacket) {
    const end = Math.min(start + perPacket, N), last = end === N;
    packets.push(dataPacket(FIELDS.map((f, i) => packed[i].subarray(
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

function loadPanoAndFls(panoSrc, flsSrc) {
  const createImageBitmap = async (blob) => loadImage(Buffer.from(await blob.arrayBuffer()));
  const sandbox = { console, Buffer, File, Blob, TextEncoder, TextDecoder, createImageBitmap, document: makeCanvasDoc(), Prompt: { confirm: async () => true } };
  vm.createContext(sandbox);
  vm.runInContext((flsSrc || FLS_SRC) + "\n;globalThis.FLS = FLS;", sandbox);
  vm.runInContext((panoSrc || PANO_SRC) + "\n;globalThis.FlsPano = FlsPano;", sandbox);
  return sandbox.FlsPano;
}

/* ══════════════════════════════════════════════════════════════
   ① FlsPano.toPanoFile — .fls / .e57 / 그 외 확장자
   ══════════════════════════════════════════════════════════════ */
async function testToPanoFile() {
  console.log("\n[① FlsPano.toPanoFile — .fls/.e57 변환, 그 외 통과]");
  const FlsPano = loadPanoAndFls();

  // .fls 성공
  const mainBytes = mainText(1.570796327, -1.049611926);
  const jpgBytes = await makeJpeg(200, 140, [40, 160, 220]);
  const flsBuf = buildFlsFixture(mainBytes, jpgBytes);
  const flsFile = new File([flsBuf], "scan_7.fls", { type: "application/octet-stream" });
  const r1 = await FlsPano.toPanoFile(flsFile);
  ok(r1.ok === true, "①a .fls → ok:true", r1);
  ok(r1.file instanceof File && /\.jpg$/.test(r1.file.name), "①b .fls → .jpg File 반환 — " + (r1.file && r1.file.name));

  // .fls 실패(컬러 미리보기 없음) → 사유 반환(조용한 실패 금지)
  const badFlsBuf = buildFlsFixture(mainBytes, new Uint8Array(0));
  const badFlsFile = new File([badFlsBuf], "scan_bad.fls", { type: "application/octet-stream" });
  const r2 = await FlsPano.toPanoFile(badFlsFile);
  ok(r2.ok === false && /미리보기 없음/.test(r2.reason), "①c 컬러 미리보기 없는 .fls → 사유 반환 — " + JSON.stringify(r2));

  // .e57 구조화 격자 있음 → 성공
  const gridBuf = buildE57({ withGrid: true });
  const gridFile = new File([gridBuf], "scan_grid.e57", { type: "application/octet-stream" });
  const r3 = await FlsPano.toPanoFile(gridFile);
  ok(r3.ok === true, "①d 구조화 격자 .e57 → ok:true", r3);
  ok(r3.file instanceof File && /\.jpg$/.test(r3.file.name), "①e .e57 → .jpg File 반환 — " + (r3.file && r3.file.name));

  // .e57 구조화 격자 없음 → 사유 반환
  const plainBuf = buildE57({ withGrid: false });
  const plainFile = new File([plainBuf], "scan_plain.e57", { type: "application/octet-stream" });
  const r4 = await FlsPano.toPanoFile(plainFile);
  ok(r4.ok === false && /구조화 격자 없음/.test(r4.reason), "①f 격자 없는 .e57 → 사유 반환 — " + JSON.stringify(r4));

  // 그 외 확장자 → 그대로 통과(변환 없음)
  const plainJpg = new File([await makeJpeg(10, 10, [1, 2, 3])], "normal.jpg", { type: "image/jpeg" });
  const r5 = await FlsPano.toPanoFile(plainJpg);
  ok(r5.ok === true && r5.file === plainJpg, "①g 일반 .jpg → 변환 없이 그대로 통과");
}

/* ══════════════════════════════════════════════════════════════
   ② 27_PinActionPop._registerPhotoFile — .fls 첨부 통합 + 오프라인 큐 폴백
   ══════════════════════════════════════════════════════════════ */
function makeElement(id) {
  const el = {
    id, value: "", textContent: "", innerHTML: "", src: "", files: null, dataset: {},
    style: {}, _classes: new Set(), _listeners: {},
    classList: {
      add: (c) => el._classes.add(c), remove: (c) => el._classes.delete(c),
      toggle: (c, f) => { if (f) el._classes.add(c); else el._classes.delete(c); },
      contains: (c) => el._classes.has(c)
    },
    addEventListener(type, fn) { (el._listeners[type] = el._listeners[type] || []).push(fn); },
    querySelector() { return null; }, querySelectorAll() { return []; }
  };
  return el;
}
/** FlsPano.toPanoFile(canvas 경로) 가 쓰는 document.createElement("canvas") 는 실제 canvas(npm) 가 필요
 *  — 그 외 태그는 가벼운 가짜 엘리먼트로 충분(p178 makeCanvasDoc 관례와 동일). */
function canvasAwareCreateElement(tag) {
  if (tag !== "canvas") return makeElement("__anon__");
  const c = createCanvas(1, 1);
  c.toBlob = (cb, type, q) => cb(c.toBuffer(type === "image/png" ? "image/png" : "image/jpeg", { quality: q == null ? 0.92 : q }));
  return c;
}
function makePapSandbox({ online }) {
  const registry = new Map();
  const getElementById = (id) => { if (!registry.has(id)) registry.set(id, makeElement(id)); return registry.get(id); };
  const document = { getElementById, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], createElement: canvasAwareCreateElement };
  const lsMap = new Map();
  const localStorage = {
    getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
    setItem: (k, v) => lsMap.set(k, String(v)),
    removeItem: (k) => lsMap.delete(k)
  };
  const State = { pins: [], mode: "designer", currentDeploymentId: "dep1", pinEditUnlocked: null };
  const enqueueCalls = [];
  const App = {
    pinHasContent(p) { return !!(p && (p.imageId || p.imageUrl)); },
    pinHasMedia(p) { return !!(p && (p.imageId || p.imageUrl || p.pendingOpId)); },
    _dirty: false, _markDirty() { App._dirty = true; },
    _keepLocal() {}, editPin() {}, deletePin() {}, focusPin() {}, setActivePin() {},
    _autoSave() { throw new Error("자동저장 OFF 정책 위반"); },
    // 실 판정(20_App.js._detect360)은 이미지 디코딩 — 여기선 파일명 기준 스텁(변환 전 .fls/.e57
    // 원본은 이미지가 아니므로 false, 변환 후 .jpg 는 true — R1 미적용 시 실패를 드러내는 핵심 스텁).
    _detect360(file, cb) { cb(/\.(jpe?g|png)$/i.test((file && file.name) || "")); }
  };
  const Auth = { isDesigner: true, headers: () => ({}) };
  const Prompt = { toast() {}, ask: async () => null };
  const Cloud = {
    _cache: {},
    async resizeImage() { return { dataURL: "data:image/jpeg;base64,AAAA", width: 2048, height: 1024 }; },
    async uploadImage() { if (!online) throw new Error("network down"); return "img-uploaded-1"; }
  };
  const UI = { renderPinsOnMap() {}, renderPinList() {}, escapeHtml: (s) => String(s == null ? "" : s), $: (id) => getElementById(id) };
  const Inspector = { showPin() {} };
  const navigator = { onLine: online };
  const sandbox = {
    console, Math, JSON, Promise, setTimeout, clearTimeout, URL, Buffer, File, Blob, TextEncoder, TextDecoder,
    document, State, App, Auth, Prompt, Cloud, UI, Inspector, navigator, localStorage,
    createImageBitmap: async (blob) => loadImage(Buffer.from(await blob.arrayBuffer()))
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(FLS_SRC + "\n;globalThis.FLS = FLS;", sandbox);
  vm.runInContext(PANO_SRC + "\n;globalThis.FlsPano = FlsPano;", sandbox);
  vm.runInContext(SQ_SRC + "\n;globalThis.SyncQueue = SyncQueue;", sandbox);
  vm.runInContext(NOTES_SRC + "\n;globalThis.Notes = Notes;", sandbox);
  vm.runInContext(PAP_SRC + "\n;globalThis.__PAP = PinActionPop;", sandbox);
  sandbox.__PAP.init();
  return { PinActionPop: sandbox.__PAP, State, App, Cloud, SyncQueue: sandbox.SyncQueue, getElementById, enqueueCalls };
}
function makePin(overrides) { return Object.assign({ id: "p1", page: 1, x: 10, y: 10, label: "핀1" }, overrides); }

async function testPinActionPopIntegration(papSrc) {
  console.log("\n[② 27_PinActionPop._registerPhotoFile — .fls 첨부(R1) + 오프라인 큐(R2)]");
  {
    // R1: 360 탭에서 .fls 첨부 → 변환되어 등록 성공
    const { PinActionPop, State } = makePapSandbox({ online: true });
    const pin = makePin({});
    State.pins = [pin];
    PinActionPop.open(pin.id);
    PinActionPop._selectRegCategory("theta");
    const mainBytes = mainText(1.570796327, -1.049611926);
    const jpgBytes = await makeJpeg(200, 140, [40, 160, 220]);
    const flsBuf = buildFlsFixture(mainBytes, jpgBytes);
    const flsFile = new File([flsBuf], "scan_1.fls", { type: "application/octet-stream" });
    await PinActionPop._registerPhotoFile(flsFile);
    ok(pin.imageId === "img-uploaded-1", "②a .fls 첨부 → 변환 후 업로드 성공(Cloud.uploadImage 재사용)", pin);
    ok(pin.is360 === true, "②b 360 탭 등록이므로 is360=true");
  }
  {
    // R2: 온라인 실패/오프라인 → SyncQueue 큐 적재 + pendingOpId
    const { PinActionPop, State, getElementById, SyncQueue } = makePapSandbox({ online: false });
    const pin = makePin({ id: "p2" });
    State.pins = [pin];
    PinActionPop.open(pin.id);
    await PinActionPop._registerPhotoFile({ name: "photo.jpg" });
    ok(!!pin.pendingOpId, "②c 오프라인 첨부 → pin.pendingOpId 세팅됨(SyncQueue 큐 적재)", pin);
    ok(pin.pendingSync === true, "②d pin.pendingSync=true");
    ok(!pin.imageId, "②e 오프라인이면 imageId 는 아직 없음");
    const all = await SyncQueue.all();
    ok(all.some((o) => o.opId === pin.pendingOpId && o.kind === "image"), "②f SyncQueue 큐에 kind:'image' op 적재됨 — " + JSON.stringify(all));
    ok(/오프라인 저장됨/.test(getElementById("pap-photo-status").textContent), "②g 상태문구 '오프라인 저장됨' 표시");
  }
}

/* ══════════════════════════════════════════════════════════════
   ③ MapCtrl.nearestByRect + UI._resolveTapPin — 겹친 핀 탭패드에서 가까운 핀 선택
   ══════════════════════════════════════════════════════════════ */
/* ── 실행 ───────────────────────────────────────────────────────── */
async function main() {
  await testToPanoFile();
  await testPinActionPopIntegration(PAP_SRC);

  // ③ MapCtrl/UI — document.elementsFromPoint 를 vm 컨텍스트에 직접 주입해 검증
  console.log("\n[③ 겹친 핀 탭패드 — 화면 거리 최근접 핀 선택(R3), 실제 주입 검증]");
  {
    const document = {
      getElementById() { return null; }, addEventListener() {}, querySelector: () => null,
      querySelectorAll() { return []; }, createElement: () => makeElement("__anon__"),
      body: { appendChild() {} }, elementsFromPoint: null
    };
    const State = { pins: [], zoom: 1, pan: { x: 0, y: 0 } };
    const sandbox = { console, document, State };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(MAPCTRL_SRC + "\n;globalThis.MapCtrl = MapCtrl;", sandbox);
    vm.runInContext(UI_SRC + "\n;globalThis.UI = UI;", sandbox);
    const UI = sandbox.UI;
    const pinA = { id: "A" }, pinB = { id: "B" };
    State.pins = [pinA, pinB];
    const markerA = { classList: { contains: (c) => c === "pin-marker" }, dataset: { id: "A" }, getBoundingClientRect: () => ({ left: 90, top: 90, width: 20, height: 20 }) };
    const markerB = { classList: { contains: (c) => c === "pin-marker" }, dataset: { id: "B" }, getBoundingClientRect: () => ({ left: 130, top: 130, width: 20, height: 20 }) };
    document.elementsFromPoint = (x, y) => [markerB, markerA]; // topmost=B, 실제로는 A가 더 가까움
    const resolvedNear = UI._resolveTapPin({ clientX: 105, clientY: 102 }, pinB);
    ok(resolvedNear === pinA, "③d 겹친 탭패드 — topmost(B) 대신 실제 더 가까운 A 로 교체됨");

    // 후보가 1개뿐이면 원래 타깃 그대로(회귀 0)
    document.elementsFromPoint = (x, y) => [markerB];
    const resolvedSingle = UI._resolveTapPin({ clientX: 135, clientY: 132 }, pinB);
    ok(resolvedSingle === pinB, "③e 후보 1개 → 원래 타깃 그대로");

    // elementsFromPoint 미지원 환경(테스트 셸 등) → 원래 타깃 그대로(회귀 0)
    document.elementsFromPoint = undefined;
    const resolvedNoSupport = UI._resolveTapPin({ clientX: 105, clientY: 102 }, pinB);
    ok(resolvedNoSupport === pinB, "③f elementsFromPoint 미지원 → 원래 타깃 그대로");
  }

  /* ══════════════════════════════════════════════════════════════
     뮤테이션 증명
     ══════════════════════════════════════════════════════════════ */
  console.log("\n[뮤테이션 R1] .fls/.e57 변환 전처리를 제거하면 ②a가 실패해야 함(원본 .fls 가 그대로 detect360에 들어가 거부됨)");
  {
    const needle = `      // [WO 20261022-singleattach R1] .fls/.e57 스캔 파일 첨부 — 39_FlsPano.toPanoFile(SoT, 60_PhotoFolder
      // ._materializeFile 과 동일 변환) 로 360 사진으로 바꿔 아래 일반 등록 경로에 그대로 태운다.
      if (/\\.(fls|e57)$/i.test(file.name || "")) {
        if (statusEl) statusEl.textContent = "스캔 파일(" + file.name + ") 변환 중…";
        if (typeof FlsPano === "undefined" || !FlsPano.toPanoFile) {
          if (errEl) { errEl.textContent = "스캔 변환 모듈을 찾지 못했습니다(FlsPano 미로드)."; errEl.classList.remove("hidden"); }
          if (statusEl) statusEl.textContent = "";
          return;
        }
        const conv = await FlsPano.toPanoFile(file);
        if (!conv || !conv.ok) {
          if (statusEl) statusEl.textContent = "";
          if (errEl) { errEl.textContent = (conv && conv.reason) || "스캔 변환 실패"; errEl.classList.remove("hidden"); }
          return; // 조용한 실패 금지 — 이유를 보여주고 중단
        }
        file = conv.file;
      }
`;
    const mutated = PAP_SRC.replace(needle, "");
    if (mutated === PAP_SRC) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
    else {
      const sandbox = makePapSandboxFromSrc(mutated, { online: true });
      const pin = makePin({ id: "pmut1" });
      sandbox.State.pins = [pin];
      sandbox.PinActionPop.open(pin.id);
      sandbox.PinActionPop._selectRegCategory("theta");
      const mainBytes = mainText(1.570796327, -1.049611926);
      const jpgBytes = await makeJpeg(200, 140, [40, 160, 220]);
      const flsBuf = buildFlsFixture(mainBytes, jpgBytes);
      const flsFile = new File([flsBuf], "scan_mut.fls", { type: "application/octet-stream" });
      await sandbox.PinActionPop._registerPhotoFile(flsFile);
      ok(!pin.imageId, "뮤테이션 적용 시 .fls 원본이 그대로 detect360 에 들어가 거부되어 등록 실패(R1 재발 — 테스트 실효성 증명)");
    }
  }

  console.log("\n[뮤테이션 R2] 오프라인 큐 폴백을 제거하면 ②c가 실패해야 함(업로드 실패만 표시)");
  {
    const needle = `        let imageId = null, pendingOp = null;
        if (navigator.onLine) {
          try { imageId = await Cloud.uploadImage(imgName, dataURL, width, height); } catch (e) { imageId = null; }
        }
        if (!imageId) {
          pendingOp = await SyncQueue.enqueue({ kind: "image", name: imgName, image_data: dataURL, width, height });
          if (!pendingOp) throw new Error("오프라인 저장 실패 — 기기 저장공간 부족");
        }`;
    const replacement = `        const imageId = await Cloud.uploadImage(imgName, dataURL, width, height);`;
    const mutated = PAP_SRC.replace(needle, replacement);
    if (mutated === PAP_SRC) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
    else {
      const sandbox = makePapSandboxFromSrc(mutated, { online: false });
      const pin = makePin({ id: "pmut2" });
      sandbox.State.pins = [pin];
      sandbox.PinActionPop.open(pin.id);
      await sandbox.PinActionPop._registerPhotoFile({ name: "photo.jpg" });
      ok(!pin.pendingOpId, "뮤테이션 적용 시 오프라인에서 pendingOpId 가 세팅되지 않음(R2 재발 — 테스트 실효성 증명)");
      const errText = sandbox.getElementById("pap-photo-err").textContent;
      ok(/업로드 실패/.test(errText), "뮤테이션 적용 시 '업로드 실패'만 표시되고 큐 적재 안내는 없음 — " + errText);
    }
  }

  console.log("\n[뮤테이션 R3] nearestByRect 결과를 무시하면 ③d가 실패해야 함(여전히 topmost=B 가 선택됨)");
  {
    const needle = `        const nearestId = (typeof MapCtrl !== "undefined" && MapCtrl.nearestByRect) ? MapCtrl.nearestByRect(candidates, x, y) : null;`;
    const replacement = `        const nearestId = null;`;
    const mutated = UI_SRC.replace(needle, replacement);
    if (mutated === UI_SRC) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
    else {
      const document = {
        getElementById() { return null; }, addEventListener() {}, querySelector: () => null,
        querySelectorAll() { return []; }, createElement: () => makeElement("__anon__"),
        body: { appendChild() {} }, elementsFromPoint: null
      };
      const State = { pins: [], zoom: 1, pan: { x: 0, y: 0 } };
      const sandbox = { console, document, State };
      sandbox.window = sandbox;
      vm.createContext(sandbox);
      vm.runInContext(MAPCTRL_SRC + "\n;globalThis.MapCtrl = MapCtrl;", sandbox);
      vm.runInContext(mutated + "\n;globalThis.UI = UI;", sandbox);
      const UI = sandbox.UI;
      const pinA = { id: "A" }, pinB = { id: "B" };
      State.pins = [pinA, pinB];
      const markerA = { classList: { contains: (c) => c === "pin-marker" }, dataset: { id: "A" }, getBoundingClientRect: () => ({ left: 90, top: 90, width: 20, height: 20 }) };
      const markerB = { classList: { contains: (c) => c === "pin-marker" }, dataset: { id: "B" }, getBoundingClientRect: () => ({ left: 130, top: 130, width: 20, height: 20 }) };
      document.elementsFromPoint = (x, y) => [markerB, markerA];
      const resolved = UI._resolveTapPin({ clientX: 105, clientY: 102 }, pinB);
      ok(resolved === pinB, "뮤테이션 적용 시 더 가까운 A 대신 여전히 topmost B 가 선택됨(R3 재발 — 테스트 실효성 증명)");
    }
  }

  console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
  process.exit(failed === 0 ? 0 : 1);
}

/** 뮤테이션 테스트용 — 임의의 papSrc 문자열로 전체 sandbox 를 새로 구성 */
function makePapSandboxFromSrc(papSrc, { online }) {
  const registry = new Map();
  const getElementById = (id) => { if (!registry.has(id)) registry.set(id, makeElement(id)); return registry.get(id); };
  const document = { getElementById, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], createElement: canvasAwareCreateElement };
  const lsMap = new Map();
  const localStorage = { getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null), setItem: (k, v) => lsMap.set(k, String(v)), removeItem: (k) => lsMap.delete(k) };
  const State = { pins: [], mode: "designer", currentDeploymentId: "dep1", pinEditUnlocked: null };
  const App = {
    pinHasContent(p) { return !!(p && (p.imageId || p.imageUrl)); },
    pinHasMedia(p) { return !!(p && (p.imageId || p.imageUrl || p.pendingOpId)); },
    _dirty: false, _markDirty() { App._dirty = true; }, _keepLocal() {},
    editPin() {}, deletePin() {}, focusPin() {}, setActivePin() {},
    _autoSave() { throw new Error("자동저장 OFF 정책 위반"); },
    _detect360(file, cb) { cb(/\.(jpe?g|png)$/i.test((file && file.name) || "")); }
  };
  const Auth = { isDesigner: true, headers: () => ({}) };
  const Prompt = { toast() {}, ask: async () => null };
  const Cloud = {
    _cache: {},
    async resizeImage() { return { dataURL: "data:image/jpeg;base64,AAAA", width: 2048, height: 1024 }; },
    async uploadImage() { if (!online) throw new Error("network down"); return "img-uploaded-1"; }
  };
  const UI = { renderPinsOnMap() {}, renderPinList() {}, escapeHtml: (s) => String(s == null ? "" : s), $: (id) => getElementById(id) };
  const Inspector = { showPin() {} };
  const navigator = { onLine: online };
  const sandbox = {
    console, Math, JSON, Promise, setTimeout, clearTimeout, URL, Buffer, File, Blob, TextEncoder, TextDecoder,
    document, State, App, Auth, Prompt, Cloud, UI, Inspector, navigator, localStorage,
    createImageBitmap: async (blob) => loadImage(Buffer.from(await blob.arrayBuffer()))
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(FLS_SRC + "\n;globalThis.FLS = FLS;", sandbox);
  vm.runInContext(PANO_SRC + "\n;globalThis.FlsPano = FlsPano;", sandbox);
  vm.runInContext(SQ_SRC + "\n;globalThis.SyncQueue = SyncQueue;", sandbox);
  vm.runInContext(NOTES_SRC + "\n;globalThis.Notes = Notes;", sandbox);
  vm.runInContext(papSrc + "\n;globalThis.PinActionPop = PinActionPop;", sandbox);
  sandbox.PinActionPop.init();
  return { PinActionPop: sandbox.PinActionPop, State, App, Cloud, SyncQueue: sandbox.SyncQueue, getElementById };
}

main();
