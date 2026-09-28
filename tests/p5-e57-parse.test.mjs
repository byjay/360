/**
 * 회귀 테스트 — E57(ASTM E2807) 파서 (프레임워크 0 · 실행: node tests/p5-e57-parse.test.mjs)
 *
 * 검사 대상: public/js/modules/09_FLS.js 의 _parseE57 / _e57* (실제 모듈 소스를 그대로 평가 — 목 구현 아님)
 *
 * 테스트용 .e57 은 **코드로 합성**한다(실파일 경로 의존 0 → 다른 PC/CI 에서도 동일하게 돈다).
 *   합성 규칙 = 지휘자가 마스터 실파일(PANOPI_Panopi301.e57)로 실측 증명한 포맷 그대로:
 *   헤더 48B → 페이지(1024B)마다 끝 4B CRC → XML(색인용 prototype 이 앞) → CV 섹션헤더 32B → 데이터 패킷들.
 *   값이 패킷 경계를 걸치는 상황(2bit 필드: 실측 2139점 = 534.75B → 534B 만 실림)도 그대로 재현한다.
 *
 * 케이스: ①헤더 ②CRC 페이지 건너뛰기(XML 이 경계를 걸침) ③prototype 선택 ④XYZ+RGB 정확도
 *         ⑤invalidState≠0 제외 ⑥MAX_POINTS 상한 중단 ⑦구면좌표 폴백
 * 뮤테이션 2건: CRC 건너뛰기 제거 → ②실패 / prototype 을 첫 번째로 되돌림 → ③실패
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "public/js/modules/09_FLS.js"), "utf8");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};
const near = (a, b, eps = 1e-6) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps;

/** 모듈 블록(`const FLS = {...};`)을 그대로 평가해 FLS 객체를 얻는다.
 *  promptStub/docStub 은 크기 가드(Prompt.confirm)·loadBuffer(document.getElementById) 테스트용 주입. */
function loadFLS(src, promptStub, docStub) {
  return new Function("THREE", "Cloud", "document", "Prompt", (src || SRC) + "\n;return FLS;")(
    undefined, undefined, docStub, promptStub || { confirm: async () => true }
  );
}

/* ══════════════════════════════════════════════════════════════
   합성 E57 빌더
   ══════════════════════════════════════════════════════════════ */
const F32 = (name) => ({ name, kind: "f32", bits: 32 });
const INT = (name, min, max) => ({
  name, kind: "int", min, max,
  bits: (max - min) <= 0 ? 0 : Math.ceil(Math.log2(max - min + 1))
});
const CART_FIELDS = [
  F32("cartesianX"), F32("cartesianY"), F32("cartesianZ"),
  INT("colorRed", 0, 255), INT("colorGreen", 0, 255), INT("colorBlue", 0, 255),
  INT("rowIndex", 0, 4294967295), INT("columnIndex", 0, 4294967295),
  INT("cartesianInvalidState", 0, 2)
];
const SPH_FIELDS = [
  F32("sphericalRange"), F32("sphericalAzimuth"), F32("sphericalElevation"),
  INT("sphericalInvalidState", 0, 2)
];

/** 결정적 레코드 생성 — 좌표는 f32 로 정확히 표현되는 값(0.25 배수)만 쓴다 */
function cartRecords(n, invalidFn) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      cartesianX: i * 0.25, cartesianY: -i * 0.5, cartesianZ: i * 1.25 + 0.5,
      colorRed: (i * 7) % 256, colorGreen: (i * 13) % 256, colorBlue: (i * 29) % 256,
      rowIndex: i, columnIndex: i * 2,
      cartesianInvalidState: invalidFn ? invalidFn(i) : 0
    });
  }
  return out;
}
function sphRecords(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      sphericalRange: 1 + i * 0.5, sphericalAzimuth: i * 0.25, sphericalElevation: i * 0.125,
      sphericalInvalidState: 0
    });
  }
  return out;
}

function f32bits(v) { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v, true); return d.getUint32(0, true); }
function wu64(dv, off, v) { dv.setUint32(off, v >>> 0, true); dv.setUint32(off + 4, Math.floor(v / 4294967296), true); }
function align4(v) { return Math.ceil(v / 4) * 4; }

/** 필드 값 전체를 LSB 우선으로 비트팩 */
function packStream(f, values) {
  const buf = new Uint8Array(Math.ceil(f.bits * values.length / 8));
  let bit = 0;
  for (const v of values) {
    const raw = f.kind === "f32" ? f32bits(v) : (v - f.min);
    for (let i = 0; i < f.bits; i++) {
      if (Math.floor(raw / Math.pow(2, i)) % 2 === 1) buf[bit >> 3] |= 1 << (bit & 7);
      bit++;
    }
  }
  return buf;
}
function dataPacket(parts) {
  const n = parts.length;
  const len = align4(6 + n * 2 + parts.reduce((s, p) => s + p.length, 0));
  const p = new Uint8Array(len);
  const dv = new DataView(p.buffer);
  p[0] = 1; p[1] = 0;                       // type=DATA, flags=0
  dv.setUint16(2, len - 1, true);           // packetLogicalLengthMinus1
  dv.setUint16(4, n, true);                 // bytestreamCount
  let cur = 6 + n * 2;
  parts.forEach((s, i) => { dv.setUint16(6 + i * 2, s.length, true); p.set(s, cur); cur += s.length; });
  return p;
}
function emptyPacket() {                     // type=2(EMPTY) — 파서가 건너뛰어야 한다
  const p = new Uint8Array(16); p[0] = 2;
  new DataView(p.buffer).setUint16(2, 15, true);
  return p;
}

function buildE57(opts) {
  const fields = opts.fields || CART_FIELDS;
  const records = opts.records;
  const pageSize = opts.pageSize || 1024;
  const USABLE = pageSize - 4;
  const perPacket = opts.perPacket || 7;
  const straddle = opts.straddle !== false;
  const decoy = opts.decoy !== false;
  const withEmpty = opts.emptyPacket !== false;
  const recCountAttr = opts.recordCountAttr != null ? opts.recordCountAttr : records.length;
  const logToPhys = (l) => Math.floor(l / USABLE) * pageSize + (l % USABLE);

  const proto = fields.map(f => f.kind === "f32"
    ? `<${f.name} type="Float" precision="single"/>`
    : `<${f.name} type="Integer" minimum="${f.min}" maximum="${f.max}"/>`).join("");
  // 색인용 CompressedVector(= 함정): 실제 파일처럼 points 보다 **앞**에 온다
  const decoyXml = decoy
    ? '<pointGroupingSchemes type="Structure"><groupingByLine type="Structure">'
      + '<groups type="CompressedVector" fileOffset="0000000000" recordCount="1"><prototype>'
      + '<idElementValue type="Integer" minimum="0" maximum="1023"/>'
      + '<startPointIndex type="Integer" minimum="0" maximum="1023"/>'
      + '<pointCount type="Integer" minimum="0" maximum="1023"/>'
      + '</prototype></groups></groupingByLine></pointGroupingSchemes>'
    : "";
  const mkXml = (pad) =>
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<e57Root type="Structure"><formatName type="String"><![CDATA[ASTM E57 3D Imaging Data File]]></formatName>'
    + '<data3D type="Vector" allowHeterogeneousChildren="1"><vectorChild type="Structure">'
    + '<name type="String"><![CDATA[synthetic]]></name>' + pad + decoyXml
    + `<points type="CompressedVector" fileOffset="CVOFFSET__" recordCount="${recCountAttr}">`
    + `<prototype>${proto}</prototype><codecs type="Vector" allowHeterogeneousChildren="1"/></points>`
    + '</vectorChild></data3D></e57Root>';

  const TAG = '<points type="CompressedVector"';
  let xml = mkXml("");
  if (straddle) {
    // points 태그가 페이지 경계(=CRC 4B 자리)를 가로지르도록 주석으로 밀어 넣는다
    const idx0 = xml.indexOf(TAG);
    let need = ((USABLE - 10) - ((48 + idx0) % USABLE) + USABLE) % USABLE;
    while (need < 7) need += USABLE;                       // "<!---->" = 7자
    xml = mkXml("<!--" + "x".repeat(need - 7) + "-->");
    const off = (48 + xml.indexOf(TAG)) % USABLE;
    if (off + TAG.length <= USABLE) throw new Error("합성 실패: points 태그가 페이지 경계를 걸치지 않음");
  }

  const xmlLen = Buffer.byteLength(xml, "utf8");           // 치환은 길이 불변(10자리 고정)
  const cvLogical = align4(48 + xmlLen);
  const dataLogical = cvLogical + 32;
  xml = xml.replace("CVOFFSET__", String(logToPhys(cvLogical)).padStart(10, "0"));

  const packed = fields.map(f => packStream(f, records.map(r => r[f.name] || 0)));
  const N = records.length;
  const packets = [];
  for (let start = 0; start < N; start += perPacket) {
    const end = Math.min(start + perPacket, N), last = end === N;
    packets.push(dataPacket(fields.map((f, i) => packed[i].subarray(
      Math.floor(start * f.bits / 8),
      last ? Math.ceil(N * f.bits / 8) : Math.floor(end * f.bits / 8)
    ))));
    if (withEmpty && start === 0) packets.push(emptyPacket());
  }
  const secLen = packets.reduce((s, p) => s + p.length, 0);

  const logicalLen = dataLogical + secLen;
  const pages = Math.ceil(logicalLen / USABLE);
  const physLen = pages * pageSize;
  const logical = new Uint8Array(logicalLen);
  const hdv = new DataView(logical.buffer);
  for (let i = 0; i < 8; i++) logical[i] = "ASTM-E57".charCodeAt(i);
  hdv.setUint32(8, 1, true); hdv.setUint32(12, 0, true);   // major/minor
  wu64(hdv, 16, physLen); wu64(hdv, 24, logToPhys(48)); wu64(hdv, 32, xmlLen); wu64(hdv, 40, pageSize);
  logical.set(new TextEncoder().encode(xml), 48);
  logical[cvLogical] = 1;                                  // section id = CompressedVector
  const cdv = new DataView(logical.buffer, cvLogical, 32);
  wu64(cdv, 8, secLen); wu64(cdv, 16, logToPhys(dataLogical)); wu64(cdv, 24, 0);
  let o = dataLogical;
  for (const pk of packets) { logical.set(pk, o); o += pk.length; }

  // 논리 → 물리: 페이지마다 끝 4B 에 CRC 자리(논리 데이터가 아님을 증명하는 쓰레기값)
  const out = new Uint8Array(physLen);
  for (let p = 0; p < pages; p++) {
    out.set(logical.subarray(p * USABLE, Math.min((p + 1) * USABLE, logicalLen)), p * pageSize);
    out.set([0xDE, 0xAD, 0xBE, 0xEF], p * pageSize + USABLE);
  }
  return { buf: out.buffer, xml, xmlLen, pageSize, pages, cvPhys: logToPhys(cvLogical) };
}

/** buildE57 의 단순화 버전 — <points type="CompressedVector"> 섹션을 **여러 개** 만든다.
 *  cap(=Math.min(MAX_POINTS,total)) 백스톱 검증용: stride 는 섹션마다 done 이 0 부터 다시 세므로
 *  섹션 수가 많으면 stride 만으로는 전체 상한을 못 지키고, cap 이 실제로 끊어야 한다(뮤테이션 C 대상). */
function buildE57Sections(sectionsRecords, fieldsOpt) {
  const fields = fieldsOpt || CART_FIELDS;
  const pageSize = 1024, USABLE = pageSize - 4, perPacket = 7;
  const logToPhys = (l) => Math.floor(l / USABLE) * pageSize + (l % USABLE);
  const proto = fields.map(f => f.kind === "f32"
    ? `<${f.name} type="Float" precision="single"/>`
    : `<${f.name} type="Integer" minimum="${f.min}" maximum="${f.max}"/>`).join("");
  if (sectionsRecords.length > 9) throw new Error("placeholder 는 섹션 9개까지만 지원(CVOFFSETn_ 10자 고정)");

  const pointsXml = sectionsRecords.map((recs, i) =>
    `<points type="CompressedVector" fileOffset="CVOFFSET${i}_" recordCount="${recs.length}">`
    + `<prototype>${proto}</prototype><codecs type="Vector" allowHeterogeneousChildren="1"/></points>`);
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<e57Root type="Structure"><formatName type="String"><![CDATA[ASTM E57 3D Imaging Data File]]></formatName>'
    + '<data3D type="Vector" allowHeterogeneousChildren="1">'
    + sectionsRecords.map((_, i) =>
      '<vectorChild type="Structure"><name type="String"><![CDATA[s' + i + ']]></name>' + pointsXml[i] + '</vectorChild>').join("")
    + '</data3D></e57Root>';
  const xmlLen = Buffer.byteLength(xml, "utf8");

  let cursor = align4(48 + xmlLen);
  const sections = sectionsRecords.map(recs => {
    const packed = fields.map(f => packStream(f, recs.map(r => r[f.name] || 0)));
    const N = recs.length;
    const packets = [];
    for (let start = 0; start < N; start += perPacket) {
      const end = Math.min(start + perPacket, N), last = end === N;
      packets.push(dataPacket(fields.map((f, idx) => packed[idx].subarray(
        Math.floor(start * f.bits / 8),
        last ? Math.ceil(N * f.bits / 8) : Math.floor(end * f.bits / 8)
      ))));
    }
    const secLen = packets.reduce((s, p) => s + p.length, 0);
    const cvLogical = cursor, dataLogical = cvLogical + 32;
    cursor = dataLogical + secLen;
    return { cvLogical, dataLogical, secLen, packets };
  });

  sections.forEach((sm, i) => { xml = xml.replace("CVOFFSET" + i + "_", String(logToPhys(sm.cvLogical)).padStart(10, "0")); });

  const logicalLen = cursor;
  const pages = Math.ceil(logicalLen / USABLE);
  const physLen = pages * pageSize;
  const logical = new Uint8Array(logicalLen);
  const hdv = new DataView(logical.buffer);
  for (let i = 0; i < 8; i++) logical[i] = "ASTM-E57".charCodeAt(i);
  hdv.setUint32(8, 1, true); hdv.setUint32(12, 0, true);
  wu64(hdv, 16, physLen); wu64(hdv, 24, logToPhys(48)); wu64(hdv, 32, xmlLen); wu64(hdv, 40, pageSize);
  logical.set(new TextEncoder().encode(xml), 48);
  sections.forEach(sm => {
    logical[sm.cvLogical] = 1;
    const cdv = new DataView(logical.buffer, sm.cvLogical, 32);
    wu64(cdv, 8, sm.secLen); wu64(cdv, 16, logToPhys(sm.dataLogical)); wu64(cdv, 24, 0);
    let o = sm.dataLogical;
    for (const pk of sm.packets) { logical.set(pk, o); o += pk.length; }
  });

  const out = new Uint8Array(physLen);
  for (let p = 0; p < pages; p++) {
    out.set(logical.subarray(p * USABLE, Math.min((p + 1) * USABLE, logicalLen)), p * pageSize);
    out.set([0xDE, 0xAD, 0xBE, 0xEF], p * pageSize + USABLE);
  }
  return { buf: out.buffer };
}

/** 기대값(유효 레코드만) */
function expectCart(records) {
  return records.filter(r => r.cartesianInvalidState === 0).map(r => ({
    x: Math.fround(r.cartesianX), y: Math.fround(r.cartesianY), z: Math.fround(r.cartesianZ),
    r: r.colorRed / 255, g: r.colorGreen / 255, b: r.colorBlue / 255
  }));
}
function checkPoints(parsed, exp, label, eps = 1e-6) {
  ok(parsed.count === exp.length, `${label}: 점 개수 ${parsed.count} (기대 ${exp.length})`);
  let bad = -1;
  for (let i = 0; i < Math.min(parsed.count, exp.length); i++) {
    const e = exp[i];
    const okXyz = near(parsed.positions[i * 3], e.x, eps) && near(parsed.positions[i * 3 + 1], e.y, eps) && near(parsed.positions[i * 3 + 2], e.z, eps);
    const okCol = e.r === undefined || (parsed.colors
      && near(parsed.colors[i * 3], e.r, eps) && near(parsed.colors[i * 3 + 1], e.g, eps) && near(parsed.colors[i * 3 + 2], e.b, eps));
    if (!okXyz || !okCol) { bad = i; break; }
  }
  ok(bad === -1, bad === -1 ? `${label}: 모든 점의 XYZ/RGB 일치` :
    `${label}: 점 #${bad} 불일치 — got(${parsed.positions[bad * 3]},${parsed.positions[bad * 3 + 1]},${parsed.positions[bad * 3 + 2]}) 기대(${exp[bad].x},${exp[bad].y},${exp[bad].z})`);
}

/* ══════════════════════════════════════════════════════════════
   ① 헤더 파싱
   ══════════════════════════════════════════════════════════════ */
console.log("\n[① 헤더 48B 파싱]");
{
  const FLS = loadFLS();
  const recs = cartRecords(20);
  const f = buildE57({ records: recs });
  const h = FLS._e57Header(f.buf);
  ok(h.major === 1 && h.minor === 0, `버전 ${h.major}.${h.minor} (기대 1.0)`);
  ok(h.pageSize === 1024, `pageSize ${h.pageSize} (기대 1024)`);
  ok(h.xmlPhysOffset === 48, `xmlPhysicalOffset ${h.xmlPhysOffset} (기대 48)`);
  ok(h.xmlLength === f.xmlLen, `xmlLogicalLength ${h.xmlLength} (기대 ${f.xmlLen})`);
  ok(h.fileLength === f.buf.byteLength, `fileLength ${h.fileLength} = 실제 ${f.buf.byteLength}`);
  // 서명 없는 파일은 조용히 죽지 않고 이유를 던져야 한다(§10)
  const junk = new Uint8Array(f.buf.slice(0)); junk[0] = 0x50;
  let msg = "";
  try { FLS._e57Header(junk.buffer); } catch (e) { msg = e.message; }
  ok(/서명/.test(msg), `서명 불일치 시 사유 표시: "${msg.slice(0, 40)}"`);
}

/* ══════════════════════════════════════════════════════════════
   ② CRC 페이지 건너뛰기 (XML 이 페이지 경계를 걸침) — 뮤테이션 대상
   ══════════════════════════════════════════════════════════════ */
function suiteCrc(FLS, label) {
  const recs = cartRecords(60);
  const f = buildE57({ records: recs, straddle: true });
  ok(f.pages >= 2, `합성 파일 페이지 수 ${f.pages} (≥2 — 경계 존재)`);
  const parsed = FLS._parseE57(f.buf);
  checkPoints(parsed, expectCart(recs), label);
  return parsed;
}
console.log("\n[② CRC 페이지 건너뛰기 — XML/데이터가 페이지 경계를 걸침]");
suiteCrc(loadFLS(), "②");

/* ══════════════════════════════════════════════════════════════
   ③ prototype 선택 (색인용 prototype 이 앞에 있는 XML) — 뮤테이션 대상
   ══════════════════════════════════════════════════════════════ */
function suiteProto(FLS, label) {
  const recs = cartRecords(30);
  const f = buildE57({ records: recs, decoy: true });
  // 합성 파일이 실제로 "함정"을 담고 있는지부터 확인 — 색인용 prototype 이 points 태그보다 앞
  const iDecoy = f.xml.indexOf("<idElementValue"), iPoints = f.xml.indexOf('<points type="CompressedVector"');
  ok(iDecoy >= 0 && iPoints >= 0 && iDecoy < iPoints,
    `${label}: 색인용 prototype(${iDecoy}) 이 points 태그(${iPoints}) 보다 앞에 있음`);
  const parsed = FLS._parseE57(f.buf);
  checkPoints(parsed, expectCart(recs), label);
  return parsed;
}
console.log("\n[③ 색인용 prototype 함정 — points 태그 뒤의 prototype 을 써야 한다]");
suiteProto(loadFLS(), "③");

/* ══════════════════════════════════════════════════════════════
   ④ XYZ + RGB 값 정확도 (패킷 여러 개 + 값이 패킷 경계를 걸치는 2bit 필드)
   ══════════════════════════════════════════════════════════════ */
console.log("\n[④ XYZ+RGB 정확도 · 다중 패킷 · 비트 경계 이월]");
{
  const FLS = loadFLS();
  const recs = cartRecords(53);                        // 53 = 7*7+4 → 마지막 패킷이 짧다
  const f = buildE57({ records: recs, perPacket: 7 });
  const parsed = FLS._parseE57(f.buf);
  checkPoints(parsed, expectCart(recs), "④");
  ok(parsed.colors instanceof Float32Array, "④: 색 배열이 Float32Array 로 반환됨");
  ok(parsed.positions.length === parsed.count * 3, `④: positions 길이 ${parsed.positions.length} = count*3`);
}

/* ══════════════════════════════════════════════════════════════
   ⑤ cartesianInvalidState ≠ 0 제외
   ══════════════════════════════════════════════════════════════ */
console.log("\n[⑤ invalidState ≠ 0 인 점 제외]");
{
  const FLS = loadFLS();
  const inval = (i) => (i % 3 === 1 ? 1 : (i % 7 === 3 ? 2 : 0));
  const recs = cartRecords(40, inval);
  const exp = expectCart(recs);
  const f = buildE57({ records: recs });
  const parsed = FLS._parseE57(f.buf);
  ok(exp.length < recs.length, `합성 레코드 40개 중 유효 ${exp.length}개 (무효가 실제로 섞임)`);
  checkPoints(parsed, exp, "⑤");
}

/* ══════════════════════════════════════════════════════════════
   ⑥ MAX_POINTS 상한 — 전부 읽고 버리지 않고 상한에서 중단
   ══════════════════════════════════════════════════════════════ */
console.log("\n[⑥ MAX_POINTS 상한에서 중단 + 균등 다운샘플]");
{
  const FLS = loadFLS();
  FLS.MAX_POINTS = 5;
  const recs = cartRecords(40);
  const f = buildE57({ records: recs, perPacket: 7 });
  const parsed = FLS._parseE57(f.buf);
  ok(parsed.count === 5, `상한 5 → 반환 점 수 ${parsed.count}`);
  ok(parsed.positions.length === 15, `positions 길이 ${parsed.positions.length} (기대 15 — 상한 크기만 할당)`);
  const stride = Math.ceil(40 / 5);
  const exp = [0, 1, 2, 3, 4].map(k => expectCart([recs[k * stride]])[0]);
  checkPoints(parsed, exp, "⑥(균등 다운샘플 stride=" + stride + ")");
}

/* ══════════════════════════════════════════════════════════════
   ⑥b MAX_POINTS 상한 — 다중 섹션에서 stride 만으로는 못 막는 초과분을 cap 이 끊는다
   (교차검증 보고서 "미확인" 항목: 실파일 2건 모두 stride 다운샘플만 걸리고 cap 백스톱은
    도달한 적이 없었다. 섹션마다 stride 누적 done 이 0 부터 다시 시작하므로, 섹션 수가 많으면
    stride 수식만으론 전체 상한을 못 지킨다 — cap 이 실제로 끊어야 한다. 뮤테이션 C 대상.
    ※ 최종 반환값은 항상 _decim 이 MAX_POINTS 로 한 번 더 클램프하므로(이중 안전망), "count"만으로는
    cap 백스톱의 유무를 구분할 수 없다(디버그로 실측: cap 제거해도 최종 count=5로 동일).
    진짜 위험은 cap 이 없으면 **중간 디코딩 배열(sink.pos)이 total 크기로 부풀어** 대용량 파일에서
    바로 그 메모리 폭증이 재현된다는 점 — 그래서 _decim 을 항등함수로 바꿔 sink 단계의 진짜 개수를
    직접 드러낸다(이 테스트에 한해 안전망 하나를 걷어내 대상 로직만 격리 — 목 아님, 실제 _parseE57 그대로). */
console.log("\n[⑥b MAX_POINTS 상한 — 다중 섹션(stride 만으론 6점, cap 이 5점으로 끊어야 함)]");
{
  const FLS = loadFLS();
  FLS.MAX_POINTS = 5;
  FLS._decim = (pos, col) => ({ positions: pos, colors: col, count: pos.length / 3 }); // 최종 이중 클램프 제거 → cap 백스톱만 관찰
  // 3섹션 × 4레코드 = 12 total → stride=ceil(12/5)=3 → 섹션별 로컬 done 기준 2점씩(0,3번째) × 3섹션 = 6점
  // cap(=min(5,12)=5) 이 실제로 끊지 않으면 6점이 반환된다.
  const sections = [cartRecords(4), cartRecords(4), cartRecords(4)];
  const f = buildE57Sections(sections);
  const parsed = FLS._parseE57(f.buf);
  ok(parsed.count === 5, `⑥b: 상한 5 → 반환 점 수 ${parsed.count} (다중 섹션 stride 만이면 6점이 됐을 상황)`);
  ok(parsed.positions.length === 15, `⑥b: positions 길이 ${parsed.positions.length} (기대 15 — cap 크기만 할당)`);
}

/* ══════════════════════════════════════════════════════════════
   ⑦ 구면좌표 스캔(색상 없음) → 직교 변환 + 무채색 폴백
   ══════════════════════════════════════════════════════════════ */
console.log("\n[⑦ 구면좌표 + 색상 없는 E57 → 무채색 폴백]");
{
  const FLS = loadFLS();
  const recs = sphRecords(15);
  const f = buildE57({ fields: SPH_FIELDS, records: recs, perPacket: 5 });
  const parsed = FLS._parseE57(f.buf);
  ok(parsed.colors === null, "색 필드가 없으면 colors=null(기존 무채색 경로로 폴백)");
  const exp = recs.map(r => {
    const rng = Math.fround(r.sphericalRange), az = Math.fround(r.sphericalAzimuth), el = Math.fround(r.sphericalElevation);
    const c = Math.cos(el);
    return { x: rng * c * Math.cos(az), y: rng * c * Math.sin(az), z: rng * Math.sin(el) };
  });
  checkPoints(parsed, exp, "⑦", 1e-5);
}

/* ══════════════════════════════════════════════════════════════
   뮤테이션 증명 A — CRC 건너뛰기를 없애면 ②가 실패해야 한다
   ══════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션 A] _e57Usable 에서 CRC 4B 차감을 없애면 ②가 실패해야 함");
{
  const needle = "_e57Usable(pageSize) { return pageSize - this.E57.CRC_BYTES; }";
  const mutated = SRC.replace(needle, "_e57Usable(pageSize) { return pageSize; }");
  if (mutated === SRC) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const FLS = loadFLS(mutated);
    const recs = cartRecords(60);
    const f = buildE57({ records: recs, straddle: true });
    let broke = false, why = "";
    try {
      const p = FLS._parseE57(f.buf);
      const exp = expectCart(recs);
      broke = p.count !== exp.length || !near(p.positions[3], exp[1].x) || !near(p.positions[4], exp[1].y);
      why = "count=" + p.count + " (기대 " + exp.length + ")";
    } catch (e) { broke = true; why = "throw: " + e.message.slice(0, 60); }
    ok(broke, "CRC 건너뛰기 제거 시 ②가 뒤집힘 → " + why);
  }
}

/* ══════════════════════════════════════════════════════════════
   뮤테이션 증명 B — prototype 을 파일의 첫 번째로 되돌리면 ③이 실패해야 한다
   ══════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션 B] prototype 검색 시작점을 points 태그 뒤 → 파일 처음으로 되돌리면 ③이 실패해야 함");
{
  const needle = 'const s0 = xml.indexOf("<prototype", from);';
  const mutated = SRC.replace(needle, 'const s0 = xml.indexOf("<prototype", 0);');
  if (mutated === SRC) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const FLS = loadFLS(mutated);
    const recs = cartRecords(30);
    const f = buildE57({ records: recs, decoy: true });
    let broke = false, why = "";
    try {
      const p = FLS._parseE57(f.buf);
      const exp = expectCart(recs);
      broke = p.count !== exp.length || !near(p.positions[3], exp[1].x);
      why = "count=" + p.count + " (기대 " + exp.length + ")";
    } catch (e) { broke = true; why = "throw: " + e.message.slice(0, 60); }
    ok(broke, "첫 prototype(색인용) 사용 시 ③이 뒤집힘 → " + why);
  }
}

/* ══════════════════════════════════════════════════════════════
   뮤테이션 증명 C — cap(=Math.min(MAX_POINTS,total)) 을 없애면 ⑥b가 실패해야 한다
   ══════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션 C] cap 을 Math.min(MAX_POINTS,total) 대신 total 로 두면 ⑥b가 실패해야 함");
{
  const needle = "const cap = Math.min(this.MAX_POINTS, total || this.MAX_POINTS);";
  const mutated = SRC.replace(needle, "const cap = total || this.MAX_POINTS;");
  if (mutated === SRC) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const FLS = loadFLS(mutated);
    FLS.MAX_POINTS = 5;
    FLS._decim = (pos, col) => ({ positions: pos, colors: col, count: pos.length / 3 }); // ⑥b와 동일 — 이중 클램프 제거
    const sections = [cartRecords(4), cartRecords(4), cartRecords(4)];
    const f = buildE57Sections(sections);
    let broke = false, why = "";
    try {
      const p = FLS._parseE57(f.buf);
      broke = p.count !== 5;
      why = "count=" + p.count + " (기대 5)";
    } catch (e) { broke = true; why = "throw: " + e.message.slice(0, 60); }
    ok(broke, "cap 백스톱 제거 시 ⑥b가 뒤집힘 → " + why);
  }
}

/* ══════════════════════════════════════════════════════════════
   ⑧ 대용량 E57 크기 가드 — _e57SizeWarning/_e57Threshold/_confirmLargeE57 (순수 로직)
   ══════════════════════════════════════════════════════════════ */
console.log("\n[⑧ 대용량 E57 크기 가드 — 임계값·문구·저사양 기기 감지]");
{
  const FLS = loadFLS();
  ok(FLS._e57SizeWarning(FLS.E57_LARGE_FILE_BYTES) === null, "임계값 이하(경계 포함)면 경고 없음");
  const over = FLS._e57SizeWarning(FLS.E57_LARGE_FILE_BYTES + 1);
  ok(over !== null, "임계값 초과면 경고 문구 반환");
  ok(/MB/.test(over) && /계속하시겠습니까/.test(over), "경고 문구에 실제 크기(MB)·확인 질문 포함: " + over.slice(0, 30));

  ok(typeof navigator === "undefined", "테스트 환경엔 navigator 없음 — 기본 임계값 경로가 실제로 쓰임");
  ok(FLS._e57Threshold() === FLS.E57_LARGE_FILE_BYTES, "navigator 없어도 정상 동작(기본 임계값)");

  // deviceMemory ≤4GB(저사양·주로 모바일) → 임계값 절반, 없는 브라우저에서도 안전
  globalThis.navigator = { deviceMemory: 4 };
  try {
    ok(FLS._e57Threshold() === FLS.E57_LARGE_FILE_BYTES / 2, "deviceMemory≤4GB → 임계값 절반");
    ok(FLS._e57SizeWarning(FLS.E57_LARGE_FILE_BYTES / 2 + 1) !== null, "저사양 임계값 기준으로도 초과분 경고");
  } finally { delete globalThis.navigator; }

  // [WO 20260928] PWA 독립실행모드에서 window.confirm()이 무음 false 를 반환하는 문제 때문에
  //  Prompt.confirm(커스텀 DOM 모달, SoT: 30_Prompt.js)으로 통일 — window.confirm 의존 제거.
  let confirmCalled = 0, confirmTitle = "", confirmMsg = "";
  const FLS2 = loadFLS(null, { confirm: async (t, m) => { confirmCalled++; confirmTitle = t; confirmMsg = m; return false; } });
  ok((await FLS2._confirmLargeE57("test-msg")) === false, "Prompt.confirm 반환값을 그대로 전달");
  ok(confirmCalled === 1 && confirmMsg === "test-msg" && !!confirmTitle, "Prompt.confirm 을 실제로 호출(네이티브 window.confirm 미사용)");
}

/* ══════════════════════════════════════════════════════════════
   ⑨ loadBuffer 크기 가드 연동 — 임계 미만은 경고 없이 진행 / 초과는 확인 콜백을 탄다
   ══════════════════════════════════════════════════════════════ */
console.log("\n[⑨ loadBuffer 크기 가드 연동]");
{
  const domStub = { getElementById: () => null };
  const bigLen = loadFLS().E57_LARGE_FILE_BYTES + 1024;

  // 임계 미만 — 확인창 없이 곧장 파싱
  {
    let confirmCalls = 0, parseCalled = false;
    const FLS = loadFLS(null, { confirm: () => { confirmCalls++; return true; } }, domStub);
    FLS._parseE57 = () => { parseCalled = true; return { positions: new Float32Array(3), colors: null, count: 1 }; };
    FLS._render = () => {};
    await FLS.loadBuffer(new ArrayBuffer(1024), "small.e57");
    ok(confirmCalls === 0 && parseCalled, "⑨: 임계 미만이면 확인창 없이 곧장 파싱");
  }

  // 임계 초과 + 취소 — 파싱 생략
  {
    let parseCalled = false;
    const FLS = loadFLS(null, { confirm: () => false }, domStub);
    FLS._parseE57 = () => { parseCalled = true; return { positions: new Float32Array(3), colors: null, count: 1 }; };
    FLS._render = () => {};
    await FLS.loadBuffer(new ArrayBuffer(bigLen), "big.e57");
    ok(!parseCalled, "⑨: 임계 초과 + 취소면 _parseE57 을 호출하지 않음");
  }

  // 임계 초과 + 확인 — 파싱 진행
  {
    let parseCalled = false, renderCalled = false;
    const FLS = loadFLS(null, { confirm: () => true }, domStub);
    FLS._parseE57 = () => { parseCalled = true; return { positions: new Float32Array(3), colors: null, count: 1 }; };
    FLS._render = () => { renderCalled = true; };
    await FLS.loadBuffer(new ArrayBuffer(bigLen), "big.e57");
    ok(parseCalled && renderCalled, "⑨: 임계 초과 + 확인이면 _parseE57·_render 진행");
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
