import type { MetadataRoute } from "next";
import { listPublicEventsV2 } from "@/lib/v2/commerce-client";
import { logger } from "@/lib/logger";

// 런타임에만 생성 — 빌드 시 외부 호출 방지 (Docker build 에 v2 가 없음)
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** 사이트맵 1회 응답 상한(v2 목록 API 상한과 동일). 초과분은 다음 페이지로 이어붙인다. */
const PAGE_SIZE = 200;
/** 방어선 — 이벤트가 폭증해도 sitemap 생성이 무한히 돌지 않게 한다. */
const MAX_PAGES = 25;

/**
 * ── 레벨2 컷오버 W2-PUB ──
 * go `SELECT slug, updated_at FROM events WHERE status='live'` → v2 공개 목록 read.
 * 상태 게이트(live)는 **v2 가 서버에서 강제**한다(draft/paused 색인 유출 차단).
 *
 * 실패 정책: 기존과 동일하게 **정적 엔트리만 반환**한다. sitemap 은 크롤러 전용이라
 * 503 을 주면 색인 자체가 깨진다 — 여기서는 "빈 목록 위장"보다 "유효한 축소 sitemap"이
 * 덜 해롭다는 판단(사용자 화면이 아님). 대신 실패를 반드시 로그로 남긴다.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://pickket.go.kr";

  const events: Array<{ slug: string; updatedAt: string | null }> = [];
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await listPublicEventsV2({
        sort: "updated",
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      for (const e of result.events) {
        if (e.slug) events.push({ slug: e.slug, updatedAt: e.updated_at });
      }
      if (result.events.length < PAGE_SIZE) break;
    }
  } catch (err: unknown) {
    logger.warn("sitemap v2 공개 이벤트 목록 조회 실패(정적 엔트리만 반환)", {
      error: err instanceof Error ? err.message : "unknown",
      collected: events.length,
    });
  }

  return [
    {
      url: `${baseUrl}/`,
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/my-tickets`,
      changeFrequency: "daily",
      priority: 0.8,
    },
    ...events.map((event) => ({
      url: `${baseUrl}/e/${event.slug}`,
      ...(event.updatedAt ? { lastModified: new Date(event.updatedAt) } : {}),
      changeFrequency: "daily" as const,
      priority: 0.8,
    })),
  ];
}
