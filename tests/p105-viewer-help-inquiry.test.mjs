/**
 * p105 — 뷰어 배포 화면 도움말 패널 + 개발자 문의 폼 회귀 테스트
 * (프레임워크 0 · 실행: node tests/p105-viewer-help-inquiry.test.mjs)
 *
 * WO 20261001-viewerhelp 판정 기준:
 *  ① 뷰어(body.role-viewer) 에서 "?" 토글을 누르면 배지 모드 대신 열람자용 섹션 패널이 뜬다.
 *  ② 패널 내용에 편집 전용 어휘(핀 생성/삭제/정렬/합치기)가 전혀 없다(역할별 분기 확인).
 *  ③ 패널 하단 "개발자에게 문의" 버튼 + 좌하단 "✉" 버튼(편집/뷰어 공용) 둘 다 문의 폼을 연다.
 *  ④ 문의 폼 제출 시 fetch POST /api/inquiries 가 올바른 payload 로 호출된다.
 *  ⑤ 429 응답이면 폼 안에 인라인 에러를 보여주고 폼을 닫지 않는다.
 *  ⑥ 200 성공이면 폼을 닫고 토스트를 띄운다.
 *  ⑦ 에디터 화면(role-viewer 없음)에서는 종전처럼 배지 모드가 그대로 동작한다(회귀 없음).
 *
 * 실제 모듈 소스(36_Help.js)를 그대로 vm 에 평가해 검사한다(목 구현 아님). fetch 만 가로챈다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const helpSrc = rd("public/js/modules/36_Help.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 범용 DOM 목(mock) — appendChild/classList/value 지원 ─────────────── */
function makeEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(), dataset: {}, style: {}, _attrs: {},
    children: [], parentNode: null, _text: "", _handlers: {}, value: "",
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k]; },
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i !== -1) this.children.splice(i, 1); c.parentNode = null; return c; },
    querySelector() { return null; },
    getBoundingClientRect() { return { left: 10, top: 10, bottom: 30, width: 50, height: 20 }; },
  };
  Object.defineProperty(el, "textContent", {
    get() { return this._text; },
    set(v) { this._text = v == null ? "" : String(v); },
  });
  return el;
}

/** 트리 전체에서 조건에 맞는 노드를 찾는다(badge/popup 처럼 body 직속이 아닌 중첩 구조 대응). */
function findAll(root, pred, out = []) {
  if (pred(root)) out.push(root);
  for (const c of root.children || []) findAll(c, pred, out);
  return out;
}
function textOfAll(root) {
  return findAll(root, () => true).map((n) => n._text || "").join(" ");
}

function makeEnv({ viewerRole = false, mainJsVersion = "abc123" } = {}) {
  const body = makeEl("body");
  if (viewerRole) body.classList.add("role-viewer");
  const scriptEl = makeEl("script");
  scriptEl.src = "/js/main.js?v=" + mainJsVersion;
  const document = {
    body,
    createElement: (t) => makeEl(t),
    querySelector(sel) {
      if (sel === 'script[src*="main.js"]') return scriptEl;
      return null;
    },
    addEventListener() {},
  };
  const fetchCalls = [];
  let fetchResponder = async () => ({ status: 200, ok: true, json: async () => ({ success: true, id: "inq-1", mail_sent: true }) });
  const fetchFn = async (url, opts) => {
    fetchCalls.push({ url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return fetchResponder(url, opts);
  };
  const toasts = [];
  const State = { currentProjectName: "테스트 프로젝트", currentDeploymentId: "dep_test_1", mode: viewerRole ? "viewer" : "designer" };
  const Auth = { headers: () => ({ Authorization: "Bearer tok" }) };
  const Prompt = { toast: (m) => toasts.push(m) };
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    document, window: { addEventListener() {}, innerWidth: 375, innerHeight: 700 },
    navigator: { userAgent: "test-agent/1.0" },
    setTimeout, clearTimeout,
    fetch: fetchFn, State, Auth, Prompt,
  };
  vm.createContext(sandbox);
  vm.runInContext(helpSrc + "\n;globalThis.__Help = Help;", sandbox);
  return { Help: sandbox.__Help, document, body, fetchCalls, toasts, setFetchResponder: (fn) => { fetchResponder = fn; } };
}

/* ══ ① 뷰어 역할 — 토글 클릭 시 섹션 패널(배지 아님) ══ */
console.log("\n[① 뷰어(role-viewer)에서 토글 → 섹션 패널]");
{
  const env = makeEnv({ viewerRole: true });
  env.Help.init();
  env.Help._toggleBtn._handlers.click[0]({ preventDefault() {}, stopPropagation() {} });
  ok(env.Help.viewerPanelOpen === true, "① toggle() 후 viewerPanelOpen=true");
  const panel = env.body.children.find((c) => c._attrs["data-help-viewer-backdrop"]);
  ok(!!panel, "① 뷰어 패널 DOM 이 body 에 추가됨");
  const allText = textOfAll(panel);
  ok(env.Help.VIEWER_SECTIONS.every((s) => allText.includes(s.title)), "① 모든 VIEWER_SECTIONS 제목이 패널에 렌더됨");
  const badges = env.body.children.filter((c) => c._attrs["data-help-badge"]);
  ok(badges.length === 0, "① 배지 모드는 전혀 동작하지 않음(배지 0개)");

  /* ══ ② 편집 전용 어휘 미노출 ══ */
  const forbidden = ["핀 생성", "핀 삭제", "정렬", "합치기", "핀 추가"];
  const leaked = forbidden.filter((w) => allText.includes(w));
  ok(leaked.length === 0, "② 편집 전용 어휘 노출 0개 (발견: " + JSON.stringify(leaked) + ")");

  env.Help._toggleBtn._handlers.click[0]({ preventDefault() {}, stopPropagation() {} });
  ok(env.Help.viewerPanelOpen === false, "① 다시 누르면 닫힘(viewerPanelOpen=false)");
  const panelAfter = env.body.children.find((c) => c._attrs["data-help-viewer-backdrop"]);
  ok(!panelAfter, "① 패널 DOM 이 제거됨");
}

/* ══ ③ 문의 진입 — ✉ 버튼 + 패널 내 버튼 둘 다 ══ */
console.log("\n[③ 문의 진입점 2곳]");
{
  const env = makeEnv({ viewerRole: true });
  env.Help.init();
  ok(!!env.Help._inquiryEntryBtn, "③ 좌하단 ✉ 버튼이 생성됨");
  env.Help._inquiryEntryBtn._handlers.click[0]({ preventDefault() {}, stopPropagation() {} });
  let form = env.body.children.find((c) => c._attrs["data-help-inquiry-backdrop"]);
  ok(!!form, "③ ✉ 버튼 클릭으로 문의 폼이 열림");
  env.Help.closeInquiry();

  env.Help._toggleBtn._handlers.click[0]({ preventDefault() {}, stopPropagation() {} }); // 뷰어 패널 열기
  const viewerPanel = env.body.children.find((c) => c._attrs["data-help-viewer-backdrop"]);
  const inquiryOpenBtn = findAll(viewerPanel, (n) => n._attrs && n._attrs["data-help-inquiry-open"])[0];
  ok(!!inquiryOpenBtn, "③ 패널 하단에 문의 버튼이 존재함");
  inquiryOpenBtn._handlers.click[0]({});
  form = env.body.children.find((c) => c._attrs["data-help-inquiry-backdrop"]);
  ok(!!form, "③ 패널 하단 버튼으로도 문의 폼이 열림");
}

/* ══ ④ 제출 payload 검증 ══ */
console.log("\n[④ 문의 제출 payload]");
{
  const env = makeEnv({ viewerRole: true });
  env.Help.init();
  env.Help.openInquiry();
  const form = env.body.children.find((c) => c._attrs["data-help-inquiry-backdrop"]);
  const titleInput = findAll(form, (n) => n._attrs && n._attrs["data-help-inquiry-title"])[0];
  const bodyInput = findAll(form, (n) => n._attrs && n._attrs["data-help-inquiry-body"])[0];
  const emailInput = findAll(form, (n) => n._attrs && n._attrs["data-help-inquiry-email"])[0];
  const sendBtn = findAll(form, (n) => n._attrs && n._attrs["data-help-inquiry-send"])[0];
  titleInput.value = "도움말 테스트 제목";
  bodyInput.value = "도움말 테스트 본문입니다.";
  emailInput.value = "me@example.com";
  await sendBtn._handlers.click[0]({});
  ok(env.fetchCalls.length === 1, "④ fetch 1회 호출");
  const call = env.fetchCalls[0];
  ok(call.url === "/api/inquiries" && call.opts.method === "POST", "④ POST /api/inquiries 호출");
  ok(call.body.title === "도움말 테스트 제목" && call.body.body === "도움말 테스트 본문입니다." && call.body.reply_email === "me@example.com", "④ 입력값이 payload 에 그대로 포함됨");
  ok(call.body.context && call.body.context.project_name === "테스트 프로젝트" && call.body.context.deployment_id === "dep_test_1" && call.body.context.app_version === "abc123", "④ 현재 화면 정보(프로젝트/배포본/버전)가 자동 첨부됨: " + JSON.stringify(call.body.context));
  ok(call.opts.headers.Authorization === "Bearer tok", "④ Auth.headers() 가 요청 헤더에 반영됨");
  /* ⑥ 성공 시 폼 닫힘 + 토스트 */
  const formAfter = env.body.children.find((c) => c._attrs["data-help-inquiry-backdrop"]);
  ok(!formAfter, "⑥ 성공 응답 후 폼이 닫힘");
  ok(env.toasts.length === 1, "⑥ 성공 토스트 1회 호출: " + env.toasts[0]);
}

/* ══ ⑤ 429 응답 — 폼을 닫지 않고 인라인 에러 ══ */
console.log("\n[⑤ 429 레이트리밋 응답 처리]");
{
  const env = makeEnv({ viewerRole: true });
  env.setFetchResponder(async () => ({ status: 429, ok: false, json: async () => ({ error: "문의가 너무 자주 접수되었습니다." }) }));
  env.Help.init();
  env.Help.openInquiry();
  const form = env.body.children.find((c) => c._attrs["data-help-inquiry-backdrop"]);
  const titleInput = findAll(form, (n) => n._attrs && n._attrs["data-help-inquiry-title"])[0];
  const bodyInput = findAll(form, (n) => n._attrs && n._attrs["data-help-inquiry-body"])[0];
  const sendBtn = findAll(form, (n) => n._attrs && n._attrs["data-help-inquiry-send"])[0];
  const errEl = findAll(form, (n) => n._attrs && n._attrs["data-help-inquiry-error"])[0];
  titleInput.value = "t"; bodyInput.value = "b";
  await sendBtn._handlers.click[0]({});
  const stillOpen = env.body.children.find((c) => c._attrs["data-help-inquiry-backdrop"]);
  ok(!!stillOpen, "⑤ 429 응답에도 폼이 닫히지 않음");
  ok(errEl._text.includes("너무 자주"), "⑤ 인라인 에러 문구 표시: " + errEl._text);
}

/* ══ ⑦ 에디터 화면(role-viewer 없음) — 종전 배지 모드 회귀 없음 ══ */
console.log("\n[⑦ 에디터 화면 회귀 없음 — 배지 모드 그대로]");
{
  const env = makeEnv({ viewerRole: false });
  env.Help.init();
  const target = makeEl("button");
  target.dataset.help = "zone-create";
  // querySelectorAll 은 badge 모드 구현이 document.querySelectorAll 을 쓰므로 보강
  env.document.querySelectorAll = (sel) => (sel === "[data-help]" ? [target] : []);
  env.Help._toggleBtn._handlers.click[0]({ preventDefault() {}, stopPropagation() {} });
  ok(env.Help.active === true, "⑦ 에디터 화면은 종전처럼 active=true (배지 모드)");
  ok(env.Help.viewerPanelOpen === false, "⑦ 에디터 화면에서는 뷰어 패널이 열리지 않음");
  const badges = env.body.children.filter((c) => c._attrs["data-help-badge"]);
  ok(badges.length === 1, "⑦ data-help 요소 수만큼 배지 생성(회귀 없음) → " + badges.length + "개");
}

/* ──────────────────────────────────────────────────────────────
 * 뮤테이션: _isViewerRole() 이 항상 false 를 반환하도록 깨뜨림
 * → ①(뷰어 패널이 열림)이 실패해야 한다.
 * ────────────────────────────────────────────────────────────── */
console.log("\n[뮤테이션] _isViewerRole 를 항상 false 로 깨뜨림 → ①이 실패해야 함");
{
  const needle = `    _isViewerRole() {
      try { return !!(document.body && document.body.classList && document.body.classList.contains("role-viewer")); }
      catch (e) { return false; }
    },`;
  if (!helpSrc.includes(needle)) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mutated = helpSrc.replace(needle, `    _isViewerRole() { return false; },`);
    const body = makeEl("body");
    body.classList.add("role-viewer");
    const document = { body, createElement: (t) => makeEl(t), querySelector: () => null, addEventListener() {} };
    document.querySelectorAll = () => [];
    const sandbox = {
      console: { warn() {}, log() {}, error() {} }, document,
      window: { addEventListener() {}, innerWidth: 1024, innerHeight: 768 },
      navigator: { userAgent: "x" }, setTimeout, clearTimeout, fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }),
    };
    vm.createContext(sandbox);
    vm.runInContext(mutated + "\n;globalThis.__Help = Help;", sandbox);
    sandbox.__Help.init();
    sandbox.__Help._toggleBtn._handlers.click[0]({ preventDefault() {}, stopPropagation() {} });
    ok(sandbox.__Help.viewerPanelOpen !== true, "뮤테이션 적용 시 ①이 깨짐(테스트 실효성 증명) → viewerPanelOpen=" + sandbox.__Help.viewerPanelOpen);
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
