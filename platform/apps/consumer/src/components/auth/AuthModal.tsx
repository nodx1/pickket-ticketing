"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Mail, Lock, Ticket, Eye, EyeOff, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@pickket/ui";
import { Button } from "@pickket/ui";
import { Input } from "@pickket/ui";
import { Label } from "@pickket/ui";
import { login, mfaVerify } from "@pickket/lib/api";
import { useAuthStore, type User } from "@pickket/store";
import { sanitizeReturnUrl } from "@/lib/auth-redirect";
import SocialLoginButtons from "./SocialLoginButtons";

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  returnUrl?: string;
}

export default function AuthModal({
  open,
  onClose,
  onSuccess,
  returnUrl,
}: AuthModalProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // MFA 단계: 임시 토큰 보관. null이면 일반 로그인 화면
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const { setAuth } = useAuthStore();
  const router = useRouter();
  const t = useTranslations("common.authModal");

  const _onAuthSuccess = (user: User) => {
    setAuth(user, "cookie");
    toast.success(t("loginSuccess"));
    setEmail("");
    setPassword("");
    setMfaToken(null);
    setMfaCode("");
    onSuccess();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await login({ email, password });

      // MFA 필요 응답: 세션 저장 없이 MFA 코드 입력 화면으로 전환
      if (res.data.mfa_required && res.data.mfa_token) {
        setMfaToken(res.data.mfa_token);
        setMfaCode("");
        return;
      }

      _onAuthSuccess((res.data as { user: User }).user);
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: unknown } } })
        ?.response?.data?.detail;
      const msg =
        typeof detail === "string"
          ? detail
          : t("loginFailed");
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleMfaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mfaToken) return;
    setLoading(true);
    try {
      const data = await mfaVerify({ mfaToken, code: mfaCode });
      _onAuthSuccess(data.user);
    } catch {
      toast.error(t("mfaInvalid"));
      setMfaCode("");
    } finally {
      setLoading(false);
    }
  };

  const handleSocialRedirect = () => {
    // Set login redirect marker so BookingFlow preserves hold on unmount
    try {
      sessionStorage.setItem("pickket_login_redirect", "true");
    } catch {
      /* noop */
    }
    onClose();
  };

  const handleSignupRedirect = () => {
    try {
      sessionStorage.setItem("pickket_login_redirect", "true");
    } catch {
      /* noop */
    }
    onClose();
    const safeReturnUrl = sanitizeReturnUrl(returnUrl);
    const params = new URLSearchParams({ tab: "signup" });
    if (safeReturnUrl) params.set("returnUrl", safeReturnUrl);
    router.push(`/auth?${params.toString()}`);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md bg-card border-border">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="inline-flex h-10 w-10 rounded-full bg-primary/10 items-center justify-center shrink-0">
              <Ticket className="h-5 w-5 text-primary/70" />
            </div>
            <div>
              <DialogTitle className="text-lg text-foreground">
                {t("title")}
              </DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground mt-0.5">
                {t("description")}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {mfaToken ? (
          <form onSubmit={handleMfaSubmit} noValidate className="space-y-4 pt-2">
            <div className="flex flex-col items-center gap-2 pb-2">
              <ShieldCheck className="h-8 w-8 text-primary/70" />
              <p className="text-sm text-muted-foreground text-center">
                {t("mfaPrompt")}
              </p>
            </div>
            <div>
              <Label
                htmlFor="auth-modal-mfa-code"
                className="flex items-center gap-1.5 mb-1.5 text-foreground"
              >
                <ShieldCheck className="h-3.5 w-3.5" /> {t("mfaCodeLabel")}
              </Label>
              <Input
                id="auth-modal-mfa-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={mfaCode}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                placeholder="000000"
                required
                maxLength={6}
                className="rounded-xl bg-card border-none focus:ring-2 focus:ring-primary/20 text-center text-2xl tracking-[0.5em] font-mono"
              />
            </div>
            <Button
              type="submit"
              className="w-full rounded-full bg-primary hover:bg-primary/90 h-11 text-base"
              disabled={loading || mfaCode.length !== 6}
            >
              {loading ? t("mfaVerifying") : t("mfaVerify")}
            </Button>
            <p className="text-center text-sm">
              <button
                type="button"
                onClick={() => { setMfaToken(null); setMfaCode(""); }}
                className="text-primary/70 font-medium hover:underline"
              >
                {t("backToLogin")}
              </button>
            </p>
          </form>
        ) : (
          <form onSubmit={handleSubmit} noValidate className="space-y-4 pt-2">
            <div>
              <Label
                htmlFor="auth-modal-email"
                className="flex items-center gap-1.5 mb-1.5 text-foreground"
              >
                <Mail className="h-3.5 w-3.5" /> {t("emailLabel")}
              </Label>
              <Input
                id="auth-modal-email"
                type="email"
                value={email}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setEmail(e.target.value)
                }
                placeholder="you@pickket.kr"
                required
                className="rounded-xl bg-card border-none focus:ring-2 focus:ring-primary/20"
              />
            </div>

            <div>
              <Label
                htmlFor="auth-modal-password"
                className="flex items-center gap-1.5 mb-1.5 text-foreground"
              >
                <Lock className="h-3.5 w-3.5" /> {t("passwordLabel")}
              </Label>
              <div className="relative">
                <Input
                  id="auth-modal-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setPassword(e.target.value)
                  }
                  required
                  className="rounded-xl bg-card border-none focus:ring-2 focus:ring-primary/20 pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  tabIndex={-1}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              className="w-full rounded-full bg-primary hover:bg-primary/90 h-11 text-base"
              disabled={loading || !email || !password}
            >
              {loading ? t("loggingIn") : t("login")}
            </Button>
          </form>
        )}

        {/* Social login — MFA 화면에서는 숨김 */}
        {!mfaToken && (
          <>
            <SocialLoginButtons
              returnUrl={returnUrl}
              onBeforeRedirect={handleSocialRedirect}
            />

            <p className="text-center text-sm text-muted-foreground">
              {t("noAccount")}{" "}
              <button
                type="button"
                onClick={handleSignupRedirect}
                className="text-primary/70 font-medium hover:underline"
              >
                {t("signup")}
              </button>
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
