/**
 * E57 이미지/포즈 추출 — E57 안에 들어 있는 2D 이미지(구면/원통 파노라마 포함)를 실제로 꺼낸다.
 * 사용: node build-tools/e57-extract.mjs <파일.e57> [출력디렉터리]
 *
 * 왜 필요한가: 이 앱의 360 뷰어는 등장방형(equirectangular) 이미지를 쓴다.
 * E57 이 구면 이미지를 품고 있다면 점군 변환 없이도 기존 뷰어에 바로 태울 수 있다.
 *
 * 물리 구조 주의: 모든 섹션이 pageSize(1024) 페이지에 담기고 각 페이지 끝 4바이트는 CRC.
 * 블롭 섹션은 선두 16바이트가 섹션 헤더(1바이트 타입 + 7 예약 + 8바이트 논리길이)다.
 */
import { openSync, readSync, closeSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const path = process.argv[2];
const outDir = process.argv[3] || ".";
if (!path) { console.error("usage: node build-tools/e57-extract.mjs <file.e57> [outDir]"); process.exit(2); }

const fd = openSync(path, "r");
const PAGE = 1024, LOGICAL = PAGE - 4;

/** 물리 오프셋에서 CRC 를 건너뛰며 논리 바이트 len 개를 읽는다 */
function readLogical(physOffset, len) {
  const out = Buffer.alloc(len);
  const page = Buffer.alloc(PAGE);
  let got = 0, phys = physOffset;
  while (got < len) {
    const pageStart = Math.floor(phys / PAGE) * PAGE;
    const inPage = phys - pageStart;
    readSync(fd, page, 0, PAGE, pageStart);
    const avail = Math.min(LOGICAL - inPage, len - got);
    if (avail <= 0) break;
    page.copy(out, got, inPage, inPage + avail);
    got += avail;
    phys = pageStart + PAGE;
  }
  return out.subarray(0, got);
}

try {
  const head = Buffer.alloc(48); readSync(fd, head, 0, 48, 0);
  if (head.toString("ascii", 0, 8) !== "ASTM-E57") { console.log(JSON.stringify({ ok:false, reason:"not e57" })); process.exit(1); }
  const xmlOff = Number(head.readBigUInt64LE(24)), xmlLen = Number(head.readBigUInt64LE(32));
  const xml = readLogical(xmlOff, xmlLen).toString("utf8");

  // 이미지 표현 종류: sphericalRepresentation(구면 파노라마) / pinholeRepresentation / cylindricalRepresentation
  const kinds = ["sphericalRepresentation", "cylindricalRepresentation", "pinholeRepresentation"];
  const found = [];
  for (const kind of kinds) {
    const re = new RegExp(`<${kind}[^>]*>([\s\S]*?)</${kind}>`, "g");
    let m;
    while ((m = re.exec(xml))) {
      const body = m[1];
      const blob = body.match(/<(jpegImage|pngImage)[^>]*fileOffset="(\d+)"[^>]*length="(\d+)"/) ||
                   body.match(/<(jpegImage|pngImage)[^>]*length="(\d+)"[^>]*fileOffset="(\d+)"/);
      const w = body.match(/<imageWidth[^>]*>(\d+)</), h = body.match(/<imageHeight[^>]*>(\d+)</);
      if (blob) {
        const isOffsetFirst = /fileOffset="\d+"[^>]*length=/.test(blob[0]);
        found.push({
          kind, fmt: blob[1],
          fileOffset: Number(isOffsetFirst ? blob[2] : blob[3]),
          length: Number(isOffsetFirst ? blob[3] : blob[2]),
          width: w ? Number(w[1]) : null, height: h ? Number(h[1]) : null
        });
      }
    }
  }

  const poses = (xml.match(/<pose[\s\S]*?<\/pose>/g) || []).length;
  const written = [];
  found.forEach((img, i) => {
    // 블롭 섹션: 선두 16바이트 = 섹션헤더(타입1 + 예약7 + 논리길이8)
    const hdr = readLogical(img.fileOffset, 16);
    const declared = Number(hdr.readBigUInt64LE(8));
    const dataLen = img.length || declared;
    const data = readLogical(img.fileOffset + 16, dataLen);
    const isJpeg = data[0] === 0xFF && data[1] === 0xD8;
    const isPng  = data[0] === 0x89 && data.toString("ascii",1,4) === "PNG";
    const name = `e57-img-${i}-${img.kind.replace("Representation","")}.${isPng ? "png" : "jpg"}`;
    if (isJpeg || isPng) {
      try { mkdirSync(outDir, { recursive: true }); } catch (e) {}
      writeFileSync(join(outDir, name), data);
      written.push({ name, bytes: data.length, kind: img.kind, w: img.width, h: img.height,
                     ratio: img.width && img.height ? +(img.width / img.height).toFixed(3) : null });
    } else {
      written.push({ name, error: "블롭 선두가 JPEG/PNG 시그니처가 아님", first4: [...data.subarray(0,4)], sectionDeclaredLen: declared });
    }
  });

  console.log(JSON.stringify({ ok:true, imagesInXml: found.length, poseNodes: poses, written }, null, 2));
} finally { closeSync(fd); }
