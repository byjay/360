// tests/_lib/seed-origin.mjs — 실 Chrome(CDP) 테스트가 허브에서 "시드 프로젝트(proj_localseed)의 원본 열기"를 집는 단일 지점.
//
// 근본원인(2026-10-10 p124 11 FAIL 이분 탐색): 공유 .tmp/localdev-state D1 에 다른 테스트·팀이 만든 프로젝트가 누적된다
//   (실측: 2026-10-08 생성 프로젝트 7개 — 전부 도면 없음). 허브는 최신순이라
//   document.querySelector('[data-act=origin-open]')(스코프 없음)가 시드가 아닌 빈 프로젝트를 열어
//   "도면을 업로드하세요" 화면에서 핀·윤곽 단언이 전부 실패했다. 코드 회귀가 아니라 테스트의 상태 의존이었다
//   (같은 커밋도 새 시드 상태에서는 PASS). p130 이 같은 함정을 이름 스코프로 피한 것을 공용화한다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 시드 프로젝트 이름 — 정본은 build-tools/seed-local.mjs 의 projects INSERT. 어긋나면 즉시 실패(조용한 오탐 금지). */
export const SEED_PROJECT_NAME = "로컬 테스트 프로젝트";
{
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const seed = fs.readFileSync(path.join(root, "build-tools", "seed-local.mjs"), "utf8");
  if (!seed.includes("'" + SEED_PROJECT_NAME + "'")) throw new Error("seed-origin: build-tools/seed-local.mjs 에 시드 이름 '" + SEED_PROJECT_NAME + "' 없음 — 정본과 어긋남");
}

/** 페이지에서 평가하는 식 — 시드 프로젝트 카드 안의 [data-act=origin-open] 요소(없으면 null). */
export const FIND_SEED_ORIGIN = `(function(){
  var cards = Array.from(document.querySelectorAll('.hub-card'));
  var card = cards.find(function(c){ var n = c.querySelector('.hub-card-name'); return n && n.textContent.indexOf(${JSON.stringify(SEED_PROJECT_NAME)}) === 0; });
  return card ? card.querySelector('[data-act=origin-open]') : null;
})()`;
