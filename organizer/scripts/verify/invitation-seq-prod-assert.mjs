/**
 * S1~S3 판정 — prod 원장을 **기준선 대비 델타**로 읽는다.
 *
 * 🔴 왜 델타인가
 * 회람의 S1 은 "같은 번호 3줄 → 원장 3건 · seq [1,2,3]" 이지만, prod 의 대상 번호에는
 * **이미 1장(seq=1, viewed)** 이 있다. 그대로 단언하면 정상인데도 실패로 보인다.
 * 기준선을 먼저 찍고 그 위의 증가분을 본다.
 *
 * 🔴 "에러 없음" 으로 판정하지 않는다
 * seq 루프가 죽으면 **1장만 발권되고 나머지는 조용히 스킵**된다(에러 0건). 그래서
 *   · 신규 행수 == 기대치
 *   · seq 가 점유된 자리를 건너뛰고 연속 배정됐는지
 *   · 티켓번호가 **실제로 붙었는지**(NULL 이면 발권 실패를 원장이 감춘 것)
 * 를 각각 단언한다.
 *
 * 사용
 *   node scripts/verify/invitation-seq-prod-assert.mjs baseline   ← 업로드 **전**
 *   node scripts/verify/invitation-seq-prod-assert.mjs check 3    ← 업로드 후(기대 신규 3건)
 *
 * 연결정보는 PG_V2_URL 환경변수(scripts/ops/backup.env)에서 읽는다.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const PHONE = process.env.PHONE ?? "01021830077";
const EVENT = process.env.EVENT_ID ?? "867128f5-5cec-41de-81e0-b1eace7ce09b";
const STATE = "/tmp/invitation-seq-baseline.json";
/**
 * 🔴 접속정보를 **argv 로 넘기지 않는다** (2026-07-31 실사고).
 * `psql <url>` 형태로 넘겼더니 psql 이 실패했을 때 execFileSync 의 에러 메시지에
 * **비밀번호가 통째로 찍혔다**. 프로세스 목록(`ps`)에도 노출된다.
 * ⟹ URL 을 파싱해 PG* 환경변수로만 전달한다.
 */
const RAW = process.env.PG_V2_URL;
if (!RAW) { console.error("PG_V2_URL 미설정 — scripts/ops/backup.env 를 source 하라"); process.exit(2); }
const u = new URL(RAW);
const PGENV = {
  ...process.env,
  PGHOST: u.hostname,
  PGPORT: u.port || "5432",
  PGUSER: decodeURIComponent(u.username),
  PGPASSWORD: decodeURIComponent(u.password),
  PGDATABASE: u.pathname.replace(/^\//, ""),
  PG_V2_URL: "",           // 자식 프로세스에도 원본을 넘기지 않는다
};

const q = (sql) => {
  try {
    return execFileSync("psql", ["-F", "\t", "-tAc", sql], { encoding: "utf8", env: PGENV }).trim();
  } catch (err) {
    // stderr 만 보여준다 — err.message 에는 명령행이 통째로 들어간다.
    console.error("  psql 실패:", String(err.stderr ?? "").trim().slice(0, 300));
    process.exit(3);
  }
};

function rows() {
  const out = q(
    `select seq, status, coalesce(ticket_number,'∅'), coalesce(recipient_name,'∅'),
            token_version, coalesce(revoked_at::text,'')
     from event_invitations
     where event_id='${EVENT}' and phone_normalized='${PHONE}' order by seq`,
  );
  return out ? out.split("\n").map((l) => {
    const [seq, status, ticket, name, tv, revokedAt] = l.split("\t");
    return { seq: Number(seq), status, ticket, name, tokenVersion: Number(tv), revokedAt };
  }) : [];
}
const dispatch = () =>
  q(`select coalesce(string_agg(d.st||'×'||d.n, ', '),'없음') from (
       select di.status as st, count(*) n from invitation_dispatch di
       join event_invitations e on e.id=di.invitation_id
       where e.phone_normalized='${PHONE}' group by di.status) d`);

const mode = process.argv[2] ?? "baseline";

if (mode === "baseline") {
  const before = rows();
  writeFileSync(STATE, JSON.stringify({ before }, null, 2));
  console.log(`  기준선 저장 — 기존 ${before.length}건`);
  before.forEach((r) => console.log(`    seq=${r.seq} ${r.status} ${r.ticket} (${r.name})`));
  console.log(`  발송큐: ${dispatch()}`);
  process.exit(0);
}

/**
 * S3 — 회수한 순번이 **되살아나는가**.
 *
 * 🔴 S1 과 판정이 다르다. 부활은 **새 행을 만들지 않는다** — 기존 행을 되살린다.
 *    그래서 "신규 seq 가 늘었는가" 로 보면 정상인데도 실패로 읽힌다.
 *    여기서 봐야 하는 것:
 *      · 총 행수가 **그대로**여야 한다(seq 6 이 생기면 상한 5 가 뚫린 것)
 *      · 티켓번호가 **바뀌어야** 한다(옛 티켓은 회수됐다 — 같으면 죽은 티켓을 다시 보낸 것)
 *      · `revoked_at` 이 **비워져야** 한다(남아 있으면 status 와 어긋난 유령 상태)
 *      · `token_version` 은 **줄지 않아야** 한다(줄면 이미 보낸 회수 링크가 되살아난다)
 */
if (mode === "s3-baseline") {
  const target = Number(process.argv[3] ?? 5);
  const row = rows().find((r) => r.seq === target);
  if (!row) { console.error(`seq=${target} 행이 없다`); process.exit(2); }
  // 🔴 죽은 티켓번호를 따로 받는다. 회수 후 발권이 실패해 원장의 ticket_number 가 이미
  //    비워졌으면, "기준선의 티켓과 다른가" 만으로는 **죽은 티켓 재사용을 못 잡는다.**
  const dead = process.env.DEAD_TICKET ?? row.ticket;
  writeFileSync("/tmp/invitation-s3-baseline.json", JSON.stringify({ total: rows().length, row, dead }, null, 2));
  console.log(`  S3 기준선 — 총 ${rows().length}행 · 대상 seq=${row.seq} ${row.status} ${row.ticket} tv=${row.tokenVersion} revoked_at=${row.revokedAt || "NULL"}`);
  process.exit(0);
}

if (mode === "s3-check") {
  const S3 = "/tmp/invitation-s3-baseline.json";
  if (!existsSync(S3)) { console.error("S3 기준선이 없다 — 먼저 `s3-baseline` 을 실행하라"); process.exit(2); }
  const { total, row: before, dead } = JSON.parse(readFileSync(S3, "utf8"));
  const after = rows();
  const now = after.find((r) => r.seq === before.seq);
  const results = [];
  const rec = (id, ok, note) => { results.push({ id, ok }); console.log(`  ${ok ? "✅" : "🔴"} ${id} — ${note}`); };

  console.log(`  회수 전 seq=${before.seq} ${before.status} ${before.ticket} tv=${before.tokenVersion}`);
  console.log(`  현재   seq=${now?.seq} ${now?.status} ${now?.ticket} tv=${now?.tokenVersion} revoked_at=${now?.revokedAt || "NULL"}`);
  console.log("");

  rec("S3-a", after.length === total,
    `총 ${after.length}행 (기준 ${total}) — 늘었으면 새 순번을 만든 것이고 상한 5 가 뚫린다`);
  // 🔴 "revoked 가 아니다" 로는 부족하다 — `failed` 도 부활 실패다(2026-07-31 실사고).
  rec("S3-b", now != null && ["issued", "sent", "viewed"].includes(now.status),
    `상태 ${now?.status} — issued/sent/viewed 가 아니면 부활하지 않았다`
    + (now?.status === "failed" ? " 🔴 발권이 죽었다(원장 failure_reason 확인)" : ""));
  rec("S3-c", now != null && now.ticket !== "∅" && now.ticket !== dead,
    `티켓번호 ${dead} → ${now?.ticket} — 같으면 회수돼 죽은 티켓을 다시 보낸 것`);
  rec("S3-d", now != null && !now.revokedAt,
    `revoked_at ${now?.revokedAt || "NULL"} — 남아 있으면 status 와 어긋난 유령 상태`);
  rec("S3-e", now != null && now.tokenVersion >= before.tokenVersion,
    `token_version ${before.tokenVersion} → ${now?.tokenVersion} — 줄면 이미 보낸 회수 링크가 되살아난다`);

  console.log("");
  console.log(`  발송큐: ${dispatch()}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`  ${failed.length === 0 ? "✅" : "🔴"} ${results.length - failed.length}/${results.length}${failed.length ? " — 실패: " + failed.map((f) => f.id).join(", ") : ""}`);
  if (failed.length) process.exitCode = 1;
  process.exit();
}

if (!existsSync(STATE)) { console.error("기준선이 없다 — 먼저 `baseline` 을 실행하라"); process.exit(2); }
const { before } = JSON.parse(readFileSync(STATE, "utf8"));
const expectNew = Number(process.argv[3] ?? 3);
const after = rows();
const beforeSeqs = new Set(before.map((r) => r.seq));
const fresh = after.filter((r) => !beforeSeqs.has(r.seq));

const results = [];
const rec = (id, ok, note) => { results.push({ id, ok }); console.log(`  ${ok ? "✅" : "🔴"} ${id} — ${note}`); };

console.log(`  기준선 ${before.length}건 [${before.map((r) => r.seq).join(",")}] → 현재 ${after.length}건 [${after.map((r) => r.seq).join(",")}]`);
console.log("");

rec("S1-a", fresh.length === expectNew,
  `신규 발급 ${fresh.length}건 (기대 ${expectNew}) — 1건이면 seq 루프가 죽고 조용히 스킵된 것`);

const expectedSeqs = [];
for (let s = 1, need = expectNew; s <= 5 && need > 0; s += 1) {
  if (!beforeSeqs.has(s)) { expectedSeqs.push(s); need -= 1; }
}
const gotSeqs = fresh.map((r) => r.seq).sort((a, b) => a - b);
rec("S1-b", JSON.stringify(gotSeqs) === JSON.stringify(expectedSeqs),
  `순번 [${gotSeqs.join(",")}] (기대 [${expectedSeqs.join(",")}] — 점유된 자리를 건너뛴다)`);

const noTicket = fresh.filter((r) => r.ticket === "∅");
rec("S1-c", noTicket.length === 0,
  noTicket.length ? `🔴 티켓번호 없는 행 ${noTicket.length}건 — 원장이 발권실패를 감췄다` : "신규 전건에 티켓번호 부착");

rec("S1-d", after.length <= 5, `총 ${after.length}건 ≤ 상한 5`);

const dup = new Set(after.map((r) => r.seq)).size !== after.length;
rec("S1-e", !dup, dup ? "🔴 seq 중복" : "seq 중복 없음");

console.log("");
console.log(`  발송큐: ${dispatch()}`);
fresh.forEach((r) => console.log(`    신규 seq=${r.seq} ${r.status} ${r.ticket} (${r.name})`));

const failed = results.filter((r) => !r.ok);
console.log("");
console.log(`  ${failed.length === 0 ? "✅" : "🔴"} ${results.length - failed.length}/${results.length}${failed.length ? " — 실패: " + failed.map((f) => f.id).join(", ") : ""}`);
console.log("  ⚠️ 화면의 '상한도달(atLimit)' 숫자는 DB 에 안 남는다 — 응답 화면에서 직접 확인할 것");
if (failed.length) process.exitCode = 1;
