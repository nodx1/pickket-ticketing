"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Eye, EyeOff, Check, X } from "lucide-react";
import { z } from "zod";
import { AuthShell } from "@/app/(auth)/_components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PASSWORD_RULES, checkPasswordRules } from "@/lib/auth/password-rules";

const registerSchema = z
  .object({
    name: z.string().min(2, "이름은 2자 이상이어야 합니다"),
    email: z.email("올바른 이메일 형식을 입력해주세요"),
    phone: z
      .string()
      .regex(/^01[0-9]-?\d{3,4}-?\d{4}$/, "전화번호 형식이 올바르지 않습니다"),
    // 🔴 규칙을 여기 다시 적지 않는다 — 화면 체크리스트와 **같은 출처**(PASSWORD_RULES)에서
    //    만든다. 두 곳에 따로 적으면 "화면은 통과라는데 제출은 거부" 가 된다.
    password: PASSWORD_RULES.reduce(
      (schema, rule) => schema.refine(rule.test, { message: rule.message }),
      z.string() as z.ZodType<string>,
    ),
    passwordConfirm: z.string().min(8, "비밀번호 확인을 입력해주세요"),
  })
  .refine((value) => value.password === value.passwordConfirm, {
    path: ["passwordConfirm"],
    message: "비밀번호가 서로 일치하지 않습니다",
  });

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    password: "",
    passwordConfirm: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 🔴 비밀번호를 **볼 수 있어야 한다.** 두 칸 다 가려놓으면 오타를 확인할 방법이 없고,
  //    모바일에서 특수문자를 섞어 칠 때 특히 그렇다(오픈일 신고 원인 중 하나).
  const [showPassword, setShowPassword] = useState(false);
  const passwordChecks = useMemo(() => checkPasswordRules(form.password), [form.password]);
  const confirmMismatch = form.passwordConfirm.length > 0 && form.password !== form.passwordConfirm;

  const isValid = useMemo(() => registerSchema.safeParse(form).success, [form]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const parsed = registerSchema.safeParse(form);
    if (!parsed.success) {
      setSubmitting(false);
      setError(parsed.error.issues[0]?.message ?? "입력값을 확인해주세요");
      return;
    }

    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const payload = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(payload.error ?? "회원가입에 실패했습니다");
      }

      router.push("/dashboard");
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "회원가입에 실패했습니다");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="회원가입"
      description="무료로 시작하세요. 첫 이벤트를 AI와 함께 만들어 보세요."
      footer={
        <div className="flex items-center justify-between">
          <span>이미 계정이 있으신가요?</span>
          <Link href="/login" className="text-primary hover:text-accent">
            로그인으로 이동
          </Link>
        </div>
      }
    >
      <form className="grid gap-5" onSubmit={handleSubmit}>
        <div className="space-y-2">
          <Label htmlFor="name">이름</Label>
          <Input id="name" value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} placeholder="홍길동" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">이메일</Label>
          <Input id="email" type="email" value={form.email} onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))} placeholder="you@pickket.kr" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone">전화번호</Label>
          <Input id="phone" value={form.phone} onChange={(event) => setForm((prev) => ({ ...prev, phone: event.target.value }))} placeholder="010-1234-5678" required />
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="password">비밀번호</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                value={form.password}
                onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
                placeholder="8자 이상 · 대문자·숫자·특수문자"
                aria-describedby="password-rules"
                className="pr-12"
                required
              />
              {/* 🔴 두 칸을 한 버튼으로 함께 토글한다 — 확인란만 가려두면 "일치하지 않습니다"
                  가 떴을 때 어느 쪽이 틀렸는지 여전히 알 수 없다. */}
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "비밀번호 숨기기" : "비밀번호 표시"}
                aria-pressed={showPassword}
                className="absolute right-1 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            {/* 🔴 규칙을 **항상** 보여준다. 종전엔 placeholder 한 줄뿐이라 입력을 시작하면
                사라졌고, 못 맞추면 버튼이 아무 말 없이 죽어 "고장" 으로 읽혔다. */}
            <ul id="password-rules" className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
              {passwordChecks.map((rule) => (
                <li
                  key={rule.label}
                  className={`flex items-center gap-1 ${rule.ok ? "text-success" : "text-muted-foreground"}`}
                >
                  {rule.ok ? <Check className="size-3" /> : <X className="size-3" />}
                  {rule.label}
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-2">
            <Label htmlFor="passwordConfirm">비밀번호 확인</Label>
            <Input
              id="passwordConfirm"
              type={showPassword ? "text" : "password"}
              value={form.passwordConfirm}
              onChange={(event) => setForm((prev) => ({ ...prev, passwordConfirm: event.target.value }))}
              placeholder="한 번 더 입력"
              aria-describedby={confirmMismatch ? "confirm-mismatch" : undefined}
              aria-invalid={confirmMismatch}
              required
            />
            {confirmMismatch ? (
              <p id="confirm-mismatch" className="text-xs text-destructive">비밀번호가 서로 일치하지 않습니다</p>
            ) : null}
          </div>
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" size="lg" className="w-full" disabled={submitting || !isValid}>
          {submitting ? "계정 생성 중..." : "회원가입"}
        </Button>
        {/* 🔴 버튼이 왜 죽어 있는지 말해준다. 종전엔 회색 버튼만 있고 아무 설명이 없어
            사용자가 "가입이 안 된다" 로 신고했다(2026-08-01 오픈일). */}
        {!isValid && !submitting ? (
          <p className="text-center text-xs text-muted-foreground">
            위 항목을 모두 입력하면 가입할 수 있습니다.
          </p>
        ) : null}
      </form>
    </AuthShell>
  );
}
