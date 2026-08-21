/**
 * §13 오프라인 체크인 큐 → 서버 배치 동기화.
 *
 * 온라인 복귀 시 로컬 pending 큐를 이벤트 체크인 API 로 순차 전송한다. 서버는 v2 admit() 로
 * 검증·기록하며(event_admissions 멱등), 각 결과를 3분류로 표면화한다:
 *  - synced:   서버가 입장 기록/멱등 통과(2xx). 로컬에서 정리 대상.
 *  - conflict: 이미 입장·취소·무효 등 서버가 거부(4xx). 스태프 리뷰 목록에 노출.
 *  - failed:   네트워크/서버 오류(5xx·전송 실패). pending 유지 → 재시도.
 *
 * 회전 QR 을 오프라인에 서버검증할 수 없었으므로 manual+origin=offline_sync 로 전송한다
 * (서버가 method="offline"·감사 mode="offline" 로 기록 = 캡처방지 미검증 명시).
 */

import { deleteQueueItem, listPending, updateQueueItem, type OfflineCheckIn } from "./offline-store";

export interface SyncCounts {
  synced: number;
  conflict: number;
  failed: number;
}

export interface SyncItemResult {
  localId: string;
  ticketNumber: string;
  guestName: string;
  outcome: "synced" | "conflict" | "failed";
  message: string | null;
}

export interface SyncResult extends SyncCounts {
  items: SyncItemResult[];
}

/** 단건 전송 함수의 응답(테스트 주입 가능하도록 fetch 추상화). */
export interface PostOutcome {
  ok: boolean;
  status: number;
  error: string | null;
}

export type OfflinePoster = (item: OfflineCheckIn) => Promise<PostOutcome>;

/** 기본 poster — check-in API 로 manual+offline_sync 전송. */
export function makeDefaultPoster(eventId: string): OfflinePoster {
  return async (item) => {
    try {
      const response = await fetch(`/api/events/${eventId}/check-in`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "manual",
          origin: "offline_sync",
          ticketNumber: item.ticketNumber,
          checkInListId: item.checkInListId,
          manualReason: `오프라인 육안 대조 (${item.guestName})`,
          offlineCheckedInAt: item.checkedInAt,
        }),
      });
      let error: string | null = null;
      try {
        const payload = (await response.json()) as { error?: string };
        error = payload.error ?? null;
      } catch {
        error = null;
      }
      return { ok: response.ok, status: response.status, error };
    } catch (err: unknown) {
      // 네트워크 오류 = 재시도 대상(failed).
      return { ok: false, status: 0, error: err instanceof Error ? err.message : "네트워크 오류" };
    }
  };
}

/**
 * pending 큐를 순차 동기화. 성공은 즉시 정리(deleteQueueItem), 충돌은 conflict 로 표시(리뷰),
 * 실패는 pending 유지(재시도). 순차 처리로 서버 부하·중복 경합을 억제한다.
 */
export async function syncOfflineQueue(eventId: string, poster: OfflinePoster): Promise<SyncResult> {
  const pending = await listPending(eventId);
  const items: SyncItemResult[] = [];
  const counts: SyncCounts = { synced: 0, conflict: 0, failed: 0 };

  for (const item of pending) {
    const res = await poster(item);
    if (res.ok) {
      await deleteQueueItem(item.localId);
      counts.synced += 1;
      items.push({ localId: item.localId, ticketNumber: item.ticketNumber, guestName: item.guestName, outcome: "synced", message: null });
    } else if (res.status >= 400 && res.status < 500) {
      // 서버 거부(이미 입장·취소·무효 등) → 충돌. 로컬 유지 + conflict 표시(스태프 리뷰).
      const message = res.error ?? "서버가 입장을 거부했습니다";
      await updateQueueItem(item.localId, { syncState: "conflict", syncMessage: message });
      counts.conflict += 1;
      items.push({ localId: item.localId, ticketNumber: item.ticketNumber, guestName: item.guestName, outcome: "conflict", message });
    } else {
      // 네트워크/서버 오류 → pending 유지(재시도). 사유만 기록.
      const message = res.error ?? "일시적 오류 — 재시도 대상";
      await updateQueueItem(item.localId, { syncState: "pending", syncMessage: message });
      counts.failed += 1;
      items.push({ localId: item.localId, ticketNumber: item.ticketNumber, guestName: item.guestName, outcome: "failed", message });
    }
  }

  return { ...counts, items };
}
