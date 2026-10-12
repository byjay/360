-- [WO 20261012-viewlink] 열람자 코멘트(요청·질문)의 출처와 사진 시점 — 추가 전용(비파괴). 백필 없음.
--   마스터 "뷰어는 ... 코멘트노드의 쓰기 권한으로 작성후 디자이너에게 문의할 권한만 있어"
--        "요청질문은 사진이 나온상태로 하고 사진내에서 가능하게해"
-- link_ref  : 작성한 열람 링크 — view_links.id 또는 'share:<공유주소 지문 24자>'. 실계정 작성은 NULL.
--             열람 세션엔 사람 신원이 없으므로(이메일 없음) 디자이너가 "어느 링크에서 온 요청인지"를 이 값으로 안다.
-- pano_view : 작성 당시 360 사진·시점 JSON {"image_id","yaw","pitch","fov"} — 요청함에서 같은 사진·같은 방향으로 연다.
--             사진 밖(도면) 요청·구버전 노트는 NULL.
ALTER TABLE pin_notes ADD COLUMN link_ref TEXT;
ALTER TABLE pin_notes ADD COLUMN pano_view TEXT;
