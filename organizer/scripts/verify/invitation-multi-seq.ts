/**
 * §5 초대권 1인 다장 발급 — **실 v2 검증**.
 *
 * 왜 필요한가: 단위테스트 37건은 전부 mock 기반이다. mock 은 내가 이해한 계약을 검증할 뿐
 * v2 가 실제로 그렇게 동작하는지는 증명하지 않는다. 실제로 mock 을 충실히 만든 덕에
 * 내 결함 2건이 잡혔지만(부활 id·상한 후 집계), 그 픽스처 자체가 맞았는지는 여기서 본다.
 *
 * 전제
 *   · v2 가 `V2_INTERNAL_BASE_URL` 에 떠 있고 alembic `invseq_0730` 적용
 *   · `hasAlimtalkCredentials() === false` (발송 stub) — 스크립트가 직접 확인하고 중단한다
 *   · HTTP 라우트가 아니라 **함수 직접 호출** — withAuth·세션·피처게이트·go DB 를 타지 않는다
 *
 * 실행
 *   npx tsx --env-file=.env.local scripts/verify/invitation-multi-seq.ts <eventId> <accountId>
 */
import { hasAlimtalkCredentials } from "@/lib/notification/alimtalk";
import { bulkIssueInvitations } from "@/lib/server/invitations";
import { getPrefixedRedis } from "@/lib/redis";
import {
  invitationBatchFingerprint,
  invitationBatchKey,
} from "@/lib/server/invitation-batch-key";
import { listEventInvitations, revokeInvitationV2 } from "@/lib/v2/commerce-client";

const eventId = process.argv[2];
const accountId = process.argv[3];

if (!eventId || !accountId) {
  console.error("사용법: … invitation-multi-seq.ts <eventId> <accountId>");
  process.exit(1);
}

// 🔴 실발송 방지 — 자격증명이 있으면 무조건 중단한다. 이 스크립트는 큐 적재까지 돌린다.
if (hasAlimtalkCredentials()) {
  console.error("🔴 중단: 발송 자격증명이 설정돼 있다. .env.local 에서 SENS/NCP 키를 제거하라.");
  process.exit(1);
}

/** 이 실행 전용 번호 — 기존 데이터와 섞이지 않게 접두사를 고정한다. */
const RUN = String(Date.now()).slice(-6);
// ⚠️ 0109990·0109991 은 메인세션 검증 스코프다 — 겹치지 않게 0107 로 잡는다.
const P1 = `0107${RUN}1`;
const P2 = `0107${RUN}2`;

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail: string) {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${label} — ${detail}`);
  } else {
    fail += 1;
    console.log(`  🔴 ${label} — ${detail}`);
  }
}

function rows(name: string, phone: string, n: number) {
  return Array.from({ length: n }, () => ({ name, phone }));
}

async function issue(recipients: Array<{ name: string; phone: string }>) {
  return bulkIssueInvitations({ accountId, eventId, recipients });
}

/** 배치 멱등키를 지워 "다른 배치" 로 만든다 — 재사용이 아닌 경로를 보려면 필요하다. */
async function clearBatch(recipients: Array<{ phone: string }>) {
  const fp = invitationBatchFingerprint(
    eventId,
    recipients.map((r) => ({ phoneNormalized: r.phone.replace(/\D/g, "") })),
  );
  await getPrefixedRedis().del(invitationBatchKey(eventId, fp));
}

async function seqsOf(phone: string) {
  const res = await listEventInvitations(eventId, accountId, { limit: 200 });
  return res.invitations
    .filter((i) => i.phone_normalized === phone)
    .map((i) => ({ seq: (i as { seq?: number }).seq, status: i.status, id: i.id, ticket: i.ticket_number }))
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

async function main() {
  console.log(`\n§5 실 v2 검증 — event=${eventId} run=${RUN}`);
  console.log(`v2=${process.env.V2_INTERNAL_BASE_URL}\n`);

  // ── §5-1 같은 번호 3줄 → 3장, seq 1·2·3
  console.log("§5-1 같은 번호 3줄");
  const r1 = await issue(rows("홍길동", P1, 3));
  check("발급 장수", r1.issued === 3, `issued=${r1.issued} atLimit=${r1.atLimit} failed=${r1.failed} ${JSON.stringify(r1.failures)}`);
  const s1 = await seqsOf(P1);
  check("순번 1·2·3", JSON.stringify(s1.map((x) => x.seq)) === "[1,2,3]", JSON.stringify(s1.map((x) => x.seq)));
  // 🔴 빈 배열에 every() 는 **true** 다 — 발급이 0건이면 이 검사가 공허하게 통과한다.
  //    (첫 실행에서 실제로 그렇게 ✅ 가 떴다) 건수를 먼저 단언한다.
  check(
    "티켓번호 부착",
    s1.length === 3 && s1.every((x) => Boolean(x.ticket)),
    `${s1.length}건 · ${s1.map((x) => x.ticket ?? "null").join(",")}`,
  );

  // ── §5-3 같은 파일 재업로드 → 재사용
  console.log("\n§5-3 같은 명단 재업로드");
  const r3 = await issue(rows("홍길동", P1, 3));
  check("replayed", r3.replayed === true, `replayed=${String(r3.replayed)} issued=${r3.issued}`);
  check("추가 발급 없음", (await seqsOf(P1)).length === 3, `${(await seqsOf(P1)).length}건`);

  // ── §5-5 이름만 바꿔 재업로드 → 재사용(지문에 이름 없음)
  console.log("\n§5-5 이름만 바꿔 재업로드");
  const r5 = await issue(rows("홍길똥", P1, 3));
  check("replayed", r5.replayed === true, `replayed=${String(r5.replayed)}`);

  // ── §5-2 같은 번호 7줄 → 5장 + atLimit 2
  console.log("\n§5-2 상한(7줄 요청)");
  await clearBatch(rows("x", P1, 7));
  const r2 = await issue(rows("홍길동", P1, 7));
  const s2 = await seqsOf(P1);
  check("총 5장", s2.filter((x) => x.status !== "revoked").length === 5, `${s2.length}건 seq=${JSON.stringify(s2.map((x) => x.seq))}`);
  check("이번 추가 2장", r2.issued === 2, `issued=${r2.issued}`);
  check("atLimit 5건", r2.atLimit === 5, `atLimit=${r2.atLimit}`);
  check("failed 0 (상한은 실패가 아니다)", r2.failed === 0, `failed=${r2.failed} ${JSON.stringify(r2.failures)}`);

  // ── §5-8 섞인 배치 — 번호별 순번 독립
  console.log("\n§5-8 번호 섞인 배치");
  const mixed = [...rows("김철수", P2, 2), ...rows("홍길동", P1, 1)];
  await clearBatch(mixed);
  const r8 = await issue(mixed);
  const s8 = await seqsOf(P2);
  check("P2 순번 1·2", JSON.stringify(s8.map((x) => x.seq)) === "[1,2]", JSON.stringify(s8.map((x) => x.seq)));
  check("P1 은 상한이라 추가 없음", r8.atLimit >= 1, `issued=${r8.issued} atLimit=${r8.atLimit}`);

  // ── §5-4 / §5-7 상한 도달 후 회수 → 그 자리에 재발급(부활)
  console.log("\n§5-4·7 상한 도달 후 회수 → 재발급");
  const target = (await seqsOf(P1)).find((x) => x.status !== "revoked");
  if (!target) {
    check("회수 대상 확보", false, "미회수 초대권이 없다");
  } else {
    await revokeInvitationV2(target.id, accountId);
    const afterRevoke = await seqsOf(P1);
    check(
      "회수 반영",
      afterRevoke.find((x) => x.seq === target.seq)?.status === "revoked",
      `seq=${target.seq} status=${afterRevoke.find((x) => x.seq === target.seq)?.status}`,
    );

    await clearBatch(rows("x", P1, 1));
    const r7 = await issue(rows("새수신자", P1, 1));
    check("빈 자리에 재발급", r7.issued === 1, `issued=${r7.issued} atLimit=${r7.atLimit} ${JSON.stringify(r7.failures)}`);

    const revived = (await seqsOf(P1)).find((x) => x.seq === target.seq);
    check("그 순번이 부활", revived?.status !== "revoked", `seq=${target.seq} status=${revived?.status}`);
    // 🔴 이게 내 결함 ①의 실증 — 부활 시 v2 는 **기존 id** 를 돌려준다.
    //    요청 id 를 계속 쓰면 티켓번호가 안 붙는다(예외는 나지 않는다).
    check("부활 행에 티켓번호 부착", Boolean(revived?.ticket), `ticket=${revived?.ticket ?? "null"}`);
    check("id 가 원래 행 그대로", revived?.id === target.id, `${target.id} → ${revived?.id}`);
  }

  console.log(`\n결과: ${pass} passed / ${fail} failed`);
  console.log(`정리용 스코프: phone_normalized IN ('${P1}','${P2}')`);
  process.exit(fail > 0 ? 1 : 0);
}

void main().catch((err: unknown) => {
  console.error("\n🔴 스크립트 실패:", err instanceof Error ? err.message : err);
  process.exit(1);
});
