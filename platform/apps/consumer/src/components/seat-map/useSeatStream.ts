"use client";

import { useEffect, useRef } from "react";
import {
  buildEventWebSocketUrl,
  WSManager,
  type WSMessage,
} from "@pickket/lib/ws";

interface SeatUpdate {
  seat_id: string;
  status: string;
  user_id?: string;
}

export function useSeatStream(
  eventId: string,
  onUpdate: (update: SeatUpdate) => void,
) {
  const wsRef = useRef<WSManager | null>(null);
  const onUpdateRef = useRef(onUpdate);

  useEffect(() => {
    onUpdateRef.current = onUpdate;
  });

  useEffect(() => {
    const manager = new WSManager({
      url: buildEventWebSocketUrl(eventId, process.env.NEXT_PUBLIC_WS_URL),
      onMessage: (msg: WSMessage) => {
        if (msg.type === "seat_update" && msg.data) {
          onUpdateRef.current(msg.data as unknown as SeatUpdate);
        }
      },
    });

    manager.connect();
    manager.subscribe("seats", eventId);
    wsRef.current = manager;

    return () => {
      manager.unsubscribe("seats", eventId);
      manager.disconnect();
      wsRef.current = null;
    };
  }, [eventId]);
}
