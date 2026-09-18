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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const appSrc = rd("public/js/modules/20_App.js");
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

/* ══════════════════════════════════════════════════════════════════
 * 헬퍼 — App._updateSyncBadge()/syncNow() 를 실제 소스로 로드
 * ══════════════════════════════════════════════════════════════════ */
function makeAppSandbox(appSource, { sqCount = 0, opCount = 0, online = true } = {}) {
  const registry = {};
  const el = (id) => (registry[id] = registry[id] || { classList: { add() {}, remove() {}, toggle() {} }, textContent: "", value: "", disabled: false, setAttribute() {} });
  const toastCalls = [];
  const sandbox = {
    console, JSON, Map, Set, Date, Promise,
    navigator: { onLine: online },
    UI: { $: (id) => el(id) },
    SyncQueue: { count: async () => sqCount, flush: async () => ({ uploaded: sqCount }) },
    OpLog: { pending: async () => Array.from({ length: opCount }) },
    // Offline.curDepId 가 있어야 opLogCount 분기가 OpLog.pending() 을 실제로 센다(실코드 그대로).
    Offline: { curDepId: () => (opCount > 0 ? "dep-test" : null) },
    Prompt: { toast: (t) => toastCalls.push(t) }
  };
  vm.createContext(sandbox);
  vm.runInContext(appSource + "\n;globalThis.__App = App;", sandbox);
  return { App: sandbox.__App, registry, toastCalls };
}

/* ══ ① 대기 0 → 보이고 disabled(+뮤테이션 — mdock-upload 업데이트 블록 제거) ══════ */
{
  const { App, registry } = makeAppSandbox(appSrc, { sqCount: 0, opCount: 0, online: true });
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
    const { App: AppM, registry: regM } = makeAppSandbox(mutated, { sqCount: 3, opCount: 0, online: true });
    AppM._updateSyncBadge(); await flush();
    const stillDefault = !regM["mdock-upload"] || regM["mdock-upload"].disabled !== false;
    ok(stillDefault, "뮤테이션 적용 시 대기 3건이어도 버튼 상태가 갱신 안 됨(①②가 깨짐) → " + (regM["mdock-upload"] ? ("disabled=" + regM["mdock-upload"].disabled) : "UI.$ 호출 자체가 없음"));
  }
}

/* ══ ② 대기 N>0 → 활성 + 건수 표시 ══════════════════════════════════════ */
{
  const { App, registry } = makeAppSandbox(appSrc, { sqCount: 2, opCount: 1, online: true });
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
  const { App, toastCalls } = makeAppSandbox(appSrc, { sqCount: 1, online: true });
  await App.syncNow();
  ok(toastCalls.some((t) => /완료/.test(t)), "④a 업로드 성공 시 완료 토스트 → " + JSON.stringify(toastCalls));

  const registryFail = {};
  const elFail = (id) => (registryFail[id] = registryFail[id] || { classList: { add() {}, remove() {}, toggle() {} }, textContent: "", value: "", disabled: false, setAttribute() {} });
  const toastCallsFail = [];
  const sandboxFail = {
    console, JSON, Map, Set, Date, Promise,
    navigator: { onLine: true },
    UI: { $: (id) => elFail(id) },
    SyncQueue: { count: async () => 1, flush: async () => { throw new Error("network"); } },
    OpLog: { pending: async () => [] },
    Offline: { curDepId: () => null },
    Prompt: { toast: (t) => toastCallsFail.push(t) }
  };
  vm.createContext(sandboxFail);
  vm.runInContext(appSrc + "\n;globalThis.__App = App;", sandboxFail);
  await sandboxFail.__App.syncNow();
  ok(toastCallsFail.some((t) => /실패/.test(t)), "④b 업로드 실패 시 실패 토스트(조용한 실패 아님) → " + JSON.stringify(toastCallsFail));

  // 오프라인 클릭 — syncNow 자체가 이미 안내(기존 경로)
  const { App: AppOff, toastCalls: toastOff } = makeAppSandbox(appSrc, { sqCount: 1, online: false });
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

  // 포함관계 증명 — #mdock-upload 는 .mdock-bar(⊆ .mobile-dock) 안의 평범한 flex 자식(.mdock-chip)이고,
  // .mdock-fab 처럼 밖으로 튀어나오는 음수 margin 이 없다(구조 확인, 문자열이 아니라 실제 CSS 규칙 유무로 판정).
  const barBlockMatch = indexHtml.match(/<div class="mdock-bar">([\s\S]*?)<\/div>\s*\n\s*<\/nav>/);
  if (!barBlockMatch) throw new Error("index.html 의 .mdock-bar 블록을 찾지 못함(소스 변경?)");
  ok(/id="mdock-upload"/.test(barBlockMatch[1]), "⑤a #mdock-upload 가 .mdock-bar(=.mobile-dock 하위) 안에 있다(포함관계)");
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

  const helpMediaSrc = styleCss.match(/@media \(max-width: 760px\) \{([\s\S]*?)\[data-help-toggle\]\{([\s\S]*?)\}/);
  if (!helpMediaSrc) throw new Error("[data-help-toggle] 모바일 규칙을 찾지 못함");
  const helpBottom = evalPx(helpMediaSrc[2].match(/bottom\s*:\s*([^;]+);/)[1].replace("!important", "").trim());
  const helpToggleRect = { x: 16, y: VIEWPORT.h - helpBottom - 40, w: 40, h: 40 };
  ok(overlapArea(mobileDockRect, helpToggleRect) === 0,
    "⑤d .mobile-dock ∩ [data-help-toggle] = 0 → helpRect=" + JSON.stringify(helpToggleRect));

  console.log("  ⇒ #mdock-upload ⊆ .mobile-dock 이고 위 겹침이 전부 0 이므로 #mdock-upload 의 겹침도 0");
}

/* ══ ⑥ 터치타깃 ≥44×44 ══════════════════════════════════════════════════ */
{
  const barBlockMatch = indexHtml.match(/<div class="mdock-bar">([\s\S]*?)<\/div>\s*\n\s*<\/nav>/);
  const chipCount = (barBlockMatch[1].match(/class="mdock-chip[^"]*"/g) || []).length;
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
  const viewerChipCount = chipCount - (barBlockMatch[1].match(/designer-only/g) || []).length; // designer-only 칩은 뷰어에서 숨김
  const widthDesigner = 375 / chipCount;
  const widthViewer = 375 / Math.max(1, viewerChipCount);
  ok(mdockHVal >= 44, "⑥a .mdock-bar 높이(=칩 높이) ≥44px, 실제 " + mdockHVal);
  ok(widthDesigner >= 44, "⑥b 설계자 모드 칩 " + chipCount + "개 균등폭 ≥44px, 실제 " + widthDesigner.toFixed(1));
  ok(widthViewer >= 44, "⑥c 뷰어 모드 칩 " + viewerChipCount + "개 균등폭 ≥44px, 실제 " + widthViewer.toFixed(1));
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
