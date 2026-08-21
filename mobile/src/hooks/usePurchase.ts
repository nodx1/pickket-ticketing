/**
 * 구매 관련 React Query 훅
 *
 * 멱등키(idempotency key) 패턴:
 * - 구매 시도 전 키를 1회 생성 → AsyncStorage에 저장
 * - 네트워크 오류 재시도 시 동일 키 재사용 → 서버 측 중복 주문 방지
 * - 성공 또는 클라이언트 오류(4xx) 시 키 삭제
 */
import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  purchaseTicket,
  purchaseFanclub,
  generateIdempotencyKey,
  type PurchaseRequest,
  type PurchaseResult,
} from "@/config/api";
import { storage } from "@/lib/storage";

const IDEM_KEY_PREFIX = "idem_purchase_";

interface PurchaseParams {
  eventId: string;
  tierId: string;
  quantity: number;
  seatIds?: string[];
  queueToken?: string;
}

/**
 * 멱등키를 가져오거나 새로 생성하여 AsyncStorage에 저장
 * 같은 eventId+tierId+quantity+seatIds 조합에 대해 재시도 시 동일 키 반환
 * quantity나 seatIds가 변경되면 새 키를 생성하여 이전 파라미터 replay 방지
 */
async function getOrCreateIdempotencyKey(
  eventId: string,
  tierId: string,
  quantity: number,
  seatIds?: string[],
): Promise<string> {
  const seatSuffix = seatIds && seatIds.length > 0 ? `_${[...seatIds].sort().join(",")}` : "";
  const storageKey = `${IDEM_KEY_PREFIX}${eventId}_${tierId}_${quantity}${seatSuffix}`;
  const existing = await storage.get(storageKey);
  if (existing) return existing;

  const newKey = generateIdempotencyKey();
  await storage.set(storageKey, newKey);
  return newKey;
}

async function clearIdempotencyKey(
  eventId: string,
  tierId: string,
  quantity: number,
  seatIds?: string[],
): Promise<void> {
  const seatSuffix = seatIds && seatIds.length > 0 ? `_${[...seatIds].sort().join(",")}` : "";
  await storage.remove(`${IDEM_KEY_PREFIX}${eventId}_${tierId}_${quantity}${seatSuffix}`);
}

export function usePurchaseTicket() {
  const queryClient = useQueryClient();
  const activeKey = useRef<string | null>(null);

  return useMutation({
    mutationFn: async ({ eventId, tierId, quantity, seatIds, queueToken }: PurchaseParams) => {
      const idempotencyKey = await getOrCreateIdempotencyKey(eventId, tierId, quantity, seatIds);
      activeKey.current = idempotencyKey;

      const request: PurchaseRequest = {
        quantity,
        idempotency_key: idempotencyKey,
        seat_ids: seatIds,
        queue_token: queueToken,
      };
      return purchaseTicket(eventId, tierId, request);
    },
    onSuccess: (data: PurchaseResult, { eventId, tierId, quantity, seatIds }) => {
      clearIdempotencyKey(eventId, tierId, quantity, seatIds);
      activeKey.current = null;
      queryClient.invalidateQueries({ queryKey: ["events", eventId, "tiers"] });
      queryClient.invalidateQueries({ queryKey: ["events", eventId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
    },
    onError: (_error, { eventId, tierId, quantity, seatIds }) => {
      // 4xx 클라이언트 오류 시 키 폐기 (재시도 무의미)
      // 5xx/네트워크 오류는 키 유지 (React Query 자동 재시도 시 동일 키 사용)
      const isClientError =
        _error && typeof _error === "object" && "response" in _error
          ? (((_error as Record<string, unknown>).response as Record<string, unknown>)?.status as number) >= 400 &&
            (((_error as Record<string, unknown>).response as Record<string, unknown>)?.status as number) < 500
          : false;
      if (isClientError) {
        clearIdempotencyKey(eventId, tierId, quantity, seatIds);
        activeKey.current = null;
      }
    },
  });
}

export function usePurchaseFanclub() {
  const queryClient = useQueryClient();
  const activeKey = useRef<string | null>(null);

  return useMutation({
    mutationFn: async ({ eventId, tierId, quantity, seatIds, queueToken }: PurchaseParams) => {
      const idempotencyKey = await getOrCreateIdempotencyKey(eventId, tierId, quantity, seatIds);
      activeKey.current = idempotencyKey;

      const request: PurchaseRequest = {
        quantity,
        idempotency_key: idempotencyKey,
        seat_ids: seatIds,
        queue_token: queueToken,
      };
      return purchaseFanclub(eventId, tierId, request);
    },
    onSuccess: (_data, { eventId, tierId, quantity, seatIds }) => {
      clearIdempotencyKey(eventId, tierId, quantity, seatIds);
      activeKey.current = null;
      queryClient.invalidateQueries({ queryKey: ["events", eventId, "tiers"] });
      queryClient.invalidateQueries({ queryKey: ["events", eventId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
    },
    onError: (_error, { eventId, tierId, quantity, seatIds }) => {
      const isClientError =
        _error && typeof _error === "object" && "response" in _error
          ? (((_error as Record<string, unknown>).response as Record<string, unknown>)?.status as number) >= 400 &&
            (((_error as Record<string, unknown>).response as Record<string, unknown>)?.status as number) < 500
          : false;
      if (isClientError) {
        clearIdempotencyKey(eventId, tierId, quantity, seatIds);
        activeKey.current = null;
      }
    },
  });
}
