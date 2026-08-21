/**
 * Fresh DAYPASS event with capacity headroom -> prove drainInvitationDispatch happy path:
 * claim-lease -> alimtalk stub log (PICKKET_INVITE_001 / INVITATION_ISSUED) -> sent transition.
 * daypass admission_day avoids the confirmed formatAdmissionRange(Date) crash on allpass.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
const envLocalPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envLocalPath)) {
  for (const line of fs.readFileSync(envLocalPath, "utf8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("="); if (i < 0) continue;
    const k = t.slice(0, i).trim(); const v = t.slice(i + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}
const { getPool } = await import("@/lib/db/pool");
const { ensureV2EventAnchor } = await import("@/lib/v2/event-anchor");
const { updateEvent } = await import("@/lib/v2/commerce-client");
const { bulkIssueInvitations, drainInvitationDispatch } = await import("@/lib/server/invitations");
const ACCOUNT = "aaaaaaaa-0000-4000-8000-000000000001";
const EV3 = "dddddddd-0000-4000-8000-000000000003";
const pool = getPool();
try {
  const ends = new Date(Date.now() + 11 * 86400000);
  await pool.query(
    `INSERT INTO events (id, account_id, title, slug, status, event_type, starts_at, ends_at,
       venue_name, admission_mode, raffle_enabled, comp_capacity_cap, enabled_features)
     VALUES ($1,$2,'F2 드레인 이벤트(daypass)','bc-golf-f2-drain','live','festival',
       NOW()+INTERVAL '10 day',$3,'부산 골프장','daypass',false,50,ARRAY['ticket_issuance']::text[])
     ON CONFLICT (id) DO NOTHING`, [EV3, ACCOUNT, ends]);
  const v2ev = await ensureV2EventAnchor(pool, EV3);
  await updateEvent(v2ev!, { admission_mode: "daypass", event_date_end: ends.toISOString() },
    { idempotencyKey: `drain-fresh-sync:${EV3}` });
  const day = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const r = await bulkIssueInvitations({
    accountId: ACCOUNT, eventId: EV3,
    recipients: [
      { name: "데이패스A", phone: "010-7777-0001", admissionMode: "daypass", admissionDay: day },
      { name: "데이패스B", phone: "010-7777-0002", admissionMode: "daypass", admissionDay: day },
    ],
  });
  console.log("[issue] " + JSON.stringify(r));
  const drain = await drainInvitationDispatch(pool);
  console.log("[drain] " + JSON.stringify(drain));
  const disp = await pool.query(
    "SELECT status, request_id FROM invitation_dispatch WHERE event_id=$1 ORDER BY phone", [EV3]);
  console.log("[dispatch] " + JSON.stringify(disp.rows));
  const led = await pool.query(
    "SELECT phone_normalized, status FROM event_invitations WHERE event_id=$1 ORDER BY phone_normalized", [EV3]);
  console.log("[ledger] " + JSON.stringify(led.rows));
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error("ERR", e instanceof Error ? e.stack : e);
  await pool.end().catch(() => {});
  process.exit(1);
}
