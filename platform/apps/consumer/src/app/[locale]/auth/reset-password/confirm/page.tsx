"use client";

import { useState, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { motion } from "motion/react";
import { Lock, ArrowLeft, CheckCircle, Eye, EyeOff } from "lucide-react";
import { Button } from "@pickket/ui";
import { Input } from "@pickket/ui";
import { Label } from "@pickket/ui";
import { confirmPasswordReset } from "@pickket/lib/api";
import { useTranslations } from "next-intl";

function ResetConfirmContent() {
  const t = useTranslations("auth.resetPasswordConfirm");
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const uid = searchParams.get("uid");
  const [completed, setCompleted] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);
  const [showConfirmPw, setShowConfirmPw] = useState(false);
  const [pwValue, setPwValue] = useState("");

  const resetConfirmSchema = z
    .object({
      new_password: z
        .string()
        .min(8, t("passwordMinLength"))
        .max(72, t("passwordMaxLength")),
      confirm_password: z.string(),
    })
    .refine((data) => data.new_password === data.confirm_password, {
      message: t("passwordMismatch"),
      path: ["confirm_password"],
    });

  type ResetConfirmForm = z.infer<typeof resetConfirmSchema>;

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResetConfirmForm>({
    resolver: zodResolver(resetConfirmSchema),
  });

  const isInvalidLink = !token || !uid;

  const onSubmit = async (data: ResetConfirmForm) => {
    if (!token || !uid) return;
    try {
      await confirmPasswordReset(token, uid, data.new_password);
      setCompleted(true);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail || t("submitError");
      toast.error(msg);
    }
  };

  return (
    <div className="bg-background min-h-screen min-h-[80vh] flex items-center justify-center px-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md"
      >
        <div className="text-center mb-8">
          <div className="inline-flex h-14 w-14 rounded-full bg-primary items-center justify-center mb-4">
            <Lock className="h-7 w-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t("subtitle")}
          </p>
        </div>

        <div className="bg-card/90 backdrop-blur-xl rounded-2xl shadow-lg p-6 lg:p-8">
          {isInvalidLink ? (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="text-center space-y-4"
            >
              <p className="text-sm text-red-600 dark:text-red-400 font-medium">
                {t("invalidLinkTitle")}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("invalidLinkDesc")}
              </p>
              <Link
                href="/auth/reset-password"
                className="inline-flex items-center gap-1.5 text-sm text-primary/70 font-medium hover:underline"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                {t("requestAgain")}
              </Link>
            </motion.div>
          ) : completed ? (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="text-center space-y-4"
            >
              <div className="inline-flex h-12 w-12 rounded-full bg-green-100 dark:bg-green-900/30 items-center justify-center mx-auto">
                <CheckCircle className="h-6 w-6 text-green-600 dark:text-green-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">
                  {t("successTitle")}
                </h2>
                <p className="text-sm text-muted-foreground mt-2">
                  {t("successDesc")}
                </p>
              </div>
              <Link href="/auth" className="inline-block mt-2">
                <Button className="rounded-full bg-primary hover:bg-primary/90 h-11 px-8 text-base">
                  {t("goToLogin")}
                </Button>
              </Link>
            </motion.div>
          ) : (
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div>
                <Label
                  htmlFor="new_password"
                  className="flex items-center gap-1.5 mb-1.5"
                >
                  <Lock className="h-3.5 w-3.5" /> {t("newPasswordLabel")}
                </Label>
                <div className="relative">
                  <Input
                    id="new_password"
                    type={showNewPw ? "text" : "password"}
                    placeholder={t("newPasswordPlaceholder")}
                    className="rounded-xl bg-card border-none focus:ring-2 focus:ring-primary/20 pr-10"
                    {...register("new_password", {
                      onChange: (e) => setPwValue(e.target.value),
                    })}
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPw(!showNewPw)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                  >
                    {showNewPw ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
                {/* Password strength bar */}
                {pwValue &&
                  (() => {
                    const checks = [
                      pwValue.length >= 8,
                      /[a-z]/.test(pwValue) && /[A-Z]/.test(pwValue),
                      /\d/.test(pwValue),
                      /[^a-zA-Z0-9]/.test(pwValue),
                    ];
                    const strength = checks.filter(Boolean).length;
                    const colors = [
                      "bg-red-600",
                      "bg-amber-600",
                      "bg-emerald-600",
                      "bg-primary",
                    ];
                    const strengthLabels = [
                      t("strengthWeak"),
                      t("strengthFair"),
                      t("strengthStrong"),
                      t("strengthVeryStrong"),
                    ];
                    return (
                      <div className="mt-2 space-y-1">
                        <div className="flex gap-1">
                          {[0, 1, 2, 3].map((i) => (
                            <div
                              key={i}
                              className={`h-1 flex-1 rounded-full transition-colors ${i < strength ? colors[strength - 1] : "bg-muted"}`}
                            />
                          ))}
                        </div>
                        <p className="text-2xs text-muted-foreground">
                          {strengthLabels[strength - 1]}
                        </p>
                      </div>
                    );
                  })()}
                {errors.new_password && (
                  <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                    {errors.new_password.message}
                  </p>
                )}
              </div>

              <div>
                <Label
                  htmlFor="confirm_password"
                  className="flex items-center gap-1.5 mb-1.5"
                >
                  <Lock className="h-3.5 w-3.5" /> {t("confirmPasswordLabel")}
                </Label>
                <div className="relative">
                  <Input
                    id="confirm_password"
                    type={showConfirmPw ? "text" : "password"}
                    placeholder={t("confirmPasswordPlaceholder")}
                    className="rounded-xl bg-card border-none focus:ring-2 focus:ring-primary/20 pr-10"
                    {...register("confirm_password")}
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPw(!showConfirmPw)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                  >
                    {showConfirmPw ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
                {errors.confirm_password && (
                  <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                    {errors.confirm_password.message}
                  </p>
                )}
              </div>

              <Button
                type="submit"
                className="w-full rounded-full bg-primary hover:bg-primary/90 h-11 text-base"
                disabled={isSubmitting}
              >
                {isSubmitting ? t("submitting") : t("submitButton")}
              </Button>

              <p className="text-center text-sm text-muted-foreground">
                <Link
                  href="/auth"
                  className="inline-flex items-center gap-1 text-primary/70 font-medium hover:underline"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  {t("backToLogin")}
                </Link>
              </p>
            </form>
          )}
        </div>
      </motion.div>
    </div>
  );
}

export default function ResetPasswordConfirmPage() {
  const t = useTranslations("auth.resetPasswordConfirm");
  return (
    <Suspense
      fallback={
        <div className="min-h-[80vh] flex items-center justify-center">
          <p className="text-muted-foreground">{t("loading")}</p>
        </div>
      }
    >
      <ResetConfirmContent />
    </Suspense>
  );
}
