/**
 * p89 — 정적 자산 캐시버스팅(?v=<해시>) + 오프라인 폴백 쿼리 무시
 * (프레임워크 0 · 실행: node tests/p89-cache-bust.test.mjs)
 *
 * 배경(2026-09-29 지휘자 재현): dist/_headers 로 Cache-Control: no-cache 를 내려도
 * Cloudflare 존(seastar.work)의 Browser Cache TTL(4h, max-age=14400)이 원 헤더를
 * 덮어써 배포 후에도 최대 4시간 구버전 js/css 가 보인다. 존 설정은 다른 사이트에
 * 영향을 주므로 건드리지 않고, 파일명 자체(쿼리스트링)를 바꿔 캐시를 무력화한다.
 *
 * 구현:
 *  · build-tools/stamp-version.mjs — public/js/main.js·css 3종의 sha256(앞10자)를
 *    계산해 public/index.html(+루트 미러) 의 href/src 쿼리를 ?v=<해시> 로 교체(멱등).
 *  · package.json build/build:check — assemble → stamp → vite build 순서로 통합.
 *  · public/sw.js — 셸 코드(html/css/js) 오프라인 폴백 매칭에 ignoreSearch:true 적용
 *    (쿼리가 매 배포마다 바뀌므로 정확매칭이면 오프라인에서 "방금 버전"만 찾다 실패한다).
 *    CACHE 버전 v17→v18(구 무쿼리 캐시 정리), SHELL 프리캐시에 누락됐던 패밀리룩/3D
 *    스킨 CSS 2종 추가.
 *
 * 검사:
 *  ① 스탬프 후 main.js/css 참조에 ?v=<10자 hex> 쿼리 존재
 *  ② 해시가 실제 파일 내용(sha256 앞10자)과 일치
 *  ③ 기존 ?v=... 쿼리가 있어도 새 해시로 교체(누적 없음)
 *  ④ 멱등 — 두 번 돌려도 결과 동일
 *  ⑤ 외부 CDN 링크(fontawesome 등)는 불변
 *  ⑥ sw.js 오프라인 폴백 — 쿼리가 바뀐 요청도 캐시된 자산을 찾아 반환(ignoreSearch)
 *
 * 뮤테이션 2건, 각 EXIT=1 확인 후 원복:
 *  ⓐ stampHtml 의 쿼리 치환 로직 무력화 → ①이 실패해야 함
 *  ⓑ sw.js 의 `{ ignoreSearch: true }` 제거 → ⑥이 실패해야 함
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};
const mustPatch = (before, after, what) => {
  if (before === after) { console.log("  FAIL 뮤테이션 패치 대상을 찾지 못함: " + what); failed++; return false; }
  return true;
};

/* ══ 격리 픽스처 — 실제 public/index.html 을 건드리지 않고 자체 폴더에서 검증 ══ */
const FIXTURE = path.join(ROOT, ".tmp", "p89-fixture-" + process.pid);
function makeFixture() {
  fs.rmSync(FIXTURE, { recursive: true, force: true });
  fs.mkdirSync(path.join(FIXTURE, "public/js"), { recursive: true });
  fs.mkdirSync(path.join(FIXTURE, "public/css"), { recursive: true });
  fs.writeFileSync(path.join(FIXTURE, "public/js/main.js"), "console.log('v1');", "utf8");
  fs.writeFileSync(path.join(FIXTURE, "public/css/style.css"), "body{color:red}", "utf8");
  fs.writeFileSync(path.join(FIXTURE, "public/css/seastar-family-tokens.css"), ".fl{color:blue}", "utf8");
  fs.writeFileSync(path.join(FIXTURE, "public/css/seastar-3d-skin.css"), ".skin{color:green}", "utf8");
  const html = `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" crossorigin="anonymous" />
<link rel="stylesheet" href="/css/style.css?v=aabbccdd00" />
<link rel="stylesheet" href="/css/seastar-family-tokens.css" />
<link rel="stylesheet" href="/css/seastar-3d-skin.css" />
</head><body>
<script src="/js/main.js"></script>
</body></html>`;
  fs.writeFileSync(path.join(FIXTURE, "public/index.html"), html, "utf8");
  return html;
}
function sha10(buf) { return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 10); }

/* ══ ①~⑤ — 정상 스탬핑(실제 stamp-version.mjs 를 픽스처에 적용) ══════════════ */
{
  makeFixture();
  const mod = await import(pathToFileURL(path.join(ROOT, "build-tools/stamp-version.mjs")).href + "?t=" + Date.now());
  const before = fs.readFileSync(path.join(FIXTURE, "public/index.html"), "utf8");
  const stamped = mod.stampHtml(FIXTURE, before);

  const hashJs = sha10(fs.readFileSync(path.join(FIXTURE, "public/js/main.js")));
  const hashCss = sha10(fs.readFileSync(path.join(FIXTURE, "public/css/style.css")));
  const hashTokens = sha10(fs.readFileSync(path.join(FIXTURE, "public/css/seastar-family-tokens.css")));
  const hashSkin = sha10(fs.readFileSync(path.join(FIXTURE, "public/css/seastar-3d-skin.css")));

  ok(stamped.includes(`src="/js/main.js?v=${hashJs}"`), "① main.js 참조에 ?v=<해시> 부여 → " + hashJs);
  ok(mod.hashOf(FIXTURE, "js/main.js") === hashJs, "② hashOf() 가 실제 sha256(앞10자)와 일치");
  ok(stamped.includes(`href="/css/style.css?v=${hashCss}"`) && !stamped.includes("aabbccdd00"),
    "③ 기존 ?v=aabbccdd00 → 새 해시로 교체(누적 없음)");
  ok(stamped.includes(`href="/css/seastar-family-tokens.css?v=${hashTokens}"`), "①b family-tokens.css 스탬프");
  ok(stamped.includes(`href="/css/seastar-3d-skin.css?v=${hashSkin}"`), "①c 3d-skin.css 스탬프");
  ok(stamped.includes('href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css"'),
    "⑤ 외부 CDN 링크는 쿼리 추가 없이 불변");

  const stampedTwice = mod.stampHtml(FIXTURE, stamped);
  ok(stampedTwice === stamped, "④ 멱등 — 두 번째 스탬프 결과가 첫 번째와 동일(diff 0)");
}

/* ══ ⓐ 뮤테이션 — stampHtml 치환 로직 무력화 → ①이 실패해야 함 ══════════════ */
{
  makeFixture();
  const src = rd("build-tools/stamp-version.mjs");
  const before = "out = out.replace(re, (_m, p1, p2, p3) => `${p1}${p2}?v=${hash}${p3}`);";
  const after = "/* mutated: no-op */";
  if (mustPatch(before, after, "ⓐ stampHtml 쿼리 치환 무력화")) {
    const patched = src.replace(before, after);
    const tmpFile = path.join(FIXTURE, "stamp-mutated.mjs");
    fs.writeFileSync(tmpFile, patched, "utf8");
    const mutMod = await import(pathToFileURL(tmpFile).href);
    const before2 = fs.readFileSync(path.join(FIXTURE, "public/index.html"), "utf8");
    const result = mutMod.stampHtml(FIXTURE, before2);
    const stillHasHash = /\/js\/main\.js\?v=[a-f0-9]{10}"/.test(result);
    ok(!stillHasHash, "ⓐ 뮤테이션 후 ①(해시 부여)이 실패해야 함(EXIT=1 기대) → hasHash=" + stillHasHash);
  }
}

/* ══ ⑥ sw.js 오프라인 폴백 — ignoreSearch 로 쿼리 달라도 캐시 히트 ═══════════ */
async function runSwOfflineFallback(swSource) {
  const handlers = {};
  class FakeRequest {
    constructor(input, init) {
      if (typeof input === "string") { this.url = input; this.method = "GET"; }
      else { this.url = input.url; this.method = input.method || "GET"; this.mode = input.mode; }
      if (init) Object.assign(this, init);
    }
  }
  class FakeResponse {
    constructor(body, init) { this.body = body; this.status = (init && init.status) ?? 200; this.type = "basic"; this._tag = init && init.tag; }
    clone() { return this; }
  }
  const store = new Map(); // url string -> FakeResponse
  const cacheObj = {
    async match(reqOrKey, opts) {
      const key = typeof reqOrKey === "string" ? reqOrKey : reqOrKey.url;
      if (opts && opts.ignoreSearch) {
        const base = key.split("?")[0];
        for (const [k, v] of store) if (k.split("?")[0] === base) return v;
        return undefined;
      }
      return store.get(key);
    },
    async put(reqOrKey, res) { store.set(typeof reqOrKey === "string" ? reqOrKey : reqOrKey.url, res); },
  };
  const cachesObj = { open: async () => cacheObj, match: async (k) => cacheObj.match(k) };
  const precached = new FakeResponse("cached-shell-js", { tag: "PRECACHED_NOQUERY" });
  store.set("https://x.example/js/main.js", precached); // 프리캐시 = 쿼리 없는 키(install 시점)

  const sandbox = {
    self: {
      addEventListener(type, fn) { handlers[type] = fn; },
      navigator: {},
      clients: { claim() {} },
      skipWaiting() {},
      location: { origin: "https://x.example" },
    },
    caches: cachesObj,
    URL,
    Request: FakeRequest,
    Response: FakeResponse,
    fetch: async () => { throw new Error("offline"); }, // 오프라인 시뮬레이션
    console,
    Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(swSource, sandbox);

  const event = {
    request: new FakeRequest({ url: "https://x.example/js/main.js?v=deadbeef12", method: "GET", mode: "same-origin" }),
    respondWith(p) { event._p = p; },
    waitUntil() {},
  };
  handlers.fetch(event);
  return event._p ? await event._p : undefined;
}

{
  const src = rd("public/sw.js");
  const res = await runSwOfflineFallback(src);
  ok(!!res && res._tag === "PRECACHED_NOQUERY",
    "⑥ 오프라인 + 쿼리 달라진 요청 → ignoreSearch 로 프리캐시된 셸 자산을 찾아 반환");
}

/* ══ ⓑ 뮤테이션 — ignoreSearch 제거 → ⑥이 실패해야 함 ═══════════════════════ */
{
  const src = rd("public/sw.js");
  const before = "c.match(req, { ignoreSearch: true })";
  const after = "c.match(req)";
  if (mustPatch(before, after, "ⓑ ignoreSearch 제거")) {
    const patched = src.replace(before, after);
    const res = await runSwOfflineFallback(patched);
    const hit = !!res && res._tag === "PRECACHED_NOQUERY";
    ok(!hit, "ⓑ 뮤테이션 후 ⑥(쿼리 무시 매칭)이 실패해야 함(EXIT=1 기대) → hit=" + hit);
  }
}

fs.rmSync(FIXTURE, { recursive: true, force: true });

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
