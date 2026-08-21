"use client";

import { Pencil, XCircle } from "lucide-react";
import { useConfirmAction } from "@/lib/hooks/useConfirmAction";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ATTENDEE_STATUS_LABELS } from "@/lib/constants";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

interface AttendeeRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  ticketNumber: string;
  status: string;
}

interface OrderAttendeesManagerProps {
  eventId: string;
  orderId: string;
  attendees: AttendeeRow[];
}

export function OrderAttendeesManager({ eventId, orderId, attendees }: OrderAttendeesManagerProps) {
  const router = useRouter();
  const [selected, setSelected] = useState<AttendeeRow | null>(null);
  const [form, setForm] = useState({ name: "", email: "", phone: "" });
  const [cancelTarget, setCancelTarget] = useState<AttendeeRow | null>(null);
  const [cancelling, setCancelling] = useState(false);

  async function cancelTicket() {
    if (!cancelTarget) {
      return;
    }
    setCancelling(true);
    try {
      const response = await fetchWithRefresh(`/api/events/${eventId}/orders/${orderId}/modify`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "cancel_item", attendeeId: cancelTarget.id }),
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error ?? "티켓 취소에 실패했습니다");
      }
      showSuccess("티켓이 취소되고 환불 처리되었습니다");
      router.refresh();
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "티켓 취소에 실패했습니다");
    } finally {
      setCancelling(false);
      setCancelTarget(null);
    }
  }

  function openEditor(attendee: AttendeeRow) {
    setSelected(attendee);
    setForm({
      name: attendee.name,
      email: attendee.email ?? "",
      phone: attendee.phone ?? "",
    });
  }

  async function save() {
    if (!selected) {
      return;
    }

    try {
      const response = await fetchWithRefresh(`/api/events/${eventId}/orders/${orderId}/modify`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "update_attendee",
          attendeeId: selected.id,
          ...form,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error ?? "참석자 수정에 실패했습니다");
      }

      showSuccess("참석자 정보가 수정되었습니다");
      router.refresh();
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "참석자 수정에 실패했습니다");
    }
  }

  // 확인 버튼 잠금 + 재진입 차단 + 실패 시 해제 (S3). `cancelTicket` 이 창을 닫는다.
  const cancelAction = useConfirmAction(() => cancelTicket());

  return (
    <>
      <div className="space-y-3">
        {attendees.map((attendee) => (
          <div key={attendee.id} className="grid gap-2 rounded-lg border border-border bg-muted px-4 py-3 text-sm lg:grid-cols-[1fr_1fr_1fr_1fr_auto]">
            <p className="font-medium text-foreground">{attendee.name}</p>
            <p className="text-content-subtle">{attendee.email ?? "-"}</p>
            <p className="text-content-subtle">{attendee.ticketNumber}</p>
            <p className="text-content-subtle">{ATTENDEE_STATUS_LABELS[attendee.status] ?? attendee.status}</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => openEditor(attendee)} disabled={attendee.status === "cancelled"}>
                <Pencil className="size-4" />
                수정
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCancelTarget(attendee)}
                disabled={attendee.status === "cancelled" || attendee.status === "checked_in"}
              >
                <XCircle className="size-4" />
                {attendee.status === "cancelled" ? "취소됨" : "취소"}
              </Button>
            </div>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={Boolean(cancelTarget)}
        title="이 티켓을 취소하시겠습니까?"
        description="해당 티켓이 취소되고 재고가 복구되며, 취소 정책에 따라 부분 환불이 처리됩니다."
        confirmText={cancelling ? "취소 중..." : "티켓 취소"}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null);
        }}
        pending={cancelAction.pending}
        onConfirm={cancelAction.run}
      />

      <Dialog open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>참석자 정보 수정</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <Input value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} placeholder="이름" />
            <Input value={form.email} onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))} placeholder="이메일" />
            <Input value={form.phone} onChange={(event) => setForm((prev) => ({ ...prev, phone: event.target.value }))} placeholder="전화번호" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelected(null)}>닫기</Button>
            <Button onClick={() => void save()}>저장</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
