/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p162-multiselect-photo.test.mjs)
 *
 * 대상: WO 20261016-multiselect — public/js/modules/67_PinMultiPhoto.js
 * 마스터 지시: "폴더 전체가 아니라 핀 멀티 선택 후 그림 멀티 선택하면 뒤에 숫자 기준으로
 *   일괄 360 삽입 기능 구현" / "폴더 전체 기능은 그대로 유지".
 *
 * 매칭 순수 로직은 60_PhotoFolder.js(isMatch/rankMatches/_peers/_existingNumbers)를 그대로
 * 재사용한다(§SoT) — 두 모듈 소스를 함께 vm 에 평가해 실제 재사용 여부까지 검증한다(목 아님).
 *
 * 뮤테이션 2건(헤더 발주 요구) — 되돌리면 실패해야 한다:
 *  A. _resolveHeads 의 선택 범위 필터(idSet.has)를 제거 → "미선택 핀은 매칭 제외"가 깨진다.
 *  B. runSelected 의 overwrite 전달을 무시(항상 true)로 바꾸면 → "기존 사진 보호"가 깨진다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const pfSrc = rd("public/js/modules/60_PhotoFolder.js");
const pmpSrc = rd("public/js/modules/67_PinMultiPhoto.js");

let failed = 0;
const ok = (cond, label, detail) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail).slice(0, 300) : "")); if (!cond) failed++; };

/* ── 핀 번호 정본 mock — PhotoFolder._pinNo/_prefixFor/_labelFor 가 PinSeries.numbers()를 쓴다 ── */
function makePinSeries(pins) {
  return {
    numbers(_pins, page) {
      const map = new Map();
      (pins || []).forEach((p) => { if ((p.page || 1) !== page) return; map.set(p.id, { no: p.no, prefix: p.prefix || "" }); });
      return map;
    },
    mediaOf(p) { return !!(p && (p.imageId || p.pendingOpId)); },
    formatNo(no) { return String(no); }
  };
}

function load(pfSrcText, pmpSrcText, opts = {}) {
  const uploadCalls = [];
  const toasts = [];
  const State = Object.assign({ pins: [], pdfPage: 1 }, opts.state || {});
  const Auth = Object.assign({ readonly: false }, opts.auth || {});
  const PinSeries = opts.pinSeries || makePinSeries(State.pins);
  const PinLink = opts.pinLink; // undefined 기본(연결 미도입 시나리오)
  const App = { _detect360: (file, cb) => cb(file.__is360 !== false, 4096, 2048), _updateSyncBadge: () => {} };
  const PhotoBatch = {
    _usedPhotoNames: () => new Set(),
    _uploadOneRow: async (pin, row, overwrite, usedNames, source) => {
      uploadCalls.push({ pinId: pin.id, name: row.name, source, overwrite });
      if (!overwrite && PinSeries.mediaOf(pin)) return { status: "skip" };
      pin.imageId = "img_" + row.name;
      return { status: "done" };
    },
    _markUnsaved: () => {}
  };
  const UI = { renderPinList: () => {}, renderPinsOnMap: () => {} };
  const Prompt = { toast: (msg) => toasts.push(String(msg)) };
  const Projects = { currentProject: { id: "projT" }, currentDeck: null, decks: [] };
  const sandbox = {
    console, Map, Set, Promise, Number, Array, String, JSON,
    document: undefined, window: undefined,
    State, Auth, PinSeries, PinLink, App, PhotoBatch, UI, Prompt, Projects
  };
  vm.createContext(sandbox);
  vm.runInContext(pfSrcText + "\n;globalThis.__PF = PhotoFolder;", sandbox);
  vm.runInContext(pmpSrcText + "\n;globalThis.__PMP = PinMultiPhoto;", sandbox);
  return { PF: sandbox.__PF, PMP: sandbox.__PMP, uploadCalls, toasts, State };
}

const files = (names) => names.map((n) => ({ name: n, lastModified: 1, __is360: true }));

/* ══ ① 핀 3개 선택 + 파일 4개(A001,X002,0003,999) → 3개 일치, 999 는 어느 선택 핀과도 안 맞음 ══ */
{
  const pins = [
    { id: "p1", page: 1, no: 1 },
    { id: "p2", page: 1, no: 2 },
    { id: "p3", page: 1, no: 3 },
    { id: "p4", page: 1, no: 4 } // 미선택 — 매칭 제외 검증용
  ];
  const { PF, PMP } = load(pfSrc, pmpSrc, { state: { pins, pdfPage: 1 } });
  const rows = PMP.buildPreview(pins, 1, ["p1", "p2", "p3"], files(["A001.jpg", "X002.jpg", "0003.jpg", "999.jpg"]));
  ok(rows.length === 3, "① 선택한 핀 3개만 행 생성(p4 제외) = " + rows.length, rows.map((r) => r.pin.id));
  ok(rows.every((r) => r.status === "일치"), "① 3건 모두 '일치'", rows.map((r) => r.status));
  const applicable = PMP.applicableRows(rows);
  ok(applicable.length === 3, "① 등록 대상 3건");
  const unusedFileRow = rows.find((r) => r.candidates.some((c) => c.name === "999.jpg"));
  ok(!unusedFileRow, "① 파일 '999.jpg' 는 선택 핀(1·2·3) 중 누구와도 안 맞아 어느 행에도 후보로 안 들어감");
}

/* ══ ② 미선택 핀은 매칭에서 제외(①의 p4 부재로 이미 증명 — 독립 사례로 재확인) ══ */
{
  const pins = [{ id: "a", page: 1, no: 1 }, { id: "b", page: 1, no: 2 }];
  const { PMP } = load(pfSrc, pmpSrc, { state: { pins, pdfPage: 1 } });
  const rows = PMP.buildPreview(pins, 1, ["a"], files(["001.jpg", "002.jpg"]));
  ok(rows.length === 1 && rows[0].pin.id === "a", "② 선택 1개(a)만 행 생성, b(미선택) 제외");
}

/* ══ ③ 기존 사진 보호 — overwrite=false(기본) 면 이미 사진 있는 핀은 skip, imageId 불변 ══ */
async function run3() {
  const pins = [{ id: "p1", page: 1, no: 1, imageId: "old_img" }];
  const { PMP, uploadCalls } = load(pfSrc, pmpSrc, { state: { pins, pdfPage: 1 } });
  const rows = PMP.buildPreview(pins, 1, ["p1"], files(["001.jpg"]));
  const summary = await PMP.runSelected(rows, false, null);
  ok(summary.skip === 1 && summary.done === 0, "③ overwrite=false → 기존 사진 핀은 skip(건너뜀)", summary);
  ok(pins[0].imageId === "old_img", "③ 기존 imageId 불변(덮어쓰지 않음)");
  ok(uploadCalls[0].overwrite === false, "③ _uploadOneRow 에 overwrite=false 전달 확인");

  // overwrite=true 를 명시하면 덮어씀(옵션 자체는 동작해야 한다)
  const pins2 = [{ id: "p1", page: 1, no: 1, imageId: "old_img" }];
  const { PMP: PMP2 } = load(pfSrc, pmpSrc, { state: { pins: pins2, pdfPage: 1 } });
  const rows2 = PMP2.buildPreview(pins2, 1, ["p1"], files(["001.jpg"]));
  const summary2 = await PMP2.runSelected(rows2, true, null);
  ok(summary2.done === 1, "③b overwrite=true 체크 시 덮어쓰기 등록 진행");
}

/* ══ ④ 다중 후보(확인필요) — 사용자가 chosenIdx 로 고른 후보만 등록 ══ */
async function run4() {
  const pins = [{ id: "p1", page: 1, no: 12, prefix: "" }];
  const { PMP } = load(pfSrc, pmpSrc, { state: { pins, pdfPage: 1 } });
  const rows = PMP.buildPreview(pins, 1, ["p1"], files(["P12_a.jpg", "P12_b.jpg"]));
  // 두 파일 다 끝 숫자가 12가 아니므로(끝이 "a"/"b") 실제로는 매칭 0 — 모호성 재현을 위해 끝자리 숫자 파일로 교체
  const rows2 = PMP.buildPreview(pins, 1, ["p1"], files(["P12.jpg", "P012.jpg"]));
  ok(rows2[0].status === "다중/확인필요" && rows2[0].candidates.length === 2, "④ 같은 번호 매칭 파일 2장 → 다중/확인필요", rows2[0]);
  rows2[0].chosenIdx = 1;
  const applicable = PMP.applicableRows(rows2);
  ok(applicable.length === 1 && applicable[0].candidates[applicable[0].chosenIdx].name === "P012.jpg", "④ chosenIdx 로 고른 후보만 등록 대상");
}

/* ══ ⑤ 연결 핀(PinLink) — 대표(head)에만 등록, 멤버 선택해도 head 로 치환 ══ */
{
  const pins = [
    { id: "head1", page: 1, no: 1, linkId: "head1" },
    { id: "member1", page: 2, no: 1, linkId: "head1" }
  ];
  const PinLink = {
    headOf(allPins, p) { if (!p || !p.linkId) return p; return (allPins || []).find((q) => q.id === p.linkId) || p; },
    dedupe(arr) { const seen = new Set(), out = []; arr.forEach((p) => { if (!seen.has(p.id)) { seen.add(p.id); out.push(p); } }); return out; }
  };
  const { PMP } = load(pfSrc, pmpSrc, { state: { pins, pdfPage: 1 }, pinLink: PinLink });
  const rows = PMP.buildPreview(pins, 1, ["member1"], files(["001.jpg"]));
  ok(rows.length === 1 && rows[0].pin.id === "head1", "⑤ 멤버 선택 → 대표(head1)로 치환해 등록 대상", rows);
}

/* ══ 뮤테이션 A — 선택 범위 필터 제거 → "미선택 핀 제외"가 깨져야 한다 ══ */
{
  const needle = /idSet\.has\(String\(p\.id\)\)/;
  ok(needle.test(pmpSrc), "뮤테이션A 대상 라인 존재 확인");
  const mutated = pmpSrc.replace(needle, "true");
  ok(mutated !== pmpSrc, "뮤테이션A 적용 확인(치환 발생)");
  const pins = [{ id: "a", page: 1, no: 1 }, { id: "b", page: 1, no: 2 }];
  const { PMP } = load(pfSrc, mutated, { state: { pins, pdfPage: 1 } });
  const rows = PMP.buildPreview(pins, 1, ["a"], files(["001.jpg", "002.jpg"]));
  ok(rows.length === 2, `뮤테이션 적용 시 선택 안 한 b 도 포함(행 ${rows.length}개) → ②가 실패할 조건 재현`);
}

async function runMutationB() {
  const needle = /PhotoFolder\._registerEntry\(r\.pin, entry, "멀티선택", !!overwrite\)/;
  ok(needle.test(pmpSrc), "뮤테이션B 대상 라인 존재 확인");
  const mutated = pmpSrc.replace(needle, 'PhotoFolder._registerEntry(r.pin, entry, "멀티선택", true)');
  ok(mutated !== pmpSrc, "뮤테이션B 적용 확인(치환 발생)");
  const pins = [{ id: "p1", page: 1, no: 1, imageId: "old_img" }];
  const { PMP } = load(pfSrc, mutated, { state: { pins, pdfPage: 1 } });
  const rows = PMP.buildPreview(pins, 1, ["p1"], files(["001.jpg"]));
  const summary = await PMP.runSelected(rows, false, null);
  ok(summary.done === 1 && pins[0].imageId !== "old_img", `뮤테이션 적용 시 overwrite=false 라도 덮어씀(기존사진 보호 깨짐 재현, done=${summary.done})`);
}

(async () => {
  await run3();
  await run4();
  await runMutationB();
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
})();
