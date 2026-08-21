"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTutorialStore } from "@/lib/stores/tutorialStore";
import { getVisibleSteps, type TourStep } from "@/lib/tutorial/tours";
import { SpotlightOverlay } from "./spotlight-overlay";
import { TutorialTooltip } from "./tutorial-tooltip";
import { TutorialProgress } from "./tutorial-progress";
import { Celebration } from "./celebration";

export function TutorialProvider() {
  const {
    activeTourId,
    activeStepIndex,
    isPaused,
    nextStep,
    prevStep,
    skipTour,
    completeTour,
  } = useTutorialStore();

  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [isActionPending, setIsActionPending] = useState(false);
  const [showCelebration, setShowCelebration] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const previousFocusRef = useRef<Element | null>(null);
  const observerRef = useRef<MutationObserver | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    setMounted(true);
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  /* visible steps for current viewport */
  const visibleSteps = activeTourId
    ? getVisibleSteps(activeTourId, typeof window !== "undefined" ? window.innerWidth : 1920)
    : [];
  const currentStep: TourStep | undefined = visibleSteps[activeStepIndex];
  const tourName = activeTourId
    ? (visibleSteps.length > 0 ? activeTourId : null)
    : null;

  /* find target element */
  const findTarget = useCallback(
    (step: TourStep | undefined): HTMLElement | null => {
      if (!step) return null;
      if (step.position === "center") return null;
      return document.querySelector<HTMLElement>(`[data-tutorial="${step.target}"]`);
    },
    [],
  );

  /* update rect */
  const updateRect = useCallback(() => {
    const el = findTarget(currentStep);
    if (el) {
      const rect = el.getBoundingClientRect();
      setTargetRect(rect);
      /* scroll into view if needed */
      if (rect.top < 0 || rect.bottom > window.innerHeight) {
        el.scrollIntoView({ behavior: reducedMotion ? "instant" : "smooth", block: "center" });
        requestAnimationFrame(() => setTargetRect(el.getBoundingClientRect()));
      }
    } else if (currentStep?.position === "center") {
      setTargetRect(null);
    }
  }, [currentStep, findTarget, reducedMotion]);

  /* observe DOM for target appearance (route change) */
  useEffect(() => {
    if (!currentStep || !activeTourId) {
      setTargetRect(null);
      return;
    }

    const tryFind = () => {
      const el = findTarget(currentStep);
      if (el) {
        updateRect();
        return true;
      }
      return false;
    };

    if (tryFind() || currentStep.position === "center") {
      updateRect();
    } else {
      observerRef.current = new MutationObserver(() => {
        if (tryFind()) {
          observerRef.current?.disconnect();
        }
      });
      observerRef.current.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }

    return () => {
      observerRef.current?.disconnect();
    };
  }, [currentStep, activeTourId, findTarget, updateRect]);

  /* ResizeObserver + scroll for position tracking */
  useEffect(() => {
    if (!currentStep || !activeTourId) return;

    const el = findTarget(currentStep);
    if (!el) return;

    resizeObserverRef.current = new ResizeObserver(updateRect);
    resizeObserverRef.current.observe(el);

    const handleScroll = () => updateRect();
    const handleResize = () => updateRect();
    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleResize, { passive: true });

    return () => {
      resizeObserverRef.current?.disconnect();
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleResize);
    };
  }, [currentStep, activeTourId, findTarget, updateRect]);

  /* action listeners (click/input) */
  useEffect(() => {
    if (!currentStep || !activeTourId) return;

    const action = currentStep.action;
    if (action.type === "none") {
      setIsActionPending(false);
      return;
    }

    setIsActionPending(true);

    if (action.type === "click") {
      const el = document.querySelector<HTMLElement>(`[data-tutorial="${action.target}"]`);
      if (!el) return;
      el.style.pointerEvents = "auto";
      el.style.position = "relative";
      el.style.zIndex = "9999";

      const handler = () => {
        setIsActionPending(false);
        handleAdvance();
      };
      el.addEventListener("click", handler, { once: true });
      return () => {
        el.removeEventListener("click", handler);
        el.style.pointerEvents = "";
        el.style.position = "";
        el.style.zIndex = "";
      };
    }

    if (action.type === "input") {
      const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `[data-tutorial="${action.target}"]`,
      );
      if (!el) return;
      el.style.pointerEvents = "auto";
      el.style.position = "relative";
      el.style.zIndex = "9999";

      const minLen = action.minLength ?? 1;
      const handler = () => {
        if (el.value.length >= minLen) {
          setIsActionPending(false);
          handleAdvance();
        }
      };
      el.addEventListener("input", handler);
      return () => {
        el.removeEventListener("input", handler);
        el.style.pointerEvents = "";
        el.style.position = "";
        el.style.zIndex = "";
      };
    }

    if (action.type === "navigate") {
      const check = () => {
        if (window.location.pathname.startsWith(action.path)) {
          setIsActionPending(false);
          handleAdvance();
          return true;
        }
        return false;
      };
      if (check()) return;

      const interval = setInterval(check, 500);
      return () => clearInterval(interval);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep?.id, activeTourId]);

  /* save/restore focus */
  useEffect(() => {
    if (activeTourId) {
      previousFocusRef.current = document.activeElement;
    } else if (previousFocusRef.current instanceof HTMLElement) {
      previousFocusRef.current.focus();
      previousFocusRef.current = null;
    }
  }, [activeTourId]);

  /* keyboard navigation */
  useEffect(() => {
    if (!activeTourId || isPaused) return;

    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowRight":
        case "Enter":
          if (!isActionPending) handleAdvance();
          break;
        case "ArrowLeft":
          handlePrev();
          break;
        case "Escape":
          skipTour();
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTourId, isPaused, isActionPending, activeStepIndex]);

  /* handlers */
  function handleAdvance() {
    if (!currentStep) return;
    if (currentStep.celebrateOnComplete) {
      setShowCelebration(true);
      setTimeout(() => setShowCelebration(false), 1500);
    }
    if (activeStepIndex >= visibleSteps.length - 1) {
      completeTour();
    } else {
      nextStep();
    }
  }

  function handlePrev() {
    if (activeStepIndex > 0) prevStep();
  }

  function handleOverlayClick() {
    if (currentStep?.action.type === "none") {
      handleAdvance();
    }
  }

  /* render */
  if (!mounted || !activeTourId || !currentStep || isPaused) return null;

  const spotlightRect = targetRect
    ? { x: targetRect.x, y: targetRect.y, width: targetRect.width, height: targetRect.height }
    : null;

  return createPortal(
    <>
      <SpotlightOverlay
        rect={spotlightRect}
        padding={currentStep.spotlightPadding ?? 8}
        onOverlayClick={handleOverlayClick}
        reducedMotion={reducedMotion}
      />
      <TutorialTooltip
        step={currentStep}
        stepIndex={activeStepIndex}
        totalSteps={visibleSteps.length}
        targetRect={targetRect}
        onNext={handleAdvance}
        onPrev={handlePrev}
        onSkip={skipTour}
        isActionPending={isActionPending}
        reducedMotion={reducedMotion}
      />
      {tourName && (
        <TutorialProgress
          tourName={tourName}
          currentStep={activeStepIndex}
          totalSteps={visibleSteps.length}
        />
      )}
      {showCelebration && !reducedMotion && <Celebration />}
    </>,
    document.body,
  );
}
