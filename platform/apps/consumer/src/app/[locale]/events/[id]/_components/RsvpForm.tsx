"use client";

import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { Button, Input, Label } from "@pickket/ui";
import { submitRsvp } from "@pickket/lib/api";
import { isApiCanceled } from "@pickket/lib/api";
import { CARD } from "@/lib/styles";

/**
 * 상세페이지 통합 트랙B U3 — 무료 참석(RSVP) 등록 폼.
 * go 원본(rsvp-form.tsx) 이식. event.rsvp_enabled 게이트 하에서만 렌더된다.
 * 백엔드 계약: POST /api/v1/public/rsvp { event_id, name, email, phone? }
 */
export function RsvpForm({
  eventId,
  eventTitle,
}: {
  eventId: string;
  eventTitle: string;
}) {
  const [form, setForm] = useState({ name: "", email: "", phone: "" });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ message: string } | null>(null);
  const [error, setError] = useState("");

  function reset() {
    setForm({ name: "", email: "", phone: "" });
    setSubmitting(false);
    setResult(null);
    setError("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.email.trim()) {
      setError("이름과 이메일을 입력해주세요.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const data = await submitRsvp({
        event_id: eventId,
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim() || undefined,
      });
      setResult({ message: data.message || "참석이 확인되었습니다." });
    } catch (err: unknown) {
      if (isApiCanceled(err)) return;
      setError(
        err instanceof Error && err.message
          ? "참석 등록에 실패했습니다. 잠시 후 다시 시도해주세요."
          : "네트워크 오류가 발생했습니다.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <div className={CARD.base}>
        <div className="flex flex-col items-center gap-4 py-6 text-center">
          <CheckCircle2 className="size-12 text-primary" />
          <p className="text-lg font-bold text-foreground">{result.message}</p>
          <p className="text-sm text-muted-foreground">
            입력하신 이메일로 안내가 전송됩니다.
          </p>
          <Button variant="outline" onClick={reset}>
            다시 등록
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={CARD.base}>
      <div className="mb-4">
        <h3 className="text-lg font-bold text-foreground">참석 등록 (RSVP)</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {eventTitle} 에 무료로 참석 신청하세요.
        </p>
      </div>
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="rsvp-name">이름 *</Label>
          <Input
            id="rsvp-name"
            value={form.name}
            onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
            placeholder="홍길동"
            disabled={submitting}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="rsvp-email">이메일 *</Label>
          <Input
            id="rsvp-email"
            type="email"
            value={form.email}
            onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
            placeholder="example@email.com"
            disabled={submitting}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="rsvp-phone">전화번호 (선택)</Label>
          <Input
            id="rsvp-phone"
            value={form.phone}
            onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
            placeholder="010-0000-0000"
            disabled={submitting}
          />
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? "등록 중..." : "참석 확인"}
        </Button>
      </form>
    </div>
  );
}
