-- [WO 20261007-aivision · 무료 전환] Workers AI Neuron 집계 컬럼 — 전체 일일 상한(무료 할당량 안) 판정에 쓴다.
-- 🔴 추가 컬럼만(0037 불변). prod 적용은 지휘자가 한다. 집계: SUM(neurons) WHERE created_at >= UTC 자정.
ALTER TABLE ai_vision_results ADD COLUMN neurons REAL;   -- 호출 1건이 쓴 Neurons(usage 토큰 × 모델 환산율, 없으면 보수적 고정값)
