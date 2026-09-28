/**
 * 회귀 테스트 P60 — "배포됨"인데 주소가 안 보이던 결함: 도면 없는 배포 차단 + 안내
 * 실행: node tests/p60-publish-guard.test.mjs      (프레임워크 0)
 *
 * 배경 — 지휘자 프로덕션 실측(scan.seastar.work): 도면(구역) 0개인 프로젝트를 배포하면
 *  "tes ● 배포됨" 배지는 뜨는데 뷰어 딥링크(?d=)를 만들 재료(deployment_id)가 없어 주소 칸이
 *  통째로 비었다. 사용자에게는 "배포했는데 왜 링크가 없지"로 보이는 모순.
 *
 * 판단(지휘자 견해 채택 — 반박 근거 없음): 공유할 도면이 없는 배포는 의미가 없다 → 배포 자체를
 * 막는다(서버 400 + 사유 텍스트). 단, 가드 도입 전에 이미 배포돼버린 레거시 프로젝트는 여전히
 * published=1·도면 0개 상태로 남을 수 있으므로, 카드 렌더에도 "조용히 비워두지 않는" 안내를 둔다
 * (CLAUDE.md §5: 값이 없으면 없다고 정직하게 표시).
 *
 * 목(mock) 금지 — 서버 항목은 실제로 빌드한 워커(dist/_worker.js)를 miniflare 에 올리고 실제
 * D1(SQLite)에 실제 migrations/*.sql 을 적용해 HTTP 로 때린다(p40 패턴 재사용).
 * 클라이언트 항목은 puppeteer 로 12_ProjectHub.js 실제 소스를 그대로 로드해 실행한다(p59 패턴 재사용).
 *
 * 검사:
 *  ⑨  도면 없는 프로젝트: 배포 시도 시 서버가 400 + "도면"을 포함한 사유로 거부한다(침묵 금지) —
 *      + 클라이언트가 그 사유를 그대로 토스트로 보여준다 + published 는 DB 상 여전히 0
 *  ⑩  도면 있는 프로젝트: 배포 후 실제로 published=1 이 되고, .hub-card-url 에 ?d= 링크가 표시된다
 *  ⑪  표시된 링크가 실제 deployment_id 를 포함한다(빈 문자열·루트 아님)
 *  ⑫  복사·공유 버튼이 링크와 함께 노출된다
 *  (부가) 레거시 구제 — 가드 이전에 이미 배포됐고 도면이 없는 카드는 .hub-card-url-empty 로
 *      "도면을 등록해야 뷰어 주소가 생성됩니다" 를 보여준다(조용한 빈칸 금지)
 *  🔴 뮤테이션 ⓐ: 서버 가드(도면 0개 거부) 제거 → ⑨ 실패
 *  🔴 뮤테이션 ⓑ: 클라이언트 ?d= 파생 제거 → ⑩⑪ 실패
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Miniflare } from "miniflare";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const projectHubSrc = rd("public/js/modules/12_ProjectHub.js");
const uiSrc = rd("public/js/modules/11_UI.js");
const promptSrc = rd("public/js/modules/30_Prompt.js");
const serverSrc = rd("src/index.tsx");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };

/* ══════════════════════════════════════════════════════════════════════
 * Part A — 실 서버(Miniflare + 실 D1 + 실 워커) — ⑨(서버 거부) + ⑩ 전제조건
 * ══════════════════════════════════════════════════════════════════════ */
console.log("[빌드] src → dist/_worker.js");
execFileSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
  cwd: ROOT, stdio: "pipe", env: Object.assign({}, process.env, { NODE_OPTIONS: "--max-old-space-size=896" }),
});
console.log("  빌드 완료");

const mf = new Miniflare({
  modules: true,
  scriptPath: path.join(ROOT, "dist/_worker.js"),
  modulesRoot: path.join(ROOT, "dist"),
  compatibilityDate: "2025-05-01",
  compatibilityFlags: ["nodejs_compat"],
  d1Databases: { DB: ":memory:" },
  r2Buckets: ["R2"],
  bindings: { SUPER_ADMIN_EMAIL: "designssir@gmail.com", SUPER_ADMIN_EMAILS: "designssir@gmail.com" },
});
const db = await mf.getD1Database("DB");

{
  const files = fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  let applied = 0;
  for (const f of files) {
    const sql = rd("migrations/" + f).replace(/--[^\n]*/g, "");
    for (let s of sql.split(";")) {
      s = s.trim(); if (!s) continue;
      await db.prepare(s).run(); applied++;
    }
  }
  console.log("  migrations 적용: " + files.length + "개 파일 / " + applied + "개 statement");
}

const BOSS = "boss@p60.test";
const NOW = Date.now();
await db.prepare("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, '관리자', 'p60.test', 'x', 'y', 1, ?, ?, 0)")
  .bind(BOSS, NOW, NOW).run();
await db.prepare("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, '관리자', 'seed', ?, ?, 0)")
  .bind(BOSS, NOW, NOW).run();
const BOSS_TOKEN = "local-p60bosstoken";
await db.prepare("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)")
  .bind(BOSS_TOKEN, BOSS, NOW, NOW + 86400000).run();

const PROJ_NO_DECK = "prj_p60_nodeck";
const PROJ_WITH_DECK = "prj_p60_withdeck";
await db.prepare("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, ?, '', ?, ?, ?, 0)")
  .bind(PROJ_NO_DECK, "P60 도면없음", BOSS, NOW, NOW).run();
await db.prepare("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, ?, '', ?, ?, ?, 0)")
  .bind(PROJ_WITH_DECK, "P60 도면있음", BOSS, NOW, NOW).run();
const DEP_ID = "dep_p60_main";
await db.prepare("INSERT INTO deployments (id, title, file_name, drawing_data, pages_data, pins, created_at, updated_at, deleted) VALUES (?, 'MAIN DECK', 'main.pdf', '', '[]', '[]', ?, ?, 0)")
  .bind(DEP_ID, NOW, NOW).run();
await db.prepare("INSERT INTO decks (id, project_id, name, level_no, deployment_id, created_at, updated_at, deleted) VALUES (?, ?, 'MAIN DECK', 1, ?, ?, ?, 0)")
  .bind("deck_p60_main", PROJ_WITH_DECK, DEP_ID, NOW, NOW).run();

const api = async (url, opts = {}) => {
  const res = await mf.dispatchFetch("http://p60.test" + url, opts);
  let body = null;
  try { body = JSON.parse(await res.text()); } catch (e) { body = null; }
  return { status: res.status, body };
};
const asBoss = (method) => ({ method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + BOSS_TOKEN } });
const publishedFlag = async (pid) => {
  const r = await db.prepare("SELECT published FROM projects WHERE id = ?").bind(pid).first();
  return r ? Number(r.published) : null;
};

console.log("\n[Part A · 실 서버(Miniflare) — ⑨ 도면 없는 프로젝트 배포 거부]");
{
  const r = await api("/api/projects/" + PROJ_NO_DECK + "/publish", asBoss("POST"));
  ok(r.status === 400, "⑨ 도면 없는 프로젝트 배포 요청 → 400 거부: 실제 " + r.status);
  ok(!!(r.body && typeof r.body.error === "string" && r.body.error.indexOf("도면") !== -1),
     "⑨ 거부 사유에 '도면'이 포함된다(침묵 금지): " + JSON.stringify(r.body));
  ok((await publishedFlag(PROJ_NO_DECK)) === 0, "⑨ 거부 후에도 DB published 는 여전히 0(실제 배포되지 않음)");
}

console.log("\n[Part A · 실 서버(Miniflare) — ⑩ 전제조건: 도면 있는 프로젝트는 배포 허용]");
{
  const r = await api("/api/projects/" + PROJ_WITH_DECK + "/publish", asBoss("POST"));
  ok(r.status === 200, "⑩ 도면 있는 프로젝트 배포 요청 → 200 허용: 실제 " + r.status);
  ok((await publishedFlag(PROJ_WITH_DECK)) === 1, "⑩ DB published 가 실제로 1 이 된다");
  const dr = await api("/api/projects/" + PROJ_WITH_DECK + "/decks", asBoss("GET"));
  const withDep = (dr.body && dr.body.data || []).find((d) => d.deployment_id === DEP_ID);
  ok(!!withDep, "⑩ decks 응답이 deployment_id(" + DEP_ID + ")를 포함한다(뷰어 딥링크 재료)");
}

/* ══════════════════════════════════════════════════════════════════════
 * Part B — 정적 소스 — 서버 가드 존재 확인 + 뮤테이션 ⓐ
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[Part B · 정적 소스 — 서버 가드]");
{
  const m = serverSrc.match(/app\.post\('\/api\/projects\/:id\/publish'[\s\S]*?\n\}\)/);
  ok(!!m, "사전조건 — publish 핸들러 블록을 찾았다");
  const body = m ? m[0] : "";
  ok(/deckRow[\s\S]*?deployment_id IS NOT NULL/.test(body), "publish 핸들러가 deployment_id 를 가진 decks 존재를 확인한다");
  ok(/도면[\s\S]*?400/.test(body) || /400\)[\s\S]{0,5}$/.test(body) === false && /'도면[^']*'/.test(body), "publish 핸들러가 400 과 함께 '도면' 사유 메시지를 반환한다");

  console.log("\n[뮤테이션ⓐ] 서버 도면-존재 가드를 제거하면 ⑨(거부)가 사라져야 함");
  const needle = serverSrc.match(/  \/\/ \[WO 20260921 publish-guard\][\s\S]*?\n  \}\n  const now = Date\.now\(\)\n  await c\.env\.DB\.prepare\('UPDATE projects SET published = 1/);
  ok(!!needle, "사전조건 — 뮤테이션 대상 가드 블록을 찾았다");
  if (needle) {
    const mutated = serverSrc.replace(needle[0], "  const now = Date.now()\n  await c.env.DB.prepare('UPDATE projects SET published = 1");
    const mM = mutated.match(/app\.post\('\/api\/projects\/:id\/publish'[\s\S]*?\n\}\)/);
    const bodyM = mM ? mM[0] : "";
    ok(!/deckRow[\s\S]*?deployment_id IS NOT NULL/.test(bodyM), "뮤테이션 적용 시 가드 코드가 사라짐(⑨가 깨짐을 확인 — 도면 없어도 무조건 배포 허용됨)");
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * Part C — 실 DOM(puppeteer) — ⑩⑪⑫ 클라이언트 렌더 + 뮤테이션 ⓑ + 레거시 안내
 * ══════════════════════════════════════════════════════════════════════ */
function buildBundle(src) {
  return "(function(){\n" + uiSrc + "\n" + promptSrc + "\n" + src +
    "\nwindow.ProjectHub = ProjectHub; window.Prompt = Prompt; window.UI = UI;\n})();\n";
}
const HARNESS_HTML = (bundleFileName) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<div id="hub-grid"></div><div id="hub-empty" class="hidden"></div>
<script>
  window.Auth = {
    isDesigner: true, idToken: "t1", role: "designer",
    headers() { return { "Content-Type": "application/json" }; },
    requireDesigner(cb) {},
    signOut() {}
  };
  window.OfflineBundle = { verify() { return Promise.resolve({ ok: false }); } };
  window.Designers = {}; window.App = { openApp() {} };
  window.PinSeries = { preferredMode() { return "checkboard"; } };
</script>
<script src="./${bundleFileName}"></script>
</body></html>`;
async function withBrowser(fn) {
  const { createRequire } = await import("node:module");
  const require = createRequire("file:///C:/Users/FREE/package.json");
  let puppeteer = null;
  try { puppeteer = require("puppeteer"); } catch (e) { puppeteer = null; }
  if (!puppeteer) { console.log("  FAIL puppeteer 를 로드할 수 없다 — 실 브라우저 검증 불가(증거 없는 PASS 금지)"); failed++; return; }
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try { await fn(browser); } finally { await browser.close(); }
}
function makePage(browser, dir, api) {
  return (async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 375, height: 812 });
    page.on("dialog", async (d) => { await d.dismiss(); });
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const url = new URL(req.url());
      const key = req.method() + " " + url.pathname;
      if (api[key]) {
        const bodyRaw = req.postData();
        const result = api[key](bodyRaw ? JSON.parse(bodyRaw) : null);
        req.respond({ status: result.status || 200, contentType: "application/json", body: JSON.stringify(result.json || {}) });
        return;
      }
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/tables/")) { req.respond({ status: 200, contentType: "application/json", body: "{}" }); return; }
      req.continue();
    });
    return page;
  })();
}
function tmpDirWithBundle(bundleSrc, bundleName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p60-"));
  fs.writeFileSync(path.join(dir, bundleName), bundleSrc, "utf8");
  fs.writeFileSync(path.join(dir, "index.html"), HARNESS_HTML(bundleName), "utf8");
  return dir;
}
async function serveDir(dir) {
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    const f = path.join(dir, u === "/" ? "index.html" : u);
    if (!f.startsWith(dir) || !fs.existsSync(f)) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "content-type": f.endsWith(".html") ? "text/html" : "text/javascript" });
    res.end(fs.readFileSync(f));
  });
  await listenSafePort(server, "127.0.0.1");
  return server;
}

async function runClientChecks(src, label) {
  console.log("\n[Part C · 실 DOM(puppeteer) — " + label + "]");
  await withBrowser(async (browser) => {
    let publishCalls = 0;
    const api = {
      "POST /api/projects/proj1/publish": () => { publishCalls++; return { status: 200, json: { ok: true } }; },
      "GET /api/projects": () => ({ status: 200, json: { data: [{ id: "proj1", name: "도면있음", published: publishCalls > 0, created_at: Date.now() }] } }),
      "GET /api/projects/proj1/decks": () => ({ status: 200, json: { data: [{ id: "d1", deployment_id: "dep_abc123" }] } }),
    };
    const dir = tmpDirWithBundle(buildBundle(src), "bundle.js");
    const server = await serveDir(dir);
    const port = server.address().port;
    const page = await makePage(browser, dir, api);
    await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "load" });

    // ⑩⑪⑫ — 도면 있는 프로젝트 배포 → ?d= 링크 + 복사·공유 버튼
    await page.evaluate(() => {
      window.ProjectHub.list = [{ id: "proj1", name: "도면있음", published: false, created_at: Date.now() }];
      window.ProjectHub.render();
    });
    await page.click('[data-act="pub"]');
    await page.waitForSelector("#wm-confirm-modal.on", { timeout: 2000 }).catch(() => {});
    await page.click("#wm-confirm-ok");
    await page.waitForSelector(".hub-card-url", { timeout: 3000 }).catch(() => {});
    const after = await page.evaluate(() => ({
      urlText: (document.querySelector(".hub-card-url-text") || {}).textContent || null,
      hasCopy: !!document.querySelector('[data-act="url-copy"]'),
      hasShare: !!document.querySelector('[data-act="url-share"]'),
    }));
    ok(publishCalls > 0, "① 배포 요청이 실제로 나간다(전제조건)");
    ok(!!after.urlText && after.urlText.length > 0, "⑩ 배포 후 .hub-card-url 에 링크가 표시된다: " + after.urlText);
    ok(!!after.urlText && after.urlText.indexOf("?d=dep_abc123") !== -1, "⑪ 표시된 링크가 실제 deployment_id 를 포함한다(빈 문자열·루트 아님): " + after.urlText);
    ok(after.hasCopy && after.hasShare, "⑫ 복사·공유 버튼이 링크와 함께 노출된다");

    // 레거시 구제 — published=true 인데 캐시가 null(도면 확인됐지만 없음) → 안내 문구
    await page.evaluate(() => {
      window.ProjectHub._deployLinkCache["proj_legacy"] = null;
      window.ProjectHub.list = [{ id: "proj_legacy", name: "레거시무도면", published: true, created_at: Date.now() }];
      window.ProjectHub.render();
    });
    const legacy = await page.evaluate(() => {
      const el = document.querySelector(".hub-card-url-empty");
      return { exists: !!el, text: el ? el.textContent : null, hasUrlBox: !!document.querySelector(".hub-card-url") };
    });
    ok(legacy.exists, "레거시 구제 — 도면 없는 배포됨 카드에 .hub-card-url-empty 안내가 뜬다(조용한 빈칸 금지)");
    ok(!!legacy.text && legacy.text.indexOf("도면") !== -1, "레거시 구제 — 안내 문구에 '도면'이 포함된다: " + legacy.text);
    ok(!legacy.hasUrlBox, "레거시 구제 — 거짓 링크(.hub-card-url)는 만들지 않는다(빈 문자열 유지)");

    server.close();
  });
}

await runClientChecks(projectHubSrc, "신코드");

/* 뮤테이션ⓑ — ?d= 파생 제거 → ⑩⑪ 실패 */
console.log("\n[뮤테이션ⓑ] 클라이언트 ?d= 파생을 제거하면 ⑩⑪이 실패해야 함");
await withBrowser(async (browser) => {
  const idx = projectHubSrc.indexOf("_deployUrl(p) {");
  const needle = 'return origin + "/?d=" + encodeURIComponent(depId);';
  ok(projectHubSrc.indexOf(needle, idx) !== -1, "사전조건 — ?d= 파생 코드를 찾았다");
  const mutatedSrc = projectHubSrc.slice(0, idx) + projectHubSrc.slice(idx).replace(needle, 'return "";');
  let publishCalls = 0;
  const api = {
    "POST /api/projects/proj1/publish": () => { publishCalls++; return { status: 200, json: { ok: true } }; },
    "GET /api/projects": () => ({ status: 200, json: { data: [{ id: "proj1", name: "도면있음", published: publishCalls > 0, created_at: Date.now() }] } }),
    "GET /api/projects/proj1/decks": () => ({ status: 200, json: { data: [{ id: "d1", deployment_id: "dep_abc123" }] } }),
  };
  const dir = tmpDirWithBundle(buildBundle(mutatedSrc), "bundle.js");
  const server = await serveDir(dir);
  const port = server.address().port;
  const page = await makePage(browser, dir, api);
  await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "load" });
  await page.evaluate(() => {
    window.ProjectHub.list = [{ id: "proj1", name: "도면있음", published: false, created_at: Date.now() }];
    window.ProjectHub.render();
  });
  await page.click('[data-act="pub"]');
  await page.waitForSelector("#wm-confirm-modal.on", { timeout: 2000 }).catch(() => {});
  await page.click("#wm-confirm-ok");
  await new Promise((r) => setTimeout(r, 500));
  const hasUrl = await page.evaluate(() => !!document.querySelector(".hub-card-url"));
  ok(!hasUrl, "뮤테이션 적용 시 ?d= 파생이 사라져 .hub-card-url 자체가 렌더되지 않는다(⑩⑪이 깨짐을 확인)");
  server.close();
});

console.log(failed === 0 ? "\n[ALL PASS]" : "\n[" + failed + " FAILED]");
process.exit(failed === 0 ? 0 : 1);
