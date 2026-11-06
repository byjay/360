/**
 * p194 — 사이드바 프로젝트 트리(구역→하위 구역→영역) 화면 증거 캡처 (WO 20261106-treeui).
 *
 * 마스터 평가 "트리구조 허접하다/불편하다"는 화면을 보고 내린 판정인데, 앞선 진단은 코드만 읽어
 * #side-tree 를 한 번도 마운트하지 않았다(tests/_lib/real-map-page.mjs 는 지도 뷰포트만 띄움).
 * 이 스크립트는 tests/_lib/real-tree-page.mjs(실 모듈 + 실 CSS 3종 + 실 renderTree/deckNode)로
 * 3개 시나리오 × 2개 뷰포트 = 6장을 찍고, 행 높이·⋯ 버튼 크기·들여쓰기·줄바꿈·가로스크롤을
 * getBoundingClientRect() 로 측정한다. 단언은 얕다("트리 행이 렌더됨·가로 스크롤 없음") —
 * 레이아웃이 "좋다/나쁘다"의 최종 판정은 지휘자가 스크린샷을 직접 보고 내린다.
 *
 * 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p194-tree-ui-shots.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openRealTreePage } from "./_lib/real-tree-page.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOT = path.join(ROOT, ".tmp", "tree-ui");
fs.mkdirSync(SHOT, { recursive: true });

let failed = 0;
const ok = (cond, label, detail) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail).slice(0, 500) : "")); if (!cond) failed++; };

// ── 시나리오 A: 프로젝트 1개·구역 0개(도면 등록 직후) ──────────────────────
const scenarioA = {
  project: { id: "prjA", name: "신규 프로젝트", can_manage_members: true },
  decks: [],
  afterEnter: async (page) => {
    // 실 State/UI 를 그대로 조작·재호출(목 아님) — "도면을 지금 막 등록한 직후" 입력만 준다.
    await page.evaluate(() => { window.__wm.State.fileType = "pdf"; window.__wm.UI.renderTree(); });
    await page.waitForSelector(".side-tree-empty-cta", { timeout: 8000 });
  }
};

// ── 시나리오 B: 큰 그룹 3개 × 하위 2~3개 × 3단 영역, 긴 이름, 접힘/펼침 혼합 ──
const scenarioB = {
  project: { id: "prjB", name: "조선해양 플랜트 프로젝트", can_manage_members: true },
  decks: [
    { id: "r1", project_id: "prjB", name: "ARCTIC VOYAGER ENGINE ROOM", parent_id: null, deployment_id: "depB1" },
    { id: "r1c1", project_id: "prjB", name: "ARCTIC VOYAGER E/R 3RD DECK PORT SIDE AREA", parent_id: "r1", deployment_id: "depB1" },
    { id: "r1c1g1", project_id: "prjB", name: "ARCTIC VOYAGER E/R 3RD DECK PORT SIDE AREA FWD ZONE", parent_id: "r1c1", deployment_id: "depB1" },
    { id: "r1c2", project_id: "prjB", name: "ARCTIC VOYAGER E/R 4TH DECK STARBOARD SIDE", parent_id: "r1", deployment_id: "depB1" },
    { id: "r2", project_id: "prjB", name: "POLAR EXPLORER CARGO HOLD", parent_id: null, deployment_id: "depB2" },
    { id: "r2c1", project_id: "prjB", name: "POLAR EXPLORER CARGO HOLD FORWARD BULKHEAD", parent_id: "r2", deployment_id: "depB2" },
    { id: "r2c2", project_id: "prjB", name: "POLAR EXPLORER CARGO HOLD AFT BULKHEAD", parent_id: "r2", deployment_id: "depB2" },
    { id: "r2c3", project_id: "prjB", name: "POLAR EXPLORER CARGO HOLD CENTER SECTION", parent_id: "r2", deployment_id: "depB2" },
    { id: "r3", project_id: "prjB", name: "NORTHERN STAR ENGINE CASING", parent_id: null, deployment_id: null }
  ],
  afterEnter: async (page) => {
    // r2 를 접어 접힘/펼침 혼합 상태로(기본은 전부 펼침 — renderTree 의 collapsed Set 조작이 아니라
    // 실제 캐럿 클릭으로 사용자 동작을 그대로 재현).
    await page.waitForSelector('#side-tree [data-deck-id="r2"] .tree-caret', { timeout: 8000 });
    await page.evaluate(() => { document.querySelector('#side-tree [data-deck-id="r2"] .tree-caret').dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await new Promise((r) => setTimeout(r, 150));
  }
};

// ── 시나리오 C: 빈 구역·미지정 구역 혼재 ────────────────────────────────
const scenarioC = {
  project: { id: "prjC", name: "혼합 상태 프로젝트", can_manage_members: true },
  decks: [
    { id: "c1", project_id: "prjC", name: "UNASSIGNED ZONE", parent_id: null, deployment_id: null },
    { id: "c2", project_id: "prjC", name: "ASSIGNED BUT EMPTY ZONE", parent_id: null, deployment_id: "depC" },
    { id: "c3", project_id: "prjC", name: "EMPTY PARENT ZONE", parent_id: null, deployment_id: null }
  ]
};

const SCENARIOS = [["A-empty-just-registered", scenarioA], ["B-deep-hierarchy", scenarioB], ["C-empty-unassigned-mixed", scenarioC]];
const VIEWPORTS = [["desktop-1280x800", 1280, 800], ["mobile-375x812", 375, 812]];

const MEASURE_FN = `(function(){
  var out = {};
  var nodes = Array.from(document.querySelectorAll('.tree-node'));
  out.rowCount = nodes.length;
  out.emptyMsg = !!document.querySelector('.side-tree-empty-msg');
  var first = nodes[0];
  out.rowHeight = first ? Math.round(first.getBoundingClientRect().height * 100) / 100 : null;
  var more = document.querySelector('.tree-more');
  out.moreBtn = more ? (function(r){ return { w: Math.round(r.width*100)/100, h: Math.round(r.height*100)/100 }; })(more.getBoundingClientRect()) : null;
  // 🔴 #side-tree 로 반드시 스코프(미스코프 시 12_ProjectHub.js 의 허브 카드 미리보기 li가 같은
  // data-deck-id 를 가져 offsetParent:null 인 숨은 요소를 먼저 집어 left=0 오염을 일으킨다).
  var lvl = function(sel){ var el = document.querySelector('#side-tree ' + sel); return el ? Math.round(el.getBoundingClientRect().left*100)/100 : null; };
  out.indent = { proj: lvl('.tree-node-project'), l1: lvl('[data-deck-id=\"r1\"]'), l2: lvl('[data-deck-id=\"r1c1\"]'), l3: lvl('[data-deck-id=\"r1c1g1\"]') };
  var longLabel = document.querySelector('#side-tree [data-deck-id=\"r1c1\"] .tree-label') || document.querySelector('#side-tree [data-deck-id=\"r1c1g1\"] .tree-label');
  if (longLabel) {
    var cs = getComputedStyle(longLabel);
    var lh = parseFloat(cs.lineHeight) || 16;
    out.longLabel = { text: longLabel.textContent.trim(), clientHeight: Math.round(longLabel.getBoundingClientRect().height*100)/100, approxLines: Math.round((longLabel.getBoundingClientRect().height / lh) * 10) / 10, scrollWidth: longLabel.scrollWidth, clientWidth: longLabel.clientWidth, titleFull: longLabel.closest('.tree-node') ? longLabel.closest('.tree-node').title : null };
  } else out.longLabel = null;
  var sidebar = document.getElementById('sidebar');
  var sideTree = document.getElementById('side-tree');
  out.sidebar = sidebar ? { width: Math.round(sidebar.getBoundingClientRect().width*100)/100, scrollWidth: sidebar.scrollWidth, clientWidth: sidebar.clientWidth } : null;
  out.sideTree = sideTree ? { scrollWidth: sideTree.scrollWidth, clientWidth: sideTree.clientWidth } : null;
  out.docOverflowX = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
  out.unassignedTags = document.querySelectorAll('.tree-tag').length;
  out.origin = (function(){ var o = document.querySelector('.tree-node-origin .tree-label'); return o ? o.textContent.trim() : null; })();
  return out;
})()`;

for (const [scName, scenario] of SCENARIOS) {
  for (const [vpName, width, height] of VIEWPORTS) {
    const tag = scName + "__" + vpName;
    console.log("\n=== " + tag + " ===");
    let handle = null;
    try {
      handle = await openRealTreePage(scenario, { width, height });
      const { page, close, pageErrors } = handle;
      const m = await page.evaluate(MEASURE_FN);
      console.log("  측정: " + JSON.stringify(m));
      const shotPath = path.join(SHOT, tag + ".png");
      await page.screenshot({ path: shotPath, fullPage: false });
      console.log("  스크린샷: " + shotPath);

      ok(m.rowCount > 0 || m.emptyMsg, "트리 행이 렌더됨(또는 빈 상태 안내)", m);
      const sw = (m.sidebar && m.sidebar.scrollWidth) || 0;
      const cw = (m.sidebar && m.sidebar.clientWidth) || 0;
      ok(sw <= cw + 1, "사이드바(#sidebar) 가로 스크롤 없음 — scrollWidth " + sw + " vs clientWidth " + cw, m.sidebar);
      ok(!m.docOverflowX, "문서 전체 가로 스크롤 없음", { docOverflowX: m.docOverflowX });
      const jsErrors = (pageErrors || []).filter((e) => !/favicon/i.test(e));
      ok(jsErrors.length === 0, "콘솔/페이지 JS 에러 0건", jsErrors);
    } catch (e) {
      ok(false, "하니스 실행", String(e && e.stack || e));
    } finally {
      if (handle) await handle.close();
    }
  }
}

console.log("\n" + (failed ? "FAILED " + failed + "건" : "ALL PASS"));
process.exit(failed ? 1 : 0);
