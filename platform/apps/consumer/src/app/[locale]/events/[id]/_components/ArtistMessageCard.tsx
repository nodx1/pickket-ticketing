"use client";

import { useState, useRef } from "react";
import { useTranslations } from "next-intl";
import { motion, AnimatePresence, useInView } from "motion/react";
import { Sparkles, Gem } from "lucide-react";
import {
  getEventComments,
  type EventComment as ApiComment,
} from "@pickket/lib/api";
import { fmt } from "../detail-helpers";
import { useQuery } from "@tanstack/react-query";

const REACTION_KEYS = ["💎", "😭", "🔥", "💕", "🎵"] as const;

interface ArtistMessageProps {
  artistName?: string;
  artistAvatar?: string;
  message?: string;
  createdAt?: string;
  eventId: string;
}

export function ArtistMessageCard({
  artistName,
  artistAvatar,
  message,
  createdAt,
  eventId,
}: ArtistMessageProps) {
  const t = useTranslations("event.artistMessage");
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-80px" });
  const [reacted, setReacted] = useState<Set<string>>(new Set());
  const [counts, setCounts] = useState<Record<string, number>>(() => ({
    "💎": 0,
    "😭": 0,
    "🔥": 0,
    "💕": 0,
    "🎵": 0,
  }));
  const [floatingEmoji, setFloatingEmoji] = useState<{
    emoji: string;
    id: number;
  } | null>(null);

  // Resolved artist message data (from props or API)
  const [artistData, setArtistData] = useState<{
    artist: string;
    avatar: string;
    message: string;
    createdAt: string;
    scarcityLabel: string;
  } | null>(
    artistName && message
      ? {
          artist: artistName,
          avatar:
            artistAvatar ??
            `https://ui-avatars.com/api/?name=${encodeURIComponent(artistName)}`,
          message,
          createdAt: createdAt ?? "",
          scarcityLabel: t("scarcityLabel"),
        }
      : null,
  );
  // If no props provided, fetch artist pinned comment from API
  const { isLoading: loading } = useQuery({
    queryKey: ["events", eventId, "artistMessage"],
    queryFn: async () => {
      const res = await getEventComments(eventId, {
        filter: "official",
        limit: 5,
      });
      const artistComment = res.data.items.find(
        (c: ApiComment) => c.role === "artist",
      );
      if (artistComment) {
        setArtistData({
          artist: artistComment.user_name,
          avatar:
            artistComment.user_avatar ??
            `https://ui-avatars.com/api/?name=${encodeURIComponent(artistComment.user_name)}`,
          message: artistComment.content,
          createdAt: new Date(artistComment.created_at).toLocaleDateString(
            "ko-KR",
            {
              year: "numeric",
              month: "long",
              day: "numeric",
              timeZone: "Asia/Seoul",
            },
          ),
          scarcityLabel: t("scarcityLabel"),
        });
      }
      return artistComment ?? null;
    },
    enabled: !artistData,
  });

  const toggleReaction = (emoji: string) => {
    setReacted((prev) => {
      const next = new Set(prev);
      if (next.has(emoji)) {
        next.delete(emoji);
        setCounts((c) => ({ ...c, [emoji]: (c[emoji] ?? 0) - 1 }));
      } else {
        next.add(emoji);
        setCounts((c) => ({ ...c, [emoji]: (c[emoji] ?? 0) + 1 }));
        // float-up 애니메이션 트리거
        setFloatingEmoji({ emoji, id: Date.now() });
      }
      return next;
    });
  };

  // Hide if no data and done loading
  if (!loading && !artistData) return null;
  // Still loading — don't render anything yet
  if (loading && !artistData) return null;

  const msg = artistData!;

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 24 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.6, ease: [0.25, 0.1, 0.25, 1] }}
      className="relative rounded-2xl p-6 text-white overflow-hidden"
      style={{
        background:
          "linear-gradient(135deg, #0a0a0a 0%, #404040 50%, #7C3AED 100%)",
      }}
    >
      {/* shimmer 애니메이션 오버레이 — motion으로 구현 */}
      <motion.div
        className="absolute inset-0 pointer-events-none opacity-20"
        style={{
          background:
            "linear-gradient(110deg, transparent 25%, rgba(255,255,255,0.15) 50%, transparent 75%)",
          backgroundSize: "200% 100%",
        }}
        animate={{ backgroundPosition: ["200% 0", "-200% 0"] }}
        transition={{ duration: 4, ease: "easeInOut", repeat: Infinity }}
      />

      {/* 빛 오버레이 */}
      <div
        className="absolute inset-0 opacity-30 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at 30% 20%, rgba(255,255,255,0.15) 0%, transparent 60%)",
        }}
      />

      {/* float-up 이모지 */}
      <AnimatePresence>
        {floatingEmoji && (
          <motion.span
            key={floatingEmoji.id}
            initial={{ opacity: 1, y: 0, x: "50%" }}
            animate={{ opacity: 0, y: -60 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.8, ease: "easeOut" }}
            onAnimationComplete={() => setFloatingEmoji(null)}
            className="absolute bottom-16 left-1/2 text-2xl pointer-events-none z-20"
          >
            {floatingEmoji.emoji}
          </motion.span>
        )}
      </AnimatePresence>

      <div className="relative z-10 space-y-4">
        {/* 헤더 */}
        <motion.div
          initial={{ opacity: 0, x: -12 }}
          animate={isInView ? { opacity: 1, x: 0 } : {}}
          transition={{ delay: 0.2, duration: 0.5 }}
          className="flex items-center gap-2 text-sm"
        >
          <Sparkles className="h-4 w-4 text-amber-300" />
          <span className="font-semibold text-white/90">
            {t("header")}
          </span>
        </motion.div>

        {/* 아티스트 정보 */}
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={msg.avatar}
            alt={msg.artist}
            className="h-11 w-11 rounded-full object-cover ring-2 ring-white/30"
          />
          <div>
            <span className="text-base font-bold">{msg.artist}</span>
            <p className="text-xs-plus text-white/60">{msg.createdAt}</p>
          </div>
        </div>

        {/* 메시지 본문 */}
        <p className="text-base text-white/90 leading-relaxed">{msg.message}</p>

        {/* 희소성 라벨 */}
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/10 backdrop-blur-sm text-xs-plus font-medium text-white/80">
            <Gem className="h-3 w-3 text-amber-300" />
            {msg.scarcityLabel}
          </span>
        </div>

        {/* 이모지 리액션 */}
        <div className="flex flex-wrap gap-2 pt-1">
          {REACTION_KEYS.map((emoji) => {
            const isReacted = reacted.has(emoji);
            const count = counts[emoji] ?? 0;
            return (
              <motion.button
                key={emoji}
                whileTap={{ scale: 1.3 }}
                animate={isReacted ? { scale: [1, 1.2, 1] } : {}}
                transition={{ type: "spring", stiffness: 400, damping: 15 }}
                onClick={() => toggleReaction(emoji)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm transition-all min-h-[36px] ${
                  isReacted
                    ? "bg-white/25 ring-1 ring-white/40"
                    : "bg-white/10 hover:bg-white/15"
                }`}
              >
                <span>{emoji}</span>
                <motion.span
                  key={count}
                  initial={{ y: 8, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  className="text-xs-plus font-medium text-white/80"
                >
                  {fmt(count)}
                </motion.span>
              </motion.button>
            );
          })}
        </div>

        {/* 총 리액션 수 */}
        <p className="text-xs-plus text-white/50">
          {t("reactionCount", { count: fmt(Object.values(counts).reduce((a, b) => a + b, 0)) })}
        </p>
      </div>
    </motion.div>
  );
}
