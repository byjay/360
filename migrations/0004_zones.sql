-- 0004_zones: 배포본에 영역(Zone) 데이터 컬럼 추가
-- zones: [{id,page,x,y,w,h,label,color,pinIds[],note}] (좌표는 % 단위, 줌/팬 무관)
ALTER TABLE deployments ADD COLUMN zones TEXT DEFAULT '[]';
