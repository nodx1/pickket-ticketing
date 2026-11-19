"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, MessageCircle, Send, X } from "lucide-react";
import {
  type ChatMessage,
  WELCOME_MESSAGE,
  QUICK_QUESTIONS,
  generateResponse,
  getTypingDelay,
  createMessageId,
} from "@/lib/chatbot";

/**
 * 상세페이지 통합 트랙B U3 — 이벤트 상세 챗봇 팝업.
 * go 원본(event-chatbot.tsx) 이식. consumer 규칙엔진(lib/chatbot.ts)을 UI 로 감싼다.
 * 이벤트 컨텍스트(제목·장소·일시)를 환영 메시지에 주입한다. LLM 아님 — FAQ 규칙엔진(로컬).
 */
export function EventChatbot({
  eventTitle,
  venue,
  eventDate,
}: {
  eventTitle: string;
  venue?: string | null;
  eventDate?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 컨텍스트 주입 환영 메시지 (첫 오픈 시 1회)
  useEffect(() => {
    if (open && messages.length === 0) {
      const context = [eventTitle, venue].filter(Boolean).join(" · ");
      setMessages([
        {
          ...WELCOME_MESSAGE,
          id: createMessageId(),
          content: context
            ? `안녕하세요! "${context}" 관련 무엇이든 물어보세요 :)\n\n티켓 구매·환불·결제 등 궁금한 점을 자유롭게 질문해주세요. 아래 빠른 질문도 눌러보세요!`
            : WELCOME_MESSAGE.content,
          timestamp: new Date(),
        },
      ]);
    }
  }, [open, messages.length, eventTitle, venue]);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, typing, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const ask = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || typing) return;
    setInput("");
    setMessages((prev) => [
      ...prev,
      {
        id: createMessageId(),
        role: "user",
        content: trimmed,
        timestamp: new Date(),
      },
    ]);
    setTyping(true);
    const { content, suggestedQuestions } = generateResponse(trimmed);
    timerRef.current = setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        {
          id: createMessageId(),
          role: "assistant",
          content,
          timestamp: new Date(),
          suggestedQuestions,
        },
      ]);
      setTyping(false);
    }, getTypingDelay());
  }, [typing]);

  // eventDate 는 향후 안내 문구 확장 대비 시그니처에 유지(현재 미사용)
  void eventDate;

  return (
    <>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="이벤트 도우미 열기"
          // 휴대폰: 하단 고정 예매 바 위에 아이콘만(본문을 덜 가리게), 넓은 화면: 문구까지
          className="fixed bottom-[calc(env(safe-area-inset-bottom)+92px)] right-4 z-40 flex items-center gap-2 rounded-full bg-primary p-3.5 text-sm font-bold text-primary-foreground shadow-lg transition hover:scale-105 sm:right-5 sm:px-5 sm:py-3 lg:bottom-6"
        >
          <MessageCircle className="size-5" />
          <span className="hidden sm:inline">궁금한 점이 있으세요?</span>
        </button>
      ) : null}

      {open ? (
        <div className="fixed bottom-6 right-6 z-50 flex h-[480px] w-[360px] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl max-[420px]:inset-x-0 max-[420px]:bottom-0 max-[420px]:h-[85vh] max-[420px]:w-full max-[420px]:rounded-b-none">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div className="flex items-center gap-2">
              <MessageCircle className="size-4 text-primary" />
              <span className="text-sm font-bold text-foreground">
                이벤트 도우미
              </span>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="닫기"
              className="rounded-full p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>

          <div
            ref={scrollRef}
            className="flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-4"
          >
            {messages.map((message) => (
              <div key={message.id} className="space-y-2">
                <div
                  className={
                    message.role === "user"
                      ? "ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl bg-primary px-4 py-2.5 text-sm text-primary-foreground"
                      : "max-w-[85%] whitespace-pre-wrap rounded-2xl bg-muted px-4 py-2.5 text-sm text-foreground"
                  }
                >
                  {message.content}
                </div>
                {message.suggestedQuestions &&
                message.suggestedQuestions.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {message.suggestedQuestions.map((q) => (
                      <button
                        key={q}
                        type="button"
                        onClick={() => ask(q)}
                        className="rounded-full border border-primary/30 bg-primary/5 px-3 py-1 text-xs text-primary transition hover:bg-primary/10"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}

            {messages.length === 1 ? (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {QUICK_QUESTIONS.slice(0, 4).map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => ask(q)}
                    className="rounded-full border border-border bg-background px-3 py-1 text-xs text-foreground transition hover:bg-muted"
                  >
                    {q}
                  </button>
                ))}
              </div>
            ) : null}

            {typing ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                답변 생성 중...
              </div>
            ) : null}
          </div>

          <div className="border-t border-border px-4 py-3">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                ask(input);
              }}
              className="flex items-center gap-2"
            >
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="질문을 입력하세요..."
                maxLength={500}
                disabled={typing}
                className="flex-1 rounded-full border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              />
              <button
                type="submit"
                disabled={typing || !input.trim()}
                aria-label="전송"
                className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
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
