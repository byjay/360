#!/usr/bin/env node
/**
 * filemap.mjs — 모든 프로젝트에서 재사용 가능한 범용 파일맵 생성기.
 * "파일 목록 + 각 파일의 역할(첫 주석) + 정적 의존관계 트리맵"을 자동 생성한다.
 * 순수 정적 분석(런타임 실행 없음). chrome.runtime.getURL('literal') 처럼
 * 문자열 리터럴 인자는 잡아 고아에서 구제하지만, getURL(변수) 처럼 변수로
 * 조립된 경로는 정적으로 알 수 없어 여전히 고아로 남는다(알려진 한계).
 *
 * 사용:
 *   node filemap.mjs [--root=<경로>] [--out=<파일>] [--json] [--guard]
 *
 * 재사용 출처(로직만 참고, 신규 재작성 — CLAUDE.md §5 사다리):
 *   E:\code-project\_warehouse\05-scripts-build\scan-orphan-logic.mjs (walk 순회 패턴)
 *   E:\code-project\_warehouse\05-scripts-build\scan-orphan.mjs (importedBy 맵 구조)
 */
// [창고 부품] 프로젝트 전체 파일맵 생성기 — 파일목록 + 역할 + 의존 트리 + 고아
// 사용: node filemap.mjs [--root=<경로>] [--out=FILEMAP.md] [--json] [--guard]
// [SWAP] SKIP_DIRS 를 자기 프로젝트 구조에 맞게 조정.
// 한계(승계): getURL(변수) 처럼 런타임 조립 경로는 정적으로 알 수 없어 고아로 잡힌다.
//            역할은 파일 첫 10줄 주석에서만 추출한다 — 주석이 없으면 추측하지 않고 '미기재'로 둔다(§5 날조 금지).
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, relative, extname, sep, isAbsolute, basename } from 'path';
import { fileURLToPath } from 'url';

// ── CLI 인자 파싱 ──────────────────────────────────────────────
const argv = process.argv.slice(2);
function argVal(name, def) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const hasFlag = (name) => argv.includes(`--${name}`);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// ── 소스 루트 결정 ─────────────────────────────────────────────
// 기본값 = 스크립트 위치(import.meta.url 기준). process.cwd() 를 쓰면 어디서
// 실행하느냐에 따라 결과가 달라져 재사용성이 떨어지므로 채택하지 않는다.
const rootArg = argVal('root', null);
let ROOT = rootArg ? (isAbsolute(rootArg) ? rootArg : join(process.cwd(), rootArg)) : SCRIPT_DIR;

if (!rootArg) {
  // 휴리스틱(1개만): 스크립트 위치 자체엔 manifest.json 이 없는데(= 여기가 앱
  // 루트가 아님) 하위 1단계 폴더 중 하나에 manifest.json/package.json 이 있으면
  // 그 폴더를 실제 소스 루트로 인식한다. 못 찾으면 아무 영향 없이 그대로 둔다
  // (일반 npm 프로젝트에서 루트에 이미 package.json 이 있는 흔한 케이스는 그대로 유지).
  if (!existsSync(join(ROOT, 'manifest.json'))) {
    let entries = [];
    try { entries = readdirSync(ROOT, { withFileTypes: true }); } catch { /* 읽기 실패 시 원래 ROOT 유지 */ }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sub = join(ROOT, e.name);
      if (existsSync(join(sub, 'manifest.json')) || existsSync(join(sub, 'package.json'))) {
        ROOT = sub;
        break;
      }
    }
  }
}

const outArg = argVal('out', null);
const OUT_PATH = outArg ? (isAbsolute(outArg) ? outArg : join(process.cwd(), outArg)) : join(SCRIPT_DIR, 'FILEMAP.md');

// ── 순회 대상 ──────────────────────────────────────────────────
// SKIP_DIRS: 이 이름의 디렉터리는 순회하지 않는다.
//   node_modules — 서드파티 의존성(맵 대상 아님)
//   .git         — VCS 메타데이터
//   dist         — 빌드 산출물(소스 아님)
//   _archive     — 보관용 사장 코드
//   data         — 정적 데이터 번들(JSONL/카탈로그 등, 코드 아님)
const SKIP_DIRS = ['node_modules', '.git', 'dist', '_archive', 'data'];
const TARGET_EXTS = new Set(['.js', '.mjs', '.ts', '.jsx', '.tsx', '.html', '.json', '.css']);
const RESOLVE_EXTS = ['.js', '.mjs', '.ts', '.jsx', '.tsx'];

function walk(dirAbs, out) {
  let entries;
  try { entries = readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      // 숨김 디렉터리(.claude/worktrees 사본·.wrangler 상태 등)는 소스가 아니다 — 포함 시 사본이 맵을 점령한다.
      if (SKIP_DIRS.includes(e.name) || e.name.startsWith('.')) continue;
      walk(join(dirAbs, e.name), out);
    } else if (e.isFile()) {
      if (TARGET_EXTS.has(extname(e.name))) out.push(join(dirAbs, e.name));
    }
  }
}
const allAbs = [];
walk(ROOT, allAbs);

function toRel(abs) { return relative(ROOT, abs).split(sep).join('/'); }

const files = allAbs.map((abs) => ({ abs, rel: toRel(abs), ext: extname(abs), size: statSync(abs).size, role: null }));
const relSet = new Set(files.map((f) => f.rel));

// ── 역할 추출: 첫 10줄 안의 첫 주석 블록에서 첫 문장 ─────────────
// 주석이 없으면 절대 추측하지 않는다(§5 날조 금지) — null 반환 → "⚠ 역할 미기재".
function extractRole(text, ext) {
  const lines = text.split(/\r?\n/).slice(0, 10);
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length) return null;
  const first = lines[i].trim();
  let blockLines;

  if (ext === '.html') {
    if (!first.startsWith('<!--')) return null;
    const buf = [];
    for (; i < lines.length; i++) { buf.push(lines[i]); if (lines[i].includes('-->')) break; }
    blockLines = buf.join('\n').replace(/<!--/, '').replace(/-->[\s\S]*$/, '').split(/\r?\n/);
  } else if (first.startsWith('//')) {
    blockLines = [];
    for (; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t.startsWith('//')) break;
      blockLines.push(t.replace(/^\/\/\s?/, ''));
    }
  } else if (first.startsWith('/*')) {
    const buf = [];
    for (; i < lines.length; i++) { buf.push(lines[i]); if (lines[i].includes('*/')) break; }
    blockLines = buf.join('\n')
      .replace(/^\/\*/, '')
      .replace(/\*\/[\s\S]*$/, '')
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^\*\s?/, ''));
  } else {
    return null; // json 등 주석 문법이 없거나, 첫 줄이 코드인 경우 → 미기재
  }

  // 장식용 줄(문자/숫자 없는 구분선 등) 제외 후 첫 의미줄 = 첫 문장.
  // 마침표(.) 로 문장을 자르지 않는다 — 버전(v2.1.0)·도메인(etest.sdu.ac.kr) 오탐 위험.
  // 이 코드베이스 관례상 줄 하나 = 요약 한 문장이므로 줄바꿈을 문장 경계로 취급한다.
  const meaningful = blockLines.map((l) => l.trim()).filter((l) => /[\p{L}\p{N}]/u.test(l));
  if (meaningful.length === 0) return null;
  return meaningful[0].slice(0, 200);
}
for (const f of files) f.role = extractRole(readFileSync(f.abs, 'utf8'), f.ext);

// ── 의존 그래프 ────────────────────────────────────────────────
const RE_IMPORT_FROM = /import\s+[^'";]*?from\s*['"]([^'"]+)['"]/g;
const RE_IMPORT_SIDE = /import\s*['"]([^'"]+)['"]/g;
const RE_DYNAMIC = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
const RE_REQUIRE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const RE_SCRIPT_SRC = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g;
// <link rel=stylesheet href=...> 는 속성 순서가 뒤바뀔 수 있어 두 패턴으로 커버.
const RE_LINK_CSS_A = /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/g;
const RE_LINK_CSS_B = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']stylesheet["'][^>]*>/g;
// chrome.runtime.getURL('literal') — 문자열 리터럴 인자만 잡는다.
// 한계(ponytail): getURL(someVar) 처럼 변수로 조립된 경로는 정적으로 알 수 없어
// 잡지 못한다 — 그런 파일은 의도적으로 계속 고아로 남는다(회귀 테스트로 고정).
const RE_GET_URL = /chrome\.runtime\.getURL\(\s*(['"])([^'"]+)\1\s*\)/g;

// getURL() 인자는 확장 루트(ROOT) 기준 절대경로다(호출 파일 위치와 무관) —
// manifest.json 의 경로 해석과 동일한 기준을 쓴다.
function resolveGetUrl(specifier) {
  if (!specifier) return null;
  const abs = join(ROOT, specifier.replace(/^\/+/, ''));
  if (existsSync(abs) && statSync(abs).isFile()) {
    const r = toRel(abs);
    if (relSet.has(r)) return r;
  }
  return null;
}

function resolveRelative(specifier, fromDirAbs) {
  if (!specifier || (!specifier.startsWith('.') && !specifier.startsWith('/'))) return null; // JS import: 상대경로만 해석(패키지 스펙 제외)
  const base = specifier.startsWith('/') ? join(ROOT, specifier) : join(fromDirAbs, specifier);
  const candidates = [base, ...RESOLVE_EXTS.map((e) => base + e), ...RESOLVE_EXTS.map((e) => join(base, 'index' + e))];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) {
      const r = toRel(c);
      if (relSet.has(r)) return r;
    }
  }
  return null;
}

// html 의 src/href 는 './' 접두사 없는 "bare" 상대경로가 정상(예: src="popup.js").
// 스킴(http:, chrome-extension: 등)이나 프로토콜-상대(//) URL 만 제외하고 나머지는 전부
// 문서 기준 상대경로로 해석한다(브라우저 동작과 동일).
function resolveHtmlRef(specifier, fromDirAbs) {
  if (!specifier || /^[a-z][a-z0-9+.-]*:/i.test(specifier) || specifier.startsWith('//')) return null;
  const base = specifier.startsWith('/') ? join(ROOT, specifier) : join(fromDirAbs, specifier);
  const candidates = [base, ...RESOLVE_EXTS.map((e) => base + e)];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) {
      const r = toRel(c);
      if (relSet.has(r)) return r;
    }
  }
  return null;
}

const importedBy = new Map(files.map((f) => [f.rel, new Set()]));
const deps = new Map(files.map((f) => [f.rel, new Set()]));
function link(fromRel, toRelPath) {
  if (!toRelPath || toRelPath === fromRel || !deps.has(fromRel)) return;
  deps.get(fromRel).add(toRelPath);
  importedBy.get(toRelPath).add(fromRel);
}

// ── 특수 참조(정적 import/HTML 링크가 아닌 경로) ─────────────────
// manifest 의 부가 키(web_accessible_resources 등)나 chrome.runtime.getURL()
// 런타임 문자열 참조로 "실제로는 쓰이는데 고아로 잡히는" 파일을 구제한다.
// 진입점(entryPoints)과는 별개 — 정식 import 그래프의 일부가 아니므로
// deps/importedBy 트리에는 반영하지 않고, 고아 판정과 표시용으로만 쓴다.
const specialRefs = new Map();
function addSpecialRef(rel, label) {
  if (!relSet.has(rel)) return;
  if (!specialRefs.has(rel)) specialRefs.set(rel, new Set());
  specialRefs.get(rel).add(label);
}

for (const f of files) {
  const text = readFileSync(f.abs, 'utf8');
  const dirAbs = dirname(f.abs);
  if (RESOLVE_EXTS.includes(f.ext)) {
    for (const re of [RE_IMPORT_FROM, RE_IMPORT_SIDE, RE_DYNAMIC, RE_REQUIRE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) link(f.rel, resolveRelative(m[1], dirAbs));
    }
  } else if (f.ext === '.html') {
    for (const re of [RE_SCRIPT_SRC, RE_LINK_CSS_A, RE_LINK_CSS_B]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) link(f.rel, resolveHtmlRef(m[1], dirAbs));
    }
  }
  // getURL 은 확장자 무관하게(HTML 인라인 스크립트 등에서도 쓰일 수 있음) 스캔한다.
  RE_GET_URL.lastIndex = 0;
  let gm;
  while ((gm = RE_GET_URL.exec(text))) {
    const target = resolveGetUrl(gm[2]);
    if (target && target !== f.rel) addSpecialRef(target, `${basename(f.rel)} (getURL)`);
  }
}

// ── 진입점 ─────────────────────────────────────────────────────
const entryPoints = new Set();

// manifest.json/package.json 은 어떤 파일도 "import" 하지 않지만 프로젝트의
// 뿌리(설정) 파일이므로 고아로 취급하지 않는다.
for (const f of files) if (f.rel === 'manifest.json' || f.rel === 'package.json') entryPoints.add(f.rel);

const manifestFile = files.find((f) => f.rel === 'manifest.json');
if (manifestFile) {
  try {
    const mf = JSON.parse(readFileSync(manifestFile.abs, 'utf8'));
    const manifestDir = dirname(manifestFile.abs);
    const addManifestEdge = (p) => {
      if (typeof p !== 'string') return;
      const abs = join(manifestDir, p);
      if (!existsSync(abs)) return; // 있으면 읽고 없으면 건너뜀 — 특정 프로젝트 전용 로직 아님
      const r = toRel(abs);
      if (relSet.has(r)) { entryPoints.add(r); link('manifest.json', r); }
    };
    (mf.content_scripts || []).forEach((cs) => (cs.js || []).forEach(addManifestEdge));
    if (mf.background && mf.background.service_worker) addManifestEdge(mf.background.service_worker);
    if (mf.side_panel && mf.side_panel.default_path) addManifestEdge(mf.side_panel.default_path);
    if (mf.action && mf.action.default_popup) addManifestEdge(mf.action.default_popup);

    // ── manifest 의 부가 참조 키 ─────────────────────────────────
    // 이 키들은 "진입점"이 아니라 "런타임에 브라우저가 참조하는 자원"이다.
    // 존재할 때만 읽는 옵셔널 처리 — 특정 프로젝트 전용 하드코딩 아님(§5).
    // entryPoints 에는 넣지 않고 specialRefs 로만 표시해 고아에서 제외한다.
    const addManifestRef = (p, keyLabel) => {
      if (typeof p !== 'string') return;
      const abs = join(manifestDir, p);
      if (!existsSync(abs)) return;
      const r = toRel(abs);
      addSpecialRef(r, `manifest(${keyLabel})`);
    };
    (mf.web_accessible_resources || []).forEach((war) => {
      if (war && Array.isArray(war.resources)) war.resources.forEach((p) => addManifestRef(p, 'web_accessible_resources'));
      else if (typeof war === 'string') addManifestRef(war, 'web_accessible_resources'); // MV2 flat 배열 형태
    });
    if (mf.declarative_net_request && Array.isArray(mf.declarative_net_request.rule_resources)) {
      mf.declarative_net_request.rule_resources.forEach((rr) => addManifestRef(rr && rr.path, 'declarative_net_request'));
    }
    if (mf.options_page) addManifestRef(mf.options_page, 'options_page');
    if (mf.options_ui && mf.options_ui.page) addManifestRef(mf.options_ui.page, 'options_ui');
    if (mf.chrome_url_overrides) Object.values(mf.chrome_url_overrides).forEach((p) => addManifestRef(p, 'chrome_url_overrides'));
    if (mf.icons) Object.values(mf.icons).forEach((p) => addManifestRef(p, 'icons'));
    if (mf.action && mf.action.default_icon) Object.values(mf.action.default_icon).forEach((p) => addManifestRef(p, 'icons'));
  } catch { /* manifest 파싱 실패 시 진입점 추정 없이 진행 */ }
}

// html 파일은 브라우저가 직접 로드하는 진입 문서다(JS import 로 참조되지 않는 게 정상).
// 그대로 두면 항상 고아로 오탐되므로 모든 .html 파일을 진입점으로 취급한다.
for (const f of files) if (f.ext === '.html') entryPoints.add(f.rel);

// ── 고아 ───────────────────────────────────────────────────────
const orphans = files
  .filter((f) => importedBy.get(f.rel).size === 0 && !entryPoints.has(f.rel) && !specialRefs.has(f.rel))
  .map((f) => f.rel)
  .sort();

const missingRole = files.filter((f) => !f.role).map((f) => f.rel).sort();

// ── 출력 ───────────────────────────────────────────────────────
function sizeFmt(n) { return n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`; }

function printTree(rel, path, lines, indent) {
  const cyclic = path.includes(rel);
  lines.push(`${'  '.repeat(indent)}- ${rel}${cyclic ? ' ↺' : ''}`);
  if (cyclic) return; // 순환은 여기서 멈춘다(무한루프 방지)
  const children = [...(deps.get(rel) || [])].sort();
  const nextPath = [...path, rel];
  for (const c of children) printTree(c, nextPath, lines, indent + 1);
}
const treeLines = [];
for (const ep of [...entryPoints].sort()) printTree(ep, [], treeLines, 0);

const rootName = ROOT.split(sep).filter(Boolean).pop();
// 생성 시각 기록: 이 파일의 목적 자체가 "생성 시점 기록"이므로 new Date() 사용은
// §5 하드코딩/날조 금지 대상이 아니다(값이 아니라 실행 시각을 그대로 찍는 것).
const now = new Date();
const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} `
  + `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

const md = [];
md.push(`# FILEMAP — ${rootName}`);
md.push(`생성: ${ts} · \`node filemap.mjs\` 로 재생성`);
md.push(`파일 ${files.length}개 · 역할 미기재 ${missingRole.length}개 · 고아 ${orphans.length}개`);
md.push('');
md.push('## 진입점');
if (entryPoints.size === 0) md.push('(없음)');
for (const ep of [...entryPoints].sort()) md.push(`- ${ep}`);
md.push('');
md.push('## 파일');
md.push('| 파일 | 역할 | 크기 | 의존 | 피의존 |');
md.push('|---|---|---|---|---|');
for (const f of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
  const role = f.role ? f.role.replace(/\|/g, '\\|') : '⚠ 역할 미기재';
  const importedCount = importedBy.get(f.rel).size;
  // 정식 import/HTML 링크 피의존이 있으면 기존과 동일하게 개수를 표시한다.
  // 없지만 manifest/getURL 같은 특수 참조로만 구제된 경우엔 참조 방식을 표기한다
  // (예: manifest(web_accessible_resources), bypass.js (getURL)) — 진입점과 구분.
  const importedCell = importedCount > 0
    ? String(importedCount)
    : (specialRefs.has(f.rel) ? [...specialRefs.get(f.rel)].sort().join(', ').replace(/\|/g, '\\|') : '0');
  md.push(`| ${f.rel} | ${role} | ${sizeFmt(f.size)} | ${deps.get(f.rel).size} | ${importedCell} |`);
}
md.push('');
md.push('## 의존 트리');
md.push(...(treeLines.length ? treeLines : ['(진입점 없음)']));
md.push('');
md.push('## ⚠ 역할 미기재');
md.push(...(missingRole.length ? missingRole.map((r) => `- ${r}`) : ['(없음)']));
md.push('');
md.push('## 고아');
md.push(...(orphans.length ? orphans.map((r) => `- ${r}`) : ['(없음)']));
md.push('');

writeFileSync(OUT_PATH, md.join('\n'), 'utf8');

if (hasFlag('json')) {
  console.log(JSON.stringify({
    root: ROOT,
    files: files.map((f) => ({
      rel: f.rel, role: f.role, size: f.size,
      deps: [...deps.get(f.rel)].sort(),
      importedBy: [...importedBy.get(f.rel)].sort(),
      specialRefs: specialRefs.has(f.rel) ? [...specialRefs.get(f.rel)].sort() : [],
    })),
    entryPoints: [...entryPoints].sort(),
    orphans,
    missingRole,
  }, null, 2));
}

if (hasFlag('guard') && missingRole.length > 0) process.exitCode = 1;
