"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@pickket/ui";
import { Heart, TrendingUp, Users, ArrowRight, Shield } from "lucide-react";
import { formatKRW } from "@pickket/lib";
import { useTranslations } from "next-intl";

interface TransferChoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticketTitle: string;
  tierName: string;
  facePrice: number;
  waitlistCount: number;
  maxMarkupPct?: number;
  onFaceValueTransfer: () => void;
  onResaleListing: () => void;
  onPeerTransfer: () => void;
}

export default function TransferChoiceDialog({
  open,
  onOpenChange,
  ticketTitle,
  tierName,
  facePrice,
  waitlistCount,
  maxMarkupPct,
  onFaceValueTransfer,
  onResaleListing,
  onPeerTransfer,
}: TransferChoiceDialogProps) {
  const t = useTranslations("waitlist.transferChoiceDialog");
  const priceCap = maxMarkupPct
    ? Math.round(facePrice * (1 + maxMarkupPct / 100))
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 gap-0 rounded-2xl overflow-hidden">
        {/* Header */}
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle className="text-lg font-bold">
            {t("title")}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground mt-1">
            {ticketTitle} · {tierName}
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 pb-6 space-y-3">
          {/* Option 1: Face value transfer (recommended) */}
          <button
            onClick={() => {
              onOpenChange(false);
              onFaceValueTransfer();
            }}
            className="w-full text-left rounded-xl border-2 border-emerald-200 bg-emerald-50/50 hover:bg-emerald-50 p-4 transition-all group"
          >
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-xl bg-emerald-100 flex items-center justify-center shrink-0">
                <Heart className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-bold text-emerald-800">
                    {t("faceValue.label")}
                  </h3>
                  <span className="text-2xs bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full font-medium">
                    {t("faceValue.badge")}
                  </span>
                </div>
                <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-0.5 font-tabular">
                  {formatKRW(facePrice)} · {t("faceValue.zeroFee")}
                </p>
                {waitlistCount > 0 && (
                  <p className="text-xs text-emerald-500 mt-1 flex items-center gap-1">
                    <Users className="h-3 w-3" />
                    {t("faceValue.waitlistMatch", { count: waitlistCount ?? 0 })}
                  </p>
                )}
              </div>
              <ArrowRight className="h-4 w-4 text-emerald-400 group-hover:text-emerald-600 dark:text-emerald-400 transition-colors mt-1" />
            </div>
          </button>

          {/* Option 2: Resale market */}
          <button
            onClick={() => {
              onOpenChange(false);
              onResaleListing();
            }}
            className="w-full text-left rounded-xl border border-border bg-card hover:bg-muted p-4 transition-all group"
          >
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                <TrendingUp className="h-5 w-5 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-bold text-foreground">
                  {t("resale.label")}
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5 font-tabular">
                  {t("resale.setPriceDesc")}
                  {priceCap && ` (${t("resale.priceCap", { cap: formatKRW(priceCap) })})`}
                </p>
                <p className="text-xs text-muted-foreground/70 mt-1">
                  {t("resale.artistShare")}
                </p>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-muted-foreground transition-colors mt-1" />
            </div>
          </button>

          {/* Option 3: Peer transfer */}
          <button
            onClick={() => {
              onOpenChange(false);
              onPeerTransfer();
            }}
            className="w-full text-left rounded-xl border border-border bg-card hover:bg-muted p-4 transition-all group"
          >
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-xl bg-violet-100 flex items-center justify-center shrink-0">
                <Shield className="h-5 w-5 text-violet-600 dark:text-violet-400" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-bold text-foreground">{t("peer.label")}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t("peer.desc")}
                </p>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-muted-foreground transition-colors mt-1" />
            </div>
          </button>

          {/* Compliance note */}
          <p className="text-2xs text-muted-foreground/60 text-center pt-1">
            {t("complianceNote")}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
