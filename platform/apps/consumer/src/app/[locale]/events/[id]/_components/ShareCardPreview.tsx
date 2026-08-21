"use client";

import { useTranslations } from "next-intl";
import { fmt } from "../detail-helpers";

/**
 * 공유 카드 프리뷰 — 바텀시트에서 미리보기용
 * SNS 공유 시 자동 생성되는 OG 카드 이미지의 클라이언트 프리뷰.
 */
export function ShareCardPreview({
  userComment,
  userName,
  eventTitle,
  eventDate,
  venue,
  eventId,
  participantCount,
}: {
  userComment?: string;
  userName?: string;
  eventTitle: string;
  eventDate: string;
  venue: string;
  eventId: string;
  participantCount: number;
}) {
  const t = useTranslations("event.shareCardPreview");
  return (
    <div
      className="rounded-xl overflow-hidden text-white mx-auto max-w-[280px] shadow-lg"
      style={{
        background:
          "linear-gradient(135deg, #0a0a0a 0%, #404040 60%, #7C3AED 100%)",
      }}
    >
      <div className="p-4 space-y-3">
        {/* 브랜드 */}
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold tracking-tight">Pickket</span>
          <span className="text-2xs text-white/50">{t("brandTagline")}</span>
        </div>

        {/* 이벤트명 */}
        <div>
          <p className="text-sm font-bold leading-tight">{eventTitle}</p>
          <p className="text-xs-plus text-white/60 mt-0.5">
            {eventDate} · {venue}
          </p>
        </div>

        {/* 유저 코멘트 (있으면) */}
        {userComment && (
          <div className="bg-white/10 rounded-lg px-3 py-2 backdrop-blur-sm">
            <p className="text-xs text-white/90 leading-relaxed line-clamp-2">
              &ldquo;{userComment}&rdquo;
            </p>
            {userName && (
              <p className="text-2xs text-white/50 mt-1">— @{userName}</p>
            )}
          </div>
        )}

        {/* 수치 */}
        <div className="flex items-center gap-3 text-xs-plus">
          <span className="bg-white/15 px-2 py-0.5 rounded-full">{t("expectation")}</span>
          <span className="bg-white/15 px-2 py-0.5 rounded-full">
            {t("participantCount", { count: participantCount ?? 0, formatted: fmt(participantCount ?? 0) })}
          </span>
        </div>

        {/* 딥링크 */}
        <p className="text-2xs text-white/40">pickket.kr/events/{eventId}</p>
      </div>
    </div>
  );
}
