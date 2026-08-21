-- 빅뱅 flip — write-through엔 go order_items 없음(v2 SoT) → attendees.order_item_id 완화.
-- attendees는 v2_ticket_id 키잉 워크플로 앵커(answers/체크인). order_item_id는 폐기 컬럼.
BEGIN;
ALTER TABLE attendees DROP CONSTRAINT IF EXISTS attendees_order_item_id_fkey;
ALTER TABLE attendees ALTER COLUMN order_item_id DROP NOT NULL;
COMMIT;
