"use client";

import { useEffect, useRef, useState, useCallback } from "react";

export interface Task {
  id: string;
  developer: string;
  description: string;
  files: string[];
  branch: string;
  status: string;
  started_at: string;
  completed_at?: string;
  summary?: string;
  next_steps?: string;
  pr_url?: string;
  notes?: { message: string; timestamp: string }[];
}

export interface FileLock {
  file_path: string;
  task_id: string;
  developer: string;
  branch: string;
  locked_at: string;
}

export interface Blocker {
  id: string;
  developer: string;
  issue: string;
  severity: "low" | "high" | "critical";
  timestamp: string;
  resolved: boolean;
}

export interface Handoff {
  task_id: string;
  developer: string;
  description: string;
  summary: string;
  next_steps?: string;
  pr_url?: string;
  branch: string;
  timestamp: string;
}

export interface DevState {
  tasks: Task[];
  locks: Record<string, FileLock>;
  blockers: Blocker[];
  handoffs: Handoff[];
  connected: boolean;
}

const MCP_SERVER =
  process.env.NEXT_PUBLIC_MCP_SERVER_URL ?? "https://mcp-staging.pickket.kr";

export function useDevStream(): DevState & { refresh: () => void } {
  const [state, setState] = useState<DevState>({
    tasks: [],
    locks: {},
    blockers: [],
    handoffs: [],
    connected: false,
  });
  const abortRef = useRef<AbortController | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCount = useRef(0);
  const MAX_RETRIES = 10;
  const connectRef = useRef<() => void>(null!);

  // 단일 SSE 프레임("event: X\ndata: Y") 을 받아 상태에 반영.
  const applyEvent = useCallback((eventName: string, dataStr: string) => {
    let data: unknown;
    try {
      data = dataStr ? JSON.parse(dataStr) : null;
    } catch {
      return;
    }
    switch (eventName) {
      case "init":
        setState((prev) => ({ ...prev, ...(data as object), connected: true }));
        break;
      case "task_claimed": {
        const task = data as Task;
        setState((prev) => ({
          ...prev,
          tasks: [task, ...prev.tasks.filter((t) => t.id !== task.id)],
        }));
        break;
      }
      case "task_updated": {
        const task = data as Task;
        setState((prev) => ({
          ...prev,
          tasks: prev.tasks.map((t) => (t.id === task.id ? task : t)),
        }));
        break;
      }
      case "task_completed": {
        const payload = data as Task & { handoff?: Handoff };
        const handoff = payload.handoff;
        setState((prev) => ({
          ...prev,
          tasks: prev.tasks.filter((t) => t.id !== payload.id),
          handoffs: handoff
            ? [handoff, ...prev.handoffs.slice(0, 19)]
            : prev.handoffs,
        }));
        break;
      }
      case "blocker_posted": {
        const blocker = data as Blocker;
        setState((prev) => ({
          ...prev,
          blockers: [
            blocker,
            ...prev.blockers.filter((b) => b.id !== blocker.id),
          ],
        }));
        break;
      }
      case "lock_acquired": {
        const { file, developer, branch } = data as {
          file: string;
          developer: string;
          branch: string;
        };
        setState((prev) => ({
          ...prev,
          locks: {
            ...prev.locks,
            [file]: {
              file_path: file,
              task_id: "",
              developer,
              branch,
              locked_at: new Date().toISOString(),
            },
          },
        }));
        break;
      }
      case "lock_released": {
        const { file } = data as { file: string };
        setState((prev) => {
          const newLocks = { ...prev.locks };
          delete newLocks[file];
          return { ...prev, locks: newLocks };
        });
        break;
      }
    }
  }, []);

  const connect = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const token =
      (typeof window !== "undefined" &&
        sessionStorage.getItem("pickket_mcp_token")) ??
      "";

    // EventSource 는 헤더를 못 보내 토큰을 URL 쿼리에 노출했었다(P2-C8 — 로그/히스토리/Referer 유출).
    // fetch + ReadableStream 으로 Authorization 헤더 전달하고 SSE 프레임을 직접 파싱한다.
    const scheduleReconnect = () => {
      if (controller.signal.aborted) return;
      setState((prev) => ({ ...prev, connected: false }));
      if (retryCount.current < MAX_RETRIES) {
        const delay = Math.min(1000 * Math.pow(2, retryCount.current), 30000);
        retryCount.current += 1;
        reconnectTimer.current = setTimeout(() => connectRef.current(), delay);
      }
    };

    (async () => {
      try {
        const res = await fetch(`${MCP_SERVER}/events`, {
          headers: {
            Accept: "text/event-stream",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);

        retryCount.current = 0;
        setState((prev) => ({ ...prev, connected: true }));

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          // SSE 프레임 구분자: 빈 줄(\n\n)
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            let eventName = "message";
            const dataLines: string[] = [];
            for (const line of frame.split("\n")) {
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
            }
            if (dataLines.length) applyEvent(eventName, dataLines.join("\n"));
          }
        }
        scheduleReconnect(); // 스트림 정상 종료 → 재접속
      } catch {
        scheduleReconnect();
      }
    })();
  }, [applyEvent]);

  useEffect(() => {
    connectRef.current = connect;
    connect();
    return () => {
      abortRef.current?.abort();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [connect]);

  return { ...state, refresh: connect };
}
