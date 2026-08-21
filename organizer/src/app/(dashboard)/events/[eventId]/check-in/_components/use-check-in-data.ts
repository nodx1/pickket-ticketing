"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { saveRoster } from "@/lib/checkin/offline-store";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

export interface CheckInListItem {
  id: string;
  name: string;
  status: "draft" | "active" | "closed";
}

export interface CheckInLogItem {
  id: string;
  /** 취소(revoke-admission) 대상 참석자 id. 과거 로그 취소에 사용. */
  attendeeId: string | null;
  name: string;
  ticketNumber: string;
  productName: string;
  method: string;
  /** 취소 대상 입장일(KST YYYY-MM-DD). 다일 이벤트 일자별 취소 정합. */
  attendedDate: string | null;
  createdAt: string;
}

interface AttendeeRow {
  ticketNumber?: string;
  name?: string;
  /** 🔴 현장 임시티켓 발급용 — 동명이인을 가른다(2026-08-19). */
  phone?: string | null;
  productName?: string | null;
  admissionMode?: string | null;
  /** 🔴 경품 추첨 당첨자 연락의 기준 번호. */
  raffleNumber?: number | null;
  status?: string;
}

/**
 * §13 체크인 데이터 로드 + 오프라인 명단 프리캐시.
 * 온라인일 때 참석자 전체를 IndexedDB(pickket-checkin)에 캐시해 LTE 끊김 시 폴백을 준비한다.
 */
export function useCheckInData(eventId: string, online: boolean) {
  const [lists, setLists] = useState<CheckInListItem[]>([]);
  const [selectedListId, setSelectedListId] = useState("");
  const [logs, setLogs] = useState<CheckInLogItem[]>([]);
  const [stats, setStats] = useState({ checkedIn: 0, total: 0 });
  const [rosterCount, setRosterCount] = useState(0);
  const [rosterCachedAt, setRosterCachedAt] = useState<number | null>(null);
  /** 리스트 조회 실패 사유 — 조용히 빈 화면을 띄우지 않기 위해 노출한다. */
  const [error, setError] = useState<string | null>(null);
  // 🔴 현장 조회용 명단 — 캐시하면서 화면에도 그대로 준다(별도 호출을 또 만들지 않는다).
  const [roster, setRoster] = useState<AttendeeRow[]>([]);

  // 참석자 전체를 로드해 오프라인 명단 캐시로 저장(온라인일 때만). 페이지 크게(limit) 로드.
  const cacheRoster = useCallback(async () => {
    if (!online) return;
    try {
      const res = await fetchWithRefresh(`/api/events/${eventId}/attendees?limit=100&page=1`, { credentials: "include" });
      if (!res.ok) return;
      const payload = (await res.json()) as { data?: AttendeeRow[]; meta?: { total?: number } };
      const total = payload.meta?.total ?? payload.data?.length ?? 0;
      // total 이 100 초과면 나머지 페이지도 순차 로드(대회 규모 대비).
      const rows: AttendeeRow[] = [...(payload.data ?? [])];
      const pages = Math.ceil(total / 100);
      for (let p = 2; p <= pages && p <= 100; p += 1) {
        const r = await fetchWithRefresh(`/api/events/${eventId}/attendees?limit=100&page=${p}`, { credentials: "include" });
        if (!r.ok) break;
        const pj = (await r.json()) as { data?: AttendeeRow[] };
        rows.push(...(pj.data ?? []));
      }
      const guests = rows
        .filter((a) => a.ticketNumber)
        .map((a) => ({
          ticketNumber: a.ticketNumber as string,
          name: a.name ?? "이름 미상",
          productName: a.productName ?? null,
          admissionMode: a.admissionMode ?? null,
          status: a.status ?? "confirmed",
        }));
      await saveRoster(eventId, guests);
      // 🔴 화면 조회용 원본도 보관한다 — 캐시용 축약본에는 연락처·경품번호가 없다.
      setRoster(rows);
      setRosterCount(guests.length);
      setRosterCachedAt(Date.now());
    } catch {
      // 캐시 실패는 온라인 정상 경로에 영향 없음(폴백 준비만 실패).
    }
  }, [eventId, online]);

  const refresh = useCallback(
    async (currentListId?: string) => {
      const listId = currentListId ?? selectedListId;
      const params = new URLSearchParams();
      if (listId) params.set("listId", listId);
      setError(null);
      try {
        const [listsResponse, attendeesResponse, checkedInResponse] = await Promise.all([
          fetchWithRefresh(`/api/events/${eventId}/check-in-lists?${params.toString()}`, { credentials: "include" }),
          fetchWithRefresh(`/api/events/${eventId}/attendees`, { credentials: "include" }),
          fetchWithRefresh(`/api/events/${eventId}/attendees?status=checked_in`, { credentials: "include" }),
        ]);
        // 🔴 종전에는 셋 중 하나만 실패해도 조용히 return 했다. 그러면 `lists` 가 빈 배열로
        //    남아 화면이 "체크인 리스트가 없습니다(먼저 만드세요)" 라는 **틀린 안내**를 띄우고
        //    QR 스캐너가 아예 렌더되지 않는다 — 게이트 스태프에겐 원인 없는 먹통으로 보인다.
        //
        //    리스트만 있으면 스캔은 가능하다. 참석자 통계·오프라인 로스터(PII 포함이라
        //    organizer 이상 전용)가 막히는 건 스캔을 막을 이유가 아니다 → 부분 실패로 낮춘다.
        if (!listsResponse.ok) {
          setError(
            listsResponse.status === 403
              ? "체크인 리스트를 볼 권한이 없습니다. 주최자에게 권한을 요청해주세요."
              : "체크인 리스트를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
          );
          return;
        }
        const listsPayload = (await listsResponse.json()) as { data?: { items?: CheckInListItem[]; recentLogs?: CheckInLogItem[] } };
        // 참석자 조회 실패는 통계·오프라인 로스터만 비운다(스캔은 계속 가능).
        const attendeesPayload = attendeesResponse.ok
          ? ((await attendeesResponse.json()) as { data?: unknown[]; meta?: { total?: number } })
          : { data: [], meta: { total: 0 } };
        const checkedInPayload = checkedInResponse.ok
          ? ((await checkedInResponse.json()) as { data?: unknown[]; meta?: { total?: number } })
          : { data: [], meta: { total: 0 } };
        setLists(listsPayload.data?.items ?? []);
        setLogs(listsPayload.data?.recentLogs ?? []);
        setStats({
          total: attendeesPayload.meta?.total ?? attendeesPayload.data?.length ?? 0,
          checkedIn: checkedInPayload.meta?.total ?? checkedInPayload.data?.length ?? 0,
        });
        if (!listId && (listsPayload.data?.items?.length ?? 0) > 0) {
          setSelectedListId(listsPayload.data?.items?.[0]?.id ?? "");
        }
      } catch {
        // 새로고침 실패는 조용히 무시(다음 액션에서 재시도).
      }
    },
    [eventId, selectedListId],
  );

  // 마운트/리스트 변경/온라인 전환 시 데이터 로드·명단 캐시. 콜백을 ref 로 참조해 effect 가
  // setState 를 직접 트리거하지 않도록 한다(외부 시스템=네트워크 fetch 동기화).
  const refreshRef = useRef(refresh);
  const cacheRosterRef = useRef(cacheRoster);
  useEffect(() => {
    refreshRef.current = refresh;
    cacheRosterRef.current = cacheRoster;
  });

  useEffect(() => {
    void refreshRef.current(selectedListId);
  }, [selectedListId]);

  useEffect(() => {
    void cacheRosterRef.current();
  }, [eventId, online]);

  return {
    error,
    lists,
    selectedListId,
    setSelectedListId,
    logs,
    stats,
    roster,
    rosterCount,
    rosterCachedAt,
    refresh,
    cacheRoster,
  };
}
