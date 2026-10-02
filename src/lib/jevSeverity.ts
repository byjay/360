/* ════════════════════════════════════════════════════════════
   src/lib/jevSeverity.ts — [WO 20261002-gap 묶음C] 결함 노트 본문 → 심각도(상/중/하) 제안
   🔴 마스터 확정(2026-10-02): "Jev는 제안만, 사람이 확정." 자동 확정 금지(전역 CLAUDE.md §1-B).
   역할 분담(SoT): 이 파일 = Jev 원시 확률만 돌려준다. 게이트(p≥0.9 자동선택 / 0.7~0.9 「추정」 /
   <0.7 빈칸)와 저장 전 사람 확정은 호출부(서버 라우트 + 클라 UI)가 한다.
   후보 고정: {상, 중, 하} — choice 1문항. 산문 없음(스킬 §3).
   ════════════════════════════════════════════════════════════ */

import { jevDecide, type JevRaw } from './jev'

/** 확률 게이트(스킬 §3 — 작업마다 정하고 기록) — 전역 §1-B 의 p≥0.90/0.70~0.90/<0.70 3단과 동일. */
export const SEVERITY_AUTO_P = 0.90
export const SEVERITY_ESTIMATE_P = 0.70

export const SEVERITY_LEVELS = ['상', '중', '하'] as const
export type SeverityLevel = typeof SEVERITY_LEVELS[number]

/** 노트 본문 길이 상한 — 입력 토큰 비용(스킬 §5). 긴 본문은 앞부분만 판정에 쓴다. */
export const SEVERITY_BODY_MAX = 400

export const SEVERITY_INSTRUCTIONS =
  '현장 결함 메모를 읽고 심각도를 판정하라. ' +
  '상 = 안전·구조·누수·전기 등 즉시 조치가 필요한 결함. ' +
  '중 = 기능상 문제이나 즉시 위험하지 않은 결함. ' +
  '하 = 외관·마감 등 경미한 결함.'
export const SEVERITY_CRITERIA = {
  상: '안전·구조 등 즉시 조치가 필요한 결함',
  중: '기능 문제이나 즉시 위험하지 않은 결함',
  하: '외관·마감 등 경미한 결함',
}

export type SeverityProbe =
  | { ok: true; label: SeverityLevel; p: number }
  | { ok: false; error: string }

/**
 * 노트 본문 1건 → 심각도 제안(원시 확률). 🔴 실패는 값으로 돌려준다(폴백 = 빈칸, 호출부가 처리).
 * `decide` 는 테스트 주입점(기본 = 실 jevDecide, src/lib/jev.ts 의 공유 호출 지점).
 */
export async function askJevSeverity(
  env: { OPENROUTER_API_KEY?: string } | undefined,
  noteBody: string,
  decide: typeof jevDecide = jevDecide
): Promise<SeverityProbe> {
  const body = String(noteBody || '').trim().slice(0, SEVERITY_BODY_MAX)
  if (!body) return { ok: false, error: 'empty-body' }
  let raw: JevRaw
  try {
    raw = await decide(
      env,
      `결함 메모: ${body}`,
      { severity: { type: 'choice', instructions: SEVERITY_INSTRUCTIONS, criteria: SEVERITY_CRITERIA } }
    )
  } catch (e: any) {
    raw = { ok: false, error: 'throw:' + String((e && e.name) || 'error').slice(0, 40) }
  }
  if (!raw.ok) return raw
  const a = raw.answers.severity
  const label = a && a.choice
  const p = a && a.probabilities ? a.probabilities[label] : undefined
  if (!SEVERITY_LEVELS.includes(label) || typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
    return { ok: false, error: 'bad-answer' }
  }
  return { ok: true, label, p }
}

/** 게이트 — p≥0.9 자동선택(estimated:false) / 0.7~0.9 「추정」(estimated:true) / <0.7 빈칸(null).
 *  🔴 라벨만 쓰지 말고 확률을 쓴다(스킬 §3) — 사람이 저장 전 반드시 확정(자동확정 금지, 호출부 책임). */
export function gateSeverity(probe: SeverityProbe): { level: SeverityLevel | null; estimated: boolean; p: number | null } {
  if (!probe.ok) return { level: null, estimated: false, p: null }
  if (probe.p >= SEVERITY_AUTO_P) return { level: probe.label, estimated: false, p: probe.p }
  if (probe.p >= SEVERITY_ESTIMATE_P) return { level: probe.label, estimated: true, p: probe.p }
  return { level: null, estimated: false, p: probe.p }
}
