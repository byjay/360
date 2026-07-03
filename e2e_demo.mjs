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
await page.waitForFunction(() => window.__wm && window.__wm.Auth, { timeout: 10000 });
await page.waitForFunction(() => window.__wm.ProjectHub._loaded, { timeout: 10000 });
await page.waitForTimeout(300);

console.log('\n── 데모 진입(구글 로그인 없이 체험) E2E ──');

// 1. 허브 인증바에 데모 버튼 2종 존재 + 노출
ok('허브: 설계자 체험 버튼 존재', await page.evaluate(() => !!document.getElementById('hub-btn-demo-designer')));
ok('허브: 둘러보기(뷰어) 버튼 존재', await page.evaluate(() => !!document.getElementById('hub-btn-demo-viewer')));
ok('미로그인 시 데모 버튼 노출', await page.evaluate(visFn, '#hub-btn-demo-designer'));

// 2. '둘러보기'(뷰어 데모) → role 그대로 viewer, 데모 사용자 세팅
ok('둘러보기 클릭 → 뷰어 데모 로그인', await page.evaluate(async () => {
  document.getElementById('hub-btn-demo-viewer').click();
  await new Promise(r => setTimeout(r, 800));
  return window.__wm.Auth.role === 'viewer'
    && window.__wm.Auth.user
    && window.__wm.Auth.user.email === 'demo.viewer@seastargo.com';
}));
ok('뷰어 데모: 데모 모드 배지 표시', await page.evaluate(() => !!document.getElementById('demo-mode-badge')));
ok('뷰어 데모: 여전히 +새프로젝트 숨김(권한없음)', await page.evaluate(() =>
  document.getElementById('hub-btn-new').classList.contains('hidden')));

// 3. 로그아웃 → 데모 해제
ok('로그아웃 → 데모 배지 제거 + 뷰어 복귀', await page.evaluate(async () => {
  window.__wm.Auth.signOut();
  await new Promise(r => setTimeout(r, 300));
  return !document.getElementById('demo-mode-badge')
    && window.__wm.Auth.user === null;
}));

// 4. '설계자 체험'(디자이너 데모) → role designer, +새프로젝트/추가카드 노출
ok('설계자 체험 클릭 → 디자이너 데모 로그인', await page.evaluate(async () => {
  document.getElementById('hub-btn-demo-designer').click();
  await new Promise(r => setTimeout(r, 900));
  return window.__wm.Auth.role === 'designer'
    && window.__wm.Auth.user
    && window.__wm.Auth.user.email === 'demo.designer@seastargo.com';
}));
ok('설계자 데모: isDesigner true', await page.evaluate(() => window.__wm.Auth.isDesigner === true));
ok('설계자 데모: +새프로젝트 버튼 노출', await page.evaluate(() =>
  !document.getElementById('hub-btn-new').classList.contains('hidden')));
ok('설계자 데모: 허브 +새프로젝트 추가카드 표시', await page.evaluate(() =>
  document.querySelectorAll('#hub-grid .hub-card-add').length === 1));
ok('설계자 데모: 카드 삭제 버튼 노출', await page.evaluate(() =>
  !!document.querySelector('#hub-grid .hub-card [data-act="del"]')));
ok('설계자 데모: 데모 모드 배지 표시', await page.evaluate(() => !!document.getElementById('demo-mode-badge')));

// 5. 설계자 데모로 실제 프로젝트 생성/삭제 (백엔드 demo 토큰 검증)
ok('설계자 데모: 프로젝트 생성 API 성공', await page.evaluate(async () => {
  const r = await fetch('/api/projects', {
    method: 'POST',
    headers: window.__wm.Auth.headers(),
    body: JSON.stringify({ name: 'E2E 데모 생성', description: 'e2e' })
  });
  const j = await r.json();
  window.__E2E_NEW_ID = j.id;
  return r.status === 200 && j.id && j.name === 'E2E 데모 생성';
}));
ok('설계자 데모: 방금 생성 프로젝트 삭제 성공(정리)', await page.evaluate(async () => {
  const r = await fetch('/api/projects/' + window.__E2E_NEW_ID, {
    method: 'DELETE',
    headers: window.__wm.Auth.headers()
  });
  const j = await r.json();
  return r.status === 200 && j.success === true;
}));

// 6. 디자이너 데모 카드 클릭 → 디자이너 모드 진입
ok('설계자 데모: 카드 클릭 → 디자이너 모드 진입', await page.evaluate(async () => {
  window.__wm.ProjectHub.open();
  await new Promise(r => setTimeout(r, 400));
  const card = document.querySelector('#hub-grid .hub-card:not(.hub-card-add)');
  card.click();
  await new Promise(r => setTimeout(r, 500));
  return window.__wm.State.mode === 'designer';
}));

// 7. 로그인 게이트 내 '로그인 없이 설계자로 체험' 버튼 존재
ok('로그인 게이트: 데모 체험 버튼 존재', await page.evaluate(() =>
  !!document.getElementById('login-gate-demo')));

// 8. demoLogin 메서드 노출 + 토큰 형식 확인
ok('Auth.demoLogin 메서드 존재', await page.evaluate(() => typeof window.__wm.Auth.demoLogin === 'function'));
ok('디자이너 데모 토큰 = demo-designer', await page.evaluate(() => {
  // 현재 디자이너 데모 상태 → idToken 확인
  return window.__wm.Auth.idToken === 'demo-designer';
}));

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
await browser.close();
process.exit(fail > 0 ? 1 : 0);
