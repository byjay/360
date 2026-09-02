/**
 * E57 CompressedVector 최소 디코더 — "정말 읽을 수 있나"를 좌표값으로 증명하는 도구.
 * 사용: node build-tools/e57-decode-sample.mjs <파일.e57> [뽑을점수=10]
 *
 * ponytail: 첫 데이터 패킷만 해석한다(전체 스트리밍/인덱스 패킷/다중 패킷 미지원).
 *   목적이 "가능 여부 증명"이라 최소로 짰다. 실제 도입 시엔 서버측 변환기를 쓴다(README 참조).
 *
 * 물리 구조: 모든 섹션이 1024B 페이지에 담기고 페이지 끝 4B 는 CRC → 논리 바이트만 이어붙여야 한다.
 * CompressedVector 섹션 헤더(32B): id(1) 예약(7) 논리길이(8) dataPhysOffset(8) indexPhysOffset(8)
 * 데이터 패킷: type(1) flags(1) len-1(2) bytestreamCount(2) [각 스트림 바이트길이(2)]* [스트림들]
 * 각 스트림은 필드 하나의 값들을 LSB 우선으로 비트팩한 것.
 */
import { openSync, readSync, closeSync } from "node:fs";

const path = process.argv[2];
const want = Number(process.argv[3] || 10);
if (!path) { console.error("usage: node build-tools/e57-decode-sample.mjs <file.e57> [n]"); process.exit(2); }

const fd = openSync(path, "r");
const PAGE = 1024, LOGICAL = PAGE - 4;
function readLogical(physOffset, len) {
  const out = Buffer.alloc(len), pg = Buffer.alloc(PAGE);
  let got = 0, phys = physOffset;
  while (got < len) {
    const ps = Math.floor(phys / PAGE) * PAGE, ip = phys - ps;
    readSync(fd, pg, 0, PAGE, ps);
    const a = Math.min(LOGICAL - ip, len - got);
    if (a <= 0) break;
    pg.copy(out, got, ip, ip + a); got += a; phys = ps + PAGE;
  }
  return out.subarray(0, got);
}
/** 필드 정의를 prototype XML 에서 뽑는다 — 손목록 금지, 파일이 정본이다 */
function parsePrototype(xml) {
  // 주의: XML 안에는 prototype 이 여러 개다(색인용 CompressedVector 가 앞에 온다).
  //   반드시 <points type="CompressedVector"> **뒤에 오는** prototype 을 써야 한다.
  //   앞엣것을 쓰면 startPointIndex/idElementValue/pointCount 로 잘못 해석된다(실측 오류).
  const pointsAt = xml.indexOf('<points type="CompressedVector"');
  const from = pointsAt >= 0 ? pointsAt : 0;
  const s0 = xml.indexOf("<prototype", from), s1 = xml.indexOf("</prototype>", s0);
  const p = xml.slice(s0, s1);
  const fields = [];
  const re = /<(\w+)\s+type="(Float|Integer|ScaledInteger)"([^/>]*)\/>/g;
  let m;
  while ((m = re.exec(p))) {
    const [, name, type, attrs] = m;
    if (type === "Float") {
      const single = /precision="single"/.test(attrs);
      fields.push({ name, type, bits: single ? 32 : 64, single });
    } else {
      const min = Number((attrs.match(/minimum="(-?\d+)"/) || [, 0])[1]);
      const max = Number((attrs.match(/maximum="(-?\d+)"/) || [, 0])[1]);
      const range = max - min;
      const bits = range <= 0 ? 0 : Math.ceil(Math.log2(range + 1));
      fields.push({ name, type, bits, min, max });
    }
  }
  return fields;
}
/** LSB 우선 비트 리더 */
function bitReader(buf) {
  let bit = 0;
  return (n) => {
    let v = 0n;
    for (let i = 0; i < n; i++) {
      const byte = buf[bit >> 3];
      if (byte === undefined) return null;
      v |= BigInt((byte >> (bit & 7)) & 1) << BigInt(i);
      bit++;
    }
    return v;
  };
}

try {
  const h = Buffer.alloc(48); readSync(fd, h, 0, 48, 0);
  const xml = readLogical(Number(h.readBigUInt64LE(24)), Number(h.readBigUInt64LE(32))).toString("utf8");
  const cvOff = Number((xml.match(/<points type="CompressedVector" fileOffset="(\d+)"/) || [, 0])[1]);
  const recordCount = Number((xml.match(/<points type="CompressedVector"[^>]*recordCount="(\d+)"/) || [, 0])[1]);
  const fields = parsePrototype(xml);

  const sec = readLogical(cvOff, 32);
  const dataPhys = Number(sec.readBigUInt64LE(16));

  const pk = readLogical(dataPhys, 6);
  const packetType = pk[0], packetLen = pk.readUInt16LE(2) + 1, nStreams = pk.readUInt16LE(4);
  const full = readLogical(dataPhys, packetLen);
  const lens = [];
  for (let i = 0; i < nStreams; i++) lens.push(full.readUInt16LE(6 + i * 2));

  let cursor = 6 + nStreams * 2;
  const streams = lens.map((L) => { const b = full.subarray(cursor, cursor + L); cursor += L; return b; });
  const readers = streams.map(bitReader);

  const pts = [];
  for (let i = 0; i < want; i++) {
    const rec = {};
    let bad = false;
    fields.forEach((f, fi) => {
      const rd = readers[fi]; if (!rd) { bad = true; return; }
      const raw = rd(f.bits); if (raw === null) { bad = true; return; }
      if (f.type === "Float") {
        const b = Buffer.alloc(f.single ? 4 : 8);
        if (f.single) b.writeUInt32LE(Number(raw & 0xffffffffn)); else b.writeBigUInt64LE(raw);
        rec[f.name] = +(f.single ? b.readFloatLE(0) : b.readDoubleLE(0)).toFixed(4);
      } else rec[f.name] = f.min + Number(raw);
    });
    if (bad) break;
    pts.push(rec);
  }

  console.log(JSON.stringify({
    ok: true, recordCount, packetType, packetLen, byteStreams: nStreams,
    fields: fields.map(f => f.name + ":" + f.bits + "b"),
    streamLengths: lens, decoded: pts.length, sample: pts
  }, null, 2));
} finally { closeSync(fd); }
