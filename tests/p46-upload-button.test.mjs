/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p46-upload-button.test.mjs)
 *
 * 마스터 원문(2026-09-18): "업로드 버튼을 만들어 보이게 하되, 없다면 비활성이고
 * 업데이트할 게 있다면 활성화해야지" — 기존 #sync-badge(topbar)는 대기=0(온라인)일 때
 * hidden 클래스가 그대로 남아 완전히 사라지는 결함이 있었다(20_App.js _updateSyncBadge
 * 온라인+대기0 분기가 "hidden" 을 remove 하지 않음). 모바일 하단 독(.mobile-dock)에
 * 항상 렌더되는 #mdock-upload 칩을 신설해 같은 로직(syncNow/OpLog)을 재사용한다.
 *
 *  ① 대기 0 → 버튼이 보이고 disabled
 *  ② 대기 N>0 → 활성 + 건수 표시
 *  ③ 클릭 시 기존 syncNow() 를 호출한다(새 경로 0)
 *  ④ 성공·실패 모두 사용자 알림이 있다(조용한 실패 0)
 *  ⑤ 375×812 에서 .mobile-dock(#mdock-upload 의 상위 컨테이너) 이 .pinfilter-bar/
 *     [data-help-toggle]/#btn-save 와 겹침 면적 0(CSS 값 파싱, 문자열 검사 금지) —
 *     #mdock-upload 는 .mdock-bar(=.mobile-dock 의 부분집합)의 평범한 flex 자식이라
 *     상위 사각형이 안 겹치면 부분집합도 안 겹친다(포함관계 증명 + 상위 사각형 실측).
 *  ⑥ 터치타깃 ≥44×44 (칩 개수로 나눈 실제 폭 × --mdock-h)
 *  ⑦ 프로젝트 안에서 다운로드 진입로가 존재한다(#btn-download-project)
 *  ⑧ 데스크톱 불변 — .mobile-dock 은 기본 display:none(미디어쿼리 밖에서만 렌더)
 *
 * 실제 소스(20_App.js/index.html/style.css/12_ProjectHub.js/31_Projects.js)를 그대로
 * 평가/파싱한다(목 구현 아님). ①②⑤ 에 뮤테이션 케이스가 붙는다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { findHelpToggleBottomRaw } from "./_lib/find-help-toggle-bottom.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const appSrc = rd("public/js/modules/20_App.js");
const syncSrc = rd("public/js/modules/05_SyncQueue.js");
const indexHtml = rd("public/index.html");
const styleCssRaw = rd("public/css/style.css");
const styleCss = styleCssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
const projectHubSrc = rd("public/js/modules/12_ProjectHub.js");
const projectsSrc = rd("public/js/modules/31_Projects.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};
// _updateSyncBadge() 는 내부 Promise.all(...).then() 을 반환하지 않는 fire-and-forget 구조라
// (실 코드 그대로) await 만으로는 완료를 못 잡는다 — 매크로태스크 한 틱을 흘려보내 대기한다.
const flush = () => new Promise((r) => setTimeout(r, 10));

// [WO 20260929-mobile] div 중첩 균형 추출 — openMarker(예: '<div class="mdock-bar">')
// 다음에 오는 자기 자신의 </div> 를 중첩 깊이로 정확히 찾는다. 기존 lazy 정규식
// (/<\/div>\s*\n\s*<\/nav>/) 은 형제 블록이 추가되면 그 형제까지 삼켜버려(비고의)
// R6 도크 재구성(메인바+#mdock-more-sheet 시트) 이후 chipCount 가 잘못 부풀었었다.
function extractDivBlock(src, openMarker) {
  const start = src.indexOf(openMarker);
  if (start < 0) throw new Error("marker not found: " + openMarker);
  let i = start + openMarker.length;
  let depth = 1;
  while (depth > 0) {
    const nextOpen = src.indexOf("<div", i);
    const nextClose = src.indexOf("</div>", i);
    if (nextClose === -1) throw new Error("unbalanced div for " + openMarker);
    if (nextOpen !== -1 && nextOpen < nextClose) { depth++; i = nextOpen + 4; }
    else { depth--; i = nextClose + 6; }
  }
  return src.slice(start + openMarker.length, i - 6);
}

/* ══════════════════════════════════════════════════════════════════
 * 헬퍼 — App._updateSyncBadge()/syncNow() 를 실제 소스로 로드
 * ══════════════════════════════════════════════════════════════════ */
// [WO 20261006-photolink] ④(조용한 실패 0) 는 이제 App.syncNow → SyncQueue._onReconnect →
//   SyncQueue.noteSyncResult 라는 **공유 판정 1곳**에서 결정된다(§G-2-5). 따라서 SyncQueue 를
//   손으로 흉내내지 않고 **실제 소스(05_SyncQueue.js)** 를 같은 컨텍스트에 평가해 쓴다(목 축소).
//   node 에 없는 플랫폼 API(localStorage/fetch/window.indexedDB)만 메모리 대역.
function makeLS() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => Array.from(m.keys())[i],
           getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); },
           removeItem: (k) => { m.delete(k); } };
}
function makeAppSandbox(appSource, { sqCount = 0, opCount = 0, online = true, fetchThrows = false } = {}) {
  const registry = {};
  const el = (id) => (registry[id] = registry[id] || { classList: { add() {}, remove() {}, toggle() {} }, textContent: "", value: "", disabled: false, setAttribute() {} });
  const toastCalls = [];
  const sandbox = {
    console, JSON, Map, Set, Date, Math, Promise, setTimeout,
    navigator: { onLine: online },
    window: {},                                  // indexedDB 없음 → SyncQueue 의 localStorage 폴백
    localStorage: makeLS(),
    State: { pins: [], zones: [], annotations: [] },
    Cloud: { _cache: {} },
    Auth: { idToken: "tok", _offlineOnly: false, headers: () => ({}), canServerWrite() { return !this._offlineOnly && !!this.idToken; }, async refresh() {}, async classifyWriteFailure() { return null; } },
    fetch: async (url, init) => {
      if (fetchThrows) throw new Error("network");
      const body = JSON.parse((init && init.body) || "{}");
      const results = (body.ops || []).map((o) => ({ opId: o.opId, ok: true, id: "img_" + o.opId }));
      return { ok: true, status: 200, json: async () => ({ ok: true, results }) };
    },
    UI: { $: (id) => el(id) },
    OpLog: { pending: async () => Array.from({ length: opCount }) },
    // Offline.curDepId 가 있어야 opLogCount 분기가 OpLog.pending() 을 실제로 센다(실코드 그대로).
    Offline: { curDepId: () => (opCount > 0 ? "dep-test" : null) },
    Prompt: { toast: (t) => toastCalls.push(t) }
  };
  vm.createContext(sandbox);
  vm.runInContext(syncSrc + "\n" + appSource + "\n;globalThis.__App = App; globalThis.__SQ = SyncQueue;", sandbox);
  const SQ = sandbox.__SQ;
  // 실 큐에 대기 op 를 적립(배지 건수는 실 count() 가 센다 — 가짜 숫자 주입 아님)
  const seeded = (async () => { for (let i = 0; i < sqCount; i++) await SQ.enqueue({ kind: "image", name: "p" + i, image_data: "data:image/jpeg;base64,AAA" }); })();
  return { App: sandbox.__App, SQ, registry, toastCalls, seeded };
}

/* ══ ① 대기 0 → 보이고 disabled(+뮤테이션 — mdock-upload 업데이트 블록 제거) ══════ */
{
  const { App, registry, seeded } = makeAppSandbox(appSrc, { sqCount: 0, opCount: 0, online: true });
  await seeded;
  App._updateSyncBadge(); await flush();
  ok(registry["mdock-upload"].disabled === true, "① 대기 0 → #mdock-upload disabled=true, 실제 " + registry["mdock-upload"].disabled);
  ok(/업로드/.test(registry["mdock-upload-label"].textContent), "① 라벨에 '업로드' 글자가 보인다 → " + registry["mdock-upload-label"].textContent);

  console.log("\n[뮤테이션] #mdock-upload 갱신 블록을 제거하면 ①이 실패해야 함(버튼이 방치됨)");
  const needle = `        const mUp = UI.$("mdock-upload");
        if (mUp) {
          mUp.disabled = (n === 0);
          const label = UI.$("mdock-upload-label");
          if (label) label.textContent = n > 0 ? ("업로드 " + n) : "업로드";
          mUp.setAttribute("title", n > 0 ? ("대기 " + n + "건 — 눌러서 지금 업로드") : "업로드할 내용이 없습니다");
        }`;
  const mutated = appSrc.replace(needle, "        /* 제거됨 */");
  if (mutated === appSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { App: AppM, registry: regM, seeded: seededM } = makeAppSandbox(mutated, { sqCount: 3, opCount: 0, online: true });
    await seededM;
    AppM._updateSyncBadge(); await flush();
    const stillDefault = !regM["mdock-upload"] || regM["mdock-upload"].disabled !== false;
    ok(stillDefault, "뮤테이션 적용 시 대기 3건이어도 버튼 상태가 갱신 안 됨(①②가 깨짐) → " + (regM["mdock-upload"] ? ("disabled=" + regM["mdock-upload"].disabled) : "UI.$ 호출 자체가 없음"));
  }
}

/* ══ ② 대기 N>0 → 활성 + 건수 표시 ══════════════════════════════════════ */
{
  const { App, registry, seeded } = makeAppSandbox(appSrc, { sqCount: 2, opCount: 1, online: true });
  await seeded;
  App._updateSyncBadge(); await flush();
  ok(registry["mdock-upload"].disabled === false, "② 대기 3건 → disabled=false, 실제 " + registry["mdock-upload"].disabled);
  ok(registry["mdock-upload-label"].textContent === "업로드 3", "② 라벨에 건수 표시 → " + registry["mdock-upload-label"].textContent);
}

/* ══ ③ 클릭 시 기존 syncNow() 호출(새 경로 0) ══════════════════════════════ */
{
  ok(/UI\.\$\("mdock-upload"\)\s*;\s*\n\s*if \(mUp\) mUp\.addEventListener\("click", \(\) => this\.syncNow\(\)\);/.test(appSrc),
    "③ #mdock-upload 클릭 리스너가 this.syncNow() 를 그대로 호출한다(정적 확인)");
  const syncNowDefCount = (appSrc.match(/async syncNow\(\)/g) || []).length;
  ok(syncNowDefCount === 1, "③ syncNow() 정의가 1곳뿐(중복/새 경로 없음) → 실제 " + syncNowDefCount);
}

/* ══ ④ 성공·실패 모두 사용자 알림(조용한 실패 0) — syncNow() 실동작 ══════════════ */
{
  const { App, toastCalls, seeded } = makeAppSandbox(appSrc, { sqCount: 1, online: true });
  await seeded;
  await App.syncNow();
  ok(toastCalls.some((t) => /완료/.test(t)), "④a 업로드 성공 시 완료 토스트 → " + JSON.stringify(toastCalls));

  // [WO 20261006-photolink] 업로드 실패 = fetch 가 터지는 실제 상황(실 SyncQueue.flush 가
  //   failed 로 집계 → noteSyncResult 가 통보). 종전엔 SyncQueue 자체를 던지는 목으로 대체해
  //   "flush 가 throw" 라는, 실제로는 일어나지 않는 경로만 봤다.
  const { App: AppFail, toastCalls: toastCallsFail, SQ: sqFail, seeded: seededFail } =
    makeAppSandbox(appSrc, { sqCount: 1, online: true, fetchThrows: true });
  await seededFail;
  await AppFail.syncNow();
  ok(toastCallsFail.some((t) => /실패/.test(t)), "④b 업로드 실패 시 실패 토스트(조용한 실패 아님) → " + JSON.stringify(toastCallsFail));
  ok(!toastCallsFail.some((t) => /완료/.test(t)), "④b-2 실패인데 '완료'로 보고하지 않는다 → " + JSON.stringify(toastCallsFail));
  ok((await sqFail.count()) === 1, "④b-3 실패분은 큐에 보존(데이터 유실 0) → " + (await sqFail.count()));

  // 오프라인 클릭 — syncNow 자체가 이미 안내(기존 경로)
  const { App: AppOff, toastCalls: toastOff, seeded: seededOff } = makeAppSandbox(appSrc, { sqCount: 1, online: false });
  await seededOff;
  await AppOff.syncNow();
  ok(toastOff.some((t) => /오프라인/.test(t)), "④c 오프라인에서 클릭해도 조용히 무시되지 않고 안내 → " + JSON.stringify(toastOff));
}

/* ══ ⑤ 375×812 겹침 면적 0 (상위 컨테이너 포함관계 증명 + 실측) ══════════════════ */
{
  const VIEWPORT = { w: 375, h: 812 };
  function extractRootVars(css) {
    const vars = {};
    const re = /:root\s*\{([^}]*)\}/gs;
    let rm;
    while ((rm = re.exec(css))) {
      const dre = /--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
      let m;
      while ((m = dre.exec(rm[1]))) vars[m[1]] = m[2].trim();
    }
    return vars;
  }
  const ROOT_VARS = extractRootVars(styleCss);
  function resolveOnce(expr) {
    let changed = false;
    const out = expr.replace(/var\(\s*--([a-zA-Z0-9_-]+)\s*(?:,((?:[^()]|\([^()]*\))*))?\)/, (full, name, fb) => {
      changed = true;
      if (ROOT_VARS[name] !== undefined) return ROOT_VARS[name];
      if (fb !== undefined) return fb.trim();
      throw new Error("정의되지 않은 var(--" + name + ")");
    });
    if (changed) return out;
    return expr.replace(/env\(\s*safe-area-inset-bottom\s*(?:,([^()]*))?\)/, () => { changed = true; return "0px"; });
  }
  function resolveAll(expr) { let p = expr, c = resolveOnce(expr), g = 0; while (c !== p) { p = c; c = resolveOnce(c); if (++g > 30) throw new Error("루프 초과"); } return c; }
  function toPx(t) { t = t.trim(); if (/^0$/.test(t)) return 0; const m = t.match(/^(-?[\d.]+)px$/); if (m) return parseFloat(m[1]); throw new Error("px 아님: " + t); }
  function evalPx(raw) { const r = resolveAll(raw.trim()); const cm = r.match(/^calc\((.+)\)$/s); if (cm) return cm[1].split("+").map((s) => s.trim()).reduce((s, t) => s + toPx(t), 0); return toPx(r); }
  function findDecl(css, selRe, prop) {
    const blockRe = new RegExp(selRe + "\\s*\\{([^}]*)\\}", "gs");
    const propRe = new RegExp("(?:^|[;\\s])" + prop + "\\s*:\\s*([^;]+);");
    let m, found = null;
    while ((m = blockRe.exec(css))) { const pm = m[1].match(propRe); if (pm) { found = pm[1].trim(); break; } }
    if (found === null) throw new Error(`'${prop}' 선언 없음 (${selRe})`);
    return found.replace(/!important/g, "").trim();
  }
  function overlapArea(a, b) {
    const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return ox * oy;
  }

  // .mobile-dock 사각형(=#mdock-upload 의 상위 컨테이너) — p41-mobile-save-reachable.test.mjs 와 동일 공식
  const mdockH = evalPx(findDecl(styleCss, "\\.mdock-bar", "height"));
  const dockBorderTop = parseFloat(findDecl(styleCss, "\\.mobile-dock", "border-top"));
  const dockTotalH = mdockH + dockBorderTop;
  const mobileDockRect = { x: 0, y: VIEWPORT.h - dockTotalH, w: VIEWPORT.w, h: dockTotalH };

  // [WO 20260929-mobile R6] #mdock-upload 는 더 이상 .mdock-bar 의 직계가 아니라
  // #mdock-more-sheet(더보기 시트, ⊆ #mobile-dock)로 이관됐다(마스터: 메인 2개+더보기).
  // 포함관계는 #mobile-dock nav 전체를 기준으로 증명 — 20_App.js 배선이 querySelectorAll로
  // #mobile-dock 하위 전체를 찾으므로 이 포함관계가 실제 배선 유지의 필요조건이다.
  // #mobile-dock 은 <nav>(div 아님) — extractDivBlock 은 div 전용이라 </nav> 를 직접 찾는다
  // (이 nav 하위엔 중첩 <nav> 가 없어 첫 </nav> 가 곧 자기 자신의 닫는 태그다).
  const navStart = indexHtml.indexOf('<nav id="mobile-dock" class="mobile-dock" aria-label="모바일 도구 도크">');
  if (navStart < 0) throw new Error("#mobile-dock nav 를 찾지 못함(소스 변경?)");
  const navBlock = indexHtml.slice(navStart, indexHtml.indexOf("</nav>", navStart));
  ok(/id="mdock-upload"/.test(navBlock), "⑤a #mdock-upload 가 #mobile-dock(더보기 시트 경유) 안에 있다(포함관계)");
  const moreSheetBlock = extractDivBlock(indexHtml, '<div id="mdock-more-sheet" class="mdock-more-sheet">');
  ok(/id="mdock-upload"/.test(moreSheetBlock), "⑤a-2 #mdock-upload 가 #mdock-more-sheet 안에 있다(R6 이관 확인)");
  ok(!/#mdock-upload\s*\{[^}]*(position\s*:\s*(absolute|fixed)|margin-top\s*:\s*-)/.test(styleCss),
    "⑤b #mdock-upload 에 상위 박스를 벗어나는 절대배치/음수마진 규칙이 없다");

  // 상위 사각형(.mobile-dock)이 다른 고정 UI 와 겹치지 않음을 실측 — 겹치지 않으면 부분집합도 겹치지 않는다.
  const pfBlock = (() => {
    const re = /@media \(max-width:640px\), \(pointer:coarse\)\{([\s\S]*?)\n\}/g;
    let m; while ((m = re.exec(styleCss))) { if (m[1].includes(".pinfilter-bar{")) return m[1]; } return null;
  })();
  if (!pfBlock) throw new Error(".pinfilter-bar 모바일 미디어 블록을 찾지 못함");
  const pfBottom = evalPx(findDecl(pfBlock, "\\.pinfilter-bar", "bottom"));
  const pfH = evalPx(ROOT_VARS["pinfilter-h-mobile"]);
  const pinfilterBarRect = { x: 0, y: VIEWPORT.h - pfBottom - pfH, w: VIEWPORT.w, h: pfH };
  ok(overlapArea(mobileDockRect, pinfilterBarRect) === 0,
    "⑤c .mobile-dock ∩ .pinfilter-bar = 0 → dock=" + JSON.stringify(mobileDockRect) + " pf=" + JSON.stringify(pinfilterBarRect));

  // [WO 20261002-gap 재발주] 공유 헬퍼(tests/_lib/find-help-toggle-bottom.mjs,
  // p34·p41·p47·p49 와 공용) — 4073788 이후 [data-help-toggle] 가 쉼표 그룹 중간 항목이다.
  const helpBottomRaw = findHelpToggleBottomRaw(styleCss);
  if (helpBottomRaw === null) throw new Error("[data-help-toggle] 모바일 규칙을 찾지 못함");
  const helpBottom = evalPx(helpBottomRaw);
  const helpToggleRect = { x: 16, y: VIEWPORT.h - helpBottom - 40, w: 40, h: 40 };
  ok(overlapArea(mobileDockRect, helpToggleRect) === 0,
    "⑤d .mobile-dock ∩ [data-help-toggle] = 0 → helpRect=" + JSON.stringify(helpToggleRect));

  console.log("  ⇒ 상시 노출되는 .mdock-bar 는 위 겹침이 전부 0. #mdock-upload 는 기본 상태(#mdock-more-sheet 접힘, " +
    "display:none)에선 렌더조차 안 되어 겹침 자체가 없고, 더보기를 펼친 순간엔 사이드바 시트와 같은 " +
    "의도된 임시 오버레이(z-index:141)로 다른 UI 위에 뜨는 것이 정상 동작이다(모달과 동일 패턴).");
}

/* ══ ⑥ 터치타깃 ≥44×44 ══════════════════════════════════════════════════
 * [WO 20260929-mobile R6] 도크가 2단으로 갈라졌다 — 상시 노출 메인바(.mdock-bar,
 * 4칩: 메뉴/포인트/사진등록/더보기) + 탭해야 뜨는 더보기 시트(#mdock-more-sheet,
 * 6칩: 보기/편집/페이지/주석/목록/업로드, 3열 그리드). 두 구역을 각자의 실제 레이아웃
 * 공식으로 따로 측정한다(예전처럼 "10칩을 375px에 균등분배"로 뭉뚱그리면 실제 레이아웃과
 * 어긋난다 — 메인바는 4칩/375px, 시트는 6칩/3열/(375-좌우여백)px). */
{
  const barBlock = extractDivBlock(indexHtml, '<div class="mdock-bar">');
  const chipCount = (barBlock.match(/class="mdock-chip[^"]*"/g) || []).length;
  ok(chipCount >= 1, "사전조건 — .mdock-bar 안 칩 개수 파싱됨 → " + chipCount);
  const mdockHForTarget = (() => {
    const blockRe = /\.mdock-bar\s*\{([^}]*)\}/gs;
    let m, found = null;
    while ((m = blockRe.exec(styleCss))) { const pm = m[1].match(/height\s*:\s*([^;]+);/); if (pm) { found = pm[1].trim(); break; } }
    return found;
  })();
  const ROOT_VARS2 = (() => {
    const vars = {}; const re = /:root\s*\{([^}]*)\}/gs; let rm;
    while ((rm = re.exec(styleCss))) { const dre = /--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g; let m; while ((m = dre.exec(rm[1]))) vars[m[1]] = m[2].trim(); }
    return vars;
  })();
  const mdockHVal = /var\(--mdock-h\)/.test(mdockHForTarget) ? parseFloat(ROOT_VARS2["mdock-h"]) : parseFloat(mdockHForTarget);
  const viewerChipCount = chipCount - (barBlock.match(/designer-only/g) || []).length; // designer-only 칩은 뷰어에서 숨김
  const widthDesigner = 375 / chipCount;
  const widthViewer = 375 / Math.max(1, viewerChipCount);
  ok(mdockHVal >= 44, "⑥a .mdock-bar 높이(=칩 높이) ≥44px, 실제 " + mdockHVal);
  ok(widthDesigner >= 44, "⑥b 메인 도크 칩 " + chipCount + "개 균등폭 ≥44px, 실제 " + widthDesigner.toFixed(1));
  ok(widthViewer >= 44, "⑥c 뷰어 모드 메인 칩 " + viewerChipCount + "개 균등폭 ≥44px, 실제 " + widthViewer.toFixed(1));

  // 더보기 시트 — grid-template-columns 열 수 + left/right 여백으로 열 폭을, .mdock-chip
  // min-height 선언으로 칩 높이를 각각 CSS 원문에서 파싱(하드코딩 없음).
  const sheetBlock = extractDivBlock(indexHtml, '<div id="mdock-more-sheet" class="mdock-more-sheet">');
  const sheetChipCount = (sheetBlock.match(/class="mdock-chip[^"]*"/g) || []).length;
  ok(sheetChipCount >= 1, "사전조건 — #mdock-more-sheet 안 칩 개수 파싱됨 → " + sheetChipCount);
  // .mdock-more-sheet 규칙은 2군데(데스크톱 기본 display:none · 모바일 미디어쿼리 내부 실 레이아웃)
  // — grid-template-columns 를 가진 쪽(모바일 실 레이아웃)을 찾는다.
  const sheetRuleRe = /\.mdock-more-sheet\s*\{([^}]*)\}/g;
  let sheetRuleBody = null, srm;
  while ((srm = sheetRuleRe.exec(styleCss))) { if (/grid-template-columns/.test(srm[1])) { sheetRuleBody = srm[1]; break; } }
  if (!sheetRuleBody) throw new Error(".mdock-more-sheet 의 모바일 레이아웃 규칙(grid-template-columns)을 찾지 못함");
  const sheetCols = parseInt((sheetRuleBody.match(/grid-template-columns\s*:\s*repeat\((\d+)/) || [])[1] || "0", 10);
  const sheetLeft = parseFloat((sheetRuleBody.match(/left\s*:\s*([\d.]+)px/) || [])[1] || "0");
  const sheetRight = parseFloat((sheetRuleBody.match(/right\s*:\s*([\d.]+)px/) || [])[1] || "0");
  ok(sheetCols >= 1, "사전조건 — #mdock-more-sheet 그리드 열 수 파싱됨 → " + sheetCols);
  const widthSheetCol = (375 - sheetLeft - sheetRight) / sheetCols;
  const sheetChipMinHRaw = (styleCss.match(/\.mdock-more-sheet\s+\.mdock-chip\s*\{([^}]*)\}/) || [])[1] || "";
  const sheetChipMinH = parseFloat((sheetChipMinHRaw.match(/min-height\s*:\s*([\d.]+)px/) || [])[1] || "0");
  ok(widthSheetCol >= 44, "⑥d 더보기 시트 칩(" + sheetCols + "열) 균등폭 ≥44px, 실제 " + widthSheetCol.toFixed(1));
  ok(sheetChipMinH >= 44, "⑥e 더보기 시트 칩 높이(min-height) ≥44px, 실제 " + sheetChipMinH);
}

/* ══ ⑦ 프로젝트 안 다운로드 진입로 존재 ══════════════════════════════════ */
{
  ok(/id="btn-download-project"/.test(indexHtml), "⑦a #btn-download-project 가 index.html 에 존재");
  ok(/downloadProject/.test(projectHubSrc), "⑦b 12_ProjectHub.js 에 downloadProject() 정본이 있다");
  ok(/ProjectHub\.downloadProject/.test(projectsSrc), "⑦c 31_Projects.js 가 그 정본을 재사용(새 함수 없음)");
}

/* ══ ⑧ 데스크톱 불변 — .mobile-dock 기본 display:none ══════════════════════ */
{
  ok(/\.mobile-nav,\s*\.mobile-dock\s*\{\s*display:\s*none;?\s*\}/.test(styleCssRaw),
    "⑧ .mobile-dock 기본(미디어쿼리 밖) display:none — 데스크톱에서 렌더되지 않는다");
}

console.log(failed === 0 ? "\n[ALL PASS]" : "\n[" + failed + " FAILED]");
process.exit(failed === 0 ? 0 : 1);
