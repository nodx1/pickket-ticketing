"use client";

import { useTranslations } from "next-intl";
import {
  type NicePayMethod,
  NICE_METHOD_LABEL_KEYS,
} from "@/lib/nicepay-methods";

interface NicePayMethodSelectorProps {
  /** 노출할 결제수단 목록(카드전용 게이팅 시 [CARD]). */
  methods: readonly NicePayMethod[];
  /** 현재 선택된 수단. */
  value: NicePayMethod;
  onChange: (method: NicePayMethod) => void;
  /** 결제 진행 중 등 선택 잠금. */
  disabled?: boolean;
}

/**
 * 나이스페이 결제수단 선택(카드/간편결제/계좌이체/가상계좌/휴대폰).
 * 선택값은 상위에서 prepare 요청의 pay_method 로 전달된다(토스는 위젯이 담당 — 미노출).
 * 라이트/다크 공용 시맨틱 토큰만 사용(하드코드 색상 금지).
 */
export function NicePayMethodSelector({
  methods,
  value,
  onChange,
  disabled,
}: NicePayMethodSelectorProps) {
  const t = useTranslations("payment");

  return (
    <fieldset
      className="grid grid-cols-1 sm:grid-cols-2 gap-2"
      aria-label={t("pay_method")}
      disabled={disabled}
    >
      {methods.map((method) => {
        const selected = method === value;
        return (
          <label
            key={method}
            className={[
              "flex items-center gap-2.5 rounded-xl border p-3 text-sm transition-colors",
              disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
              selected
                ? "border-primary bg-primary/5 text-foreground"
                : "border-border bg-muted/40 text-muted-foreground hover:border-primary/40",
            ].join(" ")}
          >
            <input
              type="radio"
              name="nice-pay-method"
              value={method}
              checked={selected}
              onChange={() => onChange(method)}
              disabled={disabled}
              className="size-4 shrink-0 accent-primary"
            />
            <span className="font-medium">
              {t(NICE_METHOD_LABEL_KEYS[method])}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
