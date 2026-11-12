/**
 * p196 — 트리 계층 번호 칩 + 하위 영역 도면 일괄 넣기 실 Chrome 증거(WO 20261106-outline, 마스터 지시).
 * tests/_lib/real-tree-page.mjs(실 모듈 + 실 CSS 3종 + 실 renderTree/deckNode, 목 0 범위 = HTTP API만)
 * 재사용 — p194/p166 과 같은 패턴.
 *
 * 검사: ① 3단 트리에 칩 1 / 1.1 / 1.1.1 이 보임 ② 순서(sort_order)를 바꾸면 칩이 즉시 갱신
 * ③ 하위가 있는 그룹 ⋯ 메뉴에 [하위 영역 도면 일괄 넣기] 항목이 보임(하위 없는 노드엔 없음)
 * ④ [도면 등록/교체] 항목은 여전히 ⋯ 메뉴 최상단 근처에 존재(기존 기능 비회귀)
 * ⑤ 모바일 375px 에서 칩 때문에 가로 스크롤이 생기지 않음
 *
 * 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p196-tree-outline-cdp.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openRealTreePage } from "./_lib/real-tree-page.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
const ok = (cond, label, detail) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail).slice(0, 500) : "")); if (!cond) failed++; };

// 그룹 1·2(최상위) → 그룹1 아래 하위 1.1·1.2 → 1.1 아래 세부 1.1.1. sort_order 로 순서 고정.
const scenario = {
  project: { id: "prjOutline", name: "계층 번호 테스트", can_manage_members: true },
  decks: [
    { id: "g1", project_id: "prjOutline", name: "그룹 1", parent_id: null, sort_order: 1, deployment_id: null },
    { id: "g2", project_id: "prjOutline", name: "그룹 2", parent_id: null, sort_order: 2, deployment_id: null },
    { id: "s11", project_id: "prjOutline", name: "하위 1-1", parent_id: "g1", sort_order: 1, deployment_id: null },
    { id: "s12", project_id: "prjOutline", name: "하위 1-2", parent_id: "g1", sort_order: 2, deployment_id: null },
    { id: "ss111", project_id: "prjOutline", name: "세부 1-1-1", parent_id: "s11", sort_order: 1, deployment_id: null }
  ]
};

const chipText = `(function(id){ var el = document.querySelector('[data-deck-id="' + id + '"] .tree-outline-no'); return el ? el.textContent.trim() : null; })`;

let handle = null;
try {
  handle = await openRealTreePage(scenario, { width: 1280, height: 900 });
  const { page, pageErrors } = handle;
  await page.waitForSelector('[data-deck-id="ss111"]', { timeout: 8000 });

  // ① 3단 칩.
  const c1 = await page.evaluate(chipText + "('g1')");
  const c2 = await page.evaluate(chipText + "('g2')");
  const c11 = await page.evaluate(chipText + "('s11')");
  const c12 = await page.evaluate(chipText + "('s12')");
  const c111 = await page.evaluate(chipText + "('ss111')");
  ok(c1 === "1", "그룹 1 칩 = '1', 실제 " + c1);
  ok(c2 === "2", "그룹 2 칩 = '2', 실제 " + c2);
  ok(c11 === "1.1", "하위 1-1 칩 = '1.1', 실제 " + c11);
  ok(c12 === "1.2", "하위 1-2 칩 = '1.2', 실제 " + c12);
  ok(c111 === "1.1.1", "세부 1-1-1 칩 = '1.1.1'(3단), 실제 " + c111);

  // ② 순서 변경(sort_order 스왑) → renderTree() 재호출 → 칩 즉시 갱신(저장 컬럼 변경 없음, 표시만).
  await page.evaluate(() => {
    const decks = window.__wm.Projects.decks;
    const a = decks.find((d) => d.id === "g1"), b = decks.find((d) => d.id === "g2");
    const t = a.sort_order; a.sort_order = b.sort_order; b.sort_order = t;
    window.__wm.UI.renderTree();
  });
  const c1b = await page.evaluate(chipText + "('g1')");
  const c2b = await page.evaluate(chipText + "('g2')");
  ok(c1b === "2" && c2b === "1", "sort_order 스왑 후 칩이 자동 재계산되어 뒤바뀜(1↔2), 실제 g1=" + c1b + " g2=" + c2b);
  // 원복(이후 단계가 원래 순서를 기대).
  await page.evaluate(() => {
    const decks = window.__wm.Projects.decks;
    const a = decks.find((d) => d.id === "g1"), b = decks.find((d) => d.id === "g2");
    const t = a.sort_order; a.sort_order = b.sort_order; b.sort_order = t;
    window.__wm.UI.renderTree();
  });

  // ③④ ⋯ 메뉴 항목 — 하위 있는 노드(g1)엔 일괄 넣기가 있고, 하위 없는 노드(ss111)엔 없다.
  //   [도면 등록/교체]는 모든 구역·영역 메뉴 최상단 근처(기존 기능, 회귀 확인).
  const openMenuLabels = async (deckId) => {
    await page.evaluate((id) => {
      const more = document.querySelector('[data-deck-id="' + id + '"] .tree-more');
      if (more) more.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }, deckId);
    await page.waitForSelector(".tree-pop", { timeout: 5000 });
    const labels = await page.evaluate(() => Array.from(document.querySelectorAll(".tree-pop-label")).map((e) => e.textContent.trim()));
    await page.evaluate(() => { const p = document.querySelector(".tree-pop"); if (p) p.remove(); });
    return labels;
  };

  const g1Labels = await openMenuLabels("g1");
  ok(g1Labels.some((l) => l.indexOf("하위 영역 도면 일괄 넣기") >= 0), "하위 2개(s11,s12) 있는 그룹 1 ⋯ 메뉴에 [하위 영역 도면 일괄 넣기] 있음", g1Labels);
  ok(g1Labels.some((l) => l.indexOf("도면 등록") >= 0 || l.indexOf("도면 교체") >= 0), "그룹 1 ⋯ 메뉴에 [도면 등록/교체] 항목 존재(기존 기능 비회귀)", g1Labels);

  const leafLabels = await openMenuLabels("ss111");
  ok(!leafLabels.some((l) => l.indexOf("하위 영역 도면 일괄 넣기") >= 0), "하위 0개인 세부 1-1-1(ss111) ⋯ 메뉴엔 [하위 영역 도면 일괄 넣기] 없음(대응 대상 자체가 없음)", leafLabels);
  ok(leafLabels.some((l) => l.indexOf("도면 등록") >= 0 || l.indexOf("도면 교체") >= 0), "세부 1-1-1 ⋯ 메뉴에도 [도면 등록/교체] 항목 존재", leafLabels);

  const jsErrors = (pageErrors || []).filter((e) => !/favicon/i.test(e));
  ok(jsErrors.length === 0, "페이지 JS 예외 0건", jsErrors);
} catch (e) {
  ok(false, "시나리오 실행 중 예외: " + (e && e.message));
} finally {
  if (handle) await handle.close();
}

// ⑤ 모바일 375px — 칩 추가로 가로 스크롤이 생기지 않는지(새 CSS 0 — .tree-level-tag 재사용이라
//   이미 감사됐지만, 실제 DOM 조합에서의 가로폭은 실측해야 한다).
let handleM = null;
try {
  handleM = await openRealTreePage(scenario, { width: 375, height: 812 });
  const { page } = handleM;
  await page.waitForSelector('[data-deck-id="ss111"]', { timeout: 8000 });
  const m = await page.evaluate(() => {
    const sidebar = document.getElementById("sidebar");
    return {
      docOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      sidebarSw: sidebar ? sidebar.scrollWidth : null,
      sidebarCw: sidebar ? sidebar.clientWidth : null
    };
  });
  ok(!m.docOverflowX, "375px 뷰포트 — 문서 전체 가로 스크롤 없음(칩 추가 후)", m);
  ok((m.sidebarSw || 0) <= (m.sidebarCw || 0) + 1, "375px 뷰포트 — 사이드바 가로 스크롤 없음(칩 추가 후)", m);
} catch (e) {
  ok(false, "375px 시나리오 실행 중 예외: " + (e && e.message));
} finally {
  if (handleM) await handleM.close();
}

console.log("\n" + (failed ? "FAIL " + failed + "건" : "모두 PASS") + " — p196 (" + ROOT + ")");
process.exit(failed ? 1 : 0);
