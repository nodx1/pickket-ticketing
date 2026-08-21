"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Shield } from "lucide-react";
import { AuthShell } from "@/app/(auth)/_components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // MFA 2단계
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const payload = (await response.json()) as {
        data?: { requiresMfa?: boolean; mfaToken?: string };
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error ?? "로그인에 실패했습니다");
      }

      // MFA 필요 → 2단계로 전환
      if (payload.data?.requiresMfa && payload.data.mfaToken) {
        setMfaToken(payload.data.mfaToken);
        return;
      }

      router.push("/dashboard");
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "로그인에 실패했습니다");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMfaSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/mfa/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mfaToken, code: mfaCode }),
      });
      const payload = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(payload.error ?? "인증에 실패했습니다");
      }

      router.push("/dashboard");
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "인증에 실패했습니다");
    } finally {
      setSubmitting(false);
    }
  }

  // MFA 2단계 화면
  if (mfaToken) {
    return (
      <AuthShell
        title="2차 인증"
        description="인증 앱에 표시된 6자리 코드를 입력하세요."
        footer={
          <button
            type="button"
            className="text-sm text-muted-foreground hover:text-foreground"
            onClick={() => { setMfaToken(null); setMfaCode(""); setError(null); }}
          >
            다른 계정으로 로그인
          </button>
        }
      >
        <form className="space-y-5" onSubmit={handleMfaSubmit}>
          <div className="flex justify-center">
            <div className="flex size-16 items-center justify-center rounded-full bg-primary/10">
              <Shield className="size-8 text-primary" />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="mfa-code">인증 코드</Label>
            <Input
              id="mfa-code"
              type="text"
              inputMode="numeric"
              placeholder="000000"
              maxLength={8}
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value.replace(/[^A-Za-z0-9]/g, "").slice(0, 8))}
              className="text-center font-mono text-xl tracking-[0.3em]"
              autoFocus
              required
            />
            <p className="text-xs text-muted-foreground">
              백업 코드 (8자리 영숫자)도 사용할 수 있습니다.
            </p>
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <Button type="submit" className="w-full" size="lg" disabled={submitting || mfaCode.length < 6}>
            {submitting ? "인증 중..." : "인증하기"}
          </Button>
        </form>
      </AuthShell>
    );
  }

  // 기본 로그인 화면
  return (
    <AuthShell
      title="로그인"
      description="관리자 대시보드에 접속하려면 등록된 계정으로 로그인해주세요."
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link href="/register" className="text-primary hover:text-accent">
            계정이 없으신가요? 회원가입
          </Link>
          <Link href="/forgot-password" className="hover:text-foreground">
            비밀번호를 잊으셨나요?
          </Link>
        </div>
      }
    >
      <form className="space-y-5" onSubmit={handleSubmit}>
        <div className="space-y-2">
          <Label htmlFor="email">이메일</Label>
          <Input
            id="email"
            type="email"
            placeholder="you@pickket.kr"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">비밀번호</Label>
          <Input
            id="password"
            type="password"
            placeholder="비밀번호를 입력해주세요"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" className="w-full" size="lg" disabled={submitting}>
          {submitting ? "로그인 중..." : "로그인"}
        </Button>
      </form>
    </AuthShell>
  );
}
