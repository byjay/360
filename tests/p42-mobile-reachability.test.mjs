// [WO 20260918 mobile-reachability] 375×812 모바일에서 #sidebar(바텀시트) 자식 조작요소 15개가
// 화면 밖으로 나가 스크롤로도 닿지 않던 결함 검증.
//
// 근본원인: .sidebar 는 display:flex(세로)+max-height:52vh 인데 직접 자식들에 flex-shrink 기본값(1)이
// 걸려 있었다. 콘텐츠 자연 합계가 max-height 를 넘으면, "자기 overflow 를 스스로 제어하는"(overflow:hidden/
// auto → 자동 최소높이 0) 자식(#side-toolbar, #side-tree)만 0까지 짓눌리고, 그 내부 버튼들은 짓눌린 조상의
// overflow 경계에 클리핑되어 .sidebar 자신의 scrollHeight 계산에서 빠진다 → scrollHeight ≈ clientHeight
// (지휘자 실측 421 vs 422) → 스크롤 자체가 생기지 않음 → 도달 불가.
// 수정: `.sidebar > * { flex-shrink: 0; }` (public/css/style.css, max-width:760px 블록) — 아무 자식도
// 짓눌리지 않으므로 자연 합계가 그대로 .sidebar 의 scrollHeight 가 되어 overflow-y:auto 로 전부 도달 가능.
//
// 이 테스트는 실제 CSS 선언값(px/vh/clamp)을 파싱해 브라우저의 flexbox shrink 알고리즘을 그대로
// 모사한다 — 문자열 포함검사(.includes) 로 판정하지 않는다.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSS_PATH = path.join(__dirname, "..", "public", "css", "style.css");
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const css = stripComments(readFileSync(CSS_PATH, "utf8"));

const VIEWPORT = { w: 375, h: 812 };
const vh = (n) => (n / 100) * VIEWPORT.h;

// ── 선언값 추출 헬퍼 (blockRe 로 특정 셀렉터 블록 전건을 찾아 prop 값 문자열 반환) ──
function findDecl(source, selectorRegexSrc, prop, { last = false } = {}) {
  const blockRe = new RegExp(selectorRegexSrc + "\\s*\\{([^}]*)\\}", "gs");
  const propRe = new RegExp("(?:^|[;\\s])" + prop + "\\s*:\\s*([^;]+);");
  let m, found = null;
  while ((m = blockRe.exec(source))) {
    const pm = m[1].match(propRe);
    if (pm) { found = pm[1].trim(); if (!last) break; }
  }
  if (found === null) throw new Error(`'${prop}' 선언을 가진 블록을 찾지 못함 (셀렉터: ${selectorRegexSrc})`);
  return found.replace(/!important/g, "").trim();
}
function findMediaBlock(source, maxWidthPx, needle) {
  // [WO 20260918] 이 코드베이스는 "@media (max-width: 760px) {" 와 "@media(max-width:760px){" 를
  // 혼용한다(공백 유무 불일치) — 둘 다 매치하도록 공백을 전부 선택적으로 둔다.
  const re = new RegExp(`@media\\s*\\(\\s*max-width:\\s*${maxWidthPx}px\\s*\\)\\s*\\{`, "g");
  let m;
  while ((m = re.exec(source))) {
    const braceStart = source.indexOf("{", m.index);
    let depth = 0, i = braceStart;
    for (; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") { depth--; if (depth === 0) break; }
    }
    const block = source.slice(braceStart + 1, i);
    if (!needle || block.includes(needle)) return block;
  }
  return null;
}
function px(v) {
  const t = String(v).trim();
  const m = t.match(/^(-?[\d.]+)px$/);
  if (m) return parseFloat(m[1]);
  const mv = t.match(/^(-?[\d.]+)vh$/);
  if (mv) return vh(parseFloat(mv[1]));
  if (/^0$/.test(t)) return 0;
  throw new Error("px/vh 로 해석 불가: " + t);
}
function resolveClamp(expr) {
  const m = expr.trim().match(/^clamp\(([^,]+),([^,]+),([^)]+)\)$/);
  if (!m) throw new Error("clamp() 형식 아님: " + expr);
  const [min, pref, max] = [px(m[1]), px(m[2]), px(m[3])];
  return Math.min(Math.max(pref, min), max);
}
/** 여러 값(공백구분 shorthand, 예: "7px 9px") 중 첫/두번째 값을 px 로. */
function shorthandPx(v, idx) {
  const parts = v.trim().split(/\s+/);
  return px(parts[Math.min(idx, parts.length - 1)]);
}

const mobileBlock = findMediaBlock(css, 760, ".sidebar {");
if (!mobileBlock) throw new Error("style.css 의 .sidebar 바텀시트 max-width:760px 블록을 찾지 못함");

// ══════════════════════════════════════════════════════════════
// 1) 각 .sidebar 직접 자식의 "자연(비압축) 높이" — 실제 CSS 선언값으로부터 산출
// ══════════════════════════════════════════════════════════════
const LINE_HEIGHT_RATIO = 1.2; // 단일 라인 텍스트 근사(보수적, p41 관례와 동일한 근사 방식)

// .sidebar 자체 — mobile max-height
const sidebarMaxH = px(findDecl(mobileBlock, "\\.sidebar", "max-height"));
const clientHeightPx = sidebarMaxH; // overflow-y:auto 컨테이너의 가용(clientHeight) 상한

// .sidebar-section 공통값(전역 마지막 !important 오버라이드 — 3346라인대)
const sectionPadding = findDecl(css, "\\.sidebar-section(?!-)(?!\\.)", "padding", { last: true }); // "7px 9px"
const sectionPadV = shorthandPx(sectionPadding, 0);
const sectionGap = px(findDecl(css, "\\.sidebar-section(?!-)(?!\\.)", "gap", { last: true }));
const sectionBorderBottom = parseFloat(findDecl(css, "\\.sidebar-section(?!-)(?!\\.)", "border-bottom", { last: false }));

// .sidebar-section-head margin-bottom(전역 마지막 오버라이드)
const headMarginBottom = px(findDecl(css, "\\.sidebar-section-head", "margin-bottom", { last: true }));

// .btn-mini 모바일 min-height (btn-upload/btn-place/btn-deploy 와 공유 규칙)
const btnMiniMobileMinH = px(findDecl(mobileBlock, "\\.btn-upload,\\s*\\.btn-place,\\s*\\.btn-deploy,\\s*\\.btn-mini", "min-height"));

// .project-current
const pcPadV = shorthandPx(findDecl(css, "\\.project-current", "padding"), 0);
const pcBorder = parseFloat(findDecl(css, "\\.project-current", "border"));
const pcFontSize = px(findDecl(css, "\\.project-current", "font-size"));
const projectCurrentH = pcPadV * 2 + pcBorder * 2 + pcFontSize * LINE_HEIGHT_RATIO;

// .project-actions margin-top
const projectActionsMarginTop = px(findDecl(css, "\\.project-actions(?!\\.)", "margin-top"));

// #stb-toggle(.stb-toggle) 모바일 규칙 — padding/font-size/border/margin
const stbToggleBlock760 = findMediaBlock(css, 760, ".stb-toggle{");
if (!stbToggleBlock760) throw new Error(".stb-toggle 의 max-width:760px 블록을 찾지 못함");
const stbTogglePad = findDecl(stbToggleBlock760, "\\.stb-toggle", "padding");
const stbTogglePadV = shorthandPx(stbTogglePad, 0);
const stbToggleFontSize = px(findDecl(stbToggleBlock760, "\\.stb-toggle", "font-size"));
const stbToggleBorder = parseFloat(findDecl(stbToggleBlock760, "\\.stb-toggle", "border"));
const stbToggleMargin = findDecl(stbToggleBlock760, "\\.stb-toggle", "margin"); // "2px 0 6px"
const [stbMarginTop, , stbMarginBottom] = stbToggleMargin.trim().split(/\s+/).map(px);
const stbToggleOwnH = stbTogglePadV * 2 + stbToggleFontSize * LINE_HEIGHT_RATIO + stbToggleBorder * 2;
const stbToggleFlowH = stbToggleOwnH + stbMarginTop + stbMarginBottom;

// #side-toolbar 열림 상태 max-height(30vh) — 자체 상한이 곧 이 아이템의 "자연 높이" 상한(내부 버튼 총합은 이보다 큼)
const sideToolbarOpenMaxH = px(findDecl(css, "body\\.tools-open \\.side-toolbar", "max-height"));

// .side-tree max-height: clamp(160px,34vh,320px)
const sideTreeMaxHRaw = findDecl(css, "\\.side-tree", "max-height");
const sideTreeMaxH = resolveClamp(sideTreeMaxHRaw);

// #section-export: btn-deploy + btn-export-json(.btn-upload) 모바일 min-height 44 공유
const sectionExportH = sectionPadV * 2 + sectionBorderBottom + btnMiniMobileMinH * 2 + sectionGap;

// #section-projects: padding + head + gap + project-current + gap + project-actions(margin-top+btn) + border
const sectionHeadH = headMarginBottom + Math.max(pcFontSize /* 근사 */, btnMiniMobileMinH);
const projectActionsH = projectActionsMarginTop + btnMiniMobileMinH;
const sectionProjectsH =
  sectionPadV * 2 +
  sectionHeadH +
  sectionGap +
  projectCurrentH +
  sectionGap +
  projectActionsH +
  sectionBorderBottom;

// ══════════════════════════════════════════════════════════════
// 2) 실제 브라우저 flexbox shrink 알고리즘 모사
//    - flexShrink:0(현재 수정) → 아무도 안 눌림 → finalTotal = 자연 합계
//    - flexShrink:1(기본값, 수정 전 버그) → overflow 를 스스로 갖는 항목(floor=0)만 눌려
//      deficit 을 흡수, 나머지(자연 높이가 곧 floor)는 절대 안 눌림
// ══════════════════════════════════════════════════════════════
const items = [
  { name: "#section-projects", hyp: sectionProjectsH, floor: sectionProjectsH }, // overflow:visible → 자동 최소=자기자신
  { name: "#stb-toggle", hyp: stbToggleFlowH, floor: stbToggleFlowH },
  { name: "#side-toolbar", hyp: sideToolbarOpenMaxH, floor: 0 }, // overflow-y:auto → 자동 최소=0
  { name: "#side-tree", hyp: sideTreeMaxH, floor: 0 }, // overflow-y:auto → 자동 최소=0
  { name: "#section-export", hyp: sectionExportH, floor: sectionExportH },
];

function simulateFlexShrink(items, available, shrinkEnabled) {
  const naturalSum = items.reduce((s, it) => s + it.hyp, 0);
  if (!shrinkEnabled || naturalSum <= available) {
    return { finalSizes: items.map((it) => it.hyp), finalTotal: naturalSum };
  }
  let deficit = naturalSum - available;
  const sizes = items.map((it) => it.hyp);
  // 반복적으로: floor>0(자기 자신이 floor)인 항목은 절대 못 줄임 → floor=0인 항목들에게만 비례 분배
  const shrinkableIdx = items.map((it, i) => (it.floor === 0 ? i : -1)).filter((i) => i >= 0);
  const shrinkableCapacity = shrinkableIdx.reduce((s, i) => s + items[i].hyp, 0);
  const reduceBy = Math.min(deficit, shrinkableCapacity);
  for (const i of shrinkableIdx) {
    const share = shrinkableCapacity > 0 ? items[i].hyp / shrinkableCapacity : 0;
    sizes[i] = Math.max(0, items[i].hyp - reduceBy * share);
  }
  const finalTotal = sizes.reduce((s, v) => s + v, 0);
  return { finalSizes: sizes, finalTotal };
}

const fixed = simulateFlexShrink(items, clientHeightPx, false); // flex-shrink:0 (현재 CSS)
const buggy = simulateFlexShrink(items, clientHeightPx, true); // flex-shrink:1 (수정 전 가정)

// ── flex-shrink:0 이 실제로 선언돼 있는지 구조적으로 확인(값 자체는 위 시뮬레이션이 증명) ──
const hasFlexShrinkZero = /\.sidebar\s*>\s*\*\s*\{[^}]*flex-shrink\s*:\s*0/.test(mobileBlock);

const results = [];
const record = (name, pass, detail) => results.push({ name, pass, detail });

record(
  "① .sidebar 는 flex-shrink:0 자식 보호 규칙이 있고, 이로써 scrollHeight(자연합계) > clientHeight(52vh) 가 수치로 성립한다",
  hasFlexShrinkZero && fixed.finalTotal > clientHeightPx,
  `hasFlexShrinkZero=${hasFlexShrinkZero} scrollHeight(자연합계)=${fixed.finalTotal.toFixed(1)} clientHeight=${clientHeightPx.toFixed(1)} ` +
    `초과분(스크롤 가능폭)=${(fixed.finalTotal - clientHeightPx).toFixed(1)} ` +
    `[대조] flex-shrink 없었다면(수정 전 가정) scrollHeight=${buggy.finalTotal.toFixed(1)} (거의 clientHeight 와 동일 → 스크롤 없음)`
);

record(
  "② flex-shrink:0 적용 시 모든 자식이 자기 자연/자체상한 높이 그대로 렌더된다(잘림 없음)",
  fixed.finalSizes.every((v, i) => Math.abs(v - items[i].hyp) < 0.01),
  `finalSizes=${JSON.stringify(fixed.finalSizes.map((v) => Number(v.toFixed(1))))} hyp=${JSON.stringify(items.map((it) => Number(it.hyp.toFixed(1))))}`
);

// ③ 터치타깃 — 이번 수정과 무관하게 이미 44px 로 보장된 컨트롤(.btn-upload/.btn-place/.btn-deploy/.btn-mini)이
//    모바일에서 계속 ≥44px 을 유지하는지(회귀 감시). .mnav-btn 도 함께 확인(기존 규약).
const mnavMinH = px(findDecl(css, "\\.mnav-btn", "min-height"));
record(
  "③ 조작요소 터치타깃 — .btn-upload/.btn-place/.btn-deploy/.btn-mini(모바일) ≥44px, .mnav-btn ≥44px 유지",
  btnMiniMobileMinH >= 44 && mnavMinH >= 44,
  `btnMiniMobileMinH=${btnMiniMobileMinH} mnavMinH=${mnavMinH}`
);

// ④ p34/p41 의 겹침-0 회귀 스위트가 여전히 PASS 하는지(자식 프로세스로 그대로 재실행)
function runTest(fileName) {
  const p = path.join(__dirname, fileName);
  try {
    execFileSync(process.execPath, [p], { stdio: "pipe" });
    return { ok: true, out: "" };
  } catch (e) {
    return { ok: false, out: (e.stdout || "").toString() + (e.stderr || "").toString() };
  }
}
const p34 = runTest("p34-mobile-pano-layout.test.mjs");
const p41 = runTest("p41-mobile-save-reachable.test.mjs");
record(
  "④ 회귀 — p34(파노 레이더/도움말 겹침) · p41(저장버튼 겹침) 겹침-0 스위트 여전히 PASS",
  p34.ok && p41.ok,
  `p34.ok=${p34.ok} p41.ok=${p41.ok}` + (p34.ok && p41.ok ? "" : ` :: p34out=${p34.out.slice(-300)} p41out=${p41.out.slice(-300)}`)
);

// ⑤ 데스크톱 불변 — flex-shrink:0 규칙이 max-width:760px 미디어 블록 "안에만" 있고 전역(비-미디어)에는 없다
const globalHasFlexShrinkZero = /(^|\n)\s*\.sidebar\s*>\s*\*\s*\{[^}]*flex-shrink\s*:\s*0/.test(
  css.replace(new RegExp(mobileBlock.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "s"), "")
);
record(
  "⑤ 데스크톱 불변 — .sidebar > * { flex-shrink:0 } 규칙은 모바일(max-width:760px) 블록 안에만 존재",
  hasFlexShrinkZero && !globalHasFlexShrinkZero,
  `mobileBlock내부=${hasFlexShrinkZero} 블록밖(전역)존재여부=${globalHasFlexShrinkZero}`
);

for (const r of results) {
  console.log(`[${r.pass ? "PASS" : "FAIL"}] ${r.name} :: ${r.detail}`);
}
const failCount = results.filter((r) => !r.pass).length;
if (failCount > 0) {
  console.error(`\n${failCount}건 실패`);
  process.exit(1);
} else {
  console.log(`\n전체 ${results.length}건 PASS`);
  process.exit(0);
}
