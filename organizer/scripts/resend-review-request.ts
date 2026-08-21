/**
 * pending_review 상태 이벤트의 review-requested webhook 을 v2 로 재전송.
 *
 * 사용:
 *   npx tsx scripts/resend-review-request.ts <eventId> <accountId>
 *
 * ⚠️ 레벨2 컷오버 W2-EVT — go `events` 테이블이 사라져 "가장 최근 pending_review" 자동 탐색이
 *    불가능해졌다. eventId 와 소유 accountId(테넌트 경계)를 **둘 다** 인자로 받는다.
 *    accountId 는 `pushReviewRequestToV2` 가 v2 read 의 organizer_ref 로 쓴다 —
 *    없으면 타 계정 이벤트를 심사 큐에 밀어넣을 수 있으므로 필수다.
 */
import fs from "node:fs";

const env = fs.readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

async function main() {
  const { pushReviewRequestToV2 } = await import("../src/lib/v2/review-request-sync");

  const eventId = process.argv[2];
  const accountId = process.argv[3];
  if (!eventId || !accountId) {
    console.error("❌ 사용법: npx tsx scripts/resend-review-request.ts <eventId> <accountId>");
    process.exit(1);
  }

  console.log(`\n🔔 v2 review-requested 재전송 → ${eventId} (account ${accountId})`);
  const ok = await pushReviewRequestToV2(eventId, accountId);
  console.log(ok ? "✅ 성공" : "❌ 실패 — v2 서버 로그 확인 필요");
}

void main();
