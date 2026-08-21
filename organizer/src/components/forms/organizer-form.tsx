"use client";

import { useState } from "react";
import { z } from "zod";
import { ImageUpload } from "@/components/shared/image-upload";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

const organizerSchema = z.object({
  name: z.string().min(2, "주최자 이름은 2자 이상이어야 합니다"),
  description: z.string().optional(),
  email: z.email("올바른 이메일 형식을 입력해주세요").or(z.literal("")),
  phone: z.string().optional(),
  logoUrl: z.string().optional(),
  contactPublic: z.boolean().optional(),
});

// slug 는 이름에서 서버가 자동 생성(내부 식별자) — 폼에서 입력받지 않는다.
// 이름·로고는 이벤트 페이지에 항상 노출. contactPublic 은 연락처(email/phone) 소비자 공개 토글.
export interface OrganizerFormValue {
  id?: string;
  name: string;
  description: string;
  email: string;
  phone: string;
  logoUrl: string;
  contactPublic: boolean;
}

interface OrganizerFormProps {
  open: boolean;
  value: OrganizerFormValue;
  title: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: OrganizerFormValue) => Promise<void>;
}

export function OrganizerForm({
  open,
  value,
  title,
  onOpenChange,
  onSubmit,
}: OrganizerFormProps) {
  const [form, setForm] = useState<OrganizerFormValue>(value);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // P2: 계정 정보(이름·연락처)로 프리필 — 계정↔주최자 재입력 마찰 제거.
  async function fillFromAccount() {
    try {
      const res = await fetchWithRefresh("/api/account/settings", { credentials: "include" });
      if (!res.ok) return;
      const payload = (await res.json()) as {
        data?: { name?: string; contactEmail?: string | null; contactPhone?: string | null };
      };
      const acc = payload.data;
      if (!acc) return;
      setForm((prev) => ({
        ...prev,
        name: acc.name || prev.name,
        email: acc.contactEmail || prev.email,
        phone: acc.contactPhone || prev.phone,
      }));
    } catch {
      // 편의 기능 — 실패해도 수동 입력 가능하므로 조용히 무시.
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    const parsed = organizerSchema.safeParse(form);
    if (!parsed.success) {
      setSaving(false);
      setError(parsed.error.issues[0]?.message ?? "입력값을 확인해주세요");
      return;
    }

    try {
      await onSubmit(form);
      onOpenChange(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "주최자 저장에 실패했습니다");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={() => void fillFromAccount()}>
              계정 정보로 채우기
            </Button>
          </div>
          <div className="space-y-2">
            <Label htmlFor="organizer-name">주최자 이름 (이벤트 페이지에 노출)</Label>
            <Input id="organizer-name" value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="organizer-description">설명</Label>
            <Textarea id="organizer-description" value={form.description} onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))} />
          </div>
          <ImageUpload
            value={form.logoUrl}
            onChange={(logoUrl) => setForm((prev) => ({ ...prev, logoUrl }))}
            label="주최자 로고 (이벤트 페이지에 노출)"
            uploadType="organizer"
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="organizer-email">이메일</Label>
              <Input id="organizer-email" type="email" value={form.email} onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="organizer-phone">전화번호</Label>
              <Input id="organizer-phone" value={form.phone} onChange={(event) => setForm((prev) => ({ ...prev, phone: event.target.value }))} />
            </div>
          </div>
          <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/40 p-4">
            <div>
              <Label htmlFor="organizer-contact-public" className="text-sm font-medium">연락처 공개</Label>
              <p className="mt-1 text-xs text-muted-foreground">
                켜면 위 이메일·전화번호가 이벤트 페이지에서 관람객에게 노출됩니다. 끄면 내부 관리용으로만 사용됩니다.
              </p>
            </div>
            <Switch
              id="organizer-contact-public"
              checked={form.contactPublic}
              onCheckedChange={(checked) => setForm((prev) => ({ ...prev, contactPublic: checked }))}
            />
          </div>
          {error ? <p className="text-sm text-warning">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "저장 중..." : "저장"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
