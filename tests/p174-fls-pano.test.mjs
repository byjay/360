/**
 * 회귀 테스트 — E57 스캔 격자 → 360° 등장방형 사진 추출 (프레임워크 0 · 실행: node tests/p174-fls-pano.test.mjs)
 *
 * 검사 대상:
 *   - public/js/modules/09_FLS.js  _parseE57(buf,{grid:true}) 의 pose/indexBounds 판독 + 격자 전해상도 디코딩
 *   - public/js/modules/39_FlsPano.js  fromGrid / padToEquirect / toJpegBlob (실제 모듈 소스 평가 — 목 아님)
 *
 * 합성 E57: 3행(고도 -45/0/+45°) × 8열(방위 0..315° 45° 간격) = 24점, pose = Z축 90° 회전.
 *   raw(파일에 저장된 cartesian) = R(local), R = [[0,-1,0],[1,0,0],[0,0,1]] (Z축 +90° 회전의 행렬형).
 *   fromGrid 는 pose 역회전으로 local 을 복원해 방위각/고도각을 구해야 한다 — 틀리면 픽셀이 엉뚱한 곳에 찍힌다.
 *   점 A(az=0°,el=0°)=빨강, 점 B(az=90°,el=0°)=초록, 점 C(az=180°,el=+45°)=파랑, 나머지=회색(100).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FLS_SRC = fs.readFileSync(path.join(ROOT, "public/js/modules/09_FLS.js"), "utf8");
const PANO_SRC = fs.readFileSync(path.join(ROOT, "public/js/modules/39_FlsPano.js"), "utf8");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};
const near = (a, b, eps) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= (eps == null ? 1e-6 : eps);

function loadFLS(src) {
  return new Function("THREE", "Cloud", "document", "Prompt", (src || FLS_SRC) + "\n;return FLS;")(
    undefined, undefined, undefined, { confirm: async () => true }
  );
}

/* ══════════════════════════════════════════════════════════════
   최소 가짜 2D canvas/document (Node 환경 — 실제 Canvas API 없이 fromGrid/padToEquirect 검증)
   ══════════════════════════════════════════════════════════════ */
function makeFakeDoc() {
  function makeCanvas() {
    const c = {
      width: 0, height: 0,
      _pixels: null,
      getContext(kind) {
        if (kind !== "2d") return null;
        return {
          createImageData(w, h) {
            return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
          },
          putImageData(imgData, x, y) {
            c._pixels = { width: imgData.width, height: imgData.height, data: imgData.data };
          },
          getImageData(x, y, w, h) {
            if (!c._pixels) return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
            return c._pixels;
          },
          fillStyle: "", fillRect() {}, drawImage(img, dx, dy, dw, dh) {
            // img: 테스트에서는 {width,height,_pixels} 형태의 "소스 캔버스"만 그린다(단순 상단-좌측 배치, 리사이즈 없음)
            if (!c._pixels) c._pixels = { width: c.width, height: c.height, data: new Uint8ClampedArray(c.width * c.height * 4) };
            if (img && img._pixels) {
              const sw = img._pixels.width, sh = img._pixels.height, sdata = img._pixels.data;
              for (let y = 0; y < sh && (dy + y) < c.height; y++) {
                for (let x = 0; x < sw && (dx + x) < c.width; x++) {
                  const so = (y * sw + x) * 4, doff = ((dy + y) * c.width + (dx + x)) * 4;
                  c._pixels.data[doff] = sdata[so]; c._pixels.data[doff + 1] = sdata[so + 1];
                  c._pixels.data[doff + 2] = sdata[so + 2]; c._pixels.data[doff + 3] = sdata[so + 3];
                }
              }
            }
          },
          toBlob(cb, type, q) { cb({ _fakeBlob: true, w: c.width, h: c.height }); }
        };
      },
      toBlob(cb, type, q) { cb({ _fakeBlob: true, w: c.width, h: c.height }); }
    };
    return c;
  }
  return {
    createElement(tag) {
      if (tag === "canvas") return makeCanvas();
      return { style: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, appendChild() {}, querySelector() { return null; }, setAttribute() {} };
    },
    getElementById() { return null; },
    querySelector() { return null; },
    body: { appendChild() {} }
  };
}
function getPixel(canvas, x, y) {
  const img = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
}

/* ══════════════════════════════════════════════════════════════
   합성 E57 빌더(격자: rowIndex/columnIndex + pose + indexBounds)
   ══════════════════════════════════════════════════════════════ */
function f32bits(v) { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v, true); return d.getUint32(0, true); }
function wu64(dv, off, v) { dv.setUint32(off, v >>> 0, true); dv.setUint32(off + 4, Math.floor(v / 4294967296), true); }
function align4(v) { return Math.ceil(v / 4) * 4; }

const FIELDS = [
  { name: "cartesianX", kind: "f32", bits: 32 },
  { name: "cartesianY", kind: "f32", bits: 32 },
  { name: "cartesianZ", kind: "f32", bits: 32 },
  { name: "colorRed", kind: "int", min: 0, max: 255, bits: 8 },
  { name: "colorGreen", kind: "int", min: 0, max: 255, bits: 8 },
  { name: "colorBlue", kind: "int", min: 0, max: 255, bits: 8 },
  { name: "rowIndex", kind: "int", min: 0, max: 255, bits: 8 },
  { name: "columnIndex", kind: "int", min: 0, max: 255, bits: 8 },
  { name: "cartesianInvalidState", kind: "int", min: 0, max: 2, bits: 2 }
];

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

/** 로컬 방향벡터를 Z축 +90° 회전행렬로 돌려 "raw"(파일 저장값)를 만든다. R=[[0,-1,0],[1,0,0],[0,0,1]] */
function rotZ90(v) { return { x: -v.y, y: v.x, z: v.z }; }
function localFromAzEl(azDeg, elDeg) {
  const az = azDeg * Math.PI / 180, el = elDeg * Math.PI / 180;
  const c = Math.cos(el);
  return { x: c * Math.cos(az), y: c * Math.sin(az), z: Math.sin(el) };
}

function buildGridE57() {
  const rows = 3, cols = 8;
  const elOf = { 0: -45, 1: 0, 2: 45 };
  const records = [];
  let ptA = -1, ptB = -1, ptC = -1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const az = c * 45, el = elOf[r];
      const local = localFromAzEl(az, el);
      const raw = rotZ90(local);
      let col255 = [100, 100, 100];
      if (r === 1 && c === 0) { col255 = [255, 0, 0]; ptA = records.length; }       // az=0,  el=0  → 빨강
      if (r === 1 && c === 2) { col255 = [0, 255, 0]; ptB = records.length; }       // az=90, el=0  → 초록
      if (r === 2 && c === 4) { col255 = [0, 0, 255]; ptC = records.length; }       // az=180,el=45 → 파랑
      records.push({
        cartesianX: raw.x, cartesianY: raw.y, cartesianZ: raw.z,
        colorRed: col255[0], colorGreen: col255[1], colorBlue: col255[2],
        rowIndex: r, columnIndex: c, cartesianInvalidState: 0
      });
    }
  }

  const proto = FIELDS.map(f => f.kind === "f32"
    ? `<${f.name} type="Float" precision="single"/>`
    : `<${f.name} type="Integer" minimum="${f.min}" maximum="${f.max}"/>`).join("");
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<e57Root type="Structure"><data3D type="Vector" allowHeterogeneousChildren="1"><vectorChild type="Structure">'
    + '<name type="String"><![CDATA[synthetic-grid]]></name>'
    + '<indexBounds type="Structure"><rowMinimum type="Integer">0</rowMinimum><rowMaximum type="Integer">' + (rows - 1) + '</rowMaximum>'
    + '<columnMinimum type="Integer">0</columnMinimum><columnMaximum type="Integer">' + (cols - 1) + '</columnMaximum></indexBounds>'
    + '<pose type="Structure"><rotation type="Structure">'
    + '<w type="Float">0.70710678</w><x type="Float">0</x><y type="Float">0</y><z type="Float">0.70710678</z>'
    + '</rotation><translation type="Structure"><x type="Float">0</x><y type="Float">0</y><z type="Float">0</z></translation></pose>'
    + `<points type="CompressedVector" fileOffset="CVOFFSET__" recordCount="${records.length}">`
    + `<prototype>${proto}</prototype><codecs type="Vector" allowHeterogeneousChildren="1"/></points>`
    + '</vectorChild></data3D></e57Root>';

  const pageSize = 1024, USABLE = pageSize - 4;
  const logToPhys = (l) => Math.floor(l / USABLE) * pageSize + (l % USABLE);
  const xmlLen = Buffer.byteLength(xml, "utf8");
  const cvLogical = align4(48 + xmlLen);
  const dataLogical = cvLogical + 32;
  const xmlFinal = xml.replace("CVOFFSET__", String(logToPhys(cvLogical)).padStart(10, "0"));
  const xmlLenFinal = Buffer.byteLength(xmlFinal, "utf8");
  if (xmlLenFinal !== xmlLen) throw new Error("합성 실패: 치환 전후 길이 불일치");

  const packed = FIELDS.map(f => packStream(f, records.map(r => r[f.name])));
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
  return { buf: out.buffer, rows, cols, n: N, ptA, ptB, ptC };
}

/* ══════════════════════════════════════════════════════════════
   ① _parseE57(buf,{grid:true}) — pose/indexBounds 판독 + 전해상도 격자
   ══════════════════════════════════════════════════════════════ */
console.log("\n[① _parseE57 grid:true — pose/indexBounds/격자 판독]");
const built = buildGridE57();
let grid = null;
{
  const FLS = loadFLS();
  const parsed = FLS._parseE57(built.buf, { grid: true });
  ok(!!parsed.grid, "①: grid 필드가 반환됨");
  grid = parsed.grid;
  ok(grid && grid.rows === built.rows && grid.cols === built.cols, `①: rows/cols = ${grid && grid.rows}/${grid && grid.cols} (기대 ${built.rows}/${built.cols})`);
  ok(grid && grid.n === built.n, `①: 격자점 개수 ${grid && grid.n} (기대 ${built.n}, 디시메이션 없음)`);
  ok(grid && grid.pose && near(grid.pose.rotation.w, 0.70710678, 1e-4), "①: pose.rotation.w 판독됨");
  // 기존 3D 뷰 경로(opts 없음)는 grid 없이 그대로 동작 — 계약 불변 확인
  const parsedNoGrid = FLS._parseE57(built.buf);
  ok(!parsedNoGrid.grid, "①: opts 없이 호출하면 grid 생성 안 함(기존 3D 뷰 성능 영향 없음)");
  ok(parsedNoGrid.count === built.n, `①: 기존 point-cloud 경로 count=${parsedNoGrid.count} (기대 ${built.n})`);
}

/* ══════════════════════════════════════════════════════════════
   ② fromGrid — pose 역회전으로 올바른 방위/고도 위치에 픽셀 배치
   ══════════════════════════════════════════════════════════════ */
console.log("\n[② fromGrid — 방위/고도 기반 픽셀 배치]");
let canvas = null;
{
  const FlsPano = new Function("document", PANO_SRC + "\n;return FlsPano;")(makeFakeDoc());
  canvas = FlsPano.fromGrid(grid);
  ok(canvas.width === 2048 && canvas.height === 1024, `②: 캔버스 크기 ${canvas.width}x${canvas.height} (기대 2048x1024, cols=8<MIN_W → 하한 적용)`);
  const W = canvas.width, H = canvas.height;
  // 기대 픽셀: az=0,el=0 → (W/2, H/2) / az=90,el=0 → (3W/4, H/2) / az=180,el=45 → (0, H/4)
  const [rA, gA, bA] = getPixel(canvas, Math.floor(0.5 * W), Math.floor(0.5 * H));
  const [rB, gB, bB] = getPixel(canvas, Math.floor(0.75 * W), Math.floor(0.5 * H));
  const [rC, gC, bC] = getPixel(canvas, 0, Math.floor(0.25 * H));
  ok(rA > 200 && gA < 60 && bA < 60, `②: az=0°,el=0° 픽셀=(${rA},${gA},${bA}) (기대 빨강)`);
  ok(gB > 200 && rB < 60 && bB < 60, `②: az=90°,el=0° 픽셀=(${rB},${gB},${bB}) (기대 초록)`);
  ok(bC > 200 && rC < 60 && gC < 60, `②: az=180°,el=45° 픽셀=(${rC},${gC},${bC}) (기대 파랑)`);
}

/* ══════════════════════════════════════════════════════════════
   ③ _detect360 판정 기준 통과 (20_App.js 임계값 재사용 — 중복 금지, 여기서는 수치만 재확인)
   ══════════════════════════════════════════════════════════════ */
console.log("\n[③ App._detect360 기준(ratio 1.85~2.15, w≥1024) 통과]");
{
  const ratio = canvas.width / canvas.height;
  ok(ratio >= 1.85 && ratio <= 2.15, `③: ratio ${ratio} (기대 2.0 근방)`);
  ok(canvas.width >= 1024, `③: width ${canvas.width} ≥ 1024`);
}

/* ══════════════════════════════════════════════════════════════
   ④ padToEquirect — 2:1 패딩(SCENE 내보내기처럼 수직 FOV가 잘린 이미지)
   ══════════════════════════════════════════════════════════════ */
console.log("\n[④ padToEquirect — 세로 패딩해 2:1 로 맞춤]");
{
  const doc = makeFakeDoc();
  const FlsPano = new Function("document", PANO_SRC + "\n;return FlsPano;")(doc);
  const src = doc.createElement("canvas");
  src.width = 2048; src.height = 1200; // 가로:세로 ≈1.7 (top90~bottom-60 범위만 담은 SCENE 내보내기 흉내)
  const ctx = src.getContext("2d");
  const id = ctx.createImageData(src.width, src.height);
  for (let i = 0; i < id.data.length; i += 4) { id.data[i] = 50; id.data[i + 1] = 60; id.data[i + 2] = 200; id.data[i + 3] = 255; }
  ctx.putImageData(id, 0, 0);
  const padded = FlsPano.padToEquirect(src, 90, -60);
  ok(padded.width === 2048 && padded.height === 1024, `④: 패딩 결과 ${padded.width}x${padded.height} (기대 2048x1024, 2:1)`);
  // 이미 2:1 인 입력은 그대로 반환
  const already = doc.createElement("canvas"); already.width = 1000; already.height = 500;
  const same = FlsPano.padToEquirect(already, 90, -60);
  ok(same === already, "④: 이미 2:1 인 입력은 그대로 반환(불필요한 재인코딩 없음)");
}

/* ══════════════════════════════════════════════════════════════
   뮤테이션 증명 A — pose 역변환을 제거하면 ②가 실패해야 한다
   ══════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션 A] fromGrid 에서 pose 역변환 적용을 제거하면 ②가 뒤집혀야 함");
{
  const needle = "if (qInv) { const r = this._rotByQuatInverse({ x, y, z }, qInv); x = r.x; y = r.y; z = r.z; }";
  const mutated = PANO_SRC.replace(needle, "if (false) { const r = this._rotByQuatInverse({ x, y, z }, qInv); x = r.x; y = r.y; z = r.z; }");
  if (mutated === PANO_SRC) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const FlsPano = new Function("document", mutated + "\n;return FlsPano;")(makeFakeDoc());
    const c2 = FlsPano.fromGrid(grid);
    const [rA] = getPixel(c2, Math.floor(0.5 * c2.width), Math.floor(0.5 * c2.height));
    const broke = !(rA > 200);  // pose 보정 없으면 빨강점이 (W/2,H/2) 에 오지 않아야 함
    ok(broke, "pose 역변환 제거 시 az=0 픽셀 위치가 뒤집힘 → got R=" + rA + " (보정 시 기대 >200)");
  }
}

/* ══════════════════════════════════════════════════════════════
   뮤테이션 증명 B — rowIndex/columnIndex 역할 매핑을 지우면(row·col 무시) ①이 실패해야 한다
   ══════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션 B] E57.ROLE 에서 rowIndex/columnIndex 매핑을 지우면(row·col 무시) grid 생성이 실패해야 함");
{
  const needle = "rowIndex: 11, columnIndex: 12, intensity: 13";
  const mutated = FLS_SRC.replace(needle, "intensity: 13");
  if (mutated === FLS_SRC) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const FLS = loadFLS(mutated);
    const parsed = FLS._parseE57(built.buf, { grid: true });
    ok(!parsed.grid, "row/col 역할 매핑 제거 시 grid 가 생성되지 않음(뒤집힘) → grid=" + JSON.stringify(!!parsed.grid));
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
