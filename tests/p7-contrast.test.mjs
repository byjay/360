/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p7-contrast.test.mjs)
 *
 * 대상: public/css/style.css — #photobatch-modal(.admin-gate 재사용) 대비 위반 수정
 *  ① .pb-table thead th — 표 머리글(핀번호/파일명/촬영시각/…): 크림 배경 위 고정 글자색
 *  ② .admin-gate-btn.primary — 사진폴더 선택/일괄등록 실행 버튼(반투명 골드 배경 위 골드 글자)
 *  ③ 구조적 안티패턴 스캐너 — "배경은 리터럴 hex 고정, 글자색은 var(--text*) 테마 변수"
 *     조합을 전체 스타일시트에서 찾아 0건이어야 한다.
 *
 *     근본원인(2026-09-03 프로덕션 실측, coordinator 재작업 지시):
 *     이 앱은 인앱 다크테마 토글이 없다(--text 는 :root 에 단 1회만 선언됨, JS 도 건드리지 않음).
 *     그런데도 프로덕션에서 .pb-table thead th 의 실측 color 가 var(--text)=#2b2820 이 아니라
 *     rgb(233,234,238)(거의 흰색)로 나왔다 — background(#e9e2d2, 실측과 정확히 일치)는 그대로였다.
 *     원인은 OS/브라우저의 강제 다크모드(forced/auto dark)가 "고정 배경은 그대로 두고 var() 기반
 *     텍스트만 밝게 재해석"하는 유형이기 때문(이 코드베이스에 이미 선례 있음 —
 *     .company-gate-card 의 `color-scheme: light` 버그수정 주석 참조).
 *     즉 숫자 대비비 계산만으로는 "소스상 라이트 값 기준"만 보고 통과 판정을 내려 이 결함을
 *     놓친다(실제 1차 작업에서 오탐으로 결론지었던 원인). 그래서 이 스캐너는 대비비가 아니라
 *     **패턴 자체**("고정 배경 + 테마변수 글자")를 위반으로 잡는다 — 값에 의존하지 않으므로
 *     현재 값이 얼마든, 미래에 실제 다크테마가 도입되든 항상 유효하다.
 *
 *  ④ .wm-toast — 하단 토스트 알림. 2차 실사고(2026-09-03, coordinator 재작업 지시):
 *     ①~③ 스캐너는 public/css/style.css **한 파일만** 봤다. 그런데 실제 로드 순서
 *     (public/index.html 의 <link> 순서)는 style.css → seastar-family-tokens.css →
 *     seastar-3d-skin.css 세 파일이고, family-tokens.css:284 에 `.wm-toast { color:
 *     #11141a !important; }` 가 있었다 — style.css 의 `color:#f4f6fb`(비-important)를
 *     항상 이겨 실제 배포본은 검정 글자였다. style.css 만 보는 스캐너는 이 클래스의
 *     실사고를 **원리적으로 못 잡는다**(다른 파일의 override 자체를 모른다).
 *     그래서 ④는 index.html 의 <link rel="stylesheet"> 순서에서 로컬 CSS 파일 목록을
 *     "파생"하고(손목록 금지, §10), 그 순서대로 전부 파싱해 같은 선택자에 대해
 *     "!important 가 비-important 를 이기고, 같은 중요도면 나중 파일이 이긴다"는
 *     캐스케이드로 최종 color/background 를 정한 뒤 그라디언트 색 스톱 위 대비를 계산한다.
 *     [ponytail] 이건 완전한 CSS 특이도(specificity) 엔진이 아니다 — "정확히 같은 선택자
 *     문자열"에 대해서만 캐스케이드를 푼다(가상클래스·베이스클래스 간 특이도 비교, 즉
 *     `.btn:hover`와 `.btn` 이 같은 요소에 동시 적용될 때의 우선순위는 다루지 않는다).
 *     .wm-toast 는 두 파일 모두 단일 클래스 선택자라 이 단순화로 충분하며, 실측으로
 *     확인했다(감사 스크립트로 전체 프로젝트를 스캔한 결과 `:hover`/`.active` 조합 선택자는
 *     오탐이 났다 — 업그레이드 경로: 필요해지면 실제 특이도 계산을 추가한다).
 *
 * 하드코딩 금지(§10): 기대 색상을 손으로 나열하지 않는다 — CSS 를 파싱해 :root 커스텀
 * 프로퍼티(3개 파일 모두 병합, 나중 파일이 이김 — seastar-3d-skin.css 의 :root 가 --text 등을
 * 다크 값으로 리맵함을 실측 확인) + 해당 규칙의 color/background 를 그대로 읽어 계산한다.
 * 새로 추가되는 색도 이 파서가 그대로 재계산하므로, 값이 바뀌면 이 테스트도 같이 재검증한다.
 *
 * 뮤테이션 증명: color 를 옛 값(var(--gold)/var(--text) 등 테마 변수, 또는 .wm-toast 의 경우
 * family-tokens.css 에 `.wm-toast { color: #11141a !important; }` 재삽입)으로 되돌리면
 * FAIL 해야 한다.
 * (수동 확인 절차는 커밋 메시지에 EXIT 코드로 기록)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ""); // 주석 제거 — 뒤 선언이 "직전 ; 없음"으로 오매칭되는 것 방지
const readCss = (relPath) => stripComments(fs.readFileSync(path.join(ROOT, relPath), "utf8").replace(/\r\n/g, "\n"));

const css = readCss("public/css/style.css");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── ④ 전용: 로드 순서 CSS 파일 목록 — public/index.html <link> 에서 파생(손목록 금지) ── */
function localStylesheetsInLoadOrder() {
  const html = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
  const re = /<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g;
  const out = [];
  let mm;
  while ((mm = re.exec(html))) {
    const href = mm[1];
    if (/^https?:/.test(href)) continue; // CDN 폰트/아이콘 제외 — 로컬 캐스케이드만 다룬다
    out.push("public/" + href.replace(/^\.?\/?/, ""));
  }
  return out;
}
const CSS_FILES = localStylesheetsInLoadOrder();

/* ── :root 커스텀 프로퍼티 맵 — CSS_FILES 전부를 로드 순서대로 병합(나중 파일이 이김) ──
 * (①~③은 기존과 동일하게 style.css 단일 스코프로 두되, var() 해석용 ROOT_VARS 는
 *  3파일 병합값을 쓴다 — --gold-ink 등 ①~③이 참조하는 변수는 다른 파일에서 재정의되지
 *  않음을 실측 확인했으므로 회귀 없음, 병합은 ④의 정확한 색 해석을 위해 필요하다.) */
function parseRootVarsMerged(fileList) {
  const map = {};
  for (const f of fileList) {
    const txt = readCss(f);
    const re = /:root\s*\{([^}]*)\}/g;
    let mm;
    while ((mm = re.exec(txt))) {
      const declRe = /(--[\w-]+)\s*:\s*([^;]+);/g;
      let x;
      while ((x = declRe.exec(mm[1]))) map[x[1].trim()] = x[2].trim();
    }
  }
  return map;
}
const ROOT_VARS = parseRootVarsMerged(CSS_FILES);

/* ── 색 표현식 → [r,g,b,a] 파싱 (hex / rgb() / rgba() / var(--x[,fallback]) 재귀 해석) ── */
function parseColor(expr, depth = 0) {
  if (!expr || depth > 8) return null;
  expr = expr.trim();
  const varM = expr.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/);
  if (varM) {
    const name = varM[1];
    const resolved = ROOT_VARS[name];
    if (resolved) return parseColor(resolved, depth + 1);
    if (varM[2]) return parseColor(varM[2], depth + 1);
    return null;
  }
  const hexM = expr.match(/^#([0-9a-fA-F]{3,8})$/);
  if (hexM) {
    let h = hexM[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [r, g, b, a];
  }
  const rgbM = expr.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\)$/);
  if (rgbM) return [+rgbM[1], +rgbM[2], +rgbM[3], rgbM[4] !== undefined ? +rgbM[4] : 1];
  return null;
}

/* ── 선택자의 선언 블록에서 특정 프로퍼티 값 추출(첫 매치, ponytail: 이 CSS엔 중복 선택자 없음 확인됨) ── */
function getDecl(cssText, selector, prop) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped.replace(/\\ /g, "\\s+") + "\\s*\\{([^}]*)\\}");
  const m = cssText.match(re);
  if (!m) return null;
  const body = m[1];
  const propRe = new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+);");
  const pm = body.match(propRe);
  return pm ? pm[1].trim() : null;
}

/* ── WCAG 2.1 상대휘도 + 대비비 ── */
function relLum([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(rgbA, rgbB) {
  const L1 = relLum(rgbA), L2 = relLum(rgbB);
  const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
}
/* 반투명 전경을 배경 위에 합성(alpha compositing) */
function composite(fgRgba, bgRgb) {
  const [r, g, b, a] = fgRgba;
  if (a >= 1) return [r, g, b];
  return [r * a + bgRgb[0] * (1 - a), g * a + bgRgb[1] * (1 - a), b * a + bgRgb[2] * (1 - a)];
}

/* ── .admin-gate-card 배경(linear-gradient 두 스톱) — pb-warn/버튼 등이 그 위에 얹힌다 ── */
function cardBgStops(cssText) {
  const bg = getDecl(cssText, ".admin-gate-card", "background");
  const m = bg && bg.match(/#([0-9a-fA-F]{6})\s*,\s*#([0-9a-fA-F]{6})/);
  if (!m) throw new Error("admin-gate-card gradient stop 파싱 실패 — CSS 구조 변경됨?");
  return [parseColor("#" + m[1]), parseColor("#" + m[2])];
}
const [CARD_STOP_A, CARD_STOP_B] = cardBgStops(css);

/* ── 범용 그라디언트 색 스톱 추출(hex/rgb()/rgba() 토큰을 순서대로 전부 뽑는다) ──
 * linear-gradient(165deg, rgba(13,20,37,.98), rgba(10,16,32,.99)) 같은 표현식에서
 * 각도·키워드는 무시하고 색 토큰만 parseColor 로 해석해 배열로 반환한다. */
function genericGradientStops(gradientExpr) {
  if (!gradientExpr) return [];
  const re = /rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}\b/g;
  const out = [];
  let mm;
  while ((mm = re.exec(gradientExpr))) {
    const c = parseColor(mm[0]);
    if (c) out.push(c);
  }
  return out;
}

/* ── ④ 전용 다중파일 캐스케이드 리졸버 ──────────────────────────────────────
 * CSS_FILES 를 로드 순서대로 파싱해 "선택자 문자열이 정확히 일치"하는 모든 규칙에서
 * 지정 프로퍼티 선언을 모으고: !important 가 있으면 그 그룹만, 그 안에서 (파일 순서,
 * 파일 내 등장 순서) 가 가장 나중인 선언이 최종 승자다. 콤마로 묶인 선택자 목록
 * (`a, b, c { ... }`)은 개별 선택자로 분해해 취급한다. */
function parseAllRulesTagged(fileList) {
  const all = [];
  fileList.forEach((f, fileIdx) => {
    const txt = readCss(f);
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let mm, order = 0;
    while ((mm = ruleRe.exec(txt))) {
      const selectors = mm[1].split(",").map((s) => s.trim()).filter(Boolean);
      const body = mm[2];
      for (const sel of selectors) all.push({ sel, body, fileIdx, order: order++, file: f });
    }
  });
  return all;
}
const ALL_RULES = parseAllRulesTagged(CSS_FILES);

function getPropFromBody(body, prop) {
  const re = new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+);", "i");
  const mm = body.match(re);
  if (!mm) return null;
  const val = mm[1].trim();
  const important = /!important\s*$/i.test(val);
  return { value: val.replace(/!important\s*$/i, "").trim(), important, raw: val };
}

/** 3파일 캐스케이드로 선택자의 최종 프로퍼티 값을 구한다. 없으면 null. */
function resolveCascade(selector, prop) {
  const candidates = ALL_RULES
    .filter((r) => r.sel === selector)
    .map((r) => ({ ...r, decl: getPropFromBody(r.body, prop) }))
    .filter((r) => r.decl);
  if (!candidates.length) return null;
  const important = candidates.filter((c) => c.decl.important);
  const pool = important.length ? important : candidates;
  pool.sort((a, b) => (a.fileIdx - b.fileIdx) || (a.order - b.order));
  const winner = pool[pool.length - 1];
  return { value: winner.decl.value, important: winner.decl.important, file: winner.file };
}

const WCAG_AA_SMALL = 4.5;

/* ══ ① .pb-table thead th — 표 머리글 ══════════════════════════════════ */
{
  const bgExpr = getDecl(css, ".pb-table thead th", "background");
  const colorExpr = getDecl(css, ".pb-table thead th", "color");
  ok(bgExpr && colorExpr, "① CSS 규칙 파싱 성공 (.pb-table thead th)");
  const bg = parseColor(bgExpr);
  const fg = parseColor(colorExpr);
  ok(!!bg && !!fg, "① 색상 파싱 성공 — bg=" + bgExpr + " color=" + colorExpr);
  const ratio = contrast(fg.slice(0, 3), bg.slice(0, 3));
  ok(ratio >= WCAG_AA_SMALL, `① 표 머리글 대비 ${ratio.toFixed(2)}:1 ≥ ${WCAG_AA_SMALL}:1 (fg=${colorExpr} bg=${bgExpr})`);
}

/* ══ ② .admin-gate-btn.primary — 사진폴더 선택/일괄등록 실행 버튼 ══════════ */
{
  const bgExpr = getDecl(css, ".admin-gate-btn.primary", "background");
  const colorExpr = getDecl(css, ".admin-gate-btn.primary", "color");
  ok(bgExpr && colorExpr, "② CSS 규칙 파싱 성공 (.admin-gate-btn.primary)");
  const fgRgba = parseColor(colorExpr);
  const btnBgRgba = parseColor(bgExpr);
  ok(!!fgRgba && !!btnBgRgba, "② 색상 파싱 성공 — bg=" + bgExpr + " color=" + colorExpr);
  // 버튼은 .admin-gate-card(그라디언트) 위에 얹히므로, 두 스톱 각각을 조상 배경 삼아
  // alpha 합성한 뒤 "더 나쁜(=대비가 더 낮은)" 쪽으로 판정한다.
  const ratios = [CARD_STOP_A, CARD_STOP_B].map((stop) => {
    const compositedBg = composite(btnBgRgba, stop.slice(0, 3));
    return contrast(fgRgba.slice(0, 3), compositedBg);
  });
  const worst = Math.min(...ratios);
  ok(worst >= WCAG_AA_SMALL, `② 버튼 글자 대비(최악 스톱 기준) ${worst.toFixed(2)}:1 ≥ ${WCAG_AA_SMALL}:1 (fg=${colorExpr} bg=${bgExpr} on card gradient)`);
}

/* ══ ③ 구조적 안티패턴 스캐너 — 고정 리터럴 배경 + var(--text*) 글자색 ══════════ */
{
  // 전체 규칙(선택자 { 선언들 })을 순회하며 "background(-color) 가 리터럴 hex/rgb(불투명)"
  // 이면서 "color 가 var(--text[2 등]) 그대로"인 규칙을 찾는다. rgba()로 투명도가 있는
  // 배경은 조상색과 섞이므로(§②에서 별도 처리) 이 스캐너 대상에서 제외한다.
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  const violations = [];
  let m;
  while ((m = ruleRe.exec(css))) {
    const selector = m[1].trim();
    const body = m[2];
    if (!selector || selector.startsWith("@") || selector === ":root") continue;
    const bgM = body.match(/background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,8}|rgb\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*\)|white)\s*;/i);
    const colorM = body.match(/(?:^|;)\s*color\s*:\s*(var\(--text[\w-]*\))\s*;/);
    if (bgM && colorM) violations.push(`${selector} (bg=${bgM[1]}, color=${colorM[1]})`);
  }
  ok(violations.length === 0,
    violations.length === 0
      ? "③ 고정배경+테마변수글자 안티패턴 0건"
      : `③ 고정배경+테마변수글자 안티패턴 ${violations.length}건 발견: ${violations.join(" | ")}`);
}

/* ══ ④ .wm-toast — 3파일 캐스케이드로 해석한 그라디언트 배경 위 토스트 글자색 ══════ */
{
  ok(CSS_FILES.length >= 3, `④ index.html 에서 로컬 스타일시트 ${CSS_FILES.length}개 파생됨: ${CSS_FILES.join(", ")}`);
  const colorR = resolveCascade(".wm-toast", "color");
  const bgR = resolveCascade(".wm-toast", "background");
  ok(!!colorR && !!bgR, `④ 캐스케이드 해석 성공 — color=${colorR && colorR.value}(from ${colorR && colorR.file}) bg=${bgR && bgR.value}(from ${bgR && bgR.file})`);
  const stops = genericGradientStops(bgR.value);
  ok(stops.length >= 2, `④ 그라디언트 색 스톱 ${stops.length}개 파싱됨 (bg=${bgR.value})`);
  const fgRgba = parseColor(colorR.value);
  ok(!!fgRgba, "④ 글자색 파싱 성공 — color=" + colorR.value);
  // 토스트 호스트는 document.body 위에 fixed 로 얹히므로, 조상(ambient) 배경은 body 의
  // 실제 배경(var(--bg))이다. 각 그라디언트 스톱을 그 위에 alpha 합성한 뒤(스톱 alpha가
  // .98~.99라 조상색 영향은 작지만, 값에 의존하지 않고 항상 계산한다) 대비를 구해
  // 가장 나쁜(최소) 값으로 판정한다.
  const ambientBg = parseColor("var(--bg)");
  ok(!!ambientBg, "④ 조상 배경(var(--bg)) 파싱 성공");
  const ratios = stops.map((stop) => {
    const compositedBg = composite(stop, ambientBg.slice(0, 3));
    return contrast(fgRgba.slice(0, 3), compositedBg);
  });
  const worst = Math.min(...ratios);
  ok(worst >= WCAG_AA_SMALL, `④ 토스트 글자 대비(3파일 캐스케이드·최악 스톱 기준) ${worst.toFixed(2)}:1 ≥ ${WCAG_AA_SMALL}:1 (fg=${colorR.value} from ${colorR.file}; bg=${bgR.value} from ${bgR.file})`);
}

/* ══ ⑤~⑦ 2026-09-03 감사 3건 — 공통 뿌리: 배경은 고정색으로 정하고 글자색은 var()에
 * 맡기거나("밝을 것") 반대로 var() 배경 위에 "밝은 표면일 것"이라는 틀린 전제로 어두운
 * 고정 글자색을 박은 패턴. ④ 와 동일하게 3파일 캐스케이드로 최종 선언을 구한다(손목록
 * 금지 §10 — 기대값을 여기 하드코딩하지 않고 CSS 를 읽어 계산). */

/* ══ ⑤ .access-cancel:hover / .btn-demo-viewer:hover / .btn-signout:hover ══════════
 * family-tokens.css 가 크림 배경+골드브라운 글자 hover 를 정의하는데, 과거
 * seastar-3d-skin.css 의 "다크 글로시" :hover 그룹이 같은 3개 선택자를 포함해
 * color:var(--text) !important 로 이겼었다(나중 파일 승). 지금은 그 그룹에서 3개가
 * 제외되어 family-tokens.css 규칙만 남아야 한다 — 재추가되면 이 테스트가 잡는다. */
{
  const sels = [".access-cancel:hover", ".btn-demo-viewer:hover", ".btn-signout:hover"];
  const ratios = sels.map((sel) => {
    const colorR = resolveCascade(sel, "color");
    const bgR = resolveCascade(sel, "background");
    ok(!!colorR && !!bgR, `⑤ ${sel} 캐스케이드 해석 성공 — color=${colorR && colorR.value}(${colorR && colorR.file}) bg=${bgR && bgR.value}(${bgR && bgR.file})`);
    const fg = parseColor(colorR.value);
    const stops = genericGradientStops(bgR.value);
    ok(!!fg && stops.length >= 1, `⑤ ${sel} 색 파싱 성공`);
    const worst = Math.min(...stops.map((s) => contrast(fg.slice(0, 3), s)));
    return { sel, worst, colorR, bgR };
  });
  for (const r of ratios) {
    ok(r.worst >= WCAG_AA_SMALL, `⑤ ${r.sel} 대비(최악 스톱) ${r.worst.toFixed(2)}:1 ≥ ${WCAG_AA_SMALL}:1 (fg=${r.colorR.value} from ${r.colorR.file}; bg=${r.bgR.value} from ${r.bgR.file})`);
  }
}

/* ══ ⑥ .allpins-sort-btn — style.css 의 background:var(--bg) 위에 family-tokens.css 가
 * !important 로 얹는 글자색. var(--bg) 는 seastar-3d-skin.css 가 항상 다크로 리맵한다. ══ */
{
  const colorR = resolveCascade(".allpins-sort-btn", "color");
  const bgR = resolveCascade(".allpins-sort-btn", "background");
  ok(!!colorR && !!bgR, `⑥ 캐스케이드 해석 성공 — color=${colorR && colorR.value}(${colorR && colorR.file}) bg=${bgR && bgR.value}(${bgR && bgR.file})`);
  const fg = parseColor(colorR.value);
  const bg = parseColor(bgR.value);
  ok(!!fg && !!bg, `⑥ 색 파싱 성공 — fg=${colorR.value} bg=${bgR.value}`);
  const ratio = contrast(fg.slice(0, 3), bg.slice(0, 3));
  ok(ratio >= WCAG_AA_SMALL, `⑥ .allpins-sort-btn 대비 ${ratio.toFixed(2)}:1 ≥ ${WCAG_AA_SMALL}:1 (fg=${colorR.value} from ${colorR.file}; bg=${bgR.value}→${bg.slice(0,3)} from ${bgR.file})`);
}

/* ══ ⑦ .user-role.role-admin — 조상 체인 .topbar(var(--panel)) → .user-badge
 * (rgba(15,23,42,.6)) → .user-role.role-admin(rgba(11,58,91,.10)) 3단 알파 합성 위
 * 글자색. var(--panel) 은 3d-skin.css 가 항상 다크로 리맵한다. ══════════════════════ */
{
  const topbarBgR = resolveCascade(".topbar", "background");
  const badgeBgR = resolveCascade(".user-badge", "background");
  const roleBgR = resolveCascade(".user-role.role-admin", "background");
  const roleColorR = resolveCascade(".user-role.role-admin", "color");
  ok(!!topbarBgR && !!badgeBgR && !!roleBgR && !!roleColorR, "⑦ 조상 체인 4개 선언 캐스케이드 해석 성공");
  const topbarBg = parseColor(topbarBgR.value);
  const badgeBg = parseColor(badgeBgR.value);
  const roleBg = parseColor(roleBgR.value);
  const roleFg = parseColor(roleColorR.value);
  ok(!!topbarBg && !!badgeBg && !!roleBg && !!roleFg,
    `⑦ 색 파싱 성공 — topbar=${topbarBgR.value} badge=${badgeBgR.value} role-bg=${roleBgR.value} role-fg=${roleColorR.value}`);
  const compositedBadge = composite(badgeBg, topbarBg.slice(0, 3));
  const compositedRole = composite(roleBg, compositedBadge);
  const ratio = contrast(roleFg.slice(0, 3), compositedRole);
  ok(ratio >= WCAG_AA_SMALL,
    `⑦ .user-role.role-admin 대비(3단 합성) ${ratio.toFixed(2)}:1 ≥ ${WCAG_AA_SMALL}:1 (fg=${roleColorR.value}; ambient=[${compositedRole.map((v) => v.toFixed(1))}])`);
}

console.log(failed === 0 ? "\n전체 PASS" : `\n${failed}건 FAIL`);
process.exit(failed === 0 ? 0 : 1);
