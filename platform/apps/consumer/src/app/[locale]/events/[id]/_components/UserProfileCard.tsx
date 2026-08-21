"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { X, UserPlus, UserCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAuthStore } from "@pickket/store";
import { fmt } from "../detail-helpers";

interface UserProfileCardProps {
  userId: string;
  userName: string;
  userAvatar?: string;
  role: string;
  fanLevel?: number;
  isOpen: boolean;
  onClose: () => void;
}

export function UserProfileCard({
  userId,
  userName,
  userAvatar,
  role,
  fanLevel,
  isOpen,
  onClose,
}: UserProfileCardProps) {
  const t = useTranslations("event.profileCard");
  const currentUser = useAuthStore((s) => s.user);
  const [following, setFollowing] = useState(false);
  const [followerCount, setFollowerCount] = useState(0);
  const [followingCount, setFollowingCount] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen || !userId) return;
    import("@pickket/lib/api").then(({ getFollowStatus }) => {
      getFollowStatus(userId)
        .then((res) => {
          setFollowing(res.data.is_following);
          setFollowerCount(res.data.follower_count);
          setFollowingCount(res.data.following_count);
        })
        .catch(() => {});
    });
  }, [isOpen, userId]);

  const handleToggleFollow = async () => {
    if (!currentUser || loading) return;
    setLoading(true);
    try {
      const { toggleFollow } = await import("@pickket/lib/api");
      const res = await toggleFollow(userId);
      setFollowing(res.data.is_following);
      setFollowerCount((c) => c + (res.data.is_following ? 1 : -1));
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  };

  const isMe = currentUser?.id === userId;
  const avatarUrl =
    userAvatar ||
    `https://ui-avatars.com/api/?name=${encodeURIComponent(userName)}&background=6c5ce7&color=fff`;

  const roleLabel =
    role === "organizer"
      ? t("roleOrganizer")
      : role === "artist"
        ? t("roleArtist")
        : role === "verified_attendee"
          ? t("roleVerifiedAttendee")
          : t("roleFan");

  const tierLabel = fanLevel
    ? (["", t("tier1"), t("tier2"), t("tier3"), t("tier4"), t("tier5")] as const)[fanLevel]
    : null;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onClick={onClose}
        >
          <div className="fixed inset-0 bg-black/40" />
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className="relative z-10 w-full max-w-sm rounded-2xl border border-border/50 bg-background shadow-sm p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close */}
            <button
              onClick={onClose}
              className="absolute top-4 right-4 text-muted-foreground hover:text-foreground"
            >
              <X className="h-5 w-5" />
            </button>

            {/* Avatar + Name */}
            <div className="flex flex-col items-center text-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={avatarUrl}
                alt={userName}
                className="h-16 w-16 rounded-full object-cover ring-2 ring-white/10"
              />
              <h3 className="mt-3 text-lg font-bold text-foreground">
                {userName}
              </h3>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary/70">
                  {roleLabel}
                </span>
                {tierLabel && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400">
                    {tierLabel}
                  </span>
                )}
              </div>
            </div>

            {/* Stats */}
            <div className="flex items-center justify-center gap-6 py-2">
              <div className="text-center">
                <p className="text-lg font-bold text-foreground">
                  {fmt(followerCount)}
                </p>
                <p className="text-2xs text-muted-foreground">{t("followers")}</p>
              </div>
              <div className="h-6 w-px bg-white/10" />
              <div className="text-center">
                <p className="text-lg font-bold text-foreground">
                  {fmt(followingCount)}
                </p>
                <p className="text-2xs text-muted-foreground">{t("following")}</p>
              </div>
            </div>

            {/* Follow button */}
            {!isMe && currentUser && (
              <button
                onClick={handleToggleFollow}
                disabled={loading}
                className={`w-full flex items-center justify-center gap-2 py-3 rounded-full text-sm font-semibold transition-all ${
                  following
                    ? "border border-white/10 text-muted-foreground hover:border-red-600/30 hover:text-red-600 dark:text-red-400"
                    : "bg-primary text-white hover:brightness-110"
                }`}
              >
                {following ? (
                  <UserCheck className="h-4 w-4" />
                ) : (
                  <UserPlus className="h-4 w-4" />
                )}
                {following ? t("following") : t("follow")}
              </button>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
