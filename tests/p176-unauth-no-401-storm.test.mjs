/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p176-unauth-no-401-storm.test.mjs)
 *
 * 대상: 발주서 WO unauth401 — [재현] 비로그인 상태에서 GET /api/projects 401 반복(실측 4회)
 *   + 401 응답을 "프로젝트 0개"로 조용히 오인(12_ProjectHub.js _loadImpl, 구 load()).
 *
 * 검증 항목(12_ProjectHub.js 를 실제 소스 그대로 vm 로 로드해 테스트 — 추출/복붙 아님):
 *  ① Auth.idToken 없음(비로그인) → load() 가 /api/projects 를 전혀 호출하지 않는다.
 *     list=[], _needsLogin=true, render() 가 "로그인이 필요합니다" 문구를 hub-empty-text 에 반영.
 *  ② Auth.idToken 있는데 서버가 401 → list=[] 이지만 _needsLogin=true(0개로 오인 금지) +
 *     Auth.authExpired() 호출(기존 공유 재로그인 관문 재사용).
 *  ③ Auth.idToken 있고 서버가 정상 200 → list 채워짐, _needsLogin=false, fetch 1회.
 *  ④ 동시 중복 load() 두 번 호출(둘 다 await 전) → 실제 /api/projects fetch 는 1회만.
 *
 * 뮤테이션 2건으로 테스트 실효성 증명(끝부분).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_PATH = path.join(ROOT, "public/js/modules/12_ProjectHub.js");
const hubSrc = fs.readFileSync(SRC_PATH, "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => x && set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle(c, force) {
      if (force === undefined) { if (set.has(c)) { set.delete(c); return false; } set.add(c); return true; }
      if (force) set.add(c); else set.delete(c);
      return !!force;
    },
    contains: (c) => set.has(c),
  };
}
function makeEl() {
  const el = { classList: makeClassList(), _text: "", get textContent() { return this._text; }, set textContent(v) { this._text = v; }, innerHTML: "" };
  el.children = [];
  el.appendChild = (c) => { el.children.push(c); return c; };
  el.querySelector = () => null;
  el.addEventListener = () => {};
  return el;
}

/** 소스를 vm 에 로드해 ProjectHub 객체(실제 코드, 추출 아님)를 반환한다. */
function loadProjectHub(src, fetchImpl, authOverrides) {
  const registry = { "hub-grid": makeEl(), "hub-empty": makeEl(), "hub-btn-new": makeEl(), "hub-empty-text": makeEl(), "hub-empty-hint": makeEl() };
  function makeCreatedEl() {
    const el = makeEl();
    el.setAttribute = () => {};
    el.tabIndex = 0;
    return el;
  }
  const document = { getElementById: (id) => registry[id] || null, createElement: () => makeCreatedEl() };
  const fetchCalls = [];
  const fetch = async (url, opts) => { fetchCalls.push(url); return fetchImpl(url, opts); };
  const authExpiredCalls = [];
  const Auth = Object.assign({
    idToken: null,
    isDesigner: false,
    headers() { return this.idToken ? { Authorization: "Bearer " + this.idToken } : {}; },
    authExpired(msg) { authExpiredCalls.push(msg); },
    setProjectContext() {}, _applyUi() {}, _renderHubSignin() {},
  }, authOverrides || {});
  const UI = { escapeHtml: (s) => s, showScreen() {}, toggle() {} };
  const ShareLink = { isViewEntry: () => false, token: () => null };
  const navigator = { onLine: true };
  const sandbox = {
    console, document, fetch, Auth, UI, ShareLink, navigator,
    location: { search: "", pathname: "/" },
    AbortController, setTimeout, clearTimeout, URLSearchParams,
    Prompt: undefined, OfflineLoad: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__ProjectHub = ProjectHub;", sandbox);
  return { ProjectHub: sandbox.__ProjectHub, registry, fetchCalls, authExpiredCalls };
}

/* ══════════════════════════ ① 비로그인 → fetch 0회 ══════════════════════════ */
{
  const { ProjectHub, registry, fetchCalls } = loadProjectHub(hubSrc, async () => { throw new Error("should not be called"); }, { idToken: null });
  await ProjectHub.load();
  const projFetch = fetchCalls.filter((u) => u === "/api/projects");
  ok(projFetch.length === 0, "① 비로그인 → /api/projects fetch 0회 → " + JSON.stringify(fetchCalls));
  ok(ProjectHub.list.length === 0 && ProjectHub._needsLogin === true, "① list=[] + _needsLogin=true");
  ok(registry["hub-empty-text"].textContent === "로그인이 필요합니다.", "① hub-empty-text = 로그인 안내 → " + registry["hub-empty-text"].textContent);
}

/* ══════════════════════════ ② 토큰 있음 + 서버 401 → 재로그인 안내(0개 오인 아님) ══════════════════════════ */
{
  const fetchImpl = async (url) => {
    if (url === "/api/projects") return { status: 401, ok: false, json: async () => ({ error: "unauthorized" }) };
    return { status: 200, ok: true, json: async () => ({ data: [] }) };
  };
  const { ProjectHub, authExpiredCalls, fetchCalls } = loadProjectHub(hubSrc, fetchImpl, { idToken: "demo-designer" });
  await ProjectHub.load();
  ok(ProjectHub.list.length === 0 && ProjectHub._needsLogin === true, "② 401 → list=[] + _needsLogin=true(0개 오인 금지)");
  ok(authExpiredCalls.length === 1, "② Auth.authExpired() 공유 관문 재사용 1회 호출 → " + JSON.stringify(authExpiredCalls));
  ok(fetchCalls.filter((u) => u === "/api/projects").length === 1, "② /api/projects fetch 정확히 1회");
}

/* ══════════════════════════ ③ 토큰 있음 + 서버 200 → 정상 로드 ══════════════════════════ */
{
  const fetchImpl = async (url) => {
    if (url === "/api/projects") return { status: 200, ok: true, json: async () => ({ data: [{ id: "p1", name: "Project One" }] }) };
    return { status: 200, ok: true, json: async () => ({ data: [] }) };
  };
  const { ProjectHub, fetchCalls } = loadProjectHub(hubSrc, fetchImpl, { idToken: "demo-designer" });
  await ProjectHub.load();
  ok(ProjectHub.list.length === 1 && ProjectHub.list[0].id === "p1" && ProjectHub._needsLogin === false, "③ 정상 200 → list 채워짐 + _needsLogin=false");
  ok(fetchCalls.filter((u) => u === "/api/projects").length === 1, "③ /api/projects fetch 1회");
}

/* ══════════════════════════ ④ 동시 중복 load() → fetch 1회로 합쳐짐 ══════════════════════════ */
{
  let resolveFetch;
  const fetchImpl = (url) => {
    if (url === "/api/projects") return new Promise((res) => { resolveFetch = () => res({ status: 200, ok: true, json: async () => ({ data: [{ id: "p1", name: "A" }] }) }); });
    return Promise.resolve({ status: 200, ok: true, json: async () => ({ data: [] }) });
  };
  const { ProjectHub, fetchCalls } = loadProjectHub(hubSrc, fetchImpl, { idToken: "demo-designer" });
  const p1 = ProjectHub.load();
  const p2 = ProjectHub.load();
  await new Promise((r) => setImmediate(r));
  resolveFetch();
  await Promise.all([p1, p2]);
  ok(fetchCalls.filter((u) => u === "/api/projects").length === 1, "④ 동시 load() 2회 → /api/projects fetch 1회(dedupe) → " + JSON.stringify(fetchCalls));
}

console.log("\n[뮤테이션 M1] 비로그인 가드(!Auth.idToken)를 무력화하면 케이스①이 다시 깨져야 함");
{
  const mutated = hubSrc.replace(
    "      if (!Auth.idToken) {\n        this.list = []; this._loaded = true; this._needsLogin = true;\n        this.render();\n        return;\n      }",
    "      if (false) {\n        this.list = []; this._loaded = true; this._needsLogin = true;\n        this.render();\n        return;\n      }"
  );
  if (mutated === hubSrc) { console.log("  FAIL M1 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { ProjectHub, fetchCalls } = loadProjectHub(mutated, async (url) => ({ status: 401, ok: false, json: async () => ({}) }), { idToken: null });
    await ProjectHub.load();
    ok(fetchCalls.filter((u) => u === "/api/projects").length > 0, "뮤테이션 M1 적용 시 비로그인인데도 fetch 발생(회귀 재현, 테스트 실효성 증명) → " + JSON.stringify(fetchCalls));
  }
}

console.log("\n[뮤테이션 M2] 401 판정을 무력화하면 케이스②가 다시 깨져야 함(0개로 오인)");
{
  const mutated = hubSrc.replace("if (status === 401) {", "if (false) {");
  if (mutated === hubSrc) { console.log("  FAIL M2 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const fetchImpl = async (url) => {
      if (url === "/api/projects") return { status: 401, ok: false, json: async () => ({ error: "unauthorized" }) };
      return { status: 200, ok: true, json: async () => ({ data: [] }) };
    };
    const { ProjectHub, authExpiredCalls } = loadProjectHub(mutated, fetchImpl, { idToken: "demo-designer" });
    await ProjectHub.load();
    // 401 판정이 죽으면 _needsLogin 이 false 로 남아(data undefined→list=[] 로만 처리) "0개"로 오인한다.
    ok(ProjectHub._needsLogin === false && authExpiredCalls.length === 0, "뮤테이션 M2 적용 시 401 이 다시 0개로 오인됨(회귀 재현, 테스트 실효성 증명)");
  }
}

console.log(failed === 0 ? "\n전체 PASS" : `\n${failed}건 FAIL`);
process.exit(failed === 0 ? 0 : 1);
