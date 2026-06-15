-- 0004_zones: 배포본에 영역(Zone) 데이터 컬럼 추가
-- zones: [{id,page,x,y,w,h,label,color,pinIds[],note}] (좌표는 % 단위, 줌/팬 무관)
-- NOTE: SQLite는 ADD COLUMN IF NOT EXISTS 미지원. 이미 존재 시 prod 적용 전 수동 확인.
ALTER TABLE deployments ADD COLUMN zones TEXT DEFAULT '[]';
