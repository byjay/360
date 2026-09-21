/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p59-publish-action.test.mjs)
 *
 * 배경 — 지휘자 프로덕션 재현(scan.seastar.work, 375×812, SW·캐시·localStorage 삭제 후):
 *   "배포" 버튼 클릭 → 네트워크 요청 0건 · 토스트 0건 · 콘솔오류 없음 · 카드 상태 그대로.
 *   버튼 자체는 존재하고 핸들러도 코드상 연결돼 있었다(12_ProjectHub.js:474 addEventListener).
 *
 * 근본원인(실측 — 본 테스트 파일 하단 REAL-DOM 파트에서 구 코드로 직접 재현):
 *   togglePublish()가 window.confirm()의 반환값으로 진행 여부를 결정하는데, PWA 독립실행모드
 *   (manifest.webmanifest: display=standalone)에서는 iOS 등 다수 플랫폼이 window.confirm()/alert()/
 *   prompt()를 지원하지 않아 "아무 표시 없이 즉시 false"를 반환한다(알려진 WebKit 제약).
 *   → `if (willPublish && !confirm(...)) return;` 이 조용히 true가 되어 fetch 이전에 즉시 return —
 *     네트워크 0건·토스트 0건·콘솔오류 0건이 정확히 설명된다.
 *
 * 수정: window.confirm() → Prompt.confirm()(30_Prompt.js 신설, admin-gate CSS 재사용 커스텀 DOM
 *   모달) — 네이티브 브라우저 다이얼로그에 의존하지 않으므로 PWA 독립실행모드 제약을 받지 않는다.
 *   또한 배포주소(98a771a)의 "subdomain 없으면 사이트 루트로 폴백"을 제거하고, 뷰어 딥링크(?d=)를
 *   /api/projects/:id/decks 조회로 얻어 항상 "프로젝트를 식별하는" 주소만 노출한다(12_ProjectHub.js
 *   _deployUrl/_resolveDeployLinks).
 *
 * 검사:
 *  Part A(정적 소스) — ⑤ 실패 시 사용자 알림(조용한 실패 0), ④ 주소가 프로젝트를 식별(루트 폴백 금지)
 *   + 뮤테이션 ⓒ 실패 알림 제거, ⓓ 루트 폴백으로 되돌림
 *  Part B(실 DOM, 실제 소스 그대로 로드 — 11_UI/30_Prompt/12_ProjectHub) —
 *   ① 배포 클릭 시 실제 fetch 요청 발생 ② 성공 시 published 상태 변경 + 카드 재렌더
 *   ③ 성공 시 .hub-card-url 즉시 노출 ④ 주소가 ?d= 딥링크(프로젝트 식별) ⑥ 복사 동작
 *   ⑦ 미배포 카드엔 주소 없음(회귀) + 뮤테이션 ⓐ 핸들러 연결 제거 → ①이 깨짐
 *  Part C — 구 코드(HEAD 커밋본)를 그대로 로드해 "PWA 독립실행모드 confirm() 무음 false" 조건에서
 *   실제로 fetch 가 0건임을 재현(신 코드는 같은 조건에서 정상 동작함을 대조 증명)
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const projectHubSrc = rd("public/js/modules/12_ProjectHub.js");
const promptSrc = rd("public/js/modules/30_Prompt.js");
const uiSrc = rd("public/js/modules/11_UI.js");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };

/* ══════════════════════════════════════════════════════════════════
 * Part A — 정적 소스 검사 (⑤ 실패 알림, ④ 주소 식별) + 뮤테이션 ⓒⓓ
 * ══════════════════════════════════════════════════════════════════ */
console.log("[Part A · 정적 소스]");
{
  const m = projectHubSrc.match(/async togglePublish\(p, btn\) \{[\s\S]*?\n    \},/);
  ok(!!m, "사전조건 — togglePublish() 블록을 찾았다");
  const body = m ? m[0] : "";
  ok(/Prompt\.confirm\(/.test(body), "togglePublish() 가 Prompt.confirm() 을 사용한다(window.confirm 제거)");
  const bodyNoComments = body.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
  ok(!/[^.]\bconfirm\(/.test(bodyNoComments.replace(/Prompt\.confirm/g, "")), "togglePublish() 코드(주석 제외) 안에 네이티브 confirm() 호출이 남아있지 않다");
  ok(/catch \(e\) \{[\s\S]*?Prompt\.toast\([\s\S]*?배포 처리 실패/.test(body), "⑤ 실패 시 Prompt.toast 로 사용자에게 알린다(조용한 실패 0)");

  console.log("\n[뮤테이션ⓒ] 실패 알림(Prompt.toast) 을 제거하면 ⑤가 실패해야 함");
  const needle = 'Prompt && Prompt.toast && Prompt.toast("배포 처리 실패: " + (e && e.message ? e.message : "네트워크 오류"), 3200);';
  const mutated = projectHubSrc.replace(needle, "/* 알림 제거됨 */");
  if (mutated === projectHubSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mM = mutated.match(/async togglePublish\(p, btn\) \{[\s\S]*?\n    \},/);
    const bodyM = mM ? mM[0] : "";
    ok(!/catch \(e\) \{[\s\S]*?Prompt\.toast\([\s\S]*?배포 처리 실패/.test(bodyM), "뮤테이션 적용 시 실패 알림이 사라짐(⑤가 깨짐을 확인)");
  }
}
{
  const fn = projectHubSrc.match(/_deployUrl\(p\) \{[\s\S]*?\n    \},/);
  ok(!!fn, "사전조건 — _deployUrl() 함수를 찾았다");
  const body = fn ? fn[0] : "";
  ok(!/loc\.origin \? \(loc\.origin \+ "\/"\)/.test(body), "④ 사이트 루트(location.origin) 폴백 코드가 없다(제거됨)");
  ok(/\?d=/.test(body), "④ subdomain 없을 때 뷰어 딥링크(?d=)로 폴백한다");
  ok(/return "";\s*\n\s*\},?\s*$/.test(body.trim()), "④ 식별 가능한 주소가 전혀 없으면 빈 문자열(주소 미노출) — 거짓 링크 금지");

  console.log("\n[뮤테이션ⓓ] 루트 폴백을 되살리면 ④가 실패해야 함(빈 문자열이 사라짐)");
  const needle = '      return "";\n    },';
  const idx = projectHubSrc.indexOf("_deployUrl(p) {");
  const scoped = projectHubSrc.slice(idx);
  const relIdx = scoped.indexOf(needle);
  ok(relIdx !== -1, "사전조건 — _deployUrl() 안에서 최종 return \"\"; 을 찾았다");
  if (relIdx !== -1) {
    const mutatedScoped = scoped.slice(0, relIdx) + '      return loc.origin ? (loc.origin + "/") : "";\n    },' + scoped.slice(relIdx + needle.length);
    const mutatedFull = projectHubSrc.slice(0, idx) + mutatedScoped;
    const fnM = mutatedFull.match(/_deployUrl\(p\) \{[\s\S]*?\n    \},/);
    const bodyM = fnM ? fnM[0] : "";
    ok(/loc\.origin \? \(loc\.origin \+ "\/"\)/.test(bodyM), "뮤테이션 적용 시 루트 폴백이 되살아남(④가 깨짐을 확인 — 이제 빈 문자열이 아니게 된다)");
  }
}

/* ══════════════════════════════════════════════════════════════════
 * Part B/C 공통 — 실 DOM(puppeteer) 헬퍼: 11_UI + 30_Prompt + 12_ProjectHub 실제 소스를
 * 하나의 클로저로 묶어 로드한다(목 아님 — 브라우저 전역 몇 개만 스텁).
 * ══════════════════════════════════════════════════════════════════ */
function buildBundle(projectHubSource) {
  return "(function(){\n" + uiSrc + "\n" + promptSrc + "\n" + projectHubSource +
    "\nwindow.ProjectHub = ProjectHub; window.Prompt = Prompt; window.UI = UI;\n})();\n";
}

const HARNESS_HTML = (bundleFileName) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<div id="hub-grid"></div><div id="hub-empty" class="hidden"></div>
<script>
  window.__log = [];
  window.__fetchCalls = [];
  window.Auth = {
    isDesigner: true, idToken: "t1", role: "designer",
    headers() { return { "Content-Type": "application/json" }; },
    requireDesigner(cb) { window.__log.push("requireDesigner-called"); },
    signOut() {}
  };
  window.OfflineBundle = { verify() { return Promise.resolve({ ok: false }); } };
  window.Designers = {}; window.App = { openApp() {} };
  window.PinSeries = { preferredMode() { return "checkboard"; } };
</script>
<script src="./${bundleFileName}"></script>
</body></html>`;

async function withBrowser(fn) {
  const require = createRequire("file:///C:/Users/FREE/package.json");
  let puppeteer = null;
  try { puppeteer = require("puppeteer"); } catch (e) { puppeteer = null; }
  if (!puppeteer) { console.log("  FAIL puppeteer 를 로드할 수 없다 — 실 브라우저 검증 불가(증거 없는 PASS 금지)"); failed++; return; }
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try { await fn(browser, puppeteer); } finally { await browser.close(); }
}

/** api: { "METHOD /path": (body) => ({status, json}) } */
function makePage(browser, dir, api) {
  return (async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 375, height: 812 });
    page.on("dialog", async (d) => { page.__nativeDialogs = page.__nativeDialogs || []; page.__nativeDialogs.push(d.message()); await d.dismiss(); });
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
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/tables/")) {
        req.respond({ status: 200, contentType: "application/json", body: "{}" });
        return;
      }
      req.continue();
    });
    return page;
  })();
}

function tmpDirWithBundle(bundleSrc, bundleName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p59-"));
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
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return server;
}

/* ══════════════════════════════════════════════════════════════════
 * Part B — 실 DOM: ①②③④⑥⑦ + 뮤테이션 ⓐ(핸들러 연결 제거)
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[Part B · 실 DOM(puppeteer) — 신 코드]");
await withBrowser(async (browser) => {
  let publishCalls = 0;
  const api = {
    "POST /api/projects/proj1/publish": () => { publishCalls++; return { status: 200, json: { ok: true } }; },
    "GET /api/projects": () => ({ status: 200, json: { data: [{ id: "proj1", name: "테스트프로젝트", published: publishCalls > 0, created_at: Date.now() }] } }),
    "GET /api/projects/proj1/decks": () => ({ status: 200, json: { data: [{ id: "d1", deployment_id: "dep_abc123" }] } }),
  };
  const dir = tmpDirWithBundle(buildBundle(projectHubSrc), "bundle.js");
  const server = await serveDir(dir);
  const port = server.address().port;
  const page = await makePage(browser, dir, api);
  await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "load" });

  await page.evaluate(() => {
    window.ProjectHub.list = [{ id: "proj1", name: "테스트프로젝트", published: false, created_at: Date.now() }];
    window.ProjectHub.render();
  });

  const shotDir = process.env.SHOT_DIR || path.join(os.tmpdir(), "p59-shots");
  fs.mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: path.join(shotDir, "p59-before-click.png") });

  ok((await page.$('[data-act="pub"]')) !== null, "사전조건 — 배포 버튼이 렌더된다");
  await page.click('[data-act="pub"]');
  await page.waitForSelector("#wm-confirm-modal.on", { timeout: 2000 }).catch(() => {});
  const modalUp = await page.evaluate(() => { const m = document.getElementById("wm-confirm-modal"); return !!m && m.classList.contains("on"); });
  ok(modalUp, "클릭 시 커스텀 확인 모달이 뜬다(네이티브 confirm() 아님)");
  await page.click("#wm-confirm-ok");
  await page.waitForFunction(() => window.ProjectHub.list[0] && window.ProjectHub.list[0].published === true, { timeout: 3000 }).catch(() => {});

  ok(publishCalls > 0, "① 배포 클릭 → 실제 POST /api/projects/:id/publish 요청 발생");

  await page.waitForSelector(".hub-card-url", { timeout: 3000 }).catch(() => {});
  const after = await page.evaluate(() => ({
    published: window.ProjectHub.list[0] ? window.ProjectHub.list[0].published : null,
    urlText: (document.querySelector(".hub-card-url-text") || {}).textContent || null,
  }));
  ok(after.published === true, "② 성공 시 published 상태가 true 로 바뀐다(카드 재렌더 근거)");
  ok(!!after.urlText, "③ 성공 시 .hub-card-url 이 즉시 나타난다");
  ok(!!after.urlText && after.urlText.indexOf("?d=dep_abc123") !== -1, "④ 주소가 뷰어 딥링크(?d=)로 프로젝트를 식별한다(루트 주소 아님) → " + after.urlText);

  await page.screenshot({ path: path.join(shotDir, "p59-after-click-url-shown.png") });
  console.log("  [스크린샷] " + path.join(shotDir, "p59-before-click.png"));
  console.log("  [스크린샷] " + path.join(shotDir, "p59-after-click-url-shown.png"));

  // ⑥ 복사 버튼 — clipboard.writeText 스텁 + 토스트 확인
  await page.evaluate(() => {
    window.__copied = null;
    Object.defineProperty(navigator, "clipboard", { value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } }, configurable: true });
  });
  await page.click('[data-act="url-copy"]');
  await new Promise((r) => setTimeout(r, 200));
  const copied = await page.evaluate(() => window.__copied);
  ok(copied && copied.indexOf("?d=dep_abc123") !== -1, "⑥ 복사 버튼 클릭 시 실제 딥링크가 클립보드에 복사된다 → " + copied);
  const toastShown = await page.evaluate(() => { const h = document.getElementById("wm-toast-host"); return h ? h.textContent : ""; });
  ok(/복사했습니다/.test(toastShown), "⑥ 복사 후 알림 토스트가 뜬다(조용한 실패 0)");

  // ⑦ 회귀 — 미배포 카드엔 주소 없음
  await page.evaluate(() => {
    window.ProjectHub.list = [{ id: "proj2", name: "미배포프로젝트", published: false, created_at: Date.now() }];
    window.ProjectHub.render();
  });
  const noUrl = await page.evaluate(() => !document.querySelector(".hub-card-url"));
  ok(noUrl, "⑦ 미배포 카드에는 주소 영역이 없다(회귀 없음)");

  server.close();
});

/* 뮤테이션 ⓐ — 핸들러 연결(addEventListener) 제거 → ①이 깨져야 함 */
console.log("\n[뮤테이션ⓐ] 배포 버튼 핸들러 연결을 제거하면 ①이 실패해야 함(요청이 나가지 않음)");
await withBrowser(async (browser) => {
  const needle = 'if (pub) pub.addEventListener("click", (e) => { e.stopPropagation(); this.togglePublish(p, pub); });';
  const mutatedSrc = projectHubSrc.replace(needle, "/* 핸들러 연결 제거됨 */");
  if (mutatedSrc === projectHubSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; return; }
  let publishCalls = 0;
  const api = { "POST /api/projects/proj1/publish": () => { publishCalls++; return { status: 200, json: { ok: true } }; } };
  const dir = tmpDirWithBundle(buildBundle(mutatedSrc), "bundle.js");
  const server = await serveDir(dir);
  const port = server.address().port;
  const page = await makePage(browser, dir, api);
  await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "load" });
  await page.evaluate(() => {
    window.ProjectHub.list = [{ id: "proj1", name: "테스트프로젝트", published: false, created_at: Date.now() }];
    window.ProjectHub.render();
  });
  await page.click('[data-act="pub"]').catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  ok(publishCalls === 0, "뮤테이션 적용 시 핸들러가 없어 클릭해도 요청이 전혀 나가지 않는다(①이 깨짐을 확인)");
  server.close();
});

/* ══════════════════════════════════════════════════════════════════
 * Part C — 구 코드(HEAD) 대조 재현: PWA 독립실행모드(window.confirm 무음 false) 조건에서
 *   구 코드는 fetch 0건(프로덕션 증상 재현), 신 코드는 정상 동작(대조).
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[Part C · 구코드 vs 신코드 대조 — PWA confirm() 무음 실패 조건]");
await withBrowser(async (browser) => {
  let oldProjectHubSrc;
  try { oldProjectHubSrc = execSync('git show HEAD:public/js/modules/12_ProjectHub.js', { cwd: ROOT, encoding: "utf8" }); }
  catch (e) { console.log("  FAIL git show 실패 — 구코드를 가져올 수 없다: " + e.message); failed++; return; }

  async function runWithBrokenConfirm(src, label) {
    let publishCalls = 0;
    const api = { "POST /api/projects/proj1/publish": () => { publishCalls++; return { status: 200, json: { ok: true } }; } };
    const dir = tmpDirWithBundle(buildBundle(src), "bundle.js");
    // window.confirm 을 "무음 false" 로 오버라이드 — index.html 안에 인라인 삽입
    const html = HARNESS_HTML("bundle.js").replace(
      "window.Auth = {",
      'window.confirm = function() { window.__log.push("confirm-silently-false"); return false; };\n  window.Auth = {'
    );
    fs.writeFileSync(path.join(dir, "index.html"), html, "utf8");
    const server = await serveDir(dir);
    const port = server.address().port;
    const page = await makePage(browser, dir, api);
    const nativeDialogs = [];
    page.on("dialog", async (d) => { nativeDialogs.push(d.message()); await d.dismiss(); });
    await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "load" });
    await page.evaluate(() => {
      window.ProjectHub.list = [{ id: "proj1", name: "테스트프로젝트", published: false, created_at: Date.now() }];
      window.ProjectHub.render();
    });
    await page.click('[data-act="pub"]').catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    // 신코드는 네이티브 confirm() 대신 커스텀 DOM 모달을 띄운다 — 있으면 OK 를 눌러 진행한다.
    const hasCustomModal = await page.evaluate(() => { const m = document.getElementById("wm-confirm-modal"); return !!m && m.classList.contains("on"); });
    if (hasCustomModal) { await page.click("#wm-confirm-ok"); await new Promise((r) => setTimeout(r, 300)); }
    server.close();
    console.log("  [" + label + "] publishCalls=" + publishCalls + " nativeDialogsSeen=" + nativeDialogs.length);
    return publishCalls;
  }

  const oldCalls = await runWithBrokenConfirm(oldProjectHubSrc, "구코드(HEAD)");
  ok(oldCalls === 0, "구코드는 PWA confirm() 무음 조건에서 요청 0건 — 프로덕션 증상 재현 성공");

  const newCalls = await runWithBrokenConfirm(projectHubSrc, "신코드(수정본)");
  ok(newCalls > 0, "신코드는 동일 조건에서도 정상 요청 발생 — window.confirm() 의존을 제거했기 때문");
});

console.log(failed === 0 ? "\n[ALL PASS]" : "\n[" + failed + " FAILED]");
process.exit(failed === 0 ? 0 : 1);
