/**
 * 레벨2 컷오버 W2-EVT — go → v2 데이터 백필.
 *
 *   go `organizers`       → v2 `event_hosts`             (id 보존)
 *   go `event_organizers` → v2 `event_host_links`        (role·display_order 보존)
 *   go `event_schedules`  → v2 `events.event_schedules`  (JSONB, id/ends_at/venue_name/sort_order 보존)
 *
 * 🔴 `migrations/240-drop-organizers-event-schedules.sql` 의 **선행 조건**이다.
 *    이 스크립트가 실패 0 으로 끝나기 전에 240 을 적용하면 주최자 표기·타임테이블이 영구 소실된다.
 *
 * 사용:
 *   npx tsx scripts/backfill-w2evt-hosts.ts                       # dry-run(기본) — 쓰기 없음
 *   npx tsx scripts/backfill-w2evt-hosts.ts --apply               # 실제 전송
 *   npx tsx scripts/backfill-w2evt-hosts.ts --apply --promote-first-as-host
 *       ↳ host 역할이 하나도 없는 이벤트에서 display_order 가 가장 낮은 항목을 host 로 승격.
 *         (기본은 승격하지 않고 **건너뛰며 실패로 보고**한다 — 데이터를 지어내지 않는다.)
 *
 * 멱등: 재실행 안전. host 는 id 고정 upsert, 링크·타임테이블은 전체 교체(PUT/PATCH)다.
 */
import fs from "node:fs";

const envPath = ".env.local";
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}

const APPLY = process.argv.includes("--apply");
const PROMOTE = process.argv.includes("--promote-first-as-host");

interface Failure {
  scope: string;
  key: string;
  reason: string;
}

async function main() {
  const { getPool } = await import("../src/lib/db/pool");
  const {
    createEventHost,
    putEventHostLinks,
    updateEvent,
    goAccountRef,
    V2CommerceError,
  } = await import("../src/lib/v2/commerce-client");
  const { toV2Schedules } = await import("../src/lib/v2/event-schedules");

  const pool = getPool();
  const failures: Failure[] = [];
  let hostOk = 0;
  let linkOk = 0;
  let schedOk = 0;

  console.log(`\n=== W2-EVT 백필 (${APPLY ? "APPLY" : "DRY-RUN"}) ===\n`);

  // ── 0) 사전 조사: host 역할이 없는 이벤트 ──────────────────────────────────
  const { rows: noHost } = await pool.query<{ event_id: string }>(
    `SELECT event_id FROM event_organizers
      GROUP BY event_id
     HAVING count(*) FILTER (WHERE role = 'host') = 0`,
  );
  if (noHost.length > 0) {
    console.log(
      `⚠️  host 역할이 없는 이벤트 ${noHost.length}건 — v2 PUT 이 400 을 낸다.` +
        (PROMOTE ? " (--promote-first-as-host 로 승격 진행)" : " (건너뛰고 실패로 보고)"),
    );
  }
  const noHostSet = new Set(noHost.map((r) => r.event_id));

  // ── 1) organizers → event_hosts ────────────────────────────────────────────
  const { rows: organizers } = await pool.query<{
    id: string;
    account_id: string;
    name: string;
    slug: string;
    description: string | null;
    email: string | null;
    phone: string | null;
    logo_url: string | null;
    contact_public: boolean;
    is_published: boolean;
  }>(
    `SELECT id, account_id, name, slug, description, email, phone, logo_url,
            contact_public, is_published
       FROM organizers
      ORDER BY account_id, created_at`,
  );
  console.log(`[1/3] organizers ${organizers.length}건`);

  for (const o of organizers) {
    if (!APPLY) continue;
    try {
      await createEventHost(o.account_id, {
        host_id: o.id, // go id 보존 — event_organizers 링크가 이 id 를 참조한다.
        name: o.name,
        slug: o.slug,
        description: o.description,
        email: o.email,
        phone: o.phone,
        logo_url: o.logo_url,
        contact_public: o.contact_public,
        is_published: o.is_published,
      });
      hostOk += 1;
    } catch (err: unknown) {
      failures.push({
        scope: "host",
        key: `${o.id} (account ${o.account_id})`,
        reason:
          err instanceof V2CommerceError
            ? `${err.status}: ${err.message}`
            : err instanceof Error
              ? err.message
              : "unknown",
      });
    }
  }

  // ── 2) event_organizers → event_host_links ─────────────────────────────────
  const { rows: links } = await pool.query<{
    event_id: string;
    account_id: string;
    organizer_id: string;
    role: "host" | "coordinator" | "sponsor";
    display_order: number;
  }>(
    `SELECT event_id, account_id, organizer_id, role, display_order
       FROM event_organizers
      ORDER BY event_id, display_order`,
  );
  const byEvent = new Map<string, typeof links>();
  for (const l of links) {
    const list = byEvent.get(l.event_id) ?? [];
    list.push(l);
    byEvent.set(l.event_id, list);
  }
  console.log(`[2/3] event_organizers ${links.length}건 / 이벤트 ${byEvent.size}개`);

  for (const [eventId, rows] of byEvent) {
    const accountId = rows[0].account_id;
    let payload = rows.map((r) => ({
      host_id: r.organizer_id,
      role: r.role,
      display_order: r.display_order ?? 0,
    }));

    if (noHostSet.has(eventId)) {
      if (!PROMOTE) {
        failures.push({
          scope: "link",
          key: eventId,
          reason: "host 역할 없음 — --promote-first-as-host 없이는 건너뜀",
        });
        continue;
      }
      const first = [...payload].sort((a, b) => a.display_order - b.display_order)[0];
      payload = payload.map((p) =>
        p === first ? { ...p, role: "host" as const } : p,
      );
      console.log(`   ↳ ${eventId}: ${first.host_id} 를 host 로 승격`);
    }

    if (!APPLY) continue;
    try {
      await putEventHostLinks(accountId, eventId, payload);
      linkOk += 1;
    } catch (err: unknown) {
      failures.push({
        scope: "link",
        key: eventId,
        reason:
          err instanceof V2CommerceError
            ? `${err.status}: ${err.message}`
            : err instanceof Error
              ? err.message
              : "unknown",
      });
    }
  }

  // ── 3) event_schedules → v2 events.event_schedules ─────────────────────────
  const { rows: schedules } = await pool.query<{
    id: string;
    event_id: string;
    account_id: string;
    title: string;
    description: string | null;
    starts_at: Date | string | null;
    ends_at: Date | string | null;
    venue_name: string | null;
    sort_order: number;
  }>(
    `SELECT es.id, es.event_id, e.account_id, es.title, es.description,
            es.starts_at, es.ends_at, es.venue_name, es.sort_order
       FROM event_schedules es
       JOIN events e ON e.id = es.event_id
      ORDER BY es.event_id, es.sort_order, es.starts_at`,
  );
  const schedByEvent = new Map<string, typeof schedules>();
  for (const s of schedules) {
    const list = schedByEvent.get(s.event_id) ?? [];
    list.push(s);
    schedByEvent.set(s.event_id, list);
  }
  console.log(`[3/3] event_schedules ${schedules.length}건 / 이벤트 ${schedByEvent.size}개`);

  const iso = (v: Date | string | null) =>
    v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

  for (const [eventId, rows] of schedByEvent) {
    const accountId = rows[0].account_id;
    const items = rows.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      startsAt: iso(s.starts_at) ?? "",
      endsAt: iso(s.ends_at),
      venueName: s.venue_name,
      sortOrder: s.sort_order ?? 0,
        imageUrl: null,
    }));

    if (!APPLY) continue;
    try {
      await updateEvent(
        eventId,
        { organizer_ref: goAccountRef(accountId), event_schedules: toV2Schedules(items) },
        { idempotencyKey: `w2evt-backfill-schedules:${eventId}` },
      );
      schedOk += 1;
    } catch (err: unknown) {
      failures.push({
        scope: "schedule",
        key: eventId,
        reason:
          err instanceof V2CommerceError
            ? `${err.status}: ${err.message}`
            : err instanceof Error
              ? err.message
              : "unknown",
      });
    }
  }

  await pool.end();

  console.log("\n=== 결과 ===");
  if (!APPLY) {
    console.log("DRY-RUN — 아무것도 전송하지 않았다. --apply 로 실행하라.");
    console.log(`대상: hosts=${organizers.length} · links=${byEvent.size} · schedules=${schedByEvent.size}`);
    if (noHost.length > 0) {
      console.log(`⚠️  host 역할 없는 이벤트 ${noHost.length}건: ${noHost.map((r) => r.event_id).join(", ")}`);
    }
    return;
  }

  console.log(`성공: hosts=${hostOk} · links=${linkOk} · schedules=${schedOk}`);
  if (failures.length === 0) {
    console.log("✅ 실패 0 — 마이그 240 적용 가능.");
    console.log("   psql 세션에서: SET pickket.w2evt_backfill_done = '1'; 후 240 실행");
    return;
  }

  console.error(`\n❌ 실패 ${failures.length}건 — 마이그 240 을 적용하지 마라(주최자 표기 소실 위험).`);
  for (const f of failures) console.error(`  [${f.scope}] ${f.key} — ${f.reason}`);
  // ORGANIZER_REF_UNRESOLVED = v2 organizer_profiles.go_account_id 매핑 부재.
  console.error(
    "\n힌트: ORGANIZER_REF_UNRESOLVED 는 v2 `organizer_profiles.go_account_id` 매핑이 없는 계정이다.\n" +
      "      해당 계정의 프로필을 먼저 v2 로 import 해야 한다(lib/v2/organizer-sync.ts).",
  );
  process.exitCode = 1;
}

void main();
