"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Shield } from "lucide-react";
import { fetchWithAuth } from "@/lib/fetchWithAuth";

/**
 * owner/admin 역할이면서 MFA 미설정 시 상단 배너 표시
 * 대시보드 레이아웃의 클라이언트 컴포넌트로 사용
 */
export function MfaReminderBanner() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    async function check() {
      try {
        const res = await fetchWithAuth<{
          data: { role: string; mfaEnabled: boolean };
        }>("/api/auth/me");
        const user = res.data;
        if (
          user &&
          (user.role === "owner" || user.role === "admin") &&
          !user.mfaEnabled
        ) {
          setShow(true);
        }
      } catch {
        // 무시 — 로그인 안 된 상태 등
      }
    }
    void check();
  }, []);

  if (!show) return null;

  return (
    <div className="border-b border-warning/30 bg-warning/10 px-4 py-2.5">
      <div className="mx-auto flex max-w-screen-xl items-center gap-3">
        <Shield className="size-4 shrink-0 text-warning" />
        <p className="flex-1 text-sm text-foreground">
          관리자 계정 보호를 위해 <strong>2차 인증(MFA)</strong>을 설정해주세요.
        </p>
        <Link
          href="/account/security"
          className="shrink-0 rounded-full bg-warning px-4 py-1 text-sm font-medium text-white transition-colors hover:bg-warning/90"
        >
          지금 설정하기
        </Link>
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setShow(false)}
        >
          나중에
        </button>
      </div>
    </div>
  );
}
