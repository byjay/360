---- MODULE tree_render_complete ----
(* [WO 20261113-treefolder, 마스터 I 항목] 트리 전체 렌더 완전성 모델.
   대상: public/js/modules/11_UI.js UI.groupDecksByParent(decks) (2026-11-13 수정) +
   UI.buildTreeModel(decks)(신규 순수 함수). 수정 전 결함: A→B→A 류 순환은 양쪽 parent_id 가
   서로 유효해 보여 groupDecksByParent 가 roots 에서도 childrenOf 에서도 빠뜨려 화면에서
   완전히 사라졌다(실사고, HANDOFF I 항목 — "순환 노드를 숨기지 말고 최상위에 배지와 함께
   표시"). 이 모델은 그 반례를 TLC 로 재현(수정 전 정의로 체크하면 InvAllAppearOnce 위반)한
   뒤, 수정된 정의(아래 Roots/ChildrenOf — 실 JS 와 1:1)로 재체크해 통과함을 증명한다.

   상태(실 코드 대응):
     exist[n]     — decks 배열에 이 노드가 있는가(소프트삭제 FALSE).
     parent[n]    — deck.parent_id(0 = 없음/최상위).
     rank[n]      — 형제 순서 대표값(tree_outline_number.tla 와 동일 추상화 — 총서만 가정).
     collapsed[n] — this._treeCollapsed(11_UI.js renderTree) 의 세션 메모리. 토글 전까지는
                    어떤 구조적 변경(추가/이동/순서변경)에도 그대로 남는다(작업지시 ③).

   🔴 CycleMember(n) — 실 JS(groupDecksByParent, 2026-11-13) 의 cycle 탐지와 1:1:
     "n 이 유효한 parent 를 갖고, parent[n] 에서부터 유효한 parent edge 를 계속 따라가면
     유한 스텝(≤N) 안에 n 자신으로 되돌아온다." JS 구현은 각 노드에서 parent 체인을 걸어
     "이번 걷기에서 이미 지난 노드를 다시 만나면" 그 반복 구간만 cycles 에 넣는다 — 순환으로
     "들어가는" 꼬리 노드(예: C→A, A↔B 순환일 때 C)는 체인이 다시 자기 자신(C)으로 돌아오지
     않으므로 cycle 구성원이 아니다(ReachesFuel 이 C 로는 못 돌아오므로 FALSE). 이 구분이
     바로 작업지시의 "순환에 속한 노드"(배지 대상) vs "순환으로 이어지는 평범한 하위 노드"다.

   🔴 Roots/ChildrenOf(수정 후, SoT) — 11_UI.js groupDecksByParent 와 1:1:
     cycle 구성원은 (원래 parent_id 가 가리키던 대상과 무관하게) 강제로 Roots 에 포함되고,
     누구의 ChildrenOf 에도 들어가지 않는다(자기 cycle 의 상대방 포함 — edge 를 끊어 중복/
     무한루프를 막는다). cycle 로 "들어가는" 꼬리 노드는 원래 parent 그대로 그 부모(이제는
     Root 로 승격된 cycle 구성원)의 자식으로 남는다 — 데이터 유실 0, 표시 위치만 보정.

   불변식(작업지시 §2):
     (①) InvAllAppearOnce      — 존재하는 모든 deck 이 Roots 에서 시작하는 렌더 결과(Rendered,
                                  ChildrenOf 를 유한 fuel 로 되감은 고정점)에 정확히 한 번(TLA+
                                  SET 이라 중복 표현 자체가 없음 — "숨겨진 노드 0"만 체크하면
                                  충분, 구조상 한 노드가 두 ChildrenOf 에 동시에 들어갈 수
                                  없다 — parent[n] 이 단일 값이라 중복 배정 자체가 불가능).
     (②) InvCycleMembersAreRoots — 순환 구성원은 반드시 Roots 에 포함된다(=항상 렌더되고
                                  배지 대상이 된다, 숨김 금지).
     (③) InvCollapsedFrame     — "펼침 상태 저장·복원 후 동일" — exist/parent/rank 를 바꾸는
                                  어떤 Next 액션도 collapsed 를 건드리지 않는다(명시적
                                  ToggleCollapse 액션만 바꾼다 — 각 액션의 UNCHANGED collapsed
                                  로 구조적으로 보장, TLC 가 모든 도달 상태에서 이 불변식을
                                  검사해내는 것 자체가 "재렌더가 접힘 상태를 지우지 않는다"는
                                  증거다).

   🔴 유한 모델 체크 한계: N=4(작업지시 "노드≤5" 범위 안, tree_outline_number.tla 선례와 동일
   N). N=5 로 1차 실행했을 때 Rendered/RenderFuel 이 매 상태마다 고정점 재계산을 하는 비용 때문에
   상태공간이 수천만 건으로 폭증해(실측: 3분 경과 시점 distinct states 337만·대기열 274만, 계속
   증가) 실행 시간 안에 완전탐색이 끝나지 않아 N=4 로 낮췄다(한 노드 줄여도 "깊이 3"·"2-순환+
   꼬리 1개"·"고아 승격" 등 작업지시가 요구하는 구조는 모두 표현 가능). N=4 범위에서만 보장이며,
   전체 자연수 N 에 대한 보장은 이 체크의 범위 밖이다(이산 로직 — Lean 증명 대상 아님,
   tree_outline_number.tla 선례와 동일 판단). *)
EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS N

NODES == 1..N

VARIABLES exist, parent, rank, collapsed

TypeOK ==
  /\ exist \in [NODES -> BOOLEAN]
  /\ parent \in [NODES -> 0..N]
  /\ rank \in [NODES -> 1..N]
  /\ collapsed \in [NODES -> BOOLEAN]

Init ==
  /\ exist = [n \in NODES |-> TRUE]
  /\ parent = [n \in NODES |-> 0]
  /\ rank = [n \in NODES |-> n]
  /\ collapsed = [n \in NODES |-> FALSE]

IsValidParent(n) == exist[n] /\ parent[n] \in 1..N /\ parent[n] /= n /\ exist[parent[n]]

(* ReachesFuel(cur, target, fuel) — valid-parent edge 를 따라가며 target 에 닿는가(유한 fuel). *)
RECURSIVE ReachesFuel(_, _, _)
ReachesFuel(cur, target, fuel) ==
  IF fuel = 0 THEN FALSE
  ELSE IF cur = target THEN TRUE
  ELSE IF ~IsValidParent(cur) THEN FALSE
  ELSE ReachesFuel(parent[cur], target, fuel - 1)

(* 🔴 JS groupDecksByParent 의 cycle 탐지와 1:1(머리말 참조). *)
CycleMember(n) == IsValidParent(n) /\ ReachesFuel(parent[n], n, N)

(* ── 수정 후(SoT) Roots/ChildrenOf — 11_UI.js 2026-11-13 와 1:1 ── *)
Roots == { n \in NODES : exist[n] /\ (~IsValidParent(n) \/ CycleMember(n)) }
ChildrenOf(p) == { n \in NODES : exist[n] /\ IsValidParent(n) /\ parent[n] = p /\ ~CycleMember(n) }

(* ── 수정 전(결함) 정의 — tree_outline_number.tla 의 옛 Roots/ChildrenOf 그대로, 반례 재현용.
   RootsBroken 은 cycle 구성원을 강제 승격하지 않는다 — 양쪽 parent_id 가 서로 유효해 보여
   어느 쪽도 Roots 조건(~IsValidParent)을 만족 못 하고, ChildrenOfBroken 도 둘 다 등록은 하지만
   누구도 Roots 에서 시작해 도달할 수 없다(아래 RenderedBroken 이 이를 직접 보인다). ── *)
RootsBroken == { n \in NODES : exist[n] /\ ~IsValidParent(n) }
ChildrenOfBroken(p) == { n \in NODES : exist[n] /\ IsValidParent(n) /\ parent[n] = p }

(* ── 렌더 고정점(유한 fuel, N 스텝이면 충분 — 깊이 ≤ N). 🔴 TLC 가 연산자 값 매개변수를 받는
   RECURSIVE 선언을 안정적으로 평가하지 못할 수 있어(고차 연산자 제약), Fixed/Broken 버전을
   각각 1차 연산자로 중복 작성한다(로직은 ChildrenOf/ChildrenOfBroken 호출 한 줄만 다르다). ── *)
RECURSIVE RenderFuel(_, _)
RenderFuel(S, fuel) ==
  IF fuel = 0 THEN S
  ELSE LET nxt == S \cup UNION { ChildrenOf(p) : p \in S }
       IN IF nxt = S THEN S ELSE RenderFuel(nxt, fuel - 1)

RECURSIVE RenderFuelBroken(_, _)
RenderFuelBroken(S, fuel) ==
  IF fuel = 0 THEN S
  ELSE LET nxt == S \cup UNION { ChildrenOfBroken(p) : p \in S }
       IN IF nxt = S THEN S ELSE RenderFuelBroken(nxt, fuel - 1)

Rendered == RenderFuel(Roots, Cardinality(NODES))
RenderedBroken == RenderFuelBroken(RootsBroken, Cardinality(NODES))

Next ==
  \/ \E n \in NODES : /\ exist' = [exist EXCEPT ![n] = ~exist[n]]
                      /\ parent' = parent /\ rank' = rank /\ collapsed' = collapsed
  \/ \E n \in NODES, p \in 0..N : /\ parent' = [parent EXCEPT ![n] = p]
                                  /\ exist' = exist /\ rank' = rank /\ collapsed' = collapsed
  \/ \E a, b \in NODES : /\ rank' = [rank EXCEPT ![a] = rank[b], ![b] = rank[a]]
                         /\ exist' = exist /\ parent' = parent /\ collapsed' = collapsed
  (* [작업지시 ③] 사용자가 명시적으로 토글한 노드만 collapsed 가 바뀐다. 구조 변경 3종(위)은
     전부 collapsed' = collapsed(UNCHANGED) — "재렌더가 접힘 상태를 지우지 않는다"의 근거. *)
  \/ \E n \in NODES : /\ collapsed' = [collapsed EXCEPT ![n] = ~collapsed[n]]
                      /\ exist' = exist /\ parent' = parent /\ rank' = rank

Spec == Init /\ [][Next]_<<exist, parent, rank, collapsed>>

InvTypeOK == TypeOK

(* ① 존재하는 모든 deck 이 렌더 결과에 나타난다(숨겨진 노드 0). *)
InvAllAppearOnce == Rendered = { n \in NODES : exist[n] }

(* ② 순환 구성원은 반드시 Roots(=항상 렌더됨, 배지 대상)에 포함된다. *)
InvCycleMembersAreRoots == \A n \in NODES : (exist[n] /\ CycleMember(n)) => n \in Roots

(* 🔴 반례 대조용(수정 전 정의가 실제로 실패함을 보이는 음성 불변식 — "항상 거짓이어야 정상").
   InvBrokenHidesCycles 를 INVARIANTS 에 걸면, 순환이 존재하는 도달 상태에서 TLC 가 즉시
   반례를 낸다(=수정 전 정의가 결함을 그대로 재현한다는 증거). 수정된 모델 체크(위 두 Inv)에는
   포함하지 않는다 — 이 Inv 자체가 "깨지는 것이 곧 그 전 결함의 재현"이라는 음성 테스트다. *)
InvBrokenHidesCycles ==
  \A n \in NODES : (exist[n] /\ CycleMember(n)) => n \in RenderedBroken

====
