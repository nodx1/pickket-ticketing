"use client";

import { Gift, Landmark, Mail, Phone, ScrollText } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import type { EventDetail } from "@pickket/lib/api";

import DomainSection from "./DomainSection";

interface CivicProgramData {
  benefits?: string[];
  requirements?: string[];
}

interface CivicParticipationCardProps {
  event: EventDetail;
}

function formatDateTime(locale: string, value?: string | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleString(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getProgramData(
  programData: EventDetail["program_data"],
): CivicProgramData {
  if (
    !programData ||
    Array.isArray(programData) ||
    typeof programData !== "object"
  ) {
    return {};
  }
  return programData as CivicProgramData;
}

export default function CivicParticipationCard({
  event,
}: CivicParticipationCardProps) {
  const t = useTranslations("domain");
  const locale = useLocale();
  const { benefits = [], requirements = [] } = getProgramData(
    event.program_data,
  );
  const howToJoin = (event.program_notes || event.description || "").trim();
  const organizerName = event.organizer_name || t("civic.organizer");
  const contact = [
    event.organizer_contact_email,
    event.organizer_contact_phone,
  ].filter(Boolean);

  if (
    !howToJoin &&
    benefits.length === 0 &&
    requirements.length === 0 &&
    contact.length === 0
  ) {
    return null;
  }

  return (
    <DomainSection
      title={t("civic.title")}
      iconSrc="/icons/categories/civic.svg"
      accentColor="bg-gradient-to-r from-emerald-500 to-teal-500"
    >
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div
            className="rounded-2xl bg-muted/50 px-4 py-3"
            aria-label={`${t("civic.organizer")}: ${organizerName}`}
          >
            <p className="text-xs text-muted-foreground">
              {t("civic.organizer")}
            </p>
            <p className="mt-1 text-sm font-semibold text-foreground">
              {organizerName}
            </p>
          </div>
          <div
            className="rounded-2xl bg-muted/50 px-4 py-3"
            aria-label={`${t("civic.period")}: ${formatDateTime(locale, event.bidding_opens_at)} ~ ${formatDateTime(locale, event.bidding_closes_at)}`}
          >
            <p className="text-xs text-muted-foreground">{t("civic.period")}</p>
            <p className="mt-1 text-sm font-semibold text-foreground">
              {formatDateTime(locale, event.bidding_opens_at)} ~{" "}
              {formatDateTime(locale, event.bidding_closes_at)}
            </p>
          </div>
        </div>

        {howToJoin && (
          <div
            className="rounded-2xl border border-border bg-background px-4 py-3"
            aria-label={t("civic.howToJoin")}
          >
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <ScrollText className="h-4 w-4 text-primary" />
              {t("civic.howToJoin")}
            </div>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {howToJoin}
            </p>
          </div>
        )}

        {benefits.length > 0 && (
          <div
            className="rounded-2xl border border-border bg-background px-4 py-3"
            aria-label={t("civic.benefits")}
          >
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Gift className="h-4 w-4 text-primary" />
              {t("civic.benefits")}
            </div>
            <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
              {benefits.map((benefit) => (
                <li key={benefit}>• {benefit}</li>
              ))}
            </ul>
          </div>
        )}

        {requirements.length > 0 && (
          <div
            className="rounded-2xl border border-border bg-background px-4 py-3"
            aria-label={t("civic.requirements")}
          >
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Landmark className="h-4 w-4 text-primary" />
              {t("civic.requirements")}
            </div>
            <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
              {requirements.map((requirement) => (
                <li key={requirement}>• {requirement}</li>
              ))}
            </ul>
          </div>
        )}

        {contact.length > 0 && (
          <div
            className="rounded-2xl border border-border bg-background px-4 py-3"
            aria-label={t("civic.contact")}
          >
            <div className="text-sm font-semibold text-foreground">
              {t("civic.contact")}
            </div>
            <div className="mt-2 space-y-1 text-sm text-muted-foreground">
              {event.organizer_contact_email && (
                <p className="flex items-center gap-2">
                  <Mail className="h-4 w-4 text-primary" />
                  {event.organizer_contact_email}
                </p>
              )}
              {event.organizer_contact_phone && (
                <p className="flex items-center gap-2">
                  <Phone className="h-4 w-4 text-primary" />
                  {event.organizer_contact_phone}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </DomainSection>
  );
}
