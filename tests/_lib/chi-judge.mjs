/**
 * 초대 토큰(hex) 자리 분포 균등성 판정 — p40 §② 전용, 재사용을 위해 분리.
 *
 * 단일 표본 카이제곱 1회 판정(임계값 37.7 = df15 p=0.001)은 정상 난수라도
 * 약 1/1000 확률로 거짓 실패한다(2026-09-28 실측: 3회 중 1회 발생, RUN3).
 * → 독립 표본 3회를 뽑아 **2회 이상 통과**해야 최종 통과로 완화한다.
 *   거짓 실패율 = P(Binomial(3, 0.001) >= 2) ≈ 3*(0.001)^2 = 3e-6 (기존의 1/300 수준).
 * 편향된 생성기는 3회 전부 비정상적으로 큰 카이제곱을 내므로 검출력은 그대로 유지된다
 * (아래 tests/p40-invite-account.test.mjs 의 카나리아 어서션이 매 실행마다 이를 증명한다).
 */
export const CHI_BINS = 16;
export const CHI_THRESHOLD = 37.7; // df=15, p=0.001 (표본 1회 기준 임계값)

export function chiSquareStat(tokens) {
  const hist = new Array(CHI_BINS).fill(0);
  let n = 0;
  for (const t of tokens) for (const ch of t) { hist[parseInt(ch, 16)]++; n++; }
  const exp = n / CHI_BINS;
  return hist.reduce((a, o) => a + (o - exp) * (o - exp) / exp, 0);
}

export function trialPass(tokens) { return chiSquareStat(tokens) < CHI_THRESHOLD; }

/** trials: 독립 표본(hex 문자열 배열) 3개. 2개 이상 통과해야 ok=true. */
export function majorityVerdict(trials) {
  const chis = trials.map(chiSquareStat);
  const passes = chis.map((c) => c < CHI_THRESHOLD);
  const passCount = passes.filter(Boolean).length;
  return { chis, passes, passCount, ok: passCount >= 2 };
}
