"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@pickket/ui";
import { toast } from "sonner";
import { CheckCircle, Send } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { submitContactForm } from "@pickket/lib/api";

export default function ContactForm() {
  const t = useTranslations("support.contactForm");

  const CATEGORIES = [
    t("categoryPurchase"),
    t("categoryPayment"),
    t("categoryResale"),
    t("categoryAccount"),
    t("categoryOther"),
  ];

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [category, setCategory] = useState("");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  const isValid = name.trim() && email.trim() && category && content.trim();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;

    setSubmitting(true);
    try {
      await submitContactForm({
        name: name.trim(),
        email: email.trim(),
        subject: category,
        message: content.trim(),
      });
      setSuccess(true);
      toast.success(t("toastSuccess"));
    } catch {
      toast.error(t("toastError"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AnimatePresence mode="wait">
      {success ? (
        <motion.div
          key="success"
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          className="bg-card rounded-2xl border border-border p-8 text-center space-y-4"
        >
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
          >
            <CheckCircle className="h-14 w-14 text-green-500 mx-auto" />
          </motion.div>
          <h3 className="text-lg font-bold text-foreground">
            {t("successTitle")}
          </h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {t("successReply")}
            <br />
            {t("successReplyDays")}
          </p>
          <div className="bg-surface-dim rounded-xl p-4 text-xs text-muted-foreground space-y-1">
            <p>
              {t("urgentContact")}{" "}
              <span className="font-medium text-foreground">1588-0000</span>
            </p>
            <p>
              {t("emailContact")}{" "}
              <span className="font-medium text-foreground">
                support@pickket.kr
              </span>
            </p>
          </div>
          <Button
            onClick={() => {
              setSuccess(false);
              setName("");
              setEmail("");
              setCategory("");
              setContent("");
            }}
            variant="outline"
            className="rounded-full"
          >
            {t("newInquiry")}
          </Button>
        </motion.div>
      ) : (
        <motion.form
          key="form"
          exit={{ opacity: 0 }}
          onSubmit={handleSubmit}
          className="bg-card rounded-2xl border border-border p-6 space-y-4"
        >
          {/* Name */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              {t("labelName")}
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
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              {t("labelEmail")}
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="example@email.com"
              className="w-full h-10 px-4 rounded-xl border border-border bg-surface-dim text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40"
            />
          </div>

          {/* Category */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              {t("labelCategory")}
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full h-10 px-4 rounded-xl border border-border bg-surface-dim text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 appearance-none"
            >
              <option value="">{t("categoryPlaceholder")}</option>
              {CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </div>

          {/* Content */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              {t("labelContent")}
            </label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={t("placeholderContent")}
              rows={5}
              className="w-full px-4 py-3 rounded-xl border border-border bg-surface-dim text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40"
            />
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

          <p className="text-2xs text-muted-foreground text-center">
            {t("footerNote")}
          </p>
        </motion.form>
      )}
    </AnimatePresence>
  );
}
