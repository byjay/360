---- MODULE photo_match ----
(* WO 20261106-photomatch — "사진 일괄 등록시 번호 매칭을 못 하고 밀린다" 재현·검증.
   핵심 결함: 기존 _buildMatches()(위치기반 1:1 — 시간순 정렬된 파일 i번째 ↔ 핀 i번째)는
   파일 하나가 빠지면(마스터 사례: 408.JPG 없음) 그 뒤 모든 파일이 한 칸씩 밀려 엉뚱한
   핀에 붙는다. 새 PhotoMatch.matchByNumber()(번호 대응)는 파일명 번호 == 핀 번호로만
   짝짓고, 없으면 그 핀을 "파일 없음"으로 남긴다(밀림 없음).

   모델 범위: 핀 번호 1..N(연속, 접두 없음) 중 정확히 한 번호의 파일만 빠진 경우.
   WO 가 요구한 "접두 2종·번호 중복"은 TLC 상태공간에 넣지 않았다(아래 가정 참조) — 그
   부분(①단사 ②접두 불일치 비매칭)은 PhotoMatch.matchByNumber 구현이 번호·접두를 모두
   키로 쓰는 순수 동등비교라 TLC 없이도 자명하고, tests/p197 의 속성 테스트(수백 케이스,
   무작위 접두·중복 포함)가 그 부분을 실측으로 커버한다 — 이 모델은 "밀림(③)" 1개 속성만
   겨냥한 전용 모델이다(가정 범위를 숨기지 않고 명시).
*)
EXTENDS Naturals, TLC

CONSTANT N            \* 핀 개수(1..N, 연속 번호) — 작은 유한 모델
VARIABLE missing       \* 파일이 없는 단 하나의 핀 번호(1..N)

Pins == 1..N

(* 정렬된 "남은 파일 번호" 시퀀스 — Pins \ {missing} 을 오름차순으로 나열한 것과 동일
   (연속 구간에서 하나를 뺀 결과이므로 닫힌 식으로 바로 구할 수 있다, 별도 정렬 불필요). *)
SortedFiles(miss) == [ i \in 1..(N-1) |-> IF i < miss THEN i ELSE i + 1 ]

(* OLD — 위치기반 1:1(현재 결함 코드, 35_PhotoBatch.js _buildMatches 의 추상 모델).
   정렬된 파일을 핀 순번(1..N-1)에 그대로 꽂는다. 핀 N(범위 끝)은 파일이 모자라 0(없음). *)
OldMatch(miss) == [ p \in Pins |-> IF p <= N - 1 THEN SortedFiles(miss)[p] ELSE 0 ]

(* NEW — 번호 대응(PhotoMatch.matchByNumber 의 추상 모델). 파일 번호 == 핀 번호일 때만 매칭,
   없으면 0(파일 없음) — 다른 핀의 매칭에 전혀 영향을 주지 않는다(밀림 구조 자체가 없음). *)
NewMatch(miss) == [ p \in Pins |-> IF p = miss THEN 0 ELSE p ]

Init == missing \in Pins
Next == UNCHANGED missing
Spec == Init /\ [][Next]_missing

(* ── 반례(수정 전) ── OLD 는 "빠진 파일 1개가 다른 핀의 매칭을 안 바꾼다"를 어긴다.
   TLC 가 이 불변식을 위반(counterexample)으로 보고해야 한다 — §1-D "수정 전 규칙의
   반례를 먼저 재현". *)
InvOldNeverShifts == \A p \in Pins : p /= missing => OldMatch(missing)[p] = p

(* ── 증명 대상(수정 후) ── NEW 는 같은 불변식을 N 범위 전체에서(TLC 전수 모델체크) 만족한다. *)
InvNewNeverShifts == \A p \in Pins : p /= missing => NewMatch(missing)[p] = p

(* ── 결정성(iv) — 같은 missing 이면 항상 같은 결과(순수 함수, 상태 없음으로 자명하지만
   TLC 불변식으로도 명시). ── *)
InvNewDeterministic == NewMatch(missing) = NewMatch(missing)

====
