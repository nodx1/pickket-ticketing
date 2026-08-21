"use client";

import { useState } from "react";
import { Bell, ArrowRight, CheckCircle } from "lucide-react";
import { toast } from "sonner";
import { subscribeNewsletter } from "@pickket/lib/api";
import { useTranslations } from "next-intl";

export default function EmailCapture() {
  const t = useTranslations("marketing.emailCapture");
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || submitting) return;

    setSubmitting(true);
    try {
      await subscribeNewsletter(email.trim());
      setSubmitted(true);
      toast.success(t("toastSuccess"));
    } catch {
      toast.error(t("toastError"));
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <section className="py-8">
        <div className="max-w-7xl mx-auto px-10 lg:px-16">
          <div className="rounded-2xl bg-[#F0FDF4] p-6 flex items-center justify-center gap-3">
            <CheckCircle className="h-5 w-5 text-cyan" />
            <p className="text-sm font-semibold text-foreground">
              {t("successMessage")}
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="py-8">
      <div className="max-w-7xl mx-auto px-10 lg:px-16">
        <div className="rounded-2xl bg-gradient-to-r from-[#0a0a0a] to-[#404040] p-6 md:p-8 flex flex-col md:flex-row items-center gap-5">
          {/* Left: text */}
          <div className="flex-1 text-center md:text-left">
            <div className="flex items-center justify-center md:justify-start gap-2 mb-2">
              <Bell className="h-5 w-5 text-cyan" />
              <h3 className="text-lg font-bold text-white">{t("heading")}</h3>
            </div>
            <p className="text-white/70 text-sm">
              {t("subheading")}
            </p>
          </div>

          {/* Right: input */}
          <form onSubmit={handleSubmit} className="flex gap-2 w-full md:w-auto">
            <label htmlFor="email-capture-input" className="sr-only">
              {t("emailLabel")}
            </label>
            <input
              id="email-capture-input"
              type="email"
              placeholder={t("emailPlaceholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="flex-1 md:w-[280px] h-11 px-4 rounded-full bg-white/15 border border-white/20 text-white placeholder:text-white/50 text-sm outline-none focus:bg-white/20 focus:border-white/40 transition-colors"
            />
            <button
              type="submit"
              disabled={submitting}
              className="h-11 px-6 rounded-full bg-white text-primary text-sm font-semibold hover:bg-white/90 transition-colors flex items-center gap-1.5 shrink-0 disabled:opacity-60"
            >
              {submitting ? t("buttonSubmitting") : t("buttonSubmit")}
              {!submitting && <ArrowRight className="h-4 w-4" />}
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}
