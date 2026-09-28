-- ════════════════════════════════════════════════════════════
-- [P63] 뷰어 초대코드 게이트 — 공유 링크를 받은 사람이 "누구인지" 남기고 들어오게 한다.
--
-- 마스터 확정(2026-09-21): "1단계 = 접속 기록 / 차단은 초대 계정" → "좋아 그렇게 해. 초대코드"
--   공유 링크 접속 → [회사명][이름][초대코드] → 코드 유효면 열람 + 기록 / 무효면 거부.
--
-- 🔴 설계 원칙: **초대코드가 유일한 열쇠**다.
--   회사명·이름은 **자기 신고**라 신뢰하지 않는다 — 대조할 명단이 DB 에 없다.
--   따라서 이름/회사로 차단하지 않고 activity_log 에 **기록만** 한다.
--
-- 🔴 재사용 정책(판단과 근거):
--   [채택] **발급 단위(협력사·현장)별 1개 · 재사용 무제한 · 만료/폐기 가능**
--   · 1회용(project_invites 방식)은 현장에서 못 쓴다 — 마스터는 협력사 단톡방에 링크를 뿌린다.
--     인원만큼 코드를 만들어 배포·관리하는 운영비가 보안 이득보다 크다.
--   · 프로젝트당 1개 공용 코드는 유출 시 전원 재배포가 필요하다(폐기 반경 = 전체).
--   · 발급 단위별 코드는 유출 시 **그 단위만** 폐기하면 된다(폐기 반경 = 한 협력사).
--     누가 들어왔는지는 코드가 아니라 activity_log(이름·소속·IP·시각)로 추적한다.
--   · 인원 제한은 두지 않는다 — 현장 인원은 유동적이고, 상한을 걸면 작업이 멈춘다.
--     대신 use_count/last_used_at 로 비정상 사용을 사후에 본다.
--
-- 🔴 코드 원문은 저장하지 않는다(project_invites 와 동일 원칙).
--   코드는 75비트 암호난수(Crockford base32 15자)라 저엔트로피 추측 대상이 아니므로
--   SHA-256 1회로 충분하다(PBKDF2 스트레칭 불필요). 목록 식별은 code_hint(앞 4자)로만.
--   → 마스터가 코드를 잊으면 재발급한다. "다시 보여주기"는 원문 저장을 요구하므로 하지 않는다.
--
-- 🔴 개인정보 보관 기간: activity_log 에 남는 이름·소속·IP 는 개인정보다.
--   보관 기간 **1년(365일)** — 단일 상수 PERSONAL_LOG_RETENTION_DAYS (src/index.tsx) 가 정본이다.
--   근거: 조선/해양 설계 도면 열람 기록은 계약·감사 대응상 최소 1년이 필요하고,
--         그 이상은 목적 달성에 불필요하다(개인정보보호법 제21조 파기 원칙).
--   ⚠️ 마스터 확인 전이라 **자동 삭제 배치는 만들지 않았다**. 정책 상수만 1곳에 둔다.
--
-- 🔴 추가 전용 비파괴 — 기존 테이블/행 변형 0.
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS project_share_codes (
  id            TEXT PRIMARY KEY,                -- psc_<hex>
  project_id    TEXT NOT NULL,
  label         TEXT NOT NULL,                   -- 발급 단위 이름(예: "대한중공업 배관팀") = 폐기 단위
  code_hash     TEXT NOT NULL UNIQUE,            -- SHA-256(정규화 코드) hex — 🔴 원문 저장 금지
  code_hint     TEXT,                            -- 앞 4자만. 목록에서 "어느 코드인지" 식별용
  created_by    TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,                         -- NULL = 무기한
  revoked       INTEGER NOT NULL DEFAULT 0,      -- 🔴 유출 시 즉시 끊는 수단
  revoked_at    INTEGER,
  revoked_by    TEXT,
  last_used_at  INTEGER,
  use_count     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_psc_project ON project_share_codes(project_id);
CREATE INDEX IF NOT EXISTS idx_psc_hash    ON project_share_codes(code_hash);
