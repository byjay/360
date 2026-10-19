/* ══════════════════════════════════════════════════════════════
   WEBHOOKS/API — 외부 연동(Procore 등) 기반 (WO 20261019-gap3)
   🔴 테스트 대상(순수): isPrivateOrLocalHost/validateWebhookUrl/hmacSignHex(암호 API만 비순수,
     네트워크·DOM 없음)/deliverWithRetry(fetch 주입 가능 — 테스트는 스텁 fetch로 검증).
   SoT: SSRF 가드는 validateWebhookUrl 하나 — 웹훅 등록 시점과 발송 시점 둘 다 이 함수를 통과해야 한다.
══════════════════════════════════════════════════════════════ */

/** 사설/루프백/링크로컬 IPv4 또는 localhost 계열 호스트명인가(SSRF 가드). IPv6 사설대역은 범위가
 *  넓어(fc00::/7 등) 완전 커버하지 않고 ::1 만 차단 — 운영 웹훅은 https 공개 도메인을 쓰므로 실사용 영향 0,
 *  이름이 없는 값을 지어내지 않는다(판정은 "알려진 패턴만"). */
export function isPrivateOrLocalHost(hostname: string): boolean {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '')
  if (!h) return true
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true
  if (h.endsWith('.local')) return true
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const a = +m[1], b = +m[2]
    if (a === 127) return true          // loopback
    if (a === 10) return true           // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true  // 172.16.0.0/12
    if (a === 192 && b === 168) return true           // 192.168.0.0/16
    if (a === 169 && b === 254) return true           // link-local
    if (a === 0) return true
  }
  return false
}

/** 웹훅 URL 검증(SSRF 가드 단일 지점) — https 만 허용, 사설·루프백·localhost 거부.
 *  testMode=true 면 http + 사설/로컬 호스트를 허용(로컬 수신 서버로 [테스트 전송] 검증용, §지시). */
export function validateWebhookUrl(url: string, testMode: boolean): { ok: true, url: URL } | { ok: false, error: string } {
  let u: URL
  try { u = new URL(String(url || '')) } catch { return { ok: false, error: 'invalid url' } }
  if (u.protocol !== 'https:' && !(testMode && u.protocol === 'http:')) {
    return { ok: false, error: 'https required' }
  }
  if (!testMode && isPrivateOrLocalHost(u.hostname)) {
    return { ok: false, error: 'private/local host rejected (ssrf guard)' }
  }
  return { ok: true, url: u }
}

/** HMAC-SHA256 서명(hex) — 웹훅 수신측이 X-Webhook-Signature 로 발신처를 검증하는 유일한 수단. */
export async function hmacSignHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export type DeliveryAttempt = { attempt: number, ok: boolean, status?: number, error?: string }
export type DeliveryResult = { attempts: DeliveryAttempt[], finalOk: boolean }

const DEFAULT_BACKOFF_MS = [500, 1500, 3000]

/** 지수 백오프 재시도(최대 3회, 기본) — fetchFn/delayFn 주입 가능(테스트는 실 네트워크 0, 가짜 delay). */
export async function deliverWithRetry(
  url: string, body: string, headers: Record<string, string>,
  opts: { attempts?: number, fetchFn?: typeof fetch, delayFn?: (attemptIdx: number) => Promise<void> } = {}
): Promise<DeliveryResult> {
  const attempts = Number.isFinite(opts.attempts) ? Number(opts.attempts) : 3
  const fetchFn = opts.fetchFn || fetch
  const delayFn = opts.delayFn || ((i: number) => new Promise<void>((r) => setTimeout(r, DEFAULT_BACKOFF_MS[i] || 3000)))
  const log: DeliveryAttempt[] = []
  for (let i = 0; i < attempts; i++) {
    let rec: DeliveryAttempt
    try {
      const res = await fetchFn(url, { method: 'POST', headers, body })
      rec = { attempt: i + 1, ok: res.status >= 200 && res.status < 300, status: res.status }
    } catch (e: any) {
      rec = { attempt: i + 1, ok: false, error: String((e && e.message) || e) }
    }
    log.push(rec)
    if (rec.ok) return { attempts: log, finalOk: true }
    if (i < attempts - 1) await delayFn(i)
  }
  return { attempts: log, finalOk: false }
}

/** 고정 윈도(기본 60s) 레이트리밋 — D1 행 자체에 카운터를 둔다(별도 KV/DO 없음, 단일 SoT).
 *  반환: 허용되면 다음에 DB 에 쓸 {windowStart,count}, 거부되면 null. */
export function rateLimitStep(
  row: { rl_window_start?: number, rl_count?: number } | null | undefined,
  limitPerWindow: number, windowMs: number, now: number
): { windowStart: number, count: number } | null {
  const ws = Number(row && row.rl_window_start) || 0
  const cnt = Number(row && row.rl_count) || 0
  if (now - ws >= windowMs) return { windowStart: now, count: 1 } // 새 윈도
  if (cnt >= limitPerWindow) return null
  return { windowStart: ws, count: cnt + 1 }
}

/** API 키 발급용 원문 생성 — 접두사로 프로젝트 쓰기 범위 식별(wk_live_ 등은 쓰지 않음, 단순 랜덤 토큰). */
export function newApiKeyPlain(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 32)
  return 'wk_' + b64
}
