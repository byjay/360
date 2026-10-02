/**
 * p116 — WO 20261001-panoshapes: 360 사진 안 도형(사각형·원) + 리더선 + 라벨 + 첨부
 * (프레임워크 0 · 실행: node tests/p116-pano-shapes.test.mjs)
 *
 * [재현] 신규 기능 — 작업 전 `git grep -n "pano-shape\|rectCorners\|circlePoints" HEAD^ -- public/js/modules`
 *   0건(도형·리더선·첨부 없음, 발주서 §[재현] 인용대로).
 *
 * 🔴 목 금지 — 실제 소스(06_PanoViewer.js, 30_Prompt.js, 01b_PinSeries.js)를 vm에 그대로 평가해 검증한다.
 *   20_App.js(God object, 5500+줄)는 p3/p103 과 동일 관례로 "배선 지점"만 정규식으로 소스 대조하거나
 *   단일 함수 본문을 추출해 AsyncFunction으로 직접 실행한다(가짜 구현 아님 — 실제 함수 본문 그대로).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const pvSrc = rd("public/js/modules/06_PanoViewer.js");
const appSrc = rd("public/js/modules/20_App.js");
const promptSrc = rd("public/js/modules/30_Prompt.js");
const seriesSrc = rd("public/js/modules/01b_PinSeries.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ══ 가짜 DOM (p103-leader-align.test.mjs 와 동일 관례 — 이 파일 안에 자체 포함) ══ */
function makeEl(tag) {
  const el = {
    tagName: tag, _classes: new Set(), style: {}, dataset: {}, children: [], attrs: {},
    parentNode: null, offsetWidth: 1000, offsetHeight: 800,
    classList: {
      add: (...c) => c.forEach((x) => el._classes.add(x)),
      remove: (...c) => c.forEach((x) => el._classes.delete(x)),
      contains: (c) => el._classes.has(c),
      toggle(c, f) {
        if (f === undefined) { if (el._classes.has(c)) { el._classes.delete(c); return false; } el._classes.add(c); return true; }
        if (f) el._classes.add(c); else el._classes.delete(c);
        return !!f;
      }
    },
    _listeners: {},
    addEventListener(t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { const a = el._listeners[t]; if (!a) return; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    dispatch(t, ev) { (el._listeners[t] || []).slice().forEach((fn) => fn(ev || {})); },
    appendChild(c) { el.children.push(c); c.parentNode = el; return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
    remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    setAttribute(k, v) { el.attrs[k] = v; },
    getAttribute(k) { return el.attrs[k]; },
    querySelector(sel) {
      if (sel === ".pano-shape-draft") return el.children.find((c) => c._classes && c._classes.has("pano-shape-draft")) || null;
      return null;
    },
    querySelectorAll() { return []; },
    click() { el.dispatch("click", { stopPropagation() {}, preventDefault() {} }); },
    getBoundingClientRect() { return { left: 0, top: 0, width: el.offsetWidth, height: el.offsetHeight }; },
    getContext() { return { beginPath(){}, arc(){}, fill(){}, stroke(){}, strokeText(){}, fillText(){}, set fillStyle(v){}, set strokeStyle(v){}, set globalAlpha(v){}, set lineWidth(v){}, set lineJoin(v){}, set font(v){}, set textAlign(v){}, set textBaseline(v){} }; },
    get className() { return Array.from(el._classes).join(" "); },
    set className(v) { el._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    set innerHTML(v) { el._html = v; },
    get innerHTML() { return el._html || ""; }
  };
  return el;
}
function makeRegistry() {
  const reg = new Map();
  const _listeners = {};
  const document = {
    getElementById: (id) => reg.get(id) || null,
    createElement: (tag) => makeEl(tag),
    createElementNS: (ns, tag) => makeEl(tag),
    body: { appendChild() {} },
    querySelectorAll: () => [],
    addEventListener(t, fn) { (_listeners[t] = _listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { const a = _listeners[t]; if (!a) return; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    dispatch(t, ev) { (_listeners[t] || []).slice().forEach((fn) => fn(ev || {})); }
  };
  return { document, reg };
}
/** 최소 THREE 목 — Sprite 생성 체인만 흉내(기하 계산은 Shapes 순수함수가 담당, 검증 대상 아님) */
function makeThreeMock() {
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone() { return new Vector3(this.x, this.y, this.z); }
    normalize() { return this; }
  }
  class Vector2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } }
  class Group { constructor() { this.children = []; } add(o) { this.children.push(o); } }
  class SpriteMaterial { constructor(o) { Object.assign(this, o); } dispose() {} }
  class Sprite { constructor(mat) { this.material = mat; this.position = new Vector3(); this.scale = new Vector3(); this.userData = {}; } }
  class CanvasTexture { constructor() {} dispose() {} }
  class Raycaster { setFromCamera() { this.ray = { direction: new Vector3(0, 0, 1) }; } intersectObjects() { return []; } }
  return { MathUtils: { degToRad: (d) => (d * Math.PI) / 180, radToDeg: (r) => (r * 180) / Math.PI }, Vector3, Vector2, Group, SpriteMaterial, Sprite, CanvasTexture, Raycaster };
}

/** 06_PanoViewer.js 를 새 vm 컨텍스트에 평가. */
function makePV({ role = "designer", savedSpots } = {}) {
  const THREE = makeThreeMock();
  const { document } = makeRegistry();
  const svg = makeEl("svg"); svg.id = "pano-shape-svg";
  const labels = makeEl("div"); labels.id = "pano-shape-labels";
  const reg = new Map([["pano-shape-svg", svg], ["pano-shape-labels", labels]]);
  document.getElementById = (id) => reg.get(id) || null;
  const State = { mode: role === "designer" ? "designer" : "viewer" };
  const Auth = { isDesigner: role === "designer" };
  const toasts = [];
  const Prompt = { toast: (m) => toasts.push(m) };
  const Radar = { spin() {} };
  const saveCalls = [];
  const App = { _saveSpots: (pin) => saveCalls.push(pin), _openShape() {}, _pickAttachment() {}, _openAttachment() {} };
  const sandbox = { console, THREE, State, Auth, Prompt, Radar, App, document, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(pvSrc + "\n;globalThis.__PV = PanoViewer;", sandbox);
  const PV = sandbox.__PV;
  PV.canvas = { clientWidth: 800, clientHeight: 600, width: 800, height: 600, style: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) };
  PV.camera = {}; PV.renderer = {};
  return { PV, toasts, saveCalls, svg, labels, document };
}

/* ══════════════════════════════════════════════════════════════
 * ① 구면 좌표 저장 — 시점 회전 후 투영 위치 일관(수치)
 * ══════════════════════════════════════════════════════════════ */
function testProjectionConsistency() {
  console.log("\n[① 구면 좌표 — 시점 회전 후 투영 위치 일관]");
  const { PV } = makePV();
  const Sh = PV.Shapes;
  // 카메라가 정확히 그 점을 바라보면(lon,lat == S.lon,S.lat) 항상 화면 정중앙(ndc 0,0) — 회전해도 불변
  [0, 30, 90, 200].forEach((camLon) => {
    const S = { lon: camLon, lat: 0, fov: 75 };
    const d = PV._lonLatToDir(camLon, 0);
    const p = Sh.project(d, S, 800, 600);
    ok(!!p && Math.abs(p.ndcX) < 1e-9 && Math.abs(p.ndcY) < 1e-9,
      `camLon=${camLon} — 카메라가 바라보는 방향의 점은 항상 화면 중앙(ndc≈0,0), 실측 ndc=(${p && p.ndcX},${p && p.ndcY})`);
  });
  // 카메라를 돌려도(S.lon 변화) "카메라 기준 상대 오프셋"이 같으면 같은 화면 위치가 나온다(회전 불변성)
  const off = 15;
  const S1 = { lon: 10, lat: 0, fov: 75 };
  const S2 = { lon: 70, lat: 0, fov: 75 };
  const p1 = Sh.project(PV._lonLatToDir(10 + off, 0), S1, 800, 600);
  const p2 = Sh.project(PV._lonLatToDir(70 + off, 0), S2, 800, 600);
  ok(Math.abs(p1.x - p2.x) < 1e-9 && Math.abs(p1.y - p2.y) < 1e-9,
    `카메라+점을 같은 각도만큼 함께 돌리면 화면 픽셀 위치 불변 — p1=(${p1.x.toFixed(2)},${p1.y.toFixed(2)}) p2=(${p2.x.toFixed(2)},${p2.y.toFixed(2)})`);
}

/* ══════════════════════════════════════════════════════════════
 * ② 화면 뒤쪽 숨김
 * ══════════════════════════════════════════════════════════════ */
function testBehindCameraHidden() {
  console.log("\n[② 화면 뒤쪽 숨김]");
  const { PV } = makePV();
  const Sh = PV.Shapes;
  const S = { lon: 0, lat: 0, fov: 75 };
  const behind = PV._lonLatToDir(180, 0); // 카메라 정반대 방향
  ok(Sh.project(behind, S, 800, 600) === null, "카메라 정반대 방향 점 → project()가 null(숨김)");
  const front = PV._lonLatToDir(0, 0);
  ok(Sh.project(front, S, 800, 600) !== null, "정면 점은 null이 아님(대조)");
}

/* ══════════════════════════════════════════════════════════════
 * ③ 사각형·원 생성과 이름 필수
 * ══════════════════════════════════════════════════════════════ */
function testNameRequired() {
  console.log("\n[③ 도형 생성 — 이름 필수]");
  const { PV } = makePV();
  const Sh = PV.Shapes;
  ok(Sh.validate({ label: "" }) === false, "빈 이름 → validate=false");
  ok(Sh.validate({ label: "   " }) === false, "공백만 이름 → validate=false");
  ok(Sh.validate({ label: "FW PUMP NO.1" }) === true, "실제 이름 → validate=true");
  // App.js _finishShapeDraft 가 실제로 validate를 호출해 막는지 소스 배선 확인(p3 관례)
  const m = appSrc.match(/async _finishShapeDraft\(draft\) \{([\s\S]*?)\n    \},/);
  ok(!!m, "App._finishShapeDraft 함수가 존재함");
  ok(!!m && /Shapes\.validate\(\{ label \}\)/.test(m[1]), "_finishShapeDraft가 Shapes.validate({label})로 이름 필수를 검사함");
  ok(!!m && /if \(!PanoViewer\.Shapes\.validate/.test(m[1]) && /return;/.test(m[1]), "검증 실패 시 return(저장하지 않음)");
}

/* ══════════════════════════════════════════════════════════════
 * ④ 라벨 드래그 저장
 * ══════════════════════════════════════════════════════════════ */
function testLabelDragSaves() {
  console.log("\n[④ 라벨 드래그 저장]");
  const { PV, saveCalls, document } = makePV({ role: "designer" });
  const s = { id: "sh1", type: "rect", lon1: 0, lat1: 0, lon2: 10, lat2: 10, label: "X" };
  const label = makeEl("div");
  PV._currentPin = { id: "pin1" };
  PV.screenToLonLat = (x, y) => ({ lon: x / 10, lat: y / 10 }); // 결정적 스텁(화면→구면 변환 자체는 기존 함수가 검증 대상)
  PV.Shapes._wireLabelDrag(PV, s, label);
  ok(label._classes.has("draggable"), "디자이너 — 라벨에 draggable 클래스 부여");
  label.dispatch("pointerdown", { stopPropagation() {}, clientX: 1, clientY: 1 });
  document.dispatch("pointermove", { clientX: 55, clientY: 77, cancelable: false });
  ok(s.labelPos && s.labelPos.lon === 5.5 && s.labelPos.lat === 7.7, `드래그 중 labelPos 갱신 — ${JSON.stringify(s.labelPos)}`);
  document.dispatch("pointerup", {});
  ok(saveCalls.length === 1 && saveCalls[0].id === "pin1", "드래그 종료 → App._saveSpots(pin) 1회 호출(저장 확정)");
}

/* ══════════════════════════════════════════════════════════════
 * ⑤ 첨부 업로드(R2 스텁) + Auth.r2 토큰
 * ══════════════════════════════════════════════════════════════ */
async function testAttachmentUpload() {
  console.log("\n[⑤ 첨부 업로드 — R2 스텁 + Auth.r2 토큰]");
  const m = appSrc.match(/async _uploadToR2\(ab, contentType\) \{([\s\S]*?)\n    \},/);
  ok(!!m, "App._uploadToR2 함수가 존재함(원본 PDF·첨부 공용 SoT)");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const calls = [];
  globalThis.Auth = { headers: () => ({ Authorization: "Bearer test-token" }) };
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ url: "/api/r2/object/assets/stub.png" }) };
  };
  globalThis.Blob = Blob;
  const ab = new TextEncoder().encode("fake-bytes").buffer;
  const url = await (new AsyncFunction("ab", "contentType", m[1]))(ab, "image/png");
  ok(url === "/api/r2/object/assets/stub.png", "업로드 성공 → 서버가 반환한 url을 그대로 돌려줌");
  ok(calls.length === 1 && calls[0].url === "/api/r2/upload" && calls[0].opts.method === "PUT", "PUT /api/r2/upload 로 1회 호출");
  ok(calls[0].opts.headers.Authorization === "Bearer test-token", "Auth.headers()의 인증 헤더가 업로드 요청에 포함됨");
  // 다운로드 측: _openAttachment가 Auth.r2(url)로 감싸는지 소스 배선 확인
  ok(/_openAttachment\(att\) \{[\s\S]*?Auth\.r2\) \? Auth\.r2\(att\.url\) : att\.url/.test(appSrc),
    "App._openAttachment가 다운로드 시 Auth.r2() 토큰 규칙을 적용함(memory r2-token-security)");
  delete globalThis.Auth; delete globalThis.fetch; delete globalThis.Blob;
}

/* ══════════════════════════════════════════════════════════════
 * ⑥ 목록 탭 시 카메라 회전(도형 → 중심으로 이동)
 * ══════════════════════════════════════════════════════════════ */
function testListRowLooksAtShapeCenter() {
  console.log("\n[⑥ 목록 탭 → 카메라 회전(도형 중심)]");
  const { PV } = makePV();
  const rect = { id: "r1", type: "rect", lon1: 0, lat1: 0, lon2: 20, lat2: 10 };
  const group = { isCurrent: true };
  const a = PV.spotRowAction(group, rect);
  ok(!!a && a.type === "look" && a.lon === 10 && a.lat === 5, `사각형 목록 탭 → 중심(10,5)으로 look, 실측=${JSON.stringify(a)}`);
  const circle = { id: "c1", type: "circle", lon: 40, lat: -8, radiusDeg: 3 };
  const a2 = PV.spotRowAction(group, circle);
  ok(!!a2 && a2.type === "look" && a2.lon === 40 && a2.lat === -8, `원 목록 탭 → 중심(40,-8)으로 look, 실측=${JSON.stringify(a2)}`);
  // 레거시 point 는 종전처럼 spot.lon/lat 그대로
  const point = { id: "p1", lon: 1, lat: 2 };
  const a3 = PV.spotRowAction(group, point);
  ok(!!a3 && a3.type === "look" && a3.lon === 1 && a3.lat === 2, "레거시 point는 기존 그대로 spot.lon/lat 사용(회귀 없음)");
}

/* ══════════════════════════════════════════════════════════════
 * ⑦ 열람자 편집 불가
 * ══════════════════════════════════════════════════════════════ */
function testViewerCannotEdit() {
  console.log("\n[⑦ 열람자 편집 불가]");
  const { PV: viewerPV } = makePV({ role: "viewer" });
  ok(viewerPV.canEditSpots() === false, "뷰어 — canEditSpots()=false");
  viewerPV._shapeDraw = "rect";
  viewerPV.S = { dragging: false, lon: 0, lat: 0, fov: 75 };
  viewerPV.onPointerDown(10, 10);
  ok(viewerPV._shapeDraft == null, "뷰어가 그리기 모드를 강제로 켜도(_shapeDraw) canEditSpots=false면 도형 드래프트가 시작되지 않음");
  ok(viewerPV.S.dragging === true, "대신 종전처럼 카메라 드래그로 처리(회귀 없음)");
  // 라벨 드래그도 뷰어는 아예 안 걸림(draggable 클래스 없음)
  const label = makeEl("div");
  viewerPV.Shapes._wireLabelDrag(viewerPV, { id: "s1" }, label);
  ok(!label._classes.has("draggable"), "뷰어 — 라벨에 draggable 클래스가 붙지 않음(드래그 자체가 안 걸림)");

  const { PV: designerPV } = makePV({ role: "designer" });
  ok(designerPV.canEditSpots() === true, "디자이너 — canEditSpots()=true(대조)");
}

/* ══════════════════════════════════════════════════════════════
 * ⑧ LWW 병합 유지 — 도형이 섞인 pin도 필드 통째로 보존(화이트리스트 없음)
 * ══════════════════════════════════════════════════════════════ */
function testLwwPreservesShapes() {
  console.log("\n[⑧ LWW 병합 — 도형 필드 보존]");
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(seriesSrc + "\n;globalThis.__PS = PinSeries;", sandbox);
  const PinSeries = sandbox.__PS;
  const shape = { id: "sh1", type: "rect", lon1: 1, lat1: 2, lon2: 3, lat2: 4, label: "X", attachments: [{ id: "a1", url: "/u" }] };
  const srv = { id: "pin1", updatedAt: 100, spots: [] };
  const loc = { id: "pin1", updatedAt: 500, spots: [shape] };
  const winner = PinSeries.newer(srv, loc);
  ok(winner === loc, "최신(updatedAt 큰) 로컬본이 승자 — 통째 선택(필드 화이트리스트 없음)");
  ok(JSON.stringify(winner.spots[0]) === JSON.stringify(shape), "도형(type/attachments 등 신규 필드) 전부 보존됨(유실 0)");
  const winner2 = PinSeries.newer({ ...srv, updatedAt: 900 }, loc);
  ok(winner2.spots.length === 0, "서버가 더 최신이면 서버본이 승자(대조 — LWW 정상 동작)");
}

/* ══════════════════════════════════════════════════════════════
 * ⑨ 레거시 spot 표시(유실 0) — 도형과 점이 섞여도 점만 스프라이트로, 도형은 Shapes로
 * ══════════════════════════════════════════════════════════════ */
function testLegacySpotsStillRender() {
  console.log("\n[⑨ 레거시 spot 표시 유지]");
  const { PV } = makePV();
  const group = { children: [], add(o) { this.children.push(o); } };
  PV._spotGroup = group;
  const legacyPoint = { id: "p1", lon: 5, lat: 5, kind: "defect" }; // type 없음 = 레거시
  const shape = { id: "sh1", type: "circle", lon: 20, lat: 0, radiusDeg: 2, label: "Y" };
  PV.renderSpots([legacyPoint, shape]);
  ok(group.children.length === 1, `레거시 point만 Sprite로 렌더(스프라이트 수=${group.children.length})`);
  ok(group.children[0].userData.spotId === "p1", "그 스프라이트는 레거시 point(p1)의 것");
  ok(PV.Shapes._shapes.length === 1 && PV.Shapes._shapes[0].id === "sh1", "도형(sh1)은 스프라이트가 아니라 Shapes 레이어로 분리 렌더");
}

/* ── 실행 ───────────────────────────────────────────────────────── */
testProjectionConsistency();
testBehindCameraHidden();
testNameRequired();
testLabelDragSaves();
await testAttachmentUpload();
testListRowLooksAtShapeCenter();
testViewerCannotEdit();
testLwwPreservesShapes();
testLegacySpotsStillRender();

/* ══════════════════════════════════════════════════════════════
 * 뮤테이션 증명 — 각 항목의 핵심 분기를 되돌리면 반드시 실패해야 한다
 * ══════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션] project()의 z<=0 숨김 분기를 제거하면 ②가 실패해야 함");
{
  const needle = `      const z = d.x * fwd.x + d.y * fwd.y + d.z * fwd.z;\n      if (z <= 1e-6) return null;`;
  const replacement = `      const z = d.x * fwd.x + d.y * fwd.y + d.z * fwd.z;`;
  const mutated = pvSrc.replace(needle, replacement);
  if (mutated === pvSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함"); failed++; }
  else {
    const sandbox = { console, THREE: makeThreeMock() };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(mutated + "\n;globalThis.__PV2 = PanoViewer;", sandbox);
    const PV2 = sandbox.__PV2;
    const behind = PV2._lonLatToDir(180, 0);
    const p = PV2.Shapes.project(behind, { lon: 0, lat: 0, fov: 75 }, 800, 600);
    ok(p !== null, "뮤테이션 적용 시 카메라 뒤 점도 숨겨지지 않게 뒤집힘(테스트 실효성 증명)");
  }
}

console.log("\n[뮤테이션] Shapes.validate가 항상 true면 ③이 실패해야 함");
{
  const needle = `    validate(data) { return !!(data && String(data.label || "").trim()); },`;
  const replacement = `    validate(data) { return true; },`;
  const mutated = pvSrc.replace(needle, replacement);
  if (mutated === pvSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함"); failed++; }
  else {
    const sandbox = { console, THREE: makeThreeMock() };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(mutated + "\n;globalThis.__PV3 = PanoViewer;", sandbox);
    const PV3 = sandbox.__PV3;
    ok(PV3.Shapes.validate({ label: "" }) === true, "뮤테이션 적용 시 빈 이름도 통과하게 뒤집힘(테스트 실효성 증명)");
  }
}

console.log("\n[뮤테이션] canEditSpots가 항상 true면 ⑦이 실패해야 함");
{
  const needle = `    canEditSpots() {
      return typeof State !== "undefined" && State.mode === "designer" &&
        (typeof Auth === "undefined" || Auth.isDesigner);
    },`;
  const replacement = `    canEditSpots() { return true; },`;
  const mutated = pvSrc.replace(needle, replacement);
  if (mutated === pvSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함"); failed++; }
  else {
    const THREE = makeThreeMock();
    const State = { mode: "viewer" }; const Auth = { isDesigner: false };
    const sandbox = { console, THREE, State, Auth, requestAnimationFrame: () => 0 };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(mutated + "\n;globalThis.__PV4 = PanoViewer;", sandbox);
    const PV4 = sandbox.__PV4;
    PV4._shapeDraw = "rect";
    PV4.S = { dragging: false, lon: 0, lat: 0, fov: 75 };
    PV4.screenToLonLat = () => ({ lon: 1, lat: 1 });
    PV4.onPointerDown(10, 10);
    ok(PV4._shapeDraft !== null, "뮤테이션 적용 시 뷰어도 도형 드래프트를 시작하게 뒤집힘(테스트 실효성 증명)");
  }
}

console.log("\n[뮤테이션] PinSeries.newer가 항상 서버본을 반환하면 ⑧이 실패해야 함");
{
  const needle = `    newer(srv, loc) {
      return (Number(loc && loc.updatedAt) || 0) > (Number(srv && srv.updatedAt) || 0) ? loc : srv;
    },`;
  const replacement = `    newer(srv, loc) { return srv; },`;
  const mutated = seriesSrc.replace(needle, replacement);
  if (mutated === seriesSrc) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함"); failed++; }
  else {
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(mutated + "\n;globalThis.__PS2 = PinSeries;", sandbox);
    const srv = { id: "pin1", updatedAt: 100, spots: [] };
    const loc = { id: "pin1", updatedAt: 500, spots: [{ id: "sh1", type: "rect" }] };
    const winner = sandbox.__PS2.newer(srv, loc);
    ok(winner === srv, "뮤테이션 적용 시 로컬의 새 도형 데이터가 항상 버려지게 뒤집힘(테스트 실효성 증명)");
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
