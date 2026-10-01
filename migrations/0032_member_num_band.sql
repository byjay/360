-- [WO 20261001-startno] 100 단위 번호 대역(마스터 확정: 멤버별 자동 배정 + 본인 변경, 서버 저장)
-- 대역 k = (k-1)*100+1 … k*100. CHECKER·360 공통 대역 번호(번호는 계열마다 독립 증가).
-- num_band NULL = 아직 배정 전(기존 행) → 서버 projectBands() 가 조회 시 멤버 추가 순서(created_at)로 빈 대역을 채운다(지연 백필).
-- 소유자는 멤버 테이블에 없을 수 있어 projects.owner_num_band 에 둔다(NULL = 1).
-- 🔴 추가 컬럼만 — 기존 데이터·기존 핀 번호 불변.
ALTER TABLE project_members ADD COLUMN num_band INTEGER;
ALTER TABLE projects ADD COLUMN owner_num_band INTEGER;
