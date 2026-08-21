"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AcceptInvitationClient({ token }: { token: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const response = await fetch("/api/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, name, password }),
    });
    const payload = (await response.json()) as { error?: string };

    if (!response.ok) {
      setError(payload.error ?? "초대 수락에 실패했습니다");
      setLoading(false);
      return;
    }

    router.push("/dashboard");
    router.refresh();
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md items-center px-4 py-10">
      <form className="w-full space-y-5 rounded-xl border border-border bg-card/95 p-8" onSubmit={handleSubmit}>
        <div>
          <p className="text-sm uppercase tracking-[0.2em] text-primary">pickket.go invite</p>
          <h1 className="mt-3 text-3xl font-black tracking-[-0.04em] text-foreground">팀 초대 수락</h1>
        </div>
        <div className="space-y-2">
          <Label>이름</Label>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>비밀번호</Label>
          <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" className="w-full" disabled={loading || !token}>
          {loading ? "처리 중..." : "가입 완료"}
        </Button>
      </form>
    </div>
  );
}
