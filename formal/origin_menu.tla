---------------------------- MODULE origin_menu ----------------------------
(* [WO 20261106-originfallback] "원본 도면" 메뉴 — pick(메인 원본 id) 결정과 메뉴 항목
   활성/비활성/문구를 입력 상태 공간 전수에 대해 검증한다(formal-verify -> tlaplus-model).
   범위: public/js/modules/31_Projects.js pickOriginalDeck/pickMainOrOpen,
         public/js/modules/11_UI.js originMenuItems,
         public/js/modules/20_App.js _mainDepId/registerDrawingFor({kind:"main"}).
   가정(경계): 5개 불리언 차원만 모델링(유한 상태 32개) — "개정 유무"는 별도 차원을 두지 않는다
   (Revision.resolve({kind:"main"})가 App._mainDepId() 공백만 보고 같은 신호를 쓰므로 mainExists
   와 동치, 중복 차원 생략). "구역 도면 등록 유무"는 origin(=메인) 판정과 무관한 다른 구역의
   자기 도면 여부라 이 메뉴의 활성/비활성에 영향이 없어(deckMenuItems는 범위 밖) 생략.
   유한 모델 체크는 이 5차원·32상태 범위에서만 전수 보장이고, 전 범위(무한 상태) 보장은 아니다. *)
VARIABLES orig, rootDeck, openDep, openUnsaved, canManageOwner

Vars == <<orig, rootDeck, openDep, openUnsaved, canManageOwner>>

TypeOK ==
  /\ orig \in BOOLEAN
  /\ rootDeck \in BOOLEAN
  /\ openDep \in BOOLEAN
  /\ openUnsaved \in BOOLEAN
  /\ canManageOwner \in BOOLEAN

Init ==
  /\ orig \in BOOLEAN
  /\ rootDeck \in BOOLEAN
  /\ openDep \in BOOLEAN
  /\ openUnsaved \in BOOLEAN
  /\ canManageOwner \in BOOLEAN

Next == UNCHANGED Vars

Spec == Init /\ [][Next]_Vars

(* ── 판정(SoT 그대로 — 31_Projects.js pickOriginalDeck/pickMainOrOpen 재현) ── *)

(* 수정 전(구) — pickOriginalDeck 만. 구역 0개 + 원본 미기록이면 null(지어내지 않음) — 이게 버그. *)
OldPickExists == orig \/ rootDeck

(* 수정 후(신) — pickMainOrOpen: OldPick 이 비면 지금 열린(저장된) 도면을 추론 후보로 더 본다. *)
NewPickExists == orig \/ rootDeck \/ (~orig /\ ~rootDeck /\ openDep)
NewPickInferred == ~orig /\ ~rootDeck /\ openDep   (* pick.inferred — 아직 서버 기록 안 됨 표시 *)

(* "지금 열린 도면" — 저장됨(openDep) 또는 로컬 draft만 복원돼 아직 저장 안 됨(openUnsaved).
   setOriginalToCurrent 가 이 경우 App._createInitialSave() 로 먼저 저장한다(31_Projects.js). *)
HasOpenDrawing == openDep \/ openUnsaved

(* 지금 실제로 서버에 "메인"으로 쓸 수 있는 배포본이 있는가(그라운드 트루스) —
   원본 기록(orig) 또는 루트 구역 발견(rootDeck) 또는 저장된 배포본이 지금 열려 있음(openDep).
   openUnsaved 만 있는 상태(로컬 draft, 한 번도 저장 안 됨)는 아직 "있다"고 할 수 없다 —
   지어내지 않음 원칙. *)
MainReallyExists == orig \/ rootDeck \/ openDep

(* 메뉴 항목 — 11_UI.js originMenuItems(proj, pick) 그대로 재현 *)
Item_OpenOriginal_Enabled(pickExists) == pickExists
Item_ReplaceMain_Enabled(pickExists) == canManageOwner /\ pickExists
Item_SetToCurrent_Shown(pickExists, inferred) == (~pickExists) \/ inferred
Item_SetToCurrent_Enabled == canManageOwner /\ HasOpenDrawing

(* ── 불변식(coordinator 지시 ①②③) ── *)

(* ① 모든 상태에서 정의됨(미정의 0) — 32상태 전부 불리언 타입으로 닫혀 있다. *)
InvAllDefined ==
  /\ TypeOK
  /\ Item_OpenOriginal_Enabled(NewPickExists) \in BOOLEAN
  /\ Item_ReplaceMain_Enabled(NewPickExists) \in BOOLEAN
  /\ Item_SetToCurrent_Shown(NewPickExists, NewPickInferred) \in BOOLEAN
  /\ Item_SetToCurrent_Enabled \in BOOLEAN

(* ② 메인 도면이 실제로 존재하는 어떤 상태에서도 "메인(원본) 도면이 아직 없습니다" 가 나오지 않는다
   — 즉 그라운드트루스가 참이면 신규 pick 판정도 반드시 참(거짓 음성 0). *)
InvNoFalseAbsence_New == MainReallyExists => NewPickExists

(* 대조용(수정 전 반례 재현) — 구(舊) pickOriginalDeck 만 쓰면 openDep 단독 상태에서 거짓 음성이 난다.
   이 불변식은 "OLD 식이 깨진다"를 보이는 용도라 OldModel.cfg 에서만 체크(의도적으로 FAIL 기대). *)
InvNoFalseAbsence_Old == MainReallyExists => OldPickExists

(* ③ "메인 도면 교체"는 소유자/관리자 권한 게이트 없이는 결코 활성화되지 않는다. *)
InvReplaceGated == Item_ReplaceMain_Enabled(NewPickExists) => canManageOwner

=============================================================================
