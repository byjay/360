/**
 * p192 — WO 20261106-originfallback: "원본 도면" 메뉴가 메인 도면이 실제로 있는데도
 * "메인(원본) 도면이 아직 없습니다 / 먼저 도면을 열어야 합니다" 를 내는 결함(실 Chrome, CDP,
 * real-map-page.mjs 하니스 재사용 — p191 과 같은 패턴).
 *
 * [재현] 마스터 스크린샷(2026-11-06) — 프로젝트 "SB SUNBO", 구역 0개("도면이 등록됐습니다"),
 *   ARCTIC VOYAGER - GA.pdf 가 열려 있는데도 원본 ⋯ 메뉴 전부가 "메인(원본) 도면이 아직 없습니다"·
 *   "지금 열린 도면을 원본으로 지정"은 "먼저 도면을 열어야 합니다". 근본원인(31_Projects.js):
 *   pickOriginalDeck 은 서버 기록(original_deployment_id) 또는 루트 구역만 보고, 구역이 0개면
 *   (등록만 되고 구역을 아직 안 만든 구간 · 그 구역이 나중에 지워진 레거시) null 을 돌려줘
 *   "없다"고 오판했다. 두 번째 하위 케이스(로컬 draft만 복원돼 서버에 한 번도 저장 안 된 열린
 *   도면)는 State.currentDeploymentId 조차 없어 "지정"도 막혔다.
 *
 * 수학적 검증(formal-verify→tlaplus-model, formal/origin_menu.tla)로 5차원·32상태 전수 확인:
 *   구(舊) 식(orig\/rootDeck)은 openDep=T·orig=F·rootDeck=F 에서 InvNoFalseAbsence_Old 위반
 *   (TLC EXIT=12, 반례 = 바로 이 재현 상태) — 신(新) 식(pickMainOrOpen)은 32상태 전부 PASS(EXIT=0).
 *
 * 검증:
 *  (0) 회귀 가드 — pickOriginalDeck(구역 0개·원본 미기록)은 여전히 null(엄격한 SoT 유지).
 *  (1) [시나리오 A: 저장된 배포본이 열려 있음] pickMainOrOpen → inferred pick(truthy) — 원본 전체
 *      도면 열기/메인 도면 교체 reason="" · 지정 항목도 여전히 보이고 reason="".
 *  (2) [시나리오 A, 권한 없음] canManageOwner=false → 메인 도면 교체는 여전히 비활성(권한 게이트
 *      약화 금지) — reason은 "" 가 아니다.
 *  (3) [시나리오 B: 로컬 draft만 복원, 한 번도 저장 안 됨] pickMainOrOpen → null(지어내지 않음,
 *      "메인(원본) 도면이 아직 없습니다"가 정직하게 참) — 하지만 "지금 열린 도면을 원본으로 지정"은
 *      reason="" (열린 도면 존재로 봄 — setOriginalToCurrent 가 먼저 저장한다).
 *  (4) [다른 프로젝트 재진입 오염 가드] State.currentProjectId 가 proj.id 와 다르면 pickMainOrOpen
 *      이 추론하지 않는다(null).
 *
 * 실행: CHROME_PATH=... TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p192-origin-menu-pick-cdp.mjs
 * 뮤테이션(반드시 EXIT=1):
 *   P192_MUT=nofallback → 31_Projects.js pickMainOrOpen의 추론 분기 제거 → (1) 깨짐
 *   P192_MUT=noshowitem → 11_UI.js originMenuItems의 "!pick||pick.inferred" → "!pick" 원복 → (1) 의 지정 항목 존재 단언 깨짐
 *   P192_MUT=nohasopen  → 11_UI.js의 hasOpenDrawing(State.fileType 폴백) 제거 → (3) 깨짐
 */
import { openRealMap, DEFAULT_MODULES } from "./_lib/real-map-page.mjs";

let failed = 0;
const ok = (cond, label, d) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (d !== undefined ? " :: " + JSON.stringify(d) : "")); if (!cond) failed++; return cond; };

const MUT = process.env.P192_MUT || "";

const MUTS = {
  nofallback: {
    file: "31_Projects.js",
    needle: '      const depId = (typeof State !== "undefined") ? State.currentDeploymentId : null;\n      if (!depId) return null;\n',
    to: '      return null; // [MUT nofallback]\n',
  },
  noshowitem: {
    file: "11_UI.js",
    needle: "if (!pick || pick.inferred) {",
    to: "if (!pick) {",
  },
  nohasopen: {
    file: "11_UI.js",
    needle: 'const hasOpenDrawing = !!(typeof State !== "undefined"\n          && (State.currentDeploymentId || (State.fileType && State.mode === "designer")));',
    to: 'const hasOpenDrawing = !!(typeof State !== "undefined" && State.currentDeploymentId);',
  },
};
if (MUT && !MUTS[MUT]) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }

const mutate = (name, src) => {
  if (!MUT || MUTS[MUT].file !== name) return src;
  const { needle, to } = MUTS[MUT];
  if (!src.includes(needle)) { console.log("FAIL 뮤테이션 대상 없음(" + MUT + ") in " + name); process.exit(2); }
  return src.replace(needle, to);
};

const page = await openRealMap({
  width: 800, height: 600,
  mutate,
  modules: [...DEFAULT_MODULES, "31_Projects.js"],
});
const ev = page.ev;

try {
  // ── 공통 시드 ──
  await ev('window.Auth = { isDesigner: true, readonly: false, isSuper: false, user: { email: "owner@x.com" }, headers: () => ({}) };');
  await ev('State.mode = "designer";'); // permCheck("owner")가 디자이너 모드를 전제로 한다
  await ev('Projects.decks = [];'); // 구역 0개("도면이 등록됐습니다" 빈 상태)
  await ev('Projects.currentProject = { id: "proj_sunbo", name: "SB SUNBO", can_manage_members: true, original_deployment_id: null };');
  await ev('State.currentProjectId = "proj_sunbo";');

  // ── (0) 회귀 가드 — pickOriginalDeck 은 여전히 엄격(null) ──
  await ev('State.currentDeploymentId = "dep_arctic"; State.fileName = "ARCTIC VOYAGER - GA.pdf";');
  const strictPick = await ev('Projects.pickOriginalDeck(Projects.decks, Projects.currentProject)');
  ok(strictPick === null, "(0) pickOriginalDeck(구역0개·원본미기록) 는 여전히 null(회귀 가드)", strictPick);

  // ── (1) 시나리오 A: 저장된 배포본이 열려 있음(State.currentDeploymentId 있음) ──
  const pickA = await ev('Projects.pickMainOrOpen(Projects.decks, Projects.currentProject)');
  ok(!!pickA && pickA.deployment_id === "dep_arctic" && pickA.inferred === true,
    "(1) pickMainOrOpen → inferred pick(truthy, deployment_id=열린 도면)", pickA);

  const itemsA = await ev('UI.originMenuItems(Projects.currentProject, Projects.pickMainOrOpen(Projects.decks, Projects.currentProject))');
  const findItem = (items, label) => (items || []).find((it) => it.label === label);
  const openItem = findItem(itemsA, "원본 전체 도면 열기");
  const replaceItem = findItem(itemsA, "메인 도면 교체");
  const setItem = findItem(itemsA, "지금 열린 도면을 원본으로 지정");
  ok(!!openItem && openItem.reason === "", "(1) [원본 전체 도면 열기] reason=''(활성)", openItem && openItem.reason);
  ok(!!replaceItem && replaceItem.reason === "", "(1) [메인 도면 교체] reason=''(활성, 권한 있음)", replaceItem && replaceItem.reason);
  ok(!!setItem && setItem.reason === "", "(1) [지금 열린 도면을 원본으로 지정] 여전히 보이고 reason=''(inferred)", setItem && setItem.reason);

  // ── (2) 시나리오 A, 권한 없음 — 교체는 여전히 비활성(게이트 유지) ──
  await ev('Projects.currentProject.can_manage_members = false;');
  const itemsA2 = await ev('UI.originMenuItems(Projects.currentProject, Projects.pickMainOrOpen(Projects.decks, Projects.currentProject))');
  const replaceItem2 = findItem(itemsA2, "메인 도면 교체");
  ok(!!replaceItem2 && replaceItem2.reason !== "", "(2) 권한 없음 → [메인 도면 교체] 여전히 비활성(권한 게이트 유지)", replaceItem2 && replaceItem2.reason);
  await ev('Projects.currentProject.can_manage_members = true;'); // 복원

  // ── (3) 시나리오 B: 로컬 draft만 복원(서버에 한 번도 저장 안 됨) ──
  await ev('State.currentDeploymentId = null; State.fileType = "pdf"; State.mode = "designer"; State.fileName = "ARCTIC VOYAGER - GA.pdf";');
  const pickB = await ev('Projects.pickMainOrOpen(Projects.decks, Projects.currentProject)');
  ok(pickB === null, "(3) 저장 안 된 draft만 있을 때 pickMainOrOpen → null(지어내지 않음)", pickB);
  const itemsB = await ev('UI.originMenuItems(Projects.currentProject, Projects.pickMainOrOpen(Projects.decks, Projects.currentProject))');
  const openItemB = findItem(itemsB, "원본 전체 도면 열기");
  const setItemB = findItem(itemsB, "지금 열린 도면을 원본으로 지정");
  ok(!!openItemB && openItemB.reason === "메인(원본) 도면이 아직 없습니다", "(3) [원본 전체 도면 열기] 저장 안 됐으니 정직하게 비활성", openItemB && openItemB.reason);
  ok(!!setItemB && setItemB.reason === "", "(3) [지금 열린 도면을 원본으로 지정] 저장 안 된 draft도 '열린 도면'으로 보고 활성", setItemB && setItemB.reason);

  // ── (4) 다른 프로젝트 재진입 오염 가드 ──
  await ev('State.currentDeploymentId = "dep_arctic"; State.currentProjectId = "proj_other";');
  const pickD = await ev('Projects.pickMainOrOpen(Projects.decks, Projects.currentProject)');
  ok(pickD === null, "(4) State.currentProjectId 가 다른 프로젝트면 추론하지 않음(오염 가드)", pickD);
} finally {
  await page.close();
}

console.log(MUT ? `\n[MUT=${MUT}] 의도적 되돌림 — 위 단언 중 일부는 반드시 FAIL 이어야 정상` : "");
console.log(failed ? `\n❌ p192 ${failed}건 FAIL` : "\n✅ p192 전체 PASS");
process.exit(failed ? 1 : 0);
