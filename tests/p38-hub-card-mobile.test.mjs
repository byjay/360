// [WO 20260917 hub-card-mobile] 프로젝트 허브 카드 — 모바일 발견성 회귀 테스트.
// 마스터 실측(scan.seastar.work, 375×812): 액션 버튼 3개 textContent="" (라벨 없음),
// 세로 아이콘 열이 카드명/날짜를 가림, 카드 1장이 화면 절반 이상 점유.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jsPath = path.join(__dirname, "..", "public", "js", "modules", "12_ProjectHub.js");
const cssPath = path.join(__dirname, "..", "public", "css", "style.css");

function findBraceBlock(src, startIdx) {
  let depth = 0, i = startIdx, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  return end;
}

/** 소스 안의 모든 "@media (max-width: 720px) {" 블록 중 needle 을 포함하는 블록을 찾는다. */
function findMediaBlockContaining(css, needle) {
  const marker = "@media (max-width: 720px) {";
  let idx = 0;
  while (true) {
    const start = css.indexOf(marker, idx);
    if (start === -1) return null;
    const end = findBraceBlock(css, start + marker.length - 1);
    if (end === -1) return null;
    const block = css.slice(start, end + 1);
    if (block.includes(needle)) return { block, start, end };
    idx = end + 1;
  }
}

/** 정확한(리터럴) 셀렉터의 { ... } 선언 내용을 문자열에서 뽑는다(첫 매치). */
function ruleBody(src, plainSelector) {
  const escaped = plainSelector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped + "\\s*\\{([^}]*)\\}");
  const m = src.match(re);
  return m ? m[1] : null;
}
/** 정규식 패턴을 셀렉터 자리에 그대로 사용(부정 lookahead 등 필요할 때). */
function ruleBodyPattern(src, pattern) {
  const re = new RegExp(pattern + "\\s*\\{([^}]*)\\}");
  const m = src.match(re);
  return m ? m[1] : null;
}

function numProp(body, prop) {
  if (!body) return null;
  const m = body.match(new RegExp(prop + "\\s*:\\s*([0-9.]+)px"));
  return m ? parseFloat(m[1]) : null;
}
function strProp(body, prop) {
  if (!body) return null;
  const m = body.match(new RegExp(prop + "\\s*:\\s*([a-zA-Z-]+)"));
  return m ? m[1] : null;
}

const js = readFileSync(jsPath, "utf8");
const css = readFileSync(cssPath, "utf8");

const results = [];
const record = (name, pass, detail) => results.push({ name, pass, detail });

/* ── ① 세 액션 버튼(공유/다운로드/멤버)에 "보이는 텍스트 라벨"이 있다 ── */
// title/aria-label 만으로는 불통과 — hub-card-act-label 스팬(내용 텍스트) 존재 여부로 판정.
const actButtonBlock = js.match(/<div class="hub-card-actions">([\s\S]*?)<\/div>'/);
assert.ok(actButtonBlock, "hub-card-actions 렌더 블록을 찾아야 한다");
const actionsSrc = actButtonBlock[1];
const buttonCount = [...actionsSrc.matchAll(/<button class="hub-card-act /g)].length;
// 빈 span("")도 매치에 잡히도록 [^<]* 사용 — 라벨 누락(빈 텍스트) 뮤테이션을 실제로 검출해야 한다.
const labelSpans = [...actionsSrc.matchAll(/<span class="hub-card-act-label"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);
record(
  "① 액션 버튼 전원(공유/다운로드/멤버/삭제)에 보이는 텍스트 라벨이 1개씩 있다(빈 문자열 불통과)",
  buttonCount >= 3 && labelSpans.length === buttonCount && labelSpans.every((t) => t.trim().length > 0),
  `버튼수=${buttonCount}, 발견된 라벨: ${JSON.stringify(labelSpans)}`
);

/* ── ② 다운로드 완료 상태를 표시하는 경로가 존재한다 ── */
const hasDoneClassToggle = /classList\.(add|remove)\(["']is-dl-done["']\)/.test(js);
const usesExistingVerify = /OfflineBundle\.verify\(/.test(js);
const ruleForDone = ruleBody(css, ".hub-card-dl.is-dl-done");
record(
  "② 다운로드 완료 상태 표시 경로 존재(OfflineBundle.verify 재사용 + is-dl-done 클래스 + CSS 스타일)",
  hasDoneClassToggle && usesExistingVerify && !!ruleForDone,
  `classToggle=${hasDoneClassToggle} verify재사용=${usesExistingVerify} cssRule=${JSON.stringify(ruleForDone)}`
);

/* ── ③ 모바일에서 아이콘 열과 카드 본문의 겹침 면적 0 (좌표 계산, 문자열 포함검사 금지) ── */
const mobileHub = findMediaBlockContaining(css, ".hub-card-actions");
assert.ok(mobileHub, "hub-card-actions 를 다루는 720px 모바일 블록이 존재해야 한다");
const mobileActionsBody = ruleBody(mobileHub.block, ".hub-card-actions");
const mobilePosition = strProp(mobileActionsBody, "position");
// static(또는 relative) 인 flex 자식은 부모 flex-column 흐름 안에서 순차 배치되므로
// 앞선 형제(.hub-card-body)와 좌표상 겹칠 수 없다 → 겹침 면적은 기하학적으로 0.
// absolute/fixed 로 되돌리면(뮤테이션) 겹침 면적을 0으로 볼 근거가 사라져 실패해야 한다.
const overlapArea = mobilePosition === "absolute" || mobilePosition === "fixed" ? 1 : 0;
record(
  "③ 모바일 .hub-card-actions 가 static 흐름 배치 → 카드 본문과 겹침 면적 0",
  overlapArea === 0,
  `position=${mobilePosition}, 계산된 겹침면적=${overlapArea}`
);

/* ── ④ 모바일 카드 높이 ≤ 화면(812px)의 30% ── */
const VIEWPORT_H = 812;
const thumbBody = ruleBody(mobileHub.block, ".hub-card-thumb");
const bodyBody = ruleBody(mobileHub.block, ".hub-card-body");
const nameBody = ruleBody(mobileHub.block, ".hub-card-name");
const metaBody = ruleBody(mobileHub.block, ".hub-card-meta");
const actBody = ruleBodyPattern(mobileHub.block, "\\.hub-card-act(?!-)");

const thumbHeight = numProp(thumbBody, "height") ?? 0;
const bodyPad = (bodyBody && bodyBody.match(/padding\s*:\s*([0-9.]+)px\s+([0-9.]+)px\s+([0-9.]+)px/)) || null;
const bodyPadTop = bodyPad ? parseFloat(bodyPad[1]) : 0;
const bodyPadBottom = bodyPad ? parseFloat(bodyPad[3]) : 0;
const nameFontSize = numProp(nameBody, "font-size") ?? 0;
const nameMarginBottom = numProp(nameBody, "margin-bottom") ?? 0;
const metaFontSize = numProp(metaBody, "font-size") ?? 0;
const actMinHeight = numProp(actBody, "height") ?? 0;

const estimatedCardHeight =
  thumbHeight +
  bodyPadTop + bodyPadBottom +
  nameFontSize * 1.3 + nameMarginBottom +
  metaFontSize * 1.3 +
  actMinHeight + 8 /* actions row padding-bottom */;
const budget = VIEWPORT_H * 0.3;
record(
  "④ 모바일 추정 카드 높이 ≤ 화면의 30%(" + budget.toFixed(1) + "px)",
  estimatedCardHeight > 0 && estimatedCardHeight <= budget,
  `추정 높이=${estimatedCardHeight.toFixed(1)}px (thumb=${thumbHeight}, bodyPad=${bodyPadTop}+${bodyPadBottom}, name=${nameFontSize}+${nameMarginBottom}, meta=${metaFontSize}, act=${actMinHeight})`
);

/* ── ⑤ 터치타깃 ≥ 44×44 유지 ── */
const actMinWidth = numProp(actBody, "min-width") ?? numProp(actBody, "width") ?? 0;
const actHeight = numProp(actBody, "height") ?? 0;
record(
  "⑤ 모바일 .hub-card-act 터치타깃 ≥44×44",
  actMinWidth >= 44 && actHeight >= 44,
  `min-width=${actMinWidth}, height=${actHeight}`
);

/* ── ⑥ 데스크톱(미디어쿼리 밖) 규칙 불변 ── */
const beforeMobileBlock = css.slice(0, mobileHub.start);
const desktopActionsBody = ruleBody(beforeMobileBlock, ".hub-card-actions");
const desktopActBody = ruleBodyPattern(beforeMobileBlock, "\\.hub-card-act(?!-)");
record(
  "⑥ 데스크톱 .hub-card-actions position:absolute 유지(모바일 오버라이드 밖)",
  strProp(desktopActionsBody, "position") === "absolute",
  `desktop position=${strProp(desktopActionsBody, "position")}`
);
record(
  "⑥ 데스크톱 .hub-card-act 25×25(아이콘 전용) 크기 유지",
  numProp(desktopActBody, "width") === 25 && numProp(desktopActBody, "height") === 25,
  `desktop act size=${numProp(desktopActBody, "width")}x${numProp(desktopActBody, "height")}`
);
record(
  "⑥ 모바일 블록이 데스크톱 규칙보다 파일 뒤쪽에 위치(캐스케이드 순서)",
  beforeMobileBlock.lastIndexOf(".hub-card-act {") < mobileHub.start,
  `desktopIdx=${beforeMobileBlock.lastIndexOf(".hub-card-act {")}, mobileBlockStart=${mobileHub.start}`
);

for (const r of results) {
  const mark = r.pass ? "PASS" : "FAIL";
  console.log(`[${mark}] ${r.name} :: ${r.detail}`);
}
const failCount = results.filter((r) => !r.pass).length;
if (failCount > 0) {
  console.error(`\n${failCount}건 실패`);
  process.exit(1);
} else {
  console.log(`\n전체 ${results.length}건 PASS`);
  process.exit(0);
}
