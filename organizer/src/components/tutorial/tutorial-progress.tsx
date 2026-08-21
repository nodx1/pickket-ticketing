"use client";

import { TOUR_MAP } from "@/lib/tutorial/tours";

interface TutorialProgressProps {
  tourName: string;
  currentStep: number;
  totalSteps: number;
}

export function TutorialProgress({
  tourName,
  currentStep,
  totalSteps,
}: TutorialProgressProps) {
  const tour = TOUR_MAP.get(tourName);
  const label = tour?.name ?? tourName;
  const percent = totalSteps > 0 ? Math.round(((currentStep + 1) / totalSteps) * 100) : 0;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[9997] flex items-center justify-center p-4 pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-4 rounded-full border border-border bg-card px-6 py-3 shadow-xl backdrop-blur-xl">
        <span className="text-sm font-medium text-foreground">{label}</span>

        <div className="flex items-center gap-2">
          {Array.from({ length: totalSteps }, (_, i) => (
            <span
              key={i}
              className={`size-2 rounded-full transition-colors ${
                i <= currentStep ? "bg-primary" : "bg-bg-emphasis"
              }`}
            />
          ))}
        </div>

        <span className="text-xs text-muted-foreground">
          {currentStep + 1}/{totalSteps} ({percent}%)
        </span>

        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-bg-subtle">
          <div
            className="h-full rounded-full bg-gradient-to-r from-primary to-success transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
    </div>
  );
}
