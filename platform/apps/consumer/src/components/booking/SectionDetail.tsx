"use client";

import React, {
  useState,
  useRef,
  useCallback,
  useMemo,
  useEffect,
} from "react";
import { Star, Eye } from "lucide-react";
import { type SeatData, type SeatTier } from "@pickket/lib/api";
import { cn, getOrganizerLabels, formatKRW } from "@pickket/lib";
import Image from "next/image";
import { useTranslations } from "next-intl";

interface SectionDetailProps {
  sectionName: string;
  seats: SeatData[];
  selectedSeats: SeatData[];
  onToggleSeat: (seat: SeatData) => void;
  onSelectRange?: (seats: SeatData[]) => void;
  onBack: () => void;
  tier?: SeatTier;
  category?: string;
}

const STATUS_COLORS: Record<string, string> = {
  available: "border-border hover:border-primary hover:bg-primary/5",
  held: "bg-amber-600/20 border-amber-600/40 cursor-not-allowed",
  sold: "bg-muted border-border cursor-not-allowed",
  reserved: "bg-muted border-border cursor-not-allowed",
};

/** Obstructed view discount rate (10%) */
const OBSTRUCTED_DISCOUNT = 0.1;

export default function SectionDetail({
  sectionName,
  seats,
  selectedSeats,
  onToggleSeat,
  onSelectRange,
  onBack: _onBack,
  tier,
  category,
}: SectionDetailProps) {
  const t = useTranslations("booking.sectionDetail");
  const [showViewInfo, setShowViewInfo] = useState(false);
  const hasViewInfo =
    tier &&
    (tier.view_image_url || tier.view_rating || tier.distance_from_stage);
  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const initialScaleSet = useRef(false);
  const [isPanning, setIsPanning] = useState(false);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);

  const selectedIds = useMemo(
    () => new Set(selectedSeats.map((s) => s.id)),
    [selectedSeats],
  );

  // Shift+click range selection state
  const [lastClickedSeatId, setLastClickedSeatId] = useState<string | null>(
    null,
  );
  const [rangeHighlight, setRangeHighlight] = useState<Set<string>>(new Set());
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // Group seats by row
  const rows = useMemo(() => {
    const map = new Map<number, SeatData[]>();
    for (const seat of seats) {
      const row = seat.row_number;
      if (!map.has(row)) map.set(row, []);
      map.get(row)!.push(seat);
    }
    for (const [, rowSeats] of map) {
      rowSeats.sort((a, b) => a.seat_number - b.seat_number);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a - b);
  }, [seats]);

  const flatSeats = useMemo(
    () => rows.flatMap(([, rowSeats]) => rowSeats),
    [rows],
  );
  const seatIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    flatSeats.forEach((s, i) => map.set(s.id, i));
    return map;
  }, [flatSeats]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    pointerStartRef.current = { x: e.clientX, y: e.clientY };
    lastPointerRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!lastPointerRef.current || !pointerStartRef.current) return;
      // Calculate distance from start to apply drag threshold
      const distX = e.clientX - pointerStartRef.current.x;
      const distY = e.clientY - pointerStartRef.current.y;
      const dist = Math.sqrt(distX * distX + distY * distY);
      if (!isPanning && dist > 5) {
        setIsPanning(true);
      }
      if (!isPanning) return;
      const dx = e.clientX - lastPointerRef.current.x;
      const dy = e.clientY - lastPointerRef.current.y;
      lastPointerRef.current = { x: e.clientX, y: e.clientY };
      setTranslate((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
    },
    [isPanning],
  );

  const handlePointerUp = useCallback(() => {
    setIsPanning(false);
    lastPointerRef.current = null;
    pointerStartRef.current = null;
  }, []);

  // Auto-fit: calculate initial scale to fit all seats in view
  useEffect(() => {
    if (initialScaleSet.current || !containerRef.current || !gridRef.current)
      return;
    // Wait for grid to render
    const timer = setTimeout(() => {
      const container = containerRef.current;
      const grid = gridRef.current;
      if (!container || !grid) return;
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      const gw = grid.scrollWidth;
      const gh = grid.scrollHeight;
      if (gw > 0 && gh > 0) {
        const fitScale = Math.min(cw / gw, ch / gh, 1) * 0.9;
        setScale(Math.max(0.2, fitScale));
        initialScaleSet.current = true;
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [seats.length]);

  // Native wheel listener (non-passive) to allow preventDefault on ctrl+wheel zoom
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setScale((prev) => Math.max(0.4, Math.min(3, prev - e.deltaY * 0.005)));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  const availableCount = seats.filter((s) => s.status === "available").length;
  const obstructedCount = seats.filter(
    (s) => s.is_obstructed && s.status === "available",
  ).length;
  const facePrice = tier ? (tier.face_price ?? tier.base_price) : 0;
  const obstructedPrice = Math.round(facePrice * (1 - OBSTRUCTED_DISCOUNT));

  return (
    <div className="h-full flex flex-col gap-3">
      {/* Header */}
      <div>
        <h3 className="text-lg font-bold text-foreground">{sectionName}</h3>
        <p className="text-xs text-muted-foreground">
          {t("availableSeats", { count: availableCount })}
        </p>
      </div>

      {/* Obstructed price info */}
      {obstructedCount > 0 && facePrice > 0 && (
        <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2 text-xs">
          <span className="font-medium text-amber-600 dark:text-amber-400">
            {t("obstructedSeats", { count: obstructedCount })}
          </span>
          <span className="text-muted-foreground line-through">
            {formatKRW(facePrice)}
          </span>
          <span className="font-bold text-foreground">
            {formatKRW(obstructedPrice)}
          </span>
          <span className="text-muted-foreground">
            {t("obstructedDiscount", { pct: Math.round(OBSTRUCTED_DISCOUNT * 100) })}
          </span>
        </div>
      )}

      {/* View info banner */}
      {hasViewInfo && (
        <button
          type="button"
          onClick={() => setShowViewInfo(!showViewInfo)}
          className="w-full flex items-center gap-3 bg-background/50 border border-border rounded-xl p-2.5 text-left hover:bg-card transition-colors"
        >
          {tier.view_image_url && (
            <div className="relative w-12 h-12 rounded-lg overflow-hidden shrink-0">
              <Image
                src={tier.view_image_url}
                alt={t("viewImageAlt")}
                fill
                className="object-cover"
              />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate">
              {tier.position_label || sectionName}
            </p>
            <div className="flex items-center gap-2 mt-0.5">
              {tier.distance_from_stage != null && (
                <span className="text-xs text-muted-foreground">
                  {t("distanceFromStage", { label: getOrganizerLabels(category).distanceRefLabel, dist: tier.distance_from_stage })}
                </span>
              )}
              {tier.view_rating != null && (
                <span className="flex items-center gap-0.5">
                  {Array.from({ length: 5 }, (_, i) => (
                    <Star
                      key={i}
                      className={cn(
                        "h-3 w-3",
                        i < tier.view_rating!
                          ? "text-amber-400 fill-amber-400"
                          : "text-muted-foreground/30",
                      )}
                    />
                  ))}
                </span>
              )}
            </div>
            {showViewInfo && tier.view_description && (
              <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                {tier.view_description}
              </p>
            )}
          </div>
          <Eye className="h-4 w-4 text-muted-foreground shrink-0" />
        </button>
      )}

      {/* Legend */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="w-5 h-5 rounded-full border-2 border-border" /> {t("legendAvailable")}
        </span>
        <span className="flex items-center gap-1">
          <span className="w-5 h-5 rounded-full bg-primary border-2 border-primary" />{" "}
          {t("legendSelected")}
        </span>
        <span className="flex items-center gap-1">
          <span className="w-5 h-5 rounded-full bg-muted border-2 border-border" />{" "}
          {t("legendSoldOut")}
        </span>
        <span className="flex items-center gap-1">
          <span className="w-5 h-5 rounded-full bg-amber-600/20 border-2 border-amber-600/40" />{" "}
          {t("legendHeld")}
        </span>
        <span className="flex items-center gap-1">
          <span className="w-5 h-5 rounded-full border-2 border-amber-600 ring-1 ring-amber-600/30" />{" "}
          {t("legendPrime")}
        </span>
        <span className="flex items-center gap-1">
          <span className="w-5 h-5 rounded-full border-2 border-dashed border-muted-foreground/50 opacity-60" />{" "}
          {t("legendObstructed")}
        </span>
      </div>

      {/* Seat Grid */}
      <div
        ref={containerRef}
        className="relative flex-1 rounded-2xl bg-background/40 p-4 overflow-hidden select-none"
        style={{ touchAction: scale > 1 ? "none" : "pan-y" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <div
          ref={gridRef}
          style={{
            transform: `scale(${scale}) translate(${translate.x / scale}px, ${translate.y / scale}px)`,
            transformOrigin: "center top",
            transition: isPanning ? "none" : "transform 0.2s ease",
          }}
        >
          {/* Stage indicator */}
          <div className="text-center mb-4">
            <div className="inline-block bg-primary/20 text-primary/70 text-xs font-bold px-8 py-1.5 rounded-lg">
              STAGE
            </div>
          </div>
          {rows.map(([rowNum, rowSeats]) => (
            <div
              key={rowNum}
              className={cn(
                "flex items-center justify-center gap-1 mb-1",
                rowNum % 2 === 0 && "bg-muted/30 rounded-lg",
              )}
            >
              <span className="text-2xs text-muted-foreground w-8 text-right shrink-0 sticky left-0 z-10 bg-background">
                {t("rowLabel", { row: rowNum })}
              </span>
              <div className="flex gap-1 flex-wrap">
                {rowSeats.map((seat) => {
                  const isAvailable = seat.status === "available";
                  const isSelected = selectedIds.has(seat.id);
                  const isObstructed = seat.is_obstructed;

                  return (
                    <button
                      key={seat.id}
                      type="button"
                      disabled={!isAvailable && !isSelected}
                      onClick={(e) => {
                        if (!isAvailable && !isSelected) return;

                        if (e.shiftKey && lastClickedSeatId && onSelectRange) {
                          const lastIdx = seatIndexMap.get(lastClickedSeatId);
                          const curIdx = seatIndexMap.get(seat.id);
                          if (lastIdx != null && curIdx != null) {
                            const [start, end] =
                              lastIdx < curIdx
                                ? [lastIdx, curIdx]
                                : [curIdx, lastIdx];
                            const rangeSeats = flatSeats
                              .slice(start, end + 1)
                              .filter(
                                (s) =>
                                  s.status === "available" &&
                                  s.row_number === seat.row_number &&
                                  !selectedIds.has(s.id),
                              );

                            if (rangeSeats.length > 0) {
                              onSelectRange(rangeSeats);
                              const highlightIds = new Set(
                                rangeSeats.map((s) => s.id),
                              );
                              setRangeHighlight(highlightIds);
                              if (highlightTimeoutRef.current)
                                clearTimeout(highlightTimeoutRef.current);
                              highlightTimeoutRef.current = setTimeout(
                                () => setRangeHighlight(new Set()),
                                600,
                              );
                            }
                          }
                        } else {
                          onToggleSeat(seat);
                        }
                        setLastClickedSeatId(seat.id);
                      }}
                      className={cn(
                        "w-12 h-12 lg:w-11 lg:h-11 rounded-full border-2 text-xs-plus font-medium transition-all duration-150 flex items-center justify-center relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                        isSelected
                          ? "bg-primary border-primary text-white shadow-[0_0_8px_rgba(10,10,10,0.4)] scale-110"
                          : STATUS_COLORS[seat.status] || STATUS_COLORS.sold,
                        !isSelected &&
                          isAvailable &&
                          (seat.quality_score ?? 0.5) >= 0.8 &&
                          "border-amber-600 ring-1 ring-amber-600/30",
                        !isSelected &&
                          isObstructed &&
                          "border-dashed opacity-60",
                        rangeHighlight.has(seat.id)
                          ? "ring-2 ring-primary/50"
                          : "",
                      )}
                      title={`${seat.label || t("seatLabel", { row: rowNum, num: seat.seat_number })}${(seat.quality_score ?? 0.5) >= 0.8 ? ` ⭐ ${t("legendPrime")}` : ""}${isObstructed ? ` ⚠ ${t("obstructedSeatLabel")}` : ""}`}
                      aria-label={`${seat.label || t("seatLabel", { row: rowNum, num: seat.seat_number })} ${isSelected ? t("ariaSelected") : seat.status === "available" ? t("legendAvailable") : t("ariaUnavailable")}`}
                    >
                      {seat.seat_number}
                      {!isSelected &&
                        !isAvailable &&
                        (seat.status === "sold" ||
                          seat.status === "reserved") && (
                          <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <span className="block w-[60%] h-[1.5px] bg-muted-foreground/60 rotate-45" />
                          </span>
                        )}
                      {!isSelected &&
                        isAvailable &&
                        (seat.quality_score ?? 0.5) >= 0.8 && (
                          <span className="absolute -top-0.5 -right-0.5 w-3 h-3 text-amber-600 dark:text-amber-400 flex items-center justify-center text-2xs">
                            ★
                          </span>
                        )}
                      {isSelected && (
                        <span className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-primary rounded-full flex items-center justify-center">
                          <svg
                            width="8"
                            height="8"
                            viewBox="0 0 8 8"
                            fill="none"
                          >
                            <path
                              d="M1.5 4L3 5.5L6.5 2"
                              stroke="white"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </span>
                      )}
                      {isObstructed && !isSelected && (
                        <span className="absolute -top-1 -left-1 w-4 h-4 bg-amber-500 rounded-full flex items-center justify-center text-white text-2xs font-bold leading-none">
                          !
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Zoom controls */}
      <div className="flex items-center gap-2 justify-end">
        <button
          type="button"
          onClick={() => {
            setScale(1);
            setTranslate({ x: 0, y: 0 });
          }}
          className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-lg hover:bg-muted transition-colors"
        >
          {t("resetZoom")}
        </button>
        <button
          type="button"
          onClick={() => setScale((s) => Math.min(3, s + 0.3))}
          className="w-7 h-7 flex items-center justify-center text-sm font-bold text-foreground rounded-lg hover:bg-muted transition-colors"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => setScale((s) => Math.max(0.4, s - 0.3))}
          className="w-7 h-7 flex items-center justify-center text-sm font-bold text-foreground rounded-lg hover:bg-muted transition-colors"
        >
          −
        </button>
      </div>
    </div>
  );
}
