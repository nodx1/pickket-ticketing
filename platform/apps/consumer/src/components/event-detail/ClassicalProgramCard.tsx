"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import type { EventProgramData } from "@pickket/lib/api";
import DomainSection from "./DomainSection";

// ─── Types ──────────────────────────────────────────────────────────────────

interface ProgramPiece {
  composer: string;
  title: string;
  movements?: string[];
  duration_min?: number;
  soloist?: string;
}

interface ClassicalProgramCardProps {
  programData?: EventProgramData;
  programNotes?: string;
  artistName?: string;
  subjectName?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isIntermission(piece: ProgramPiece): boolean {
  if (piece.composer === "INTERMISSION") return true;
  const title = piece.title.toLowerCase();
  return title.includes("인터미션") || title.includes("intermission");
}

function formatDuration(
  minutes: number,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  if (minutes < 60) {
    return t("classical.approxMin", { min: minutes });
  }
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (remaining === 0) {
    return t("classical.approxMin", { min: minutes });
  }
  return t("classical.approxHourMin", { hours, minutes: remaining });
}

// ─── Intermission Divider ───────────────────────────────────────────────────

function IntermissionDivider({ label }: { label: string }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true }}
      transition={{ duration: 0.5 }}
      className="flex items-center gap-3 py-3"
    >
      <motion.div
        initial={{ scaleX: 0 }}
        whileInView={{ scaleX: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.6, delay: 0.2 }}
        className="flex-1 border-t border-dashed border-border/60 origin-left"
      />
      <span className="text-xs-plus font-medium text-muted-foreground uppercase tracking-widest">
        {label}
      </span>
      <motion.div
        initial={{ scaleX: 0 }}
        whileInView={{ scaleX: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.6, delay: 0.2 }}
        className="flex-1 border-t border-dashed border-border/60 origin-right"
      />
    </motion.div>
  );
}

// ─── Program Piece Row ──────────────────────────────────────────────────────

function ProgramPieceRow({
  piece,
  index,
  soloistLabel,
  durationLabel,
}: {
  piece: ProgramPiece;
  index: number;
  soloistLabel: string;
  durationLabel: (min: number) => string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      whileInView={{ opacity: 1, x: 0 }}
      viewport={{ once: true }}
      transition={{
        type: "spring",
        stiffness: 300,
        damping: 30,
        delay: index * 0.06,
      }}
      role="listitem"
      className="flex gap-3 py-3 first:pt-0 last:pb-0"
    >
      {/* Number */}
      <motion.div
        initial={{ scale: 0 }}
        whileInView={{ scale: 1 }}
        viewport={{ once: true }}
        transition={{
          type: "spring",
          stiffness: 400,
          damping: 20,
          delay: index * 0.06 + 0.1,
        }}
        className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center mt-0.5"
      >
        <span className="text-xs font-bold text-primary tabular-nums">
          {index}
        </span>
      </motion.div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Composer */}
        <p className="text-xs text-muted-foreground font-medium leading-tight">
          {piece.composer}
        </p>

        {/* Title — serif for elegance */}
        <p className="text-sm font-bold text-foreground font-serif leading-snug mt-0.5">
          {piece.title}
        </p>

        {/* Movements */}
        {piece.movements && piece.movements.length > 0 && (
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            {piece.movements.join(", ")}
          </p>
        )}

        {/* Meta: duration + soloist */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5">
          {piece.duration_min != null && (
            <span className="text-xs-plus text-muted-foreground/70 tabular-nums">
              {durationLabel(piece.duration_min)}
            </span>
          )}
          {piece.soloist && (
            <span className="text-xs-plus font-medium text-primary/80">
              {soloistLabel}: {piece.soloist}
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function ClassicalProgramCard({
  programData,
  programNotes,
  artistName,
  subjectName,
}: ClassicalProgramCardProps) {
  const t = useTranslations("domain");
  const pieces = useMemo(
    () => (Array.isArray(programData) ? (programData as ProgramPiece[]) : []),
    [programData],
  );

  // Calculate total duration
  const totalDuration = useMemo(() => {
    if (pieces.length === 0) return 0;
    let total = 0;
    for (const piece of pieces) {
      if (!isIntermission(piece) && piece.duration_min != null) {
        total += piece.duration_min;
      }
    }
    return total;
  }, [pieces]);

  // Track numbering (skipping intermissions)
  const numberedPieces = useMemo(() => {
    if (pieces.length === 0) return [];
    let pieceNumber = 0;
    return pieces.map((piece) => {
      if (isIntermission(piece)) {
        return { piece, number: -1, isIntermission: true };
      }
      pieceNumber++;
      return { piece, number: pieceNumber, isIntermission: false };
    });
  }, [pieces]);

  // Don't render if no data
  if (pieces.length === 0 && !programNotes) {
    return null;
  }

  return (
    <DomainSection
      title={t("classical.program")}
      subtitle={subjectName}
      iconSrc="/icons/categories/classical.svg"
      accentColor="bg-gradient-to-r from-green-500 to-teal-500"
    >
      {/* Program notes */}
      {programNotes && (
        <div className="mb-5">
          <p className="text-sm text-muted-foreground italic leading-relaxed border-l-2 border-primary/30 pl-4">
            {programNotes}
          </p>
        </div>
      )}

      {/* Conductor */}
      {artistName && (
        <div className="mb-4 flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {t("classical.conductor")}
          </span>
          <span className="text-xs text-muted-foreground">|</span>
          <span className="text-sm font-semibold text-foreground">
            {artistName}
          </span>
        </div>
      )}

      {/* Program list */}
      {numberedPieces.length > 0 && (
        <div className="bg-amber-50/50 dark:bg-amber-950/10 rounded-xl p-4">
          <div
            className="divide-y divide-border/40"
            role="list"
            aria-label={t("classical.program")}
          >
            {numberedPieces.map((item, idx) => {
              if (item.isIntermission) {
                return (
                  <IntermissionDivider
                    key={`intermission-${idx}`}
                    label={t("classical.intermission")}
                  />
                );
              }

              return (
                <ProgramPieceRow
                  key={`${item.piece.composer}-${item.piece.title}-${idx}`}
                  piece={item.piece}
                  index={item.number}
                  soloistLabel={t("classical.soloist")}
                  durationLabel={(min: number) =>
                    t("classical.durationMin", { min })
                  }
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Total duration */}
      {totalDuration > 0 && (
        <div className="mt-4 flex justify-end">
          <span className="text-xs text-muted-foreground/70">
            {t("classical.estimatedDuration")}:{" "}
            {formatDuration(totalDuration, t)}
          </span>
        </div>
      )}
    </DomainSection>
  );
}
