import { NextRequest, NextResponse } from "next/server";
import { getPrefixedRedis } from "@/lib/redis";
import { PUBLIC_ANY_STATUS, resolvePublicEventById } from "@/lib/v2/public-event";
import { contextBannerCacheKey, resolveContextBanner } from "@/lib/public/context-banner";

// 공개 비인증 API — v2 이벤트 조회를 매 요청 태우지 않도록 짧은 TTL 캐시(go: prefix).
//
// ⚠️ TTL 을 짧게 잡은 이유: 이제 배너는 **주최자가 직접 쓴 문구**다. 문구를 비워
//    배너를 끄려 했는데 몇 분간 남아 있으면 "왜 안 지워지지" 가 된다.
//    저장 시 무효화(`invalidateContextBanner`)가 1차이고, 이 TTL 은 그것이
//    실패했을 때의 백스톱이다.
const BANNER_CACHE_TTL_SEC = 30;

export async function GET(_request: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await params;

    // 캐시 히트 — 배너 문자열(또는 빈문자=배너없음)을 그대로 반환.
    const cacheKey = contextBannerCacheKey(eventId);
    try {
      const cached = await getPrefixedRedis().get(cacheKey);
      if (cached !== null) {
        return NextResponse.json({ data: { banner: cached === "" ? null : cached } });
      }
    } catch {
      /* redis 장애 시 캐시 우회(비차단) */
    }

    // W2-PUB: go `SELECT title, starts_at, venue_name, v2_event_id FROM events` 대체.
    //   배너는 표시 전용 부가기능이라 v2 불가 시에도 화면을 막지 않는다(banner:null 200) —
    //   ⚠️ 이건 "빈 목록 위장"이 아니라 **배너 미표시**다(구매 경로·재고 판정과 무관).
    const resolved = await resolvePublicEventById(eventId, PUBLIC_ANY_STATUS);
    if (!resolved.ok) {
      return NextResponse.json({ data: { banner: null } });
    }
    const e = resolved.event;

    // 🔴 주최자가 쓴 문구만 표시한다 (2026-07-30 주최측 피드백).
    //
    // 종전에는 여기서 `D-N · 날짜 · 잔여석 · 최저가` 를 **직접 계산**했고, 설정 화면의
    // 「상단 안내 배너」 입력값은 읽지 않았다. 그래서 주최자가 쓴 공지는 사라지고
    // 통제할 수 없는 자동 문구가 최상단에 떴다 — KLPGA 에서 **`₩0부터`** 가 나왔다
    // (최저가 계산에 0원 comp 등급이 섞여 유료 대회가 무료로 보였다).
    //
    // 이제 문구를 비우면 배너가 사라진다. v2 티어 조회도 불필요해져 공개 API 가 가벼워졌다.
    const banner = resolveContextBanner(e.context_banner);

    // 빈 배너도 캐시한다 — 배너 없는 이벤트가 매 요청 v2 를 때리지 않게.
    try {
      await getPrefixedRedis().set(cacheKey, banner ?? "", "EX", BANNER_CACHE_TTL_SEC);
    } catch {
      /* redis 장애 시 캐시 스킵(비차단) */
    }

    return NextResponse.json({ data: { banner } });
  } catch {
    return NextResponse.json({ data: { banner: null } });
  }
}
