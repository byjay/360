/**
 * p200 — 트리 "폴더구조처럼" 재정비(WO 20261112-treefolder, 마스터 I 항목: "순환 노드는 숨기지
 * 말고 최상위에 「순환 복구 필요」 배지와 함께 표시"). 순수 함수 UI.buildTreeModel(decks)·
 * UI.groupDecksByParent(decks) 의 cycle 처리를 무작위 그래프(노드≤5, 순환·고아·자기참조 포함)
 * 수백 개로 속성 테스트한다. 이 불변식은 formal/tree_render_complete.tla(N=4, TLC) 가 이미
 * 유한 모델로 체크한 것과 같은 결론인지 JS 구현에 대해 교차검증한다(p195 Part A 와 동일 패턴).
 *
 * 검사(작업지시 §2 불변식):
 *  (①) 모든 deck 이 렌더 결과(roots 로 시작해 childrenOf 를 재귀로 펼친 집합)에 정확히 한 번
 *      나타난다(숨겨진 노드 0) — 수정 전 결함(A↔B 순환이 roots/childrenOf 모두에서 빠짐)의 반례.
 *  (②) 순환 구성원은 groupDecksByParent().cycles 에 표시되고, roots 에도 포함된다(숨김 금지).
 *  (③) 순환으로 "들어가는" 꼬리 노드(순환 구성원 자신은 아님)는 원래 parent 그대로 남아있다.
 *  (④) buildTreeModel() 의 중첩 트리를 평탄화하면 groupDecksByParent 기반 Rendered 집합과 같다
 *      (두 함수가 서로 다른 결론을 내지 않는다 — SoT 일치).
 *  (⑤) 재계산 결정적.
 *
 * 뮤테이션 2건(지휘자가 코드 일시 수정 후 재실행 → EXIT=1 확인 → 원복, §G-2-5):
 *  ⓐ groupDecksByParent 의 cycle 강제 root 승격을 되돌림(cycles.has(id) 체크 제거) → (①)(②) 실패해야 함.
 *  ⓑ buildTreeModel 의 build() 가 children 을 재귀하지 않게 자름 → (④) 실패해야 함.
 *  실행: P200_MUT=a|b TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p200-tree-folder-model.test.mjs
 *
 * 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p200-tree-folder-model.test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcText = (f) => fs.readFileSync(path.join(ROOT, "public/js/modules", f), "utf8");
const MUT = process.env.P200_MUT || "";

let failed = 0;
const ok = (cond, label, detail) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail).slice(0, 500) : ""));
  if (!cond) failed++;
};

function loadUI() {
  let uiSrc = srcText("11_UI.js");
  if (MUT === "a") {
    // ⓐ cycle 강제 root 승격을 되돌림 — childrenOf 빌드에서 cycles 가드 제거 + roots 필터에서도 제거.
    const needleChildren = 'if (cycles.has(id)) return; // 순환 구성원은 누구의 자식으로도 등록하지 않는다(강제 root)';
    const needleRoots = 'const roots = decks.filter((d) => cycles.has(String(d.id)) || !parentKey(d));';
    if (!uiSrc.includes(needleChildren) || !uiSrc.includes(needleRoots)) throw new Error("뮤테이션ⓐ needle 없음(소스 변경?)");
    uiSrc = uiSrc.replace(needleChildren, "").replace(needleRoots, "const roots = decks.filter((d) => !parentKey(d));");
  }
  if (MUT === "b") {
    const needle = "children: build(childrenOf.get(id) || [])";
    if (!uiSrc.includes(needle)) throw new Error("뮤테이션ⓑ needle 없음(소스 변경?)");
    uiSrc = uiSrc.replace(needle, "children: []");
  }
  const sandbox = { console, document: { addEventListener() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(srcText("64_TreeDnD.js"), sandbox);
  const UI = vm.runInContext(uiSrc + "\n;UI", sandbox);
  return { UI, TreeDnD: sandbox.window.TreeDnD };
}
const { UI } = loadUI();
ok(typeof UI === "object" && typeof UI.groupDecksByParent === "function", "11_UI.js 로드 — UI.groupDecksByParent 함수");
ok(typeof UI.buildTreeModel === "function", "UI.buildTreeModel 함수 존재(신규 순수 모델 함수)");

// 결정적 PRNG(xorshift32) — p195 와 동일 패턴.
function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** 무작위 deck 그래프(노드≤5) — 고아 부모·자기참조·2/3-사이클·순환으로 들어가는 꼬리를 섞는다. */
function randomGraph(rng, n) {
  const ids = Array.from({ length: n }, (_, i) => "d" + i);
  const decks = ids.map((id, i) => {
    const r = rng();
    let parent_id = null;
    if (r < 0.5 && i > 0) parent_id = ids[Math.floor(rng() * i)];       // 유효한 조상(앞쪽) — 비순환 보장
    else if (r < 0.62) parent_id = "ghost-" + Math.floor(rng() * 1000); // 없는 부모 — 고아 승격
    else if (r < 0.7 && i > 0) parent_id = id;                          // 자기참조 — 최상위 승격
    return { id, parent_id, sort_order: Math.floor(rng() * 5), created_at: Math.floor(rng() * 1000) };
  });
  // 순환 주입: n>=3 이면 40% 로 뒤쪽 두 노드를 2-사이클로 강제(꼬리 노드가 하나 더 있으면 그 중
  // 하나를 cycle 쪽으로 가리키게 해 "꼬리" 케이스도 함께 섞는다).
  if (n >= 3 && rng() < 0.4) {
    const a = n - 2, b = n - 1;
    decks[a].parent_id = decks[b].id;
    decks[b].parent_id = decks[a].id;
    if (n >= 4 && rng() < 0.5) decks[n - 3].parent_id = decks[a].id; // 꼬리 노드(cycle 구성원은 아님)
  }
  // n>=3 이면 30% 로 3-사이클도 시도.
  if (n >= 3 && rng() < 0.3) {
    const a = 0, b = 1 % n, c = 2 % n;
    if (a !== b && b !== c && a !== c) {
      decks[a].parent_id = decks[b].id;
      decks[b].parent_id = decks[c].id;
      decks[c].parent_id = decks[a].id;
    }
  }
  return decks;
}

function flattenModel(nodes) {
  const out = [];
  (nodes || []).forEach((n) => { out.push(n.id); out.push(...flattenModel(n.children)); });
  return out;
}

function checkInvariants(decks, label) {
  const { roots, childrenOf, cycles } = UI.groupDecksByParent(decks);
  const byId = new Map(decks.map((d) => [String(d.id), d]));

  // ── 렌더 고정점(roots 에서 시작해 childrenOf 를 유한 번 되감는다) ──
  const renderedSet = (() => {
    let S = new Set(roots.map((d) => String(d.id)));
    for (let i = 0; i < decks.length + 1; i++) {
      let grew = false;
      Array.from(S).forEach((id) => {
        (childrenOf.get(id) || []).forEach((c) => { const cid = String(c.id); if (!S.has(cid)) { S.add(cid); grew = true; } });
      });
      if (!grew) break;
    }
    return S;
  })();

  // (①) 모든 deck 이 정확히 한 번(Set 이라 중복 표현 불가 — "존재" 여부만) 나타난다.
  const allIds = decks.map((d) => String(d.id));
  const missing = allIds.filter((id) => !renderedSet.has(id));
  ok(missing.length === 0, label + " — (①) 모든 deck 이 렌더 결과에 나타난다(숨겨진 노드 0)", { missing });
  ok(renderedSet.size === allIds.length, label + " — (①) 렌더 결과 노드 수 = 입력 deck 수(" + allIds.length + "), 실제 " + renderedSet.size);

  // (②) 순환 구성원은 cycles 에 있고 roots 에도 있다.
  const rootIds = new Set(roots.map((d) => String(d.id)));
  let cycleOk = true;
  cycles.forEach((id) => { if (!rootIds.has(id)) { cycleOk = false; ok(false, label + " — (②) 순환 구성원 " + id + " 이 roots 에 없음(숨김 회귀)"); } });
  ok(cycleOk, label + " — (②) 순환 구성원(" + cycles.size + "개) 전부 roots 에 포함(숨김 금지)");

  // (③) 순환으로 들어가는 꼬리 노드(자신은 cycle 아님, parent 가 cycle 구성원)는 그 parent 의
  //     childrenOf 에 그대로 남아있다(= renderedSet 에 부모를 통해 들어옴, 데이터 유실 0).
  let tailOk = true;
  decks.forEach((d) => {
    const id = String(d.id);
    if (cycles.has(id)) return;
    const pid = d.parent_id != null ? String(d.parent_id) : "";
    if (!pid || pid === id || !byId.has(pid)) return; // 고아/자기참조는 roots, 대상 아님
    if (cycles.has(pid)) {
      const kids = (childrenOf.get(pid) || []).map((c) => String(c.id));
      if (kids.indexOf(id) === -1) { tailOk = false; ok(false, label + " — (③) 순환-꼬리 " + id + " 가 승격된 부모(" + pid + ")의 childrenOf 에 없음"); }
    }
  });
  ok(tailOk, label + " — (③) 순환으로 들어가는 꼬리 노드는 승격된 부모 아래 그대로 남는다(유실 0)");

  // (④) buildTreeModel 평탄화 = renderedSet(SoT 일치).
  const model = UI.buildTreeModel(decks);
  const flatIds = flattenModel(model);
  const flatSet = new Set(flatIds);
  const sameSize = flatIds.length === flatSet.size; // 중복 0(모델 자체가 재귀 트리라 구조상 중복 불가해야 함)
  ok(sameSize, label + " — (④) buildTreeModel 평탄화에 중복 노드 0, 실제 " + flatIds.length + "개 중 유일 " + flatSet.size + "개");
  const setsEqual = flatSet.size === renderedSet.size && Array.from(renderedSet).every((id) => flatSet.has(id));
  ok(setsEqual, label + " — (④) buildTreeModel 평탄화 결과 = groupDecksByParent 기반 렌더 집합(SoT 일치)", { flat: Array.from(flatSet).sort(), rendered: Array.from(renderedSet).sort() });
  // buildTreeModel 의 cycle 플래그도 groupDecksByParent().cycles 와 일치해야 한다.
  let modelCycleOk = true;
  const walkCheck = (nodes) => (nodes || []).forEach((n) => { if (n.cycle !== cycles.has(n.id)) modelCycleOk = false; walkCheck(n.children); });
  walkCheck(model);
  ok(modelCycleOk, label + " — (④) buildTreeModel 의 cycle 플래그가 groupDecksByParent().cycles 와 일치");

  // (⑤) 재계산 결정적.
  const { roots: roots2 } = UI.groupDecksByParent(decks);
  const sameRootOrder = JSON.stringify(roots.map((d) => d.id)) === JSON.stringify(roots2.map((d) => d.id));
  ok(sameRootOrder, label + " — (⑤) 재계산 결정적(같은 입력 → 같은 roots 순서)");
}

{
  const rng = makeRng(20261113);
  let crashed = 0;
  for (let t = 0; t < 400; t++) {
    const n = 1 + Math.floor(rng() * 4); // 1~4 노드("노드≤5" 범위)
    const decks = randomGraph(rng, n);
    try { checkInvariants(decks, "graph#" + t + "(n=" + n + ")"); }
    catch (e) { crashed++; ok(false, "graph#" + t + " 예외: " + e.message); }
  }
  ok(crashed === 0, "무작위 그래프 400개(순환·고아·자기참조·순환꼬리 포함) 중 예외 0건");
}

// 고정 예시 — A↔B 순환 + 꼬리 C(C→A) + 무관한 루트 R.
{
  const decks = [
    { id: "R", parent_id: null },
    { id: "A", parent_id: "B" },
    { id: "B", parent_id: "A" },
    { id: "C", parent_id: "A" }
  ];
  checkInvariants(decks, "고정예시(R·A↔B순환·C꼬리)");
  const { cycles, roots } = UI.groupDecksByParent(decks);
  ok(cycles.has("A") && cycles.has("B") && !cycles.has("C") && !cycles.has("R"),
    "고정예시 — cycle 구성원은 정확히 {A,B}, C(꼬리)·R(무관)은 아니다 — 실제 " + JSON.stringify(Array.from(cycles)));
  ok(roots.some((d) => d.id === "A") && roots.some((d) => d.id === "B") && roots.some((d) => d.id === "R") && !roots.some((d) => d.id === "C"),
    "고정예시 — roots = {R,A,B}(C 는 A 의 자식으로 남음, roots 아님) — 실제 " + JSON.stringify(roots.map((d) => d.id)));
}

ok(UI.buildTreeModel([]).length === 0, "빈 decks 배열 → buildTreeModel 빈 배열");
ok(UI.buildTreeModel(null).length === 0, "decks=null → 예외 없이 빈 배열(방어)");

console.log("\n" + (failed ? "FAIL " + failed + "건" : "모두 PASS") + " — p200" + (MUT ? " [MUT=" + MUT + "]" : ""));
process.exit(failed ? 1 : 0);
