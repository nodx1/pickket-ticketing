"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { showError, showSuccess, showWarning } from "@/lib/hooks/useToast";
import { DrawForm } from "./draw-form";
import { DrawConfirmDialog } from "./draw-confirm-dialog";
import { DrawResult } from "./draw-result";
import { DrawHistory } from "./draw-history";
import type { RaffleDraw } from "./types";

type DrawEnvelope = { success: boolean; data?: RaffleDraw; error?: string };
type DrawsEnvelope = { success: boolean; data?: { draws: RaffleDraw[] }; error?: string };

export function RaffleClient({ eventId }: { eventId: string }) {
  const [seed, setSeed] = useState("");
  const [count, setCount] = useState("");
  const [drawKey, setDrawKey] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [lastDraw, setLastDraw] = useState<RaffleDraw | null>(null);
  const [history, setHistory] = useState<RaffleDraw[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const payload = await fetchWithAuth<DrawsEnvelope>(`/api/events/${eventId}/raffle/draws`, {
        redirectOnUnauthorized: false,
      });
      setHistory(payload.data?.draws ?? []);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "추첨 이력을 불러오지 못했습니다");
    } finally {
      setHistoryLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  // "추첨 실행" 클릭 → 이중추첨 방지 확인 다이얼로그 게이트.
  function requestDraw() {
    const parsedCount = Number(count);
    if (!seed.trim()) {
      showWarning("공개 시드를 입력해주세요");
      return;
    }
    if (!Number.isInteger(parsedCount) || parsedCount < 1) {
      showWarning("당첨 수는 1 이상의 정수여야 합니다");
      return;
    }
    setConfirmOpen(true);
  }

  async function confirmDraw() {
    const parsedCount = Number(count);
    setDrawing(true);
    try {
      const payload = await fetchWithAuth<DrawEnvelope>(`/api/events/${eventId}/raffle/draw`, {
        method: "POST",
        body: JSON.stringify({
          seed: seed.trim(),
          count: parsedCount,
          ...(drawKey.trim() ? { drawKey: drawKey.trim() } : {}),
        }),
        redirectOnUnauthorized: false,
      });
      if (!payload.success || !payload.data) {
        throw new Error(payload.error ?? "추첨에 실패했습니다");
      }
      setLastDraw(payload.data);
      setConfirmOpen(false);
      showSuccess(`추첨 완료 · 당첨 ${payload.data.winningNumbers.length}건`);
      await loadHistory();
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "추첨에 실패했습니다");
    } finally {
      setDrawing(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-content-subtle">현장 운영</p>
        <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">경품 추첨</h2>
        <p className="mt-2 text-sm text-content-subtle">
          체크인 완료자를 대상으로 공개 시드 기반 추첨을 실행합니다. 같은 시드는 같은 결과를 재현합니다.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_0.9fr]">
        <div className="space-y-6">
          <DrawForm
            seed={seed}
            count={count}
            drawKey={drawKey}
            drawing={drawing}
            onSeedChange={setSeed}
            onCountChange={setCount}
            onDrawKeyChange={setDrawKey}
            onSubmit={requestDraw}
          />
          {lastDraw ? <DrawResult draw={lastDraw} /> : null}
        </div>
        <DrawHistory draws={history} loading={historyLoading} />
      </div>

      <DrawConfirmDialog
        open={confirmOpen}
        seed={seed.trim()}
        count={Number(count) || 0}
        drawKey={drawKey}
        drawing={drawing}
        onConfirm={() => void confirmDraw()}
        onOpenChange={setConfirmOpen}
      />
    </div>
  );
}
