"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { formatKRW } from "@/lib/format";
import { shouldJoinQueue } from "@/lib/public/purchase-gate";
import {
  QUEUE_ADMISSION_EVENT,
  QUEUE_ADMISSION_PREFIX,
} from "./queue-purchase-gate";

interface StickyCTABarProps {
  /**
   * 대기열 사용 여부(v2 정본). 꺼져 있으면 처음부터 구매 가능 상태로 둔다 —
   * 상세 페이지가 대기열 왕복을 아예 하지 않으므로 여기서 기다리면 영원히 안 열린다.
   */
  queueEnabled: boolean;
  eventId?: string;
  eventSlug: string;
  minPrice: number;
  maxPrice: number;
  isSoldOut: boolean;
}

export function StickyCTABar({ queueEnabled,
  eventId, eventSlug, minPrice, maxPrice, isSoldOut }: StickyCTABarProps) {
  const [visible, setVisible] = useState(false);
  const [queueReady, setQueueReady] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        setVisible(!entry.isIntersecting);
      },
      { threshold: 0 },
    );

    const originalCTA = document.querySelector("[data-cta-original]");
    if (originalCTA) {
      observer.observe(originalCTA);
    }

    return () => observer.disconnect();
  }, []);

  // 🟡 `sessionStorage` 는 **서버에 존재하지 않는다.** 그래서 초기 state 로는 읽을 수 없고
  //    (lazy initializer 를 쓰면 SSR 에서 터지거나 hydration 불일치가 난다), 마운트 후
  //    한 번 읽어 반영하는 이 패턴이 SSR 앱에서 클라이언트 전용 상태를 다루는 정석이다.
  //    린트가 경고하는 "연쇄 렌더"는 여기선 **마운트당 추가 렌더 1회**로 끝난다(루프 아님).
  //    근본 해법은 `useSyncExternalStore`(서버 스냅샷 지원)지만, 이 컴포넌트는 이미
  //    prod 에서 돌고 있고 배포 직전에 동작을 바꿀 이유가 없다 — 대회 후 정리 대상.
    //
  //    ⚠️ 억제(disable)를 붙이는 이유: 이 1건을 남겨두면 `eslint src` 가 영영 0 이 되지
  //       않아 **새 에러가 기존 소음에 묻힌다**. 알려진 것은 근거와 함께 억제해
  //       "0 = 새 문제 없음" 이라는 신호를 되살린다.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    // `sessionStorage` 는 서버에 존재하지 않는다 — 초기 state 로 읽을 수 없고(lazy initializer 를
    // 쓰면 SSR hydration 불일치), 마운트 후 1회 반영이 SSR 앱에서 클라이언트 전용 상태를 다루는
    // 정석이다. 린트가 경고하는 "연쇄 렌더"도 여기선 마운트당 추가 렌더 1회로 끝나고 루프가 아니다.
    // 근본 해법은 `useSyncExternalStore`(서버 스냅샷 지원)지만 이 컴포넌트는 이미 prod 에서
    // 돌고 있어 판매 직전에 동작을 바꾸지 않는다 → 대회 후 정리 대상.
    // 🔴 대기열을 안 쓰면 기다리지 않는다. 상세 페이지가 join 을 부르지 않으므로
    //    sessionStorage 에도 admission 이 절대 안 생긴다 — 여기서 기다리면 영구 잠김이다.
    if (!eventId || !shouldJoinQueue({ queueEnabled, soldOut: isSoldOut })) {
      setQueueReady(true);
      return;
    }
    setQueueReady(
      sessionStorage.getItem(`${QUEUE_ADMISSION_PREFIX}${eventId}`) !== null,
    );
    const onAdmission = (event: Event) => {
      const detail = (event as CustomEvent<{ eventId: string }>).detail;
      if (detail?.eventId === eventId) setQueueReady(true);
    };
    window.addEventListener(QUEUE_ADMISSION_EVENT, onAdmission);
    return () => window.removeEventListener(QUEUE_ADMISSION_EVENT, onAdmission);
  }, [eventId, queueEnabled, isSoldOut]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!visible) return null;

  const priceLabel =
    minPrice === maxPrice
      ? minPrice === 0
        ? "무료"
        : formatKRW(minPrice)
      : `${formatKRW(minPrice)} ~ ${formatKRW(maxPrice)}`;

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-card/95 backdrop-blur-lg lg:hidden animate-slide-up-fade">
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">{priceLabel}</p>
        </div>
        <Button asChild={queueReady && !isSoldOut} disabled={isSoldOut || !queueReady} size="lg" className="shrink-0">
          {queueReady && !isSoldOut ? (
            <Link href={`/e/${eventSlug}/checkout`}>티켓 구매</Link>
          ) : (
            <span>{isSoldOut ? "매진" : "대기열 확인 중"}</span>
          )}
        </Button>
      </div>
    </div>
  );
}
