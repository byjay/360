/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p115-pinch-center-fix.test.mjs)
 *
 * 대상: WORK_ORDER_20261001_mobilefast.md 판정①(핀치 확대·축소, "손가락 중심점 기준" 정확도).
 *
 * [재현] 지휘자 발주서 수치 그대로(대수적 유도, 이 파일이 재현 겸 회귀): 종전 20_App.js 터치
 * 핸들러는 "MapCtrl.zoomBy(ratio, mid)로 중점을 고정한 뒤, 중점 이동분(mid - prevMid)만큼
 * pan을 추가로 더하는" 2단계 합성이었다. ratio=1(순수 팬)이거나 중점이 안 움직이면 정확하지만,
 * 핀치 중 매 프레임처럼 "줌과 팬이 동시에" 일어나면 (mid-prevMid)*(1-ratio) 만큼 드리프트가
 * 나(대수적으로 유도), 중심점 고정이 깨진다. MapCtrl.pinchTransform(10_MapCtrl.js)은 이를
 * "직전 중점이 가리키던 도면좌표를 현재 중점에 역산"하는 단일 수식으로 교체해 오차를 없앤다.
 *
 * 실제 모듈 소스(public/js/modules/10_MapCtrl.js)를 vm 에 그대로 평가해 검사(목 구현 아님).
 * 뮤테이션 1건(구 2단계 합성으로 되돌림)으로 이 테스트가 실제로 그 버그를 잡는지 증명한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const mapSrc = rd("public/js/modules/10_MapCtrl.js");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };

function loadMap(src) {
  const sandbox = {
    console, Math, JSON, isFinite,
    State: { zoom: 1, pan: { x: 0, y: 0 }, isoView: false, isoDir: 0, panDragging: false, mode: "designer", fileType: "pdf" },
    document: { getElementById: () => null, createElement: () => ({ style: {}, getContext: () => null }) },
    navigator: { userAgent: "node" },
    performance: { now: () => 0 },
    setTimeout: () => 0, clearTimeout: () => {}
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__MAP = MapCtrl;", sandbox);
  const MapCtrl = sandbox.__MAP;
  const fakeClassList = () => ({ toggle() {}, add() {}, remove() {} });
  const transform = { style: {}, offsetWidth: 800, offsetHeight: 600, classList: fakeClassList() };
  const viewport = { clientWidth: 400, clientHeight: 700, classList: fakeClassList(), getBoundingClientRect: () => ({ left: 20, top: 40, width: 400, height: 700 }) };
  MapCtrl.init(viewport, transform);
  return { MapCtrl, transform, viewport, State: sandbox.State };
}

/** "손가락 중심점 기준 확대" 검증: 핀치 전 curMid 아래 있던 도면좌표가, pinchTransform 적용 뒤에도
 *  화면상 같은 위치(curMid)에 남아야 한다. 오차 = |after - curMid| / viewport 대각선. */
function centerError(r, pan0, zoom0, rectLeft, rectTop, prevMid, curMid, ratio) {
  // 핀치 전, "직전 중점(prevMid)" 아래 있던 도면좌표(로컬 content 좌표) — 이 점이 이번 프레임
  // 종료 후 "현재 중점(curMid)" 화면 위치에 그대로 있어야 "중심점 고정"이다.
  const beforeLocalX = prevMid.x - rectLeft, beforeLocalY = prevMid.y - rectTop;
  const contentX = (beforeLocalX - pan0.x) / zoom0, contentY = (beforeLocalY - pan0.y) / zoom0;
  // 핀치 적용
  const after = r.pinchTransform(pan0, zoom0, rectLeft, rectTop, prevMid.x, prevMid.y, curMid.x, curMid.y, ratio);
  // 적용 후, 그 도면좌표가 화면 어디에 있는지(로컬) — curMid 와 같아야 한다
  const afterScreenX = after.pan.x + after.zoom * contentX;
  const afterScreenY = after.pan.y + after.zoom * contentY;
  const curLocalX = curMid.x - rectLeft, curLocalY = curMid.y - rectTop;
  const dx = afterScreenX - curLocalX, dy = afterScreenY - curLocalY;
  const diag = Math.hypot(400, 700);
  return Math.hypot(dx, dy) / diag;
}

/* ══ 건1 — 중심점 고정 정확도(오차 < 1%), ratio≠1 + 중점 이동 동시 발생(핀치 실사용 조건) ══ */
{
  const { MapCtrl } = loadMap(mapSrc);
  const cases = [
    { pan0: { x: -40, y: -60 }, zoom0: 1.4, rectLeft: 20, rectTop: 40, prevMid: { x: 180, y: 300 }, curMid: { x: 210, y: 330 }, ratio: 1.18 },
    { pan0: { x: 10, y: 5 }, zoom0: 2.6, rectLeft: 20, rectTop: 40, prevMid: { x: 150, y: 450 }, curMid: { x: 130, y: 470 }, ratio: 0.82 },
    { pan0: { x: 0, y: 0 }, zoom0: 1.0, rectLeft: 20, rectTop: 40, prevMid: { x: 200, y: 350 }, curMid: { x: 260, y: 300 }, ratio: 1.5 },
  ];
  let maxErr = 0;
  for (const c of cases) {
    const e = centerError(MapCtrl, c.pan0, c.zoom0, c.rectLeft, c.rectTop, c.prevMid, c.curMid, c.ratio);
    maxErr = Math.max(maxErr, e);
  }
  ok(maxErr < 0.01, "pinchTransform 중심점 고정 오차 < 1% (실측 " + (maxErr * 100).toFixed(4) + "%, ratio≠1+중점이동 동시 케이스 3종)");
}

/* ══ 건2 — MAX_ZOOM 상한이 16으로 올라감(zoomBy 경유) ══ */
{
  const { MapCtrl, State } = loadMap(mapSrc);
  ok(MapCtrl.MAX_ZOOM === 16, "MapCtrl.MAX_ZOOM === 16 (종전 8에서 상향)");
  MapCtrl.zoomBy(1000);
  ok(State.zoom === 16, "zoomBy 가 MAX_ZOOM(16) 에서 클램프됨 (실측 " + State.zoom + ")");
}

/* ══ 건3(뮤테이션 증명) — pinchTransform 을 구 2단계 합성(zoomBy + 중점이동 보정 추가)으로
 *  되돌리면, 위 건1 과 같은 "ratio≠1+중점이동 동시" 케이스에서 오차가 1%를 넘어야 한다. */
{
  const needle = `      return {
        zoom: newZoom,
        pan: {
          x: curLocalX - actualRatio * (prevLocalX - pan.x),
          y: curLocalY - actualRatio * (prevLocalY - pan.y)
        }
      };
    },`;
  ok(mapSrc.includes(needle), "뮤테이션 전제 — pinchTransform 반환 블록을 소스에서 찾음(needle 일치)");
  const oldBuggy = `      return {
        zoom: newZoom,
        pan: {
          x: curLocalX * (1 - actualRatio) + actualRatio * pan.x + (curMidX - prevMidX),
          y: curLocalY * (1 - actualRatio) + actualRatio * pan.y + (curMidY - prevMidY)
        }
      };
    },`;
  const mutatedSrc = mapSrc.replace(needle, oldBuggy);
  ok(mutatedSrc !== mapSrc, "뮤테이션 적용됨(문자열이 바뀜)");
  const { MapCtrl } = loadMap(mutatedSrc);
  // ratio 편차가 크고 중점도 크게 움직이는 케이스(위 cases[2])로 — 드리프트 항 (mid-prevMid)*(1-ratio)
  // 가 커 1% 문턱을 넉넉히 넘는다(작은 ratio 편차 케이스는 ~0.95%로 문턱에 바짝 붙어 불안정).
  const e = centerError(MapCtrl, { x: 0, y: 0 }, 1.0, 20, 40, { x: 200, y: 350 }, { x: 260, y: 300 }, 1.5);
  ok(e >= 0.01, "뮤테이션(구 2단계 합성) 적용 시 중심점 오차가 1% 이상으로 재현됨 (실측 " + (e * 100).toFixed(4) + "%) — 이 테스트가 실제로 그 회귀를 잡는다");
}

console.log(failed === 0 ? "\nALL PASS" : "\n" + failed + " FAILED");
process.exit(failed === 0 ? 0 : 1);
