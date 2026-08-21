"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useSeatStream } from "./useSeatStream";

export type SeatStatus =
  | "available"
  | "held"
  | "sold"
  | "selected"
  | "disabled";

export interface Seat {
  id: string;
  row: string;
  number: number;
  x: number;
  y: number;
  status: SeatStatus;
  section?: string;
  price?: number;
}

interface SeatMapProps {
  eventId: string;
  seats: Seat[];
  maxSelectable?: number;
  onSelect?: (selectedSeats: Seat[]) => void;
}

const STATUS_COLORS: Record<SeatStatus, string> = {
  available: "#4ade80", // green-400
  held: "#fbbf24", // amber-400
  sold: "#6b7280", // gray-500
  selected: "#404040", // violet-500
  disabled: "#d1d5db", // gray-300
};

const SEAT_SIZE = 20;
const SEAT_GAP = 4;

export function SeatMap({
  eventId,
  seats: initialSeats,
  maxSelectable = 4,
  onSelect,
}: SeatMapProps) {
  const t = useTranslations("booking.seatMap");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [seats, setSeats] = useState<Seat[]>(initialSeats);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [scale, setScale] = useState(1);
  const [offset, _setOffset] = useState({ x: 0, y: 0 });

  // Real-time seat updates via WebSocket
  useSeatStream(eventId, (update) => {
    setSeats((prev) =>
      prev.map((s) =>
        s.id === update.seat_id
          ? { ...s, status: update.status as SeatStatus }
          : s,
      ),
    );
    // Deselect if someone else took our selected seat
    if (update.status !== "available" && selectedIds.has(update.seat_id)) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(update.seat_id);
        return next;
      });
    }
  });

  // Draw canvas
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    ctx.save();
    ctx.translate(offset.x, offset.y);
    ctx.scale(scale, scale);

    for (const seat of seats) {
      const status = selectedIds.has(seat.id) ? "selected" : seat.status;
      ctx.fillStyle = STATUS_COLORS[status];
      ctx.beginPath();
      ctx.roundRect(
        seat.x * (SEAT_SIZE + SEAT_GAP),
        seat.y * (SEAT_SIZE + SEAT_GAP),
        SEAT_SIZE,
        SEAT_SIZE,
        4,
      );
      ctx.fill();

      // Seat label
      if (scale > 0.8) {
        ctx.fillStyle =
          status === "sold" || status === "disabled" ? "#9ca3af" : "#111827";
        ctx.font = "9px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(
          `${seat.row}${seat.number}`,
          seat.x * (SEAT_SIZE + SEAT_GAP) + SEAT_SIZE / 2,
          seat.y * (SEAT_SIZE + SEAT_GAP) + SEAT_SIZE / 2 + 3,
        );
      }
    }

    ctx.restore();
  }, [seats, selectedIds, scale, offset]);

  useEffect(() => {
    draw();
  }, [draw]);

  // Click handler
  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left - offset.x) / scale;
    const y = (e.clientY - rect.top - offset.y) / scale;

    const clicked = seats.find((s) => {
      const sx = s.x * (SEAT_SIZE + SEAT_GAP);
      const sy = s.y * (SEAT_SIZE + SEAT_GAP);
      return x >= sx && x <= sx + SEAT_SIZE && y >= sy && y <= sy + SEAT_SIZE;
    });

    if (
      !clicked ||
      clicked.status === "sold" ||
      clicked.status === "held" ||
      clicked.status === "disabled"
    ) {
      return;
    }

    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(clicked.id)) {
        next.delete(clicked.id);
      } else if (next.size < maxSelectable) {
        next.add(clicked.id);
      }
      return next;
    });
  };

  // Notify parent of selection changes
  useEffect(() => {
    const selected = seats.filter((s) => selectedIds.has(s.id));
    onSelect?.(selected);
  }, [selectedIds, seats, onSelect]);

  // Wheel zoom
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const newScale = Math.max(0.3, Math.min(3, scale - e.deltaY * 0.001));
    setScale(newScale);
  };

  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-border bg-muted/30">
      {/* Legend */}
      <div className="flex gap-4 p-3 text-xs">
        {(["available", "selected", "held", "sold"] as SeatStatus[]).map(
          (status) => (
            <div key={status} className="flex items-center gap-1.5">
              <div
                className="h-3 w-3 rounded-sm"
                style={{ backgroundColor: STATUS_COLORS[status] }}
              />
              <span className="text-muted-foreground">
                {status === "available"
                  ? t("legendAvailable")
                  : status === "selected"
                    ? t("legendSelected")
                    : status === "held"
                      ? t("legendHeld")
                      : t("legendSold")}
              </span>
            </div>
          ),
        )}
      </div>

      {/* Stage label */}
      <div className="mx-auto mb-2 w-48 rounded-b-lg bg-foreground/10 py-1 text-center text-xs text-muted-foreground">
        STAGE
      </div>

      <canvas
        ref={canvasRef}
        className="h-[500px] w-full cursor-pointer"
        onClick={handleClick}
        onWheel={handleWheel}
      />
    </div>
  );
}
