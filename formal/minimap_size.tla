---- MODULE minimap_size ----
(* [마스터 요청 2026-11-06, 결정 2026-11-12] 미니맵(레이더) 패널 "창" 크기 +/− 단계 조절 +
   번호 가독 임계(숨김/표시) 의 유한 모델.
   대상: public/js/modules/07_Radar.js _bindSizeControls / _clampSizeScale / _updateNumberVisibility
   (구현 참조: step ∈ 0..SMAX, SIZE_STEPS = [0.8, 1, 1.25, 1.55], 기본 step=1,
   RADAR_PIN_NO_MIN_PX=8, RADAR_PIN_NO_HYST=0.15).

   불변식:
     (i)   step 은 항상 [0,SMAX] 범위
     (ii)  적용된 배율(effScale)은 뷰포트 여유(vp)를 넘지 않음(패널이 화면 밖으로 안 나감)
     (iii) step 과 persisted(localStorage 저장값)는 항상 같다 — 저장·복원 후 동일
     (iv)  점(핀 dot) 가시 개수는 창 크기·줌·번호 가시성과 무관하게 항상 전체 핀 수와 같다
     (v)   [2026-11-12] 번호 표시(numVisible=TRUE) ⇒ 실화면 글자크기(visualPx) ≥ 가독 임계(NoMinPx).
           예외 없음(안전쪽 전이는 히스테리시스 없이 임계에서 즉시 숨김 — 복귀쪽에만 여유를 둬
           깜빡임만 방지, §_updateNumberVisibility 주석과 동일 설계).

   🔴 유한 모델 체크 한계: vp(뷰포트 여유)는 4개 대표값, stagePct(도면 줌·구역 기준 배율)는 3개
   대표값(100=구역 거의 전체 덮음·1x, 220=같은 구역+콘텐츠줌 2회, 278=기본 핀 근접 자동확대
   ≈2.78x)으로만 추상화했다 — 실제 코드는 연속값(getBoundingClientRect·줌 1~6x 연속)을 쓴다.
   이 모델은 "이 대표값 조합에서 히스테리시스·임계 로직이 깨지지 않는다"만 보장한다. *)
EXTENDS Naturals

CONSTANTS SMAX, TotalPins

VARIABLES step, persisted, vp, effScale, visibleDots, stagePct, visualPx, numVisible

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

(* 도면/구역 줌 배율(x100 스케일) 대표값 — §모듈 주석 참조. *)
StagePctSet == {100, 220, 278}

(* 번호 저작 폰트(px, 2026-11-12 결정: 6px 유지, 5px로 내리지 않음) · 가독 임계(px) · 히스테리시스. *)
NoFontPx == 6
NoMinPx == 8
HystUpperPx == 9  (* NoMinPx*115\div100 = 9.2 → 정수모델에선 9(절삭) — 실구현은 부동소수 9.2 *)

(* 실화면 번호 크기(px) = 저작폰트 × 창배율(effScale,*100) × 도면배율(stagePct,*100) / 10000. *)
VisualPx(eff, sp) == (NoFontPx * eff * sp) \div 10000

(* §_updateNumberVisibility 그대로: 안전쪽(표시→숨김)은 임계(NoMinPx)에서 즉시,
   복귀쪽(숨김→표시)만 여유(HystUpperPx)를 둬 깜빡임 방지. *)
NextNumVisible(old, px) ==
  IF ~old /\ px >= HystUpperPx THEN TRUE
  ELSE IF old /\ px < NoMinPx THEN FALSE
  ELSE old

TypeOK ==
  /\ step \in Steps
  /\ persisted \in Steps
  /\ vp \in VPSet
  /\ effScale \in Nat
  /\ visibleDots \in Nat
  /\ stagePct \in StagePctSet
  /\ visualPx \in Nat
  /\ numVisible \in BOOLEAN

Init ==
  /\ step = 1          (* 기본값 — 회귀 0 보장 *)
  /\ persisted = 1
  /\ vp \in VPSet
  /\ effScale = Eff(1, vp)
  /\ visibleDots = TotalPins
  /\ stagePct \in StagePctSet
  /\ visualPx = VisualPx(Eff(1, vp), stagePct)
  /\ numVisible = (visualPx >= HystUpperPx)   (* 초기상태는 복귀쪽 기준으로 보수적으로 판정 *)

Plus ==
  /\ step' = IF step < SMAX THEN step + 1 ELSE step
  /\ persisted' = step'
  /\ vp' = vp
  /\ effScale' = Eff(step', vp)
  /\ visibleDots' = visibleDots
  /\ stagePct' = stagePct
  /\ visualPx' = VisualPx(effScale', stagePct')
  /\ numVisible' = NextNumVisible(numVisible, visualPx')

Minus ==
  /\ step' = IF step > 0 THEN step - 1 ELSE step
  /\ persisted' = step'
  /\ vp' = vp
  /\ effScale' = Eff(step', vp)
  /\ visibleDots' = visibleDots
  /\ stagePct' = stagePct
  /\ visualPx' = VisualPx(effScale', stagePct')
  /\ numVisible' = NextNumVisible(numVisible, visualPx')

(* 새로고침(재로드) — localStorage(persisted)에서 복원. *)
Reload ==
  /\ step' = persisted
  /\ persisted' = persisted
  /\ vp' = vp
  /\ effScale' = Eff(persisted, vp)
  /\ visibleDots' = visibleDots
  /\ stagePct' = stagePct
  /\ visualPx' = VisualPx(effScale', stagePct')
  /\ numVisible' = NextNumVisible(numVisible, visualPx')

(* 창 크기 변화(회전·리사이즈) — step은 그대로, 안전 배율만 재계산(§ resize 리스너). *)
ViewportResize ==
  /\ vp' \in VPSet
  /\ step' = step
  /\ persisted' = persisted
  /\ effScale' = Eff(step, vp')
  /\ visibleDots' = visibleDots
  /\ stagePct' = stagePct
  /\ visualPx' = VisualPx(effScale', stagePct')
  /\ numVisible' = NextNumVisible(numVisible, visualPx')

(* [2026-11-12] 도면 줌(+/−, 핀치) 또는 구역 전환 — stagePct 변화. *)
StageChange ==
  /\ stagePct' \in StagePctSet
  /\ step' = step
  /\ persisted' = persisted
  /\ vp' = vp
  /\ effScale' = effScale
  /\ visibleDots' = visibleDots
  /\ visualPx' = VisualPx(effScale', stagePct')
  /\ numVisible' = NextNumVisible(numVisible, visualPx')

Next == Plus \/ Minus \/ Reload \/ ViewportResize \/ StageChange

Spec == Init /\ [][Next]_<<step, persisted, vp, effScale, visibleDots, stagePct, visualPx, numVisible>>

(* ── 불변식 ── *)
InvRange == step \in Steps                       (* (i) *)
InvFit == effScale <= vp                         (* (ii) — 패널이 뷰포트 여유를 넘지 않음 *)
InvPersist == step = persisted                   (* (iii) — 저장·복원 후 동일 *)
InvDots == visibleDots = TotalPins               (* (iv) — 점 가시 개수 = 전체 핀 수, 크기조절과 무관 *)
InvNumberVisible == numVisible => (visualPx >= NoMinPx)   (* (v) — 2026-11-12 결정 *)

====
