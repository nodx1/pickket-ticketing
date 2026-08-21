"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  Bell,
  Trophy,
  Clock,
  Sparkles,
  Megaphone,
  ChevronRight,
  Inbox,
  CheckCheck,
} from "lucide-react";
import { Button } from "@pickket/ui";
import { useAuthStore } from "@pickket/store";
import { useAuthReady } from "@/providers/AuthProvider";
import {
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from "@pickket/lib/api";

interface Notification {
  id: string;
  type: "result" | "bidding_open" | "deadline" | "general";
  title: string;
  message: string;
  event_id?: string;
  is_read: boolean;
  created_at: string;
}

type TFunc = ReturnType<typeof useTranslations>;

function getRelativeTime(dateStr: string, t: TFunc): string {
  const now = new Date().getTime();
  const date = new Date(dateStr).getTime();
  const diff = now - date;

  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (minutes < 1) return t("notifications.justNow");
  if (minutes < 60) return t("notifications.minutesAgo", { minutes });
  if (hours < 24) return t("notifications.hoursAgo", { hours });
  if (days === 1) return t("notifications.yesterday");
  if (days < 7) return t("notifications.daysAgo", { days });
  if (days < 30) return t("notifications.weeksAgo", { weeks: Math.floor(days / 7) });
  return t("notifications.monthsAgo", { months: Math.floor(days / 30) });
}

function getDateGroup(dateStr: string, t: TFunc): string {
  const now = new Date();
  const date = new Date(dateStr);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dateDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = today.getTime() - dateDay.getTime();
  const daysDiff = diff / (1000 * 60 * 60 * 24);

  if (daysDiff === 0) return t("notifications.groupToday");
  if (daysDiff === 1) return t("notifications.groupYesterday");
  if (daysDiff < 7) return t("notifications.groupThisWeek");
  if (daysDiff < 30) return t("notifications.groupThisMonth");
  return t("notifications.groupPrevious");
}

function getNotificationIcon(type: string) {
  switch (type) {
    case "result":
      return <Trophy className="h-4 w-4 text-amber-500" />;
    case "bidding_open":
      return <Sparkles className="h-4 w-4 text-primary/70" />;
    case "deadline":
      return <Clock className="h-4 w-4 text-orange-500" />;
    case "general":
      return <Megaphone className="h-4 w-4 text-blue-500" />;
    default:
      return <Bell className="h-4 w-4 text-muted-foreground" />;
  }
}

function getNotificationIconBg(type: string) {
  switch (type) {
    case "result":
      return "bg-amber-100 dark:bg-amber-900/30";
    case "bidding_open":
      return "bg-primary/20";
    case "deadline":
      return "bg-orange-100 dark:bg-orange-900/30";
    case "general":
      return "bg-blue-100 dark:bg-blue-900/30";
    default:
      return "bg-white/5";
  }
}

function SkeletonNotifications() {
  return (
    <div className="max-w-7xl mx-auto space-y-4 px-8 pt-24 pb-5">
      <div className="h-10 bg-white/5 rounded-2xl animate-pulse w-48" />
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="h-20 bg-white/5 rounded-2xl animate-pulse" />
      ))}
    </div>
  );
}

export default function NotificationsPage() {
  const t = useTranslations();
  const { user } = useAuthStore();
  const ready = useAuthReady();
  const router = useRouter();

  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (ready && !user) {
      router.replace("/auth");
    }
  }, [ready, user, router]);

  const loadNotifications = useCallback(async () => {
    try {
      const res = await getNotifications();
      const data = res.data;
      setNotifications(
        Array.isArray(data) ? data : (data?.notifications ?? []),
      );
    } catch {
      // 비로그인 또는 네트워크 에러 — 토스트 없이 무시
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) {
      loadNotifications();
    }
  }, [user, loadNotifications]);

  // Poll for new notifications every 60 seconds
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(loadNotifications, 60000);
    return () => clearInterval(interval);
  }, [user, loadNotifications]);

  const handleNotificationClick = async (notification: Notification) => {
    // Mark as read before navigating
    if (!notification.is_read) {
      try {
        await markNotificationRead(notification.id);
        setNotifications((prev) =>
          prev.map((n) =>
            n.id === notification.id ? { ...n, is_read: true } : n,
          ),
        );
      } catch {
        // Silently fail — still navigate
      }
    }
    if (notification.event_id) {
      router.push(`/events/${notification.event_id}`);
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await markAllNotificationsRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
      toast.success(t("notifications.markAllReadSuccess"));
    } catch {
      toast.error(t("notifications.markAllReadError"));
    }
  };

  const grouped = useMemo(() => {
    const groups: Record<string, Notification[]> = {};
    for (const n of notifications) {
      const group = getDateGroup(n.created_at, t);
      if (!groups[group]) groups[group] = [];
      groups[group].push(n);
    }
    return groups;
  }, [notifications, t]);

  if (!user) return null;
  if (loading) return <SkeletonNotifications />;

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  return (
    <motion.div
      className="bg-background min-h-screen max-w-7xl mx-auto space-y-6 px-8 pt-24 pb-5"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Bell className="h-8 w-8 text-primary/70" />
            {t("notifications.title")}
          </h1>
          {unreadCount > 0 && (
            <p className="text-muted-foreground mt-1">
              {t.rich("notifications.unreadCount", {
                count: unreadCount ?? 0,
                strong: (chunks) => (
                  <strong className="text-primary/70">{chunks}</strong>
                ),
              })}
            </p>
          )}
        </div>
        {unreadCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="rounded-full gap-1.5 text-xs"
            onClick={handleMarkAllRead}
          >
            <CheckCheck className="h-3.5 w-3.5" />
            {t("notifications.markAllRead")}
          </Button>
        )}
      </div>

      {/* Notification List */}
      {notifications.length === 0 ? (
        <div className="rounded-2xl shadow-lg p-5 lg:p-6">
          <div className="text-center py-16 text-muted-foreground">
            <Inbox className="h-16 w-16 mx-auto mb-4 opacity-20" />
            <p className="text-lg font-medium mb-2">{t("notifications.emptyTitle")}</p>
            <p className="text-sm max-w-xs mx-auto">
              {t("notifications.emptyDescription")}
            </p>
            <Button
              variant="link"
              className="mt-4"
              onClick={() => router.push("/events")}
            >
              {t("notifications.browseEvents")} <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([groupLabel, items]) => (
            <div key={groupLabel}>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-1">
                {groupLabel}
              </h3>
              <div className="space-y-3">
                {items.map((notification, idx) => (
                  <motion.div
                    key={notification.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: idx * 0.03, duration: 0.2 }}
                  >
                    <div
                      className={`rounded-2xl shadow-lg ${
                        notification.event_id
                          ? "cursor-pointer hover:shadow-xl hover:-translate-y-1"
                          : ""
                      } transition-all duration-200 ${
                        !notification.is_read ? "bg-card" : "bg-card/80"
                      }`}
                      onClick={() => handleNotificationClick(notification)}
                    >
                      <div className="py-4 px-5">
                        <div className="flex items-start gap-3">
                          {/* Unread dot */}
                          <div className="flex flex-col items-center gap-1 shrink-0 mt-1">
                            {!notification.is_read && (
                              <span className="h-2 w-2 rounded-full bg-primary" />
                            )}
                            {notification.is_read && (
                              <span className="h-2 w-2 rounded-full bg-transparent" />
                            )}
                          </div>

                          {/* Icon badge */}
                          <div
                            className={`shrink-0 h-9 w-9 rounded-full flex items-center justify-center ${getNotificationIconBg(notification.type)}`}
                          >
                            {getNotificationIcon(notification.type)}
                          </div>

                          <div className="flex-1 min-w-0">
                            <h3
                              className={`text-sm truncate ${
                                !notification.is_read
                                  ? "font-semibold text-foreground"
                                  : "font-medium text-foreground/80"
                              }`}
                            >
                              {notification.title}
                            </h3>
                            <p
                              className={`text-sm ${
                                !notification.is_read
                                  ? "text-muted-foreground"
                                  : "text-muted-foreground/70"
                              }`}
                            >
                              {notification.message}
                            </p>
                            <p className="text-xs text-muted-foreground/60 mt-1.5">
                              {getRelativeTime(notification.created_at, t)}
                            </p>
                          </div>
                          {notification.event_id && (
                            <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0 mt-1" />
                          )}
                        </div>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </motion.div>
  );
}
