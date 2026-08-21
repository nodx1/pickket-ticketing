"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";

import api from "@pickket/lib/api";
import { Button } from "@pickket/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@pickket/ui";
import { Input } from "@pickket/ui";

import TransferTimeline from "./TransferTimeline";

type TransferStatus =
  | "initiated"
  | "identity_verified"
  | "completed"
  | "cancelled";

interface TransferFlowProps {
  open: boolean;
  transferId: string;
  onClose: () => void;
  onCompleted?: () => void;
}

export default function TransferFlow({
  open,
  transferId,
  onClose,
  onCompleted,
}: TransferFlowProps) {
  const [status, setStatus] = useState<TransferStatus>("initiated");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codeSent, setCodeSent] = useState(false);

  const t = useTranslations("transfer.flow");
  const canVerify = useMemo(() => code.trim().length === 6, [code]);

  const withLoading = async (fn: () => Promise<void>) => {
    setLoading(true);
    setError(null);
    try {
      await fn();
    } catch (e: unknown) {
      const message =
        (e as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ||
        (e instanceof Error ? e.message : t("errorGeneric"));
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const sendCode = () =>
    withLoading(async () => {
      await api.post(`/transfers/${transferId}/send-code`);
      setCodeSent(true);
      setStatus("initiated");
    });

  const verifyCode = () =>
    withLoading(async () => {
      const res = await api.post(`/transfers/${transferId}/verify`, {
        code: code.trim(),
      });
      const next =
        (res.data?.status as TransferStatus | undefined) || "identity_verified";
      setStatus(next);
    });

  const completeTransfer = () =>
    withLoading(async () => {
      const res = await api.post(`/transfers/${transferId}/complete`);
      const next =
        (res.data?.status as TransferStatus | undefined) || "completed";
      setStatus(next);
      if (next === "completed") {
        onCompleted?.();
      }
    });

  const cancelTransfer = () =>
    withLoading(async () => {
      const res = await api.post(`/transfers/${transferId}/cancel`);
      const next =
        (res.data?.status as TransferStatus | undefined) || "cancelled";
      setStatus(next);
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription className="sr-only">
            {t("description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <TransferTimeline status={status} />

          {status !== "cancelled" && status !== "completed" && (
            <div className="space-y-2">
              <Button
                onClick={sendCode}
                disabled={loading}
                className="w-full rounded-full"
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  t("sendCode")
                )}
              </Button>

              <Input
                value={code}
                onChange={(e) =>
                  setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                placeholder={t("codePlaceholder")}
                inputMode="numeric"
              />

              <Button
                variant="outline"
                onClick={verifyCode}
                disabled={loading || !canVerify || !codeSent}
                className="w-full rounded-full"
              >
                {t("verifyCode")}
              </Button>

              <Button
                onClick={completeTransfer}
                disabled={loading || status !== "identity_verified"}
                className="w-full rounded-full"
              >
                {t("complete")}
              </Button>
            </div>
          )}

          {status === "completed" && (
            <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              {t("completedMessage")}
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          <Button
            variant="ghost"
            onClick={cancelTransfer}
            disabled={
              loading || status === "completed" || status === "cancelled"
            }
            className="w-full text-red-600 dark:text-red-400 hover:text-red-700"
          >
            {t("cancel")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
