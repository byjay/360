/**
 * p157-person-blur-pure — WO 20261015-personblur (순수 함수 단위검증, 실행: node tests/p157-person-blur-pure.test.mjs)
 *
 * 62_PersonBlur.js 의 조각 분할·좌표 합치기·랩 처리·박스 병합·블러 적용을 실 소스를 vm 에
 * 로드해 검증한다(목 구현 금지 — document/canvas 만 최소 폴리필해 실 로직을 그대로 돌린다).
 * 뮤테이션 2건: P157_MUT=wrap → applyBoxBlur 의 이음선 랩 분기 제거(픽셀 검사 EXIT=1 기대),
 *              P157_MUT=merge → mergeBoxes 의 랩 shift 후보 제거(병합 검사 EXIT=1 기대).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let src = fs.readFileSync(path.join(ROOT, "public/js/modules/62_PersonBlur.js"), "utf8").replace(/\r\n/g, "\n");

const MUT = process.env.P157_MUT || "";
if (MUT === "wrap") {
  const before = src;
  src = src.replace(
    'if (x + w <= fullWidth) { draw1(x, w); return; }\n      // 이음선 랩 — 오른쪽 남은 폭 + 왼쪽(0부터) 넘친 폭\n      const rightW = fullWidth - x;\n      draw1(x, rightW);\n      draw1(0, w - rightW);',
    'draw1(x, w);'
  );
  if (src === before) { console.log("FAIL 뮤테이션 대상(wrap) 못 찾음"); process.exit(2); }
}
if (MUT === "merge") {
  const before = src;
  src = src.replace('const shifts = W > 0 ? [0, W, -W] : [0];', 'const shifts = [0];');
  if (src === before) { console.log("FAIL 뮤테이션 대상(merge) 못 찾음"); process.exit(2); }
}

/* ── 최소 캔버스 폴리필(실 DOM 없이 진짜 applyBoxBlur/sliceRanges 로직을 그대로 실행) ── */
function makeCanvas(w, h) {
  const canvas = { _w: w | 0, _h: h | 0, _buf: new Uint8ClampedArray(Math.max(1, w | 0) * Math.max(1, h | 0) * 4).fill(255) };
  Object.defineProperty(canvas, "width", { get() { return canvas._w; }, set(v) { canvas._w = v | 0; canvas._buf = new Uint8ClampedArray(Math.max(1, canvas._w) * Math.max(1, canvas._h) * 4).fill(255); } });
  Object.defineProperty(canvas, "height", { get() { return canvas._h; }, set(v) { canvas._h = v | 0; canvas._buf = new Uint8ClampedArray(Math.max(1, canvas._w) * Math.max(1, canvas._h) * 4).fill(255); } });
  canvas.getContext = () => ({
    canvas,
    imageSmoothingEnabled: true,
    save() {}, restore() {},
    drawImage(src2, ...rest) {
      let sx, sy, sw, sh, dx, dy, dw, dh;
      if (rest.length >= 8) [sx, sy, sw, sh, dx, dy, dw, dh] = rest;
      else { dx = rest[0]; dy = rest[1]; sx = 0; sy = 0; sw = src2.width; sh = src2.height; dw = sw; dh = sh; }
      const sBuf = src2._buf, sW = src2.width, sH = src2.height;
      for (let y = 0; y < dh; y++) {
        const syy = Math.min(sH - 1, Math.max(0, sy + Math.floor((y * sh) / dh)));
        for (let x = 0; x < dw; x++) {
          const sxx = Math.min(sW - 1, Math.max(0, sx + Math.floor((x * sw) / dw)));
          const dPixX = dx + x, dPixY = dy + y;
          if (dPixX < 0 || dPixY < 0 || dPixX >= canvas.width || dPixY >= canvas.height) continue;
          const sIdx = (syy * sW + sxx) * 4, dIdx = (dPixY * canvas.width + dPixX) * 4;
          canvas._buf[dIdx] = sBuf[sIdx]; canvas._buf[dIdx + 1] = sBuf[sIdx + 1]; canvas._buf[dIdx + 2] = sBuf[sIdx + 2]; canvas._buf[dIdx + 3] = sBuf[sIdx + 3];
        }
      }
    }
  });
  return canvas;
}
const pixelAt = (canvas, x, y) => { const i = (y * canvas.width + x) * 4; return [canvas._buf[i], canvas._buf[i + 1], canvas._buf[i + 2]]; };
const setPixel = (canvas, x, y, rgb) => { const i = (y * canvas.width + x) * 4; canvas._buf[i] = rgb[0]; canvas._buf[i + 1] = rgb[1]; canvas._buf[i + 2] = rgb[2]; canvas._buf[i + 3] = 255; };

const fakeDoc = { createElement: (tag) => (tag === "canvas" ? makeCanvas(1, 1) : {}) };
const sandbox = { console, document: fakeDoc, window: undefined, navigator: undefined, Auth: undefined, State: undefined, UI: undefined, Prompt: undefined, Cloud: undefined, App: undefined };
vm.createContext(sandbox);
vm.runInContext(src + "\nthis.__PB = PersonBlur;", sandbox);
const PB = sandbox.__PB;

let failed = 0;
const ok = (cond, label, detail) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail).slice(0, 300) : "")); if (!cond) failed++; };

console.log("\n[A. sliceRanges — 조각 분할]");
{
  const slices = PB.sliceRanges(1000, 4, 0.1);
  ok(slices.length === 4, "A 조각 수 = n", slices);
  ok(slices[0].x0 < 0, "A 첫 조각은 왼쪽으로 겹쳐 음수 x0(이음선 랩 대상)", slices[0]);
  ok(slices[3].x0 + slices[3].w > 1000, "A 마지막 조각은 오른쪽으로 width 초과", slices[3]);
  const overlap01 = (slices[0].x0 + slices[0].w) - slices[1].x0;
  ok(overlap01 > 0, "A 조각0-1 겹침 구간 > 0", overlap01);
}

console.log("\n[B. normalizeX — 좌우 랩]");
{
  ok(PB.normalizeX(-10, 1000) === 990, "B 음수 랩", PB.normalizeX(-10, 1000));
  ok(PB.normalizeX(1005, 1000) === 5, "B 초과 랩", PB.normalizeX(1005, 1000));
  ok(PB.normalizeX(500, 1000) === 500, "B 범위 내 그대로");
}

console.log("\n[C. mapBoxToFull — 조각-로컬 → 전체좌표]");
{
  const slice = { x0: -40, w: 200, i: 0 };
  const full = PB.mapBoxToFull([10, 20, 30, 60], slice, 1000);
  ok(full.x === PB.normalizeX(-40 + 10, 1000), "C x 가 slice.x0+local, 랩 적용", full);
  ok(full.width === 30 && full.height === 60, "C width/height 보존", full);
}

console.log("\n[D. mergeBoxes — 이음선 건너 중복 병합(뮤테이션: merge)]");
{
  const boxes = [
    { x: 990, y: 100, width: 40, height: 80 },
    { x: 5, y: 102, width: 35, height: 78 }
  ];
  const merged = PB.mergeBoxes(boxes, 1000, 0.2);
  ok(merged.length === 1, "D 이음선 건너 중복 박스 1개로 병합", merged);
  const far = PB.mergeBoxes([{ x: 100, y: 0, width: 30, height: 30 }, { x: 500, y: 0, width: 30, height: 30 }], 1000, 0.2);
  ok(far.length === 2, "D 겹치지 않는 박스는 유지(과병합 금지)", far);
}

console.log("\n[E. applyBoxBlur — 박스 밖 불변 · 이음선 랩 양쪽 모두 블러(뮤테이션: wrap)]");
{
  // 100x50 캔버스, 전부 빨강(255,0,0) → 박스 영역만 모자이크로 바뀌어야(색이 달라짐) 하고 박스 밖은 그대로.
  const cv = makeCanvas(100, 50);
  for (let y = 0; y < 50; y++) for (let x = 0; x < 100; x++) setPixel(cv, x, y, [255, 0, 0]);
  // 이음선을 넘는 박스: x=90, width=20 → 90..100(10px, 오른쪽) + 0..10(10px, 랩된 왼쪽)
  const box = { x: 90, y: 10, width: 20, height: 20 };
  // 박스가 블러로 바뀌는 걸 눈에 보이게, 박스 내부를 체커무늬(교대 색)로 채워 모자이크 후 평탄화되는지 본다
  for (let y = 10; y < 30; y++) for (let x = 90; x < 100; x++) setPixel(cv, x, y, ((x + y) % 2 === 0) ? [0, 255, 0] : [0, 0, 255]);
  for (let y = 10; y < 30; y++) for (let x = 0; x < 10; x++) setPixel(cv, x, y, ((x + y) % 2 === 0) ? [0, 255, 0] : [0, 0, 255]);
  const ctx = cv.getContext("2d");
  const outsideBefore = pixelAt(cv, 50, 25);   // 박스 밖(완전 빨강 영역)
  PB.applyBoxBlur(ctx, box, 100, 50, { cell: 4 });
  const outsideAfter = pixelAt(cv, 50, 25);
  ok(outsideBefore.join() === outsideAfter.join(), "E 박스 밖 픽셀은 불변", { outsideBefore, outsideAfter });
  // 모자이크 후엔 한 셀(4px) 내부가 전부 같은 색이 된다 — 체커무늬가 평탄화됐는지로 "달라졌음"을 판정
  const rightUniform = pixelAt(cv, 90, 10).join() === pixelAt(cv, 91, 10).join();
  const leftUniform = pixelAt(cv, 0, 10).join() === pixelAt(cv, 1, 10).join();
  ok(rightUniform, "E 이음선 오른쪽 조각도 블러(모자이크)됨", { p0: pixelAt(cv, 90, 10), p1: pixelAt(cv, 91, 10) });
  ok(leftUniform, "E 이음선 왼쪽(랩된) 조각도 블러(모자이크)됨 — MUT=wrap 이면 여기서 FAIL", { p0: pixelAt(cv, 0, 10), p1: pixelAt(cv, 1, 10) });
}

console.log("\n[F. buttonState — 디자이너/온라인/사진 순서]");
{
  ok(PB.buttonState({ canEdit: false }).disabled === true, "F 권한 없으면 비활성");
  ok(/디자이너/.test(PB.buttonState({ canEdit: false }).reason), "F 사유에 '디자이너'");
  ok(PB.buttonState({ canEdit: true, online: false }).disabled === true, "F 오프라인 비활성");
  ok(/온라인/.test(PB.buttonState({ canEdit: true, online: false }).reason), "F 사유에 '온라인'");
  ok(PB.buttonState({ canEdit: true, online: true, pin: {} }).disabled === true, "F 사진 없으면 비활성");
  ok(PB.buttonState({ canEdit: true, online: true, pin: { imageId: "x" } }).disabled === false, "F 조건 충족 시 사용 가능");
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
