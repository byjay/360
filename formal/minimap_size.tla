---- MODULE minimap_size ----
(* [마스터 요청 2026-11-06] 미니맵(레이더) 패널 "창" 크기 +/− 단계 조절의 유한 모델.
   대상: public/js/modules/07_Radar.js _bindSizeControls / _clampSizeScale
   (구현 참조: step ∈ 0..SMAX, SIZE_STEPS = [0.8, 1, 1.25, 1.55], 기본 step=1).

   불변식(작업지시 §2):
     (i)   step 은 항상 [0,SMAX] 범위
     (ii)  적용된 배율(effScale)은 뷰포트 여유(vp)를 넘지 않음(패널이 화면 밖으로 안 나감)
     (iii) step 과 persisted(localStorage 저장값)는 항상 같다 — 저장·복원 후 동일
     (iv)  점(핀 dot) 가시 개수는 창 크기 조작과 무관하게 항상 전체 핀 수와 같다
           (크기 조절 로직과 점 렌더 로직은 서로 다른 코드 경로 — 교차 영향 없음을 모델로도 명시)

   🔴 유한 모델 체크 한계: vp(뷰포트 여유)는 4개 대표값(100/110/130/999, 100=스케일1에서도 여유 없음
   ~ 999=충분)으로만 추상화했다. 실제 코드는 window.innerWidth/innerHeight·getBoundingClientRect
   연속값을 쓴다 — 이 모델은 "그 비율 함수(min(nominal,여유))가 유한 대표값에서 깨지지 않는다"만
   보장한다. 연속 실수 전범위 보장은 아니다(Lean 증명 대상 아님, TLC 유한모델체크로 충분한 이산 로직). *)
EXTENDS Naturals

CONSTANTS SMAX, TotalPins

VARIABLES step, persisted, vp, effScale, visibleDots

Steps == 0..SMAX

(* 구현의 SIZE_STEPS = [0.8, 1, 1.25, 1.55] 를 *100 정수로 스케일. index 0..3 고정(SMAX=3). *)
Nominal(s) ==
  CASE s = 0 -> 80
    [] s = 1 -> 100
    [] s = 2 -> 125
    [] s = 3 -> 155

(* 뷰포트 여유(스케일*100) 대표값 — 실제 코드의 safeMax = Math.max(1, min(maxByW,maxByH)) 는
   항상 >=100(=1.0)으로 바닥을 둔다(§ _clampSizeScale). 100=여유 전혀 없음(작은 모바일),
   999=충분(대형 데스크톱). *)
VPSet == {100, 110, 130, 999}

(* 구현의 safe = Math.max(1, Math.min(nominal, safeMax)) 를 그대로 반영(여기선 100=1.0 바닥 이미 보장). *)
Eff(s, v) == IF Nominal(s) <= v THEN Nominal(s) ELSE v

TypeOK ==
  /\ step \in Steps
  /\ persisted \in Steps
  /\ vp \in VPSet
  /\ effScale \in Nat
  /\ visibleDots \in Nat

Init ==
  /\ step = 1          (* 기본값 — 회귀 0 보장 *)
  /\ persisted = 1
  /\ vp \in VPSet
  /\ effScale = Eff(1, vp)
  /\ visibleDots = TotalPins

Plus ==
  /\ step' = IF step < SMAX THEN step + 1 ELSE step
  /\ persisted' = step'
  /\ vp' = vp
  /\ effScale' = Eff(step', vp)
  /\ visibleDots' = visibleDots

Minus ==
  /\ step' = IF step > 0 THEN step - 1 ELSE step
  /\ persisted' = step'
  /\ vp' = vp
  /\ effScale' = Eff(step', vp)
  /\ visibleDots' = visibleDots

(* 새로고침(재로드) — localStorage(persisted)에서 복원. *)
Reload ==
  /\ step' = persisted
  /\ persisted' = persisted
  /\ vp' = vp
  /\ effScale' = Eff(persisted, vp)
  /\ visibleDots' = visibleDots

(* 창 크기 변화(회전·리사이즈) — step은 그대로, 안전 배율만 재계산(§ resize 리스너). *)
ViewportResize ==
  /\ vp' \in VPSet
  /\ step' = step
  /\ persisted' = persisted
  /\ effScale' = Eff(step, vp')
  /\ visibleDots' = visibleDots

Next == Plus \/ Minus \/ Reload \/ ViewportResize

Spec == Init /\ [][Next]_<<step, persisted, vp, effScale, visibleDots>>

(* ── 불변식 ── *)
InvRange == step \in Steps                       (* (i) *)
InvFit == effScale <= vp                         (* (ii) — 패널이 뷰포트 여유를 넘지 않음 *)
InvPersist == step = persisted                   (* (iii) — 저장·복원 후 동일 *)
InvDots == visibleDots = TotalPins               (* (iv) — 점 가시 개수 = 전체 핀 수, 크기조절과 무관 *)

====
