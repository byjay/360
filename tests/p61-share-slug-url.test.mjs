/**
 * p61 — 공유 주소 체계 `/srview/<프로젝트명>-<토큰>`
 * (프레임워크 0 · 실행: node tests/p61-share-slug-url.test.mjs)
 *
 * 마스터 원문:
 *   2026-09-18 "배포했을 시 주소 형태는 다른 프로젝트를 유추할 수 없도록 해줘"
 *              "보이는 건 seastar 과 srview 로 나오게 해줘"
 *              "프로젝트 이름은 그쪽 고객이 봐도 알 수 있게 할 거니까"
 *   2026-09-21 "scan.seastar.work/프로젝트이름 — 이런 식으로 배포해줘"
 *              "배포되면 주소를 보이게 하고 주소 링크도 바로 복사 가능하게 해"
 *
 * 🔴 두 요구는 충돌한다(이름은 보여야 하는데 남의 것은 유추 불가해야 한다).
 *    해법 = **이름은 노출하되 열쇠가 아니다.** 열쇠는 80비트 암호난수 토큰이다.
 *
 *  ① 배포 시 토큰 발급 + 주소에 프로젝트명이 보인다
 *  ② 🔴 토큰 없이 이름(slug)만으로는 404 — 비멤버 API 응답에도 토큰이 없다(열거 차단)
 *  ③ 토큰이 암호난수·80비트(≥64비트) — DB 평문 저장 여부와 그 판단 근거
 *  ④ 🔴 기존 `?d=` 링크 계속 동작(회귀)
 *  ⑤ 🔴 이름 변경 후에도 기존 토큰 링크가 열린다(토큰 재발급 없음)
 *  ⑥ 이름 중복("1"×2)·빈 이름에서 충돌 0
 *  ⑦ 한글 이름 처리(음절/자모/공백)
 *  ⑧ 🔴 새 경로에서도 쓰기 403(p48 보안 회귀 금지)
 *  ⑨ 정적 자원이 새 경로에서 깨지지 않는다(index.html 상대경로 0)
 *  ⑩ 카드 하단에 링크 + 복사·공유 노출
 *
 * 뮤테이션 5건: ⓐ토큰검사 제거→② ⓑ암호난수→비암호PRNG→③ ⓒ`?d=`분기 제거→④
 *               ⓓ이름변경 시 토큰 재발급→⑤ ⓔ새 경로 쓰기 허용(열람전용 강등 제거)→⑧
 *
 * 🔴 목 금지 — 실제 Hono 앱(src/index.tsx)을 esbuild 로 번들해 실제 Request 로 구동한다.
 *   가짜는 D1 저장소와 ASSETS 바인딩뿐이다(라우팅·인증체인·핸들러는 전부 실 소스).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

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

/* ══ 실제 워커 번들 — 뮤테이션은 src/ 를 임시폴더에 복사해 문자열 치환 후 번들 ══════ */
let buildSeq = 0;
async function buildWorker(patches = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p61-src-"));
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  // 🔴 src/lib/*.ts 를 손목록으로 적지 않는다 — 새 lib 파일이 추가되면 조용히 번들이 깨진다(P68 실사고).
  const files = { "index.tsx": rd("src/index.tsx") };
  for (const f of fs.readdirSync(path.join(ROOT, "src/lib"))) if (/\.tsx?$/.test(f)) files["lib/" + f] = rd("src/lib/" + f);
  for (const p of patches) {
    const cur = files[p.file];
    if (cur === undefined) throw new Error("unknown patch file " + p.file);
    const next = cur.replace(p.from, p.to);
    if (!mustPatch(cur, next, p.file + " :: " + String(p.from).slice(0, 60))) return null;
    files[p.file] = next;
  }
  for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), body, "utf8");
  const out = path.join(os.tmpdir(), `p61-worker-${process.pid}-${buildSeq++}.mjs`);
  await esbuild.build({
    entryPoints: [path.join(dir, "index.tsx")],
    bundle: true, format: "esm", platform: "node", outfile: out,
    jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
    absWorkingDir: ROOT, nodePaths: [path.join(ROOT, "node_modules")],
  });
  const mod = (await import("file://" + out.replace(/\\/g, "/"))).default;
  fs.unlinkSync(out); fs.rmSync(dir, { recursive: true, force: true });
  return mod;
}

/** src/lib/util.ts 의 순수 유틸을 실제로 import (토큰 생성기 통계 검증용) */
async function loadUtil(patches = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p61-util-"));
  let body = rd("src/lib/util.ts");
  for (const p of patches) {
    const next = body.replace(p.from, p.to);
    if (!mustPatch(body, next, "util :: " + String(p.from).slice(0, 60))) return null;
    body = next;
  }
  const src = path.join(dir, "util.ts");
  fs.writeFileSync(src, body, "utf8");
  const out = path.join(os.tmpdir(), `p61-util-${process.pid}-${buildSeq++}.mjs`);
  await esbuild.build({ entryPoints: [src], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  const mod = await import("file://" + out.replace(/\\/g, "/"));
  fs.unlinkSync(out); fs.rmSync(dir, { recursive: true, force: true });
  return mod;
}

/* ══ D1 저장소 가짜 — 핸들러가 아니라 "저장소"만 대체 ══════════════════════ */
const DEP_ID = "dep_p61_001";
function freshState() {
  return {
    settings: {},
    sessions: { "local-super-tok": { email: "designssir@gmail.com", expires_at: Date.now() + 8.64e7, revoked: 0 } },
    localUsers: { "designssir@gmail.com": { email: "designssir@gmail.com", name: "마스터", deleted: 0, must_change_password: 0 } },
    designers: new Set(),
    projects: {},          // id → row
    decks: [],             // { project_id, deployment_id, level_no, created_at, deleted }
    deployments: { [DEP_ID]: { id: DEP_ID, project_id: "prj_a", pins: "[]", zones: "[]", annotations: "[]", version: 3, deleted: 0, tenant_id: null, name: "T", created_at: 1, updated_at: 1 } },
    writes: [],
  };
}
function addProject(state, id, name, opts = {}) {
  state.projects[id] = { id, name, description: null, owner: "designssir@gmail.com", created_at: 1, updated_at: 1,
    published: opts.published ? 1 : 0, published_at: null, published_by: null, subdomain: null, share_token: opts.share_token ?? null, deleted: 0 };
  if (opts.deck !== false) state.decks.push({ project_id: id, deployment_id: opts.deployment_id || DEP_ID, level_no: 1, created_at: 1, deleted: 0 });
  return state.projects[id];
}
function makeDB(state) {
  const like = (q, s) => q.indexOf(s) >= 0;
  return {
    prepare(sql) {
      const q = sql.replace(/\s+/g, " ").trim();
      const exec = (a) => ({
        async first() {
          if (like(q, "FROM app_settings WHERE scope = '*' AND skey = ?")) return state.settings[a[0]] ? { value: state.settings[a[0]] } : null;
          if (like(q, "FROM local_sessions WHERE token = ?")) return state.sessions[a[0]] || null;
          if (like(q, "FROM local_users WHERE email = ?")) return state.localUsers[String(a[0]).toLowerCase()] || null;
          if (like(q, "FROM designers WHERE email = ?")) return state.designers.has(String(a[0]).toLowerCase()) ? { email: a[0], deleted: 0 } : null;
          if (like(q, "FROM tenant_members WHERE email = ?")) return null;
          if (like(q, "FROM deployments WHERE id = ?")) return state.deployments[a[0]] || null;
          // ── projects ──
          if (like(q, "SELECT share_token FROM projects WHERE id = ?")) {
            const p = state.projects[a[0]]; return p && !p.deleted ? { share_token: p.share_token } : null;
          }
          if (like(q, "FROM projects WHERE share_token = ? AND deleted = 0")) {
            const p = Object.values(state.projects).find((x) => !x.deleted && x.share_token && x.share_token === a[0]);
            return p ? { id: p.id, name: p.name, share_token: p.share_token, published: p.published } : null;
          }
          if (like(q, "FROM projects WHERE id = ?")) { const p = state.projects[a[0]]; return p || null; }
          // ── decks ──
          if (like(q, "SELECT COUNT(*) AS n FROM decks WHERE project_id = ?")) {
            return { n: state.decks.filter((d) => d.project_id === a[0] && !d.deleted && d.deployment_id).length };
          }
          if (like(q, "SELECT deployment_id FROM decks WHERE project_id = ?")) {
            const d = state.decks.filter((x) => x.project_id === a[0] && !x.deleted && x.deployment_id)
              .sort((x, y) => (x.level_no - y.level_no) || (x.created_at - y.created_at))[0];
            return d ? { deployment_id: d.deployment_id } : null;
          }
          return null;
        },
        async all() {
          if (like(q, "FROM projects WHERE deleted = 0")) return { results: Object.values(state.projects).filter((p) => !p.deleted) };
          // [WO 20261009-readacl] 읽기 SoT(depRefIndexOf) — 살아있는 구역의 배포본 참조
          if (like(q, "FROM decks WHERE deleted = 0 AND deployment_id IS NOT NULL")) return { results: state.decks.filter((d) => !d.deleted && d.deployment_id) };
          return { results: [] };
        },
        async run() {
          if (like(q, "INSERT INTO app_settings")) { if (!state.settings[a[0]]) state.settings[a[0]] = a[1]; return { success: true }; }
          if (like(q, "UPDATE projects SET share_token = ?")) {
            const onlyIfNull = like(q, "share_token IS NULL");
            const p = state.projects[a[2]];
            if (p && !p.deleted && (!onlyIfNull || p.share_token == null)) {
              // UNIQUE(share_token) 부분 인덱스 재현 — 중복이면 D1 처럼 throw
              if (Object.values(state.projects).some((x) => x.id !== p.id && x.share_token === a[0])) throw new Error("UNIQUE constraint failed: projects.share_token");
              p.share_token = a[0]; p.updated_at = a[1];
            }
            state.writes.push(q); return { success: true };
          }
          if (like(q, "UPDATE projects SET published = 1")) {
            // bind(now, email, now, pid) → pid 는 a[3]
            const p = state.projects[a[3]];
            if (p && !p.deleted) { p.published = 1; p.published_at = a[0]; p.published_by = a[1]; p.updated_at = a[2]; }
            state.writes.push(q); return { success: true };
          }
          if (/^(INSERT|UPDATE|DELETE)/i.test(q)) state.writes.push(q);
          return { success: true };
        },
      });
      return { bind: (...a) => exec(a), first: async () => exec([]).first(), all: async () => exec([]).all(), run: async () => exec([]).run() };
    },
    batch: async () => [],
  };
}

/* ── ASSETS 가짜: Cloudflare Pages 와 동일하게 "실제 파일만" 200 ──
 *   /index.html 만 존재. /srview/... 같은 가짜 경로는 404 → 워커가 셸로 폴백한다. */
const SHELL_HTML = '<!doctype html><html><head><link rel="stylesheet" href="/css/style.css"></head><body><script src="/js/main.js"></script></body></html>';
const ASSETS = {
  async fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/index.html") return new Response(SHELL_HTML, { status: 200, headers: { "Content-Type": "text/html" } });
    return new Response("not found", { status: 404 });
  },
};

function makeCaller(worker, state) {
  const ENV = { DB: null, ASSETS, DEMO_LOGIN: "0" };
  return async (method, p, { token, body, host = "scan.seastar.work" } = {}) => {
    ENV.DB = makeDB(state);
    const h = { "Content-Type": "application/json", Host: host, Origin: "https://" + host };
    if (token) h.Authorization = "Bearer " + token;
    const req = new Request("https://" + host + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    return await worker.fetch(req, ENV, { waitUntil() {}, passThroughOnException() {} });
  };
}

/* ══════════════════════════════════════════════════════════════════════ */
const worker = await buildWorker();
const util = await loadUtil();
if (!worker || !util) { console.log("\n[FATAL] 번들 실패"); process.exit(1); }

const SUP = "local-super-tok";
/** 배포 → 서버가 내려준 project 객체 */
async function publish(call, pid) {
  const r = await call("POST", "/api/projects/" + pid + "/publish", { token: SUP, body: {} });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, project: j.project || null, error: j.error };
}

console.log("\n[① 배포 시 토큰 발급 · 주소에 프로젝트명이 보인다]");
let STATE = freshState();
let call = makeCaller(worker, STATE);
{
  addProject(STATE, "prj_a", "선각 A동");
  const { status, project } = await publish(call, "prj_a");
  ok(status === 200, "① publish → 200 (실제 " + status + ")");
  ok(!!project && typeof project.share_token === "string" && project.share_token.length === 16,
    "① share_token 16자 발급 → " + (project && project.share_token));
  ok(!!project && typeof project.share_path === "string" && project.share_path.startsWith("/srview/"),
    "① 주소가 /srview/ 로 시작(마스터: '보이는 건 seastar 과 srview') → " + (project && project.share_path));
  const readable = decodeURIComponent(project.share_path);
  ok(readable.includes("선각"), "① 🔴 주소에 프로젝트 이름이 그대로 보인다(고객 인지) → " + readable);
  ok(readable.endsWith("-" + project.share_token), "① 이름 뒤에 토큰이 붙는다 → " + readable);
  // 실제 링크가 열리는지
  const open = await call("GET", "/srview/" + encodeURIComponent(readable.split("/srview/")[1]));
  ok(open.status === 200, "① 발급된 전체 주소로 앱 셸 200 (실제 " + open.status + ")");
  const html = await open.text();
  ok(html.includes("/js/main.js"), "① 반환된 셸이 index.html 이다");
  ok(open.headers.get("x-robots-tag") === "noindex, nofollow", "① 검색엔진 색인 차단 헤더(주소 유출 경로 차단) → " + open.headers.get("x-robots-tag"));
}

console.log("\n[② 🔴 토큰 없이 이름만으로는 404 — 열거 차단]");
const TOK_A = STATE.projects.prj_a.share_token;
{
  const slug = decodeURIComponent(STATE.projects.prj_a.share_token ? "선각-a동" : "");
  const bare = await call("GET", "/srview/" + encodeURIComponent("선각-a동"));
  ok(bare.status === 404, "② 이름(slug)만 → 404 (실제 " + bare.status + ")  path=/srview/" + slug);
  const wrong = await call("GET", "/srview/" + encodeURIComponent("선각-a동") + "-aaaaaaaaaaaaaaaa");
  ok(wrong.status === 404, "② 형식은 맞지만 존재하지 않는 토큰 → 404 (실제 " + wrong.status + ")");
  const short = await call("GET", "/srview/" + encodeURIComponent("선각-a동") + "-abc");
  ok(short.status === 404, "② 짧은 토큰 → 404 (실제 " + short.status + ")");
  const noSeg = await call("GET", "/srview");
  ok(noSeg.status === 404, "② /srview (목록 시도) → 404 (실제 " + noSeg.status + ")");
  const api = await call("GET", "/api/share/" + encodeURIComponent("선각-a동"));
  ok(api.status === 404, "② /api/share/<이름> → 404 (실제 " + api.status + ")");
  // 404 본문이 존재/미존재를 구분해 알려주지 않는다(동일 응답)
  const b1 = await (await call("GET", "/srview/" + encodeURIComponent("선각-a동"))).text();
  const b2 = await (await call("GET", "/srview/aaaaaaaaaaaaaaaa")).text();
  ok(b1 === b2, "② 존재/미존재 404 본문이 동일 — 어떤 힌트도 주지 않는다");
  // 🔴 비멤버(익명)에게는 API 응답에서 토큰 자체를 주지 않는다
  // [WO 20261009-readacl · 마스터 지시] 토큰 없는 /api/projects = 401(로그인 게이트 정책 — 종전 "익명도 이름을 본다"는 폐기).
  const anonR = await call("GET", "/api/projects");
  const anonT = await anonR.text();
  ok(anonR.status === 401 && !anonT.includes(TOK_A) && !anonT.includes("선각"), "② 토큰 없는 /api/projects → 401 · 이름·토큰 0 (실제 " + anonR.status + ")");
  // 비멤버 = 열람 링크(?d=) 세션: 자기 링크 프로젝트는 보되 공유 열쇠는 받지 못한다
  const vt = (await (await call("POST", "/api/auth/auto-entry", { body: { kind: "viewer", d: DEP_ID } })).json()).token;
  const anon = await (await call("GET", "/api/projects", { token: vt })).json();
  const row = (anon.data || []).find((p) => p.id === "prj_a");
  ok(!!row && row.published === true, "② 링크 열람 세션은 자기 링크의 배포 프로젝트를 본다");
  ok(!!row && row.share_token === null && row.share_path === null, "② 🔴 비멤버 응답에는 share_token/share_path 가 없다 → " + JSON.stringify([row && row.share_token, row && row.share_path]));
  const mine = await (await call("GET", "/api/projects", { token: SUP })).json();
  const row2 = (mine.data || []).find((p) => p.id === "prj_a");
  ok(!!row2 && row2.share_token === TOK_A, "② 멤버(슈퍼)에게는 정상 제공 → " + (row2 && row2.share_path));
  // 정상 토큰은 열린다(대조군)
  const good = await call("GET", "/srview/" + encodeURIComponent("아무이름") + "-" + TOK_A);
  ok(good.status === 200, "② 🔴 slug 가 틀려도 토큰만 맞으면 200 — 토큰이 유일한 열쇠 (실제 " + good.status + ")");
}

console.log("\n[뮤테이션ⓐ] /srview 토큰 검사를 제거하면 ②가 실패해야 함");
{
  const w = await buildWorker([{ file: "index.tsx", from: "  if (!row) return shareNotFound(c)\n  return await serveAppShell(c)", to: "  return await serveAppShell(c)" }]);
  if (w) {
    const c2 = makeCaller(w, STATE);
    const r = await c2("GET", "/srview/" + encodeURIComponent("선각-a동"));
    ok(r.status === 200, "뮤테이션 적용 시 이름만으로 열린다(②가 깨짐을 확인) → " + r.status);
  }
}

console.log("\n[③ 토큰 엔트로피 · 암호난수 · 저장 형태]");
{
  const src = rd("src/lib/util.ts");
  const fn = (src.match(/export function randShareToken\(\)[\s\S]*?\n}/) || [""])[0];
  ok(fn.includes("crypto.getRandomValues"), "③a 토큰 생성기가 crypto.getRandomValues 사용");
  ok(!/Math\s*\.\s*random/.test(fn), "③b 생성기 본문에 비암호 PRNG 호출 0건");
  ok(/new Uint8Array\(10\)/.test(fn), "③c 10바이트 = 80비트 — 요구 최소치 64비트 초과");

  const N = 5000, seen = new Set();
  let badShape = 0;
  for (let i = 0; i < N; i++) { const t = util.randShareToken(); if (!/^[a-z2-7]{16}$/.test(t)) badShape++; seen.add(t); }
  ok(badShape === 0, "③d " + N + "개 모두 base32 16자 형식");
  ok(seen.size === N, "③e " + N + "개 전부 유일(충돌 0) → " + seen.size);
  // 알파벳 소진(편향된 생성기라면 32자 중 일부가 안 나온다)
  const chars = new Set(Array.from(seen).join(""));
  ok(chars.size === 32, "③f base32 알파벳 32자 전부 출현(편향 없음) → " + chars.size);
  const bits = Math.log2(32) * 16;
  ok(bits >= 64, "③g 엔트로피 " + bits + "비트 ≥ 64비트");

  // 🔴 저장 형태 판단 근거 — 초대 토큰(sha256Hex 해시 저장)과 달리 **평문**으로 저장한다.
  //   [P63] 판정: 과거엔 소스 전체에서 /sha256Hex\([^)]*share/i 를 찾아 "없으면 평문"이라 판정했는데,
  //   뒤에 추가된 **초대코드** 해시 sha256Hex(normalizeShareCode(...)) 가 같은 패턴에 걸려 오탐이 났다.
  //   검사 대상은 "공유 **토큰**을 다루는 두 함수"뿐이므로 그 본문만 정확히 떼어내 본다.
  const idx = rd("src/index.tsx");
  const fnBody = (name) => {
    const i = idx.indexOf("function " + name + "(");
    if (i < 0) return null;
    const open = idx.indexOf("{", i);
    let d = 0;
    for (let k = open; k < idx.length; k++) {
      if (idx[k] === "{") d++;
      else if (idx[k] === "}") { d--; if (d === 0) return idx.slice(i, k + 1); }
    }
    return null;
  };
  const ensureFn = fnBody("ensureShareToken"), lookupFn = fnBody("projectByShareToken");
  ok(!!ensureFn && !!lookupFn, "③h-0 사전조건 — ensureShareToken/projectByShareToken 본문을 찾았다");
  ok(!!ensureFn && !/sha256Hex/.test(ensureFn), "③h-1 저장 경로(ensureShareToken)가 토큰을 해싱하지 않는다(평문 저장)");
  ok(!!lookupFn && !/sha256Hex/.test(lookupFn), "③h-2 조회 경로(projectByShareToken)가 URL 토큰을 그대로 대조한다(해시 경유 아님)");
  ok(/UPDATE projects SET share_token = \?/.test(idx) && /WHERE share_token = \? AND deleted = 0/.test(idx),
    "③h DB 에는 토큰 **평문** 저장 — 근거: 이 링크는 허브 카드에서 **반복 재표시·복사**되어야 한다" +
    "(초대 토큰처럼 1회 발급 후 버리는 값이 아니다). 해시 저장이면 다시 보여줄 수 없다." +
    " 잔여위험: DB 읽기 권한자는 전 프로젝트 링크를 얻는다 — 단 그 권한자는 이미 프로젝트 데이터 전체를 읽을 수 있으므로 추가 노출 0.");
}

{
  const idx0 = rd("src/index.tsx");
  const mutated = idx0.replace(
    "  if (!isShareToken(token)) return null",
    "  if (!isShareToken(token)) return null" + String.fromCharCode(10) + "  token = await sha256Hex(token)");
  if (mutated === idx0) { console.log("  FAIL mutation target not found (projectByShareToken)"); failed++; }
  else {
    const i = mutated.indexOf("function projectByShareToken(");
    const open = mutated.indexOf("{", i);
    let d = 0, body = "";
    for (let k = open; k < mutated.length; k++) { if (mutated[k] === "{") d++; else if (mutated[k] === "}") { d--; if (d === 0) { body = mutated.slice(i, k + 1); break; } } }
    ok(/sha256Hex/.test(body), "뮤테이션ⓑ-2 적용 시 조회 경로가 해싱을 타게 되어 ③h-2 가 깨진다");
  }
}

console.log("\n[뮤테이션ⓑ] 토큰 생성기를 비암호 PRNG 로 바꾸면 ③이 실패해야 함");
{
  const u = await loadUtil([{ file: "util", from: "  crypto.getRandomValues(a)", to: "  for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256)" }]);
  // loadUtil 은 patch.file 을 보지 않으므로 그대로 적용된다(단일 파일)
  if (u) {
    const dirSrc = rd("src/lib/util.ts").replace("  crypto.getRandomValues(a)", "  for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256)");
    const fnM = (dirSrc.match(/export function randShareToken\(\)[\s\S]*?\n}/) || [""])[0];
    ok(!fnM.includes("crypto.getRandomValues") && /Math\s*\.\s*random/.test(fnM),
      "뮤테이션 적용 시 ③a/③b 검사가 깨진다(암호난수 아님을 탐지) → " + fnM.split("\n")[2].trim());
  }
}

console.log("\n[④ 🔴 기존 `?d=` 링크 계속 동작 — 이미 공유된 링크가 죽으면 안 된다]");
{
  const r = await call("GET", "/?d=" + DEP_ID);
  ok(r.status === 200, "④a 루트 + ?d= → 앱 셸 200 (실제 " + r.status + ")");
  // [WO 20261009-readacl] 클라이언트는 열람 링크 식별자(?d=)를 함께 보낸다 — 서버가 그 링크로 범위를 서명
  const mint = await (await call("POST", "/api/auth/auto-entry", { body: { kind: "viewer", d: DEP_ID } })).json();
  const dep = await call("GET", "/tables/deployments/" + DEP_ID, { token: mint.token });
  ok(dep.status === 200, "④b 열람전용 세션이 배포본을 계속 읽는다 → " + dep.status);
  const footer = rd("public/js/modules/99_footer.js");
  ok(/const depId\s*=\s*params\.get\("d"\);/.test(footer), "④c 클라이언트에 `?d=` 파싱이 남아 있다");
  ok(/}\s*else if \(depId\) \{/.test(footer), "④d `?d=` 진입 분기가 살아 있다(공유 링크 분기 뒤)");
  const app = rd("public/js/modules/20_App.js");
  ok(/let wantId = params\.get\("d"\)/.test(app), "④e 배포본 선택도 여전히 `?d=` 를 1순위로 읽는다");
  const hub = rd("public/js/modules/12_ProjectHub.js");
  ok(hub.includes('return origin + "/?d=" + encodeURIComponent(depId);'), "④f 허브의 `?d=` 폴백 주소 생성이 남아 있다");
}

console.log("\n[뮤테이션ⓒ] `?d=` 진입 분기를 제거하면 ④가 실패해야 함");
{
  const before = rd("public/js/modules/99_footer.js");
  const after = before.replace("} else if (depId) {", "} else if (false) {");
  if (mustPatch(before, after, "99_footer `?d=` 분기")) {
    ok(!/}\s*else if \(depId\) \{/.test(after), "뮤테이션 적용 시 ④d 가 깨진다(하위호환 소실 탐지)");
  }
}

console.log("\n[⑤ 🔴 이름 변경 후에도 기존 토큰 링크가 열린다]");
{
  const oldPath = "/srview/" + encodeURIComponent("선각-a동") + "-" + TOK_A;
  STATE.projects.prj_a.name = "선각 B동 리네임";               // 고객이 이름을 바꿨다
  const again = await publish(call, "prj_a");                   // 재배포까지 해도
  ok(again.project.share_token === TOK_A, "⑤a 재배포·이름변경에도 토큰 불변 → " + again.project.share_token);
  const r1 = await call("GET", oldPath);
  ok(r1.status === 200, "⑤b 🔴 **옛 이름**이 박힌 옛 링크가 그대로 열린다 (실제 " + r1.status + ")");
  const newPath = again.project.share_path;
  ok(decodeURIComponent(newPath).includes("선각"), "⑤c 새 주소에는 바뀐 이름이 반영된다 → " + decodeURIComponent(newPath));
  const r2 = await call("GET", newPath);
  ok(r2.status === 200, "⑤d 새 주소도 열린다(둘 다 유효) (실제 " + r2.status + ")");
  const j = await (await call("GET", "/api/share/" + TOK_A)).json();
  ok(j.matched && j.project.id === "prj_a" && j.deployment_id === DEP_ID,
    "⑤e 토큰 해석이 같은 프로젝트/배포본을 가리킨다 → " + JSON.stringify([j.project && j.project.id, j.deployment_id]));
}

console.log("\n[뮤테이션ⓓ] 배포마다 토큰을 재발급하면 ⑤가 실패해야 함");
{
  const w = await buildWorker([
    { file: "index.tsx", from: "  if (cur && cur.share_token) return String(cur.share_token)", to: "  if (false) return String(cur.share_token)" },
    { file: "index.tsx", from: "WHERE id = ? AND deleted = 0 AND share_token IS NULL", to: "WHERE id = ? AND deleted = 0" },
  ]);
  if (w) {
    const S2 = freshState(); addProject(S2, "prj_a", "선각 A동");
    const c2 = makeCaller(w, S2);
    const p1 = await publish(c2, "prj_a");
    S2.projects.prj_a.name = "선각 B동 리네임";
    const p2 = await publish(c2, "prj_a");
    ok(p1.project.share_token !== p2.project.share_token, "뮤테이션 적용 시 토큰이 바뀐다 → " + p1.project.share_token + " → " + p2.project.share_token);
    const dead = await c2("GET", p1.project.share_path);
    ok(dead.status === 404, "뮤테이션 적용 시 옛 링크가 죽는다(⑤b 가 깨짐을 확인) → " + dead.status);
  }
}

console.log("\n[⑥ 이름 중복·빈 이름에서 충돌 0]");
{
  const S = freshState(); const c3 = makeCaller(worker, S);
  addProject(S, "prj_1", "1"); addProject(S, "prj_2", "1");      // 실데이터에 존재하는 중복 초단문 이름
  addProject(S, "prj_e", "   "); addProject(S, "prj_s", "###");
  const a = await publish(c3, "prj_1"), b = await publish(c3, "prj_2");
  ok(a.project.share_path !== b.project.share_path, "⑥a 같은 이름 '1' 두 개 → 서로 다른 주소\n      " + a.project.share_path + "\n      " + b.project.share_path);
  ok(a.project.share_token !== b.project.share_token, "⑥b 토큰이 다르다");
  const ra = await c3("GET", a.project.share_path), rb = await c3("GET", b.project.share_path);
  ok(ra.status === 200 && rb.status === 200, "⑥c 둘 다 열린다 (" + ra.status + "/" + rb.status + ")");
  const ja = await (await c3("GET", "/api/share/" + a.project.share_token)).json();
  const jb = await (await c3("GET", "/api/share/" + b.project.share_token)).json();
  ok(ja.project.id === "prj_1" && jb.project.id === "prj_2", "⑥d 각자 자기 프로젝트로 해석된다 → " + ja.project.id + " / " + jb.project.id);
  const e = await publish(c3, "prj_e"), s = await publish(c3, "prj_s");
  ok(e.project.share_path.startsWith("/srview/project-"), "⑥e 빈 이름 → 기본 slug 'project' → " + e.project.share_path);
  ok(s.project.share_path.startsWith("/srview/project-"), "⑥f 기호뿐인 이름 → 기본 slug 'project' → " + s.project.share_path);
  const re = await c3("GET", e.project.share_path);
  ok(re.status === 200, "⑥g 빈 이름 프로젝트 링크도 정상 200 (실제 " + re.status + ")");
}

console.log("\n[⑦ 한글 이름 처리]");
{
  ok(util.slugifyProjectName("선각 A동") === "선각-a동", "⑦a '선각 A동' → " + util.slugifyProjectName("선각 A동"));
  ok(util.slugifyProjectName("ㅅㄷㄴㅅ1") === "ㅅㄷㄴㅅ1", "⑦b 자모 이름 보존(실데이터) → " + util.slugifyProjectName("ㅅㄷㄴㅅ1"));
  ok(util.slugifyProjectName("tes") === "tes" && util.slugifyProjectName("test1") === "test1", "⑦c 기존 실데이터 영문 이름 그대로");
  ok(util.slugifyProjectName("A/B?C#D") === "a-b-c-d", "⑦d URL 구분자는 '-' 로 접힌다 → " + util.slugifyProjectName("A/B?C#D"));
  ok(!util.slugifyProjectName("배 ---").endsWith("-"), "⑦e 슬러그는 '-' 로 끝나지 않는다(토큰 분리 유일성) → " + JSON.stringify(util.slugifyProjectName("배 ---")));
  ok(Array.from(util.slugifyProjectName("한".repeat(80))).length === 40, "⑦f 길이 상한 40 코드포인트");
  ok(util.slugifyProjectName("🚢🚢") === "project", "⑦g 이모지뿐인 이름 → 'project' (깨진 문자 생성 0)");
  // 한글 slug 가 붙은 실제 경로가 왕복한다
  const S = freshState(); const c4 = makeCaller(worker, S);
  addProject(S, "prj_k", "ㅅㄷㄴㅅ1");
  const p = await publish(c4, "prj_k");
  ok(decodeURIComponent(p.project.share_path).startsWith("/srview/ㅅㄷㄴㅅ1-"), "⑦h 자모 이름 주소 → " + decodeURIComponent(p.project.share_path));
  const enc = await c4("GET", p.project.share_path);                       // 퍼센트인코딩 형태
  const dec = await c4("GET", decodeURIComponent(p.project.share_path));   // 사람이 읽는 형태(브라우저 붙여넣기)
  ok(enc.status === 200 && dec.status === 200, "⑦i 인코딩/디코딩 두 형태 모두 200 (" + enc.status + "/" + dec.status + ")");
}

console.log("\n[⑧ 🔴 새 경로에서도 쓰기 403 — p48 보안 회귀 금지]");
{
  const auth = rd("public/js/modules/22_Auth.js");
  ok(/get\("d"\)\s*\?\s*"viewer"\s*:\s*"designer"/.test(auth), "⑧a p48 계약 유지 — `?d=` 는 여전히 viewer");
  ok(/if \(typeof ShareLink !== "undefined" && ShareLink\.token\(\)\) kind = "viewer";/.test(auth),
    "⑧b 🔴 공유 링크(/srview/)도 열람전용 토큰만 요청한다");
  const main = rd("public/js/main.js");
  ok(main.includes('ShareLink.token()) kind = "viewer"'), "⑧c 번들(main.js)에 반영됨(assemble 미러 확인)");
  // 서버 강제 — 열람전용 토큰으로는 어떤 경로에서 들어왔든 쓰기가 막힌다
  const S = freshState(); const c5 = makeCaller(worker, S);
  addProject(S, "prj_a", "선각 A동");
  const p = await publish(c5, "prj_a");
  // [WO 20261009-readacl] 공유 주소(/srview) 세션 = 공유 토큰(t)으로 발급
  const mint = await (await c5("POST", "/api/auth/auto-entry", { body: { kind: "viewer", t: p.project.share_token } })).json();
  const before = S.writes.length;
  const w1 = await c5("PATCH", "/tables/deployments/" + DEP_ID, { token: mint.token, body: { pins: [{ id: "hack" }] } });
  ok(w1.status === 403, "⑧d 공유 링크 세션 PATCH /tables/deployments → 403 (실제 " + w1.status + ")");
  const w2 = await c5("POST", "/api/projects/prj_a/unpublish", { token: mint.token, body: {} });
  ok(w2.status === 403, "⑧e 공유 링크 세션 POST unpublish → 403 (실제 " + w2.status + ")");
  ok(S.writes.length === before, "⑧f DB 쓰기 0건 (실제 " + (S.writes.length - before) + "건)");
  const r = await c5("GET", "/tables/deployments/" + DEP_ID, { token: mint.token });
  ok(r.status === 200, "⑧g 열람은 정상 200 (실제 " + r.status + ")");
  // 공유 해석 API 는 인증 없이 읽기만 — 쓰기 메서드는 라우트 자체가 없다
  const wBefore = S.writes.length;
  const pw = await c5("POST", "/api/share/" + p.project.share_token, { body: {} });
  // 🔴 정직 보고: 앱의 기존 catch-all(app.all('*'))이 미정의 경로를 SPA 셸로 폴백하므로 상태코드는 200 이다.
  //   중요한 것은 "쓰기 라우트가 존재하지 않는다" = DB 변경 0건이라는 사실이다.
  ok(S.writes.length === wBefore, "⑧h /api/share 에 쓰기 라우트 없음 — POST 는 SPA 폴백(" + pw.status + "), DB 쓰기 " + (S.writes.length - wBefore) + "건");
}

console.log("\n[뮤테이션ⓔ] 공유 링크의 열람전용 강등을 제거하면 ⑧이 실패해야 함");
{
  const before = rd("public/js/modules/22_Auth.js");
  const after = before.replace('      if (typeof ShareLink !== "undefined" && ShareLink.token()) kind = "viewer";\n', "");
  if (mustPatch(before, after, "22_Auth 공유링크 열람전용 강등")) {
    ok(!/ShareLink\.token\(\)\) kind = "viewer";/.test(after),
      "뮤테이션 적용 시 ⑧b 가 깨진다 — /srview/ 진입이 designer(쓰기) 토큰을 요청하게 된다");
  }
}

console.log("\n[⑨ 정적 자원이 새 경로에서 깨지지 않는다]");
{
  const html = rd("public/index.html");
  // 🔴 `/srview/<x>` 는 디렉터리가 /srview/ 라서, 상대경로 src/href 는 /srview/js/main.js 로 요청된다.
  const rel = [];
  const re = /(?:src|href)="([^"]+)"/g; let m;
  while ((m = re.exec(html))) {
    const u = m[1];
    if (/^(https?:)?\/\//.test(u) || u.startsWith("/") || u.startsWith("#") || u.startsWith("data:") || u.startsWith("mailto:")) continue;
    rel.push(u);
  }
  ok(rel.length === 0, "⑨a index.html 의 상대경로 src/href 0건 (실제 " + rel.length + "건" + (rel.length ? ": " + rel.join(", ") : "") + ")");
  // [P89] 빌드 stamp 단계가 캐시버스팅 쿼리(?v=<해시>)를 붙인다 — 절대경로 자체는 그대로, 쿼리만 허용.
  ok(/href="\/css\/style\.css(\?v=[a-f0-9]+)?"/.test(html) && /src="\/js\/main\.js(\?v=[a-f0-9]+)?"/.test(html),
    "⑨b 핵심 자산이 절대경로(캐시버스팅 쿼리 허용)");
  ok(/navigator\.serviceWorker\.register\('\/sw\.js'\)/.test(html), "⑨c SW 등록도 절대경로(스코프가 /srview/ 로 좁아지지 않는다)");
  ok(rd("index.html") === html, "⑨d 루트 미러(index.html) 동기화됨");
  // /srview/ 아래로 새는 요청이 발생하면 워커가 HTML 을 JS 자리에 돌려준다(치명) — 그 경로를 실제로 확인
  const leak = await call("GET", "/srview/js/main.js");
  const leakBody = await leak.text();
  const wouldBreak = leak.status === 200 && leakBody.includes("<!doctype html");
  console.log("  INFO /srview/js/main.js → " + leak.status + (wouldBreak ? " + HTML 본문(=JS 자리에 HTML → MIME 오류)" : ""));
  ok(wouldBreak, "⑨e 🔴 위험 실재 확인 — 상대경로였다면 이 요청이 발생해 앱이 깨진다. ⑨a(상대경로 0)가 그 유일한 방어선이다");
  ok(rd("public/js/main.js") === rd("js/main.js"), "⑨f 번들 미러(js/main.js) 동기화됨");
}

console.log("\n[⑩ 카드 하단에 링크 + 복사·공유 노출]");
{
  const hub = rd("public/js/modules/12_ProjectHub.js");
  ok(/const deployUrl = p\.published \? this\._deployUrl\(p\) : "";/.test(hub), "⑩a 주소 게이트 = p.published (배지와 동일 SoT)");
  ok(hub.includes('class="hub-card-url"') && hub.includes('data-act="url-copy"') && hub.includes('data-act="url-share"'),
    "⑩b 주소 텍스트 + 복사 + 공유 버튼이 카드에 있다");
  // 카드 하단 = hub-card-body 안, 이름/메타 **뒤**
  const body = hub.slice(hub.indexOf("'<div class=\"hub-card-body\">'"), hub.indexOf("'<div class=\"hub-card-actions\">'"));
  ok(body.indexOf("hub-card-name") < body.indexOf("hub-card-meta") && body.indexOf("hub-card-meta") < body.indexOf("hub-card-url"),
    "⑩c 순서: 이름 → 메타 → **주소(하단)**");
  // _deployUrl 이 새 주소를 1순위로 반환하는지(실제 실행)
  const vm = await import("node:vm");
  const sandbox = {
    console, Promise, Date, decodeURIComponent, encodeURIComponent,
    document: { getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {}, focus() {}, select() {} }), body: { appendChild() {}, removeChild() {} } },
    location: { hostname: "scan.seastar.work", protocol: "https:", origin: "https://scan.seastar.work" },
    navigator: {}, Prompt: { toast() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(hub + "\n;globalThis.__PH = ProjectHub;", sandbox);
  const PH = sandbox.__PH;
  const u = PH._deployUrl({ id: "p", name: "선각 A동", published: true, share_path: "/srview/%EC%84%A0%EA%B0%81-a%EB%8F%99-abcdefghijklmnop", subdomain: "hulla" });
  ok(u === "https://scan.seastar.work/srview/선각-a동-abcdefghijklmnop", "⑩d 🔴 공유 주소가 1순위 + 한글 디코딩 노출 → " + u);
  const u2 = PH._deployUrl({ id: "p", name: "x", published: true, subdomain: "hulla" });
  ok(u2 === "https://hulla.seastar.work", "⑩e share_path 없으면 기존 subdomain 주소로 폴백(회귀 0) → " + u2);
  PH._deployLinkCache = { p3: DEP_ID };
  const u3 = PH._deployUrl({ id: "p3", name: "x", published: true });
  ok(u3 === "https://scan.seastar.work/?d=" + DEP_ID, "⑩f 둘 다 없으면 기존 `?d=` 로 폴백(회귀 0) → " + u3);
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
