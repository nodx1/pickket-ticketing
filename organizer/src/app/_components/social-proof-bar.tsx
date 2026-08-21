import { getPublicStatsV2 } from "@/lib/v2/commerce-client";
import { logger } from "@/lib/logger";
import { SocialProofBarClient } from "./social-proof-bar-client";

/**
 * ── 레벨2 컷오버 W2-PUB ──
 * go `COUNT(*) FROM attendees|events` → v2 `/internal/public/stats`.
 *
 * ⚠️ **표시 수치의 분모가 바뀐다**: 예전엔 go DB 만 셌고 이제 플랫폼 전체(v2)를 센다.
 *    v2 가 SoT 이므로 더 정확하지만, 랜딩에 노출되는 숫자가 커진다 → 제품 확인 필요.
 *
 * 실패 정책: 장식 섹션이므로 throw 하지 않고 **렌더 자체를 생략**한다(0 을 표시하면
 * "이벤트 0개"라는 거짓 신호가 된다 — 조용한 오정보 금지).
 */
export async function SocialProofBar() {
  // JSX 는 try 밖에서 만든다 — 서버 컴포넌트 렌더 에러는 try/catch 로 잡히지 않고
  // (React 가 나중에 렌더한다) 여기서 데이터 조회 실패만 다뤄야 하기 때문이다.
  let stats: Awaited<ReturnType<typeof getPublicStatsV2>>;
  try {
    stats = await getPublicStatsV2();
  } catch (err: unknown) {
    logger.warn("랜딩 소셜프루프 v2 집계 조회 실패(섹션 생략)", {
      error: err instanceof Error ? err.message : "unknown",
    });
    return null;
  }

  return (
    <SocialProofBarClient
      eventCount={stats.event_count}
      ticketCount={stats.ticket_count}
      liveCount={stats.live_event_count}
    />
  );
}
