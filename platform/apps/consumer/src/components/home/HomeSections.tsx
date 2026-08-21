"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  Bell,
  ChevronRight,
  Clock,
  Compass,
  Gift,
  Heart,
  Home,
  Sparkles,
  Star,
  ThumbsUp,
  Ticket,
  TrendingUp,
  User,
  Users,
  X,
  Zap,
} from "lucide-react";
import { useTranslations } from "next-intl";

import {
  EventItem,
  fmt,
  OpenNotice,
  RankingItem,
} from "@/components/home/types";

export function QuickMenu() {
  const t = useTranslations("home.quick_menu");
  const items = [
    { icon: Ticket, labelKey: "booking" as const, color: "text-primary" },
    { icon: Sparkles, labelKey: "lottery" as const, color: "text-purple-500" },
    { icon: Gift, labelKey: "coupon" as const, color: "text-destructive" },
    { icon: Zap, labelKey: "ap_balance" as const, color: "text-cyan" },
    { icon: Heart, labelKey: "favorites" as const, color: "text-red-400" },
    { icon: TrendingUp, labelKey: "ranking" as const, color: "text-amber-500" },
  ];

  return (
    <div className="flex items-center justify-between">
      {items.map((item) => (
        <button
          key={item.labelKey}
          className="flex flex-col items-center gap-0.5 py-1 px-1 rounded-lg hover:bg-muted/50 transition-colors min-w-0 flex-1 basis-0"
        >
          <div
            className={`w-9 h-9 rounded-xl bg-muted/80 flex items-center justify-center ${item.color}`}
          >
            <item.icon className="h-4 w-4" />
          </div>
          <span className="text-2xs font-medium text-muted-foreground whitespace-nowrap">
            {t(item.labelKey)}
          </span>
        </button>
      ))}
    </div>
  );
}

export function SocialProofV2() {
  const t = useTranslations("home.social_proof");
  const items: {
    icon?: React.ComponentType<{ className?: string }>;
    iconSrc?: string;
    value: string;
    label: string;
    desc: string;
    color: string;
    glowColor?: string;
  }[] = [
    {
      icon: Ticket,
      value: t("sale_modes_value"),
      label: t("sale_modes_label"),
      desc: t("sale_modes_desc"),
      color: "from-primary to-brand-lighter",
    },
    {
      iconSrc: "/icons/trust/price-guarantee.svg",
      value: t("ap_uses_value"),
      label: t("ap_uses_label"),
      desc: t("ap_uses_desc"),
      color: "from-cyan to-[#00A88E]",
      glowColor: "rgba(0,210,160,0.12)",
    },
    {
      icon: Gift,
      value: t("ap_earn_value"),
      label: t("ap_earn_label"),
      desc: t("ap_earn_desc"),
      color: "from-purple-500 to-fuchsia-500",
    },
    {
      iconSrc: "/icons/trust/fair-distribution.svg",
      value: t("transparency_value"),
      label: t("transparency_label"),
      desc: t("transparency_desc"),
      color: "from-amber-500 to-orange-500",
      glowColor: "rgba(245,158,11,0.12)",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-2xl bg-card border border-border p-4 text-center hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200"
        >
          <div
            className={`w-10 h-10 rounded-xl bg-gradient-to-br ${item.color} flex items-center justify-center mx-auto mb-2.5`}
            style={
              item.glowColor
                ? { boxShadow: `0 0 12px ${item.glowColor}` }
                : undefined
            }
          >
            {item.iconSrc ? (
              <Image
                src={item.iconSrc}
                alt={item.label}
                width={20}
                height={20}
                className="brightness-0 invert"
              />
            ) : item.icon ? (
              <item.icon className="h-5 w-5 text-white" />
            ) : null}
          </div>
          <div className="text-lg font-extrabold text-foreground leading-tight">
            {item.value}
          </div>
          <div className="text-xs-plus font-semibold text-foreground/70 mt-0.5">
            {item.label}
          </div>
          <div className="text-2xs text-muted-foreground mt-1 leading-snug">
            {item.desc}
          </div>
        </div>
      ))}
    </div>
  );
}

export function OpenNoticeItem({ notice }: { notice: OpenNotice }) {
  const t = useTranslations("home.open_notice");
  const isToday = notice.dDay === "Today";

  return (
    <Link
      href={`/events/${notice.id}`}
      className={`flex items-center gap-3 p-3 rounded-xl border transition-all hover:shadow-md cursor-pointer ${
        isToday ? "border-primary/30 bg-primary/5" : "border-border"
      }`}
    >
      <div
        className={`shrink-0 w-11 h-11 rounded-lg flex items-center justify-center font-extrabold text-xs ${
          isToday
            ? "bg-primary text-white animate-pulse"
            : "bg-muted text-primary"
        }`}
      >
        {notice.dDay}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="text-sm-minus font-bold text-foreground truncate">
            {notice.title}
          </h3>
          {notice.exclusive && (
            <span className="shrink-0 px-1.5 py-0.5 rounded text-2xs font-bold bg-cyan/10 text-cyan">
              {t("exclusive_badge")}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          {t("open_prefix")} {notice.date}
        </p>
      </div>
      <button
        onClick={(event) => event.preventDefault()}
        aria-label={t("alert_btn_aria")}
        className="shrink-0 w-8 h-8 rounded-full border border-border flex items-center justify-center text-muted-foreground hover:bg-primary hover:text-white hover:border-primary transition-all"
      >
        <Bell className="h-3.5 w-3.5" />
      </button>
    </Link>
  );
}

export function RankItem({ item }: { item: RankingItem }) {
  const medalColors = ["", "text-amber-400", "text-gray-400", "text-amber-700"];

  return (
    <div className="flex items-center gap-4 px-4 py-2.5 hover:bg-muted/50 transition-colors cursor-pointer group">
      <div
        className={`w-7 text-center text-base font-black tabular-nums ${
          item.rank <= 3 ? medalColors[item.rank] : "text-muted-foreground"
        }`}
      >
        {item.rank}
      </div>
      <div className="w-10 text-center">
        {item.change === "new" && (
          <span className="px-1.5 py-0.5 rounded text-2xs font-bold bg-red-500/10 text-red-500">
            NEW
          </span>
        )}
        {item.change === "up" && (
          <span className="text-xs text-red-500 font-bold">
            ▲{item.changeVal}
          </span>
        )}
        {item.change === "down" && (
          <span className="text-xs text-blue-500 font-bold">
            ▼{item.changeVal}
          </span>
        )}
        {item.change === "same" && (
          <span className="text-xs text-muted-foreground">-</span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-semibold text-foreground truncate group-hover:text-primary transition-colors">
          {item.title}
        </h3>
      </div>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <Users className="h-3 w-3" />
        <span className="tabular-nums">{fmt(item.bidders)}</span>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
    </div>
  );
}

export function ReviewSection() {
  const t = useTranslations("home.review");
  const reviews = [
    {
      user: "티켓마니아",
      rating: 5,
      text: "역대급 세트리스트! 앵콜 3곡이 미쳤어요",
      date: "2일 전",
      helpful: 42,
    },
    {
      user: "공연중독자",
      rating: 5,
      text: "사운드 퀄리티가 정말 좋았습니다. 고척돔 음향 최고",
      date: "3일 전",
      helpful: 28,
    },
    {
      user: "첫관람",
      rating: 4,
      text: "첫 콘서트였는데 분위기가 너무 좋았어요!",
      date: "5일 전",
      helpful: 15,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
          <Star className="h-5 w-5 text-amber-400" /> {t("title")}
          <span className="text-sm font-normal text-muted-foreground">
            (342)
          </span>
        </h2>
        <button className="text-xs text-primary font-medium hover:underline inline-flex items-center gap-1 min-h-[24px]">
          {t("view_all")} <ChevronRight className="h-3 w-3" />
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {reviews.map((review) => (
          <div
            key={`${review.user}-${review.date}`}
            className="p-3 rounded-xl border border-border hover:shadow-md transition-shadow"
          >
            <div className="flex items-center gap-2 mb-1.5">
              <div className="flex items-center gap-0.5">
                {[1, 2, 3, 4, 5].map((star) => (
                  <Star
                    key={star}
                    className={`h-3 w-3 ${
                      star <= review.rating
                        ? "fill-amber-400 text-amber-400"
                        : "text-muted-foreground/30"
                    }`}
                  />
                ))}
              </div>
              <span className="text-xs font-semibold text-foreground">
                {review.user}
              </span>
              <span className="text-2xs text-muted-foreground ml-auto">
                {review.date}
              </span>
            </div>
            <p className="text-sm text-foreground/80 line-clamp-2">
              {review.text}
            </p>
            <div className="mt-1.5 flex items-center gap-1 text-xs-plus text-muted-foreground">
              <ThumbsUp className="h-3 w-3" /> {t("helpful")} {review.helpful}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function RecentlyViewed({ events }: { events: EventItem[] }) {
  const t = useTranslations("home.recently_viewed");
  const items = events.slice(0, 6);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
          <Clock className="h-5 w-5 text-muted-foreground" /> {t("title")}
        </h2>
        <button className="text-xs text-primary font-medium hover:underline inline-flex items-center gap-1 min-h-[24px]">
          {t("view_all")} <ChevronRight className="h-3 w-3" />
        </button>
      </div>
      <div className="overflow-x-auto scrollbar-hide -mx-6 px-6">
        <div className="flex gap-3 min-w-max">
          {items.map((item) => (
            <Link
              key={item.id}
              href={`/events/${item.id}`}
              className="w-[130px] shrink-0 group cursor-pointer"
            >
              <div className="relative aspect-[3/4] rounded-xl overflow-hidden mb-1.5 bg-muted">
                <Image
                  src={item.posterImg}
                  alt={item.title}
                  fill
                  sizes="130px"
                  className="object-cover group-hover:scale-105 transition-transform duration-300"
                />
              </div>
              <h3 className="text-xs font-semibold text-foreground truncate group-hover:text-primary transition-colors">
                {item.title}
              </h3>
              <p className="text-xs font-bold text-primary tabular-nums mt-0.5">
                {fmt(item.price)}원
              </p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

interface StickyCTAProps {
  position?: "top" | "bottom";
}

export function StickyCTA({ position = "bottom" }: StickyCTAProps) {
  const t = useTranslations("home.sticky_cta");
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  const positionClasses =
    position === "top"
      ? "fixed top-0 left-0 right-0 border-b shadow-[0_4px_24px_rgba(0,0,0,0.12)]"
      : "fixed bottom-14 md:bottom-0 left-0 right-0 border-t shadow-[0_-4px_24px_rgba(0,0,0,0.12)]";

  return (
    <div
      className={`${positionClasses} z-50 bg-card/95 backdrop-blur-xl border-border`}
    >
      <div className="max-w-[1100px] mx-auto px-6 py-3 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-foreground truncate">
            SEVENTEEN WORLD TOUR [FOLLOW] AGAIN
          </h3>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-lg font-extrabold text-primary tabular-nums">
              154,000원
            </span>
            <span className="text-xs text-muted-foreground line-through">
              176,000원
            </span>
            <span className="text-xs font-bold text-destructive">-12%</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button className="px-8 py-3 rounded-full bg-gradient-to-r from-primary to-brand-lighter text-white font-bold text-sm shadow-lg hover:shadow-xl hover:scale-[1.02] transition-all">
            {t("apply")}
          </button>
          <button
            onClick={() => setDismissed(true)}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-muted/80 transition-colors text-muted-foreground hover:text-foreground"
            aria-label={t("close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

export function MobileBottomTabBar() {
  const t = useTranslations("home.mobile_tabs");
  const [activeTab, setActiveTab] = useState("home");
  const tabs = [
    { key: "home", icon: Home, labelKey: "home" as const },
    { key: "explore", icon: Compass, labelKey: "explore" as const },
    { key: "ticket", icon: Ticket, labelKey: "ticket" as const },
    { key: "my", icon: User, labelKey: "my" as const },
  ];

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 md:hidden bg-card/95 backdrop-blur-xl border-t border-border safe-area-bottom">
      <div className="flex items-center justify-around py-2">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex flex-col items-center gap-0.5 py-1 px-5 rounded-xl transition-all ${
              activeTab === tab.key ? "text-primary" : "text-muted-foreground"
            }`}
          >
            <tab.icon
              className={`h-5 w-5 ${
                activeTab === tab.key ? "stroke-[2.5]" : ""
              }`}
            />
            <span className="text-2xs font-medium">{t(tab.labelKey)}</span>
            {activeTab === tab.key && (
              <div className="w-1 h-1 rounded-full bg-primary" />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
