#!/usr/bin/env node
// build-tools/aivision-realcall.mjs — [WO 20261007-aivision] 실제 OpenRouter 비전 호출 1회(과금 발생).
// 🔴 지휘자 승인 후에만 실행한다. 서버 라우트를 거치지 않고 src/lib/aiVision.ts(SoT) 의 askVision 을 그대로 호출해
//    응답 구조(스키마 검증 통과)·토큰·비용(usage.cost)을 실증한다. 키는 _warehouse/secrets.json(openrouter.apiKey)에서만 읽고 출력하지 않는다.
//
// 사용: node build-tools/aivision-realcall.mjs <image.jpg|png> [compare.jpg] [--label "위치명"]
//   예) node build-tools/aivision-realcall.mjs .tmp/sample360.jpg
// 출력: 모델 · ms · usage(prompt/completion/cost_usd) · 결과 JSON(요약·항목·결함 제안) — .tmp/aivision-realcall.json 에도 저장
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const li = args.indexOf('--label');
const label = li >= 0 ? args[li + 1] : '';
const files = args.filter((a, i) => a !== '--label' && i !== li + 1);
if (!files.length) { console.error('사용: node build-tools/aivision-realcall.mjs <image> [compare] [--label 위치명]'); process.exit(2); }

const secretsPath = process.env.SECRETS_JSON || 'E:/code-project/_warehouse/secrets.json';
let key = process.env.OPENROUTER_API_KEY || '';
if (!key) { try { key = JSON.parse(fs.readFileSync(secretsPath, 'utf8')).openrouter.apiKey; } catch (e) {} }
if (!key) { console.error('OPENROUTER_API_KEY 없음(환경변수 또는 _warehouse/secrets.json openrouter.apiKey)'); process.exit(2); }

const toDataUrl = (p) => {
  const buf = fs.readFileSync(p);
  const ext = path.extname(p).toLowerCase();
  const ct = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  if (buf.length > 4 * 1024 * 1024) { console.error(p + ': 4MB 초과 — 서버와 같은 상한. 축소본을 쓰세요.'); process.exit(2); }
  return { url: `data:${ct};base64,` + buf.toString('base64'), bytes: buf.length };
};

const esbuild = await import(pathToFileURL(path.join(ROOT, 'node_modules/esbuild/lib/main.js')).href);
const out = path.join(os.tmpdir(), 'aivision-realcall-' + process.pid + '.mjs');
await esbuild.build({ entryPoints: [path.join(ROOT, 'src/lib/aiVision.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile: out, logLevel: 'silent' });
const L = await import(pathToFileURL(out).href);
try { fs.unlinkSync(out); } catch (e) {}

const img = toDataUrl(files[0]);
const cmp = files[1] ? toDataUrl(files[1]) : null;
console.log(`[realcall] 모델 ${L.visionModelOf(process.env)} · 현재 ${img.bytes}B` + (cmp ? ` · 비교 ${cmp.bytes}B` : '') + ' · 호출 1회(과금)');
const t0 = Date.now();
const probe = await L.askVision({ OPENROUTER_API_KEY: key, AI_VISION_MODEL: process.env.AI_VISION_MODEL }, { imageDataUrl: img.url, compareDataUrl: cmp ? cmp.url : null, pinLabel: label });
const report = { at: new Date().toISOString(), ms: Date.now() - t0, image: files[0], compare: files[1] || null, probe: probe.ok ? { ok: true, model: probe.model, usage: probe.usage, result: probe.value } : probe };
fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '.tmp/aivision-realcall.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(probe.ok ? 0 : 1);
