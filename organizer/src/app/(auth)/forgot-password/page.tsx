"use client";

import Link from "next/link";
import { useState } from "react";
import { AuthShell } from "@/app/(auth)/_components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    setError(null);

    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const payload = (await response.json()) as { data?: { message?: string }; error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "재설정 링크 발송에 실패했습니다");
      }
      setMessage(payload.data?.message ?? "해당 이메일로 비밀번호 재설정 링크를 발송했습니다");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "재설정 링크 발송에 실패했습니다");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="비밀번호 찾기"
      description="가입한 이메일을 입력하면 비밀번호 재설정 링크를 준비합니다."
      footer={
        <div className="flex items-center justify-between">
          <span>비밀번호가 기억나셨나요?</span>
          <Link href="/login" className="text-primary hover:text-accent">
            로그인으로 돌아가기
          </Link>
        </div>
      }
    >
      <form className="space-y-5" onSubmit={handleSubmit}>
        <div className="space-y-2">
          <Label htmlFor="email">이메일</Label>
          <Input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@pickket.kr" required />
        </div>
        {message ? <p className="text-sm text-success">{message}</p> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" size="lg" className="w-full" disabled={submitting}>
          {submitting ? "발송 준비 중..." : "비밀번호 재설정 링크 발송"}
        </Button>
      </form>
    </AuthShell>
  );
}
