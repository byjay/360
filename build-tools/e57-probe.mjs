/**
 * E57 프로브 — 파일을 실제로 열어 헤더/XML 섹션을 읽고, 이 뷰어에 넣을 수 있는지 판단 근거를 뽑는다.
 * 사용: node build-tools/e57-probe.mjs <파일.e57>
 *
 * E57(ASTM E2807) 물리 구조:
 *  - 헤더 48바이트: "ASTM-E57"(8) major(u32) minor(u32) fileLength(u64) xmlOffset(u64) xmlLength(u64) pageSize(u64)
 *  - 파일은 pageSize(기본 1024) 단위 페이지이며 각 페이지 끝 4바이트는 CRC → 논리 데이터는 페이지당 pageSize-4 바이트.
 *    따라서 XML 을 꺼내려면 물리 오프셋에서 CRC 를 걷어내며 읽어야 한다(이 부분을 빠뜨리면 XML 이 깨진다).
 */
import { openSync, readSync, closeSync, statSync } from "node:fs";

const path = process.argv[2];
if (!path) { console.error("usage: node build-tools/e57-probe.mjs <file.e57>"); process.exit(2); }

const fd = openSync(path, "r");
try {
  const size = statSync(path).size;
  const head = Buffer.alloc(48);
  readSync(fd, head, 0, 48, 0);
  const sig = head.toString("ascii", 0, 8);
  if (sig !== "ASTM-E57") { console.log(JSON.stringify({ ok: false, reason: "signature mismatch", sig })); process.exit(1); }

  const major = head.readUInt32LE(8), minor = head.readUInt32LE(12);
  const fileLen = Number(head.readBigUInt64LE(16));
  const xmlOff  = Number(head.readBigUInt64LE(24));
  const xmlLen  = Number(head.readBigUInt64LE(32));
  const pageSize = Number(head.readBigUInt64LE(40)) || 1024;
  const logicalPerPage = pageSize - 4;   // 페이지 끝 4바이트 = CRC

  // 물리 오프셋 → CRC 를 건너뛰며 논리 바이트 xmlLen 만큼 수집
  const out = Buffer.alloc(xmlLen);
  let got = 0, phys = xmlOff;
  const page = Buffer.alloc(pageSize);
  while (got < xmlLen) {
    const pageStart = Math.floor(phys / pageSize) * pageSize;
    const inPage = phys - pageStart;
    readSync(fd, page, 0, pageSize, pageStart);
    const avail = Math.min(logicalPerPage - inPage, xmlLen - got);
    if (avail <= 0) break;
    page.copy(out, got, inPage, inPage + avail);
    got += avail;
    phys = pageStart + pageSize + 0;     // 다음 페이지 선두로
    if (got < xmlLen) phys = pageStart + pageSize;
  }
  const xml = out.toString("utf8", 0, got);

  const count = (re) => (xml.match(re) || []).length;
  const num = (re) => { const m = xml.match(re); return m ? Number(m[1]) : null; };
  const scans  = count(/<vectorChild[^>]*type="Structure"/g) || count(/<points\b/g);
  const points = (xml.match(/recordCount="(\d+)"/g) || []).map(s => Number(s.match(/\d+/)[0]));
  const totalPts = points.reduce((a, b) => a + b, 0);

  console.log(JSON.stringify({
    ok: true, file: path, sizeMB: +(size / 1048576).toFixed(1),
    version: major + "." + minor, headerFileLength: fileLen, pageSize,
    xmlOffset: xmlOff, xmlLength: xmlLen, xmlRead: got,
    xmlWellFormedGuess: xml.trimStart().startsWith("<?xml"),
    scanCount: scans, pointRecordCounts: points.slice(0, 10), totalPoints: totalPts,
    hasImages: /<images2D\b/.test(xml), hasColor: /colorRed/.test(xml), hasIntensity: /intensity/.test(xml),
    xmlHead: xml.slice(0, 400)
  }, null, 2));
} finally { closeSync(fd); }
