"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { CollapsibleSidebarGroup } from "@/components/layout/collapsible-sidebar-group";
import { pinnedItem, visibleGroupsFor } from "@/components/layout/event-sidebar-groups";
import { StatusBadge } from "@/components/shared/status-badge";
import { useUIPreferences } from "@/lib/stores/uiPreferencesStore";
import type { EventStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

interface EventSidebarProps {
  event: {
    id: string;
    title: string;
    slug: string;
    status: EventStatus;
    enabledFeatures?: string[];
    /** 이벤트에 공정 추첨/팬클럽 등 lottery 계열 sale_phase 가 하나라도 있는지. */
    hasLotteryPhase?: boolean;
    /** F4 경품 추첨(raffle) 활성화 여부. 추첨 실행 화면 노출 게이트. */
    raffleEnabled?: boolean;
  };
}


export function EventSidebar({ event }: EventSidebarProps) {
  const pathname = usePathname();
  const { collapsedGroups, toggleGroup, hydrate } = useUIPreferences();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const visibleGroups = visibleGroupsFor(event);


  return (
    <aside className="w-full max-w-[280px] rounded-xl border border-border bg-sidebar p-5">
      <div className="space-y-4 rounded-lg border border-border-subtle bg-bg-muted p-4">
        <StatusBadge status={event.status} />
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-primary">event</p>
          <h2 className="mt-2 text-xl font-black tracking-[-0.04em] text-foreground">{event.title}</h2>
          <p className="mt-2 text-sm text-content-subtle">@{event.slug}</p>
        </div>
        {/* 🔴 새 탭으로 연다 (2026-07-31 대표 지적).
            같은 탭이면 편집 화면을 떠났다가 뒤로가기로 돌아오는데, 그때 서버 렌더가
            다시 돌지 않아 **만료된 세션인데 화면은 멀쩡한** 상태가 된다.
            미리보기는 확인이지 이탈이 아니다 — 편집 화면을 그대로 두는 게 맞다.
            ⚠️ 이건 완화지 수정이 아니다. 근본 원인(5분 만료 + 갱신 미배선)은
               `fetchWithRefresh` 배선이 담당한다. */}
        <Button asChild className="w-full">
          <Link href={`/e/${event.slug}`} target="_blank" rel="noopener noreferrer">
            이벤트 페이지 미리보기
          </Link>
        </Button>
      </div>

      <div className="mt-6 space-y-6">
        {/* 진입 항목 — 그룹 밖 고정. `/events/{id}` 의 redirect 목적지라 항상 최상단에 둔다. */}
        {(() => {
          const href = `/events/${event.id}/${pinnedItem.href}`;
          const active = pathname === href;
          const Icon = pinnedItem.icon;
          return (
            <Link
              href={href}
              {...(active ? { "aria-current": "page" as const } : {})}
              className={cn(
                "flex items-center gap-3 rounded-lg px-4 py-3 text-sm font-medium transition",
                active
                  ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20"
                  : "text-content-subtle hover:bg-bg-emphasis hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
              {pinnedItem.label}
            </Link>
          );
        })()}


        {visibleGroups.map((group) => (
          <CollapsibleSidebarGroup
            key={group.id}
            label={group.label}
            // 접힘 키는 라벨이 아니라 **id** — 라벨을 바꿔도 사용자의 접힘이 보존된다.
            isCollapsed={collapsedGroups.has(group.id)}
            onToggle={() => toggleGroup(group.id)}
          >
            {group.items.map((item) => {
              const Icon = item.icon;
              const href = item.disabled ? "#" : `/events/${event.id}/${item.href}`;
              const active = !item.disabled && pathname === href;

              if (item.disabled) {
                return (
                  <div
                    key={`${group.label}-${item.label}`}
                    className="flex items-center gap-3 rounded-lg px-4 py-3 text-sm text-content-muted"
                  >
                    <Icon className="size-4" />
                    {item.label}
                  </div>
                );
              }

              return (
                <Link
                  key={`${group.label}-${item.label}`}
                  href={href}
                  {...("tutorialId" in item && item.tutorialId ? { "data-tutorial": item.tutorialId } : {})}
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-4 py-3 text-sm transition",
                    active
                      ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20"
                      : "text-content-subtle hover:bg-bg-emphasis hover:text-foreground",
                  )}
                >
                  <Icon className="size-4" />
                  {item.label}
                </Link>
              );
            })}
          </CollapsibleSidebarGroup>
        ))}
      </div>
    </aside>
  );
}
