#!/usr/bin/env node
/**
 * 실파일 런타임 검증 — [WO 20261022-flsfolder] FLS 폴더 일괄등록 경로를 "진짜" Z: 점합 폴더
 * 3개(PANOPI_Panopi301~303.e57)로 시뮬레이션: 핀 301/302/303 이 있다고 가정하고
 * 60_PhotoFolder.js(_materializeFile — 실 소스, 재구현 아님)가 FLS._parseE57(grid:true) +
 * FlsPano.fromGrid/padToEquirect/toJpegBlob 를 거쳐 실제 등록용 jpg 로 변환하는지 확인한다.
 * 브라우저 canvas 대신 node-canvas(toBuffer) 를 toBlob 계약에 맞게 감싼다.
 *
 * 실행(E: 안에서, TEMP/TMP 지정 — CLAUDE.md §G-5):
 *   node build-tools/flsfolder-batch-realfile.mjs "<점합 폴더>" 301 302 303
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "canvas";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const folder = process.argv[2];
const nums = process.argv.slice(3).length ? process.argv.slice(3) : ["301", "302", "303"];
if (!folder) { console.error("사용법: node flsfolder-batch-realfile.mjs <점합폴더> [번호...]"); process.exit(1); }

const FLS_SRC = fs.readFileSync(path.join(ROOT, "public/js/modules/09_FLS.js"), "utf8");
const PANO_SRC = fs.readFileSync(path.join(ROOT, "public/js/modules/39_FlsPano.js"), "utf8");
const PF_SRC = fs.readFileSync(path.join(ROOT, "public/js/modules/60_PhotoFolder.js"), "utf8");

function loadFLS() {
  return new Function("THREE", "Cloud", "document", "Prompt", FLS_SRC + "\n;return FLS;")(
    undefined, undefined, undefined, { confirm: async () => true }
  );
}
function makeNodeDoc() {
  return {
    createElement(tag) {
      if (tag !== "canvas") return {};
      const c = createCanvas(1, 1);
      // 브라우저 canvas.toBlob 계약으로 감싸기(node-canvas 는 toBuffer만 제공 — FlsPano.toJpegBlob 이 요구하는 API)
      c.toBlob = (cb, type, q) => {
        const buf = c.toBuffer("image/jpeg", { quality: q == null ? 0.92 : q });
        cb(new Blob([buf], { type: type || "image/jpeg" }));
      };
      return c;
    }
  };
}
function loadPano(doc) { return new Function("document", PANO_SRC + "\n;return FlsPano;")(doc); }
function loadPF(FLS, FlsPano) {
  return new Function("FLS", "FlsPano", "File", "Blob", PF_SRC + "\n;return PhotoFolder;")(FLS, FlsPano, File, Blob);
}

async function main() {
  const FLS = loadFLS();
  const doc = makeNodeDoc();
  const FlsPano = loadPano(doc);
  const PF = loadPF(FLS, FlsPano);

  const outDir = path.join(ROOT, ".tmp/flsx/batch");
  fs.mkdirSync(outDir, { recursive: true });

  console.log("핀 가정: " + nums.join(", ") + " · 폴더: " + folder);
  for (const no of nums) {
    const fname = "PANOPI_Panopi" + no + ".e57";
    const fpath = path.join(folder, fname);
    if (!fs.existsSync(fpath)) { console.log("핀 " + no + " — 건너뜀(파일 없음: " + fname + ")"); continue; }

    // isMatch 확인(매칭 로직 자체는 불변 — 실파일명으로도 그대로 동작 확인)
    const matched = PF.isMatch(Number(no), fname);
    const sizeMB = (fs.statSync(fpath).size / 1024 / 1024).toFixed(1);

    const t0 = Date.now();
    const rss0 = process.memoryUsage().rss;
    const buf = fs.readFileSync(fpath);
    const file = new File([buf], fname, { type: "application/octet-stream" });
    const entry = { name: fname, getFile: async () => file };

    const mat = await PF._materializeFile(entry);
    const t1 = Date.now();
    const rss1 = process.memoryUsage().rss;

    if (!mat.ok) {
      console.log("핀 " + no + " (" + fname + ", " + sizeMB + "MB) — 실패: " + mat.reason + " · " + (t1 - t0) + "ms");
      continue;
    }
    const jpgBuf = Buffer.from(await mat.file.arrayBuffer());
    const outPath = path.join(outDir, "panopi" + no + ".jpg");
    fs.writeFileSync(outPath, jpgBuf);
    console.log("핀 " + no + " 매칭=" + matched + " (" + fname + ", " + sizeMB + "MB) → " + mat.file.name
      + " (" + (jpgBuf.length / 1024).toFixed(1) + "KB) · " + (t1 - t0) + "ms · rss "
      + (rss0 / 1024 / 1024).toFixed(1) + "MB→" + (rss1 / 1024 / 1024).toFixed(1) + "MB (+"
      + ((rss1 - rss0) / 1024 / 1024).toFixed(1) + "MB) · 저장=" + outPath);
  }
}
main().catch((e) => { console.error("실패:", (e && e.stack) || e); process.exit(1); });
