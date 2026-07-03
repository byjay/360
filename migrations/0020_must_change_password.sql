-- 0020: 초대 계정의 첫 로그인 후 비밀번호 변경 강제 플래그
-- 멤버 초대 시 비번 '1'로 자동 생성된 계정은 must_change_password=1 → 첫 로그인 후 변경 유도
ALTER TABLE local_users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
