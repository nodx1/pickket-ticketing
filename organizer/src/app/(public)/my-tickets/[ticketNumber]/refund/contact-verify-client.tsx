"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * 환불 전 본인확인 — 구매 시 입력한 이메일·전화를 대조한다.
 *
 * 🔴 이 컴포넌트는 **구매자 정보를 받지 않는다.** prefill 이 있으면 확인 자체가
 *    무의미해지고(화면에 답이 적혀 있다), 링크를 전달받은 제3자에게 구매자의
 *    이메일·전화를 그대로 노출하게 된다. 서버도 미인증 상태에서는 넘기지 않는다.
 */
export function ContactVerifyClient({ ticketNumber }: { ticketNumber: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/public/lookup/verify-contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketNumber, email, phone }),
      });
      if (res.ok) {
        // 쿠키가 구워졌다 — 서버 컴포넌트를 다시 태워 환불 화면으로 넘어간다.
        router.refresh();
        return;
      }
      if (res.status === 429) {
        setError("확인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.");
      } else if (res.status === 503) {
        setError("일시적인 오류입니다. 잠시 후 다시 시도해주세요.");
      } else {
        setError("입력하신 정보가 주문 정보와 일치하지 않습니다.");
      }
    } catch {
      setError("확인에 실패했습니다. 잠시 후 다시 시도해주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-md px-4 py-10">
      <h1 className="text-2xl font-black tracking-[-0.03em] text-foreground">본인 확인</h1>
      <p className="mt-2 text-sm text-content-muted">
        환불을 신청하려면 <span className="font-semibold">예매하실 때 입력한</span> 이메일과
        휴대폰 번호를 확인해주세요.
      </p>

      <form onSubmit={submit} className="mt-6 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="verify-email">이메일</Label>
          <Input
            id="verify-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="verify-phone">휴대폰 번호</Label>
          <Input
            id="verify-phone"
            type="tel"
            inputMode="numeric"
            autoComplete="tel"
            required
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="01012345678"
          />
        </div>

        {error ? (
          <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-foreground">
            {error}
          </p>
        ) : null}

        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "확인 중…" : "확인하고 계속"}
        </Button>
      </form>

      <p className="mt-6 text-xs text-muted-foreground">
        입력하신 정보는 주문 확인에만 쓰이며 저장하지 않습니다. 확인이 어려우시면
        고객센터로 문의해주세요.
      </p>
    </div>
  );
}
