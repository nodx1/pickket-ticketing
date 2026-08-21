"use client";

// 🔴 발송 모듈(alimtalk)이 아니라 **순수 템플릿 모듈**을 import 한다.
//    발송 모듈은 node:crypto 를 끌고 오므로 클라이언트에서 import 하면 안 된다.
import { ALIMTALK_TEMPLATES } from "@/lib/notification/alimtalk-templates";

/**
 * 초대권 알림톡 **미리 보기** — 수신자가 실제로 받을 화면을 그대로 보여준다.
 *
 * 왜 필요한가: 주최자는 지금까지 "무엇이 나가는지" 를 보지 못한 채 발송했다.
 * 문구·행사 정보가 틀려도 발송 후에야 안다. 그리고 카카오 승인 템플릿은 본문이
 * **한 글자만 달라도** 전달이 거부되므로(실측 3027), 실제 나갈 문안을 그대로
 * 렌더해 눈으로 확인할 수 있어야 한다.
 *
 * ⚠️ 여기 쓰는 본문은 발송 코드가 쓰는 것과 **같은 템플릿 함수**다(하드코딩 금지).
 *    복붙하면 둘이 갈라지고, 미리보기가 거짓이 된다.
 */
export function InvitationPreview({
  eventTitle,
  eventDate,
  venueName,
  channelId,
}: {
  eventTitle: string;
  eventDate: string;
  venueName: string;
  channelId: string | null;
}) {
  const body = ALIMTALK_TEMPLATES.INVITATION_ISSUED.body({ eventTitle, eventDate, venueName });

  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold text-foreground">초대권 알림톡 미리 보기</p>

      {/* 휴대폰 목업 — 실제 카카오톡 말풍선 형태 */}
      <div className="mx-auto w-full max-w-[280px] rounded-[2rem] border-[6px] border-foreground/80 bg-[#b2c7d9] p-3">
        <div className="rounded-xl bg-white shadow-sm">
          <div className="flex items-center justify-between rounded-t-xl bg-[#FEE500] px-3 py-1.5">
            <span className="text-[11px] font-bold text-foreground/80">알림톡 도착</span>
            <span className="rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] font-semibold text-foreground/70">
              Kakao
            </span>
          </div>
          <pre className="whitespace-pre-wrap break-words px-3 py-3 text-[11px] leading-relaxed text-foreground">
            {body}
          </pre>
          <div className="border-t border-border px-3 py-2">
            <div className="rounded-md bg-muted px-3 py-1.5 text-center text-[11px] font-semibold text-foreground">
              모바일 티켓
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-center gap-2 text-xs">
        <span className="text-content-muted">발신 카카오톡 채널</span>
        <span className="rounded border border-border px-2 py-0.5 font-semibold text-foreground">
          {channelId ?? "미설정"}
        </span>
      </div>
    </div>
  );
}
