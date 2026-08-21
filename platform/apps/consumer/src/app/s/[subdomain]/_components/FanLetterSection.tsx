"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Heart, Star, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  getFanLetters,
  createFanLetter,
  deleteFanLetter,
} from "@pickket/lib/api";
import { useAuthStore } from "@pickket/store";

interface FanLetter {
  id: string;
  event_id: string;
  user_id: string;
  user_name: string;
  content: string;
  featured: boolean;
  visible: boolean;
  created_at: string;
}

interface FanLetterSectionProps {
  eventId: string;
}

export function FanLetterSection({ eventId }: FanLetterSectionProps) {
  const t = useTranslations("event.fanLetter");
  const [letters, setLetters] = useState<FanLetter[]>([]);
  const [total, setTotal] = useState(0);
  const [content, setContent] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const user = useAuthStore((s) => s.user);

  const fetchLetters = useCallback(async () => {
    try {
      const res = await getFanLetters(eventId, { limit: 20, offset: 0 });
      setLetters(res.data.items);
      setTotal(res.data.total);
    } catch {
      // silently fail for public listing
    }
  }, [eventId]);

  useEffect(() => {
    fetchLetters();
  }, [fetchLetters]);

  const handleSubmit = async () => {
    if (!content.trim() || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await createFanLetter(eventId, { content: content.trim() });
      setContent("");
      setShowForm(false);
      await fetchLetters();
    } catch {
      toast.error(t("submitError"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (letterId: string) => {
    try {
      await deleteFanLetter(letterId);
      await fetchLetters();
    } catch {
      toast.error(t("deleteError"));
    }
  };

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleDateString("ko-KR", {
      month: "short",
      day: "numeric",
    });

  return (
    <section className="rounded-xl bg-card border border-white/5 p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <Heart className="h-5 w-5 text-primary/70" />
          {t("title")}
          {total > 0 && (
            <span className="text-sm font-normal text-muted-foreground">
              {total}
            </span>
          )}
        </h2>
        {user && (
          <button
            onClick={() => setShowForm(!showForm)}
            className="text-sm text-primary/70 hover:text-primary transition-colors"
          >
            {showForm ? t("cancel") : t("writeButton")}
          </button>
        )}
      </div>

      {/* Write form */}
      {showForm && (
        <div className="mb-6 space-y-3">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value.slice(0, 500))}
            placeholder={t("placeholder")}
            rows={4}
            className="w-full rounded-lg bg-background border border-white/10 px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary resize-none transition-colors"
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {content.length}/500
            </span>
            <button
              onClick={handleSubmit}
              disabled={!content.trim() || isSubmitting}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/80 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              <Send className="h-3.5 w-3.5" />
              {isSubmitting ? t("submitting") : t("send")}
            </button>
          </div>
        </div>
      )}

      {/* Letters list */}
      {letters.length === 0 ? (
        <div className="text-sm text-muted-foreground text-center py-8">
          {t("empty")}
        </div>
      ) : (
        <div className="space-y-3">
          {letters.map((letter) => (
            <div
              key={letter.id}
              className={`relative rounded-lg p-4 transition-colors ${
                letter.featured
                  ? "bg-primary/10 border border-primary/30"
                  : "bg-background border border-white/5"
              }`}
            >
              {letter.featured && (
                <Star className="absolute top-3 right-3 h-4 w-4 text-primary/70 fill-current" />
              )}
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-medium text-foreground">
                  {letter.user_name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatDate(letter.created_at)}
                </span>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
                {letter.content}
              </p>
              {user && user.id === letter.user_id && (
                <button
                  onClick={() => handleDelete(letter.id)}
                  className="absolute bottom-3 right-3 text-muted-foreground hover:text-red-400 transition-colors"
                  title={t("delete")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
