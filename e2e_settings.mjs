// A안 E2E: 접속=뷰어 / ⚙️ 설정창 / 역할별 렌더 / 편집모드 전환
import pw from '/opt/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.js';
const { chromium } = pw;

const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { pass++; results.push(`  ✅ ${name}`); }
  else { fail++; results.push(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

const clickEv = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (el) el.click(); return !!el; }, sel);
const vis = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  // 자신 + 조상 체인을 따라 display:none / visibility:hidden / .hidden / opacity:0 검사
  let node = el;
  while (node && node !== document.documentElement) {
    const st = getComputedStyle(node);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    if (node.classList && node.classList.contains('hidden')) return false;
    if (parseFloat(st.opacity) === 0) return false;
    node = node.parentElement;
  }
  // 조상 체인이 모두 표시 상태면 visible로 판정
  // (single-process headless 환경에서는 getClientRects가 0을 반환할 수 있어 사용하지 않음)
  return true;
}, sel);

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--single-process', '--disable-gpu', '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=256'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    page.on('pageerror', e => results.push(`  ⚠️ pageerror: ${e.message}`));

    // ── 1) 접속 → 첫 화면 = 프로젝트 허브 → 카드 클릭 → 뷰어 진입 ──
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__wm && window.__wm.ProjectHub && window.__wm.ProjectHub._loaded, { timeout: 10000 });
    await page.waitForTimeout(300);

    const hubShown = await page.evaluate(() =>
      document.getElementById('screen-projects').classList.contains('active'));
    check('접속 첫 화면 = 프로젝트 허브', hubShown);

    // 카드가 없으면 허브에서 직접 뷰어 진입(빈 상태 대비), 있으면 첫 카드 클릭
    await page.evaluate(() => {
      const card = document.querySelector('#hub-grid .hub-card:not(.hub-card-add)');
      if (card) card.click();
      else window.__wm.App.openApp('viewer');
    });
    await page.waitForTimeout(500);

    const appShown = await page.evaluate(() =>
      document.getElementById('screen-app').classList.contains('active'));
    check('카드 클릭 → screen-app 진입', appShown);

    const mode = await page.evaluate(() => window.__wm && window.__wm.State && window.__wm.State.mode);
    check('미로그인 진입 모드 = viewer', mode === 'viewer', `mode=${mode}`);

    const modeLabel = await page.evaluate(() => { const e = document.getElementById('mode-label'); return e ? e.textContent : ''; });
    check('mode-label = VIEWER MODE', /VIEWER/.test(modeLabel), modeLabel);

    // ── 2) topbar 버튼 가시성 ──
    check('⚙️ 설정 버튼 노출', await vis(page, '#btn-settings'));
    check('"뷰어로" 버튼 숨김(뷰어 모드)', !(await vis(page, '#btn-exit-edit')));
    // ← 버튼: 프로젝트 허브 복귀용으로 표시(잠금 링크 아님)
    check('← 허브 복귀 버튼 노출', await vis(page, '#btn-back'));

    // ── 3) 설정 패널 열기 (미로그인) ──
    await clickEv(page, '#btn-settings');
    await page.waitForTimeout(400);
    check('설정 모달 표시', await page.evaluate(() => { const m = document.getElementById('settings-modal'); return m && !m.classList.contains('hidden'); }));
    check('미로그인 블록(settings-loggedout) 표시', await vis(page, '#settings-loggedout'));
    check('로그인 블록(settings-loggedin) 숨김', !(await vis(page, '#settings-loggedin')));
    // GOOGLE_CLIENT_ID 미설정 → noclient 안내 노출
    check('클라이언트ID 미설정 안내 노출', await vis(page, '#settings-noclient'));

    // ── 4) 설정 패널 닫기 ──
    await clickEv(page, '#settings-close');
    await page.waitForTimeout(400);
    check('설정 모달 닫힘', await page.evaluate(() => { const m = document.getElementById('settings-modal'); return m && m.classList.contains('hidden'); }));

    // ── 5) 디자이너 권한 시뮬레이션 → 편집 모드 전환 ──
    //   (실제 구글 로그인 대신 Auth 상태를 주입해 UI 로직만 검증)
    await page.evaluate(() => {
      const A = window.__wm.Auth;
      A.user = { email: 'designer@example.com', name: '테스트 디자이너', picture: '', role: 'designer' };
      A.role = 'designer';
      A._applyUi();
    });
    await clickEv(page, '#btn-settings');
    await page.waitForTimeout(300);
    check('로그인 후: 로그인 블록 표시', await vis(page, '#settings-loggedin'));
    check('로그인 후: 미로그인 블록 숨김', !(await vis(page, '#settings-loggedout')));
    check('디자이너: "편집 모드로 전환" 노출', await vis(page, '#settings-designer-actions'));
    check('디자이너: 뷰어 안내 숨김', !(await vis(page, '#settings-viewer-note')));
    check('디자이너(슈퍼 아님): 디자이너 관리 숨김', !(await vis(page, '#settings-super-actions')));
    const sName = await page.evaluate(() => document.getElementById('settings-name').textContent);
    check('설정 패널 이름 표시', /테스트 디자이너/.test(sName), sName);

    // 편집 모드 전환
    await clickEv(page, '#btn-go-edit');
    await page.waitForTimeout(500);
    const m2 = await page.evaluate(() => window.__wm.State.mode);
    check('편집 모드 전환됨(mode=designer)', m2 === 'designer', `mode=${m2}`);
    check('편집 모드: "뷰어로" 버튼 노출', await vis(page, '#btn-exit-edit'));
    check('편집 모드: 프로젝트 섹션 표시', await vis(page, '#section-projects'));

    // ── 6) "뷰어로" → 뷰어 복귀 ──
    await clickEv(page, '#btn-exit-edit');
    await page.waitForTimeout(500);
    const m3 = await page.evaluate(() => window.__wm.State.mode);
    check('뷰어로 복귀(mode=viewer)', m3 === 'viewer', `mode=${m3}`);
    check('뷰어 복귀: 프로젝트 섹션 숨김', !(await vis(page, '#section-projects')));

    // ── 7) 슈퍼관리자 시뮬레이션 → 디자이너 관리 버튼 노출 ──
    await page.evaluate(() => {
      const A = window.__wm.Auth;
      A.user = { email: 'designssir@gmail.com', name: '슈퍼관리자', picture: '', role: 'super' };
      A.role = 'super';
      A._applyUi();
    });
    await clickEv(page, '#btn-settings');
    await page.waitForTimeout(300);
    check('슈퍼관리자: 디자이너 관리 버튼 노출', await vis(page, '#settings-super-actions'));
    check('슈퍼관리자: 편집 모드 전환 노출', await vis(page, '#settings-designer-actions'));
    const sRole = await page.evaluate(() => document.getElementById('settings-role').textContent);
    check('슈퍼관리자 역할 라벨', /슈퍼관리자/.test(sRole), sRole);

    // ── 8) 로그아웃 → 미로그인 블록 복귀 ──
    await clickEv(page, '#btn-settings-signout');
    await page.waitForTimeout(300);
    const loggedOut = await page.evaluate(() => window.__wm.Auth.role);
    check('로그아웃 후 role=viewer', loggedOut === 'viewer', loggedOut);
    check('로그아웃 후 미로그인 블록 표시', await vis(page, '#settings-loggedout'));

    await page.close();
  } catch (e) {
    fail++; results.push(`  ❌ EXCEPTION: ${e.message}`);
  } finally {
    await browser.close();
  }

  console.log('\n' + results.join('\n'));
  console.log(`\n  ── 결과: ${pass} PASS / ${fail} FAIL ──\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
