"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  Shield,
  AlertCircle,
  MapPin,
  FileText,
  BadgeCheck,
  Banknote,
} from "lucide-react";
import { motion } from "motion/react";
import DomainSection from "./DomainSection";

// ─── Types ──────────────────────────────────────────────────────────────────

interface PublicEventInfoCardProps {
  isFree: boolean;
  depositAmount: number;
  requireCheckin: boolean;
  localityRestricted?: string;
  noShowPolicy: string;
  eventId: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("ko-KR").format(amount);
}

function getNoShowLabel(
  policy: string,
  t: (key: string) => string,
): {
  text: string;
  color: string;
} {
  switch (policy) {
    case "refund":
      return {
        text: t("publicEvent.noShowRefund"),
        color: "text-foreground",
      };
    case "forfeit":
      return {
        text: t("publicEvent.noShowForfeit"),
        color: "text-red-600 dark:text-red-400",
      };
    case "partial":
      return {
        text: t("publicEvent.noShowPartial"),
        color: "text-amber-600 dark:text-amber-400",
      };
    default:
      return {
        text: policy,
        color: "text-foreground",
      };
  }
}

// ─── Info Item Sub-component ────────────────────────────────────────────────

function InfoItem({
  icon: Icon,
  label,
  badge,
  badgeColor,
  textColor,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  badge?: string;
  badgeColor?: string;
  textColor?: string;
}) {
  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: 12 },
        visible: { opacity: 1, y: 0 },
      }}
      className="flex items-start gap-3 rounded-xl bg-muted/50 dark:bg-muted/30 px-4 py-3"
    >
      <Icon className="h-4.5 w-4.5 text-muted-foreground mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        {badge && (
          <motion.span
            initial={badge === "FREE" ? { scale: 0 } : undefined}
            animate={badge === "FREE" ? { scale: 1 } : undefined}
            transition={
              badge === "FREE"
                ? { type: "spring", stiffness: 500, damping: 20, delay: 0.3 }
                : undefined
            }
            className={[
              "inline-flex items-center px-2 py-0.5 rounded-md text-xs-plus font-bold mb-1",
              badgeColor ?? "bg-muted text-muted-foreground",
            ].join(" ")}
          >
            {badge}
          </motion.span>
        )}
        <p
          className={[
            "text-sm leading-relaxed font-tabular",
            textColor ?? "text-foreground",
          ].join(" ")}
        >
          {label}
        </p>
      </div>
    </motion.div>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function PublicEventInfoCard({
  isFree,
  depositAmount,
  requireCheckin,
  localityRestricted,
  noShowPolicy,
  eventId,
}: PublicEventInfoCardProps) {
  const t = useTranslations("domain");
  const noShow = getNoShowLabel(noShowPolicy, t);

  return (
    <DomainSection
      title={t("publicEvent.title")}
      icon={Shield}
      accentColor="bg-gradient-to-r from-indigo-500 to-blue-500"
    >
      <div className="space-y-4">
        {/* ── Info Grid ───────────────────────────────────── */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={{ visible: { transition: { staggerChildren: 0.08 } } }}
          className="grid grid-cols-1 md:grid-cols-2 gap-2.5"
        >
          {/* Free / Deposit */}
          {isFree ? (
            <InfoItem
              icon={BadgeCheck}
              label={t("publicEvent.free")}
              badge="FREE"
              badgeColor="bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
            />
          ) : (
            <InfoItem
              icon={Banknote}
              label={t("publicEvent.deposit", {
                amount: formatCurrency(depositAmount),
              })}
              badge={t("publicEvent.depositBadge")}
              badgeColor="bg-blue-500/10 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300"
            />
          )}

          {/* Check-in */}
          {requireCheckin && (
            <InfoItem
              icon={AlertCircle}
              label={t("publicEvent.checkinRequired")}
              badge={t("publicEvent.caution")}
              badgeColor="bg-amber-500/10 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300"
            />
          )}

          {/* Locality */}
          {localityRestricted && (
            <InfoItem
              icon={MapPin}
              label={t("publicEvent.localityRestricted", {
                area: localityRestricted,
              })}
              badge={t("publicEvent.localityBadge")}
              badgeColor="bg-violet-500/10 dark:bg-violet-500/20 text-violet-700 dark:text-violet-300"
            />
          )}

          {/* No-show policy */}
          <InfoItem
            icon={FileText}
            label={noShow.text}
            textColor={noShow.color}
          />
        </motion.div>

        {/* ── Transparency Report Link ────────────────────── */}
        <div className="pt-1">
          <Link
            href={`/events/${eventId}/report`}
            className="inline-flex items-center gap-2 px-4 py-2.5 min-h-[44px] rounded-xl border border-border bg-background hover:bg-muted/60 transition-colors duration-200 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            <FileText className="h-4 w-4 text-indigo-500 group-hover:text-indigo-600 dark:text-indigo-400 dark:group-hover:text-indigo-400 transition-colors" />
            <span className="text-sm font-medium text-foreground">
              {t("publicEvent.transparencyReport")}
            </span>
            <svg
              className="h-3.5 w-3.5 text-muted-foreground group-hover:translate-x-0.5 transition-transform"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 5l7 7-7 7"
              />
            </svg>
          </Link>
        </div>
      </div>
    </DomainSection>
  );
}
