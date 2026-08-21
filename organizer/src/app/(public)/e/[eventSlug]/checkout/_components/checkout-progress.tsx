"use client";

import { useEffect } from "react";
import { Check } from "lucide-react";
import { useCheckoutStore } from "@/lib/stores/checkoutStore";

const STEPS = [
  { label: "티켓 선택", step: 1 },
  { label: "정보 입력", step: 2 },
  { label: "결제", step: 3 },
  { label: "완료", step: 4 },
];

export function CheckoutProgress({ current }: { current: 1 | 2 | 3 | 4 }) {
  // sessionStorage persist 수동 rehydrate — 모든 체크아웃 단계가 이 컴포넌트를 렌더하므로
  // 여기 한 곳에서 복원한다(skipHydration: SSR 미스매치 방지).
  useEffect(() => {
    void useCheckoutStore.persist.rehydrate();
  }, []);

  return (
    <div className="mx-auto max-w-2xl px-4">
      <div className="flex items-center justify-between">
        {STEPS.map((s, i) => (
          <div key={s.step} className="flex items-center">
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={`flex size-9 items-center justify-center rounded-full text-sm font-bold transition ${
                  s.step < current
                    ? "bg-success text-success-foreground"
                    : s.step === current
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted/40 text-muted-foreground"
                }`}
              >
                {s.step < current ? <Check className="size-4" /> : s.step}
              </div>
              <span
                className={`text-xs ${
                  s.step <= current ? "font-semibold text-foreground" : "text-muted-foreground"
                }`}
              >
                {s.label}
              </span>
            </div>
            {i < STEPS.length - 1 ? (
              <div
                className={`mx-2 hidden h-0.5 w-12 sm:block lg:w-20 ${
                  s.step < current ? "bg-success" : "bg-muted/40"
                }`}
              />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
