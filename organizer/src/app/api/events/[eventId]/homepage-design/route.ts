import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import {
  goAccountRef,
  updateEvent,
  upsertEventPage,
  V2CommerceError,
  type EventDetail,
} from "@/lib/v2/commerce-client";
import { EventAccessError, eventAccessStatus, requireOwnedEvent } from "@/lib/v2/event-access";
import { mapHomepageDesignToEventPage } from "@/lib/v2/homepage-design-mapping";
import { buildHomepageDesignPatch, homepageDesignSchema } from "@/lib/events/homepage-design-schema";

type Params = { eventId: string };

/** 홈페이지 빌더 디자인 조회 (레벨2 W2-EVT — go `events.homepage_design` → v2 흡수분). */
export const GET = withRole<Params>("organizer", async (_request, { session, params }) => {
  let event: EventDetail;
  try {
    event = await requireOwnedEvent(params.eventId, session.accountId);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse(err.message, eventAccessStatus(err));
    }
    throw err;
  }
  return successResponse(event.homepage_design ?? {});
});

/**
 * 홈페이지 빌더 디자인 저장.
 *
 * 두 개의 v2 write 가 있다:
 *  1) `events.homepage_design` — 주최자 편집 정본(빌더가 다시 읽는 값).
 *  2) `event_pages` — 소비자 화이트라벨 랜딩(/s/{subdomain}) 렌더 정본.
 *
 * 🔴 순서 고정: 편집 정본(1)을 먼저 확정한 뒤 파생(2)을 만든다. 반대로 하면 (1) 실패 시
 *    소비자 랜딩만 새 디자인이고 빌더는 옛 값을 보여주는 split-brain 이 된다.
 *    (2) 실패는 502 로 통지 — 편집 정본은 이미 저장됐으므로 재저장으로 수렴한다.
 */
export const PUT = withRole<Params>("organizer", async (request, { session, params }) => {
  let body: z.infer<typeof homepageDesignSchema>;
  try {
    body = homepageDesignSchema.parse(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) return errorResponse(ERR.INVALID_INPUT, 400);
    return errorResponse(ERR.SERVER, 500);
  }

  let event: EventDetail;
  try {
    event = await requireOwnedEvent(params.eventId, session.accountId);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse(err.message, eventAccessStatus(err));
    }
    throw err;
  }

  // ── 1) 편집 정본 저장 (v2 events.homepage_design) ──
  try {
    await updateEvent(
      event.event_id,
      { organizer_ref: goAccountRef(session.accountId), homepage_design: body },
      { idempotencyKey: `event-homepage-design:${params.eventId}:${Date.now()}` },
    );
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return errorResponse(
        "랜딩 디자인 저장 중 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.",
        503,
      );
    }
    throw err;
  }

  // ── 2) 소비자 화이트라벨 랜딩(event_pages) 파생 write-through ──
  try {
    await upsertEventPage(
      event.event_id,
      mapHomepageDesignToEventPage(body),
      // 안정 멱등키: 이벤트당 1개(동시 2회 저장은 fingerprint 로 최신 body 반영, 재시도는 중복생성 없음).
      { idempotencyKey: `event-page.${params.eventId}` },
    );
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return errorResponse(`랜딩 페이지 동기화에 실패했습니다: ${err.message}`, 502);
    }
    throw err;
  }

  return successResponse({ id: event.event_id });
});

/**
 * 홈페이지 디자인 **부분 병합** 저장.
 *
 * 🔴 왜 PUT 이 아니라 PATCH 가 따로 필요한가
 * PUT 은 `homepage_design` 을 **통째로 교체**한다. 디자이너 화면은 전체 상태를 들고 있어
 * 그래도 되지만, 이벤트 설정 화면처럼 **일부만 아는 화면**이 PUT 을 쓰면 나머지 값이
 * 전부 사라진다(색·토글·히어로 설정까지). 상세 이미지 하나 저장하려고 디자인을
 * 날리는 셈이다.
 *
 * 그래서 기존 값을 읽어 **받은 키만 덮어쓴다**. 요청에 없는 키는 그대로 남는다.
 */
export const PATCH = withRole<Params>("organizer", async (request, { session, params }) => {
  let patch: Partial<z.infer<typeof homepageDesignSchema>>;
  try {
    // 🔴 `.partial().parse()` 를 직접 쓰지 않는다 — `.default()` 필드가 요청에 없어도
    //    기본값으로 채워져 기존 값을 덮어쓴다. buildHomepageDesignPatch 가 그걸 거른다.
    patch = buildHomepageDesignPatch(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) return errorResponse(ERR.INVALID_INPUT, 400);
    return errorResponse(ERR.SERVER, 500);
  }

  let event: EventDetail;
  try {
    event = await requireOwnedEvent(params.eventId, session.accountId);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse(err.message, eventAccessStatus(err));
    }
    throw err;
  }

  const current = (event.homepage_design ?? {}) as Record<string, unknown>;
  const merged = { ...current, ...patch };

  try {
    await updateEvent(
      event.event_id,
      { organizer_ref: goAccountRef(session.accountId), homepage_design: merged },
      { idempotencyKey: `event-homepage-design:${params.eventId}:${Date.now()}` },
    );
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return errorResponse(
        "랜딩 디자인 저장 중 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.",
        503,
      );
    }
    throw err;
  }

  // 소비자 랜딩 파생은 **병합 결과 전체**로 만든다 — patch 만 넘기면 색·토글이 기본값으로 덮인다.
  try {
    await upsertEventPage(
      event.event_id,
      mapHomepageDesignToEventPage(merged as z.infer<typeof homepageDesignSchema>),
      { idempotencyKey: `event-page.${params.eventId}` },
    );
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return errorResponse(`랜딩 페이지 동기화에 실패했습니다: ${err.message}`, 502);
    }
    throw err;
  }

  return successResponse({ id: event.event_id });
});
