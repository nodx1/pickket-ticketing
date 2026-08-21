"use client";

/**
 * 라이브 요약 폴링.
 *
 * ## 🔴 폴링이다. SSE·WebSocket 이 아니다
 * 골프장은 네트워크가 끊긴다. 끊긴 소켓은 되살릴 절차가 필요하지만, 폴링은
 * **다음 번에 그냥 다시 읽는다.** 갤러리 수천 명 × 재연결 로직은 우리가 감당할 게 아니다.
 *
 * ## 🔴 세 가지를 지킨다
 * ```
 * 1  탭이 백그라운드면 멈춘다     주머니 속 폰 수천 대가 계속 때리면 안 된다
 * 2  실패해도 화면을 비우지 않는다  직전 값을 유지하고 기준 시각을 표시한다
 * 3  겹쳐 부르지 않는다           느린 응답 하나가 요청을 쌓지 않게 한다
 * ```
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveSummary } from "./types";

/** 갱신 주기. 서버 캐시도 20초라 이보다 짧게 해도 새 값이 없다. */
export const LIVE_POLL_MS = 20_000;

export interface LiveFeed {
  /** 마지막으로 **성공**한 응답. 실패해도 지워지지 않는다. */
  summary: LiveSummary | null;
  /** 아직 한 번도 못 받았다(첫 로딩). */
  loading: boolean;
  /** 마지막 시도가 실패했다 — 값은 유지하되 화면이 기준 시각을 밝힌다. */
  failing: boolean;
  /** 마지막 성공 수신 시각(ms). 없으면 `null`. */
  lastOkAt: number | null;
}

/**
 * 요약을 읽을 곳.
 *
 * 🔴 **경로가 곧 권한이다.** 공개 경로는 리허설을 걸러내고, 주최자 경로는 그대로 준다.
 *    쿼리·헤더로 리허설을 켤 수 있게 만들지 않는다 — 링크 한 번 새면 되돌릴 수 없다.
 */
export type LiveFeedSource =
  | { kind: "ticket"; ticketNumber: string }
  | { kind: "organizer"; eventId: string };

function feedUrl(src: LiveFeedSource): string {
  return src.kind === "ticket"
    ? `/api/public/live/summary?ticket=${encodeURIComponent(src.ticketNumber)}`
    // 🔴 `/live` 는 대시보드 SSE 스트림이다(JSON 아님). `res.json()` 이 영원히 안 끝나
    //    로딩이 고착한다. 요약은 반드시 `/live/summary` 다.
    : `/api/events/${encodeURIComponent(src.eventId)}/live/summary`;
}

async function fetchSummary(src: LiveFeedSource, signal: AbortSignal): Promise<LiveSummary> {
  const res = await fetch(feedUrl(src), { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`live summary ${res.status}`);
  const body: unknown = await res.json();
  const data = (body as { data?: LiveSummary })?.data ?? (body as LiveSummary);
  // 🔴 모양 검사 — 응답이 다르면 **옛 값을 지키는 편이 낫다**(빈 화면보다).
  //    `status` 는 진행 단계 축이고 `stale` 은 직교하는 정지 축이다. 둘 다 있어야 요약이다.
  const shaped =
    typeof (data as LiveSummary)?.status === "string" &&
    typeof (data as LiveSummary)?.stale === "boolean";
  if (!data || !shaped) {
    throw new Error("live summary 응답 모양이 다르다");
  }
  return data as LiveSummary;
}

export function useLiveSummary(source: string | LiveFeedSource): LiveFeed {
  // 문자열은 종전 호출부(티켓 번호) — 시그니처를 깨지 않는다.
  const src: LiveFeedSource =
    typeof source === "string" ? { kind: "ticket", ticketNumber: source } : source;
  const srcKey = feedUrl(src);
  const [summary, setSummary] = useState<LiveSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [failing, setFailing] = useState(false);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);

  /** 진행 중인 요청 — 겹쳐 부르지 않기 위한 표식. */
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopped = useRef(false);

  const tick = useCallback(async () => {
    if (inFlight.current || stopped.current) return;
    inFlight.current = true;
    const ac = new AbortController();
    try {
      const next = await fetchSummary(src, ac.signal);
      if (stopped.current) return;
      setSummary(next);
      setLastOkAt(Date.now());
      setFailing(false);
    } catch {
      // 🔴 값을 지우지 않는다. 실패 표시만 켠다.
      if (!stopped.current) setFailing(true);
    } finally {
      inFlight.current = false;
      if (!stopped.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcKey]);

  useEffect(() => {
    stopped.current = false;

    function clear() {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    }

    /** 보이는 동안만 도는 루프. */
    function schedule() {
      clear();
      timer.current = setTimeout(run, LIVE_POLL_MS);
    }

    async function run() {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        // 🔴 백그라운드면 **부르지 않는다.** 타이머도 다시 걸지 않는다 —
        //    다시 보일 때 visibilitychange 가 깨운다.
        return;
      }
      await tick();
      if (!stopped.current) schedule();
    }

    function onVisibility() {
      if (stopped.current) return;
      if (document.visibilityState === "visible") {
        // 돌아오면 즉시 한 번 읽고 루프를 재개한다(오래된 값을 보여주지 않는다).
        void run();
      } else {
        clear();
      }
    }

    void run();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped.current = true;
      clear();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [tick]);

  return { summary, loading, failing, lastOkAt };
}
