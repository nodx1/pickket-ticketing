/**
 * [DEPRECATED — 레벨2 컷오버(스코프A)] 대기열 구매 제안 만료 리퍼.
 *
 * 대기열 정본이 v2 로 이관되면서 만료 처리도 v2 Celery task 로 이전됨:
 *   platform/backend/app/tasks/waitlist_offer_reaper.py (beat: waitlist-reap-expired-offers, 5분)
 *
 * 이 go 스크립트는 go DB waitlist_entries 를 직접 UPDATE 하던 경로다. 정본이 v2 이므로
 * 더 이상 go DB 를 건드려선 안 된다(SSOT 위반·유령 상태). 실행 시 안내만 출력하고 종료한다.
 */
import process from "node:process";

function main(): void {
  console.log(
    "[waitlist-offer-reaper] DEPRECATED — 대기열 만료 처리는 v2 Celery(waitlist_offer_reaper.reap_expired_offers, 5분 주기)로 이관되었습니다. go DB 직접 만료 금지.",
  );
  process.exit(0);
}

main();
