"use client";

/**
 * 좌석 공개 API 클라이언트 래퍼 — Phase 6 (Frontend Components)
 *
 * `/api/public/events/[slug]/seats*` 엔드포인트를 fetch로 호출한다.
 * 경로 토큰은 이벤트 slug (UUID가 아님). 서버가 slug→UUID 로 매핑한다.
 * 하위 호환을 위해 함수 시그니처의 첫 번째 인자 이름은 `eventSlug` 로 변경됨.
 */

import type { Seat, SeatHoldResponse } from "./types";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

interface SeatListResult {
  seats: Seat[];
  summary: Record<string, number>;
}

interface ApiEnvelope<T> {
  data: T;
  error?: string;
}

export async function fetchSeats(
  eventSlug: string,
  mapId: string,
  opts?: { tierId?: string; section?: string },
): Promise<SeatListResult> {
  const params = new URLSearchParams({ mapId });
  if (opts?.tierId) params.set("tierId", opts.tierId);
  if (opts?.section) params.set("section", opts.section);
  const res = await fetchWithRefresh(
    `/api/public/events/${eventSlug}/seats?${params.toString()}`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error("좌석 조회 실패");
  const body = (await res.json()) as ApiEnvelope<SeatListResult>;
  return body.data;
}

export async function holdSeats(
  eventSlug: string,
  seatIds: string[],
): Promise<SeatHoldResponse> {
  const res = await fetchWithRefresh(`/api/public/events/${eventSlug}/seats/hold`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seatIds }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? "좌석 잠금 실패");
  }
  const body = (await res.json()) as ApiEnvelope<SeatHoldResponse>;
  return body.data;
}

export async function releaseHold(
  eventSlug: string,
  holdId: string,
  holdToken: string,
): Promise<void> {
  await fetchWithRefresh(`/api/public/events/${eventSlug}/seats/hold`, {
    method: "DELETE",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ holdId, holdToken }),
  });
}

export async function getBestAvailable(
  eventSlug: string,
  mapId: string,
  quantity: number,
  tierId?: string,
): Promise<Seat[]> {
  const params = new URLSearchParams({
    mapId,
    quantity: String(quantity),
    adjacent: "true",
  });
  if (tierId) params.set("tierId", tierId);
  const res = await fetchWithRefresh(
    `/api/public/events/${eventSlug}/seats/best-available?${params.toString()}`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error("추천 좌석 조회 실패");
  const body = (await res.json()) as ApiEnvelope<{ seats: Seat[] }>;
  return body.data.seats;
}

/**
 * 트랙 1.8 — 친구 함께 예매: size 만큼 인접한 좌석을 한 번에 hold.
 * group-allocator 가 all-win-or-all-lose 를 보장.
 */
export interface CompanionResult {
  holdId: string;
  holdToken: string;
  expiresAt: string;
  seatIds: string[];
  tierId: string;
  size: number;
}

export async function bookCompanionSeats(
  eventSlug: string,
  size: number,
  tierId?: string,
): Promise<CompanionResult> {
  const res = await fetchWithRefresh(
    `/api/public/events/${eventSlug}/seats/companion`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ size, tierId }),
    },
  );
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? "친구 함께 예매에 실패했습니다");
  }
  const body = (await res.json()) as ApiEnvelope<CompanionResult>;
  return body.data;
}

/**
 * 트랙 1.9 — 좌석 즐겨찾기 + 가격 알림 등록.
 */
export interface SeatWatchInput {
  seatId: string;
  targetPrice?: number | null;
}
export interface SeatWatch {
  id: string;
  seatId: string;
  targetPrice: number | null;
  notifyAt: string | null;
  createdAt: string;
}

export async function watchSeat(
  eventSlug: string,
  input: SeatWatchInput,
): Promise<SeatWatch> {
  const res = await fetchWithRefresh(
    `/api/public/events/${eventSlug}/seats/watch`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? "관심 좌석 등록 실패");
  }
  const body = (await res.json()) as ApiEnvelope<SeatWatch>;
  return body.data;
}

export async function unwatchSeat(
  eventSlug: string,
  seatId: string,
): Promise<void> {
  await fetchWithRefresh(
    `/api/public/events/${eventSlug}/seats/watch?seatId=${encodeURIComponent(seatId)}`,
    {
      method: "DELETE",
      credentials: "include",
    },
  );
}

export async function listSeatWatches(
  eventSlug: string,
): Promise<SeatWatch[]> {
  const res = await fetchWithRefresh(
    `/api/public/events/${eventSlug}/seats/watch`,
    { credentials: "include" },
  );
  if (!res.ok) return [];
  const body = (await res.json()) as ApiEnvelope<SeatWatch[]>;
  return body.data ?? [];
}
