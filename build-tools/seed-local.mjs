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
import zlib from 'node:zlib';
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

// ── 최소 PNG 인코더(stdlib zlib 만 사용 — 신규 의존성 0) ──────────────────────────────
// 8bit grayscale, 필터 없음(filter byte 0 고정). 도면/360 placeholder 를 "실제 크기"로
// 만들기 위함 — 종전 1x1 TINY_JPEG 은 naturalWidth=1 이라 핀 마커 스케일이 폭주했다(R1 재현).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
/** 8bit grayscale PNG 데이터URL. pixelFn(x,y) => 0..255 */
function pngDataUrl(width, height, pixelFn) {
  const raw = Buffer.alloc((width + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width; x++) raw[p++] = pixelFn(x, y) & 0xFF;
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // bitdepth8,grayscale,...
  const png = Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + png.toString('base64');
}

// ── 도면 placeholder: 실제 비율 평면도(격자 "방" 윤곽) ──────────────────────────────
// 4x3 격자(여백 5%). 구역(zoneB)의 crop% 은 이 격자 경계와 정확히 일치시켜
// 도면 위에서 "의미 있는 방 하나"로 보이게 한다.
const DRAWING_W = 2400, DRAWING_H = 1700;
const GRID_COLS = 4, GRID_ROWS = 3, MARGIN_PCT = 5, LINE_PX = 4;
const CELL_W_PCT = (100 - MARGIN_PCT * 2) / GRID_COLS;
const CELL_H_PCT = (100 - MARGIN_PCT * 2) / GRID_ROWS;
function pctToPx(pct, dim) { return Math.round(pct / 100 * dim); }
function drawingPixel(x, y) {
  const onV = (pct) => Math.abs(x - pctToPx(pct, DRAWING_W)) <= LINE_PX / 2;
  const onH = (pct) => Math.abs(y - pctToPx(pct, DRAWING_H)) <= LINE_PX / 2;
  if (onV(MARGIN_PCT) || onV(100 - MARGIN_PCT) || onH(MARGIN_PCT) || onH(100 - MARGIN_PCT)) return 20;
  for (let i = 1; i < GRID_COLS; i++) { if (onV(MARGIN_PCT + CELL_W_PCT * i)) return 60; }
  for (let j = 1; j < GRID_ROWS; j++) { if (onH(MARGIN_PCT + CELL_H_PCT * j)) return 60; }
  return 250;
}
// zoneB(아래) 가 도면 위에서 가리킬 방 — 격자 col=1,row=1 (0-base)
const ZONEB_CROP = {
  x: MARGIN_PCT + CELL_W_PCT * 1, y: MARGIN_PCT + CELL_H_PCT * 1,
  w: CELL_W_PCT, h: CELL_H_PCT,
};

// ── 360 placeholder: 실제 비율 equirectangular(수평선 + 8분할 세로선) ──────────────
const PANO_W = 1024, PANO_H = 512;
function panoPixel(x, y) {
  const horizon = PANO_H / 2;
  if (x % 128 < 2) return 10;
  if (Math.abs(y - horizon) <= 2) return 10;
  if (y < horizon) return Math.round(225 - (horizon - y) / horizon * 55);
  return Math.round(95 + (y - horizon) / horizon * 55);
}
const DRAWING_DATAURL = pngDataUrl(DRAWING_W, DRAWING_H, drawingPixel);
const PANO_DATAURL = pngDataUrl(PANO_W, PANO_H, panoPixel);

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
  const zoneBId = 'dk_localseed_zoneB';
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

  // pano_images(360 테스트 이미지 2개 — 실제 비율 equirectangular PNG, zlib 직접 인코딩)
  for (let i = 0; i < panoIds.length; i++) {
    sqlLines.push(
      `INSERT INTO pano_images (id, name, image_data, width, height, created_at, updated_at, deleted, tenant_id) VALUES ` +
      `('${panoIds[i]}', '360 테스트 ${i + 1}', '${esc(PANO_DATAURL)}', ${PANO_W}, ${PANO_H}, ${now}, ${now}, 0, 'tnt_default') ` +
      `ON CONFLICT(id) DO UPDATE SET image_data=excluded.image_data, width=excluded.width, height=excluded.height, updated_at=excluded.updated_at, deleted=0;`
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

  // pages_data: 실제 비율(2400x1700) 평면도 placeholder PNG — naturalWidth/Height 가 1 이던
  //   종전 TINY_JPEG 폭주(R1 재현: 마커 5796x10212px)를 없앤다. ga.pdf 래스터화는 여전히 범위 밖
  //   (헤드리스 PDF.js 렌더는 무거움) — source_meta.pdf_url 은 있으면 실제 ga.pdf 를 가리킨다(아래 업로드).
  const pagesData = esc(JSON.stringify([DRAWING_DATAURL]));
  let sourceMeta = 'NULL';
  const gaPdf = path.join(TMP, 'ga.pdf');
  if (fs.existsSync(gaPdf)) {
    try {
      sh(`node node_modules/wrangler/bin/wrangler.js r2 object put seastar-assets/localseed/ga.pdf --local --persist-to "${STATE}" --file "${gaPdf.replace(/\\/g, '/')}" --content-type application/pdf`);
      sourceMeta = `'${esc(JSON.stringify({ v: 1, pdf_url: '/api/r2/object/localseed/ga.pdf', pages: [{ w: DRAWING_W, h: DRAWING_H, pw: DRAWING_W, ph: DRAWING_H }] }))}'`;
    } catch (e) {
      console.warn('[seed-local] R2 로컬 업로드 실패(무시) — source_meta 는 NULL로 둠: ' + String(e.message).split('\n')[0]);
    }
  }

  sqlLines.push(
    `INSERT INTO deployments (id, title, file_name, pages_data, pins, zones, annotations, created_at, updated_at, deleted, tenant_id, version, project_id, source_meta) VALUES ` +
    `('${depId}', '원본 도면(local seed)', 'ga.pdf', '${pagesData}', '${pinsJson}', '[]', '[]', ${now}, ${now}, 0, 'tnt_default', 0, '${projId}', ${sourceMeta}) ` +
    `ON CONFLICT(id) DO UPDATE SET pins=excluded.pins, pages_data=excluded.pages_data, source_meta=excluded.source_meta, updated_at=excluded.updated_at, deleted=0;`
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
  // zoneB — 메인 도면에서 "창 방식"으로 잘라 만든 구역(crop% = 격자 방 하나, 46_DeckOutline 윤곽 표시 확인용)
  sqlLines.push(
    `INSERT INTO decks (id, project_id, name, deployment_id, page, crop, parent_id, created_at, updated_at, deleted) VALUES ` +
    `('${zoneBId}', '${projId}', 'B구역(메인 크롭)', '${depId}', 1, '${esc(JSON.stringify(ZONEB_CROP))}', NULL, ${now}, ${now}, 0) ` +
    `ON CONFLICT(id) DO UPDATE SET crop=excluded.crop, updated_at=excluded.updated_at, deleted=0;`
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
  console.log('[seed-local] 샘플 프로젝트: ' + projId + ' (구역 ' + zoneId + ' > 영역 ' + areaId + ', 구역 ' + zoneBId + '[crop], 핀 ' + pins.length + '개)');
  console.log('[seed-local] 도면 ' + DRAWING_W + 'x' + DRAWING_H + 'px, 360 placeholder ' + PANO_W + 'x' + PANO_H + 'px (zlib PNG, 신규 의존성 0)');
}

main().catch((e) => { console.error('[seed-local] 실패:', e); process.exit(1); });
