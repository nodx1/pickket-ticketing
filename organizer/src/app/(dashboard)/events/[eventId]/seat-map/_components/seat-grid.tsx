"use client";

import { cn } from "@/lib/utils";

interface SeatRow {
  id: string;
  section: string;
  row: string;
  seatNumber: string;
  status: "available" | "held" | "reserved" | "blocked";
  tierId: string | null;
}

interface TierLite {
  id: string;
  name: string;
  colorHex: string | null;
}

export function SeatGrid({
  seats,
  selectedSeatIds,
  tiers,
  onToggle,
}: {
  seats: SeatRow[];
  selectedSeatIds: string[];
  tiers: TierLite[];
  onToggle: (seatId: string) => void;
}) {
  const tierColorById = new Map(tiers.map((t) => [t.id, t.colorHex ?? null]));

  return (
    <div className="space-y-6">
      {Array.from(new Set(seats.map((seat) => seat.section))).map((section) => (
        <div key={section} className="space-y-3">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">{section}</p>
          <div className="grid gap-2 sm:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10">
            {seats
              .filter((seat) => seat.section === section)
              .map((seat) => {
                const selected = selectedSeatIds.includes(seat.id);
                const tierColor = seat.tierId ? tierColorById.get(seat.tierId) ?? null : null;
                const hasTier = tierColor !== null;
                const isBlocked = seat.status === "blocked";
                const isReserved = seat.status === "reserved";

                // 인라인 스타일로 등급 색상 주입 (등급 있고 차단·예약 아닐 때만)
                const inlineStyle: React.CSSProperties =
                  hasTier && !isBlocked && !isReserved
                    ? { backgroundColor: `${tierColor}33`, borderColor: tierColor ?? undefined, color: tierColor ?? undefined }
                    : {};

                return (
                  <button
                    key={seat.id}
                    type="button"
                    disabled={isReserved}
                    style={inlineStyle}
                    className={cn(
                      "rounded-lg border px-3 py-3 text-xs font-semibold transition",
                      // 기본 상태 (등급 없음 + 사용 가능)
                      !hasTier && !isBlocked && !isReserved && "border-success/30 bg-success/10 text-success",
                      // 차단
                      isBlocked && "border-slate-400 bg-slate-200 text-slate-500 line-through",
                      // 예약
                      isReserved && "cursor-not-allowed border-sky-500/30 bg-sky-500/20 text-sky-700",
                      // 선택 — 배경/색 유지하고 외곽선만 강조 (옵션 A)
                      selected && "ring-2 ring-primary ring-offset-2",
                    )}
                    onClick={() => onToggle(seat.id)}
                  >
                    {seat.row}-{seat.seatNumber}
                  </button>
                );
              })}
          </div>
        </div>
      ))}
    </div>
  );
}
