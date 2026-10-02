/* ════════════════════════════════════════════════════════════
   build-tools/lib/jev-client.mjs — [WO 20261002-jevsupervise] Jev(TypeSafe System One) 호출 + 확률 게이트

   재사용 근거(새로 발명하지 않는다):
     · 엔드포인트·모델 = src/lib/jev.ts 의 검증된 호출(JEV_ENDPOINT · JEV_MODEL) 과 동일
       (OpenRouter `alpha/decisions` · `typesafe/jev-1.13`, 실측 200 — _warehouse/jev/JEV_PLAYBOOK.md:44)
     · 질문 형식 = docs.typesafe.ai/primitives/choice (2026-10-02 라이브 문서 확인):
       { type:'choice', instructions, criteria:{옵션:설명} } → answers[k] = { choice, confidence, probabilities }
       🔴 instructions 필수(빠지면 400 invalid_union — src/lib/jev.ts:175 실측 주석)
     · 비용 = 입력 $0.042 / 1M 토큰, 출력 무료 (JEV_PLAYBOOK.md:127-128)

   🔴 키: 환경변수 OPENROUTER_API_KEY 에서만 읽는다. 값을 로그·에러·파일에 담지 않는다.
   🔴 실패(키 없음·HTTP 오류·타임아웃)는 예외가 아니라 값 { ok:false, error } 로 돌려준다 — 삼키는 catch 금지.
   ════════════════════════════════════════════════════════════ */

export const JEV_ENDPOINT = process.env.JEV_ENDPOINT || 'https://openrouter.ai/api/alpha/decisions'
export const JEV_MODEL = process.env.JEV_MODEL || 'typesafe/jev-1.13'
export const JEV_TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS) || 15000
export const PRICE_IN_PER_TOKEN = 0.042 / 1_000_000

/* 확률 게이트(WO 20261002-jevsupervise §규칙) — 라벨만 쓰지 말고 확률로 판정 상태를 정한다 */
export const GATE_CONFIRM_P = 0.90
export const GATE_ESTIMATE_P = 0.70

/** 상태 문자열(표 출력·JSON 공통 SoT) */
export const GATE_LABEL = Object.freeze({
  confirmed: '확정',
  estimated: '추정',
  escalate: 'LLM 검토 필요',
  unavailable: '판정 불가 — 수동 검토',
  rule: '규칙 확정',
})

/** p → 게이트 상태. 숫자가 아니거나 범위를 벗어나면 'unavailable'(조용히 확정으로 넘기지 않는다). */
export function gateOf(p) {
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return 'unavailable'
  if (p >= GATE_CONFIRM_P) return 'confirmed'
  if (p >= GATE_ESTIMATE_P) return 'estimated'
  return 'escalate'
}

/**
 * choice 답 하나를 판정 레코드로 바꾼다. p = 선택된 옵션의 probability(문서: probabilities 는 옵션별 확률).
 * @returns {{label:string|null, p:number|null, confidence:number|null, probabilities:object|null, gate:string}}
 */
export function readChoice(answer, allowed) {
  const a = answer && typeof answer === 'object' ? answer : null
  const label = a && typeof a.choice === 'string' ? a.choice : null
  if (!label || (allowed && !allowed.includes(label))) {
    return { label: null, p: null, confidence: null, probabilities: null, gate: 'unavailable' }
  }
  const probs = a.probabilities && typeof a.probabilities === 'object' ? a.probabilities : null
  const p = probs && typeof probs[label] === 'number' ? probs[label] : null
  const confidence = typeof a.confidence === 'number' ? a.confidence : null
  return { label, p, confidence, probabilities: probs, gate: gateOf(p) }
}

const RETRYABLE = new Set([429, 529])

/**
 * Jev 1회 호출(429/529 만 1회 백오프, 401 재시도 금지).
 * @param {{state:unknown, questions:object, key?:string, fetchImpl?:Function, timeoutMs?:number}} o
 * @returns {Promise<{ok:true, answers:object, inputTokens:number, ms:number} | {ok:false, error:string, ms:number}>}
 */
export async function jevDecide(o) {
  const t0 = Date.now()
  const key = o.key !== undefined ? o.key : process.env.OPENROUTER_API_KEY
  if (!key) return { ok: false, error: 'no-key(OPENROUTER_API_KEY)', ms: 0 }
  const doFetch = o.fetchImpl || globalThis.fetch
  const body = JSON.stringify({ model: JEV_MODEL, state: o.state, questions: o.questions })
  const timeoutMs = o.timeoutMs || JEV_TIMEOUT_MS

  const once = async () => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const r = await doFetch(JEV_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body,
        signal: ac.signal,
      })
      if (!r.ok) {
        // 본문 앞부분만(키는 요청 헤더에만 있으므로 응답 본문에 섞이지 않는다)
        const txt = await r.text().catch(() => '')
        return { status: r.status, detail: String(txt).slice(0, 160) }
      }
      const j = await r.json()
      return { status: 200, json: j }
    } finally {
      clearTimeout(timer)
    }
  }

  try {
    let res = await once()
    if (RETRYABLE.has(res.status)) {
      await new Promise((r) => setTimeout(r, 600))
      res = await once()
    }
    const ms = Date.now() - t0
    if (res.status !== 200) return { ok: false, error: 'http-' + res.status + (res.detail ? ':' + res.detail : ''), ms }
    const answers = res.json && res.json.answers && typeof res.json.answers === 'object' ? res.json.answers : null
    if (!answers) return { ok: false, error: 'no-answer', ms }
    const usage = (res.json && res.json.usage) || {}
    return { ok: true, answers, inputTokens: Number(usage.input_tokens) || 0, ms }
  } catch (e) {
    const name = (e && (e.name || (e.constructor && e.constructor.name))) || 'error'
    return { ok: false, error: name === 'AbortError' ? 'timeout' : 'network:' + String(name).slice(0, 40), ms: Date.now() - t0 }
  }
}
