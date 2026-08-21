"use client";

import { ExternalLink, Link2 } from "lucide-react";
import { useTranslations } from "next-intl";
import type { SocialEmbed } from "../community-data";
import { fmt } from "../detail-helpers";

const PLATFORM_CONFIG: Record<
  SocialEmbed["platform"],
  { name: string; iconClass: string }
> = {
  instagram: {
    name: "Instagram",
    iconClass:
      "bg-gradient-to-tr from-purple-500 via-pink-500 to-orange-400 text-white",
  },
  x: {
    name: "X",
    iconClass: "bg-black dark:bg-white text-white dark:text-black",
  },
  youtube: {
    name: "YouTube",
    iconClass: "bg-red-600 text-white",
  },
  tiktok: {
    name: "TikTok",
    iconClass: "bg-black text-white",
  },
};

const PLATFORM_ICON: Record<SocialEmbed["platform"], string> = {
  instagram: "IG",
  x: "X",
  youtube: "YT",
  tiktok: "TT",
};

export function SocialEmbedCard({ embed }: { embed: SocialEmbed }) {
  const t = useTranslations("event.socialEmbed");
  const platform = PLATFORM_CONFIG[embed.platform];

  return (
    <a
      href={embed.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-xl border border-border/60 overflow-hidden bg-background/50 transition-all duration-200 hover:shadow-md hover:-translate-y-0.5"
    >
      <div className="flex gap-0">
        {/* 썸네일 */}
        <div className="shrink-0 w-20 h-20 sm:w-24 sm:h-24">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={embed.thumbnail}
            alt=""
            className="w-full h-full object-cover"
          />
        </div>

        {/* 콘텐츠 */}
        <div className="flex-1 min-w-0 p-3 flex flex-col justify-between">
          <div>
            {/* 플랫폼 + 핸들 */}
            <div className="flex items-center gap-2 mb-1">
              <span
                className={`inline-flex items-center justify-center h-4 w-6 rounded text-2xs font-bold ${platform.iconClass}`}
              >
                {PLATFORM_ICON[embed.platform]}
              </span>
              <span className="text-xs-plus text-muted-foreground truncate">
                {embed.authorHandle}
              </span>
            </div>
            {/* 캡션 */}
            <p className="text-xs text-foreground/80 leading-relaxed line-clamp-2">
              {embed.caption}
            </p>
          </div>
          {/* 하단 */}
          <div className="flex items-center gap-3 mt-1.5">
            <span className="text-2xs text-muted-foreground">
              ❤️ {fmt(embed.likeCount)}
            </span>
            <span className="text-2xs text-muted-foreground">
              💬 {fmt(embed.commentCount)}
            </span>
            <span className="ml-auto flex items-center gap-1 text-2xs text-primary">
              {t("viewOriginal")}
              <ExternalLink className="h-2.5 w-2.5" />
            </span>
          </div>
        </div>
      </div>
    </a>
  );
}

/* ── 공유 버튼 그룹 (피드 아이템 공통) ── */
export function ShareMenu({
  onClose,
  itemId,
}: {
  onClose: () => void;
  itemId: string;
}) {
  const t = useTranslations("event.socialEmbed");
  const copyLink = () => {
    navigator.clipboard.writeText(
      `https://pickket.kr/events/evt-001#${itemId}`,
    );
    onClose();
  };

  return (
    <div className="absolute right-0 top-full mt-1 z-20 w-48 rounded-xl border border-white/5 bg-background shadow-sm p-1.5 space-y-0.5">
      <button
        onClick={onClose}
        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-foreground hover:bg-white/5 transition-colors"
      >
        <span className="text-base">📱</span>
        {t("instagramStory")}
      </button>
      <button
        onClick={onClose}
        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-foreground hover:bg-white/5 transition-colors"
      >
        <span className="text-base">🐦</span>{t("shareOnX")}
      </button>
      <button
        onClick={copyLink}
        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-foreground hover:bg-white/5 transition-colors"
      >
        <Link2 className="h-4 w-4 text-muted-foreground" />
        {t("copyLink")}
      </button>
    </div>
  );
}
