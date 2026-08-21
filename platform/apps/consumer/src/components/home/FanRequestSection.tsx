"use client";

import { useCallback, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useAuthStore } from "@pickket/store";
import { createFanRequest } from "@pickket/lib/api";
import type { FanRequestArtist } from "@/components/home/types";
import { fmt } from "@/components/home/types";

const RANK_COLORS = [
  "text-amber-500 dark:text-amber-400",
  "text-slate-400 dark:text-slate-300",
  "text-orange-600 dark:text-orange-400",
];

export default function FanRequestSection({
  artists,
}: {
  artists?: FanRequestArtist[];
}) {
  const t = useTranslations("home.fan_request");
  const [localCounts, setLocalCounts] = useState<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    for (const a of artists ?? []) counts[a.id] = a.requests;
    return counts;
  });
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const user = useAuthStore((s) => s.user);

  const rankedArtists = [...(artists ?? [])]
    .sort(
      (left, right) =>
        (localCounts[right.id] ?? right.requests) -
        (localCounts[left.id] ?? left.requests),
    )
    .slice(0, 10);

  const handleRequest = useCallback(
    async (artistId: string) => {
      if (!user) {
        toast.error(t("toast_login_required"), {
          action: {
            label: t("toast_login_action"),
            onClick: () => {
              window.location.href = "/auth";
            },
          },
        });
        return;
      }
      if (pendingIds.has(artistId)) return;

      setPendingIds((p) => new Set(p).add(artistId));

      try {
        await createFanRequest(artistId);
        setLocalCounts((c) => ({ ...c, [artistId]: (c[artistId] ?? 0) + 1 }));
        toast.success(t("toast_success"));
      } catch (err: unknown) {
        const axiosErr = err as { response?: { status?: number } };
        console.log("[fanRequest error]", axiosErr?.response?.status, err);
        if (axiosErr?.response?.status === 409) {
          toast.info(t("toast_duplicate"));
        } else {
          toast.error(t("toast_error"));
        }
      } finally {
        setPendingIds((p) => {
          const n = new Set(p);
          n.delete(artistId);
          return n;
        });
      }
    },
    [user, pendingIds, t],
  );

  if (rankedArtists.length === 0) {
    return null;
  }

  return (
    <section id="fan-requests" className="max-w-7xl mx-auto px-4 sm:px-8 py-12">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl lg:text-2xl font-black tracking-tight text-foreground flex items-center gap-3">
          {t("title")}
          <span className="inline-flex items-center gap-1.5 text-xs font-bold text-red-500">
            <span className="relative flex h-2 w-2">
              <span className="absolute inset-0 rounded-full bg-red-500 animate-ping opacity-75" />
              <span className="relative rounded-full h-2 w-2 bg-red-500" />
            </span>
            LIVE
          </span>
        </h2>
        <Link
          href="/fan-requests"
          className="hidden sm:flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          {t("view_more")}
          <ChevronRight className="h-4 w-4" />
        </Link>
      </div>

      <div className="space-y-2">
        {rankedArtists.map((artist, index) => {
          const pending = pendingIds.has(artist.id);
          const count = localCounts[artist.id] ?? artist.requests;

          return (
            <motion.article
              key={artist.id}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ delay: index * 0.05, duration: 0.4 }}
              className="flex items-center gap-4 p-4 rounded-2xl bg-muted/30 border border-border hover:bg-muted/50 transition-colors"
            >
              <span
                className={`text-lg font-black w-6 text-center ${RANK_COLORS[index] ?? "text-muted-foreground"}`}
              >
                {index + 1}
              </span>

              <div className="relative w-12 h-12 rounded-full overflow-hidden bg-muted border border-border shrink-0">
                {artist.image ? (
                  <Image
                    src={artist.image}
                    alt={artist.name}
                    fill
                    sizes="48px"
                    className="object-cover"
                  />
                ) : (
                  <span className="absolute inset-0 flex items-center justify-center text-sm font-bold text-primary">
                    {artist.name.charAt(0)}
                  </span>
                )}
              </div>

              <span className="text-sm font-bold text-foreground truncate flex-1 min-w-0">
                {artist.name}
              </span>
              <span className="text-2xs font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded-full shrink-0 w-16 text-center">
                {artist.genre}
              </span>
              <span className="text-xs font-bold text-primary font-tabular shrink-0 w-20 text-right">
                {t("request_count", { count: fmt(count) })}
              </span>

              <button
                type="button"
                disabled={pending}
                onClick={() => handleRequest(artist.id)}
                className="shrink-0 px-5 py-2.5 rounded-full text-xs font-bold transition-all active:scale-95 disabled:opacity-60 bg-primary text-white shadow-sm hover:shadow-lg hover:bg-primary/80 hover:scale-105"
              >
                {t("request_btn")}
              </button>
            </motion.article>
          );
        })}
      </div>
    </section>
  );
}
