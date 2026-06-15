// e2e_pagebug.mjs — PDF 페이지별 핀 구분 버그 재현/검증
import pw from '/opt/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.js';
const { chromium } = pw;
const BASE = 'http://localhost:3000';

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--single-process','--disable-gpu','--disable-dev-shm-usage','--js-flags=--max-old-space-size=256'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('PAGEERR', e.message));
  try {
    await page.goto(BASE + '/?mode=viewer', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__wm && window.__wm.UI, { timeout: 15000 });
    await page.waitForTimeout(400);

    const r = await page.evaluate(() => {
      const W = window.__wm;
      // 다중 페이지 시뮬레이션
      W.State.pdfPages = 3;
      W.State.pdfPage = 1;
      W.State.pins = [];
      // page1 핀 2개, page2 핀 1개, page3 핀 1개
      W.State.pins.push({ id: 'a1', x: 20, y: 20, page: 1, label: 'P1-a' });
      W.State.pins.push({ id: 'a2', x: 30, y: 30, page: 1, label: 'P1-b' });
      W.State.pins.push({ id: 'b1', x: 40, y: 40, page: 2, label: 'P2-a' });
      W.State.pins.push({ id: 'c1', x: 50, y: 50, page: 3, label: 'P3-a' });

      // 페이지1 렌더
      W.State.pdfPage = 1;
      W.UI.renderPinsOnMap();
      const cnt1 = document.querySelectorAll('#pins-layer .pin-marker').length;

      // 페이지2로 이동(렌더만)
      W.State.pdfPage = 2;
      W.UI.renderPinsOnMap();
      const cnt2 = document.querySelectorAll('#pins-layer .pin-marker').length;
      const ids2 = [...document.querySelectorAll('#pins-layer .pin-marker')].map(e => e.dataset.id);

      // 페이지3
      W.State.pdfPage = 3;
      W.UI.renderPinsOnMap();
      const cnt3 = document.querySelectorAll('#pins-layer .pin-marker').length;

      return { cnt1, cnt2, cnt3, ids2 };
    });
    console.log('RESULT', JSON.stringify(r));
    console.log('expect cnt1=2, cnt2=1, cnt3=1');
    console.log(r.cnt1===2 && r.cnt2===1 && r.cnt3===1 ? 'PAGE_FILTER_OK' : 'PAGE_FILTER_BUG');
  } catch(e) { console.log('FATAL', e.message); }
  finally { await browser.close(); }
})();
