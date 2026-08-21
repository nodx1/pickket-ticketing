"use client";

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

// API 카테고리 계약과 일치(orders/sold_out/refunds/payment_failed/check_in/ai). 기본값 모두 on.
type NotificationCategory = "orders" | "sold_out" | "refunds" | "payment_failed" | "check_in" | "ai";

type NotificationPrefs = Record<NotificationCategory, boolean>;

const DEFAULT_PREFS: NotificationPrefs = {
  orders: true,
  sold_out: true,
  refunds: true,
  payment_failed: true,
  check_in: true,
  ai: true,
};

const CATEGORY_META: { key: NotificationCategory; label: string; description: string }[] = [
  { key: "orders", label: "주문", description: "새 주문이 접수되면 알림을 받습니다." },
  { key: "sold_out", label: "매진", description: "상품이 매진되면 알림을 받습니다." },
  { key: "refunds", label: "환불 요청", description: "환불 요청이 접수되면 알림을 받습니다." },
  { key: "payment_failed", label: "결제 실패", description: "주문의 결제가 실패하면 알림을 받습니다." },
  { key: "check_in", label: "체크인", description: "체크인이 주요 단계에 도달하면 알림을 받습니다." },
  { key: "ai", label: "AI 제안", description: "AI 에이전트의 제안·자동 적용 알림을 받습니다." },
];

export function NotificationPrefsCard() {
  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_PREFS);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [savingKey, setSavingKey] = useState<NotificationCategory | null>(null);

  useEffect(() => {
    let isMounted = true;
    async function load() {
      try {
        const response = await fetchWithRefresh("/api/account/notifications", { credentials: "include" });
        if (!response.ok) {
          throw new Error("load failed");
        }
        const payload = (await response.json()) as { data?: Partial<NotificationPrefs> };
        if (isMounted) {
          setPrefs({ ...DEFAULT_PREFS, ...(payload.data ?? {}) });
          setStatus("ready");
        }
      } catch {
        if (isMounted) {
          setStatus("error");
        }
      }
    }
    void load();
    return () => {
      isMounted = false;
    };
  }, []);

  async function toggle(key: NotificationCategory, next: boolean) {
    const previous = prefs[key];
    // 낙관적 업데이트 후 실패 시 되돌린다.
    setPrefs((prev) => ({ ...prev, [key]: next }));
    setSavingKey(key);
    try {
      const response = await fetchWithRefresh("/api/account/notifications", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: next }),
      });
      if (!response.ok) {
        throw new Error("save failed");
      }
      showSuccess("알림 설정이 저장되었습니다");
    } catch {
      setPrefs((prev) => ({ ...prev, [key]: previous }));
      showError("알림 설정 저장에 실패했습니다");
    } finally {
      setSavingKey(null);
    }
  }

  if (status === "loading") {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">알림 설정을 불러오는 중입니다...</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">알림 설정을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        인앱 알림 종류별로 수신 여부를 설정합니다. 시스템 알림은 항상 발송됩니다.
      </p>
      <div className="divide-y divide-border rounded-lg border border-border bg-card">
        {CATEGORY_META.map(({ key, label, description }) => (
          <div key={key} className="flex items-center justify-between gap-4 p-4">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-foreground">{label}</p>
              <p className="text-sm text-muted-foreground">{description}</p>
            </div>
            <Switch
              checked={prefs[key]}
              disabled={savingKey === key}
              onCheckedChange={(next) => void toggle(key, next)}
              aria-label={`${label} 알림`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
