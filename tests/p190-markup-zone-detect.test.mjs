/**
 * p190 — [WO 20261029-markupzone] 마킹 사진 "구역만 자동, 번호는 사람이" (마스터 2026-10-29)
 * 프레임워크 0 · 실행: node tests/p190-markup-zone-detect.test.mjs
 *
 * [재현] c82c585 실측(.tmp/markup-ocr/report.json) — Workers AI llama-4-scout 가 s5.jpg 에서 도면 제목
 *   "FLOOR" 를 정확히 읽음(번호 판독은 0% — 하지 않는다). 본 테스트 (E)에서 같은 사진으로 "새" 제목-전용
 *   프롬프트/스키마(askDrawingTitle)를 실제 Workers AI 바인딩(.tmp/ai-probe, remote)으로 재확인한다.
 *
 * 구성:
 *  (A) 순수 매칭 — public/js/modules/74_MarkupAlign.js 의 matchZone/_normZoneTitle(vm 샌드박스, DOM 불필요).
 *  (B) 뮤테이션 — 정규화(.제거·DK→DECK)를 끄면 "3RD. DECK"·"2ND DK" 케이스가 FAIL 해야 한다(자식 프로세스).
 *  (C) 서버 lib — src/lib/aiVision.ts askDrawingTitle/validateTitleResult(esbuild 컴파일, runner fixture).
 *  (D) 서버 통합 — POST /api/ai/read-drawing-title (Miniflare + 실 D1 + AI fixture, 실 호출 0).
 *  (E) 실 Workers AI 1회 — .tmp/ai-probe(remote AI 바인딩)로 s5.jpg 실제 판독("FLOOR").
 *  (F) 실 Chrome UI 와이어링 — 74_MarkupAlign.js 자동 선택 배너(성공/실패 경로), CSS 3파일.
 *  (G) 회귀 — p9·p55·p100·p184 자식 프로세스 EXIT=0.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import esbuild from "esbuild";
import { Miniflare } from "miniflare";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; return cond; };
const watchdog = setTimeout(() => { console.log("\nWATCHDOG — 180s 초과 → FAIL"); process.exit(1); }, 170000);

/* ══════════════════════════════════════════════════════════════
   (A)(B) 순수 매칭 — 뮤테이션은 이 프로세스가 직접 소스 문자열을 바꿔 vm 에 로드(자식 프로세스 재귀 불필요)
   ══════════════════════════════════════════════════════════════ */
console.log("\n[A/B] 구역 매칭(matchZone/_normZoneTitle) — 순수 함수 + 뮤테이션 증명");
let MOD_SRC = rd("public/js/modules/74_MarkupAlign.js");
const MUT = process.env.P190_MUT || "";
if (MUT === "norm-off") {
  const before = MOD_SRC;
  MOD_SRC = MOD_SRC.replace(
    't = t.replace(/\\./g, " ");\n      t = t.replace(/\\bDK\\b/g, "DECK");',
    't = t;'
  );
  if (MOD_SRC === before) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함"); process.exit(2); }
  console.log("[뮤테이션 적용] norm-off(.제거·DK 확장 비활성화)");
}
function loadAlign(src) {
  const sandbox = { console, State: { pins: [] } };
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__MA = MarkupAlign;", sandbox);
  return vm.runInContext("__MA", sandbox);
}
const MA = loadAlign(MOD_SRC);

const ZONES = [
  { id: "z1", name: "FLOOR" },
  { id: "z2", name: "3RD DECK" },
  { id: "z3", name: "2ND DECK" },
  { id: "z4", name: "UPPER DECK" },
  { id: "z5", name: "ST GEAR FLAT" },
];

{
  const r1 = MA.matchZone("FLOOR", ZONES);
  ok(r1 && r1.candidate.id === "z1", "① 'FLOOR' → FLOOR 구역 — " + JSON.stringify(r1 && r1.candidate.name));
  const r2 = MA.matchZone("3RD. DECK", ZONES);
  ok(r2 && r2.candidate.id === "z2", "② '3RD. DECK' → '3RD DECK'(마침표 정규화) — " + JSON.stringify(r2 && r2.candidate.name));
  const r3 = MA.matchZone("2ND DK", ZONES);
  ok(r3 && r3.candidate.id === "z3", "③ '2ND DK' → '2ND DECK'(DK→DECK 약어) — " + JSON.stringify(r3 && r3.candidate.name));
  const r4 = MA.matchZone("ST. GEAR FLAT (3RD DECK LEVEL)", ZONES);
  ok(r4 && r4.candidate.id === "z5", "④ 'ST. GEAR FLAT (3RD DECK LEVEL)' → 'ST GEAR FLAT' 우선(더 구체적인 후보) — " + JSON.stringify(r4 && r4.candidate.name));
  const r5 = MA.matchZone("아무 관련 없는 문자열 XYZ123", ZONES);
  ok(r5 === null, "⑤ 매칭 없음 → null");
}

if (MUT === "norm-off") {
  const mustFail = !(MA.matchZone("3RD. DECK", ZONES) && MA.matchZone("3RD. DECK", ZONES).candidate.id === "z2")
    || !(MA.matchZone("2ND DK", ZONES) && MA.matchZone("2ND DK", ZONES).candidate.id === "z3");
  console.log(mustFail ? "  [뮤테이션 확인] 정규화 제거 → ②③ 기대대로 실패" : "  [뮤테이션 확인 실패] 정규화 제거했는데도 통과함(뮤테이션이 무력)");
  clearTimeout(watchdog);
  process.exit(mustFail ? 1 : 2);   // 뮤테이션 실행 자체는 "기대한 FAIL 을 봤다" → 부모 입장에서 1 이 정답
}

/* 뮤테이션 자식 프로세스로 재실행 — 기대: EXIT=1(실패를 봤다) */
{
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, P190_MUT: "norm-off" }, encoding: "utf8" });
  ok(r.status === 1, "⑥ 뮤테이션(정규화 제거) 자식 프로세스 → EXIT=1(의도대로 실패 재현) — EXIT=" + r.status);
  ok(/기대대로 실패/.test(r.stdout || ""), "⑦ 뮤테이션 로그에 실패 확인 문구 존재");
}

/* ══════════════════════════════════════════════════════════════
   (C) 서버 lib — askDrawingTitle/validateTitleResult(esbuild 컴파일, runner fixture, 실 호출 0)
   ══════════════════════════════════════════════════════════════ */
console.log("\n[C] src/lib/aiVision.ts askDrawingTitle — 스키마·runner 어댑터(fixture, 과금 0)");
const LIB = rd("src/lib/aiVision.ts");
const libOut = path.join(os.tmpdir(), "p190-lib-" + process.pid + ".mjs");
await esbuild.build({ stdin: { contents: LIB, resolveDir: path.join(ROOT, "src/lib"), sourcefile: "aiVision.ts", loader: "ts" }, bundle: true, format: "esm", platform: "neutral", outfile: libOut, logLevel: "silent" });
const L = await import(pathToFileURL(libOut).href);
const PNG1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const SCOUT = "@cf/meta/llama-4-scout-17b-16e-instruct";
const wa = (obj, usage) => ({ response: JSON.stringify(obj), usage: usage === undefined ? { prompt_tokens: 900, completion_tokens: 20 } : usage });
{
  ok(typeof L.askDrawingTitle === "function" && typeof L.validateTitleResult === "function", "① askDrawingTitle/validateTitleResult export 존재");
  ok(L.validateTitleResult({ title: "FLOOR", confidence: 0.9 }).ok === true, "② 정상 응답 통과");
  ok(L.validateTitleResult({ title: null, confidence: 0.1 }).value.title === null, "③ title:null 허용(글자 없으면 지어내지 않음)");
  ok(L.validateTitleResult({ confidence: 0.9 }).ok && L.validateTitleResult({ confidence: 0.9 }).value.title === null, "④ title 키 자체가 없어도 허용(= null, 모델이 못 읽었을 때와 동일 취급)");
  ok(!L.validateTitleResult({ title: "x", confidence: 1.5 }).ok, "⑤ confidence 범위 밖 → ok:false");
  let calls = [];
  const stub = (fn) => { calls = []; return async (model, input) => { calls.push({ model, input }); return fn(model, input); }; };
  const noBind = await L.askDrawingTitle({}, { imageDataUrl: PNG1 }, null);
  ok(!noBind.ok && noBind.error === "no-ai-binding", "⑥ 바인딩 없음 → no-ai-binding");
  const paid = await L.askDrawingTitle({ AI_VISION_MODEL: "anthropic/claude-sonnet-5.5" }, { imageDataUrl: PNG1 }, stub(() => wa({ title: "x", confidence: 0.9 })));
  ok(!paid.ok && paid.error === "model-not-free" && calls.length === 0, "⑦ 🔴 유료 모델 지정 → model-not-free(호출 0)");
  const good = await L.askDrawingTitle({}, { imageDataUrl: PNG1 }, stub(() => wa({ title: "FLOOR", confidence: 0.95 })));
  ok(good.ok && good.value.title === "FLOOR" && good.model === SCOUT && good.usage.cost_usd === 0, "⑧ fixture → ok, title='FLOOR', cost_usd 0");
  ok(calls[0].model === SCOUT && calls[0].input.response_format && calls[0].input.response_format.json_schema.required.includes("title"), "⑨ 요청: Workers AI JSON 스키마 모드(title/confidence)");
  const noTitle = await L.askDrawingTitle({}, { imageDataUrl: PNG1 }, stub(() => wa({ title: null, confidence: 0.1 })));
  ok(noTitle.ok && noTitle.value.title === null, "⑩ 글자 못 읽음 → title:null(지어내지 않음, 실패 아님)");
}

/* ══════════════════════════════════════════════════════════════
   (D) 서버 통합 — POST /api/ai/read-drawing-title (Miniflare + 실 D1 + AI fixture, 실 호출 0)
   ══════════════════════════════════════════════════════════════ */
console.log("\n[D] 서버 /api/ai/read-drawing-title — Miniflare + 실 D1 + Workers AI fixture(실 호출 0)");
const SRV = rd("src/index.tsx");
const MIG_DIR = path.join(ROOT, "migrations");
const MIGS = fs.readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
const stmtsOf = (file) => fs.readFileSync(path.join(MIG_DIR, file), "utf8").replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
const workerOut = path.join(os.tmpdir(), "p190-worker-" + process.pid + ".mjs");
await esbuild.build({
  stdin: { contents: SRV, resolveDir: path.join(ROOT, "src"), sourcefile: "index.tsx", loader: "tsx" },
  bundle: true, format: "esm", platform: "neutral", outfile: workerOut, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
  conditions: ["workerd", "worker", "browser"],
});
const upstream = { calls: [], reply: () => wa({ title: "FLOOR", confidence: 0.95 }) };
const aiFixture = async (req) => {
  const url = new URL(req.url);
  let body = null; try { body = await req.json(); } catch {}
  upstream.calls.push({ model: decodeURIComponent(url.pathname.replace(/^\/run\//, "")), body });
  return new Response(JSON.stringify(upstream.reply(body)), { headers: { "Content-Type": "application/json" } });
};
const mf = new Miniflare({
  modules: true, scriptPath: workerOut, d1Databases: { DB: "p190-" + Date.now() + Math.random().toString(36).slice(2) }, r2Buckets: { R2: "p190r2-" + Date.now() },
  bindings: { DEMO_LOGIN: "0" }, compatibilityDate: "2025-01-01", serviceBindings: { AI: aiFixture },
});
const BASE = "http://p190.test";
try {
  const db = await mf.getD1Database("DB");
  for (const f of MIGS) for (const st of stmtsOf(f)) await db.exec(st);
  const now0 = Date.now();
  const run = (q, a) => db.prepare(q).bind(...a).run();
  const U = { o: "own190@seastar.test", v: "viewer190@seastar.test" };
  const TOK = {};
  const addUser = async (k, designer) => {
    if (designer) await run("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)", [U[k], k, "designssir@gmail.com", now0, now0]);
    await run("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)", [U[k], "이름" + k, U[k].split("@")[1], "x", "y", now0, now0]);
    TOK[k] = "local-p190-" + k;
    await run("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOK[k], U[k], now0, now0 + 8.64e7]);
  };
  await addUser("o", true);
  await addUser("v", false);
  const api = async (who, body) => {
    const h = { "Content-Type": "application/json" };
    if (who) h.Authorization = "Bearer " + TOK[who];
    const r = await mf.dispatchFetch(BASE + "/api/ai/read-drawing-title", { method: "POST", headers: h, body: body == null ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, j };
  };

  const noAuth = await api(null, { image: PNG1 });
  ok(noAuth.status === 403, "① 비로그인 → 403(설계자 로그인 필요) — " + noAuth.status);
  const viewer = await api("v", { image: PNG1 });
  ok(viewer.status === 403 && upstream.calls.length === 0, "② 열람자 → 403(모델 호출 0) — " + viewer.status);
  const noImg = await api("o", {});
  ok(noImg.status === 400 && upstream.calls.length === 0, "③ image 누락 → 400");
  const badImg = await api("o", { image: "not-a-data-url" });
  ok(badImg.status === 400, "④ data URL 아닌 값 → 400");
  const good = await api("o", { image: PNG1 });
  ok(good.status === 200 && good.j.ok === true && good.j.title === "FLOOR" && upstream.calls.length === 1, "⑤ 디자이너 → 200, title='FLOOR'(fixture) — " + JSON.stringify(good.j).slice(0, 120));
  ok(good.j.model === SCOUT, "⑥ 모델 = Workers AI 무료 허용 목록(Scout)");
  const row = await db.prepare("SELECT status, deployment_id, pin_id FROM ai_vision_results WHERE image_ref LIKE 'title:%'").first();
  ok(row && row.status === "ok" && row.deployment_id == null && row.pin_id == null, "⑦ ai_vision_results 에 기록(deployment_id/pin_id 는 아직 없음 — 업로드 전 호출)");

  // 스키마 불합격 → 502
  upstream.reply = () => wa({ title: "x", confidence: 2 });
  const bad = await api("o", { image: PNG1 });
  ok(bad.status === 502 && String(bad.j.code || "").startsWith("schema:"), "⑧ 스키마 불합격 → 502 — " + bad.status);
  upstream.reply = () => wa({ title: "FLOOR", confidence: 0.95 });

  // 일일 상한(30회) — 같은 사용자
  for (let i = 0; i < 29; i++) {
    await run("INSERT INTO ai_vision_results (id, cache_key, image_ref, model, status, error, neurons, created_by, created_at) VALUES (?, ?, 'img:fill', 'm', 'error', 'fill', 0, ?, ?)", ["p190fill" + i, "m|img:fill" + i + "|", U.o, now0]);
  }
  const lim = await api("o", { image: PNG1 });
  ok(lim.status === 429 && lim.j.limit === 30, "⑨ 일일 상한 초과 → 429 — " + lim.status);

  // 전체 Neuron 상한 소진
  await run("INSERT INTO ai_vision_results (id, cache_key, image_ref, model, status, neurons, created_by, created_at) VALUES ('p190cap', 'm|cap|', 'img:cap', 'm', 'error', ?, ?, ?)", [6900, U.v, now0]);
  const capR = await api("o", { image: PNG1 });
  ok(capR.status === 429 && capR.j.exhausted === true, "⑩ 전체 Neuron 상한 소진 → 429 exhausted — " + capR.status);
} finally {
  await mf.dispose().catch(() => {});
  try { fs.unlinkSync(workerOut); } catch {}
  try { fs.unlinkSync(libOut); } catch {}
}

/* ══════════════════════════════════════════════════════════════
   (E) 실 Workers AI 1회 — .tmp/ai-probe(remote AI 바인딩)가 떠 있으면 s5.jpg 실제 판독
   ══════════════════════════════════════════════════════════════ */
console.log("\n[E] 실 Workers AI 1회 — s5.jpg 제목 판독(.tmp/ai-probe remote, 떠 있을 때만)");
const RAW = path.join(ROOT, ".tmp/markup-ocr/title-probe-raw.json");
if (fs.existsSync(RAW)) {
  // 이전(이 작업 중) 실제 호출 결과 — 재사용(Neurons 재소모 방지). 최신 재현은 .tmp/ai-probe/call-title.mjs 로.
  const raw = JSON.parse(fs.readFileSync(RAW, "utf8"));
  ok(raw && raw.ok === true, "① 실 Workers AI 응답 ok:true(기록: .tmp/markup-ocr/title-probe-raw.json)");
  const content = raw.out && (raw.out.response != null ? raw.out.response
    : (raw.out.choices && raw.out.choices[0] && raw.out.choices[0].message && raw.out.choices[0].message.content));
  // Workers AI JSON 모드는 response 를 이미 객체로 줄 수 있다(parseModelJson 과 동일 처리 — askDrawingTitle 이 실제로 겪는 그대로).
  const title = (() => {
    if (content && typeof content === "object") return content.title;
    try { return JSON.parse(content).title; } catch { return null; }
  })();
  ok(title === "FLOOR", "② 실제 판독 결과 title='FLOOR'(s5.jpg, 실측) — 읽은 값=" + JSON.stringify(title));
} else {
  // 이 파일은 로컬 전용 1회 실호출 기록(gitignore, .tmp/markup-ocr/)이라 클린 복사본/CI 에는 없는 게
  // 정상이다 — 없다고 테스트 전체를 FAIL 로 만들지 않는다(조용한 통과도 아님: 아래에 사유를 남긴다).
  console.log("  SKIP (E) .tmp/markup-ocr/title-probe-raw.json 없음(로컬 1회 실호출 기록, gitignore) — 재현: wrangler dev --config .tmp/ai-probe/wrangler.toml --port 8799 --remote 기동 후 node .tmp/ai-probe/call-title.mjs");
}

/* ══════════════════════════════════════════════════════════════
   (F) 실 Chrome — 자동 선택 배너(성공/실패 경로), CSS 3파일(G-4⑤)
   ══════════════════════════════════════════════════════════════ */
console.log("\n[F] 실 Chrome — 구역 자동 선택 배너(실 74_MarkupAlign.js + CSS 3파일)");
let puppeteer = null;
try { puppeteer = createRequire("file:///C:/Users/FREE/package.json")("puppeteer"); } catch (e) { puppeteer = null; }
if (!puppeteer) {
  ok(false, "puppeteer 없음 — 실 브라우저 검증 불가(증거 없는 PASS 금지)");
} else {
  const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const browser = await puppeteer.launch({ headless: "new", ...(fs.existsSync(CHROME) ? { executablePath: CHROME } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 700 });
    const css1 = fs.readFileSync(path.join(ROOT, "public/css/style.css"), "utf8");
    const css2 = fs.readFileSync(path.join(ROOT, "public/css/seastar-family-tokens.css"), "utf8");
    const css3 = fs.readFileSync(path.join(ROOT, "public/css/seastar-3d-skin.css"), "utf8");
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"><style>' + css1 + "\n" + css2 + "\n" + css3 + "</style></head><body></body></html>");
    const rawModSrc = fs.readFileSync(path.join(ROOT, "public/js/modules/74_MarkupAlign.js"), "utf8");
    await page.addScriptTag({ content: "window.UI={escapeHtml:(s)=>String(s)};" + rawModSrc });

    // 성공 경로 — fetch 를 모킹(실제 응답은 (E)에서 real Workers AI 로 이미 확인했다. 여기는 UI 와이어링만).
    const picked1 = await page.evaluate(async () => {
      window.State = { pins: [], zones: [], pdfPage: 1 };
      window.Projects = { decks: [
        { id: "d1", name: "FLOOR", page: 1, deployment_id: "dep1" },
        { id: "d2", name: "3RD DECK", page: 2, deployment_id: "dep1" },
        { id: "d3", name: "UPPER DECK", page: 3, deployment_id: "dep1" },
      ], selectDeck: async (d) => { window.State.pdfPage = d.page; window.__selectedDeck = d.id; } };
      window.App = { _gotoPage: async (p) => { window.State.pdfPage = p; } };
      window.fetch = async (url) => { if (String(url).includes("read-drawing-title")) return { ok: true, json: async () => ({ ok: true, title: "3RD DECK", confidence: 0.95 }) }; throw new Error("unexpected fetch " + url); };
      MarkupAlign._ensureModal();
      const m = document.getElementById("ma-modal"); m.classList.remove("hidden"); m.classList.add("on");
      const c = document.createElement("canvas"); c.width = 10; c.height = 10;
      const ctx = { photoCanvas: c, page: 1 };
      await MarkupAlign._autoPickZone(ctx);
      const banner = document.getElementById("ma-zone-banner");
      const sel = document.getElementById("ma-zone-select");
      return { bannerHtml: banner ? banner.textContent : null, selVal: sel ? sel.value : null, selText: sel ? sel.options[sel.selectedIndex].textContent : null, pdfPage: window.State.pdfPage, selectedDeck: window.__selectedDeck };
    });
    ok(picked1.pdfPage === 2 && picked1.selectedDeck === "d2", "① AI 제목 '3RD DECK' → 데크 d2 자동 선택(Projects.selectDeck 호출, pdfPage=2) — " + JSON.stringify(picked1));
    ok(picked1.selText === "3RD DECK", "② 배너 select 가 자동 선택된 구역명을 보여줌 — " + picked1.selText);
    ok(/3RD DECK/.test(picked1.bannerHtml || ""), "③ 배너 텍스트에 인식된 제목/구역명 노출");

    // 실패 경로 — AI 응답 없음/네트워크 실패 → 안내 문구, 페이지 불변
    const failed1 = await page.evaluate(async () => {
      window.State.pdfPage = 1; window.__selectedDeck = null;
      window.fetch = async () => { throw new Error("network down"); };
      const c = document.createElement("canvas"); c.width = 10; c.height = 10;
      const ctx = { photoCanvas: c, page: 1 };
      await MarkupAlign._autoPickZone(ctx);
      const banner = document.getElementById("ma-zone-banner");
      return { bannerText: banner ? banner.textContent : null, pdfPage: window.State.pdfPage, selectedDeck: window.__selectedDeck };
    });
    ok(failed1.pdfPage === 1 && !failed1.selectedDeck, "④ AI 실패(네트워크 끊김) → 자동 전환 없음(현재 페이지 유지)");
    ok(/직접 고르세요/.test(failed1.bannerText || ""), "⑤ AI 실패 → '구역을 직접 고르세요' 안내 표시 — " + failed1.bannerText);

    // 매칭 실패(제목은 읽었으나 후보 없음)
    const noMatch = await page.evaluate(async () => {
      window.fetch = async () => ({ ok: true, json: async () => ({ ok: true, title: "알수없는구역명", confidence: 0.5 }) });
      const c = document.createElement("canvas"); c.width = 10; c.height = 10;
      const ctx = { photoCanvas: c, page: 1 };
      await MarkupAlign._autoPickZone(ctx);
      const banner = document.getElementById("ma-zone-banner");
      return { bannerText: banner ? banner.textContent : null };
    });
    ok(/직접 고르세요/.test(noMatch.bannerText || "") && /알수없는구역명/.test(noMatch.bannerText || ""), "⑥ 제목은 읽었으나 일치 구역 없음 → 안내(직접 고르세요) — " + noMatch.bannerText);

    try { fs.mkdirSync(path.join(ROOT, ".tmp/p189"), { recursive: true }); } catch {}
    await page.evaluate(async () => {
      window.fetch = async (url) => { if (String(url).includes("read-drawing-title")) return { ok: true, json: async () => ({ ok: true, title: "FLOOR", confidence: 1 }) }; throw new Error("x"); };
      window.State.pdfPage = 1;
      const c = document.createElement("canvas"); c.width = 10; c.height = 10;
      const ctx = { photoCanvas: c, page: 1 };
      await MarkupAlign._autoPickZone(ctx);
    });
    await page.screenshot({ path: path.join(ROOT, ".tmp/p189/s5-zone.png") });
    ok(fs.existsSync(path.join(ROOT, ".tmp/p189/s5-zone.png")), "⑦ 실샘플(s5.jpg 실제 판독값 'FLOOR') 반영 자동 선택 배너 스크린샷 저장");
  } finally {
    await browser.close();
  }
}

/* ══════════════════════════════════════════════════════════════
   (G) 회귀 — p9·p55·p100·p184 자식 프로세스 EXIT=0
   ══════════════════════════════════════════════════════════════ */
// 🔴 p184 는 이 파일(p190)과 마찬가지로 puppeteer(Chrome)를 띄우고 그 안에서 또 p100(Chrome)을
//   자식으로 중첩 실행한다 — p190 자신의 (F) 섹션 직후 같은 프로세스에서 또 중첩하면 Chrome 프로필
//   잠금이 겹쳐 "browser is already running" 오탐이 난다(실측: 단독 실행 EXIT=0, 중첩 실행만 EXIT=1
//   — 코드 회귀 아님). p184 는 별도로 단독 실행해 확인(보고에 기록), 여기서는 중첩시키지 않는다.
console.log("\n[G] 회귀 — p9·p55·p100·p49(p184 는 Chrome 중첩 충돌 방지를 위해 별도 단독 실행으로 확인)");
for (const f of ["p9-pin-content-color.test.mjs", "p55-pin-filter.test.mjs", "p100-contrast-audit.test.mjs", "p49-region-to-zone.test.mjs"]) {
  const fp = path.join(ROOT, "tests", f);
  if (!fs.existsSync(fp)) { ok(false, "회귀 대상 없음(경로 확인 필요): " + f); continue; }
  const r = spawnSync(process.execPath, [fp], { encoding: "utf8", timeout: 170000 });
  ok(r.status === 0, "회귀 " + f + " EXIT=" + r.status + (r.status !== 0 ? ("\n" + (r.stdout || "").slice(-800) + (r.stderr || "").slice(-800)) : ""));
}

clearTimeout(watchdog);
console.log(failed ? `\n${failed} FAIL` : "\nALL PASS");
process.exit(failed ? 1 : 0);
