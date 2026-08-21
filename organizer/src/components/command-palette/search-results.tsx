"use client";

import type { LucideIcon } from "lucide-react";
import { Calendar, CreditCard, UserCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { EVENT_STATUS_LABELS, ORDER_STATUS_LABELS } from "@/lib/constants";

interface SearchEvent {
  id: string;
  title: string;
  slug: string;
  status: string;
  startsAt: string;
}

interface SearchOrder {
  id: string;
  eventId: string;
  orderNumber: string;
  buyerName: string;
  buyerEmail: string;
  status: string;
}

interface SearchAttendee {
  id: string;
  eventId: string;
  ticketNumber: string;
  name: string;
  email: string;
  status: string;
}

interface SearchResultsProps {
  events: SearchEvent[];
  orders: SearchOrder[];
  attendees: SearchAttendee[];
  isLoading: boolean;
  onClose: () => void;
}

export function SearchResults({
  events,
  orders,
  attendees,
  isLoading,
  onClose,
}: SearchResultsProps) {
  const router = useRouter();
  const total = events.length + orders.length + attendees.length;

  function navigate(href: string) {
    onClose();
    router.push(href);
  }

  if (isLoading) {
    return (
      <div className="space-y-2 p-2">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={`search-skeleton-${index}`} className="h-12 animate-pulse rounded-lg bg-bg-muted" />
        ))}
      </div>
    );
  }

  if (total === 0) {
    return (
      <div className="px-4 py-8 text-center text-sm text-muted-foreground">
        검색 결과가 없습니다
      </div>
    );
  }

  return (
    <div className="space-y-4 p-2">
      {events.length > 0 ? (
        <ResultGroup label="이벤트">
          {events.map((event) => (
            <ResultItem
              key={event.id}
              icon={Calendar}
              title={event.title}
              subtitle={`@${event.slug}`}
              badge={EVENT_STATUS_LABELS[event.status as keyof typeof EVENT_STATUS_LABELS] ?? event.status}
              onClick={() => navigate(`/events/${event.id}/dashboard`)}
            />
          ))}
        </ResultGroup>
      ) : null}

      {orders.length > 0 ? (
        <ResultGroup label="주문">
          {orders.map((order) => (
            <ResultItem
              key={order.id}
              icon={CreditCard}
              title={order.orderNumber}
              subtitle={`${order.buyerName} · ${order.buyerEmail}`}
              badge={ORDER_STATUS_LABELS[order.status as keyof typeof ORDER_STATUS_LABELS] ?? order.status}
              onClick={() => navigate(`/events/${order.eventId}/orders`)}
            />
          ))}
        </ResultGroup>
      ) : null}

      {attendees.length > 0 ? (
        <ResultGroup label="참석자">
          {attendees.map((attendee) => (
            <ResultItem
              key={attendee.id}
              icon={UserCheck}
              title={attendee.name}
              subtitle={`${attendee.ticketNumber} · ${attendee.email}`}
              badge={attendee.status}
              onClick={() => navigate(`/events/${attendee.eventId}/attendees`)}
            />
          ))}
        </ResultGroup>
      ) : null}
    </div>
  );
}

function ResultGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function ResultItem({
  icon: Icon,
  title,
  subtitle,
  badge,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  badge: string;
  onClick: () => void;
}) {
  const badgeLabelMap: Record<string, string> = {
    live: "진행중",
    completed: "완료",
    pending: "대기",
    archived: "보관",
    refunded: "환불",
    checked_in: "체크인",
    registered: "등록",
  };

  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition hover:bg-bg-muted"
      onClick={onClick}
    >
      <div className="flex size-8 items-center justify-center rounded-xl bg-bg-subtle">
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-foreground">{title}</p>
        <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <span
        className={cn(
          "rounded-full px-2 py-0.5 text-xs font-medium",
          badge === "live" || badge === "completed" || badge === "checked_in"
            ? "bg-success/15 text-success"
            : badge === "pending"
              ? "bg-warning/15 text-warning"
              : "bg-bg-subtle text-muted-foreground",
        )}
      >
        {badgeLabelMap[badge] ?? badge}
      </span>
    </button>
  );
}
