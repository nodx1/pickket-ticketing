-- 203: pre-202 ambiguous failed rows cannot be classified safely after the fact.
-- Keep them out of the automatic retry queue until an owner confirms the provider result.
UPDATE payment_compensation_actions
   SET status = 'manual_review',
       manual_review_reason = COALESCE(manual_review_reason, 'legacy_failed_requires_review'),
       next_retry_at = NULL,
       updated_at = NOW()
 WHERE status = 'failed';
