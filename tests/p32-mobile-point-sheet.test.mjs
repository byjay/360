// [WO 20260917] 모바일 "새 포인트" 시트 — 핀 아이콘 칩 정사각 강제 해제 + 도크 z-index 회귀 테스트.
// 지휘자 정정 반영: 브레이크포인트는 720px(기존 .pin-form-float 모바일 블록), 640px 아님.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.join(__dirname, "..", "public", "css", "style.css");

function run(css) {
  const results = [];
  const record = (name, pass, detail) => results.push({ name, pass, detail });

  // 기존 720px 모바일 블록의 시작/끝 위치를 찾는다.
  const blockStartMarker = "@media (max-width: 720px) {";
  const blockStart = css.indexOf(blockStartMarker);
  assert.ok(blockStart !== -1, "720px 모바일 블록이 존재해야 한다");
  // 이 블록은 .pin-form-float 를 다루는 블록이어야 한다(다른 720px 블록과 구분).
  // 블록 끝은 중괄호 깊이 추적으로 찾는다.
  let depth = 0, i = blockStart, blockEnd = -1;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) { blockEnd = i; break; }
    }
  }
  assert.ok(blockEnd !== -1, "720px 블록의 닫는 중괄호를 찾아야 한다");
  const mobileBlock = css.slice(blockStart, blockEnd + 1);
  assert.ok(mobileBlock.includes(".pin-form-float"), "이 720px 블록은 .pin-form-float 를 다루는 블록이어야 한다");

  // ① 모바일 블록 안에 .pf-icon-chip aspect-ratio 해제가 실재한다.
  const mobileChipMatch = mobileBlock.match(/\.pf-icon-chip\s*\{([^}]*)\}/);
  record(
    "① 모바일 블록 내 .pf-icon-chip aspect-ratio 해제",
    !!mobileChipMatch && /aspect-ratio\s*:\s*auto/.test(mobileChipMatch[1]),
    mobileChipMatch ? mobileChipMatch[1].trim() : "(없음)"
  );

  // ② 데스크톱(미디어쿼리 밖) .pf-icon-chip 규칙이 변경되지 않았다(aspect-ratio:1/1 유지).
  const beforeMobileBlock = css.slice(0, blockStart);
  const desktopChipMatch = beforeMobileBlock.match(/\.pf-icon-chip\s*\{([^}]*)\}/);
  record(
    "② 데스크톱 .pf-icon-chip aspect-ratio:1/1 유지",
    !!desktopChipMatch && /aspect-ratio\s*:\s*1\s*\/\s*1/.test(desktopChipMatch[1]),
    desktopChipMatch ? desktopChipMatch[1].trim() : "(없음)"
  );

  // ③ 캐스케이드 순서상 모바일 규칙이 기본 규칙 뒤에 온다.
  const desktopChipIdx = beforeMobileBlock.lastIndexOf(".pf-icon-chip {");
  record(
    "③ 모바일 .pf-icon-chip 규칙이 데스크톱 규칙보다 파일 뒤쪽에 위치",
    desktopChipIdx !== -1 && desktopChipIdx < blockStart,
    `desktopIdx=${desktopChipIdx}, mobileBlockStart=${blockStart}`
  );

  // ④ 720px 블록에서 .pin-form-float z-index 가 .mobile-dock 보다 크다(하드코딩 비교 금지 — CSS에서 파싱).
  const pinFormFloatMatch = mobileBlock.match(/\.pin-form-float\s*\{([^}]*)\}/);
  const pinFormZMatch = pinFormFloatMatch && pinFormFloatMatch[1].match(/z-index\s*:\s*(\d+)/);
  const dockZAllMatches = [...css.matchAll(/\.mobile-dock\s*\{[^}]*z-index\s*:\s*(\d+)/g)];
  const dockZ = dockZAllMatches.length ? Number(dockZAllMatches[0][1]) : null;
  const pinFormZ = pinFormZMatch ? Number(pinFormZMatch[1]) : null;
  record(
    "④ .pin-form-float z-index(모바일) > .mobile-dock z-index",
    pinFormZ !== null && dockZ !== null && pinFormZ > dockZ,
    `pinFormZ=${pinFormZ}, dockZ=${dockZ}`
  );

  // ⑤ 시트 하단에 도크 높이만큼 여백(bottom 오프셋)이 있다 — 독을 가리지 않는다.
  const pinFormBottomMatch = pinFormFloatMatch && pinFormFloatMatch[1].match(/bottom\s*:\s*calc\(([^)]*)\)/);
  record(
    "⑤ .pin-form-float bottom 오프셋이 58px(도크 높이) 기반 calc()",
    !!pinFormBottomMatch && /58px/.test(pinFormBottomMatch[1]),
    pinFormBottomMatch ? pinFormBottomMatch[0] : "(없음, bottom:0 이면 도크에 가려짐)"
  );

  return results;
}

const rawCss = readFileSync(cssPath, "utf8");
// CSS 주석(/* ... */) 을 먼저 제거 — 주석 안의 참고용 숫자(예: "도크 z-index:140" 설명)가
// 실제 선언과 혼동되어 오탐/오검출되는 것을 막는다(브라우저도 주석은 무시한다).
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, "");
const results = run(css);

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
