/**
 * 회귀 테스트 — .fls(OLE2 복합 문서) 단일 파일 → 360 사진 추출 (프레임워크 0 · 실행: node tests/p178-fls-ole-preview.test.mjs)
 *
 * [재현] R1~R4(지휘자 실측, 발주서) — FARO iQscene 미처리 스캔(scan_0.fls 등)은 디렉터리가 아니라
 * 단일 OLE2(MS-CFB) 파일이며, "Main"(StartTheta/EndTheta 라디안 헤더)·"Previews/previewColor.jpg"
 * (컬러 360 미리보기) 두 스트림만 있으면 등록 가능한 360 사진으로 변환할 수 있다. 실파일 3개(scan_0/
 * scan_10/scan_121) 검증은 build-tools/fls-ole-verify.mjs(python olefile 추출 결과와 크기 일치, EXIT=0).
 *
 * 대상: public/js/modules/39_FlsPano.js — _ole2Streams(최소 OLE2 리더)·fromFlsOle(Theta→padToEquirect
 * 재사용)·public/js/modules/60_PhotoFolder.js — _EXT_RE(.fls 추가)·_isFls·_materializeFile.
 *
 * 실 모듈 소스를 vm/Function 에 그대로 평가한다(재구현 금지, 목 아님). canvas(npm, 기존 설치)로
 * 실제 JPEG 인코딩/디코딩을 수행 — drawImage/getImageData 를 가짜로 흉내내지 않는다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "canvas";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const PANO_SRC = rd("public/js/modules/39_FlsPano.js");
const PF_SRC = rd("public/js/modules/60_PhotoFolder.js");

let failed = 0;
const ok = (cond, label, detail) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail).slice(0, 400) : "")); if (!cond) failed++; };

/* ══════════════════════════════════════════════════════════════
   최소 OLE2(MS-CFB) 빌더 — 이 테스트 전용(섹터512/미니섹터64/cutoff4096, 버전3, DIFAT 불필요 규모).
   엔트리 고정: Root(0)→child Main(1){right:Previews(2)}, Previews(2){child: previewColor.jpg(3)}.
   ══════════════════════════════════════════════════════════════ */
function buildFlsFixture(mainBytes, jpgBytes) {
  const SECTOR = 512, MINI = 64, CUTOFF = 4096;
  const FREE = 0xFFFFFFFF, EOC = 0xFFFFFFFE;

  // 실제 OLE2 규약대로 각 스트림을 크기로 분류한다(미니/일반) — previewColor.jpg 가 scan_121.fls 처럼
  // 작은(1x1 플레이스홀더) 경우 "항상 일반 스트림"으로 가정하면 리더가 미니스트림으로 읽어 깨진다.
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

  const D = 1; // 4 dir entries * 128 = 512 = 1 sector
  const MF = Math.ceil(miniFatBytes.length / SECTOR);
  const MS = Math.max(1, Math.ceil(miniContainerLen / SECTOR));
  const idDir = 1, idMiniFat = idDir + D, idMiniStream = idMiniFat + MF, idRegularBase = idMiniStream + MS;

  let roff = 0;
  regularArr.forEach((s) => { s._regStart = idRegularBase + roff; s._regCount = Math.ceil(s.data.length / SECTOR); roff += s._regCount; });
  const BS = Math.max(1, roff); // 최소 1섹터는 fat 배열 크기 확보용(실제로 안 쓰여도 무해)

  const fat = new Int32Array(128).fill(FREE); // 1 FAT 섹터=128 엔트리, 이 테스트 규모에서 항상 충분
  fat[0] = 0xFFFFFFFD; // FATSECT
  fat[idDir] = EOC;
  for (let i = 0; i < MF; i++) fat[idMiniFat + i] = (i < MF - 1) ? (idMiniFat + i + 1) : EOC;
  for (let i = 0; i < MS; i++) fat[idMiniStream + i] = (i < MS - 1) ? (idMiniStream + i + 1) : EOC;
  regularArr.forEach((s) => { for (let i = 0; i < s._regCount; i++) fat[s._regStart + i] = (i < s._regCount - 1) ? (s._regStart + i + 1) : EOC; });

  // 디렉터리 엔트리 4개(128바이트씩): Root(0)→child Main(1){right:Previews(2)}, Previews(2){child: previewColor.jpg(3)}
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

  const msBuf = new Uint8Array(MS * SECTOR); // 미니스트림도 일반 섹터(512B) 단위로 저장돼야 한다(섹터 경계 패딩)
  msBuf.set(miniContainer, 0);
  const regularBuf = new Uint8Array(BS * SECTOR);
  regularArr.forEach((s) => regularBuf.set(s.data, (s._regStart - idRegularBase) * SECTOR));

  const total = headerLen + SECTOR /* FAT sector id0 */ + dirBuf.length + miniFatBytes.length + msBuf.length + regularBuf.length;
  const out = new Uint8Array(total);
  const hdv = new DataView(out.buffer);
  const SIG = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
  SIG.forEach((b, i) => out[i] = b);
  hdv.setUint16(24, 0x003E, true);      // minor version
  hdv.setUint16(26, 3, true);           // major version 3
  hdv.setUint16(28, 0xFFFE, true);      // byte order
  hdv.setUint16(30, 9, true);           // sector shift → 512
  hdv.setUint16(32, 6, true);           // mini sector shift → 64
  hdv.setUint32(40, 0, true);           // dir sector count(v3 미사용)
  hdv.setUint32(44, 1, true);           // FAT sector 수
  hdv.setInt32(48, idDir, true);        // first dir sector
  hdv.setUint32(56, CUTOFF, true);      // mini stream cutoff
  hdv.setInt32(60, idMiniFat, true);    // first mini FAT sector
  hdv.setUint32(64, MF, true);          // mini FAT sector 수
  hdv.setInt32(68, EOC, true);          // first DIFAT sector(없음)
  hdv.setUint32(72, 0, true);           // DIFAT sector 수
  hdv.setInt32(76, 0, true);            // DIFAT[0] = FAT sector id
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
  return new TextEncoder().encode(
    "/** iQscene: Scan Data **/\nStartTheta " + startThetaRad + "\nEndTheta " + endThetaRad + "\n"
  );
}

async function makeJpeg(w, h, rgb) {
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  const id = ctx.createImageData(w, h);
  // 전면 랜덤 노이즈 — JPEG 손실압축 후에도 미니스트림 cutoff(4096B)를 확실히 넘기게 한다
  for (let i = 0; i < id.data.length; i += 4) {
    id.data[i] = (rgb[0] + Math.floor(Math.random() * 256)) % 256;
    id.data[i + 1] = (rgb[1] + Math.floor(Math.random() * 256)) % 256;
    id.data[i + 2] = (rgb[2] + Math.floor(Math.random() * 256)) % 256;
    id.data[i + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return c.toBuffer("image/jpeg", { quality: 1 });
}

function makeDoc() {
  return {
    createElement(tag) {
      if (tag !== "canvas") return { style: {} };
      const c = createCanvas(1, 1);
      c.toBlob = (cb, type, q) => cb(c.toBuffer(type === "image/png" ? "image/png" : "image/jpeg", { quality: q == null ? 0.92 : q }));
      return c;
    }
  };
}
function loadFlsPano(src) {
  const createImageBitmap = async (blob) => loadImage(Buffer.from(await blob.arrayBuffer()));
  const fn = new Function("document", "createImageBitmap", "Blob", (src || PANO_SRC) + "\n;return FlsPano;");
  return fn(makeDoc(), createImageBitmap, Blob);
}

function getPixel(canvas, x, y) {
  const img = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
}

/* ══════════════════════════════════════════════════════════════
   ① _ole2Streams — Main / Previews/previewColor.jpg 를 원본과 바이트 단위로 동일하게 읽음
   ══════════════════════════════════════════════════════════════ */
console.log("\n[① _ole2Streams — 스트림 2개 원본과 바이트 일치]");
let fixtureBuf, jpgBytes, mainBytes;
{
  mainBytes = mainText(1.570796327, -1.049611926); // 90°, -60.135°(R2 실측값)
  jpgBytes = await makeJpeg(200, 140, [40, 160, 220]); // 2:1 이 아닌 비율 — padToEquirect 가 실제로 패딩 캔버스를 새로 만들게(이미 2:1이면 원본 img 그대로 반환돼 getContext 없음)
  ok(jpgBytes.length > 4096, "사전조건: 픽스처 JPEG 가 미니스트림 cutoff(4096) 초과 — " + jpgBytes.length + "B(정상 스트림 경로 검증)");
  fixtureBuf = buildFlsFixture(mainBytes, jpgBytes);
  const FlsPano = loadFlsPano();
  const streams = FlsPano._ole2Streams(fixtureBuf, ["Main", "Previews/previewColor.jpg"]);
  ok(streams["Main"] && streams["Main"].length === mainBytes.length, "①a Main 스트림 길이 일치 — " + (streams["Main"] && streams["Main"].length));
  ok(Buffer.from(streams["Main"]).equals(Buffer.from(mainBytes)), "①b Main 스트림 바이트 완전 일치(미니스트림 경로)");
  ok(streams["Previews/previewColor.jpg"] && streams["Previews/previewColor.jpg"].length === jpgBytes.length, "①c previewColor.jpg 길이 일치 — " + (streams["Previews/previewColor.jpg"] && streams["Previews/previewColor.jpg"].length));
  ok(Buffer.from(streams["Previews/previewColor.jpg"]).equals(Buffer.from(jpgBytes)), "①d previewColor.jpg 바이트 완전 일치(일반 FAT 체인 경로)");
}

/* ══════════════════════════════════════════════════════════════
   ② fromFlsOle — StartTheta/EndTheta → padToEquirect 경계가 비율과 일치
   ══════════════════════════════════════════════════════════════ */
console.log("\n[② fromFlsOle — Theta 비율대로 세로 배치, 2:1 결과]");
{
  const FlsPano = loadFlsPano();
  const res = await FlsPano.fromFlsOle(fixtureBuf);
  ok(res.ok, "②a fromFlsOle ok=true — " + JSON.stringify(res && res.reason));
  const canvas = res.canvas;
  const ratio = canvas.width / canvas.height;
  ok(ratio > 1.9 && ratio < 2.1, "②b 2:1 결과 " + canvas.width + "x" + canvas.height + "(ratio " + ratio.toFixed(3) + ")");
  const topDegExpect = 1.570796327 * 180 / Math.PI, botDegExpect = -1.049611926 * 180 / Math.PI;
  ok(Math.abs(res.topDeg - topDegExpect) < 1e-4, "②c topDeg=" + res.topDeg + "(기대 " + topDegExpect + ")");
  ok(Math.abs(res.bottomDeg - botDegExpect) < 1e-4, "②d bottomDeg=" + res.bottomDeg + "(기대 " + botDegExpect + ")");

  const H = canvas.height;
  const topFrac = (90 - res.topDeg) / 180, botFrac = (90 - res.bottomDeg) / 180;
  const yTop = Math.round(topFrac * H), yBot = Math.round(botFrac * H);
  const aboveY = Math.max(0, yTop - 3), belowY = Math.min(H - 1, yBot + 3), insideY = Math.floor((yTop + yBot) / 2);
  const [ra, ga, ba] = getPixel(canvas, 2, aboveY);
  const [rb, gb, bb] = getPixel(canvas, 2, belowY);
  const [ri, gi, bi] = getPixel(canvas, 2, insideY);
  if (yTop > 3) ok(ra === 128 && ga === 128 && ba === 128, "②e 경계 위쪽(y=" + aboveY + ")은 중립 회색 — got (" + ra + "," + ga + "," + ba + ")");
  else console.log("  SKIP ②e (topFrac 이 상단 끝 근처라 '위쪽' 회색 영역이 없음, yTop=" + yTop + ")");
  if (yBot < H - 4) ok(rb === 128 && gb === 128 && bb === 128, "②f 경계 아래쪽(y=" + belowY + ")은 중립 회색 — got (" + rb + "," + gb + "," + bb + ")");
  else console.log("  SKIP ②f (botFrac 이 하단 끝 근처라 검사 생략)");
  ok(!(ri === 128 && gi === 128 && bi === 128), "②g 경계 안쪽(y=" + insideY + ")은 사진 내용(회색 아님) — got (" + ri + "," + gi + "," + bi + ")");

  // ②h~i R2 실측값은 StartTheta=90°(yTop=0, 위쪽 회색 영역 없음) — 상단 경계 자체의 배치를 확실히
  // 검증하기 위해 topDeg=45°(yTop>0) 인 별도 Theta 로도 확인한다.
  const altMain = mainText(45 * Math.PI / 180, -80 * Math.PI / 180);
  const altBuf = buildFlsFixture(altMain, jpgBytes);
  const res2 = await FlsPano.fromFlsOle(altBuf);
  const H2 = res2.canvas.height;
  const yTop2 = Math.round(((90 - res2.topDeg) / 180) * H2);
  const [ra2, ga2, ba2] = getPixel(res2.canvas, 2, Math.max(0, yTop2 - 3));
  const [ri2, gi2, bi2] = getPixel(res2.canvas, 2, Math.min(H2 - 1, yTop2 + 3));
  ok(yTop2 > 5, "②h topDeg=45° → yTop=" + yTop2 + " (0 아님 — 위쪽 회색 영역 존재)");
  ok(ra2 === 128 && ga2 === 128 && ba2 === 128, "②i topDeg=45° 경계 위쪽은 중립 회색 — got (" + ra2 + "," + ga2 + "," + ba2 + ")");
  ok(!(ri2 === 128 && gi2 === 128 && bi2 === 128), "②j topDeg=45° 경계 바로 아래는 사진 내용 — got (" + ri2 + "," + gi2 + "," + bi2 + ")");
}

/* ══════════════════════════════════════════════════════════════
   ③ 컬러 미리보기 없음(zero-length) / 1x1 플레이스홀더 → 사유 반환(조용한 실패 금지)
   ══════════════════════════════════════════════════════════════ */
console.log("\n[③ 컬러 미리보기 없음/플레이스홀더 — 사유 반환]");
{
  const FlsPano = loadFlsPano();
  const noPreviewBuf = buildFlsFixture(mainBytes, new Uint8Array(0));
  const res1 = await FlsPano.fromFlsOle(noPreviewBuf);
  ok(res1.ok === false && /미리보기 없음/.test(res1.reason), "③a zero-length previewColor.jpg → 사유 — " + JSON.stringify(res1));

  const tinyJpg = await makeJpeg(1, 1, [0, 0, 0]); // 실파일 scan_121.fls 와 동일한 1x1 플레이스홀더(R4 후속 실측)
  const tinyBuf = buildFlsFixture(mainBytes, tinyJpg);
  const res2 = await FlsPano.fromFlsOle(tinyBuf);
  ok(res2.ok === false && /미리보기 없음/.test(res2.reason), "③b 1x1 플레이스홀더 JPEG → 사유(실파일 scan_121.fls 재현) — " + JSON.stringify(res2));
}

/* ══════════════════════════════════════════════════════════════
   ④ 60_PhotoFolder 통합 — "scan_10.fls" → 10번 핀 등록
   ══════════════════════════════════════════════════════════════ */
console.log("\n[④ 60_PhotoFolder — scan_10.fls 매칭 → 10번 핀에 등록]");
{
  const document = makeDoc();
  document.getElementById = () => null;
  document.body = { appendChild() {} };
  document.querySelector = () => null;
  const toasts = [];
  const uploadCalls = [];
  const State = { pins: [{ id: "p10", page: 1 }], pdfPage: 1, checkboard: true, regMode: "photo" };
  const Auth = { readonly: false };
  const PinSeries = { seriesOf: () => "content", mediaOf: () => false, formatNo: (n) => String(n), numbers: () => new Map([["p10", { no: 10 }]]) };
  const App = { _detect360: (f, cb) => cb(true, 1549, 775) };
  const PhotoBatch = {
    _usedPhotoNames: () => new Set(),
    _uploadOneRow: async (pin, row) => { uploadCalls.push({ pinId: pin.id, name: row.name }); pin.imageId = "img_" + row.name; return { status: "done" }; },
    _markUnsaved: () => {}
  };
  const UI = { renderPinList: () => {}, renderPinsOnMap: () => {} };
  const Prompt = { toast: (m) => toasts.push(String(m)) };
  const Projects = { currentProject: { id: "projT" }, currentDeck: null, decks: [], pinsForDeck: (p) => p };
  const createImageBitmap = async (blob) => loadImage(Buffer.from(await blob.arrayBuffer()));
  const localStorageMap = new Map();
  const localStorage = { getItem: (k) => (localStorageMap.has(k) ? localStorageMap.get(k) : null), setItem: (k, v) => localStorageMap.set(k, String(v)), removeItem: (k) => localStorageMap.delete(k) };
  const sandbox = {
    console, Map, Set, Promise, Buffer, File, Blob, TextEncoder, TextDecoder, createImageBitmap,
    document, window: { showDirectoryPicker: undefined, document },
    localStorage, State, Auth, PinSeries, App, PhotoBatch, UI, Prompt, Projects, SyncQueue: undefined,
    THREE: undefined, Cloud: undefined
  };
  vm.createContext(sandbox);
  vm.runInContext(PANO_SRC + "\n;globalThis.FlsPano = FlsPano;", sandbox);
  vm.runInContext(PF_SRC + "\n;globalThis.__PF = PhotoFolder;", sandbox);
  const PF = sandbox.__PF;

  const fls10 = buildFlsFixture(mainBytes, jpgBytes);
  const file10 = new File([fls10], "scan_10.fls", { type: "application/octet-stream" });
  PF._entry("__root__").mode = "fallback";
  PF._entry("__root__").fallbackFiles = [file10];

  ok(PF._EXT_RE.test("scan_10.fls"), "④a _EXT_RE 가 단일 파일 .fls 를 인식");
  const rows = await PF.previewBatch("__root__", null);
  ok(rows.length === 1 && rows[0].status === "일치", "④b previewBatch: 10번 핀 ↔ scan_10.fls 일치 — " + JSON.stringify(rows.map((r) => r.status)));
  const summary = await PF.runBatchConfirmed(rows);
  ok(summary.done === 1, "④c runBatchConfirmed done=1 — " + JSON.stringify(summary));
  ok(uploadCalls.length === 1 && uploadCalls[0].pinId === "p10", "④d 10번 핀(p10)에 등록 호출됨 — " + JSON.stringify(uploadCalls));
  ok(uploadCalls[0] && /\.jpg$/.test(uploadCalls[0].name), "④e 등록 파일명이 .jpg 로 변환됨 — " + JSON.stringify(uploadCalls));
}

/* ══════════════════════════════════════════════════════════════
   뮤테이션 증명 A — Theta 파싱을 무시(기본값 고정)하면 ②e~g 경계 위치가 깨져야 함
   ══════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션 A] Main 의 StartTheta/EndTheta 파싱을 무시(기본 TOP_DEG/BOTTOM_DEG 고정)하면 경계가 뒤집혀야 함");
{
  const needle = 'if (sm) topDeg = parseFloat(sm[1]) * 180 / Math.PI;\n        if (em) bottomDeg = parseFloat(em[1]) * 180 / Math.PI;';
  const mutated = PANO_SRC.replace(needle, '/* mutated: ignore theta */ void sm; void em;');
  if (mutated === PANO_SRC) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    // 기본값(TOP_DEG=90,BOTTOM_DEG=-60)과 다른 Theta(45°,-80°)를 쓰는 픽스처로 차이를 드러낸다
    const altMain = mainText(45 * Math.PI / 180, -80 * Math.PI / 180);
    const altBuf = buildFlsFixture(altMain, jpgBytes);
    const FlsPano = loadFlsPano(mutated);
    const res = await FlsPano.fromFlsOle(altBuf);
    const broke = Math.abs(res.topDeg - 45) > 1 || Math.abs(res.bottomDeg - (-80)) > 1;
    ok(broke, "Theta 파싱 제거 시 topDeg/bottomDeg 가 기본값(90/-60)으로 고정되어 기대(45/-80)와 달라짐 → got topDeg=" + res.topDeg + " bottomDeg=" + res.bottomDeg);
  }
}

/* ══════════════════════════════════════════════════════════════
   뮤테이션 증명 B — _EXT_RE 에서 fls 를 제거하면 ④ 등록이 0건으로 깨져야 함
   ══════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션 B] _EXT_RE 에서 fls 를 제거하면 scan_10.fls 매칭/등록이 0건이 되어야 함");
{
  const needle = "_EXT_RE: /\\.(jpe?g|png|heic|e57|fls)$/i,";
  const mutated = PF_SRC.replace(needle, "_EXT_RE: /\\.(jpe?g|png|heic|e57)$/i,");
  if (mutated === PF_SRC) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const document = makeDoc();
    document.getElementById = () => null; document.body = { appendChild() {} }; document.querySelector = () => null;
    const uploadCalls2 = [];
    const createImageBitmap = async (blob) => loadImage(Buffer.from(await blob.arrayBuffer()));
    const localStorageMap2 = new Map();
    const sandbox2 = {
      console, Map, Set, Promise, Buffer, File, Blob, TextEncoder, TextDecoder, createImageBitmap,
      document, window: { showDirectoryPicker: undefined, document },
      localStorage: { getItem: (k) => (localStorageMap2.has(k) ? localStorageMap2.get(k) : null), setItem: (k, v) => localStorageMap2.set(k, String(v)), removeItem: () => {} },
      State: { pins: [{ id: "p10", page: 1 }], pdfPage: 1, checkboard: true, regMode: "photo" },
      Auth: { readonly: false },
      PinSeries: { seriesOf: () => "content", mediaOf: () => false, formatNo: (n) => String(n), numbers: () => new Map([["p10", { no: 10 }]]) },
      App: { _detect360: (f, cb) => cb(true, 1549, 775) },
      PhotoBatch: { _usedPhotoNames: () => new Set(), _uploadOneRow: async (pin, row) => { uploadCalls2.push(row.name); return { status: "done" }; }, _markUnsaved: () => {} },
      UI: { renderPinList: () => {}, renderPinsOnMap: () => {} },
      Prompt: { toast: () => {} },
      Projects: { currentProject: { id: "projT" }, currentDeck: null, decks: [], pinsForDeck: (p) => p },
      SyncQueue: undefined, THREE: undefined, Cloud: undefined
    };
    vm.createContext(sandbox2);
    vm.runInContext(PANO_SRC + "\n;globalThis.FlsPano = FlsPano;", sandbox2);
    vm.runInContext(mutated + "\n;globalThis.__PF = PhotoFolder;", sandbox2);
    const PF2 = sandbox2.__PF;
    const fls10b = buildFlsFixture(mainBytes, jpgBytes);
    const file10b = new File([fls10b], "scan_10.fls", { type: "application/octet-stream" });
    PF2._entry("__root__").mode = "fallback";
    PF2._entry("__root__").fallbackFiles = [file10b];
    const rows2 = await PF2.previewBatch("__root__", null);
    const summary2 = await PF2.runBatchConfirmed(rows2);
    const broke = summary2.done === 0 && uploadCalls2.length === 0;
    ok(broke, "_EXT_RE 에서 fls 제거 시 scan_10.fls 가 매칭 후보에서 빠져 등록 0건 → got done=" + summary2.done + " uploadCalls=" + JSON.stringify(uploadCalls2));
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
