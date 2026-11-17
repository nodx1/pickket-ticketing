"use client";

/**
 * 웹 현장 단말 — 키오스크·POS·게이트 태블릿에서 브라우저로 띄우는 입장 단말 (과업 WP6).
 *
 *  - 단말 키로 v2 Socket.IO `/terminal` 에 직접 접속(이 기기에만 저장)
 *  - 스캐너(키보드 입력형)·카메라·수기 입력(POS) → scan → 판정을 크게 표시
 *  - 접속 즉시·변경 즉시 차단 목록을 받아 두고, 연결이 끊겨도 차단 티켓은 화면에서 바로 막는다
 *  - 다른 게이트의 부정 경보(캡처 재사용 등)를 실시간으로 받아 보여 준다
 *  - 소켓이 끊기면 REST(/api/v1/terminals/scan)로 대신 보낸다
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { AlertTriangle, CheckCircle2, KeyRound, Keyboard, LogOut, ScanLine, ShieldAlert, Wifi, WifiOff, XCircle } from "lucide-react";

import { cn } from "@/lib/utils";

interface Decision {
  result: "admitted" | "reentry_ok" | "rejected";
  code: string;
  message: string;
  ticket_no: string | null;
  holder?: string | null;
  tier?: string | null;
  gate?: string | null;
  fraud?: boolean;
  duplicate_read?: boolean;
  at: string;
}
interface Hello {
  terminal_id: string;
  event_id: string;
  gate: string;
  name: string;
  kind: string;
}
interface Blocklist {
  version: number;
  blocked: Array<{ ticket_no: string; reason: string }>;
  sanctioned: string[];
}

const STORAGE_KEY = "pickket.terminal.key";

function readKey(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export default function TerminalPage() {
  const [key, setKey] = useState("");
  const [draftKey, setDraftKey] = useState("");
  const [config, setConfig] = useState<{ url: string; path: string; rest: string } | null>(null);
  const [state, setState] = useState<"idle" | "connecting" | "live" | "offline" | "denied">("idle");
  const [hello, setHello] = useState<Hello | null>(null);
  const [blocklist, setBlocklist] = useState<Blocklist | null>(null);
  const [current, setCurrent] = useState<Decision | null>(null);
  const [history, setHistory] = useState<Decision[]>([]);
  const [alerts, setAlerts] = useState<Decision[]>([]);
  const [manual, setManual] = useState(false);
  const [input, setInput] = useState("");
  const socketRef = useRef<Socket | null>(null);
  const helloRef = useRef<Hello | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setKey(readKey());
    void fetch("/api/terminal/config")
      .then((r) => r.json())
      .then((j: { data: { url: string; path: string; rest: string } }) => setConfig(j.data))
      .catch(() => setConfig({ url: "", path: "/ws/socket.io", rest: "/api/v1/terminals" }));
  }, []);

  useEffect(() => {
    if (!key || !config) return;
    setState("connecting");
    const socket = io(`${config.url || window.location.origin}/terminal`, {
      path: config.path,
      transports: ["websocket"],
      auth: { key },
      reconnectionDelayMax: 5_000,
    });
    socketRef.current = socket;
    socket.on("connect", () => setState("live"));
    socket.on("disconnect", () => setState("offline"));
    socket.on("connect_error", (err) => setState(err.message.includes("unauthorized") ? "denied" : "offline"));
    socket.on("hello", (h: Hello) => {
      helloRef.current = h;
      setHello(h);
    });
    socket.on("blocklist.sync", (b: Blocklist) => setBlocklist(b));
    // 다른 단말의 부정 경보만 모은다(내 판정은 큰 화면에 이미 보인다)
    socket.on("fraud.alert", (d: Decision & { terminal_id?: string | null }) => {
      if (d.terminal_id && d.terminal_id === helloRef.current?.terminal_id) return;
      setAlerts((prev) => [d, ...prev].slice(0, 10));
    });
    socket.on("permission.update", (p: { status?: string; gate?: string }) => {
      if (p.status && p.status !== "active") setState("denied");
      if (p.gate) setHello((h) => (h ? { ...h, gate: p.gate! } : h));
    });
    const beat = setInterval(() => socket.emit("heartbeat", {}), 20_000);
    return () => {
      clearInterval(beat);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [key, config]);

  useEffect(() => {
    if (!current) return;
    const t = setTimeout(() => setCurrent(null), current.result === "rejected" ? 6_000 : 3_000);
    inputRef.current?.focus();
    return () => clearTimeout(t);
  }, [current]);

  const scan = useCallback(
    async (payload: string) => {
      const value = payload.trim();
      if (!value) return;
      const ticketNo = manual ? value.toUpperCase() : value.split(":")[1] ?? "";
      // 연결이 끊겨도 차단 목록에 있는 티켓은 화면에서 바로 막는다
      const blockedLocally =
        blocklist && (blocklist.blocked.some((b) => b.ticket_no === ticketNo) || blocklist.sanctioned.includes(ticketNo));
      const send = async (): Promise<Decision> => {
        const socket = socketRef.current;
        if (socket?.connected) {
          return (await socket.timeout(8_000).emitWithAck("scan", { payload: value, manual, scanned_at: new Date().toISOString() })) as Decision;
        }
        const res = await fetch(`${config?.rest ?? ""}/scan`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Terminal-Key": key },
          body: JSON.stringify({ payload: value, manual, scanned_at: new Date().toISOString() }),
        });
        if (res.status === 401) {
          setState("denied");
          throw new Error("사용이 중지된 단말입니다");
        }
        return (await res.json()) as Decision;
      };
      try {
        if (blockedLocally && state !== "live") {
          setCurrent({ result: "rejected", code: "blocked_ticket", message: "입장이 차단된 티켓입니다(단말 차단 목록).", ticket_no: ticketNo, fraud: true, at: new Date().toISOString() });
          return;
        }
        const decision = await send();
        setCurrent(decision);
        if (!decision.duplicate_read) setHistory((prev) => [decision, ...prev].slice(0, 30));
      } catch (err) {
        setCurrent({ result: "rejected", code: "network", message: err instanceof Error ? err.message : "서버에 연결할 수 없습니다", ticket_no: ticketNo || null, at: new Date().toISOString() });
      } finally {
        setInput("");
      }
    },
    [blocklist, config?.rest, key, manual, state],
  );

  if (!key) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-bg-muted p-6">
        <form
          className="w-full max-w-md rounded-xl border border-border bg-card p-8 shadow-sm"
          onSubmit={(e) => {
            e.preventDefault();
            const k = draftKey.trim();
            if (!k) return;
            try {
              localStorage.setItem(STORAGE_KEY, k);
            } catch {
              /* 저장 불가 — 이번 세션만 */
            }
            setKey(k);
          }}
        >
          <span className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <KeyRound className="size-6" />
          </span>
          <h1 className="mt-4 text-2xl font-black tracking-[-0.03em]">피켓 현장 단말</h1>
          <p className="mt-2 text-sm text-content-subtle">주최사 대시보드 ‘현장 입장 관리’에서 발급한 단말 키를 입력하세요. 키는 이 기기에만 저장됩니다.</p>
          <input
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
            placeholder="pkt_term_…"
            aria-label="단말 키"
            autoFocus
            className="mt-6 w-full rounded-md border border-border bg-card px-3 py-3 font-mono text-sm focus:border-primary focus:outline-none"
          />
          <button type="submit" className="btn-gradient mt-4 h-12 w-full rounded-full font-semibold text-white">
            단말 시작
          </button>
        </form>
      </main>
    );
  }

  const tone = !current ? "idle" : current.result === "rejected" ? (current.fraud ? "fraud" : "reject") : "ok";
  return (
    <main className="flex min-h-dvh flex-col bg-bg-muted">
      <header className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-5 py-3">
        <ScanLine className="size-5 text-primary" />
        <div className="min-w-0">
          <p className="truncate text-sm font-bold">{hello?.name ?? "현장 단말"}</p>
          <p className="text-xs text-content-subtle">게이트 {hello?.gate ?? "-"}</p>
        </div>
        <span
          className={cn(
            "ml-auto inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold",
            state === "live" ? "bg-success/10 text-success" : state === "denied" ? "bg-destructive/10 text-destructive" : "bg-warning/15 text-warning",
          )}
        >
          {state === "live" ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
          {{ idle: "준비", connecting: "연결 중", live: "실시간 연결", offline: "연결 끊김 — REST 전송", denied: "사용 중지된 단말" }[state]}
        </span>
        <span className="text-xs text-content-subtle">
          차단 {blocklist ? blocklist.blocked.length + blocklist.sanctioned.length : 0}건
        </span>
        <button
          type="button"
          onClick={() => {
            try {
              localStorage.removeItem(STORAGE_KEY);
            } catch {
              /* noop */
            }
            setKey("");
            setDraftKey("");
          }}
          className="inline-flex items-center gap-1 text-xs text-content-subtle hover:text-foreground"
        >
          <LogOut className="size-3.5" /> 키 변경
        </button>
      </header>

      <div className="grid flex-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section
          aria-live="assertive"
          className={cn(
            "flex min-h-[22rem] flex-col items-center justify-center rounded-2xl border-2 p-8 text-center transition-colors",
            tone === "idle" && "border-border bg-card",
            tone === "ok" && "border-success bg-success/10",
            tone === "reject" && "border-warning bg-warning/10",
            tone === "fraud" && "border-destructive bg-destructive/10",
          )}
        >
          {tone === "idle" ? (
            <>
              <ScanLine className="size-16 text-primary" />
              <p className="mt-4 text-2xl font-black">QR을 스캔해 주세요</p>
              <p className="mt-2 text-sm text-content-subtle">회전 QR 화면을 스캐너에 대 주세요.</p>
            </>
          ) : (
            <>
              {tone === "ok" ? (
                <CheckCircle2 className="size-20 text-success" />
              ) : tone === "fraud" ? (
                <ShieldAlert className="size-20 text-destructive" />
              ) : (
                <XCircle className="size-20 text-warning" />
              )}
              <p className="mt-4 text-4xl font-black tracking-[-0.03em]">
                {current!.result === "admitted" ? "입장" : current!.result === "reentry_ok" ? "재입장" : "입장 불가"}
              </p>
              <p className="mt-3 max-w-lg text-base text-foreground">{current!.message}</p>
              <p className="mt-3 font-mono text-sm text-content-subtle">
                {current!.ticket_no ?? ""} {current!.holder ? `· ${current!.holder}` : ""} {current!.tier ? `· ${current!.tier}` : ""}
              </p>
            </>
          )}
        </section>

        <aside className="space-y-4">
          <form
            className="rounded-xl border border-border bg-card p-4"
            onSubmit={(e) => {
              e.preventDefault();
              void scan(input);
            }}
          >
            <label htmlFor="scan-input" className="text-xs font-semibold text-content-subtle">
              {manual ? "티켓번호 직접 입력" : "스캐너 입력"}
            </label>
            <input
              id="scan-input"
              ref={inputRef}
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={manual ? "TKT-…" : "PKT:…"}
              className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 font-mono text-sm focus:border-primary focus:outline-none"
            />
            <div className="mt-3 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setManual((m) => !m)}
                className={cn("inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-semibold", manual ? "border-primary text-primary" : "border-border text-content-subtle")}
              >
                <Keyboard className="size-3.5" /> 수기 입력(POS)
              </button>
              <button type="submit" className="btn-gradient h-9 rounded-full px-4 text-sm font-semibold text-white">
                확인
              </button>
            </div>
          </form>

          {alerts.length ? (
            <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
              <p className="flex items-center gap-1.5 text-sm font-bold text-destructive">
                <AlertTriangle className="size-4" /> 다른 게이트 부정 경보
              </p>
              <ul className="mt-2 space-y-1 text-xs">
                {alerts.map((a, i) => (
                  <li key={`${a.at}-${i}`}>
                    <span className="font-mono">{a.ticket_no}</span> · {a.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="rounded-xl border border-border bg-card p-4">
            <p className="text-sm font-bold">최근 판정</p>
            <ul className="mt-2 max-h-80 space-y-1 overflow-auto text-xs">
              {history.map((h, i) => (
                <li key={`${h.at}-${i}`} className="flex items-center gap-2">
                  <span className={cn("size-2 rounded-full", h.result === "rejected" ? (h.fraud ? "bg-destructive" : "bg-warning") : "bg-success")} />
                  <span className="shrink-0 whitespace-nowrap font-mono">{h.ticket_no ?? "-"}</span>
                  <span className="truncate text-content-subtle">{h.message}</span>
                </li>
              ))}
              {history.length === 0 ? <li className="text-content-subtle">아직 없습니다.</li> : null}
            </ul>
          </div>
        </aside>
      </div>
    </main>
  );
}
