/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p7-contrast.test.mjs)
 *
 * 대상: public/css/style.css — #photobatch-modal(.admin-gate 재사용) 대비 위반 수정
 *  ① .pb-table thead th — 표 머리글(핀번호/파일명/촬영시각/…): 크림 배경 위 var(--text)
 *  ② .admin-gate-btn.primary — 사진폴더 선택/일괄등록 실행 버튼(반투명 골드 배경 위 골드 글자)
 *
 * 하드코딩 금지(§10): 기대 색상을 손으로 나열하지 않는다 — style.css 를 파싱해
 * :root 커스텀 프로퍼티 + 해당 규칙의 color/background 를 그대로 읽어 WCAG 대비비를 계산한다.
 * 새로 추가되는 색도 이 파서가 그대로 재계산하므로, 값이 바뀌면 이 테스트도 같이 재검증한다.
 *
 * 뮤테이션 증명: color 를 옛 값(var(--gold)/e9eaee류 밝은 값)으로 되돌리면 FAIL 해야 한다.
 * (수동 확인 절차는 커밋 메시지에 EXIT 코드로 기록)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = fs.readFileSync(path.join(ROOT, "public/css/style.css"), "utf8")
  .replace(/\r\n/g, "\n")
  .replace(/\/\*[\s\S]*?\*\//g, ""); // 주석 제거 — 주석 뒤 선언이 "직전 ; 없음"으로 오매칭되는 것 방지

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── :root 커스텀 프로퍼티 맵 (ponytail: 첫 :root { } 블록만, 이 파일 구조상 충분) ── */
function parseRootVars(cssText) {
  const m = cssText.match(/:root\s*\{([^}]*)\}/);
  const map = {};
  if (!m) return map;
  const body = m[1];
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let mm;
  while ((mm = re.exec(body))) map[mm[1].trim()] = mm[2].trim();
  return map;
}
const ROOT_VARS = parseRootVars(css);

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

console.log(failed === 0 ? "\n전체 PASS" : `\n${failed}건 FAIL`);
process.exit(failed === 0 ? 0 : 1);
