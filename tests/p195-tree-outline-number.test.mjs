/**
 * p195 — 트리 계층 번호(WO 20261106-outline, 마스터 지시: "상위 그룹 1 2 3 … 하위 1.1 1.2 1.3 …").
 * 대상: public/js/modules/11_UI.js UI.outlineNumbers(decks) · UI.parseLeadingOutlineNo(name).
 * 프레임워크 0 · 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p195-tree-outline-number.test.mjs
 *
 * Part A — outlineNumbers: 무작위 트리 300개(순환·고아·빈 트리 포함)로 불변식 속성 테스트
 *   (TLA+ formal/tree_outline_number.tla 가 N=4 유한 모델로 이미 체크한 같은 불변식을,
 *   실제 JS 구현에 대해 더 큰 무작위 트리로 재확인한다 — 모델과 구현이 같은 결론인지 교차검증).
 * Part B — parseLeadingOutlineNo: 작업지시 예시 4건 + 경계값.
 * Part C — 뮤테이션 2건(형제 정렬 변경 / 접두 규칙 제거) — 지휘자가 코드 일시 수정 후 재실행해
 *   EXIT=1 확인 → 원복(§G-2-5). 이 파일 자체는 정상 경로만 검사한다(주석 참조).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcText = (f) => fs.readFileSync(path.join(ROOT, "public/js/modules", f), "utf8");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 로더 — 64_TreeDnD.js(window.TreeDnD 로 self-export) 를 먼저, 그 뒤 11_UI.js(바닥 const UI,
   window export 없음 — 실 번들과 같은 단일 스코프 안에서 bare 식별자로 서로를 참조하는 패턴이라
   트레일링 식 `;UI` 로 vm.runInContext 의 완료값을 받아온다). document 는 RailLabels 의
   top-level DOMContentLoaded 리스너 등록 가드(typeof document...)만 통과시키는 최소 스텁. */
function loadUI() {
  const sandbox = { console, document: { addEventListener() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(srcText("64_TreeDnD.js"), sandbox);
  const UI = vm.runInContext(srcText("11_UI.js") + "\n;UI", sandbox);
  return { UI, TreeDnD: sandbox.window.TreeDnD };
}
const { UI, TreeDnD } = loadUI();
ok(typeof UI === "object" && typeof UI.outlineNumbers === "function", "11_UI.js 가 로드되고 UI.outlineNumbers 가 함수다");
ok(typeof TreeDnD === "object" && typeof TreeDnD.compareSiblings === "function", "64_TreeDnD.js 가 로드되고 TreeDnD.compareSiblings 가 함수다(SoT 공유 확인)");

/* ══════════════════════════════════════════════════════════════════════
 * Part A — outlineNumbers 속성 테스트(무작위 트리 300개)
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[Part A · outlineNumbers 불변식(무작위 트리)]");

// 결정적 PRNG(xorshift32) — 실행마다 같은 트리 집합으로 재현 가능(디버깅 가능한 실패).
function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** 무작위 deck 배열 생성 — n개 노드, 일부는 parent_id 가 존재하지 않는 id(고아 승격 유도),
 *  일부는 서로를 가리키는 2-사이클(순환, 고립되어 렌더되지 않음 — groupDecksByParent 규약),
 *  sort_order/level_no/created_at 도 무작위(동률 포함)로 섞어 TreeDnD.compareSiblings 의
 *  3단 폴백을 전부 건드린다. */
function randomDecks(rng, n) {
  const ids = Array.from({ length: n }, (_, i) => "d" + i);
  const decks = ids.map((id, i) => {
    const r = rng();
    let parent_id = null;
    if (r < 0.55 && i > 0) parent_id = ids[Math.floor(rng() * i)];        // 유효한 조상(앞쪽 id) — 비순환 보장
    else if (r < 0.65) parent_id = "ghost-" + Math.floor(rng() * 1000);  // 없는 부모 — 고아 승격
    else if (r < 0.72 && i > 0) parent_id = id;                          // 자기참조 — 최상위 승격
    const has = (k) => rng() < 0.6;
    return {
      id, parent_id,
      sort_order: has("s") ? Math.floor(rng() * 5) : null,  // 동률 섞음(폴백 경로 테스트)
      level_no: has("l") ? Math.floor(rng() * 5) : null,
      created_at: Math.floor(rng() * 1000)
    };
  });
  // [WO 20261113-treefolder] 2-사이클 1쌍 강제 주입(n>=4) — 전에는 groupDecksByParent 가 양쪽 다
  // roots/childrenOf 에서 빠뜨려 고립시켰다(=렌더되지 않음). 이제는 마스터 I 지시로 둘 다 cycles
  // 에 담겨 강제 root 로 승격된다(숨김 0) — checkOutlineInvariants 의 isValidChild 가 cycles 를
  // 봐서 "더는 자식이 아님"을 반영하므로 이 주입은 여전히 그 분기를 건드리는 유효한 케이스다.
  if (n >= 4 && rng() < 0.4) {
    decks[2].parent_id = decks[3].id;
    decks[3].parent_id = decks[2].id;
  }
  return decks;
}

function checkOutlineInvariants(decks, map, label) {
  // [WO 20261113-treefolder] cycles 도 함께 받는다 — groupDecksByParent 가 이제 순환 구성원을
  // 강제로 roots 로 승격한다(마스터 I: 숨기지 않고 표시). 아래 isValidChild 가 이 Set 으로
  // "원래 parent_id 는 유효해 보이지만 실제로는 더 이상 그 부모의 자식이 아님"을 구분한다.
  const { roots, childrenOf, cycles } = UI.groupDecksByParent(decks);
  // (i) 형제 번호 유일·1..n 연속 — 루트 그룹 + 각 부모 그룹.
  const checkGroup = (list, where) => {
    const nos = list.map((d) => { const e = map.get(String(d.id)); return e && !e.cycle ? e.no.split(".").pop() : null; }).filter((x) => x != null).map(Number);
    const sorted = nos.slice().sort((a, b) => a - b);
    const expect = Array.from({ length: nos.length }, (_, i) => i + 1);
    if (JSON.stringify(sorted) !== JSON.stringify(expect)) {
      ok(false, label + " — " + where + " 형제 번호 1.." + nos.length + " 연속 유일, 실제 " + JSON.stringify(sorted));
      return false;
    }
    return true;
  };
  let good = checkGroup(roots, "roots");
  childrenOf.forEach((kids, pid) => { if (!checkGroup(kids, "children-of-" + pid)) good = false; });
  ok(good, label + " — 모든 형제 그룹 번호 유일·1..n 연속");

  // [뮤테이션①이 여기서 잡힌다] 형제 "번호" 뿐 아니라 "어느 형제가 몇 번인지"도
  // TreeDnD.compareSiblings 정렬 순서와 정확히 같아야 한다(§작업지시 — 새 정렬 금지, SoT 재사용).
  // sort(cmp) 를 지우면(뮤테이션①) 숫자 집합은 여전히 1..n 이지만 배정이 달라져 여기서 실패한다.
  const checkOrder = (fullList, where) => {
    // 고립 순환 섬의 자식들(부모 자체가 어느 루트에서도 도달 불가라 map 에 없음)은 번호가 아예
    // 없다(checkGroup 의 nos=[] 와 같은 전제) — 순서를 묻는 게 무의미하니 제외하고 비교한다.
    const list = fullList.filter((d) => { const e = map.get(String(d.id)); return e && !e.cycle; });
    if (list.length < 2) return true;
    const sorted = list.slice().sort((a, b) => TreeDnD.compareSiblings(a, b));
    const want = sorted.map((d) => String(d.id));
    const got = list.slice().sort((a, b) => { const ea = map.get(String(a.id)), eb = map.get(String(b.id)); return Number(ea.no.split(".").pop()) - Number(eb.no.split(".").pop()); }).map((d) => String(d.id));
    const same = JSON.stringify(want) === JSON.stringify(got);
    if (!same) ok(false, label + " — " + where + " 번호 배정 순서가 TreeDnD.compareSiblings 순서와 다름(뮤테이션① 징후), 기대 " + JSON.stringify(want) + " 실제 " + JSON.stringify(got));
    return same;
  };
  let orderOk = checkOrder(roots, "roots");
  childrenOf.forEach((kids, pid) => { if (!checkOrder(kids, "children-of-" + pid)) orderOk = false; });
  ok(orderOk, label + " — 모든 형제 그룹의 번호 배정이 TreeDnD.compareSiblings 순서와 일치");

  // (ii) 자식 번호 = 부모 번호 + "." + 순번 — groupDecksByParent 와 같은 유효성 규칙으로만 "자식"
  //   판정(자기참조·없는 부모는 최상위로 승격되므로 부모-자식 관계가 아니다, 11_UI.js:639-642 그대로).
  //   [WO 20261113-treefolder] 🔴 순환 구성원(cycles)도 raw parent_id 는 유효해 보이지만
  //   groupDecksByParent 가 그 부모-자식 edge 를 끊어 강제 root 로 승격했다 — 더는 "자식"이 아니다.
  const byId = new Map(decks.map((d) => [String(d.id), d]));
  const isValidChild = (d) => {
    const pid = d.parent_id != null ? String(d.parent_id) : "";
    return !!(pid && pid !== String(d.id) && byId.has(pid)) && !cycles.has(String(d.id));
  };
  let prefixOk = true;
  decks.forEach((d) => {
    const e = map.get(String(d.id));
    if (!e || e.cycle || !isValidChild(d)) return;
    const pe = map.get(String(d.parent_id));
    if (!pe || pe.cycle) return; // 부모가 번호 없음(고립 순환 섬 등) — 이 자식도 도달 불가라 map 에 없을 것
    const seg = e.no.split(".");
    const expected = pe.no + "." + seg[seg.length - 1];
    if (e.no !== expected) { prefixOk = false; ok(false, label + " — " + d.id + " 번호(" + e.no + ") != 부모(" + pe.no + ")+순번, 기대 " + expected); }
  });
  ok(prefixOk, label + " — 모든 비순환 자식 번호가 부모 번호 접두사를 그대로 포함");

  // (iv) 재계산 결정적 — 같은 입력으로 다시 계산해도 같은 맵.
  const map2 = UI.outlineNumbers(decks);
  const same = decks.every((d) => {
    const a = map.get(String(d.id)), b = map2.get(String(d.id));
    return JSON.stringify(a) === JSON.stringify(b);
  });
  ok(same, label + " — 재계산 결정적(같은 입력 → 같은 번호)");
}

{
  const rng = makeRng(20261106);
  let crashed = 0;
  for (let t = 0; t < 300; t++) {
    const n = 1 + Math.floor(rng() * 9); // 1~9 노드
    const decks = randomDecks(rng, n);
    let map;
    try { map = UI.outlineNumbers(decks); } catch (e) { crashed++; console.log("  FAIL  tree#" + t + " 예외: " + e.message); continue; }
    checkOutlineInvariants(decks, map, "tree#" + t + "(n=" + n + ")");
  }
  ok(crashed === 0, "무작위 트리 300개(순환·고아 포함) 중 예외(=무한 재귀/크래시) 0건");
}

// [WO 20261113-treefolder] 🔴 규약 변경(전·후 대조) — 전: "고립 2-사이클(a↔b)은 어느 루트에서도
// 도달 불가라 번호 미할당(화면에서 사라짐)". 마스터 I 지시("순환 노드는 숨기지 말고 최상위에 배지와
// 함께 표시")로 groupDecksByParent 가 이제 a·b 를 cycles 에 담아 강제로 roots 로 승격한다 — 둘 다
// 번호를 받고(숨김 0), cycles 집합으로 "원래 서로를 가리키던 순환 구성원"임이 구분된다.
{
  const decks = [
    { id: "r", parent_id: null, sort_order: 1 },
    { id: "a", parent_id: "b", sort_order: 1 },
    { id: "b", parent_id: "a", sort_order: 1 }
  ];
  const map = UI.outlineNumbers(decks);
  const G = UI.groupDecksByParent(decks);
  ok(map.get("r") && map.get("r").no === "1", "2-사이클과 무관한 루트는 정상 번호(1), 실제 " + JSON.stringify(map.get("r")));
  ok(G.cycles.has("a") && G.cycles.has("b"), "A↔B 순환 구성원 둘 다 groupDecksByParent().cycles 에 표시된다(숨김 0, 마스터 I)");
  ok(map.has("a") && map.has("b"), "순환 구성원도 강제 root 승격으로 번호를 받는다(화면에서 사라지지 않음) — 실제 " + JSON.stringify({ a: map.get("a"), b: map.get("b") }));
  ok(G.roots.some((d) => d.id === "a") && G.roots.some((d) => d.id === "b"), "순환 구성원이 실제로 roots 배열에 포함된다(렌더 시 원본으로 전달되는 배열)");
}

// 빈 트리.
ok(UI.outlineNumbers([]).size === 0, "빈 decks 배열 → 빈 맵");
ok(UI.outlineNumbers(null).size === 0, "decks=null → 예외 없이 빈 맵(방어)");

/* ══════════════════════════════════════════════════════════════════════
 * Part B — parseLeadingOutlineNo(작업지시 예시 4건 + 경계값)
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[Part B · parseLeadingOutlineNo]");
{
  const P = (s) => UI.parseLeadingOutlineNo(s);
  ok(P("1.1_평면.pdf") === "1.1", "'1.1_평면.pdf' → '1.1', 실제 " + P("1.1_평면.pdf"));
  ok(P("01.02 ER.pdf") === "1.2", "'01.02 ER.pdf' → '1.2'(앞자리 0 무시), 실제 " + P("01.02 ER.pdf"));
  ok(P("1.1.pdf") === "1.1", "'1.1.pdf' → '1.1', 실제 " + P("1.1.pdf"));
  ok(P("a1.1.pdf") === null, "'a1.1.pdf' → null(없음), 실제 " + P("a1.1.pdf"));
  ok(P("1.1.1-ENGINE.png") === "1.1.1", "3단 번호 + '-' 구분자, 실제 " + P("1.1.1-ENGINE.png"));
  ok(P("2 상세.jpg") === "2", "단일 레벨 번호 + 공백, 실제 " + P("2 상세.jpg"));
  ok(P("") === null && P(null) === null && P(undefined) === null, "빈 값/null/undefined → null");
  ok(P("12") === "12", "확장자 없이 순수 숫자만(실수로 분수로 안 잘림) → '12', 실제 " + P("12"));
  ok(P("1.1") === "1.1", "확장자 없는 '1.1' 이 가짜 확장자(.1)로 안 잘림 — 허용 확장자 목록만 제거, 실제 " + P("1.1"));
  ok(P("A동_1.1.pdf") === null, "번호가 맨 앞이 아니면(접두 텍스트) null, 실제 " + P("A동_1.1.pdf"));
}

console.log("\n" + (failed ? "FAIL " + failed + "건" : "모두 PASS") + " — p195");
process.exit(failed ? 1 : 0);
