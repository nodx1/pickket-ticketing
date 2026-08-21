"use client";

import { useMemo, useState } from "react";
import {
  Accessibility,
  ChevronLeft,
  ChevronRight,
  Phone,
  Shield,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Button, Input, Switch } from "@pickket/ui";
import { createHoneypotProps } from "@pickket/lib";
import {
  submitSimpleBooking,
  type EventDetail,
  type SeatTier,
} from "@pickket/lib/api";

interface SimpleBookingModeProps {
  event: EventDetail;
  tiers: SeatTier[];
}

export default function SimpleBookingMode({
  event,
  tiers,
}: SimpleBookingModeProps) {
  const t = useTranslations("booking.simpleMode");
  const [enabled, setEnabled] = useState(false);
  const [step, setStep] = useState(1);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [selectedTierId, setSelectedTierId] = useState<string>("");
  const [quantity, setQuantity] = useState(1);
  const [honeypot, setHoneypot] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const selectedTier = useMemo(
    () => tiers.find((tier) => tier.id === selectedTierId) ?? null,
    [selectedTierId, tiers],
  );
  const nameError = !name.trim() ? t("nameRequired") : "";
  const phoneError = !phone.trim() ? t("phoneRequired") : "";
  const shouldValidateContact = step >= 2;

  async function handleSubmit() {
    if (!selectedTierId || !phone.trim() || !name.trim()) {
      toast.error(t("validationAllRequired"));
      return;
    }
    if (honeypot) {
      toast.error(t("honeypotBlocked"));
      return;
    }

    try {
      setSubmitting(true);
      await submitSimpleBooking({
        actual_user_name: name.trim(),
        actual_user_phone: phone.trim(),
        requested_quantity: quantity,
        event_id: event.id,
        tier_id: selectedTierId,
      });
      setSubmitted(true);
      toast.success(t("submitSuccess"));
    } catch {
      toast.error(t("submitError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      className={`rounded-3xl border p-6 ${
        enabled
          ? "border-black bg-white text-black shadow-[0_14px_40px_rgba(0,0,0,0.1)]"
          : "border-border bg-card"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-lg font-bold">
            <Accessibility className="h-5 w-5" />
            {t("title")}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{t("accessibilityLabel")}</span>
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label={t("toggleAriaLabel")}
          />
        </div>
      </div>

      {enabled && (
        <div className="mt-6 space-y-5">
          <div className="grid gap-2 text-center sm:grid-cols-3">
            {[t("stepSelectEvent"), t("stepEnterInfo"), t("stepConfirm")].map((label, index) => (
              <div
                key={label}
                aria-current={step === index + 1 ? "step" : undefined}
                className={`rounded-2xl px-4 py-3 text-lg font-bold ${
                  step === index + 1
                    ? "bg-black text-white"
                    : "bg-neutral-100 text-neutral-500"
                }`}
              >
                {index + 1}. {label}
              </div>
            ))}
          </div>

          {submitted ? (
            <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-6">
              <p className="text-2xl font-black">{t("submittedTitle")}</p>
              <p className="mt-2 text-lg">
                {t("submittedMessage", { name: name ?? "", phone: phone ?? "" })}
              </p>
            </div>
          ) : (
            <>
              {step === 1 && (
                <div className="grid gap-3 md:grid-cols-2">
                  {tiers.map((tier) => (
                    <button
                      key={tier.id}
                      type="button"
                      className={`rounded-3xl border p-5 text-left transition ${
                        selectedTierId === tier.id
                          ? "border-black bg-black text-white"
                          : "border-border bg-background"
                      }`}
                      onClick={() => setSelectedTierId(tier.id)}
                      aria-label={t("tierSelectAriaLabel", { name: tier.name ?? "" })}
                    >
                      <p className="text-2xl font-black">{tier.name}</p>
                      <p className="mt-2 text-lg">
                        {t("tierRemaining", { count: tier.remaining ?? 0 })}
                      </p>
                    </button>
                  ))}
                </div>
              )}

              {step === 2 && (
                <div className="space-y-4">
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={t("namePlaceholder")}
                    className="h-14 text-lg"
                    aria-label={t("namePlaceholder")}
                    aria-required="true"
                    aria-invalid={shouldValidateContact && Boolean(nameError)}
                    aria-describedby={
                      shouldValidateContact && nameError
                        ? "simple-booking-name-error"
                        : undefined
                    }
                  />
                  {shouldValidateContact && nameError && (
                    <p
                      id="simple-booking-name-error"
                      className="text-sm font-medium text-destructive"
                    >
                      {nameError}
                    </p>
                  )}
                  <Input
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    placeholder={t("phonePlaceholder")}
                    className="h-14 text-lg"
                    aria-label={t("phonePlaceholder")}
                    aria-required="true"
                    aria-invalid={shouldValidateContact && Boolean(phoneError)}
                    aria-describedby={
                      shouldValidateContact && phoneError
                        ? "simple-booking-phone-error"
                        : undefined
                    }
                  />
                  {shouldValidateContact && phoneError && (
                    <p
                      id="simple-booking-phone-error"
                      className="text-sm font-medium text-destructive"
                    >
                      {phoneError}
                    </p>
                  )}
                  <div className="flex items-center gap-4 rounded-2xl bg-neutral-100 p-4">
                    <Button
                      type="button"
                      size="lg"
                      variant="outline"
                      className="h-14 w-14 rounded-full text-2xl"
                      onClick={() =>
                        setQuantity((value) => Math.max(1, value - 1))
                      }
                      aria-label={t("decreaseQuantityAriaLabel")}
                    >
                      -
                    </Button>
                    <span className="text-2xl font-black">{t("quantityUnit", { count: quantity ?? 0 })}</span>
                    <Button
                      type="button"
                      size="lg"
                      variant="outline"
                      className="h-14 w-14 rounded-full text-2xl"
                      onClick={() =>
                        setQuantity((value) => Math.min(4, value + 1))
                      }
                      aria-label={t("increaseQuantityAriaLabel")}
                    >
                      +
                    </Button>
                  </div>
                  <input
                    {...createHoneypotProps()}
                    value={honeypot}
                    onChange={(event) => setHoneypot(event.target.value)}
                    className="absolute left-[-9999px] top-auto h-px w-px opacity-0"
                  />
                </div>
              )}

              {step === 3 && (
                <div className="space-y-4 rounded-3xl bg-neutral-100 p-6">
                  <p className="text-2xl font-black">{t("confirmTitle")}</p>
                  <p className="text-lg">{t("confirmEvent", { title: event.title ?? "" })}</p>
                  <p className="text-lg">
                    {t("confirmTier", { name: selectedTier?.name || t("notSelected") })}
                  </p>
                  <p className="text-lg">{t("confirmBooker", { name: name || t("notEntered") })}</p>
                  <p className="text-lg">{t("confirmPhone", { phone: phone || t("notEntered") })}</p>
                  <p className="text-lg">{t("confirmQuantity", { count: quantity ?? 0 })}</p>
                  <div className="flex items-start gap-2 rounded-2xl border border-black/10 bg-white p-4 text-base">
                    <Shield className="mt-1 h-5 w-5 shrink-0" />
                    {t("noSignupNotice")}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap justify-between gap-3">
                <Button
                  type="button"
                  size="lg"
                  variant="outline"
                  className="h-14 rounded-full px-8 text-lg"
                  onClick={() => setStep((value) => Math.max(1, value - 1))}
                  disabled={step === 1}
                >
                  <ChevronLeft className="h-5 w-5" />
                  {t("prevButton")}
                </Button>
                {step < 3 ? (
                  <Button
                    type="button"
                    size="lg"
                    className="h-14 rounded-full px-8 text-lg"
                    onClick={() => setStep((value) => Math.min(3, value + 1))}
                    disabled={
                      step === 1
                        ? !selectedTierId
                        : !phone.trim() || !name.trim()
                    }
                  >
                    {t("nextButton")}
                    <ChevronRight className="h-5 w-5" />
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="lg"
                    className="h-14 rounded-full px-8 text-lg"
                    onClick={() => void handleSubmit()}
                    disabled={submitting}
                  >
                    <Phone className="h-5 w-5" />
                    {submitting ? t("submittingButton") : t("submitButton")}
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
