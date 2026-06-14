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
await page.waitForFunction(() => window.__wm && window.__wm.ProjectHub, { timeout: 10000 });
// 프로젝트 로드 완료 대기
await page.waitForFunction(() => window.__wm.ProjectHub._loaded, { timeout: 10000 });
await page.waitForTimeout(300);

console.log('\n── 프로젝트 허브(첫 화면) E2E ──');

// 1. 첫 화면 = screen-projects (active)
ok('첫 화면이 screen-projects', await page.evaluate(() =>
  document.getElementById('screen-projects').classList.contains('active')));
ok('screen-app 비활성', await page.evaluate(() =>
  !document.getElementById('screen-app').classList.contains('active')));

// 2. ProjectHub 모듈 노출 + 목록 로드
ok('ProjectHub 모듈 노출', await page.evaluate(() => !!window.__wm.ProjectHub));
ok('프로젝트 목록 2개 로드', await page.evaluate(() => window.__wm.ProjectHub.list.length === 2));

// 3. 카드 그리드 렌더 (미로그인=뷰어 → 카드 2개, +새프로젝트 없음)
ok('그리드에 카드 2개 표시', await page.evaluate(() =>
  document.querySelectorAll('#hub-grid .hub-card:not(.hub-card-add)').length === 2));
ok('미로그인 시 +새 프로젝트 카드 없음', await page.evaluate(() =>
  document.querySelectorAll('#hub-grid .hub-card-add').length === 0));
ok('미로그인 시 헤더 +새프로젝트 버튼 숨김', await page.evaluate(() =>
  document.getElementById('hub-btn-new').classList.contains('hidden')));

// 4. 카드 내용 (이름/메타)
ok('카드 이름 표시(LNG Carrier 최신순 먼저)', await page.evaluate(() => {
  const first = document.querySelector('#hub-grid .hub-card .hub-card-name');
  return first && first.textContent.includes('LNG Carrier');
}));
ok('카드 날짜 메타 표시', await page.evaluate(() =>
  !!document.querySelector('#hub-grid .hub-card .hub-card-date')));

// 5. 미로그인 카드 클릭 → 뷰어 모드 진입
await page.evaluate(() => {
  const card = document.querySelector('#hub-grid .hub-card:not(.hub-card-add)');
  card.click();
});
await page.waitForTimeout(500);
ok('카드 클릭 → screen-app 진입', await page.evaluate(() =>
  document.getElementById('screen-app').classList.contains('active')));
ok('미로그인 진입 = 뷰어 모드', await page.evaluate(() => window.__wm.State.mode === 'viewer'));
ok('진입 시 선택 프로젝트 State 기록', await page.evaluate(() =>
  window.__wm.State.currentProjectName === 'LNG Carrier 174K'
  && window.__wm.State.currentProjectId === 'p_demo2'));
ok('뒤로(←) 버튼 표시(허브 복귀 가능)', await page.evaluate(visFn, '#btn-back'));

// 6. ← 버튼 → 프로젝트 허브 복귀
await page.evaluate(() => document.getElementById('btn-back').click());
await page.waitForTimeout(400);
ok('← → 프로젝트 허브 복귀', await page.evaluate(() =>
  document.getElementById('screen-projects').classList.contains('active')));

// 7. 디자이너 권한 시뮬레이션 → 재렌더 → +새프로젝트 카드/버튼 노출
ok('디자이너 로그인 시 +새프로젝트 노출', await page.evaluate(() => {
  // Auth role을 디자이너로 강제 (E2E 시뮬레이션)
  window.__wm.Auth.role = 'designer';
  window.__wm.Auth.user = { email: 'd@x.com', name: 'D', role: 'designer' };
  window.__wm.Auth._applyUi();           // refreshIfVisible 트리거
  const addCard = document.querySelectorAll('#hub-grid .hub-card-add').length === 1;
  const btnVisible = !document.getElementById('hub-btn-new').classList.contains('hidden');
  return addCard && btnVisible;
}));

// 8. 디자이너 카드 클릭 → 디자이너 모드 진입
ok('디자이너 카드 클릭 → 디자이너 모드', await page.evaluate(async () => {
  const card = document.querySelector('#hub-grid .hub-card:not(.hub-card-add)');
  card.click();
  await new Promise(r => setTimeout(r, 400));
  return window.__wm.State.mode === 'designer';
}));

// 9. 디자이너 카드에 삭제 버튼 존재 (허브로 복귀 후 확인)
await page.evaluate(() => { window.__wm.ProjectHub.open(); });
await page.waitForTimeout(400);
ok('디자이너 카드에 삭제 액션 버튼 존재', await page.evaluate(() =>
  !!document.querySelector('#hub-grid .hub-card [data-act="del"]')));

// 10. 브랜드 로고가 허브 상단바에도 표시
ok('허브 상단바 로고 슬롯 채워짐', await page.evaluate(() =>
  document.getElementById('hub-brand-logo').innerHTML.trim().length > 0));

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
await browser.close();
process.exit(fail > 0 ? 1 : 0);
