"use client";

import { useTutorialStore } from "@/lib/stores/tutorialStore";

interface CoachmarkProps {
  featureId: string;
  className?: string;
}

export function Coachmark({ featureId, className = "" }: CoachmarkProps) {
  const { isCoachmarkDismissed, dismissCoachmark, activeTourId } = useTutorialStore();

  if (activeTourId) return null;
  if (isCoachmarkDismissed(featureId)) return null;

  return (
    <button
      type="button"
      onClick={() => dismissCoachmark(featureId)}
      className={`relative flex size-3 items-center justify-center ${className}`}
      aria-label="새로운 기능 안내 닫기"
    >
      <span className="absolute size-3 rounded-full bg-success" />
      <span className="absolute size-3 rounded-full bg-success animate-coachmark-ping" />
    </button>
  );
}
