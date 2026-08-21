"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { StepPosition, TourStep } from "@/lib/tutorial/tours";

interface TooltipPosition {
  top: number;
  left: number;
  arrow: "top" | "bottom" | "left" | "right" | "none";
}

interface TutorialTooltipProps {
  step: TourStep;
  stepIndex: number;
  totalSteps: number;
  targetRect: DOMRect | null;
  onNext: () => void;
  onPrev: () => void;
  onSkip: () => void;
  isActionPending: boolean;
  reducedMotion?: boolean;
}

const TOOLTIP_GAP = 16;
const TOOLTIP_MAX_WIDTH = 360;
const VIEWPORT_PADDING = 16;

function calculatePosition(
  targetRect: DOMRect | null,
  preferred: StepPosition,
  tooltipRect: DOMRect | null,
): TooltipPosition {
  if (!targetRect || preferred === "center") {
    return {
      top: window.innerHeight / 2 - 120,
      left: window.innerWidth / 2 - Math.min(TOOLTIP_MAX_WIDTH, window.innerWidth - 32) / 2,
      arrow: "none",
    };
  }

  const tw = tooltipRect?.width ?? 320;
  const th = tooltipRect?.height ?? 200;
  const isMobile = window.innerWidth < 768;

  if (isMobile) {
    return {
      top: Math.min(
        targetRect.bottom + TOOLTIP_GAP,
        window.innerHeight - th - VIEWPORT_PADDING,
      ),
      left: VIEWPORT_PADDING,
      arrow: "top",
    };
  }

  const positions: Record<StepPosition, TooltipPosition> = {
    top: {
      top: targetRect.top - th - TOOLTIP_GAP,
      left: targetRect.left + targetRect.width / 2 - tw / 2,
      arrow: "bottom",
    },
    bottom: {
      top: targetRect.bottom + TOOLTIP_GAP,
      left: targetRect.left + targetRect.width / 2 - tw / 2,
      arrow: "top",
    },
    left: {
      top: targetRect.top + targetRect.height / 2 - th / 2,
      left: targetRect.left - tw - TOOLTIP_GAP,
      arrow: "right",
    },
    right: {
      top: targetRect.top + targetRect.height / 2 - th / 2,
      left: targetRect.right + TOOLTIP_GAP,
      arrow: "left",
    },
    center: { top: 0, left: 0, arrow: "none" },
  };

  let pos = positions[preferred];

  if (pos.top < VIEWPORT_PADDING || pos.top + th > window.innerHeight - VIEWPORT_PADDING) {
    const opposite = preferred === "top" ? "bottom" : preferred === "bottom" ? "top" : preferred;
    if (opposite !== preferred) pos = positions[opposite];
  }

  if (pos.left < VIEWPORT_PADDING || pos.left + tw > window.innerWidth - VIEWPORT_PADDING) {
    const opposite = preferred === "left" ? "right" : preferred === "right" ? "left" : preferred;
    if (opposite !== preferred) pos = positions[opposite];
  }

  pos.left = Math.max(VIEWPORT_PADDING, Math.min(pos.left, window.innerWidth - tw - VIEWPORT_PADDING));
  pos.top = Math.max(VIEWPORT_PADDING, Math.min(pos.top, window.innerHeight - th - VIEWPORT_PADDING));

  return pos;
}

export function TutorialTooltip({
  step,
  stepIndex,
  totalSteps,
  targetRect,
  onNext,
  onPrev,
  onSkip,
  isActionPending,
  reducedMotion,
}: TutorialTooltipProps) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltipRect, setTooltipRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (tooltipRef.current) {
      setTooltipRect(tooltipRef.current.getBoundingClientRect());
    }
  }, [step.id]);

  const pos = calculatePosition(targetRect, step.position, tooltipRect);
  const isLastStep = stepIndex === totalSteps - 1;
  const isFirstStep = stepIndex === 0;
  const hasInteraction = step.action.type !== "none";

  const focusTrapRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Tab") {
        const focusable = focusTrapRef.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), [tabindex]:not([tabindex='-1'])",
        );
        if (!focusable?.length) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [],
  );

  useEffect(() => {
    const firstButton = focusTrapRef.current?.querySelector<HTMLElement>("button");
    firstButton?.focus();
  }, [step.id]);

  return (
    <div
      ref={tooltipRef}
      role="dialog"
      aria-modal="true"
      aria-label={`튜토리얼: ${step.title}`}
      aria-describedby="tutorial-step-description"
      className="fixed z-[9999] w-[min(calc(100vw-32px),360px)]"
      style={{
        top: pos.top,
        left: pos.left,
        transition: reducedMotion ? "none" : "top 0.3s cubic-bezier(0.16,1,0.3,1), left 0.3s cubic-bezier(0.16,1,0.3,1)",
      }}
      onKeyDown={handleKeyDown}
    >
      {/* 화살표 */}
      {pos.arrow !== "none" && (
        <div
          className="absolute size-3 rotate-45 border border-border bg-card"
          style={{
            ...(pos.arrow === "top" && { top: -6, left: "50%", marginLeft: -6, borderRight: 0, borderBottom: 0 }),
            ...(pos.arrow === "bottom" && { bottom: -6, left: "50%", marginLeft: -6, borderLeft: 0, borderTop: 0 }),
            ...(pos.arrow === "left" && { left: -6, top: "50%", marginTop: -6, borderRight: 0, borderTop: 0 }),
            ...(pos.arrow === "right" && { right: -6, top: "50%", marginTop: -6, borderLeft: 0, borderBottom: 0 }),
          }}
        />
      )}

      <div
        ref={focusTrapRef}
        className="rounded-lg border border-border bg-card/95 p-6 shadow-2xl backdrop-blur-xl"
      >
        {/* 헤더 */}
        <div className="mb-4 flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">
            스텝 {stepIndex + 1}/{totalSteps}
          </span>
          <button
            type="button"
            onClick={onSkip}
            className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition hover:bg-bg-subtle hover:text-foreground"
            aria-label="투어 건너뛰기"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* 내용 */}
        <h3 className="text-lg font-bold text-foreground">{step.title}</h3>
        <p
          id="tutorial-step-description"
          className="mt-2 text-sm leading-6 text-muted-foreground"
        >
          {step.description}
        </p>

        {/* 인터렉티브 힌트 */}
        {hasInteraction && isActionPending && (
          <p className="mt-3 text-sm font-medium text-primary">
            💡 {step.action.type === "click" ? "지금 클릭해보세요" : step.action.type === "input" ? "입력해보세요" : "이동해보세요"}
          </p>
        )}

        {/* 네비게이션 */}
        <div className="mt-5 flex items-center justify-between">
          <button
            type="button"
            onClick={onPrev}
            disabled={isFirstStep}
            className="flex items-center gap-1 text-sm text-muted-foreground transition hover:text-foreground disabled:opacity-30"
            aria-label="이전 스텝"
          >
            <ChevronLeft className="size-4" />
            이전
          </button>

          {/* 도트 인디케이터 */}
          <div className="flex items-center gap-1.5" aria-hidden="true">
            {Array.from({ length: totalSteps }, (_, i) => (
              <span
                key={i}
                className={`size-1.5 rounded-full transition-colors ${
                  i === stepIndex ? "bg-primary" : i < stepIndex ? "bg-primary/40" : "bg-bg-emphasis"
                }`}
              />
            ))}
          </div>

          {hasInteraction && isActionPending ? (
            <span className="text-xs text-muted-foreground/60">대기 중...</span>
          ) : (
            <button
              type="button"
              onClick={onNext}
              className="flex items-center gap-1 text-sm font-medium text-primary transition hover:text-primary/80"
              aria-label={isLastStep ? "투어 완료" : "다음 스텝"}
            >
              {isLastStep ? "완료" : "다음"}
              <ChevronRight className="size-4" />
            </button>
          )}
        </div>

        {/* 건너뛰기 */}
        <div className="mt-3 text-center">
          <button
            type="button"
            onClick={onSkip}
            className="text-xs text-muted-foreground/50 transition hover:text-muted-foreground"
          >
            건너뛰기
          </button>
        </div>
      </div>

      {/* 스크린 리더 라이브 리전 */}
      <div aria-live="polite" className="sr-only">
        {`${step.title} — ${stepIndex + 1}/${totalSteps}단계`}
      </div>
    </div>
  );
}
