"use client";

import { useCallback, useState } from "react";
import { type GuestBuyer } from "@pickket/lib/api";

/* ── 게스트 view_token sessionStorage 보관 ─────────────────────────────────
 *
 * view_token 은 게스트 주문 생성 응답에 **1회만** 실려온다. 조회·결제 confirm 에
 * 재사용해야 하므로 sessionStorage 에 보관한다(localStorage 금지 — 탭 종료 시 폐기).
 * 결제 리다이렉트(토스/나이스) 후 success 페이지에서 confirm 하려면 값이 살아 있어야
 * 하므로 sessionStorage 가 정합(같은 origin·같은 탭 유지). orderId 로 스코프한다.
 */

const TOKEN_KEY_PREFIX = "pickket_guest_view_token_";
const BUYER_KEY = "pickket_guest_buyer";

interface StoredToken {
  token: string;
  expiresAt: string;
}

export function persistGuestViewToken(
  orderId: string,
  token: string,
  expiresAt: string,
) {
  if (typeof window === "undefined") return;
  try {
    const data: StoredToken = { token, expiresAt };
    sessionStorage.setItem(TOKEN_KEY_PREFIX + orderId, JSON.stringify(data));
  } catch {
    /* storage unavailable */
  }
}

export function readGuestViewToken(orderId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY_PREFIX + orderId);
    if (!raw) return null;
    const data: StoredToken = JSON.parse(raw);
    if (data.expiresAt && new Date(data.expiresAt).getTime() <= Date.now()) {
      sessionStorage.removeItem(TOKEN_KEY_PREFIX + orderId);
      return null;
    }
    return typeof data.token === "string" ? data.token : null;
  } catch {
    return null;
  }
}

export function clearGuestViewToken(orderId: string) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(TOKEN_KEY_PREFIX + orderId);
  } catch {
    /* noop */
  }
}

const EMPTY_BUYER: GuestBuyer = {
  email: "",
  name: "",
  phone: "",
  marketing_opt_in: false,
};

function restoreBuyer(): GuestBuyer {
  if (typeof window === "undefined") return EMPTY_BUYER;
  try {
    const raw = sessionStorage.getItem(BUYER_KEY);
    if (!raw) return EMPTY_BUYER;
    const data = JSON.parse(raw);
    return {
      email: typeof data.email === "string" ? data.email : "",
      name: typeof data.name === "string" ? data.name : "",
      phone: typeof data.phone === "string" ? data.phone : "",
      marketing_opt_in: Boolean(data.marketing_opt_in),
    };
  } catch {
    return EMPTY_BUYER;
  }
}

/**
 * 게스트 buyer 입력 상태 + view_token sessionStorage 헬퍼.
 * buyer 는 편의상 세션 동안 재사용(재입력 부담 완화)하되 PII 이므로 sessionStorage 한정.
 */
export function useGuestBooking() {
  const [buyer, setBuyer] = useState<GuestBuyer>(() => restoreBuyer());

  const updateBuyer = useCallback((patch: Partial<GuestBuyer>) => {
    setBuyer((prev) => {
      const next = { ...prev, ...patch };
      if (typeof window !== "undefined") {
        try {
          sessionStorage.setItem(BUYER_KEY, JSON.stringify(next));
        } catch {
          /* noop */
        }
      }
      return next;
    });
  }, []);

  const resetBuyer = useCallback(() => {
    setBuyer(EMPTY_BUYER);
    if (typeof window !== "undefined") {
      try {
        sessionStorage.removeItem(BUYER_KEY);
      } catch {
        /* noop */
      }
    }
  }, []);

  return {
    buyer,
    updateBuyer,
    resetBuyer,
    persistViewToken: persistGuestViewToken,
    readViewToken: readGuestViewToken,
    clearViewToken: clearGuestViewToken,
  };
}
