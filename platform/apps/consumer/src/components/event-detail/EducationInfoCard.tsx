"use client";

import { BookOpen, Clock3, MessageSquareText, Users } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import type { EventDetail } from "@pickket/lib/api";

import DomainSection from "./DomainSection";

interface CurriculumItem {
  week?: number;
  title?: string;
  description?: string;
}

interface EducationInfoCardProps {
  event: EventDetail;
}

function getCurriculum(
  programData: EventDetail["program_data"],
): CurriculumItem[] {
  if (
    !programData ||
    Array.isArray(programData) ||
    typeof programData !== "object"
  ) {
    return [];
  }
  const raw = (programData as { curriculum?: CurriculumItem[] }).curriculum;
  return Array.isArray(raw) ? raw : [];
}

export default function EducationInfoCard({ event }: EducationInfoCardProps) {
  const t = useTranslations("domain");
  const locale = useLocale();
  const curriculum = getCurriculum(event.program_data);
  const instructor = event.artist_name || event.subject_name;
  const numberFormatter = new Intl.NumberFormat(locale);

  if (
    !instructor &&
    !event.age_restriction &&
    !event.duration_minutes &&
    !event.total_seats &&
    curriculum.length === 0
  ) {
    return null;
  }

  return (
    <DomainSection
      title={t("education.title")}
      iconSrc="/icons/categories/education.svg"
      accentColor="bg-gradient-to-r from-sky-500 to-cyan-500"
    >
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          {instructor && (
            <div
              className="rounded-2xl bg-muted/50 px-4 py-3"
              aria-label={`${t("education.instructor")}: ${instructor}`}
            >
              <p className="text-xs text-muted-foreground">
                {t("education.instructor")}
              </p>
              <p className="mt-1 text-sm font-semibold text-foreground">
                {instructor}
              </p>
            </div>
          )}
          {event.age_restriction && (
            <div
              className="rounded-2xl bg-muted/50 px-4 py-3"
              aria-label={`${t("education.target")}: ${event.age_restriction}`}
            >
              <p className="text-xs text-muted-foreground">
                {t("education.target")}
              </p>
              <p className="mt-1 text-sm font-semibold text-foreground">
                {event.age_restriction}
              </p>
            </div>
          )}
          {event.duration_minutes && (
            <div
              className="rounded-2xl bg-muted/50 px-4 py-3"
              aria-label={`${t("education.duration")}: ${numberFormatter.format(event.duration_minutes)}`}
            >
              <p className="text-xs text-muted-foreground">
                {t("education.duration")}
              </p>
              <p className="mt-1 flex items-center gap-2 text-sm font-semibold text-foreground">
                <Clock3 className="h-4 w-4 text-primary" />
                {numberFormatter.format(event.duration_minutes)}
              </p>
            </div>
          )}
          {event.total_seats > 0 && (
            <div
              className="rounded-2xl bg-muted/50 px-4 py-3"
              aria-label={`${t("education.capacity")}: ${numberFormatter.format(event.total_seats)}`}
            >
              <p className="text-xs text-muted-foreground">
                {t("education.capacity")}
              </p>
              <p className="mt-1 flex items-center gap-2 text-sm font-semibold text-foreground">
                <Users className="h-4 w-4 text-primary" />
                {numberFormatter.format(event.total_seats)}
              </p>
            </div>
          )}
        </div>

        {curriculum.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-primary" />
              <h4 className="text-sm font-semibold text-foreground">
                {t("education.curriculum")}
              </h4>
            </div>
            <div
              className="space-y-2"
              role="list"
              aria-label={t("education.curriculum")}
            >
              {curriculum.map((item, index) => (
                <div
                  key={`${item.week ?? index}-${item.title ?? "curriculum"}`}
                  role="listitem"
                  className="rounded-2xl border border-border bg-background px-4 py-3"
                >
                  <p className="text-xs font-semibold text-primary">
                    {t("education.week", { n: item.week ?? index + 1 })}
                  </p>
                  <p className="mt-1 text-sm font-semibold text-foreground">
                    {item.title || "-"}
                  </p>
                  {item.description && (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {item.description}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          onClick={() => {
            document
              .getElementById("reviews-section")
              ?.scrollIntoView({ behavior: "smooth" });
          }}
        >
          <MessageSquareText className="h-4 w-4 text-primary" />
          {t("education.reviews")}
        </button>
      </div>
    </DomainSection>
  );
}
