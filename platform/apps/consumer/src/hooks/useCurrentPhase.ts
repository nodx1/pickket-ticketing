"use client";

/**
 * 현재 판매 단계(sale phase) 조회 hook.
 *
 * ── 레벨2 컷오버 T2-PHASE ──
 * 예전에는 pickket.go 공개 API(`GO_URL/api/public/events/{slug}/current-phase`)를 **직접**
 * 호출했다. go DB/앱이 제거되면 이 훅이 죽어 이벤트 카드의 단계 표시가 사라진다.
 * 판매 단계 SSOT 는 v2 `phase_configs` 이므로 v2 공개 엔드포인트로 전환했다.
 *
 * 엔드포인트: `GET {API_URL}/api/v1/public/events/{slugOrId}/current-phase` (인증 불요)
 * 대상이 없어도 200 + data:null 을 반환한다 — 카드가 조용히 폴백한다.
 *
 * 반환:
 *   current?: { mode, status, opensAt, closesAt, ... }  — 현재 활성 phase
 *   phases[]: 전체 phase 시퀀스
 *   eventStatus, eventId
 */
import { useQuery } from "@tanstack/react-query";
import { API_URL } from "@pickket/lib";

export type SalePhaseMode =
  | "membership_presale"
  | "lottery"
  | "waitlist_promotion"
  | "queue_sale"
  | "fcfs_residual";

export type SalePhaseStatus =
  | "scheduled"
  | "open"
  | "closed"
  | "allocating"
  | "allocated"
  | "skipped";

export interface SalePhaseDTO {
  id: string;
  phaseOrder: number;
  mode: SalePhaseMode;
  opensAt: string | null;
  closesAt: string | null;
  targetQuantity: number | null;
  allocatedQuantity: number;
  status: SalePhaseStatus;
}

export interface CurrentPhaseResponse {
  eventId: string;
  eventStatus: string;
  current: SalePhaseDTO | null;
  phases: SalePhaseDTO[];
}

export function useCurrentPhase(slug: string | null | undefined) {
  return useQuery<CurrentPhaseResponse | null>({
    queryKey: ["pickket-current-phase", slug],
    enabled: Boolean(slug),
    staleTime: 10_000,
    refetchInterval: 30_000,
    queryFn: async () => {
      if (!slug) return null;
      const res = await fetch(
        `${API_URL}/api/v1/public/events/${encodeURIComponent(slug)}/current-phase`,
      );
      if (!res.ok) {
        // 네트워크/서버 오류 — 조용히 null (단계 UI 미표시로 폴백)
        return null;
      }
      const payload = (await res.json()) as {
        data: CurrentPhaseResponse | null;
      };
      return payload.data; // null 가능 (해당 이벤트에 단계 없음)
    },
  });
}
