/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p27-pin-panel.test.mjs)
 *
 * 대상: WORK_ORDER — 핀 클릭 통합 패널(등록정보/번호수정 + 노트 + 사진 미리보기/등록).
 * [마스터 2026-09-17 최신] 레이아웃 정본: 오른쪽 고정 패널, 상(정보)/하(사진) 2분할.
 * 핀 클릭 시 ISO 전환을 켜지 않는다(별도 에이전트가 영역 자동 ISO 를 제거 중 — 여기서 추가 금지).
 *
 * 재사용: 27_PinActionPop.js(기존 핀 액션 팝업을 확장) + 13_Notes.js(노트 렌더/제출 함수 재사용,
 * 같은 /api/notes 데이터소스) + 핀 필드 imageId/imageName/imageUrl(기존 저장 경로 그대로).
 *
 * 실제 모듈 소스(13_Notes.js/27_PinActionPop.js)를 vm 에 그대로 평가해 검사한다(목 구현 아님).
 * DOM 은 jsdom 없이 최소 fake element 레지스트리로 대체(classList/value/addEventListener만 필요).
 *
 * 뮤테이션 3+1건: 사진없음→등록UI 숨김 처리 제거 → ②실패 / URL 검증 우회 → ③실패 /
 * 뷰어 편집차단 제거 → ⑥실패 / 상하 2분할을 단일 영역으로 병합 → 구조테스트 실패.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ══════════════════════ fake DOM (jsdom 없음) ══════════════════════ */
function makeElement(id) {
  const el = {
    id, value: "", textContent: "", innerHTML: "", src: "", readOnly: false,
    style: {}, files: null,
    _classes: new Set(),
    _listeners: {},
    classList: {
      add: (c) => el._classes.add(c),
      remove: (c) => el._classes.delete(c),
      toggle: (c, force) => { if (force) el._classes.add(c); else el._classes.delete(c); },
      contains: (c) => el._classes.has(c),
    },
    addEventListener(type, fn) { (el._listeners[type] = el._listeners[type] || []).push(fn); },
    dispatch(type, evt) { (el._listeners[type] || []).forEach((fn) => fn(evt || {})); },
    querySelector() { return makeElement("__stub__"); },
  };
  return el;
}

function makeSandbox() {
  const registry = new Map();
  const getElementById = (id) => {
    if (!registry.has(id)) registry.set(id, makeElement(id));
    return registry.get(id);
  };
  const document = {
    getElementById,
    addEventListener() {},
    querySelector: () => null,
    createElement: () => makeElement("__anon__"),
  };
  const State = { pins: [], mode: "designer", currentDeploymentId: "dep1", pinEditUnlocked: null };
  const notesFetchImpl = () => Promise.resolve({ ok: true, json: async () => ({ data: [] }) });
  const App = {
    pinHasContent(p) { return !!(p && (p.imageId || p.imageUrl || p.videoUrl || p.note)); },
    pinHasMedia(p) { return !!(p && (p.imageId || p.imageUrl || p.videoUrl || p.pendingOpId || p.localPreview)); },
    openPano(pin) { App._openPanoCalled = pin; },
    editPin() {}, deletePin() {}, focusPin() {},
    setActivePin() {},
    _dirty: false,
    _markDirty() { App._dirty = true; },
    _autoSave() { throw new Error("자동저장 OFF 정책 위반: App._autoSave() 가 호출됨"); },
  };
  const Auth = { isDesigner: true, user: { name: "tester" }, headers: () => ({}) };
  const Prompt = { toast() {}, ask: async () => null };
  const Cloud = {
    _cache: {},
    async resizeImage() { return { dataURL: "data:image/jpeg;base64,AAAA", width: 10, height: 10 }; },
    async uploadImage() { return "img-uploaded-1"; },
    async fetchImage(id) { return Cloud._cache[id] || "data:fetched:" + id; },
  };
  const UI = {
    renderPinsOnMap() {}, renderPinList() {},
    escapeHtml: (s) => String(s == null ? "" : s),
    $: (id) => getElementById(id),
  };
  const Inspector = { showPin() {} };
  const sandbox = {
    console, Math, JSON, Promise, setTimeout, clearTimeout, URL,
    document, State, App, Auth, Prompt, Cloud, UI, Inspector,
    fetch: notesFetchImpl,
    navigator: { onLine: true },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return { sandbox, getElementById, App, State, Auth };
}

function load(paSrc, notesSrc) {
  const { sandbox, getElementById, App, State, Auth } = makeSandbox();
  vm.runInContext(notesSrc + "\n;globalThis.__NOTES = Notes;", sandbox);
  sandbox.Notes = sandbox.__NOTES;
  vm.runInContext(paSrc + "\n;globalThis.__PAP = PinActionPop;", sandbox);
  const PinActionPop = sandbox.__PAP;
  PinActionPop.init();
  return { PinActionPop, getElementById, App, State, Auth };
}

function makePin(overrides) {
  return Object.assign({ id: "p1", page: 1, x: 10, y: 10, label: "" }, overrides);
}

/* ══════════════════════ 실행부 ══════════════════════ */
function run(paSrc, notesSrc, indexHtml) {
  /* [1] 사진 있는 핀 클릭 → 미리보기 표시 */
  console.log("\n[1] 사진 있는 핀 → 미리보기 표시");
  {
    const { PinActionPop, getElementById, State } = load(paSrc, notesSrc);
    const pin = makePin({ imageUrl: "https://x.test/photo.jpg" });
    State.pins = [pin];
    PinActionPop.open(pin.id);
    ok(!getElementById("pap-photo-preview").classList.contains("hidden"), "미리보기 영역 표시됨");
    ok(getElementById("pap-photo-register").classList.contains("hidden"), "등록 UI는 숨겨짐");
  }

  /* [2] 사진 없는 핀 클릭 → 등록 UI 표시(빈칸 아님) */
  console.log("\n[2] 사진 없는 핀 → 등록 UI 표시");
  {
    const { PinActionPop, getElementById, State } = load(paSrc, notesSrc);
    const pin = makePin({});
    State.pins = [pin];
    PinActionPop.open(pin.id);
    ok(getElementById("pap-photo-preview").classList.contains("hidden"), "미리보기 영역 숨김");
    ok(!getElementById("pap-photo-register").classList.contains("hidden"), "등록 UI 표시됨");
    const hasFileInput = /id="pap-photo-file"/.test(indexHtml);
    const hasUrlInput = /id="pap-photo-url"/.test(indexHtml);
    ok(hasFileInput && hasUrlInput, "등록 UI에 파일선택+URL입력 둘 다 마크업 존재(빈칸 아님)");
  }

  /* [3] 경로 입력 빈 값/잘못된 형식 → 거부 + 이유 표시 */
  console.log("\n[3] 경로 검증 — 빈 값/오형식 거부");
  {
    const { PinActionPop, getElementById, State } = load(paSrc, notesSrc);
    const pin = makePin({});
    State.pins = [pin];
    PinActionPop.open(pin.id);

    getElementById("pap-photo-url").value = "";
    PinActionPop._registerPhotoUrl();
    ok(!getElementById("pap-photo-err").classList.contains("hidden"), "빈 값 → 에러 표시");
    ok(/입력하세요/.test(getElementById("pap-photo-err").textContent), "빈 값 이유 텍스트");
    ok(!pin.imageUrl, "빈 값은 저장되지 않음");

    getElementById("pap-photo-url").value = "not-a-url";
    PinActionPop._registerPhotoUrl();
    ok(!getElementById("pap-photo-err").classList.contains("hidden"), "오형식(URL 아님) → 에러 표시");
    ok(!pin.imageUrl, "오형식은 저장되지 않음");

    getElementById("pap-photo-url").value = "https://x.test/file.txt";
    PinActionPop._registerPhotoUrl();
    ok(!getElementById("pap-photo-err").classList.contains("hidden"), "허용 확장자 아님 → 에러 표시");
    ok(!pin.imageUrl, "허용 확장자 아니면 저장되지 않음");

    getElementById("pap-photo-url").value = "https://x.test/pic.jpg";
    PinActionPop._registerPhotoUrl();
    ok(getElementById("pap-photo-err").classList.contains("hidden"), "유효한 URL → 에러 없음");
    ok(pin.imageUrl === "https://x.test/pic.jpg", "유효한 URL은 pin.imageUrl 로 저장됨");
  }

  /* [4] 미리보기 클릭 → 전체화면 경로 호출(App.openPano 재사용) */
  console.log("\n[4] 미리보기 클릭 → 전체화면(App.openPano) 호출");
  {
    const { PinActionPop, getElementById, App, State } = load(paSrc, notesSrc);
    const pin = makePin({ imageUrl: "https://x.test/photo.jpg" });
    State.pins = [pin];
    PinActionPop.open(pin.id);
    getElementById("pap-photo-img").dispatch("click");
    ok(App._openPanoCalled === pin, "App.openPano(pin) 호출됨(전체화면 경로 재사용)");
    ok(getElementById("pin-action-pop").classList.contains("hidden"), "패널은 닫힘");
  }

  /* [5] 번호(위치명) 수정이 저장 경로(pin.label + markDirty)로 전달된다 */
  console.log("\n[5] 번호/위치명 수정 → pin.label 반영 + 미저장 표시");
  {
    const { PinActionPop, getElementById, App, State } = load(paSrc, notesSrc);
    const pin = makePin({ label: "3" });
    State.pins = [pin];
    PinActionPop.open(pin.id);
    getElementById("pap-label-input").value = "7";
    PinActionPop._saveLabel();
    ok(pin.label === "7", "pin.label 갱신됨(체크보드 계열은 이 값이 곧 번호)");
    ok(App._dirty === true, "App._markDirty() 로 미저장 표시만 남음");
  }

  /* [6] 뷰어 모드: 보기 가능 / 편집 UI 없음 */
  console.log("\n[6] 뷰어 모드 — 보기 가능, 편집 UI 없음");
  {
    const { PinActionPop, getElementById, Auth, State } = load(paSrc, notesSrc);
    Auth.isDesigner = false;
    const withPhoto = makePin({ id: "p2", imageUrl: "https://x.test/photo.jpg" });
    const noPhoto = makePin({ id: "p3" });
    State.pins = [withPhoto, noPhoto];

    PinActionPop.open(withPhoto.id);
    ok(!getElementById("pap-photo-preview").classList.contains("hidden"), "뷰어도 사진 미리보기는 봄");
    ok(getElementById("pap-label-input").readOnly === true, "위치명 입력 읽기전용");
    ok(getElementById("pap-label-save").classList.contains("hidden"), "저장 버튼 숨김(편집 불가)");
    ok(getElementById("pap-notes-form-row").classList.contains("hidden"), "노트 작성 폼 숨김(편집 불가)");

    PinActionPop.open(noPhoto.id);
    ok(getElementById("pap-photo-register").classList.contains("hidden"), "뷰어는 사진 등록 UI 자체가 없음");
  }

  /* [7] 등록 후 자동 서버저장 안 함(미저장 표시만) — 파일 등록 경로 */
  console.log("\n[7] 사진 파일 등록 후 자동저장 안 함");
  return (async () => {
    const { PinActionPop, getElementById, App, State } = load(paSrc, notesSrc);
    const pin = makePin({});
    State.pins = [pin];
    PinActionPop.open(pin.id);
    const fakeFile = { name: "a.jpg" };
    await PinActionPop._registerPhotoFile(fakeFile);
    ok(pin.imageId === "img-uploaded-1", "Cloud.uploadImage 저장 경로로 imageId 반영");
    ok(App._dirty === true, "등록 후 미저장 표시(App._markDirty)만 남음 — App._autoSave 미호출(호출 시 throw)");

    /* ── 구조 검사: 패널 = 상(정보)/하(사진) 2분할, ISO 미개입 ── */
    console.log("\n[구조] 상/하 2분할 + ISO 미개입");
    const cardBlock = indexHtml.slice(indexHtml.indexOf('id="pin-action-pop"'), indexHtml.indexOf('id="pin-action-pop"') + 6000);
    const topIdx = cardBlock.indexOf('id="pap-top"');
    const bottomIdx = cardBlock.indexOf('id="pap-bottom"');
    ok(topIdx > -1 && bottomIdx > -1 && topIdx < bottomIdx, "pap-top(정보) → pap-bottom(사진) 순서로 상/하 2분할 구성됨");
    ok(!/isoView|setIso|ISO_ON/.test(paSrc), "27_PinActionPop.js 소스에 ISO 전환 코드 없음(핀 클릭 시 ISO 켜지 않음)");

    return failed;
  })();
}

const paSrc = rd("public/js/modules/27_PinActionPop.js");
const notesSrc = rd("public/js/modules/13_Notes.js");
const indexHtml = rd("public/index.html");

run(paSrc, notesSrc, indexHtml).then((f) => {
  console.log("\n" + (f === 0 ? "ALL PASS" : f + " FAILED"));
  process.exit(f === 0 ? 0 : 1);
});
