# 로컬 개발 환경 (local-dev)

마스터 지시(2026-10-02): "모든 TEST는 로컬에서 하고 빌드해" + "로컬 관리자·최고관리자 계정을 만들어서".
지휘자가 내장 브라우저로 **localhost**에서 로그인해 화면을 테스트하기 위한 격리 로컬 환경.

## 사용법
1. 빌드(HEAD를 `.tmp/localdev/`에 격리 추출 → 조립 → vite build → D1 로컬 마이그레이션):
   `node build-tools/local-dev.mjs`  (상태 초기화는 `--fresh`)
2. 시드(계정 3개 + 샘플 프로젝트 — 로컬 D1에만, prod 절대 금지):
   `node build-tools/seed-local.mjs`
3. 서버 실행: `.claude/launch.json`의 `"360-local"` 구성(포트 자동 배정) 또는 직접:
   `node node_modules/wrangler/bin/wrangler.js pages dev .tmp/localdev/dist --d1=webapp-production --local --persist-to .tmp/localdev-state --ip 127.0.0.1 --port 8799`
4. 로그인: 메인화면 → "회사 이메일로 가입/로그인" → 계정 이메일은 아래 참조, 비밀번호는
   `.tmp/local-test-accounts.json`(gitignore, 매 시드마다 무작위 재생성·콘솔 미출력)만 참조.
5. 계정: 최고관리자(`designssir@gmail.com`, 로컬 전용 — prod Google 계정과 무관) · 디자이너(`designer@test.local`) ·
   열람자(`viewer@test.local`). 샘플 프로젝트 `proj_localseed`(구역 1 > 영역 1, CHECKER 핀 5 + 360 핀 2).

## 범위/한계
- `pages_data`는 실제 ga.pdf 래스터화가 아니라 **실제 비율(2400x1700) 평면도 placeholder PNG**다
  (4x3 격자 "방" 윤곽, zlib 직접 인코딩 — 신규 의존성 0). 종전 1x1 TINY_JPEG은 naturalWidth=1 이라
  핀 마커 스케일이 폭주(5796x10212px, 화면 밖)했다 — 이제 모바일 375px 화면 테스트가 가능하다.
  360 placeholder(1024x512 equirectangular)도 같은 방식. 헤드리스 PDF.js 렌더(ga.pdf 실제 래스터화)는
  여전히 범위 밖. 원본 PDF 자체는 로컬 R2(`.tmp/localdev-state`)에 `localseed/ga.pdf`로 업로드되어 있다.
  샘플 프로젝트에는 메인에서 잘라 만든 구역(`dk_localseed_zoneB`, crop=격자 방 하나)도 포함된다
  (46_DeckOutline 윤곽 표시 확인용).
- `.tmp/localdev/.dev.vars`에는 외부 키(Firebase/Resend 등)를 넣지 않는다 — 로컬 세션(`local-` 토큰) 로그인만 검증 대상.
- 재실행은 멱등(이미 적용된 마이그레이션/계정은 덮어쓰기 또는 스킵).
