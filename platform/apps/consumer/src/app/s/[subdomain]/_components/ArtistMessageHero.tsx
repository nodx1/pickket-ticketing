"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { motion, AnimatePresence } from "motion/react";
import { Sparkles } from "lucide-react";
import { getArtistMessages, reactToArtistMessage } from "@pickket/lib/api";

interface ArtistMessage {
  id: string;
  event_id: string;
  author_name: string;
  author_avatar_url: string | null;
  content: string;
  pinned: boolean;
  reactions: Record<string, number>;
  created_at: string;
}

const REACTION_EMOJIS = [
  { emoji: "\uD83D\uDD25", key: "fire" },
  { emoji: "\u2764\uFE0F", key: "heart" },
  { emoji: "\uD83D\uDC4F", key: "clap" },
  { emoji: "\uD83C\uDFB5", key: "music" },
] as const;

function timeAgo(dateStr: string, t: ReturnType<typeof useTranslations>): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.max(0, now - then);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return t("justNow");
  if (minutes < 60) return t("minutesAgo", { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("hoursAgo", { hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("daysAgo", { days });
  return new Date(dateStr).toLocaleDateString("ko-KR", {
    month: "short",
    day: "numeric",
  });
}

function Avatar({
  name,
  url,
  size = "md",
}: {
  name: string;
  url: string | null;
  size?: "sm" | "md";
}) {
  const dim = size === "sm" ? "h-8 w-8 text-xs" : "h-10 w-10 text-sm";

  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={name}
        className={`${dim} rounded-full object-cover ring-1 ring-white/10`}
      />
    );
  }

  return (
    <div
      className={`${dim} rounded-full flex items-center justify-center font-bold bg-primary/20 text-primary/70 ring-1 ring-white/10`}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

function ReactionButtons({
  messageId,
  reactions,
  onReact,
}: {
  messageId: string;
  reactions: Record<string, number>;
  onReact: (messageId: string, key: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 mt-2">
      {REACTION_EMOJIS.map(({ emoji, key }) => {
        const count = reactions[key] ?? 0;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onReact(messageId, key)}
            className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs transition-colors bg-white/5 hover:bg-primary/20 border border-white/5 hover:border-primary/30"
          >
            <span>{emoji}</span>
            {count > 0 && (
              <span className="text-muted-foreground">{count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function PinnedMessage({
  message,
  onReact,
  t,
}: {
  message: ArtistMessage;
  onReact: (messageId: string, key: string) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="relative p-5 rounded-xl bg-gradient-to-br from-primary/10 to-transparent border border-primary/20"
    >
      <div className="flex items-center gap-2 mb-3">
        <Sparkles className="h-4 w-4 text-primary/70" />
        <span className="text-xs font-semibold tracking-wide text-primary/70 uppercase">
          Pinned
        </span>
      </div>

      <div className="flex items-start gap-3">
        <Avatar name={message.author_name} url={message.author_avatar_url} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-foreground">
              {message.author_name}
            </span>
            <span className="text-xs text-muted-foreground">
              {timeAgo(message.created_at, t)}
            </span>
          </div>
          <p className="mt-1.5 text-base leading-relaxed text-foreground/90 whitespace-pre-line">
            {message.content}
          </p>
          <ReactionButtons
            messageId={message.id}
            reactions={message.reactions}
            onReact={onReact}
          />
        </div>
      </div>
    </motion.div>
  );
}

function MessageCard({
  message,
  index,
  onReact,
  t,
}: {
  message: ArtistMessage;
  index: number;
  onReact: (messageId: string, key: string) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.06 }}
      className="p-4 rounded-xl bg-white/[0.03] border border-white/5 hover:border-white/10 transition-colors"
    >
      <div className="flex items-start gap-3">
        <Avatar
          name={message.author_name}
          url={message.author_avatar_url}
          size="sm"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">
              {message.author_name}
            </span>
            <span className="text-xs text-muted-foreground">
              {timeAgo(message.created_at, t)}
            </span>
          </div>
          <p className="mt-1 text-sm leading-relaxed text-foreground/80 whitespace-pre-line">
            {message.content}
          </p>
          <ReactionButtons
            messageId={message.id}
            reactions={message.reactions}
            onReact={onReact}
          />
        </div>
      </div>
    </motion.div>
  );
}

export function ArtistMessageHero({ eventId }: { eventId: string }) {
  const t = useTranslations("artistMessage");
  const [messages, setMessages] = useState<ArtistMessage[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getArtistMessages(eventId)
      .then((res) => {
        if (!cancelled) {
          setMessages(res.data.items);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  const handleReact = useCallback((messageId: string, key: string) => {
    // Optimistic update
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId
          ? {
              ...m,
              reactions: {
                ...m.reactions,
                [key]: (m.reactions[key] ?? 0) + 1,
              },
            }
          : m,
      ),
    );
    reactToArtistMessage(messageId, key).catch(() => {
      // Revert on error
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                reactions: {
                  ...m.reactions,
                  [key]: Math.max(0, (m.reactions[key] ?? 0) - 1),
                },
              }
            : m,
        ),
      );
    });
  }, []);

  // Don't render if no messages or still loading
  if (!loaded || messages.length === 0) return null;

  const pinned = messages.find((m) => m.pinned);
  const regular = messages.filter((m) => !m.pinned);

  return (
    <div className="max-w-[1100px] mx-auto px-4 sm:px-6 mt-6">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="relative rounded-2xl border border-white/10 bg-card/80 backdrop-blur-xl overflow-hidden"
      >
        {/* Gradient border accent */}
        <div className="absolute inset-0 rounded-2xl pointer-events-none ring-1 ring-inset ring-transparent bg-gradient-to-br from-primary/10 via-transparent to-primary/70/5 [mask:linear-gradient(#fff_0_0)_content-box,linear-gradient(#fff_0_0)] [mask-composite:xor] p-[1px]" />

        <div className="relative p-5 sm:p-6 space-y-4">
          {/* Section header */}
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary/70" />
            <h3 className="text-sm font-bold tracking-wide text-foreground">
              {t("title")}
            </h3>
          </div>

          {/* Pinned message */}
          <AnimatePresence>
            {pinned && <PinnedMessage message={pinned} onReact={handleReact} t={t} />}
          </AnimatePresence>

          {/* Regular messages */}
          {regular.length > 0 && (
            <div className="max-h-[320px] overflow-y-auto space-y-3 pr-1 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
              {regular.map((msg, i) => (
                <MessageCard
                  key={msg.id}
                  message={msg}
                  index={i}
                  onReact={handleReact}
                  t={t}
                />
              ))}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
