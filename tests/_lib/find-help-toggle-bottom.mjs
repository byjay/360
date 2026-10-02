// [WO 20261002-gap 재발주] 🔴 공유 헬퍼 — 6개 테스트(p34/p41/p42/p46/p47/p49, p42는 p34·p41을
// 자식 프로세스로 재실행하므로 간접 수혜, p51/p65는 p46·p49를 재실행하므로 간접 수혜)가 각자
// 정규식으로 "[data-help-toggle] 의 bottom:...!important 선언"을 찾고 있었는데, 전부 "셀렉터
// 바로 뒤에 '{' 가 온다"는 낡은 가정이었다. 4073788(SoT 통합)에서 이 셀렉터가
// "body:has(#screen-app.active) [data-help-toggle], ..." 처럼 쉼표로 묶인 그룹의 중간 항목으로
// 옮겨지며 전부 null/못찾음으로 깨졌다(지휘자 재현 R1~R8). 같은 실수를 여섯 곳에 각자 고치면
// 또 갈라진다(CLAUDE.md §10 SoT) — 이 함수 하나로 "찾기"만 공유한다. 값을 숫자로 환산하는 건
// 호출부마다 쓰는 evalPx/evalSimpleCalc가 다르므로(이 파일은 그 책임을 지지 않는다) 호출부에
// 그대로 둔다 — "찾기" 로직만 교체해 각 파일의 나머지 코드는 손대지 않는다(최소 변경).
//
// 반환: [data-help-toggle] 가 (쉼표로 묶인 그룹의 어디에 있든) bottom:...!important 선언을 가진
// 규칙의 "중괄호 안쪽 선언 텍스트"(문자열). 못 찾으면 null.
export function findHelpToggleBottomBlock(styleCss) {
  const re = /\[data-help-toggle\]\s*[,{]/g;
  let m;
  while ((m = re.exec(styleCss)) !== null) {
    const braceStart = styleCss.indexOf("{", m.index);
    if (braceStart === -1) break;
    let depth = 0, i = braceStart;
    for (; i < styleCss.length; i++) {
      if (styleCss[i] === "{") depth++;
      else if (styleCss[i] === "}") { depth--; if (depth === 0) break; }
    }
    const block = styleCss.slice(braceStart + 1, i);
    if (/bottom\s*:\s*[^;]+!important/.test(block)) return block;
    re.lastIndex = i + 1;
  }
  return null;
}

/** 편의 함수 — 블록에서 "bottom:" 값만 뽑아 !important 를 뗀 문자열로 반환(숫자 환산은 호출부 책임). */
export function findHelpToggleBottomRaw(styleCss) {
  const block = findHelpToggleBottomBlock(styleCss);
  if (block === null) return null;
  const m = /bottom\s*:\s*([^;]+);/.exec(block);
  if (!m) return null;
  return m[1].replace("!important", "").trim();
}
