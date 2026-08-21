-- 방향2 A (주최자 소비자 노출): 연락처 공개 여부 플래그.
-- 이름·로고는 항상 소비자 노출(별도 플래그 없음). email/phone 만 이 플래그로
-- 소비자 노출을 제어한다(기본 비공개). B/C/D(go→v2→consumer 파이프라인)에서
-- 이 값을 참조해 공개 연락처만 hosts[] 로 전달한다.
ALTER TABLE organizers
  ADD COLUMN IF NOT EXISTS contact_public BOOLEAN NOT NULL DEFAULT false;
