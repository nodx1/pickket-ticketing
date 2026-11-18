"use client";

import { MapPin, CalendarDays, Ticket } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * 자유 입장(좌석 배치도 없음) 행사의 왼쪽 패널.
 * 배치도 영역을 그대로 두면 「STAGE」 표시와 확대 버튼만 있는 빈 화면이 되어, 대신 행사 요약과
 * 「좌석 없이 입장」 안내를 보여 준다.
 */
export default function GeneralAdmissionPanel({
  title,
  venue,
  dateText,
  imageUrl,
}: {
  title: string;
  venue?: string | null;
  dateText?: string | null;
  imageUrl?: string | null;
}) {
  const t = useTranslations("booking.generalAdmission");
  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-muted/30 p-6 lg:p-10">
      <div className="mx-auto max-w-xl rounded-2xl border border-border bg-background overflow-hidden">
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt="" className="w-full aspect-[16/9] object-cover" />
        ) : null}
        <div className="p-6">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-bold text-foreground">
            <Ticket className="h-3.5 w-3.5" />
            {t("badge")}
          </div>
          <h2 className="mt-3 text-xl font-bold tracking-tight text-foreground">{title}</h2>
          <dl className="mt-4 space-y-2 text-sm text-muted-foreground">
            {dateText ? (
              <div className="flex items-center gap-2">
                <CalendarDays className="h-4 w-4" />
                <dd>{dateText}</dd>
              </div>
            ) : null}
            {venue ? (
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4" />
                <dd>{venue}</dd>
              </div>
            ) : null}
          </dl>
          <p className="mt-5 rounded-xl bg-muted/60 p-4 text-sm leading-relaxed text-foreground">{t("body")}</p>
        </div>
      </div>
    </div>
  );
}
