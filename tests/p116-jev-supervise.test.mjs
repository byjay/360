/**
 * p116 — [WO 20261002-jevsupervise] 개발 감독 도구 build-tools/jev-supervise.mjs
 * (프레임워크 0 · 실행: node tests/p116-jev-supervise.test.mjs)
 *
 * 경계: Jev HTTP 만 스텁(ask 주입·fetchImpl). 결정론 검사는 **실 git 저장소의 실제 커밋**으로 검사한다.
 *   ① 번들·미러 — 23c0680(번들 포함) 적중 / 0fe4386(문서만) 정상
 *   ② reflog — 고정 픽스처(reset 후 재커밋·amend) + 실 reflog(bb4f3b6 = reset 직후 재커밋, 있으면)
 *   ③ 기존 테스트 수정 · ④ CRLF \r 정확 카운트 · ⑤ in-place sed 흔적
 *   J  확률 게이트(0.90 확정 / 0.70 추정 / <0.70 승격 / 실패 = 판정 불가) · 보조 항목 강등 · 스위트 규칙 플레이크
 *   CLI exit code — 결정론 위반 있을 때만 1, Jev 판정은 exit code 무영향
 * 뮤테이션: checkBundle 를 `return []` 로 무력화 → ① FAIL → EXIT=1 (보고서에 실측 인용)
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const S = await import(pathToFileURL(join(ROOT, 'build-tools/jev-supervise.mjs')).href)
const C = await import(pathToFileURL(join(ROOT, 'build-tools/lib/jev-client.mjs')).href)

let failed = 0
const ok = (c, l) => { console.log((c ? '  PASS ' : '  FAIL ') + l); if (!c) failed++ }
const git = S.makeGit(ROOT)
const hasCommit = (h) => git.ok(['cat-file', '-e', h + '^{commit}'])

console.log('# ① 번들·미러')
ok(JSON.stringify(S.checkBundle(['public/js/main.js', 'js/main.js', 'index.html', 'css/style.css', 'public/index.html', 'public/css/style.css', 'tests/a.mjs']))
  === JSON.stringify(['public/js/main.js', 'js/main.js', 'index.html', 'css/style.css']), '픽스처: 번들 4종만 적중(public/index.html·public/css 는 소스라 제외)')
if (hasCommit('23c0680')) {
  const r = S.runCommits('23c0680', git)
  const b = r.commits[0].bundle
  ok(b.includes('js/main.js') && b.includes('public/js/main.js') && b.includes('index.html'), `실 커밋 23c0680 ① 적중 → ${b.join(', ')}`)
  ok(r.violations > 0, `23c0680 위반 수 > 0 → ${r.violations}`)
} else ok(false, '23c0680 커밋이 저장소에 없다(실 커밋 검증 불가)')
if (hasCommit('0fe4386')) {
  const r = S.runCommits('0fe4386', git)
  ok(r.violations === 0 && r.commits[0].bundle.length === 0, `실 커밋 0fe4386(문서만) 위반 0 → ${r.violations}`)
}

console.log('# ② reflog')
const H = (c) => c.repeat(40)
// git reflog 출력은 최신이 먼저다
const reflogText = [
  `${H('e')}\tHEAD@{1000900}\tcommit: 다음 커밋`,
  `${H('d')}\tHEAD@{1000800}\tcommit: 재커밋`,
  `${H('b')}\tHEAD@{1000700}\treset: moving to HEAD`,
  `${H('b')}\tHEAD@{1000600}\treset: moving to HEAD~1`,
  `${H('c')}\tHEAD@{1000500}\tcommit: 남의 커밋`,
  `${H('b')}\tHEAD@{1000400}\tcommit (amend): 고친 커밋`,
  `${H('a')}\tHEAD@{1000300}\tcommit: 원 커밋`,
].join('\n')
const ent = S.parseReflog(reflogText)
ok(ent[0].hash === H('a') && ent[ent.length - 1].hash === H('e'), 'parseReflog: 시간순(오래된 것 먼저) 정렬')
const hd = S.reflogHitsFor(H('d'), ent)
ok(hd.some((h) => h.type === 'reset' && h.displaced === H('c')), `reset 직후 재커밋 적중 + 밀려난 커밋 = c → ${JSON.stringify(hd.map((h) => [h.type, h.displaced && h.displaced[0]]))}`)
ok(S.reflogHitsFor(H('b'), ent).some((h) => h.type === 'amend' && h.displaced === H('a')), 'amend 로 만든 커밋 적중 + 원본 a')
ok(S.reflogHitsFor(H('e'), ent).length === 0 && S.reflogHitsFor(H('c'), ent).length === 0, '정상 커밋(e·c) 미적중 — 사이에 다른 커밋이 있으면 끊는다')
const far = S.parseReflog([`${H('d')}\tHEAD@{${1000600 + S.REFLOG_WINDOW_SEC + 1}}\tcommit: 한참 뒤`, `${H('b')}\tHEAD@{1000600}\treset: moving to HEAD~1`, `${H('c')}\tHEAD@{1000500}\tcommit: x`].join('\n'))
ok(S.reflogHitsFor(H('d'), far).length === 0, '30분 창 밖의 reset 은 연결하지 않는다')
if (hasCommit('bb4f3b6')) {
  const full = git.text(['rev-parse', 'bb4f3b6']).trim()
  const real = S.parseReflog(git.text(['reflog', '--date=unix', '--format=%H%x09%gd%x09%gs']))
  if (real.some((e) => e.hash === full)) {
    const hits = S.reflogHitsFor(full, real)
    ok(hits.some((h) => h.type === 'reset'), `실 reflog: bb4f3b6(2026-10-01 reset 직후 재커밋) ② 적중 → ${hits.length}건`)
  } else console.log('  SKIP 실 reflog 에 bb4f3b6 생성 기록 없음(다른 클론) — 픽스처 검사로 대체')
}

console.log('# ③ 기존 테스트 수정')
const ns = S.parseNameStatus('A\ttests/p999-new.test.mjs\nM\ttests/p31-x.test.mjs\nD\ttests/p15-y.test.mjs\nR087\ttests/p62-a.test.mjs\ttests/p62-b.test.mjs\nM\tpublic/js/modules/20_App.js')
const et = S.checkExistingTests(ns)
ok(et.map((t) => t.status + ' ' + t.path).join(',') === 'M tests/p31-x.test.mjs,D tests/p15-y.test.mjs,R tests/p62-b.test.mjs', `신규(A) 제외, 수정·삭제·이름변경만 → ${et.map((t) => t.status).join('')}`)

console.log('# ④ CRLF')
ok(S.countCR(Buffer.from('a\r\nb\r\nc\rd\n')) === 3, 'countCR: \\r 3개를 정확히 센다')
ok(JSON.stringify(S.crlfDelta(Buffer.from('a\r\nb\r\n'), Buffer.from('a\r\nb\n'))) === '{"before":1,"after":2}', 'crlfDelta: 1→2 증가 = 혼입')
ok(S.crlfDelta(Buffer.from('a\r\nb\n'), Buffer.from('a\r\nb\r\n')) === null, 'crlfDelta: 감소/동일은 혼입 아님')
ok(S.crlfDelta(Buffer.from([0x89, 0x50, 0, 13, 13]), null) === null, '바이너리(NUL 포함)는 제외')

console.log('# ⑤ in-place sed')
const SED = ['sed', '-i'].join(' ')
ok(S.checkSedInplace(`fix: ${SED} 로 치환`, []).length === 1, '커밋 메시지 흔적 적중')
ok(S.checkSedInplace('ok', [`+  ${SED} 's/a/b/' x.js`, `+ ${['sed', '-E', '-i'].join(' ')} 's/a/b/' y`, `+ ${['sed', '--in-place'].join(' ')} s/a/b/ z`]).length === 3, 'diff 추가 줄 흔적 3종(-i, -E -i, --in-place) 적중')
ok(S.checkSedInplace('sed -n 1,5p 는 읽기', ['+ sed -n 3p file', "+ sed 's/a/b/' file > out"]).length === 0, '읽기 전용 sed 는 미적중')

console.log('# J 확률 게이트')
const stub = (answers, extra = {}) => async () => ({ ok: true, answers, inputTokens: 100, ms: 5, ...extra })
const ch = (choice, p) => ({ type: 'choice', choice, confidence: p, probabilities: { [choice]: p } })
const j1 = await S.judge(['J2', 'J3', 'J4'], 'x', stub({ J2: ch('있음', 0.95), J3: ch('단정', 0.8), J4: ch('명시', 0.5) }))
const g = Object.fromEntries(j1.results.map((r) => [r.id, r]))
ok(g.J2.gate === 'confirmed' && g.J2.p === 0.95 && g.J2.label === '있음', 'p 0.95 → 확정 (라벨과 확률 둘 다 보존)')
ok(g.J3.gate === 'estimated' && g.J3.gateText === '추정', 'p 0.80 → 추정')
ok(g.J4.gate === 'escalate' && g.J4.gateText === 'LLM 검토 필요', 'p 0.50 → LLM 검토 필요(승격)')
ok(C.gateOf(0.9) === 'confirmed' && C.gateOf(0.7) === 'estimated' && C.gateOf(0.6999) === 'escalate' && C.gateOf(NaN) === 'unavailable', '경계값 0.90/0.70')
const ja = await S.judge(['J1'], 'x', stub({ J1: ch('없음', 0.97) }))
ok(ja.results[0].gate === 'estimated' && /보조/.test(ja.results[0].gateText), '보조 항목(J1, 실측 <80%)은 p 0.97 이어도 확정으로 올리지 않는다')
const jf = await S.judge(['J2'], 'x', async () => ({ ok: false, error: 'timeout' }))
ok(jf.results[0].label === null && jf.results[0].gateText === '판정 불가 — 수동 검토' && jf.error === 'timeout', 'Jev 실패 → 판정 불가 — 수동 검토(조용한 실패 금지)')
const jt = await S.judge(['J2'], 'x', async () => { throw new Error('boom') })
ok(jt.results[0].gate === 'unavailable', 'ask 예외도 판정 불가로 값 처리')
const jb = await S.judge(['J2'], 'x', stub({ J2: ch('모름', 0.99) }))
ok(jb.results[0].gate === 'unavailable', '후보 밖 라벨 → 판정 불가')

console.log('# J6 스위트')
const tap = [
  'TAP version 13',
  '#   PASS a',
  '#   FAIL ⑥d 더보기 시트 칩 균등폭 ≥44px, 실제 39.9',
  '# Subtest: E:\\\\code-project\\\\360\\\\tests\\\\p46-upload-button.test.mjs',
  'not ok 1 - E:\\\\code-project\\\\360\\\\tests\\\\p46-upload-button.test.mjs',
  '  ---',
  "  error: 'test failed'",
  '  ...',
  '# Subtest: tests/p2.test.mjs',
  'ok 2 - tests/p2.test.mjs',
  'not ok 3 - tests/p3.test.mjs',
  '  ---',
  "  error: 'listen EADDRINUSE: address already in use 127.0.0.1:8788'",
  '  ...',
  '1..3',
].join('\n')
const fails = S.parseSuiteLog(tap)
ok(fails.length === 2, `TAP 최상위 실패 2건 → ${fails.length}`)
ok(fails[0] && fails[0].name === 'E:\\code-project\\360\\tests\\p46-upload-button.test.mjs' && /⑥d/.test(fails[0].error), `TAP 경로 역이스케이프 + 첫 FAIL 줄 → ${fails[0] && fails[0].error}`)
ok(fails[1] && /EADDRINUSE/.test(fails[1].error), `YAML error 줄('test failed' 제외) → ${fails[1] && fails[1].error}`)
const spec = S.parseSuiteLog('✔ a (1ms)\n✖ tests/p9.test.mjs (20ms)\n  AssertionError: 1 !== 2\n')
ok(spec.length === 1 && spec[0].name === 'tests/p9.test.mjs' && /AssertionError/.test(spec[0].error), 'spec 리포터 ✖ 줄도 파싱')
let calls = 0
const counting = async () => { calls++; return { ok: true, answers: { J6: ch('실제회귀', 0.93) }, inputTokens: 50, ms: 3 } }
const js = await S.judgeSuite([{ name: 'a', error: 'x' }, { name: 'b', error: 'y' }], { ask: counting, rerun: (f) => (f.name === 'a' ? 0 : 1) })
ok(js.results[0].label === '플레이크' && js.results[0].source === 'rule' && js.results[0].gate === 'rule', '단독 재실행 EXIT=0 → 규칙으로 플레이크')
ok(js.results[0].failLine === 'x' && js.results[0].error === null && js.results[1].failLine === 'y', '실패 첫 줄(failLine)과 Jev 오류(error)를 섞지 않는다')
ok(calls === 1 && js.results[1].label === '실제회귀' && js.results[1].gate === 'confirmed', `Jev 는 나머지에만 호출(1회) → ${calls}`)
ok(/단독 재실행: EXIT=1/.test(S.suiteState({ name: 'b', error: 'y', rerun: 1 })), 'J6 state 에 재실행 결과 포함')

console.log('# 키 안전 · 폴백')
const FAKE = 'sk-or-v1-FAKEKEY-' + 'x'.repeat(20)
const r401 = await C.jevDecide({ state: 's', questions: {}, key: FAKE, fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }) })
ok(!r401.ok && /http-401/.test(r401.error) && !r401.error.includes(FAKE), '401 → 값 실패, 에러 문자열에 키 없음')
let n429 = 0
await C.jevDecide({ state: 's', questions: {}, key: FAKE, fetchImpl: async () => { n429++; return { ok: false, status: 429, text: async () => '' } } })
ok(n429 === 2, `429 는 1회만 재시도 → 호출 ${n429}`)
const rnk = await C.jevDecide({ state: 's', questions: {}, key: '' })
ok(!rnk.ok && /no-key/.test(rnk.error), '키 없음 → no-key')
let body = null
await C.jevDecide({ state: 's', questions: { J2: S.QUESTIONS.J2 }, key: FAKE, fetchImpl: async (u, o) => { body = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ answers: {} }) } } })
ok(body && body.model === C.JEV_MODEL && body.questions.J2.type === 'choice' && body.questions.J2.instructions && body.questions.J2.criteria, '요청 형식: model·state·questions{type:choice, instructions(필수), criteria}')

console.log('# CLI exit code')
const tmp = join(ROOT, '.tmp', 'p116')
mkdirSync(tmp, { recursive: true })
const env = { ...process.env, TEMP: join(ROOT, '.tmp'), TMP: join(ROOT, '.tmp'), OPENROUTER_API_KEY: '' }
const cli = (args) => spawnSync(process.execPath, [join(ROOT, 'build-tools/jev-supervise.mjs'), ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 120000 })
if (hasCommit('23c0680')) {
  const c1 = cli(['--commits', '23c0680', '--out', join(tmp, 'c1.json')])
  ok(c1.status === 1 && /①번들 23c0680 \| 위반/.test(c1.stdout), `--commits 23c0680 → EXIT=${c1.status} (위반 있음 = 1)`)
  const saved = JSON.parse(readFileSync(join(tmp, 'c1.json'), 'utf8'))
  ok(saved.violations > 0 && saved.commits.commits[0].bundle.length === 3, 'JSON 산출물(UTF-8) 기록')
}
if (hasCommit('0fe4386')) {
  const c0 = cli(['--commits', '0fe4386', '--out', join(tmp, 'c0.json')])
  ok(c0.status === 0, `--commits 0fe4386(위반 없음) → EXIT=${c0.status}`)
}
const cr = cli(['--report', 'tests/p116-jev-supervise.test.mjs', '--out', join(tmp, 'r.json')])
ok(cr.status === 0 && /판정 불가 — 수동 검토/.test(cr.stdout), `키 없는 --report → 판정 불가 표시, EXIT=${cr.status}(Jev 는 exit code 무영향)`)
const cu = cli([])
ok(cu.status === 2, `인자 없음 → 사용법 EXIT=${cu.status}`)

console.log(failed ? `# [${failed} FAILED]` : '# ALL PASS')
process.exitCode = failed ? 1 : 0
