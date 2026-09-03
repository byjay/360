/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p14-viewer-zoom-quality.test.mjs)
 *
 * 마스터 지시(2026-09-03): 뷰어에서 도면을 확대하면 뭉갠다.
 * 근본원인: 배포 시 원본 PDF 를 저장하지 않아 뷰어는 4096px 스냅샷만 갖고 있고,
 *          확대는 CSS 확대라 픽셀이 그대로 커진다.
 * 채택안(하이브리드): 첫 화면은 스냅샷으로 즉시 표시, 스냅샷 해상도를 실제로
 *          넘겨 확대할 때만 원본 PDF 를 1회 지연 로드해 재래스터한다.
 *
 * 검사:
 *   A 배포 시 원본 URL 이 source_meta 에 기록된다 (_buildSourceMeta)
 *   B 이미지 도면(PNG/JPG)은 이 경로를 타지 않는다(업로드 요청 0)
 *   C 임계 이하에서는 원본을 받지 않는다(불필요 다운로드 0)
 *   D 임계 초과 시 1회만 받는다(재호출해도 재다운로드 0)
 *   E 원본 없는 구버전 배포본 → 종전 동작 + 안내는 1회만
 *   F 재래스터 가드는 모드가 아니라 "원본 보유 여부" 로 판정한다
 *
 * 실제 모듈 소스(01_State.js/02_PDF.js/10_MapCtrl.js/20_App.js)를 vm 에 함께
 * 평가해 검사한다(목 구현 아님). 뮤테이션 3건이 붙어 있어, 고친 코드를 되돌리면
 * 해당 검사가 실패한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const stateSrc = rd("public/js/modules/01_State.js");
const pdfSrc   = rd("public/js/modules/02_PDF.js");
const mapSrc   = rd("public/js/modules/10_MapCtrl.js");
const appSrc   = rd("public/js/modules/20_App.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/** 네 모듈을 한 샌드박스에 평가 → { State, PDF, MapCtrl, App, env } (env = 관찰용 스파이) */
function load(src = { state: stateSrc, pdf: pdfSrc, map: mapSrc, app: appSrc }) {
  const env = {
    fetchCalls: [],
    toasts: [],
    applyTransformCalls: 0,
    uploadUrl: "/api/r2/object/assets/9990001-abcd.pdf"
  };
  const imgStub = {
    classList: { contains: () => false },
    naturalWidth: 1000,
    clientWidth: 1500
  };
  const sandbox = {
    console, Math, JSON, Promise, setTimeout, clearTimeout, Object, Array, Number, String,
    Blob: function Blob(parts, opts) { this.parts = parts; this.opts = opts; },
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }),
      body: { appendChild() {} }
    },
    navigator: { userAgent: "node", platform: "", maxTouchPoints: 0 },
    performance: { now: () => 0 },
    UI: { $: (id) => (id === "map-image" ? imgStub : null) },
    Auth: { headers: () => ({}), r2: (u) => u },
    Prompt: { toast: (msg) => { env.toasts.push(msg); } },
    Zones: { serialize: () => "[]" },
    fetch: async (url, opts) => {
      env.fetchCalls.push({ url, method: (opts && opts.method) || "GET" });
      if (String(url).indexOf("/api/r2/upload") === 0) {
        return { ok: true, json: async () => ({ url: env.uploadUrl }) };
      }
      // 원본 PDF 다운로드
      return { ok: true, headers: { get: () => null }, body: null, arrayBuffer: async () => new ArrayBuffer(8) };
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    src.state + "\n" + src.pdf + "\n" + src.map + "\n" + src.app +
    "\n;globalThis.__STATE=State;globalThis.__PDF=PDF;globalThis.__MAP=MapCtrl;globalThis.__APP=App;",
    sandbox
  );
  // App._primeSourceRender 이 doc.getPage 를 쓰므로 PDF.load 스텁 부여(App 소스 밖 — 런타임 전용)
  sandbox.__PDF.load = async () => ({
    numPages: 1,
    getPage: async () => ({ rotate: 0, getViewport: () => ({ width: 2384 }) })
  });
  sandbox.__PDF._renderState = {};
  sandbox.__PDF._clearCrop = () => {};
  sandbox.__MAP.applyTransform = () => { env.applyTransformCalls++; };
  return { State: sandbox.__STATE, PDF: sandbox.__PDF, MapCtrl: sandbox.__MAP, App: sandbox.__APP, env };
}

/* ────────────────────────────────────────────────────────────
 * A/B. 배포 시 source_meta 생성 — 원본 URL 기록 + 이미지 도면 가드
 * ──────────────────────────────────────────────────────────── */
async function suiteBuildMeta(label, mk) {
  console.log("\n[" + label + "]");
  {
    const { State, App, env } = mk();
    State.fileType = "pdf";
    State.fileData = new ArrayBuffer(16);
    const dims = [{ w: 4096, h: 2893, pw: 2384, ph: 1684 }];
    const meta = await App._buildSourceMeta(dims);
    let parsed = null; try { parsed = JSON.parse(meta); } catch (e) {}
    ok(!!parsed && parsed.pdf_url === env.uploadUrl, `A PDF 배포 → source_meta.pdf_url 기록됨 (${parsed && parsed.pdf_url})`);
    ok(!!parsed && Array.isArray(parsed.pages) && parsed.pages[0].w === 4096, "A source_meta.pages = 실측 스냅샷 픽셀");
    ok(State.sourcePdfUrl === env.uploadUrl, "A State.sourcePdfUrl 도 함께 갱신");
  }
  {
    const { State, App, env } = mk();
    State.fileType = "image";
    State.fileData = new ArrayBuffer(16);
    const meta = await App._buildSourceMeta([]);
    ok(meta === null, "B 이미지 도면(PNG/JPG) → source_meta 없음(null)");
    ok(env.fetchCalls.length === 0, "B 이미지 도면 → 원본 업로드 요청 0건(경로 자체를 안 탐)");
  }
}

/* ────────────────────────────────────────────────────────────
 * C/D. 임계 판정 + 1회만 로드
 * ──────────────────────────────────────────────────────────── */
async function suiteThresholdOnce(label, mk) {
  console.log("\n[" + label + "]");
  {
    // C: 임계 이하(확대 안 함) → 원본을 받지 않는다
    const { State, App, env } = mk();
    State.fileType = "pdf";
    State.sourceMeta = { v: 1, pdf_url: "/api/r2/object/assets/x.pdf", pages: [{ w: 1000, h: 700, pw: 1000, ph: 700 }] };
    State.sourcePdfUrl = State.sourceMeta.pdf_url;
    State.pdfPage = 1;
    const r = await App.maybeLoadSourcePdf(1.0);
    ok(r === false && env.fetchCalls.length === 0, `C 임계 이하(zoom=1.0) → 원본 다운로드 0건 (fetch=${env.fetchCalls.length})`);
  }
  {
    // D: 임계 초과 → 1회만 받는다(재호출해도 재다운로드 없음)
    const { State, App, env } = mk();
    State.fileType = "pdf";
    State.sourceMeta = { v: 1, pdf_url: "/api/r2/object/assets/x.pdf", pages: [{ w: 1000, h: 700, pw: 1000, ph: 700 }] };
    State.sourcePdfUrl = State.sourceMeta.pdf_url;
    State.pdfPage = 1;
    const r1 = await App.maybeLoadSourcePdf(3.0); // cssPx(1500)*3 > 1000*1.5 → 임계 초과
    ok(r1 === true, "D 임계 초과(zoom=3.0) → 첫 호출 성공(원본 확보)");
    const dlCount1 = env.fetchCalls.filter(c => c.url === State.sourcePdfUrl).length;
    ok(dlCount1 === 1, `D 원본 다운로드 정확히 1회 (${dlCount1})`);
    const r2 = await App.maybeLoadSourcePdf(6.0); // 더 확대해도
    ok(r2 === false, "D 이미 원본 보유 → 재호출은 즉시 false(가드)");
    const dlCount2 = env.fetchCalls.filter(c => c.url === State.sourcePdfUrl).length;
    ok(dlCount2 === 1, `D 재호출해도 재다운로드 없음 (누적 ${dlCount2})`);
  }
}

/* ────────────────────────────────────────────────────────────
 * E. 원본 없는 구버전 배포본 — 종전 동작 + 안내 1회만
 * ──────────────────────────────────────────────────────────── */
async function suiteLegacyFallback(label, mk) {
  console.log("\n[" + label + "]");
  const { State, App, env } = mk();
  State.fileType = "pdf";
  App._applySourceMeta({ source_meta: null }); // 구버전 배포본 = source_meta 없음
  ok(State.sourcePdfUrl === null, "E 구버전 배포본 → State.sourcePdfUrl = null");
  const r1 = await App.maybeLoadSourcePdf(6.0); // 임계는 넘지만 원본이 없다
  ok(r1 === false && env.fetchCalls.length === 0, "E 원본 없음 → 다운로드 시도 안 함(종전 스냅샷 그대로)");
  ok(env.toasts.length === 1, `E 안내 정확히 1회 (${env.toasts.length}건: ${env.toasts.join(" | ")})`);
  const r2 = await App.maybeLoadSourcePdf(8.0); // 더 확대해도
  ok(env.toasts.length === 1, `E 반복 확대해도 안내는 여전히 1회(반복 알림 금지) (${env.toasts.length})`);
}

/* ────────────────────────────────────────────────────────────
 * F. 재래스터 가드 = 모드가 아니라 "원본 보유 여부"
 * ──────────────────────────────────────────────────────────── */
function suiteGuard(label, mk) {
  console.log("\n[" + label + "]");
  const { State, MapCtrl, PDF } = mk();
  // 뷰어 모드인데 원본을 지연 로드해 확보한 상태 → 가드가 열려야 한다(구 조건은 mode==viewer 라 항상 닫혀 있었다)
  State.mode = "viewer"; State.fileType = "pdf"; State.pdfDoc = null; State.srcPdfDoc = { numPages: 1 };
  ok(MapCtrl.hasRerenderSource() === true, "F 뷰어+원본 확보(srcPdfDoc) → 가드 열림(구 조건이면 항상 닫혀있었음)");
  // 뷰어인데 원본이 없다(구버전) → 가드는 닫혀야 한다
  State.srcPdfDoc = null;
  ok(MapCtrl.hasRerenderSource() === false, "F 뷰어+원본 없음 → 가드 닫힘(스냅샷 그대로)");
  // 편집모드 PDF(종전 경로) → 여전히 열려야 한다(회귀 없음)
  State.mode = "designer"; State.pdfDoc = { numPages: 1 };
  ok(MapCtrl.hasRerenderSource() === true, "F 편집모드 PDF(State.pdfDoc) → 가드 열림(종전 동작 보존)");
}

/* ── 실행: 정상 소스 ─────────────────────────────────────────── */
{
  const mk = () => load();
  await suiteBuildMeta("A/B source_meta 생성 (정상 소스)", mk);
  await suiteThresholdOnce("C/D 임계 판정 + 1회만 (정상 소스)", mk);
  await suiteLegacyFallback("E 구버전 폴백 + 1회 안내 (정상 소스)", mk);
  suiteGuard("F 재래스터 가드 (정상 소스)", mk);
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 M1: source_meta 에서 pdf_url 기록을 제거 → A 가 실패해야 함
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션M1] source_meta 에서 pdf_url 기록 제거 → A 가 실패해야 함");
  const needle = "return JSON.stringify({ v: 1, pdf_url: url, pages: pages });";
  const mutated = appSrc.replace(needle, "return JSON.stringify({ v: 1, pages: pages });");
  if (mutated === appSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mk = () => load({ state: stateSrc, pdf: pdfSrc, map: mapSrc, app: mutated });
    const { State, App } = mk();
    State.fileType = "pdf"; State.fileData = new ArrayBuffer(16);
    const meta = await App._buildSourceMeta([{ w: 4096, h: 2893, pw: 2384, ph: 1684 }]);
    let parsed = null; try { parsed = JSON.parse(meta); } catch (e) {}
    ok(!(parsed && parsed.pdf_url != null),
      `뮤테이션 적용 시 pdf_url 이 기록되지 않음(테스트 실효성 증명) → pdf_url=${parsed && parsed.pdf_url}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 M2: 임계 판정을 제거(항상 true) → C 가 실패해야 함
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션M2] needsSourceRerender 를 항상 true 로 되돌림 → C 가 실패해야 함");
  const needle = "return (cssPx * zoom) > (snapPx * gain);";
  const mutated = pdfSrc.replace(needle, "return true;");
  if (mutated === pdfSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mk = () => load({ state: stateSrc, pdf: mutated, map: mapSrc, app: appSrc });
    const { State, App, env } = mk();
    State.fileType = "pdf";
    State.sourceMeta = { v: 1, pdf_url: "/api/r2/object/assets/x.pdf", pages: [{ w: 1000, h: 700, pw: 1000, ph: 700 }] };
    State.sourcePdfUrl = State.sourceMeta.pdf_url;
    State.pdfPage = 1;
    const r = await App.maybeLoadSourcePdf(1.0); // 확대 안 했는데도
    ok(!(r === false && env.fetchCalls.length === 0),
      `뮤테이션 적용 시 임계 이하에서도 다운로드가 발생함(테스트 실효성 증명) → r=${r}, fetch=${env.fetchCalls.length}`);
  }
}

/* ────────────────────────────────────────────────────────────
 * 뮤테이션 M3: 구버전 폴백 안내를 제거 → E 가 실패해야 함
 * ──────────────────────────────────────────────────────────── */
{
  console.log("\n[뮤테이션M3] 구버전 배포본 안내(this._noticeNoSource) 호출 제거 → E 가 실패해야 함");
  const needle = 'if (!State.sourcePdfUrl) { this._noticeNoSource(); return false; }';
  const mutated = appSrc.replace(needle, 'if (!State.sourcePdfUrl) { return false; }');
  if (mutated === appSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mk = () => load({ state: stateSrc, pdf: pdfSrc, map: mapSrc, app: mutated });
    const { State, App, env } = mk();
    State.fileType = "pdf";
    App._applySourceMeta({ source_meta: null });
    await App.maybeLoadSourcePdf(6.0);
    ok(!(env.toasts.length === 1),
      `뮤테이션 적용 시 구버전 안내가 표시되지 않음(테스트 실효성 증명) → toasts=${env.toasts.length}`);
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
