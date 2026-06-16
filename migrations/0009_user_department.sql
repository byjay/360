-- 0009_user_department.sql
-- 회원가입 시 "부서/소속" 저장 컬럼 추가 (요구사항: 이름 + 회사 + 부서 입력)
-- 이미 존재하면 무시(에러 방지를 위해 별도 마이그레이션으로 분리)

ALTER TABLE local_users ADD COLUMN department TEXT;
