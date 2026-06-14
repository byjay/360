import pw from '/opt/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.js';
const { chromium } = pw;

const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--single-process', '--disable-gpu', '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=256']
});
const page = await browser.newPage();
await page.setViewportSize({ width: 1280, height: 800 });

// 가시성: 조상 체인의 display/hidden/opacity 검사 (getClientRects 미사용)
const visFn = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  let n = el;
  while (n && n !== document.body) {
    const s = getComputedStyle(n);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
    if (n.classList && n.classList.contains('hidden')) return false;
    n = n.parentElement;
  }
  return true;
};

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__wm && window.__wm.Brand, { timeout: 10000 });

console.log('\n── 브랜딩 시스템 E2E ──');

// 1. Brand 모듈 존재
ok('Brand 모듈 노출(__wm.Brand)', await page.evaluate(() => !!window.__wm.Brand));

// 2. WM_BRAND 설정 로드
const cfg = await page.evaluate(() => window.__wm.Brand.cfg);
ok('Brand.cfg 로드됨', !!cfg);
ok('cfg.company = SEASTAR Inc.', cfg && cfg.company === 'SEASTAR Inc.');
ok('cfg.product = 360° Location Viewer', cfg && cfg.product.includes('360'));

// 3. 홈 로고 슬롯: 실제 로고 이미지(images/logo.png) 로드 검증
ok('홈 로고 슬롯 채워짐(내용 존재)', await page.evaluate(() =>
  document.getElementById('brand-logo-home').innerHTML.trim().length > 0));
ok('홈 로고 = 이미지 로드 성공', await page.evaluate(() => {
  const el = document.getElementById('brand-logo-home');
  const img = el.querySelector('img');
  return el.classList.contains('brand-logo--img') && img && img.complete && img.naturalWidth > 0;
}));

// 4. 텍스트 슬롯 채워짐
ok('home-badge = 회사명', await page.evaluate(() =>
  document.getElementById('home-badge').textContent === 'SEASTAR Inc.'));
ok('home-title = 제품명', await page.evaluate(() =>
  document.getElementById('home-title').textContent.includes('360')));
ok('home-sub = 태그라인', await page.evaluate(() =>
  document.getElementById('home-sub').textContent.includes('WORLD SHIPBUILDING')));
ok('home-footer = POWERED BY', await page.evaluate(() =>
  document.getElementById('home-footer').textContent.startsWith('POWERED BY')));

// 5. 문서 제목
ok('document.title에 제품+회사', await page.evaluate(() =>
  document.title.includes('360') && document.title.includes('SEASTAR')));

// 6. accent 미지정 시 기본 골드 유지
// 브랜드 기본색(--gold)이 SEASTAR 블루로 주입되었는지 검증
// (--accent는 모드별로 green/blue로 per-mode 재설정되므로 --gold로 검증)
ok('브랜드 기본색(--gold) = SEASTAR 블루(#1b75bb)', await page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--gold').trim() === '#1b75bb'));

// 7. 상단바 로고 슬롯 — 앱 진입 후 확인 (viewer 모드)
await page.evaluate(() => window.__wm.App.openApp('viewer'));
await page.waitForTimeout(500);
ok('상단바 로고 슬롯 존재', await page.evaluate(() => !!document.getElementById('brand-logo-top')));
ok('상단바 로고 = 이미지 로드', await page.evaluate(() =>
  document.getElementById('brand-logo-top').classList.contains('brand-logo--img')));

// 8. accent 동적 변경 검증 (테마색 주입 동작)
ok('accent 동적 주입 동작', await page.evaluate(() => {
  window.WM_BRAND.accent = '#3b82f6';
  window.__wm.Brand.apply();
  const v = getComputedStyle(document.documentElement).getPropertyValue('--gold').trim();
  // 기본값 복원
  window.WM_BRAND.accent = '#1b75bb';
  window.__wm.Brand.apply();
  return v === '#3b82f6';
}));

// 9. 잘못된 로고 URL→ onerror 텍스트 워드마크 폴백 (안정성 핵심)
ok('잘못된 logoUrl → 텍스트 폴백 동작', await page.evaluate(async () => {
  window.WM_BRAND.logoUrl = 'images/__nonexistent__.png';
  window.__wm.Brand.apply();
  const el = document.getElementById('brand-logo-home');
  // onerror 이벤트 대기
  await new Promise(r => setTimeout(r, 600));
  const fellBack = el.classList.contains('brand-logo--text')
    && el.textContent.includes('SEA');
  // 기본값 복원
  window.WM_BRAND.logoUrl = 'images/logo.png';
  window.__wm.Brand.apply();
  return fellBack;
}));

// 10. SEASTAR 워드마크 2색 분할(SEA+STAR) 검증
ok('SEASTAR 워드마크 SEA+STAR 분할', await page.evaluate(() => {
  // 임시로 로고 제거해 텍스트 워드마크 강제
  const saved = window.WM_BRAND.logoUrl;
  window.WM_BRAND.logoUrl = '';
  window.__wm.Brand.apply();
  const el = document.getElementById('brand-logo-home');
  const okWm = !!el.querySelector('.brand-wm-1') && !!el.querySelector('.brand-wm-3');
  window.WM_BRAND.logoUrl = saved;
  window.__wm.Brand.apply();
  return okWm;
}));

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
await browser.close();
process.exit(fail > 0 ? 1 : 0);
