-- 멀티유저 동시작업 충돌 방지: 낙관적 잠금(Optimistic Locking)용 version 컬럼
-- 저장 시 클라이언트가 보낸 base_version 과 서버 version 을 비교하여
-- 일치할 때만 갱신(version+1), 불일치 시 409 충돌 응답 → 클라이언트가 병합 후 재시도.
ALTER TABLE deployments ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
