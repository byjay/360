/**
 * [WO 20261022-flsole] 실파일 런타임 검증 — 39_FlsPano.js 의 fromFlsOle (OLE2 최소 리더)를 실제 FARO
 * .fls(OLE2 복합 문서) 3개(scan_0/scan_10/scan_121)에 돌려, 지휘자가 python olefile 로 미리 추출한
 * .tmp/flsx/ods/*.jpg 결과(R3)와 크기를 대조한다. 테스트 하네스가 아니라 1회성 수동 검증 스크립트.
 *
 * 실행: node build-tools/fls-ole-verify.mjs
 * 의존: canvas(npm, 기존 설치 — 새 의존성 아님) — createImageBitmap/document.createElement('canvas') 폴리필.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "canvas";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PANO_SRC = fs.readFileSync(path.join(ROOT, "public/js/modules/39_FlsPano.js"), "utf8");

const SCANDIR = "Z:/38.선보/SCAN파일_261019_2/ODS, ODP, FPA (3개 정합)/ODS, ODP, FPA (3개 정합)/Scene/ODP, ODS, FLY/Revisions/1/Scans";
const PREVDIR = path.join(ROOT, ".tmp/flsx/ods");

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

function loadFlsPano() {
  const createImageBitmap = async (blob) => loadImage(Buffer.from(await blob.arrayBuffer()));
  const doc = makeDoc();
  const fn = new Function("document", "createImageBitmap", "Blob", PANO_SRC + "\n;return FlsPano;");
  return fn(doc, createImageBitmap, Blob);
}

async function main() {
  const FlsPano = loadFlsPano();
  const cases = [
    { name: "scan_0.fls", expectOk: true, refJpg: "scan_0.jpg" },
    { name: "scan_10.fls", expectOk: true, refJpg: "scan_10.jpg" },
    { name: "scan_121.fls", expectOk: false }
  ];
  let failed = 0;
  for (const c of cases) {
    const fp = path.join(SCANDIR, c.name);
    const buf = fs.readFileSync(fp);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const t0 = Date.now();
    const res = await FlsPano.fromFlsOle(ab);
    const ms = Date.now() - t0;
    console.log(`\n[${c.name}] ${ms}ms`);
    if (c.expectOk) {
      if (!res.ok) { console.log("  FAIL 기대: ok=true, 실제:", res); failed++; continue; }
      console.log(`  canvas ${res.canvas.width}x${res.canvas.height} ratio=${(res.canvas.width / res.canvas.height).toFixed(4)} topDeg=${res.topDeg.toFixed(3)} bottomDeg=${res.bottomDeg.toFixed(3)}`);
      const ref = await loadImage(path.join(PREVDIR, c.refJpg));
      console.log(`  python 기준(R3) ${ref.width}x${ref.height} ratio=${(ref.width / ref.height).toFixed(4)}`);
      const ratioOk = Math.abs(res.canvas.width / res.canvas.height - 2) < 0.02;
      const widthOk = Math.abs(res.canvas.width - ref.width) <= 2 || Math.abs(res.canvas.width - ref.width) / ref.width < 0.02;
      if (!ratioOk) { console.log("  FAIL ratio 불일치"); failed++; }
      else if (!widthOk) { console.log("  FAIL width 불일치(기대~" + ref.width + ", 실제 " + res.canvas.width + ")"); failed++; }
      else console.log("  PASS 크기/비율 python 결과와 일치");
    } else {
      if (res.ok) { console.log("  FAIL 기대: ok=false(컬러 미리보기 없음), 실제: ok=true"); failed++; }
      else console.log("  PASS 기대대로 실패 — reason:", res.reason);
    }
  }
  console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
