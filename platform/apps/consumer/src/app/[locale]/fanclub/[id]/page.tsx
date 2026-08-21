"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useParams } from "next/navigation";
import { motion } from "motion/react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import {
  Users,
  Star,
  Shield,
  Ticket,
  TrendingUp,
  CheckCircle2,
  Loader2,
  BadgeCheck,
} from "lucide-react";
import { Button } from "@pickket/ui";
import { Badge } from "@pickket/ui";
import { Input } from "@pickket/ui";
import { useAuthStore } from "@pickket/store";
import { getFanclub, joinFanclub } from "@pickket/lib/api";
import { getDomainLabels } from "@pickket/lib";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface FanclubDetail {
  id: string;
  organizer_id: string;
  name: string;
  artist_name: string;
  subject_name?: string;
  domain?: string;
  description?: string;
  logo_url?: string;
  max_members?: number;
  is_official: boolean;
  member_count: number;
}

export default function FanclubDetailPage() {
  const t = useTranslations("fanclub.detail");
  const params = useParams();
  const fanclubId = params.id as string;
  const { user } = useAuthStore();

  const queryClient = useQueryClient();
  const [membershipCode, setMembershipCode] = useState("");
  const [joined, setJoined] = useState(false);

  const { data: fanclub = null, isLoading: loading } =
    useQuery<FanclubDetail | null>({
      queryKey: ["fanclub", fanclubId],
      queryFn: async () => {
        const data = await getFanclub(fanclubId);
        return data;
      },
    });

  const labels = getDomainLabels(fanclub?.domain);

  // Check if user is already a member
  useEffect(() => {
    if (user?.fanclub_memberships) {
      const isMember = user.fanclub_memberships.some(
        (m) => m.fanclub_id === fanclubId && m.status === "active",
      );
      setJoined(isMember);
    }
  }, [user, fanclubId]);

  const joinMutation = useMutation({
    mutationFn: async () => {
      if (!membershipCode.trim()) throw new Error(t("errorCodeRequired"));
      if (!user) throw new Error(t("errorLoginRequired"));
      await joinFanclub(fanclubId, { membership_code: membershipCode.trim() });
    },
    onSuccess: () => {
      toast.success(t("toastJoinSuccess", { community: labels.communityLabel ?? "" }));
      setJoined(true);
      setMembershipCode("");
      queryClient.invalidateQueries({ queryKey: ["fanclub", fanclubId] });
    },
    onError: (err: unknown) => {
      const msg =
        (err as { message?: string })?.message ||
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ||
        t("toastJoinError");
      toast.error(msg);
    },
  });

  const handleJoin = () => joinMutation.mutate();
  const joining = joinMutation.isPending;

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-5 pt-20 pb-5 lg:px-6 lg:pb-6 space-y-6">
        <div className="h-32 bg-surface-dim rounded-2xl animate-pulse" />
        <div className="h-48 bg-surface-dim rounded-2xl animate-pulse" />
        <div className="h-32 bg-surface-dim rounded-2xl animate-pulse" />
      </div>
    );
  }

  if (!fanclub) {
    return (
      <div className="max-w-3xl mx-auto px-5 pt-20 pb-5 lg:px-6 lg:pb-6">
        <div className="rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] p-5 text-center py-16">
          <Users className="h-12 w-12 mx-auto mb-3 text-muted-foreground opacity-30" />
          <p className="text-lg font-medium mb-1">
            {t("notFound")}
          </p>
          <p className="text-sm text-muted-foreground">{t("notFoundHint")}</p>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      className="max-w-3xl mx-auto space-y-6 px-5 pt-20 pb-5 lg:px-6 lg:pb-6"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      {/* Fanclub Header */}
      <div className="rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] overflow-hidden">
        <div className="bg-gradient-to-r from-primary/10 to-violet-500/10 p-6 lg:p-8">
          <div className="flex items-start gap-5">
            {/* Logo */}
            <div className="shrink-0">
              {fanclub.logo_url ? (
                <Image
                  src={fanclub.logo_url}
                  alt={fanclub.name}
                  width={96}
                  height={96}
                  unoptimized
                  className="w-20 h-20 lg:w-24 lg:h-24 rounded-2xl object-cover shadow-lg"
                />
              ) : (
                <div className="w-20 h-20 lg:w-24 lg:h-24 rounded-2xl bg-primary/20 flex items-center justify-center shadow-lg">
                  <Users className="h-10 w-10 text-primary" />
                </div>
              )}
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-2xl lg:text-3xl font-bold">
                  {fanclub.name}
                </h1>
                {fanclub.is_official && (
                  <Badge className="rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 gap-1">
                    <BadgeCheck className="h-3.5 w-3.5" />
                    {t("badgeOfficial")}
                  </Badge>
                )}
                {joined && (
                  <Badge className="rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {t("badgeJoined")}
                  </Badge>
                )}
              </div>
              <p className="text-lg text-muted-foreground mt-1">
                {fanclub.subject_name || fanclub.artist_name}
              </p>
              {fanclub.description && (
                <p className="text-sm text-muted-foreground mt-3 leading-relaxed">
                  {fanclub.description}
                </p>
              )}
              <div className="flex items-center gap-4 mt-4 text-sm text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Users className="h-4 w-4" />
                  <strong className="text-foreground font-tabular">
                    {fanclub.member_count.toLocaleString()}
                  </strong>
                  {t("memberCountSuffix")}
                </span>
                {fanclub.max_members && (
                  <span className="flex items-center gap-1">
                    {t("capacityPrefix")}{" "}
                    <strong className="text-foreground font-tabular">
                      {fanclub.max_members.toLocaleString()}
                    </strong>
                    {t("capacitySuffix")}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Benefits Section */}
      <div className="rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] p-5 lg:p-6">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Star className="h-5 w-5 text-amber-500" />
          {t("benefitsTitle")}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="rounded-xl bg-gradient-to-br from-primary/5 to-primary/10 p-4"
          >
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
                <Ticket className="h-4 w-4 text-primary" />
              </div>
              <h3 className="font-medium text-sm">{t("benefit1Title")}</h3>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t("benefit1Desc", { community: labels.communityLabel ?? "", member: labels.memberLabel ?? "" })}
            </p>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className="rounded-xl bg-gradient-to-br from-violet-500/5 to-violet-500/10 p-4"
          >
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-full bg-violet-500/20 flex items-center justify-center">
                <Shield className="h-4 w-4 text-violet-600 dark:text-violet-400" />
              </div>
              <h3 className="font-medium text-sm">{t("benefit2Title")}</h3>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t("benefit2Desc", { community: labels.communityLabel ?? "", member: labels.memberLabel ?? "" })}
            </p>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="rounded-xl bg-gradient-to-br from-cyan-500/5 to-cyan-500/10 p-4"
          >
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-full bg-cyan-500/20 flex items-center justify-center">
                <TrendingUp className="h-4 w-4 text-cyan-600 dark:text-cyan-400" />
              </div>
              <h3 className="font-medium text-sm">{t("benefit3Title")}</h3>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t("benefit3Desc", { community: labels.communityLabel ?? "" })}
            </p>
          </motion.div>
        </div>
      </div>

      {/* Join Section */}
      <div className="rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] p-5 lg:p-6">
        {joined ? (
          <div className="text-center py-8">
            <CheckCircle2 className="h-12 w-12 mx-auto mb-3 text-green-500" />
            <p className="text-lg font-semibold mb-1">{t("joinedHeading")}</p>
            <p className="text-sm text-muted-foreground">{t("joinedDesc", { community: labels.communityLabel ?? "" })}</p>
          </div>
        ) : (
          <>
            <h2 className="text-lg font-semibold mb-4">{t("joinHeading", { community: labels.communityLabel ?? "" })}</h2>
            <p className="text-sm text-muted-foreground mb-4">
              {t("joinDesc", { community: labels.communityLabel ?? "" })}
            </p>
            <div className="flex gap-3">
              <Input
                placeholder={t("codePlaceholder")}
                value={membershipCode}
                onChange={(e) => setMembershipCode(e.target.value)}
                className="flex-1 rounded-full"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleJoin();
                }}
              />
              <Button
                onClick={handleJoin}
                disabled={joining || !membershipCode.trim()}
                className="rounded-full bg-primary hover:bg-primary/90 gap-1.5 px-6"
              >
                {joining ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t("buttonJoining")}
                  </>
                ) : (
                  t("buttonJoin")
                )}
              </Button>
            </div>
          </>
        )}
      </div>
    </motion.div>
  );
}
