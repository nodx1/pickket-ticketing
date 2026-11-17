"use client";

/**
 * 현장 실시간 연결 — v2 Socket.IO `/monitor` 네임스페이스.
 *
 * 토큰은 서버(go)가 v2 에서 받아 내려준다(1시간). 끊기면 토큰을 새로 받아 다시 붙는다.
 * 받은 이벤트: admission(판정) · fraud.alert(부정 탐지) · terminal.status · sanction · blocklist.sync
 */
import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

import { gw } from "@/components/gwasup/ui";

export interface LiveDecision {
  result: string;
  code: string;
  message: string;
  ticket_no: string | null;
  holder?: string | null;
  tier?: string | null;
  gate: string | null;
  terminal_id?: string | null;
  terminal_name?: string;
  fraud: boolean;
  at: string;
}

export type LiveState = "connecting" | "live" | "offline";

export function useOnsiteLive(
  eventId: string,
  handlers: {
    onDecision: (d: LiveDecision) => void;
    onFraud: (d: LiveDecision) => void;
    onChange: () => void;
  },
) {
  const [state, setState] = useState<LiveState>("connecting");
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    let socket: Socket | null = null;
    let cancelled = false;

    const connect = async () => {
      try {
        const { token, url, path } = await gw<{ token: string; url: string; path: string }>(eventId, "onsite/monitor-token");
        if (cancelled) return;
        socket = io(`${url || window.location.origin}/monitor`, {
          path,
          transports: ["websocket"],
          auth: { token },
          reconnectionDelayMax: 10_000,
        });
        socket.on("connect", () => setState("live"));
        socket.on("disconnect", () => setState("offline"));
        socket.on("connect_error", async () => {
          setState("offline");
          // 토큰 만료 등 — 새 토큰으로 다시 붙는다
          try {
            const fresh = await gw<{ token: string }>(eventId, "onsite/monitor-token");
            if (socket) socket.auth = { token: fresh.token };
          } catch {
            /* 다음 재시도에서 다시 */
          }
        });
        socket.on("admission", (d: LiveDecision) => ref.current.onDecision(d));
        socket.on("fraud.alert", (d: LiveDecision) => ref.current.onFraud(d));
        socket.on("terminal.status", () => ref.current.onChange());
        socket.on("sanction", () => ref.current.onChange());
        socket.on("blocklist.sync", () => ref.current.onChange());
      } catch {
        setState("offline");
      }
    };
    void connect();
    return () => {
      cancelled = true;
      socket?.disconnect();
    };
  }, [eventId]);

  return state;
}
