/* ════════════════════════════════════════════════════════════
   src/lib/util.ts — 순수 유틸(이메일·랜덤·해시). Hono 컨텍스트 의존 0.
   [리팩토링 1단계] index.tsx 에서 추출. 한 파일 한 책임.
   ════════════════════════════════════════════════════════════ */

export function normEmail(s: string): string { return String(s || '').trim().toLowerCase() }
export function emailDomain(email: string): string { const i = email.indexOf('@'); return i < 0 ? '' : email.slice(i + 1) }
export function isValidEmail(email: string): boolean { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) }
export function gen6(): string { return String(Math.floor(100000 + Math.random() * 900000)) }

export function randToken(prefix: string): string {
  const a = new Uint8Array(24); crypto.getRandomValues(a)
  let h = ''; for (const x of a) h += x.toString(16).padStart(2, '0')
  return prefix + h
}

export function bufToHex(buf: ArrayBuffer): string {
  const a = new Uint8Array(buf); let h = ''
  for (const x of a) h += x.toString(16).padStart(2, '0')
  return h
}

/** PBKDF2(SHA-256, 100k) 비밀번호 해시 */
export async function hashPassword(password: string, saltHex?: string): Promise<{ hash: string; salt: string }> {
  let salt: Uint8Array
  if (saltHex) {
    salt = new Uint8Array(saltHex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)))
  } else {
    salt = new Uint8Array(16); crypto.getRandomValues(salt)
  }
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, baseKey, 256)
  return { hash: bufToHex(bits), salt: bufToHex(salt.buffer) }
}

/** 상수시간 비교 비밀번호 검증 */
export async function verifyPassword(password: string, saltHex: string, hashHex: string): Promise<boolean> {
  const { hash } = await hashPassword(password, saltHex)
  if (hash.length !== hashHex.length) return false
  let diff = 0
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ hashHex.charCodeAt(i)
  return diff === 0
}
