#!/usr/bin/env node
/**
 * 실파일 런타임 검증 — PANOPI_Panopi301.e57(FARO SCENE 내보내기) → 360° 등장방형 JPG.
 * 09_FLS.js(_parseE57 grid:true) + 39_FlsPano.js(fromGrid/padToEquirect/toJpegBlob) 를
 * 실제 모듈 소스 그대로 평가해 실행한다(목 구현 아님). 브라우저 canvas 대신 node-canvas 사용.
 *
 * 실행(E: 안에서, TEMP/TMP 지정 — CLAUDE.md §G-5):
 *   node build-tools/e57-pano-realfile.mjs "<e57 경로>" [출력.jpg]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, Image } from "canvas";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inPath = process.argv[2];
const outPath = process.argv[3] || path.join(ROOT, ".tmp/flsx/panopi301_pano.jpg");
if (!inPath) { console.error("사용법: node e57-pano-realfile.mjs <e57경로> [출력.jpg]"); process.exit(1); }

const FLS_SRC = fs.readFileSync(path.join(ROOT, "public/js/modules/09_FLS.js"), "utf8");
const PANO_SRC = fs.readFileSync(path.join(ROOT, "public/js/modules/39_FlsPano.js"), "utf8");

function loadFLS() {
  return new Function("THREE", "Cloud", "document", "Prompt", FLS_SRC + "\n;return FLS;")(
    undefined, undefined, undefined, { confirm: async () => true }
  );
}
/** node-canvas 캔버스를 document.createElement("canvas") 처럼 보이게 하는 최소 doc 스텁 */
function makeNodeDoc() {
  return {
    createElement(tag) {
      if (tag === "canvas") return createCanvas(1, 1);
      return {};
    }
  };
}
function loadPano(doc) {
  return new Function("document", PANO_SRC + "\n;return FlsPano;")(doc);
}

async function main() {
  const t0 = Date.now();
  const rssStart = process.memoryUsage().rss;
  const buf = fs.readFileSync(inPath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  const FLS = loadFLS();
  const doc = makeNodeDoc();
  const FlsPano = loadPano(doc);

  const tParseStart = Date.now();
  const parsed = FLS._parseE57(ab, { grid: true });
  const tParseEnd = Date.now();
  if (!parsed.grid) { console.error("격자(rowIndex/columnIndex) 정보를 찾지 못했습니다 — 360 추출 불가."); process.exit(1); }
  console.log("grid: rows=" + parsed.grid.rows + " cols=" + parsed.grid.cols + " n=" + parsed.grid.n.toLocaleString());

  const tFromGridStart = Date.now();
  const canvas = FlsPano.fromGrid(parsed.grid);
  const tFromGridEnd = Date.now();
  const padded = FlsPano.padToEquirect(canvas, FlsPano.TOP_DEG, FlsPano.BOTTOM_DEG);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const jpegBuf = padded.toBuffer("image/jpeg", { quality: 0.92 });
  fs.writeFileSync(outPath, jpegBuf);
  const t1 = Date.now();
  const rssEnd = process.memoryUsage().rss;

  console.log("출력: " + outPath + " (" + padded.width + "x" + padded.height + ", " + (jpegBuf.length / 1024).toFixed(1) + "KB)");
  console.log("ratio=" + (padded.width / padded.height).toFixed(4) + " (App._detect360 기준 1.85~2.15, w>=1024)");
  console.log("시간: 전체=" + (t1 - t0) + "ms · _parseE57(grid)=" + (tParseEnd - tParseStart) + "ms · fromGrid=" + (tFromGridEnd - tFromGridStart) + "ms");
  console.log("RSS: 시작=" + (rssStart / 1024 / 1024).toFixed(1) + "MB → 종료=" + (rssEnd / 1024 / 1024).toFixed(1) + "MB (증가 " + ((rssEnd - rssStart) / 1024 / 1024).toFixed(1) + "MB)");
}
main().catch(e => { console.error("실패:", e && e.stack || e); process.exit(1); });
