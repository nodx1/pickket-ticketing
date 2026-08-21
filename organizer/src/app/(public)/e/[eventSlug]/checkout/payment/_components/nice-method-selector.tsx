"use client";

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  type NiceMethod,
  NICE_METHOD_LABELS,
} from "@/lib/payment/nice-methods";

interface NiceMethodSelectorProps {
  /** 노출할 결제수단 목록(카드전용 게이팅 시 [card]). */
  methods: readonly NiceMethod[];
  value: NiceMethod;
  onChange: (method: NiceMethod) => void;
}

/**
 * 나이스페이(구형) 결제수단 선택 — 선택값은 prepare 요청의 pay_method 로 서버에 전달된다
 * (서버가 payForm.PayMethod 로 정규화 주입 — consumer 와 동일 계약).
 * 라이트모드 시맨틱 토큰만 사용(하드코딩 색상 금지). 모바일 우선 1열 → sm 2열.
 */
export function NiceMethodSelector({ methods, value, onChange }: NiceMethodSelectorProps) {
  return (
    <div className="space-y-3 rounded-lg border border-primary/20 bg-primary/10 px-4 py-4 text-sm text-muted-foreground">
      <p className="font-semibold text-foreground">나이스페이 결제수단</p>
      <RadioGroup
        value={value}
        onValueChange={(v: NiceMethod) => onChange(v)}
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
      >
        {methods.map((method) => (
          <label
            key={method}
            className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
              value === method
                ? "border-primary bg-background text-foreground"
                : "border-border bg-background/60 text-muted-foreground hover:border-primary/40"
            }`}
          >
            <RadioGroupItem value={method} />
            {NICE_METHOD_LABELS[method]}
          </label>
        ))}
      </RadioGroup>
      <p className="text-xs">
        결제 진행 버튼을 누르면 선택하신 수단으로 나이스페이 결제창이 열립니다. 결제 완료 후 자동으로 예약이 확정됩니다.
      </p>
    </div>
  );
}
