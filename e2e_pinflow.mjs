// e2e_pinflow.mjs — 과제1(사진 업로드+저장 버튼) + 과제2(뷰어 클릭→360 팝업) 검증
import pw from '/opt/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.js';
const { chromium } = pw;
const BASE = 'http://localhost:3000';

let pass = 0, fail = 0; const results = [];
function check(n, c) { if (c) { pass++; results.push(`  ✅ ${n}`); } else { fail++; results.push(`  ❌ ${n}`); } }

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--single-process','--disable-gpu','--disable-dev-shm-usage','--js-flags=--max-old-space-size=256'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => results.push(`  ⚠️ pageerror: ${e.message}`));
  try {
    await page.goto(BASE + '/?mode=viewer', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__wm && window.__wm.App, { timeout: 15000 });
    await page.waitForTimeout(400);

    // ── 과제1: 핀 폼 구성 요소 (사진 업로드 + 저장 버튼) ──
    check('1. 360° 파일 업로드 버튼 존재(btn-pin-file)', await page.evaluate(() => !!document.getElementById('btn-pin-file')));
    check('1b. 파일 input 존재(image/video accept)', await page.evaluate(() => {
      const i = document.getElementById('input-pin-file');
      return i && /image|video/.test(i.getAttribute('accept') || '');
    }));
    check('1c. 저장&업로드 버튼 존재(btn-confirm-pin)', await page.evaluate(() => {
      const b = document.getElementById('btn-confirm-pin');
      return b && /저장/.test(b.textContent);
    }));
    check('1d. URL 직접입력 필드 존재', await page.evaluate(() => !!document.getElementById('input-pin-url')));

    // 저장 버튼 활성화 로직: URL 입력 시 enabled
    check('1e. 내용 입력 시 저장 버튼 활성화', await page.evaluate(() => {
      const W = window.__wm;
      W.Auth.demoLogin('designer');
      W.State.pending = { x: 40, y: 40 };
      document.getElementById('section-pin-form').classList.remove('hidden');
      const url = document.getElementById('input-pin-url');
      url.value = 'https://example.com/pano.jpg';
      url.dispatchEvent(new Event('input', { bubbles: true }));
      return document.getElementById('btn-confirm-pin').disabled === false;
    }));
    check('1f. 빈 내용 시 저장 버튼 비활성화', await page.evaluate(() => {
      const url = document.getElementById('input-pin-url');
      url.value = '';
      url.dispatchEvent(new Event('input', { bubbles: true }));
      return document.getElementById('btn-confirm-pin').disabled === true;
    }));

    // ── 과제2: 뷰어에서 핀 클릭 → openPano (360 팝업) ──
    // 콘텐츠 있는 핀 주입 후 마커 클릭 → pano-overlay 표시
    await page.evaluate(() => {
      const W = window.__wm;
      W.State.mode = 'viewer';
      W.State.pdfPage = 1; W.State.pdfPages = 1;
      W.State.pins = [];
      W.addPin({ id: 'vp1', x: 50, y: 50, page: 1, label: '360 테스트', imageUrl: 'https://example.com/pano.jpg' });
    });
    await page.waitForTimeout(300);
    check('2. 뷰어 마커가 도면에 렌더', await page.evaluate(() =>
      !!document.querySelector('#pins-layer .pin-marker[data-id="vp1"]')));

    // openPano 직접 호출(클릭 핸들러가 호출하는 함수) → 오버레이 표시 확인
    const overlayShown = await page.evaluate(async () => {
      const W = window.__wm;
      const pin = W.State.pins.find(p => p.id === 'vp1');
      try { await W.App.openPano(pin); } catch (e) {}
      await new Promise(r => setTimeout(r, 400));
      const ov = document.getElementById('pano-overlay');
      return ov && !ov.classList.contains('hidden');
    });
    check('2b. 핀 클릭(openPano) → 360 오버레이 표시', overlayShown);

    // pinHasContent: 콘텐츠 있는 핀은 클릭 즉시 오픈 대상
    check('2c. 콘텐츠 있는 핀은 즉시 오픈 대상(pinHasContent)', await page.evaluate(() => {
      const pin = window.__wm.State.pins.find(p => p.id === 'vp1');
      return window.__wm.App.pinHasContent(pin) === true;
    }));

    // 오버레이 닫기
    await page.evaluate(() => {
      const ov = document.getElementById('pano-overlay');
      if (ov) ov.classList.add('hidden');
    });

    // 마커 클릭 이벤트가 실제로 바인딩되어 있는지(이벤트 시뮬레이션)
    const clickOpens = await page.evaluate(async () => {
      const W = window.__wm;
      const ov = document.getElementById('pano-overlay'); if (ov) ov.classList.add('hidden');
      const el = document.querySelector('#pins-layer .pin-marker[data-id="vp1"]');
      if (!el) return false;
      el.click();
      await new Promise(r => setTimeout(r, 400));
      return ov && !ov.classList.contains('hidden');
    });
    check('2d. 마커 DOM 클릭 → 오버레이 열림(이벤트 바인딩)', clickOpens);

  } catch (e) { results.push(`  ❌ FATAL: ${e.message}`); fail++; }
  finally {
    console.log('\n══════ 핀 등록/뷰어 팝업 E2E 결과 ══════');
    console.log(results.join('\n'));
    console.log(`\n  합계: ${pass} PASS / ${fail} FAIL`);
    await browser.close();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
