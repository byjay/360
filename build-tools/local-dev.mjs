#!/usr/bin/env node
// build-tools/local-dev.mjs — 로컬 전용 빌드. HEAD 를 .tmp/localdev/ 에 git archive 로
// 격리 추출(작업트리의 타 팀 WIP 배제) → node_modules 정션 → .tmp/ga.pdf 복사 →
// assemble.py → stamp-version.mjs → 미러 cp → vite build → D1 로컬 마이그레이션 적용.
//
// 사용: node build-tools/local-dev.mjs [--fresh]
//   --fresh : .tmp/localdev-state(로컬 D1/R2 영속 상태) 삭제 후 처음부터.
//
// 🔴 CLAUDE.md §G-5 — C: 드라이브 금지. TEMP/TMP 는 항상 이 프로젝트 안 .tmp 로 고정한다
//   (프로젝트 밖 경로를 TEMP 로 쓰면 로컬 workerd 가 기동 실패한다 — 2026-09-28 실측).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, '.tmp');
const WORK = path.join(TMP, 'localdev');
const STATE = path.join(TMP, 'localdev-state');
const FRESH = process.argv.includes('--fresh');
const DB_NAME = 'webapp-production';

// cmd.exe 로 넘기는 경로 문자열은 슬래시로 통일한다 — 역슬래시가 git bash 의 tar(GNU tar)에
// 의해 에스케이프로 오인되어 "E\:\\code-project..." 처럼 깨지는 실측 오류를 피한다.
const toSh = (p) => p.replace(/\\/g, '/');

function sh(cmd, cwd = ROOT) {
  console.log('[local-dev] $ ' + cmd);
  execSync(cmd, {
    stdio: 'inherit',
    cwd,
    env: { ...process.env, TEMP: TMP, TMP: TMP },
  });
}

function trySh(cmd, cwd = ROOT) {
  try {
    sh(cmd, cwd);
    return true;
  } catch (e) {
    console.warn('[local-dev] 건너뜀(이미 적용됨 또는 무해한 중복 오류): ' + String(e.message).split('\n')[0]);
    return false;
  }
}

// 0) --fresh: 로컬 D1/R2 영속 상태 초기화 (정션이 아니라 상태 디렉터리 자체 — 삭제 안전)
if (FRESH && fs.existsSync(STATE)) {
  console.log('[local-dev] --fresh: ' + STATE + ' 삭제');
  try {
    // maxRetries/retryDelay: 방금 종료된 wrangler/miniflare 의 SQLite 캐시 파일이 OS 핸들 해제
    // 지연으로 잠깐 EBUSY 를 내는 경우를 흡수.
    fs.rmSync(STATE, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch (e) {
    // 🔴 이 Windows 머신엔 다른 세션의 wrangler/workerd 프로세스가 동시에 떠 있을 수 있다
    //   (CLAUDE.md §G-4⑥ — 공유 머신 가정). 남의 프로세스를 taskkill 하지 않고, 삭제 실패는
    //   경고로만 남긴다 — 다음 실행의 마이그레이션은 멱등이라 잔존 상태가 있어도 깨지지 않는다.
    console.warn('[local-dev] --fresh 일부 삭제 실패(다른 프로세스가 파일을 점유 중일 수 있음, 무시하고 계속): ' + e.message.split('\n')[0]);
  }
}

// 1) 작업트리 격리 추출(HEAD) — 다른 팀의 미커밋 WIP(src/index.tsx 등)를 배제한다.
fs.mkdirSync(TMP, { recursive: true });
if (fs.existsSync(WORK)) {
  // node_modules 는 정션(reparse point)이다 — 재귀 삭제가 그 안의 실제 node_modules(용량 큼,
  // 다른 프로세스가 일부 파일을 열어 둘 수 있음)까지 따라 들어가 EBUSY 를 내는 걸 피하려고
  // 정션 자체만 먼저 끊어낸다(rmdirSync 는 정션을 "따라가지 않고" 그 reparse point만 제거한다).
  const nmDstPre = path.join(WORK, 'node_modules');
  if (fs.existsSync(nmDstPre)) {
    try { fs.rmdirSync(nmDstPre); } catch (e) { console.warn('[local-dev] node_modules 정션 해제 실패(무시): ' + e.message.split('\n')[0]); }
  }
  try {
    fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch (e) {
    console.warn('[local-dev] 이전 .tmp/localdev 삭제 실패(다른 프로세스 점유 가능, 무시하고 덮어쓰기 진행): ' + e.message.split('\n')[0]);
  }
}
fs.mkdirSync(WORK, { recursive: true });
sh(`git archive HEAD | tar -x -C "${toSh(WORK)}"`);

// 2) node_modules 정션(복사 금지 — 용량/시간. mklink 는 cmd 내장이라 cmd /c 경유 필요)
const nmSrc = path.join(ROOT, 'node_modules');
const nmDst = path.join(WORK, 'node_modules');
if (!fs.existsSync(nmDst) && fs.existsSync(nmSrc)) {
  sh(`cmd /c mklink /J "${nmDst}" "${nmSrc}"`);
}

// 3) .tmp/ga.pdf 복사(시드 재료 — 원본 도면)
const gaSrc = path.join(TMP, 'ga.pdf');
if (fs.existsSync(gaSrc)) {
  const gaDstDir = path.join(WORK, '.tmp');
  fs.mkdirSync(gaDstDir, { recursive: true });
  fs.copyFileSync(gaSrc, path.join(gaDstDir, 'ga.pdf'));
} else {
  console.warn('[local-dev] .tmp/ga.pdf 없음 — 시드 스크립트가 원본 도면 등록을 건너뜁니다.');
}

// 4) 조립: assemble.py → stamp-version.mjs → 미러 cp → vite build
sh('python build-tools/assemble.py', WORK);
sh('node build-tools/stamp-version.mjs', WORK);

const MIRRORS = [
  ['public/js/main.js', 'js/main.js'],
  ['public/index.html', 'index.html'],
  ['public/css/style.css', 'css/style.css'],
  ['public/css/seastar-family-tokens.css', 'css/seastar-family-tokens.css'],
  ['public/css/seastar-3d-skin.css', 'css/seastar-3d-skin.css'],
  ['public/sw.js', 'sw.js'],
  ['public/js/firebase-init.js', 'js/firebase-init.js'],
];
for (const [src, dst] of MIRRORS) {
  const srcAbs = path.join(WORK, src);
  const dstAbs = path.join(WORK, dst);
  if (!fs.existsSync(srcAbs)) { console.warn('[local-dev] 미러 소스 없음: ' + src); continue; }
  fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
  fs.copyFileSync(srcAbs, dstAbs);
}

// 5) 로컬 전용 .dev.vars — 외부 키(Firebase/Resend 등) 없음. 로컬 세션 로그인만 사용.
fs.writeFileSync(
  path.join(WORK, '.dev.vars'),
  '# 로컬 전용(build-tools/local-dev.mjs 생성) — 외부 키 없음. 로컬 세션(local-) 로그인만 사용한다.\n'
);

sh('node --max-old-space-size=896 node_modules/vite/bin/vite.js build', WORK);

// 6) D1 로컬 마이그레이션 적용 — migrations/*.sql 전부, migrations/manual/ 은 디렉터리라
//    readdir 필터(.sql 확장자)에서 자연히 제외된다. 이미 적용된 ALTER/CREATE 는 중복 오류를
//    trySh 가 삼켜 멱등으로 만든다.
fs.mkdirSync(STATE, { recursive: true });
const migDir = path.join(WORK, 'migrations');
const files = fs.existsSync(migDir)
  ? fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()
  : [];
for (const f of files) {
  const file = path.join(migDir, f);
  trySh(`node node_modules/wrangler/bin/wrangler.js d1 execute ${DB_NAME} --local --persist-to "${STATE}" --file "${file}"`, WORK);
}

console.log('[local-dev] 완료 → ' + WORK);
console.log('[local-dev] D1 상태 → ' + STATE);
console.log('[local-dev] 다음: node build-tools/seed-local.mjs  (계정/샘플 프로젝트 시드)');
console.log('[local-dev] 실행: .claude/launch.json 구성 "360-local"');
