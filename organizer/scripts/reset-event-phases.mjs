import { Client } from "pg";
import { readFileSync } from "fs";
const env = Object.fromEntries(readFileSync(".env.local","utf8").split("\n").filter(l=>l&&!l.startsWith("#")&&l.includes("=")).map(l=>{const i=l.indexOf("=");return[l.slice(0,i).trim(),l.slice(i+1).trim()]}));
const c = new Client({host:env.PG_HOST,port:+env.PG_PORT,user:env.PG_USER,password:env.PG_PASSWORD,database:env.PG_DATABASE});
await c.connect();
const eventId = process.argv[2];
const minutes = Number(process.argv[3] ?? "30");
if (!eventId) { console.error("Usage: node scripts/reset-event-phases.mjs <event_id> [minutes]"); process.exit(1); }

const opensAt = new Date();
const closesAt = new Date(opensAt.getTime() + minutes * 60000);
const fcfsStart = new Date(closesAt.getTime() + 60000);

await c.query(`DELETE FROM sale_phases WHERE event_id = $1`, [eventId]);
await c.query(`INSERT INTO sale_phases (id, account_id, event_id, phase_order, mode, opens_at, closes_at, status, config) SELECT gen_random_uuid(), account_id, $1, 1, 'lottery', $2, $3, 'scheduled', '{"payment_window_hours":72}'::jsonb FROM events WHERE id = $1`, [eventId, opensAt.toISOString(), closesAt.toISOString()]);
await c.query(`INSERT INTO sale_phases (id, account_id, event_id, phase_order, mode, opens_at, closes_at, status, config) SELECT gen_random_uuid(), account_id, $1, 2, 'fcfs_residual', $2, NULL, 'scheduled', '{}'::jsonb FROM events WHERE id = $1`, [eventId, fcfsStart.toISOString()]);
await c.query(`UPDATE seat_tiers SET sale_mode = 'point_lottery' WHERE event_id = $1`, [eventId]);

const ph = await c.query(`SELECT phase_order, mode, opens_at, closes_at FROM sale_phases WHERE event_id = $1 ORDER BY phase_order`, [eventId]);
console.log("✓ Phases reset:"); console.table(ph.rows);
await c.end();
console.log(`\n다음 단계:\n1. npx tsx scripts/resync-v2-now.ts ${eventId}\n2. v2 DB 에서 tier sale_mode 업데이트:\n   UPDATE seat_tiers SET sale_mode='point_lottery' WHERE event_id='${eventId}';`);
