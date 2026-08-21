"use client";

import Link from "next/link";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { Mic, Users, Tag, Music2, Guitar } from "lucide-react";
import { motion } from "motion/react";
import DomainSection from "./DomainSection";
import { normalizeSaleMode } from "@pickket/lib";

function getGenreIcon(genre: string) {
  const lower = genre.toLowerCase();
  if (lower.includes("pop") || lower.includes("k-pop")) return Music2;
  if (lower.includes("rock")) return Guitar;
  if (lower.includes("hip") || lower.includes("rap")) return Mic;
  return Tag;
}

interface ConcertArtistSectionProps {
  artistName?: string;
  artistImageUrl?: string;
  communityId?: string | null;
  tags?: string;
  tiers?: Array<{ sale_mode: string }>;
}

export default function ConcertArtistSection({
  artistName,
  artistImageUrl,
  communityId,
  tags,
  tiers,
}: ConcertArtistSectionProps) {
  const t = useTranslations("domain");
  if (!artistName) return null;

  const hasFanclubTier =
    tiers?.some((t) => normalizeSaleMode(t.sale_mode) === "fanclub") ?? false;
  const tagList = tags
    ? tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

  return (
    <DomainSection
      title={t("concert.artist")}
      iconSrc="/icons/categories/concert.svg"
      accentColor="bg-primary"
    >
      <div className="flex flex-col md:flex-row items-center md:items-start gap-5">
        {/* Avatar */}
        <div className="shrink-0">
          {artistImageUrl ? (
            <Image
              src={artistImageUrl}
              alt={artistName}
              width={80}
              height={80}
              className="w-20 h-20 rounded-full object-cover border-2 border-border shadow-sm"
              unoptimized
            />
          ) : (
            <div className="w-20 h-20 rounded-full bg-gradient-to-br from-red-400 to-rose-600 flex items-center justify-center border-2 border-border shadow-sm">
              <span className="text-2xl font-black text-white">
                {artistName.charAt(0)}
              </span>
            </div>
          )}
        </div>

        {/* Info */}
        <div
          className="flex-1 text-center md:text-left space-y-4"
          aria-label={`${t("concert.artist")}: ${artistName}`}
        >
          {/* Artist name */}
          <motion.p
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
            className="text-xl font-bold text-foreground"
          >
            {artistName}
          </motion.p>

          {/* Fanclub link + badge row */}
          <div className="flex flex-wrap items-center justify-center md:justify-start gap-2">
            {communityId && (
              <Link
                href={`/community/${communityId}`}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[44px] rounded-full bg-primary/10 text-primary text-sm font-medium hover:bg-primary/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                <Users className="h-3.5 w-3.5" />
                {t("concert.fanclub")}
              </Link>
            )}

            {hasFanclubTier && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 text-xs font-semibold">
                {t("concert.fanclubOnly")}
              </span>
            )}
          </div>

          {/* Tags with genre icons */}
          {tagList.length > 0 && (
            <motion.div
              initial="hidden"
              animate="visible"
              variants={{ visible: { transition: { staggerChildren: 0.06 } } }}
              className="flex flex-wrap items-center justify-center md:justify-start gap-1.5"
              role="list"
              aria-label={t("concert.ariaGenreTags")}
            >
              {tagList.map((tag) => {
                const IconComponent = getGenreIcon(tag);
                return (
                  <motion.span
                    key={tag}
                    variants={{
                      hidden: { opacity: 0, scale: 0.85 },
                      visible: { opacity: 1, scale: 1 },
                    }}
                    transition={{ type: "spring", stiffness: 400, damping: 25 }}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-xs-plus font-medium"
                    role="listitem"
                    aria-label={t("concert.ariaGenreTag", { tag })}
                  >
                    <IconComponent className="h-3 w-3" aria-hidden="true" />
                    {tag}
                  </motion.span>
                );
              })}
            </motion.div>
          )}
        </div>
      </div>
    </DomainSection>
  );
}
