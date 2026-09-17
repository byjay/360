/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p27-zone-drawing-dim.test.mjs)
 *
 * 대상: 2026-09-17 발주서(ISO 제거 발주에 추가된 결함 1건) — 마스터 스크린샷 지적:
 * "영역 지정할 때 포인트가 너무 크다" / 영역(원형) 드래그 중 파란 원 4~5개가 겹쳐
 * 도면 선·글자를 완전히 덮음.
 *
 * 근본원인: 영역 그리기 중에도 이미 완성된 zone-shape 들이 평상시(fill-opacity 압축 전
 * color-mix 14~30%) 그대로 그려져, 여러 개가 겹치면 알파가 누적돼 도면을 가린다.
 * da479bf 커밋이 "구역 확대 상태(body.deck-view-active)"에 적용한 것과 동일한 패턴
 * (fill-opacity 인하 + filter:brightness(.8) 로 외곽선 대비 유지)을 "그리기 중"
 * (body.zone-drawing-active)에 재사용한다(신규 로직 아님). 그리는 중인 도형(.zd-shape/
 * .zd-line)은 완성 영역보다 한층 더 옅게 하여 시각적으로 구분한다.
 *
 * body 클래스는 16_Zones.js _syncToolUi() 에서 State.drawingZone 값과 동기화한다
 * (도형 선택/토글/취소/완료 등 모든 종료 경로가 _syncToolUi() 를 거치므로 누락 없음).
 *
 * 핀 크기(pinScreenScale, 10_MapCtrl.js): 1ce7910 커밋에서 "zoom 하나로 전 핀 공유 —
 * 구조상 이미 균일"이 확인됐다. 이번 조사에서도 pinScreenScale() 은 State.zoom 단일값의
 * 함수이며 State.drawingZone 과 무관함을 재확인했다(아래 [4]) — 즉 "영역 지정 모드"라서
 * 핀이 커지는 것이 아니라, 줌아웃 시 부분 역보정(PIN_SCALE_EXP=0.6)으로 전 화면 공통 커지는
 * 현상이다. 상수(PIN_MAX_SCALE=4.5 등) 를 줄이면 다른 배율에서 핀이 과소해질 위험이 있고,
 * 마스터 스크린샷의 실제 확대 배율(zoom)을 라이브로 실측하지 못해 "이 상수가 실제로 과한가"는
 * [Uncertain] 이다 → 추측으로 상수를 변경하지 않는다(원인 미상으로 보고, 회귀 없음 확인만).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const zonesSrc = rd("public/js/modules/16_Zones.js");
const mapSrc = rd("public/js/modules/10_MapCtrl.js");
const cssSrc = rd("public/css/style.css");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── CSS 파싱 유틸(p17 과 동일 패턴 재사용) ── */
function ruleBody(css, selectorRegexSrc) {
  const m = css.match(new RegExp(selectorRegexSrc + "\\{([^}]*)\\}"));
  return m ? m[1] : null;
}
function parseFillFilter(rule) {
  if (!rule) return { found: false };
  const fo = rule.match(/fill-opacity:\s*([\d.]+)/);
  const br = rule.match(/brightness\(([\d.]+)\)/);
  return { found: true, fillOpacity: fo ? parseFloat(fo[1]) : 1, brightness: br ? parseFloat(br[1]) : 1 };
}
function lum(r, g, b) {
  const f = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrastVsWhite(hex, k) {
  const c = hex.replace("#", "");
  const r = (parseInt(c.slice(0, 2), 16) / 255) * k, g = (parseInt(c.slice(2, 4), 16) / 255) * k, b = (parseInt(c.slice(4, 6), 16) / 255) * k;
  return (1 + 0.05) / (lum(r, g, b) + 0.05);
}
const zoneColorsMatch = rd("public/js/modules/15_Compare.js").match(/ZONE_COLORS\s*=\s*\[([^\]]+)\]/);
const ZONE_COLORS = zoneColorsMatch ? zoneColorsMatch[1].match(/#[0-9a-fA-F]{6}/g) : [];

console.log("[사전조건] ZONE_COLORS 6색 실측");
ok(ZONE_COLORS.length === 6, `ZONE_COLORS 6색 (실제 ${ZONE_COLORS.length}) — ${ZONE_COLORS.join(",")}`);

console.log("\n[1] 그리기 중 영역(zone-drawing-active)의 채움 불투명도가 완성 영역(fill-opacity 없음=1)보다 낮다");
{
  const info = parseFillFilter(ruleBody(cssSrc, "body\\.zone-drawing-active \\.zone-shape"));
  ok(info.found, "body.zone-drawing-active .zone-shape 규칙 존재");
  ok(info.fillOpacity < 1, `채움 불투명도 인하 확인 (fill-opacity=${info.fillOpacity})`);
  const deckInfo = parseFillFilter(ruleBody(cssSrc, "body\\.deck-view-active \\.zone-shape"));
  ok(info.fillOpacity <= deckInfo.fillOpacity, `그리기 중이 구역확대(deck-view-active=${deckInfo.fillOpacity})보다 같거나 더 옅음 (실제 ${info.fillOpacity})`);
}

console.log("\n[2] 외곽선 대비가 3:1 이상(흰 도면 배경, brightness 필터 반영)");
{
  const info = parseFillFilter(ruleBody(cssSrc, "body\\.zone-drawing-active \\.zone-shape"));
  const contrasts = ZONE_COLORS.map((c) => +contrastVsWhite(c, info.brightness).toFixed(2));
  const minC = Math.min(...contrasts);
  ok(minC >= 3.0, `외곽선 대비 실측(brightness(${info.brightness})) 전부 ≥3:1 — ${ZONE_COLORS.map((c, i) => c + "=" + contrasts[i]).join(", ")} (최저 ${minC})`);
}

console.log("\n[3] 완성 영역 기본 스타일(.zone-shape, body 클래스 없음)은 불변(회귀 없음)");
{
  const baseRule = ruleBody(cssSrc, "\\n\\.zone-shape ");
  // 기본 규칙에 fill: color-mix(... 14% ...) 이 그대로 있고, 별도 body 클래스 없이도 걸리는지 확인
  const hasBase14 = /\.zone-shape\s*\{[^}]*fill:\s*color-mix\(in srgb, var\(--zc, #f59e0b\) 14%/.test(cssSrc);
  ok(hasBase14, "기본 .zone-shape fill(14%) 규칙이 그대로 존재(변경 없음)");
  const hasHover30 = /\.zone-shape:hover, \.zone-shape\.active\s*\{[^}]*fill:\s*color-mix\(in srgb, var\(--zc, #f59e0b\) 30%/.test(cssSrc);
  ok(hasHover30, "기본 .zone-shape:hover/.active fill(30%) 규칙이 그대로 존재(변경 없음)");
}

console.log("\n[4] 핀 크기(pinScreenScale)는 State.zoom 단일값의 함수 — drawingZone 과 무관(구조 재확인, 조정 없음)");
{
  const State = { zoom: 1 };
  const sandbox = { console, State, Math, JSON };
  vm.createContext(sandbox);
  vm.runInContext(mapSrc + "\n;globalThis.__MAP = MapCtrl;", sandbox);
  const MapCtrl = sandbox.__MAP;
  const s1 = MapCtrl.pinScreenScale();
  State.drawingZone = true; // 존재하지 않는 필드를 넣어도 결과가 같아야 함(참조 안 함 증명)
  const s2 = MapCtrl.pinScreenScale();
  ok(s1 === s2, `drawingZone 유무와 무관하게 동일 (zoom=1 → ${s1} / ${s2})`);
  const noArgsUsed = !/pinScreenScale\(\)\s*\{[^}]*drawingZone/.test(mapSrc);
  ok(noArgsUsed, "pinScreenScale() 소스에 drawingZone 참조 없음(줌 전용 확인)");
  State.zoom = 0.3; // 넓게 줌아웃(영역 그리기 시 흔한 배율) — 참고용 정보 로그(판정 아님)
  console.log(`  [정보] zoom=0.3(넓게 줌아웃) 시 pinScreenScale=${MapCtrl.pinScreenScale().toFixed(2)} (PIN_MAX_SCALE=${MapCtrl.PIN_MAX_SCALE}) — 상수 변경 없음, 참고용`);
}

console.log("\n[뮤테이션 M1] 그리기 중 옅게 처리 제거 → [1]실패해야 함");
{
  const mutCss = cssSrc.replace(
    "body.zone-drawing-active .zone-shape{ fill-opacity:.1; filter:brightness(.8); }",
    "body.zone-drawing-active .zone-shape{ }"
  );
  ok(mutCss !== cssSrc, "M1 문자열 치환 적중(소스와 정확히 일치)");
  const info = parseFillFilter(ruleBody(mutCss, "body\\.zone-drawing-active \\.zone-shape"));
  const broke1 = !(info.found && info.fillOpacity < 1);
  ok(broke1, `[1]실패 재현: 옅게 처리 제거 시 info=${JSON.stringify(info)} (fillOpacity<1 아님)`);
}

console.log("\n[뮤테이션 M2] 기본 스타일 변경 방지 가드 제거(기본 .zone-shape fill 14%→30%로 변조) → [3]실패해야 함");
{
  const mutCss = cssSrc.replace(
    "fill: color-mix(in srgb, var(--zc, #f59e0b) 14%, transparent);",
    "fill: color-mix(in srgb, var(--zc, #f59e0b) 30%, transparent);"
  );
  ok(mutCss !== cssSrc, "M2 문자열 치환 적중(소스와 정확히 일치)");
  const hasBase14 = /\.zone-shape\s*\{[^}]*fill:\s*color-mix\(in srgb, var\(--zc, #f59e0b\) 14%/.test(mutCss);
  const broke3 = !hasBase14;
  ok(broke3, `[3]실패 재현: 기본 스타일이 14%가 아니게 변조됨(hasBase14=${hasBase14})`);
}

console.log("\n" + (failed ? "FAILED " + failed : "ALL PASS"));
process.exit(failed ? 1 : 0);
