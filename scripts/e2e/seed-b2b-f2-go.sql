-- F2 seed (go side) — identity + event prerequisites.
-- Seeds ONLY identity/parent rows via SQL. The v2 event anchor, comp product,
-- comp tier, orders, attendees, invitations, and dispatch queue are all created by
-- REAL app code (ensureV2EventAnchor -> createEvent, bulkIssueInvitations ->
-- ensureCompProduct/upsertTiers -> createOrder -> v2). See seed-b2b-f2-anchor.mts / run-f2.mts.
--
-- Fixed UUIDs so the driver/harness can reference them without capture.
\set acct 'aaaaaaaa-0000-4000-8000-000000000001'
\set usr  'bbbbbbbb-0000-4000-8000-000000000001'
\set v2usr 'cccccccc-0000-4000-8000-000000000001'
\set ev   'dddddddd-0000-4000-8000-000000000001'

INSERT INTO accounts (id, name, slug, contact_email, owner_user_id, is_active)
VALUES (:'acct', '노드엑스 B2B 테스트', 'nodex-b2b-f2', 'owner-f2@no-reply.pickket.kr', NULL, true)
ON CONFLICT (id) DO NOTHING;

-- owner user; v2_user_id maps to the v2 organizer user (seeded in v2 by seed-b2b-f2-v2.sql).
INSERT INTO users (id, account_id, email, name, role, password_hash, is_active, v2_user_id)
VALUES (:'usr', :'acct', 'owner-f2@no-reply.pickket.kr', 'F2 주최자', 'owner', '!disabled!', true, :'v2usr')
ON CONFLICT (id) DO NOTHING;

UPDATE accounts SET owner_user_id = :'usr' WHERE id = :'acct';

-- Event: allpass + raffle_enabled, comp_capacity_cap = 3 (so 4th recipient is blocked).
-- v2_event_id intentionally NULL — REAL app code (ensureV2EventAnchor) will fill it via
-- createEvent write-through, proving that leg of the F2 chain.
-- enabled_features includes ticket_issuance so the REAL HTTP bulk route (requireFeature) passes.
INSERT INTO events (
  id, account_id, title, slug, status, event_type,
  starts_at, ends_at, venue_name, venue_address,
  admission_mode, raffle_enabled, comp_capacity_cap, enabled_features
) VALUES (
  :'ev', :'acct', '2026 BC카드·한경 골프 챔피언십 (F2)', 'bc-golf-f2', 'live', 'festival',
  NOW() + INTERVAL '10 day', NOW() + INTERVAL '11 day', '부산 골프장', '부산광역시 강서구',
  'allpass', true, 3, ARRAY['ticket_issuance']::text[]
)
ON CONFLICT (id) DO NOTHING;

SELECT 'go-seeded' AS status,
       (SELECT v2_event_id FROM events WHERE id = :'ev') AS v2_event_id_before_anchor,
       (SELECT comp_capacity_cap FROM events WHERE id = :'ev') AS cap,
       (SELECT admission_mode FROM events WHERE id = :'ev') AS admission_mode,
       (SELECT raffle_enabled FROM events WHERE id = :'ev') AS raffle_enabled;
