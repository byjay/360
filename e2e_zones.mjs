// e2e_zones.mjs — 영역(Zone) 지정·하이라이트 기능 E2E (사용자 핵심 요청)
// 검증: 모듈 존재, 영역 그리기(좌표), 도면 박스 렌더, 하이라이트(핀 dim/hot),
//       사이드바 목록, focus/flyTo, 삭제, serialize/load, 디자이너 전용 컨트롤, 뷰어 가시성
import pw from '/opt/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.js';
const { chromium } = pw;

const BASE = 'http://localhost:3000';
const DEP = 'dep_mq90aup0_s4qdz0za'; // 로컬 D1에 존재하는 배포본 id (drawing.png)

let pass = 0, fail = 0;
const results = [];
function check(name, cond) {
  if (cond) { pass++; results.push(`  ✅ ${name}`); }
  else { fail++; results.push(`  ❌ ${name}`); }
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--single-process', '--disable-gpu', '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=256'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => results.push(`  ⚠️ pageerror: ${e.message}`));

  try {
    await page.goto(BASE + '/?mode=viewer', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__wm && window.__wm.Zones, { timeout: 15000 });
    await page.waitForTimeout(500);

    // 1. __wm.Zones 모듈 존재
    check('1. window.__wm.Zones 모듈 존재', await page.evaluate(() => typeof window.__wm.Zones === 'object'));

    // 2. State 초기화 + 테스트 핀 2개 주입 (하나는 영역 안, 하나는 영역 밖)
    await page.evaluate((dep) => {
      const W = window.__wm;
      W.State.currentDeploymentId = dep;
      W.State.pdfPage = 1;
      W.State.zones = [];
      W.State.pins = [];
      // 영역(10,10 ~ 40,40) 안의 핀
      W.addPin({ id: 'pin_in', x: 25, y: 25, page: 1, label: '영역내 핀' });
      // 영역 밖 핀
      W.addPin({ id: 'pin_out', x: 80, y: 80, page: 1, label: '영역외 핀' });
    }, DEP);
    check('2. 핀 2개 주입(영역내/외) + deployment 설정', await page.evaluate(() =>
      window.__wm.State.pins.length === 2 && window.__wm.State.currentDeploymentId === 'dep_mq90aup0_s4qdz0za'));

    // 3. 데모 설계자 로그인 → isDesigner
    await page.evaluate(() => window.__wm.Auth.demoLogin('designer'));
    await page.waitForTimeout(400);
    check('3. 데모 설계자 로그인 (Zones.isDesigner)', await page.evaluate(() => window.__wm.Zones.isDesigner() === true));

    // 4. 영역 직접 주입(load) → State.zones 반영
    await page.evaluate(() => {
      window.__wm.Zones.load([{
        id: 'zone_test1', page: 1, x: 10, y: 10, w: 30, h: 30,
        label: '엔진룸 구역', color: '#f59e0b', pinIds: ['pin_in'], note: '',
      }]);
    });
    await page.waitForTimeout(200);
    check('4. Zones.load → State.zones 1개', await page.evaluate(() => window.__wm.State.zones.length === 1));

    // 5. 도면 위 영역 박스 렌더
    check('5. #zones-layer 에 .zone-box 렌더', await page.evaluate(() => {
      const box = document.querySelector('#zones-layer .zone-box[data-zone="zone_test1"]');
      return !!box;
    }));
    check('5b. 영역 박스 좌표/크기 % 적용', await page.evaluate(() => {
      const box = document.querySelector('#zones-layer .zone-box[data-zone="zone_test1"]');
      return box && box.style.left === '10%' && box.style.width === '30%';
    }));
    check('5c. 영역 라벨 표시', await page.evaluate(() => {
      const lbl = document.querySelector('#zones-layer .zone-box-label');
      return lbl && lbl.textContent.includes('엔진룸 구역');
    }));

    // 6. 디자이너 → 삭제 버튼(SVG) 존재
    check('6. 디자이너: 영역 삭제 버튼(SVG) 렌더', await page.evaluate(() => {
      const del = document.querySelector('#zones-layer .zone-box-del svg');
      return !!del;
    }));

    // 7. 사이드바 목록 렌더 + 카운트
    await page.evaluate(() => window.__wm.Zones.renderList());
    await page.waitForTimeout(150);
    check('7. #zone-list 항목 1개', await page.evaluate(() =>
      document.querySelectorAll('#zone-list .zone-item').length === 1));
    check('7b. #zone-count = 1', await page.evaluate(() =>
      document.getElementById('zone-count').textContent === '1'));
    check('7c. 목록 핀 카운트 아이콘(SVG) 렌더', await page.evaluate(() =>
      !!document.querySelector('#zone-list .zone-item-cnt svg')));

    // 8. 하이라이트: 영역 내 핀=hot, 외부 핀=dim
    await page.evaluate(() => window.__wm.Zones.highlight('zone_test1'));
    await page.waitForTimeout(150);
    check('8. 영역내 핀 .zone-hot', await page.evaluate(() => {
      const el = document.querySelector('#pins-layer .pin-marker[data-pin-id="pin_in"], #pins-layer .pin-marker[data-id="pin_in"]');
      return el && el.classList.contains('zone-hot');
    }));
    check('8b. 영역외 핀 .zone-dim', await page.evaluate(() => {
      const el = document.querySelector('#pins-layer .pin-marker[data-pin-id="pin_out"], #pins-layer .pin-marker[data-id="pin_out"]');
      return el && el.classList.contains('zone-dim');
    }));
    check('8c. 영역 박스 active 클래스', await page.evaluate(() =>
      !!document.querySelector('#zones-layer .zone-box.active')));

    // 9. 하이라이트 해제(null) → dim/hot 제거
    await page.evaluate(() => window.__wm.Zones.highlight(null));
    await page.waitForTimeout(150);
    check('9. 하이라이트 해제 시 .zone-dim/.zone-hot 제거', await page.evaluate(() => {
      const hot = document.querySelectorAll('#pins-layer .pin-marker.zone-hot').length;
      const dim = document.querySelectorAll('#pins-layer .pin-marker.zone-dim').length;
      return hot === 0 && dim === 0;
    }));

    // 10. focus → flyTo 호출 (MapCtrl.flyTo 스파이)
    const flyCalled = await page.evaluate(() => {
      let called = false;
      const orig = window.__wm.MapCtrl.flyTo;
      window.__wm.MapCtrl.flyTo = function (...a) { called = true; return orig && orig.apply(this, a); };
      window.__wm.Zones.focus('zone_test1');
      window.__wm.MapCtrl.flyTo = orig;
      return called;
    });
    check('10. focus() → MapCtrl.flyTo 호출', flyCalled);

    // 11. refreshPinLinks: 핀 이동 후 연결 재계산
    await page.evaluate(() => {
      // pin_out 을 영역 안으로 이동
      const p = window.__wm.State.pins.find(x => x.id === 'pin_out');
      p.x = 20; p.y = 20;
      window.__wm.Zones.refreshPinLinks();
    });
    check('11. refreshPinLinks → 영역 핀 2개 연결', await page.evaluate(() => {
      const z = window.__wm.State.zones[0];
      return (z.pinIds || []).length === 2;
    }));

    // 12. serialize → JSON 문자열
    check('12. serialize() JSON 직렬화', await page.evaluate(() => {
      const s = window.__wm.Zones.serialize();
      const arr = JSON.parse(s);
      return Array.isArray(arr) && arr.length === 1 && arr[0].label === '엔진룸 구역';
    }));

    // 13. 그리기 시뮬레이션 (onDrawStart/Move/End) — viewportToPercent 경로
    //     drawingZone 토글 후, 화면 좌표로 드래그 → 영역 추가 (Prompt 자동 응답)
    const drawAdded = await page.evaluate(async () => {
      const W = window.__wm;
      // 그리기는 viewportToPercent(=#map-transform 크기) 에 의존하므로,
      // 실제 도면 미로딩 상태에서는 transform 에 측정 가능한 크기를 부여한다.
      const vpEl = document.getElementById('map-viewport');
      if (vpEl) vpEl.classList.remove('hidden');
      const tf = document.getElementById('map-transform');
      if (tf) { tf.style.width = '800px'; tf.style.height = '600px'; tf.style.position = 'absolute'; tf.style.left = '200px'; tf.style.top = '150px'; }
      // Prompt.ask 를 자동 확정으로 대체
      const origAsk = W.Prompt.ask;
      W.Prompt.ask = async () => ({ value: '드래그 구역' });
      W.State.drawingZone = true;
      const r = tf ? tf.getBoundingClientRect() : { left: 200, top: 150, width: 800, height: 600 };
      const x1 = r.left + r.width * 0.3, y1 = r.top + r.height * 0.3;
      const x2 = r.left + r.width * 0.6, y2 = r.top + r.height * 0.6;
      const before = W.State.zones.length;
      const started = W.Zones.onDrawStart(x1, y1);
      W.Zones.onDrawMove(x2, y2);
      await W.Zones.onDrawEnd(x2, y2);
      W.Prompt.ask = origAsk;
      return { started, before, after: W.State.zones.length };
    });
    check('13. 그리기 시작(onDrawStart) 성공', drawAdded.started === true);
    check('13b. 드래그로 영역 추가됨', drawAdded.after === drawAdded.before + 1);

    // 14. 삭제 (remove, confirm 자동 수락)
    await page.evaluate(() => { window.confirm = () => true; });
    await page.evaluate(() => window.__wm.Zones.remove('zone_test1'));
    await page.waitForTimeout(150);
    check('14. remove() → 해당 영역 제거', await page.evaluate(() =>
      !window.__wm.State.zones.some(z => z.id === 'zone_test1')));
    check('14b. 도면에서 박스 제거', await page.evaluate(() =>
      !document.querySelector('#zones-layer .zone-box[data-zone="zone_test1"]')));

    // ── 뷰어 권한 시나리오 (새 페이지) ──
    const page2 = await ctx.newPage();
    page2.on('pageerror', e => results.push(`  ⚠️ pageerror(viewer): ${e.message}`));
    await page2.goto(BASE + '/?mode=viewer', { waitUntil: 'domcontentloaded' });
    await page2.waitForFunction(() => window.__wm && window.__wm.Zones, { timeout: 15000 });
    await page2.waitForTimeout(400);
    // 뷰어로 로그인 + 영역 주입
    await page2.evaluate((dep) => {
      const W = window.__wm;
      W.State.currentDeploymentId = dep;
      W.State.pdfPage = 1;
      W.State.pins = [];
      W.Auth.demoLogin('viewer');
      W.Zones.load([{ id: 'zv1', page: 1, x: 10, y: 10, w: 20, h: 20, label: '뷰어구역', color: '#3b82f6', pinIds: [], note: '' }]);
    }, DEP);
    await page2.waitForTimeout(300);

    check('15. 뷰어: 영역 박스 표시됨', await page2.evaluate(() =>
      !!document.querySelector('#zones-layer .zone-box[data-zone="zv1"]')));
    check('15b. 뷰어: 삭제 버튼 없음(디자이너 전용)', await page2.evaluate(() =>
      !document.querySelector('#zones-layer .zone-box-del')));
    check('15c. 뷰어: 영역 목록 표시(영역 있을 때)', await page2.evaluate(() => {
      const sec = document.getElementById('section-zones');
      return sec && !sec.classList.contains('hidden') &&
        document.querySelectorAll('#zone-list .zone-item').length === 1;
    }));
    check('15d. 뷰어: toggleDraw 무시(그리기 불가)', await page2.evaluate(() => {
      window.__wm.State.drawingZone = false;
      window.__wm.Zones.toggleDraw();
      return window.__wm.State.drawingZone === false;
    }));

    await page2.close();
  } catch (e) {
    results.push(`  ❌ FATAL: ${e.message}`);
    fail++;
  } finally {
    console.log('\n══════ Zone(영역) 기능 E2E 결과 ══════');
    console.log(results.join('\n'));
    console.log(`\n  합계: ${pass} PASS / ${fail} FAIL`);
    await browser.close();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
