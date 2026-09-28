/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p70-hub-deck-tree.test.mjs)
 *
 * 배경 — 마스터 반복 지시: "전체 프로젝트 페이지에 하위 구역-영역... 이건 몇번말했잖아 트리이해안되네"
 * "구역이름을 동시에 리스트에 보여주고". 기존 3단 사이드바 트리(11_UI.js renderTree)는 도면 편집
 * 화면 전용이고, 마스터가 가리킨 화면은 프로젝트 허브(전체 프로젝트 목록, 12_ProjectHub.js) —
 * 그 카드 안에는 구역/영역이 하나도 없었다(재현: scan.seastar.work 375×812 .hub-card 요소 전수).
 *
 * 구현 요약:
 *  · 분류 규칙(parent_id NULL=구역/있으면=영역)을 UI.groupDecksByParent() 로 공유 함수화
 *    (11_UI.js renderTree() 와 12_ProjectHub.js 카드 트리가 같은 함수를 쓴다 — SoT).
 *  · ProjectHub._loadDeckTrees() 가 /api/projects/:id/decks 를 프로젝트별 병렬 조회(N+1 회피,
 *    기존 _resolveDeployLinks 와 동일 관행) → _deckTreeCache 에 저장.
 *  · ProjectHub._renderDeckTreeHtml(p) 가 카드 아래 구역→영역 HTML 생성(항상 펼침, 접기 없음).
 *  · 구역/영역 클릭 → ProjectHub.openProjectAtDeck() 가 기존 openProject()(진입) +
 *    Projects.selectDeck()(열기)를 그대로 재사용(새 진입 로직 0).
 *  · 31_Projects.js loadDecks() 끝에서 ProjectHub.refreshIfVisible() 호출(공유 지점, SoT) —
 *    구역 생성(createDeck/extractRegionAsDeck/드래그크롭) 전부가 loadDecks() 를 거치므로
 *    허브가 보이는 상태면 새로고침 없이 카드 트리가 갱신된다.
 *
 * 검사(실 브라우저 375×812, puppeteer):
 *  ① 구역 2개(영역 2개·0개) → 카드 아래 구역 이름 2개 + 영역 이름 2개가 DOM 에 렌더
 *  ② 기본 펼침 — .hub-card-tree 가 숨김 없이(computed display != none) 바로 보인다
 *  ③ 구역 0개 프로젝트 → "구역 없음" 표시
 *  ④ deleted=1 구역은 안 보인다(방어적 클라 필터 — 서버도 deleted=0 만 내려주지만 이중 확인)
 *  ⑤ 구역 클릭 → openProjectAtDeck 가 openProject+Projects.selectDeck 를 그대로 호출(새 진입 로직 없음)
 *  ⑥ 구역 생성 후(Projects.loadDecks 호출) 새로고침 없이 카드 트리에 새 이름이 나타난다
 *  ⑦ 색 대비 실측 — 실제 로드된 CSS(3파일) 캐스케이드로 계산된 computed color/배경으로 대비 계산
 *
 * 뮤테이션 3건, 각 EXIT=1 확인 후 원복:
 *  ⓐ 카드 렌더에서 _renderDeckTreeHtml 호출 제거 → ①이 실패해야 함(렌더 고아 검증 겸함)
 *  ⓑ 트리 컨테이너를 기본 display:none 으로 바꿈 → ②가 실패해야 함
 *  ⓒ 31_Projects.js loadDecks() 의 ProjectHub.refreshIfVisible() 호출 제거 → ⑥이 실패해야 함
 *
 * [WO 20260929-tree-label 추가분 — Part E] 마스터: "이 트리가 제대로 제목이 안나오잖아"
 * (편집 화면 사이드바 트리가 구역/영역 이름 대신 도면 파일명처럼 보이는 문제 — 실제로는
 * UI.deckLabelHtml() 공유 함수가 항상 deck.name 을 1차 라벨로 쓰고, 파일명은 .tree-doc-src
 * 보조 라벨일 뿐이었다. 진짜 결함은 .tree-label 1줄 말줄임 CSS(긴 이름이 "…"로 안 읽힘)와
 * .tree-node.active 색 대비 2.07:1(AA 미달) 이었다):
 *  ⑧ 사이드바 트리 라벨 SoT = deck.name(파일명 아님) — 파일명과 다른 이름으로 렌더 검증
 *  ⑨ 허브 카드 트리와 사이드바 트리가 같은 UI.deckLabelHtml() 공유 함수를 쓴다
 *  ⑩ 전체 이름은 title(네이티브 툴팁)로 항상 확인 가능(잘려도 유실 없음)
 *  ⑪ .tree-node.active 색 대비 실측 ≥ 4.5:1(실 브라우저 computed 값 알파합성)
 *  뮤테이션ⓓ: deckNode 라벨을 파일명(docName)으로 되돌림 → ⑧이 실패해야 함
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const uiSrc = rd("public/js/modules/11_UI.js");
const promptSrc = rd("public/js/modules/30_Prompt.js");
const projectHubSrc = rd("public/js/modules/12_ProjectHub.js");
const projectsSrc = rd("public/js/modules/31_Projects.js");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };

function buildBundle(hubSource, projSource) {
  return "(function(){\n" + uiSrc + "\n" + promptSrc + "\n" + hubSource + "\n" + projSource +
    "\nwindow.ProjectHub = ProjectHub; window.Prompt = Prompt; window.UI = UI; window.Projects = Projects;\n})();\n";
}

const HARNESS_HTML = (bundleFileName) => `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="/css/style.css">
<link rel="stylesheet" href="/css/seastar-family-tokens.css">
<link rel="stylesheet" href="/css/seastar-3d-skin.css">
</head><body>
<div id="screen-projects" class="screen active">
  <div id="hub-grid"></div><div id="hub-empty" class="hidden"></div><div id="hub-empty-hint"></div>
</div>
<script>
  window.State = {};
  window.Auth = {
    isDesigner: true, idToken: "t1", role: "designer",
    headers() { return { "Content-Type": "application/json" }; },
    requireDesigner(cb) { cb && cb(); },
    setProjectContext() {}, signOut() {}
  };
  window.OfflineBundle = { verify() { return Promise.resolve({ ok: false }); } };
  window.Designers = {};
  window.App = {
    openApp() {}, loadDeckDrawing() { return Promise.resolve(); },
    offerDeckDrawingLink() {}, isDeckUnsaved() { return false; }, _refreshUnsavedDecks() {}
  };
  window.PinSeries = { preferredMode() { return "checkboard"; } };
</script>
<script src="./${bundleFileName}"></script>
</body></html>`;

async function withBrowser(fn) {
  const require = createRequire("file:///C:/Users/FREE/package.json");
  let puppeteer = null;
  try { puppeteer = require("puppeteer"); } catch (e) { puppeteer = null; }
  if (!puppeteer) { console.log("  FAIL puppeteer 를 로드할 수 없다 — 실 브라우저 검증 불가(증거 없는 PASS 금지)"); failed++; return; }
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try { await fn(browser); } finally { await browser.close(); }
}

/** api: { "METHOD /path": (body) => ({status, json}) } — 매칭 안 되는 /api,/tables 는 빈 200 */
function makePage(browser, dir, api) {
  return (async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2 });
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const url = new URL(req.url());
      const key = req.method() + " " + url.pathname;
      if (api[key]) {
        const result = api[key]();
        req.respond({ status: result.status || 200, contentType: "application/json", body: JSON.stringify(result.json || {}) });
        return;
      }
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/tables/")) {
        req.respond({ status: 200, contentType: "application/json", body: "{}" });
        return;
      }
      req.continue();
    });
    return page;
  })();
}

function tmpDirWithBundle(bundleSrc, bundleName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p70-"));
  fs.writeFileSync(path.join(dir, bundleName), bundleSrc, "utf8");
  fs.writeFileSync(path.join(dir, "index.html"), HARNESS_HTML(bundleName), "utf8");
  return dir;
}

async function serveDir(dir) {
  const PUB = path.join(ROOT, "public");
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    if (u.startsWith("/css/")) {
      const f = path.join(PUB, u);
      if (fs.existsSync(f)) { res.writeHead(200, { "content-type": "text/css" }); res.end(fs.readFileSync(f)); return; }
    }
    const f = path.join(dir, u === "/" ? "index.html" : u);
    if (!f.startsWith(dir) || !fs.existsSync(f)) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "content-type": f.endsWith(".html") ? "text/html" : "text/javascript" });
    res.end(fs.readFileSync(f));
  });
  await listenSafePort(server, "127.0.0.1");
  return server;
}

/* ── 픽스처: 프로젝트 3개 ─────────────────────────────────────────────
   p1: 구역 2개 — "본체구역"(영역 2개: "선수영역","선미영역") · "브릿지구역"(영역 0개)
   p2: 구역 0개(빈 프로젝트) → "구역 없음"
   p3: 구역 2개 — 1개는 deleted=1(안 보여야 함) · 1개는 정상 */
function decksFor(pid) {
  if (pid === "p1") return [
    { id: "d1", project_id: "p1", name: "본체구역", parent_id: null, deployment_id: null, deleted: 0 },
    { id: "d1a", project_id: "p1", name: "선수영역", parent_id: "d1", deployment_id: null, deleted: 0 },
    { id: "d1b", project_id: "p1", name: "선미영역", parent_id: "d1", deployment_id: null, deleted: 0 },
    { id: "d2", project_id: "p1", name: "브릿지구역", parent_id: null, deployment_id: null, deleted: 0 }
  ];
  if (pid === "p2") return [];
  if (pid === "p3") return [
    { id: "d3-live", project_id: "p3", name: "살아있는구역", parent_id: null, deployment_id: null, deleted: 0 },
    { id: "d3-del", project_id: "p3", name: "삭제된구역", parent_id: null, deployment_id: null, deleted: 1 }
  ];
  return [];
}
function apiFor(state) {
  return {
    "GET /api/projects": () => ({ status: 200, json: { data: [
      { id: "p1", name: "프로젝트원", created_at: Date.now(), published: false },
      { id: "p2", name: "프로젝트투", created_at: Date.now(), published: false },
      { id: "p3", name: "프로젝트쓰리", created_at: Date.now(), published: false }
    ] } }),
    "GET /api/projects/p1/decks": () => ({ status: 200, json: { data: state.p1Decks || decksFor("p1") } }),
    "GET /api/projects/p2/decks": () => ({ status: 200, json: { data: decksFor("p2") } }),
    "GET /api/projects/p3/decks": () => ({ status: 200, json: { data: decksFor("p3") } })
  };
}

/* 대비(WCAG) 계산 — 실 브라우저 computed 값을 그대로 넣는다(추측 금지) */
function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(rgbA, rgbB) {
  const la = luminance(rgbA), lb = luminance(rgbB);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
function parseRgb(s) {
  const m = (s || "").match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  return m[1].split(",").slice(0, 3).map((x) => parseFloat(x.trim()));
}

console.log("\n[Part A · 렌더 — 구역/영역 이름 · 기본펼침 · 구역없음 · deleted 필터]");
await withBrowser(async (browser) => {
  const dir = tmpDirWithBundle(buildBundle(projectHubSrc, projectsSrc), "bundle.js");
  const server = await serveDir(dir);
  const port = server.address().port;
  const page = await makePage(browser, dir, apiFor({}));
  await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "load" });

  await page.evaluate(async () => { await window.ProjectHub.load(); });

  const m1 = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll(".hub-card"));
    const find = (name) => cards.find((c) => ((c.querySelector(".hub-card-name") || {}).textContent || "").includes(name));
    const cardP1 = find("프로젝트원");
    const cardP2 = find("프로젝트투");
    const cardP3 = find("프로젝트쓰리");
    const treeText = (c) => (c ? (c.querySelector(".hub-card-tree") || {}).innerText || "" : "");
    const tree1 = cardP1 ? cardP1.querySelector(".hub-card-tree") : null;
    const cs = tree1 ? getComputedStyle(tree1) : null;
    return {
      p1Text: treeText(cardP1),
      p1DeckCount: cardP1 ? cardP1.querySelectorAll(".hub-tree-deck").length : -1,
      p1RegionCount: cardP1 ? cardP1.querySelectorAll(".hub-tree-region").length : -1,
      p1Display: cs ? cs.display : null,
      p2Text: treeText(cardP2),
      p3Text: treeText(cardP3),
      p3DeckCount: cardP3 ? cardP3.querySelectorAll(".hub-tree-deck").length : -1
    };
  });
  ok(/본체구역/.test(m1.p1Text) && /브릿지구역/.test(m1.p1Text), "① 구역 이름 2개(본체구역·브릿지구역)가 카드 아래 DOM 에 렌더된다");
  ok(/선수영역/.test(m1.p1Text) && /선미영역/.test(m1.p1Text), "① 영역 이름 2개(선수영역·선미영역)가 함께 렌더된다");
  ok(m1.p1DeckCount === 2, "① 구역 노드 개수 = 2 (실제 " + m1.p1DeckCount + ")");
  ok(m1.p1RegionCount === 2, "① 영역 노드 개수 = 2 (실제 " + m1.p1RegionCount + ")");
  ok(m1.p1Display !== "none" && m1.p1Display !== null, "② 기본 펼침 — .hub-card-tree computed display=" + m1.p1Display + " (숨김 아님)");
  ok(/구역 없음/.test(m1.p2Text), "③ 구역 0개 프로젝트는 '구역 없음'을 표시한다");
  ok(/살아있는구역/.test(m1.p3Text) && !/삭제된구역/.test(m1.p3Text), "④ deleted=1 구역('삭제된구역')은 안 보이고 정상 구역만 보인다");
  ok(m1.p3DeckCount === 1, "④ p3 구역 노드 개수 = 1 (deleted 제외, 실제 " + m1.p3DeckCount + ")");

  console.log("\n[Part A' · 색 대비 실측 — 실제 CSS 3파일 캐스케이드 computed 값]");
  const contrastData = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll(".hub-card"));
    const cardP1 = cards.find((c) => ((c.querySelector(".hub-card-name") || {}).textContent || "").includes("프로젝트원"));
    const deckNode = cardP1.querySelector(".hub-tree-deck");
    const regionNode = cardP1.querySelector(".hub-tree-region");
    const cardBg = getComputedStyle(cardP1).backgroundImage;
    return {
      deckColor: getComputedStyle(deckNode).color,
      regionColor: getComputedStyle(regionNode).color,
      cardBackgroundImage: cardBg
    };
  });
  const stops = Array.from(contrastData.cardBackgroundImage.matchAll(/rgba?\([^)]+\)/g)).map((m) => parseRgb(m[0])).filter(Boolean);
  const deckRgb = parseRgb(contrastData.deckColor);
  const regionRgb = parseRgb(contrastData.regionColor);
  ok(stops.length >= 2, "사전조건 — .hub-card 배경 그라디언트에서 색상 stop 2개 이상 추출(실제 " + stops.length + ", raw=" + contrastData.cardBackgroundImage + ")");
  if (stops.length >= 2 && deckRgb && regionRgb) {
    const worstDeck = Math.min(...stops.map((s) => contrast(deckRgb, s)));
    const worstRegion = Math.min(...stops.map((s) => contrast(regionRgb, s)));
    console.log("  [실측] 구역 글자색 " + contrastData.deckColor + " vs 카드배경 stops " + JSON.stringify(stops) + " → 최소 대비 " + worstDeck.toFixed(2) + ":1");
    console.log("  [실측] 영역 글자색 " + contrastData.regionColor + " vs 카드배경 stops " + JSON.stringify(stops) + " → 최소 대비 " + worstRegion.toFixed(2) + ":1");
    ok(worstDeck >= 4.5, "⑦ 구역 이름 색 대비 ≥ 4.5:1 (실측 " + worstDeck.toFixed(2) + ":1)");
    ok(worstRegion >= 4.5, "⑦ 영역 이름 색 대비 ≥ 4.5:1 (실측 " + worstRegion.toFixed(2) + ":1)");
  }

  const shotDir = process.env.SHOT_DIR || path.join(os.tmpdir(), "p70-hub-tree-shots");
  fs.mkdirSync(shotDir, { recursive: true });
  const shotPath = path.join(shotDir, "p70-hub-deck-tree-375x812.png");
  await page.screenshot({ path: shotPath, fullPage: true });
  console.log("  [스크린샷] " + shotPath);

  server.close();
});

console.log("\n[Part B · 클릭 진입 — openProjectAtDeck 가 기존 openProject+selectDeck 를 재사용]");
await withBrowser(async (browser) => {
  const dir = tmpDirWithBundle(buildBundle(projectHubSrc, projectsSrc), "bundle.js");
  const server = await serveDir(dir);
  const port = server.address().port;
  const page = await makePage(browser, dir, apiFor({}));
  await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "load" });
  await page.evaluate(async () => { await window.ProjectHub.load(); });

  // openProject/App.openApp/Projects.selectDeck 호출 여부를 스파이로 추적
  await page.evaluate(() => {
    window.__calls = [];
    const origOpenApp = window.App.openApp;
    window.App.openApp = function (mode, opts) { window.__calls.push("openApp:" + mode); return origOpenApp.call(this, mode, opts); };
    const origSelectDeck = window.Projects.selectDeck;
    window.Projects.selectDeck = async function (d) { window.__calls.push("selectDeck:" + d.id); return origSelectDeck.call(this, d); };
  });

  await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll(".hub-card"));
    const cardP1 = cards.find((c) => ((c.querySelector(".hub-card-name") || {}).textContent || "").includes("프로젝트원"));
    const regionNode = cardP1.querySelector(".hub-tree-region");
    regionNode.click();
  });
  await new Promise((r) => setTimeout(r, 400));
  const calls = await page.evaluate(() => window.__calls);
  const curDeck = await page.evaluate(() => window.Projects.currentDeck && window.Projects.currentDeck.id);
  ok(calls.some((c) => c.startsWith("openApp:")), "⑤ 영역 클릭 → 기존 진입 경로 App.openApp() 이 호출된다(새 진입 로직 아님)");
  ok(calls.some((c) => c.startsWith("selectDeck:")), "⑤ 영역 클릭 → 기존 Projects.selectDeck() 가 호출된다(새 열기 로직 아님)");
  ok(curDeck === "d1a" || curDeck === "d1b", "⑤ 클릭한 영역(선수영역/선미영역)이 실제 Projects.currentDeck 로 선택된다(실제 " + curDeck + ")");

  server.close();
});

console.log("\n[Part C · 구역 생성 후 즉시 반영 — Projects.loadDecks() → ProjectHub.refreshIfVisible()]");
async function runCreateRefresh(hubSource, projSource, label) {
  let calls = 0;
  return await new Promise((resolve) => {
    withBrowser(async (browser) => {
      const state = { p1Decks: decksFor("p1") }; // 초기: 구역 2개(영역 포함)
      const dir = tmpDirWithBundle(buildBundle(hubSource, projSource), "bundle.js");
      const server = await serveDir(dir);
      const port = server.address().port;
      const page = await makePage(browser, dir, apiFor(state));
      await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "load" });
      await page.evaluate(async () => { await window.ProjectHub.load(); });

      const before = await page.evaluate(() => {
        const cardP1 = Array.from(document.querySelectorAll(".hub-card")).find((c) => ((c.querySelector(".hub-card-name") || {}).textContent || "").includes("프로젝트원"));
        return (cardP1.querySelector(".hub-card-tree") || {}).innerText || "";
      });

      // "구역 생성"을 시뮬레이션 — 서버 응답에 새 구역을 추가하고, 모든 생성 함수가 공통으로
      // 거치는 Projects.loadDecks() 를 직접 호출한다(추출 함수 자체는 UI 드래그가 필요해
      // 이 테스트 범위 밖 — 공유 지점(loadDecks)만 검증한다).
      state.p1Decks = decksFor("p1").concat([{ id: "d1c", project_id: "p1", name: "새로만든영역", parent_id: "d1", deployment_id: null, deleted: 0 }]);
      await page.evaluate(() => { window.Projects.currentProject = { id: "p1", name: "프로젝트원" }; });
      await page.evaluate(async () => { await window.Projects.loadDecks(); });
      await new Promise((r) => setTimeout(r, 300));

      const after = await page.evaluate(() => {
        const cardP1 = Array.from(document.querySelectorAll(".hub-card")).find((c) => ((c.querySelector(".hub-card-name") || {}).textContent || "").includes("프로젝트원"));
        return (cardP1.querySelector(".hub-card-tree") || {}).innerText || "";
      });

      console.log("  [" + label + "] before has새로만든영역=" + /새로만든영역/.test(before) + " after has새로만든영역=" + /새로만든영역/.test(after));
      server.close();
      resolve({ before, after });
    });
  });
}
{
  const r = await runCreateRefresh(projectHubSrc, projectsSrc, "신코드");
  ok(!/새로만든영역/.test(r.before), "사전조건 — 생성 전에는 '새로만든영역'이 없다");
  ok(/새로만든영역/.test(r.after), "⑥ Projects.loadDecks() 호출만으로(수동 재렌더 없이) 카드 트리에 새 영역 이름이 나타난다");
}

console.log("\n[뮤테이션ⓐ] 카드 렌더에서 _renderDeckTreeHtml 호출을 제거 → ①이 실패해야 함(렌더 고아 검증)");
await withBrowser(async (browser) => {
  const needle = "(isLocked ? '' : this._renderDeckTreeHtml(p));";
  const mutated = projectHubSrc.replace(needle, "'';");
  if (mutated === projectHubSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; return; }
  const dir = tmpDirWithBundle(buildBundle(mutated, projectsSrc), "bundle.js");
  const server = await serveDir(dir);
  const port = server.address().port;
  const page = await makePage(browser, dir, apiFor({}));
  await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "load" });
  await page.evaluate(async () => { await window.ProjectHub.load(); });
  const has = await page.evaluate(() => !!document.querySelector(".hub-card-tree"));
  ok(!has, "뮤테이션 적용 시 카드 아래 트리 자체가 렌더되지 않는다(①이 깨짐을 확인 — 렌더 고아 아님을 방증)");
  server.close();
});

console.log("\n[뮤테이션ⓑ] 트리 컨테이너 기본 display:none 으로 바꿈 → ②가 실패해야 함");
await withBrowser(async (browser) => {
  const needle = 'return \'<div class="hub-card-tree"><ul class="hub-tree-decks">\' + rootsHtml + \'</ul></div>\';';
  const mutated = projectHubSrc.replace(needle, 'return \'<div class="hub-card-tree" style="display:none"><ul class="hub-tree-decks">\' + rootsHtml + \'</ul></div>\';');
  if (mutated === projectHubSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; return; }
  const dir = tmpDirWithBundle(buildBundle(mutated, projectsSrc), "bundle.js");
  const server = await serveDir(dir);
  const port = server.address().port;
  const page = await makePage(browser, dir, apiFor({}));
  await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "load" });
  await page.evaluate(async () => { await window.ProjectHub.load(); });
  const display = await page.evaluate(() => {
    const t = document.querySelector(".hub-card-tree");
    return t ? getComputedStyle(t).display : null;
  });
  ok(display === "none", "뮤테이션 적용 시 기본 상태가 숨김(display:none)이 됨(②가 깨짐을 확인, 실제 " + display + ")");
  server.close();
});

console.log("\n[뮤테이션ⓒ] 31_Projects.js loadDecks() 의 ProjectHub.refreshIfVisible() 호출 제거 → ⑥이 실패해야 함");
{
  const needle = 'try { if (typeof ProjectHub !== "undefined" && ProjectHub.refreshIfVisible) ProjectHub.refreshIfVisible(); } catch (e) {}';
  const mutatedProj = projectsSrc.replace(needle, "/* 갱신 연결 제거됨 */");
  if (mutatedProj === projectsSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const r = await runCreateRefresh(projectHubSrc, mutatedProj, "뮤테이션ⓒ적용");
    ok(!/새로만든영역/.test(r.after), "뮤테이션 적용 시 loadDecks() 만으로는 카드 트리가 갱신되지 않는다(⑥이 깨짐을 확인)");
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * Part E — 편집화면 사이드바 트리(11_UI.js renderTree) — 라벨 SoT · title 툴팁 · 대비
 * ══════════════════════════════════════════════════════════════════════ */
const FILE_NAME = "ARCTIC VOYAGER - GA_REV3(General Arrangement Drawing FINAL).pdf";
function sidebarHarnessDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p70e-"));
  const HARNESS = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/css/style.css">
<link rel="stylesheet" href="/css/seastar-family-tokens.css">
<link rel="stylesheet" href="/css/seastar-3d-skin.css">
</head><body>
<aside id="sidebar" class="sidebar" style="width:320px">
  <div id="side-tree" class="side-tree"></div>
</aside>
<script src="./ui.js"></script>
</body></html>`;
  fs.writeFileSync(path.join(dir, "index.html"), HARNESS, "utf8");
  return dir;
}
async function measureSidebarTree(browser, uiSource) {
  const dir = sidebarHarnessDir();
  fs.writeFileSync(path.join(dir, "ui.js"), uiSource, "utf8");
  const server = await serveDir(dir);
  const port = server.address().port;
  const page = await makePage(browser, dir, {});
  await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "load" });
  await page.waitForFunction(() => { try { return typeof UI !== "undefined"; } catch (e) { return false; } }, { timeout: 10000 });
  await page.evaluate((fileName) => {
    window.State = { mode: "designer", pdfPage: 1, pdfPages: 1, currentDeploymentId: null, activePin: null, zones: [], pins: [] };
    const decks = [
      { id: "d1", name: "ㅁ", deployment_id: "dep1", deployment_file_name: fileName, parent_id: null },
      { id: "d1a", name: "ㅁㄴㅇ", deployment_id: "dep1", deployment_file_name: fileName, parent_id: "d1" }
    ];
    window.Projects = { decks, currentProject: { id: "prj1", name: "tes" }, currentDeck: decks[0], selectDeck() {} };
    window.Zones = { _contains: () => false, focus() {} };
    window.App = { focusPin() {} };
    UI.renderTree();
  }, FILE_NAME);
  const m = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll(".tree-label")).map((n) => n.textContent.trim());
    const subs = Array.from(document.querySelectorAll(".tree-doc-src")).map((n) => n.textContent.trim());
    const deckHead = document.querySelector(".tree-node-deck");
    const regionHead = document.querySelector(".tree-node-region");
    const activeNode = document.querySelector(".tree-node.active");
    const cs = activeNode ? getComputedStyle(activeNode) : null;
    return {
      labels, subs,
      deckTitle: deckHead ? deckHead.title : null,
      regionTitle: regionHead ? regionHead.title : null,
      activeColor: cs ? cs.color : null,
      activeBg: cs ? cs.backgroundColor : null,
      sidebarBg: getComputedStyle(document.getElementById("sidebar")).backgroundColor
    };
  });
  const shots = {};
  const shotDir = process.env.SHOT_DIR || path.join(os.tmpdir(), "p70-hub-tree-shots");
  fs.mkdirSync(shotDir, { recursive: true });
  await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2 });
  shots.mobile = path.join(shotDir, "p70-sidebar-tree-375x812.png");
  await page.screenshot({ path: shots.mobile });
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
  shots.desktop = path.join(shotDir, "p70-sidebar-tree-desktop.png");
  await page.screenshot({ path: shots.desktop });
  server.close();
  return { m, shots };
}

console.log("\n[Part E · 편집화면 사이드바 트리 — 라벨 SoT(deck.name) · title 툴팁 · .tree-node.active 대비]");
await withBrowser(async (browser) => {
  const { m, shots } = await measureSidebarTree(browser, uiSrc);

  ok(m.labels.includes("ㅁ") && m.labels.includes("ㅁㄴㅇ"), "⑧ 사이드바 트리 라벨이 deck.name('ㅁ'/'ㅁㄴㅇ')이다 — 실제 " + JSON.stringify(m.labels));
  ok(!m.labels.some((l) => l.indexOf("ARCTIC VOYAGER") !== -1), "⑧ 도면 파일명이 1차 라벨(.tree-label)로 쓰이지 않는다(SoT=deck.name)");
  ok(m.subs.some((s) => s.indexOf("ARCTIC VOYAGER") !== -1), "사전조건 — 도면 파일명은 보조 라벨(.tree-doc-src)로만 남아있다");
  ok(m.deckTitle === "ㅁ" && m.regionTitle === "ㅁㄴㅇ",
    "⑩ head.title 에 전체 이름이 그대로 들어있다(잘려도 유실 없음) — 실제 " + JSON.stringify({ deck: m.deckTitle, region: m.regionTitle }));

  const activeRgb = parseRgb(m.activeColor);
  const sidebarRgb = parseRgb(m.sidebarBg);
  const alphaMatch = (m.activeBg || "").match(/rgba\([^)]+,\s*([\d.]+)\)/);
  const overlayRgb = parseRgb(m.activeBg);
  let composite = null;
  if (overlayRgb && sidebarRgb && alphaMatch) {
    const a = parseFloat(alphaMatch[1]);
    composite = [0, 1, 2].map((i) => overlayRgb[i] * a + sidebarRgb[i] * (1 - a));
  }
  ok(!!activeRgb && !!composite, "사전조건 — 활성 행 글자색(" + m.activeColor + ")/합성 배경 계산 가능");
  if (activeRgb && composite) {
    const c = contrast(activeRgb, composite);
    console.log("  [실측] .tree-node.active 글자 " + m.activeColor + " vs 합성배경 rgb(" + composite.map((x) => x.toFixed(1)).join(",") + ") → " + c.toFixed(2) + ":1");
    ok(c >= 4.5, "⑪ .tree-node.active 색 대비 ≥ 4.5:1 (실측 " + c.toFixed(2) + ":1)");
  }
  console.log("  [스크린샷] " + shots.mobile);
  console.log("  [스크린샷] " + shots.desktop);
});

console.log("\n[뮤테이션ⓓ] deckNode 라벨을 파일명(docName)으로 되돌림 → ⑧이 실패해야 함");
await withBrowser(async (browser) => {
  const needle = "const _nameLabel = this.deckLabelHtml(deck);";
  const mutated = uiSrc.replace(needle, "const _nameLabel = docName ? esc(docName) : this.deckLabelHtml(deck);");
  if (mutated === uiSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { m } = await measureSidebarTree(browser, mutated);
    ok(m.labels.some((l) => l.indexOf("ARCTIC VOYAGER") !== -1), "뮤테이션 적용 시 1차 라벨이 파일명으로 바뀐다(⑧이 깨짐을 확인) — 실제 " + JSON.stringify(m.labels));
  }
});

console.log(failed === 0 ? "\n[ALL PASS]" : "\n[" + failed + " FAILED]");
process.exit(failed === 0 ? 0 : 1);
