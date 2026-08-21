"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Input } from "@pickket/ui";
import { api } from "@pickket/lib";
import { Phone, Shield, Check, X } from "lucide-react";

interface PhoneVerifyModalProps {
  open: boolean;
  onClose: () => void;
  onVerified: () => void;
}

export default function PhoneVerifyModal({
  open,
  onClose,
  onVerified,
}: PhoneVerifyModalProps) {
  const t = useTranslations("mypage.phoneVerifyModal");
  const [step, setStep] = useState<"input" | "otp" | "done">("input");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  const reset = () => {
    setStep("input");
    setPhone("");
    setCode("");
    setError("");
  };

  const handleSend = async () => {
    setError("");
    setLoading(true);
    try {
      await api.post("/auth/verify-phone/send", { phone });
      setStep("otp");
    } catch (e: unknown) {
      const err = e as { response?: { data?: { message?: string } } };
      setError(err.response?.data?.message || t("sendFailed"));
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    setError("");
    setLoading(true);
    try {
      await api.post("/auth/verify-phone/confirm", { phone, code });
      setStep("done");
      onVerified();
    } catch (e: unknown) {
      const err = e as { response?: { data?: { message?: string } } };
      setError(err.response?.data?.message || t("codeMismatch"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-background rounded-2xl shadow-xl w-full max-w-sm p-6 m-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="flex items-center gap-2 font-bold text-lg">
            <Shield className="h-5 w-5 text-primary" />
            {t("title")}
          </h3>
          <button
            onClick={() => {
              reset();
              onClose();
            }}
            className="p-1 hover:bg-muted rounded"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {step === "input" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t("inputDescription")}
            </p>
            <div className="flex items-center gap-2 px-3 py-2 border rounded-lg">
              <Phone className="h-4 w-4 text-muted-foreground" />
              <Input
                type="tel"
                placeholder="010-1234-5678"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="border-0 focus-visible:ring-0 p-0 h-auto"
              />
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <Button
              onClick={handleSend}
              disabled={loading || phone.replace(/\D/g, "").length < 10}
              className="w-full"
            >
              {loading ? t("sending") : t("sendCode")}
            </Button>
          </div>
        )}

        {step === "otp" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t("otpDescription", { phone: phone ?? "" })}
            </p>
            <Input
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              className="text-center font-tabular text-lg tracking-widest"
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setStep("input")}
                className="flex-1"
              >
                {t("changeNumber")}
              </Button>
              <Button
                onClick={handleConfirm}
                disabled={loading || code.length !== 6}
                className="flex-1"
              >
                {loading ? t("verifying") : t("confirm")}
              </Button>
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="space-y-3 text-center py-4">
            <div className="mx-auto h-14 w-14 rounded-full bg-emerald-100 dark:bg-emerald-950 flex items-center justify-center">
              <Check className="h-7 w-7 text-emerald-600 dark:text-emerald-400" />
            </div>
            <p className="font-semibold">{t("doneTitle")}</p>
            <p className="text-sm text-muted-foreground">
              {t("doneDescription")}
            </p>
            <Button
              onClick={() => {
                reset();
                onClose();
              }}
              className="w-full"
            >
              {t("close")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
