-- F2 seed (v2 side) — minimal organizer identity so _resolve_organizer(go_account_id) works.
-- v2 createOrder/createEvent resolve organizer via OrganizerProfile.go_account_id -> user_id.
-- Everything else (event, tiers, orders, tickets) is created by REAL go write-through code.
\set v2usr 'cccccccc-0000-4000-8000-000000000001'
\set prof  'eeeeeeee-0000-4000-8000-000000000001'
\set goacct 'aaaaaaaa-0000-4000-8000-000000000001'

-- v2 organizer user. hashed_password/email placeholders — F2 never authenticates as this user
-- (internal commerce uses HMAC service auth), it only maps organizer_ref -> user_id.
INSERT INTO users (id, email, hashed_password, name, is_verified, is_organizer, is_active,
  verification_level, loyalty_score, created_at, updated_at)
VALUES (:'v2usr', 'org-f2@no-reply.pickket.kr', '!disabled!', 'F2 주최자', true, true, true, 1, 0, NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- OrganizerProfile mapping go account_id -> v2 user_id.
-- contact_email/company_name are stored raw here (F2 only reads user_id, never decrypts these).
INSERT INTO organizer_profiles (id, user_id, company_name, contact_email, status, go_account_id, created_at, updated_at)
VALUES (:'prof', :'v2usr', '주식회사 노드엑스', 'org-f2@no-reply.pickket.kr', 'approved', :'goacct', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

SELECT 'v2-seeded' AS status,
       (SELECT user_id FROM organizer_profiles WHERE go_account_id = :'goacct') AS mapped_user_id;
