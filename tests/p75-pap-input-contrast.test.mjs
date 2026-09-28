/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p75-pap-input-contrast.test.mjs)
 *
 * 마스터 지시(2026-09-28): "까만 영역을 없애 글자 안보여" (핀 #8 패널 입력칸)
 *
 * 근본원인(실측): #pin-action-pop 안 #pap-label-input/#pap-notes-input/#pap-photo-url 은
 *   public/index.html 인라인 style 로 color:#0f172a(라이트 전용 진한 남색)만 고정하고 배경은
 *   지정하지 않는다. 배경은 style.css 전역 규칙(input[type=...],textarea,select{background:var(--bg2)})을
 *   물려받는데, seastar-3d-skin.css 가 :root --bg2 를 다크(#1d2025)로 remap 하면서 어두운
 *   글자+어두운 배경 조합(대비 1.09:1)이 됐다. CSS 3개(style.css/seastar-family-tokens.css/
 *   seastar-3d-skin.css) 전수 grep 결과 :root --bg2 재정의는 seastar-3d-skin.css 한 곳뿐.
 *
 * 조치: style.css 에 #pin-action-pop 범위 한정 규칙(ID 선택자라 다크 스킨 로드 순서와 무관하게
 *   항상 이긴다)을 추가 — 배경 흰색 고정, 전역 다크 remap(:root --bg2)은 건드리지 않는다.
 *
 * 실 브라우저(Chrome/puppeteer)에서 style.css + seastar-family-tokens.css + seastar-3d-skin.css
 * 3개를 실제 로드 순서 그대로 적용하고(다크 스킨 활성 상태 재현), public/index.html 의
 * #pin-action-pop 마크업 원문을 그대로 삽입해 getComputedStyle 로 실측한다(소스 짐작 아님 —
 * CLAUDE.md §G-4④ "런타임에서 실측").
 * 뮤테이션 1건(패널 입력 배경 규칙 제거) 붙어 있어, 되돌리면 반드시 실패한다.
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

function contrastRatio(rgbA, rgbB) {
  const lum = ([r, g, b]) => {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const l1 = lum(rgbA), l2 = lum(rgbB);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}
function parseRgb(s) {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(s || "");
  return m ? [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])] : [0, 0, 0];
}

// index.html 에서 #pin-action-pop 블록 원문 그대로 추출(손으로 베끼지 않음 — 드리프트 방지)
const html = rd("public/index.html");
const startTag = '<div id="pin-action-pop"';
const s = html.indexOf(startTag);
if (s < 0) { console.log("FAIL #pin-action-pop 블록을 index.html 에서 찾지 못함"); process.exit(1); }
// 대응하는 닫는 </div> 찾기(중첩 카운팅)
let depth = 0, i = s, end = -1;
const re = /<div\b[^>]*>|<\/div>/g;
re.lastIndex = s;
let m;
while ((m = re.exec(html))) {
  if (m[0].startsWith("<div")) depth++;
  else depth--;
  if (depth === 0) { end = re.lastIndex; break; }
}
if (end < 0) { console.log("FAIL #pin-action-pop 닫는 태그를 찾지 못함"); process.exit(1); }
const papBlock = html.slice(s, end);
ok(/id="pap-label-input"/.test(papBlock) && /id="pap-notes-input"/.test(papBlock) && /id="pap-photo-url"/.test(papBlock),
  "추출된 #pin-action-pop 블록에 pap-label-input/pap-notes-input/pap-photo-url 포함(원문 추출 검증)");

async function measure(cssLinks) {
  const HARNESS = `<!doctype html><html><head><meta charset="utf-8">
${cssLinks.map((h) => `<link rel="stylesheet" href="${h}">`).join("\n")}
</head><body class="screen">
${papBlock.replace(/\bhidden\b/, "")}
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
  page.on("pageerror", () => {});
  await page.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "load", timeout: 30000 });
  const r = await page.evaluate(() => {
    const pick = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, color: cs.color };
    };
    return { label: pick("pap-label-input"), notes: pick("pap-notes-input"), photoUrl: pick("pap-photo-url") };
  });
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
  const CSS3 = ["/css/style.css", "/css/seastar-family-tokens.css", "/css/seastar-3d-skin.css"];

  console.log("\n[① 실 브라우저 — CSS 3개 실제 로드 순서(다크 스킨 활성) — #pap-* 대비 실측]");
  const r1 = await measure(CSS3);
  ["label", "notes", "photoUrl"].forEach((k) => {
    const { bg, color } = r1[k];
    const cr = contrastRatio(parseRgb(bg), parseRgb(color));
    ok(cr >= 4.5, `① #pap-${k === "label" ? "label-input" : k === "notes" ? "notes-input" : "photo-url"} 대비 ${cr.toFixed(2)}:1 ≥ 4.5 (bg=${bg}, color=${color})`);
  });

  console.log("\n[뮤테이션] #pin-action-pop 입력 배경 규칙 제거 → ①이 실패해야 함");
  const styleSrc = rd("public/css/style.css");
  const needle = "#pin-action-pop input[type=\"text\"],\n#pin-action-pop input[type=\"url\"],\n#pin-action-pop input[type=\"number\"],\n#pin-action-pop input[type=\"email\"],\n#pin-action-pop input[type=\"search\"],\n#pin-action-pop textarea,\n#pin-action-pop select {\n  background: #ffffff;\n  color: #0f172a;\n}";
  const mutated = styleSrc.replace(needle, "/* removed for mutation test */");
  if (mutated === styleSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const tmpCss = path.join(ROOT, "public", "css", "__p75-mutated.css");
    fs.writeFileSync(tmpCss, mutated);
    try {
      const r2 = await measure(["/css/__p75-mutated.css", "/css/seastar-family-tokens.css", "/css/seastar-3d-skin.css"]);
      const cr = contrastRatio(parseRgb(r2.label.bg), parseRgb(r2.label.color));
      ok(cr < 4.5, `뮤테이션 적용 시 #pap-label-input 대비 ${cr.toFixed(2)}:1 < 4.5(①붕괴 증명, 다크배경+다크글자 재현)`);
    } finally {
      fs.unlinkSync(tmpCss);
    }
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
