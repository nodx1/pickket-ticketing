"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, ExternalLink, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CollapsibleSidebarGroup } from "@/components/layout/collapsible-sidebar-group";
import { pinnedItem, visibleGroupsFor } from "@/components/layout/event-sidebar-groups";
import { StatusBadge } from "@/components/shared/status-badge";
import { marketViewState } from "@/lib/public/lottery-cta";
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
    /** 판매 채널. marketplace 가 켜져 있고 승인되면 「피켓에서 보기」가 피켓 이벤트 화면을 연다. */
    saleChannels?: string[];
  };
}


export function EventSidebar({ event }: EventSidebarProps) {
  const pathname = usePathname();
  const { collapsedGroups, toggleGroup, hydrate } = useUIPreferences();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const visibleGroups = visibleGroupsFor(event);
  const market = marketViewState(event);
  // 🔴 1280px 미만(태블릿·모바일)에서는 메뉴 40여 개가 본문 위에 통째로 쌓였다(UI 감사 P0-3).
  //    좁은 화면은 '현재 화면 + 메뉴 버튼' 한 줄로 접고, 누르면 펼친다. 화면을 옮기면 다시 접힌다
  //    (열린 경로를 기억해 비교 — 이펙트로 닫지 않는다).
  const [openPath, setOpenPath] = useState<string | null>(null);
  const menuOpen = openPath === pathname;
  const currentLabel =
    visibleGroups.flatMap((g) => g.items).find((item) => pathname === `/events/${event.id}/${item.href}`)?.label ??
    (pathname === `/events/${event.id}/${pinnedItem.href}` ? pinnedItem.label : "이벤트 메뉴");

  return (
    <aside className="w-full rounded-xl border border-border bg-sidebar p-3 xl:max-w-[280px] xl:p-5">
      <button
        type="button"
        onClick={() => setOpenPath(menuOpen ? null : pathname)}
        aria-expanded={menuOpen}
        aria-controls="event-sidebar-menu"
        className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left xl:hidden"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Menu className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs text-content-subtle">{event.title}</span>
          <span className="block truncate text-sm font-bold text-foreground">{currentLabel}</span>
        </span>
        <ChevronDown className={cn("size-4 text-content-subtle transition", menuOpen && "rotate-180")} />
      </button>
      <div id="event-sidebar-menu" className={cn(menuOpen ? "mt-3 block" : "hidden", "xl:mt-0 xl:block")}>
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
        {/* 피켓 마켓에 올린 이벤트는 팬이 실제로 보는 피켓 화면이 「진짜 이벤트 화면」이다.
            승인 전에는 피켓에 아직 없으므로 링크 대신 안내만 둔다. 피켓고 자체 페이지는 보조 버튼. */}
        {market.kind === "live" ? (
          <Button asChild className="w-full">
            <a href={market.url} target="_blank" rel="noopener noreferrer">
              피켓에서 보기
              <ExternalLink className="size-4" aria-hidden />
            </a>
          </Button>
        ) : market.kind === "pending" ? (
          <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs leading-relaxed text-content-subtle">
            피켓 마켓에 올릴 이벤트예요. 게시 준비에서 심사를 요청하고 관리자가 승인하면 피켓에 공개돼요.
          </p>
        ) : null}
        <Button asChild variant={market.kind === "live" ? "outline" : "default"} className="w-full">
          <Link href={`/e/${event.slug}`} target="_blank" rel="noopener noreferrer">
            {market.kind === "off" ? "이벤트 페이지 미리보기" : "피켓고 페이지 미리보기"}
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
      </div>
    </aside>
  );
}
