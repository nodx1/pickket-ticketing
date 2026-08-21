"use client";

import Link from "next/link";
import { Bell } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { fetchWithAuth } from "@/lib/fetchWithAuth";

interface NotificationItem {
  id: string;
  eventId: string | null;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
}

function formatTimeAgo(value: string) {
  const diffMs = Date.now() - new Date(value).getTime();
  const diffMinutes = Math.max(Math.floor(diffMs / 60000), 0);
  if (diffMinutes < 1) return "방금 전";
  if (diffMinutes < 60) return `${diffMinutes}분 전`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}시간 전`;
  return `${Math.floor(diffHours / 24)}일 전`;
}

export function NotificationBell() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [count, setCount] = useState(0);
  const disabledRef = useRef(false);

  const load = useCallback(async () => {
    if (disabledRef.current) {
      return;
    }

    try {
      const [countPayload, listPayload] = await Promise.all([
        fetchWithAuth<{ success: boolean; data: { count: number } }>("/api/notifications/unread-count"),
        fetchWithAuth<{ success: boolean; data: NotificationItem[] }>("/api/notifications?limit=5"),
      ]);
      if (disabledRef.current) {
        return;
      }
      setCount(countPayload.data.count);
      setItems(listPayload.data);
    } catch {
      // 미인증 상태에서는 무시
    }
  }, []);

  useEffect(() => {
    disabledRef.current = false;
    const initialTimer = window.setTimeout(() => {
      void load();
    }, 0);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void load();
      }
    }, 30000);
    const handleLogout = () => {
      disabledRef.current = true;
      setCount(0);
      setItems([]);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void load();
      }
    };

    window.addEventListener("pickket:logout", handleLogout);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      disabledRef.current = true;
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
      window.removeEventListener("pickket:logout", handleLogout);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [load]);

  const unreadItems = useMemo(() => items.filter((item) => !item.isRead).length, [items]);

  async function markAllRead() {
    await fetchWithAuth("/api/notifications", { method: "PATCH" });
    await load();
  }

  async function markRead(id: string) {
    await fetchWithAuth(`/api/notifications/${id}`, { method: "PATCH" });
    await load();
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={count > 0 ? `알림 ${count}건 읽지 않음` : "알림"}
          className="relative flex size-10 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground transition hover:text-foreground"
        >
          <Bell className="size-4" />
          {count > 0 ? (
            <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-xs font-semibold text-foreground">
              {count > 99 ? "99+" : count}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[360px] p-0">
        <div className="border-b border-border px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-foreground">알림</p>
              <p className="mt-1 text-xs text-muted-foreground">읽지 않은 알림 {unreadItems}건</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => void markAllRead()}>
              전체 읽음
            </Button>
          </div>
        </div>

        <div className="max-h-[360px] overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">새 알림이 없습니다</div>
          ) : (
            items.map((item) => (
              <Link
                key={item.id}
                href={item.eventId ? `/events/${item.eventId}/dashboard` : "/notifications"}
                className="relative block border-b border-border px-4 py-4 transition hover:bg-muted/40"
                onClick={() => void markRead(item.id)}
              >
                {!item.isRead ? <span className="absolute bottom-3 left-0 top-3 w-1 rounded-r-full bg-primary" /> : null}
                <div className="pl-3">
                  <p className="text-sm font-semibold text-foreground">{item.title}</p>
                  <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">{item.message}</p>
                  <p className="mt-2 text-xs text-muted-foreground">{formatTimeAgo(item.createdAt)}</p>
                </div>
              </Link>
            ))
          )}
        </div>

        <div className="px-4 py-3">
          <Button asChild variant="outline" className="w-full">
            <Link href="/notifications">모든 알림 보기</Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
