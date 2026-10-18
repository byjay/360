/**
 * p168 — gap1: 설계 360 비교 · 도면 축척 측정 · XLSX 내보내기 (WO 20261019-gap1, 지휘자 발주)
 * 프레임워크 0 · 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node --test tests/p168-gap1.test.mjs
 *
 * [재현](지휘자 2026-10-19 실행 결과 재인용 — 발주서 그대로):
 *  R1 grep -l -i -E "bim|ifc|\.glb|design360|designPano" public/js/modules/*.js src/index.tsx | wc -l → 0
 *  R2 grep -l -E "setScale|scaleRef.*mm|실거리|축척 설정" public/js/modules/*.js | wc -l → 0
 *  R3 grep -n -i -E "xlsx|spreadsheetml|officedocument.spreadsheet" public/js/modules/*.js → 05_SyncQueue.js:622(아이콘 라벨뿐)
 *
 * 구현: 70_Scale.js(축척 설정/거리/면적 — 순수 함수) · 71_XlsxExport.js(SpreadsheetML XML) ·
 *       72_DesignCompare.js + 52_CompareSync.js(openDesign).
 * 🔴 목 금지 — 실제 소스를 vm 에 그대로 평가해 검증한다(p119/p164 관례).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const SCALE_SRC = rd("public/js/modules/70_Scale.js");
const XLSX_SRC = rd("public/js/modules/71_XlsxExport.js");

function loadScale(src) {
  const sandbox = {
    console,
    document: { getElementById: () => null, createElementNS: () => ({ setAttribute() {}, dataset: {} }) },
    window: undefined,
    State: { annotations: [], pdfPage: 1 },
    Auth: { role: "designer", readonly: false },
    Projects: { currentDeck: null },
    PdfAnno: { _pt: () => null, _render: () => {}, _persist: () => {} },
    MapCtrl: { _contentSize: () => ({ w: 1000, h: 1000 }) },
    Prompt: { toast: () => {}, confirm: async () => true },
  };
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__Scale = Scale;", sandbox);
  return sandbox.__Scale;
}
function loadXlsx(src) {
  const sandbox = { console, document: {}, Blob: class {}, URL: { createObjectURL: () => "" } };
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__X = XlsxExport;", sandbox);
  return sandbox.__X;
}

// 🔴 node:test 의 test() 콜백 안에서는 assert 로 던져야 서브테스트가 실제로 "not ok"(FAIL)이 된다 —
// 단순 console.log 카운터는 node:test 자체 pass/fail 집계(=최종 exit code)에 반영되지 않는다
// (뮤테이션 실측에서 FAIL 로그는 찍히는데 exit code 가 0으로 남는 현상으로 실제 확인됨).
const ok = (cond, label, d) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (!cond && d !== undefined ? " :: " + JSON.stringify(d) : "")); assert.ok(cond, label + (d !== undefined ? " :: " + JSON.stringify(d) : "")); };

/* ══════════════════════════════════════════════════════════════
 * ① 축척 계산 — "1000mm 기준선 → 측정 2000mm" 시나리오(발주서 그대로):
 *   content 1000×1000, 기준선 500px(=1000정규화 중 500) = 실제 1000mm → mmPerPx=2.
 *   같은 content에서 전체 폭(1000px) 측정 = 2000mm(±0.5%). ══════════════════════════════════════════ */
test("① Scale.mmPerPxFromTwoPoints/distanceMM — 1000mm 기준선 → 2000mm 측정 정확", () => {
  const Scale = loadScale(SCALE_SRC);
  const content = { w: 1000, h: 1000 };
  const p1 = { x: 0, y: 500 }, p2 = { x: 500, y: 500 };
  const mmPerPx = Scale.mmPerPxFromTwoPoints(content, p1, p2, 1000);
  ok(Math.abs(mmPerPx - 2) < 1e-9, "mmPerPx = 2 (1000mm / 500px)", mmPerPx);
  const q1 = { x: 0, y: 500 }, q2 = { x: 1000, y: 500 };
  const mm = Scale.distanceMM(content, q1, q2, mmPerPx);
  const err = Math.abs(mm - 2000) / 2000;
  ok(err <= 0.005, "거리 측정 2000mm ±0.5% (실측 " + mm + ")", mm);
});

test("① Scale.areaMM2 — 정사각형 폴리곤(실측 간단 도형) 면적", () => {
  const Scale = loadScale(SCALE_SRC);
  const content = { w: 1000, h: 1000 };
  const mmPerPx = 2; // 2mm/px
  // 500×500 px 정사각형 → 250000 px² → ×4(mm²/px²) = 1,000,000 mm²
  const pts = [{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 500 }, { x: 0, y: 500 }];
  const mm2 = Scale.areaMM2(content, pts, mmPerPx);
  ok(Math.abs(mm2 - 1000000) < 1, "면적 1,000,000mm²(=1m²) 정확", mm2);
});

/* ══════════════════════════════════════════════════════════════
 * ② 벡터 복사 구역(src_crop) 축척 파생 — deriveForCrop = base × scaleRef(31_Projects.js:1107 과 동일 정의).
 *   원본에서 800mm 재는 구간이, scaleRef=0.5 로 확대해 그린 복사본에서도 똑같이 800mm 로 나와야 한다
 *   (복사본은 같은 px 예산으로 원본의 절반 폭만 담았으므로 — §헤더 주석 "동일 실거리"). ══════════════════ */
test("② Scale.deriveForCrop — 벡터 복사 구역에서도 동일 실거리(800mm)", () => {
  const Scale = loadScale(SCALE_SRC);
  const baseMmPerPx = 2, scaleRef = 0.5;
  const derived = Scale.deriveForCrop(baseMmPerPx, scaleRef);
  ok(Math.abs(derived - 1) < 1e-9, "파생 mmPerPx = base(2) × scaleRef(0.5) = 1", derived);

  const origContent = { w: 1000, h: 1000 }, copyContent = { w: 1000, h: 1000 };
  const origMM = Scale.distanceMM(origContent, { x: 0, y: 0 }, { x: 400, y: 0 }, baseMmPerPx);   // 400px×2mm/px
  const copyMM = Scale.distanceMM(copyContent, { x: 0, y: 0 }, { x: 800, y: 0 }, derived);        // 800px×1mm/px(확대된 분)
  ok(Math.abs(origMM - 800) < 1e-9, "원본에서 실측 800mm", origMM);
  ok(Math.abs(copyMM - 800) < 1e-9, "복사본(src_crop 파생 축척)에서도 실측 800mm — 동일", copyMM);
  ok(Math.abs(origMM - copyMM) < 1e-9, "원본·복사본 실거리 일치(오차 0)");
});

test("② Scale.findScaleAnno — 페이지별 축척 주석 조회(가장 최근 1건)", () => {
  const Scale = loadScale(SCALE_SRC);
  const annos = [
    { id: "a1", page: 1, type: "scale", mmPerPx: 1 },
    { id: "a2", page: 1, type: "scale", mmPerPx: 3 },
    { id: "a3", page: 2, type: "scale", mmPerPx: 9 },
  ];
  ok(Scale.findScaleAnno(annos, 1).mmPerPx === 3, "페이지1 — 가장 최근(a2, mmPerPx=3)");
  ok(Scale.findScaleAnno(annos, 2).mmPerPx === 9, "페이지2 — a3");
  ok(Scale.findScaleAnno(annos, 3) === null, "페이지3 — 없음(null, 지어내지 않음)");
});

/* ══════════════════════════════════════════════════════════════
 * ③ XLSX(SpreadsheetML) — 한글 셀 값·열 수·행 수 round-trip. zip 없이 XML 파싱으로 검증. ══════ */
test("③ XlsxExport.build — 한글 헤더/값 round-trip + 행·열 수 일치", () => {
  const X = loadXlsx(XLSX_SRC);
  const columns = ["구역", "번호", "라벨", "면적(mm²)"];
  const rows = [
    ["A동", 1, "핀 하나 & <테스트>", 1000000],
    ["B동", 2, "두번째\"핀\"", 2500.5],
  ];
  const xml = X.build("점검보고서", columns, rows);
  ok(/<Worksheet ss:Name="점검보고서">/.test(xml), "시트명(한글) 보존");
  const cellVals = Array.from(xml.matchAll(/<Data ss:Type="(String|Number)">([^<]*)<\/Data>/g)).map((m) => m[2]);
  ok(cellVals.includes("구역") && cellVals.includes("핀 하나 &amp; &lt;테스트&gt;"), "한글 값 + XML 특수문자 이스케이프", cellVals);
  ok(cellVals.includes("2500.5"), "숫자 셀 값 보존(소수)", cellVals);
  const rowCount = (xml.match(/<Row>/g) || []).length;
  ok(rowCount === rows.length + 1, "행 수 = 헤더 1 + 데이터 " + rows.length, rowCount);
  const headerCellCount = (xml.match(/<Column /g) || []).length;
  ok(headerCellCount === columns.length, "열 너비 지정 수 = 열 개수", headerCellCount);
});

/* ══════════════════════════════════════════════════════════════
 * ④ 뮤테이션 증명 3건 — 고친 로직을 되돌리면 반드시 FAIL 한다(§G-2 뮤테이션 증명).
 *   각 블록은 "원본(그대로) PASS" 와 "뮤테이션 FAIL" 을 함께 확인한다. ══════════════════════════ */
test("④-1 뮤테이션: mmPerPxFromTwoPoints 의 '/ d' 제거 → 거리 계산이 틀려야 한다", () => {
  const mutated = SCALE_SRC.replace("return realMM / d;", "return realMM;"); // 나눗셈 제거(고의 결함)
  ok(mutated !== SCALE_SRC, "사전조건 — 치환이 실제로 적용됐다(문자열이 바뀜)");
  const Scale = loadScale(mutated);
  const content = { w: 1000, h: 1000 };
  const mmPerPx = Scale.mmPerPxFromTwoPoints(content, { x: 0, y: 0 }, { x: 500, y: 0 }, 1000);
  // 정상이면 2(=1000/500), 뮤테이션이면 1000(나눗셈 없이 realMM 그대로) — 다르면 뮤테이션이 "검출됨"(=테스트가 가짜가 아님).
  ok(mmPerPx !== 2, "뮤테이션 적용 시 mmPerPx ≠ 2(정상값과 달라짐 → 테스트가 결함을 잡아낸다)", mmPerPx);
});

test("④-2 뮤테이션: deriveForCrop 에서 scaleRef 곱셈 제거 → 복사본 실거리가 틀려야 한다", () => {
  const mutated = SCALE_SRC.replace(
    "return baseMmPerPx * scaleRef;",
    "return baseMmPerPx;" // scaleRef 무시(고의 결함 — 모든 복사본이 원본과 같은 배율이 돼버림)
  );
  ok(mutated !== SCALE_SRC, "사전조건 — 치환이 실제로 적용됐다");
  const Scale = loadScale(mutated);
  const derived = Scale.deriveForCrop(2, 0.5);
  ok(derived !== 1, "뮤테이션 적용 시 파생 mmPerPx ≠ 1(정상값과 달라짐)", derived);
});

test("④-3 뮤테이션: XlsxExport._esc 이스케이프 제거 → XML 특수문자가 그대로 새면 안 된다", () => {
  const mutated = XLSX_SRC.replace(
    '_esc(s) {\n      return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");\n    },',
    '_esc(s) { return String(s == null ? "" : s); },' // 이스케이프 제거(고의 결함)
  );
  ok(mutated !== XLSX_SRC, "사전조건 — 치환이 실제로 적용됐다");
  const X = loadXlsx(mutated);
  const xml = X.build("S", ["라벨"], [["<핀> & \"테스트\""]]);
  const hasRawAngle = /<핀>/.test(xml);
  ok(hasRawAngle, "뮤테이션 적용 시 이스케이프 없이 '<핀>' 이 그대로 샘(XML 구조 오염 — 정상 코드라면 절대 없어야 할 상태)", xml.slice(0, 200));
});
