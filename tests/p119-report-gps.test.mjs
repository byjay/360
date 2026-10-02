/**
 * p119 — WO 20261002-gap ★1(점검 보고서 CSV+인쇄) + WO 20261001-gps(GPS 자동 기록)
 * (프레임워크 0 · 실행: node tests/p119-report-gps.test.mjs)
 *
 * [재현] 지휘자 발주서 인용(HEAD 4073788):
 *   R1 `git grep -n "exportCsv|head = \[" HEAD -- public/js/modules/19_PinGrid.js` → :142 exportCsv,
 *      6열(No,Name,Page,X,Y,Has360), 현재 페이지만 → FAIL(보고서용 열과 범위가 없다)
 *   R2 `git grep -n -E "@media print|@page" HEAD -- public/css` → 0건 → FAIL(인쇄 보고서가 없다)
 *   R3 `grep -rn "geolocation" public/js` → 0건(이 턴 재확인) → FAIL(GPS 자동 기록이 없다)
 *
 * 🔴 목 금지 — 실제 소스(47_Report.js/48_GPS.js)를 vm에 그대로 평가해 검증한다(p116/p117 관례).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const reportSrc = rd("public/js/modules/47_Report.js");
const gpsSrc = rd("public/js/modules/48_GPS.js");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };

function makeReport() {
  const sandbox = { console, Auth: { role: "designer" } };
  vm.createContext(sandbox);
  vm.runInContext(reportSrc + "\n;globalThis.__Report = Report;", sandbox);
  return sandbox.__Report;
}

/* ══════════════════════════════════════════════════════════════
 * ① Report._rows — 14열, 행수=핀수, 구역/영역/모드/번호 매핑, 값 없으면 빈칸
 * ══════════════════════════════════════════════════════════════ */
function testRowsBasic() {
  console.log("\n[① Report._rows — 14열/행수/매핑]");
  const Report = makeReport();
  const decks = [{ id: "d1", name: "Main Deck", page: 1, zones: [{ label: "1번 화물창", pinIds: ["p1"] }] }];
  const pins = [
    { id: "p1", page: 1, x: 10.5, y: 20.25, label: "P1", checkboard: true, author: "pak@seastar.test", shotAt: 1700000000000, shotSrc: "EXIF DateTimeOriginal", imageName: "img1", attachments: [{ id: "a1" }] },
    { id: "p2", page: 1, x: 30, y: 40, label: "P2" } // 사진·시각·작성자 전부 없음 — 빈칸 확인
  ];
  const notes = [
    { pin_id: "p1", status: "open", author: "kim@seastar.test" },
    { pin_id: "p1", status: "done", author: "kim@seastar.test" }
  ];
  const rows = Report._rows(pins, notes, decks, "designer");
  ok(rows.length === pins.length, "행 수 = 핀 수(" + rows.length + "===" + pins.length + ")");
  ok(rows.every((r) => r.length === 14), "모든 행이 14열 — " + JSON.stringify(rows.map((r) => r.length)));
  ok(Report.COLUMNS.length === 14, "COLUMNS 헤더도 14개");
  const r1 = rows[0];
  ok(r1[0] === "Main Deck", "구역(deck.name) = Main Deck — " + r1[0]);
  ok(r1[1] === "1번 화물창", "영역(zone.label, pinIds 매칭) = 1번 화물창 — " + r1[1]);
  ok(r1[2] === "CHECKER", "모드 = checkboard:true → CHECKER — " + r1[2]);
  ok(r1[4] === "P1", "라벨 = P1");
  ok(r1[5] === "2023-11-14 22:13:20", "촬영시각 UTC 고정 포맷 — " + r1[5]);
  ok(r1[6] === "EXIF DateTimeOriginal", "시각출처(shotSrc)");
  ok(r1[7] === "img1", "사진명(imageName)");
  ok(r1[8] === 1, "첨부수 = 1");
  ok(r1[9] === 2, "노트수 = 2(해당 pin_id만)");
  ok(r1[10] === 1, "미해결수 = 1(status!=='done')");
  ok(r1[11] === "pak@seastar.test", "작성자(designer 역할) = pin.author");
  ok(r1[12] === "10.50" && r1[13] === "20.25", "X%/Y% 소수점 2자리");
  const r2 = rows[1];
  ok(r2[0] === "Main Deck" && r2[1] === "", "핀2: 구역은 페이지 매칭, 영역은 pinIds 미포함 → 빈칸");
  ok(r2[2] === "360", "핀2: checkboard 없음 → 360 계열");
  ok(r2[5] === "" && r2[6] === "" && r2[7] === "" && r2[11] === "", "핀2: 촬영시각/출처/사진명/작성자 전부 빈칸(지어내지 않음) — " + JSON.stringify(r2));
  ok(r2[8] === 0 && r2[9] === 0 && r2[10] === 0, "핀2: 첨부/노트/미해결 = 0(실제 0, 빈칸 아님)");
}

/* ══════════════════════════════════════════════════════════════
 * ② Report._rows — 열람자(viewer) 역할 → 작성자 열에 이메일 0건
 * ══════════════════════════════════════════════════════════════ */
function testViewerNoEmail() {
  console.log("\n[② 열람자 역할 — 이메일 제외]");
  const Report = makeReport();
  const pins = [{ id: "p1", page: 1, x: 1, y: 1, label: "P1", author: "pak@seastar.test" }];
  const notes = [{ pin_id: "p1", status: "open", author: "kim@seastar.test", author_email: "kim@seastar.test" }];
  const rowsViewer = Report._rows(pins, notes, [], "viewer");
  const rowsDesigner = Report._rows(pins, notes, [], "designer");
  const hasEmail = (v) => typeof v === "string" && v.indexOf("@") !== -1;
  ok(!rowsViewer.some((r) => r.some(hasEmail)), "viewer 행 전체에 '@' 포함 문자열 0건");
  ok(rowsDesigner[0][11] === "pak@seastar.test", "designer는 작성자 열에 이메일 유지(대조군)");
}

/* ══════════════════════════════════════════════════════════════
 * ③ Report._toCsv — UTF-8 BOM + 헤더 + 이스케이프
 * ══════════════════════════════════════════════════════════════ */
function testCsv() {
  console.log("\n[③ Report._toCsv — BOM/헤더]");
  const Report = makeReport();
  const csv = Report._toCsv([["구역A", "", "360", 1, "라벨,쉼표", "", "", "", 0, 0, 0, "", "1.00", "2.00"]]);
  ok(csv.charCodeAt(0) === 0xFEFF, "BOM(U+FEFF) 선두");
  ok(csv.indexOf(Report.COLUMNS[0]) !== -1, "헤더 포함");
  ok(csv.indexOf('"라벨,쉼표"') !== -1, "쉼표 포함 값 CSV 이스케이프");
}

/* ══════════════════════════════════════════════════════════════
 * ④ GPS — 순수 포맷 함수(정확도 경고/지도 링크/표시 문자열)
 * ══════════════════════════════════════════════════════════════ */
function makeGPS(extra) {
  const store = new Map();
  const sandbox = Object.assign({
    console,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    },
    window: { matchMedia: (q) => ({ matches: false }) },
    navigator: {}
  }, extra || {});
  vm.createContext(sandbox);
  vm.runInContext(gpsSrc + "\n;globalThis.__GPS = GPS;", sandbox);
  return { GPS: sandbox.__GPS, store };
}

function testPureFormatters() {
  console.log("\n[④ GPS 순수 포맷 함수]");
  const { GPS } = makeGPS();
  ok(GPS.accWarning({ acc: 12 }) === null, "정확도 12m → 경고 없음");
  ok(GPS.accWarning({ acc: 80 }) === "위치 부정확(±80m)", "정확도 80m(≥50) → 경고 문자열 — " + GPS.accWarning({ acc: 80 }));
  ok(GPS.accWarning(null) === null, "gps 없음 → null(지어내지 않음)");
  const url = GPS.mapUrl({ lat: 35.1023, lng: 129.0401 });
  ok(url && url.indexOf("35.1023") !== -1 && url.indexOf("129.0401") !== -1, "지도 링크에 좌표 포함 — " + url);
  ok(GPS.mapUrl(null) === null, "gps 없음 → 지도 링크 null");
  const disp = GPS.displayText({ lat: 35.1023, lng: 129.0401, acc: 12, ts: Date.UTC(2026, 9, 2, 14, 32, 0) });
  ok(disp.indexOf("35.1023") !== -1 && disp.indexOf("129.0401") !== -1 && disp.indexOf("±12m") !== -1 && disp.indexOf("14:32") !== -1,
    "표시 문자열 좌표+정확도+시각 — " + disp);
  ok(GPS.displayText(null) === "", "gps 없음 → 빈 문자열(값 없으면 빈칸, 지어내지 않음)");
}

/* ══════════════════════════════════════════════════════════════
 * ⑤ GPS.capture — 성공/거부 경로(비동기, navigator.geolocation 스텁)
 * ══════════════════════════════════════════════════════════════ */
async function testCaptureSuccessAndDenied() {
  console.log("\n[⑤ GPS.capture — 성공/거부, 거부 후 재요청 없음]");
  let calls = 0;
  const { GPS, store } = makeGPS({
    window: { matchMedia: () => ({ matches: true }) }, // 모바일 가정 → enabled() 기본 true
    navigator: {
      geolocation: {
        getCurrentPosition: (succ, fail) => { calls++; succ({ coords: { latitude: 35.1, longitude: 129.2, accuracy: 10, altitude: null } }); }
      }
    }
  });
  const g = await GPS.capture();
  ok(g && g.lat === 35.1 && g.lng === 129.2 && g.acc === 10 && g.src === "device", "성공 경로 → {lat,lng,acc,src:'device'} — " + JSON.stringify(g));
  ok(calls === 1, "getCurrentPosition 1회 호출");

  let calls2 = 0;
  const { GPS: GPS2 } = makeGPS({
    window: { matchMedia: () => ({ matches: true }) },
    navigator: { geolocation: { getCurrentPosition: (succ, fail) => { calls2++; fail({ code: 1 }); } } }
  });
  const g2 = await GPS2.capture();
  ok(g2 === null, "권한 거부 → null(저장 안 함, 조용한 실패는 아님 — 호출자가 '위치 없음' 표시)");
  const g3 = await GPS2.capture();
  ok(g3 === null && calls2 === 1, "거부 후 두 번째 호출은 getCurrentPosition 재호출 없음(다시 묻지 않음) — calls=" + calls2);

  // attachToPin: EXIF 이미 있으면 기기 GPS로 덮지 않음(판정기준 §2)
  const { GPS: GPS3 } = makeGPS({
    window: { matchMedia: () => ({ matches: true }) },
    navigator: { geolocation: { getCurrentPosition: (succ) => succ({ coords: { latitude: 1, longitude: 1, accuracy: 1 } }) } }
  });
  const pinWithExif = { id: "x", gps: { lat: 9, lng: 9, src: "exif" } };
  GPS3.attachToPin(pinWithExif);
  await new Promise((r) => setTimeout(r, 0));
  ok(pinWithExif.gps.src === "exif" && pinWithExif.gps.lat === 9, "EXIF GPS 있으면 기기 GPS로 덮지 않음");

  const pinNoGps = { id: "y" };
  GPS3.attachToPin(pinNoGps);
  await new Promise((r) => setTimeout(r, 0));
  ok(pinNoGps.gps && pinNoGps.gps.src === "device" && pinNoGps.gps.lat === 1, "EXIF 없으면 attachToPin이 기기 GPS로 채움 — " + JSON.stringify(pinNoGps.gps));
}

/* ══════════════════════════════════════════════════════════════
 * ⑥ GPS.parseExifGPS — 합성 JPEG(APP1/TIFF/GPS IFD) 버퍼 파싱
 * ══════════════════════════════════════════════════════════════ */
function buildJpegGpsBuffer() {
  const buf = new ArrayBuffer(140);
  const b = new DataView(buf);
  let o = 0;
  const u8 = (v) => { b.setUint8(o, v); o++; };
  const asc = (s) => { for (const ch of s) u8(ch.charCodeAt(0)); };
  const u16be = (v) => { b.setUint16(o, v, false); o += 2; };
  const u16le = (v) => { b.setUint16(o, v, true); o += 2; };
  const u32le = (v) => { b.setUint32(o, v, true); o += 4; };

  u8(0xFF); u8(0xD8);              // SOI
  u8(0xFF); u8(0xE1);              // APP1
  u16be(136);                      // segLen (content 134 + 2)
  asc("Exif"); u8(0); u8(0);       // "Exif\0\0" (6)
  const tiffStart = o;             // = 12
  asc("II");                       // byte order
  u16le(42);                       // TIFF magic
  u32le(8);                        // IFD0 offset(relative)=8
  // IFD0 @ tiffStart+8
  u16le(1);                        // 1 entry
  u16le(0x8825); u16le(4); u32le(1); u32le(26); // GPS IFD pointer(LONG) → relative 26
  u32le(0);                        // next IFD = 0
  // GPS IFD @ tiffStart+26 = absolute 38
  u16le(4);                        // 4 entries
  u16le(0x0001); u16le(2); u32le(2); u8(0x4E); u8(0); u8(0); u8(0);       // GPSLatitudeRef='N'
  u16le(0x0002); u16le(5); u32le(3); u32le(80);                           // GPSLatitude → rel 80
  u16le(0x0003); u16le(2); u32le(2); u8(0x45); u8(0); u8(0); u8(0);       // GPSLongitudeRef='E'
  u16le(0x0004); u16le(5); u32le(3); u32le(104);                         // GPSLongitude → rel 104
  u32le(0);                        // next IFD = 0
  // GPSLatitude rational[3] @ tiffStart+80 = absolute 92
  u32le(35); u32le(1);  u32le(0); u32le(1);  u32le(0); u32le(1);          // 35°00'00"
  // GPSLongitude rational[3] @ tiffStart+104 = absolute 116
  u32le(129); u32le(1); u32le(0); u32le(1);  u32le(0); u32le(1);          // 129°00'00"
  if (o !== 140) throw new Error("buffer layout mismatch, got " + o);
  return buf;
}

function testParseExifGPS() {
  console.log("\n[⑥ GPS.parseExifGPS — 합성 JPEG 버퍼]");
  const { GPS } = makeGPS();
  const buf = buildJpegGpsBuffer();
  const g = GPS.parseExifGPS(buf);
  ok(!!g, "GPS IFD 파싱 성공(null 아님)");
  ok(g && g.lat === 35 && g.lng === 129 && g.src === "exif", "위도35/경도129/src=exif — " + JSON.stringify(g));
  const notExif = GPS.parseExifGPS(new ArrayBuffer(10));
  ok(notExif === null, "너무 짧은/비JPEG 버퍼 → null(예외 없이 조용한 실패 아님, 빈 결과로 '위치 없음' 처리)");
}

(async () => {
  testRowsBasic();
  testViewerNoEmail();
  testCsv();
  testPureFormatters();
  await testCaptureSuccessAndDenied();
  testParseExifGPS();

  console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
  process.exit(failed === 0 ? 0 : 1);
})();
