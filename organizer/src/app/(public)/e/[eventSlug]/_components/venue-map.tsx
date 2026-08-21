"use client";

import { Bus, Car, Copy, MapPinned } from "lucide-react";
import type { DetailImageView } from "@/lib/public/detail-image";
import { DetailImageBox, DetailSectionCard } from "./detail-images";
import { Button } from "@/components/ui/button";
import { showSuccess } from "@/lib/hooks/useToast";

/**
 * 🔴 텍스트와 이미지를 **둘 다** 둔다 (2026-07-30 대표 지시 반영).
 *
 * 주최자가 만든 안내 이미지를 넣을 수 있게 하되, 텍스트를 대체하지 않는다 —
 * 이미지만 있으면 **검색엔진과 낭독기가 못 읽는다.** 대중교통 안내는 특히
 * 검색 유입이 있는 정보다. 둘 다 있으면 둘 다, 하나만 있으면 그것만.
 *
 * 아이콘·헤더(🚌 대중교통 안내)는 유지한다 — 이미지 안에 제목이 있어도,
 * 스크롤하며 눈으로 찾는 데는 헤더가 필요하다.
 */
interface VenueMapProps {
  venueName: string | null;
  venueAddress: string | null;
  transportInfo?: string | null;
  parkingInfo?: string | null;
  transportImages?: DetailImageView[];
  parkingImages?: DetailImageView[];
}

export function VenueMap({ venueName, venueAddress, transportInfo, parkingInfo, transportImages = [], parkingImages = [] }: VenueMapProps) {
  // 🔴 2026-07-28: 종전엔 `if (!venueAddress) return null` 로 **전체를 숨겼다**.
  //    그래서 주소를 안 넣고 주차·교통만 입력한 이벤트는 그 안내가 통째로 안 보였다.
  //    탭 구조 도입으로 더 나빠진다 — `hasVenueTab` 은 주차/교통만 있어도 탭을 여는데
  //    여기서 null 을 내면 **탭은 열리는데 안이 빈** 상태가 된다("빈 탭 금지" 위반).
  //    ⟹ 주소는 **있을 때만** 그리고, 교통·주차는 독립적으로 렌더한다.
  //       셋 다 없으면 그때만 아무것도 그리지 않는다(호출측 조건과 이중 방어).
  if (!venueAddress && !transportInfo && !parkingInfo && transportImages.length === 0 && parkingImages.length === 0) {
    return null;
  }

  return (
    <DetailSectionCard>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm uppercase tracking-[0.18em] text-primary">venue</p>
          <h3 className="mt-2 text-xl font-bold text-foreground">{venueName ?? "행사 장소"}</h3>
          {venueAddress ? (
            <p className="mt-2 text-sm text-muted-foreground">{venueAddress}</p>
          ) : null}
        </div>
        {/* 주소가 없으면 복사·지도 버튼은 의미가 없다(빈 문자열로 검색하게 된다). */}
        {venueAddress ? (
        <div className="flex flex-wrap gap-2 sm:shrink-0">
          <Button
            type="button"
            variant="outline"
            onClick={async () => {
              await navigator.clipboard.writeText(venueAddress);
              showSuccess("주소가 복사되었습니다");
            }}
          >
            <Copy className="size-4" />
            주소 복사
          </Button>
          <Button type="button" asChild variant="outline">
            <a
              href={`https://map.naver.com/p/search/${encodeURIComponent(venueAddress)}`}
              target="_blank"
              rel="noreferrer"
            >
              <MapPinned className="size-4" />
              네이버 지도에서 보기
            </a>
          </Button>
        </div>
        ) : null}
      </div>
      {/* 🔴 whitespace-pre-line — 주최자가 줄을 나눠 입력해도 종전엔 한 줄로 붙었다
          (2026-07-30 주최측 "주차 안내 박스에 내용 줄바꿈 필요").
          break-words 는 긴 URL·주소가 가로 스크롤을 만드는 것을 막는다. */}
      <DetailImageBox label="대중교통 안내" icon={<Bus className="size-4 text-primary" />} items={transportImages}>
        {transportInfo ? (
          <p className="mt-2 whitespace-pre-line break-words text-sm text-muted-foreground">{transportInfo}</p>
        ) : null}
      </DetailImageBox>
      <DetailImageBox label="주차 안내" icon={<Car className="size-4 text-primary" />} items={parkingImages}>
        {parkingInfo ? (
          <p className="mt-2 whitespace-pre-line break-words text-sm text-muted-foreground">{parkingInfo}</p>
        ) : null}
      </DetailImageBox>
    </DetailSectionCard>
  );
}
