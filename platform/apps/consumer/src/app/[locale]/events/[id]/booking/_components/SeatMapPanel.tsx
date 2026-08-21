"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import { useTranslations } from "next-intl";
import { MapPin } from "lucide-react";
import {
  type VenueData,
  type SeatTier,
  type SeatData,
  type EventDetail,
  getEventSeats,
} from "@pickket/lib/api";
import VenueMap from "@/components/booking/VenueMap";
import SectionDetail from "@/components/booking/SectionDetail";
import BestAvailableButton from "@/components/booking/BestAvailableButton";

interface SeatMapPanelProps {
  eventId: string;
  venue: VenueData | null;
  tiers: SeatTier[];
  selectedTier: SeatTier | null;
  selectedSeats: SeatData[];
  quantity: number;
  onSelectTier: (tierId: string) => void;
  onToggleSeat: (seat: SeatData) => void;
  onSetSelectedSeats: (seats: SeatData[]) => void;
  category?: string;
  homeTeam?: string;
  awayTeam?: string;
  eventImageUrl?: string | null;
  eventTitle?: string;
  seatSelectionActive?: boolean;
  onExitSeatSelection?: () => void;
  event?: EventDetail | null;
  /** 부모(useEventData)가 이미 로드한 좌석. 있으면 여기서 재fetch 하지 않음. */
  preloadedSeats?: SeatData[];
  /** 추첨 이벤트면 true — 구역 클릭 시 좌석 선택 대신 응모 모달 트리거 */
  lotteryMode?: boolean;
  /** 추첨 모드에서 구역 클릭 시 부모에게 알림 */
  onSectionClickForLottery?: (args: {
    sectionName: string;
    tierId: string;
  }) => void;
}

export default function SeatMapPanel({
  eventId,
  venue,
  tiers,
  selectedTier,
  selectedSeats,
  onSelectTier,
  onToggleSeat,
  onSetSelectedSeats,
  category,
  homeTeam,
  awayTeam,
  seatSelectionActive,
  onExitSeatSelection,
  preloadedSeats,
  lotteryMode,
  onSectionClickForLottery,
}: SeatMapPanelProps) {
  const t = useTranslations("booking.seatMapPanel");
  const [fetchedSeats, setFetchedSeats] = useState<SeatData[]>([]);
  // 부모가 preloadedSeats 를 주면 그걸 쓰고, 아니면 자체 fetch 결과를 씀 (중복 호출 방지)
  const allSeats = preloadedSeats ?? fetchedSeats;
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(
    null,
  );
  const [loadingSeats, setLoadingSeats] = useState(false);

  // venue가 API에서 올 때까지 대기 — fallback 생성하지 않음 (깜빡임 방지)
  const effectiveVenue = venue;

  useEffect(() => {
    setSelectedSectionId(null);
  }, [selectedTier?.id]);

  // 좌석 로드 — 부모가 preloadedSeats 를 주면 자체 fetch 스킵 (중복 호출 방지).
  // preloadedSeats 없을 때만 여기서 직접 로드. selectedTier 는 deps 아님.
  // 취소/네트워크 에러 시 fallback 안 씀 (취소 시 fallback → 피그마 5×8 대신 4×10 버그).
  useEffect(() => {
    if (preloadedSeats !== undefined) {
      setLoadingSeats(false);
      return;
    }
    if (!effectiveVenue) {
      setFetchedSeats([]);
      setLoadingSeats(false);
      return;
    }
    let cancelled = false;
    setLoadingSeats(true);
    getEventSeats(eventId)
      .then((res) => {
        if (cancelled) return;
        const data = Array.isArray(res.data) ? res.data : [];
        setFetchedSeats(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const name = (err as { name?: string } | null)?.name;
        if (name === "CanceledError" || name === "AbortError") return;
        setFetchedSeats([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingSeats(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, effectiveVenue, preloadedSeats]);

  // 섹션별 재고 + 해당 섹션의 tier 정보 — 모든 tier 를 대상으로 계산
  const sectionAvailability = useMemo(() => {
    if (!effectiveVenue) return {};
    const map: Record<
      string,
      { total: number; available: number; tierName: string; price: number }
    > = {};
    for (const section of effectiveVenue.sections) {
      // stage/console은 비좌석 장식 블록 — availability 계산 대상 아님
      const kind = section.kind ?? "assigned";
      if (kind === "stage" || kind === "console") continue;
      const sectionSeats = allSeats.filter((s) => s.section === section.name);
      if (sectionSeats.length > 0) {
        // assigned: seats 테이블 기반
        const sampleSeat = sectionSeats[0];
        const tier = tiers.find((t) => t.id === sampleSeat.tier_id);
        map[section.id] = {
          total: sectionSeats.length,
          available: sectionSeats.filter((s) => s.status === "available")
            .length,
          tierName: tier?.name ?? "-",
          price: tier?.face_price ?? tier?.base_price ?? 0,
        };
      } else {
        // standing: seats 레코드 없음 → tier.capacity 기반
        // 매칭 우선순위: 이름 일치 → section_name 일치 → standing tier (seating_type 기반)
        const tier =
          tiers.find((t) => t.name === section.name) ??
          tiers.find((t) => t.section_name === section.name) ??
          (section.kind === "standing"
            ? tiers.find((t) => t.seating_type === "standing")
            : undefined);
        if (tier) {
          // standing tier 하나에 여러 섹션 → capacity를 섹션 수로 나누거나 섹션 자체 capacity 사용
          const sectionCap = section.capacity || tier.capacity;
          const remaining = sectionCap - (tier.sold_count ?? 0);
          map[section.id] = {
            total: sectionCap,
            available: Math.max(0, remaining),
            tierName: tier.name,
            price: tier.face_price ?? tier.base_price ?? 0,
          };
        }
      }
    }
    return map;
  }, [effectiveVenue, allSeats, tiers]);

  // 좌석이 있는 섹션 목록
  const sectionsWithSeats = useMemo(() => {
    return Object.keys(sectionAvailability);
  }, [sectionAvailability]);

  // 좌석 선택에서 보여줄 섹션: selectedSectionId가 있으면 그것, 없으면 첫 번째 섹션
  const activeSectionId = selectedSectionId ?? sectionsWithSeats[0] ?? null;
  const activeSectionData = effectiveVenue?.sections.find(
    (s) => s.id === activeSectionId,
  );
  const activeSectionSeats = useMemo(() => {
    if (!activeSectionId || !effectiveVenue) return [];
    const section = effectiveVenue.sections.find(
      (s) => s.id === activeSectionId,
    );
    if (!section) return [];
    return allSeats.filter((s) => s.section === section.name);
  }, [activeSectionId, effectiveVenue, allSeats]);

  const handleBack = useCallback(() => {
    setSelectedSectionId(null);
    onExitSeatSelection?.();
  }, [onExitSeatSelection]);

  const handleSelectRange = useCallback(
    (rangeSeats: SeatData[]) => {
      if (!selectedTier) return;
      const maxGroup = selectedTier.max_group_size ?? 4;
      const currentIds = new Set(selectedSeats.map((s) => s.id));
      const newSeats = rangeSeats.filter((s) => !currentIds.has(s.id));
      const canAdd = maxGroup - selectedSeats.length;
      const toAdd = newSeats.slice(0, Math.max(0, canAdd));
      if (toAdd.length > 0) {
        onSetSelectedSeats([...selectedSeats, ...toAdd]);
      }
    },
    [selectedSeats, selectedTier, onSetSelectedSeats],
  );

  /* 섹션 클릭 핸들러 — 일반: tier 자동선택 + 좌석선택 모드, 추첨(lotteryMode): 응모 모달 트리거.
   * ⚠️ Hook 규칙: 아래 조건부 early-return 보다 반드시 위에 선언해야 렌더마다 호출 순서가 동일하다. */
  const handleSelectSection = useCallback(
    (sectionId: string) => {
      if (!effectiveVenue) return;
      const section = effectiveVenue.sections.find((s) => s.id === sectionId);
      if (!section) return;
      // 섹션 → tier 매칭: 이름 → section_name → 좌석의 tier_id → standing kind
      const sampleSeat = allSeats.find((s) => s.section === section.name);
      const tier =
        tiers.find((t) => t.name === section.name) ??
        tiers.find((t) => t.section_name === section.name) ??
        tiers.find((t) => t.id === sampleSeat?.tier_id) ??
        (section.kind === "standing"
          ? tiers.find((t) => t.seating_type === "standing")
          : undefined);
      if (!tier) return;

      if (lotteryMode) {
        onSectionClickForLottery?.({
          sectionName: section.name,
          tierId: tier.id,
        });
        return;
      }

      if (!sampleSeat) return;
      if (tier.id !== selectedTier?.id) {
        onSelectTier?.(tier.id);
      }
      setSelectedSectionId(sectionId);
    },
    [
      effectiveVenue,
      allSeats,
      tiers,
      selectedTier?.id,
      onSelectTier,
      lotteryMode,
      onSectionClickForLottery,
    ],
  );

  /* ── 비지정석(스탠딩) 수량 선택 모드 ── */
  if (
    seatSelectionActive &&
    selectedTier &&
    selectedTier.seating_type !== "assigned"
  ) {
    return (
      <div
        className="flex-1 overflow-hidden flex flex-col items-center justify-center"
        style={{ height: "100%" }}
      >
        <div className="text-center space-y-4 px-8">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
            <MapPin className="h-8 w-8 text-primary" />
          </div>
          <h3 className="text-xl font-bold text-foreground">
            {selectedTier.name}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t("standingInfo")}
            <br />
            <span className="hidden lg:inline">
              {t("selectQtyRight")}
            </span>
            <span className="lg:hidden">
              {t("selectQtyBottom")}
            </span>
          </p>
        </div>
      </div>
    );
  }

  /* ── 좌석 선택 모드 (지정석) ── */
  if (seatSelectionActive && selectedTier && effectiveVenue) {
    return (
      <div
        className="flex-1 overflow-hidden flex flex-col"
        style={{ height: "100%" }}
      >
        {/* 헤더 */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-background/90 backdrop-blur-sm shrink-0">
          <MapPin className="h-4 w-4 text-primary" />
          <span className="text-sm font-bold text-foreground">{t("seatSelection")}</span>
          <span className="text-xs text-muted-foreground">
            — {selectedTier.name}
          </span>
          <div className="ml-auto">
            <BestAvailableButton
              eventId={eventId}
              tierId={selectedTier.id}
              quantity={Math.max(1, selectedSeats.length || 1)}
              onResult={onSetSelectedSeats}
            />
          </div>
        </div>

        {/* 좌석 그리드 */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {loadingSeats ? (
            <div className="flex items-center justify-center h-full">
              <div className="animate-pulse text-sm text-muted-foreground">
                {t("loadingSeats")}
              </div>
            </div>
          ) : activeSectionData ? (
            <div className="h-full overflow-auto p-4">
              <SectionDetail
                sectionName={activeSectionData.name}
                seats={activeSectionSeats}
                selectedSeats={selectedSeats}
                onToggleSeat={onToggleSeat}
                onSelectRange={handleSelectRange}
                onBack={handleBack}
                tier={selectedTier}
                category={category}
              />
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-muted-foreground">
                {t("noSeatInfo")}
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ── 실제 피그마 배치 맵 (figma layout 반영) — 섹션 클릭은 위 handleSelectSection 참조 ── */
  if (!effectiveVenue) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        {t("loadingVenue")}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-hidden" style={{ height: "100%" }}>
      <VenueMap
        venue={effectiveVenue}
        sectionAvailability={sectionAvailability}
        selectedSectionId={selectedSectionId}
        onSelectSection={handleSelectSection}
        category={category}
        homeTeam={homeTeam}
        awayTeam={awayTeam}
        lotteryMode={lotteryMode}
      />
    </div>
  );
}
