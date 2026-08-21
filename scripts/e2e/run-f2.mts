/**
 * F2 (bulk invitation issuance) real end-to-end driver.
 *
 * Runs INSIDE the go app (tsx, @/ alias) so every step taxes the REAL app code path:
 *   - ensureV2EventAnchor   -> v2 createEvent write-through (fills events.v2_event_id)
 *   - updateEvent           -> v2 PATCH (admission_mode/raffle_enabled/event_date_end) = go edit-save path
 *   - bulkIssueInvitations  -> ensureCompProduct -> upsertTiers (v2 tier) ->
 *                              createOrder -> v2 /internal/orders + confirm-payment ->
 *                              attendees write-back + invitation_dispatch queue
 *   - drainInvitationDispatch -> claim-lease (SKIP LOCKED) + alimtalk stub + deep-link token
 *
 * Load .env.local first (same loader as scripts/migrate.ts) so PG and V2 env are present.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const envLocalPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envLocalPath)) {
  for (const line of fs.readFileSync(envLocalPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

const { getPool } = await import("@/lib/db/pool");
const { ensureV2EventAnchor } = await import("@/lib/v2/event-anchor");
const { updateEvent } = await import("@/lib/v2/commerce-client");
const { bulkIssueInvitations, drainInvitationDispatch } = await import("@/lib/server/invitations");
const { createInvitationToken, INVITE_TOKEN_PARAM } = await import("@/lib/invitation-token");

const ACCOUNT = "aaaaaaaa-0000-4000-8000-000000000001";
const EVENT = "dddddddd-0000-4000-8000-000000000001";

const pool = getPool();
const results: Array<[string, boolean, string]> = [];
const rec = (step: string, ok: boolean, detail: string) => {
  results.push([step, ok, detail]);
  console.log(`[${ok ? "PASS" : "FAIL"}] ${step}: ${detail}`);
};

async function q<T = any>(sql: string, args: unknown[] = []): Promise<T[]> {
  const { rows } = await pool.query(sql, args);
  return rows as T[];
}

try {
  // ── STEP 0: v2 event anchor via REAL app code (createEvent write-through) ──
  const before = await q<{ v2_event_id: string | null }>(
    "SELECT v2_event_id FROM events WHERE id=$1", [EVENT]);
  const v2EventId = await ensureV2EventAnchor(pool, EVENT);
  const after = await q<{ v2_event_id: string | null }>(
    "SELECT v2_event_id FROM events WHERE id=$1", [EVENT]);
  rec("S0 ensureV2EventAnchor -> v2 createEvent write-through (fills v2_event_id)",
    !!v2EventId && !before[0].v2_event_id && !!after[0].v2_event_id,
    `before=${before[0].v2_event_id} v2EventId=${v2EventId} after=${after[0].v2_event_id}`);

  // ── STEP 0b: propagate allpass + raffle to v2 via REAL updateEvent (go edit-save path) ──
  // FINDING: ensureV2EventAnchor does NOT send admission_mode/raffle_enabled/event_date_end,
  // so the anchor path leaves v2 at single/raffle=false. The go event-edit route pushes these
  // via updateEvent — we invoke that same real write-through here to bring v2 into sync.
  const goEv = await q<{ ends_at: Date }>("SELECT ends_at FROM events WHERE id=$1", [EVENT]);
  await updateEvent(v2EventId!, {
    admission_mode: "allpass",
    event_date_end: new Date(goEv[0].ends_at).toISOString(),
    raffle_enabled: true,
  }, { idempotencyKey: `event-f2-sync:${EVENT}` });
  const v2after = await q<{ raffle_enabled: boolean; admission_mode: string }>(
    "SELECT raffle_enabled, admission_mode FROM events WHERE id=$1", [v2EventId!]);
  // Note: this reads go DB; v2 state is on 5435. We verify v2 separately in the shell report.
  rec("S0b updateEvent write-through sent (allpass/raffle to v2)", true,
    `sent admission_mode=allpass raffle_enabled=true event_date_end=${new Date(goEv[0].ends_at).toISOString()}`);

  // ── STEP 1: bulk issue 3 recipients (real createOrder write-through) ──
  const batch1 = [
    { name: "홍길동", phone: "010-1111-1111", admissionMode: "allpass" as const },
    { name: "김철수", phone: "010-2222-2222", admissionMode: "allpass" as const },
    { name: "이영희", phone: "01033333333", admissionMode: "allpass" as const },
  ];
  const r1 = await bulkIssueInvitations({ accountId: ACCOUNT, eventId: EVENT, recipients: batch1 });
  rec("S1 bulk issue 3 recipients (issued=3, failed=0)",
    r1.requested === 3 && r1.issued === 3 && r1.failed === 0 && r1.skipped === 0 && r1.deduped === 0,
    JSON.stringify(r1));

  const invs = await q<{ phone_normalized: string; status: string; ticket_number: string | null; attendee_id: string | null }>(
    "SELECT phone_normalized, status, ticket_number, attendee_id FROM event_invitations WHERE event_id=$1 ORDER BY phone_normalized", [EVENT]);
  rec("S1 event_invitations rows (3, status=issued, ticket_number+attendee filled)",
    invs.length === 3 && invs.every(i => i.status === "issued" && i.ticket_number && i.attendee_id),
    invs.map(i => `${i.phone_normalized}:${i.status}:${i.ticket_number}`).join(" | "));

  const prods = await q<{ id: string; v2_tier_id: string | null; price: string; visibility: string }>(
    "SELECT id, v2_tier_id, price, visibility FROM products WHERE event_id=$1 AND name='초대권'", [EVENT]);
  rec("S1 ensureCompProduct -> hidden 0원 product + v2 tier anchor",
    prods.length === 1 && !!prods[0].v2_tier_id && prods[0].visibility === "hidden" && Number(prods[0].price) === 0,
    prods.length ? `product=${prods[0].id} v2_tier=${prods[0].v2_tier_id}` : "no comp product");

  const ords = await q<{ n: string }>("SELECT COUNT(*)::text n FROM orders WHERE event_id=$1 AND total_amount=0", [EVENT]);
  const atts = await q<{ ticket_number: string; v2_ticket_id: string; raffle_number: number | null }>(
    "SELECT ticket_number, v2_ticket_id, raffle_number FROM attendees WHERE event_id=$1", [EVENT]);
  rec("S1 createOrder write-through: go orders(3, 0원) + attendees(3, v2_ticket_id)",
    Number(ords[0].n) === 3 && atts.length === 3 && atts.every(a => a.v2_ticket_id && a.ticket_number),
    `orders=${ords[0].n} attendees=${atts.length} v2tickets=${atts.filter(a=>a.v2_ticket_id).length}`);
  rec("S1 raffle_number assigned by v2 (raffle_enabled event, post-sync)",
    atts.every(a => a.raffle_number != null),
    atts.map(a => `${a.ticket_number}:rn=${a.raffle_number}`).join(", "));

  const disp1 = await q<{ status: string; n: string }>(
    "SELECT status, COUNT(*)::text n FROM invitation_dispatch WHERE event_id=$1 GROUP BY status", [EVENT]);
  rec("S1 invitation_dispatch queued (3)",
    disp1.length === 1 && disp1[0].status === "queued" && Number(disp1[0].n) === 3, JSON.stringify(disp1));

  // ── STEP 2: re-upload same batch -> dedup/skip (UNIQUE event_id,phone) ──
  const r2 = await bulkIssueInvitations({ accountId: ACCOUNT, eventId: EVENT, recipients: batch1 });
  rec("S2 re-upload same 3 -> all skipped (0 issued, 3 skipped)",
    r2.issued === 0 && r2.skipped === 3 && r2.failed === 0, JSON.stringify(r2));
  const invCount2 = await q<{ n: string }>("SELECT COUNT(*)::text n FROM event_invitations WHERE event_id=$1", [EVENT]);
  rec("S2 no new invitation rows after re-upload (still 3)", Number(invCount2[0].n) === 3, `count=${invCount2[0].n}`);

  // ── STEP 3: comp_capacity_cap = 3 -> a NEW distinct recipient is cap-blocked ──
  const capRow = await q<{ cap: number; issued: string }>(
    `SELECT (SELECT comp_capacity_cap FROM events WHERE id=$1) AS cap,
            (SELECT COUNT(*)::text FROM event_invitations WHERE event_id=$1 AND status<>'revoked') AS issued`, [EVENT]);
  const r3 = await bulkIssueInvitations({
    accountId: ACCOUNT, eventId: EVENT, recipients: [{ name: "초과객", phone: "010-5555-5555" }] });
  rec("S3 comp_capacity_cap enforcement (capExceeded, 0 issued, local gate)",
    r3.capExceeded === true && r3.issued === 0 && r3.skipped === 1,
    `cap=${capRow[0].cap} issued=${capRow[0].issued} result=${JSON.stringify(r3)}`);

  // ── STEP 3b: v2 tier atomic capacity — bump go cap past frozen v2 tier capacity(3), issue new ──
  // Documented caveat (rsvp-product.ts): comp cap is applied to v2 tier ONLY at tier creation.
  // So even after raising go comp_capacity_cap, v2 tier capacity stays 3 -> v2 rejects the 4th
  // atomically (V2CommerceError). This proves v2 is the final atomic enforcer.
  await pool.query("UPDATE events SET comp_capacity_cap = 10 WHERE id=$1", [EVENT]);
  const r3b = await bulkIssueInvitations({
    accountId: ACCOUNT, eventId: EVENT, recipients: [{ name: "v2초과객", phone: "010-6666-6666" }] });
  const invFailed = await q<{ status: string; failure_reason: string | null }>(
    "SELECT status, failure_reason FROM event_invitations WHERE event_id=$1 AND phone_normalized='01066666666'", [EVENT]);
  rec("S3b v2 tier atomic capacity blocks 4th (frozen tier cap=3) -> failed",
    r3b.issued === 0 && r3b.failed === 1 && invFailed[0]?.status === "failed",
    `result=${JSON.stringify(r3b)} ledger=${JSON.stringify(invFailed[0])}`);

  // ── STEP 4: concurrency on a SECOND event with headroom (clean 1-of-2 observation) ──
  await runConcurrencyOnFreshEvent();

  // ── STEP 5: drain dispatch queue (alimtalk stub + deep-link token) on EVENT(allpass) ──
  let drainErr: string | null = null;
  try {
    const drain = await drainInvitationDispatch(pool);
    rec("S5 drainInvitationDispatch claimed+sent (stub, no NCP creds)",
      drain.claimed >= 3 && drain.sent === drain.claimed && drain.failed === 0, JSON.stringify(drain));
    const sentRows = await q<{ status: string; n: string }>(
      "SELECT status, COUNT(*)::text n FROM invitation_dispatch WHERE event_id=$1 GROUP BY status", [EVENT]);
    rec("S5 dispatch rows -> sent", sentRows.every(r => r.status === "sent"), JSON.stringify(sentRows));
    const invSent = await q<{ status: string; n: string }>(
      "SELECT status, COUNT(*)::text n FROM event_invitations WHERE event_id=$1 AND status='sent' GROUP BY status", [EVENT]);
    rec("S5 event_invitations transitioned issued->sent", invSent.length > 0, JSON.stringify(invSent));
    const drain2 = await drainInvitationDispatch(pool);
    rec("S5b re-drain claims 0 (no re-send of already-sent)", drain2.claimed === 0, JSON.stringify(drain2));
  } catch (e) {
    drainErr = e instanceof Error ? e.message : String(e);
    rec("S5 drainInvitationDispatch (allpass, admission_day=NULL)", false, `CRASH: ${drainErr}`);
  }

  // ── STEP 6: produce a REAL deep-link token for an issued ticket (F5 hand-off) ──
  const first = await q<{ ticket_number: string; token_version: number; ends_at: Date }>(
    `SELECT i.ticket_number, i.token_version, e.ends_at
       FROM event_invitations i JOIN events e ON e.id=i.event_id
      WHERE i.event_id=$1 AND i.ticket_number IS NOT NULL ORDER BY i.created_at LIMIT 1`, [EVENT]);
  const tk = first[0];
  const expiresAt = new Date(tk.ends_at).getTime() + 30 * 24 * 60 * 60 * 1000;
  const token = createInvitationToken({ ticketNumber: tk.ticket_number, version: tk.token_version, expiresAt });
  const deepLink = `/tickets/${encodeURIComponent(tk.ticket_number)}?${INVITE_TOKEN_PARAM}=${token}`;
  rec("S6 deep-link bearer token generated for issued ticket", !!token && token.includes("."),
    `ticket=${tk.ticket_number} v=${tk.token_version}`);
  fs.writeFileSync("/tmp/b2b-e2e/f2-deeplink.txt", deepLink);
  console.log("DEEPLINK=" + deepLink);
  console.log("F2_TICKET=" + tk.ticket_number);

  const npass = results.filter(r => r[1]).length;
  console.log(`\n=== F2 SUMMARY: ${npass}/${results.length} checks passed ===`);
  await pool.end();
  process.exit(0);
} catch (err) {
  console.error("DRIVER ERROR:", err instanceof Error ? (err.stack ?? err.message) : err);
  await pool.end().catch(() => {});
  process.exit(2);
}

// ── Concurrency helper: fresh event with cap headroom so v2 tier isn't the limiter ──
async function runConcurrencyOnFreshEvent() {
  const EV2 = "dddddddd-0000-4000-8000-000000000002";
  await pool.query(
    `INSERT INTO events (id, account_id, title, slug, status, event_type, starts_at, ends_at,
       venue_name, admission_mode, raffle_enabled, comp_capacity_cap, enabled_features)
     VALUES ($1,$2,'F2 동시성 이벤트','bc-golf-f2-conc','live','festival',
       NOW()+INTERVAL '10 day', NOW()+INTERVAL '11 day','부산 골프장','allpass',false,50,ARRAY['ticket_issuance']::text[])
     ON CONFLICT (id) DO NOTHING`, [EV2, ACCOUNT]);
  await ensureV2EventAnchor(pool, EV2);
  const racePhone = { name: "동시성객", phone: "010-9999-9999" };
  const [rc1, rc2] = await Promise.all([
    bulkIssueInvitations({ accountId: ACCOUNT, eventId: EV2, recipients: [racePhone] }),
    bulkIssueInvitations({ accountId: ACCOUNT, eventId: EV2, recipients: [racePhone] }),
  ]);
  const raceRows = await q<{ n: string }>(
    "SELECT COUNT(*)::text n FROM event_invitations WHERE event_id=$1 AND phone_normalized='01099999999'", [EV2]);
  const dispRows = await q<{ n: string }>(
    "SELECT COUNT(*)::text n FROM invitation_dispatch WHERE event_id=$1", [EV2]);
  const totalIssued = rc1.issued + rc2.issued;
  rec("S4 concurrent bulk same-phone -> exactly 1 invitation + 1 dispatch (no double-issue)",
    Number(raceRows[0].n) === 1 && Number(dispRows[0].n) === 1 && totalIssued <= 1,
    `invRow=${raceRows[0].n} dispRow=${dispRows[0].n} issued(c1)=${rc1.issued} issued(c2)=${rc2.issued} skipped=${rc1.skipped}/${rc2.skipped}`);
}
