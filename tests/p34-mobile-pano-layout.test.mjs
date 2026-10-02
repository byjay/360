// [WO 20260917] 모바일 파노 레이더↔조작판 겹침 제거 + 레이더 축소 + 토스트 가림 해소
// + 도움말 "?" 버튼 ↔ mobile-dock/pin-filter-bar/pin-grid-reopen 겹침 제거.
// DOM 없는 환경 기준(p32/p33 패턴 준용) — 소스 텍스트에서 CSS 규칙/변수를 파싱해
// 지휘자가 실측한 좌표(375×812)를 그대로 대입, 산식으로 겹침 면적을 계산한다.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { findHelpToggleBottomBlock } from "./_lib/find-help-toggle-bottom.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const styleCssPath = path.join(__dirname, "..", "public", "css", "style.css");
const tokensCssPath = path.join(__dirname, "..", "public", "css", "seastar-family-tokens.css");
const skinCssPath = path.join(__dirname, "..", "public", "css", "seastar-3d-skin.css");
const radarPath = path.join(__dirname, "..", "public", "js", "modules", "07_Radar.js");

const VW = 375, VH = 812; // 지휘자 실측 프로덕션 뷰포트

function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ""); }

/** 캐스케이드 순서(로드 순서) 그대로 이어붙인 하나의 소스 — style→tokens→skin. */
function loadCascade() {
  const style = stripComments(readFileSync(styleCssPath, "utf8"));
  const tokens = stripComments(readFileSync(tokensCssPath, "utf8"));
  const skin = stripComments(readFileSync(skinCssPath, "utf8"));
  return { style, tokens, skin, all: style + "\n" + tokens + "\n" + skin };
}

/** :root { --name: value; } 를 캐스케이드 순서로 마지막 선언까지 반영해 값을 읽는다(px 숫자만). */
function readRootVarPx(cascadeAll, name) {
  const re = new RegExp(`--${name}\\s*:\\s*([0-9.]+)px`, "g");
  let m, last = null;
  while ((m = re.exec(cascadeAll)) !== null) last = m[1];
  return last === null ? null : Number(last);
}

/** 미디어쿼리 블록(중괄호 깊이 추적)까지 포함해 특정 셀렉터의 선언 블록 텍스트를 찾는다(마지막 매치=캐스케이드 최종값). */
/** selectorRegex 와 매치되는 모든 선언 블록을 문서 순서(=캐스케이드 순서)대로 배열로 반환. */
function findAllRules(css, selectorRegex) {
  const re = new RegExp(selectorRegex.source + "\\s*\\{", selectorRegex.flags.includes("g") ? selectorRegex.flags : selectorRegex.flags + "g");
  const blocks = [];
  let m;
  while ((m = re.exec(css)) !== null) {
    const braceStart = css.indexOf("{", m.index);
    let depth = 0, i = braceStart;
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") { depth--; if (depth === 0) break; }
    }
    blocks.push(css.slice(braceStart + 1, i));
    re.lastIndex = i + 1;
  }
  return blocks;
}

/** 여러 선언 블록(문서 순서)을 훑어 특정 속성(propName)의 "마지막으로 정의된" 값을 캐스케이드처럼 반환.
 *  나중 블록이 그 속성을 정의하지 않으면 이전 블록 값이 유지된다(실제 CSS cascade와 동일 근사). */
function lastDeclaredValue(blocks, propName) {
  const re = new RegExp(`(?:^|;|\\{)\\s*${propName}\\s*:\\s*([^;]+);`);
  let value = null;
  for (const b of blocks) {
    const m = re.exec(b);
    if (m) value = m[1].trim();
  }
  return value;
}

function findLastRule(css, selectorRegex) {
  const blocks = findAllRules(css, selectorRegex);
  return blocks.length ? blocks[blocks.length - 1] : null;
}

/** 특정 부분 문자열을 포함하는 미디어 블록만 골라 반환(동일 헤더가 여러 번 나오는 경우 대비). */
function findMediaBlock(css, mediaHeaderSubstr, mustContain) {
  let searchFrom = 0;
  while (true) {
    const idx = css.indexOf(mediaHeaderSubstr, searchFrom);
    if (idx === -1) return null;
    const braceStart = css.indexOf("{", idx);
    let depth = 0, i = braceStart;
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") { depth--; if (depth === 0) break; }
    }
    const block = css.slice(braceStart + 1, i);
    if (!mustContain || block.includes(mustContain)) return block;
    searchFrom = i + 1;
  }
}

/** calc(var(--a) + var(--b) + 8px) 같은 단순 덧셈 calc를 숫자로 환산(이 파일 용도 한정 최소 파서). */
function evalSimpleCalc(expr, vars) {
  let s = expr.trim();
  const m = /^calc\((.*)\)$/.exec(s);
  if (m) s = m[1];
  s = s.replace(/var\(--([a-zA-Z0-9-]+)(?:,\s*[^)]+)?\)/g, (_, name) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return String(vars[name]);
    throw new Error(`알 수 없는 변수: --${name}`);
  });
  s = s.replace(/([0-9.]+)px/g, "$1");
  // + 만 지원(이 코드베이스의 실제 사용 패턴)
  const parts = s.split("+").map((p) => Number(p.trim()));
  if (parts.some((n) => Number.isNaN(n))) throw new Error(`파싱 실패: ${expr} -> ${s}`);
  return parts.reduce((a, b) => a + b, 0);
}

/** 사각형 겹침 면적(px²). 각 rect = {top,bottom,left,right} (y down). */
function overlapArea(a, b) {
  const top = Math.max(a.top, b.top);
  const bottom = Math.min(a.bottom, b.bottom);
  const left = Math.max(a.left, b.left);
  const right = Math.min(a.right, b.right);
  const h = Math.max(0, bottom - top);
  const w = Math.max(0, right - left);
  return h * w;
}

function run() {
  const results = [];
  const record = (name, pass, detail) => results.push({ name, pass, detail });
  const { style, tokens, skin, all } = loadCascade();
  const radarSrc = readFileSync(radarPath, "utf8");

  // ── SoT 변수 읽기 ──
  const controlsBottom = readRootVarPx(all, "pano-controls-bottom");
  const controlsHMobile = readRootVarPx(all, "pano-controls-h-mobile");
  const pinfilterBottomMobile = readRootVarPx(all, "pinfilter-bottom-mobile");
  const pinfilterHMobile = readRootVarPx(all, "pinfilter-h-mobile");

  // ── 결함1: 레이더(모바일 720px) vs 조작판 겹침 = 0 ──
  const radarMobileBlock = findMediaBlock(tokens, "@media (max-width: 720px)");
  const radarLargeMobileRule = radarMobileBlock && findLastRule(radarMobileBlock, /\.pano-radar\.pano-radar-large/);
  let radarRect = null, controlsRect = null, overlap1 = null;
  try {
    const widthMatch = radarLargeMobileRule && /width:\s*min\(([0-9.]+)vw,\s*([0-9.]+)px\)/.exec(radarLargeMobileRule);
    const bottomMatch = radarLargeMobileRule && /bottom:\s*([^;]+);/.exec(radarLargeMobileRule);
    const vars = { "pano-controls-bottom": controlsBottom, "pano-controls-h-mobile": controlsHMobile };
    const radarBottom = bottomMatch ? evalSimpleCalc(bottomMatch[1], vars) : null;
    const radarWidth = widthMatch ? Math.min((Number(widthMatch[1]) / 100) * VW, Number(widthMatch[2])) : null;
    // 실측 종횡비(높이/너비 = 264/293, 마스터 375x812 실측 293x264) 재사용해 축소 후 높이를 근사한다.
    const RATIO_H_OVER_W = 264 / 293;
    const radarHeight = radarWidth !== null ? radarWidth * RATIO_H_OVER_W : null;

    const controlsRule = findLastRule(style, /\.pano-controls/);
    const controlsHeight = controlsHMobile; // 모바일 2줄 래핑 실측치(SoT 변수)

    if (radarWidth !== null && radarHeight !== null && radarBottom !== null && controlsRule && controlsHeight !== null) {
      radarRect = { left: 18, right: 18 + radarWidth, bottom: VH - radarBottom, top: VH - radarBottom - radarHeight };
      controlsRect = {
        left: (VW - 187) / 2, right: (VW - 187) / 2 + 187, // 지휘자 실측 폭 187 재사용(중앙정렬)
        bottom: VH - controlsBottom, top: VH - controlsBottom - controlsHeight
      };
      overlap1 = overlapArea(radarRect, controlsRect);
    }
  } catch (e) {
    overlap1 = `계산 실패: ${e.message}`;
  }
  record(
    "① 모바일(720px) 레이더-확대 vs 조작판 겹침 면적 = 0",
    overlap1 === 0,
    `overlap=${JSON.stringify(overlap1)}, radar=${JSON.stringify(radarRect)}, controls=${JSON.stringify(controlsRect)}`
  );

  // ── 결함2: 레이더 화면 점유 ≤ 18% ──
  let areaPct = null;
  if (radarRect) {
    const w = radarRect.right - radarRect.left, h = radarRect.bottom - radarRect.top;
    areaPct = (w * h) / (VW * VH) * 100;
  }
  record(
    "② 모바일(720px) 레이더-확대 화면 점유율 ≤ 18%",
    typeof areaPct === "number" && areaPct <= 18,
    `areaPct=${areaPct}`
  );

  // ── 결함3: 토스트 z-index > 필터 칩 z-index (캐스케이드 3파일 전체 반영, 여러 블록에 걸친 속성값 추적) ──
  const toastBlocks = findAllRules(all, /\.wm-toast-host/);
  const pinfilterBlocks = findAllRules(all, /\.pinfilter-bar(?!-)/);
  const toastZRaw = lastDeclaredValue(toastBlocks, "z-index");
  const filterZRaw = lastDeclaredValue(pinfilterBlocks, "z-index");
  record(
    "③ .wm-toast-host z-index > .pinfilter-bar z-index (style+tokens+skin 캐스케이드)",
    toastZRaw !== null && filterZRaw !== null && Number(toastZRaw) > Number(filterZRaw),
    `toastZ=${toastZRaw}, filterZ=${filterZRaw}`
  );

  // ── 결함3 보강: 모바일 블록에서 토스트가 칩 바 상단 위로 띄워졌는지(위치 겹침 자체도 0) ──
  const pinfilterMobileBlock = findMediaBlock(style, "@media (max-width:640px), (pointer:coarse){", "pinfilter-bar");
  const toastMobileRule = pinfilterMobileBlock && findLastRule(pinfilterMobileBlock, /\.wm-toast-host/);
  let toastPosOverlap = null;
  try {
    const vars2 = { "pinfilter-bottom-mobile": pinfilterBottomMobile, "pinfilter-h-mobile": pinfilterHMobile };
    const toastBottomMatch = toastMobileRule && /bottom:\s*([^;]+);/.exec(toastMobileRule);
    const toastBottom = toastBottomMatch ? evalSimpleCalc(toastBottomMatch[1], vars2) : null;
    if (toastBottom !== null) {
      // 필터 바 존(모바일): bottom=pinfilterBottomMobile, height=pinfilterHMobile(실측 SoT)
      const filterTop = VH - pinfilterBottomMobile - pinfilterHMobile;
      const filterBottom = VH - pinfilterBottomMobile;
      // 토스트 최소 높이(1줄) 가정 없이, "토스트 하단(가장 아래)"이 칩 바 상단보다 위(작은 y)인지만 검사
      // → toastBottom(px, 화면하단 기준 offset)이 클수록 화면상 더 위로 올라간다.
      const toastBottomEdgeY = VH - toastBottom;
      toastPosOverlap = toastBottomEdgeY <= filterTop ? 0 : (toastBottomEdgeY - filterTop);
    }
  } catch (e) { toastPosOverlap = `계산 실패: ${e.message}`; }
  record(
    "③-보강) 모바일 토스트 하단 위치가 필터 칩 바 상단과 겹치지 않음(위치 자체 분리)",
    toastPosOverlap === 0,
    `toastPosOverlap=${JSON.stringify(toastPosOverlap)}`
  );

  // ── 결함4: "?" 버튼 vs mobile-dock 겹침 = 0 ──
  // [WO 20261002-gap 재발주] 🔴 4073788 에서 [data-help-toggle] 의 bottom !important 규칙이
  // "mobile-dock 을 정의하는 미디어 블록 안"에서 별도 블록(body:has(#screen-app.active) 그룹,
  // CLAUDE.md §10 SoT 통합)으로 옮겨졌다 — 공유 헬퍼(tests/_lib/find-help-toggle-bottom.mjs,
  // p41·p46·p47·p49 와 공용)로 style 전체에서 직접 찾는다(산식은 그대로
  // pinfilter-bottom-mobile+pinfilter-h-mobile+8px — 값 자체는 불변, 검색 범위만 확장).
  const helpToggleRule = findHelpToggleBottomBlock(style);
  let helpRect = null, dockRect = null, overlap4 = null, overlap5 = null, overlap6 = null;
  try {
    const vars3 = { "pinfilter-bottom-mobile": pinfilterBottomMobile, "pinfilter-h-mobile": pinfilterHMobile };
    const helpBottomMatch = helpToggleRule && /bottom:\s*([^;]+?)\s*!important/.exec(helpToggleRule);
    const helpBottom = helpBottomMatch ? evalSimpleCalc(helpBottomMatch[1], vars3) : null;
    if (helpBottom !== null) {
      // 버튼 크기 40x40, left:16px — 36_Help.js _toggleStyle 인라인 값(변경 안 함) 그대로 사용.
      helpRect = { left: 16, right: 56, bottom: VH - helpBottom, top: VH - helpBottom - 40 };
      // 지휘자 실측 좌표 재사용(재조사 불필요) — mobile-dock 375x59 @0,753 / pin-filter-bar 303x48 @8,700 / pin-grid-reopen 46x46 @315,690
      dockRect = { left: 0, right: 375, top: 753, bottom: 812 };
      const filterRect = { left: 8, right: 8 + 303, top: 700, bottom: 700 + 48 };
      const reopenRect = { left: 315, right: 315 + 46, top: 690, bottom: 690 + 46 };
      overlap4 = overlapArea(helpRect, dockRect);
      overlap5 = overlapArea(helpRect, filterRect);
      overlap6 = overlapArea(helpRect, reopenRect);
    }
  } catch (e) { overlap4 = `계산 실패: ${e.message}`; }
  record(
    "④ 모바일 '?' 버튼 vs mobile-dock 겹침 면적 = 0",
    overlap4 === 0,
    `overlap=${JSON.stringify(overlap4)}, help=${JSON.stringify(helpRect)}, dock=${JSON.stringify(dockRect)}`
  );
  record(
    "⑤ 모바일 '?' 버튼 vs pin-filter-bar 겹침 면적 = 0",
    overlap5 === 0,
    `overlap=${JSON.stringify(overlap5)}`
  );
  record(
    "⑥ 모바일 '?' 버튼 vs pin-grid-reopen 겹침 면적 = 0",
    overlap6 === 0,
    `overlap=${JSON.stringify(overlap6)}`
  );

  // ── 회귀: wm-radar-large 기본 확대 토글 로직 생존 ──
  record(
    "⑦ localStorage('wm-radar-large') 기본 확대 토글 로직 생존(회귀)",
    /localStorage\.getItem\("wm-radar-large"\)/.test(radarSrc) &&
      /classList\.toggle\("pano-radar-large", storedLarge\)/.test(radarSrc) &&
      /localStorage\.setItem\("wm-radar-large", large \? "1" : "0"\)/.test(radarSrc),
    "패턴 3종 확인"
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
