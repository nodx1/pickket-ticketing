"use client";

import { useState, useMemo } from "react";
import { useTranslations } from "next-intl";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@pickket/ui";
import { Badge } from "@pickket/ui";
import {
  Calendar,
  Car,
  Clock,
  ExternalLink as LinkIcon,
  Globe,
  MapPin,
  Music,
  Train,
  Tv,
} from "lucide-react";
import { getDomainLabels, getOrganizerLabels } from "@pickket/lib";
import {
  EventInfoTabsEvent,
  formatPeriod,
  getFaqItems,
} from "@/components/event-detail/eventInfoTabUtils";

interface EventInfoTabsProps {
  event: EventInfoTabsEvent;
  participants?: Array<{ position: string; name: string; session_id?: string }>;
  saleModeDescription?: string;
}

export default function EventInfoTabs({
  event,
  participants,
  saleModeDescription,
}: EventInfoTabsProps) {
  const t = useTranslations("event.infoTabs");
  const [descExpanded, setDescExpanded] = useState(false);

  const parsedTags = useMemo(() => {
    if (!event.tags) return [];
    try {
      const parsed: unknown = JSON.parse(event.tags);
      if (Array.isArray(parsed)) {
        return parsed.filter((t): t is string => typeof t === "string");
      }
    } catch {
      // ignore parse errors
    }
    return [];
  }, [event.tags]);

  const orgLabels = useMemo(
    () => getOrganizerLabels(event.category),
    [event.category],
  );
  const structuredProgram = useMemo(
    () => (Array.isArray(event.program_data) ? event.program_data : []),
    [event.program_data],
  );

  const infoGridItems = useMemo(() => {
    const items: { label: string; value: string }[] = [];

    if (event.subject_name || event.artist_name) {
      items.push({
        label: getDomainLabels(event.category).subjectLabel,
        value: event.subject_name || event.artist_name || "",
      });
    }

    // 온라인 이벤트는 물리 장소를 노출하지 않는다(온라인 표기로 전환).
    if (!event.is_online) {
      items.push({
        label: orgLabels.venueLabel,
        value: event.location_city
          ? `${event.venue ?? ""} · ${event.location_city}`
          : (event.venue ?? ""),
      });
    }

    if (event.duration_minutes) {
      items.push({
        label: orgLabels.durationLabel,
        value: t("durationValue", { minutes: event.duration_minutes ?? 0 }),
      });
    }

    // 관람연령 — go 정본 age_rating 우선, 없으면 기존 age_restriction 폴백.
    const ageValue = event.age_rating?.trim() || event.age_restriction?.trim();
    if (ageValue) {
      items.push({
        label: orgLabels.ageRatingLabel,
        value: ageValue,
      });
    }

    return items;
  }, [event, orgLabels, t]);

  const cat = event.category?.toLowerCase();
  const isSports = cat === "sports";
  const isClassical = cat === "classical";
  const isMusical = cat === "musical";
  const isFestival = cat === "festival";
  const hasParticipants = participants && participants.length > 0;
  const hasStructuredProgram = isClassical && structuredProgram.length > 0;
  const hasProgram =
    isClassical && (hasStructuredProgram || !!event.program_notes);

  // Group participants by position (for festival lineup rendering)
  const groupedParticipants = useMemo(() => {
    if (!participants || !isFestival) return null;
    return participants.reduce<Record<string, string[]>>((acc, p) => {
      if (!acc[p.position]) acc[p.position] = [];
      acc[p.position].push(p.name);
      return acc;
    }, {});
  }, [participants, isFestival]);

  return (
    <div className="bg-card/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.2)] p-5 lg:p-6">
      <Tabs defaultValue="info">
        <TabsList
          className="overflow-x-auto flex-nowrap scrollbar-hide"
          aria-label={t("tabsAriaLabel")}
        >
          <TabsTrigger value="info">{orgLabels.infoTabLabel}</TabsTrigger>
          <TabsTrigger value="guide">{t("tabGuide")}</TabsTrigger>
          {hasParticipants && (
            <TabsTrigger value="cast">{orgLabels.participantLabel}</TabsTrigger>
          )}
          {hasProgram && <TabsTrigger value="program">{t("tabProgram")}</TabsTrigger>}
          <TabsTrigger value="venue">{t("tabVenue", { venueLabel: orgLabels.venueLabel ?? "" })}</TabsTrigger>
        </TabsList>

        {/* Tab 1: 공연 정보 */}
        <TabsContent value="info" className="mt-4 space-y-5">
          {/* 온라인 이벤트 배지 + 공식 홈페이지 (go→v2, U1). 없으면 미노출. */}
          {(event.is_online || event.homepage_url?.trim()) && (
            <div className="flex flex-wrap items-center gap-2">
              {event.is_online && (
                <Badge
                  variant="secondary"
                  className="gap-1 text-xs bg-primary/10 text-primary"
                >
                  <Globe className="h-3.5 w-3.5" />
                  {t("onlineEvent")}
                </Badge>
              )}
              {event.homepage_url?.trim() && (
                <a
                  href={event.homepage_url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-xs font-medium text-primary hover:bg-primary/5 transition-colors"
                >
                  <LinkIcon className="h-3.5 w-3.5" />
                  {t("officialHomepage")}
                </a>
              )}
            </div>
          )}

          {/* Description */}
          {event.description && (
            <div>
              <div
                id="event-description"
                className={descExpanded ? "" : "line-clamp-3"}
              >
                <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line">
                  {event.description}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDescExpanded((prev) => !prev)}
                className="mt-2 py-2 px-3 text-xs font-medium text-primary hover:underline"
                aria-expanded={descExpanded}
                aria-controls="event-description"
              >
                {descExpanded ? t("collapse") : t("expand")}
              </button>
            </div>
          )}

          {/* Exhibition/Festival period */}
          {/* formatPeriod 는 단일일(시작=종료)이면 "" 를 돌려준다 — 그 경우 기간 블록을 통째로
              숨긴다(레벨2 컷오버로 event_date_end 가 항상 채워지기 때문). */}
          {(cat === "exhibition" || cat === "festival") &&
            event.event_date_end &&
            formatPeriod(
              event.event_date ?? undefined,
              event.event_date_end ?? undefined,
            ) !== "" && (
              <div className="bg-primary/5 dark:bg-primary/10 rounded-xl p-3 flex items-center gap-3">
                <Calendar className="h-4 w-4 text-primary shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t("exhibitionPeriod")}
                  </p>
                  <p className="text-sm font-medium text-foreground">
                    {formatPeriod(
                      event.event_date ?? undefined,
                      event.event_date_end ?? undefined,
                    )}
                  </p>
                </div>
              </div>
            )}

          {/* Info grid */}
          {infoGridItems.length > 0 && (
            <div className="grid grid-cols-2 gap-3">
              {infoGridItems.map((item) => (
                <div key={item.label} className="bg-muted rounded-xl p-3">
                  <p className="text-xs-plus text-muted-foreground mb-0.5">
                    {item.label}
                  </p>
                  <p className="text-sm font-medium text-foreground">
                    {item.value}
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* Tags */}
          {parsedTags.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {parsedTags.map((tag) => (
                <Badge key={tag} variant="secondary" className="text-xs">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Tab 2: 예매 안내 */}
        <TabsContent value="guide" className="mt-4 space-y-2">
          {getFaqItems(orgLabels.verifyMessage).map((faq) => {
            const content = faq.useDescription
              ? saleModeDescription || t("saleModeDescriptionFallback")
              : faq.content;

            return (
              <details
                key={faq.id}
                className="rounded-xl border border-border px-4 py-3 group"
              >
                <summary className="cursor-pointer font-medium text-sm text-foreground list-none flex items-center justify-between">
                  {faq.summary}
                  <span className="text-muted-foreground transition-transform motion-reduce:transition-none group-open:rotate-180">
                    &#9662;
                  </span>
                </summary>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                  {content}
                </p>
              </details>
            );
          })}
        </TabsContent>

        {/* Tab 3: 참여자/캐스트/아티스트/선수단/라인업 (all domains with participants) */}
        {hasParticipants && (
          <TabsContent value="cast" className="mt-4 space-y-4">
            {/* Festival: grouped by stage */}
            {isFestival && groupedParticipants ? (
              <div className="space-y-4">
                {Object.entries(groupedParticipants).map(([stage, artists]) => (
                  <div key={stage}>
                    <h4 className="text-xs font-semibold text-primary mb-2">
                      {stage}
                    </h4>
                    <div className="flex flex-wrap gap-2">
                      {artists.map((name) => (
                        <Badge key={name} variant="secondary">
                          {name}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : isMusical ? (
              /* Musical: theatrical layout with character header */
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-muted-foreground mb-1">
                  {t("characterHeader")}
                </h4>
                {participants.map((p, idx) => (
                  <div
                    key={`${p.position}-${p.name}-${idx}`}
                    className="flex items-center gap-3 bg-muted rounded-xl px-4 py-3"
                  >
                    <span className="text-sm text-muted-foreground min-w-[80px] shrink-0">
                      {p.position}
                    </span>
                    <span className="text-sm font-medium text-foreground">
                      &mdash; {p.name}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              /* Default: position — name list (concert, classical, sports, exhibition) */
              <div className="space-y-2">
                {participants.map((p, idx) => (
                  <div
                    key={`${p.position}-${p.name}-${idx}`}
                    className="flex items-center gap-3 bg-muted rounded-xl px-4 py-3"
                  >
                    <span className="text-sm text-muted-foreground min-w-[80px] shrink-0">
                      {p.position}
                    </span>
                    <span className="text-sm font-medium text-foreground">
                      &mdash; {p.name}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>
        )}

        {/* Tab 4: 프로그램 (classical only) */}
        {hasProgram && (
          <TabsContent value="program" className="mt-4 space-y-4">
            {hasStructuredProgram ? (
              <div className="space-y-3">
                {structuredProgram.map((piece, idx) => (
                  <div key={`${piece.composer}-${piece.title}`}>
                    {/* Intermission divider between pieces */}
                    {idx > 0 && (
                      <div className="flex items-center gap-3 py-3">
                        <div className="flex-1 border-t border-dashed border-border" />
                        <span className="text-xs text-muted-foreground font-medium px-2">
                          {t("intermission")}
                        </span>
                        <div className="flex-1 border-t border-dashed border-border" />
                      </div>
                    )}
                    <div className="bg-muted rounded-xl px-4 py-4 space-y-2">
                      {/* Piece number + composer */}
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-primary shrink-0">
                          {idx + 1}.
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {piece.composer}
                        </span>
                      </div>
                      {/* Title */}
                      <p className="text-sm font-semibold text-foreground pl-5">
                        {piece.title}
                      </p>
                      {/* Movements */}
                      {piece.movements && piece.movements.length > 0 && (
                        <ul className="pl-8 space-y-0.5">
                          {piece.movements.map((mov, mIdx) => (
                            <li
                              key={`${piece.title}-${mIdx}-${mov}`}
                              className="text-xs text-muted-foreground leading-relaxed"
                            >
                              {mov}
                            </li>
                          ))}
                        </ul>
                      )}
                      {/* Soloist */}
                      {piece.soloist && (
                        <p className="text-xs text-primary/80 pl-5 pt-1">
                          {t("soloist", { name: piece.soloist ?? "" })}
                        </p>
                      )}
                      {/* Duration */}
                      {piece.duration_min != null && (
                        <div className="flex items-center gap-1.5 pl-5 pt-1">
                          <Clock className="h-3 w-3 text-muted-foreground" />
                          <span className="text-xs text-muted-foreground">
                            {t("pieceDuration", { minutes: piece.duration_min ?? 0 })}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {/* Total duration */}
                {structuredProgram.some((p) => p.duration_min != null) && (
                  <div className="flex items-center justify-end gap-1.5 pt-2 pr-1">
                    <Music className="h-3.5 w-3.5 text-primary" />
                    <span className="text-xs font-medium text-primary">
                      {t("totalDuration", {
                        minutes: structuredProgram.reduce(
                          (sum, p) => sum + (p.duration_min ?? 0),
                          0,
                        ),
                      })}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              /* Fallback: plain text program_notes */
              <div className="space-y-2">
                {event
                  .program_notes!.split("\n")
                  .filter((line) => line.trim())
                  .map((line, idx) => (
                    <div
                      key={line.trim()}
                      className="flex items-start gap-3 bg-muted rounded-xl px-4 py-3"
                    >
                      <span className="text-sm font-semibold text-primary shrink-0 min-w-[24px]">
                        {idx + 1}.
                      </span>
                      <span className="text-sm text-foreground leading-relaxed">
                        {line.trim()}
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </TabsContent>
        )}

        {/* Tab 5: 장소/경기장/전시관/축제장 안내 (all domains) */}
        <TabsContent value="venue" className="mt-4 space-y-4">
          {/* 온라인 이벤트 — 물리 장소/오시는길 대신 온라인 안내로 전환 (U1) */}
          {event.is_online ? (
            <div className="flex items-start gap-3 bg-primary/5 dark:bg-primary/10 rounded-xl p-4">
              <Globe className="h-5 w-5 text-primary mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {t("onlineEvent")}
                </p>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                  {t("onlineVenueHint")}
                </p>
                {event.homepage_url?.trim() && (
                  <a
                    href={event.homepage_url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                  >
                    <LinkIcon className="h-3.5 w-3.5" />
                    {t("officialHomepage")}
                  </a>
                )}
              </div>
            </div>
          ) : (
            /* 오프라인 — 장소명 + 주소 라인 (venue_address, U1) */
            (event.venue || event.venue_address?.trim()) && (
              <div className="flex items-start gap-3 bg-muted rounded-xl p-4">
                <MapPin className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                <div className="min-w-0">
                  {event.venue && (
                    <p className="text-sm font-semibold text-foreground">
                      {event.venue}
                      {event.location_city ? ` · ${event.location_city}` : ""}
                    </p>
                  )}
                  {event.venue_address?.trim() && (
                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed break-words">
                      {event.venue_address}
                    </p>
                  )}
                  {event.venue_address?.trim() && (
                    <a
                      href={`https://map.kakao.com/?q=${encodeURIComponent(event.venue_address)}`}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                    >
                      <MapPin className="h-3.5 w-3.5" />
                      {t("openMap")}
                    </a>
                  )}
                </div>
              </div>
            )
          )}

          {/* Match info (sports only) */}
          {isSports && event.home_team && event.away_team && (
            <div className="bg-muted rounded-xl p-4 text-center">
              <div className="flex items-center justify-center gap-3">
                <span className="text-base font-bold text-foreground">
                  {event.home_team}
                </span>
                <span className="text-xs font-semibold text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                  VS
                </span>
                <span className="text-base font-bold text-foreground">
                  {event.away_team}
                </span>
              </div>
              {event.match_status && (
                <p className="text-xs text-muted-foreground mt-2">
                  {event.match_status}
                </p>
              )}
            </div>
          )}

          {/* Broadcast info (sports only) */}
          {isSports && event.broadcast_url && (
            <div className="flex items-start gap-3 bg-muted rounded-xl p-3">
              <Tv className="h-4 w-4 text-primary mt-0.5 shrink-0" />
              <div>
                <p className="text-xs text-muted-foreground">{t("broadcastInfo")}</p>
                <p className="text-sm font-medium text-foreground">
                  {event.broadcast_platform || t("broadcastOnline")}
                </p>
              </div>
            </div>
          )}

          {/* Stage info (festival only) */}
          {isFestival && event.stage_info && (
            <div className="bg-muted rounded-xl p-4">
              <h4 className="text-xs font-semibold text-primary mb-2">
                {t("stageInfo")}
              </h4>
              <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line">
                {event.stage_info}
              </p>
            </div>
          )}

          {/* Parking info */}
          {event.parking_info && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Car className="h-4 w-4 text-primary" />
                <span className="text-sm font-semibold text-foreground">
                  {t("parkingInfo")}
                </span>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line pl-6">
                {event.parking_info}
              </p>
            </div>
          )}

          {/* Transit hint — 오프라인 이벤트에만 */}
          {!event.is_online && (
            <div className="flex items-start gap-3 bg-primary/5 dark:bg-primary/10 rounded-xl p-3">
              <Train className="h-4 w-4 text-primary mt-0.5 shrink-0" />
              <p className="text-xs text-muted-foreground">
                {t("transitHint", { venueLabel: orgLabels.venueLabel ?? "" })}
              </p>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
