----------------------------- MODULE deck_parent_acyclic -----------------------------
(* [WO 20261112-deckcycle] decks.parent_id 순환 방지 모델.
 *
 * 재현된 결함: PUT /api/decks/:id (src/index.tsx) 는 자기참조만 막고(parentId === id)
 * 후손 전수 검사가 없다. PATCH /api/decks/:id/move 는 deckSelfAndDescendantIds() 로
 * 전수 검사를 한다. PUT 을 2회(A.parent=B, B.parent=A) 호출하면 순환이 만들어진다
 * (.tmp/repro-cycle.mjs 실측: 둘 다 status 200).
 *
 * 모델: Decks = 1..N(유한, N<=5). 연산 Create(새 id, 부모) · PutParentBuggy(수정 전
 * PUT — 자기참조만 검사) · PutParentFixed(수정 후 PUT — MoveParent 와 같은 공유 가드
 * SelfAndDescendants 재사용) · MoveParent(기존에도 가드 있음, 변경 없음) · Delete(소프트삭제).
 * 불변식 NoCycle: 살아있는 모든 deck 은 자기 자신의 '진성 후손'(1단계 이상)이 아니다.
 *
 * used 변수로 id 재사용을 막아(genId() 는 실제로 유일성을 보장) "삭제된 id 를 재활용해
 * 옛 자식 포인터가 되살아나는" 모델 전용 허구 반례를 배제한다.
 *
 * 실행(수정 후, 커밋된 cfg, N=4): -deadlock 필수 — 유한 id 풀(N) 소진 후 더 Create 할 수
 * 없는 종단상태는 모델 전용 산물(실제 genId() 는 사실상 무한)이지 안전성 위반이 아니다.
 *   java -cp E:\tools\proof-tools\tla2tools.jar tlc2.TLC -deadlock -config deck_parent_acyclic.cfg deck_parent_acyclic.tla
 *   실측(2026-11-13): EXIT=0, 43013 states generated, 3187 distinct, 0 left on queue.
 * 수정 전 반례(버그 재현, .tmp 전용 cfg — SpecBuggy, 커밋 안 함):
 *   java -cp E:\tools\proof-tools\tla2tools.jar tlc2.TLC -config <buggy.cfg> deck_parent_acyclic.tla
 *   실측(2026-11-13): EXIT=12(NoCycle 위반), Create(1)→Create(2,parent=1)→PutParentBuggy(1,parent=2)
 *   로 4 상태 만에 1↔2 순환 발견.
 *)
EXTENDS Naturals, FiniteSets

CONSTANT N
ASSUME N \in Nat /\ N > 0

Decks == 1..N
NullP == 0
PDecks == Decks \cup {NullP}

VARIABLES exists, parent, used

vars == <<exists, parent, used>>

Init ==
  /\ exists = [d \in Decks |-> FALSE]
  /\ parent = [d \in Decks |-> NullP]
  /\ used = {}

(* 살아있는 deck 중 부모가 id 인 것 — 실제 SQL(deckSelfAndDescendantIds)의
   "WHERE project_id=? AND deleted=0" 과 동일하게 죽은 deck 은 아예 집합에서 빠진다. *)
Children(id) == {d \in Decks : exists[d] /\ parent[d] = id}

(* acc 는 유한집합(Decks 부분집합)이고 매 단계 엄격히 커지거나 멈추므로 항상 종료한다
   (순환이 있어도 종료 — Children 결과가 이미 acc 에 포함되면 멈춘다). *)
RECURSIVE Grow(_)
Grow(acc) ==
  LET next == UNION {Children(d) : d \in acc}
  IN IF next \subseteq acc THEN acc ELSE Grow(acc \cup next)

(* 자기 자신 + 모든 후손(임의 깊이) — 실제 deckSelfAndDescendantIds() 와 동일 정의. *)
SelfAndDescendants(id) == Grow({id})
(* 자기 자신을 뺀, '진성'(1단계 이상) 후손만 — 불변식 판정용. *)
ProperDescendants(id) == Grow(Children(id))

Create(id, p) ==
  /\ id \notin used
  /\ (p = NullP \/ (p \in Decks /\ exists[p]))
  /\ exists' = [exists EXCEPT ![id] = TRUE]
  /\ parent' = [parent EXCEPT ![id] = p]
  /\ used' = used \cup {id}

(* 수정 전(버그) — src/index.tsx:5522 원래 코드. 자기참조만 검사. *)
PutParentBuggy(id, p) ==
  /\ exists[id]
  /\ p # id
  /\ (p = NullP \/ (p \in Decks /\ exists[p]))
  /\ parent' = [parent EXCEPT ![id] = p]
  /\ exists' = exists
  /\ used' = used

(* 수정 후 — PATCH /move 의 공유 가드(deckSelfAndDescendantIds)를 PUT 에도 재사용. *)
PutParentFixed(id, p) ==
  /\ exists[id]
  /\ p # id
  /\ (p = NullP \/ (p \in Decks /\ exists[p]))
  /\ (p = NullP \/ p \notin SelfAndDescendants(id))
  /\ parent' = [parent EXCEPT ![id] = p]
  /\ exists' = exists
  /\ used' = used

(* PATCH /api/decks/:id/move — 기존에도 이 가드가 있었다(변경 없음, src/index.tsx:5574). *)
MoveParent(id, p) == PutParentFixed(id, p)

Delete(id) ==
  /\ exists[id]
  /\ exists' = [exists EXCEPT ![id] = FALSE]
  /\ parent' = parent
  /\ used' = used

NextBuggy ==
  \/ \E id \in Decks, p \in PDecks : Create(id, p)
  \/ \E id \in Decks, p \in PDecks : PutParentBuggy(id, p)
  \/ \E id \in Decks, p \in PDecks : MoveParent(id, p)
  \/ \E id \in Decks : Delete(id)

NextFixed ==
  \/ \E id \in Decks, p \in PDecks : Create(id, p)
  \/ \E id \in Decks, p \in PDecks : PutParentFixed(id, p)
  \/ \E id \in Decks, p \in PDecks : MoveParent(id, p)
  \/ \E id \in Decks : Delete(id)

SpecBuggy == Init /\ [][NextBuggy]_vars
SpecFixed == Init /\ [][NextFixed]_vars

(* 불변식 — 살아있는 deck 은 자기 자신의 진성 후손이 아니다(=부모 그래프에 순환 없음). *)
NoCycle == \A id \in Decks : exists[id] => id \notin ProperDescendants(id)

=============================================================================
