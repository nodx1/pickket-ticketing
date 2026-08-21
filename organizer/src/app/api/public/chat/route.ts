/**
 * 공개 이벤트 챗봇 — v2 CS 챗봇(`POST /api/v1/chat`, chatbot_service)으로 라우팅.
 *
 * go 자체 LLM 챗봇(public_chat_sessions + Anthropic)은 폐기됐다(레벨2 go DB 흡수 §영역B).
 * 이 라우트는 기존 프론트 계약({ eventId, sessionKey, message } → { data: { reply, escalate } })을
 * 유지하되, 실제 응답 생성은 v2 챗봇 서비스에 위임하는 얇은 프록시다(재구축 아님, 라우팅만).
 *
 * v2 계약: 요청 { message, conversation_id?, event_id? } → 응답 { response, tier, conversation_id, escalated }.
 * 세션 연속성: go 의 sessionKey ↔ v2 conversation_id 매핑(왕복 전달)으로 대화 맥락 유지.
 * 이벤트 맥락: go 의 eventId 를 v2 event_id 로 전달 → v2 챗봇이 해당 이벤트 정보를
 *   시스템프롬프트에 주입해 이벤트-특정 질문에 정확히 답한다(과거엔 무시했음).
 * 인증 불필요(공개 엔드포인트) — v2 도 미인증 사용을 허용한다.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { isProdRuntime } from "@/lib/env/runtime";
import { rateLimitKey } from "@/lib/request-ip";
import { checkRateLimit } from "@/lib/rate-limit";

const requestSchema = z.object({
  // eventId 는 v2 event_id 로 전달돼 해당 이벤트 정보 context 를 챗봇에 주입한다.
  eventId: z.string().uuid().optional(),
  // sessionKey 는 v2 conversation_id 로 왕복 전달돼 대화 맥락을 잇는다.
  sessionKey: z.string().min(8).max(64).optional(),
  message: z.string().trim().min(1).max(1000),
});

interface V2ChatResponse {
  response: string;
  tier: number;
  conversation_id: string;
  escalated: boolean;
}

export async function POST(request: NextRequest) {
  // 🔴 종전엔 xff[0](위조 가능) → x-real-ip(CF 엣지) → "unknown"(전원 한 버킷) 이었다.
  const ip = rateLimitKey(request.headers, isProdRuntime());
  if (ip === null) {
    return NextResponse.json({ error: "요청을 처리할 수 없습니다" }, { status: 503 });
  }
  const rateLimit = await checkRateLimit(`chat:${ip}`, { max: 10, windowMs: 60_000 });

  if (!rateLimit.success) {
    return NextResponse.json(
      { error: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요." },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)),
        },
      },
    );
  }

  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
    }
    return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  const v2Base = process.env.V2_INTERNAL_BASE_URL;
  if (!v2Base) {
    logger.error("공개 챗봇 v2 라우팅 미설정", { source: "public-chat", reason: "V2_INTERNAL_BASE_URL 없음" });
    return NextResponse.json({ error: "챗봇을 잠시 사용할 수 없습니다." }, { status: 503 });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    let res: Response;
    try {
      res = await fetch(`${v2Base.replace(/\/$/, "")}/api/v1/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: body.message,
          conversation_id: body.sessionKey ?? null,
          event_id: body.eventId ?? null,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      // v2 레이트리밋(429)·기타 오류는 사용자 친화 문구로 매핑.
      if (res.status === 429) {
        return NextResponse.json(
          { error: "메시지 전송 한도를 초과했습니다. 잠시 후 다시 시도해주세요." },
          { status: 429 },
        );
      }
      logger.warn("공개 챗봇 v2 응답 오류", { source: "public-chat", status: res.status });
      return NextResponse.json({ error: "응답 생성에 실패했습니다." }, { status: 502 });
    }

    const data = (await res.json()) as V2ChatResponse;

    return NextResponse.json({
      data: {
        reply: data.response,
        // v2 conversation_id 를 sessionKey 자리로 되돌려 프론트가 다음 요청에 재사용하도록 한다.
        sessionKey: data.conversation_id,
        escalate: data.escalated,
      },
    });
  } catch (err: unknown) {
    logger.error("공개 챗봇 v2 라우팅 오류", {
      source: "public-chat",
      error: err instanceof Error ? err.message : "알 수 없는 오류",
    });
    return NextResponse.json({ error: "응답 생성에 실패했습니다." }, { status: 502 });
  }
}
