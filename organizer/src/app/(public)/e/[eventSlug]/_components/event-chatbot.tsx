"use client";

import { CheckCircle2, Loader2, MessageCircle, Send, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface Message {
  role: "user" | "assistant";
  content: string;
}

// 세션 연속성: v2 챗봇이 발급하는 conversation_id 를 sessionKey 로 저장/재전송한다.
function readStoredSessionKey(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem("pickket-chat-key");
}

function storeSessionKey(key: string): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem("pickket-chat-key", key);
}

export function EventChatbot({ eventId, eventSlug }: { eventId: string; eventSlug: string }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  // escalation: 봇이 확답 불가로 판단(escalate=true) 하거나 사용자가 명시적으로 문의를 원할 때 폼 노출.
  const [escalate, setEscalate] = useState(false);
  const [inquiryContact, setInquiryContact] = useState("");
  const [inquirySubmitting, setInquirySubmitting] = useState(false);
  const [inquiryDone, setInquiryDone] = useState(false);
  const [inquiryError, setInquiryError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, open]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) {
      return;
    }

    const sessionKey = readStoredSessionKey();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setSending(true);

    try {
      const response = await fetch("/api/public/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, sessionKey: sessionKey ?? undefined, message: text }),
      });

      const payload = (await response.json()) as {
        data?: { reply: string; sessionKey?: string; escalate?: boolean };
        error?: string;
      };
      // v2 가 발급한 conversation_id(=sessionKey)를 저장해 다음 요청에 재사용(대화 맥락 유지).
      if (payload.data?.sessionKey) {
        storeSessionKey(payload.data.sessionKey);
      }
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content:
            payload.data?.reply ??
            payload.error ??
            "응답을 받을 수 없습니다.",
        },
      ]);
      if (payload.data?.escalate) {
        setEscalate(true);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "네트워크 오류가 발생했습니다. 다시 시도해주세요.",
        },
      ]);
    } finally {
      setSending(false);
    }
  }, [eventId, input, sending]);

  // escalation: 대화 맥락을 문의 본문으로 요약해 `public/inquiries`(source=chatbot)로 인입한다.
  // 인입 SoT 는 event_inquiries(라이브 원장). CS 수렴층(support_tickets)은 미운영으로 폐기됨(mig225).
  // 향후 CS 문맥 조립이 필요하면 v2 에서 신축(go 재도입 아님).
  const submitEscalation = useCallback(async () => {
    if (inquirySubmitting) return;

    const transcript = messages
      .map((m) => `${m.role === "user" ? "고객" : "도우미"}: ${m.content}`)
      .join("\n")
      .slice(-900);
    const question =
      transcript.trim().length >= 5
        ? `[챗봇 대화에서 문의 전환]\n${transcript}`
        : "[챗봇에서 문의 전환] 주최자 답변이 필요한 문의입니다.";

    setInquirySubmitting(true);
    setInquiryError("");

    try {
      const response = await fetch("/api/public/inquiries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: eventSlug,
          question,
          contact: inquiryContact.trim() || undefined,
          source: "chatbot",
        }),
      });
      const payload = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok || payload.success === false) {
        setInquiryError(payload.error ?? "문의 접수에 실패했습니다");
        return;
      }
      setInquiryDone(true);
    } catch {
      setInquiryError("네트워크 오류가 발생했습니다");
    } finally {
      setInquirySubmitting(false);
    }
  }, [eventSlug, inquiryContact, inquirySubmitting, messages]);

  return (
    <>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-24 right-6 z-50 flex items-center gap-2 rounded-full bg-primary px-5 py-3 text-sm font-bold text-foreground shadow-lg shadow-primary/30 transition hover:scale-105 hover:shadow-xl lg:bottom-6"
        >
          <MessageCircle className="size-5" />
          궁금한 점이 있으세요?
        </button>
      ) : null}

      {open ? (
        <div className="fixed bottom-6 right-6 z-50 flex h-[480px] w-[360px] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl max-[420px]:inset-x-0 max-[420px]:bottom-0 max-[420px]:h-[85vh] max-[420px]:w-full max-[420px]:rounded-b-none">
          <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
            <div className="flex items-center gap-2">
              <MessageCircle className="size-4 text-primary" />
              <span className="text-sm font-bold text-foreground">이벤트 도우미</span>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-full p-1 text-muted-foreground transition hover:bg-bg-subtle hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-4">
            {messages.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <p className="text-center text-sm text-muted-foreground">
                  이벤트에 대해 궁금한 점을
                  <br />
                  자유롭게 질문해주세요!
                </p>
              </div>
            ) : null}

            {messages.map((message, index) => (
              <div key={`${message.role}-${index}`} className="space-y-2">
                <div
                  className={cn(
                    "max-w-[85%] rounded-lg px-4 py-2.5 text-sm whitespace-pre-wrap",
                    message.role === "user"
                      ? "ml-auto bg-primary text-primary-foreground"
                      : "bg-bg-subtle text-foreground/90",
                  )}
                >
                  {message.content}
                </div>
              </div>
            ))}

            {sending ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                답변 생성 중...
              </div>
            ) : null}
          </div>

          {escalate && !inquiryDone ? (
            <div className="border-t border-border-subtle bg-bg-muted px-4 py-3">
              <p className="mb-2 text-xs text-content-subtle">
                더 정확한 답변이 필요하신가요? 주최자에게 직접 문의를 남겨보세요.
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={inquiryContact}
                  onChange={(event) => setInquiryContact(event.target.value)}
                  placeholder="연락처 (선택 · 회신 받으실 곳)"
                  maxLength={200}
                  disabled={inquirySubmitting}
                  className="flex-1 rounded-full border border-border bg-card px-4 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void submitEscalation()}
                  disabled={inquirySubmitting}
                  className="whitespace-nowrap rounded-full bg-primary px-4 py-2 text-sm font-bold text-primary-foreground transition hover:bg-primary/80 disabled:opacity-40"
                >
                  {inquirySubmitting ? "접수 중..." : "문의 남기기"}
                </button>
              </div>
              {inquiryError ? <p className="mt-2 text-xs text-destructive">{inquiryError}</p> : null}
            </div>
          ) : null}

          {inquiryDone ? (
            <div className="flex items-center gap-2 border-t border-border-subtle bg-success/10 px-4 py-3 text-sm text-foreground">
              <CheckCircle2 className="size-4 text-success" />
              문의가 접수되었습니다. 주최자가 확인 후 답변드립니다.
            </div>
          ) : null}

          <div className="border-t border-border-subtle px-4 py-3">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void sendMessage();
              }}
              className="flex items-center gap-2"
            >
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="질문을 입력하세요..."
                maxLength={500}
                disabled={sending}
                className="flex-1 rounded-full border border-border bg-bg-muted px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              />
              <button
                type="submit"
                disabled={sending || !input.trim()}
                className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground transition hover:bg-primary/80 disabled:opacity-40"
              >
                <Send className="size-4" />
              </button>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
