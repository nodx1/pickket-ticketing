"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { Pin, Heart, MessageCircle, Eye, Share2 } from "lucide-react";
import type { UnifiedFeedItem } from "../community-data";
import { fmt } from "../detail-helpers";
import { RoleBadge } from "./RoleBadge";
import { SocialEmbedCard } from "./SocialEmbedCard";

const ACCENT_BORDER: Record<string, string> = {
  announcement: "border-l-blue-500",
  update: "border-l-amber-500",
  event_promotion: "border-l-primary",
};

const TYPE_LABEL_CLASS: Record<string, string> = {
  announcement:
    "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  update:
    "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  event_promotion: "bg-primary/10 text-primary/70",
};

export function OrganizerPost({
  item,
  onShare,
}: {
  item: UnifiedFeedItem;
  onShare?: (id: string) => void;
}) {
  const t = useTranslations("event.organizerPost");
  const [liked, setLiked] = useState(false);
  const accent = ACCENT_BORDER[item.postType ?? "announcement"];
  const likeCount = item.likes + (liked ? 1 : 0);

  return (
    <div
      className={`rounded-2xl border border-blue-200 dark:border-blue-800/50 bg-blue-50/50 dark:bg-blue-950/20 border-l-4 ${accent} p-4 space-y-3`}
    >
      {/* 헤더 */}
      <div className="flex items-center gap-2.5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.avatar}
          alt=""
          className="h-9 w-9 rounded-full object-cover"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground truncate">
              {item.user}
            </span>
            <RoleBadge role="organizer" />
          </div>
          <div className="flex items-center gap-2 text-xs-plus text-muted-foreground">
            <span>{item.createdAt}</span>
            {item.postType && (
              <span
                className={`px-1.5 py-0.5 rounded text-2xs font-medium ${TYPE_LABEL_CLASS[item.postType]}`}
              >
                {t(`typeLabel.${item.postType}`)}
              </span>
            )}
          </div>
        </div>
        {item.pinned && (
          <span
            className="group relative flex items-center gap-1 text-xs-plus text-muted-foreground cursor-default"
            title={t("pinnedTitle")}
          >
            <Pin className="h-3 w-3 rotate-12" />
            <span className="group-hover:underline">{t("pinnedLabel")}</span>
          </span>
        )}
      </div>

      {/* "~가 메시지를 보냈습니다" 알림 톤 (핀 포스트만) */}
      {item.pinned && (
        <p className="text-xs-plus text-blue-600 dark:text-blue-400 font-medium -mt-1">
          {t("sentMessage", { user: item.user ?? "" })}
        </p>
      )}

      {/* 본문 */}
      <p className="text-sm text-foreground/85 leading-relaxed">{item.text}</p>

      {/* 이미지 */}
      {item.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.image}
          alt=""
          className="w-full rounded-xl aspect-[2/1] object-cover"
        />
      )}

      {/* SNS 임베드 */}
      {item.socialEmbed && <SocialEmbedCard embed={item.socialEmbed} />}

      {/* 액션 — 터치 타겟 44px */}
      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={() => setLiked(!liked)}
          className={`flex items-center gap-1.5 text-xs transition-colors min-h-[44px] min-w-[44px] justify-center ${
            liked
              ? "text-red-500"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <motion.span
            animate={liked ? { scale: [1, 1.3, 1] } : { scale: 1 }}
            transition={{ duration: 0.3 }}
          >
            <Heart className={`h-4 w-4 ${liked ? "fill-red-500" : ""}`} />
          </motion.span>
          <motion.span
            key={likeCount}
            initial={{ y: liked ? 8 : 0, opacity: liked ? 0 : 1 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.2 }}
          >
            {fmt(likeCount)}
          </motion.span>
        </button>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground min-h-[44px]">
          <MessageCircle className="h-4 w-4" />
          {item.replies}
        </span>
        {item.readCount && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground min-h-[44px]">
            <Eye className="h-4 w-4" />
            {fmt(item.readCount)}
          </span>
        )}
        <button
          onClick={() => onShare?.(item.id)}
          className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors min-h-[44px] min-w-[44px] justify-center"
        >
          <Share2 className="h-4 w-4" />
          {t("share")}
        </button>
      </div>
    </div>
  );
}
