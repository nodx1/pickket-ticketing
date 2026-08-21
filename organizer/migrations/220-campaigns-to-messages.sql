-- email_campaigns → event_messages 수렴(흡수). messages 를 SoT 로 통합(계획서 §3).
-- 채번: 계획서 초안의 218 은 support_messages 가 점유 → 220 사용(216 waitlist·217/218 support 이후).
--
-- ⚠️ 파괴적 DROP 금지: campaigns 테이블은 보존한다(백필 후 별도 마이그레이션에서 폐기).
-- 재실행 멱등: result_meta.legacy_campaign_id 로 중복 삽입 차단(NOT EXISTS).
-- 가산적·읽기전용 수렴 마이그레이션.

-- 1) 캠페인 헤더 → event_messages.
--    ⚠️ event_messages.status CHECK 는 (draft/scheduled/sent/failed) 만 허용 → 'sending' 없음.
--       campaigns 의 'sending'/'sent_with_failures' 는 안전하게 매핑한다(CHECK 위반 방지):
--         sent → sent, scheduled → scheduled, sending → scheduled(진행중은 예약으로 수렴),
--         sent_with_failures → sent, 그 외(draft/failed 등) → draft.
INSERT INTO event_messages
  (id, account_id, event_id, title, channel, status, body,
   recipient_filter, message_type, segment, sent_count, failed_count,
   result_meta, scheduled_at, sent_at, created_at, updated_at)
SELECT
  ec.id, ec.account_id, ec.event_id, ec.subject, 'email',
  CASE ec.status
    WHEN 'sent' THEN 'sent'
    WHEN 'sent_with_failures' THEN 'sent'
    WHEN 'scheduled' THEN 'scheduled'
    WHEN 'sending' THEN 'scheduled'
    ELSE 'draft'
  END,
  ec.body_html, 'all', ec.message_type,
  NULLIF(ec.segment, '{}'::jsonb),
  COALESCE((ec.stats->>'sent')::int, 0),
  COALESCE((ec.stats->>'bounced')::int, 0),
  jsonb_build_object('legacy_campaign_id', ec.id, 'legacy_stats', ec.stats),
  ec.scheduled_at, ec.sent_at, ec.created_at, ec.updated_at
FROM email_campaigns ec
WHERE NOT EXISTS (
  SELECT 1 FROM event_messages em
  WHERE em.result_meta->>'legacy_campaign_id' = ec.id::text
);

-- 2) 수신자별 발송이력 → message_deliveries(source=message).
--    message_id = 흡수된 event_messages.id(=원래 campaign.id 로 삽입됨) 로 매핑.
--    ⚠️ 184 멱등 인덱스 = (message_id, channel, contact) UNIQUE. status CHECK =
--       (queued/sent/delivered/failed/skipped) → campaigns 의 'sending' 은 queued 로 수렴.
INSERT INTO message_deliveries
  (message_id, source, account_id, channel, contact, status, created_at, updated_at)
SELECT
  ecr.campaign_id, 'message', ec.account_id, 'email', ecr.email,
  CASE ecr.status
    WHEN 'sent' THEN 'sent'
    WHEN 'delivered' THEN 'delivered'
    WHEN 'failed' THEN 'failed'
    WHEN 'sending' THEN 'queued'
    ELSE 'skipped'
  END,
  ecr.created_at, NOW()
FROM email_campaign_recipients ecr
JOIN email_campaigns ec ON ec.id = ecr.campaign_id
WHERE ecr.email IS NOT NULL
ON CONFLICT (message_id, channel, contact) DO NOTHING;  -- 184 멱등 인덱스
