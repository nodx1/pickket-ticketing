"use client";

import { Mail, User, Phone, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button, Input, Label } from "@pickket/ui";
import { formatKRW } from "@pickket/lib";
import { type GuestBuyer } from "@pickket/lib/api";

interface GuestBuyerFormProps {
  eventTitle: string;
  tierName: string;
  quantity: number;
  totalAmount: number;
  isFree: boolean;
  buyer: GuestBuyer;
  emailValid: boolean;
  canSubmit: boolean;
  processing: boolean;
  error: string | null;
  onUpdateBuyer: (patch: Partial<GuestBuyer>) => void;
  onSubmit: (e: React.FormEvent) => void;
  onSwitchToLogin?: () => void;
}

/**
 * 게스트 구매자 정보 입력 폼(form phase).
 * email 필수 · name/phone 선택 · 마케팅 수신동의 · 무료/유료 CTA.
 */
export function GuestBuyerForm({
  eventTitle,
  tierName,
  quantity,
  totalAmount,
  isFree,
  buyer,
  emailValid,
  canSubmit,
  processing,
  error,
  onUpdateBuyer,
  onSubmit,
  onSwitchToLogin,
}: GuestBuyerFormProps) {
  const t = useTranslations("guest.checkout");

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4 pt-2">
      {/* 주문 요약 */}
      <div className="rounded-xl bg-muted/60 border border-border p-3 space-y-1.5">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">{eventTitle}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">
            {tierName} × {quantity}
          </span>
          <span className="font-semibold text-foreground font-tabular">
            {isFree ? t("freeLabel") : formatKRW(totalAmount)}
          </span>
        </div>
      </div>

      {/* 이메일(필수) */}
      <div>
        <Label
          htmlFor="guest-email"
          className="flex items-center gap-1.5 mb-1.5 text-foreground"
        >
          <Mail className="h-3.5 w-3.5" /> {t("emailLabel")}
          <span className="text-red-600 dark:text-red-400">*</span>
        </Label>
        <Input
          id="guest-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          value={buyer.email}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            onUpdateBuyer({ email: e.target.value })
          }
          placeholder="you@pickket.kr"
          required
          aria-invalid={buyer.email.length > 0 && !emailValid}
          className="rounded-xl bg-card border-border focus:ring-2 focus:ring-primary/20"
        />
        <p className="mt-1 text-2xs text-muted-foreground">{t("emailHint")}</p>
      </div>

      {/* 이름(선택) */}
      <div>
        <Label
          htmlFor="guest-name"
          className="flex items-center gap-1.5 mb-1.5 text-foreground"
        >
          <User className="h-3.5 w-3.5" /> {t("nameLabel")}
          <span className="text-muted-foreground text-xs">{t("optional")}</span>
        </Label>
        <Input
          id="guest-name"
          type="text"
          autoComplete="name"
          value={buyer.name ?? ""}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            onUpdateBuyer({ name: e.target.value })
          }
          className="rounded-xl bg-card border-border focus:ring-2 focus:ring-primary/20"
        />
      </div>

      {/* 전화(선택) */}
      <div>
        <Label
          htmlFor="guest-phone"
          className="flex items-center gap-1.5 mb-1.5 text-foreground"
        >
          <Phone className="h-3.5 w-3.5" /> {t("phoneLabel")}
          <span className="text-muted-foreground text-xs">{t("optional")}</span>
        </Label>
        <Input
          id="guest-phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={buyer.phone ?? ""}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            onUpdateBuyer({ phone: e.target.value })
          }
          placeholder="010-1234-5678"
          className="rounded-xl bg-card border-border focus:ring-2 focus:ring-primary/20"
        />
      </div>

      {/* 마케팅 수신동의 */}
      <label className="flex items-start gap-2.5 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={buyer.marketing_opt_in}
          onChange={(e) => onUpdateBuyer({ marketing_opt_in: e.target.checked })}
          className="mt-0.5 size-4 rounded border-border text-primary focus:ring-primary/30"
        />
        <span className="text-xs text-muted-foreground">
          {t("marketingOptIn")}
        </span>
      </label>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      <Button
        type="submit"
        disabled={!canSubmit}
        className="w-full rounded-full bg-primary hover:brightness-110 text-white h-11 text-base"
      >
        {processing ? (
          <span className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("processing")}
          </span>
        ) : isFree ? (
          t("ctaFree")
        ) : (
          t("ctaPaid", { amount: formatKRW(totalAmount) })
        )}
      </Button>

      {onSwitchToLogin && (
        <p className="text-center text-sm text-muted-foreground">
          {t("preferLogin")}{" "}
          <button
            type="button"
            onClick={onSwitchToLogin}
            className="text-primary/70 font-medium hover:underline"
          >
            {t("loginInstead")}
          </button>
        </p>
      )}
    </form>
  );
}
