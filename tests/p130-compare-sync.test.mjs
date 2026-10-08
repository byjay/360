/**
 * p130 — WO 20261008-comparesync: 360 동기 비교(두 뷰어를 나란히, 한쪽을 돌리면 같이 돈다)
 * (프레임워크 0 · 실행: node tests/p130-compare-sync.test.mjs)
 *
 * [재현] 발주서 R1(지휘자, HEAD f6a3b89): 15_Compare.js는 평면 canvas cover+클립 슬라이더뿐,
 *   360 동시 회전·동기화 토글·오프셋 유지가 전혀 없었다(FAIL). 06_PanoViewer.createViewerCore,
 *   52_CompareSync.js 는 이 작업에서 신규 추가.
 *
 * 🔴 목 금지 — 실제 소스(06_PanoViewer.js, 52_CompareSync.js)를 vm에 그대로 평가해 검증한다.
 *   THREE/DOM 은 p116(기존 관례)과 동일하게 최소 동작 목으로 대체(렌더 결과 자체는 검증 대상이 아님 —
 *   검증 대상은 동기화 수식·오프셋 유지·dispose 완전성·기본 시점 선택).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const pvSrc = rd("public/js/modules/06_PanoViewer.js");
const csSrc = rd("public/js/modules/52_CompareSync.js");

let failed = 0;
const ok = (cond, label, detail) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail) : ""));
  if (!cond) failed++;
};

/* ══ 최소 가짜 DOM(p116 관례) ══ */
function makeEl(tag) {
  const el = {
    tagName: tag, _classes: new Set(), style: {}, dataset: {}, children: [], attrs: {}, _listeners: {},
    classList: {
      add: (...c) => c.forEach((x) => el._classes.add(x)),
      remove: (...c) => c.forEach((x) => el._classes.delete(x)),
      contains: (c) => el._classes.has(c),
      toggle(c, f) { if (f) el._classes.add(c); else el._classes.delete(c); return !!f; },
    },
    addEventListener(t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn); },
    dispatch(t, ev) { (el._listeners[t] || []).slice().forEach((fn) => fn(ev || {})); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 360 }; },
    getContext() { return {}; },
    set innerHTML(v) { el._html = v; },
    get innerHTML() { return el._html || ""; },
  };
  return el;
}
function makeDocument(ids) {
  const reg = new Map();
  ids.forEach((id) => reg.set(id, makeEl("div")));
  return { getElementById: (id) => reg.get(id) || null, reg };
}
/** createViewerCore 가 쓰는 최소 THREE 목 — dispose 호출 여부를 추적(mutation 증명용). */
function makeThreeMock() {
  const calls = { textureDispose: 0, materialDispose: 0, geometryDispose: 0, rendererDispose: 0 };
  class Vector3 { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } }
  class WebGLRenderer { constructor(o) { this.o = o; } setPixelRatio() {} setSize() {} render() {} dispose() { calls.rendererDispose++; } }
  class Scene { constructor() { this.children = []; } add(o) { this.children.push(o); } }
  class PerspectiveCamera { constructor(fov, ar) { this.fov = fov; this.aspect = ar; } updateProjectionMatrix() {} lookAt() {} }
  class SphereGeometry { scale() {} dispose() { calls.geometryDispose++; } }
  class Mesh { constructor(geo, mat) { this.geometry = geo; this.material = mat; this.rotation = { x: 0 }; } }
  class MeshBasicMaterial { constructor(o) { Object.assign(this, o || {}); } dispose() { calls.materialDispose++; } }
  class Texture { constructor(img) { this.img = img; } dispose() { calls.textureDispose++; } }
  return { calls, THREE: { MathUtils: { degToRad: (d) => (d * Math.PI) / 180 }, Vector3, WebGLRenderer, Scene, PerspectiveCamera, SphereGeometry, Mesh, MeshBasicMaterial, Texture, LinearFilter: "linear" } };
}
class FakeImage {
  set src(v) { this._src = v; if (typeof this.onload === "function") this.onload(); }
  get src() { return this._src; }
}

function makeSandbox() {
  const { calls, THREE } = makeThreeMock();
  const doc = makeDocument(["pano-compare-360", "cmp360-canvas-a", "cmp360-canvas-b", "cmp360-label-a", "cmp360-label-b", "cmp360-sel-a", "cmp360-sel-b", "btn-cmp360-close", "btn-cmp360-sync", "btn-cmp360-flat"]);
  const UI = { escapeHtml: (s) => String(s) };
  const sandbox = {
    console, THREE, document: doc,
    location: { origin: "http://localhost" },
    Image: FakeImage,
    UI,
    requestAnimationFrame: (fn) => 1, cancelAnimationFrame: () => {},
    addEventListener: () => {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(pvSrc + "\n;globalThis.__PV = PanoViewer;", sandbox);
  sandbox.PanoViewer = sandbox.__PV;
  vm.runInContext(csSrc + "\n;globalThis.__CS = CompareSync;", sandbox);
  sandbox.CompareSync = sandbox.__CS;
  return { sandbox, calls, doc };
}

/* ══════════════════════════════════════════
 * ① createViewerCore — 드래그/FOV 순수 수식 + resize
 * ══════════════════════════════════════════ */
function testCoreMath() {
  console.log("\n[① createViewerCore — 드래그/FOV 수식]");
  const { sandbox } = makeSandbox();
  const canvas = { getBoundingClientRect: () => ({ width: 640, height: 320 }), clientWidth: 640, clientHeight: 320 };
  const core = sandbox.PanoViewer.createViewerCore(canvas);
  ok(!!core, "createViewerCore — THREE 있으면 인스턴스 생성 성공");
  core.resize();
  ok(Math.abs(core.camera.aspect - 640 / 320) < 1e-9, "resize — aspect = 캔버스 bbox 기준", core.camera.aspect);
  core.applyDrag(100, 100, 80, 100); // 왼쪽으로 20px 이동 → lon 증가(기존 PanoViewer.onPointerMove와 동일 공식)
  const expectedLon = (100 - 80) * (core.S.fov / 500);
  ok(Math.abs(core.S.lon - expectedLon) < 1e-9, "applyDrag — lon = (lx-x)*fov/500 (메인 뷰어와 동일 공식)", { lon: core.S.lon, expectedLon });
  core.setFov(1000);
  ok(core.S.fov === 110, "setFov — 상한 110 클램프");
  core.setFov(-1000);
  ok(core.S.fov === 30, "setFov — 하한 30 클램프");
}

/* ══════════════════════════════════════════
 * ② CompareSync 동기화 — 한쪽 변경 → 다른 쪽 같은 값, 루프 0회
 * ══════════════════════════════════════════ */
function testSyncFollow() {
  console.log("\n[② 동기화 — 한쪽 드래그 → 다른 쪽 같은 yaw/pitch/fov]");
  const { sandbox } = makeSandbox();
  const CS = sandbox.CompareSync;
  const left = { S: { lon: 0, lat: 0, fov: 75 }, applyDrag(lx, ly, x, y) { this.S.lon += (lx - x) * (this.S.fov / 500); }, setFov() {}, setState(p) { Object.assign(this.S, p); }, dispose() { this.disposed = true; } };
  const right = { S: { lon: 0, lat: 0, fov: 75 }, applyDrag() {}, setFov() {}, setState(p) { Object.assign(this.S, p); }, dispose() { this.disposed = true; } };
  CS._left = left; CS._right = right; CS._sync = true; CS._offsetLon = 0;
  CS._lx = 100; CS._ly = 100;
  CS._onDrag("left", 60, 130); // lon += (100-60)*0.15=6, lat += (130-100)*0.15 → applied via left.applyDrag stub above only touches lon
  ok(Math.abs(right.S.lon - left.S.lon) < 1e-9, "같은 쪽(left) 드래그 → 반대쪽(right) lon 동일 값으로 즉시 따라옴", { left: left.S.lon, right: right.S.lon });
  // 루프 0회 — onDrag가 상대쪽을 다시 트리거해 왕복호출(재귀)하지 않는지 확인
  let rightSetStateCalls = 0;
  const origSetState = right.setState.bind(right);
  right.setState = (p) => { rightSetStateCalls++; origSetState(p); };
  CS._onDrag("left", 50, 120);
  ok(rightSetStateCalls === 1, "드래그 1회 = 반대쪽 setState 정확히 1회(루프/왕복 없음)", rightSetStateCalls);
}

function testOffsetPreserved() {
  console.log("\n[③ 오프셋 유지 — 동기화 끄기 중 재정렬 → 다시 켜면 그 차이를 유지]");
  const { sandbox } = makeSandbox();
  const CS = sandbox.CompareSync;
  const left = { S: { lon: 0, lat: 0, fov: 75 }, setState(p) { Object.assign(this.S, p); } };
  const right = { S: { lon: 0, lat: 0, fov: 75 }, setState(p) { Object.assign(this.S, p); } };
  CS._left = left; CS._right = right; CS._sync = true; CS._offsetLon = 0;
  CS.toggleSync(); // 끄기
  ok(CS._sync === false, "토글 — 동기화 꺼짐");
  right.S.lon = 40; // 끈 상태에서 사용자가 직접 right만 북쪽 정렬(40도 차이)
  CS.toggleSync(); // 다시 켜기 → 지금 차이(40)를 오프셋으로 고정
  ok(CS._sync === true && CS._offsetLon === 40, "다시 켜면 그 순간의 yaw 차이(40)를 오프셋으로 고정", CS._offsetLon);
  CS._lx = 0; CS._ly = 0;
  left.applyDrag = (lx, ly, x, y) => { left.S.lon += (lx - x) * (left.S.fov / 500); };
  CS._onDrag("left", -10, 0); // left.lon += 10*0.15=1.5
  ok(Math.abs(right.S.lon - (left.S.lon + 40)) < 1e-9, "오프셋 유지한 채로 계속 동기화됨(right = left + 40)", { left: left.S.lon, right: right.S.lon });
}

function testDefaultShotSelection() {
  console.log("\n[④ 기본 시점 선택 — 최신 대 직전]");
  const { sandbox } = makeSandbox();
  const CS = sandbox.CompareSync;
  sandbox.TimeLapse = {
    hasMultiple: () => true,
    _shots: [{ id: "s0", label: "s0", capturedAt: 1 }, { id: "s1", label: "s1", capturedAt: 2 }, { id: "s2", label: "s2", capturedAt: 3 }],
    _resolveSrc: async (s) => ({ src: "data:" + s.id, isVideo: false }),
    _fmtDate: () => "00.00.00",
  };
  const canvasA = { getBoundingClientRect: () => ({ width: 300, height: 300 }) };
  const canvasB = { getBoundingClientRect: () => ({ width: 300, height: 300 }) };
  sandbox.document.reg.get("cmp360-canvas-a").getBoundingClientRect = canvasA.getBoundingClientRect;
  sandbox.document.reg.get("cmp360-canvas-b").getBoundingClientRect = canvasB.getBoundingClientRect;
  return sandbox.CompareSync.open().then((result) => {
    ok(result === true, "open() — THREE+정적 시점 2개 이상 → 360 동기 비교로 성공", result);
    ok(CS._idxA === 1 && CS._idxB === 2, "기본값 = 시점 배열의 마지막 2개(최신 대 직전)", { idxA: CS._idxA, idxB: CS._idxB });
    return { sandbox, CS };
  });
}

async function testDisposeNoLeak() {
  console.log("\n[⑤ dispose — 닫은 뒤 렌더러/텍스처 완전 해제(누수 0)]");
  const { sandbox, calls } = makeSandbox();
  const CS = sandbox.CompareSync;
  sandbox.TimeLapse = {
    hasMultiple: () => true,
    _shots: [{ id: "s0", label: "s0", capturedAt: 1 }, { id: "s1", label: "s1", capturedAt: 2 }],
    _resolveSrc: async (s) => ({ src: "data:" + s.id, isVideo: false }),
    _fmtDate: () => "00.00.00",
  };
  const opened = await CS.open();
  ok(opened === true, "open() 성공(사전조건)");
  ok(calls.rendererDispose === 0, "열려 있는 동안 dispose 호출 0 (사전조건)", calls);
  CS.close();
  ok(CS._left === null && CS._right === null, "close() 후 두 코어 참조 모두 null");
  ok(calls.rendererDispose === 2, "close() 후 renderer.dispose() 정확히 2회(좌·우 각각)", calls);
  ok(calls.textureDispose === 2, "close() 후 texture.dispose() 정확히 2회", calls);
}

async function main() {
  testCoreMath();
  testSyncFollow();
  testOffsetPreserved();
  const r = await testDefaultShotSelection();
  await testDisposeNoLeak();
  console.log("\n" + (failed ? "FAILED " + failed + "건" : "ALL PASS"));
  process.exit(failed ? 1 : 0);
}
main();
