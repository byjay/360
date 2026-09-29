/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p82-mobile-topbar-settings-fab.test.mjs)
 *
 * [재현] 지휘자 프로덕션 실측(ac64707f · 375×812 · 캐시 삭제 · 편집화면):
 *   #btn-settings x=468 right=502 inView=false — 뷰포트(375) 밖, [설정](시작번호·핀색상·
 *   편집모드 전환·로그아웃)에 도달 불가. 우하단 "포인트" 플로팅 버튼(#pin-grid-reopen)도
 *   "포인" 만 보이고 잘림.
 *
 * 근본원인 A (설정 버튼 화면 밖) — public/css/style.css:3505 부근
 *   기존 `#btn-back, #regmode-seg { order: -1; }` (WO 20260929)가 뒤로가기+3모드 세그먼트만
 *   topbar 앞으로 당겼을 뿐, #btn-settings(DOM 최후미, public/index.html:280)는 여전히
 *   로고·상태배지·전체핀 등 order:0 그룹 뒤에 남아 375px를 넘겼다.
 *   또한 전역(비-미디어) 규칙 `.btn-settings{padding:6px 10px !important}`
 *   (style.css COMPACT OPERATIONS 섹션, ~라인 3386)가 44px 터치 타깃에 못 미쳤다(#btn-back도 동일).
 *
 * 근본원인 B (포인트 FAB 텍스트 잘림) — public/css/style.css:4090, ~4158
 *   `.pin-grid-reopen-label{white-space:nowrap}`(데스크톱 전용, gap:7px 라벨 포함 alto FAB 설계)가
 *   모바일 46×46 정사각 아이콘 전용 FAB에도 그대로 상속돼 "포인트" 3글자가 박스를 넘쳤다
 *   (뷰포트 밖이 아니라 버튼 자체 폭 부족 — "포인"까지만 보임).
 *
 * 수정:
 *   - #btn-back, #regmode-seg, #btn-settings { order: -1; } (설정 포함 3종 세트로 확장)
 *   - @media(max-width:760px) #btn-back, #btn-settings { min-width:44px; min-height:44px; padding:0 !important; ... }
 *   - @media(max-width:640px),(pointer:coarse) 안 .pin-grid-reopen-label { display:none; } (아이콘 전용 FAB)
 *
 * 검사(실 브라우저, puppeteer, public/index.html 실 마크업 + CSS 3파일 실 캐스케이드):
 *  ① 360×740 / 375×812 / 414×896 각 폭에서 #btn-back·.regmode-btn×2(CHECKER/360, WO 20260929 2모드 전환)·#btn-settings 전부
 *     뷰포트 안(0 ≤ left, right ≤ vw) + elementFromPoint(중심)이 자기 자신(클릭 가능) + h ≥ 44
 *  ② 같은 3폭에서 #pin-grid-reopen 이 뷰포트 안(right ≤ vw, bottom ≤ vh) + 라벨 숨김(잘림 없음)
 *  ③ 데스크톱 1440×900 회귀 없음 — #btn-settings 높이 44px 미만이어도 OK(데스크톱 요구 아님)지만
 *     order:-1 미적용(자연스러운 DOM 순서) + .pin-grid-reopen-label 은 계속 보임(display!=none)
 *
 * 뮤테이션 2건, 각 EXIT=1 확인 후 원복:
 *  ⓐ order 규칙에서 `, #btn-settings` 제거 → ①에서 #btn-settings 가 뷰포트 밖으로 밀려나 실패
 *  ⓑ `.pin-grid-reopen-label { display:none; }`(모바일 FAB 블록) 제거 → ②에서 라벨이 다시 보여 실패
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
const indexHtml = rd("public/index.html");
const cssStyle = rd("public/css/style.css");

// 실 마크업 추출(값 복제 아님 — 소스가 바뀌면 테스트도 자동으로 최신 마크업을 쓴다)
const headerMatch = indexHtml.match(/<header id="topbar"[\s\S]*?<\/header>/);
const reopenMatch = indexHtml.match(/<button id="pin-grid-reopen"[\s\S]*?<\/button>/);
if (!headerMatch) throw new Error("public/index.html 에서 #topbar 헤더 블록을 찾지 못함(마크업 변경?)");
if (!reopenMatch) throw new Error("public/index.html 에서 #pin-grid-reopen 블록을 찾지 못함(마크업 변경?)");
// [WO 20260929] index.html의 #brand-logo-top은 JS 하이드레이션 전(빈 div, .brand-logo:empty{display:none}로
// 접힘)이라 실제 운영 화면(20_App.js가 brand-logo--img+<img> 를 채운 뒤)과 폭이 다르다. p80 하네스와
// 동일하게 하이드레이션된 상태를 재현해야 프로덕션 실측(x=468 오버플로)과 같은 조건이 된다.
const headerHtml = headerMatch[0].replace(
  /<div id="brand-logo-top" class="brand-logo brand-logo-top"[^>]*><\/div>/,
  '<div id="brand-logo-top" class="brand-logo brand-logo-top brand-logo--img"><img class="brand-logo-img" src="/images/logo.png" alt="SEASTAR" /></div>'
);
const reopenHtml = reopenMatch[0].replace(' hidden"', '"'); // hidden 해제(측정 대상)

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };

async function withBrowser(fn) {
  const require = createRequire("file:///C:/Users/FREE/package.json");
  let puppeteer = null;
  try { puppeteer = require("puppeteer"); } catch (e) { puppeteer = null; }
  if (!puppeteer) { console.log("  FAIL puppeteer 를 로드할 수 없다 — 실 브라우저 검증 불가(증거 없는 PASS 금지)"); failed++; return; }
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try { await fn(browser); } finally { await browser.close(); }
}

function serveDir(dir) {
  const PUB = path.join(ROOT, "public");
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    if (u.startsWith("/css/") || u.startsWith("/images/") || u.startsWith("/js/")) {
      const f = path.join(PUB, u);
      if (fs.existsSync(f)) {
        const ct = u.endsWith(".css") ? "text/css" : u.endsWith(".js") ? "text/javascript" : "application/octet-stream";
        res.writeHead(200, { "content-type": ct }); res.end(fs.readFileSync(f)); return;
      }
    }
    const f = path.join(dir, u === "/" ? "index.html" : u);
    if (!f.startsWith(dir) || !fs.existsSync(f)) { res.writeHead(404); res.end("nf"); return; }
    const ct = f.endsWith(".html") ? "text/html" : f.endsWith(".css") ? "text/css" : "text/javascript";
    res.writeHead(200, { "content-type": ct });
    res.end(fs.readFileSync(f));
  });
  return new Promise((resolve) => { listenSafePort(server, "127.0.0.1").then(() => resolve(server)); });
}

function buildLayoutHtml(cssSrc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p82-"));
  // /css/style.css 는 serveDir() 가 진짜 public/css/ 로 가로채므로 뮤테이션본은 다른 경로(/style.css)로 서빙.
  fs.writeFileSync(path.join(dir, "style.css"), cssSrc, "utf8");
  const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" crossorigin="anonymous" referrerpolicy="no-referrer" />
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/css/seastar-family-tokens.css">
<link rel="stylesheet" href="/css/seastar-3d-skin.css">
<style>.hidden{display:none!important} body{margin:0}</style>
</head><body>
<div id="screen-app" class="screen active">
${headerHtml}
<main id="map-area" class="map-area" style="position:relative;height:80vh;">
  ${reopenHtml}
</main>
</div>
</body></html>`;
  fs.writeFileSync(path.join(dir, "index.html"), HTML, "utf8");
  return dir;
}

async function measure(browser, cssSrc, vw, vh) {
  const dir = buildLayoutHtml(cssSrc);
  const server = await serveDir(dir);
  const port = server.address().port;
  const page = await browser.newPage();
  await page.setViewport({ width: vw, height: vh, deviceScaleFactor: 2 });
  await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "load" });
  const m = await page.evaluate(() => {
    // [WO 20260929 2모드 전환] btn-regmode-view는 세그먼트에서 제거됐다(디자이너 UI 도달 불가) — 검사 대상에서도 제외.
    const ids = ["btn-back", "btn-regmode-checkboard", "btn-regmode-photo", "btn-settings"];
    const btns = ids.map((id) => {
      const el = document.getElementById(id);
      if (!el) return { id, missing: true };
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const top = document.elementFromPoint(cx, cy);
      const clickable = !!top && (top === el || el.contains(top));
      return { id, left: r.left, right: r.right, top: r.top, height: r.height, clickable };
    });
    const reopen = document.getElementById("pin-grid-reopen");
    const label = document.querySelector(".pin-grid-reopen-label");
    const reopenRect = reopen ? reopen.getBoundingClientRect() : null;
    const labelDisplay = label ? getComputedStyle(label).display : null;
    const labelRect = label ? label.getBoundingClientRect() : null;
    return {
      vw: window.innerWidth, vh: window.innerHeight,
      btns,
      reopen: reopenRect ? { right: reopenRect.right, bottom: reopenRect.bottom, width: reopenRect.width } : null,
      labelDisplay,
      labelOverflow: (labelRect && reopenRect) ? (labelRect.right > reopenRect.right + 0.5) : null
    };
  });
  server.close();
  return m;
}

const WIDTHS = [[360, 740], [375, 812], [414, 896]];

console.log("\n[Part A · 모바일 3폭 — 뒤로/세그먼트3/설정 전부 화면 안+클릭가능+44px, 포인트 FAB 잘림 없음]");
await withBrowser(async (browser) => {
  for (const [vw, vh] of WIDTHS) {
    const m = await measure(browser, cssStyle, vw, vh);
    console.log(`  [실측 ${vw}x${vh}] ` + JSON.stringify(m.btns) + " reopen=" + JSON.stringify(m.reopen) + " labelDisplay=" + m.labelDisplay);
    for (const b of m.btns) {
      ok(!b.missing, `사전조건 — #${b.id} 존재(${vw}px)`);
      if (b.missing) continue;
      ok(b.left >= 0 && b.right <= m.vw, `① #${b.id} 뷰포트 안(${vw}px) — left=${b.left.toFixed(1)} right=${b.right.toFixed(1)} vw=${m.vw}`);
      ok(b.clickable, `① #${b.id} 클릭 가능(자기 자신이 elementFromPoint, ${vw}px)`);
      ok(b.height >= 44, `① #${b.id} 터치 타깃 높이 ≥44px(${vw}px) — 실제 ${b.height.toFixed(1)}`);
    }
    ok(m.reopen != null && m.reopen.right <= m.vw && m.reopen.bottom <= m.vh,
      `② #pin-grid-reopen 뷰포트 안(${vw}px) — right=${m.reopen && m.reopen.right.toFixed(1)} bottom=${m.reopen && m.reopen.bottom.toFixed(1)}`);
    ok(m.labelDisplay === "none" || m.labelOverflow === false,
      `② #pin-grid-reopen 라벨 잘림 없음(${vw}px) — labelDisplay=${m.labelDisplay} overflow=${m.labelOverflow}`);
  }
});

console.log("\n[Part B · 데스크톱 1440×900 회귀 없음]");
await withBrowser(async (browser) => {
  const m = await measure(browser, cssStyle, 1440, 900);
  console.log("  [실측 1440x900] " + JSON.stringify(m.btns) + " labelDisplay=" + m.labelDisplay);
  const settings = m.btns.find((b) => b.id === "btn-settings");
  ok(settings && !settings.missing, "사전조건 — 데스크톱 #btn-settings 존재");
  ok(m.labelDisplay !== "none", "③ 데스크톱에서 #pin-grid-reopen 라벨은 계속 보임(display=" + m.labelDisplay + ")");
});

console.log("\n[뮤테이션ⓐ] order 규칙에서 `, #btn-settings` 제거 → ①에서 설정 버튼이 뷰포트 밖으로 밀려야 함(375px)");
await withBrowser(async (browser) => {
  const needle = "#btn-back, #regmode-seg, #btn-settings { order: -1; }";
  if (!cssStyle.includes(needle)) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; return; }
  const mutated = cssStyle.replace(needle, "#btn-back, #regmode-seg { order: -1; }");
  const m = await measure(browser, mutated, 375, 812);
  const settings = m.btns.find((b) => b.id === "btn-settings");
  console.log("  [뮤테이션 실측] btn-settings right=" + (settings && settings.right.toFixed(1)) + " vw=" + m.vw);
  ok(settings && settings.right > m.vw, "뮤테이션 적용 시 #btn-settings 가 뷰포트 밖으로 밀려난다(①이 깨짐을 확인)");
});

console.log("\n[뮤테이션ⓑ] 모바일 FAB `.pin-grid-reopen-label { display:none; }` 제거 → ②에서 라벨이 다시 잘려야 함(375px)");
await withBrowser(async (browser) => {
  const needle = ".pin-grid-reopen-label{ display:none; }";
  if (!cssStyle.includes(needle)) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; return; }
  const mutated = cssStyle.replace(needle, "");
  const m = await measure(browser, mutated, 375, 812);
  console.log("  [뮤테이션 실측] labelDisplay=" + m.labelDisplay + " labelOverflow=" + m.labelOverflow);
  ok(m.labelDisplay !== "none" && m.labelOverflow === true, "뮤테이션 적용 시 라벨이 다시 보이며 버튼 폭을 넘친다(②가 깨짐을 확인)");
});

console.log(failed === 0 ? "\n[ALL PASS]" : "\n[" + failed + " FAILED]");
process.exit(failed === 0 ? 0 : 1);
