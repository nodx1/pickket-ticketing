/**
 * go DB 의 accounts (사업자 프로필) + event_organizers (팀 멤버) 를
 * v2 /api/v1/internal/organizer/profiles/import + /teams/import 로 push.
 *
 * 이전 단계 (`v2-import-users.ts`) 가 사용자를 import 해서 users.v2_user_id 가
 * 채워져 있어야 함. 이 스크립트는 그 매핑을 활용.
 *
 * 처리 순서:
 *   1. account 별로 organizer_profiles 생성 (owner = accounts.owner_user_id)
 *   2. 같은 account 의 추가 owner user 들을 team_members.role=owner / event_id=NULL 로 등록
 *   3. event_organizers 행을 team_members.role=host/coordinator/sponsor / event_id=v2_event_id 로 등록
 *
 * 실행:
 *   npx tsx scripts/v2-import-organizers.ts          # dry-run
 *   npx tsx scripts/v2-import-organizers.ts --apply  # 실 import
 *
 * ⚠️ 의존:
 *   - users.v2_user_id 채워져 있을 것 (v2-import-users.ts 먼저 실행)
 *   - events.v2_event_id 가 있어야 event-level team 매핑 가능. 없으면 org-level 로 대체.
 *     staging 은 events 0개라 영향 없음.
 */
import crypto from "node:crypto";
import fs from "node:fs";

if (fs.existsSync(".env.local")) {
  const env = fs.readFileSync(".env.local", "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}

const APPLY = process.argv.includes("--apply");
const V2_BASE = process.env.V2_INTERNAL_BASE_URL ?? "https://api-staging.pickket.kr";
const SECRET = process.env.V2_EVENT_SYNC_SECRET;
const PROFILE_PATH = "/api/v1/internal/organizer/profiles/import";
const TEAM_PATH = "/api/v1/internal/organizer/teams/import";

if (!SECRET) {
  console.error("❌ V2_EVENT_SYNC_SECRET 미설정");
  process.exit(1);
}

interface AccountRow {
  id: string;
  name: string;
  slug: string;
  business_number: string | null;
  contact_email: string;
  contact_phone: string | null;
  owner_user_id: string | null;
  trust_tier: string;
  trust_score: number;
  v2_organizer_profile_id: string | null;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  account_id: string;
  v2_user_id: string | null;
}

interface EventOrgRow {
  id: string;
  event_id: string;
  organizer_id: string;
  account_id: string;
  role: string;
  display_order: number;
  v2_team_member_id: string | null;
  v2_event_id: string | null;
  v2_user_id: string | null; // organizer's owner user
  v2_organizer_profile_id: string | null;
}

function sign(timestamp: string, body: string): string {
  return crypto.createHmac("sha256", SECRET!).update(`${timestamp}.${body}`).digest("hex");
}

async function callV2<T>(
  path: string,
  payload: unknown,
  event: string,
): Promise<{ ok: true; data: T } | { ok: false; error: string; status?: number }> {
  const body = JSON.stringify(payload);
  const timestamp = new Date().toISOString();
  const signature = sign(timestamp, body);

  const res = await fetch(`${V2_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Pickket-Signature": signature,
      "X-Pickket-Timestamp": timestamp,
      "X-Pickket-Event": event,
      "X-Pickket-Delivery-Id": crypto.randomUUID(),
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: text.slice(0, 300) };
  }
  return { ok: true, data: (await res.json()) as T };
}

async function main() {
  const { getPool } = await import("../src/lib/db/pool");
  const pool = getPool();

  console.log(`▶ V2 organizer/team import — mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`  endpoints: ${PROFILE_PATH}, ${TEAM_PATH}`);

  // 1) accounts + owner user
  const { rows: accounts } = await pool.query<AccountRow>(
    `SELECT id, name, slug, business_number, contact_email, contact_phone,
            owner_user_id, trust_tier, trust_score, v2_organizer_profile_id
     FROM accounts
     WHERE is_active = true
     ORDER BY created_at`,
  );

  // 2) 모든 active user (account 별 owner 후보 + 추가 owner)
  const { rows: users } = await pool.query<UserRow>(
    `SELECT id, email, name, account_id, v2_user_id
     FROM users
     WHERE is_active = true AND v2_user_id IS NOT NULL
     ORDER BY account_id, created_at`,
  );
  const usersByAccount = new Map<string, UserRow[]>();
  const userById = new Map<string, UserRow>();
  for (const u of users) {
    if (!usersByAccount.has(u.account_id)) usersByAccount.set(u.account_id, []);
    usersByAccount.get(u.account_id)!.push(u);
    userById.set(u.id, u);
  }

  console.log(`  대상: accounts=${accounts.length}, active users=${users.length}\n`);

  // ─── Phase 1: profiles import ───────────────────────────────────────────
  let profileOk = 0;
  let profileFail = 0;
  const profileFailures: Array<{ account: string; error: string }> = [];

  for (const acc of accounts) {
    if (!acc.owner_user_id) {
      console.log(`  ⏭  ${acc.name} (${acc.id.slice(0, 8)}) — owner_user_id 없음, skip`);
      continue;
    }
    const ownerUser = userById.get(acc.owner_user_id);
    if (!ownerUser?.v2_user_id) {
      console.log(`  ⏭  ${acc.name} — owner user 의 v2_user_id 누락, skip`);
      continue;
    }

    const payload = {
      go_account_id: acc.id,
      owner_v2_user_id: ownerUser.v2_user_id,
      name: acc.name,
      slug: acc.slug,
      business_number: acc.business_number,
      representative_name: ownerUser.name, // fallback
      contact_email: acc.contact_email,
      contact_phone: acc.contact_phone,
      trust_tier: acc.trust_tier,
      trust_score: acc.trust_score,
    };

    if (!APPLY) {
      console.log(`  [dry] profile: ${acc.name} (${acc.slug}) owner=${ownerUser.email}`);
      profileOk++;
      continue;
    }

    const res = await callV2<{ v2_organizer_profile_id: string; created: boolean }>(
      PROFILE_PATH,
      payload,
      "organizer.profile.import",
    );

    if (!res.ok) {
      console.log(`  ❌ profile ${acc.name} — ${res.status} ${res.error}`);
      profileFailures.push({ account: acc.name, error: `${res.status} ${res.error}` });
      profileFail++;
      continue;
    }

    console.log(
      `  ✅ profile: ${acc.name}${res.data.created ? " (created)" : " (updated)"} → ${res.data.v2_organizer_profile_id}`,
    );

    await pool.query(
      `UPDATE accounts SET v2_organizer_profile_id = $1 WHERE id = $2`,
      [res.data.v2_organizer_profile_id, acc.id],
    );
    profileOk++;
  }

  console.log(`\n  profiles: ok=${profileOk}, fail=${profileFail}\n`);

  // ─── Phase 2: 추가 owner (org-level team_members.role=owner) ────────────
  // 같은 account 의 owner_user_id 가 아닌 다른 user 들을 org-level 로 등록.
  // 현재 staging 은 1 account = 1 user 라 거의 0건이지만 멀티유저 대비.
  let extraOwnerOk = 0;
  let extraOwnerFail = 0;

  // accounts 다시 조회 (방금 backfill 된 v2_organizer_profile_id 반영)
  const { rows: accountsAfterProfile } = await pool.query<AccountRow>(
    `SELECT id, owner_user_id, v2_organizer_profile_id FROM accounts WHERE is_active = true`,
  );
  const profileByAccount = new Map(
    accountsAfterProfile.map((a) => [a.id, a]),
  );

  for (const [accountId, accUsers] of usersByAccount) {
    const acc = profileByAccount.get(accountId);
    if (!acc?.v2_organizer_profile_id) continue;
    const extras = accUsers.filter((u) => u.id !== acc.owner_user_id);

    for (const extra of extras) {
      const payload = {
        go_event_organizer_id: `extra-owner-${extra.id}`, // 가짜 id (event_organizers 에 없는 row 라 unique 충돌 방지용 prefix)
        v2_event_id: null,
        v2_organizer_profile_id: acc.v2_organizer_profile_id,
        v2_user_id: extra.v2_user_id,
        role: "owner",
        display_order: 0,
      };

      if (!APPLY) {
        console.log(`  [dry] extra-owner: ${extra.email} → org ${acc.id.slice(0, 8)}`);
        extraOwnerOk++;
        continue;
      }

      const res = await callV2<{ v2_team_member_id: string; created: boolean }>(
        TEAM_PATH,
        payload,
        "organizer.team.import",
      );
      if (!res.ok) {
        console.log(`  ❌ extra-owner ${extra.email} — ${res.status} ${res.error}`);
        extraOwnerFail++;
        continue;
      }
      console.log(`  ✅ extra-owner: ${extra.email} → ${res.data.v2_team_member_id}`);
      await pool.query(
        `UPDATE users SET v2_team_member_id_owner = $1 WHERE id = $2`,
        [res.data.v2_team_member_id, extra.id],
      );
      extraOwnerOk++;
    }
  }

  console.log(`\n  extra-owners: ok=${extraOwnerOk}, fail=${extraOwnerFail}\n`);

  // ─── Phase 3: event_organizers (event-level team) ───────────────────────
  // event_organizers.event_id 는 v2 에 동일 UUID 로 mirror 됨 (events/sync 이미 동작).
  // 그대로 v2_event_id 로 전달 → event-level 멤버십 + unique 키 분산.
  const { rows: eventOrgs } = await pool.query<EventOrgRow>(
    `SELECT eo.id, eo.event_id, eo.organizer_id, eo.account_id, eo.role,
            eo.display_order, eo.v2_team_member_id,
            eo.event_id AS v2_event_id,
            COALESCE(o.v2_user_id, u_owner.v2_user_id) AS v2_user_id,
            a.v2_organizer_profile_id
     FROM event_organizers eo
     JOIN accounts a ON a.id = eo.account_id
     JOIN organizers o ON o.id = eo.organizer_id
     LEFT JOIN users u_owner ON u_owner.id = a.owner_user_id
     ORDER BY eo.created_at`,
  );

  let teamOk = 0;
  let teamFail = 0;
  for (const eo of eventOrgs) {
    if (!eo.v2_organizer_profile_id) {
      console.log(`  ⏭  event-org ${eo.id.slice(0, 8)} — profile 매핑 없음, skip`);
      continue;
    }
    if (!eo.v2_user_id) {
      console.log(`  ⏭  event-org ${eo.id.slice(0, 8)} — v2_user_id 없음, skip`);
      continue;
    }

    const payload = {
      go_event_organizer_id: eo.id,
      v2_event_id: eo.v2_event_id, // staging 은 NULL (events 비어있음)
      v2_organizer_profile_id: eo.v2_organizer_profile_id,
      v2_user_id: eo.v2_user_id,
      role: eo.role,
      display_order: eo.display_order ?? 0,
    };

    if (!APPLY) {
      console.log(`  [dry] team: event=${eo.event_id.slice(0, 8)} role=${eo.role}`);
      teamOk++;
      continue;
    }

    const res = await callV2<{ v2_team_member_id: string; created: boolean }>(
      TEAM_PATH,
      payload,
      "organizer.team.import",
    );
    if (!res.ok) {
      console.log(`  ❌ team ${eo.id.slice(0, 8)} — ${res.status} ${res.error}`);
      teamFail++;
      continue;
    }
    await pool.query(
      `UPDATE event_organizers SET v2_team_member_id = $1 WHERE id = $2`,
      [res.data.v2_team_member_id, eo.id],
    );
    console.log(`  ✅ team: ${eo.id.slice(0, 8)} → ${res.data.v2_team_member_id}`);
    teamOk++;
  }

  console.log(`\n=== 최종 ===`);
  console.log(`  profiles: ok=${profileOk}, fail=${profileFail}`);
  console.log(`  extra-owners: ok=${extraOwnerOk}, fail=${extraOwnerFail}`);
  console.log(`  event-teams: ok=${teamOk}, fail=${teamFail}`);

  if (profileFailures.length > 0) {
    console.log("\n profile 실패:");
    profileFailures.forEach((f) => console.log(`  - ${f.account}: ${f.error}`));
  }

  if (!APPLY) {
    console.log("\n⚠️  dry-run. 실 적용은 --apply.");
  }

  await pool.end();
}

void main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
