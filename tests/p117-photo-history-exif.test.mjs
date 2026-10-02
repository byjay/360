/**
 * p117 — WO 20261002-gap 묶음A: 재방선 사진 이력 + 전/후 비교 + EXIF 촬영시각 + 360 원본 보관
 * (프레임워크 0 · 실행: node tests/p117-photo-history-exif.test.mjs)
 *
 * [재현] 지휘자 확인(발주서 인용) — HEAD a7a7bb0 기준:
 *   R1 pin.timeline 쓰기 0건(14_TimeLapse.js:146 hasMultiple() 항상 false)
 *   R2 capturedAt= 쓰기 0건, shotAt=은 27_PinActionPop.js:425(Date.now())·35_PhotoBatch.js:609(sortKey)
 *      — 필드명 불일치(TimeLapse는 capturedAt을 읽음), 단건 등록은 EXIF 미사용.
 *   R3 35_PhotoBatch.js:617 pin.imageId = imageId — 교체 시 이전 사진 이력 소실.
 *   R4 04_Cloud.js:8,61 _decode/resizeImage 기본 4096px — THETA 원본(11008×5504) 미보관.
 *
 * 🔴 목 금지 — 실제 소스(35_PhotoBatch.js/14_TimeLapse.js/05_SyncQueue.js/27_PinActionPop.js)를
 *   vm에 그대로 평가해 검증한다(p116-pano-shapes 관례와 동일 — DOM/THREE는 최소 스텁).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const pbSrc = rd("public/js/modules/35_PhotoBatch.js");
const tlSrc = rd("public/js/modules/14_TimeLapse.js");
const sqSrc = rd("public/js/modules/05_SyncQueue.js");
const papSrc = rd("public/js/modules/27_PinActionPop.js");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };

/* ── 가짜 DOM(p116 관례 재사용 — 이 파일 안에 자체 포함, getElementById만 필요) ── */
function makeEl(id) {
  const el = {
    id, _classes: new Set(), style: {}, attrs: {}, _html: "",
    classList: {
      add: (...c) => c.forEach((x) => el._classes.add(x)),
      remove: (...c) => c.forEach((x) => el._classes.delete(x)),
      contains: (c) => el._classes.has(c),
      toggle(c, f) { if (f) el._classes.add(c); else el._classes.delete(c); return !!f; }
    },
    setAttribute(k, v) { el.attrs[k] = v; },
    removeAttribute(k) { delete el.attrs[k]; },
    getAttribute(k) { return el.attrs[k]; },
    querySelectorAll() { return []; },
    addEventListener() {},
    set innerHTML(v) { el._html = v; },
    get innerHTML() { return el._html; },
    set href(v) { el._href = v; },
    get href() { return el._href; },
    set textContent(v) { el._text = v; },
    get textContent() { return el._text; }
  };
  return el;
}
function makeDocument(ids) {
  const reg = new Map(ids.map((id) => [id, makeEl(id)]));
  return { getElementById: (id) => reg.get(id) || null, reg };
}

/* ══════════════════════════════════════════════════════════════
 * ① PhotoNaming.pushHistory — 교체 직전 "현재"를 이력에 적립(R1·R3 수정 대상)
 * ══════════════════════════════════════════════════════════════ */
function makePB() {
  const sandbox = { console, Auth: { user: { email: "pak@seastar.test" } } };
  vm.createContext(sandbox);
  vm.runInContext(pbSrc + "\n;globalThis.__PN = PhotoNaming;", sandbox);
  return sandbox.__PN;
}
function testPushHistory() {
  console.log("\n[① PhotoNaming.pushHistory]");
  const PN = makePB();
  // 신규 등록(이전 사진 없음) → 적립할 것이 없으므로 no-op
  const fresh = { id: 1 };
  PN.pushHistory(fresh, "단건등록");
  ok(fresh.timeline === undefined, "신규 핀(이전 사진 없음) → timeline 생성 안 함(지어낸 이력 0)");
  // 기존 사진 있는 핀 → 교체 전 이력 적립
  const pin = { id: 2, imageId: "img-old", shotAt: 1000, shotSrc: "EXIF DateTimeOriginal", origName: "R0001.JPG" };
  PN.pushHistory(pin, "일괄등록");
  ok(Array.isArray(pin.timeline) && pin.timeline.length === 1, "기존 사진 있는 핀 → timeline에 1건 적립");
  ok(pin.timeline[0].imageId === "img-old" && pin.timeline[0].shotAt === 1000 && pin.timeline[0].by === "pak@seastar.test",
    "적립된 이력 = 이전 imageId·shotAt·작성자(Auth.user.email) 보존 — " + JSON.stringify(pin.timeline[0]));
  // 같은 사진으로 재호출(재시도 안전장치) → 중복 적립 안 함
  PN.pushHistory(pin, "재시도");
  ok(pin.timeline.length === 1, "동일 imageId 재호출(재시도) → 중복 적립 0건(dedup)");
}

/* ══════════════════════════════════════════════════════════════
 * ② TimeLapse._normalize — shotAt SoT, capturedAt은 레거시 읽기 폴백(R2 수정 대상)
 * ══════════════════════════════════════════════════════════════ */
function makeTL(extraIds = []) {
  const document = makeDocument(["pano-timeline", "tl-current", "tl-chips", "btn-pano-orig", "btn-tl-revert", "btn-tl-delete", ...extraIds]);
  const toasts = [];
  const sandbox = {
    console, document, Compare: { open() {} }, UI: { escapeHtml: (s) => String(s), renderPinsOnMap() {}, renderPinList() {} },
    App: { _markDirty() {} }, Prompt: { toast: (m) => toasts.push(m), confirm: async () => true },
    Auth: { isAdmin: true, r2: (u) => u }, PanoViewer: { canEditSpots: () => true }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // 실제 PhotoNaming(35_PhotoBatch.js)을 같은 컨텍스트에 함께 평가 — revertCurrent가 쓰는
  // PhotoNaming.pushHistory가 목이 아니라 실제 구현이어야 "이력 적립" 주장이 증명된다.
  vm.runInContext(pbSrc + "\n" + tlSrc + "\n;globalThis.__TL = TimeLapse;", sandbox);
  return { TL: sandbox.__TL, document, toasts };
}
function testNormalizeShotAtPriority() {
  console.log("\n[② TimeLapse._normalize — shotAt 우선, capturedAt 폴백]");
  const { TL } = makeTL();
  // 이력 항목: shotAt만 있음(신규 데이터) → capturedAt으로 정규화돼 날짜 칩에 표시돼야 함
  const pinA = { id: "p1", imageId: "cur", timeline: [{ imageId: "old1", shotAt: 5000 }] };
  const outA = TL._normalize(pinA);
  const hist = outA.find((s) => s.imageId === "old1");
  ok(!!hist && hist.capturedAt === 5000, "이력 항목의 shotAt(신규 SoT)이 capturedAt으로 정규화됨 — " + JSON.stringify(hist));
  // 레거시 데이터: capturedAt만 있음(과거 기록) → 읽기 폴백으로 여전히 표시
  const pinB = { id: "p2", imageId: "cur2", timeline: [{ imageId: "old2", capturedAt: 6000 }] };
  const outB = TL._normalize(pinB);
  const histB = outB.find((s) => s.imageId === "old2");
  ok(!!histB && histB.capturedAt === 6000, "레거시 capturedAt만 있어도 읽기 폴백으로 표시(과거 데이터 유실 0) — " + JSON.stringify(histB));
  // 현재 슬롯(pin.shotAt)도 동일 우선순위
  const pinC = { id: "p3", imageId: "cur3", shotAt: 7000 };
  const outC = TL._normalize(pinC);
  ok(outC[0].capturedAt === 7000 && outC[0].rawIndex === -1, "현재 슬롯도 pin.shotAt 반영 + rawIndex=-1(이력 아님) — " + JSON.stringify(outC[0]));
}

/* ══════════════════════════════════════════════════════════════
 * ③ TimeLapse.revertCurrent/deleteShot — 되돌리기·이력 삭제(묶음A⑤)
 * ══════════════════════════════════════════════════════════════ */
function testRevertAndDelete() {
  console.log("\n[③ 되돌리기·이력 삭제]");
  const { TL } = makeTL();
  const pin = {
    id: "p9", imageId: "cur-img", shotAt: 3000,
    timeline: [{ id: "tl1", imageId: "old-img", shotAt: 1000 }]
  };
  TL.setPin(pin);
  TL._idx = 0; // 과거 시점(old-img) 선택
  const before = TL.currentShot();
  ok(before && before.imageId === "old-img" && before.rawIndex === 0, "선택된 시점 = 이력의 old-img(rawIndex=0)");
  TL.revertCurrent();
  ok(pin.imageId === "old-img", "되돌리기 → pin.imageId가 선택 시점(old-img)으로 교체됨");
  ok(Array.isArray(pin.timeline) && pin.timeline.some((t) => t.imageId === "cur-img"), "되돌리기 → 이전 현재(cur-img)가 이력에 적립됨");
  ok(!pin.timeline.some((t) => t.id === "tl1"), "되돌린 항목(tl1) 자체는 이력에서 제거됨(중복 보존 금지)");

  // 삭제(관리자) — Prompt.confirm 없이도(guard 통과) 동작, 현재 슬롯은 삭제 대상이 아님
  const pin2 = { id: "p10", imageId: "cur2", timeline: [{ id: "h1", imageId: "a" }, { id: "h2", imageId: "b" }] };
  const { TL: TL2 } = makeTL();
  TL2.setPin(pin2);
  TL2._idx = 0; // 이력의 h1(rawIndex 0) 선택
  return TL2.deleteShot().then(() => {
    ok(pin2.timeline.length === 1 && pin2.timeline[0].id === "h2", "삭제 → 선택한 이력(h1) 1건만 제거, 나머지 보존");
  });
}

/* ══════════════════════════════════════════════════════════════
 * ④ SyncQueue._applyOrigUrl — 360 원본 R2 키를 "지금 그 사진이 있는 자리"에 정확히 적립(묶음A④)
 * ══════════════════════════════════════════════════════════════ */
function makeSQ() {
  const sandbox = { console, navigator: { onLine: true } };
  sandbox.window = sandbox; // ("indexedDB" in window) 체크용 — indexedDB 없음 = IDB 미지원 경로
  vm.createContext(sandbox);
  vm.runInContext(sqSrc + "\n;globalThis.__SQ = SyncQueue;", sandbox);
  return { SQ: sandbox.__SQ, sandbox };
}
function testApplyOrigUrlCorrelates() {
  console.log("\n[④ SyncQueue._applyOrigUrl — 정확한 슬롯에 원본 키 적립]");
  const { SQ, sandbox } = makeSQ();
  const pinCur = { id: "pinX", imageId: "img-now" };
  sandbox.State = { pins: [pinCur] }; // vm 컨텍스트 전역에 직접 심어야 함(sandbox != Node globalThis)
  SQ._applyOrigUrl("pinX", "img-now", "/api/r2/object/assets/orig1.jpg");
  ok(pinCur.origKey === "/api/r2/object/assets/orig1.jpg", "현재 필드(imageId 일치) → pin.origKey에 적립");

  // 업로드가 느려 그 사이 사진이 교체되고 이전 사진은 이력으로 넘어간 경우 — 이력 항목에 적립돼야 함
  const pinMoved = { id: "pinY", imageId: "img-new", timeline: [{ id: "h1", imageId: "img-was-current" }] };
  sandbox.State.pins = [pinMoved];
  SQ._applyOrigUrl("pinY", "img-was-current", "/api/r2/object/assets/orig2.jpg");
  ok(pinMoved.origKey == null && pinMoved.timeline[0].origKey === "/api/r2/object/assets/orig2.jpg",
    "현재는 이미 다른 사진(img-new)로 교체됨 → 원본 키가 '현재'가 아니라 이력 항목(img-was-current)에 정확히 적립됨 — " + JSON.stringify(pinMoved));
}

/* ══════════════════════════════════════════════════════════════
 * ⑤ SyncQueue.keepOriginal — 온라인 성공 경로 + 실패 시 조용한 성공 보고 금지(토스트)
 * ══════════════════════════════════════════════════════════════ */
async function testKeepOriginalOnlineSuccess() {
  console.log("\n[⑤ keepOriginal — 온라인 성공 경로]");
  const file = { name: "R0001_20261002120000.JPG", type: "image/jpeg", arrayBuffer: async () => new ArrayBuffer(16) };
  {
    const { SQ, sandbox } = makeSQ();
    const pin = { id: "pinZ", imageId: "view-copy-id" };
    sandbox.State = { pins: [pin] };
    sandbox.App = { _uploadToR2: async () => "/api/r2/object/assets/full.jpg", _markDirty() {}, _saveDraftLocal: null };
    await SQ.keepOriginal(pin, file, "view-copy-id");
    ok(pin.origKey === "/api/r2/object/assets/full.jpg", "온라인 업로드 성공 → pin.origKey 즉시 반영");
  }

  console.log("\n[⑤ keepOriginal — 업로드 실패(IndexedDB 없음) → 조용한 성공 보고 금지]");
  {
    const { SQ, sandbox } = makeSQ();
    const toasts = [];
    sandbox.Prompt = { toast: (m) => toasts.push(m) };
    sandbox.App = { _uploadToR2: async () => null }; // 업로드 실패
    const pin = { id: "pinW", imageId: "vc2" };
    await SQ.keepOriginal(pin, file, "vc2"); // sandbox에 indexedDB 없음 → _saveOrig도 실패
    ok(pin.origKey === undefined, "업로드 실패 → origKey를 거짓으로 채우지 않음(가짜 성공 금지)");
    ok(toasts.some((t) => /원본 보관 실패/.test(t)), "실패 사실을 토스트로 알림(조용한 실패 금지) — " + JSON.stringify(toasts));
  }
}

/* ══════════════════════════════════════════════════════════════
 * ⑥ 소스 배선 확인 — 단건(27)·일괄(35) 업로드 경로가 공유 헬퍼를 실제로 호출하는가
 * ══════════════════════════════════════════════════════════════ */
function testWiring() {
  console.log("\n[⑥ 소스 배선 — 공유 헬퍼 호출 확인]");
  ok(/PhotoNaming\.pushHistory\(pin, "단건등록"\)/.test(papSrc), "27_PinActionPop._registerPhotoFile → PhotoNaming.pushHistory 호출(R3 수정)");
  ok(/PhotoBatch\._sortRows\(\[\{ file, name: file\.name, lastModified: file\.lastModified, exif \}\]\)/.test(papSrc),
    "27_PinActionPop._registerPhotoFile → PhotoBatch._sortRows 재사용(EXIF 우선순위, R2 수정)");
  ok(/SyncQueue\.keepOriginal\(pin, file, imageId\)/.test(papSrc), "27_PinActionPop._registerPhotoFile → SyncQueue.keepOriginal 호출(360 원본 보관, R4 수정)");
  ok(/PhotoNaming\.pushHistory\(pin, source \|\| "일괄등록"\)/.test(pbSrc), "35_PhotoBatch._uploadOneRow → PhotoNaming.pushHistory 호출(배치/자동연결 공유)");
  ok(/SyncQueue\.keepOriginal\(pin, row\.file, uploaded \? newImageId : null\)/.test(pbSrc), "35_PhotoBatch._uploadOneRow → SyncQueue.keepOriginal 호출(배치/자동연결 공유)");
}

/* ── 실행 ───────────────────────────────────────────────────────── */
testPushHistory();
testNormalizeShotAtPriority();
await testRevertAndDelete();
testApplyOrigUrlCorrelates();
await testKeepOriginalOnlineSuccess();
testWiring();

/* ══════════════════════════════════════════════════════════════
 * 뮤테이션 증명 — 핵심 분기를 되돌리면 반드시 실패해야 한다
 * ══════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션] pushHistory의 hasCurrent 가드를 제거하면 ①이 실패해야 함(신규 핀에도 가짜 이력 생김)");
{
  const needle = `      const hasCurrent = pin.imageId || pin.imageUrl || pin.pendingOpId;\n      if (!hasCurrent) return;`;
  const replacement = `      const hasCurrent = true;`;
  const mutated = pbSrc.replace(needle, replacement);
  if (mutated === pbSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함"); failed++; }
  else {
    const sandbox = { console, Auth: { user: { email: "x@x" } } };
    vm.createContext(sandbox);
    vm.runInContext(mutated + "\n;globalThis.__PNm = PhotoNaming;", sandbox);
    const fresh = { id: 1 };
    sandbox.__PNm.pushHistory(fresh, "단건등록");
    ok(Array.isArray(fresh.timeline) && fresh.timeline.length === 1, "뮤테이션 적용 시 신규 핀에도 가짜 이력 1건이 생겨버림(테스트 실효성 증명)");
  }
}

console.log("\n[뮤테이션] _normalize가 shotAt을 무시하고 capturedAt만 읽으면 ②가 실패해야 함(R2 재발)");
{
  const needle = `capturedAt: (Number.isFinite(t.shotAt) ? t.shotAt : null) || t.capturedAt || null,`;
  const replacement = `capturedAt: t.capturedAt || null,`;
  const mutated = tlSrc.replace(needle, replacement);
  if (mutated === tlSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함"); failed++; }
  else {
    const document = makeDocument(["pano-timeline", "tl-current", "tl-chips", "btn-pano-orig", "btn-tl-revert", "btn-tl-delete"]);
    const sandbox = { console, document, Compare: { open() {} }, UI: { escapeHtml: (s) => String(s) } };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(mutated + "\n;globalThis.__TLm = TimeLapse;", sandbox);
    const pin = { id: "p1", imageId: "cur", timeline: [{ imageId: "old1", shotAt: 5000 }] };
    const out = sandbox.__TLm._normalize(pin);
    const hist = out.find((s) => s.imageId === "old1");
    ok(hist && hist.capturedAt == null, "뮤테이션 적용 시 shotAt이 무시돼 날짜 칩이 다시 빈값이 됨(R2 재발 — 테스트 실효성 증명)");
  }
}

console.log("\n[뮤테이션] _applyOrigUrl이 항상 '현재'에만 적립하면 ④가 실패해야 함(원본 키 오적립)");
{
  const needle = `        if (imageId && pin.imageId === imageId) { pin.origKey = url; }
        else if (Array.isArray(pin.timeline) && imageId) {
          const t = pin.timeline.find((x) => x && x.imageId === imageId);
          if (t) t.origKey = url; else { pin.origKey = pin.origKey || url; }
        } else { pin.origKey = pin.origKey || url; }`;
  const replacement = `        pin.origKey = url;`;
  const mutated = sqSrc.replace(needle, replacement);
  if (mutated === sqSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함"); failed++; }
  else {
    const sandbox = { console, navigator: { onLine: true } };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(mutated + "\n;globalThis.__SQm = SyncQueue;", sandbox);
    const pinMoved = { id: "pinY", imageId: "img-new", timeline: [{ id: "h1", imageId: "img-was-current" }] };
    sandbox.State = { pins: [pinMoved] };
    sandbox.__SQm._applyOrigUrl("pinY", "img-was-current", "/orig2.jpg");
    ok(pinMoved.origKey === "/orig2.jpg" && pinMoved.timeline[0].origKey == null,
      "뮤테이션 적용 시 원본 키가 이미 교체된 '현재'에 잘못 적립됨(이력 항목은 영영 못 받음 — 테스트 실효성 증명)");
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
