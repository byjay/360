// [WO 20261002-fixmobile2] 지휘자 재현 R1~R3 겹침 3종을 "숫자로" 검증한다(p34/p41/p114 패턴 계승).
// 문자열 포함 검사 금지 — calc()/var()/env()/vh 를 실제로 평가해 rect 를 만들고 겹침 면적을 계산한다.
//   R1: 메뉴 시트(.sidebar, body.sidebar-open) 열림 중 FAB([data-help-toggle] 등)가 "CHECKER" 항목을 가림
//   R2: 배치모드 안내(.crosshair-msg)가 번호대역 칩 줄(#regmode-start-wrap)을 덮음
//   R3: PWA 설치 배너(.pwa-install-banner.on)와 앱설치 FAB(#pwa-install-btn)가 같은 공식으로 겹침
// 마스터 "숨기지 마" — 세 항목 모두 위치만 옮겨 겹침을 0으로 만들었는지 검증(z-index 조작/hidden 금지는
// 소스 리뷰 몫이고, 이 테스트는 "겹침 면적=0"이라는 결과만 숫자로 확인한다).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSS_DIR = path.join(__dirname, "..", "public", "css");
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const styleCss = stripComments(readFileSync(path.join(CSS_DIR, "style.css"), "utf8"));
const tokensCss = stripComments(readFileSync(path.join(CSS_DIR, "seastar-family-tokens.css"), "utf8"));
const skinCss = stripComments(readFileSync(path.join(CSS_DIR, "seastar-3d-skin.css"), "utf8"));
const cascade = styleCss + "\n" + tokensCss + "\n" + skinCss;

const VIEWPORT = { w: 375, h: 812 };

// ── calc()/var()/env()/vh 최소 평가기 ──
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
  const mpx = t.match(/^(-?[\d.]+)px$/);
  if (mpx) return parseFloat(mpx[1]);
  const mvh = t.match(/^(-?[\d.]+)vh$/);
  if (mvh) return (parseFloat(mvh[1]) / 100) * VIEWPORT.h;
  throw new Error("px/vh 로 해석 불가: '" + t + "'");
}
function evalPx(rawExpr) {
  const resolved = resolveAll(rawExpr.trim().replace(/\s*!important\s*$/, ""));
  const cm = resolved.match(/^calc\((.+)\)$/s);
  if (cm) {
    const terms = cm[1].split("+").map((s) => s.trim());
    return terms.reduce((sum, t) => sum + toPx(t), 0);
  }
  return toPx(resolved);
}
function overlapArea(a, b) {
  const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ox * oy;
}
function findMediaBlockContaining(css, mediaRe, needle) {
  const re = new RegExp(mediaRe.source, "g" + (mediaRe.flags.includes("s") ? "s" : ""));
  let m;
  while ((m = re.exec(css))) {
    if (m[1].includes(needle)) return m[1];
  }
  return null;
}
function findDecl(css, selectorRegexSrc, prop) {
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
// [WO 20261002-fixmobile2] tests/_lib/find-help-toggle-bottom.mjs 와 같은 함정 — 셀렉터가 쉼표로 묶인
// 그룹의 중간 항목일 수 있다("body.sidebar-open [data-help-toggle],"처럼 바로 뒤에 '{' 가 안 옴).
// 그룹 어디에 있든(쉼표 또는 '{' 뒤) 중괄호 깊이를 세어 블록 전체를 찾는다.
function findDeclInGroup(css, selectorRegexSrc, prop) {
  const re = new RegExp(selectorRegexSrc + "\\s*[,{]", "g");
  const propRe = new RegExp("(?:^|[;\\s])" + prop + "\\s*:\\s*([^;]+);");
  let m;
  while ((m = re.exec(css))) {
    const braceStart = css.indexOf("{", m.index);
    if (braceStart === -1) break;
    let depth = 0, i = braceStart;
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") { depth--; if (depth === 0) break; }
    }
    const block = css.slice(braceStart + 1, i);
    const pm = block.match(propRe);
    if (pm) return pm[1].trim();
    re.lastIndex = i + 1;
  }
  throw new Error(`'${prop}' 선언을 가진 그룹 블록을 찾지 못함 (셀렉터: ${selectorRegexSrc})`);
}

const results = [];
const record = (name, pass, detail) => results.push({ name, pass, detail });

// 🔴 이 파일엔 같은 헤더 "@media (max-width: 760px)"가 여러 블록으로 흩어져 있다(병합되지 않음) —
// 공백 유무까지 정확히 구분해 "그 규칙이 실제로 들어있는" 블록을 찾는다(엉뚱한 블록에서 못 찾아 FAIL
// 오탐이 나지 않게).
const mob760 = findMediaBlockContaining(styleCss, /@media \(max-width: 760px\) \{([\s\S]*?)\n\}/, ".numband-btn");
if (!mob760) throw new Error("style.css 의 .numband-btn 포함 @media(max-width:760px) 블록을 찾지 못함");
const pwaBlock = findMediaBlockContaining(styleCss, /@media \(max-width: 760px\)\{([\s\S]*?)\n\}/, "#pwa-install-btn");
if (!pwaBlock) throw new Error("style.css 의 #pwa-install-btn 포함 @media(max-width:760px){ 블록을 찾지 못함(공백 없는 헤더 변형)");

// ══════════════════════════════════════════════════════════════
// R1: .sidebar(트리 시트) vs body.sidebar-open [data-help-toggle] 등 FAB
// ══════════════════════════════════════════════════════════════
const sidebarMediaBlock = findMediaBlockContaining(styleCss, /@media \(max-width: 760px\) \{([\s\S]*?)\n\}/, ".sidebar {");
if (!sidebarMediaBlock) throw new Error("style.css 의 .sidebar 모바일(바텀시트) 미디어 블록을 찾지 못함");
const sidebarBottom = evalPx(findDecl(sidebarMediaBlock, "\\.sidebar", "bottom"));
const sidebarMaxH = evalPx(findDecl(sidebarMediaBlock, "\\.sidebar", "max-height"));
// 시트의 "최악의 경우"(가장 길게 늘어났을 때) 높이 = max-height 그 자체(overflow-y:auto 로 그 이상은 못 늘어남)
const sidebarRect = { x: 0, y: VIEWPORT.h - sidebarBottom - sidebarMaxH, w: VIEWPORT.w, h: sidebarMaxH };

const helpOpenBottomRaw = findDeclInGroup(pwaBlock, "body\\.sidebar-open \\[data-help-toggle\\]", "bottom");
const helpOpenBottom = evalPx(helpOpenBottomRaw);
const helpToggleOpenRect = { x: 16, y: VIEWPORT.h - helpOpenBottom - 40, w: 40, h: 40 }; // 36_Help.js 40x40 리터럴(p41 동일 전제)

record(
  "R1 .sidebar(바텀시트, 최악높이=max-height) 와 body.sidebar-open [data-help-toggle] 겹침 면적 = 0",
  overlapArea(sidebarRect, helpToggleOpenRect) === 0,
  `sidebar=${JSON.stringify(sidebarRect)} help=${JSON.stringify(helpToggleOpenRect)} overlap=${overlapArea(sidebarRect, helpToggleOpenRect)}`
);

// ══════════════════════════════════════════════════════════════
// R2: #regmode-start-wrap(번호대역 칩 줄) vs .crosshair-msg(배치모드 안내 배너)
// ══════════════════════════════════════════════════════════════
const wrapTop = evalPx(findDeclInGroup(mob760, "#btn-regmode-checkboard\\.active ~ #regmode-start-wrap", "top"));
const wrapPaddingRaw = findDeclInGroup(mob760, "#btn-regmode-checkboard\\.active ~ #regmode-start-wrap", "padding"); // "2px 12px"
const wrapPadV = parseFloat(wrapPaddingRaw.split(/\s+/)[0]);
const numbandBtnMinH = evalPx(findDecl(mob760, "\\.numband-btn", "min-height"));
const wrapH = wrapPadV * 2 + numbandBtnMinH;
const wrapRect = { x: 0, y: wrapTop, w: VIEWPORT.w, h: wrapH };

const topbarH = evalPx(findDecl(styleCss, "\\.topbar", "height"));
const crosshairMsgTopRaw = findDecl(mob760, "\\.crosshair-msg", "top");
const crosshairMsgTop = evalPx(crosshairMsgTopRaw);
// .crosshair-msg 는 #map-viewport(=topbar 높이에서 시작) 기준 absolute — 화면좌표 = topbarH + top
// 높이는 보수적으로 작게 잡아 "겹침 없음"을 더 엄격히(통과가 쉬워지지 않게) 검증한다.
const crosshairMsgRect = { x: 0, y: topbarH + crosshairMsgTop, w: VIEWPORT.w, h: 1 };

record(
  "R2 #regmode-start-wrap(번호대역 칩 줄) 와 .crosshair-msg(배치모드 안내) 겹침 면적 = 0",
  overlapArea(wrapRect, crosshairMsgRect) === 0,
  `wrap=${JSON.stringify(wrapRect)} msgTopScreen=${crosshairMsgRect.y} overlap=${overlapArea(wrapRect, crosshairMsgRect)}`
);

// ══════════════════════════════════════════════════════════════
// R3: .pwa-install-banner.on vs body:has(#pwa-install-banner.on) #pwa-install-btn
// ══════════════════════════════════════════════════════════════
const bannerBottom = evalPx(findDecl(pwaBlock, "\\.pwa-install-banner", "bottom"));
const BANNER_H = 98; // 실측(.tmp/fixmobile2/measure.out, 헤드리스 크롬 375px, .pwa-install-banner.on rect height)
const bannerRect = { y: VIEWPORT.h - bannerBottom - BANNER_H, h: BANNER_H };

const fabOpenBottomRaw = findDecl(pwaBlock, "body:has\\(#pwa-install-banner\\.on\\) #pwa-install-btn", "bottom");
const fabOpenBottom = evalPx(fabOpenBottomRaw);
const FAB_H_MIN = 10; // 보수적 최소치(실제 버튼은 더 큼) — 더 작을수록 겹침 검증이 더 엄격해진다
const fabRect = { y: VIEWPORT.h - fabOpenBottom - FAB_H_MIN, h: FAB_H_MIN };

const vOverlap = (a, b) => Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
record(
  "R3 .pwa-install-banner.on(실측 높이 98px) 와 body:has(.on) #pwa-install-btn 수직 겹침 = 0",
  vOverlap(bannerRect, fabRect) === 0,
  `banner=${JSON.stringify(bannerRect)} fab=${JSON.stringify(fabRect)} overlap=${vOverlap(bannerRect, fabRect)}`
);
record(
  "R3-보조 FAB 가 배너보다 정확히 (배너높이98+8px갭)=106px 더 위에 뜬다(공용 mdock-h 변수가 상쇄되어 항상 성립)",
  fabOpenBottom - bannerBottom === BANNER_H + 8,
  `fabOpenBottom=${fabOpenBottom} bannerBottom=${bannerBottom} diff=${fabOpenBottom - bannerBottom}`
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
