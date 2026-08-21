"use client";

import type { ChatMessage as ChatMessageType } from "@/lib/chatbot";
import { ThumbsUp, ThumbsDown, Bot } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useEffect } from "react";

/** Format time client-side only to avoid SSR hydration mismatch */
function useFormattedTime(date: Date) {
  const [time, setTime] = useState("");
  useEffect(() => {
    setTime(
      date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }),
    );
  }, [date]);
  return time;
}

interface ChatMessageProps {
  message: ChatMessageType;
  onFeedback?: (messageId: string, feedback: "helpful" | "not_helpful") => void;
}

export function TypingIndicator() {
  return (
    <div className="flex items-start gap-2.5 mb-4">
      <div className="h-7 w-7 rounded-full bg-primary flex items-center justify-center flex-shrink-0">
        <Bot className="h-4 w-4 text-white" />
      </div>
      <div className="bg-surface-dim rounded-2xl rounded-bl-md px-4 py-3">
        <div className="flex items-center gap-1">
          <span
            className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce"
            style={{ animationDelay: "0ms" }}
          />
          <span
            className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce"
            style={{ animationDelay: "150ms" }}
          />
          <span
            className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce"
            style={{ animationDelay: "300ms" }}
          />
        </div>
      </div>
    </div>
  );
}

export default function ChatMessage({ message, onFeedback }: ChatMessageProps) {
  const t = useTranslations("support.chatMessage");
  const [feedbackGiven, setFeedbackGiven] = useState(message.feedback ?? null);
  const isUser = message.role === "user";
  const formattedTime = useFormattedTime(message.timestamp);

  const handleFeedback = (fb: "helpful" | "not_helpful") => {
    setFeedbackGiven(fb);
    onFeedback?.(message.id, fb);
  };

  if (isUser) {
    return (
      <div className="flex justify-end mb-4">
        <div className="max-w-[80%]">
          <div className="bg-primary text-white rounded-2xl rounded-br-md px-4 py-2.5 text-sm whitespace-pre-wrap">
            {message.content}
          </div>
          <p className="text-2xs text-muted-foreground text-right mt-1">
            {formattedTime}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2.5 mb-4">
      <div className="h-7 w-7 rounded-full bg-primary flex items-center justify-center flex-shrink-0">
        <Bot className="h-4 w-4 text-white" />
      </div>
      <div className="max-w-[80%]">
        <div className="bg-surface-dim text-foreground rounded-2xl rounded-bl-md px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed">
          {message.content}
        </div>
        <div className="flex items-center gap-2 mt-1.5">
          <p className="text-2xs text-muted-foreground">{formattedTime}</p>
          {feedbackGiven ? (
            <span className="text-2xs text-muted-foreground">{t("feedbackThanks")}</span>
          ) : (
            <div className="flex items-center gap-1">
              <button
                onClick={() => handleFeedback("helpful")}
                className="p-0.5 text-muted-foreground hover:text-blue-500 transition-colors"
              >
                <ThumbsUp className="h-3 w-3" />
              </button>
              <button
                onClick={() => handleFeedback("not_helpful")}
                className="p-0.5 text-muted-foreground hover:text-red-400 transition-colors"
              >
                <ThumbsDown className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
