"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { sendChatMessage } from "@pickket/lib/api";

// ── Types ────────────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  tier?: 0 | 1;
  escalated?: boolean;
  timestamp: Date;
}

// ── Icons (inline SVG to avoid dependency) ──────────────────────────────────

function ChatBubbleIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function SendIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

function HeadsetIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
      <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
    </svg>
  );
}

// ── Component ───────────────────────────────────────────────────────────────

export default function ChatWidget() {
  const t = useTranslations("common.chatWidget");
  const pathname = usePathname();
  // 이벤트 상세엔 하단 sticky 예매바(MobileStickyBottom)가 있어 FAB 를 위로 띄워 겹침 방지.
  const hasBottomBar = pathname?.includes("/events/") ?? false;
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [isEscalated, setIsEscalated] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 초기 환영 메시지
  useEffect(() => {
    if (isOpen && messages.length === 0) {
      setMessages([
        {
          id: "welcome",
          role: "assistant",
          content: t("welcomeMessage"),
          tier: 0,
          timestamp: new Date(),
        },
      ]);
    }
  }, [isOpen, messages.length]);

  // 메시지 목록 끝으로 스크롤
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 패널 열 때 입력 포커스
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    try {
      const result = await sendChatMessage({
        message: text,
        conversation_id: conversationId,
      });

      setConversationId(result.conversation_id);

      const botMessage: ChatMessage = {
        id: `bot-${Date.now()}`,
        role: "assistant",
        content: result.response,
        tier: result.tier,
        escalated: result.escalated,
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, botMessage]);

      if (result.escalated) {
        setIsEscalated(true);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          role: "assistant",
          content: t("sendError"),
          tier: 0,
          timestamp: new Date(),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading, conversationId]);

  const handleEscalate = useCallback(async () => {
    const escalateMsg = t("escalateMessage");
    setInput(escalateMsg);
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: escalateMsg,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMessage]);
    setIsLoading(true);

    try {
      const result = await sendChatMessage({
        message: escalateMsg,
        conversation_id: conversationId,
      });

      setConversationId(result.conversation_id);
      setMessages((prev) => [
        ...prev,
        {
          id: `bot-${Date.now()}`,
          role: "assistant",
          content: result.response,
          tier: result.tier,
          escalated: result.escalated,
          timestamp: new Date(),
        },
      ]);
      setIsEscalated(true);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          role: "assistant",
          content: t("escalateError"),
          tier: 0,
          timestamp: new Date(),
        },
      ]);
    } finally {
      setIsLoading(false);
      setInput("");
    }
  }, [conversationId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <>
      {/* Floating Button */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className={`fixed right-5 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-indigo-500 text-white shadow-lg transition-all hover:scale-105 hover:bg-indigo-600 active:scale-95 dark:bg-indigo-600 dark:hover:bg-indigo-500 ${hasBottomBar ? "bottom-24 lg:bottom-5" : "bottom-5"}`}
          aria-label={t("openChatbot")}
        >
          <ChatBubbleIcon />
        </button>
      )}

      {/* Chat Panel */}
      {isOpen && (
        <div className="fixed right-5 bottom-5 z-50 flex h-[520px] w-[380px] flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900 max-[420px]:right-0 max-[420px]:bottom-0 max-[420px]:h-full max-[420px]:w-full max-[420px]:rounded-none">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-gray-200 bg-indigo-500 px-4 py-3 dark:border-gray-700 dark:bg-indigo-600">
            <div className="flex items-center gap-2">
              <ChatBubbleIcon className="h-5 w-5 text-white" />
              <div>
                <h3 className="text-sm font-semibold text-white">
                  {t("headerTitle")}
                </h3>
                <p className="text-xs text-indigo-100">{t("headerSubtitle")}</p>
              </div>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="rounded-full p-1 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
              aria-label={t("closeChatbot")}
            >
              <CloseIcon />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3">
            <div className="space-y-3">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                      msg.role === "user"
                        ? "rounded-br-md bg-indigo-500 text-white dark:bg-indigo-600"
                        : "rounded-bl-md bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200"
                    }`}
                  >
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                    {/* Tier indicator */}
                    {msg.role === "assistant" && msg.tier !== undefined && (
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <span
                          className={`inline-block h-1.5 w-1.5 rounded-full ${
                            msg.tier === 1
                              ? "bg-emerald-400"
                              : "bg-gray-400 dark:bg-gray-500"
                          }`}
                        />
                        <span className="text-[10px] text-gray-400 dark:text-gray-500">
                          {msg.tier === 1 ? "AI" : "FAQ"}
                        </span>
                        {msg.escalated && (
                          <span className="text-[10px] text-orange-500">
                            {t("agentConnected")}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {/* Loading indicator */}
              {isLoading && (
                <div className="flex justify-start">
                  <div className="rounded-2xl rounded-bl-md bg-gray-100 px-4 py-3 dark:bg-gray-800">
                    <div className="flex gap-1">
                      <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400 [animation-delay:0ms]" />
                      <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400 [animation-delay:150ms]" />
                      <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400 [animation-delay:300ms]" />
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Escalation button */}
          {!isEscalated && messages.length > 2 && (
            <div className="border-t border-gray-100 px-4 py-2 dark:border-gray-800">
              <button
                onClick={handleEscalate}
                disabled={isLoading}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-gray-200 py-1.5 text-xs text-gray-500 transition-colors hover:border-orange-300 hover:text-orange-500 disabled:opacity-50 dark:border-gray-700 dark:text-gray-400 dark:hover:border-orange-500 dark:hover:text-orange-400"
              >
                <HeadsetIcon />
                {t("connectAgent")}
              </button>
            </div>
          )}

          {/* Input */}
          <div className="border-t border-gray-200 p-3 dark:border-gray-700">
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t("inputPlaceholder")}
                disabled={isLoading}
                maxLength={1000}
                className="flex-1 rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-500 dark:focus:border-indigo-500 dark:focus:ring-indigo-500"
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || isLoading}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-500 text-white transition-all hover:bg-indigo-600 disabled:opacity-40 disabled:hover:bg-indigo-500 dark:bg-indigo-600 dark:hover:bg-indigo-500"
                aria-label={t("sendMessage")}
              >
                <SendIcon />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
