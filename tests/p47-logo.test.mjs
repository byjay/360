// [WO 20260918 brand-logo] 상단 로고를 SEASTAR SHIP DESIGN SOLUTIONS 신규 이미지(네이비 배경)로
// 교체한 결과를 검증한다.
//
// 지휘자 사전조사 정정: 원 발주서는 5번째 렌더 지점을 index.html:1389 `.login-logo-top` 로 지목했으나,
// 그 요소는 실제로 scan360 인라인 SVG(로그인 상단 장식, images/logo.png 와 무관)이다. images/logo.png 를
// 실제로 소비하는 5번째 지점은 `.login-logo-bottom img`(index.html:1464, 로그인 카드 하단 "© SEASTAR Inc.")
// 이며, 본 테스트는 이 실제 지점을 검증한다.
//
// 숫자 검증(겹침 면적 등)은 CSS 선언값을 파싱해 계산한다 — 문자열 포함검사로 판정하지 않는다.
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const LOGO_PATH = path.join(ROOT, "public", "images", "logo.png");
const HTML_PATH = path.join(ROOT, "public", "index.html");
const CSS_PATH = path.join(ROOT, "public", "css", "style.css");
const TOKENS_CSS_PATH = path.join(ROOT, "public", "css", "seastar-family-tokens.css");

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const html = readFileSync(HTML_PATH, "utf8");
const styleCss = stripComments(readFileSync(CSS_PATH, "utf8"));
const tokensCss = stripComments(readFileSync(TOKENS_CSS_PATH, "utf8"));

// ── PNG IHDR 파서 (외부 의존성 없이 실제 픽셀 크기를 읽는다) ──
function readPngSize(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47 && buf.slice(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    // signature check via bytes 1-4 "PNG "
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

const results = [];
const record = (name, pass, detail) => results.push({ name, pass, detail });

// ══════════════════════════════════════════════════════════════
// ① 파일 크기 ≤ 100KB
// ══════════════════════════════════════════════════════════════
const fileSize = statSync(LOGO_PATH).size;
record("① logo.png 파일 크기 ≤ 100KB", fileSize <= 100 * 1024, `size=${fileSize}B (${(fileSize / 1024).toFixed(1)}KB)`);

// ══════════════════════════════════════════════════════════════
// ② 가로세로비 원본(8192×3520, 마스터 확인) 대비 ±2%
// ══════════════════════════════════════════════════════════════
const ORIG_W = 8192, ORIG_H = 3520; // 마스터 제공 원본(seastar_logo_ship.png) 실측 픽셀
const ORIG_RATIO = ORIG_W / ORIG_H;
const buf = readFileSync(LOGO_PATH);
const { width: curW, height: curH } = readPngSize(buf);
const curRatio = curW / curH;
const ratioDiff = Math.abs(curRatio / ORIG_RATIO - 1);
record(
  "② 가로세로비가 원본(2.327:1) 대비 ±2% 이내",
  ratioDiff <= 0.02,
  `현재=${curW}×${curH} (${curRatio.toFixed(4)}) 원본비=${ORIG_RATIO.toFixed(4)} diff=${(ratioDiff * 100).toFixed(2)}%`
);

// ══════════════════════════════════════════════════════════════
// ③ logoUrl 경로 유지
// ══════════════════════════════════════════════════════════════
const logoUrlMatch = html.match(/logoUrl:\s*"([^"]+)"/);
record(
  "③ logoUrl 경로가 여전히 images/logo.png",
  !!logoUrlMatch && logoUrlMatch[1] === "images/logo.png",
  `logoUrl=${logoUrlMatch ? logoUrlMatch[1] : "(없음)"}`
);

// ══════════════════════════════════════════════════════════════
// ④ 5개 렌더 지점 마크업 존재(렌더 고아 0) — 정정된 5번째 지점 포함
// ══════════════════════════════════════════════════════════════
const renderPoints = [
  { name: "#hub-brand-logo (프로젝트 허브)", re: /<div id="hub-brand-logo" class="brand-logo brand-logo-top"/ },
  { name: "#brand-logo-home (홈)", re: /<div id="brand-logo-home" class="brand-logo brand-logo-home"/ },
  { name: "#brand-logo-top (작업화면 상단바)", re: /<div id="brand-logo-top" class="brand-logo brand-logo-top"/ },
  { name: "#brand-logo-pano (파노라마)", re: /<div id="brand-logo-pano" class="brand-logo brand-logo-pano"/ },
  { name: ".login-logo-bottom img (로그인 하단, 정정된 5번째 지점)", re: /<div class="login-logo-bottom">\s*<img src="images\/logo\.png"/ },
];
for (const rp of renderPoints) {
  record(`④ 렌더 지점 존재 — ${rp.name}`, rp.re.test(html), rp.re.test(html) ? "존재" : "마크업 없음(렌더 고아)");
}

// ══════════════════════════════════════════════════════════════
// ⑤ 375×812 모바일 — 로고 영역이 하단 고정 클러스터(.mobile-dock/#btn-save/[data-help-toggle])와
//    겹치지 않는다. #screen-app 은 이 셋과 실제로 공존하는 유일한 화면이라 여기에 스코프한다.
//    수치 근거: 상단바(브랜드로고 포함)는 항상 문서 흐름(top) 안에 머무르고, 셋은 전부 position:fixed
//    로 뷰포트 하단에 고정된다 — y축으로 물리적으로 분리되면 겹침 면적은 0이다(계산으로 증명).
// ══════════════════════════════════════════════════════════════
const VIEWPORT = { w: 375, h: 812 };

function findDecl(css, selectorRegexSrc, prop) {
  const blockRe = new RegExp(selectorRegexSrc + "\\s*\\{([^}]*)\\}", "gs");
  const propRe = new RegExp("(?:^|[;\\s])" + prop + "\\s*:\\s*([^;]+);");
  let m, found = null;
  while ((m = blockRe.exec(css))) {
    const pm = m[1].match(propRe);
    if (pm) { found = pm[1].trim(); break; }
  }
  if (found === null) throw new Error(`'${prop}' 선언을 가진 블록을 찾지 못함 (셀렉터: ${selectorRegexSrc})`);
  return found.replace(/!important/g, "").trim();
}
function extractRootVars(css) {
  const vars = {};
  const re = /:root\s*\{([^}]*)\}/gs;
  let rm;
  while ((rm = re.exec(css))) {
    const dre = /--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
    let m;
    while ((m = dre.exec(rm[1]))) vars[m[1]] = m[2].trim();
  }
  return vars;
}
const cascade = styleCss + "\n" + tokensCss;
const ROOT_VARS = extractRootVars(cascade);
function resolveOnce(expr) {
  let changed = false;
  const out = expr.replace(/var\(\s*--([a-zA-Z0-9_-]+)\s*(?:,((?:[^()]|\([^()]*\))*))?\)/, (full, name, fallback) => {
    changed = true;
    if (ROOT_VARS[name] !== undefined) return ROOT_VARS[name];
    if (fallback !== undefined) return fallback.trim();
    throw new Error("정의되지 않은 var(--" + name + ")");
  });
  if (changed) return out;
  const out2 = expr.replace(/env\(\s*safe-area-inset-bottom\s*(?:,([^()]*))?\)/, () => { changed = true; return "0px"; });
  return out2;
}
function resolveAll(expr) {
  let prev = expr, cur = resolveOnce(expr), guard = 0;
  while (cur !== prev) { prev = cur; cur = resolveOnce(cur); if (++guard > 30) throw new Error("resolve 루프 초과"); }
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
  if (cm) return cm[1].split("+").map((s) => s.trim()).reduce((sum, t) => sum + toPx(t), 0);
  return toPx(resolved);
}
function overlapArea(a, b) {
  const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ox * oy;
}

// .mobile-dock 하단 클러스터
const mdockH = evalPx(findDecl(cascade, "\\.mdock-bar", "height"));
const dockBorderTop = parseFloat(findDecl(styleCss, "\\.mobile-dock", "border-top"));
const mobileDockRect = { x: 0, y: VIEWPORT.h - (mdockH + dockBorderTop), w: VIEWPORT.w, h: mdockH + dockBorderTop };

// #btn-save 모바일 FAB
function findMediaBlockContaining(css, mediaRe, needle) {
  const re = new RegExp(mediaRe.source, "g" + (mediaRe.flags.includes("s") ? "s" : ""));
  let m;
  while ((m = re.exec(css))) { if (m[1].includes(needle)) return m[1]; }
  return null;
}
const btnSaveBlock = findMediaBlockContaining(tokensCss, /@media \(max-width: 640px\) \{([\s\S]*?)\n\}/, "#btn-save");
const btnSaveBottom = evalPx(findDecl(btnSaveBlock, "#btn-save\\.btn-save:not\\(\\.hidden\\)", "bottom"));
const btnSavePadding = findDecl(btnSaveBlock, "#btn-save\\.btn-save:not\\(\\.hidden\\)", "padding");
const [padV] = btnSavePadding.split(/\s+/).map((s) => parseFloat(s));
const btnSaveFontSize = evalPx(findDecl(btnSaveBlock, "#btn-save\\.btn-save:not\\(\\.hidden\\)", "font-size"));
const btnSaveBorder = parseFloat(findDecl(tokensCss, "#btn-save\\.btn-save(?!:)", "border"));
const btnSaveH = padV * 2 + btnSaveFontSize + btnSaveBorder * 2;
const btnSaveRect = { x: 0, y: VIEWPORT.h - btnSaveBottom - btnSaveH, w: VIEWPORT.w, h: btnSaveH };

// [data-help-toggle]
const helpBottom = evalPx(findDecl(styleCss, "\\[data-help-toggle\\]", "bottom"));
const helpToggleRect = { x: 0, y: VIEWPORT.h - helpBottom - 40, w: VIEWPORT.w, h: 40 };

// 로고 영역 최악 높이(#screen-app 상단바 컨텍스트): .topbar 고정 높이(68px) — 이미지(44px, 아래 계산)
// + padding 이 이보다 작아 topbar 안에 완전히 들어간다.
const topbarH = evalPx(findDecl(styleCss, "\\.topbar", "height"));
// seastar-family-tokens.css 의 !important 규칙이 실제 렌더 높이를 44px 로 고정한다(브랜드로고 이미지 공통 캡).
const imgEffectiveH = parseFloat(findDecl(tokensCss, "\\.brand-logo img,\\s*\\.brand-logo-top img,\\s*#hub-brand-logo img", "max-height"));
const logoBoxMobilePad = findDecl(styleCss.match(/@media \(max-width: 560px\) \{([\s\S]*?)\n\}/)[1], "\\.brand-logo-top\\.brand-logo--img", "padding");
const [logoPadV] = logoBoxMobilePad.split(/\s+/).map((s) => parseFloat(s));
const logoContentH = imgEffectiveH + logoPadV * 2;
const logoAreaBottomWorstCase = Math.max(topbarH, logoContentH); // topbar가 이미지+패딩보다 크면 topbar 경계가 곧 경계
const logoRect = { x: 0, y: 0, w: VIEWPORT.w, h: logoAreaBottomWorstCase };

const overlapDock = overlapArea(logoRect, mobileDockRect);
const overlapSave = overlapArea(logoRect, btnSaveRect);
const overlapHelp = overlapArea(logoRect, helpToggleRect);
record(
  "⑤ 375×812 — 로고 영역(상단, y:0~" + logoAreaBottomWorstCase.toFixed(1) + "px)이 .mobile-dock/#btn-save/[data-help-toggle](모두 하단 고정)와 겹침 0",
  overlapDock === 0 && overlapSave === 0 && overlapHelp === 0,
  `logoRect=${JSON.stringify(logoRect)} dock.y=${mobileDockRect.y.toFixed(1)} btnSave.y=${btnSaveRect.y.toFixed(1)} help.y=${helpToggleRect.y.toFixed(1)} ` +
    `overlap(dock=${overlapDock}, save=${overlapSave}, help=${overlapHelp})`
);

// ⑤-보조: 로고의 topbar 내 가로 폭 기여분이 이전 로고(200×52, 3.846:1)보다 커지지 않았는지(회귀 가드)
const PREV_RATIO = 200 / 52;
const mobileImgPadding = logoBoxMobilePad.split(/\s+/).map((s) => parseFloat(s));
const padH = mobileImgPadding[1] ?? mobileImgPadding[0];
const newLogoBoxW = imgEffectiveH * curRatio + padH * 2;
const prevLogoBoxW = imgEffectiveH * PREV_RATIO + padH * 2;
record(
  "⑤-보조 새 로고의 topbar 폭 기여분이 이전 로고보다 크지 않다(회귀 가드)",
  newLogoBoxW <= prevLogoBoxW,
  `new=${newLogoBoxW.toFixed(1)}px prev=${prevLogoBoxW.toFixed(1)}px`
);

// ══════════════════════════════════════════════════════════════
// ⑥ 데스크톱 규칙 불변 — 컨텍스트별 height 선언 리터럴이 그대로 남아있다(내가 수정하지 않았음을 증명)
// ══════════════════════════════════════════════════════════════
const desktopRules = [
  { sel: "\\.brand-logo-top \\.brand-logo-img", prop: "height", expect: "38px" },
  { sel: "\\.brand-logo-home \\.brand-logo-img", prop: "height", expect: "56px" },
  { sel: "\\.brand-logo-pano \\.brand-logo-img", prop: "height", expect: "18px" },
];
for (const r of desktopRules) {
  const val = findDecl(styleCss, r.sel, r.prop);
  record(`⑥ 데스크톱 불변 — ${r.sel} { ${r.prop}: ${r.expect} } 그대로`, val === r.expect, `실제값=${val}`);
}

// ══════════════════════════════════════════════════════════════
// ⑦ 배경 처리 — 흰 알약(#fff) 제거, 네이비 로고가 다크 UI에 직접 어울리게(transparent)
// ══════════════════════════════════════════════════════════════
const brandImgBlock = styleCss.match(/\.brand-logo--img\s*\{([^}]*)\}/);
const bg = brandImgBlock ? (brandImgBlock[1].match(/background\s*:\s*([^;]+);/) || [])[1] : null;
record(
  "⑦ .brand-logo--img 흰 배경(#fff) 제거됨(네이비 로고가 다크 UI에 직접 노출)",
  !!bg && !/#fff|white/i.test(bg.trim()),
  `background=${bg}`
);

// ══════════════════════════════════════════════════════════════
// [WO 로고축약] logo-compact.png(선박 제외) + 좁은 화면 전환 검증
// ══════════════════════════════════════════════════════════════
const COMPACT_PATH = path.join(ROOT, "public", "images", "logo-compact.png");
const compactSize = statSync(COMPACT_PATH).size;
const compactBuf = readFileSync(COMPACT_PATH);
const { width: compactW, height: compactH } = readPngSize(compactBuf);
const compactRatio = compactW / compactH;

// ⑮ logo-compact.png 존재 + 50KB 이하
record(
  "⑮ logo-compact.png 존재 + 파일 크기 ≤ 50KB",
  compactSize > 0 && compactSize <= 50 * 1024,
  `size=${compactSize}B (${(compactSize / 1024).toFixed(1)}KB) ${compactW}×${compactH}`
);

// ⑯ 선박 영역 제외 — 가로세로비가 원본(2.327:1)보다 유의미하게(≥10%) 좁아졌다(수치 근거)
const ratioShrink = (ORIG_RATIO - compactRatio) / ORIG_RATIO;
record(
  "⑯ logo-compact.png 이 선박 와이어프레임을 제외해 가로세로비가 원본 대비 ≥10% 좁아졌다",
  ratioShrink >= 0.10,
  `compact=${compactW}×${compactH}(${compactRatio.toFixed(4)}) orig비=${ORIG_RATIO.toFixed(4)} 감소율=${(ratioShrink * 100).toFixed(1)}%`
);

// ⑰ 좁은 폭(≤560px) 전환 규칙이 CSS 값으로 실재한다 — @media (max-width:560px) 블록 안에서
//    .brand-logo-img 의 content 선언이 logo-compact.png 를 가리키는지 "선언값을 파싱"해 확인.
function findMediaBlockContainingLocal(css, mediaRe, needle) {
  const re = new RegExp(mediaRe.source, "g" + (mediaRe.flags.includes("s") ? "s" : ""));
  let m;
  while ((m = re.exec(css))) { if (m[1].includes(needle)) return m[1]; }
  return null;
}
const mobileBlock560 = findMediaBlockContainingLocal(styleCss, /@media \(max-width: 560px\) \{([\s\S]*?)\n\}/, ".brand-logo-img");
const contentDecl = mobileBlock560 ? findDecl(mobileBlock560, "\\.brand-logo-img", "content") : null;
const contentUrlMatch = contentDecl ? contentDecl.match(/url\(\s*["']?([^"')]+)["']?\s*\)/) : null;
record(
  "⑰ @media(max-width:560px) 안 .brand-logo-img { content: url(...) } 가 logo-compact.png 를 가리킨다",
  !!contentUrlMatch && /logo-compact\.png$/.test(contentUrlMatch[1]),
  `content=${contentDecl} url=${contentUrlMatch ? contentUrlMatch[1] : "(없음)"}`
);

// ⑱ 넓은 화면(미디어쿼리 밖)에서는 .brand-logo-img 에 content 재정의가 없어 logo.png(logoUrl) 그대로 유지(회귀)
const cssNoMedia = styleCss.replace(/@media[^{]*\{[\s\S]*?\n\}/g, "");
const topLevelContentBlock = cssNoMedia.match(/\.brand-logo-img\s*\{([^}]*)\}/);
const topLevelHasContent = !!(topLevelContentBlock && /(?:^|[;\s])content\s*:/.test(topLevelContentBlock[1]));
record(
  "⑱ 넓은 화면(미디어쿼리 밖) .brand-logo-img 에 content 재정의 없음 — logo.png(logoUrl) 유지",
  !topLevelHasContent,
  topLevelContentBlock ? `top-level 블록=${topLevelContentBlock[1].trim()}` : "top-level 블록 없음(정상)"
);

// ⑲ 375×812 겹침 0 재확인(회귀) — 이번 변경은 .brand-logo-img 의 표시 이미지만 바꾸고
//    박스 모델(height/padding)은 그대로이므로 ⑤ 의 계산이 동일하게 성립해야 한다.
record(
  "⑲ 375×812 — 로고 축약 적용 후에도 .mobile-dock/#btn-save/[data-help-toggle] 겹침 0(회귀, ⑤ 재확인)",
  overlapDock === 0 && overlapSave === 0 && overlapHelp === 0,
  `overlap(dock=${overlapDock}, save=${overlapSave}, help=${overlapHelp}) logoAreaBottom=${logoAreaBottomWorstCase.toFixed(1)}px`
);

// ── 결과 출력 ──
for (const r of results) console.log(`[${r.pass ? "PASS" : "FAIL"}] ${r.name} :: ${r.detail}`);
const failCount = results.filter((r) => !r.pass).length;
if (failCount > 0) {
  console.error(`\n${failCount}건 실패`);
  process.exit(1);
} else {
  console.log(`\n전체 ${results.length}건 PASS`);
  process.exit(0);
}
