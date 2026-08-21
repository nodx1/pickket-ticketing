"use client";

import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function RsvpForm({ eventId }: { eventId: string }) {
  const [form, setForm] = useState({ name: "", email: "", phone: "" });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ status: string; message: string } | null>(null);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name || !form.email) { setError("이름과 이메일을 입력해주세요"); return; }
    setSubmitting(true);
    setError("");

    try {
      const res = await fetch(`/api/events/${eventId}/public/rsvp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = (await res.json()) as { data?: { status: string; message: string }; error?: string };
      if (!res.ok) {
        setError(data.error ?? "참석 등록에 실패했습니다");
        return;
      }
      setResult(data.data ?? { status: "confirmed", message: "참석이 확인되었습니다!" });
    } catch {
      setError("네트워크 오류가 발생했습니다");
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <Card className="border-success/40">
        <CardContent className="flex flex-col items-center gap-4 p-8">
          <CheckCircle2 className="size-12 text-success" />
          <p className="text-lg font-bold text-foreground">{result.message}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">참석 등록 (RSVP)</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="space-y-2">
            <Label>이름 *</Label>
            <Input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="홍길동" />
          </div>
          <div className="space-y-2">
            <Label>이메일 *</Label>
            <Input type="email" value={form.email} onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))} placeholder="example@email.com" />
          </div>
          <div className="space-y-2">
            <Label>전화번호</Label>
            <Input value={form.phone} onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))} placeholder="010-0000-0000" />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? "등록 중..." : "참석 확인"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
