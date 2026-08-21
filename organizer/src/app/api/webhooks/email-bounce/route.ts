/**
 * 이메일 바운스/컴플레인 수신 → 억제목록(suppression) 반영.
 * 하드바운스·스팸신고 주소로 재발송하면 발신 평판이 급락하므로 전역 차단한다.
 *
 * ⚠️ H-10: 억제는 **명시 allowlist(하드바운스·컴플레인) 매칭 시에만**. 빈 type·미지 이벤트는
 *   전역 억제하지 않고 quarantine(로그만) — 안 그러면 임의/신규 provider 이벤트가 정상 주소를
 *   전역 차단(경쟁사 억제·DoS)하는 벡터가 된다.
 * 인증: Authorization: Bearer ${EMAIL_BOUNCE_SECRET or CRON_SECRET}.
 *   (per-provider HMAC 서명 검증은 NCP 바운스 페이로드 규격 확정 후 추가 — 보드 잔여.)
 * 페이로드(관대 파싱): { events: [{ email, type }] } 또는 { email, type }.
 */
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { suppress } from "@/lib/notification/compliance";
import { logger, maskPII } from "@/lib/logger";

interface BounceEvent {
  email?: string;
  address?: string;
  type?: string;
  eventType?: string;
}

// 억제 대상 allowlist — 영구 실패(하드바운스)·수신자 신고(컴플레인)만.
const COMPLAINT = /complaint|spam|abuse/i;
const HARD_BOUNCE = /hard|permanent|mailbox_?full|no_?such|invalid_?address|user_?unknown/i;
// 일시 실패(재시도 가능) — 억제하지 않음.
const TRANSIENT = /soft|defer|delay|transient|temporary|throttl|greylist|timeout/i;

export async function POST(request: Request) {
  const secret = (process.env.EMAIL_BOUNCE_SECRET || process.env.CRON_SECRET) ?? "";
  const authHeader = request.headers.get("authorization") ?? "";
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return errorResponse("인증 정보가 올바르지 않습니다", 401);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse("잘못된 페이로드입니다", 400);
  }

  const p = payload as { events?: BounceEvent[] } & BounceEvent;
  const events: BounceEvent[] = Array.isArray(p.events) ? p.events : [p];

  let suppressed = 0;
  let quarantined = 0;
  const quarantineSamples: Array<{ type: string; email: string }> = [];

  for (const e of events) {
    const email = (e.email || e.address || "").trim().toLowerCase();
    const type = (e.type || e.eventType || "").trim();
    if (!email || !email.includes("@")) continue;

    const isComplaint = COMPLAINT.test(type);
    const isHard = HARD_BOUNCE.test(type);
    const isTransient = TRANSIENT.test(type);

    // allowlist 매칭 + 일시실패 아님 → 억제. 그 외(빈/미지/일시)는 quarantine.
    if ((isComplaint || isHard) && !isTransient) {
      await suppress(null, "email", email, isComplaint ? "complaint" : "bounce");
      suppressed += 1;
    } else {
      quarantined += 1;
      if (quarantineSamples.length < 20) {
        quarantineSamples.push({ type: type || "(빈값)", email: maskPII(email) });
      }
    }
  }

  logger.info("이메일 바운스 처리", { count: events.length, suppressed, quarantined });
  if (quarantined > 0) {
    // 미지/빈 이벤트는 전역 억제하지 않고 운영자 수동 검토용으로 남긴다.
    logger.warn("바운스 quarantine(미지·빈 type — 억제 안 함)", {
      source: "email-bounce",
      quarantined,
      samples: quarantineSamples,
    });
  }
  return successResponse({ received: events.length, suppressed, quarantined });
}
