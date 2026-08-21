"use client";

import { useEffect, useState } from "react";
import { useConfirmAction } from "@/lib/hooks/useConfirmAction";
import { KeyRound, Pencil, ScrollText, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { WebhookDetailDrawer } from "./webhook-detail-drawer";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

const AVAILABLE_EVENTS = [
  "order.created",
  "order.completed",
  "order.refunded",
  "attendee.checked_in",
  "event.updated",
];

interface WebhookRow {
  id: string;
  name: string;
  endpointUrl: string;
  signingSecret: string;
  status: string;
  subscribedEvents: string[];
}

export function WebhooksClient({ eventId }: { eventId: string }) {
  const [items, setItems] = useState<WebhookRow[]>([]);
  const [form, setForm] = useState({
    name: "",
    endpointUrl: "",
    subscribedEvents: ["order.completed"],
  });
  const [editing, setEditing] = useState<WebhookRow | null>(null);
  const [editForm, setEditForm] = useState({
    name: "",
    endpointUrl: "",
    subscribedEvents: [] as string[],
    status: "active",
  });
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // 생성/재발급 순간에만 서버가 반환하는 원본 시크릿. 모달로 1회 노출 후 폐기(다시 볼 수 없음).
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  // 배송 로그 드로어 대상 웹훅 id (null = 닫힘).
  const [logWebhookId, setLogWebhookId] = useState<string | null>(null);

  async function load() {
    const response = await fetchWithRefresh(`/api/events/${eventId}/webhooks`, { credentials: "include" });
    const payload = (await response.json()) as { data?: WebhookRow[] };
    setItems(payload.data ?? []);
  }

  useEffect(() => {
    let isMounted = true;
    async function init() {
      const response = await fetchWithRefresh(`/api/events/${eventId}/webhooks`, { credentials: "include" });
      const payload = (await response.json()) as { data?: WebhookRow[] };
      if (isMounted) {
        setItems(payload.data ?? []);
      }
    }
    void init();
    return () => {
      isMounted = false;
    };
  }, [eventId]);

  async function createWebhook() {
    const response = await fetchWithRefresh(`/api/events/${eventId}/webhooks`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (response.ok) {
      const payload = (await response.json()) as { data?: { signingSecret?: string } };
      await load();
      setForm({ name: "", endpointUrl: "", subscribedEvents: ["order.completed"] });
      // 서명 시크릿은 생성 응답에서만 노출 — 즉시 모달로 1회 표시.
      if (payload.data?.signingSecret) {
        setRevealedSecret(payload.data.signingSecret);
      }
      showSuccess("웹훅이 추가되었습니다");
    } else {
      showError("웹훅 추가에 실패했습니다");
    }
  }

  async function regenerateSecret() {
    if (!regeneratingId) return;
    const targetId = regeneratingId;
    setRegeneratingId(null);
    const response = await fetchWithRefresh(`/api/events/${eventId}/webhooks/${targetId}/regenerate`, {
      method: "POST",
      credentials: "include",
    });
    if (!response.ok) {
      showError("시크릿 재발급에 실패했습니다");
      return;
    }
    const payload = (await response.json()) as { data?: { signingSecret?: string } };
    await load();
    if (payload.data?.signingSecret) {
      setRevealedSecret(payload.data.signingSecret);
    }
    showSuccess("서명 시크릿을 재발급했습니다");
  }

  async function copySecret(secret: string) {
    try {
      await navigator.clipboard.writeText(secret);
      showSuccess("시크릿을 복사했습니다");
    } catch {
      showError("복사에 실패했습니다. 직접 선택해 복사해주세요.");
    }
  }

  function openEdit(row: WebhookRow) {
    setEditing(row);
    setEditForm({
      name: row.name,
      endpointUrl: row.endpointUrl,
      subscribedEvents: [...row.subscribedEvents],
      status: row.status,
    });
  }

  async function saveEdit() {
    if (!editing) return;
    const response = await fetchWithRefresh(`/api/events/${eventId}/webhooks/${editing.id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: editForm.name,
        endpointUrl: editForm.endpointUrl,
        subscribedEvents: editForm.subscribedEvents,
        status: editForm.status,
      }),
    });
    setEditing(null);
    if (!response.ok) {
      showError("웹훅 수정에 실패했습니다");
      return;
    }
    await load();
    showSuccess("웹훅이 수정되었습니다");
  }

  async function deleteWebhook() {
    if (!deletingId) return;
    const response = await fetchWithRefresh(`/api/events/${eventId}/webhooks/${deletingId}`, {
      method: "DELETE",
      credentials: "include",
    });
    setDeletingId(null);
    if (!response.ok) {
      showError("웹훅 삭제에 실패했습니다");
      return;
    }
    await load();
    showSuccess("웹훅이 삭제되었습니다");
  }

  // 확인 버튼 잠금 + 재진입 차단 + 실패 시 해제 (S3). `deleteWebhook` 이 창을 닫는다.
  const deleteAction = useConfirmAction(() => deleteWebhook());
  // 확인 버튼 잠금 + 재진입 차단 + 실패 시 해제 (S3). `regenerateSecret` 이 창을 닫는다.
  const regenerateAction = useConfirmAction(() => regenerateSecret());

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-black tracking-[-0.04em] text-foreground">웹훅</h2>
        <p className="mt-2 text-sm text-muted-foreground">주문, 환불, 체크인 이벤트를 외부 시스템으로 전달합니다.</p>
      </div>

      <Card className="border-border bg-card/95">
        <CardHeader>
          <CardTitle className="text-foreground">웹훅 추가</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 lg:grid-cols-2">
            <Input placeholder="이름" value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} />
            <Input type="url" inputMode="url" spellCheck={false} placeholder="https://example.com/webhook" value={form.endpointUrl} onChange={(event) => setForm((prev) => ({ ...prev, endpointUrl: event.target.value }))} />
          </div>
          <div className="grid gap-3 lg:grid-cols-3">
            {AVAILABLE_EVENTS.map((item) => (
              <label key={item} className="flex items-center gap-3 rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
                <Checkbox
                  checked={form.subscribedEvents.includes(item)}
                  onCheckedChange={(checked) =>
                    setForm((prev) => ({
                      ...prev,
                      subscribedEvents: checked === true
                        ? [...prev.subscribedEvents, item]
                        : prev.subscribedEvents.filter((entry) => entry !== item),
                    }))
                  }
                />
                {item}
              </label>
            ))}
          </div>
          <Button onClick={() => void createWebhook()}>웹훅 추가</Button>
        </CardContent>
      </Card>

      <div className="grid gap-4">
        {items.map((item) => (
          <Card key={item.id} className="border-border bg-card/95">
            <CardHeader className="flex-row items-start justify-between gap-4">
              <CardTitle className="text-foreground">{item.name}</CardTitle>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="icon" aria-label="배송 로그" onClick={() => setLogWebhookId(item.id)}>
                  <ScrollText className="size-4" />
                </Button>
                <Button variant="outline" size="icon" aria-label="서명 시크릿 재발급" onClick={() => setRegeneratingId(item.id)}>
                  <KeyRound className="size-4" />
                </Button>
                <Button variant="outline" size="icon" aria-label="웹훅 수정" onClick={() => openEdit(item)}>
                  <Pencil className="size-4" />
                </Button>
                <Button variant="outline" size="icon" aria-label="웹훅 삭제" onClick={() => setDeletingId(item.id)}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>URL: {item.endpointUrl}</p>
              <p>이벤트: {item.subscribedEvents.join(", ")}</p>
              <p>시크릿: {item.signingSecret.slice(0, 8)}...</p>
              <p>상태: {item.status === "active" ? "활성" : "비활성"}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={editing !== null} onOpenChange={() => setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>웹훅 수정</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-webhook-name">이름</Label>
              <Input id="edit-webhook-name" value={editForm.name} onChange={(event) => setEditForm((prev) => ({ ...prev, name: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-webhook-url">엔드포인트 URL</Label>
              <Input id="edit-webhook-url" type="url" inputMode="url" spellCheck={false} value={editForm.endpointUrl} onChange={(event) => setEditForm((prev) => ({ ...prev, endpointUrl: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label>구독 이벤트</Label>
              <div className="grid gap-2 lg:grid-cols-2">
                {AVAILABLE_EVENTS.map((item) => (
                  <label key={item} className="flex items-center gap-3 rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
                    <Checkbox
                      checked={editForm.subscribedEvents.includes(item)}
                      onCheckedChange={(checked) =>
                        setEditForm((prev) => ({
                          ...prev,
                          subscribedEvents: checked === true
                            ? [...prev.subscribedEvents, item]
                            : prev.subscribedEvents.filter((entry) => entry !== item),
                        }))
                      }
                    />
                    {item}
                  </label>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label>상태</Label>
              <Select value={editForm.status} onValueChange={(value) => setEditForm((prev) => ({ ...prev, status: value }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">활성</SelectItem>
                  <SelectItem value="disabled">비활성</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>취소</Button>
            <Button onClick={() => void saveEdit()}>저장</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deletingId !== null}
        title="웹훅 삭제"
        description="이 웹훅을 삭제하시겠습니까? 이후 이벤트 알림이 발송되지 않습니다."
        confirmText="삭제"
        pending={deleteAction.pending}
        onConfirm={deleteAction.run}
        onOpenChange={() => setDeletingId(null)}
      />

      <ConfirmDialog
        open={regeneratingId !== null}
        title="서명 시크릿 재발급"
        description="재발급하면 기존 시크릿으로 서명하던 수신 시스템의 검증이 즉시 중단됩니다. 새 시크릿을 수신 시스템에 반영해야 합니다. 계속하시겠습니까?"
        confirmText="재발급"
        pending={regenerateAction.pending}
        onConfirm={regenerateAction.run}
        onOpenChange={(open) => { if (!open) setRegeneratingId(null); }}
      />

      <Dialog open={revealedSecret !== null} onOpenChange={(open) => { if (!open) setRevealedSecret(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>서명 시크릿</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-warning">
              이 시크릿은 지금 한 번만 표시됩니다. 창을 닫으면 다시 볼 수 없으니 안전한 곳에 저장하세요.
            </p>
            <code className="block break-all rounded-lg border border-border bg-muted px-4 py-3 font-mono text-sm text-foreground">
              {revealedSecret}
            </code>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => revealedSecret && void copySecret(revealedSecret)}>복사</Button>
            <Button onClick={() => setRevealedSecret(null)}>확인</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <WebhookDetailDrawer eventId={eventId} webhookId={logWebhookId} onClose={() => setLogWebhookId(null)} />
    </div>
  );
}
