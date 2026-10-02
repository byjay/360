#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════
   build-tools/jev-supervise.mjs — [WO 20261002-jevsupervise] 개발 관리·감독 도구

   지휘자가 손으로 하던 반복 감독 판정을 자동화한다. 🔴 이 도구는 **경고와 표만** 낸다.
   배포·삭제·권한·번호 확정의 최종 판단은 하지 않는다(전역 CLAUDE.md §1-B Jev 금지 영역).

   결정론 검사(규칙으로 확정 — Jev 불필요)      --commits <range>
     ① 번들·미러 파일 포함   ② reflog reset/amend/rebase   ③ 기존 테스트 수정(신규 제외)
     ④ CRLF 혼입(\r 바이트 수)   ⑤ 커밋 메시지·diff 의 in-place sed 흔적
   Jev 판정(후보 고정·산문 불필요·반복)
     --report <file>  J1~J4 (에이전트 보고서)
     --order  <file>  J5     (발주서 [재현] 블록)
     --suite  <log> [--rerun]  J6 (실패 테스트 분류 — 단독 재실행 PASS 는 규칙으로 '플레이크')
   확률 게이트: p≥0.90 확정 / 0.70~0.90 추정 / <0.70 LLM 검토 필요 / 실패 = 판정 불가 — 수동 검토
   exit code: 결정론 위반(①②④⑤)이 있을 때만 1. Jev 판정은 exit code 에 영향을 주지 않는다.

   사용: node build-tools/jev-supervise.mjs --commits HEAD~5..HEAD
         node build-tools/jev-supervise.mjs --report r.txt --order .claude/WORK_ORDER_x.md
         node build-tools/jev-supervise.mjs --suite .tmp/hfX/suite.log --rerun
   ════════════════════════════════════════════════════════════ */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { jevDecide, readChoice, GATE_LABEL, PRICE_IN_PER_TOKEN } from './lib/jev-client.mjs'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* ── ① 번들·미러 (CLAUDE.md G-4 ⑥: 번들은 지휘자만 재조립) ─────────────── */
export const BUNDLE_FILES = Object.freeze(['public/js/main.js', 'js/main.js', 'index.html'])
export const BUNDLE_DIRS = Object.freeze(['css/'])

/** @param {string[]} paths 커밋이 건드린 경로 @returns {string[]} 번들·미러 경로 */
export function checkBundle(paths) {
  return paths.filter((p) => BUNDLE_FILES.includes(p) || BUNDLE_DIRS.some((d) => p.startsWith(d)))
}

/* ── name-status 파싱 ─────────────────────────────────────────────── */
/** `git diff-tree -r --name-status -M` 출력 → [{status, path, from}] (status 는 첫 글자 A/M/D/R/C/T) */
export function parseNameStatus(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    const status = parts[0].charAt(0)
    if (status === 'R' || status === 'C') out.push({ status, from: parts[1], path: parts[2] })
    else out.push({ status, path: parts[1] })
  }
  return out
}

/* ── ③ 기존 테스트 수정(신규 A 제외) — 수정·이름변경·삭제 ─────────────── */
export function checkExistingTests(changes) {
  return changes
    .filter((c) => c.status !== 'A' && c.status !== 'C' && /^tests\//.test(c.status === 'R' ? c.from : c.path))
    .map((c) => ({ status: c.status, path: c.path, from: c.from }))
}

/* ── ④ CRLF 혼입 — \r 바이트 수를 정확히 센다 ──────────────────────── */
export function countCR(buf) {
  if (!buf) return 0
  let n = 0
  for (let i = 0; i < buf.length; i++) if (buf[i] === 13) n++
  return n
}
/** NUL 바이트가 있으면 바이너리로 보고 CRLF 검사에서 제외한다(git 의 판정 방식과 같다: 앞 8000바이트). */
export function isBinary(buf) {
  if (!buf) return false
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}
/** 부모 대비 \r 이 늘었으면 혼입. @returns {null | {before:number, after:number}} */
export function crlfDelta(after, before) {
  if (!after || isBinary(after)) return null
  const a = countCR(after)
  const b = before && !isBinary(before) ? countCR(before) : 0
  return a > b ? { before: b, after: a } : null
}

/* ── ⑤ in-place sed 흔적 ───────────────────────────────────────────
   정규식을 문자열 조각으로 만든다 — 이 파일 자체가 검사에 걸리지 않게(자기 오탐 방지). */
export const SED_INPLACE_RE = new RegExp('\\bsed\\s+(?:-[A-Za-z]+\\s+|-e\\s+\\S+\\s+)*(?:-[A-Za-z]*i[A-Za-z]*\\b|--in-place)')
/** 문서(*.md)의 금지 규칙 서술은 사용 흔적이 아니므로 diff 검사에서 제외한다(호출부에서 pathspec 으로 거른다). */
export function checkSedInplace(message, addedLines) {
  const hits = []
  for (const l of String(message || '').split('\n')) if (SED_INPLACE_RE.test(l)) hits.push({ where: 'message', line: l.trim().slice(0, 120) })
  for (const l of addedLines || []) if (SED_INPLACE_RE.test(l)) hits.push({ where: 'diff', line: l.trim().slice(0, 120) })
  return hits
}

/* ── ② reflog ────────────────────────────────────────────────────── */
export const REFLOG_WINDOW_SEC = 30 * 60

function reflogKind(subject) {
  if (/^commit \(amend\)/.test(subject)) return 'amend'
  if (/^commit/.test(subject)) return 'commit'
  if (/^reset:/.test(subject)) return 'reset'
  if (/^rebase/.test(subject)) return 'rebase'
  return 'other'
}

/** `git reflog --date=unix --format=%H%x09%gd%x09%gs` → 시간순(오래된 것 먼저) 배열 */
export function parseReflog(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    const [hash, sel, ...rest] = line.split('\t')
    const m = /@\{(\d+)\}/.exec(sel || '')
    const subject = rest.join('\t')
    out.push({ hash, ts: m ? Number(m[1]) : NaN, subject, kind: reflogKind(subject) })
  }
  return out.reverse()
}

/** reset/rebase 사건마다 그 직전 HEAD(= 밀려난 커밋)를 붙인다. amend 는 직전 원본을 붙인다. */
export function reflogEvents(entries) {
  const ev = []
  entries.forEach((e, i) => {
    if (e.kind !== 'reset' && e.kind !== 'rebase' && e.kind !== 'amend') return
    const prev = entries[i - 1]
    ev.push({ ...e, displaced: prev && prev.hash !== e.hash ? prev.hash : null })
  })
  return ev
}

/**
 * 커밋 하나에 대한 ② 판정. 근거:
 *   a) 그 커밋이 amend/rebase 로 만들어졌다
 *   b) 그 커밋 생성 직전(30분 이내, 사이에 다른 커밋 없음)에 reset/rebase 가 있었다 = reset 후 재커밋
 */
export function reflogHitsFor(fullHash, entries) {
  const idx = entries.findIndex((e) => e.hash === fullHash && (e.kind === 'commit' || e.kind === 'amend' || e.kind === 'rebase'))
  if (idx < 0) return []
  const self = entries[idx]
  const hits = []
  if (self.kind === 'amend') hits.push({ type: 'amend', ts: self.ts, subject: self.subject.slice(0, 80), displaced: entries[idx - 1] ? entries[idx - 1].hash : null })
  if (self.kind === 'rebase') hits.push({ type: 'rebase', ts: self.ts, subject: self.subject.slice(0, 80), displaced: null })
  for (let j = idx - 1; j >= 0; j--) {
    const e = entries[j]
    if (e.kind === 'commit' || e.kind === 'amend') break
    if (!(self.ts - e.ts <= REFLOG_WINDOW_SEC)) break
    if (e.kind === 'reset' || e.kind === 'rebase') {
      const prev = entries[j - 1]
      hits.push({ type: e.kind, ts: e.ts, subject: e.subject.slice(0, 80), displaced: prev && prev.hash !== e.hash ? prev.hash : null })
    }
  }
  return hits
}

/* ── git 실행 (UTF-8 고정) ─────────────────────────────────────────── */
export function makeGit(cwd = REPO_ROOT) {
  const base = ['-c', 'core.quotepath=off', '-c', 'i18n.logOutputEncoding=utf-8']
  const raw = (args) => execFileSync('git', [...base, ...args], { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  return {
    text: (args) => raw(args).toString('utf8'),
    buf: (args) => { try { return raw(args) } catch { return null } },
    ok: (args) => { try { raw(args); return true } catch { return false } },
  }
}

/** 로컬 시각(실행 기기 시간대 — git reflog --date=iso 와 같은 기준) */
const iso = (ts) => {
  if (!Number.isFinite(ts)) return '?'
  const d = new Date(ts * 1000)
  const z = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`
}

/**
 * --commits 검사. 결정론 결과만 돌려준다(Jev 호출 없음).
 * @returns {{commits:Array, events:Array, violations:number}}
 */
export function runCommits(range, git = makeGit()) {
  const list = range.includes('..')
    ? git.text(['rev-list', '--reverse', range]).split('\n').filter(Boolean)
    : [git.text(['rev-parse', '--verify', range + '^{commit}']).trim()]
  let reflog = []
  try { reflog = parseReflog(git.text(['reflog', '--date=unix', '--format=%H%x09%gd%x09%gs'])) } catch { reflog = [] }
  const commits = []
  let violations = 0
  let minTs = Infinity, maxTs = -Infinity
  for (const h of list) {
    const [short, cts, ...subj] = git.text(['log', '-1', '--format=%h%x09%ct%x09%s', h]).trim().split('\t')
    const ts = Number(cts)
    minTs = Math.min(minTs, ts); maxTs = Math.max(maxTs, ts)
    const isRoot = !git.ok(['rev-parse', '--verify', '--quiet', h + '^'])
    const changes = parseNameStatus(git.text(['diff-tree', '-r', '--no-commit-id', '--name-status', '-M', ...(isRoot ? ['--root'] : []), h]))
    const paths = changes.map((c) => c.path)
    const bundle = checkBundle(paths)
    const reflogHits = reflogHitsFor(h, reflog)
    const tests = checkExistingTests(changes)
    const crlf = []
    for (const c of changes) {
      if (c.status === 'D') continue
      const after = git.buf(['cat-file', 'blob', `${h}:${c.path}`])
      const before = isRoot ? null : git.buf(['cat-file', 'blob', `${h}^:${c.status === 'R' ? c.from : c.path}`])
      const d = crlfDelta(after, before)
      if (d) crlf.push({ path: c.path, ...d })
    }
    const message = git.text(['log', '-1', '--format=%B', h])
    const diff = isRoot ? '' : git.text(['diff', '-U0', '--no-color', h + '^', h, '--', '.', ':(exclude)*.md'])
    const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    const sed = checkSedInplace(message, added)
    const v = (bundle.length ? 1 : 0) + (reflogHits.length ? 1 : 0) + (crlf.length ? 1 : 0) + (sed.length ? 1 : 0)
    violations += v
    commits.push({ hash: h, short, ts, subject: subj.join('\t'), bundle, reflog: reflogHits, existingTests: tests, crlf, sed, violations: v })
  }
  // 범위 시간대(±30분)의 reflog 사건 — 밀려난 커밋이 HEAD 조상인지(=이탈 여부)까지
  const events = reflogEvents(reflog)
    .filter((e) => e.ts >= minTs - REFLOG_WINDOW_SEC && e.ts <= maxTs + REFLOG_WINDOW_SEC)
    .map((e) => ({ ...e, displacedReachable: e.displaced ? git.ok(['merge-base', '--is-ancestor', e.displaced, 'HEAD']) : null }))
  return { commits, events, violations }
}

/* ── TAP / spec 스위트 로그 → 실패 목록 ───────────────────────────── */
const unescapeTap = (s) => s.replace(/\\\\/g, '\\').replace(/\\#/g, '#')

/** @returns {{name:string, error:string}[]} 최상위 실패(파일 단위) */
export function parseSuiteLog(text) {
  const lines = String(text).replace(/\r/g, '').split('\n')
  const fails = []
  let segStart = 0
  const pickError = (seg) => {
    const pri = [
      (l) => /^#\s+FAIL\b/.test(l.trim()) || /^\s*#\s+✖/.test(l),
      (l) => /^\s+error:\s*'/.test(l) && !/'test failed'/.test(l),
      (l) => /(AssertionError|Error:|ERR_|EADDRINUSE|ENOENT|Timed out|timeout)/i.test(l) && !/'test failed'/.test(l),
      (l) => /^\s+not ok \d+ - /.test(l),
    ]
    for (const f of pri) {
      const hit = seg.find(f)
      if (hit) return unescapeTap(hit.trim().replace(/^#\s*/, '')).slice(0, 200)
    }
    return '(오류 줄 없음)'
  }
  lines.forEach((l, i) => {
    const tap = /^(not ok|ok) \d+ - (.+?)(?:\s+#\s+(?:SKIP|TODO).*)?$/.exec(l)
    const spec = /^✖ (.+?)(?: \([\d.]+m?s\))?$/.exec(l)
    if (tap) {
      if (tap[1] === 'not ok') {
        // 실패 블록(YAML) 은 결과 줄 뒤에 온다 → 결과 줄 앞 구간 + 뒤 YAML 까지
        let end = i + 1
        while (end < lines.length && /^\s/.test(lines[end])) end++
        fails.push({ name: unescapeTap(tap[2]), error: pickError([...lines.slice(segStart, i), ...lines.slice(i + 1, end)]) })
      }
      segStart = i + 1
    } else if (spec && !/^✖ failing tests:?$/.test(l)) {
      let end = i + 1
      while (end < lines.length && /^\s/.test(lines[end])) end++
      if (!fails.some((f) => f.name === spec[1])) fails.push({ name: spec[1], error: pickError(lines.slice(i + 1, end)) })
    }
  })
  return fails
}

/* ── Jev 질문(후보 고정) ──────────────────────────────────────────── */
const RULE = '소프트웨어 개발 감독이다. 에이전트가 낸 텍스트에 규율 증거가 있는지만 판정한다. 텍스트에 적힌 것만 근거로 삼고 추측하지 않는다.'
const q = (question, criteria) => ({ type: 'choice', instructions: { rule: RULE, question }, criteria })

export const QUESTIONS = Object.freeze({
  J1: q('보고서가 기존 테스트를 수정했다면, 수정 전·후 assertion(기대값) 대조와 뮤테이션 실행 EXIT=1 실증이 둘 다 있는가?', {
    있음: '기존 테스트를 수정했고, 전·후 기대값 대조와 뮤테이션(고친 부분을 되돌림) 실행에서 테스트가 실패(EXIT=1)했다는 실행 증거가 둘 다 적혀 있다',
    없음: '기존 테스트를 수정(기대값 변경·needle 갱신·허용목록 추가·조건 완화)했는데 전·후 대조나 뮤테이션 EXIT=1 실증 중 하나라도 빠졌다',
    해당없음: '기존 테스트를 수정하지 않았다(신규 테스트 추가만 했거나 테스트를 건드리지 않았다)',
  }),
  J2: q('통과·실패·정상 주장에 실행 증거(EXIT 코드·실행 명령·실제 출력 수치)가 붙어 있는가?', {
    있음: '통과·실패 주장마다 EXIT 코드, 실행한 명령, 통과 건수 같은 실제 출력이 붙어 있다',
    없음: '"통과", "정상", "완료" 라고만 하고 EXIT 코드·명령·출력 같은 실행 증거가 없다',
  }),
  J3: q('"기존부터 실패했다", "이번 변경과 무관하다" 같은 주장이 재현 근거 없이 단정됐는가?', {
    단정: '기존 실패·무관 주장을 하면서 이전 커밋 추출본 재현, 단독 재실행 EXIT 같은 근거를 대지 않았다',
    근거제시: '기존 실패·무관·플레이크 주장에 이전 커밋 재현이나 단독 재실행 EXIT 같은 실행 근거를 붙였다',
    해당없음: '기존 실패나 무관하다는 주장 자체가 없다',
  }),
  J4: q('미완·잔여·보류 항목이 명시됐는가?', {
    명시: '미완·잔여 위험·보류·결정 대기 항목을 적었거나 "미완 없음"을 명시했다',
    누락: '미완 여부를 전혀 언급하지 않았다(생략하거나 수행하지 않은 일이 있어도 미완으로 적지 않았다)',
  }),
  J5: q('발주서에 결함 재현 블록(재현 명령·실측 수치·EXIT·판정)이 있는가, 아니면 재현이 필요 없는 신규 기능 발주인가?', {
    있음: '[재현] 블록이 있고, 지휘자가 실측한 수치·명령·EXIT·코드 위치 같은 재현 근거가 적혀 있다',
    없음: '결함 수정을 요구하는데 지휘자가 직접 재현한 블록(명령·실측·EXIT)이 없다(스크린샷·원장 기재·정찰 보고만 있음 포함)',
    신규기능사유: '결함 수정이 아니라 신규 기능·이식·조사·문서 발주라서 재현이 필요 없다',
  }),
  J6: q('이 테스트 실패의 원인 분류는?', {
    플레이크: '타이밍·부하·확률·순서 때문에 간헐적으로 실패한다. 코드 결함이 아니다',
    환경: '포트 점유, 경로, 메모리 부족, 브라우저·의존성 누락, 임시폴더 위치 같은 실행 환경 문제다',
    실제회귀: '이번 변경이 기존 동작이나 기존 테스트의 기대를 깨뜨렸다',
    기존결함: '이번 변경 이전부터 있던 앱 결함을 테스트가 정확히 잡았다(수정 전 실패가 예상된 측정용 테스트 포함)',
  }),
})
export const REPORT_IDS = Object.freeze(['J1', 'J2', 'J3', 'J4'])

/**
 * 일치율 < 80% 로 측정된 항목 = "보조 표시만"(WO §측정). 값은 build-tools/jev-supervise-measure.mjs 실측으로 정한다.
 * 보조 항목은 p 가 높아도 '확정' 으로 올리지 않는다.
 * 실측 2026-10-02(gold 라벨 87 = Jev 85 + 규칙 2, 호출 49회): J1 8/12=66.7% · J5 14/22=63.6% → 보조.
 *   J2 12/12 · J3 11/12 · J4 12/12 · J6 15/15 → 사용. (재구성 사례 기반 — 표본이 늘면 재측정)
 */
export const AUXILIARY = new Set(['J1', 'J5'])

export const MAX_STATE_CHARS = 10000
export function clip(text) {
  const s = String(text || '')
  return s.length > MAX_STATE_CHARS ? s.slice(0, MAX_STATE_CHARS) + `\n…(이하 ${s.length - MAX_STATE_CHARS}자 생략)` : s
}

/** 기본 ask = Jev 실호출. 테스트는 ask 를 주입한다. */
export const defaultAsk = (state, questions) => jevDecide({ state, questions })

/**
 * ids 질문을 1회 호출(fan-out)로 묻고 게이트를 적용한다.
 * @returns {Promise<{results:Array, inputTokens:number, ms:number, error:string|null}>}
 */
export async function judge(ids, state, ask = defaultAsk) {
  const questions = Object.fromEntries(ids.map((id) => [id, QUESTIONS[id]]))
  let res
  try { res = await ask(state, questions) } catch (e) { res = { ok: false, error: 'throw:' + String((e && e.message) || e).slice(0, 80) } }
  const results = ids.map((id) => {
    if (!res || !res.ok) return { id, label: null, p: null, confidence: null, gate: 'unavailable', gateText: GATE_LABEL.unavailable, aux: AUXILIARY.has(id), error: (res && res.error) || 'unknown' }
    const r = readChoice(res.answers[id], Object.keys(QUESTIONS[id].criteria))
    let gate = r.gate
    if (AUXILIARY.has(id) && gate === 'confirmed') gate = 'estimated'
    return { id, ...r, gate, gateText: GATE_LABEL[gate] + (AUXILIARY.has(id) ? ' (보조)' : ''), aux: AUXILIARY.has(id), error: r.gate === 'unavailable' ? 'bad-answer' : null }
  })
  return { results, inputTokens: (res && res.inputTokens) || 0, ms: (res && res.ms) || 0, error: res && !res.ok ? res.error : null }
}

/** J6 state — 측정 스크립트와 CLI 가 같은 문자열을 쓴다(SoT) */
export function suiteState(f) {
  const rr = f.rerun == null ? '하지 않음' : f.rerun === 0 ? 'EXIT=0 (단독으로는 통과)' : `EXIT=${f.rerun} (단독으로도 실패)`
  return `실패한 테스트: ${f.name}\n실패 첫 줄: ${f.error}\n단독 재실행: ${rr}` + (f.note ? `\n추가 정보: ${f.note}` : '')
}

/** 단독 재실행. TEMP/TMP 는 프로젝트 안 .tmp(CLAUDE.md G-5). */
export function rerunFile(name, cwd = REPO_ROOT) {
  const file = isAbsolute(name) ? name : resolve(cwd, name)
  if (!/\.(m?js|cjs)$/.test(file) || !existsSync(file)) return null
  const tmp = join(cwd, '.tmp')
  mkdirSync(tmp, { recursive: true })
  const r = spawnSync(process.execPath, ['--test', file], { cwd, env: { ...process.env, TEMP: tmp, TMP: tmp }, timeout: 300000, stdio: 'ignore' })
  return typeof r.status === 'number' ? r.status : 124
}

/**
 * --suite 판정. 단독 재실행 EXIT=0 → 규칙 '플레이크'(Jev 미호출). 나머지만 Jev.
 */
export async function judgeSuite(fails, { ask = defaultAsk, rerun = null } = {}) {
  const out = []
  let inputTokens = 0, calls = 0
  for (const f of fails) {
    const item = { ...f, rerun: rerun ? rerun(f) : null }
    // failLine = 테스트 실패 첫 줄, error = Jev 호출 오류(둘을 섞지 않는다)
    const base = { name: f.name, failLine: f.error, rerun: item.rerun }
    if (item.rerun === 0) {
      out.push({ ...base, id: 'J6', label: '플레이크', p: null, confidence: null, gate: 'rule', gateText: GATE_LABEL.rule, error: null, source: 'rule' })
      continue
    }
    const j = await judge(['J6'], suiteState(item), ask)
    calls++
    inputTokens += j.inputTokens
    out.push({ ...base, ...j.results[0], source: 'jev' })
  }
  return { results: out, inputTokens, calls }
}

/* ── 출력 ─────────────────────────────────────────────────────────── */
const cell = (s) => String(s == null ? '-' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ')
const fmtP = (p) => (typeof p === 'number' ? p.toFixed(2) : '-')

export function commitRows(rc) {
  const rows = []
  for (const c of rc.commits) {
    const tag = `${c.short}`
    rows.push([`①번들 ${tag}`, c.bundle.length ? '위반' : '정상', '-', c.bundle.join(', ') || c.subject.slice(0, 50)])
    rows.push([`②reflog ${tag}`, c.reflog.length ? '위반' : '정상', '-', c.reflog.map((h) => `${h.type} ${iso(h.ts)}${h.displaced ? ' 밀려남 ' + h.displaced.slice(0, 7) : ''}`).join('; ') || '-'])
    rows.push([`③기존테스트 ${tag}`, c.existingTests.length ? '주의(J1 확인)' : '정상', '-', c.existingTests.map((t) => `${t.status} ${t.path}`).join(', ') || '-'])
    rows.push([`④CRLF ${tag}`, c.crlf.length ? '위반' : '정상', '-', c.crlf.map((x) => `${x.path} \\r ${x.before}→${x.after}`).join(', ') || '-'])
    rows.push([`⑤sed ${tag}`, c.sed.length ? '위반' : '정상', '-', c.sed.map((x) => `${x.where}: ${x.line}`).join('; ') || '-'])
  }
  for (const e of rc.events) {
    rows.push([`reflog 사건 ${iso(e.ts)}`, e.displaced && e.displacedReachable === false ? '이탈' : '기록', '-', `${e.subject.slice(0, 60)}${e.displaced ? ' / 밀려난 ' + e.displaced.slice(0, 7) + (e.displacedReachable ? '(HEAD 조상)' : '(HEAD 조상 아님)') : ''}`])
  }
  return rows
}

export function jevRows(prefix, results) {
  return results.map((r) => [
    `${prefix}${r.id}${r.name ? ' ' + r.name.split(/[\\/]/).pop() : ''}`,
    r.label ? `${r.label} [${r.gateText}]` : r.gateText,
    fmtP(r.p),
    [
      r.failLine,
      r.source === 'rule' ? '단독 재실행 EXIT=0' : r.rerun != null ? `단독 재실행 EXIT=${r.rerun}` : null,
      r.error ? `오류 ${r.error}` : r.confidence != null ? `confidence ${r.confidence.toFixed(2)}` : null,
    ].filter(Boolean).join(' / ') || '-',
  ])
}

export function table(rows) {
  return ['| 검사 | 결과 | p | 근거 |', '|---|---|---|---|', ...rows.map((r) => '| ' + r.map(cell).join(' | ') + ' |')].join('\n')
}

/* ── CLI ──────────────────────────────────────────────────────────── */
function parseArgs(argv) {
  const a = { rerun: false, noJev: false }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--commits') a.commits = argv[++i]
    else if (k === '--report') a.report = argv[++i]
    else if (k === '--order') a.order = argv[++i]
    else if (k === '--suite') a.suite = argv[++i]
    else if (k === '--rerun') a.rerun = true
    else if (k === '--no-jev') a.noJev = true
    else if (k === '--out') a.out = argv[++i]
    else throw new Error('알 수 없는 인자: ' + k)
  }
  return a
}

export async function main(argv, { ask = defaultAsk, cwd = process.cwd() } = {}) {
  const a = parseArgs(argv)
  if (!a.commits && !a.report && !a.order && !a.suite) {
    process.stderr.write('사용: --commits <range> | --report <file> | --order <file> | --suite <log> [--rerun] [--no-jev] [--out <json>]\n')
    return 2
  }
  const useAsk = a.noJev ? async () => ({ ok: false, error: '--no-jev' }) : ask
  const rows = []
  const out = { at: new Date().toISOString(), args: argv }
  let violations = 0, inputTokens = 0, jevCalls = 0
  if (a.commits) {
    const rc = runCommits(a.commits, makeGit(REPO_ROOT))
    out.commits = rc
    violations += rc.violations
    rows.push(...commitRows(rc))
  }
  const rd = (f) => readFileSync(isAbsolute(f) ? f : resolve(cwd, f), 'utf8')
  if (a.report) {
    const j = await judge(REPORT_IDS, clip(rd(a.report)), useAsk)
    out.report = j; inputTokens += j.inputTokens; jevCalls++
    rows.push(...jevRows('보고서 ', j.results))
  }
  if (a.order) {
    const j = await judge(['J5'], clip(rd(a.order)), useAsk)
    out.order = j; inputTokens += j.inputTokens; jevCalls++
    rows.push(...jevRows('발주서 ', j.results))
  }
  if (a.suite) {
    const fails = parseSuiteLog(rd(a.suite))
    const s = await judgeSuite(fails, { ask: useAsk, rerun: a.rerun ? (f) => rerunFile(f.name, REPO_ROOT) : null })
    out.suite = s; inputTokens += s.inputTokens; jevCalls += s.calls
    if (!fails.length) rows.push(['스위트', '실패 0', '-', a.suite])
    rows.push(...jevRows('스위트 ', s.results))
  }
  out.violations = violations
  out.jev = { calls: jevCalls, inputTokens, costUsd: +(inputTokens * PRICE_IN_PER_TOKEN).toFixed(8) }
  const jsonPath = a.out || join(REPO_ROOT, '.tmp', 'supervise', new Date().toISOString().replace(/[:.]/g, '-') + '.json')
  mkdirSync(dirname(jsonPath), { recursive: true })
  writeFileSync(jsonPath, JSON.stringify(out, null, 2), 'utf8')
  const summary = `\n결정론 위반 ${violations}건 · Jev 호출 ${jevCalls}회 · 입력 ${inputTokens}토큰 · $${out.jev.costUsd} · JSON ${jsonPath}\n` +
    '※ 이 도구는 경고·표만 낸다. 배포·삭제·권한·번호 확정의 최종 판단은 사람이 한다.\n'
  process.stdout.write(table(rows) + '\n' + summary, 'utf8')
  return violations > 0 ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (e) => {
    process.stderr.write('jev-supervise 오류: ' + String((e && e.message) || e).slice(0, 300) + '\n')
    process.exitCode = 2
  })
}
