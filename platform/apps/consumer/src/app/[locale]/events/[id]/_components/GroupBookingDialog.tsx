"use client";

import { useState } from "react";
import { CheckCircle2, Users } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  Textarea,
} from "@pickket/ui";
import { submitGroupBooking, isApiCanceled } from "@pickket/lib/api";

interface ProductOption {
  id: string;
  name: string;
}

/**
 * 상세페이지 통합 트랙B U3 — 단체(그룹) 예약 신청.
 * go 원본(group-booking-request-client.tsx) 이식 → 상세페이지 진입 모달로 재구성.
 * event.group_booking_enabled 게이트. 백엔드 계약:
 * POST /api/v1/public/group-bookings { event_id, org_name, contact_*, attendee_count, product_id?, notes? }
 */
export function GroupBookingDialog({
  eventId,
  eventTitle,
  products,
}: {
  eventId: string;
  eventTitle: string;
  products: ProductOption[];
}) {
  const [open, setOpen] = useState(false);
  const emptyForm = {
    orgName: "",
    contactName: "",
    contactEmail: "",
    contactPhone: "",
    attendeeCount: "20",
    productId: products[0]?.id ?? "",
    notes: "",
  };
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  function resetAll() {
    setForm({ ...emptyForm, productId: products[0]?.id ?? "" });
    setSubmitting(false);
    setSubmitted(false);
    setError("");
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) resetAll();
  }

  async function submit() {
    if (submitting) return;
    if (!form.orgName.trim() || !form.contactName.trim() || !form.contactEmail.trim()) {
      setError("단체명·담당자명·이메일은 필수입니다.");
      return;
    }
    const count = Number(form.attendeeCount);
    if (!Number.isFinite(count) || count < 1) {
      setError("예상 인원을 올바르게 입력해주세요.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await submitGroupBooking({
        event_id: eventId,
        org_name: form.orgName.trim(),
        contact_name: form.contactName.trim(),
        contact_email: form.contactEmail.trim(),
        contact_phone: form.contactPhone.trim(),
        attendee_count: count,
        product_id: form.productId || undefined,
        notes: form.notes.trim() || undefined,
      });
      setSubmitted(true);
    } catch (err: unknown) {
      if (isApiCanceled(err)) return;
      setError(
        err instanceof Error
          ? "단체 예약 신청에 실패했습니다. 잠시 후 다시 시도해주세요."
          : "네트워크 오류가 발생했습니다.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" className="w-full gap-2">
          <Users className="size-4" />
          단체 예약 문의
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        {submitted ? (
          <div className="flex flex-col items-center gap-4 py-8 text-center">
            <CheckCircle2 className="size-12 text-primary" />
            <div>
              <p className="text-lg font-bold text-foreground">
                단체 예약 신청이 접수되었습니다.
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                담당자가 확인 후 연락드리겠습니다.
              </p>
            </div>
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              닫기
            </Button>
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{eventTitle} 단체 예약</DialogTitle>
              <DialogDescription>
                단체 관람을 원하시면 아래 정보를 남겨주세요. 담당자가 확인 후
                연락드립니다.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="단체명 *"
                value={form.orgName}
                onChange={(v) => setForm((p) => ({ ...p, orgName: v }))}
                disabled={submitting}
              />
              <Field
                label="담당자명 *"
                value={form.contactName}
                onChange={(v) => setForm((p) => ({ ...p, contactName: v }))}
                disabled={submitting}
              />
              <Field
                label="이메일 *"
                type="email"
                value={form.contactEmail}
                onChange={(v) => setForm((p) => ({ ...p, contactEmail: v }))}
                disabled={submitting}
              />
              <Field
                label="전화번호"
                value={form.contactPhone}
                onChange={(v) => setForm((p) => ({ ...p, contactPhone: v }))}
                disabled={submitting}
              />
              <Field
                label="예상 인원"
                type="number"
                value={form.attendeeCount}
                onChange={(v) => setForm((p) => ({ ...p, attendeeCount: v }))}
                disabled={submitting}
              />
              {products.length > 0 ? (
                <div className="space-y-2">
                  <Label htmlFor="gb-product">희망 상품</Label>
                  <select
                    id="gb-product"
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
                    value={form.productId}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, productId: e.target.value }))
                    }
                    disabled={submitting}
                  >
                    {products.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="gb-notes">비고 (선택)</Label>
              <Textarea
                id="gb-notes"
                value={form.notes}
                onChange={(e) =>
                  setForm((p) => ({ ...p, notes: e.target.value }))
                }
                disabled={submitting}
                placeholder="희망 일정, 요청사항 등을 남겨주세요."
              />
            </div>
            {error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : null}
            <Button
              className="w-full"
              onClick={() => void submit()}
              disabled={submitting}
            >
              {submitting ? "신청 중..." : "신청하기"}
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
    </div>
  );
}
