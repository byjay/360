#!/usr/bin/env node
// build-tools/seed-local.mjs — 로컬 D1(.tmp/localdev-state)에만 테스트 계정 3개 + 샘플 프로젝트 1개를 심는다.
// 🔴 prod 절대 금지 — build-tools/local-dev.mjs 로 먼저 .tmp/localdev/ 를 빌드해 둔 뒤 실행한다.
//
// 사용: node build-tools/seed-local.mjs
//
// 계정 3개(로컬 세션 방식, local_users 재사용):
//   · 최고관리자 — wrangler.jsonc SUPER_ADMIN_EMAIL(designssir@gmail.com)과 동일 이메일
//     (로컬 SQLite 전용 — prod Google OAuth 계정과 무관. isSuperAdmin() 은 이메일 문자열만 비교한다)
//   · 디자이너   — designer@test.local (designers 테이블에도 등록)
//   · 열람자     — viewer@test.local
// 비밀번호는 실행마다 무작위 생성 → .tmp/local-test-accounts.json(gitignore) 에만 기록, 콘솔엔 이메일만.
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

// 🔴 가드: 이 스크립트에 --remote 가 섞여 들어오면 즉시 종료(prod D1 오염 방지)
if (process.argv.includes('--remote')) {
  console.error('[seed-local] 🔴 --remote 금지 — 이 스크립트는 로컬 D1 전용이다. 즉시 종료.');
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, '.tmp');
const WORK = path.join(TMP, 'localdev');
const STATE = path.join(TMP, 'localdev-state');
const DB_NAME = 'webapp-production';
const SUPER_EMAIL = 'designssir@gmail.com';     // wrangler.jsonc SUPER_ADMIN_EMAIL 과 동일(로컬 전용 계정)
const DESIGNER_EMAIL = 'designer@test.local';
const VIEWER_EMAIL = 'viewer@test.local';
const TEST_DOMAIN = 'test.local';

if (!fs.existsSync(WORK)) {
  console.error('[seed-local] .tmp/localdev 없음 — 먼저 node build-tools/local-dev.mjs 를 실행하세요.');
  process.exit(1);
}

function sh(cmd, cwd = WORK) {
  console.log('[seed-local] $ ' + cmd);
  return execSync(cmd, { cwd, env: { ...process.env, TEMP: TMP, TMP: TMP }, encoding: 'utf8' });
}

// ── src/lib/util.ts 의 실제 해시 함수를 esbuild 로 그 자리에서 변환해 재사용(SoT, 로직 복제 금지) ──
async function loadUtil() {
  const esbuildBin = path.join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js');
  const esbuild = await import(pathToFileURL(esbuildBin).href);
  const tsPath = path.join(WORK, 'src', 'lib', 'util.ts');
  const tsSrc = fs.readFileSync(tsPath, 'utf8');
  const { code } = esbuild.transformSync(tsSrc, { loader: 'ts', format: 'esm' });
  const outFile = path.join(TMP, '_seed-util.mjs');
  fs.writeFileSync(outFile, code);
  const mod = await import(pathToFileURL(outFile).href + '?t=' + Date.now());
  fs.rmSync(outFile, { force: true });
  return mod;
}

function randPassword() {
  return crypto.randomBytes(18).toString('base64url'); // 24자, 암호난수
}

function d1(sqlFile) {
  sh(`node node_modules/wrangler/bin/wrangler.js d1 execute ${DB_NAME} --local --persist-to "${STATE}" --file "${sqlFile}"`);
}

function esc(s) {
  return String(s).replace(/'/g, "''");
}

// 1x1 최소 유효 JPEG(검정 1px) — 360 핀 테스트 이미지(리포지토리에 재사용 가능한 픽스처 없어 최소 생성)
const TINY_JPEG_DATAURL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLFRgTEA4dHyMgHx0cICAjJSYlJSIjJioqKSo2NTU7Oz1GSUA/RUdHSUdM/9sAQwEICQkMCwsVDQ0VIhUXFSIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAEAG//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAQIAAAAAAAAAAAAAAAAAAQIRAwBBUWH/2Q==';

async function main() {
  const util = await loadUtil();
  const now = Date.now();
  const sqlLines = [];

  // ── 계정 3개 ──
  const accounts = [
    { email: SUPER_EMAIL, name: 'SUPER(local)', role: 'super' },
    { email: DESIGNER_EMAIL, name: 'DESIGNER(local)', role: 'designer' },
    { email: VIEWER_EMAIL, name: 'VIEWER(local)', role: 'viewer' },
  ];
  const creds = [];
  for (const a of accounts) {
    const pw = randPassword();
    const { hash, salt } = await util.hashPassword(pw);
    const domain = util.emailDomain(a.email);
    sqlLines.push(
      `INSERT INTO local_users (email, name, domain, company, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES ` +
      `('${esc(a.email)}', '${esc(a.name)}', '${esc(domain)}', 'SEASTAR-LOCAL-TEST', '${hash}', '${salt}', 1, ${now}, ${now}, 0) ` +
      `ON CONFLICT(email) DO UPDATE SET pw_hash=excluded.pw_hash, pw_salt=excluded.pw_salt, updated_at=excluded.updated_at, deleted=0;`
    );
    creds.push({ email: a.email, role: a.role, password: pw });
  }
  // 디자이너 권한 테이블 등록(로컬 전용 — isDesigner() 가 designers 테이블을 조회한다)
  sqlLines.push(
    `INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES ` +
    `('${esc(DESIGNER_EMAIL)}', 'DESIGNER(local)', '${esc(SUPER_EMAIL)}', ${now}, ${now}, 0) ` +
    `ON CONFLICT(email) DO UPDATE SET deleted=0, updated_at=excluded.updated_at;`
  );
  // 테스트 도메인 허용(자체가입 UI 테스트용 — 로그인 자체엔 불필요하지만 실제 가입 정책과 일치)
  sqlLines.push(
    `INSERT INTO allowed_domains (id, project_id, domain, note, added_by, created_at, deleted) VALUES ` +
    `('ad_localseed_${TEST_DOMAIN}', '*', '${esc(TEST_DOMAIN)}', 'local seed', '${esc(SUPER_EMAIL)}', ${now}, 0) ` +
    `ON CONFLICT(project_id, domain) DO UPDATE SET deleted=0;`
  );

  // ── 샘플 프로젝트 + 원본 도면 + 구역/영역 + 핀 ──
  const projId = 'proj_localseed';
  const depId = 'dep_localseed_original';
  const zoneId = 'dk_localseed_zoneA';
  const areaId = 'dk_localseed_zoneA_area1';
  const panoIds = ['pano_localseed_1', 'pano_localseed_2'];

  sqlLines.push(
    `INSERT INTO projects (id, name, description, owner, tenant_id, created_at, updated_at, deleted, original_deployment_id) VALUES ` +
    `('${projId}', '로컬 테스트 프로젝트', 'local-dev 시드 — 로그인/화면 테스트용', '${esc(SUPER_EMAIL)}', 'tnt_default', ${now}, ${now}, 0, '${depId}') ` +
    `ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, deleted=0;`
  );
  sqlLines.push(
    `INSERT INTO project_members (project_id, email, role, granted_by, created_at) VALUES ` +
    `('${projId}', '${esc(DESIGNER_EMAIL)}', 'designer', '${esc(SUPER_EMAIL)}', ${now}) ` +
    `ON CONFLICT(project_id, email) DO UPDATE SET role=excluded.role;`
  );
  sqlLines.push(
    `INSERT INTO project_members (project_id, email, role, granted_by, created_at) VALUES ` +
    `('${projId}', '${esc(VIEWER_EMAIL)}', 'viewer', '${esc(SUPER_EMAIL)}', ${now}) ` +
    `ON CONFLICT(project_id, email) DO UPDATE SET role=excluded.role;`
  );

  // pano_images(360 테스트 이미지 2개 — 리포지토리 픽스처 부재로 최소 유효 JPEG 생성)
  for (let i = 0; i < panoIds.length; i++) {
    sqlLines.push(
      `INSERT INTO pano_images (id, name, image_data, width, height, created_at, updated_at, deleted, tenant_id) VALUES ` +
      `('${panoIds[i]}', '360 테스트 ${i + 1}', '${TINY_JPEG_DATAURL}', 1, 1, ${now}, ${now}, 0, 'tnt_default') ` +
      `ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, deleted=0;`
    );
  }

  // 핀: CHECKER 5개(checkboard=true) + 360 2개(imageId 참조, checkboard 필드 생략)
  const pins = [];
  for (let n = 1; n <= 5; n++) {
    pins.push({ id: now + n, createdAt: now + n, x: 10 + n * 8, y: 15 + n * 6, page: 1, label: String(n), checkboard: true, author: DESIGNER_EMAIL });
  }
  for (let n = 1; n <= 2; n++) {
    pins.push({ id: now + 100 + n, createdAt: now + 100 + n, x: 60 + n * 8, y: 70, page: 1, label: String(n), imageId: panoIds[n - 1], author: DESIGNER_EMAIL });
  }
  const pinsJson = esc(JSON.stringify(pins));

  // pages_data: 실제 ga.pdf 래스터화는 하지 않음(헤드리스 PDF.js 렌더는 이 스크립트 범위 밖·무거움).
  //   구조적 등록만 수행 — source_meta.pdf_url 이 R2 의 실제 ga.pdf 를 가리킨다(아래 업로드).
  const pagesData = esc(JSON.stringify([TINY_JPEG_DATAURL]));
  let sourceMeta = 'NULL';
  const gaPdf = path.join(TMP, 'ga.pdf');
  if (fs.existsSync(gaPdf)) {
    try {
      sh(`node node_modules/wrangler/bin/wrangler.js r2 object put seastar-assets/localseed/ga.pdf --local --persist-to "${STATE}" --file "${gaPdf.replace(/\\/g, '/')}" --content-type application/pdf`);
      sourceMeta = `'${esc(JSON.stringify({ v: 1, pdf_url: '/api/r2/object/localseed/ga.pdf', pages: [{ w: 1, h: 1, pw: 1, ph: 1 }] }))}'`;
    } catch (e) {
      console.warn('[seed-local] R2 로컬 업로드 실패(무시) — source_meta 는 NULL로 둠: ' + String(e.message).split('\n')[0]);
    }
  }

  sqlLines.push(
    `INSERT INTO deployments (id, title, file_name, pages_data, pins, zones, annotations, created_at, updated_at, deleted, tenant_id, version, project_id, source_meta) VALUES ` +
    `('${depId}', '원본 도면(local seed)', 'ga.pdf', '${pagesData}', '${pinsJson}', '[]', '[]', ${now}, ${now}, 0, 'tnt_default', 0, '${projId}', ${sourceMeta}) ` +
    `ON CONFLICT(id) DO UPDATE SET pins=excluded.pins, updated_at=excluded.updated_at, deleted=0;`
  );

  // 구역(최상위, parent_id NULL) + 영역(구역 하위, parent_id=구역)
  sqlLines.push(
    `INSERT INTO decks (id, project_id, name, deployment_id, page, parent_id, created_at, updated_at, deleted) VALUES ` +
    `('${zoneId}', '${projId}', 'A구역', '${depId}', 1, NULL, ${now}, ${now}, 0) ` +
    `ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, deleted=0;`
  );
  sqlLines.push(
    `INSERT INTO decks (id, project_id, name, deployment_id, page, parent_id, created_at, updated_at, deleted) VALUES ` +
    `('${areaId}', '${projId}', 'A구역-1영역', '${depId}', 1, '${zoneId}', ${now}, ${now}, 0) ` +
    `ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, deleted=0;`
  );

  const sqlFile = path.join(TMP, '_seed-local.sql');
  fs.writeFileSync(sqlFile, sqlLines.join('\n') + '\n', 'utf8');
  d1(sqlFile);
  fs.rmSync(sqlFile, { force: true });

  // ── 자격증명 파일(gitignore 확인 — .tmp/ 전체가 이미 무시됨) ──
  const credFile = path.join(TMP, 'local-test-accounts.json');
  fs.writeFileSync(credFile, JSON.stringify({ generated_at: new Date(now).toISOString(), accounts: creds }, null, 2), 'utf8');

  console.log('[seed-local] 완료. 계정 이메일(비밀번호는 ' + credFile + ' 참조, 콘솔 미출력):');
  for (const c of creds) console.log('  - ' + c.role + ': ' + c.email);
  console.log('[seed-local] 샘플 프로젝트: ' + projId + ' (구역 ' + zoneId + ' > 영역 ' + areaId + ', 핀 ' + pins.length + '개)');
}

main().catch((e) => { console.error('[seed-local] 실패:', e); process.exit(1); });
