"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { eventPagePath } from "@/lib/public/event-path";

export function GroupBookingRequestClient({
  event,
  eventSlug,
}: {
  event: {
    id: string;
    title: string;
    products: Array<{ id: string; name: string }>;
  };
  /** 접수 완료 후 돌아갈 행사 페이지. 없으면 버튼을 그리지 않는다. */
  eventSlug?: string | null;
}) {
  const [form, setForm] = useState({
    organizationName: "",
    contactName: "",
    contactEmail: "",
    contactPhone: "",
    attendeeCount: "20",
    productId: event.products[0]?.id ?? "",
    notes: "",
  });
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      const response = await fetch(`/api/events/${event.id}/group-bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          attendeeCount: Number(form.attendeeCount),
        }),
      });
      if (response.ok) {
        setSubmitted(true);
      } else {
        const payload = (await response.json()) as { error?: string };
        setError(payload.error ?? "단체 예약 신청에 실패했습니다. 다시 시도해주세요.");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "네트워크 오류가 발생했습니다. 다시 시도해주세요.");
    }
  }

  // 슬러그를 모르면 행사 버튼을 그리지 않는다 — `/e/undefined` 로 보내지 않는다.
  const eventHref = eventPagePath(eventSlug);

  if (submitted) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <div className="rounded-xl border border-border bg-card/95 p-8 text-center">
          <h1 className="text-3xl font-black tracking-[-0.04em] text-foreground">단체 예약 신청이 접수되었습니다.</h1>
          <p className="mt-3 text-sm text-muted-foreground">담당자가 확인 후 연락드리겠습니다.</p>
          {/*
            🔴 여기도 길이 끊겨 있었다 (2026-08-02). 이건 **독립 페이지**라
            문의 폼처럼 "탭을 바꾸면 된다" 가 성립하지 않는다 — 신청을 마치면
            뒤로가기 말고는 갈 데가 없었다.
          */}
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            {eventHref ? (
              <Button asChild>
                <Link href={eventHref}>행사 페이지로</Link>
              </Button>
            ) : null}
            <Button asChild variant="outline">
              <Link href="/">다른 행사 보기</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-16">
      <div className="space-y-6 rounded-xl border border-border bg-card/95 p-8">
        <div>
          <p className="text-sm uppercase tracking-[0.2em] text-primary">group booking</p>
          <h1 className="mt-3 text-3xl font-black tracking-[-0.04em] text-foreground">{event.title} 단체 예약</h1>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Field label="단체명" value={form.organizationName} onChange={(value) => setForm((prev) => ({ ...prev, organizationName: value }))} />
          <Field label="담당자명" value={form.contactName} onChange={(value) => setForm((prev) => ({ ...prev, contactName: value }))} />
          <Field label="이메일" value={form.contactEmail} onChange={(value) => setForm((prev) => ({ ...prev, contactEmail: value }))} />
          <Field label="전화번호" value={form.contactPhone} onChange={(value) => setForm((prev) => ({ ...prev, contactPhone: value }))} />
          <Field label="예상 인원" value={form.attendeeCount} onChange={(value) => setForm((prev) => ({ ...prev, attendeeCount: value }))} />
          <div className="space-y-2">
            <Label>희망 상품</Label>
            <select
              className="h-11 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground"
              value={form.productId}
              onChange={(event) => setForm((prev) => ({ ...prev, productId: event.target.value }))}
            >
              {event.products.map((product) => (
                <option key={product.id} value={product.id}>{product.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-2">
          <Label>비고</Label>
          <Textarea value={form.notes} onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))} />
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button onClick={() => void submit()}>신청하기</Button>
      </div>
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}
