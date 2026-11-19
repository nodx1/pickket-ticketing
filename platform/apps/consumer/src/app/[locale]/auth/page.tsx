"use client";

import { useState, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { motion } from "motion/react";
import {
  Ticket,
  Mail,
  Lock,
  User as UserIcon,
  Eye,
  EyeOff,
  ShieldCheck,
  ChevronLeft,
} from "lucide-react";
import { Button } from "@pickket/ui";
import { Input } from "@pickket/ui";
import { Label } from "@pickket/ui";
import { login, register, mfaVerify } from "@pickket/lib/api";
import { useAuthStore, type User } from "@pickket/store";
import { ConsentItem, SubToggle } from "@/components/auth/ConsentControls";
import SocialLoginButtons from "@/components/auth/SocialLoginButtons";
import { resolveAuthReturnUrl } from "@/lib/auth-redirect";
import { useTranslations } from "next-intl";

/* ── Password strength helpers ────────────────────────────────────── */

function calcPasswordStrength(pw: string): number {
  let score = 0;
  if (pw.length >= 8) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^a-zA-Z0-9]/.test(pw)) score++;
  return score;
}

const strengthColors = [
  "#DC2626",
  "#D97706",
  "#00A882",
  "var(--primary)",
] as const;

/* ── Main Page ──────────────────────────────────────────────────────── */

export default function AuthPage() {
  const t = useTranslations("auth");
  const { setAuth } = useAuthStore();
  const router = useRouter();
  const tCommon = useTranslations("common");
  // 로그인 화면엔 상단 메뉴가 없어서, 홈 화면 앱(PWA)에선 빠져나갈 길이 없었다 → 화면 안 뒤로 가기.
  const goBack = () => {
    if (window.history.length > 1) router.back();
    else router.push("/");
  };
  const searchParams = useSearchParams();
  // AUDIT 2026-05-28 §P0: dev 크레덴셜 프리필 완전 제거 — 컨테이너 빌드 오류 시 노출 위험 차단.
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{
    email?: string;
    password?: string;
  }>({});
  // MFA 단계: 임시 토큰 보관. null이면 일반 로그인 화면
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const safeReturnUrl = resolveAuthReturnUrl(
    searchParams.get("returnUrl"),
    searchParams.get("redirect"),
  );

  const passwordStrength = useMemo(
    () => calcPasswordStrength(password),
    [password],
  );

  /* Consent state */
  const [consents, setConsents] = useState({
    terms: false,
    privacy: false,
    age14: false,
    marketing: false,
    marketingEmail: false,
    marketingSms: false,
    marketingPush: false,
    thirdParty: false,
  });
  const [expandedSections, setExpandedSections] = useState<
    Record<string, boolean>
  >({});
  const consentIds = {
    all: "consent-all",
    terms: "consent-terms",
    privacy: "consent-privacy",
    age14: "consent-age14",
    marketing: "consent-marketing",
    thirdParty: "consent-third-party",
  } as const;

  const allRequired = consents.terms && consents.privacy && consents.age14;
  const allChecked =
    allRequired &&
    consents.marketing &&
    consents.thirdParty &&
    consents.marketingEmail &&
    consents.marketingSms &&
    consents.marketingPush;

  const handleSelectAll = (checked: boolean) => {
    setConsents({
      terms: checked,
      privacy: checked,
      age14: checked,
      marketing: checked,
      marketingEmail: checked,
      marketingSms: checked,
      marketingPush: checked,
      thirdParty: checked,
    });
  };

  const handleConsentChange = (
    key: keyof typeof consents,
    checked: boolean,
  ) => {
    setConsents((prev) => {
      const next = { ...prev, [key]: checked };
      if (key === "marketing" && !checked) {
        next.marketingEmail = false;
        next.marketingSms = false;
        next.marketingPush = false;
      }
      if (key === "marketing" && checked) {
        next.marketingEmail = true;
        next.marketingSms = true;
        next.marketingPush = true;
      }
      if (["marketingEmail", "marketingSms", "marketingPush"].includes(key)) {
        next.marketing =
          next.marketingEmail && next.marketingSms && next.marketingPush;
      }
      return next;
    });
  };

  const toggleSection = (key: string) => {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const resetConsents = () => {
    setConsents({
      terms: false,
      privacy: false,
      age14: false,
      marketing: false,
      marketingEmail: false,
      marketingSms: false,
      marketingPush: false,
      thirdParty: false,
    });
    setExpandedSections({});
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldErrors({});

    if (!isLogin) {
      const errors: { email?: string; password?: string } = {};

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        errors.email = t("error_email_invalid");
      }

      if (password.length < 8) {
        errors.password = t("error_password_length");
      } else if (!/[A-Z]/.test(password)) {
        errors.password = t("error_password_uppercase");
      } else if (!/\d/.test(password)) {
        errors.password = t("error_password_digit");
      }

      if (Object.keys(errors).length > 0) {
        setFieldErrors(errors);
        return;
      }

      if (!allRequired) {
        toast.error(t("error_required_consent"));
        return;
      }
    }

    setLoading(true);
    try {
      const res = isLogin
        ? await login({ email, password })
        : await register({
            email,
            password,
            name,
            is_organizer: isOrganizer,
            consents: {
              terms: consents.terms,
              privacy: consents.privacy,
              age14: consents.age14,
              marketing: consents.marketing,
              marketing_channels: {
                email: consents.marketingEmail,
                sms: consents.marketingSms,
                push: consents.marketingPush,
              },
              third_party: consents.thirdParty,
              consented_at: new Date().toISOString(),
            },
          });

      // MFA 필요 응답: 세션 저장 없이 MFA 코드 입력 화면으로 전환
      if (isLogin && res.data.mfa_required && res.data.mfa_token) {
        setMfaToken(res.data.mfa_token);
        setMfaCode("");
        return;
      }

      // 이 경로에서는 MFA 분기 이후이므로 user가 반드시 존재함
      const user = (res.data as { user: User }).user;
      setAuth(user, "cookie");
      toast.success(isLogin ? t("toast_welcome_back") : t("toast_welcome"));
      router.push(isLogin ? safeReturnUrl || "/" : "/onboarding");
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: unknown } } })
        ?.response?.data?.detail;
      const msg =
        typeof detail === "string"
          ? detail
          : Array.isArray(detail) && detail.length > 0
            ? String(
                detail[0]?.msg ??
                  detail[0]?.message ??
                  t("error_check_input"),
              )
            : typeof detail === "object" &&
                detail !== null &&
                "message" in detail
              ? String((detail as { message: unknown }).message)
              : t("toast_error_generic");
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
      setAuth(data.user, "cookie");
      toast.success(t("toast_welcome_back"));
      router.push(safeReturnUrl || "/");
    } catch {
      toast.error(t("mfa.error_invalid_code"));
      setMfaCode("");
    } finally {
      setLoading(false);
    }
  };

  // ── MFA 코드 입력 화면 ──────────────────────────────────────────────
  if (mfaToken) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-2 sm:px-4">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md"
        >
          <div className="text-center mb-8">
            <div className="inline-flex h-14 w-14 rounded-full bg-primary items-center justify-center mb-4">
              <ShieldCheck className="h-7 w-7 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-foreground">
              {t("mfa.title")}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {t("mfa.subtitle")}
            </p>
          </div>

          <div className="bg-card backdrop-blur-xl rounded-2xl shadow-xl p-6 lg:p-8 border border-border">
            <form onSubmit={handleMfaSubmit} noValidate className="space-y-4">
              <div>
                <Label
                  htmlFor="mfa-code"
                  className="flex items-center gap-1.5 mb-1.5 text-foreground"
                >
                  <ShieldCheck className="h-3.5 w-3.5" /> {t("mfa.code_label")}
                </Label>
                <Input
                  id="mfa-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={mfaCode}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  placeholder={t("mfa.code_placeholder")}
                  required
                  maxLength={6}
                  className="rounded-xl border-input focus:ring-2 focus:ring-primary/20 text-center text-2xl tracking-[0.5em] font-mono"
                />
              </div>

              <Button
                type="submit"
                className="w-full rounded-full bg-primary text-primary-foreground hover:bg-primary/90 h-11 text-base"
                disabled={loading || mfaCode.length !== 6}
              >
                {loading ? t("loading") : t("mfa.verify_button")}
              </Button>
            </form>

            <p className="mt-4 text-center text-sm text-muted-foreground">
              <button
                type="button"
                onClick={() => {
                  setMfaToken(null);
                  setMfaCode("");
                }}
                className="text-primary/70 font-medium hover:underline"
              >
                {t("mfa.back_to_login")}
              </button>
            </p>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-2 sm:px-4 py-16">
      <button
        type="button"
        onClick={goBack}
        aria-label={tCommon("back")}
        className="fixed left-2 top-[calc(env(safe-area-inset-top)+8px)] z-10 flex h-11 w-11 items-center justify-center rounded-full text-foreground hover:bg-muted active:scale-95 sm:left-4 sm:top-4"
      >
        <ChevronLeft className="h-6 w-6" />
      </button>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md"
      >
        <div className="text-center mb-8">
          <div className="inline-flex h-14 w-14 rounded-full bg-primary items-center justify-center mb-4">
            <Ticket className="h-7 w-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">
            {isLogin ? t("title_login") : t("title_register")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isLogin ? t("subtitle_login") : t("subtitle_register")}
          </p>
        </div>

        {/* Glassmorphism Card */}
        <div className="bg-card backdrop-blur-xl rounded-2xl shadow-xl p-6 lg:p-8 border border-border">
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            {!isLogin && (
              <div>
                <Label
                  htmlFor="name"
                  className="flex items-center gap-1.5 mb-1.5 text-foreground"
                >
                  <UserIcon className="h-3.5 w-3.5" /> {t("name")}
                </Label>
                <Input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setName(e.target.value)
                  }
                  placeholder={t("name_placeholder")}
                  required
                  className="rounded-xl border-input focus:ring-2 focus:ring-primary/20"
                />
              </div>
            )}

            <div>
              <Label
                htmlFor="email"
                className="flex items-center gap-1.5 mb-1.5 text-foreground"
              >
                <Mail className="h-3.5 w-3.5" /> {t("email")}
              </Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  setEmail(e.target.value);
                  setFieldErrors((prev) => ({ ...prev, email: undefined }));
                }}
                placeholder="you@pickket.kr"
                required
                className={`rounded-xl border-input focus:ring-2 focus:ring-primary/20 ${fieldErrors.email ? "ring-2 ring-red-500/40" : ""}`}
              />
              {fieldErrors.email && (
                <p className="text-xs text-red-500 mt-1">{fieldErrors.email}</p>
              )}
            </div>

            <div>
              <Label
                htmlFor="password"
                className="flex items-center gap-1.5 mb-1.5 text-foreground"
              >
                <Lock className="h-3.5 w-3.5" /> {t("password")}
              </Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    setPassword(e.target.value);
                    setFieldErrors((prev) => ({
                      ...prev,
                      password: undefined,
                    }));
                  }}
                  required
                  className={`rounded-xl border-input focus:ring-2 focus:ring-primary/20 pr-10 ${fieldErrors.password ? "ring-2 ring-red-500/40" : ""}`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  tabIndex={-1}
                  aria-label={
                    showPassword ? t("password_hide") : t("password_show")
                  }
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
              {fieldErrors.password && (
                <p className="text-xs text-red-500 mt-1">
                  {fieldErrors.password}
                </p>
              )}
              {/* Password strength bar (registration only) */}
              {!isLogin && password.length > 0 && (
                <div className="mt-2 space-y-1">
                  <div className="flex gap-1">
                    {[0, 1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className={`h-1 flex-1 rounded-full transition-colors duration-200 ${
                          i < passwordStrength ? "" : "bg-muted"
                        }`}
                        style={
                          i < passwordStrength
                            ? {
                                backgroundColor:
                                  strengthColors[passwordStrength - 1],
                              }
                            : undefined
                        }
                      />
                    ))}
                  </div>
                  <p
                    className="text-xs"
                    style={{ color: strengthColors[passwordStrength - 1] }}
                  >
                    {t(
                      (["pw_weak", "pw_fair", "pw_strong", "pw_very_strong"] as const)[
                        passwordStrength - 1
                      ],
                    )}
                  </p>
                </div>
              )}
              {isLogin && (
                <div className="flex justify-end mt-1.5">
                  <Link
                    href="/auth/reset-password"
                    className="text-xs text-primary/70 hover:underline font-medium"
                  >
                    {t("forgot_password")}
                  </Link>
                </div>
              )}
            </div>

            {!isLogin && (
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={isOrganizer}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setIsOrganizer(e.target.checked)
                  }
                  className="rounded"
                />
                {t("organizer_toggle")}
              </label>
            )}

            {/* ── Consent Section (signup only) ── */}
            {!isLogin && (
              <div className="space-y-3 pt-2">
                <div className="flex items-center gap-2">
                  <div className="h-px flex-1 bg-border" />
                  <span className="text-xs text-muted-foreground font-medium">
                    {t("consent_title")}
                  </span>
                  <div className="h-px flex-1 bg-border" />
                </div>

                <div className="max-h-[280px] overflow-y-auto space-y-2 pr-1">
                  {/* 전체 동의 */}
                  <label
                    htmlFor={consentIds.all}
                    className="flex items-center gap-2.5 p-3 rounded-xl bg-primary/5 border border-primary/10 cursor-pointer"
                  >
                    <input
                      id={consentIds.all}
                      type="checkbox"
                      checked={allChecked}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        handleSelectAll(e.target.checked)
                      }
                      className="rounded accent-primary w-4 h-4"
                    />
                    <span className="text-sm font-semibold text-foreground">
                      {t("consent_all")}
                    </span>
                  </label>

                  <div className="h-px bg-border" />

                  {/* 이용약관 */}
                  <ConsentItem
                    inputId={consentIds.terms}
                    detailsId="consent-terms-details"
                    checked={consents.terms}
                    onChange={(v) => handleConsentChange("terms", v)}
                    label={t("consent_terms")}
                    required
                    linkHref="/terms"
                    linkLabel={t("consent_view_all")}
                    expanded={expandedSections.terms}
                    onToggleExpand={() => toggleSection("terms")}
                    summary={t("consent_terms_summary")}
                  />

                  {/* 개인정보 수집·이용 */}
                  <ConsentItem
                    inputId={consentIds.privacy}
                    detailsId="consent-privacy-details"
                    checked={consents.privacy}
                    onChange={(v) => handleConsentChange("privacy", v)}
                    label={t("consent_privacy")}
                    required
                    linkHref="/privacy"
                    linkLabel={t("consent_view_all")}
                    expanded={expandedSections.privacy}
                    onToggleExpand={() => toggleSection("privacy")}
                    summary={null}
                  >
                    <div className="text-xs text-muted-foreground space-y-1 mt-1.5 pl-6">
                      <p>
                        <span className="font-medium text-foreground">
                          {t("privacy_items_label")}
                        </span>{" "}
                        {t("privacy_items_value")}
                      </p>
                      <p>
                        <span className="font-medium text-foreground">
                          {t("privacy_purpose_label")}
                        </span>{" "}
                        {t("privacy_purpose_value")}
                      </p>
                      <p>
                        <span className="font-medium text-foreground">
                          {t("privacy_retention_label")}
                        </span>{" "}
                        {t("privacy_retention_value")}
                      </p>
                    </div>
                  </ConsentItem>

                  {/* Age 14+ */}
                  <ConsentItem
                    inputId={consentIds.age14}
                    checked={consents.age14}
                    onChange={(v) => handleConsentChange("age14", v)}
                    label={t("consent_age14")}
                    required
                  />

                  <div className="h-px bg-border" />

                  {/* 마케팅 수신 */}
                  <ConsentItem
                    inputId={consentIds.marketing}
                    detailsId="consent-marketing-details"
                    checked={consents.marketing}
                    onChange={(v) => handleConsentChange("marketing", v)}
                    label={t("consent_marketing")}
                    required={false}
                    expanded={expandedSections.marketing}
                    onToggleExpand={() => toggleSection("marketing")}
                    summary={t("consent_marketing_summary")}
                  />
                  {(expandedSections.marketing || consents.marketing) && (
                    <div className="pl-8 space-y-1.5">
                      <SubToggle
                        checked={consents.marketingEmail}
                        onChange={(v) =>
                          handleConsentChange("marketingEmail", v)
                        }
                        label={t("email")}
                      />
                      <SubToggle
                        checked={consents.marketingSms}
                        onChange={(v) => handleConsentChange("marketingSms", v)}
                        label="SMS"
                      />
                      <SubToggle
                        checked={consents.marketingPush}
                        onChange={(v) =>
                          handleConsentChange("marketingPush", v)
                        }
                        label={t("push_notification")}
                      />
                    </div>
                  )}

                  {/* 제3자 제공 */}
                  <ConsentItem
                    inputId={consentIds.thirdParty}
                    detailsId="consent-third-party-details"
                    checked={consents.thirdParty}
                    onChange={(v) => handleConsentChange("thirdParty", v)}
                    label={t("consent_third_party")}
                    required={false}
                    expanded={expandedSections.thirdParty}
                    onToggleExpand={() => toggleSection("thirdParty")}
                    summary={t("consent_third_party_summary")}
                  />
                </div>
              </div>
            )}

            <Button
              type="submit"
              className="w-full rounded-full bg-primary text-primary-foreground hover:bg-primary/90 h-11 text-base"
              disabled={loading || (!isLogin && !allRequired)}
            >
              {loading ? t("loading") : isLogin ? t("login") : t("register")}
            </Button>
          </form>

          {/* Social Login Buttons */}
          <SocialLoginButtons returnUrl={safeReturnUrl} />

          <p className="mt-4 text-center text-sm text-muted-foreground">
            {isLogin ? t("no_account") : t("have_account")}{" "}
            <button
              type="button"
              onClick={() => {
                setIsLogin(!isLogin);
                resetConsents();
              }}
              className="text-primary/70 font-medium hover:underline"
            >
              {isLogin ? t("register") : t("login")}
            </button>
          </p>
        </div>
      </motion.div>
    </div>
  );
}
