/**
 * 완료 화면의 **행동 블록** — 주 행동 · 보조 · 캘린더.
 *
 * ## 🔴 왜 한 줄에 넣으면 안 되나 (2026-08-08, 대표 지적)
 * 종전엔 넷을 한 `flex flex-wrap` 줄에 넣었다:
 * ```
 * 주 버튼(192px 알약) · CalendarLinks · 길찾기 · 행사 페이지로
 * ```
 * `CalendarLinks` 는 버튼이 아니라 **라벨 줄 + 칩 3개 줄의 2단 블록**이다.
 * 그 높이가 줄을 키우고 칩이 폭을 먹어, 마지막 버튼이 **혼자 다음 줄**로 떨어져
 * 가운데 붕 떴다. 한 줄 안에 높이가 다른 것을 섞으면 그렇게 된다.
 *
 * ⟹ 층을 나눈다: **주 행동 → 보조 둘 → 캘린더(자기 줄)**.
 *
 * ## ⚠️ 페이지에서 분리한 이유
 * 정렬이 지적된 화면이라 **눈으로 볼 수 있어야** 한다. 페이지는 실주문이 있어야
 * 열리므로 그 안에 두면 확인할 방법이 배포뿐이다. 블록을 떼어 두면 고정 props 로
 * 렌더해 화면을 직접 본다.
 */
import Link from "next/link";
import { MapPin, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CalendarLinks } from "@/components/shared/calendar-links";
import type { CompletionCta } from "@/lib/checkout/completion-actions";
import { CopyAccountButton } from "./copy-account-button";

export interface CompletionActionsBlockProps {
  cta: CompletionCta;
  /** 입금 계좌번호. `cta.kind === "copy-account"` 일 때만 쓰인다. */
  bankAccount: string | null;
  /** 행사 페이지 경로. 모르면 그 버튼을 그리지 않는다. */
  eventHref: string | null;
  eventTitle: string;
  eventSlug: string;
  startsAt: string;
  endsAt: string;
  venueName: string | null;
  venueAddress: string | null;
}

export function CompletionActionsBlock({
  cta,
  bankAccount,
  eventHref,
  eventTitle,
  eventSlug,
  startsAt,
  endsAt,
  venueName,
  venueAddress,
}: CompletionActionsBlockProps) {
  return (
    <div className="space-y-4" data-testid="completion-actions">
      {/* ① 주 행동 — 자기 줄을 독차지한다. */}
      <div className="flex justify-center" data-testid="completion-primary">
        {cta.kind === "copy-account" && bankAccount ? (
          <CopyAccountButton account={bankAccount} label={cta.label} />
        ) : (
          <Button asChild className="min-w-48">
            {/* ⚠️ 폴백 경로도 인코딩된 것을 쓴다 — 이 대회 슬러그가 한글이다. */}
            <Link href={cta.href ?? eventHref ?? "/my-tickets"}>
              <Smartphone className="mr-2 size-4" />
              {cta.label}
            </Link>
          </Button>
        )}
      </div>

      {/* ② 보조 — 높이가 같은 버튼끼리만 한 줄에 둔다. */}
      <div className="flex flex-wrap justify-center gap-3" data-testid="completion-secondary">
        <Button variant="outline" asChild>
          <Link
            href={`https://map.naver.com/v5/search/${encodeURIComponent(eventTitle)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <MapPin className="mr-2 size-4" />
            길찾기
          </Link>
        </Button>
        {/* 🔴 행사로 돌아갈 길 (2026-08-01). 티켓·캘린더·길찾기는 있는데 정작
            **행사 페이지로 가는 링크가 없었다** — 일정이나 안내를 다시 보려면
            주소를 직접 쳐야 했다. */}
        {eventHref ? (
          <Button variant="outline" asChild>
            <Link href={eventHref}>행사 페이지로</Link>
          </Button>
        ) : null}
      </div>

      {/* ③ 캘린더는 2단 블록이라 자기 줄을 쓴다. */}
      <div
        className="flex justify-center border-t border-border pt-4"
        data-testid="completion-calendar"
      >
        <CalendarLinks
          title={eventTitle}
          startsAt={startsAt}
          endsAt={endsAt}
          venueName={venueName}
          venueAddress={venueAddress}
          eventSlug={eventSlug}
        />
      </div>
    </div>
  );
}
