/**
 * 소비자 문의 제출(공개) — 이벤트 slug 로 문의를 남긴다.
 * 인증 없음. 남용 방지를 위해 길이 제한 + 이벤트 존재 검증.
 *
 * ── 레벨2 컷오버 W2-PUB → W5-SUPPORT (전환 완료) ──
 * ✅ go `SELECT id, account_id FROM events WHERE slug=$1 AND status IN ('live','paused')`
 *    → v2 by-slug live read + 동일 상태 게이트(호출측 판정).
 * ✅ `event_inquiries` 원장도 v2 로 이관(주최자 문의함과 **같은 배치**에서 옮겨 접수·조회가
 *    갈라지지 않게 했다).
 *
 * 🔴 이 경로는 **비인증 공개 접수**다. 저장 실패를 200/202 로 흘리면 고객은 접수됐다고
 *    믿는데 아무 데도 남지 않는다. 저장 실패는 반드시 5xx 로 되돌린다(아래 catch 참조).
 */
import { z } from "zod";
import crypto from "node:crypto";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { isProdRuntime } from "@/lib/env/runtime";
import { rateLimitKey } from "@/lib/request-ip";
import { ERR } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { submitEventInquiry, V2CommerceError } from "@/lib/v2/commerce-client";
import {
  PUBLIC_LIVE_OR_PAUSED_STATUSES,
  resolvePublicEventBySlug,
} from "@/lib/v2/public-event";

const MAX_BODY_BYTES = 16 * 1024;
const IP_LIMIT = { windowMs: 60_000, max: 5, onRedisError: "closed" as const };
const EVENT_LIMIT = { windowMs: 60_000, max: 30, onRedisError: "closed" as const };
const FINGERPRINT_LIMIT = { windowMs: 30_000, max: 1, onRedisError: "closed" as const };

const schema = z.object({
  slug: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9가-힣_-]+$/),
  question: z.string().trim().min(5, "문의 내용을 5자 이상 입력해주세요").max(1000),
  contact: z.string().trim().max(200).refine(
    (value) => value.length === 0 || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || /^\+?[0-9()\-\s]{8,30}$/.test(value),
    "연락처 형식이 올바르지 않습니다",
  ).optional(),
  source: z.enum(["web", "chatbot"]).optional(),
  // 숨김 필드에 값이 들어오면 저장하지 않고 성공 형태로 종료한다(봇 피드백 방지).
  website: z.string().max(200).optional(),
});

/**
 * 🔴 종전엔 `clientBucket()` 이 `TRUSTED_PROXY !== "true"` 면 전건 `"untrusted-proxy"` 를
 *    돌려줬다. 그 env 가 **prod 에 설정되어 있지 않아서**(CapRover env 34개 전수 확인)
 *    문의 폼의 레이트리밋 키가 상시 한 값이었다 — 전 세계가 5회/분 버킷 하나를 공유했고,
 *    한 명이 채우면 나머지 전원이 막혔다. fail-closed 설계가 **상시 발동**한 상태였다.
 *
 *    정본 유도(`rateLimitKey` — CF-Connecting-IP 우선)로 대체하고 그 env 는 폐기한다.
 *    "신뢰한 ingress 만" 이라는 의도는 유지된다 — 다만 boolean env 대신
 *    "CF 를 거친 증거(CF-Connecting-IP)" 로 판정한다. 근거는 lib/request-ip.ts 상단.
 */

function fingerprint(eventId: string, question: string, contact: string | undefined): string {
  return crypto
    .createHash("sha256")
    .update(`${eventId}\n${question.trim().toLowerCase()}\n${contact?.trim().toLowerCase() ?? ""}`)
    .digest("hex");
}

function limited(resetAt: number) {
  return new Response(JSON.stringify({ success: false, error: "요청이 너무 많습니다" }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))),
    },
  });
}

export async function POST(request: Request) {
  try {
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_BODY_BYTES) return errorResponse("요청 본문이 너무 큽니다", 413);
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return errorResponse("요청 본문이 너무 큽니다", 413);
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      return errorResponse(ERR.INVALID_INPUT, 400);
    }
    const body = schema.parse(parsedBody);

    const bucket = rateLimitKey(request.headers, isProdRuntime());
    if (bucket === null) return errorResponse("요청을 처리할 수 없습니다", 503);
    const ipLimit = await checkRateLimit(`inquiry:ip:${bucket}`, IP_LIMIT);
    if (!ipLimit.success) return limited(ipLimit.resetAt);
    if (body.website?.trim()) return successResponse({ received: true }, 202);

    const resolved = await resolvePublicEventBySlug(body.slug, PUBLIC_LIVE_OR_PAUSED_STATUSES);
    if (!resolved.ok) return errorResponse(resolved.error, resolved.status);
    const ev = { id: resolved.event.event_id };
    // ⚠️ 옛 `go_account_id` 필수 검사(404)를 제거했다. 그 검사는 **원장의 account_id NOT NULL
    //    제약** 때문에 있었을 뿐인데, v2 `event_inquiries` 는 account 축 없이 events FK 로만
    //    매달리므로(경계 = events.organizer_id) 제약 자체가 사라졌다. 유지하면 v2-네이티브
    //    이벤트의 문의를 **이유 없이 거부**하게 된다("기능을 폐기하지 않는다").

    const eventLimit = await checkRateLimit(`inquiry:event:${ev.id}`, EVENT_LIMIT);
    if (!eventLimit.success) return limited(eventLimit.resetAt);
    const duplicateLimit = await checkRateLimit(
      `inquiry:fingerprint:${fingerprint(ev.id, body.question, body.contact)}`,
      FINGERPRINT_LIMIT,
    );
    if (!duplicateLimit.success) return limited(duplicateLimit.resetAt);

    // 🔴 저장 실패는 절대 200/202 로 흘리지 않는다 — 아래 catch 가 500 으로 되돌린다.
    await submitEventInquiry(ev.id, {
      question: body.question.trim(),
      contact: body.contact?.trim() || null,
      source: body.source ?? "web",
    });

    return successResponse({ received: true }, 201);
  } catch (err: unknown) {
    if (err instanceof z.ZodError) return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    if (err instanceof V2CommerceError) {
      // 🔴 v2 가 준 4xx 를 그대로 되돌리면 안 된다: 여기서 4xx 는 **접수 실패**인데
      //    소비자 입력 잘못이 아니다(입력은 위 zod 가 이미 검증했다). 접수되지 않았다는
      //    사실을 명확히 5xx 로 알려 소비자가 재시도하게 한다.
      return errorResponse("문의를 접수하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    return errorResponse(ERR.SERVER, 500);
  }
}
