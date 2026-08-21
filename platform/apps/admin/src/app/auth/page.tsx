"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button, Card, Input, Label } from "@pickket/ui";
import { CONSUMER_URL } from "@pickket/lib";
import { login, mfaVerify } from "@pickket/lib/api";
import { useAuthStore } from "@pickket/store";

export default function AdminAuthPage() {
  const t = useTranslations("auth.adminLogin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // MFA 단계: 임시 토큰 보관. null이면 일반 로그인 화면
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const { setAuth } = useAuthStore();
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawCallback = searchParams.get("callbackUrl") || "/";
  const callbackUrl = (() => {
    const c = rawCallback.trim();
    if (!c.startsWith("/") || c.startsWith("//")) return "/";
    try {
      const parsed = new URL(c, "https://pickket.local");
      if (parsed.origin !== "https://pickket.local") return "/";
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return "/";
    }
  })();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await login({ email, password });

      // MFA 필요 응답: 세션 저장 없이 MFA 코드 입력 화면으로 전환
      if (res.data.mfa_required && res.data.mfa_token) {
        setMfaToken(res.data.mfa_token);
        setMfaCode("");
        return;
      }

      const { user } = res.data;
      if (!user || !user.is_admin) {
        setError(t("errorAdminOnly"));
        return;
      }
      setAuth(user, "cookie");
      router.replace(callbackUrl);
    } catch {
      setError(t("errorInvalidCredentials"));
    } finally {
      setLoading(false);
    }
  };

  const handleMfaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mfaToken) return;
    setError("");
    setLoading(true);
    try {
      const data = await mfaVerify({ mfaToken, code: mfaCode });
      const { user } = data;
      if (!user.is_admin) {
        setError(t("errorAdminOnly"));
        setMfaToken(null);
        setMfaCode("");
        return;
      }
      setAuth(user, "cookie");
      router.replace(callbackUrl);
    } catch {
      setError(t("errorMfaInvalid"));
      setMfaCode("");
    } finally {
      setLoading(false);
    }
  };

  // ── MFA 코드 입력 화면 ──────────────────────────────────────────────
  if (mfaToken) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md p-8">
          <div className="flex flex-col items-center mb-6">
            <div className="inline-flex h-12 w-12 rounded-full bg-primary items-center justify-center mb-3">
              <ShieldCheck className="h-6 w-6 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-center">{t("mfaTitle")}</h1>
            <p className="text-center text-muted-foreground text-sm mt-1">
              {t("mfaDescription")}
            </p>
          </div>
          <form onSubmit={handleMfaSubmit} className="space-y-4">
            <div>
              <Label htmlFor="mfa-code">{t("mfaCodeLabel")}</Label>
              <Input
                id="mfa-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={mfaCode}
                onChange={(e) =>
                  setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                placeholder="000000"
                required
                maxLength={6}
                className="text-center text-2xl tracking-[0.5em] font-mono"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button
              type="submit"
              className="w-full"
              disabled={loading || mfaCode.length !== 6}
            >
              {loading ? t("mfaVerifying") : t("mfaVerifyButton")}
            </Button>
          </form>
          <p className="text-center text-sm text-muted-foreground mt-4">
            <button
              type="button"
              onClick={() => {
                setMfaToken(null);
                setMfaCode("");
                setError("");
              }}
              className="text-primary hover:underline"
            >
              {t("backToLogin")}
            </button>
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md p-8">
        <h1 className="text-2xl font-bold text-center mb-2">Pickket Admin</h1>
        <p className="text-center text-muted-foreground mb-6">{t("subtitle")}</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="email">{t("emailLabel")}</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <Label htmlFor="password">{t("passwordLabel")}</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? t("loggingIn") : t("loginButton")}
          </Button>
        </form>
        <p className="text-center text-sm text-muted-foreground mt-4">
          {t("consumerLink")}{" "}
          <a href={CONSUMER_URL} className="text-primary hover:underline">
            Pickket
          </a>
        </p>
      </Card>
    </div>
  );
}
