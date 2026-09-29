/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p88-photo-time-match.test.mjs)
 *
 * 대상: WORK_ORDER 2026-09-29 "포인트 생성 시간을 기록해 … 그 시간에 들어오는 사진을 반드시
 * 360도 사진을 찾아서 연동 가능하게 해 제일 근사한 시간에 저장된 360 그림을 찾아서 연동되게" /
 * "THETA X야 … 와이파이에 연결되었을 때는 감지해서 같이 작동 연동해".
 *
 * 검증 대상:
 *  ① PinSeries.createdAt() SoT — 명시 필드 우선 → id(Date.now() 타임스탬프) 파생 → null
 *  ② EXIF Make/Model/OffsetTimeOriginal 파싱(합성 JPEG) + _isThetaSignal()
 *  ③ OffsetTimeOriginal 있으면 절대시각으로 정확히 환산(있고/없고 대조)
 *  ④ 최근접 1:1 매칭 — 사진 하나 누락돼도 이후 전부 밀리지 않음(순서기반 _buildMatches 와 대조)
 *  ⑤ 360 아닌 사진은 후보에서 제외 + excluded360 으로 명시(조용히 빠뜨리지 않음)
 *  ⑥ 허용오차 초과 쌍은 미연결
 *  ⑦ 시계보정(offsetMin) 이 매칭에 반영
 *  ⑧ 이미 360 있는 핀은 기본 제외, includeExisting360 로 포함 가능
 *  ⑨ DOM e2e: openTimeMatch → 파일선택 → 미리보기 렌더 → 적용(_uploadOneRow 재사용, run()과 동일 SoT)
 *  ⑩ 오프라인 시 SyncQueue.enqueue 로 사진 바이트가 큐잉됨(오프라인 영속 경로 확인)
 *  ⑪ 32_Offline.js 온라인 복귀 감지 — 오프라인 중 생성된 핀이 있으면 안내 배너 표시, 없으면 표시 안 함
 *
 * 실제 소스(01b_PinSeries.js/35_PhotoBatch.js/32_Offline.js)를 그대로 vm 에 평가(목 구현 아님).
 * ④⑤ 에는 뮤테이션(수정 무력화) 케이스가 붙어 있어, 고친 코드를 되돌리면 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const seriesSrc = rd("public/js/modules/01b_PinSeries.js");
const pbSrc = rd("public/js/modules/35_PhotoBatch.js");
const offlineSrc = rd("public/js/modules/32_Offline.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 합성 JPEG(EXIF APP1: DateTimeOriginal + OffsetTimeOriginal + Make + Model) 빌더 ── */
function buildExifJpeg2({ date, offset, make, model }) {
  const asciiZ = (s) => Buffer.from(String(s) + "\0", "ascii"); // ASCII 타입은 NUL 종료 포함해 count
  const ifd0Fields = [];
  if (make) ifd0Fields.push({ tag: 0x010F, bytes: asciiZ(make) });
  if (model) ifd0Fields.push({ tag: 0x0110, bytes: asciiZ(model) });
  const exifFields = [];
  if (date) exifFields.push({ tag: 0x9003, bytes: Buffer.from(date + "\0", "ascii") }); // "YYYY:MM:DD HH:MM:SS\0" = 20
  if (offset) exifFields.push({ tag: 0x9010, bytes: asciiZ(offset) });

  const ifd0Start = 8;
  const ifd0Count = ifd0Fields.length + 1; // +ExifIFD pointer
  const ifd0Len = 2 + ifd0Count * 12 + 4;
  const exifIfdStart = ifd0Start + ifd0Len;
  const exifCount = exifFields.length;
  const exifIfdLen = 2 + exifCount * 12 + 4;
  let valueCursor = exifIfdStart + exifIfdLen;

  const allFields = [...ifd0Fields, ...exifFields];
  allFields.forEach((f) => { f.valueOffset = valueCursor; valueCursor += f.bytes.length; });
  const tiffLen = valueCursor;

  const tiff = Buffer.alloc(tiffLen);
  let o = 0;
  tiff.write("II", o, "ascii"); o += 2;
  tiff.writeUInt16LE(42, o); o += 2;
  tiff.writeUInt32LE(ifd0Start, o); o += 4;

  // IFD0
  tiff.writeUInt16LE(ifd0Count, o); o += 2;
  ifd0Fields.forEach((f) => {
    tiff.writeUInt16LE(f.tag, o); o += 2;
    tiff.writeUInt16LE(2, o); o += 2;              // type ASCII
    tiff.writeUInt32LE(f.bytes.length, o); o += 4;  // count(incl NUL)
    tiff.writeUInt32LE(f.valueOffset, o); o += 4;
  });
  // ExifIFD pointer
  tiff.writeUInt16LE(0x8769, o); o += 2;
  tiff.writeUInt16LE(4, o); o += 2;   // LONG
  tiff.writeUInt32LE(1, o); o += 4;
  tiff.writeUInt32LE(exifIfdStart, o); o += 4;
  tiff.writeUInt32LE(0, o); o += 4;   // IFD0 next = 0

  // ExifIFD
  tiff.writeUInt16LE(exifCount, o); o += 2;
  exifFields.forEach((f) => {
    tiff.writeUInt16LE(f.tag, o); o += 2;
    tiff.writeUInt16LE(2, o); o += 2;
    tiff.writeUInt32LE(f.bytes.length, o); o += 4;
    tiff.writeUInt32LE(f.valueOffset, o); o += 4;
  });
  tiff.writeUInt32LE(0, o); o += 4;   // ExifIFD next = 0

  allFields.forEach((f) => f.bytes.copy(tiff, f.valueOffset));

  const exifHeader = Buffer.from("Exif\0\0", "ascii");
  const app1Payload = Buffer.concat([exifHeader, tiff]);
  const app1 = Buffer.alloc(4 + app1Payload.length);
  app1.writeUInt8(0xFF, 0); app1.writeUInt8(0xE1, 1);
  app1.writeUInt16BE(app1Payload.length + 2, 2);
  app1Payload.copy(app1, 4);

  return Buffer.concat([Buffer.from([0xFF, 0xD8]), app1, Buffer.from([0xFF, 0xD9])]);
}
const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

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

/* ══ ① PinSeries.createdAt SoT ══════════════════════════════════════════ */
{
  const { PS } = loadPB(pbSrc);
  ok(PS.createdAt({ createdAt: 12345 }) === 12345, "①a 명시 createdAt 필드 우선");
  ok(PS.createdAt({ id: 1727500000000 }) === 1727500000000, "①b 명시 필드 없으면 id(타임스탬프) 파생");
  ok(PS.createdAt({ id: "X" }) === null, "①c 비숫자 id → null(가짜 시각 금지)");
  ok(PS.createdAt({ id: 5 }) === null, "①d 작은 숫자 id(타임스탬프 아님) → null");
  ok(PS.createdAt(null) === null, "①e null 핀 → null");
}

/* ══ ② EXIF Make/Model/OffsetTimeOriginal 파싱 + THETA 신호 ══════════════ */
{
  const { PB } = loadPB(pbSrc);
  const buf = toArrayBuffer(buildExifJpeg2({ date: "2026:09:03 10:15:30", offset: "+09:00", make: "RICOH", model: "RICOH THETA X" }));
  const r = PB._parseExifDate(buf);
  ok(!!r && r.iso === "2026-09-03T10:15:30" && r.make === "RICOH" && r.model === "RICOH THETA X" && r.offsetOriginal === "+09:00",
    "②a Make/Model/OffsetTimeOriginal 파싱 → " + JSON.stringify(r));
  ok(PB._isThetaSignal(r.make, r.model) === true, "②b THETA 신호 감지(RICOH/THETA)");
  ok(PB._isThetaSignal("Canon", "EOS R5") === false, "②c 일반 카메라는 신호 없음");
}

/* ══ ③ OffsetTimeOriginal 유무에 따른 절대시각 환산 대조 ══════════════════ */
{
  const { PB } = loadPB(pbSrc);
  const withOffset = PB._sortRows([{ name: "a.jpg", exif: { iso: "2026-09-03T10:00:00", tag: "DateTimeOriginal", offsetOriginal: "+09:00" } }]);
  const withoutOffset = PB._sortRows([{ name: "a.jpg", exif: { iso: "2026-09-03T10:00:00", tag: "DateTimeOriginal", offsetOriginal: null } }]);
  ok(withOffset[0].sortKey === Date.parse("2026-09-03T10:00:00+09:00"),
    "③a OffsetTimeOriginal 있으면 정확한 절대시각으로 환산 → " + withOffset[0].sortKey);
  ok(withoutOffset[0].sortKey === Date.parse("2026-09-03T10:00:00"),
    "③b 없으면 기존처럼 브라우저 로컬 타임존 해석(회귀 없음)");
}

/* ══ ④ 최근접 1:1 매칭 — 사진 누락돼도 밀리지 않음(+뮤테이션) ══════════════ */
{
  const { PB } = loadPB(pbSrc);
  // _sortRows 는 offset 없는 EXIF iso 를 "로컬시각"으로 해석(Date.parse 기본 동작) — 테스트도
  // 반드시 로컬시각 문자열을 만들어 먹여야 한다(UTC 문자열을 넣으면 타임존만큼 어긋난다).
  const isoLocal = (ms) => {
    const d = new Date(ms), p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  };
  const T = (m) => new Date(2026, 8, 3, 10, m, 0).getTime();
  const pins = [
    { id: "P1", page: 1, label: "1", checkboard: true, createdAt: T(0) },
    { id: "P2", page: 1, label: "2", checkboard: true, createdAt: T(10) }, // 사진 없음(누락)
    { id: "P3", page: 1, label: "3", checkboard: true, createdAt: T(20) },
    { id: "P4", page: 1, label: "4", checkboard: true, createdAt: T(30) }
  ];
  const { PB: PB2 } = loadPB(pbSrc, { pins, pdfPage: 1 });
  const pinList = PB2._pinList(pins, 1, "checkboard");
  const rows = PB2._sortRows([
    { name: "for-p1.jpg", is360: true, exif: { iso: isoLocal(T(0)), tag: "DateTimeOriginal" } },
    { name: "for-p3.jpg", is360: true, exif: { iso: isoLocal(T(20)), tag: "DateTimeOriginal" } },
    { name: "for-p4.jpg", is360: true, exif: { iso: isoLocal(T(30)), tag: "DateTimeOriginal" } }
  ]);
  const result = PB2._buildTimeMatches(pinList, rows, { toleranceMs: 5 * 60000 });
  const pairs = result.matches.map((m) => m.no + "<->" + m.row.name).sort();
  ok(pairs.join(",") === "1<->for-p1.jpg,3<->for-p3.jpg,4<->for-p4.jpg",
    "④a 누락된 P2 를 건너뛰고 나머지가 정확히 제 짝과 매칭(밀리지 않음) → " + pairs.join(","));
  ok(result.unmatchedPins.length === 1 && result.unmatchedPins[0].no === 2,
    "④b P2 만 미연결(사진 없음)로 남음 → " + JSON.stringify(result.unmatchedPins));

  // 대조: 기존 위치기반 _buildMatches 는 누락을 모르고 밀려서 매칭한다(회귀 대조용, 실패 아님)
  const legacy = PB2._buildMatches(pinList, rows, { start: 1, end: 4 });
  const legacyPairs = legacy.matches.map((m) => m.no + "<->" + m.row.name).join(",");
  ok(legacyPairs === "1<->for-p1.jpg,2<->for-p3.jpg,3<->for-p4.jpg",
    "④c [대조] 위치기반 매칭은 밀림 발생(신규 시간매칭이 왜 필요한지의 증거) → " + legacyPairs);

  console.log("\n[뮤테이션④] 최근접 매칭을 순서기반(_buildMatches)으로 되돌리면 ④a 가 실패해야 함");
  const needle = "const { matches, unmatchedPins, unmatchedRows } = this._nearestAssign(pinEntries, rowEntries, toleranceMs);";
  const mutated = pbSrc.replace(needle,
    "const legacyBM = this._buildMatches(pinEntries.map(e=>({pin:e.pin,no:e.no})), rowEntries.map(e=>e.row), {start:-Infinity,end:Infinity});" +
    "const matches = legacyBM.matches, unmatchedPins = legacyBM.leftoverPins, unmatchedRows = legacyBM.leftoverRows;");
  if (mutated === pbSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PB: PBm } = loadPB(mutated, { pins, pdfPage: 1 });
    const pinListM = PBm._pinList(pins, 1, "checkboard");
    const rowsM = PBm._sortRows([
      { name: "for-p1.jpg", is360: true, exif: { iso: isoLocal(T(0)), tag: "DateTimeOriginal" } },
      { name: "for-p3.jpg", is360: true, exif: { iso: isoLocal(T(20)), tag: "DateTimeOriginal" } },
      { name: "for-p4.jpg", is360: true, exif: { iso: isoLocal(T(30)), tag: "DateTimeOriginal" } }
    ]);
    const resultM = PBm._buildTimeMatches(pinListM, rowsM, { toleranceMs: 5 * 60000 });
    const pairsM = resultM.matches.map((m) => m.no + "<->" + m.row.name).sort().join(",");
    ok(pairsM !== "1<->for-p1.jpg,3<->for-p3.jpg,4<->for-p4.jpg",
      "뮤테이션 적용 시 위치기반으로 밀려 틀어짐(테스트 실효성 증명) → " + pairsM);
  }
}

/* ══ ⑤ 360 아닌 사진은 후보 제외 + excluded360 명시(+뮤테이션) ══════════════ */
{
  const { PB } = loadPB(pbSrc);
  const pins = [{ id: "P1", page: 1, label: "1", checkboard: true, createdAt: 1000 }];
  const pinList = [{ pin: pins[0], no: 1 }];
  const rows = [
    { name: "flat.jpg", is360: false, excluded: false, sortKey: 1000 },
    { name: "pano.jpg", is360: true, excluded: false, sortKey: 1000 }
  ];
  const result = PB._buildTimeMatches(pinList, rows, { toleranceMs: 60000 });
  ok(result.matches.length === 1 && result.matches[0].row.name === "pano.jpg",
    "⑤a 360 사진만 매칭 대상 → " + result.matches.map((m) => m.row.name).join(","));
  ok(result.excluded360.length === 1 && result.excluded360[0].name === "flat.jpg",
    "⑤b 360 아닌 사진은 excluded360 으로 명시(조용히 안 빠짐) → " + result.excluded360.map((r) => r.name).join(","));

  console.log("\n[뮤테이션⑤] 360 필터를 제거하면 ⑤a 가 실패해야 함(아무 사진이나 매칭됨)");
  const needle = 'if (row.is360 !== true) { excluded360.push(row); return; }';
  const mutated = pbSrc.replace(needle, '/* filter removed */');
  if (mutated === pbSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PB: PBm } = loadPB(mutated);
    const resultM = PBm._buildTimeMatches(pinList, rows, { toleranceMs: 60000 });
    ok(resultM.matches.length !== 1 || resultM.matches[0].row.name !== "pano.jpg",
      "뮤테이션 적용 시 360 아닌 사진도 매칭 후보에 섞임(테스트 실효성 증명) → " + JSON.stringify(resultM.matches.map((m) => m.row.name)));
  }
}

/* ══ ⑥ 허용오차 초과 → 미연결(작업 시간대 창 안쪽인데도 개별쌍이 벌어진 경우) ══════════════ */
{
  const { PB } = loadPB(pbSrc);
  // 핀 2개(0분, 25분)를 둬 창(=[min-10, max+10])을 넓혀서, far.jpg(20분)가 "창 안이지만
  // 개별 허용오차(10분)는 초과"인 상황을 만든다 — outOfWindow 가 아니라 unmatchedRows 로 남아야 함.
  const pins = [{ id: "A", page: 1, label: "1", createdAt: 0 }, { id: "B", page: 1, label: "2", createdAt: 25 * 60000 }];
  const pinList = [{ pin: pins[0], no: 1 }, { pin: pins[1], no: 2 }];
  const rows = [{ name: "far.jpg", is360: true, excluded: false, sortKey: 20 * 60000 }]; // A 와 20분 차이(초과), B 와 5분 차이(허용)
  const result = PB._buildTimeMatches(pinList, rows, { toleranceMs: 10 * 60000 });
  ok(result.matches.length === 1 && result.matches[0].no === 2,
    "⑥a 가까운 핀(B, 5분차)과는 연결, 먼 핀(A, 20분차)과는 그대로 미연결 → " + JSON.stringify(result.matches.map((m) => m.no)));
  ok(result.unmatchedPins.length === 1 && result.unmatchedPins[0].no === 1,
    "⑥b 허용오차 초과 핀은 unmatchedPins 로 남음(outOfWindow 아님, 창 안이므로) → " + JSON.stringify(result.unmatchedPins));
}

/* ══ ⑦ 시계보정(offsetMin) 반영 ══════════════════════════════════════════ */
{
  const { PB } = loadPB(pbSrc);
  const pins = [{ id: "A", page: 1, label: "1", createdAt: 20 * 60000 }]; // 핀 시각 = 20분
  const pinList = [{ pin: pins[0], no: 1 }];
  const rows = [{ name: "shifted.jpg", is360: true, excluded: false, sortKey: 0 }]; // 사진 시각 = 0분(보정 전엔 20분차, 허용오차 밖)
  const before = PB._buildTimeMatches(pinList, rows, { toleranceMs: 5 * 60000, offsetMin: 0 });
  ok(before.matches.length === 0, "⑦a 보정 전엔 20분 차이 → 미연결");
  const after = PB._buildTimeMatches(pinList, rows, { toleranceMs: 5 * 60000, offsetMin: 20 }); // 카메라 시계가 20분 느림 보정
  ok(after.matches.length === 1, "⑦b 시계보정(+20분) 반영 후 연결 → matches=" + after.matches.length);
}

/* ══ ⑧ 이미 360 있는 핀 기본 제외 / includeExisting360 ══════════════════ */
{
  const { PB } = loadPB(pbSrc);
  const pins = [{ id: "A", page: 1, label: "1", is360: true, createdAt: 0 }];
  const pinList = [{ pin: pins[0], no: 1 }];
  const rows = [{ name: "new360.jpg", is360: true, excluded: false, sortKey: 0 }];
  const resDefault = PB._buildTimeMatches(pinList, rows, { toleranceMs: 60000 });
  ok(resDefault.matches.length === 0 && resDefault.skippedExisting.length === 1,
    "⑧a 이미 360 있는 핀은 기본 제외(skippedExisting) → " + resDefault.skippedExisting.length);
  const resInclude = PB._buildTimeMatches(pinList, rows, { toleranceMs: 60000, includeExisting360: true });
  ok(resInclude.matches.length === 1, "⑧b includeExisting360=true 로 포함 → matches=" + resInclude.matches.length);
}

/* ══ [지휘자 발주 보강2 2026-09-29] ⑭ 작업 시간대 창 — 옛 사진 다수는 outOfWindow 로 개수만 ══
   마스터: "사진을 자동등록할 때 이 폴더로 지정해" / "가장 최근 파일부터 찾게 해"(폴더 전체 선택
   시 옛 사진 수백 장이 매칭 후보로 끼지 않게). */
{
  const { PB } = loadPB(pbSrc);
  const pins = [{ id: "A", page: 1, label: "1", createdAt: 1000 * 60000 }]; // 핀 시각 = 1000분
  const pinList = [{ pin: pins[0], no: 1 }];
  const rows = [
    { name: "recent.jpg", is360: true, excluded: false, sortKey: 1000 * 60000 }, // 창 안
    { name: "old1.jpg", is360: true, excluded: false, sortKey: 10 * 60000 },     // 창 밖(한참 옛날)
    { name: "old2.jpg", is360: true, excluded: false, sortKey: 20 * 60000 }      // 창 밖
  ];
  const result = PB._buildTimeMatches(pinList, rows, { toleranceMs: 10 * 60000 });
  ok(result.matches.length === 1 && result.matches[0].row.name === "recent.jpg",
    "⑭a 창 안 사진만 매칭 → " + result.matches.map((m) => m.row.name).join(","));
  ok(result.outOfWindow.length === 2 && result.outOfWindow.every((r) => /old/.test(r.name)),
    "⑭b 옛 사진 2장은 outOfWindow 로 분리(목록 전체를 안 그리고 개수만 표시할 근거) → " + result.outOfWindow.map((r) => r.name).join(","));

  console.log("\n[뮤테이션⑭] 작업 시간대 창 필터를 제거하면 ⑭b 가 실패해야 함(옛 사진도 매칭 시도됨)");
  const needle = "if (winMin != null && Number.isFinite(t) && (t < winMin || t > winMax)) { outOfWindow.push(row); return; }";
  const mutated = pbSrc.replace(needle, "");
  if (mutated === pbSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PB: PBm } = loadPB(mutated);
    const resultM = PBm._buildTimeMatches(pinList, rows, { toleranceMs: 10 * 60000 });
    ok(resultM.outOfWindow.length === 0,
      "뮤테이션 적용 시 작업창 분리가 사라짐(테스트 실효성 증명) → outOfWindow=" + resultM.outOfWindow.length);
  }
}

/* ══ [지휘자 발주 보강2] ⑮ 선택 파일 처리 순서 = 최신 우선 ══════════════════ */
async function testRecencyOrder() {
  const { PB, sandbox } = loadPB(pbSrc, { pins: [], pdfPage: 1 });
  const registry = new Map();
  function makeElement() {
    const el = { value: "", textContent: "", innerHTML: "", checked: false, style: {}, _listeners: {}, _classes: new Set() };
    el.classList = { add: (c) => el._classes.add(c), remove: (c) => el._classes.delete(c), contains: (c) => el._classes.has(c) };
    el.addEventListener = () => {}; el.click = () => {}; el.setAttribute = () => {};
    el.appendChild = (c) => { if (c && c.id) registry.set(c.id, c); };
    el.remove = () => {};
    return el;
  }
  sandbox.document = {
    getElementById: (id) => registry.get(id) || null,
    createElement: () => makeElement(),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    body: { appendChild: (el) => { if (el.id) registry.set(el.id, el); } },
    querySelectorAll: () => []
  };
  sandbox.navigator = { onLine: true };
  sandbox.Auth = { isDesigner: true };
  sandbox.Prompt = { toast() {} };
  sandbox.App = Object.assign(sandbox.App, { _detect360(file, cb) { cb(false, 0, 0); } });

  PB._tm = { rows: [], series: "content" };
  const parseOrder = [];
  // THETA 파일명 타임스탬프로 quick-time 을 매길 수 있는 3개 — 오래된→최신 순으로 "선택"됐다고 가정.
  const files = [
    { name: "R0001_20260101000000.jpg", slice: () => ({ arrayBuffer: async () => { parseOrder.push("old"); return new ArrayBuffer(0); } }) },
    { name: "R0002_20260601000000.jpg", slice: () => ({ arrayBuffer: async () => { parseOrder.push("mid"); return new ArrayBuffer(0); } }) },
    { name: "R0003_20260929000000.jpg", slice: () => ({ arrayBuffer: async () => { parseOrder.push("new"); return new ArrayBuffer(0); } }) }
  ];
  await PB._onTimeMatchFilesChosen(files);
  ok(parseOrder.join(",") === "new,mid,old", "⑮ 최신 파일부터 먼저 처리(EXIF 파싱 호출 순서) → " + parseOrder.join(","));
}

/* ══ ⑨⑩ DOM e2e — openTimeMatch → 선택 → 미리보기 → 적용(오프라인 큐잉 확인) ══ */
async function testDomE2E() {
  const pin = { id: "PIN1", page: 1, label: "1", checkboard: true, createdAt: 5 * 60000 }; // 핀 시각=5분
  const pins = [pin];
  const { PB, sandbox } = loadPB(pbSrc, { pins, pdfPage: 1 });

  const registry = new Map();
  const makeEl = () => ({
    value: "", textContent: "", innerHTML: "", checked: false, disabled: false,
    _classes: new Set(),
    classList: {
      add: (c) => elSelf._classes.add(c),
      remove: (c) => elSelf._classes.delete(c),
      contains: (c) => elSelf._classes.has(c)
    },
    _listeners: {},
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    click() {},
    setAttribute() {}, style: {}
  });
  // classList.add/remove 가 자기 자신을 가리키도록 클로저 재구성
  function makeElement() {
    const el = { value: "", textContent: "", innerHTML: "", checked: false, style: {}, _listeners: {}, _classes: new Set() };
    el.classList = {
      add: (c) => el._classes.add(c),
      remove: (c) => el._classes.delete(c),
      contains: (c) => el._classes.has(c)
    };
    el.addEventListener = (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); };
    el.click = () => {};
    el.setAttribute = () => {};
    el.appendChild = (c) => { if (c && c.id) registry.set(c.id, c); };
    el.remove = () => {};
    return el;
  }
  const bodyChildren = [];
  const document = {
    getElementById: (id) => registry.get(id) || null,
    createElement: (tag) => { const el = makeElement(); el.tagName = tag; return el; },
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    body: { appendChild: (el) => { bodyChildren.push(el); if (el.id) registry.set(el.id, el); } },
    querySelectorAll: () => []
  };
  sandbox.document = document;
  sandbox.navigator = { onLine: false }; // 오프라인 시나리오
  sandbox.Auth = { isDesigner: true };
  let uploadCalled = false, enqueueCalled = null;
  sandbox.Cloud = {
    _cache: {},
    async resizeImage(file) { return { dataURL: "data:image/jpeg;base64,AAA", width: 4000, height: 2000 }; },
    async uploadImage() { uploadCalled = true; return "should-not-be-called"; }
  };
  sandbox.SyncQueue = {
    async enqueue(op) { enqueueCalled = op; return "op-1"; }
  };
  let dirtyMarked = false;
  sandbox.App = Object.assign(sandbox.App, { _detect360(file, cb) { cb(true, 4000, 2000); }, _updateSyncBadge() {}, _markDirty() { dirtyMarked = true; } });
  sandbox.UI = { renderPinList() {}, renderPinsOnMap() {} };
  sandbox.Prompt = { toast() {} };

  PB.openTimeMatch({ series: "checkboard" });
  ok(document.getElementById("photobatch-tm-modal") != null, "⑨a openTimeMatch() 가 모달 DOM 을 생성함(index.html 무변경)");
  ok(document.getElementById("photobatch-tm-files") != null, "⑨b 파일 입력(input[multiple]) 생성됨");

  // 사용자가 사진 1장을 선택했다고 가정(핀 시각 5분과 근접한 EXIF 시각)
  const file = { name: "R0010001.jpg", lastModified: 5 * 60000, slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) };
  await PB._onTimeMatchFilesChosen([file]);
  const result = PB._tm.result;
  ok(!!result && result.matches.length === 1 && result.matches[0].pin === pin,
    "⑨c 선택 후 미리보기 결과에 핀↔파일 매칭 1건 → matches=" + (result && result.matches.length));
  ok(/R0010001\.jpg/.test(document.getElementById("photobatch-tm-list").innerHTML),
    "⑨d 미리보기 목록 렌더에 파일명 노출");

  await PB._applyTimeMatch();
  ok(pin.imageName === "R0010001", "⑨e 적용 후 핀에 imageName 반영(_uploadOneRow 재사용 = run()과 동일 SoT)");
  ok(pin.is360 === true, "⑨f pin.is360 반영");
  ok(uploadCalled === false, "⑩a 오프라인이므로 Cloud.uploadImage 는 호출되지 않음");
  ok(!!enqueueCalled && enqueueCalled.image_data === "data:image/jpeg;base64,AAA",
    "⑩b 오프라인 바이트가 SyncQueue.enqueue 로 큐잉됨(IndexedDB 'ops' 영속 경로, 05_SyncQueue.js:210-242) → " + JSON.stringify(enqueueCalled && enqueueCalled.kind));
  ok(pin.pendingOpId === "op-1" && pin.pendingSync === true, "⑩c pendingOpId/pendingSync 로 대기 상태 표시");
  ok(dirtyMarked === true, "⑨g 적용 후 App._markDirty() 만(자동저장 호출 없음)");
}

/* ══ ⑪ 32_Offline.js — 온라인 복귀 시 오프라인 중 생성된 핀이 있으면만 안내 ══ */
function testReconnectBanner() {
  const bannerCalls = [];
  const registry = new Map();
  function makeElement(id) {
    const el = { id, style: {}, _children: [], _listeners: {} };
    el.setAttribute = () => {};
    el.addEventListener = (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); };
    el.appendChild = (c) => { el._children.push(c); };
    el.remove = () => { if (id) registry.delete(id); };
    return el;
  }
  const document = {
    getElementById: (id) => registry.get(id) || null,
    createElement: () => makeElement(null),
    body: { appendChild: (el) => { if (el.id) registry.set(el.id, el); } }
  };
  const State = { pins: [] };
  const PinSeries = { createdAt(p) { return p && p.createdAt; } };
  const sandbox = makeSandbox({ document, State, PinSeries, setTimeout: () => 0, clearTimeout: () => {}, navigator: { onLine: true } });
  vm.runInContext(offlineSrc + "\n;globalThis.__updateNetBadge = updateNetBadge;", sandbox);

  // 시나리오 A: 오프라인 진입 → 핀 생성 없음 → 온라인 복귀 → 배너 없음
  sandbox._onGoOffline();
  sandbox._onGoOnline();
  ok(!document.getElementById("wm-theta-reconnect"), "⑪a 오프라인 중 핀 생성 없으면 배너 미표시");

  // 시나리오 B: 오프라인 진입 → 핀 생성됨(생성시각이 오프라인 시작 이후) → 온라인 복귀 → 배너 표시
  sandbox._onGoOffline();
  State.pins.push({ id: "p1", createdAt: Date.now() + 5 });
  sandbox._onGoOnline();
  ok(!!document.getElementById("wm-theta-reconnect"), "⑪b 오프라인 중 핀 생성되면 온라인 복귀 시 배너 표시");
}

/* ══ [지휘자 발주 보강 2026-09-29] ⑫⑬ THETA 실기기 파일명 타임스탬프 ══════════════
   마스터 실측: "R0013783_20260929155952.JPG"(/내장 저장공간/Pictures/RICOH THETA, Android). */
{
  const { PB } = loadPB(pbSrc);

  // ⑫a 파일명 패턴 파싱 자체
  const fn = PB._parseThetaFilenameDate("R0013783_20260929155952.JPG");
  ok(!!fn && fn.iso === "2026-09-29T15:59:52", "⑫a THETA 파일명 → 2026-09-29 15:59:52 로컬 → " + JSON.stringify(fn));
  ok(PB._isThetaFilename("R0013783_20260929155952.JPG") === true, "⑫b 파일명 THETA 신호 감지");
  ok(PB._isThetaFilename("normal_photo.jpg") === false, "⑫c 일반 파일명은 신호 없음");

  // ⑫d EXIF 없는 THETA 파일명만으로 시간순 정렬/시각 출처 표시가 성립
  const rows = PB._sortRows([{ name: "R0013783_20260929155952.JPG", exif: null, lastModified: 0 }]);
  ok(rows[0].sortKey === Date.parse("2026-09-29T15:59:52") && rows[0].timeSource === "파일명(THETA 타임스탬프)",
    "⑫d EXIF 없어도 파일명만으로 정확한 시각 추출 → " + rows[0].timeLabel + " / " + rows[0].timeSource);

  // ⑫e EXIF 없는 THETA 파일명만으로 핀과 실제 최근접 매칭 성공(end-to-end)
  const pinTime = Date.parse("2026-09-29T15:59:52");
  const pins = [{ id: pinTime, page: 1, label: "1", checkboard: true }];
  const pinList = PB._pinList(pins, 1, "checkboard");
  const rows360 = PB._sortRows([{ name: "R0013783_20260929155952.JPG", exif: null, lastModified: 0, is360: true, excluded: false }]);
  const result = PB._buildTimeMatches(pinList, rows360, { toleranceMs: 60000 });
  ok(result.matches.length === 1 && result.matches[0].row.name === "R0013783_20260929155952.JPG",
    "⑫e EXIF 없는 THETA 파일명만으로 핀 최근접 매칭 성공 → matches=" + result.matches.length);

  // ⑬ 파일명·EXIF 시각이 다르면 EXIF 가 우선(카메라가 기록한 진짜 촬영시각)
  const conflictRows = PB._sortRows([{
    name: "R0013783_20260929155952.JPG", // 파일명 시각 = 15:59:52
    exif: { iso: "2026-09-29T09:00:00", tag: "DateTimeOriginal" } // EXIF 시각 = 09:00:00(다름)
  }]);
  ok(conflictRows[0].sortKey === Date.parse("2026-09-29T09:00:00") && conflictRows[0].timeSource === "EXIF DateTimeOriginal",
    "⑬ 파일명·EXIF 불일치 시 EXIF 우선 → " + conflictRows[0].timeLabel + " / " + conflictRows[0].timeSource);

  console.log("\n[뮤테이션⑫] 파일명 THETA 타임스탬프 파싱을 무력화하면 ⑫d 가 실패해야 함");
  const needle = "const fnDate = this._parseThetaFilenameDate(r.name);";
  const mutated = pbSrc.replace(needle, "const fnDate = null;");
  if (mutated === pbSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PB: PBm } = loadPB(mutated);
    const rowsM = PBm._sortRows([{ name: "R0013783_20260929155952.JPG", exif: null, lastModified: 0 }]);
    ok(rowsM[0].timeSource !== "파일명(THETA 타임스탬프)",
      "뮤테이션 적용 시 파일명 시각추출이 사라져 mtime/파일명순으로 후퇴(테스트 실효성 증명) → " + rowsM[0].timeSource);
  }
}

/* ══ [지휘자 발주 보강3·4 2026-09-29] ⑯ PhotoNaming — 영역/구역 저장 이름 + 표시(+뮤테이션) ══
   마스터: "영역이나 구역이 있다면 그 사진은 영역이름_시간으로 변경해서 등록해" /
   "사진정보를 바로 알아볼 수 있게". */
function loadPBWithProjects(pbSource, State, Projects) {
  const AppMock = { pinHasContent(pin) { return !!(pin && (pin.imageId || pin.imageUrl || pin.videoId)); } };
  const sandbox = makeSandbox({ State, App: AppMock, Projects });
  vm.runInContext(seriesSrc + "\n" + pbSource + "\n;globalThis.__PB = PhotoBatch; globalThis.__PN = PhotoNaming;", sandbox);
  return { PB: sandbox.__PB, PN: sandbox.__PN };
}
{
  const pin = { id: "p1", page: 1, x: 50, y: 50 };

  // ⑯a 영역(crop 있는 자식 deck) 을 열어 편집 중이면 영역이름 우선
  {
    const decks = [
      { id: "d1", parent_id: null, name: "1구역" },
      { id: "d2", parent_id: "d1", name: "엔진룸", crop: { x: 0, y: 0, w: 100, h: 100 } }
    ];
    const { PN } = loadPBWithProjects(pbSrc, { pins: [pin] }, { currentDeck: decks[1], decks });
    const scope = PN.scopeOf(pin);
    ok(scope.area === "엔진룸" && scope.zone === "1구역", "⑯a 영역 열람 중 → area=영역이름, zone=부모 구역이름 → " + JSON.stringify(scope));
    const name = PN.name(pin, "photo.jpg", Date.parse("2026-01-01T00:00:00"), new Set());
    ok(name === "엔진룸_20260101000000.jpg", "⑯a2 저장 이름 = 영역이름_시각 → " + name);
  }

  // ⑯b 구역(비크롭, 자식 영역이 이 핀을 안 덮음) → 구역이름
  {
    const decks = [{ id: "d1", parent_id: null, name: "1구역" }];
    const { PN } = loadPBWithProjects(pbSrc, { pins: [pin] }, { currentDeck: decks[0], decks });
    const scope = PN.scopeOf(pin);
    ok(scope.area === null && scope.zone === "1구역", "⑯b 구역만 있으면 area=null, zone=구역이름 → " + JSON.stringify(scope));
    const name = PN.name(pin, "photo.jpg", Date.parse("2026-01-01T00:00:00"), new Set());
    ok(name === "1구역_20260101000000.jpg", "⑯b2 저장 이름 = 구역이름_시각 → " + name);
  }

  // ⑯c 겹치는 자식 영역이 있으면 면적이 작은 쪽 우선
  {
    const decks = [
      { id: "d1", parent_id: null, name: "1구역" },
      { id: "c1", parent_id: "d1", name: "큰영역", crop: { x: 10, y: 10, w: 80, h: 80 } },
      { id: "c2", parent_id: "d1", name: "작은영역", crop: { x: 40, y: 40, w: 20, h: 20 } }
    ];
    const { PN } = loadPBWithProjects(pbSrc, { pins: [pin] }, { currentDeck: decks[0], decks });
    ok(PN.scopeOf(pin).area === "작은영역", "⑯c 겹치면 면적 작은 영역 우선 → " + PN.scopeOf(pin).area);
  }

  // ⑯d 영역/구역 둘 다 없으면(Projects 없음) 원본 파일명 유지
  {
    const { PN } = loadPBWithProjects(pbSrc, { pins: [pin] }, undefined); // Projects 미주입
    ok(PN.name(pin, "original.jpg", Date.now(), new Set()) === "original.jpg", "⑯d 소속 없으면 원본 파일명 유지");
  }

  // ⑯e 금지문자 치환 + 충돌 시 접미사
  {
    const decks = [{ id: "d1", parent_id: null, name: 'A/B:C*D?"E<F>G|H' }];
    const { PN } = loadPBWithProjects(pbSrc, { pins: [pin] }, { currentDeck: decks[0], decks });
    const ts = Date.parse("2026-01-01T00:00:00");
    const n1 = PN.name(pin, "a.jpg", ts, new Set());
    ok(n1 === "A-B-C-D--E-F-G-H_20260101000000.jpg", "⑯e1 금지문자 → '-' 치환(인접 문자는 각각 치환, 뭉치지 않음) → " + n1);
    const used = new Set([n1]);
    const n2 = PN.name(pin, "b.jpg", ts, used);
    ok(n2 === n1.replace(".jpg", "_2.jpg"), "⑯e2 같은 이름 충돌 시 _2 접미사 → " + n2);
  }

  console.log("\n[뮤테이션⑯] 영역 우선순위를 구역 우선으로 바꾸면 ⑯a2 가 실패해야 함");
  const needle = "const label = scope.area || scope.zone;";
  const occurrences = (pbSrc.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
  const mutated = pbSrc.split(needle).join("const label = scope.zone || scope.area;");
  if (occurrences === 0) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const decks = [
      { id: "d1", parent_id: null, name: "1구역" },
      { id: "d2", parent_id: "d1", name: "엔진룸", crop: { x: 0, y: 0, w: 100, h: 100 } }
    ];
    const { PN: PNm } = loadPBWithProjects(mutated, { pins: [pin] }, { currentDeck: decks[1], decks });
    const nameM = PNm.name(pin, "photo.jpg", Date.parse("2026-01-01T00:00:00"), new Set());
    ok(nameM !== "엔진룸_20260101000000.jpg",
      "뮤테이션 적용 시 영역 대신 구역이름이 쓰임(테스트 실효성 증명) → " + nameM);
  }
}

await testDomE2E();
await testRecencyOrder();
testReconnectBanner();

console.log(failed === 0 ? "\n전체 PASS" : `\n${failed}건 FAIL`);
process.exit(failed === 0 ? 0 : 1);
