"use client";

import Link from "next/link";
import { useState } from "react";
import { AuthShell } from "@/app/(auth)/_components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ResetPasswordFormProps {
  token: string;
}

export function ResetPasswordForm({ token }: ResetPasswordFormProps) {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    setError(null);

    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: password }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "비밀번호 재설정에 실패했습니다");
      }
      setMessage("비밀번호가 변경되었습니다. 이제 다시 로그인해주세요.");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "비밀번호 재설정에 실패했습니다");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="비밀번호 재설정"
      description="이메일로 받은 토큰을 바탕으로 새로운 비밀번호를 설정합니다."
      footer={
        <div className="flex items-center justify-between">
          <span>로그인 화면으로 돌아가시겠어요?</span>
          <Link href="/login" className="text-primary hover:text-accent">
            로그인으로 이동
          </Link>
        </div>
      }
    >
      <form className="space-y-5" onSubmit={handleSubmit}>
        <div className="space-y-2">
          <Label htmlFor="token">재설정 토큰</Label>
          <Input id="token" value={token} readOnly placeholder="토큰이 자동으로 채워집니다" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">새 비밀번호</Label>
          <Input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="새 비밀번호를 입력해주세요" required />
        </div>
        {message ? <p className="text-sm text-success">{message}</p> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" size="lg" className="w-full" disabled={submitting || !token}>
          {submitting ? "변경 중..." : "새 비밀번호 저장"}
        </Button>
      </form>
    </AuthShell>
  );
}
