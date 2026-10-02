// [WO 20260918 mobile-save-dock] 모바일 375×812 에서 #btn-save(하단 FAB)가 .mobile-dock/.pinfilter-bar/
// .pin-grid-reopen/[data-help-toggle] 와 겹치지 않는지 CSS 선언값을 파싱해 "숫자로" 검증한다.
// 문자열 포함 검사(.includes 등)로 판정하지 않는다 — calc()/var()/env() 를 실제로 평가해 rect 를 만들고
// 겹침 면적을 계산한다.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { findHelpToggleBottomRaw } from "./_lib/find-help-toggle-bottom.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSS_DIR = path.join(__dirname, "..", "public", "css");
const JS_DIR = path.join(__dirname, "..", "public", "js", "modules");

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const styleCss = stripComments(readFileSync(path.join(CSS_DIR, "style.css"), "utf8"));
const tokensCss = stripComments(readFileSync(path.join(CSS_DIR, "seastar-family-tokens.css"), "utf8"));
const cascade = styleCss + "\n" + tokensCss;

const VIEWPORT = { w: 375, h: 812 };

// ── calc()/var()/env() 최소 평가기 — 우리가 쓰는 값은 전부 'px 항들의 덧셈'뿐이라 이 정도로 충분 ──
function extractRootVars(css) {
  const vars = {};
  const re = /:root\s*\{([^}]*)\}/gs;
  let rm;
  while ((rm = re.exec(css))) {
    const body = rm[1];
    const dre = /--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
    let m;
    while ((m = dre.exec(body))) vars[m[1]] = m[2].trim();
  }
  return vars;
}
const ROOT_VARS = extractRootVars(cascade);

function resolveOnce(expr) {
  let changed = false;
  // var(--x) 또는 var(--x, fallback) — fallback 안에 괄호가 있을 수 있어 균형 매칭은 생략하고
  // 우리 코드베이스의 실제 형태(괄호 1중첩 이하)만 지원한다.
  const out = expr.replace(/var\(\s*--([a-zA-Z0-9_-]+)\s*(?:,((?:[^()]|\([^()]*\))*))?\)/, (full, name, fallback) => {
    changed = true;
    if (ROOT_VARS[name] !== undefined) return ROOT_VARS[name];
    if (fallback !== undefined) return fallback.trim();
    throw new Error("정의되지 않은 var(--" + name + ") — 폴백도 없음: " + full);
  });
  if (changed) return out;
  const out2 = expr.replace(/env\(\s*safe-area-inset-bottom\s*(?:,([^()]*))?\)/, () => {
    changed = true;
    return "0px"; // 지휘자 실측 기준 디바이스(세이프에어리어 0)와 동일 조건
  });
  return out2;
}
function resolveAll(expr) {
  let prev = expr, cur = resolveOnce(expr), guard = 0;
  while (cur !== prev) { prev = cur; cur = resolveOnce(cur); if (++guard > 30) throw new Error("resolve 루프 초과: " + expr); }
  return cur;
}
function toPx(term) {
  const t = term.trim();
  if (/^0$/.test(t)) return 0;
  const m = t.match(/^(-?[\d.]+)px$/);
  if (m) return parseFloat(m[1]);
  throw new Error("px 로 해석 불가: '" + t + "'");
}
function evalPx(rawExpr) {
  const resolved = resolveAll(rawExpr.trim());
  const cm = resolved.match(/^calc\((.+)\)$/s);
  if (cm) {
    const terms = cm[1].split("+").map((s) => s.trim());
    return terms.reduce((sum, t) => sum + toPx(t), 0);
  }
  return toPx(resolved);
}

// ── 겹침 면적 계산 (숫자 기반, 문자열 비교 없음) ──
function overlapArea(a, b) {
  const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ox * oy;
}

// ══════════════════════════════════════════════════════════════
// 1) 실제 CSS 선언값 추출 (지정 셀렉터의 특정 프로퍼티 값 문자열만 정규식으로 뽑아 evalPx 로 숫자화)
// ══════════════════════════════════════════════════════════════
function findDecl(css, selectorRegexSrc, prop) {
  // 같은 셀렉터가 여러 블록에 등장할 수 있어(예: ".mobile-nav, .mobile-dock{display:none}" 요약규칙과
  // 실제 정의 블록이 공존) prop 을 실제로 담은 블록을 전건 스캔해서 찾는다.
  const blockRe = new RegExp(selectorRegexSrc + "\\s*\\{([^}]*)\\}", "gs");
  const propRe = new RegExp("(?:^|[;\\s])" + prop + "\\s*:\\s*([^;]+);");
  let m, found = null;
  while ((m = blockRe.exec(css))) {
    const pm = m[1].match(propRe);
    if (pm) { found = pm[1].trim(); break; }
  }
  if (found === null) throw new Error(`'${prop}' 선언을 가진 블록을 찾지 못함 (셀렉터: ${selectorRegexSrc})`);
  return found;
}

// #btn-save 모바일 FAB 규칙 (seastar-family-tokens.css, max-width:640px 블록)
function findMediaBlockContaining(css, mediaRe, needle) {
  const re = new RegExp(mediaRe.source, "g" + (mediaRe.flags.includes("s") ? "s" : ""));
  let m;
  while ((m = re.exec(css))) {
    if (m[1].includes(needle)) return m[1];
  }
  return null;
}
const mobileBlock = findMediaBlockContaining(tokensCss, /@media \(max-width: 640px\) \{([\s\S]*?)\n\}/, "#btn-save");
if (!mobileBlock) throw new Error("seastar-family-tokens.css 의 #btn-save 포함 max-width:640px 미디어 블록을 찾지 못함");
const btnSaveBottomRaw = findDecl(mobileBlock, "#btn-save\\.btn-save:not\\(\\.hidden\\)", "bottom");
const btnSavePosition = findDecl(mobileBlock, "#btn-save\\.btn-save:not\\(\\.hidden\\)", "position");
const btnSaveRight = evalPx(findDecl(mobileBlock, "#btn-save\\.btn-save:not\\(\\.hidden\\)", "right"));
const btnSaveBottom = evalPx(btnSaveBottomRaw);

// #btn-save 크기 — padding/border/line-height 로 유도(이 미디어블록 + 기본 규칙)
const btnSavePadding = findDecl(mobileBlock, "#btn-save\\.btn-save:not\\(\\.hidden\\)", "padding"); // "13px 20px"
const [padV, padH] = btnSavePadding.split(/\s+/).map((s) => parseFloat(s));
const btnSaveFontSize = evalPx(findDecl(mobileBlock, "#btn-save\\.btn-save:not\\(\\.hidden\\)", "font-size"));
const baseBorder = findDecl(tokensCss, "#btn-save\\.btn-save", "border"); // "1.5px solid #d8a83e"
const borderPx = parseFloat(baseBorder);
const btnSaveH = padV * 2 + btnSaveFontSize /* line-height:1 */ + borderPx * 2;
// 너비는 padding-H*2 + 아이콘(15) + gap(6) + 텍스트 근사폭(지휘자 실측 100×43 기준 검증용 하한만 사용)
const btnSaveW = padH * 2 + 15 + 6 + 40; // 아이콘15 + gap6(.btn-save 기본 gap) + 텍스트 대략폭(보수적 최소값)

const btnSaveRect = {
  x: VIEWPORT.w - btnSaveRight - btnSaveW,
  y: VIEWPORT.h - btnSaveBottom - btnSaveH,
  w: btnSaveW,
  h: btnSaveH,
};

// .mobile-dock 높이 = .mdock-bar 의 height 선언(리터럴이든 var()든 evalPx 가 그대로 처리) + border-top(1px)
// + safe-area-bottom(0, 지휘자 실측 조건). --mdock-h 변수 존재 여부에 의존하지 않는다(다른 세션이 아직
// 커밋하지 않은 리팩터일 수 있음 — 이 테스트는 그 변수의 존재를 전제로 삼지 않는다).
const mdockH = evalPx(findDecl(cascade, "\\.mdock-bar", "height"));
const dockBorderTop = parseFloat(findDecl(styleCss, "\\.mobile-dock", "border-top"));
const dockTotalH = mdockH + dockBorderTop + 0; // safe-area-inset-bottom = 0
const mobileDockRect = { x: 0, y: VIEWPORT.h - dockTotalH, w: VIEWPORT.w, h: dockTotalH };

// .pin-grid-reopen (모바일 오버라이드 블록, style.css 내 (max-width:640px), (pointer:coarse) 미디어)
const reopenBlock = findMediaBlockContaining(styleCss, /@media \(max-width: 640px\), \(pointer: coarse\)\{([\s\S]*?)\n\}/, ".pin-grid-reopen{");
if (!reopenBlock) throw new Error("style.css 의 pin-grid-reopen 모바일 미디어 블록을 찾지 못함");
const reopenBottom = evalPx(findDecl(reopenBlock, "\\.pin-grid-reopen", "bottom"));
const reopenW = evalPx(findDecl(reopenBlock, "\\.pin-grid-reopen", "width"));
const reopenH = evalPx(findDecl(reopenBlock, "\\.pin-grid-reopen", "height"));
const reopenRight = evalPx(findDecl(styleCss, "\\.pin-grid-reopen(?!-)", "right")); // 기본 규칙(top:16;right:14) 재사용
const pinGridReopenRect = { x: VIEWPORT.w - reopenRight - reopenW, y: VIEWPORT.h - reopenBottom - reopenH, w: reopenW, h: reopenH };

// .pinfilter-bar (모바일) — 실제 너비는 콘텐츠에 따라 가변이라, max-width 값을 '최악의 경우'로 써서
// 그래도 겹치지 않아야 통과하게 한다(보수적 검증).
const pfBlock = findMediaBlockContaining(styleCss, /@media \(max-width:640px\), \(pointer:coarse\)\{([\s\S]*?)\n\}/, ".pinfilter-bar{");
if (!pfBlock) throw new Error("style.css 의 pinfilter-bar 모바일 미디어 블록을 찾지 못함");
const pfBottomRaw = findDecl(pfBlock, "\\.pinfilter-bar", "bottom");
const pfBottom = evalPx(pfBottomRaw);
const pfLeft = evalPx(findDecl(pfBlock, "\\.pinfilter-bar", "left"));
const pfMaxWidthRaw = findDecl(pfBlock, "\\.pinfilter-bar", "max-width"); // calc(100% - 16px)
const pfMaxWidthCalc = pfMaxWidthRaw.match(/^calc\(100%\s*-\s*([\d.]+)px\)$/);
if (!pfMaxWidthCalc) throw new Error("pinfilter-bar max-width 형식 불일치: " + pfMaxWidthRaw);
const pfW = VIEWPORT.w - parseFloat(pfMaxWidthCalc[1]); // 최악의 경우(꽉 찬 폭)
const pfH = evalPx(ROOT_VARS["pinfilter-h-mobile"]); // 실측 높이 SoT
const pinfilterBarRect = { x: pfLeft, y: VIEWPORT.h - pfBottom - pfH, w: pfW, h: pfH };

// [data-help-toggle] — 인라인 JS 리터럴(36_Help.js: width/height 40px) + CSS !important bottom
const helpJs = readFileSync(path.join(JS_DIR, "36_Help.js"), "utf8");
if (!/width:40px.*height:40px|width:40px[\s\S]{0,40}height:40px/.test(helpJs)) {
  throw new Error("36_Help.js 의 helpToggle 40x40 리터럴을 찾지 못함(소스 변경됨?)");
}
// [WO 20261002-gap 재발주] 🔴 4073788 에서 [data-help-toggle] 가 쉼표로 묶인 셀렉터 그룹의
// 중간 항목(body:has(#screen-app.active) [data-help-toggle], ...)으로 옮겨져 바로 뒤에 "{" 가
// 오지 않는다 — 공유 헬퍼(tests/_lib/find-help-toggle-bottom.mjs, p34·p46·p47·p49 와 공용)로
// 그룹 어디에 있든 bottom:...!important 규칙을 찾는다.
const helpBottomRaw = findHelpToggleBottomRaw(styleCss);
if (helpBottomRaw === null) throw new Error("[data-help-toggle] 모바일 bottom !important 규칙을 찾지 못함");
const helpBottom = evalPx(helpBottomRaw);
const helpToggleRect = { x: 16, y: VIEWPORT.h - helpBottom - 40, w: 40, h: 40 };

// ══════════════════════════════════════════════════════════════
// 검증
// ══════════════════════════════════════════════════════════════
const results = [];
const record = (name, pass, detail) => results.push({ name, pass, detail });

record(
  "① #btn-save 는 position:fixed 이며 .mobile-dock 과 겹침 면적 0",
  btnSavePosition === "fixed" && overlapArea(btnSaveRect, mobileDockRect) === 0,
  `btnSave=${JSON.stringify(btnSaveRect)} dock=${JSON.stringify(mobileDockRect)} overlap=${overlapArea(btnSaveRect, mobileDockRect)}`
);

record(
  "② #btn-save 가 .pin-grid-reopen / .pinfilter-bar(최악폭) / [data-help-toggle] 와도 겹치지 않는다",
  overlapArea(btnSaveRect, pinGridReopenRect) === 0 &&
    overlapArea(btnSaveRect, pinfilterBarRect) === 0 &&
    overlapArea(btnSaveRect, helpToggleRect) === 0,
  `reopenOverlap=${overlapArea(btnSaveRect, pinGridReopenRect)} pinfilterOverlap=${overlapArea(btnSaveRect, pinfilterBarRect)} helpOverlap=${overlapArea(btnSaveRect, helpToggleRect)}`
);

// ③ 상단바의 나머지 버튼들 — position:fixed/absolute 로 이탈시키는 규칙이 없어야
//    정상 플로우(topbar 높이 68px 이내)에 머무르고, 이는 어떤 하단 클러스터(가장 높은 것: helpToggle top)
//    보다도 한참 위에 있어 기하학적으로 겹칠 수 없다.
const topbarH = evalPx(findDecl(styleCss, "\\.topbar", "height"));
const OTHER_TOPBAR_SELECTORS = [".btn-allpins", ".btn-exit-edit", ".btn-enter-edit", ".btn-settings"];
const offenders = [];
for (const sel of OTHER_TOPBAR_SELECTORS) {
  const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![a-zA-Z-])[^{]*\\{([^}]*)\\}", "g");
  let m;
  while ((m = re.exec(cascade))) {
    if (/position\s*:\s*(fixed|absolute)/.test(m[1])) offenders.push(`${sel} :: ${m[0].slice(0, 80)}`);
  }
}
const highestClusterTop = Math.min(mobileDockRect.y, pinGridReopenRect.y, pinfilterBarRect.y, helpToggleRect.y);
record(
  "③ 상단바 나머지 버튼(btn-allpins/exit-edit/enter-edit/settings)은 이탈 규칙 없음 + topbar(68px) < 최상단 하단클러스터",
  offenders.length === 0 && topbarH < highestClusterTop,
  `offenders=${JSON.stringify(offenders)} topbarH=${topbarH} highestClusterTop=${highestClusterTop}`
);

// ④ 저장 실패 시 사용자 알림 경로 존재 (기존 토스트 재사용, 새 배지 없음)
const appJs = readFileSync(path.join(JS_DIR, "20_App.js"), "utf8");
const saveNowMatch = appJs.match(/async _saveNow\(opts\) \{[\s\S]*?\n    \},\n/);
if (!saveNowMatch) throw new Error("_saveNow 함수를 찾지 못함(소스 변경됨?)");
const saveNowBody = saveNowMatch[0];
const toastCallCount = (saveNowBody.match(/Prompt\.toast\s*&&\s*Prompt\.toast\(/g) || []).length;
// _createInitialSave 가 예외 없이 실패(autoSaveDepId 미설정)하는, catch 블록을 우회하는 특정 분기에
// 토스트가 있는지 — 전역 카운트만 보면 이 분기 하나가 빠져도 다른 토스트들 때문에 통과해버린다(회귀 놓침).
const createInitialSaveFailBranch = saveNowBody.match(
  /await this\._createInitialSave\(\);\s*\n\s*if \(!State\.autoSaveDepId\) \{([\s\S]*?)\n\s*\}/
);
if (!createInitialSaveFailBranch) throw new Error("_createInitialSave 실패 분기를 찾지 못함(소스 변경됨?)");
const createInitialSaveFailHasToast = /Prompt\.toast\s*&&\s*Prompt\.toast\(/.test(createInitialSaveFailBranch[1]);
record(
  "④ _saveNow: _createInitialSave 실패(예외 없이 autoSaveDepId 미설정, catch 우회)분기에도 Prompt.toast 알림 존재",
  toastCallCount >= 3 && createInitialSaveFailHasToast,
  `toast 호출 수=${toastCallCount} createInitialSaveFailHasToast=${createInitialSaveFailHasToast}`
);

// ⑤ 터치타깃 — 핵심 모바일 그룹(mnav-btn/mdock-chip)은 min-height 44 유지, #btn-save 크기는 회귀 없음
const mnavMinH = evalPx(findDecl(styleCss, "\\.mnav-btn", "min-height"));
record(
  "⑤ 터치타깃 — .mnav-btn min-height ≥44 유지 + #btn-save 폭 ≥44(높이는 기존값 유지, 이번 수정과 무관)",
  mnavMinH >= 44 && btnSaveRect.w >= 44,
  `mnavMinH=${mnavMinH} btnSaveW=${btnSaveRect.w.toFixed(1)} btnSaveH(참고,기존값)=${btnSaveH.toFixed(1)}`
);

// ⑥ 데스크톱 불변 — #btn-save.btn-save 기본(비-미디어) 규칙에는 position:fixed 가 없다
const baseRuleBlock = tokensCss.match(/#btn-save\.btn-save\s*\{([^}]*)\}/);
if (!baseRuleBlock) throw new Error("#btn-save.btn-save 기본 규칙을 찾지 못함");
record(
  "⑥ 데스크톱(비-모바일) 기본 #btn-save.btn-save 규칙은 position:fixed 아님(모바일 미디어에만 적용)",
  !/position\s*:\s*fixed/.test(baseRuleBlock[1]),
  `baseRule=${baseRuleBlock[1].trim().slice(0, 120)}`
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
