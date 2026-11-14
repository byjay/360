---- MODULE pin_zoom_dots ----
(* [WO 20261114-pinzoomdots] 「자동」 모드 — 줌아웃/혼잡 시 핀을 연한 고정 점으로 줄이는 규칙의
   유한 모델. 대상: public/js/modules/10_MapCtrl.js _applyPinDotSizesNow/_applyPinBillboard,
   23c_PinSizePrefs.js PinShapePrefs. minimap_size.tla(07_Radar.js) 의 히스테리시스 패턴을
   그대로 재사용(가독 임계=8px, 복귀 여유=15% → 9.2px, 정수모델 9).

   추상화:
     - ZoomPx = "핀 실제 화면 크기"(pinScreenPx(), 저작 크기×도면줌×사용자 설정 통합값)의 대표값.
       임계(8) 미만/근접/이상을 모두 포함하게 {5, 8, 9, 15, 30} 5개로 대표.
     - Crowded[p] = 핀 p 의 "이웃 간격 < 핀 지름" 혼잡 여부(10_MapCtrl.js 구현은 밀도 알고리즘이
       바닥(PIN_DOT_MIN_PX)에 닿은 점을 이 조건의 보수적 부분집합으로 근사 — 모델에서는 그 근사를
       직접 불린 변수로 추상화, 매 스텝 임의 변경(실제 드로잉 배치는 모델 범위 밖)).
     - FadedGlobal = ZoomPx 히스테리시스로 결정되는 "전역 줌아웃 페이드" 상태(미니맵과 동일 설계).
     - Faded(p) = FadedGlobal \/ Crowded[p] — 전역 줌아웃이거나 로컬 혼잡이면 페이드.
     - Shape(p) ∈ {FullPin, FadedDot, ForcedDot}:
         FullPin   = 번호·그림자·풍선 다 보이는 상태(구현: 비페이드 .pin-dot/번호조건부 또는 교체 teardrop)
         FadedDot  = 연한 고정 점(6~8px), 번호·줄기·그림자 없음(신규, 이번 WO)
         ForcedDot = 사용자 설정 "점" 강제(기존 PinShapePrefs.DOT, 줌/혼잡과 무관, 회귀 0)
     - Selected = 선택/호버/방금배치/포커스 핀(0=없음) — 항상 FullPin(발주 §1 예외).
     - Mode ∈ {auto, pin, dot} — PinShapePrefs. pin/dot 모드는 줌·혼잡과 무관(발주 §4).

   유한 모델 체크 한계: Pins 는 최대 N(<=6)개, ZoomPx·Crowded 는 대표값/불리언 추상화 — 연속 px·
   실제 밀도 알고리즘 수치 자체는 모델 범위 밖("이 대표값 조합에서 전이·히스테리시스가 깨지지
   않는다"만 보장, minimap_size.tla 와 동일 한계 서술). *)
EXTENDS Naturals, FiniteSets

CONSTANTS N  \* 핀 개수(<=6, 모델체크는 .cfg 에서 4로 고정)

Pins == 1..N

VARIABLES mode, selected, zoomPx, crowded, fadedGlobal

ZoomPxSet == {5, 8, 9, 15, 30}
ModeSet == {"auto", "pin", "dot"}

NoMinPx == 8          (* PIN_DOT_MAX_SCREEN_PX — 미니맵 RADAR_PIN_NO_MIN_PX 와 통일(§발주 §2) *)
HystUpperPx == 9      (* NoMinPx*115\div100=9.2 → 정수모델 절삭 9, 실구현은 부동소수 9.2(minimap과 동일 패턴) *)

(* §_updateNumberVisibility/minimap_size.tla 와 동일 설계: 안전쪽(진입)은 임계에서 즉시,
   복귀쪽(해제)만 여유(HystUpperPx)를 둬 경계 깜빡임 방지. *)
NextFadedGlobal(old, px) ==
  IF ~old /\ px < NoMinPx THEN TRUE
  ELSE IF old /\ px >= HystUpperPx THEN FALSE
  ELSE old

Faded(p) == fadedGlobal \/ crowded[p]

Shape(p) ==
  CASE mode = "pin" -> "ForcedPin"
    [] mode = "dot" -> "ForcedDot"
    [] OTHER ->                                   (* mode = "auto" *)
         IF p = selected THEN "FullPin"
         ELSE IF Faded(p) THEN "FadedDot"
         ELSE "FullPin"

TypeOK ==
  /\ mode \in ModeSet
  /\ selected \in (0..N)
  /\ zoomPx \in ZoomPxSet
  /\ crowded \in [Pins -> BOOLEAN]
  /\ fadedGlobal \in BOOLEAN

Init ==
  /\ mode = "auto"
  /\ selected = 0
  /\ zoomPx \in ZoomPxSet
  /\ crowded = [p \in Pins |-> FALSE]
  /\ fadedGlobal = (zoomPx < NoMinPx)   (* 초기상태는 안전쪽(진입) 기준 보수적 판정 *)

ZoomChange ==
  /\ zoomPx' \in ZoomPxSet
  /\ mode' = mode
  /\ selected' = selected
  /\ crowded' = crowded
  /\ fadedGlobal' = NextFadedGlobal(fadedGlobal, zoomPx')

CrowdChange ==
  /\ crowded' \in [Pins -> BOOLEAN]
  /\ mode' = mode
  /\ selected' = selected
  /\ zoomPx' = zoomPx
  /\ fadedGlobal' = fadedGlobal

SelectChange ==
  /\ selected' \in (0..N)
  /\ mode' = mode
  /\ zoomPx' = zoomPx
  /\ crowded' = crowded
  /\ fadedGlobal' = fadedGlobal

ModeChange ==
  /\ mode' \in ModeSet
  /\ selected' = selected
  /\ zoomPx' = zoomPx
  /\ crowded' = crowded
  /\ fadedGlobal' = fadedGlobal

Next == ZoomChange \/ CrowdChange \/ SelectChange \/ ModeChange

Spec == Init /\ [][Next]_<<mode, selected, zoomPx, crowded, fadedGlobal>>

(* ── 불변식(발주 §절차) ── *)
(* (i) 모든 핀은 핀 또는 점으로 렌더 — 숨김(Hidden) 값이 Shape 범위에 없으므로 항상 성립.
       명시적으로도 확인: *)
InvAllRendered == \A p \in Pins: Shape(p) \in {"FullPin", "FadedDot", "ForcedDot", "ForcedPin"}

(* (ii) auto 에서 화면 크기(전역) 또는 혼잡으로 페이드된, 선택되지 않은 핀은 번호 없음(FadedDot) *)
InvAutoFadeNoNumber ==
  \A p \in Pins:
    (mode = "auto" /\ Faded(p) /\ p # selected) => (Shape(p) = "FadedDot")

(* (iii) 선택된 핀은 모드·줌·혼잡과 무관하게 항상 FullPin(발주 §1 예외) *)
InvSelectedAlwaysFull == (selected # 0 /\ mode = "auto") => (Shape(selected) = "FullPin")

(* (iv) 모드 pin/dot 은 줌·혼잡과 무관(발주 §4 "기존 동작 불변") *)
InvForcedModeIndependent ==
  /\ (mode = "pin" => \A p \in Pins: Shape(p) = "ForcedPin")
  /\ (mode = "dot" => \A p \in Pins: Shape(p) = "ForcedDot")

====
