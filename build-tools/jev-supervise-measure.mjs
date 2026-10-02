#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════
   build-tools/jev-supervise-measure.mjs — [WO 20261002-jevsupervise §측정] J1~J6 일치율 실측

   전역 CLAUDE.md §1-B: "형식 보장 ≠ 정답 보장. 표본 20건 이상 일치율 실측 전에 「대체했다」 금지."
   입력 : .tmp/supervise/gold.json (라벨 데이터셋 — 사람 판정)
   출력 : 항목별 일치율(엄격·허용대안) · 게이트별 건수와 정확도 · 비용 · 지연 → 표 + .tmp/supervise/measure-<ts>.json
   🔴 Jev 실호출(OPENROUTER_API_KEY). 키가 없으면 전부 '판정 불가' 로 집계되고 exit 2.

   사용: node build-tools/jev-supervise-measure.mjs [gold.json]
   ════════════════════════════════════════════════════════════ */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { REPO_ROOT, REPORT_IDS, judge, judgeSuite, clip, defaultAsk } from './jev-supervise.mjs'
import { PRICE_IN_PER_TOKEN } from './lib/jev-client.mjs'

const goldPath = resolve(process.argv[2] || join(REPO_ROOT, '.tmp', 'supervise', 'gold.json'))
const gold = JSON.parse(readFileSync(goldPath, 'utf8'))

const rows = [] // {J, case, gold, alt, label, p, gate, source}
const lat = []
let tokens = 0, calls = 0

const timedAsk = async (state, questions) => {
  const r = await defaultAsk(state, questions)
  if (r.ok) lat.push(r.ms)
  return r
}

for (const c of gold.reports) {
  const j = await judge(REPORT_IDS, clip(c.text), timedAsk)
  tokens += j.inputTokens; calls++
  for (const r of j.results) rows.push({ J: r.id, case: c.id, gold: c.labels[r.id], alt: [], label: r.label, p: r.p, gate: r.gate, source: 'jev', error: r.error })
}
for (const c of gold.orders) {
  const text = c.file ? readFileSync(join(REPO_ROOT, c.file), 'utf8') : c.text
  const j = await judge(['J5'], clip(text), timedAsk)
  tokens += j.inputTokens; calls++
  const r = j.results[0]
  rows.push({ J: 'J5', case: c.id, gold: c.label, alt: c.alt || [], label: r.label, p: r.p, gate: r.gate, source: 'jev', error: r.error })
}
{
  const fails = gold.suite.map((s) => ({ id: s.id, name: s.name, error: s.error, _rerun: s.rerun, _gold: s.label, _alt: s.alt || [] }))
  // 재실행 결과는 gold 에 기록된 값(지휘자 실측)을 그대로 준다 — 측정 대상은 분류이지 재실행이 아니다
  const s = await judgeSuite(fails, { ask: timedAsk, rerun: (f) => f._rerun })
  // judgeSuite 는 순서를 유지한다
  s.results.forEach((r, i) => {
    const f = fails[i]
    rows.push({ J: 'J6', case: f.id, gold: f._gold, alt: f._alt, label: r.label, p: r.p, gate: r.gate, source: r.source, error: r.error || null })
  })
  tokens += s.inputTokens; calls += s.calls
}

/* ── 집계 ─────────────────────────────────────────────────────────── */
const ids = ['J1', 'J2', 'J3', 'J4', 'J5', 'J6']
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : '-')
const summary = ids.map((J) => {
  const all = rows.filter((r) => r.J === J && r.source === 'jev')
  const ok = all.filter((r) => r.label === r.gold).length
  const okAlt = all.filter((r) => r.label === r.gold || r.alt.includes(r.label)).length
  const by = (g) => all.filter((r) => r.gate === g)
  const conf = by('confirmed'), est = by('estimated'), esc = by('escalate'), un = by('unavailable')
  return {
    J, n: all.length, match: ok, acc: all.length ? ok / all.length : null, accAlt: all.length ? okAlt / all.length : null,
    confirmed: conf.length, confirmedAcc: conf.length ? conf.filter((r) => r.label === r.gold).length / conf.length : null,
    estimated: est.length, estimatedAcc: est.length ? est.filter((r) => r.label === r.gold).length / est.length : null,
    escalate: esc.length, unavailable: un.length,
    rule: rows.filter((r) => r.J === J && r.source === 'rule').length,
    ruleAcc: (() => { const rr = rows.filter((r) => r.J === J && r.source === 'rule'); return rr.length ? rr.filter((r) => r.label === r.gold).length / rr.length : null })(),
    auxiliary: all.length ? ok / all.length < 0.8 : null,
  }
})
lat.sort((a, b) => a - b)
const q = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : null)
const cost = tokens * PRICE_IN_PER_TOKEN
const out = {
  at: new Date().toISOString(), gold: goldPath, calls, inputTokens: tokens, costUsd: +cost.toFixed(8),
  costPerCallUsd: calls ? +(cost / calls).toFixed(8) : null, latencyMs: { median: q(0.5), p90: q(0.9), max: lat[lat.length - 1] ?? null, n: lat.length },
  summary, rows,
}
const dir = join(REPO_ROOT, '.tmp', 'supervise')
mkdirSync(dir, { recursive: true })
const file = join(dir, 'measure-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json')
writeFileSync(file, JSON.stringify(out, null, 2), 'utf8')

const f2 = (x) => (x == null ? '-' : (100 * x).toFixed(1) + '%')
const lines = ['| 항목 | n | 일치(엄격) | 일치(대안허용) | 확정 n/정확 | 추정 n/정확 | 승격 | 판정불가 | 규칙 n/정확 | 상태 |', '|---|---|---|---|---|---|---|---|---|---|']
for (const s of summary) {
  lines.push(`| ${s.J} | ${s.n} | ${s.match}/${s.n} ${f2(s.acc)} | ${f2(s.accAlt)} | ${s.confirmed}/${f2(s.confirmedAcc)} | ${s.estimated}/${f2(s.estimatedAcc)} | ${s.escalate} | ${s.unavailable} | ${s.rule}/${f2(s.ruleAcc)} | ${s.auxiliary == null ? '-' : s.auxiliary ? '보조 표시만(<80%)' : '사용'} |`)
}
const miss = rows.filter((r) => r.source === 'jev' && r.label !== r.gold).map((r) => `${r.case}/${r.J}: gold=${r.gold} jev=${r.label ?? 'null'} p=${r.p == null ? '-' : r.p.toFixed(2)} ${r.gate}${r.error ? ' ' + r.error : ''}`)
process.stdout.write(lines.join('\n') + `\n\n호출 ${calls}회 · 입력 ${tokens}토큰 · $${cost.toFixed(6)} (건당 $${calls ? (cost / calls).toFixed(7) : '-'}) · 지연 중앙값 ${out.latencyMs.median}ms p90 ${out.latencyMs.p90}ms\n` +
  `불일치 ${miss.length}건:\n` + miss.join('\n') + `\nJSON ${file}\n`, 'utf8')
process.exitCode = rows.some((r) => r.gate === 'unavailable' && r.source === 'jev') ? 2 : 0
