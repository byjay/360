/**
 * 사진 시간순 정렬 검증기 — "핀 번호 ↔ 촬영시각 1:1 매칭"이 실제 사진에서 성립하는지 확인한다.
 * 사용: node build-tools/photo-timesort.mjs <폴더> [핀시작번호=1]
 *
 * 정렬 기준 우선순위(브라우저 구현도 이 순서를 그대로 따른다):
 *   1) EXIF DateTimeOriginal (진짜 촬영시각)
 *   2) 파일 수정시각(mtime) — 복사 시 바뀔 수 있어 신뢰도 낮음
 *   3) 파일명 자연정렬 — 최후 수단
 * 각 항목이 어느 기준으로 정렬됐는지 반드시 표시한다(추측을 사실처럼 보이면 안 된다).
 */
import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, extname } from "node:path";

const dir = process.argv[2];
const startNo = Number(process.argv[3] || 1);
if (!dir) { console.error("usage: node build-tools/photo-timesort.mjs <dir> [startNo]"); process.exit(2); }

/** JPEG 선두에서 EXIF DateTimeOriginal(0x9003)과 SOF 크기를 한 번에 뽑는다 */
function readJpegMeta(path, probeBytes = 256 * 1024) {
  const fd = openSync(path, "r");
  try {
    const st = statSync(path);
    const len = Math.min(probeBytes, st.size);
    const b = Buffer.alloc(len);
    readSync(fd, b, 0, len, 0);
    if (b[0] !== 0xFF || b[1] !== 0xD8) return { error: "JPEG 아님" };

    let i = 2, exif = null, size = null;
    while (i < b.length - 4) {
      if (b[i] !== 0xFF) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
      const segLen = b.readUInt16BE(i + 2);
      const segStart = i + 4;

      // SOF0..SOF15(=크기). DHT/DAC/SOS 는 제외
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        size = { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      }
      // APP1 = EXIF
      if (marker === 0xE1 && b.toString("ascii", segStart, segStart + 4) === "Exif") {
        exif = parseExifDate(b, segStart + 6, Math.min(segStart + segLen, b.length));
      }
      if (marker === 0xDA) break;           // SOS 이후는 압축 데이터
      i = segStart + segLen - 2;
      if (segLen <= 0) break;
    }
    return { exif, size };
  } finally { closeSync(fd); }
}

/** TIFF 헤더부터 IFD0 + ExifIFD 를 훑어 DateTimeOriginal(0x9003)/DateTime(0x0132) 를 찾는다 */
function parseExifDate(b, tiffStart, end) {
  if (tiffStart + 8 > end) return null;
  const le = b.toString("ascii", tiffStart, tiffStart + 2) === "II";
  const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  if (u16(tiffStart + 2) !== 42) return null;

  let best = null;
  const walk = (ifdOff, depth) => {
    if (depth > 2) return;
    const at = tiffStart + ifdOff;
    if (at + 2 > end) return;
    const n = u16(at);
    for (let k = 0; k < n; k++) {
      const e = at + 2 + k * 12;
      if (e + 12 > end) return;
      const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
      const valOff = (type === 2 && cnt > 4) ? tiffStart + u32(e + 8) : e + 8;
      if (tag === 0x8769) { walk(u32(e + 8), depth + 1); continue; }   // ExifIFD 포인터
      if ((tag === 0x9003 || tag === 0x9004 || tag === 0x0132) && type === 2 && valOff + 19 <= end) {
        const s = b.toString("ascii", valOff, valOff + 19);            // "YYYY:MM:DD HH:MM:SS"
        const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
        if (m) {
          const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
          // DateTimeOriginal(0x9003) 이 가장 정확 → 있으면 그것으로 확정
          if (tag === 0x9003) return (best = { iso, tag: "DateTimeOriginal" });
          if (!best) best = { iso, tag: tag === 0x9004 ? "DateTimeDigitized" : "DateTime" };
        }
      }
    }
  };
  walk(u32(tiffStart + 4), 0);
  return best;
}

/** 파일명 자연정렬(숫자를 숫자로) */
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

const IMG = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const files = readdirSync(dir).filter(f => IMG.has(extname(f).toLowerCase()));

const rows = files.map(name => {
  const p = join(dir, name);
  const st = statSync(p);
  let meta = {};
  try { meta = readJpegMeta(p); } catch (e) { meta = { error: String(e.message || e) }; }
  const exifIso = meta.exif && meta.exif.iso;
  const ratio = meta.size ? +(meta.size.w / meta.size.h).toFixed(3) : null;
  return {
    name,
    sortKey: exifIso ? Date.parse(exifIso) : st.mtimeMs,
    timeSource: exifIso ? ("EXIF " + meta.exif.tag) : "파일수정시각",
    time: exifIso || new Date(st.mtimeMs).toISOString().slice(0, 19),
    w: meta.size && meta.size.w, h: meta.size && meta.size.h, ratio,
    is360: !!(ratio && ratio >= 1.85 && ratio <= 2.15 && meta.size.w >= 1024),
    sizeMB: +(st.size / 1048576).toFixed(2)
  };
});

rows.sort((a, b) => (a.sortKey - b.sortKey) || natural(a.name, b.name));
rows.forEach((r, i) => { r.pinNo = startNo + i; });

const exifCount = rows.filter(r => r.timeSource.startsWith("EXIF")).length;
const n360 = rows.filter(r => r.is360).length;
console.log(JSON.stringify({
  dir, photos: rows.length,
  exifTimeCount: exifCount, mtimeFallbackCount: rows.length - exifCount,
  is360Count: n360, notEquirect: rows.filter(r => !r.is360).map(r => r.name + " " + r.w + "x" + r.h),
  firstTime: rows[0] && rows[0].time, lastTime: rows[rows.length - 1] && rows[rows.length - 1].time,
  mapping: rows.map(r => ({ pin: r.pinNo, file: r.name, time: r.time, src: r.timeSource, wh: r.w + "x" + r.h, is360: r.is360 }))
}, null, 2));
