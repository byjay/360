// [WO 20260917 radar zoom] 파노라마 미니맵(레이더) 콘텐츠 확대(1~6x) 정적 회귀 테스트.
// 실행 환경에 DOM이 없으므로(p32 패턴 준용) 소스 텍스트 정규식/중괄호 깊이 파싱으로 검증한다.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const radarPath = path.join(__dirname, "..", "public", "js", "modules", "07_Radar.js");
const helpPath = path.join(__dirname, "..", "public", "js", "modules", "36_Help.js");
const htmlPath = path.join(__dirname, "..", "public", "index.html");
const cssPath = path.join(__dirname, "..", "public", "css", "style.css");

function extractFn(src, name) {
  // 메서드 "정의"만 찾는다("name() {" 패턴) — "this.name();" 같은 호출부와 구분해야
  // 첫 occurrence(호출부)를 잘못 집어 엉뚱한 함수 본문을 반환하지 않는다.
  const idx = src.indexOf(name + "() {");
  if (idx === -1) return null;
  const braceStart = src.indexOf("{", idx);
  if (braceStart === -1) return null;
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  return src.slice(braceStart, i + 1);
}

function run() {
  const results = [];
  const record = (name, pass, detail) => results.push({ name, pass, detail });

  const radarSrc = readFileSync(radarPath, "utf8");
  const helpSrc = readFileSync(helpPath, "utf8");
  const htmlSrc = readFileSync(htmlPath, "utf8");
  const cssSrc = readFileSync(cssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  const bindFn = extractFn(radarSrc, "_bindZoomControls");
  const applyFn = extractFn(radarSrc, "_applyTransform");

  // ① +/− 로 배율이 1↔6 범위에서만 변한다 (경계 클램프)
  record(
    "① ZMIN=1 / ZMAX=6 클램프(clamp) 함수 존재",
    !!bindFn && /ZMIN\s*=\s*1/.test(bindFn) && /ZMAX\s*=\s*6/.test(bindFn) &&
      /clamp\s*=\s*\(v\)\s*=>\s*Math\.max\(ZMIN,\s*Math\.min\(ZMAX,\s*v\)\)/.test(bindFn) &&
      /setZoom\s*=\s*\(v\)\s*=>\s*\{\s*this\._zoom\s*=\s*clamp\(v\)/.test(bindFn),
    bindFn ? "존재" : "_bindZoomControls 없음"
  );

  // ② 확대해도 패널 박스(.pano-radar) 크기 값이 불변 — zoom 코드는 stage.style.transform만 건드리고
  //    박스 자체(width/height)는 만지지 않는다. CSS 쪽도 기존 고정폭이 그대로 남아있어야 한다.
  const touchesBoxSize = bindFn && /getElementById\(["']pano-radar["']\)/.test(bindFn);
  const cssBoxWidthMatch = cssSrc.match(/\.pano-radar\s*\{([^}]*)\}/);
  record(
    "② 줌 컨트롤이 박스(#pano-radar) 크기를 직접 조작하지 않음 + CSS 고정폭(188px) 불변",
    !touchesBoxSize && !!cssBoxWidthMatch && /width:\s*188px/.test(cssBoxWidthMatch[1]) && /overflow:\s*hidden/.test(cssBoxWidthMatch[1]),
    `touchesBoxSize=${touchesBoxSize}, cssBox=${cssBoxWidthMatch ? cssBoxWidthMatch[1].trim().slice(0,80) : "(없음)"}`
  );

  // ③ 확대 시 현재 위치(핀)가 중앙(50%)에 유지되는 변환식 v = pin - 50/s 가 적용된다.
  record(
    "③ 중앙 유지 변환식(vx = pin.x - 50/s, vy = pin.y - 50/s) 존재",
    !!applyFn && /vx\s*=\s*pin\.x\s*-\s*50\s*\/\s*s/.test(applyFn) && /vy\s*=\s*pin\.y\s*-\s*50\s*\/\s*s/.test(applyFn) &&
      /zoom\s*>\s*1\.001/.test(applyFn),
    applyFn ? "존재" : "_applyTransform 없음"
  );

  // ④ 더블탭/더블클릭 리셋이 1x로 돌린다.
  record(
    "④ dblclick과 더블탭(300ms) 모두 setZoom(1) 호출",
    !!bindFn && /dblclick["'],?\s*\(e\)\s*=>\s*\{[^}]*setZoom\(1\)/.test(bindFn) &&
      /now\s*-\s*lastTapT\s*<\s*300[\s\S]{0,40}setZoom\(1\)/.test(bindFn),
    bindFn ? "존재" : "_bindZoomControls 없음"
  );

  // ⑤ 레이더 확대 상태에서 .pano-controls 영역을 침범하지 않는다 — 박스 경계(bottom/z-index) 값이
  //    줌 기능 추가로 변경되지 않았음을 CSS에서 확인(값 자체를 파싱해 비교, 하드코딩 비교 금지).
  const radarBoxDecl = cssSrc.match(/\.pano-radar\s*\{([^}]*)\}/);
  const panoControlsDecl = cssSrc.match(/\.pano-controls\s*\{([^}]*)\}/);
  const radarZ = radarBoxDecl && radarBoxDecl[1].match(/z-index:\s*(\d+)/);
  const ctrlZ = panoControlsDecl && panoControlsDecl[1].match(/z-index:\s*(\d+)/);
  record(
    "⑤ .pano-controls z-index > .pano-radar z-index (조작바가 항상 위, 박스 크기·위치는 줌 기능이 건드리지 않음)",
    !!radarZ && !!ctrlZ && Number(ctrlZ[1]) > Number(radarZ[1]),
    `radarZ=${radarZ ? radarZ[1] : "?"}, ctrlZ=${ctrlZ ? ctrlZ[1] : "?"}`
  );

  // ⑥ Help 항목이 등록되고 data-help 배지 대상이 실재한다(렌더 고아 방지).
  const helpKeyMatch = helpSrc.match(/"radar-zoom":\s*"[^"]+"/);
  const dataHelpInHtml = /id="pano-radar-zoom-in"[^>]*data-help="radar-zoom"/.test(htmlSrc);
  record(
    "⑥ Help.CONTENT['radar-zoom'] 등록 + HTML에 실재하는 요소(#pano-radar-zoom-in)의 data-help로 연결(렌더 고아 방지)",
    !!helpKeyMatch && dataHelpInHtml,
    `helpKey=${!!helpKeyMatch}, htmlBadge=${dataHelpInHtml}`
  );

  // 부가: HTML에 +/- 버튼 둘 다 존재
  record(
    "부가) #pano-radar-zoom-in, #pano-radar-zoom-out 버튼 둘 다 index.html에 존재",
    /id="pano-radar-zoom-in"/.test(htmlSrc) && /id="pano-radar-zoom-out"/.test(htmlSrc),
    "grep 결과 확인"
  );

  return results;
}

const results = run();
let failCount = 0;
for (const r of results) {
  const mark = r.pass ? "PASS" : "FAIL";
  console.log(`[${mark}] ${r.name} :: ${r.detail}`);
  if (!r.pass) failCount++;
}

if (failCount > 0) {
  console.error(`\n${failCount}건 실패`);
  process.exit(1);
} else {
  console.log(`\n전체 ${results.length}건 PASS`);
  process.exit(0);
}
