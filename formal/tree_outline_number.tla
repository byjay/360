---- MODULE tree_outline_number ----
(* [WO 20261106-outline 마스터 지시] 트리 계층 번호(최상위 1,2,3… / 하위 1.1,1.2… / 1.1.1…) 모델.
   대상: public/js/modules/11_UI.js UI.outlineNumbers(decks) — 그룹핑 = groupDecksByParent(고아
   부모 승격 포함), 형제 순서 = TreeDnD.compareSiblings(SoT, 64_TreeDnD.js).

   상태(실 코드 대응):
     exist[n]  — decks 배열에 이 노드가 있는가(소프트삭제 시 FALSE, groupDecksByParent 의
                 byId.has(pid) 판정과 동일 — 지워진 부모를 가리키면 고아 승격).
     parent[n] — deck.parent_id(0 = 없음/최상위 의도).
     rank[n]   — TreeDnD.compareSiblings 가 만드는 "형제 사이의 상대 순서"의 대표값(전역
                 bijection 1..N). 🔴 추상화 한계: 실 비교자는 sort_order→level_no→created_at
                 3단 폴백이지만, 어떤 두 형제든 항상 유일한 총서(strict total order)를 만든다는
                 점만 쓰면 충분하다(총서를 만드는 함수가 *무엇*이든 아래 불변식은 똑같이 성립) —
                 이 모델은 "총서가 있다"만 가정하고 rank 로 대표한다. 폴백 공식 자체의 정확성은
                 p158(64_TreeDnD.js siblingsOf 단위테스트)이 이미 검증한다(중복 검증 금지).

   불변식(작업지시 §2):
     (i)   InvSiblingUnique — 형제 번호 유일·1..n 연속
     (ii)  InvChildPrefix   — 자식 번호 = 부모 번호 + "." + 순번
     (iii) InvLabelWellTyped — 계산이 항상 끝나고(Fuel 유한) 결과가 숫자열 또는 "cycle" 중 하나
           (순환 입력에서도 종료 — DepthFuel/PathFuel 이 정수 fuel 로만 재귀해 TLA+ RECURSIVE 의
           정지성 요건을 그대로 만족한다. TLC 가 이 연산을 모든 도달 상태에서 평가해내는 것 자체가
           "무한 재귀 없음"의 증거다.)
     (iv)  재계산 결정적 — 선언형 스펙이라 같은 상태에서 Label(n) 재평가는 항상 같은 값(언어 차원의
           보장, 별도 액션으로 모델링할 대상이 없음 — 주석으로만 기록).

   🔴 유한 모델 체크 한계: N=4(노드 4개, 깊이 최대 3 — "root→child→grandchild→ggchild"로 이미
   작업지시의 "깊이≤3"을 포괄). N=6 이상은 (exist·parent·rank) 조합 상태공간이 기하급수적으로
   커져(N=6 이면 2^6 · 7^6 · 720 ≈ 54억) 실행 시간 안에 완전탐색이 불가능하다 — 이 모델은
   "N=4 범위에서" 불변식을 보장하며, 전체 자연수 N 에 대한 보장은 이 TLC 체크의 범위 밖이다
   (이산 로직이라 Lean 증명 대상은 아님 — minimap_size.tla 선례와 동일 판단). *)
EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS N

NODES == 1..N

VARIABLES exist, parent, rank

TypeOK ==
  /\ exist \in [NODES -> BOOLEAN]
  /\ parent \in [NODES -> 0..N]
  /\ rank \in [NODES -> 1..N]

Init ==
  /\ exist = [n \in NODES |-> TRUE]
  /\ parent = [n \in NODES |-> 0]       (* 시작 상태 — 전부 최상위(평면), 회귀 0 보장 *)
  /\ rank = [n \in NODES |-> n]         (* 시작 순서 = id 순서 *)

(* ── groupDecksByParent 와 동일한 유효성 판정 ── *)
IsValidParent(n) == exist[n] /\ parent[n] \in 1..N /\ parent[n] /= n /\ exist[parent[n]]

ChildrenOf(p) == { n \in NODES : IsValidParent(n) /\ parent[n] = p }
Roots == { n \in NODES : exist[n] /\ ~IsValidParent(n) }

(* ── 형제 사이의 1-based 순번(rank 로 대표한 총서 기준) ── *)
Rank(n) ==
  LET sibs == IF ~IsValidParent(n) THEN Roots ELSE ChildrenOf(parent[n])
  IN Cardinality({ m \in sibs : rank[m] <= rank[n] })

(* ── 순환 방어(§작업지시) — fuel(정수, 감소)로만 재귀해 TLA+ 정지성 요건을 만족한다.
   fuel=N 이면: 진짜 비순환 체인은 최대 N 단계(노드 N개뿐이라 한 번씩만 방문)에서 반드시
   parent 가 유효하지 않은 지점(루트)에 닿는다 — 그 전에 fuel 이 바닥나면 순환으로 판정한다. ── *)
RECURSIVE DepthFuel(_, _)
DepthFuel(n, fuel) ==
  IF fuel = 0 THEN -1
  ELSE IF ~IsValidParent(n) THEN 0
  ELSE LET d == DepthFuel(parent[n], fuel - 1) IN IF d = -1 THEN -1 ELSE 1 + d

IsCyclicNode(n) == DepthFuel(n, N) = -1

RECURSIVE PathFuel(_, _)
PathFuel(n, fuel) ==
  IF fuel = 0 THEN <<>>
  ELSE IF ~IsValidParent(n) THEN <<Rank(n)>>
  ELSE LET p == PathFuel(parent[n], fuel - 1) IN IF p = <<>> THEN <<>> ELSE Append(p, Rank(n))

(* Label(n) — 루트부터 n까지의 순번 수열("1.2.3" 의 구조적 표현), 순환이면 "cycle" 센티널. *)
Label(n) == IF ~exist[n] THEN <<>> ELSE IF IsCyclicNode(n) THEN "cycle" ELSE PathFuel(n, N)

Next ==
  \/ \E n \in NODES : /\ exist' = [exist EXCEPT ![n] = ~exist[n]]   (* 추가/삭제(소프트) 토글 *)
                      /\ parent' = parent /\ rank' = rank
  \/ \E n \in NODES, p \in 0..N : /\ parent' = [parent EXCEPT ![n] = p]   (* 이동 *)
                                  /\ exist' = exist /\ rank' = rank
  \/ \E a, b \in NODES : /\ rank' = [rank EXCEPT ![a] = rank[b], ![b] = rank[a]]   (* 순서변경 *)
                         /\ exist' = exist /\ parent' = parent

Spec == Init /\ [][Next]_<<exist, parent, rank>>

(* ── 불변식 ── *)
InvTypeOK == TypeOK

(* (i) 형제 번호 유일·1..n 연속 — 루트 그룹(0) 과 각 부모 그룹(1..N) 모두 검사 *)
InvSiblingUnique ==
  \A p \in {0} \cup NODES :
    LET sibs == IF p = 0 THEN Roots ELSE ChildrenOf(p)
    IN { Rank(n) : n \in sibs } = (1..Cardinality(sibs))

(* (ii) 자식 번호 = 부모 번호 + 순번(Append) — 비순환·유효부모인 노드에서만 성립 *)
InvChildPrefix ==
  \A n \in NODES :
    (exist[n] /\ IsValidParent(n) /\ ~IsCyclicNode(n))
    => Label(n) = Append(Label(parent[n]), Rank(n))

(* (iii) 계산이 항상 끝나고(TLC 가 이 식을 모든 도달 상태에서 평가해낸다는 사실 자체가 증거) 결과가
   항상 숫자열 또는 "cycle" 중 하나 — 지워진 노드는 <<>> (지어내지 않음, 표시 자체가 없다). *)
InvLabelWellTyped ==
  \A n \in NODES :
    IF ~exist[n] THEN Label(n) = <<>>
    ELSE IF IsCyclicNode(n) THEN Label(n) = "cycle"
    ELSE Label(n) \in Seq(1..N)

====
