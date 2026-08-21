"use client";

import { useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { motion } from "motion/react";
import { Mail, ArrowLeft } from "lucide-react";
import { Button } from "@pickket/ui";
import { Input } from "@pickket/ui";
import { Label } from "@pickket/ui";
import { requestPasswordReset } from "@pickket/lib/api";
import { useTranslations } from "next-intl";

const makeResetRequestSchema = (t: ReturnType<typeof useTranslations<"auth.resetPassword">>) =>
  z.object({
    email: z.string().email(t("emailInvalid")),
  });

type ResetRequestForm = { email: string };

export default function ResetPasswordPage() {
  const t = useTranslations("auth.resetPassword");
  const resetRequestSchema = makeResetRequestSchema(t);
  const [submitted, setSubmitted] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResetRequestForm>({
    resolver: zodResolver(resetRequestSchema),
  });

  const onSubmit = async (data: ResetRequestForm) => {
    try {
      await requestPasswordReset(data.email);
      setSubmitted(true);
    } catch {
      toast.error(t("submitError"));
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
            <Mail className="h-7 w-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t("subtitle")}
          </p>
        </div>

        <div className="bg-card/90 backdrop-blur-xl rounded-2xl shadow-lg p-6 lg:p-8">
          {submitted ? (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="text-center space-y-4"
            >
              <div className="inline-flex h-12 w-12 rounded-full bg-green-100 dark:bg-green-900/30 items-center justify-center mx-auto">
                <Mail className="h-6 w-6 text-green-600 dark:text-green-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">{t("checkEmailTitle")}</h2>
                <p className="text-sm text-muted-foreground mt-2">
                  {t("checkEmailBody")}
                </p>
              </div>
              <Link
                href="/auth"
                className="inline-flex items-center gap-1.5 text-sm text-primary/70 font-medium hover:underline mt-4"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                {t("backToLogin")}
              </Link>
            </motion.div>
          ) : (
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div>
                <Label
                  htmlFor="email"
                  className="flex items-center gap-1.5 mb-1.5"
                >
                  <Mail className="h-3.5 w-3.5" /> {t("emailLabel")}
                </Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@pickket.kr"
                  className="rounded-xl bg-card border-none focus:ring-2 focus:ring-primary/20"
                  {...register("email")}
                />
                {errors.email && (
                  <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                    {errors.email.message}
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
