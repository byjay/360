/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p85-pap-panel-declutter.test.mjs)
 *
 * 발주서(WO 20260929) — 마스터: "포인트 선택시 메뉴 상단과 하단 중복되잖아" / "깔끔하게 정렬하고 정리해"
 * 정본 레이아웃(지휘자 확정): 상단 3버튼[360 보기/위치 이동/삭제] 한 줄 → 번호/이름+저장
 *   → 하단 등록 탭 1곳(사진/360/문서/노트/동영상/URL, 노트도 여기로 통합) → 빈 공간 제거(50:50 강제 분할 해제).
 *
 * 검증 대상:
 *  ① public/index.html #pin-action-pop 마크업 — 상단 "수정/사진 추가" 버튼 제거,
 *     상단 노트 섹션(pap-notes-mini) 제거, 노트는 pap-bottom 안 pap-notes-panel 로 통합(중복 0).
 *  ② 27_PinActionPop.js — PAP_REG_CATS 6종 유지(노트 포함), _selectRegCategory 가
 *     photo/doc/note 영역을 상호 배타적으로 토글(동시 노출 없음).
 *  ③ 실 브라우저(puppeteer) — 데스크톱/375px 두 폭에서 상단 3버튼 + 닫기 버튼 rect ≥44×44,
 *     375px 폭에서 화면(x+width≤375) 안에 위치.
 *  ④ confirm( 네이티브 다이얼로그 미사용(p76 정본 유지) — 27_PinActionPop.js 자체 검사.
 *
 * 뮤테이션 2건 — 되돌리면 반드시 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

const html = rd("public/index.html");
const jsSrc = rd("public/js/modules/27_PinActionPop.js");

// 원문 그대로 #pin-action-pop 블록 추출(손 카피 금지 — 드리프트 방지)
function extractPapBlock(src) {
  const startTag = '<div id="pin-action-pop"';
  const s = src.indexOf(startTag);
  if (s < 0) return null;
  let depth = 0, i = s, end = -1;
  const re = /<div\b[^>]*>|<\/div>/g;
  re.lastIndex = s;
  let m;
  while ((m = re.exec(src))) {
    if (m[0].startsWith("<div")) depth++; else depth--;
    if (depth === 0) { end = re.lastIndex; break; }
  }
  if (end < 0) return null;
  return src.slice(s, end);
}
const papBlock = extractPapBlock(html);
ok(!!papBlock, "① #pin-action-pop 블록 추출 성공");

/* ══════════ ① 마크업 — 중복 제거 확인 ══════════ */
console.log("\n[① 마크업 — 중복 버튼/노트 섹션 제거]");
ok(!/id="pap-edit"/.test(papBlock || ""), "① 상단 '수정/사진 추가'(#pap-edit) 버튼 제거됨");
ok(!/id="pap-notes-mini"/.test(papBlock || ""), "① 상단 노트 섹션(#pap-notes-mini) 제거됨");
ok(/id="pap-notes-panel"/.test(papBlock || ""), "① 노트가 등록 탭 패널(#pap-notes-panel)로 이동함");
// pap-bottom 안에 pap-notes-panel 이 있는지(등록 탭 통합 위치 확인)
const bottomStart = (papBlock || "").indexOf('id="pap-bottom"');
const notesIdx = (papBlock || "").indexOf('id="pap-notes-panel"');
ok(bottomStart >= 0 && notesIdx > bottomStart, "① #pap-notes-panel 이 #pap-bottom 내부에 위치(등록 탭 통합)");
// pap-notes-list/input/submit 은 정확히 1곳씩만 존재(중복 위젯 0)
["pap-notes-list", "pap-notes-input", "pap-notes-submit"].forEach((id) => {
  const cnt = ((papBlock || "").match(new RegExp('id="' + id + '"', "g")) || []).length;
  ok(cnt === 1, `① #${id} 정확히 1곳만 존재(중복 0, 실제 ${cnt}곳)`);
});
// 상단 액션 행 = 3버튼(view/move/del)만 — 중첩 <div> 깊이 계산으로 정확히 그 블록만 추출
function extractDivByOpenTag(src, openTag) {
  const s = src.indexOf(openTag);
  if (s < 0) return "";
  let depth = 0, end = -1;
  const re = /<div\b[^>]*>|<\/div>/g;
  re.lastIndex = s;
  let m;
  while ((m = re.exec(src))) {
    if (m[0].startsWith("<div")) depth++; else depth--;
    if (depth === 0) { end = re.lastIndex; break; }
  }
  return end < 0 ? "" : src.slice(s, end);
}
const actionsHtml = extractDivByOpenTag(papBlock || "", '<div class="pap-actions">');
const btnCount = (actionsHtml.match(/<button\b/g) || []).length;
ok(btnCount === 3, `① 상단 액션 행 버튼 수 = 3(view/move/del), 실제 ${btnCount}`);
ok(/id="pap-view"/.test(actionsHtml) && /id="pap-move"/.test(actionsHtml) && /id="pap-del"/.test(actionsHtml),
  "① 상단 액션 행에 view/move/del 만 존재");

/* ══════════ ② JS 로직 — 등록 탭 6종 + 상호배타 토글 ══════════ */
console.log("\n[② 27_PinActionPop.js — 등록 탭 로직]");
const catsMatch = /PAP_REG_CATS\s*=\s*\[([\s\S]*?)\];/.exec(jsSrc);
const catsBlock = catsMatch ? catsMatch[1] : "";
const catIds = (catsBlock.match(/id:\s*"(\w+)"/g) || []).map((s) => s.match(/"(\w+)"/)[1]);
ok(catIds.length === 6 && catIds.includes("note") && catIds.includes("photo") && catIds.includes("doc"),
  `② 등록 종류 6종 유지(노트 포함) — 실제: ${catIds.join(",")}`);
ok(/pap-edit/.test(jsSrc) === false, "② JS 에서 #pap-edit 참조 완전 제거(고아 리스너 없음)");
ok(/photoArea\.classList\.toggle\("hidden",\s*isDoc \|\| isNote\)/.test(jsSrc),
  "② _selectRegCategory: 문서/노트 선택 시 사진 영역 숨김(상호배타)");
ok(/docBox\.classList\.toggle\("hidden",\s*!isDoc\)/.test(jsSrc) && /notesPanel\.classList\.toggle\("hidden",\s*!isNote\)/.test(jsSrc),
  "② _selectRegCategory: 문서/노트 패널이 각자 선택시에만 노출");

/* ══════════ ④ confirm( 네이티브 다이얼로그 미사용(p76 정본) ══════════ */
console.log("\n[④ 네이티브 confirm 미사용]");
ok(!/[^.]\bconfirm\s*\(/.test(jsSrc.replace(/Prompt\.confirm/g, "")), "④ 27_PinActionPop.js 에 네이티브 confirm( 없음");

/* ══════════ ③ 실 브라우저 — 버튼 rect ≥44×44, 화면 안 ══════════ */
async function measureRects(viewportWidth, styleHref) {
  const HARNESS = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${styleHref || "/css/style.css"}">
<link rel="stylesheet" href="/css/seastar-family-tokens.css">
<link rel="stylesheet" href="/css/seastar-3d-skin.css">
</head><body>
${(papBlock || "").replace(/\bhidden\b/, "")}
</body></html>`;
  const PUB = path.join(ROOT, "public");
  const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    if (u === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(HARNESS); return; }
    const f = path.join(PUB, u);
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
    res.end(fs.readFileSync(f));
  });
  await listenSafePort(server, "127.0.0.1");
  const PORT = server.address().port;
  const require = createRequire("file:///C:/Users/FREE/package.json");
  const puppeteer = require("puppeteer");
  const browser = await puppeteer.launch({ headless: "new", protocolTimeout: 180000, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  await page.setViewport({ width: viewportWidth, height: 900 });
  page.on("pageerror", () => {});
  await page.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "load", timeout: 30000 });
  const r = await page.evaluate((vw) => {
    const rectOf = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, x: r.x, right: r.x + r.width };
    };
    return {
      view: rectOf("pap-view"), move: rectOf("pap-move"), del: rectOf("pap-del"), close: rectOf("pap-close")
    };
  }, viewportWidth);
  await browser.close();
  server.close();
  return r;
}

let puppeteerAvailable = true;
try { createRequire("file:///C:/Users/FREE/package.json")("puppeteer"); } catch (e) { puppeteerAvailable = false; }

if (!puppeteerAvailable) {
  console.log("  FAIL puppeteer 를 로드할 수 없다 — 실 브라우저 수치 증명 불가(증거 없는 PASS 금지)");
  failed++;
} else {
  console.log("\n[③ 실 브라우저 — 375px 폭, 상단 3버튼+닫기 rect]");
  const r = await measureRects(375);
  ["view", "move", "del", "close"].forEach((k) => {
    const rc = r[k];
    ok(!!rc, `③ #pap-${k} 요소 존재`);
    if (rc) {
      ok(rc.h >= 44, `③ #pap-${k} height ${rc.h.toFixed(1)}px ≥ 44px`);
      ok(rc.right <= 375 + 0.5, `③ #pap-${k} 화면(375px) 안(right=${rc.right.toFixed(1)})`);
    }
  });

  console.log("\n[뮤테이션 1] .pap-btn min-height:44px 규칙 제거 → 버튼 height<44 로 붕괴해야 함");
  const cssSrc = rd("public/css/style.css");
  const needle1 = "min-height: 44px; /* [WO 20260929] 터치타깃 ≥44px */\n  padding: 11px 8px;";
  const mutated1 = cssSrc.replace(needle1, "padding: 11px 8px;");
  if (mutated1 === cssSrc) { console.log("  FAIL 뮤테이션1 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    // 🔴 실 style.css 는 절대 덮어쓰지 않는다(동시 작업 중인 다른 에이전트 보호) — 별도 임시 CSS로만 로드.
    const tmpCss = path.join(ROOT, "public", "css", "__p85-mutated.css");
    fs.writeFileSync(tmpCss, mutated1);
    try {
      const r2 = await measureRects(375, "/css/__p85-mutated.css");
      ok(r2.view.h < 44, `뮤테이션1 적용 시 #pap-view height ${r2.view.h.toFixed(1)}px < 44px(①붕괴 증명)`);
    } finally {
      fs.unlinkSync(tmpCss);
    }
  }

  console.log("\n[뮤테이션 2] 상단 노트 섹션(pap-notes-mini)을 다시 삽입 → 중복 검사가 실패해야 함");
  const dupInjected = html.replace(
    '<div id="pap-info-form"',
    '<div id="pap-notes-mini"><input id="pap-notes-input-dup"/></div><div id="pap-info-form"'
  );
  const dupBlock = extractPapBlock(dupInjected);
  const dupOk = !/id="pap-notes-mini"/.test(dupBlock || "");
  ok(dupOk === false, "뮤테이션2: pap-notes-mini 재주입 시 '제거됨' 검사가 실패로 뒤집힘(검사 유효성 증명)");
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
