"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { motion, AnimatePresence } from "motion/react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@pickket/ui";
import { Button } from "@pickket/ui";
import { toast } from "sonner";
import {
  Send,
  CheckCircle,
  Paperclip,
  User,
  Mail,
  FileText,
  Briefcase,
  Ticket,
} from "lucide-react";
import { submitCareerApplication } from "@pickket/lib/api";

interface ApplicationModalProps {
  open: boolean;
  onClose: () => void;
  position?: string;
  team?: string;
}

export default function ApplicationModal({
  open,
  onClose,
  position,
  team,
}: ApplicationModalProps) {
  const t = useTranslations("careers.applicationModal");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [intro, setIntro] = useState("");
  const [portfolioUrl, setPortfolioUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  const isValid = name.trim() && email.trim() && intro.trim();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;

    setSubmitting(true);
    try {
      await submitCareerApplication({
        name: name.trim(),
        email: email.trim(),
        position: position || t("allPositions"),
        message: intro.trim(),
        resume_url: portfolioUrl.trim() || undefined,
        phone: phone.trim() || undefined,
      });
      setSuccess(true);
      toast.success(t("toastSuccess"));
    } catch {
      toast.error(t("toastError"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    onClose();
    // Reset after close animation
    setTimeout(() => {
      setName("");
      setEmail("");
      setPhone("");
      setIntro("");
      setPortfolioUrl("");
      setSuccess(false);
    }, 300);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto p-0 gap-0 rounded-2xl">
        <AnimatePresence mode="wait">
          {success ? (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="p-8 text-center space-y-5"
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 300, damping: 20 }}
              >
                <CheckCircle className="h-16 w-16 text-green-500 mx-auto" />
              </motion.div>
              <div>
                <h3 className="text-xl font-bold text-foreground mb-2">
                  {t("successTitle")}
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {t("successBody", { name: name ?? "" })}
                  <br />
                  {t("successBodyEmail1")}{" "}
                  <span className="font-medium text-foreground">{email}</span>
                  {t("successBodyEmail2")}
                  <br />
                  {t("successBodyEmail3")}
                </p>
              </div>
              <div className="bg-surface-dim rounded-xl p-4 text-xs text-muted-foreground space-y-1">
                <p>
                  {t("appliedPosition")}{" "}
                  <span className="font-semibold text-foreground">
                    {position || t("allPositions")}
                  </span>
                </p>
                <p>{t("reviewTimeline")}</p>
                <p>
                  {t("contactLabel")}{" "}
                  <span className="font-medium text-foreground">
                    support@pickket.kr
                  </span>
                </p>
              </div>
              <Button
                onClick={handleClose}
                className="rounded-full bg-primary hover:bg-brand-hover text-white px-8"
              >
                {t("confirm")}
              </Button>
            </motion.div>
          ) : (
            <motion.div key="form" exit={{ opacity: 0 }}>
              {/* Header */}
              <DialogHeader className="p-6 pb-0">
                <div className="flex items-center gap-3 mb-1">
                  {position && (
                    <span className="px-2.5 py-1 rounded-full bg-primary/10 text-primary text-2xs font-semibold">
                      {team}
                    </span>
                  )}
                </div>
                <DialogTitle className="text-lg font-bold text-foreground flex items-center gap-1.5">
                  {position ? (
                    <>{position} {t("applyFor")}</>
                  ) : (
                    <>
                      <span className="inline-flex items-center gap-1">
                        <span className="h-5 w-5 rounded-md bg-primary inline-flex items-center justify-center">
                          <Ticket className="h-3 w-3 text-white" />
                        </span>
                        <span>
                          Pick<span className="text-cyan">&middot;</span>ket
                        </span>
                      </span>
                      {t("applyToPickket")}
                    </>
                  )}
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground mt-1">
                  {t("description")}
                </DialogDescription>
              </DialogHeader>

              {/* Form */}
              <form onSubmit={handleSubmit} className="p-6 space-y-4">
                {/* Name */}
                <div>
                  <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-1.5">
                    <User className="h-3 w-3" />
                    {t("labelName")} <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t("placeholderName")}
                    className="w-full h-10 px-4 rounded-xl border border-border bg-surface-dim text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40"
                  />
                </div>

                {/* Email */}
                <div>
                  <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-1.5">
                    <Mail className="h-3 w-3" />
                    {t("labelEmail")} <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@email.com"
                    className="w-full h-10 px-4 rounded-xl border border-border bg-surface-dim text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40"
                  />
                </div>

                {/* Phone */}
                <div>
                  <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-1.5">
                    <Briefcase className="h-3 w-3" />
                    {t("labelPhone")}
                  </label>
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="010-0000-0000"
                    className="w-full h-10 px-4 rounded-xl border border-border bg-surface-dim text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40"
                  />
                </div>

                {/* Portfolio URL */}
                <div>
                  <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-1.5">
                    <Paperclip className="h-3 w-3" />
                    {t("labelPortfolio")}
                  </label>
                  <input
                    type="url"
                    value={portfolioUrl}
                    onChange={(e) => setPortfolioUrl(e.target.value)}
                    placeholder="https://"
                    className="w-full h-10 px-4 rounded-xl border border-border bg-surface-dim text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40"
                  />
                </div>

                {/* Self-introduction */}
                <div>
                  <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-1.5">
                    <FileText className="h-3 w-3" />
                    {t("labelIntro")} <span className="text-red-400">*</span>
                  </label>
                  <textarea
                    value={intro}
                    onChange={(e) => setIntro(e.target.value)}
                    placeholder={t("placeholderIntro")}
                    rows={4}
                    className="w-full px-4 py-3 rounded-xl border border-border bg-surface-dim text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40"
                  />
                  <p className="text-2xs text-muted-foreground mt-1 text-right">
                    {intro.length}/500
                  </p>
                </div>

                {/* Notice */}
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-700 leading-relaxed">
                  {t("privacyNotice")}
                </div>

                {/* Submit */}
                <Button
                  type="submit"
                  disabled={!isValid || submitting}
                  className="w-full h-11 rounded-full bg-primary hover:bg-brand-hover text-white font-semibold"
                >
                  {submitting ? (
                    t("submitting")
                  ) : (
                    <span className="flex items-center gap-2">
                      <Send className="h-4 w-4" />
                      {t("submitButton")}
                    </span>
                  )}
                </Button>
              </form>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
