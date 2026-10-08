/**
 * p136 — WO 20261008-treetree(마스터: "구역을 등록하면 하단 트리에 나와야 하는데 안 나오잖아").
 *
 * 근본원인(public/css/style.css + 미러 css/style.css, .tree-label): `flex:1;min-width:0;` 은
 * flex-basis:0% 다. flexbox 수축(overflow) 단계에서 basis:0 아이템의 "기여분"은 항상 0이라
 * 이 행(kindTag "구역" + 이름 + 상태태그 + .tree-src-tag "잘라옴" + .tree-cnt + ⋯버튼)이
 * 좁은 사이드바(240px)에서 조금이라도 넘치면 이름이 통째로 0px 로 접힌다 — grow 는 여유
 * 공간이 '양수'일 때만 적용되고 오버플로(음수)엔 전혀 관여하지 않는다(CSS 스펙). 동시에
 * 유일한 다른 shrink 대상인 .tree-src-tag(flex:0 1 auto)가 오버플로 전량을 떠안아
 * "잘…" 처럼 한 글자로 짓눌린다(마스터 스크린샷 실측과 정확히 일치).
 *
 * 수정: .tree-label 을 flex:1 1 auto(basis=auto, 실제 내용 크기로 수축 계산에 정당히
 * 참여) + min-width:44px(바닥) 로, .tree-src-tag 도 min-width:0→20px 로 — 둘 다 완전히
 * 0으로는 못 접히게 한다. (§5 SoT — .tree-label 은 프로젝트/원본/구역/영역/핀 트리 노드가
 * 모두 공유하는 한 벌이라 이 CSS 한 곳만 고치면 전부 해결된다.)
 *
 * 실 Chrome(헤드리스 CDP)으로 public/css/style.css 를 그대로 로드해 renderTree() 가 실제
 * 만드는 것과 동일한 DOM(class 전수 일치)을 구성하고 레이아웃을 측정한다. 목(mock) 없음 —
 * 서버가 필요 없는 이유는 레이아웃이 순수 CSS 문제이기 때문(fixture 는 마크업만 고정,
 * CSS 는 실 파일을 그대로 로드).
 *
 * 실행: P136=1 TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p136-treelabel-overflow-cdp.mjs
 *   (P136 != "1" 이면 SKIP)
 * 뮤테이션: P136_MUT=1 — 옛 규칙(flex:1;min-width:0)을 그대로 되살려 FAIL(EXIT=1)을 기대한다.
 * 스크린샷: .tmp/fixtree2/
 */
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { fileURLToPath } from "node:url";

if (process.env.P136 !== "1") { console.log("[SKIP] p136 은 P136=1 일 때만 실행(실 Chrome 실측)"); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = path.join(ROOT, ".tmp");
const OUT = path.join(TMP, "fixtree2");
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const MUT = process.env.P136_MUT === "1";

let failed = 0; const fails = [];
const ok = (cond, label, detail) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null ? " :: " + JSON.stringify(detail) : "")); if (!cond) { failed++; fails.push(label); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) { console.log("FAIL Chrome 없음: " + CHROME); process.exit(2); }

const cssPath = path.join(ROOT, "public", "css", "style.css");
if (!fs.existsSync(cssPath)) { console.log("FAIL public/css/style.css 없음"); process.exit(2); }
const css = fs.readFileSync(cssPath, "utf8");

const profileDir = path.join(TMP, "p136-chrome-" + Date.now());
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", "--user-data-dir=" + profileDir, "--window-size=1400,1130", "about:blank"], { stdio: "ignore" });

async function devtoolsPort() {
  for (let i = 0; i < 80; i++) {
    try { const p = parseInt(fs.readFileSync(path.join(profileDir, "DevToolsActivePort"), "utf8").split("\n")[0], 10); if (p > 0) return p; } catch (e) {}
    await wait(150);
  }
  throw new Error("DevToolsActivePort 없음");
}
const getJson = (url) => new Promise((resolve, reject) => http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on("error", reject));

try {
  const port = await devtoolsPort();
  let pageWs = null;
  for (let i = 0; i < 40 && !pageWs; i++) { try { const l = await getJson("http://127.0.0.1:" + port + "/json/list"); const pg = l.find((t) => t.type === "page"); if (pg) pageWs = pg.webSocketDebuggerUrl; } catch (e) {} if (!pageWs) await wait(250); }
  const ws = new WebSocket(pageWs);
  await new Promise((r) => ws.on("open", r));
  let idc = 0; const pending = new Map();
  ws.on("message", (raw) => { const msg = JSON.parse(raw); if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); } });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++idc; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails).slice(0, 600)); return r.result.value; };
  const evSafe = async (expr) => { try { return await ev(expr); } catch (e) { return { __err: String(e.message).slice(0, 400) }; } };
  let shotN = 0;
  const shot = async (name) => { const s = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, String(++shotN).padStart(2, "0") + "-" + name + ".png"), Buffer.from(s.data, "base64")); };

  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1130, deviceScaleFactor: 1, mobile: false });

  // renderTree()(public/js/main.js) 가 실제로 만드는 .tree-node-deck 행 — class 전수 일치
  // (kindTag "구역" → .tree-label(긴 이름) → 상태태그 "도면없음" → .tree-src-tag "잘라옴"
  //  → .tree-cnt "0" → .tree-more "⋯"). 사이드바 데스크톱 실폭(240px - 패딩) ≈ 204px 컨테이너.
  const deckName = "아주 길고 상세한 구역 이름 — 마스터 실측 재현용";
  const headHtml =
    '<div id="__p136_host" style="width:204px;padding:8px 6px;">' +
    '<button class="tree-node tree-node-deck">' +
    '<svg class="tree-caret" viewBox="0 0 24 24" width="16" height="16"></svg>' +
    '<svg width="16" height="16"></svg>' +
    '<span class="tree-kind-tag">구역</span>' +
    '<span class="tree-label">' + deckName + '</span>' +
    '<span class="tree-tag">도면없음</span>' +
    '<span class="tree-src-tag tree-src-crop">잘라옴</span>' +
    '<span class="tree-cnt">0</span>' +
    '<span class="tree-more">\u22ef</span>' +
    '</button></div>';

  const mutCss = '#__p136_host .tree-label{flex:1 !important;min-width:0 !important;}';

  await ev(`(function(){
    document.open();
    document.write('<!doctype html><html><head><style>' + ${JSON.stringify(css)} + '${MUT ? "\\n" + mutCss : ""}' + '</style></head><body style="background:#1d2025"></body></html>');
    document.close();
    return 1;
  })()`);
  await wait(300);
  await ev(`(function(){ document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(headHtml)}); return 1; })()`);
  await wait(300);
  await shot(MUT ? "mut-row" : "fixed-row");

  const m = await evSafe(`(function(){
    var label = document.querySelector('#__p136_host .tree-label');
    var src = document.querySelector('#__p136_host .tree-src-tag');
    var head = document.querySelector('#__p136_host .tree-node-deck');
    if (!label || !src || !head) return { ok:false };
    var lr = label.getBoundingClientRect(), sr = src.getBoundingClientRect();
    return { ok:true, labelWidth: lr.width, labelText: label.textContent, srcWidth: sr.width, srcText: src.textContent };
  })()`);
  console.log((MUT ? "[MUT] " : "") + "measure:", JSON.stringify(m));

  ok(m.ok, "DOM 구성 — .tree-label/.tree-src-tag 존재", m);
  if (m.ok) {
    // 구역 이름 행(kindTag+상태태그+srcTag+cnt+더보기)이 204px 컨테이너를 넘쳐도
    // 이름이 완전히 0px 로 사라지지 않아야 한다(마스터 실측 결함의 핵심 불변식).
    ok(m.labelWidth > 20, "구역 이름(.tree-label) 폭이 0으로 접히지 않는다(>20px)", m);
    ok(m.labelText === deckName, "구역 이름 텍스트가 그대로 보존된다(잘려 사라지지 않음)", m);
  }

  ws.close();
  console.log("\n" + (failed ? "FAILED " + failed + "건: " + fails.join(", ") : "ALL PASS"));
  process.exit(failed ? 1 : 0);
} finally {
  try { chrome.kill(); } catch (e) {}
}
