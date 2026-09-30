/* ════════════════════════════════════════════════════════════
   src/lib/jev.ts — [P68] Jev(TypeSafe System One) 어댑터 + 회사명 게이트 판정 순서
   "허락되지 않은 회사이면 리젝트해" (마스터, 2026-09-28)

   🔴 Jev 가 권한부여의 **최종 판단**을 하지 않는다(전역 CLAUDE.md §1-B 금지 항목).
     초대코드 해시 검증을 **이미 통과한 뒤**의 추가 게이트이고, 애매하면 사람(설계자)에게 넘긴다.

   판정 순서(바꾸지 마라 — decideCompanyGate 가 정본):
     ① 코드 해시 검증          … 호출부(src/index.tsx)에서 선행. 실패 시 여기 오지 않는다
     ② 코드에 company 없음     → 통과 (기존 코드·기존 링크 무손상)
     ③ 규칙(정규화 정확일치)   → 일치하면 통과. 🔴 Jev 를 호출하지 않는다
     ④ 규칙 실패 시에만 Jev 1회
          p >= 0.90 → 통과('추정통과') / p <= 0.10 → 리젝트 / 그 사이 → 보류(사람 승인 대기)
     ⑤ Jev 실패(키 없음·4xx·5xx·타임아웃) → 폴백 = ③의 결과(리젝트)
          🔴 catch 로 삼켜 통과시키지 않는다(거짓 성공 금지, 스킬 §6 폴백 규율)

   실측 근거(2026-09-28, 조선/해양 협력사 24표본):
     · 기존 규칙 단독 일치율 66.7%(16/24) — 정당한 협력사 8건 오리젝트
     · Jev noul 확답(p>=0.90 또는 p<=0.10) 13건 **전부 정답(13/13)**, 폴백(모른다) 45.8%
     · 24건 $0.000386 · 지연 중앙값 211ms
   ════════════════════════════════════════════════════════════ */

import { companyRuleMatch } from './util'

/* ── 임계값(스킬 §3: 작업마다 정하고 기록한다) ──────────────────────────
 * 권한 게이트는 파괴적 판정에 가까우므로 통과 문턱을 0.90 으로 높게 잡고,
 * 🔴 그 사이 구간을 **자동 리젝트가 아니라 보류**로 둔다 — 정당한 협력사를 자동으로 막지 않는다. */
export const COMPANY_GATE_PASS_P = 0.90
export const COMPANY_GATE_REJECT_P = 0.10

export const JEV_MODEL = 'typesafe/jev-1.13'
/** OpenRouter 경유(추가 수수료 없음, 실측 확인). 공식 경로는 POST https://api.typesafe.ai/v1/systemone */
export const JEV_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions'
/** 🔴 게이트가 Jev 때문에 멈추면 안 된다 — 넘으면 폴백(리젝트)으로 떨어진다. */
export const JEV_TIMEOUT_MS = 3000

/** 회사 동일성 질문 — 계열사/자회사를 "같다"로 보면 게이트가 무의미해지므로 명시적으로 배제한다. */
export const SAME_COMPANY_INSTRUCTIONS =
  '열람자가 입력한 소속이 등록된 정식 회사명과 동일한 법인을 가리키는가? ' +
  '표기 차이(법인 접미사, 영문/한글, 약어, 공백, 대소문자)는 동일한 것으로 본다. ' +
  '계열사·자회사·모회사는 다른 법인으로 본다.'

/** Jev 1회 호출 결과. 🔴 성공/실패를 예외가 아니라 값으로 구분한다(삼키는 catch 방지). */
export type JevProbe = { ok: true; p: number } | { ok: false; error: string }
export type JevAsk = (allowed: string, input: string) => Promise<JevProbe>

export type CompanyGateVerdict = 'pass' | 'reject' | 'pending'
/** 감사 기록(스킬 §7-5) — "왜 그렇게 판정됐나"에 나중에 답할 수 있어야 한다. */
export type CompanyGateAudit = {
  applied: boolean
  p: number | null
  threshold: number
  verdict: 'pass' | 'reject' | 'pending' | 'fallback'
}
export type CompanyGateResult = {
  verdict: CompanyGateVerdict
  reason: string
  /** null = 회사 검사 자체가 없었다(코드에 company 미지정). */
  jev: CompanyGateAudit | null
}

const audit = (
  applied: boolean, p: number | null, verdict: CompanyGateAudit['verdict']
): CompanyGateAudit => ({ applied, p, threshold: COMPANY_GATE_PASS_P, verdict })

/**
 * [P68] 회사명 게이트 — 순수 판정 순서. I/O 는 `ask` 로 주입받는다(테스트가 실 로직을 그대로 돈다).
 * 🔴 `ask` 는 ③ 규칙이 실패했을 때만 호출된다.
 */
export async function decideCompanyGate(args: {
  allowed: string | null | undefined
  input: string
  ask: JevAsk
}): Promise<CompanyGateResult> {
  const allowed = String(args.allowed ?? '').trim()
  const input = String(args.input ?? '').trim()

  // ② 코드에 허용 회사가 지정되지 않았다 → 검사 없음(현행 동작 그대로)
  if (!allowed) return { verdict: 'pass', reason: 'no-company-registered', jev: null }

  // ③ 기존 규칙이 확신을 갖고 통과시켰다 → Jev 를 호출하지 않는다
  if (companyRuleMatch(allowed, input)) {
    return { verdict: 'pass', reason: 'rule-exact', jev: audit(false, null, 'pass') }
  }

  // ④ 규칙이 못 잡은 것만 Jev 1회
  let probe: JevProbe
  try {
    probe = await args.ask(allowed, input)
  } catch (e: any) {
    probe = { ok: false, error: 'throw:' + String((e && e.message) || e).slice(0, 80) }
  }

  // ⑤ 폴백 = ③의 결과(= 불일치 = 리젝트). 🔴 실패를 통과로 바꾸지 않는다
  if (!probe.ok || typeof probe.p !== 'number' || !Number.isFinite(probe.p) || probe.p < 0 || probe.p > 1) {
    const err = probe.ok ? 'bad-probability' : probe.error
    return { verdict: 'reject', reason: 'jev-unavailable:' + err, jev: audit(false, null, 'fallback') }
  }

  const p = probe.p
  // 🔴 라벨만 쓰지 말고 확률을 쓴다 — 임계값이 이 게이트의 유일한 안전장치다(스킬 §3)
  if (p >= COMPANY_GATE_PASS_P) return { verdict: 'pass', reason: 'jev-estimated-pass', jev: audit(true, p, 'pass') }
  if (p <= COMPANY_GATE_REJECT_P) return { verdict: 'reject', reason: 'company-mismatch', jev: audit(true, p, 'reject') }
  // 🔴 그 사이 = "모른다". 자동 통과도 자동 리젝트도 하지 않고 사람에게 넘긴다
  return { verdict: 'pending', reason: 'company-uncertain', jev: audit(true, p, 'pending') }
}

/** 429/529 만 짧게 1회 백오프. 401 은 키 문제라 재시도하지 않는다(스킬 §6). */
const RETRYABLE = new Set([429, 529])

/** Jev 원시 결과 — 🔴 성공/실패를 예외가 아니라 값으로 구분한다(삼키는 catch 방지). */
export type JevRaw = { ok: true; answers: Record<string, any> } | { ok: false; error: string }

/**
 * [WO 20260930-merge] Jev 1회 호출 공유 지점(SoT) — 회사명 게이트·중복 핀 판정이 같은 경로를 탄다.
 * 🔴 키는 Cloudflare 시크릿 `OPENROUTER_API_KEY` 에서만 읽고 값을 로그·응답·에러 메시지에 **절대** 담지 않는다
 * (CLAUDE.md Non-Negotiable #4). 타임아웃 JEV_TIMEOUT_MS · 429/529 만 1회 백오프 · 401 재시도 금지.
 */
export async function jevDecide(
  env: { OPENROUTER_API_KEY?: string } | undefined,
  state: unknown,
  questions: Record<string, unknown>
): Promise<JevRaw> {
  const key = env && env.OPENROUTER_API_KEY
  if (!key) return { ok: false, error: 'no-key' }
  const body = JSON.stringify({ model: JEV_MODEL, state, questions })

  const once = async (): Promise<{ status: number; answers?: Record<string, any> }> => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), JEV_TIMEOUT_MS)
    try {
      const r = await fetch(JEV_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body,
        signal: ac.signal,
      })
      if (!r.ok) { await r.text().catch(() => ''); return { status: r.status } }
      const j: any = await r.json()
      return { status: 200, answers: j && j.answers && typeof j.answers === 'object' ? j.answers : undefined }
    } finally {
      clearTimeout(timer)
    }
  }

  try {
    let res = await once()
    if (RETRYABLE.has(res.status)) {
      await new Promise((r) => setTimeout(r, 400))
      res = await once()
    }
    if (res.status !== 200) return { ok: false, error: 'http-' + res.status }
    if (!res.answers) return { ok: false, error: 'no-answer' }
    return { ok: true, answers: res.answers }
  } catch (e: any) {
    // AbortError(타임아웃) 포함. 🔴 키 값이 섞일 수 있는 원문을 그대로 싣지 않는다
    const name = (e && (e.name || e.constructor?.name)) || 'error'
    return { ok: false, error: name === 'AbortError' ? 'timeout' : 'network:' + String(name).slice(0, 40) }
  }
}

/**
 * Jev 실호출 어댑터(회사명 게이트). 호출 자체는 jevDecide(공유 지점)가 한다.
 */
export async function askJevSameCompany(
  env: { OPENROUTER_API_KEY?: string } | undefined,
  allowed: string,
  input: string
): Promise<JevProbe> {
  // state 는 판정에 필요한 2줄만 — 입력 토큰이 그대로 비용이다(스킬 §5)
  const raw = await jevDecide(
    env,
    `등록된 정식 회사명: ${allowed.slice(0, 80)}
열람자가 입력한 소속: ${input.slice(0, 80)}`,
    // 🔴 instructions 는 필수다 — 빠지면 400 invalid_union (실측 확인)
    { same_company: { type: 'noul', instructions: SAME_COMPANY_INSTRUCTIONS } }
  )
  if (!raw.ok) return raw
  // 🔴 noul 은 boolean 이 아니라 0~1 실수다
  const p = raw.answers.same_company ? raw.answers.same_company.noul : undefined
  if (typeof p !== 'number') return { ok: false, error: 'no-answer' }
  return { ok: true, p }
}
