"use client";

import type { ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { PublicEventTab, PublicEventTabId } from "@/lib/public/event-tabs";

/**
 * 공개 상세의 정보 영역을 탭으로 묶는 **껍데기**.
 *
 * 정보구조(IA)는 consumer `EventInfoTabs` 를 흡수했지만, 렌더는 **기존 마크업을 그대로**
 * 패널에 담는다 — 데이터를 다시 넘겨 재구현하면 같은 화면을 두 번 만들게 되고 시각 회귀
 * 위험이 생긴다. 여기서는 어느 섹션이 어느 탭에 들어가는지만 정한다.
 *
 * 🔴 탭 판정은 `lib/public/event-tabs.ts::resolveEventTabs()` 순수 함수가 한다.
 *    서버 컴포넌트에 인라인 조건으로 두면 **테스트가 닿지 못한다** — 이 프로젝트에서
 *    매진 판정이 정확히 그래서, 판정을 정반대로 뒤집어도 전체 스위트가 통과한 전례가 있다.
 */
export interface EventDetailTabsProps {
  /** `resolveEventTabs()` 결과. 내용이 있는 탭만 들어온다(빈 탭 금지). */
  tabs: PublicEventTab[];
  /** 탭별 패널. 판정에서 빠진 탭의 노드는 렌더되지 않는다. */
  panels: Partial<Record<PublicEventTabId, ReactNode>>;
}

export function EventDetailTabs({ tabs, panels }: EventDetailTabsProps) {
  // 탭이 하나뿐이면 껍데기를 만들지 않는다 — 선택지 없는 탭 바는 클릭할 게 없는 장식이다.
  if (tabs.length <= 1) {
    return <div className="space-y-10">{tabs.map((t) => panels[t.id])}</div>;
  }

  return (
    <Tabs defaultValue={tabs[0]!.id}>
      {/*
        🔴 2026-07-31: 여기 주석은 원래 "스냅으로 붙인다" 였는데 **스냅 클래스가 없었다**.
           주석이 코드보다 앞서 있었던 것이다. 스크롤바까지 숨겨놔서 넘친다는 단서가 하나도
           없었고, 390px 기기에서 마지막 탭이 그냥 잘려 보였다(총폭 417 vs 바 폭 358).

        해법의 순서:
          1) **라벨을 짧게** — 애초에 안 넘치게 한다(`event-tabs.ts::TAB_LABELS`). 이게 본 해법.
          2) `min-w-0` — 공용 TabsTrigger 의 `min-w-24`(96px) 하한이 짧은 라벨까지 늘려
             넘침을 만들고 있었다. 여기서만 푼다(다른 화면의 탭 폭은 건드리지 않는다).
          3) 스냅 — 라벨이 늘거나 탭이 추가돼 그래도 넘칠 때의 **안전망**. 이제 실제로 붙는다.
      */}
      <TabsList className="max-w-full snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => (
          <TabsTrigger
            key={t.id}
            value={t.id}
            className="min-w-0 shrink-0 snap-start whitespace-nowrap px-3 sm:px-4"
          >
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>

      {tabs.map((t) => (
        // 🔴 `forceMount` + CSS 숨김 — Radix 기본은 비활성 탭을 **언마운트**한다.
        //    그러면 이벤트 소개·장소 안내 본문이 초기 HTML 에서 통째로 빠져 검색 노출을 잃는다.
        //    DOM 에는 전부 두고 표시만 감춘다.
        <TabsContent
          key={t.id}
          value={t.id}
          forceMount
          className="space-y-10 data-[state=inactive]:hidden"
        >
          {panels[t.id]}
        </TabsContent>
      ))}
    </Tabs>
  );
}
