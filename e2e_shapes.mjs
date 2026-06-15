// e2e_shapes.mjs — 영역 그리기 도구(사각형/원형/다각형) + 도형별 핀 판정 검증 (과제6)
import pw from '/opt/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.js';
const { chromium } = pw;
const BASE = 'http://localhost:3000';
const DEP = 'dep_mq90aup0_s4qdz0za';

let pass = 0, fail = 0; const results = [];
function check(n, c) { if (c) { pass++; results.push(`  ✅ ${n}`); } else { fail++; results.push(`  ❌ ${n}`); } }

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--single-process','--disable-gpu','--disable-dev-shm-usage','--js-flags=--max-old-space-size=256'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => results.push(`  ⚠️ pageerror: ${e.message}`));
  try {
    await page.goto(BASE + '/?mode=viewer', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__wm && window.__wm.Zones, { timeout: 15000 });
    await page.waitForTimeout(400);

    // 설계자 로그인 + 환경 셋업 + 그리기 가능하도록 transform 크기 부여
    await page.evaluate((dep) => {
      const W = window.__wm;
      W.State.currentDeploymentId = dep; W.State.pdfPage = 1; W.State.zones = []; W.State.pins = [];
      W.Auth.demoLogin('designer');
      const vp = document.getElementById('map-viewport'); if (vp) vp.classList.remove('hidden');
      const tf = document.getElementById('map-transform');
      if (tf) { tf.style.width = '800px'; tf.style.height = '600px'; tf.style.position = 'absolute'; tf.style.left = '200px'; tf.style.top = '150px'; }
    }, DEP);
    await page.waitForTimeout(300);

    // 1. 3개 도형 도구 버튼 존재
    check('1. 사각형/원형/다각형 도구 버튼 존재', await page.evaluate(() =>
      !!document.getElementById('btn-zone-rect') && !!document.getElementById('btn-zone-circle') && !!document.getElementById('btn-zone-poly')));

    // 2. pickShape('circle') → drawingZone + _shape=circle + 버튼 active
    check('2. 원형 도구 선택 → 그리기 모드', await page.evaluate(() => {
      window.__wm.Zones.pickShape('circle');
      return window.__wm.State.drawingZone === true && window.__wm.Zones._shape === 'circle'
        && document.getElementById('btn-zone-circle').classList.contains('active');
    }));

    // 3. 원형 드래그 → circle zone 추가
    const circleRes = await page.evaluate(async () => {
      const W = window.__wm;
      const origAsk = W.Prompt.ask; W.Prompt.ask = async () => ({ value: '원형구역' });
      W.State.drawingZone = false; W.Zones._shape = 'rect'; // 클린 상태
      W.Zones.pickShape('circle');
      const tf = document.getElementById('map-transform'); const r = tf.getBoundingClientRect();
      const x1 = r.left + r.width*0.3, y1 = r.top + r.height*0.3;
      const x2 = r.left + r.width*0.6, y2 = r.top + r.height*0.6;
      W.Zones.onDrawStart(x1,y1); W.Zones.onDrawMove(x2,y2); await W.Zones.onDrawEnd(x2,y2);
      W.Prompt.ask = origAsk;
      const z = W.State.zones[W.State.zones.length-1];
      return z ? { shape: z.shape, hasR: typeof z.r==='number', hasBB: typeof z.x==='number' && typeof z.w==='number', label: z.label } : null;
    });
    check('3. 원형 영역 추가됨', !!circleRes && circleRes.shape === 'circle');
    check('3b. 원형 geom(cx,cy,r) + 바운딩박스 보관', !!circleRes && circleRes.hasR && circleRes.hasBB);
    check('3c. 원형 라벨 적용', !!circleRes && circleRes.label === '원형구역');

    // 4. SVG <ellipse> 렌더
    check('4. SVG ellipse 도형 렌더', await page.evaluate(() =>
      !!document.querySelector('#zones-svg ellipse.zone-shape')));

    // 5. 원 내부/외부 점 판정 (_contains)
    check('5. 원형 _contains 판정 정확', await page.evaluate(() => {
      const z = window.__wm.State.zones.find(z=>z.shape==='circle');
      const inC = window.__wm.Zones._contains(z, z.cx, z.cy);          // 중심=내부
      const outC = window.__wm.Zones._contains(z, z.cx + z.r + 5, z.cy); // 멀리=외부
      return inC === true && outC === false;
    }));

    // 6. 다각형: 점 3개 클릭 후 finishPoly
    const polyRes = await page.evaluate(async () => {
      const W = window.__wm;
      const origAsk = W.Prompt.ask; W.Prompt.ask = async () => ({ value: '다각형구역' });
      W.State.drawingZone = false; W.Zones._shape = "rect"; W.Zones.pickShape("poly");
      const tf = document.getElementById('map-transform'); const r = tf.getBoundingClientRect();
      const P = (fx, fy) => [r.left + r.width*fx, r.top + r.height*fy];
      // 삼각형 형태로 3점 클릭
      let p = P(0.2,0.7); W.Zones.onDrawStart(p[0],p[1]);
      p = P(0.5,0.2); W.Zones.onDrawStart(p[0],p[1]);
      p = P(0.7,0.7); W.Zones.onDrawStart(p[0],p[1]);
      await W.Zones._finishPoly();
      W.Prompt.ask = origAsk;
      const z = W.State.zones[W.State.zones.length-1];
      return z ? { shape: z.shape, n: (z.points||[]).length, hasBB: typeof z.x==='number' } : null;
    });
    check('6. 다각형(3점) 영역 추가됨', !!polyRes && polyRes.shape === 'poly' && polyRes.n === 3);
    check('6b. 다각형 바운딩박스 보관', !!polyRes && polyRes.hasBB);

    // 7. SVG <polygon> 렌더
    check('7. SVG polygon 도형 렌더', await page.evaluate(() =>
      !!document.querySelector('#zones-svg polygon.zone-shape')));

    // 8. 다각형 내부/외부 판정 (point-in-polygon)
    check('8. 다각형 _contains 판정', await page.evaluate(() => {
      const z = window.__wm.State.zones.find(z=>z.shape==='poly');
      const cx = z.x + z.w/2, cy = z.y + z.h/2; // 바운딩박스 중심(삼각형 내부에 가깝게)
      const inP = window.__wm.Zones._contains(z, cx, cy);
      const outP = window.__wm.Zones._contains(z, z.x - 10, z.y - 10);
      return typeof inP === 'boolean' && outP === false;
    }));

    // 9. 사각형 도구 (회귀) — pickShape('rect') 동작
    const rectRes = await page.evaluate(async () => {
      const W = window.__wm;
      const origAsk = W.Prompt.ask; W.Prompt.ask = async () => ({ value: '사각구역' });
      W.Zones.pickShape('rect');
      const tf = document.getElementById('map-transform'); const r = tf.getBoundingClientRect();
      const x1 = r.left + r.width*0.1, y1 = r.top + r.height*0.1;
      const x2 = r.left + r.width*0.25, y2 = r.top + r.height*0.25;
      W.Zones.onDrawStart(x1,y1); W.Zones.onDrawMove(x2,y2); await W.Zones.onDrawEnd(x2,y2);
      W.Prompt.ask = origAsk;
      const z = W.State.zones[W.State.zones.length-1];
      return z ? z.shape : null;
    });
    check('9. 사각형 도구 그리기', rectRes === 'rect');
    check('9b. SVG rect 도형 렌더', await page.evaluate(() =>
      !!document.querySelector('#zones-svg rect.zone-shape')));

    // 10. 목록에 도형별 아이콘 + 3개 항목
    await page.evaluate(() => window.__wm.Zones.renderList());
    await page.waitForTimeout(150);
    check('10. 영역 목록 3개(원/다각형/사각형)', await page.evaluate(() =>
      document.querySelectorAll('#zone-list .zone-item').length === 3));
    check('10b. 목록 도형 아이콘 렌더', await page.evaluate(() =>
      document.querySelectorAll('#zone-list .zone-item-shape svg').length === 3));

    // 11. 같은 도구 재클릭 → 그리기 해제
    check('11. 같은 도구 재클릭 시 해제', await page.evaluate(() => {
      window.__wm.Zones.pickShape('rect'); // 켜기
      const on = window.__wm.State.drawingZone;
      window.__wm.Zones.pickShape('rect'); // 끄기
      return on === true && window.__wm.State.drawingZone === false;
    }));

    // 12. serialize/load 라운드트립 (도형 보존)
    check('12. serialize→load 도형 보존', await page.evaluate(() => {
      const s = window.__wm.Zones.serialize();
      const arr = JSON.parse(s);
      const shapes = arr.map(z=>z.shape).sort().join(',');
      window.__wm.Zones.load(arr);
      const after = (window.__wm.State.zones||[]).map(z=>z.shape).sort().join(',');
      return shapes === after && arr.length === 3;
    }));

    // 13. 디자이너 전용: 뷰어는 pickShape 무시
    const page2 = await ctx.newPage();
    await page2.goto(BASE + '/?mode=viewer', { waitUntil: 'domcontentloaded' });
    await page2.waitForFunction(() => window.__wm && window.__wm.Zones, { timeout: 15000 });
    await page2.waitForTimeout(300);
    check('13. 뷰어: pickShape 무시(그리기 불가)', await page2.evaluate(() => {
      window.__wm.Auth.demoLogin('viewer');
      window.__wm.State.drawingZone = false;
      window.__wm.Zones.pickShape('circle');
      return window.__wm.State.drawingZone === false;
    }));
    await page2.close();

  } catch (e) { results.push(`  ❌ FATAL: ${e.message}`); fail++; }
  finally {
    console.log('\n══════ 영역 도구(도형) E2E 결과 ══════');
    console.log(results.join('\n'));
    console.log(`\n  합계: ${pass} PASS / ${fail} FAIL`);
    await browser.close();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
