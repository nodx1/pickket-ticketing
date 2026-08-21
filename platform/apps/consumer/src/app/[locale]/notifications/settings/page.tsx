"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Bell, Smartphone, ArrowLeft, Megaphone, Sparkles } from "lucide-react";
import { Button } from "@pickket/ui";
import api from "@pickket/lib/api";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

interface NotifPrefs {
  allocation_result: boolean;
  payment_reminder: boolean;
  event_update: boolean;
  price_alert: boolean;
  marketing: boolean;
  email_enabled: boolean;
  sms_enabled: boolean;
  push_enabled: boolean;
  // Phase E: 능동 알림 (opt-in, 기본 OFF)
  location_based: boolean;
  price_watch: boolean;
  weekly_curation: boolean;
  friend_activity: boolean;
}


export default function NotificationSettingsPage() {
  const t = useTranslations("notifications.settings");
  const router = useRouter();
  const queryClient = useQueryClient();

  const PREF_SECTIONS = [
    {
      title: t("sectionType"),
      icon: Bell,
      items: [
        {
          key: "allocation_result",
          label: t("allocationResultLabel"),
          desc: t("allocationResultDesc"),
        },
        {
          key: "payment_reminder",
          label: t("paymentReminderLabel"),
          desc: t("paymentReminderDesc"),
        },
        {
          key: "event_update",
          label: t("eventUpdateLabel"),
          desc: t("eventUpdateDesc"),
        },
        {
          key: "price_alert",
          label: t("priceAlertLabel"),
          desc: t("priceAlertDesc"),
        },
      ],
    },
    {
      title: t("sectionChannel"),
      icon: Smartphone,
      items: [
        { key: "email_enabled", label: t("emailLabel"), desc: t("emailDesc") },
        { key: "sms_enabled", label: t("smsLabel"), desc: t("smsDesc") },
        { key: "push_enabled", label: t("pushLabel"), desc: t("pushDesc") },
      ],
    },
    {
      title: t("sectionMarketing"),
      icon: Megaphone,
      items: [
        {
          key: "marketing",
          label: t("marketingLabel"),
          desc: t("marketingDesc"),
        },
      ],
    },
    {
      title: t("sectionActive"),
      icon: Sparkles,
      items: [
        {
          key: "location_based",
          label: t("locationBasedLabel"),
          desc: t("locationBasedDesc"),
        },
        {
          key: "price_watch",
          label: t("priceWatchLabel"),
          desc: t("priceWatchDesc"),
        },
        {
          key: "weekly_curation",
          label: t("weeklyCurationLabel"),
          desc: t("weeklyCurationDesc"),
        },
        {
          key: "friend_activity",
          label: t("friendActivityLabel"),
          desc: t("friendActivityDesc"),
        },
      ],
    },
  ];

  const { data: prefs = null } = useQuery<NotifPrefs | null>({
    queryKey: ["notifications", "preferences"],
    queryFn: async () => {
      const res = await api.get("/notifications/preferences");
      return res.data;
    },
  });

  const [optimisticPrefs, setOptimisticPrefs] = useState<NotifPrefs | null>(
    null,
  );
  const displayPrefs = optimisticPrefs ?? prefs;

  const toggleMutation = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: boolean }) => {
      await api.put("/notifications/preferences", { [key]: value });
    },
    onMutate: ({ key, value }) => {
      if (displayPrefs) {
        setOptimisticPrefs({ ...displayPrefs, [key]: value } as NotifPrefs);
      }
    },
    onSuccess: () => {
      toast.success(t("saveSuccess"));
      queryClient.invalidateQueries({
        queryKey: ["notifications", "preferences"],
      });
      setOptimisticPrefs(null);
    },
    onError: () => {
      setOptimisticPrefs(null);
      toast.error(t("saveError"));
    },
  });

  const toggle = (key: string) => {
    if (!displayPrefs) return;
    const newVal = !displayPrefs[key as keyof NotifPrefs];
    toggleMutation.mutate({ key, value: newVal });
  };

  const saving = toggleMutation.isPending;

  if (!displayPrefs) {
    return (
      <div className="p-6 pt-20 space-y-4">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-14 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto px-4 pt-20 pb-6">
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-xl font-bold">{t("pageTitle")}</h1>
      </div>

      {PREF_SECTIONS.map((section, si) => (
        <motion.div
          key={section.title}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: si * 0.1 }}
          className="mb-6"
        >
          <div className="flex items-center gap-2 mb-3">
            <section.icon className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              {section.title}
            </h2>
          </div>
          <div className="border rounded-xl divide-y bg-card">
            {section.items.map((item) => (
              <div
                key={item.key}
                className="flex items-center justify-between p-4"
              >
                <div>
                  <p className="font-medium text-sm">{item.label}</p>
                  <p className="text-xs text-muted-foreground">{item.desc}</p>
                </div>
                <button
                  onClick={() => toggle(item.key)}
                  disabled={saving}
                  className={`relative w-11 h-6 rounded-full transition-colors ${
                    displayPrefs[item.key as keyof NotifPrefs]
                      ? "bg-primary"
                      : "bg-muted-foreground/30"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${
                      displayPrefs[item.key as keyof NotifPrefs]
                        ? "translate-x-5"
                        : ""
                    }`}
                  />
                </button>
              </div>
            ))}
          </div>
        </motion.div>
      ))}
    </div>
  );
}
