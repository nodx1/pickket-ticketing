"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  Camera,
  Star,
  Bell,
  Award,
  ImageIcon,
  Loader2,
  Plus,
  MessageSquare,
} from "lucide-react";
import { Button } from "@pickket/ui";
import { useAuthStore } from "@pickket/store";
import api from "@pickket/lib/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";

interface EventMemory {
  id: string;
  event_id: string;
  user_id: string;
  memory_type: "digital_souvenir" | "photo" | "review" | "badge";
  content: Record<string, unknown> | null;
  title: string | null;
  description: string | null;
  is_public: boolean;
  user_name: string;
  created_at: string;
}

interface PostEventSectionProps {
  eventId: string;
  eventTitle: string;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const MEMORY_TYPE_LABELS: Record<
  string,
  { label: string; icon: typeof Camera }
> = {
  digital_souvenir: { label: "디지털 기념품", icon: Award },
  photo: { label: "사진", icon: Camera },
  review: { label: "리뷰", icon: MessageSquare },
  badge: { label: "뱃지", icon: Star },
};

export function PostEventSection({
  eventId,
  eventTitle,
}: PostEventSectionProps) {
  const t = useTranslations("event.postSection");
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);

  const { data: memories = [], isLoading: loading } = useQuery<EventMemory[]>({
    queryKey: ["events", eventId, "memories"],
    queryFn: async () => {
      const res = await api.get<EventMemory[]>(
        `/events/${eventId}/memories?limit=20`,
      );
      return res.data;
    },
  });

  const handleCreatePhotoMemory = async () => {
    if (!user) {
      toast.error(t("loginRequired"));
      return;
    }
    setSubmitting(true);
    try {
      await api.post(`/events/${eventId}/memories`, {
        memory_type: "photo",
        title: `${eventTitle} 후기`,
        is_public: true,
        content: { text: "멋진 이벤트였습니다!" },
      });
      toast.success(t("memoryCreated"));
      await queryClient.invalidateQueries({
        queryKey: ["events", eventId, "memories"],
      });
    } catch (err: unknown) {
      const message =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? t("memoryCreateFailed");
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleNotifyNext = async () => {
    toast.success(t("nextEventNotifySet"));
  };

  // Souvenir card from memories
  const souvenirMemory = memories.find(
    (m) => m.memory_type === "digital_souvenir",
  );
  const photoMemories = memories.filter((m) => m.memory_type === "photo");

  return (
    <motion.section
      className="space-y-6 rounded-xl border border-border bg-card p-5 md:p-6"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
    >
      {/* Header */}
      <div className="text-center space-y-2">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Star className="h-6 w-6 text-primary" />
        </div>
        <h2 className="text-lg font-semibold">{t("eventEnded")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("eventEndedSubtitle")}
        </p>
      </div>

      {/* Digital Souvenir Card */}
      {souvenirMemory && (
        <motion.div
          className="rounded-lg border border-primary/20 bg-gradient-to-br from-primary/5 to-primary/10 p-4"
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.1 }}
        >
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Award className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{t("digitalSouvenir")}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {souvenirMemory.title ?? eventTitle}
              </p>
              {Boolean(souvenirMemory.content?.image_url) && (
                <div className="mt-3 overflow-hidden rounded-md">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={souvenirMemory.content!.image_url as string}
                    alt={t("digitalSouvenir")}
                    className="w-full object-cover"
                  />
                </div>
              )}
            </div>
          </div>
        </motion.div>
      )}

      {/* Review Prompt CTA */}
      <motion.div
        className="rounded-lg border border-border bg-muted/50 p-4"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
      >
        <div className="flex items-center gap-3">
          <MessageSquare className="h-5 w-5 text-amber-500 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium">{t("reviewPromptTitle")}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("reviewPromptSubtitle")}
            </p>
          </div>
          <Button size="sm" variant="outline">
            {t("writeReview")}
          </Button>
        </div>
      </motion.div>

      {/* Photo Sharing Section */}
      <motion.div
        className="space-y-3"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <Camera className="h-4 w-4" />
            {t("photoSharing")}
          </h3>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleCreatePhotoMemory}
            disabled={submitting || !user}
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
            ) : (
              <Plus className="h-3.5 w-3.5 mr-1" />
            )}
            {t("uploadPhoto")}
          </Button>
        </div>

        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : photoMemories.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {photoMemories.slice(0, 6).map((memory) => (
              <div
                key={memory.id}
                className="aspect-square rounded-lg border border-border bg-muted/30 overflow-hidden flex items-center justify-center"
              >
                {memory.content?.image_url ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={memory.content.image_url as string}
                    alt={memory.title ?? t("eventPhoto")}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="text-center p-2">
                    <ImageIcon className="h-6 w-6 mx-auto text-muted-foreground/50" />
                    <p className="text-[10px] text-muted-foreground mt-1 line-clamp-2">
                      {memory.title ?? t("photo")}
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border py-8 text-center">
            <ImageIcon className="h-8 w-8 mx-auto text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground mt-2">
              {t("noPhotosYet")}
            </p>
          </div>
        )}
      </motion.div>

      {/* Re-engagement Button */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25 }}
      >
        <Button className="w-full" variant="outline" onClick={handleNotifyNext}>
          <Bell className="h-4 w-4 mr-2" />
          {t("notifyNextEvent")}
        </Button>
      </motion.div>
    </motion.section>
  );
}
