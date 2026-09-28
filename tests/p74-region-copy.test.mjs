/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p74-region-copy.test.mjs)
 *
 * 대상: 마스터 지시 "지정한 영역만 복사해서 새로운 페이지" / "확대하면 해상도가 깨지잖아".
 *
 * 근본원인: 영역(region deck)이 복사본이 아니라 원본 배포본을 가리키는 창(같은 deployment_id + crop %)이었다.
 *   원본 PDF 가 없는 배포본(29개 중 24개)은 확대하면 스냅샷 비트맵만 늘어나 깨진다.
 *
 * 채택: 영역 생성 시 원본 PDF 의 그 페이지를 pdf-lib 로 통째 복사(벡터)하고 MediaBox/CropBox 를
 *   영역 사각형으로 좁힌 새 1페이지 PDF 를 새 배포본으로 저장 → 새 영역 deck 은 그 배포본(crop 없음).
 *   원본이 없으면 조용히 이미지 복사본을 만들지 않고 묻는다(원본 올리기 / 창 방식 / 취소).
 *
 * 오라클: 좌표 변환은 **실제 pdf.js(pdfjs-dist 3.11.174 — 앱과 같은 버전)** 의 viewport.convertToPdfPoint 와 대조한다.
 *   복사 PDF 는 **실제 pdf-lib** 로 만들고 실제 pdf.js 로 다시 열어 페이지 크기·내용 위치를 잰다(목 아님).
 * 뮤테이션 3건(y 뒤집기 제거 / 원본 없음 분기 우회 / 기존 핀 수정)이 붙어 있다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as PDFLib from "pdf-lib";

const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.js")).default;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const pdfSrc = rd("public/js/modules/02_PDF.js");
const projSrc = rd("public/js/modules/31_Projects.js");
const appSrc = rd("public/js/modules/20_App.js");
const projSrcBox = { v: projSrc };   // 뮤테이션이 흐름 스위트의 31_Projects 소스를 바꿔 끼우는 자리

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };
const near = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;

const vendorLib = rd("public/vendor/pdf-lib.min.js");
/** 02_PDF.js + **벤더링한 public/vendor/pdf-lib.min.js 그 파일**을 한 realm 에 올린다(앱과 같은 조합).
 *  테스트가 만든 바이트(바깥 realm)는 vm realm 의 Uint8Array 로 옮겨 넘긴다(브라우저에선 같은 realm). */
function loadPDF(src = pdfSrc) {
  const sb = { console, document: {} };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(vendorLib, sb);
  vm.runInContext(src + "\n;globalThis.__P = PDF;", sb);
  const P = sb.__P, U8 = vm.runInContext("Uint8Array", sb), raw = P.copyRegionToPdf;
  P.copyRegionToPdf = function (b, ...rest) { return raw.call(this, new U8(new Uint8Array(b)), ...rest); };
  return P;
}

/** 원본 PDF — 회전·MediaBox 원점 이동·CropBox 까지 넣어 좌표계 함정을 전부 밟는다. 표지 텍스트 2개. */
async function makeSrcPdf(rot, { size = [600, 400], mb = [30, 50, 600, 400], cb = null, pages = 1 } = {}) {
  const d = await PDFLib.PDFDocument.create();
  const font = await d.embedFont(PDFLib.StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = d.addPage(size);
    p.setMediaBox(...mb);
    if (cb) p.setCropBox(...cb);
    p.setRotation(PDFLib.degrees(rot));
    for (let x = 40; x <= 620; x += 20) for (let y = 60; y <= 440; y += 20) p.drawText("G" + x + "_" + y, { x, y, size: 6, font });
  }
  return await d.save();
}
const FONTS = path.join(ROOT, "node_modules/pdfjs-dist/standard_fonts/").split(path.sep).join("/");
const openPdf = async (bytes) => await pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: FONTS, verbosity: 0 }).promise;

async function textPos(page, vp, str) {
  const tc = await page.getTextContent();
  const it = tc.items.find((i) => i.str === str);
  return it ? vp.convertToViewportPoint(it.transform[4], it.transform[5]) : null;
}

const CROP = { x: 10, y: 20, w: 30, h: 25 };

/* ═════ 1. crop % → PDF 사용자 공간(좌하단 원점) — 실제 pdf.js 와 대조, 회전 0/90/180/270 ═════ */
async function suiteBox(label, P) {
  console.log("\n[" + label + "]");
  for (const rot of [0, 90, 180, 270]) {
    for (const cb of [null, [60, 70, 500, 300]]) {
      const doc = await openPdf(await makeSrcPdf(rot, { cb }));
      const pg = await doc.getPage(1);
      const vp = pg.getViewport({ scale: 1 });
      const a = vp.convertToPdfPoint(CROP.x / 100 * vp.width, CROP.y / 100 * vp.height);
      const b = vp.convertToPdfPoint((CROP.x + CROP.w) / 100 * vp.width, (CROP.y + CROP.h) / 100 * vp.height);
      const want = { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
      const got = P.cropPctToPdfBox(CROP, pg.view, pg.rotate) || {};
      ok(near(got.x, want.x) && near(got.y, want.y) && near(got.width, want.w) && near(got.height, want.h),
        `rot=${rot} ${cb ? "CropBox" : "MediaBox"} → ${JSON.stringify(got)} = pdf.js ${JSON.stringify(want)}`);
      await doc.destroy();
    }
  }
  ok(P.cropPctToPdfBox({ x: 0, y: 0, w: 0, h: 5 }, [0, 0, 10, 10], 0) === null, "폭 0 영역 → null(조용한 가짜 상자 금지)");
  ok(P.cropPctToPdfBox(CROP, [0, 0, 10, 10], 45) === null, "90° 배수가 아닌 회전 → null");
}

/* ═════ 2. 실제 pdf-lib 로 복사 → 실제 pdf.js 로 열어 크기·내용 위치 확인 ═════ */
async function suiteCopy(label, P) {
  console.log("\n[" + label + "]");
  for (const rot of [0, 90, 180, 270]) {
    const srcBytes = await makeSrcPdf(rot, { cb: [40, 60, 620, 440] });
    const sdoc = await openPdf(srcBytes); const spg = await sdoc.getPage(1);
    const svp = spg.getViewport({ scale: 1 });
    const res = await P.copyRegionToPdf(srcBytes, 1, CROP, null);
    const ndoc = await openPdf(res.bytes); const npg = await ndoc.getPage(1);
    const nvp = npg.getViewport({ scale: 1 });
    ok(ndoc.numPages === 1, `rot=${rot} 새 PDF = 1페이지`);
    const ew = CROP.w / 100 * svp.width, eh = CROP.h / 100 * svp.height;
    ok(near(nvp.width, ew, 0.1) && near(nvp.height, eh, 0.1),
      `rot=${rot} 새 페이지 화면 크기 ${nvp.width.toFixed(2)}×${nvp.height.toFixed(2)}pt = 영역 ${ew.toFixed(2)}×${eh.toFixed(2)}pt`);
    // 격자 표지(G<x>_<y>) 중 원본 화면에서 영역 안에 있던 것 → 새 페이지에서 (원본 위치 − 영역 원점)에 있어야 한다
    const ox = CROP.x / 100 * svp.width, oy = CROP.y / 100 * svp.height;
    const sItems = (await spg.getTextContent()).items.filter((i) => /^G/.test(i.str));
    const inside = sItems.map((i) => ({ s: i.str, p: svp.convertToViewportPoint(i.transform[4], i.transform[5]) }))
      // 글자 몸통(최대 ≈30pt)까지 영역 안에 들어오는 것만 — pdf.js 는 보이는 상자 밖으로 삐져나간 글자를 텍스트에서 뺀다
      .filter((o) => o.p[0] > ox + 32 && o.p[0] < ox + ew - 32 && o.p[1] > oy + 32 && o.p[1] < oy + eh - 32);
    let matched = 0, bad = null;
    for (const o of inside) {
      const pn = await textPos(npg, nvp, o.s);
      if (pn && near(pn[0], o.p[0] - ox, 0.1) && near(pn[1], o.p[1] - oy, 0.1)) matched++;
      else if (!bad) bad = o.s + " 원본(" + o.p.map((v) => v.toFixed(1)) + ") 새(" + (pn && pn.map((v) => v.toFixed(1))) + ")";
    }
    ok(inside.length >= 3 && matched === inside.length,
      `rot=${rot} 내용 위치 보존 — 영역 안 표지 ${matched}/${inside.length}개가 (원본 화면 위치 − 영역 원점)에 있음${bad ? " · 불일치 " + bad : ""}`);
    ok(npg.rotate === rot, `rot=${rot} 회전 유지(${npg.rotate})`);
    await sdoc.destroy(); await ndoc.destroy();
  }
  // 원본 바이트 불변
  const srcBytes = await makeSrcPdf(0);
  const before = Buffer.from(srcBytes).toString("base64");
  await P.copyRegionToPdf(srcBytes, 1, CROP, null);
  ok(Buffer.from(srcBytes).toString("base64") === before, "원본 PDF 바이트 불변(읽기만)");
  // 대조 실패 → SIZE_MISMATCH
  let code = null;
  try { await P.copyRegionToPdf(srcBytes, 1, CROP, { count: 1, pw: 842, ph: 595 }); } catch (e) { code = e.code; }
  ok(code === "SIZE_MISMATCH", "화면 도면 크기(842×595)와 다른 원본 → SIZE_MISMATCH 로 거부 (" + code + ")");
  code = null;
  try { await P.copyRegionToPdf(srcBytes, 3, CROP, null); } catch (e) { code = e.code; }
  ok(code === "SIZE_MISMATCH", "없는 페이지(3쪽) → 거부");
}

/* ═════ 3. 대조 규칙(순수) ═════ */
function suiteMismatch(P) {
  console.log("\n[3. 원본 ↔ 화면 도면 대조]");
  ok(P.regionSizeMismatch({ count: 2, pw: 600, ph: 400 }, { count: 2, w: 601, h: 399 }) === null, "같은 파일(±1pt) → 일치");
  ok(/페이지 수/.test(P.regionSizeMismatch({ count: 2 }, { count: 3, w: 1, h: 1 }) || ""), "페이지 수 다름 → 사유");
  ok(/크기/.test(P.regionSizeMismatch({ pw: 600, ph: 400 }, { count: 1, w: 842, h: 595 }) || ""), "크기 다름 → 사유");
  ok(/비율/.test(P.regionSizeMismatch({ w: 4096, h: 2731 }, { count: 1, w: 595, h: 842 }) || ""), "(pt 기록 없는 구버전) 비율 다름 → 사유");
  ok(P.regionSizeMismatch({ w: 4096, h: 2731 }, { count: 1, w: 600, h: 400 }) === null, "(pt 기록 없는 구버전) 비율 같음 → 일치");
  ok(P.regionSizeMismatch(null, { count: 1, w: 1, h: 1 }) === null, "기대값 없음(화면=PDF 자체) → 대조 생략");
}

/* ═════ 4. 흐름 — 31_Projects.extractRegionAsDeck (실제 PDF 모듈 + 실제 pdf-lib · App 은 I/O 경계만 기록) ═════ */
const SRC_DEP = "dep_src";
function makeClient(P, { source, confirms = [], file = null, pins = [], app = {} } = {}) {
  const rec = { toasts: [], confirms: [], decksPost: [], copies: [], attaches: [], otherFetch: [] };
  const labels = { ok: { textContent: "확인" }, cancel: { textContent: "취소" } };
  const State = { mode: "designer", pdfPage: 1, autoSaveDepId: SRC_DEP, pins };
  const decks = [{ id: "dck_root", name: "ㅁ", deployment_id: SRC_DEP, page: 1, crop: null, parent_id: null }];
  const App = {
    _regionSource: async () => source,
    _regionExpect: (meta, snapCount) => ({ count: snapCount, pw: 600, ph: 400 }),
    _pickPdfFile: async () => file,
    _attachSourcePdf: async (depId, bytes) => { rec.attaches.push({ depId, bytes }); return true; },
    _createRegionCopyDeployment: async (name, bytes) => { rec.copies.push({ name, bytes }); return "dep_copy_" + rec.copies.length; },
  };
  Object.assign(App, app);
  const sb = {
    console, JSON, Math, Date, Set, Map, Promise, Object, Array, String, Number, Boolean, setTimeout,
    navigator: { onLine: true },
    document: { getElementById: (id) => (id === "wm-confirm-ok" ? labels.ok : id === "wm-confirm-cancel" ? labels.cancel : null) },
    Auth: { headers: () => ({}), isDesigner: true },
    Prompt: {
      toast: (m) => rec.toasts.push(String(m)),
      ask: async () => ({ value: "" }),
      // 실제 Prompt.confirm 처럼 모달이 뜬 뒤(동기 반환 이후) 사용자가 보는 버튼 문구를 기록한다
      confirm: async (t, m) => { await null; rec.confirms.push({ t, m, ok: labels.ok.textContent, no: labels.cancel.textContent }); return confirms.shift() === true; }
    },
    State, App, PDF: P,
    fetch: async (url, o) => {
      o = o || {};
      if (/\/decks$/.test(url) && o.method === "POST") {
        const b = JSON.parse(o.body); rec.decksPost.push(b);
        const d = Object.assign({ id: "dck_new" + rec.decksPost.length }, b); decks.push(d);
        return { ok: true, json: async () => d };
      }
      if (/\/decks$/.test(url)) return { ok: true, json: async () => decks };
      rec.otherFetch.push({ url, method: o.method || "GET", body: o.body });
      return { ok: false, status: 500, json: async () => ({}) };
    },
  };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(projSrcBox.v + "\n;globalThis.__J = Projects;", sb);
  const J = sb.__J;
  J.currentProject = { id: "prj" };
  J.decks = decks.slice();
  J.currentDeck = decks[0];
  J.loadDecks = async () => { J.decks = decks.slice(); };
  J._renderDecks = () => {};
  return { J, rec, labels, State };
}

async function suiteFlow(label, P, pSrc) {
  console.log("\n[" + label + "]");
  const srcBytes = await makeSrcPdf(0, { mb: [0, 0, 600, 400] });

  // 4-A 원본 있음 → 벡터 복사본 배포본을 가리키는 영역(crop 없음) + 핀 N 알림 + 기존 핀 불변
  {
    const pins = [
      { id: "a", page: 1, x: 15, y: 30 }, { id: "b", page: 1, x: 39, y: 44 },   // 영역 안 2개
      { id: "c", page: 1, x: 80, y: 80 },                                         // 영역 밖
      { id: "d", page: 2, x: 15, y: 30 },                                         // 다른 페이지
    ];
    const before = JSON.stringify(pins);
    const c = makeClient(P, { source: { bytes: srcBytes, expect: { count: 1, pw: 600, ph: 400 } }, pins });
    const d = await c.J.extractRegionAsDeck({ crop: CROP, name: "평면도" });
    const b = c.rec.decksPost[0] || {};
    ok(!!d && b.deployment_id === "dep_copy_1" && b.crop === null && b.page === 1,
      `A 영역 deck → 새 배포본(${b.deployment_id}) · crop=${JSON.stringify(b.crop)} · page=${b.page}`);
    ok(b.parent_id === "dck_root", "A parent_id = 원본 구역(트리 3단 유지)");
    const cp = c.rec.copies[0];
    let sz = null;
    if (cp) { const nd = await openPdf(cp.bytes); const vp = (await nd.getPage(1)).getViewport({ scale: 1 }); sz = [vp.width, vp.height]; await nd.destroy(); }
    ok(!!sz && near(sz[0], 180, 0.1) && near(sz[1], 100, 0.1), `A 새 배포본에 넘긴 PDF = 영역 크기 180×100pt (${sz && sz.map((v) => v.toFixed(2))})`);
    ok(c.rec.toasts.some((t) => /핀 2개는 원본에 그대로/.test(t)), "A 토스트: 영역 안 핀 2개(밖·다른 페이지 제외) 원본 잔류 안내");
    ok(JSON.stringify(c.State.pins) === before, "A 🔴 기존 핀 불변(State.pins 전·후 동일)");
    ok(c.rec.otherFetch.length === 0 && c.rec.attaches.length === 0, "A 원본 배포본에 쓰기 0(PATCH·원본 등록 없음)");
    ok(c.rec.confirms.length === 0, "A 원본 있으면 묻지 않는다");
  }
  // 4-A0 핀이 영역 밖에만 있으면 알림 생략
  {
    const c = makeClient(P, { source: { bytes: srcBytes, expect: null }, pins: [{ page: 1, x: 90, y: 90 }] });
    await c.J.extractRegionAsDeck({ crop: CROP, name: "측면도" });
    ok(!c.rec.toasts.some((t) => /핀 \d+개/.test(t)), "A0 영역 안 핀 0 → 핀 문구 생략");
  }
  // 4-B1 원본 없음 → 묻는다 → [지금은 기존 방식으로] → [창 방식으로 만들기] → 창 deck(선명도 한계 고지), 복사본 0
  {
    const c = makeClient(P, { source: { missing: true, snapCount: 1 }, confirms: [false, true] });
    const d = await c.J.extractRegionAsDeck({ crop: CROP, name: "단면" });
    const b = c.rec.decksPost[0] || {};
    ok(c.rec.confirms[0] && /원본 PDF 가 없는/.test(c.rec.confirms[0].t) && /확대하면 깨집니다/.test(c.rec.confirms[0].m),
      "B1 원본 없음 → 먼저 사실을 알리고 묻는다(" + (c.rec.confirms[0] && c.rec.confirms[0].t) + ")");
    ok(c.rec.confirms[0] && c.rec.confirms[0].ok === "원본 PDF 올리기" && c.rec.confirms[0].no === "지금은 기존 방식으로",
      "B1 버튼 문구 = [원본 PDF 올리기] / [지금은 기존 방식으로]");
    ok(c.rec.copies.length === 0, "B1 🔴 원본 없이 복사본(이미지) 생성 0");
    ok(!!d && b.deployment_id === SRC_DEP && b.crop && b.crop.w === CROP.w, "B1 창 방식 deck(원본 배포본 + crop)");
    ok(c.rec.toasts.some((t) => /선명도에 한계/.test(t)), "B1 선명도 한계를 그대로 알림");
    ok(c.labels.ok.textContent === "확인" && c.labels.cancel.textContent === "취소", "B1 확인창 버튼 문구 원복(다른 확인창 오염 0)");
  }
  // 4-B2 원본 없음 → 기존 방식 → 취소 → 아무것도 안 만든다
  {
    const c = makeClient(P, { source: { missing: true, snapCount: 1 }, confirms: [false, false] });
    const d = await c.J.extractRegionAsDeck({ crop: CROP, name: "x" });
    ok(d === null && c.rec.decksPost.length === 0 && c.rec.copies.length === 0, "B2 취소 → deck·복사본 0");
  }
  // 4-B3 원본 없음 → [원본 PDF 올리기] → 파일 → 원본 등록(원본 배포본) → 벡터 복사
  {
    const file = { arrayBuffer: async () => srcBytes };
    const c = makeClient(P, { source: { missing: true, snapCount: 1 }, confirms: [true], file });
    const d = await c.J.extractRegionAsDeck({ crop: CROP, name: "올린원본" });
    const b = c.rec.decksPost[0] || {};
    ok(c.rec.attaches.length === 1 && c.rec.attaches[0].depId === SRC_DEP, "B3 올린 PDF 를 **현재 배포본**의 원본으로 등록");
    ok(c.rec.copies.length === 1 && !!d && b.deployment_id === "dep_copy_1" && b.crop === null, "B3 곧바로 벡터 복사본 영역 생성");
  }
  // 4-B4 다른 파일(크기 다름) → 경고 → 취소 → 등록·복사 0
  {
    const d2 = await PDFLib.PDFDocument.create(); d2.addPage([842, 595]);
    const other = await d2.save();
    const c = makeClient(P, { source: { missing: true, snapCount: 1 }, confirms: [true, false], file: { arrayBuffer: async () => other } });
    const d = await c.J.extractRegionAsDeck({ crop: CROP, name: "다른파일" });
    ok(c.rec.confirms[1] && /다른 파일/.test(c.rec.confirms[1].t) && /크기/.test(c.rec.confirms[1].m), "B4 크기 다른 PDF → 경고(" + (c.rec.confirms[1] && c.rec.confirms[1].m.split("\n")[0]) + ")");
    ok(d === null && c.rec.attaches.length === 0 && c.rec.copies.length === 0, "B4 취소 → 원본 등록·복사 0");
  }
  // 4-C 원본 확인 실패(네트워크) → 조용히 창으로 가지 않고 묻는다
  {
    const c = makeClient(P, { source: { error: "원본 PDF 를 내려받지 못했습니다" }, confirms: [false] });
    const d = await c.J.extractRegionAsDeck({ crop: CROP, name: "y" });
    ok(d === null && c.rec.confirms.length === 1 && /창/.test(c.rec.confirms[0].t), "C 원본 실패 → 창 방식 여부를 묻고, 거절 시 생성 0");
  }
  // 4-D 복사본 저장 실패 → 영역 deck 을 만들지 않는다(원본 창으로 조용히 대체 금지)
  {
    const c = makeClient(P, { source: { bytes: srcBytes, expect: null }, app: { _createRegionCopyDeployment: async () => null } });
    const d = await c.J.extractRegionAsDeck({ crop: CROP, name: "z" });
    ok(d === null && c.rec.decksPost.length === 0 && c.rec.toasts.some((t) => /새 페이지 저장 실패/.test(t)), "D 복사본 저장 실패 → deck 0 + 실패 안내");
  }
}

/* ═════ 5. App 경계 — 원본 등록은 source_meta 한 칸만 / 복사본 배포본은 핀 0 · 원본 없으면 생성 0 ═════ */
function loadApp(src = appSrc, { live = false } = {}) {
  const calls = [];
  const State = { mode: "designer", pins: [{ id: "p1", x: 1, y: 1 }], zones: [], annotations: [], autoSaveDepId: live ? SRC_DEP : null, depVersion: 3 };
  const el = { classList: { contains: () => false }, naturalWidth: 0 };
  const sb = {
    console, Math, JSON, Promise, setTimeout, clearTimeout, Blob, Uint8Array, ArrayBuffer, Object, Array, String, Number,
    State, UI: { $: () => el }, Auth: { headers: () => ({}) }, Prompt: { toast() {} },
    PDF: { load: async () => ({ destroy() {} }), snapshotAllPages: async () => { sb.PDF.lastSnapshotDims = [{ w: 900, h: 500, pw: 180, ph: 100 }]; return ["data:image/png;base64,AA"]; }, lastSnapshotDims: "PREV" },
    document: { getElementById: () => null },
    navigator: { onLine: true }, location: { origin: "x" }, performance: { now: () => 0 },
    fetch: async (url, o) => {
      o = o || {}; calls.push({ url, method: o.method || "GET", body: o.body });
      if (url === "/api/r2/upload") return { ok: sb.__uploadOk !== false, json: async () => ({ url: "/api/r2/object/assets/new.pdf" }) };
      if (url === "/tables/deployments" && o.method === "POST") return { ok: true, json: async () => ({ id: "dep_new" }) };
      return { ok: true, status: 200, json: async () => ({ version: 4 }) };
    },
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(src + "\n;globalThis.__A = App;", sb);
  return { A: sb.__A, calls, State, sb };
}

async function suiteApp(label, aSrc) {
  console.log("\n[" + label + "]");
  for (const live of [false, true]) {
    const { A, calls, State } = loadApp(aSrc, { live });
    const pinsBefore = JSON.stringify(State.pins);
    const okv = await A._attachSourcePdf(SRC_DEP, new Uint8Array([1, 2, 3]));
    const patch = calls.find((c) => c.method === "PATCH");
    const keys = patch ? Object.keys(JSON.parse(patch.body)).sort().join(",") : "";
    ok(okv && !!patch && /\/tables\/deployments\/dep_src$/.test(patch.url), `${live ? "live" : "비live"} 원본 등록 → PATCH /tables/deployments/${SRC_DEP}`);
    ok(keys === (live ? "base_version,source_meta" : "source_meta"),
      `${live ? "live" : "비live"} 🔴 PATCH 본문 = {${keys}} — 핀·구역·주석 미전송(서버 부분갱신이 보존)`);
    ok(JSON.stringify(State.pins) === pinsBefore, `${live ? "live" : "비live"} 로컬 핀 불변`);
  }
  {
    const { A, calls, sb } = loadApp(aSrc);
    const id = await A._createRegionCopyDeployment("평면도", new Uint8Array([1]));
    const post = calls.find((c) => c.url === "/tables/deployments" && c.method === "POST");
    const b = post ? JSON.parse(post.body) : {};
    let meta = null; try { meta = JSON.parse(b.source_meta); } catch (e) {}
    ok(id === "dep_new" && b.pins === "[]" && b.zones === "[]" && b.annotations === "[]", "복사본 배포본: 핀·구역·주석 0으로 시작");
    ok(!!meta && meta.pdf_url === "/api/r2/object/assets/new.pdf" && meta.pages[0].pw === 180, "복사본 배포본: source_meta = 새 PDF + 실측 스냅샷");
    ok(sb.PDF.lastSnapshotDims === "PREV", "PDF.lastSnapshotDims 원복(편집 중 도면 저장에 섞이지 않음)");
  }
  {
    const { A, calls, sb } = loadApp(aSrc);
    sb.__uploadOk = false;
    const id = await A._createRegionCopyDeployment("평면도", new Uint8Array([1]));
    ok(id === null && !calls.some((c) => c.url === "/tables/deployments"), "🔴 새 PDF 업로드 실패 → 배포본 생성 0(이미지뿐인 복사본 금지)");
  }
  {
    const { A, State } = loadApp(aSrc, { live: true });
    State.fileType = "pdf"; State.fileData = new ArrayBuffer(8);
    const s = await A._regionSource(SRC_DEP, 1);
    ok(s.bytes === State.fileData && s.expect === null, "편집모드 PDF 가 떠 있으면 로컬 원본 바이트 사용(네트워크 0)");
    State.fileType = "image"; State.sourceMeta = null; State.sourcePdfUrl = null; State.viewerPages = ["a", "b"];
    const m = await A._regionSource(SRC_DEP, 1);
    ok(m.missing === true && m.snapCount === 2, "원본 없는 배포본 → missing(스냅샷 2쪽)");
  }
}

/* ═════ 실행 ═════ */
const P = loadPDF();
await suiteBox("1. crop % → PDF 상자(실제 pdf.js 대조)", P);
await suiteCopy("2. 실제 pdf-lib 복사 → pdf.js 재측정", P);
suiteMismatch(P);
await suiteFlow("4. extractRegionAsDeck 흐름", P);
await suiteApp("5. App 경계(원본 등록·복사본 저장)", appSrc);

/* ═════ 뮤테이션 ═════ */
async function mutate(label, run) {
  const before = failed;
  const logs = [];
  const orig = console.log; console.log = (...a) => logs.push(a.join(" "));
  try { await run(); } catch (e) { failed++; logs.push("  FAIL(throw) " + e.message); }
  console.log = orig;
  const caught = failed > before;
  failed = before;
  ok(caught, label + (caught ? " → 테스트가 실패함(실효성 증명): " + (logs.find((l) => /FAIL/.test(l)) || "").trim().slice(0, 90) : " → 🔴 잡지 못함"));
}
console.log("\n[뮤테이션]");
{
  const needle = "return [x0 + u * W, y1 - v * H];";
  ok(pdfSrc.includes(needle), "M1 대상 존재");
  await mutate("M1 y 뒤집기 제거", async () => { const M = loadPDF(pdfSrc.replace(needle, "return [x0 + u * W, y0 + v * H];")); await suiteBox("M1", M); await suiteCopy("M1", M); });
}
{
  const needle = "if (!bytes) {";
  ok(projSrc.includes(needle), "M2 대상 존재");
  const mSrc = projSrc.replace(needle, "if (false) {");
  await mutate("M2 원본 없음 분기 우회(묻지 않고 진행)", async () => {
    const save = projSrcBox.v; projSrcBox.v = mSrc;
    try { await suiteFlow("M2", P); } finally { projSrcBox.v = save; }
  });
}
{
  const needle = "const build = () => ({ source_meta: meta });";
  ok(appSrc.includes(needle), "M3 대상 존재");
  await mutate("M3 원본 등록 시 기존 핀 덮어쓰기", async () => { await suiteApp("M3", appSrc.replace(needle, "const build = () => ({ source_meta: meta, pins: \"[]\" });")); });
}
{
  const needle = "const n = live ? this._pinsInCrop(State.pins, page, crop) : 0;";
  ok(projSrc.includes(needle), "M3b 대상 존재");
  await mutate("M3b 영역 안 핀을 원본에서 제거(State.pins 변형)", async () => {
    const save = projSrcBox.v;
    projSrcBox.v = projSrc.replace(needle, needle + " State.pins = State.pins.filter((p) => !(p.x < 40 && p.y < 45));");
    try { await suiteFlow("M3b", P); } finally { projSrcBox.v = save; }
  });
}

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
