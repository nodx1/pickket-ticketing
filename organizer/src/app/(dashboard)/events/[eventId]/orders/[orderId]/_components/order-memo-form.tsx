"use client";

import { useState } from "react";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

interface OrderMemoFormProps {
  eventId: string;
  orderId: string;
  initialMemo: string;
}

export function OrderMemoForm({ eventId, orderId, initialMemo }: OrderMemoFormProps) {
  const [memo, setMemo] = useState(initialMemo);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setMessage(null);

    try {
      const response = await fetchWithRefresh(`/api/events/${eventId}/orders/${orderId}`, {
        method: "PATCH",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ memo }),
      });

      if (response.ok) {
        setMessage("메모를 저장했습니다.");
      } else {
        const payload = (await response.json()) as { error?: string };
        setMessage(payload.error ?? "메모 저장에 실패했습니다.");
      }
    } catch {
      setMessage("메모 저장 중 오류가 발생했습니다.");
    }

    setSaving(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">메모</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Textarea rows={5} value={memo} onChange={(event) => setMemo(event.target.value)} />
        {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
        <div className="flex justify-end">
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? "저장 중..." : "메모 저장"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
