"use client";

import { useState } from "react";
import { CheckCircle2, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * 공개 이벤트 페이지 문의 폼.
 * 기존 `POST /api/public/inquiries` 엔드포인트(slug 기반)를 소비한다.
 * honeypot(website) 필드로 봇 유입 차단 — 서버도 동일 필드를 무해 처리한다.
 */
export function InquiryForm({ eventSlug }: { eventSlug: string }) {
  const [form, setForm] = useState({ question: "", contact: "", website: "" });
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (form.question.trim().length < 5) {
      setError("문의 내용을 5자 이상 입력해주세요");
      return;
    }
    setSubmitting(true);
    setError("");

    try {
      const res = await fetch("/api/public/inquiries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: eventSlug,
          question: form.question.trim(),
          contact: form.contact.trim() || undefined,
          source: "web",
          website: form.website,
        }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || data.success === false) {
        setError(data.error ?? "문의 접수에 실패했습니다");
        return;
      }
      setDone(true);
    } catch {
      setError("네트워크 오류가 발생했습니다");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <Card className="border-success/40">
        <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
          <CheckCircle2 className="size-10 text-success" />
          <p className="text-base font-bold text-foreground">문의가 접수되었습니다</p>
          <p className="text-sm text-content-subtle">
            주최자가 확인 후 답변드립니다. 연락처를 남기셨다면 회신받으실 수 있어요.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <MessageSquare className="size-5 text-primary" />
          주최자에게 문의하기
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="inquiry-question">문의 내용 *</Label>
            <textarea
              id="inquiry-question"
              value={form.question}
              onChange={(e) => setForm((p) => ({ ...p, question: e.target.value }))}
              placeholder="궁금하신 점을 자유롭게 남겨주세요"
              maxLength={1000}
              rows={4}
              className="w-full rounded-lg border border-border bg-bg-muted px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="inquiry-contact">연락처 (선택)</Label>
            <Input
              id="inquiry-contact"
              value={form.contact}
              onChange={(e) => setForm((p) => ({ ...p, contact: e.target.value }))}
              placeholder="이메일 또는 전화번호 (회신 받으실 곳)"
              maxLength={200}
            />
          </div>
          {/* honeypot — 사람은 보이지 않음, 봇만 채운다. */}
          <div className="absolute left-[-9999px]" aria-hidden="true">
            <label htmlFor="inquiry-website">홈페이지</label>
            <input
              id="inquiry-website"
              type="text"
              tabIndex={-1}
              autoComplete="off"
              value={form.website}
              onChange={(e) => setForm((p) => ({ ...p, website: e.target.value }))}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? "접수 중..." : "문의 남기기"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
