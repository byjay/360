-- [WO 20261001-projectinfo] 프로젝트 정보(자유 메모 + 일정 목록: 방선/점검/회의 등).
-- 마스터: "방선 일정 정보 등도 노트나 메모로 프로젝트 정보에 저장하게 해"
-- 가장 단순한 선택: 서브테이블 대신 TEXT(JSON) 컬럼 1개 — 프로젝트당 일정 수가 적고(수십 건 이하),
-- 동시편집이 드물어 LWW(아래 shape 의 updatedAt)로 충분하다(§5 YAGNI — 정규화 테이블은 과설계).
-- shape: { note: string, schedule: [{id,date,kind,content,done}], updatedAt: number, updatedBy: string }
-- NULL = 아직 저장된 정보 없음(서버가 조용히 {}로 지어내지 않고 parseInfoJson 에서 빈 기본값 반환).
-- 🔴 prod 적용은 지휘자(이 발주 범위 아님) — 로컬/스테이징에서만 검증한다.
ALTER TABLE projects ADD COLUMN info_json TEXT;
