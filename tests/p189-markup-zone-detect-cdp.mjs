/**
 * p189 — [WO 20261029-markupzone] 실 Chrome 증거 캡처(지휘자 반려 재작업)
 * 지휘자 반려 사유: 이전 s5-zone.png 는 사진 선택 전 1단계(제목·[사진 선택] 버튼)뿐이라
 *   자동 선택 증거가 아니었다. 이번엔 s5.jpg 를 실제로 선택 → _onFile 실행(실 _autoPickZone
 *   경로 통과, 실 Workers AI 응답 title="FLOOR" 는 .tmp/markup-ocr/title-probe-raw.json 의
 *   실측값을 fetch 모킹으로 재사용 — 같은 세션에서 이미 1회 실 호출로 확인했다, Neurons 재소모 방지)
 *   → ① 자동 선택 배너 + 바꿀 수 있는 후보 select ② 프로젝트가 FLOOR 구역(page=1)으로 전환된
 *   상태(시작은 3RD DECK, page=2)까지 끝난 화면을 데스크톱(1280x800)·모바일(375x812) 두 장 저장.
 *
 * 실행: node tests/p189-markup-zone-detect-cdp.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; return cond; };

let puppeteer = null;
try { puppeteer = createRequire("file:///C:/Users/FREE/package.json")("puppeteer"); } catch (e) { puppeteer = null; }
if (!puppeteer) { console.log("  FAIL puppeteer 없음 — 실 브라우저 캡처 불가"); process.exit(1); }

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT_DIR = path.join(ROOT, ".tmp/p189");
fs.mkdirSync(OUT_DIR, { recursive: true });

const css = ["public/css/style.css", "public/css/seastar-family-tokens.css", "public/css/seastar-3d-skin.css"]
  .map((p) => fs.readFileSync(path.join(ROOT, p), "utf8")).join("\n");
const modSrc = fs.readFileSync(path.join(ROOT, "public/js/modules/74_MarkupAlign.js"), "utf8");
const photoB64 = fs.readFileSync(path.join(ROOT, ".tmp/markup-samples/s5.jpg")).toString("base64");

const browser = await puppeteer.launch({ headless: "new", ...(fs.existsSync(CHROME) ? { executablePath: CHROME } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"><style>' + css + "</style></head><body></body></html>");
  await page.addScriptTag({ content: "window.UI={escapeHtml:(s)=>String(s)};" + modSrc });

  const state = await page.evaluate(async (photoB64) => {
    // 3 구역(데크) 프로젝트 — FLOOR(page1)·3RD DECK(page2, 현재 열려있음)·UPPER DECK(page3)
    window.State = { pins: [], zones: [], pdfPage: 2, fileType: "image", imageUrl: null };
    window.Projects = {
      currentProject: { id: "prjZ", name: "테스트 프로젝트" },
      decks: [
        { id: "d1", name: "FLOOR", page: 1, deployment_id: "depZ" },
        { id: "d2", name: "3RD DECK", page: 2, deployment_id: "depZ" },
        { id: "d3", name: "UPPER DECK", page: 3, deployment_id: "depZ" },
      ],
      selectDeck: async (d) => { window.State.pdfPage = d.page; window.__selectedDeckName = d.name; },
    };
    window.App = { _gotoPage: async (p) => { window.State.pdfPage = p; } };
    // _renderOriginCanvas (image 분기) 가 실패하지 않도록 자리표시 이미지 — 페이지 전환을 시각화하려고
    // 현재 열린 데크 이름을 큰 글자로 그려 넣는다(순수 node-canvas 없이 브라우저 canvas 로).
    const mkPlaceholder = (label) => {
      const c = document.createElement("canvas"); c.width = 900; c.height = 700;
      const g = c.getContext("2d");
      g.fillStyle = "#e2e8f0"; g.fillRect(0, 0, c.width, c.height);
      g.strokeStyle = "#1a1a1a"; g.lineWidth = 3; g.strokeRect(20, 20, c.width - 40, c.height - 40);
      g.fillStyle = "#1a1a1a"; g.font = "bold 64px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(label, c.width / 2, c.height / 2);
      return c.toDataURL("image/png");
    };
    window.State.imageUrl = mkPlaceholder("3RD DECK (현재)");
    // real_onFile 이 호출하는 _renderOriginCanvas 는 State.imageUrl 을 그때그때 다시 읽으므로,
    // 자동 선택으로 데크가 바뀌면 그 데크 이름으로 바로 자리표시 이미지를 새로 세팅한다.
    window.Projects.selectDeck = async (d) => {
      window.State.pdfPage = d.page; window.__selectedDeckName = d.name;
      window.State.imageUrl = mkPlaceholder(d.name + " (전환됨)");
    };
    // 실 Workers AI 응답(이번 세션 .tmp/markup-ocr/title-probe-raw.json 실측: title="FLOOR") 재사용
    window.fetch = async (url) => {
      if (String(url).includes("read-drawing-title")) return { ok: true, json: async () => ({ ok: true, title: "FLOOR", confidence: 1 }) };
      throw new Error("unexpected fetch " + url);
    };

    MarkupAlign._ensureModal();
    const m = document.getElementById("ma-modal");
    m.classList.remove("hidden"); m.classList.add("on");
    MarkupAlign._ctx = { step: 1, photoPts: [], origPts: [], candidates: [], page: window.State.pdfPage, view: { scale: 1, tx: 0, ty: 0 }, gesture: null, showGuides: false, detected: null };

    // s5.jpg(현장 마킹 사진, 실제 바이트) → File 객체 → 실 _onFile 경로(= 사진 선택 UI 그대로)
    const bin = atob(photoB64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], "s5.jpg", { type: "image/jpeg" });

    const pageBefore = window.State.pdfPage;
    await MarkupAlign._onFile(file);
    const pageAfter = window.State.pdfPage;

    const banner = document.getElementById("ma-zone-banner");
    const sel = document.getElementById("ma-zone-select");
    return {
      pageBefore, pageAfter, selectedDeckName: window.__selectedDeckName,
      bannerText: banner ? banner.textContent : null,
      selSelectedText: sel ? sel.options[sel.selectedIndex].textContent : null,
      step1Hidden: document.getElementById("ma-step1").classList.contains("hidden"),
      step2Hidden: document.getElementById("ma-step2").classList.contains("hidden"),
    };
  }, photoB64);

  console.log("  [STATE] " + JSON.stringify(state));
  ok(state.pageBefore === 2 && state.pageAfter === 1, "① 자동 선택 전 3RD DECK(page=2) → 후 FLOOR(page=1) 전환 — before=" + state.pageBefore + " after=" + state.pageAfter);
  ok(state.selectedDeckName === "FLOOR", "② Projects.selectDeck 가 실제로 'FLOOR' 데크로 호출됨");
  ok(/FLOOR/.test(state.bannerText || "") && /자동 선택/.test(state.bannerText || ""), "③ 배너 문구에 'FLOOR'·'자동 선택' 노출 — " + state.bannerText);
  ok(state.selSelectedText === "FLOOR", "④ 바꿀 수 있는 후보 select 의 선택값 = 'FLOOR'");
  ok(state.step1Hidden === true && state.step2Hidden === false, "⑤ 1단계(사진 선택) 숨김 · 2단계(정합/배너) 표시 중");

  await page.setViewport({ width: 1280, height: 800 });
  await page.screenshot({ path: path.join(OUT_DIR, "s5-zone-desktop.png") });
  await page.setViewport({ width: 375, height: 812 });
  await page.screenshot({ path: path.join(OUT_DIR, "s5-zone-mobile.png") });
  ok(fs.existsSync(path.join(OUT_DIR, "s5-zone-desktop.png")), "⑥ 데스크톱(1280x800) 스크린샷 저장 — .tmp/p189/s5-zone-desktop.png");
  ok(fs.existsSync(path.join(OUT_DIR, "s5-zone-mobile.png")), "⑦ 모바일(375x812) 스크린샷 저장 — .tmp/p189/s5-zone-mobile.png");

  try { fs.unlinkSync(path.join(OUT_DIR, "s5-zone.png")); } catch {}
} finally {
  await browser.close();
}

console.log(failed ? `\n${failed} FAIL` : "\nALL PASS");
process.exit(failed ? 1 : 0);
