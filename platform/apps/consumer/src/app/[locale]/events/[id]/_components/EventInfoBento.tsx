"use client";

import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import type {
  EventDetail,
  SeatTier,
  SessionData,
  ParticipantSlot,
  ParticipantAssignment,
} from "@pickket/lib/api";
import { getSaleModeDescription } from "@pickket/lib";
import { CollapsibleCard } from "./CollapsibleCard";
import {
  Info,
  Music,
  Trophy,
  Palette,
  Theater,
  GraduationCap,
  Landmark,
} from "lucide-react";

const EventInfoTabs = dynamic(
  () => import("@/components/event-detail/EventInfoTabs"),
  {
    ssr: false,
    loading: () => (
      <div className="animate-pulse p-5 space-y-4">
        <div className="flex gap-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-8 w-20 rounded-md bg-muted" />
          ))}
        </div>
        <div className="space-y-3">
          <div className="h-4 bg-muted rounded w-3/4" />
          <div className="h-4 bg-muted rounded w-1/2" />
          <div className="h-4 bg-muted rounded w-2/3" />
        </div>
      </div>
    ),
  },
);
const CastingCalendar = dynamic(
  () => import("@/components/event-detail/CastingCalendar"),
);
const FestivalTimetable = dynamic(
  () => import("@/components/event-detail/FestivalTimetable"),
);
const SportsMatchSection = dynamic(
  () => import("@/components/event-detail/SportsMatchSection"),
);
const MusicalCastHighlight = dynamic(
  () => import("@/components/event-detail/MusicalCastHighlight"),
);
const ClassicalProgramCard = dynamic(
  () => import("@/components/event-detail/ClassicalProgramCard"),
);
const FestivalOverview = dynamic(
  () => import("@/components/event-detail/FestivalOverview"),
);
const ExhibitionInfoCard = dynamic(
  () => import("@/components/event-detail/ExhibitionInfoCard"),
);
const PublicEventInfoCard = dynamic(
  () => import("@/components/event-detail/PublicEventInfoCard"),
);
const ConcertArtistSection = dynamic(
  () => import("@/components/event-detail/ConcertArtistSection"),
);
const EducationInfoCard = dynamic(
  () => import("@/components/event-detail/EducationInfoCard"),
);
const CivicParticipationCard = dynamic(
  () => import("@/components/event-detail/CivicParticipationCard"),
);

interface EventInfoBentoProps {
  event: EventDetail;
  tiers: SeatTier[];
  sessions: SessionData[];
  participants: Array<{ position: string; name: string; session_id?: string }>;
  rawSlots: ParticipantSlot[];
  rawAssignments: ParticipantAssignment[];
  onSessionChange: (sessionEventId: string) => void;
}

export function EventInfoBento({
  event,
  tiers,
  sessions,
  participants,
  rawSlots,
  rawAssignments,
  onSessionChange,
}: EventInfoBentoProps) {
  const t = useTranslations("event.infoBento");
  const category = event.category;

  return (
    <>
      {/* Public sector info */}
      {event.is_public_sector && (
        <CollapsibleCard
          title={t("publicEvent")}
          icon={Landmark}
          defaultOpen
          span="full"
        >
          <PublicEventInfoCard
            isFree={event.is_free ?? false}
            depositAmount={event.deposit_amount ?? 0}
            requireCheckin={event.require_checkin ?? false}
            localityRestricted={event.locality_restricted ?? undefined}
            noShowPolicy={event.no_show_policy ?? "refund"}
            eventId={event.id}
          />
        </CollapsibleCard>
      )}

      {/* Sports */}
      {category === "sports" && event.home_team && event.away_team && (
        <CollapsibleCard
          title={t("matchInfo")}
          icon={Trophy}
          defaultOpen
          span="full"
        >
          <SportsMatchSection
            homeTeam={event.home_team}
            awayTeam={event.away_team}
            matchStatus={event.match_status}
            broadcastPlatform={event.broadcast_platform}
            broadcastUrl={event.broadcast_url}
            parkingInfo={event.parking_info}
            subCategory={event.sub_category}
            venue={event.venue}
          />
        </CollapsibleCard>
      )}

      {/* Musical cast */}
      {category === "musical" && rawAssignments.length > 0 && (
        <CollapsibleCard title={t("casting")} icon={Theater} defaultOpen span="full">
          <MusicalCastHighlight
            assignments={rawAssignments.map((a) => {
              const slot = rawSlots.find((s) => s.id === a.slot_id);
              return {
                slot_name: slot?.slot_name ?? "",
                participant_name: a.participant_name,
                participant_image_url: a.participant_image_url,
                session_date: a.session_date,
              };
            })}
            eventDate={event.event_date}
          />
        </CollapsibleCard>
      )}

      {/* Classical program */}
      {category === "classical" &&
        (event.program_data || event.program_notes) && (
          <CollapsibleCard
            title={t("program")}
            icon={Music}
            defaultOpen
            span="full"
          >
            <ClassicalProgramCard
              programData={event.program_data}
              programNotes={event.program_notes}
              artistName={event.artist_name}
              subjectName={event.subject_name ?? undefined}
            />
          </CollapsibleCard>
        )}

      {/* Festival overview */}
      {category === "festival" &&
        (rawAssignments.length > 0 ||
          event.stage_info ||
          event.event_date_end) && (
          <CollapsibleCard
            title={t("festivalOverview")}
            icon={Music}
            defaultOpen
            span="full"
          >
            <FestivalOverview
              assignments={rawAssignments.map((a) => {
                const slot = rawSlots.find((s) => s.id === a.slot_id);
                return {
                  slot_name: slot?.slot_name ?? "",
                  participant_name: a.participant_name,
                  participant_image_url: a.participant_image_url,
                  session_date: a.session_date,
                  duration_minutes: a.duration_minutes ?? undefined,
                };
              })}
              stageInfo={event.stage_info}
              eventDate={event.event_date}
              eventDateEnd={event.event_date_end ?? undefined}
            />
          </CollapsibleCard>
        )}

      {/* Exhibition */}
      {category === "exhibition" &&
        (event.event_date_end || event.artist_name) && (
          <CollapsibleCard title={t("exhibitionInfo")} icon={Palette} defaultOpen>
            <ExhibitionInfoCard
              eventDate={event.event_date}
              eventDateEnd={event.event_date_end ?? undefined}
              artistName={event.artist_name}
              durationMinutes={event.duration_minutes}
            />
          </CollapsibleCard>
        )}

      {/* Concert artist */}
      {category === "concert" && event.artist_name && (
        <CollapsibleCard title={t("artist")} icon={Music} defaultOpen>
          <ConcertArtistSection
            artistName={event.artist_name}
            artistImageUrl={event.artist_image_url}
            communityId={event.community_id}
            tags={event.tags}
            tiers={tiers.map((t) => ({ sale_mode: t.sale_mode }))}
          />
        </CollapsibleCard>
      )}

      {/* Education */}
      {category === "education" && (
        <CollapsibleCard title={t("educationInfo")} icon={GraduationCap} defaultOpen>
          <EducationInfoCard event={event} />
        </CollapsibleCard>
      )}

      {/* Civic */}
      {category === "civic" && (
        <CollapsibleCard title={t("civicGuide")} icon={Landmark} defaultOpen>
          <CivicParticipationCard event={event} />
        </CollapsibleCard>
      )}

      {/* Musical casting calendar */}
      {category === "musical" && rawSlots.length > 0 && sessions.length > 1 && (
        <CollapsibleCard title={t("castingCalendar")} icon={Theater} span="full">
          <CastingCalendar
            slots={rawSlots}
            assignments={rawAssignments}
            sessions={sessions}
            onSessionSelect={onSessionChange}
          />
        </CollapsibleCard>
      )}

      {/* Festival timetable */}
      {category === "festival" &&
        rawSlots.length > 0 &&
        rawAssignments.length > 0 && (
          <CollapsibleCard title={t("timetable")} icon={Music} span="full">
            <FestivalTimetable
              slots={rawSlots}
              assignments={rawAssignments}
              eventDateStart={event.event_date}
              eventDateEnd={event.event_date_end ?? undefined}
            />
          </CollapsibleCard>
        )}

      {/* General event info (description, notice, etc.) */}
      <CollapsibleCard title={t("eventInfo")} icon={Info} defaultOpen span="full">
        <EventInfoTabs
          event={event}
          participants={participants}
          saleModeDescription={
            tiers.length > 0
              ? getSaleModeDescription(tiers[0].sale_mode)
              : undefined
          }
        />
      </CollapsibleCard>
    </>
  );
}
