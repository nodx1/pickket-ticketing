"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  Calendar,
  MapPin,
  Users,
  Eye,
  Bell,
  Music,
  MessageSquare,
} from "lucide-react";
import { SubdomainShell } from "./SubdomainShell";

interface EventData {
  id: string;
  title: string;
  description?: string;
  event_date: string;
  event_date_end?: string;
  venue?: string;
  image_url?: string;
  status?: string;
  category?: string;
  bid_count?: number;
  view_count?: number;
  total_seats?: number;
  page_theme?: { logoUrl?: string } | null;
}

export function SubdomainArchiveClient({ event }: { event: EventData }) {
  const t = useTranslations("event.archive");
  const [notifyRequested, setNotifyRequested] = useState(false);

  const formattedDate = new Date(event.event_date).toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  });

  const stats = [
    {
      label: t("statTotalSeats"),
      value: event.total_seats?.toLocaleString() ?? "-",
      icon: Users,
    },
    {
      label: t("statViewCount"),
      value: event.view_count?.toLocaleString() ?? "-",
      icon: Eye,
    },
    {
      label: t("statBidCount"),
      value: event.bid_count?.toLocaleString() ?? "-",
      icon: MessageSquare,
    },
  ];

  return (
    <SubdomainShell event={event}>
      <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-8 space-y-8">
        {/* Archive banner */}
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-primary/20 to-background border border-white/10 p-6 sm:p-8">
          <div className="absolute top-4 right-4 px-3 py-1 rounded-full bg-white/10 text-xs font-medium text-muted-foreground">
            {t("badge")}
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground mb-4">
            {event.title}
          </h1>
          <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Calendar className="h-4 w-4" />
              {formattedDate}
            </span>
            {event.venue && (
              <span className="flex items-center gap-1.5">
                <MapPin className="h-4 w-4" />
                {event.venue}
              </span>
            )}
          </div>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-3 sm:gap-4">
          {stats.map((stat) => {
            const Icon = stat.icon;
            return (
              <div
                key={stat.label}
                className="rounded-xl bg-card border border-white/5 p-4 sm:p-5 text-center"
              >
                <Icon className="h-5 w-5 mx-auto mb-2 text-primary/70" />
                <p className="text-xl sm:text-2xl font-bold text-foreground">
                  {stat.value}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {stat.label}
                </p>
              </div>
            );
          })}
        </div>

        {/* Setlist placeholder */}
        <section className="rounded-xl bg-card border border-white/5 p-6">
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2 mb-4">
            <Music className="h-5 w-5 text-primary/70" />
            {t("setlistTitle")}
          </h2>
          <div className="text-sm text-muted-foreground text-center py-8">
            {t("setlistEmpty")}
          </div>
        </section>

        {/* Reviews placeholder */}
        <section className="rounded-xl bg-card border border-white/5 p-6">
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2 mb-4">
            <MessageSquare className="h-5 w-5 text-primary/70" />
            {t("reviewsTitle")}
          </h2>
          <div className="text-sm text-muted-foreground text-center py-8">
            {t("reviewsEmpty")}
          </div>
        </section>

        {/* Next event CTA */}
        <div className="text-center py-6">
          <button
            onClick={() => setNotifyRequested(true)}
            disabled={notifyRequested}
            className={`inline-flex items-center gap-2 px-6 py-3 rounded-full font-medium text-sm transition-all ${
              notifyRequested
                ? "bg-primary/30 text-primary/70 cursor-default"
                : "bg-primary text-white hover:bg-primary/80"
            }`}
          >
            <Bell className="h-4 w-4" />
            {notifyRequested ? t("notifyDone") : t("notifyRequest")}
          </button>
        </div>
      </div>
    </SubdomainShell>
  );
}
