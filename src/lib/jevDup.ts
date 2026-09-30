/* ════════════════════════════════════════════════════════════
   src/lib/jevDup.ts — [WO 20260930-merge] 구역 합치기 미리보기의 "같은 위치 중복 핀" 판정(Jev)
   마스터: "다른 사람이 한 포인트도 전체 복사해서 구역 단위로 합치는 기능" + "jev 를 활용하는 게 목적"

   🔴 역할 분담(SoT):
     · 이 파일 = Jev 원시 확률만 돌려주는 얇은 어댑터. 판정 게이트(p≥0.90 사용 / 0.70~0.90 추정 /
       p<0.70 거리 규칙)와 거리 규칙은 **클라이언트 한 곳**(public/js/modules/41_RegionMerge.js
       RegionMerge.decideDup)에 있다 — 서버가 꺼져도(오프라인) 같은 규칙으로 판정해야 하기 때문.
     · 중복 판정은 **표시와 "선택 해제" 기본값에만** 쓴다. 삭제·확정 판단에는 쓰지 않는다(전역 §1-B).
   후보 고정: {same, different} — choice 1문항/쌍. 산문 없음.
   ════════════════════════════════════════════════════════════ */

import { jevDecide, type JevRaw } from './jev'

/** 한 요청에 담는 쌍 상한 — state 가 곧 입력 토큰 비용이고 32K 컨텍스트 상한이 있다(스킬 §5).
 *  쌍 1개 state ≈ 60~90 토큰(라벨·메모 60자·사진명 40자 절단) × 40 ≈ 3.6K — 상한의 1/8 이하. 클라가 이 단위로 나눠 보낸다. */
export const DUP_MAX_PAIRS = 40

/** 질문 — "같은 현장 지점을 다시 찍은 것인가". 라벨 번호만 같다고 같은 지점이 아니다(대역이 다른 두 사람). */
export const DUP_INSTRUCTIONS =
  '도면 위 두 점검 포인트가 현장의 같은 지점을 가리키는가? `distance_pct` 는 도면(구역) 폭·높이 기준 % 거리다. ' +
  '라벨 번호가 같아도 다른 사람이 따로 매긴 번호일 수 있다. 메모·사진명이 같은 대상을 말하면 같은 지점으로 본다.'
export const DUP_CRITERIA = {
  same: '같은 현장 지점을 두 번 기록한 것(중복)',
  different: '가까이 있지만 서로 다른 점검 대상',
}

export type DupBrief = { label: string; note: string; photo: string }
export type DupPairIn = { i: number; distance_pct: number; incoming: DupBrief; existing: DupBrief }
export type DupProbe = { i: number; ok: true; label: 'same' | 'different'; p: number } | { i: number; ok: false; error: string }

const brief = (b: any): DupBrief => ({
  label: String((b && b.label) ?? '').slice(0, 20),
  note: String((b && b.note) ?? '').slice(0, 60),
  photo: String((b && b.photo) ?? '').slice(0, 40),
})

/** 신뢰 경계 — 클라가 보낸 쌍을 정규화. 형식 오류는 { error } (호출부 400). */
export function sanitizeDupPairs(raw: any): { pairs?: DupPairIn[]; error?: string } {
  if (!Array.isArray(raw) || !raw.length) return { error: 'pairs must be a non-empty array' }
  if (raw.length > DUP_MAX_PAIRS) return { error: 'too many pairs (max ' + DUP_MAX_PAIRS + ')' }
  const out: DupPairIn[] = []
  for (const r of raw) {
    const i = Number(r && r.i), d = Number(r && r.distance_pct)
    if (!Number.isInteger(i) || i < 0 || !Number.isFinite(d) || d < 0) return { error: 'each pair needs integer i and finite distance_pct' }
    out.push({ i, distance_pct: Math.round(d * 1000) / 1000, incoming: brief(r.incoming), existing: brief(r.existing) })
  }
  return { pairs: out }
}

/**
 * 쌍마다 choice 1문항을 한 요청에 병렬로 묻는다(질문끼리 서로 답을 못 본다 — 공식 문서 "Compose and verify").
 * 🔴 실패는 값으로 돌려준다 — 클라가 거리 규칙으로 폴백한다(거짓 성공 금지).
 * `decide` 는 테스트 주입점(기본 = 실 jevDecide).
 */
export async function askJevDupPairs(
  env: { OPENROUTER_API_KEY?: string } | undefined,
  pairs: DupPairIn[],
  decide: typeof jevDecide = jevDecide
): Promise<{ ok: true; probes: DupProbe[] } | { ok: false; error: string }> {
  const state = { pairs: pairs.map((p) => ({ distance_pct: p.distance_pct, incoming: p.incoming, existing: p.existing })) }
  const questions: Record<string, unknown> = {}
  pairs.forEach((_, k) => {
    questions['q' + k] = {
      type: 'choice',
      instructions: { pair: '`pairs[' + k + ']`', question: DUP_INSTRUCTIONS + ' 대상: `pairs[' + k + '].incoming` 와 `pairs[' + k + '].existing`.' },
      criteria: DUP_CRITERIA,
    }
  })
  let raw: JevRaw
  try { raw = await decide(env, state, questions) } catch (e: any) { raw = { ok: false, error: 'throw:' + String((e && e.name) || 'error').slice(0, 40) } }
  if (!raw.ok) return raw
  const probes: DupProbe[] = pairs.map((p, k) => {
    const a = raw.ok ? raw.answers['q' + k] : null
    const label = a && a.choice
    const prob = a && a.probabilities ? a.probabilities[label] : undefined
    if ((label !== 'same' && label !== 'different') || typeof prob !== 'number' || !Number.isFinite(prob) || prob < 0 || prob > 1) {
      return { i: p.i, ok: false, error: 'bad-answer' }
    }
    return { i: p.i, ok: true, label, p: prob }
  })
  return { ok: true, probes }
}
