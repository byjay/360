/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p6-photo-batch.test.mjs)
 *
 * 대상: public/js/modules/35_PhotoBatch.js — "사진 폴더 일괄 매칭"(RESUME_LEDGER.md §H)
 *  ① EXIF DateTimeOriginal 파싱(합성 JPEG, 실파일 의존 없음)
 *  ② EXIF 없으면 파일 lastModified 폴백 + 근거 표시("파일 수정시각")
 *  ③ 시간순 정렬이 파일명순과 다를 때 시간순을 채택한다
 *  ④ 핀 번호는 PinSeries 정본에서 파생한다(체크보드 계열은 제외, 자체 채번 금지)
 *  ⑤ 개수 불일치 시 남는 쪽을 경고(leftoverPins/leftoverRows)로 알려준다(조용히 자르지 않음)
 *  ⑥ 기존 사진이 있는 핀은 기본 건너뛴다(덮어쓰기 체크 시에만 진행)
 *  ⑦ 행 순서를 수동으로 바꾸면 매칭 순서에 그대로 반영된다
 *
 * 실제 모듈 소스(01b_PinSeries.js / 35_PhotoBatch.js)를 그대로 vm 에 평가해 검사한다(목 구현 아님).
 * ③④ 에는 뮤테이션(수정 무력화) 케이스가 붙어 있어, 고친 코드를 되돌리면 실패한다.
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

/* ── 합성 JPEG(EXIF APP1 세그먼트 포함) 빌더 — 실파일 의존 없음 ───────────── */
function buildExifJpeg(dateStr /* "YYYY:MM:DD HH:MM:SS" */) {
  const dateBytes = Buffer.from(dateStr, "ascii"); // 19 bytes
  const ifd0Start = 8;
  const ifd0Len = 2 + 12 + 4; // entries(1) + next-ifd
  const exifIfdStart = ifd0Start + ifd0Len;
  const exifIfdLen = 2 + 12 + 4;
  const dateValueOffset = exifIfdStart + exifIfdLen;
  const tiffLen = dateValueOffset + dateBytes.length + 1;

  const tiff = Buffer.alloc(tiffLen);
  let o = 0;
  tiff.write("II", o, "ascii"); o += 2;
  tiff.writeUInt16LE(42, o); o += 2;
  tiff.writeUInt32LE(ifd0Start, o); o += 4;
  // IFD0: 1 entry = ExifIFD pointer(0x8769)
  tiff.writeUInt16LE(1, o); o += 2;
  tiff.writeUInt16LE(0x8769, o); o += 2;
  tiff.writeUInt16LE(4, o); o += 2;      // type LONG
  tiff.writeUInt32LE(1, o); o += 4;      // count
  tiff.writeUInt32LE(exifIfdStart, o); o += 4;
  tiff.writeUInt32LE(0, o); o += 4;      // IFD0 next = 0
  // ExifIFD: 1 entry = DateTimeOriginal(0x9003)
  tiff.writeUInt16LE(1, o); o += 2;
  tiff.writeUInt16LE(0x9003, o); o += 2;
  tiff.writeUInt16LE(2, o); o += 2;      // type ASCII
  tiff.writeUInt32LE(dateBytes.length + 1, o); o += 4; // count(+NUL)
  tiff.writeUInt32LE(dateValueOffset, o); o += 4;
  tiff.writeUInt32LE(0, o); o += 4;      // ExifIFD next = 0
  dateBytes.copy(tiff, dateValueOffset);

  const exifHeader = Buffer.from("Exif\0\0", "ascii");
  const app1Payload = Buffer.concat([exifHeader, tiff]);
  const app1 = Buffer.alloc(4 + app1Payload.length);
  app1.writeUInt8(0xFF, 0); app1.writeUInt8(0xE1, 1);
  app1.writeUInt16BE(app1Payload.length + 2, 2);
  app1Payload.copy(app1, 4);

  return Buffer.concat([Buffer.from([0xFF, 0xD8]), app1, Buffer.from([0xFF, 0xD9])]);
}
function plainJpeg() { return Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]); } // EXIF 없음
const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

/* ── vm 컨텍스트: 실제 소스만 평가(목 구현 없음) ─────────────────────────── */
function makeSandbox(extra = {}) {
  const sandbox = Object.assign({ console, JSON, Map, Set, Date, DataView, ArrayBuffer, Buffer }, extra);
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}
function loadPB(pbSource, extraState = {}) {
  const State = Object.assign({ pins: [], pdfPage: 1 }, extraState);
  const AppMock = { pinHasContent(pin) { return !!(pin && (pin.imageId || pin.imageUrl || pin.videoId)); } };
  const sandbox = makeSandbox({ State, App: AppMock });
  vm.runInContext(seriesSrc + "\n" + pbSource + "\n;globalThis.__PB = PhotoBatch; globalThis.__PS = PinSeries;", sandbox);
  return { PB: sandbox.__PB, PS: sandbox.__PS, sandbox };
}

/* ══ ① EXIF DateTimeOriginal 파싱 ══════════════════════════════════════ */
{
  const { PB } = loadPB(pbSrc);
  const buf = toArrayBuffer(buildExifJpeg("2026:09:03 10:15:30"));
  const r = PB._parseExifDate(buf);
  ok(!!r && r.iso === "2026-09-03T10:15:30" && r.tag === "DateTimeOriginal",
    "① EXIF DateTimeOriginal 파싱 → " + JSON.stringify(r));
}

/* ══ ② EXIF 없으면 mtime 폴백 + 근거 표시 ═══════════════════════════════ */
{
  const { PB } = loadPB(pbSrc);
  const exifNone = PB._parseExifDate(toArrayBuffer(plainJpeg()));
  ok(exifNone === null, "②a EXIF 없는 JPEG → null 반환");
  const rows = PB._sortRows([{ name: "b.jpg", lastModified: 2000, exif: null }, { name: "a.jpg", lastModified: 1000, exif: null }]);
  ok(rows[0].name === "a.jpg" && rows[0].timeSource === "파일 수정시각",
    "②b mtime 폴백 정렬 + 근거표시 → " + rows.map(r => r.name + ":" + r.timeSource).join(", "));
}

/* ══ ③ 시간순 정렬이 파일명순과 다를 때 시간순 채택(+뮤테이션) ══════════════ */
{
  const rowsIn = [
    { name: "z_first.jpg", exif: { iso: "2026-09-03T09:00:00", tag: "DateTimeOriginal" }, lastModified: 0 },
    { name: "a_second.jpg", exif: { iso: "2026-09-03T09:05:00", tag: "DateTimeOriginal" }, lastModified: 0 },
    { name: "m_third.jpg", exif: { iso: "2026-09-03T09:10:00", tag: "DateTimeOriginal" }, lastModified: 0 }
  ];
  const { PB } = loadPB(pbSrc);
  const sorted = PB._sortRows(rowsIn).map(r => r.name);
  ok(sorted.join(",") === "z_first.jpg,a_second.jpg,m_third.jpg",
    "③ 시간순 채택(파일명순이면 a,m,z 순서가 됐을 것) → " + sorted.join(","));

  console.log("\n[뮤테이션③] 정렬을 파일명순으로 되돌리면 실패해야 함");
  const needle = `      withKey.sort((a, b) => {
        const ak = Number.isFinite(a.sortKey) ? a.sortKey : Infinity;
        const bk = Number.isFinite(b.sortKey) ? b.sortKey : Infinity;
        if (ak !== bk) return ak - bk;
        return this._natural(a.name, b.name);
      });`;
  const mutated = pbSrc.replace(needle, `      withKey.sort((a, b) => this._natural(a.name, b.name));`);
  if (mutated === pbSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PB: PBm } = loadPB(mutated);
    const sortedM = PBm._sortRows(rowsIn).map(r => r.name);
    ok(sortedM.join(",") !== "z_first.jpg,a_second.jpg,m_third.jpg",
      `뮤테이션 적용 시 파일명순으로 깨짐(테스트 실효성 증명) → ${sortedM.join(",")}`);
  }
}

/* ══ ④ 핀 번호는 PinSeries 정본에서 파생(+뮤테이션: 자체 채번) ══════════════ */
{
  const pins = [
    { id: "A", page: 1, label: "A", imageId: null },                 // content series no=1
    { id: "X", page: 1, label: "5", checkboard: true },               // checkboard 계열(별도) — 매칭 대상 아님
    { id: "B", page: 1, label: "B", imageId: null }                   // content series no=2
  ];
  const { PB } = loadPB(pbSrc, { pins, pdfPage: 1 });
  const list = PB._pinList(pins, 1);
  ok(list.length === 2 && list[0].no === 1 && list[0].pin.id === "A" && list[1].no === 2 && list[1].pin.id === "B",
    "④ PinSeries 정본에서 콘텐츠 계열만 파생(체크보드 제외) → " + JSON.stringify(list.map(e => ({ id: e.pin.id, no: e.no }))));

  console.log("\n[뮤테이션④] PinSeries 를 우회해 자체 채번(체크보드까지 포함)하면 실패해야 함");
  const needle = `        const info = map.get(p.id);
        if (!info || info.series !== "content") return;
        list.push({ pin: p, no: info.no });`;
  const mutated = pbSrc.replace(needle, `        list.push({ pin: p, no: list.length + 1 });`);
  if (mutated === pbSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PB: PBm } = loadPB(mutated, { pins, pdfPage: 1 });
    const listM = PBm._pinList(pins, 1);
    const bNo = listM.find(e => e.pin.id === "B");
    ok(!bNo || bNo.no !== 2,
      `뮤테이션 적용 시 체크보드가 콘텐츠 번호를 밀어냄(테스트 실효성 증명) → B.no=${bNo && bNo.no}`);
  }
}

/* ══ ⑤ 개수 불일치 경고(leftover) ══════════════════════════════════════ */
{
  const { PB } = loadPB(pbSrc);
  const pinList = [{ pin: { id: "P1" }, no: 1 }, { pin: { id: "P2" }, no: 2 }, { pin: { id: "P3" }, no: 3 }];
  const rows = [{ name: "1.jpg", excluded: false }, { name: "2.jpg", excluded: false }]; // 사진 1장 부족
  const { matches, leftoverPins, leftoverRows } = PB._buildMatches(pinList, rows, { start: 1, end: 3 });
  ok(matches.length === 2 && leftoverPins.length === 1 && leftoverPins[0].no === 3 && leftoverRows.length === 0,
    "⑤ 개수 불일치 시 남는 핀을 leftoverPins 로 알림(조용히 자르지 않음) → matches=" + matches.length + " leftoverPins=" + leftoverPins.length);
}

/* ══ ⑥ 기존 사진 있는 핀은 기본 건너뛰기(run() 실측) ══════════════════════ */
async function testSkipExisting() {
  const pinA = { id: "A", page: 1, label: "A" };                          // 사진 없음 → 업로드 대상
  const pinB = { id: "B", page: 1, label: "B", imageId: "existing-123" }; // 이미 사진 있음 → 기본 건너뜀
  const pins = [pinA, pinB];
  const { PB, sandbox } = loadPB(pbSrc, { pins, pdfPage: 1 });

  const registry = {};
  const getEl = (id) => (registry[id] = registry[id] || { textContent: "", disabled: false, checked: false, classList: { add() {}, remove() {} } });
  sandbox.document = { getElementById: getEl, querySelectorAll: () => [] };
  sandbox.navigator = { onLine: true };
  sandbox.confirm = () => true;
  let uploadCalls = [];
  sandbox.Cloud = {
    _cache: {},
    async resizeImage(file) { return { dataURL: "data:image/jpeg;base64,AAA", width: 10, height: 5 }; },
    async uploadImage(name) { uploadCalls.push(name); return "new-" + name; }
  };
  sandbox.SyncQueue = { async enqueue() { return null; } };
  let dirtyMarked = false;
  sandbox.App = Object.assign(sandbox.App, { _updateSyncBadge() {}, _markDirty() { dirtyMarked = true; } });
  sandbox.UI = { renderPinList() {}, renderPinsOnMap() {} };
  sandbox.Prompt = { toast() {} };
  vm.runInContext("globalThis.PinGrid = undefined;", sandbox);

  PB._rows = [
    { file: { slice() {} }, name: "a.jpg", excluded: false, is360: false },
    { file: { slice() {} }, name: "b.jpg", excluded: false, is360: false }
  ];
  PB._range = { start: 1, end: 2 };

  await PB.run();
  ok(pinA.imageId === "new-a" && pinB.imageId === "existing-123" && uploadCalls.length === 1,
    "⑥a 기존사진 핀은 기본 건너뜀 → A업로드=" + pinA.imageId + " B(불변)=" + pinB.imageId + " 업로드횟수=" + uploadCalls.length);
  ok(dirtyMarked === true, "⑥b 완료 후 App._markDirty() 로 '미저장' 표시만(자동저장 호출 없음)");

  // 덮어쓰기 체크 시에는 진행되어야 함
  registry["photobatch-overwrite"] = { checked: true };
  uploadCalls = [];
  PB._rows = [
    { file: { slice() {} }, name: "a2.jpg", excluded: false, is360: false },
    { file: { slice() {} }, name: "b2.jpg", excluded: false, is360: false }
  ];
  await PB.run();
  ok(uploadCalls.length === 2 && pinB.imageId === "new-b2",
    "⑥c 덮어쓰기 체크 시 기존사진 핀도 갱신 → 업로드횟수=" + uploadCalls.length + " B=" + pinB.imageId);
}

/* ══ ⑦ 행 순서 수동 변경이 매칭에 반영 ═══════════════════════════════════ */
{
  const { PB } = loadPB(pbSrc);
  const pinList = [{ pin: { id: "P1" }, no: 1 }, { pin: { id: "P2" }, no: 2 }];
  const rows = [{ name: "second.jpg" }, { name: "first.jpg" }]; // 시간순 정렬 결과라고 가정(사용자가 순서를 바꾸기 전)
  const before = PB._buildMatches(pinList, rows, { start: 1, end: 2 });
  ok(before.matches[0].row.name === "second.jpg", "⑦a 기본 순서대로 매칭 → P1↔" + before.matches[0].row.name);

  // 사용자가 표에서 위/아래로 순서를 바꿈(0번↔1번 스왑) — _moveRow 와 동일한 조작
  const swapped = rows.slice(); const tmp = swapped[0]; swapped[0] = swapped[1]; swapped[1] = tmp;
  const after = PB._buildMatches(pinList, swapped, { start: 1, end: 2 });
  ok(after.matches[0].row.name === "first.jpg" && after.matches[1].row.name === "second.jpg",
    "⑦b 수동 순서 변경이 매칭에 반영됨 → P1↔" + after.matches[0].row.name + ", P2↔" + after.matches[1].row.name);
}

await testSkipExisting();

console.log(failed === 0 ? "\n전체 PASS" : `\n${failed}건 FAIL`);
process.exit(failed === 0 ? 0 : 1);
