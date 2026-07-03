// E2E: 레이더 미니맵 + 핀 간 이동 핫스팟 (신기능)
import pw from '/opt/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.js';
const { chromium } = pw;

const BASE = 'http://localhost:3000';
let pass = 0, fail = 0; const results = [];
function check(name, cond, detail) {
  if (cond) { pass++; results.push(`  ✅ ${name}`); }
  else { fail++; results.push(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
const ev = (page, fn, arg) => page.evaluate(fn, arg);
const vis = (page, sel) => page.evaluate((s) => {
  let n = document.querySelector(s); if (!n) return false;
  while (n && n !== document.documentElement) {
    const st = getComputedStyle(n);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    if (n.classList && n.classList.contains('hidden')) return false;
    if (parseFloat(st.opacity) === 0) return false;
    n = n.parentElement;
  }
  return true;
}, sel);

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--single-process','--disable-gpu','--disable-dev-shm-usage','--js-flags=--max-old-space-size=256'] });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    page.on('pageerror', e => results.push(`  ⚠️ pageerror: ${e.message}`));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);

    // 도면 이미지(map-image) 한 장 + 같은 페이지에 3개 핀(콘텐츠 있음) 주입
    await ev(page, () => {
      const W = window.__wm;
      // 가짜 도면 이미지 노출 (radar의 _currentMapSrc가 map-image src를 읽음)
      const svg = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#123"/></svg>');
      const img = document.getElementById('map-image');
      img.src = svg;
      img.classList.remove('hidden');
      W.State.fileType = 'image';
      // 뷰어 모드 도면 페이지(배포본) — radar는 viewerPages를 우선 사용
      W.State.viewerPages = [svg];
      W.State.pdfPage = 1;
      // 콘텐츠 있는 핀 = imageUrl 보유 (외부 URL이라 실제 로드는 실패해도 radar/nav 로직은 동작)
      W.State.pins = [
        { id: 'p1', x: 20, y: 30, page: 1, label: 'A', imageUrl: 'https://example.com/a.jpg' },
        { id: 'p2', x: 50, y: 50, page: 1, label: 'B', imageUrl: 'https://example.com/b.jpg' },
        { id: 'p3', x: 80, y: 70, page: 1, label: 'C', imageUrl: 'https://example.com/c.jpg' },
      ];
    });

    // ── 두 번째 핀(B) 파노라마 오픈 ──
    await ev(page, () => window.__wm.App.openPano(window.__wm.State.pins[1]));
    await page.waitForTimeout(500);

    check('레이더 미니맵 표시', await vis(page, '#pano-radar'));
    check('레이더 도면 이미지 src 설정', await ev(page, () => { const i = document.getElementById('pano-radar-map'); return i && i.src.startsWith('data:image/svg'); }));
    const radarPins = await ev(page, () => document.querySelectorAll('#pano-radar-pins .pano-radar-pin').length);
    check('레이더에 핀 3개 렌더', radarPins === 3, `count=${radarPins}`);
    const curCount = await ev(page, () => document.querySelectorAll('#pano-radar-pins .pano-radar-pin.current').length);
    check('현재 핀 1개만 강조(current)', curCount === 1, `current=${curCount}`);
    // 현재 핀 위치 = B(50,50)
    const conePos = await ev(page, () => { const c = document.getElementById('pano-radar-cone'); return c.style.left + '|' + c.style.top; });
    check('시야 부채꼴이 현재 핀 위치(50%,50%)', conePos === '50%|50%', conePos);

    // 시야 회전 반영: lon 변경 후 spin
    await ev(page, () => { window.__wm.PanoViewer.S.lon = 90; window.__wm.Radar.spin(90, 75); });
    const fanRot = await ev(page, () => document.querySelector('#pano-radar-cone .pano-radar-fan').style.transform);
    check('부채꼴이 시야각(lon=90)으로 회전', /rotate\(90deg\)/.test(fanRot), fanRot);

    // ── 핀 간 이동 네비게이션 ──
    check('네비게이션 바 표시(핀 2개 이상)', await vis(page, '#pano-nav'));
    const label = await ev(page, () => document.getElementById('pano-nav-label').textContent);
    check('네비 라벨 = "2 / 3" (B는 중간)', label === '2 / 3', label);
    check('이전 버튼 활성(중간)', !(await ev(page, () => document.getElementById('btn-pano-prev').disabled)));
    check('다음 버튼 활성(중간)', !(await ev(page, () => document.getElementById('btn-pano-next').disabled)));

    // 다음(→) → C
    await ev(page, () => document.getElementById('btn-pano-next').click());
    await page.waitForTimeout(300);
    const lbl2 = await ev(page, () => document.getElementById('pano-nav-label').textContent);
    check('다음 이동 후 "3 / 3"', lbl2 === '3 / 3', lbl2);
    check('마지막에서 다음 버튼 비활성', await ev(page, () => document.getElementById('btn-pano-next').disabled));
    const cur2 = await ev(page, () => { const d = document.querySelector('#pano-radar-pins .pano-radar-pin.current'); return d ? d.title : ''; });
    check('레이더 현재 핀이 C로 갱신', cur2 === 'C', cur2);

    // 이전(←) 두 번 → A
    await ev(page, () => document.getElementById('btn-pano-prev').click());
    await page.waitForTimeout(200);
    await ev(page, () => document.getElementById('btn-pano-prev').click());
    await page.waitForTimeout(300);
    const lbl3 = await ev(page, () => document.getElementById('pano-nav-label').textContent);
    check('이전 두 번 후 "1 / 3"', lbl3 === '1 / 3', lbl3);
    check('처음에서 이전 버튼 비활성', await ev(page, () => document.getElementById('btn-pano-prev').disabled));

    // 키보드 → 이동
    await ev(page, () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    await page.waitForTimeout(300);
    const lbl4 = await ev(page, () => document.getElementById('pano-nav-label').textContent);
    check('키보드 → 로 다음 이동("2 / 3")', lbl4 === '2 / 3', lbl4);

    // ── 닫으면 레이더/네비 숨김 ──
    await ev(page, () => window.__wm.PanoViewer.close());
    await page.waitForTimeout(300);
    check('닫은 후 레이더 숨김', !(await vis(page, '#pano-radar')));
    check('닫은 후 네비 숨김', !(await vis(page, '#pano-nav')));

    // ── 단일 핀이면 네비 숨김 ──
    await ev(page, () => { window.__wm.State.pins = [{ id: 'solo', x: 40, y: 40, page: 1, label: 'Solo', imageUrl: 'https://example.com/s.jpg' }]; window.__wm.App.openPano(window.__wm.State.pins[0]); });
    await page.waitForTimeout(400);
    check('핀 1개일 때 네비 숨김', !(await vis(page, '#pano-nav')));
    check('핀 1개여도 레이더는 표시', await vis(page, '#pano-radar'));

    await page.close();
  } catch (e) {
    fail++; results.push(`  ❌ EXCEPTION: ${e.message}`);
  } finally { await browser.close(); }

  console.log('\n' + results.join('\n'));
  console.log(`\n  ── 결과: ${pass} PASS / ${fail} FAIL ──\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
