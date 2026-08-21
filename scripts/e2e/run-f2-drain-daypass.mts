/**
 * Isolate the drain path: issue a DAYPASS invitation (admission_day set) so the buggy
 * formatAdmissionRange branch is NOT hit, proving drainInvitationDispatch's happy path:
 * claim-lease (SKIP LOCKED) -> alimtalk stub log -> deep-link token -> sent transition.
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
const { bulkIssueInvitations, drainInvitationDispatch } = await import("@/lib/server/invitations");
const ACCOUNT = "aaaaaaaa-0000-4000-8000-000000000001";
const EVENT = "dddddddd-0000-4000-8000-000000000001";
const pool = getPool();
try {
  // daypass recipient with explicit admission_day -> drain builds admissionInfo from admission_day
  const day = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const r = await bulkIssueInvitations({
    accountId: ACCOUNT, eventId: EVENT,
    recipients: [{ name: "데이패스객", phone: "010-7777-7777", admissionMode: "daypass", admissionDay: day }],
  });
  console.log("[issue] " + JSON.stringify(r));
  // bump cap so this issues (event cap was 3, already full) — was raised to 10 in main run; ensure room
  await pool.query("UPDATE events SET comp_capacity_cap = 20 WHERE id=$1", [EVENT]);
  const r2 = await bulkIssueInvitations({
    accountId: ACCOUNT, eventId: EVENT,
    recipients: [{ name: "데이패스객", phone: "010-7777-7777", admissionMode: "daypass", admissionDay: day }],
  });
  console.log("[issue-retry] " + JSON.stringify(r2));
  const drain = await drainInvitationDispatch(pool);
  console.log("[drain] " + JSON.stringify(drain));
  const rows = await pool.query(
    "SELECT phone_normalized, status, ticket_number FROM event_invitations WHERE event_id=$1 AND phone_normalized='01077777777'", [EVENT]);
  console.log("[ledger] " + JSON.stringify(rows.rows));
  const disp = await pool.query(
    "SELECT status, request_id FROM invitation_dispatch WHERE event_id=$1 AND phone='010-7777-7777'", [EVENT]);
  console.log("[dispatch] " + JSON.stringify(disp.rows));
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error("ERR", e instanceof Error ? e.stack : e);
  await pool.end().catch(() => {});
  process.exit(1);
}
