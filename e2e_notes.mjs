// e2e_notes.mjs — 이슈/필드노트 협업 기능 E2E (Task #1)
// 검증: 노트 패널 열기, 익명 노트 생성, 상태 변경, 필터, 핀 뱃지(리스트/도면), 권한, summary
import pw from '/opt/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.js';
const { chromium } = pw;

const BASE = 'http://localhost:3000';
const DEP = 'dep_mq90aup0_s4qdz0za'; // 로컬 D1에 존재하는 배포본 id

let pass = 0, fail = 0;
const results = [];
function check(name, cond) {
  if (cond) { pass++; results.push(`  ✅ ${name}`); }
  else { fail++; results.push(`  ❌ ${name}`); }
}

// 사전: 로컬 D1 노트 비우기는 호출 측에서 수행. 여기선 API로 직접 시드 노트 정리.
async function clearNotes(page) {
  // designer 토큰으로 현 핀의 모든 노트 삭제
  await page.evaluate(async (dep) => {
    const r = await fetch('/api/notes?deployment_id=' + dep + '&pin_id=pin_e2e');
    const j = await r.json();
    for (const n of (j.data || [])) {
      await fetch('/api/notes/' + n.id, { method: 'DELETE', headers: { Authorization: 'Bearer demo-designer' } });
    }
  }, DEP);
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
    await page.waitForFunction(() => window.__wm && window.__wm.Notes, { timeout: 15000 });
    await page.waitForTimeout(500);

    // 1. __wm 훅에 Notes 존재
    check('1. window.__wm.Notes 존재', await page.evaluate(() => typeof window.__wm.Notes === 'object'));

    // 2. 배포본 id 주입 + 테스트 핀 주입
    await page.evaluate((dep) => {
      window.__wm.State.currentDeploymentId = dep;
      window.__wm.State.pins = [];
      window.__wm.addPin({ id: 'pin_e2e', x: 40, y: 40, page: 1, label: '엔진룸 배관' });
    }, DEP);
    await clearNotes(page);
    check('2. 핀 주입 + currentDeploymentId 설정', await page.evaluate(() => window.__wm.State.currentDeploymentId === 'dep_mq90aup0_s4qdz0za'));

    // 3. 데모 설계자 로그인 (편집 권한 확보)
    await page.evaluate(() => window.__wm.Auth.demoLogin('designer'));
    await page.waitForTimeout(400);
    check('3. 데모 설계자 로그인 (isDesigner)', await page.evaluate(() => window.__wm.Auth.isDesigner === true));

    // 4. Notes.setPin + openPanel → 패널 표시
    await page.evaluate(() => {
      const pin = window.__wm.State.pins.find(p => p.id === 'pin_e2e');
      window.__wm.Notes.setPin(pin);
      window.__wm.Notes.openPanel();
    });
    await page.waitForTimeout(500);
    check('4. 노트 패널 열림 (hidden 제거)', await page.evaluate(() => {
      const p = document.getElementById('pano-notes-panel');
      return p && !p.classList.contains('hidden');
    }));
    check('4b. 패널 핀 라벨 표시', await page.evaluate(() => {
      const l = document.getElementById('pnp-pin-label');
      return l && l.textContent.includes('엔진룸');
    }));

    // 5. 노트 작성 (폼 입력 → submit)
    await page.evaluate(() => {
      document.getElementById('pnp-input').value = '배관 누수 의심, 점검 요망';
      const a = document.getElementById('pnp-assignee'); if (a) a.value = '김현장';
      const s = document.getElementById('pnp-status-sel'); if (s) s.value = 'open';
    });
    await page.evaluate(() => window.__wm.Notes.submit());
    await page.waitForTimeout(800);
    check('5. 노트 1건 생성됨 (리스트 렌더)', await page.evaluate(() => {
      return document.querySelectorAll('#pnp-list .pnp-item').length === 1;
    }));
    check('5b. 노트 본문 표시', await page.evaluate(() => {
      const b = document.querySelector('#pnp-list .pnp-body');
      return b && b.textContent.includes('배관 누수');
    }));
    check('5c. 담당자 태그 표시', await page.evaluate(() => {
      const t = document.querySelector('#pnp-list .pnp-assignee-tag');
      return t && t.textContent.includes('김현장');
    }));

    // 6. 두 번째 노트(progress) 추가
    await page.evaluate(() => {
      document.getElementById('pnp-input').value = '용접부 재검사 진행';
      const s = document.getElementById('pnp-status-sel'); if (s) s.value = 'progress';
      window.__wm.Notes.submit();
    });
    await page.waitForTimeout(800);
    check('6. 노트 2건 (open+progress)', await page.evaluate(() => {
      return document.querySelectorAll('#pnp-list .pnp-item').length === 2;
    }));

    // 7. summary 로드 → 핀 뱃지 (미해결 카운트)
    await page.evaluate(() => window.__wm.Notes.loadSummary());
    await page.waitForTimeout(500);
    check('7. summary 미해결 카운트=2', await page.evaluate(() => {
      return window.__wm.Notes.openCountFor('pin_e2e') === 2;
    }));
    check('7b. 리스트 핀 이슈 뱃지 표시', await page.evaluate(() => {
      const badge = document.querySelector('#pin-list .pin-issue-badge, .pin-issue-badge');
      return !!badge;
    }));
    check('7c. 도면 핀 이슈 점 표시', await page.evaluate(() => {
      const dot = document.querySelector('.pin-marker-issue');
      return !!dot;
    }));

    // 8. 상태 변경 (progress → done) via updateStatus
    const firstId = await page.evaluate(() => {
      const it = document.querySelector('#pnp-list .pnp-item');
      return it ? it.dataset.id : null;
    });
    await page.evaluate((id) => window.__wm.Notes.updateStatus(id, 'done'), firstId);
    await page.waitForTimeout(700);
    check('8. 상태 변경 → done 반영', await page.evaluate((id) => {
      const it = document.querySelector(`#pnp-list .pnp-item[data-id="${id}"]`);
      return it && it.classList.contains('st-done');
    }, firstId));

    // 9. 필터 (done만 보기)
    await page.evaluate(() => {
      const btn = document.querySelector('#pnp-filter .pnp-fbtn[data-f="done"]');
      if (btn) btn.click();
    });
    await page.waitForTimeout(400);
    check('9. done 필터 → 1건만 표시', await page.evaluate(() => {
      return document.querySelectorAll('#pnp-list .pnp-item').length === 1;
    }));
    // 전체 필터 복귀
    await page.evaluate(() => {
      const btn = document.querySelector('#pnp-filter .pnp-fbtn[data-f="all"]');
      if (btn) btn.click();
    });
    await page.waitForTimeout(300);
    check('9b. all 필터 → 2건 복귀', await page.evaluate(() => {
      return document.querySelectorAll('#pnp-list .pnp-item').length === 2;
    }));

    // 10. 미해결 카운트 갱신 (1 done → open 1개만 남음: progress→done 했으니 open만)
    check('10. done 처리 후 미해결 카운트 감소', await page.evaluate(() => {
      return window.__wm.Notes.openCountFor('pin_e2e') === 1;
    }));

    // 11. 헤더 이슈 카운트 뱃지
    check('11. 헤더 이슈 카운트 뱃지(total=2)', await page.evaluate(() => {
      const el = document.getElementById('pano-notes-count');
      return el && !el.classList.contains('hidden') && el.textContent === '2';
    }));

    // 12. 패널 닫기
    await page.evaluate(() => window.__wm.Notes.closePanel());
    await page.waitForTimeout(400);
    check('12. 패널 닫힘', await page.evaluate(() => {
      const p = document.getElementById('pano-notes-panel');
      return p && p.classList.contains('hidden');
    }));

    // 13. 권한: 뷰어로 전환 후 타인(설계자) 노트 수정 버튼 미노출
    await page.evaluate(() => window.__wm.Auth.demoLogin('viewer'));
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const pin = window.__wm.State.pins.find(p => p.id === 'pin_e2e');
      window.__wm.Notes.setPin(pin);
      window.__wm.Notes.openPanel();
    });
    await page.waitForTimeout(800);
    check('13. 뷰어는 타인 노트 상태버튼 미노출', await page.evaluate(() => {
      // 설계자가 만든 노트 → 뷰어에겐 .pnp-status-actions 없어야 함
      return document.querySelectorAll('#pnp-list .pnp-status-actions').length === 0;
    }));

    // 14. 삭제 (정리) — 설계자 토큰으로
    await page.evaluate(() => window.__wm.Auth.demoLogin('designer'));
    await page.waitForTimeout(300);
    await clearNotes(page);
    await page.evaluate(() => window.__wm.Notes.loadSummary());
    await page.waitForTimeout(500);
    check('14. 삭제 후 미해결 카운트=0', await page.evaluate(() => {
      return window.__wm.Notes.openCountFor('pin_e2e') === 0;
    }));

  } catch (e) {
    results.push(`  💥 EXCEPTION: ${e.message}`);
    fail++;
  } finally {
    await browser.close();
  }

  console.log('\n══════════ e2e_notes 결과 ══════════');
  console.log(results.join('\n'));
  console.log(`\n  PASS: ${pass}  FAIL: ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
})();
