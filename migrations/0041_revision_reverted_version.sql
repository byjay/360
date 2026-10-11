-- [WO 20261011-offmerge R2] 개정 되돌리기(undo)가 일어난 배포본 버전(되돌림 직전 version).
-- 오프라인 편집 재기준화(src/index.tsx revsSinceVersion)가 "편집 기준 버전 이후에 되돌렸는가"를 판정해 역변환(invertAff)을 적용한다.
-- 기존 행은 NULL(되돌림 시점 모름) — 그 경우 서버는 좌표를 추정 변환하지 않고 검토 표시만 단다. 기존 데이터 변경 없음(열 추가만).
ALTER TABLE drawing_revisions ADD COLUMN reverted_version INTEGER;
