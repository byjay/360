/**
 * public/js/modules/09_FLS.js 의 _parseE57 을 "마스터의 진짜 스캔 파일"로 직접 검증하는 도구.
 * 합성 테스트(tests/p5-e57-parse.test.mjs)는 내가 만든 가정을 그대로 반영하므로,
 * 가정이 틀리면 테스트도 같이 틀린다 — 그래서 실파일로 한 번 더 교차검증한다.
 *
 * 사용: node build-tools/e57-realfile-check.mjs <file1.e57> [file2.e57 ...]
 *       인자 없이 실행 → 기본 후보 경로(마스터 스캔 폴더)를 찾아보고, 없으면 안내만 하고 정상 종료(exit 0).
 *
 * ponytail: 09_FLS.js는 IIFE 조각이라 그대로 require 불가 → "const FLS = {...};" 객체 리터럴
 *   구간만 텍스트로 잘라 vm 에서 평가한다. 객체 리터럴 평가 자체는 메서드 본문을 실행하지 않으므로
 *   (호출 시점에만 실행) document/THREE/window 스텁은 안전망 용도로만 넣는다(실제로 안 쓰여도 무해).
 */
import { readFileSync, existsSync } from "node:fs";
import { createContext, Script } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLS_MODULE = join(__dirname, "..", "public", "js", "modules", "09_FLS.js");
const SAMPLE_TOOL = join(__dirname, "e57-decode-sample.mjs");

const DEFAULT_CANDIDATES = [
  "Z:\\10-ECO\\020. MV PANOPI\\001. Feasibilitty Study(방선사진-SCANFILE-PROPOSAL)\\002. SCAN FILE\\점합\\PANOPI_Panopi301.e57",
  "Z:\\10-ECO\\020. MV PANOPI\\001. Feasibilitty Study(방선사진-SCANFILE-PROPOSAL)\\002. SCAN FILE\\점합\\PANOPI_scan101.e57",
];

let targets = process.argv.slice(2);
if (!targets.length) targets = DEFAULT_CANDIDATES;

const missing = targets.filter((p) => !existsSync(p));
if (missing.length === targets.length) {
  console.log("[안내] 실파일을 찾지 못했습니다 — 이 환경에는 마스터의 스캔 폴더가 없는 것으로 보입니다.");
  console.log("사용법: node build-tools/e57-realfile-check.mjs <file1.e57> [file2.e57 ...]");
  console.log("확인한 경로:");
  for (const p of targets) console.log("  - " + p + (existsSync(p) ? " (있음)" : " (없음)"));
  process.exit(0);
}

/** ── 09_FLS.js 에서 FLS 객체 리터럴만 잘라 vm 에서 평가 ── */
function loadFLS() {
  const src = readFileSync(FLS_MODULE, "utf8");
  const startAnchor = "const FLS = {";
  const closeAnchor = "close() { this.showPane(false); }";
  const s0 = src.indexOf(startAnchor);
  const ai = src.indexOf(closeAnchor);
  if (s0 < 0 || ai < 0) throw new Error("09_FLS.js 구조가 바뀌어 FLS 객체 리터럴 경계를 찾지 못했습니다(스크립트 갱신 필요).");
  const closeBraceIdx = src.indexOf("};", ai);
  if (closeBraceIdx < 0) throw new Error("FLS 객체 리터럴의 닫는 '};' 를 찾지 못했습니다.");
  const flsSrc = src.slice(s0, closeBraceIdx + 2);

  const sandbox = {
    console, Math, JSON, process,
    TextDecoder, TextEncoder, Uint8Array, Uint16Array, Int32Array, Float32Array, Float64Array,
    DataView, ArrayBuffer,
    // 안전망 스텁 — _parseE57 경로에서는 실제로 사용되지 않는다(메서드 본문은 호출 시에만 실행)
    document: { getElementById: () => null, createElement: () => ({}) },
    window: {}, THREE: {}, ResizeObserver: function () {}, requestAnimationFrame: () => 0,
    module: { exports: {} },
  };
  const ctx = createContext(sandbox);
  new Script(flsSrc + "\nmodule.exports = FLS;", { filename: "09_FLS.js(extracted)" }).runInContext(ctx);
  return sandbox.module.exports;
}

function toArrayBuffer(nodeBuf) {
  return nodeBuf.buffer.slice(nodeBuf.byteOffset, nodeBuf.byteOffset + nodeBuf.byteLength);
}

function minMax3(arr) {
  let n = arr.length / 3;
  let mnX = Infinity, mnY = Infinity, mnZ = Infinity, mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
  let nanInf = 0;
  for (let i = 0; i < n; i++) {
    const x = arr[i * 3], y = arr[i * 3 + 1], z = arr[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { nanInf++; continue; }
    if (x < mnX) mnX = x; if (x > mxX) mxX = x;
    if (y < mnY) mnY = y; if (y > mxY) mxY = y;
    if (z < mnZ) mnZ = z; if (z > mxZ) mxZ = z;
  }
  return { min: [mnX, mnY, mnZ], max: [mxX, mxY, mxZ], nanInf };
}

/** 기존 검증 도구(e57-decode-sample.mjs)로 첫 N점을 뽑아 비교용 XYZ 배열로 변환 */
function sampleViaExistingTool(path, want) {
  const out = execFileSync(process.execPath, [SAMPLE_TOOL, path, String(want)], {
    maxBuffer: 64 * 1024 * 1024, timeout: 120000,
  }).toString("utf8");
  const j = JSON.parse(out);
  const pts = j.sample.map((rec) => {
    if ("cartesianX" in rec) return [rec.cartesianX, rec.cartesianY, rec.cartesianZ];
    if ("sphericalRange" in rec) {
      const rng = rec.sphericalRange, az = rec.sphericalAzimuth || 0, el = rec.sphericalElevation || 0;
      const c = Math.cos(el);
      return [rng * c * Math.cos(az), rng * c * Math.sin(az), rng * Math.sin(el)];
    }
    return null;
  }).filter(Boolean);
  return { fields: j.fields, pts, recordCount: j.recordCount };
}

const FLS = loadFLS();
const results = [];

for (const path of targets) {
  if (!existsSync(path)) { console.log("[건너뜀] 없음: " + path); continue; }
  console.log("\n==================== " + path + " ====================");
  const nodeBuf = readFileSync(path);
  const fileMB = (nodeBuf.byteLength / 1024 / 1024).toFixed(1);
  const ab = toArrayBuffer(nodeBuf);

  // ponytail: 진짜 피크는 GC 타이밍 때문에 동기 실행 중엔 정확히 못 잰다(샘플링하려면 워커/타이머가
  // 필요한데 단일 스레드 동기 루프는 이벤트루프를 막는다). rss 는 파싱 "직후" 스냅샷 — 상한선 근사치다.
  const memBefore = process.memoryUsage();
  const t0 = Date.now();
  let parsed = null, err = null;
  try {
    parsed = FLS._parseE57.call(FLS, ab);
  } catch (e) {
    err = e;
  }
  const elapsedMs = Date.now() - t0;
  const memAfter = process.memoryUsage();
  const mb = (v) => (v / 1024 / 1024).toFixed(1);

  const row = {
    path, fileMB, elapsedMs,
    memBeforeMB: mb(memBefore.heapUsed), memAfterMB: mb(memAfter.heapUsed),
    rssBeforeMB: mb(memBefore.rss), rssAfterMB: mb(memAfter.rss),
  };

  if (err) {
    row.error = err.message || String(err);
    console.log("[FAIL] _parseE57 예외: " + row.error);
    results.push(row);
    continue;
  }

  const posStats = minMax3(parsed.positions);
  const colStats = parsed.colors ? minMax3(parsed.colors) : null;
  row.count = parsed.count;
  row.posMin = posStats.min.map((v) => +v.toFixed(3));
  row.posMax = posStats.max.map((v) => +v.toFixed(3));
  row.posNanInf = posStats.nanInf;
  row.colMin = colStats ? colStats.min.map((v) => +v.toFixed(4)) : null;
  row.colMax = colStats ? colStats.max.map((v) => +v.toFixed(4)) : null;
  row.colNanInf = colStats ? colStats.nanInf : null;
  row.capHit = parsed.count >= FLS.MAX_POINTS ? "예(cap 도달, 잘림)" : "아니오";

  console.log("점 개수: " + row.count.toLocaleString() + " / MAX_POINTS=" + FLS.MAX_POINTS.toLocaleString() + " → cap 잘림: " + row.capHit);
  console.log("좌표 범위 X/Y/Z min: " + JSON.stringify(row.posMin) + " max: " + JSON.stringify(row.posMax) + " (NaN/Inf 제외개수: " + row.posNanInf + ")");
  if (colStats) console.log("색상 범위 min: " + JSON.stringify(row.colMin) + " max: " + JSON.stringify(row.colMax) + " (NaN/Inf 제외개수: " + row.colNanInf + ")");
  else console.log("색상: 없음(컬러 필드 미검출)");
  console.log("소요시간: " + elapsedMs + "ms, heapUsed 전/후: " + row.memBeforeMB + "MB → " + row.memAfterMB + "MB"
    + ", rss(프로세스 전체) 전/후: " + row.rssBeforeMB + "MB → " + row.rssAfterMB + "MB (rss=근사 피크선, GC타이밍상 정확한 순간피크 아님)");

  // ── 정답 대조: e57-decode-sample.mjs 로 첫 몇 점 비교 ──
  // _parseE57 은 recordCount > MAX_POINTS 면 stride 로 균등 다운샘플한다(FLS._e57ReadSection 참조,
  // sink.stride = ceil(total/MAX_POINTS)). 기존 도구는 다운샘플 없이 원본 순서 그대로 뽑으므로,
  // 같은 stride 로 인덱싱해야 "같은 점"을 비교하는 것이다 — 안 하면 거짓 불일치가 난다(실측).
  try {
    const N = 5;
    const probe = sampleViaExistingTool(path, N); // recordCount 확인용 소량 선조회
    const stride = probe.recordCount > FLS.MAX_POINTS ? Math.ceil(probe.recordCount / FLS.MAX_POINTS) : 1;
    const need = Math.min((N - 1) * stride + 1, 200000); // 첫 패킷 한도 내로 캡
    const ref = stride === 1 ? probe : sampleViaExistingTool(path, need);
    const eps = 1e-2; // ScaledInteger 양자화·부동소수 반올림 허용오차
    let n = 0, mismatches = 0;
    const diffLines = [];
    for (let i = 0; i < N; i++) {
      const refIdx = i * stride;
      if (refIdx >= ref.pts.length) break; // 첫 패킷 범위를 벗어남 — 그 이상은 대조 불가(정직 표기)
      n++;
      const a = ref.pts[refIdx];
      const b = [parsed.positions[i * 3], parsed.positions[i * 3 + 1], parsed.positions[i * 3 + 2]];
      const d = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
      if (d > eps) { mismatches++; diffLines.push("  점[FLS #" + i + " = 원본 #" + refIdx + "] 기존도구=" + JSON.stringify(a) + " vs FLS=" + JSON.stringify(b.map(v=>+v.toFixed(4))) + " diff=" + d.toFixed(4)); }
    }
    row.crossCheckStride = stride;
    row.crossCheckPoints = n;
    row.crossCheckMismatches = mismatches;
    if (n === 0) {
      row.crossCheckNote = "기존도구가 좌표 필드를 못 찾았거나 stride 범위가 첫 패킷을 벗어남 — 비교 불가";
      console.log("[대조] " + row.crossCheckNote);
    } else if (mismatches === 0) {
      console.log("[대조] 기존 도구(e57-decode-sample.mjs) 첫 " + n + "점 좌표 일치 (stride=" + stride + ", 오차<" + eps + ")");
    } else {
      console.log("[대조] ⚠ 불일치 " + mismatches + "/" + n + "점 (stride=" + stride + "):");
      diffLines.forEach((l) => console.log(l));
    }
  } catch (e) {
    row.crossCheckError = e.message || String(e);
    console.log("[대조] 기존 도구 실행 실패: " + row.crossCheckError);
  }

  results.push(row);
}

console.log("\n==================== 요약 ====================");
console.table(results.map((r) => ({
  파일: r.path.split(/[\\/]/).pop(),
  크기MB: r.fileMB,
  결과: r.error ? "FAIL: " + r.error : "OK",
  점수: r.count != null ? r.count.toLocaleString() : "-",
  상한도달: r.capHit || "-",
  NaN수: r.posNanInf != null ? r.posNanInf : "-",
  소요ms: r.elapsedMs,
  rssMB후: r.rssAfterMB || "-",
  대조: r.error ? "-" : (r.crossCheckMismatches === 0 ? "일치" : (r.crossCheckMismatches > 0 ? "불일치" : (r.crossCheckNote || r.crossCheckError || "-"))),
})));
