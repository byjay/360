-- 0011_deployment_annotations.sql
-- [P0-1 🔴 데이터 유실 봉인] PDF 주석(annotations) 영속화
-- 배경: 클라이언트는 main.js:6415 에서 annotations 를 저장 요청하지만,
--       서버 mapDeployment / INSERT / UPDATE / 스키마 모두에 컬럼이 없어
--       저장 직후 영구 소실되었다. (로드 시 dep.annotations 는 항상 undefined)
-- 조치: deployments 테이블에 annotations 컬럼 추가(기본 '[]').
ALTER TABLE deployments ADD COLUMN annotations TEXT DEFAULT '[]';
