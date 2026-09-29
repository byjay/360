#!/usr/bin/env node
/**
 * stamp-version.mjs — 정적 자산 콘텐츠 해시를 index.html 참조에 ?v= 로 박아
 * Cloudflare 존의 Browser Cache TTL(4h, max-age=14400)을 무력화한다.
 *
 * 배경(2026-09-29 지휘자 재현): _headers 로 no-cache 를 내려도 CF 존 설정이
 * 원 헤더를 덮어써 js/css 가 최대 4시간 구버전으로 남는다. 존 설정은 건드리지
 * 않고(다른 사이트 영향) 파일명 자체를 바꿔 캐시를 무력화한다.
 *
 * 대상: public/index.html 이 참조하는 로컬 정적 자산(외부 CDN 링크는 제외)
 *   - js/main.js
 *   - css/style.css, css/seastar-family-tokens.css, css/seastar-3d-skin.css
 *
 * 멱등: 파일 내용이 그대로면 해시도 그대로 → 몇 번을 돌려도 결과가 같다.
 * 기존 ?v=... 쿼리가 있으면 새 해시로 교체(누적 없음).
 *
 * 실행: node build-tools/stamp-version.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// index.html 이 참조하는, 이 빌드가 직접 만들어내는 로컬 정적 자산만 대상.
export const TARGETS = [
  'js/main.js',
  'css/style.css',
  'css/seastar-family-tokens.css',
  'css/seastar-3d-skin.css',
];

export function hashOf(root, relPath) {
  const abs = path.join(root, 'public', relPath);
  const buf = fs.readFileSync(abs);
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
}

export function stampHtml(root, html, targets = TARGETS) {
  let out = html;
  for (const rel of targets) {
    const hash = hashOf(root, rel);
    const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // href="/css/x.css" 또는 src="/js/x.js" — 기존 ?v=... 있으면 교체, 없으면 추가.
    const re = new RegExp(`((?:href|src)=")(/${escaped})(?:\\?v=[a-f0-9]+)?(")`, 'g');
    out = out.replace(re, (_m, p1, p2, p3) => `${p1}${p2}?v=${hash}${p3}`);
  }
  return out;
}

export function run(root = ROOT) {
  const htmlPath = path.join(root, 'public', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const stamped = stampHtml(root, html);
  fs.writeFileSync(htmlPath, stamped, 'utf8');
  // 루트 미러 동기화 — p61 등 "미러 동기화" 검증 유지(공유 페이지도 같은 index.html 사용).
  const rootHtmlPath = path.join(root, 'index.html');
  if (fs.existsSync(rootHtmlPath)) fs.writeFileSync(rootHtmlPath, stamped, 'utf8');
  console.log('[stamp-version] index.html 자산 해시 갱신 완료');
  return stamped;
}

// CLI 직접 실행 시에만 동작(테스트에서 import 시 자동실행 방지)
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  run();
}
