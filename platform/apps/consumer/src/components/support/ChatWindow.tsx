"use client";

import { useTranslations } from "next-intl";
import { useState, useRef, useEffect, useCallback } from "react";
import {
  WELCOME_MESSAGE,
  QUICK_QUESTIONS,
  generateResponse,
  getTypingDelay,
  createMessageId,
  type ChatMessage as ChatMessageType,
} from "@/lib/chatbot";
import ChatMessage, { TypingIndicator } from "./ChatMessage";
import { Bot, Send } from "lucide-react";

export default function ChatWindow() {
  const t = useTranslations("support.chatWindow");
  const [messages, setMessages] = useState<ChatMessageType[]>([
    WELCOME_MESSAGE,
  ]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = useCallback(() => {
    const el = scrollAreaRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping, scrollToBottom]);

  const handleSend = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isTyping) return;

      // Add user message
      const userMsg: ChatMessageType = {
        id: createMessageId(),
        role: "user",
        content: trimmed,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setInput("");
      setIsTyping(true);

      // Simulate AI thinking
      await new Promise((resolve) => setTimeout(resolve, getTypingDelay()));

      // Generate response
      const response = generateResponse(trimmed);
      const aiMsg: ChatMessageType = {
        id: createMessageId(),
        role: "assistant",
        content: response.content,
        timestamp: new Date(),
        suggestedQuestions: response.suggestedQuestions,
      };

      setMessages((prev) => [...prev, aiMsg]);
      setIsTyping(false);
    },
    [isTyping],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend(input);
    }
  };

  const handleFeedback = (
    messageId: string,
    feedback: "helpful" | "not_helpful",
  ) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, feedback } : m)),
    );
  };

  // Get the latest suggested questions from the last assistant message
  const lastAssistantMsg = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");
  const suggestedQuestions = lastAssistantMsg?.suggestedQuestions;

  return (
    <div className="bg-card rounded-2xl border border-border shadow-[0_2px_16px_rgba(0,0,0,0.06)] h-[500px] md:h-[640px] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border flex-shrink-0">
        <div className="h-8 w-8 rounded-full bg-primary flex items-center justify-center">
          <Bot className="h-5 w-5 text-white" />
        </div>
        <div>
          <p className="text-sm font-semibold text-foreground">
            {t("title")}
          </p>
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
            <span className="text-2xs text-muted-foreground">{t("online")}</span>
          </div>
        </div>
      </div>

      {/* Messages area */}
      <div ref={scrollAreaRef} className="flex-1 overflow-y-auto px-4 py-4">
        {messages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} onFeedback={handleFeedback} />
        ))}
        {isTyping && <TypingIndicator />}
      </div>

      {/* Suggested questions */}
      {suggestedQuestions && suggestedQuestions.length > 0 && !isTyping && (
        <div className="px-4 py-2 border-t border-border flex-shrink-0">
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
            {suggestedQuestions.map((q) => (
              <button
                key={q}
                onClick={() => handleSend(q)}
                className="flex-shrink-0 px-3 py-1.5 rounded-full text-xs border border-border text-muted-foreground hover:bg-surface-dim hover:border-primary/30 hover:text-primary transition-colors"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Quick questions (only show when no suggested questions) */}
      {(!suggestedQuestions || suggestedQuestions.length === 0) &&
        messages.length <= 1 &&
        !isTyping && (
          <div className="px-4 py-2 border-t border-border flex-shrink-0">
            <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
              {QUICK_QUESTIONS.map((q) => (
                <button
                  key={q}
                  onClick={() => handleSend(q)}
                  className="flex-shrink-0 px-3 py-1.5 rounded-full text-xs border border-border text-muted-foreground hover:bg-surface-dim hover:border-primary/30 hover:text-primary transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

      {/* Input area */}
      <div className="px-4 py-3 border-t border-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("inputPlaceholder")}
            disabled={isTyping}
            className="flex-1 h-10 px-4 rounded-full border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 disabled:opacity-50 disabled:bg-muted"
          />
          <button
            onClick={() => handleSend(input)}
            disabled={!input.trim() || isTyping}
            className="h-10 w-10 rounded-full bg-primary text-white flex items-center justify-center hover:bg-brand-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
