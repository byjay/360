/**
 * p67 — 도면(PDF) 화면에 360 방향 보정 진입구가 없다 → #pdf-toolbar 에 tb-setdir 추가
 * (프레임워크 0 · 실행: node tests/p67-pdf-toolbar-setdir.test.mjs)
 *
 * 마스터 실사고(2026-09-17): "pdf뷰 방향 보정 기능이 있었는데 사라졌네"
 * 재현(지휘자, scan.seastar.work): #pdf-toolbar 안에 방향 관련 진입구 0개.
 * 기능 자체는 살아있다(#btn-pano-setdir, 07_Radar.js#enterDirAdjustMode) — 파노라마
 * 뷰어 전용 진입구였을 뿐. 도면 화면에는 도달할 방법이 없었다.
 *
 * 검증:
 *   ① #pdf-toolbar 안(파노 오버레이보다 앞)에 tb-setdir 버튼이 존재한다
 *   ② 그 버튼에 title·aria-label 이 모두 비어있지 않다
 *   ③ 핸들러가 기존 공유 경로(App.openPano → Radar.enterDirAdjustMode)를 호출한다
 *      (dirOffset 등 방향 계산 로직을 새로 만들지 않는다 — 복제 금지)
 *   ④ Radar.enterDirAdjustMode 호출부가 파일 전체에 2곳(기존 btn-pano-setdir + 신규 tb-setdir)뿐 —
 *      새 구현이 아니라 같은 함수를 한 번 더 호출하는 것임을 증명
 *   ⑤ 행동: 핀 미선택 → 토스트만, openPano 미호출 / 핀 선택+미디어없음 → 토스트만 /
 *      핀 선택+미디어있음 → openPano 호출 + enterDirAdjustMode 호출
 *   ⑥ 파노라마 안 열린 상태(precondition 미충족)에서 눌러도 무반응이 아니라 반드시 토스트가 뜬다(조용한 실패 금지)
 *
 * 🔴 뮤테이션 2건: ⓐ 버튼을 지우면 ① 실패 · ⓑ title/aria-label 을 비우면 ② 실패
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

const INDEX_HTML = rd("public/index.html");
const APP_SRC = rd("public/js/modules/20_App.js");

/* ① tb-setdir 이 #pdf-toolbar 안(파노 오버레이보다 앞)에 존재 */
const idxToolbar = INDEX_HTML.indexOf('id="pdf-toolbar"');
const idxSetdirBtn = INDEX_HTML.indexOf('id="tb-setdir"');
const idxPanoOverlay = INDEX_HTML.indexOf('id="pano-overlay"');
ok(idxToolbar >= 0 && idxSetdirBtn > idxToolbar && idxSetdirBtn < idxPanoOverlay,
  "① #pdf-toolbar 안에 tb-setdir 버튼이 존재한다(파노 오버레이 전용이 아니다)");

/* ② title·aria-label 비어있지 않음 */
const btnTagMatch = INDEX_HTML.match(/<button id="tb-setdir"[^>]*>/);
ok(!!btnTagMatch, "② tb-setdir 버튼 태그를 찾음");
const btnTag = btnTagMatch ? btnTagMatch[0] : "";
const titleMatch = btnTag.match(/title="([^"]*)"/);
const ariaMatch = btnTag.match(/aria-label="([^"]*)"/);
ok(!!titleMatch && titleMatch[1].trim().length > 0, "② title 속성이 비어있지 않다");
ok(!!ariaMatch && ariaMatch[1].trim().length > 0, "② aria-label 속성이 비어있지 않다");

/* ③④ 핸들러 추출 — 공유 경로 호출 확인 */
function extractHandlerSrc(src) {
  const m = src.match(/bind\("tb-setdir",\s*(\(\)\s*=>\s*\{[\s\S]*?\n      \})\);/);
  return m ? m[1] : null;
}
const handlerSrc = extractHandlerSrc(APP_SRC);
ok(!!handlerSrc, "③ tb-setdir 핸들러 소스를 추출함");
ok(handlerSrc && /this\.openPano\(/.test(handlerSrc), "③ 핸들러가 App.openPano(공유 경로)를 호출한다");
ok(handlerSrc && /Radar\.enterDirAdjustMode\(/.test(handlerSrc), "③ 핸들러가 Radar.enterDirAdjustMode(공유 경로)를 호출한다");
ok(handlerSrc && !/dirOffset/.test(handlerSrc), "③ 핸들러 안에 방향 계산 로직(dirOffset)이 복제되지 않았다");

const enterCallSites = (APP_SRC.match(/Radar\.enterDirAdjustMode\(\)/g) || []).length;
ok(enterCallSites === 2, "④ Radar.enterDirAdjustMode() 호출부가 20_App.js 안에 정확히 2곳(기존+신규) — 새 구현 아님");

/* ⑤⑥ 행동 검증 — 추출한 핸들러를 실제로 실행 */
function runHandler({ pin, hasMedia }) {
  const calls = { toasts: [], openPano: [], enterDirAdjustMode: 0 };
  const sandbox = {
    console,
    State: { pins: pin ? [pin] : [], activePin: pin ? pin.id : null },
    Prompt: { toast: (m) => calls.toasts.push(String(m)) },
    Radar: { enterDirAdjustMode: () => { calls.enterDirAdjustMode++; } },
  };
  vm.createContext(sandbox);
  // 래퍼 함수를 stubApp 에 바인딩해 실행 — 화살표 함수는 정의 시점의 this 를 그대로 캡처하므로
  // wrapper.call(stubApp) 로 정의해야 원본과 동일하게 this.pinHasMedia/this.openPano 가 stubApp 을 가리킨다.
  const wrapperFn = vm.runInContext("(function(){ return " + handlerSrc + "; })", sandbox);
  const stubApp = {
    pinHasMedia: (p) => !!(p && p.hasMedia),
    openPano: (p) => calls.openPano.push(p.id),
  };
  const handler = wrapperFn.call(stubApp);
  handler();
  return calls;
}

{
  const r = runHandler({ pin: null, hasMedia: false });
  ok(r.toasts.length === 1, "⑤ 핀 미선택 → 토스트 1회(조용한 실패 아님)");
  ok(r.openPano.length === 0 && r.enterDirAdjustMode === 0, "⑤ 핀 미선택 → openPano/enterDirAdjustMode 호출 안 함");
}
{
  const r = runHandler({ pin: { id: "p1", hasMedia: false }, hasMedia: false });
  ok(r.toasts.length === 1, "⑤ 핀 선택 + 미디어 없음 → 토스트 1회(조용한 실패 아님)");
  ok(r.openPano.length === 0 && r.enterDirAdjustMode === 0, "⑤ 핀 선택 + 미디어 없음 → openPano/enterDirAdjustMode 호출 안 함");
}
{
  const r = runHandler({ pin: { id: "p1", hasMedia: true }, hasMedia: true });
  ok(r.openPano.length === 1 && r.openPano[0] === "p1", "⑤ 핀 선택 + 미디어 있음 → openPano(pin) 호출");
  ok(r.enterDirAdjustMode === 1, "⑤ 핀 선택 + 미디어 있음 → Radar.enterDirAdjustMode() 호출");
  ok(r.toasts.length === 0, "⑥ 정상 경로에서는 불필요한 토스트가 없다");
}

/* ══ 뮤테이션 2건 — 되돌리면 반드시 실패해야 한다(§G-2-3) ══ */
console.log("\n-- 뮤테이션 증명 --");
// ⓐ 버튼을 지우면 ① 실패
{
  const mutatedHtml = INDEX_HTML.replace(btnTag, "<!-- removed -->");
  ok(mutatedHtml !== INDEX_HTML, "ⓐ 뮤테이션 패치 적용됨(문자열 매치 확인)");
  const idx2 = mutatedHtml.indexOf('id="tb-setdir"');
  const mutFail = !(idxToolbar >= 0 && idx2 > idxToolbar && idx2 < idxPanoOverlay);
  ok(mutFail, "ⓐ [뮤테이션] 버튼 제거 시 ① 판정이 실패로 뒤집힌다");
}
// ⓑ title/aria-label 비우면 ② 실패
{
  const mutatedTag = btnTag.replace(/title="[^"]*"/, 'title=""').replace(/aria-label="[^"]*"/, 'aria-label=""');
  ok(mutatedTag !== btnTag, "ⓑ 뮤테이션 패치 적용됨(문자열 매치 확인)");
  const t2 = mutatedTag.match(/title="([^"]*)"/);
  const a2 = mutatedTag.match(/aria-label="([^"]*)"/);
  const mutFail = !(t2 && t2[1].trim().length > 0 && a2 && a2[1].trim().length > 0);
  ok(mutFail, "ⓑ [뮤테이션] 레이블을 비우면 ② 판정이 실패로 뒤집힌다");
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
