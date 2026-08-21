"use client";

import { useEffect, useState } from "react";
import { useConfirmAction } from "@/lib/hooks/useConfirmAction";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { DataTable } from "@/components/shared/data-table";
import { Button } from "@/components/ui/button";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { WAITLIST_STATUS_LABELS } from "@/lib/constants";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

interface WaitlistRow extends Record<string, string | number | boolean | null> {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: string;
  productName: string;
}

export function EventWaitlistClient({ eventId }: { eventId: string }) {
  const [items, setItems] = useState<WaitlistRow[]>([]);
  const [offeringId, setOfferingId] = useState<string | null>(null);
  useEffect(() => {
    let isMounted = true;
    async function load() {
      const response = await fetchWithRefresh(`/api/events/${eventId}/waitlist`, { credentials: "include" });
      const payload = (await response.json()) as { data?: WaitlistRow[] };
      if (isMounted) setItems(payload.data ?? []);
    }
    void load();
    return () => {
      isMounted = false;
    };
  }, [eventId]);

  async function offer(id: string) {
    try {
      const res = await fetchWithRefresh(`/api/events/${eventId}/waitlist/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "offered" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? "제안에 실패했습니다");
      }
      showSuccess("구매 제안이 완료되었습니다");
      // Refresh the list
      const response = await fetchWithRefresh(`/api/events/${eventId}/waitlist`, { credentials: "include" });
      const payload = (await response.json()) as { data?: WaitlistRow[] };
      setItems(payload.data ?? []);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "제안에 실패했습니다");
    }
  }

  // 확인 버튼 잠금 + 재진입 차단 + 실패 시 해제 (S3).
  // 종전엔 `void fn(); setTarget(null)` 라 **요청이 끝나기 전에 창이 닫혔다** —
  // 그 상태로 pending 을 넘겨봐야 보이지도 않는다. 끝난 뒤 닫도록 바꿨다.
  const offerAction = useConfirmAction(async () => {
    if (!offeringId) return;
    await offer(offeringId);
    setOfferingId(null);
  });

  return (
    <div className="space-y-6">
      <h2 className="text-3xl font-black tracking-[-0.04em] text-foreground">대기열</h2>
      <DataTable
        data={items}
        columns={[
          { key: "name", label: "이름" },
          { key: "email", label: "이메일" },
          { key: "productName", label: "상품" },
          { key: "status", label: "상태", render: (row) => WAITLIST_STATUS_LABELS[String(row.status)] ?? row.status },
          { key: "id", label: "작업", render: (row) => <Button variant="outline" onClick={() => setOfferingId(row.id)}>구매 제안</Button> },
        ]}
      />
      <ConfirmDialog
        open={offeringId !== null}
        title="구매 제안"
        description="이 대기자에게 구매 제안을 보내시겠습니까?"
        confirmText="제안하기"
        pending={offerAction.pending}
        onConfirm={offerAction.run}
        onOpenChange={(open) => { if (!open) setOfferingId(null); }}
      />
    </div>
  );
}
