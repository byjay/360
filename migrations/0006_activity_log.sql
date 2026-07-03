-- 활동 로그 (슈퍼관리자가 전체 기록을 관리)
-- 로그인, 프로젝트/데크/포인트/배포 생성·삭제 등 주요 액션을 기록한다.
CREATE TABLE IF NOT EXISTS activity_log (
  id          TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,           -- epoch ms
  actor_email TEXT,                       -- 행위자 이메일 (게스트=NULL)
  actor_role  TEXT,                       -- super / designer / viewer / guest
  action      TEXT NOT NULL,              -- login / project.create / pin.create ...
  target_type TEXT,                       -- project / deck / pin / deployment / auth ...
  target_id   TEXT,                       -- 대상 식별자
  detail      TEXT,                       -- 부가 설명(JSON 문자열 가능)
  ip          TEXT,                       -- 요청 IP(CF-Connecting-IP)
  ua          TEXT,                       -- User-Agent (앞부분)
  deleted     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_activity_ts        ON activity_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_activity_actor      ON activity_log(actor_email);
CREATE INDEX IF NOT EXISTS idx_activity_action     ON activity_log(action);
CREATE INDEX IF NOT EXISTS idx_activity_target     ON activity_log(target_type, target_id);
