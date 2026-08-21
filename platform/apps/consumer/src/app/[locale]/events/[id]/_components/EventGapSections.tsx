"use client";

import { useTranslations } from "next-intl";
import { Clock, CalendarClock, MapPin, ClipboardList } from "lucide-react";
import type { EventDetail } from "@pickket/lib/api";
import { CollapsibleCard } from "./CollapsibleCard";

interface EventGapSectionsProps {
  event: EventDetail;
}

/**
 * Phase 1-C: go 랜딩에만 있던 상세 콘텐츠를 consumer 상세에 렌더.
 * v2 EventResponse 신규 갭 필드(event_schedules / transport_info / parking_info /
 * runtime_minutes / intermission_minutes / questions)를 읽어 표시.
 * 각 섹션은 데이터가 없으면(null/빈배열) 미표시 — 기존 렌더 불변, 가산적.
 */
export function EventGapSections({ event }: EventGapSectionsProps) {
  const t = useTranslations("event.gapSections");

  // 타임테이블 — 최소 1개 유효 항목이 있을 때만 표시
  const schedules = (event.event_schedules ?? []).filter(
    (s) => s && (s.time || s.title || s.description),
  );
  const hasSchedules = schedules.length > 0;

  // 공연시간 · 인터미션
  const runtime =
    typeof event.runtime_minutes === "number" && event.runtime_minutes > 0
      ? event.runtime_minutes
      : null;
  const intermission =
    typeof event.intermission_minutes === "number" &&
    event.intermission_minutes > 0
      ? event.intermission_minutes
      : null;
  const hasRuntime = runtime !== null || intermission !== null;

  // 오시는 길 · 주차 (sports 카테고리는 EventInfoBento 의 경기정보 섹션이 이미 parking 을
  // 노출하므로 중복 방지 위해 여기선 transport 만; 그 외 카테고리는 둘 다 표시)
  const transport = event.transport_info?.trim() || null;
  const parking =
    event.category === "sports" ? null : event.parking_info?.trim() || null;
  const hasLocation = Boolean(transport || parking);

  // 예매 설문 안내 (상세엔 안내만 — 실제 입력은 체크아웃)
  const questions = (event.questions ?? []).filter((q) => q && q.label);
  const hasQuestions = questions.length > 0;

  if (!hasSchedules && !hasRuntime && !hasLocation && !hasQuestions) {
    return null;
  }

  return (
    <>
      {/* 일정 · 타임테이블 */}
      {hasSchedules && (
        <CollapsibleCard
          title={t("schedule")}
          icon={CalendarClock}
          defaultOpen
          span="full"
        >
          <ol className="space-y-3">
            {schedules.map((s, i) => (
              <li
                key={i}
                className="flex gap-3 rounded-xl border border-border/60 bg-muted/30 px-4 py-3"
              >
                {s.time ? (
                  <span className="shrink-0 text-sm font-bold text-primary tabular-nums">
                    {s.time}
                  </span>
                ) : null}
                <div className="min-w-0">
                  {s.title ? (
                    <p className="text-sm font-semibold text-foreground">
                      {s.title}
                    </p>
                  ) : null}
                  {s.description ? (
                    <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed whitespace-pre-line">
                      {s.description}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </CollapsibleCard>
      )}

      {/* 공연시간 · 인터미션 */}
      {hasRuntime && (
        <CollapsibleCard title={t("runtime")} icon={Clock} defaultOpen>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {runtime !== null && (
              <div className="rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
                <dt className="text-xs text-muted-foreground">
                  {t("runtimeLabel")}
                </dt>
                <dd className="mt-0.5 text-sm font-semibold text-foreground">
                  {t("minutes", { count: runtime })}
                </dd>
              </div>
            )}
            {intermission !== null && (
              <div className="rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
                <dt className="text-xs text-muted-foreground">
                  {t("intermissionLabel")}
                </dt>
                <dd className="mt-0.5 text-sm font-semibold text-foreground">
                  {t("minutes", { count: intermission })}
                </dd>
              </div>
            )}
          </dl>
        </CollapsibleCard>
      )}

      {/* 오시는 길 · 주차 */}
      {hasLocation && (
        <CollapsibleCard
          title={t("location")}
          icon={MapPin}
          defaultOpen
          span="full"
        >
          <div className="space-y-4">
            {transport ? (
              <div>
                <h4 className="text-sm font-semibold text-foreground mb-1">
                  {t("transportLabel")}
                </h4>
                <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line">
                  {transport}
                </p>
              </div>
            ) : null}
            {parking ? (
              <div>
                <h4 className="text-sm font-semibold text-foreground mb-1">
                  {t("parkingLabel")}
                </h4>
                <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line">
                  {parking}
                </p>
              </div>
            ) : null}
          </div>
        </CollapsibleCard>
      )}

      {/* 예매 설문 안내 (상세엔 안내만 — 실제 응답은 예매 단계) */}
      {hasQuestions && (
        <CollapsibleCard title={t("questions")} icon={ClipboardList}>
          <p className="text-xs text-muted-foreground mb-3">
            {t("questionsNotice")}
          </p>
          <ul className="space-y-2">
            {questions.map((q, i) => (
              <li
                key={i}
                className="flex items-start gap-2 text-sm text-foreground"
              >
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" />
                <span>
                  {q.label}
                  {q.required ? (
                    <span className="ml-1 text-xs font-medium text-primary">
                      {t("questionRequired")}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </CollapsibleCard>
      )}
    </>
  );
}
