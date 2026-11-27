"use client";

/**
 * 웹 현장 단말 — 직원 휴대폰·태블릿, 키오스크·POS·게이트 PC 에서 브라우저로 띄우는 입장 단말 (과업 WP6).
 *
 *  - 피켓고 「직원 입장 링크」(`/terminal#k=단말키`)로 열면 키를 이 기기에 저장하고 주소에서 지운 뒤 바로 시작한다.
 *    키오스크·POS 는 키를 직접 입력해도 된다.
 *  - 단말 키로 v2 Socket.IO `/terminal` 에 직접 접속한다.
 *  - 읽는 방법: 카메라(휴대폰·태블릿 기본) · 스캐너(키보드 입력형, PC 기본) · 수기 입력(POS 만)
 *  - 접속 즉시·변경 즉시 차단 목록을 받아 두고, 연결이 끊겨도 차단 티켓은 화면에서 바로 막는다
 *  - 다른 게이트의 부정 경보(캡처 재사용 등)를 실시간으로 받아 보여 준다
 *  - 소켓이 끊기면 REST(/api/v1/terminals/scan)로 대신 보낸다
 *  - 링크가 새로 바뀌었거나 중지·폐기됐거나 행사가 끝나 닫히면 그 이유를 크게 보여 준다
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { AlertTriangle, Camera, CheckCircle2, KeyRound, Keyboard, LogOut, ScanLine, ShieldAlert, Wifi, WifiOff, XCircle } from "lucide-react";

import { readTerminalKeyFromHash, shouldSendScan } from "@/lib/onsite/terminal-link";
import { cn } from "@/lib/utils";

import { CameraScanner, cameraProblemText, type CameraProblem } from "./camera-scanner";

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
type ConnState = "idle" | "connecting" | "live" | "offline" | "denied" | "closed";
type Mode = "camera" | "scanner";

const STORAGE_KEY = "pickket.terminal.key";

function readKey(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveKey(key: string) {
  try {
    if (key) localStorage.setItem(STORAGE_KEY, key);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 저장 불가 — 이번 세션만 */
  }
}

function buzz(result: Decision["result"]) {
  try {
    navigator.vibrate?.(result === "rejected" ? [90, 60, 90] : 60);
  } catch {
    /* 진동 없는 기기 */
  }
}

export default function TerminalPage() {
  const [key, setKey] = useState("");
  const [ready, setReady] = useState(false);
  const [draftKey, setDraftKey] = useState("");
  const [config, setConfig] = useState<{ url: string; path: string; rest: string } | null>(null);
  const [state, setState] = useState<ConnState>("idle");
  const [hello, setHello] = useState<Hello | null>(null);
  const [blocklist, setBlocklist] = useState<Blocklist | null>(null);
  const [current, setCurrent] = useState<Decision | null>(null);
  const [history, setHistory] = useState<Decision[]>([]);
  const [alerts, setAlerts] = useState<Decision[]>([]);
  const [manual, setManual] = useState(false);
  const [mode, setMode] = useState<Mode>("scanner");
  const [cameraProblem, setCameraProblem] = useState<CameraProblem | null>(null);
  const [input, setInput] = useState("");
  const socketRef = useRef<Socket | null>(null);
  const helloRef = useRef<Hello | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const lastSent = useRef<{ text: string; at: number } | null>(null);

  useEffect(() => {
    // 첫 설정도 타이머로 — 이펙트 본문에서 곧바로 상태를 바꾸지 않는다(react-hooks/set-state-in-effect)
    const first = setTimeout(() => {
      // 입장 링크로 열었으면 그 키가 우선한다. 저장한 뒤 주소에서 지워 캡처·공유에 키가 남지 않게 한다.
      const fromLink = readTerminalKeyFromHash(window.location.hash);
      if (fromLink) {
        saveKey(fromLink);
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
      setKey(fromLink ?? readKey());
      // 휴대폰·태블릿(손가락 입력)은 카메라로, PC 는 스캐너 입력으로 시작한다.
      const touch = window.matchMedia?.("(pointer: coarse)").matches ?? false;
      // (http 로 연 기기는 mediaDevices 자체가 없다 — 그때는 스캐너 입력으로 둔다)
      if (touch && typeof navigator.mediaDevices?.getUserMedia === "function") setMode("camera");
      setReady(true);
    }, 0);
    // 단말 화면이 이미 열린 탭에서 새 입장 링크를 열면 `#` 뒤만 바뀌어 페이지가 다시 읽히지 않는다.
    // 그때도 새 키로 갈아탄다(예전 링크가 끊긴 뒤 새 링크를 받은 경우).
    const onHash = () => {
      const next = readTerminalKeyFromHash(window.location.hash);
      if (!next) return;
      saveKey(next);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      setHello(null);
      setBlocklist(null);
      setCurrent(null);
      setState("idle");
      setKey(next);
    };
    window.addEventListener("hashchange", onHash);
    void fetch("/api/terminal/config")
      .then((r) => r.json())
      .then((j: { data: { url: string; path: string; rest: string } }) => setConfig(j.data))
      .catch(() => setConfig({ url: "", path: "/ws/socket.io", rest: "/api/v1/terminals" }));
    return () => {
      clearTimeout(first);
      window.removeEventListener("hashchange", onHash);
    };
  }, []);

  useEffect(() => {
    if (!key || !config) return;
    const socket = io(`${config.url || window.location.origin}/terminal`, {
      path: config.path,
      transports: ["websocket"],
      auth: { key },
      reconnectionDelayMax: 5_000,
    });
    socketRef.current = socket;
    const connecting = setTimeout(() => setState((s) => (s === "idle" ? "connecting" : s)), 0);
    socket.on("connect", () => setState("live"));
    socket.on("disconnect", (reason) => {
      setState((s) => (s === "denied" || s === "closed" ? s : "offline"));
      // 서버가 끊은 경우(새 링크 발급·중지·행사 종료)는 자동 재접속이 없다. 한 번 다시 붙어 보면
      // 거부 이유(unauthorized: …)가 connect_error 로 와서 화면이 그 이유를 보여 준다.
      if (reason === "io server disconnect") socket.connect();
    });
    socket.on("connect_error", (err) => {
      if (err.message.includes("event_closed")) {
        setState("closed");
        socket.disconnect();
      } else if (err.message.includes("unauthorized")) {
        setState("denied");
        socket.disconnect();
      } else {
        setState("offline");
      }
    });
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
      clearTimeout(connecting);
      clearInterval(beat);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [key, config]);

  useEffect(() => {
    if (!current) return;
    const t = setTimeout(() => setCurrent(null), current.result === "rejected" ? 6_000 : 3_000);
    // 카메라 모드(휴대폰)에서 입력칸에 초점을 주면 화면 키보드가 올라와 카메라를 가린다
    if (mode === "scanner") inputRef.current?.focus();
    return () => clearTimeout(t);
  }, [current, mode]);

  const scan = useCallback(
    async (payload: string, opts: { manual?: boolean } = {}) => {
      const value = payload.trim();
      if (!value) return;
      const isManual = opts.manual ?? false;
      // 피켓고 QR(PKT:티켓번호:…)만 화면에서 티켓번호를 읽을 수 있다. 피켓 앱 QR 은 서버가 판정한다.
      const ticketNo = isManual ? value.toUpperCase() : value.startsWith("PKT:") ? (value.split(":")[1] ?? "") : "";
      // 연결이 끊겨도 차단 목록에 있는 티켓은 화면에서 바로 막는다
      const blockedLocally =
        blocklist && (blocklist.blocked.some((b) => b.ticket_no === ticketNo) || blocklist.sanctioned.includes(ticketNo));
      const send = async (): Promise<Decision> => {
        const socket = socketRef.current;
        if (socket?.connected) {
          return (await socket.timeout(8_000).emitWithAck("scan", { payload: value, manual: isManual, scanned_at: new Date().toISOString() })) as Decision;
        }
        const res = await fetch(`${config?.rest ?? ""}/scan`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Terminal-Key": key },
          body: JSON.stringify({ payload: value, manual: isManual, scanned_at: new Date().toISOString() }),
        });
        if (res.status === 401) {
          const body = (await res.json().catch(() => ({}))) as { detail?: string; error?: { message?: string } };
          const detail = body.detail ?? body.error?.message ?? "";
          const closed = detail.includes("행사가 끝나");
          setState(closed ? "closed" : "denied");
          throw new Error(closed ? "행사가 끝나 이 입장 링크는 닫혔습니다" : "사용이 중지된 단말입니다");
        }
        return (await res.json()) as Decision;
      };
      inFlight.current = true;
      try {
        if (blockedLocally && state !== "live") {
          const d: Decision = { result: "rejected", code: "blocked_ticket", message: "입장이 차단된 티켓입니다(단말 차단 목록).", ticket_no: ticketNo, fraud: true, at: new Date().toISOString() };
          setCurrent(d);
          buzz(d.result);
          return;
        }
        const decision = await send();
        setCurrent(decision);
        buzz(decision.result);
        if (!decision.duplicate_read) setHistory((prev) => [decision, ...prev].slice(0, 30));
      } catch (err) {
        setCurrent({ result: "rejected", code: "network", message: err instanceof Error ? err.message : "서버에 연결할 수 없습니다", ticket_no: ticketNo || null, at: new Date().toISOString() });
        buzz("rejected");
      } finally {
        inFlight.current = false;
        setInput("");
      }
    },
    [blocklist, config?.rest, key, state],
  );

  const onCameraDecode = useCallback(
    (text: string) => {
      const now = Date.now();
      if (!shouldSendScan(text, lastSent.current, now, { inFlight: inFlight.current })) return;
      lastSent.current = { text, at: now };
      void scan(text);
    },
    [scan],
  );

  const resetKey = () => {
    saveKey("");
    setKey("");
    setDraftKey("");
    setHello(null);
    setBlocklist(null);
    setCurrent(null);
    setHistory([]);
    setAlerts([]);
    setState("idle");
  };

  if (!ready) {
    return <main className="min-h-dvh bg-bg-muted" />;
  }

  if (!key) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-bg-muted p-4 sm:p-6">
        <form
          className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8"
          onSubmit={(e) => {
            e.preventDefault();
            const k = draftKey.trim();
            if (!k) return;
            saveKey(k);
            setKey(k);
          }}
        >
          <span className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <KeyRound className="size-6" />
          </span>
          <h1 className="mt-4 text-2xl font-black tracking-[-0.03em]">피켓 현장 단말</h1>
          <p className="mt-2 text-sm text-content-subtle">
            주최사가 보내 준 <b className="text-foreground">입장 링크</b>를 열면 바로 시작돼요. 키오스크·POS는 피켓고 「현장 입장 관리」에서 받은 단말 키를 입력하세요.
          </p>
          <input
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
            placeholder="pkt_term_…"
            aria-label="단말 키"
            className="mt-6 w-full rounded-md border border-border bg-card px-3 py-3 font-mono text-sm focus:border-primary focus:outline-none"
          />
          <button type="submit" className="btn-gradient mt-4 h-12 w-full rounded-full font-semibold text-white">
            단말 시작
          </button>
        </form>
      </main>
    );
  }

  const blockedView = state === "denied" || state === "closed";
  const tone = !current ? "idle" : current.result === "rejected" ? (current.fraud ? "fraud" : "reject") : "ok";
  return (
    <main className="flex min-h-dvh flex-col bg-bg-muted">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-card px-4 py-2.5 sm:px-5 sm:py-3">
        <ScanLine className="size-5 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold">{hello?.name ?? "현장 단말"}</p>
          <p className="text-xs text-content-subtle">게이트 {hello?.gate ?? "-"}</p>
        </div>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold",
            state === "live" ? "bg-success/10 text-success" : blockedView ? "bg-destructive/10 text-destructive" : "bg-warning/15 text-warning",
          )}
        >
          {state === "live" ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
          {{ idle: "준비", connecting: "연결 중", live: "실시간 연결", offline: "연결 끊김 — REST 전송", denied: "사용 중지된 단말", closed: "행사 종료" }[state]}
        </span>
        <span className="hidden text-xs text-content-subtle sm:inline">차단 {blocklist ? blocklist.blocked.length + blocklist.sanctioned.length : 0}건</span>
        <button type="button" onClick={resetKey} className="inline-flex items-center gap-1 text-xs text-content-subtle hover:text-foreground">
          <LogOut className="size-3.5" /> 키 변경
        </button>
      </header>

      {blockedView ? (
        <div className="flex flex-1 items-center justify-center p-4">
          <div role="alert" className="w-full max-w-md rounded-2xl border-2 border-destructive bg-card p-8 text-center">
            <XCircle className="mx-auto size-16 text-destructive" />
            <p className="mt-4 text-2xl font-black">이 입장 링크는 쓸 수 없어요</p>
            <p className="mt-3 text-sm text-content-subtle">
              {state === "closed"
                ? "행사가 끝나 링크가 자동으로 닫혔어요."
                : "새 링크로 바뀌었거나 주최사가 사용을 멈췄어요. 피켓고 「현장 입장 관리」에서 새 링크를 받아 주세요."}
            </p>
            <button type="button" onClick={resetKey} className="btn-gradient mt-6 h-12 w-full rounded-full font-semibold text-white">
              다른 링크·키로 시작
            </button>
          </div>
        </div>
      ) : (
        <div className="grid flex-1 content-start gap-4 p-3 sm:p-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="space-y-3">
            {mode === "camera" ? (
              <div className="mx-auto w-full max-w-md">
                {cameraProblem ? (
                  <div role="alert" className="flex aspect-square w-full flex-col items-center justify-center gap-3 rounded-2xl border border-warning bg-warning/10 p-6 text-center">
                    <Camera className="size-10 text-warning" />
                    <p className="text-sm text-foreground">{cameraProblemText(cameraProblem)}</p>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => setCameraProblem(null)} className="rounded-full border border-border bg-card px-4 py-2 text-sm font-semibold">
                        다시 시도
                      </button>
                      <button type="button" onClick={() => setMode("scanner")} className="rounded-full border border-border bg-card px-4 py-2 text-sm font-semibold">
                        스캐너 입력으로
                      </button>
                    </div>
                  </div>
                ) : (
                  <CameraScanner onDecode={onCameraDecode} onError={setCameraProblem} />
                )}
              </div>
            ) : null}

            <section
              aria-live="assertive"
              data-testid="terminal-decision"
              className={cn(
                "mx-auto flex w-full flex-col items-center justify-center rounded-2xl border-2 p-5 text-center transition-colors sm:p-8",
                mode === "camera" ? "min-h-[9rem] max-w-md" : "min-h-[22rem]",
                tone === "idle" && "border-border bg-card",
                tone === "ok" && "border-success bg-success/10",
                tone === "reject" && "border-warning bg-warning/10",
                tone === "fraud" && "border-destructive bg-destructive/10",
              )}
            >
              {tone === "idle" ? (
                mode === "camera" ? (
                  <p className="text-lg font-bold text-foreground">관객 티켓 QR을 네모 안에 비춰 주세요</p>
                ) : (
                  <>
                    <ScanLine className="size-16 text-primary" />
                    <p className="mt-4 text-2xl font-black">QR을 스캔해 주세요</p>
                    <p className="mt-2 text-sm text-content-subtle">회전 QR 화면을 스캐너에 대 주세요.</p>
                  </>
                )
              ) : (
                <>
                  {tone === "ok" ? (
                    <CheckCircle2 className={cn("text-success", mode === "camera" ? "size-12" : "size-20")} />
                  ) : tone === "fraud" ? (
                    <ShieldAlert className={cn("text-destructive", mode === "camera" ? "size-12" : "size-20")} />
                  ) : (
                    <XCircle className={cn("text-warning", mode === "camera" ? "size-12" : "size-20")} />
                  )}
                  <p className={cn("font-black tracking-[-0.03em]", mode === "camera" ? "mt-2 text-3xl" : "mt-4 text-4xl")}>
                    {current!.result === "admitted" ? "입장" : current!.result === "reentry_ok" ? "재입장" : "입장 불가"}
                  </p>
                  <p className="mt-2 max-w-lg text-base text-foreground">{current!.message}</p>
                  <p className="mt-2 font-mono text-sm text-content-subtle">
                    {current!.ticket_no ?? ""} {current!.holder ? `· ${current!.holder}` : ""} {current!.tier ? `· ${current!.tier}` : ""}
                  </p>
                </>
              )}
            </section>
          </div>

          <aside className="space-y-4">
            <div className="flex rounded-full border border-border bg-card p-1" role="group" aria-label="QR 읽는 방법">
              {(
                [
                  ["camera", "카메라", Camera],
                  ["scanner", "스캐너·직접 입력", Keyboard],
                ] as const
              ).map(([value, label, Icon]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  onClick={() => {
                    setCameraProblem(null);
                    setMode(value);
                    if (value === "camera") setManual(false);
                  }}
                  className={cn(
                    "inline-flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-2 text-sm font-semibold",
                    mode === value ? "bg-primary text-primary-foreground" : "text-content-subtle",
                  )}
                >
                  <Icon className="size-4" /> {label}
                </button>
              ))}
            </div>

            {mode === "scanner" ? (
              <form
                className="rounded-xl border border-border bg-card p-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void scan(input, { manual });
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
                  placeholder={manual ? "TKT-…" : "피켓·피켓고 티켓 QR"}
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
            ) : null}

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
      )}
    </main>
  );
}
