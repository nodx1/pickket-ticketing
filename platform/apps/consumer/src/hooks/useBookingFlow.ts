"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { type SeatData, holdSeats, releaseHold } from "@pickket/lib/api";
import { toast } from "sonner";

export type BookingStep = "session" | "tier" | "seat" | "payment";

interface BookingState {
  step: BookingStep;
  selectedSessionEventId: string | null;
  selectedTierId: string | null;
  selectedSeats: SeatData[];
  quantity: number;
  holdId: string | null;
  holdExpiresAt: string | null;
  isAssignedSeating: boolean;
}

const INITIAL_STATE: BookingState = {
  step: "session",
  selectedSessionEventId: null,
  selectedTierId: null,
  selectedSeats: [],
  quantity: 1,
  holdId: null,
  holdExpiresAt: null,
  isAssignedSeating: false,
};

const STEP_ORDER: BookingStep[] = ["session", "tier", "seat", "payment"];

/* ── sessionStorage persistence ─────────────────────────── */
const SESSION_KEY_PREFIX = "pickket_booking_";
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface PersistedBooking extends BookingState {
  timestamp: number;
}

function persistBookingState(eventId: string, state: BookingState) {
  if (typeof window === "undefined") return;
  try {
    const data: PersistedBooking = { ...state, timestamp: Date.now() };
    sessionStorage.setItem(SESSION_KEY_PREFIX + eventId, JSON.stringify(data));
  } catch {
    /* storage unavailable */
  }
}

function restoreBookingState(eventId: string): {
  state: BookingState;
  restored: boolean;
} {
  if (typeof window === "undefined")
    return { state: INITIAL_STATE, restored: false };
  try {
    const raw = sessionStorage.getItem(SESSION_KEY_PREFIX + eventId);
    if (!raw) return { state: INITIAL_STATE, restored: false };

    const data: PersistedBooking = JSON.parse(raw);
    if (Date.now() - data.timestamp > SESSION_TTL_MS) {
      sessionStorage.removeItem(SESSION_KEY_PREFIX + eventId);
      return { state: INITIAL_STATE, restored: false };
    }

    // Validate hold expiry
    if (
      data.holdExpiresAt &&
      new Date(data.holdExpiresAt).getTime() <= Date.now()
    ) {
      data.holdId = null;
      data.holdExpiresAt = null;
      data.step = "seat"; // hold expired → go back to seat selection
    }

    // Validate restored SeatData
    if (Array.isArray(data.selectedSeats)) {
      data.selectedSeats = data.selectedSeats.filter(
        (s) => s && typeof s.id === "string" && typeof s.section === "string",
      );
    } else {
      data.selectedSeats = [];
    }

    const { timestamp: _, ...bookingState } = data;
    return { state: bookingState, restored: true };
  } catch {
    return { state: INITIAL_STATE, restored: false };
  }
}

export function clearPersistedBooking(eventId: string) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(SESSION_KEY_PREFIX + eventId);
  } catch {
    /* noop */
  }
}

export function useBookingFlow(eventId: string) {
  const [{ state: initialState, restored: wasRestored }] = useState(() =>
    restoreBookingState(eventId),
  );
  const [state, setState] = useState<BookingState>(initialState);

  // Keep a ref to the latest state for async callbacks
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Persist state on every change
  useEffect(() => {
    persistBookingState(eventId, state);
  }, [eventId, state]);

  const updateState = useCallback((patch: Partial<BookingState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  const selectSession = useCallback(
    (sessionEventId: string) => {
      updateState({
        selectedSessionEventId: sessionEventId,
        selectedTierId: null,
        selectedSeats: [],
        holdId: null,
        holdExpiresAt: null,
      });
    },
    [updateState],
  );

  const selectTier = useCallback(
    (tierId: string) => {
      updateState({ selectedTierId: tierId, selectedSeats: [] });
    },
    [updateState],
  );

  const setQuantity = useCallback(
    (qty: number, maxSeats: number = 4) => {
      updateState({ quantity: Math.max(1, Math.min(maxSeats, qty)) });
    },
    [updateState],
  );

  const setIsAssigned = useCallback(
    (isAssigned: boolean) => {
      updateState({ isAssignedSeating: isAssigned });
    },
    [updateState],
  );

  const toggleSeat = useCallback((seat: SeatData, maxSeats: number = 4) => {
    setState((prev) => {
      const exists = prev.selectedSeats.find((s) => s.id === seat.id);
      if (exists) {
        return {
          ...prev,
          selectedSeats: prev.selectedSeats.filter((s) => s.id !== seat.id),
        };
      }
      if (prev.selectedSeats.length >= maxSeats) {
        toast.error(`최대 ${maxSeats}석까지 선택 가능합니다.`);
        return prev;
      }
      return { ...prev, selectedSeats: [...prev.selectedSeats, seat] };
    });
  }, []);

  const setSelectedSeats = useCallback(
    (seats: SeatData[]) => {
      updateState({ selectedSeats: seats });
    },
    [updateState],
  );

  const holdSelectedSeats = useCallback(async (): Promise<boolean> => {
    const seats = stateRef.current.selectedSeats;
    if (seats.length === 0) return false;
    try {
      const res = await holdSeats(eventId, {
        seat_ids: seats.map((s) => s.id),
      });
      updateState({
        holdId: res.data.hold_id,
        holdExpiresAt: res.data.hold_until,
      });
      toast.success("좌석이 임시 확보되었습니다.");
      return true;
    } catch {
      toast.error("좌석 확보에 실패했습니다. 다시 시도해주세요.");
      return false;
    }
  }, [eventId, updateState]);

  const releaseCurrentHold = useCallback(async () => {
    const holdId = stateRef.current.holdId;
    if (!holdId) return;
    try {
      await releaseHold(eventId, holdId);
    } catch {
      // silent fail on release
    }
    updateState({ holdId: null, holdExpiresAt: null });
  }, [eventId, updateState]);

  const verifyHoldValid = useCallback((): boolean => {
    const expiresAt = stateRef.current.holdExpiresAt;
    if (!expiresAt) return false;
    return new Date(expiresAt).getTime() > Date.now();
  }, []);

  const nextStep = useCallback(() => {
    setState((prev) => {
      const idx = STEP_ORDER.indexOf(prev.step);
      if (idx < STEP_ORDER.length - 1) {
        return { ...prev, step: STEP_ORDER[idx + 1] };
      }
      return prev;
    });
  }, []);

  const prevStep = useCallback(() => {
    setState((prev) => {
      const idx = STEP_ORDER.indexOf(prev.step);
      if (idx > 0) {
        return { ...prev, step: STEP_ORDER[idx - 1] };
      }
      return prev;
    });
  }, []);

  const goToStep = useCallback(
    (step: BookingStep) => {
      updateState({ step });
    },
    [updateState],
  );

  const canProceed = (() => {
    switch (state.step) {
      case "session":
        return state.selectedSessionEventId !== null;
      case "tier":
        return state.selectedTierId !== null;
      case "seat":
        return state.isAssignedSeating ? state.selectedSeats.length > 0 : true;
      case "payment":
        return true;
      default:
        return false;
    }
  })();

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
    clearPersistedBooking(eventId);
  }, [eventId]);

  return {
    ...state,
    canProceed,
    isRestoredSession: wasRestored,
    selectSession,
    selectTier,
    setQuantity,
    toggleSeat,
    setSelectedSeats,
    setIsAssigned,
    holdSelectedSeats,
    releaseCurrentHold,
    verifyHoldValid,
    nextStep,
    prevStep,
    goToStep,
    reset,
  };
}
