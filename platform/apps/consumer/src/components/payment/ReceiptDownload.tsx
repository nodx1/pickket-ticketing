"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { Printer, Receipt, CheckCircle2 } from "lucide-react";
import { Button } from "@pickket/ui";
import { formatKRW, formatDateShort } from "@pickket/lib";
import api from "@pickket/lib/api";

interface ReceiptData {
  receipt_number: string;
  order_id: string;
  event_title: string;
  event_date: string | null;
  event_venue: string | null;
  tier_name: string | null;
  quantity: number;
  unit_price: number | null;
  total_amount: number;
  payment_method: string | null;
  status: string;
  buyer_name: string;
  buyer_email: string;
  paid_at: string;
  issued_at: string;
  company_name: string;
  company_registration: string;
}

interface ReceiptDownloadProps {
  orderId: string;
}

export default function ReceiptDownload({ orderId }: ReceiptDownloadProps) {
  const t = useTranslations("payment.receiptDownload");
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [loading, setLoading] = useState(false);
  const [showReceipt, setShowReceipt] = useState(false);

  const fetchReceipt = async () => {
    setLoading(true);
    try {
      const res = await api.get<ReceiptData>(`/orders/${orderId}/receipt`);
      setReceipt(res.data);
      setShowReceipt(true);
    } catch {
      // silent fail
    } finally {
      setLoading(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  if (!showReceipt) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={fetchReceipt}
        disabled={loading}
      >
        <Receipt className="h-4 w-4 mr-1.5" />
        {loading ? t("loading") : t("receiptButton")}
      </Button>
    );
  }

  return (
    <>
      {/* Screen version with print button */}
      <div className="print:hidden mb-4 flex gap-2">
        <Button variant="outline" size="sm" onClick={handlePrint}>
          <Printer className="h-4 w-4 mr-1.5" />
          {t("print")}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setShowReceipt(false)}>
          {t("close")}
        </Button>
      </div>

      {/* Receipt content - print-friendly */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="border rounded-xl p-6 bg-white dark:bg-card print:border-black print:shadow-none"
      >
        {/* Header */}
        <div className="text-center border-b pb-4 mb-4">
          <h2 className="text-xl font-bold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground mt-1">Receipt</p>
        </div>

        {/* Receipt Number */}
        <div className="flex justify-between items-center mb-4">
          <span className="text-sm text-muted-foreground">{t("receiptNumber")}</span>
          <span className="font-mono font-semibold">
            {receipt?.receipt_number}
          </span>
        </div>

        {/* Event Info */}
        <div className="bg-muted/50 rounded-lg p-4 mb-4 print:bg-gray-50">
          <h3 className="font-semibold mb-2">{receipt?.event_title}</h3>
          {receipt?.event_date && (
            <p className="text-sm text-muted-foreground">
              {t("eventDate", { date: formatDateShort(receipt.event_date) })}
            </p>
          )}
          {receipt?.event_venue && (
            <p className="text-sm text-muted-foreground">
              {t("eventVenue", { venue: receipt.event_venue })}
            </p>
          )}
          {receipt?.tier_name && (
            <p className="text-sm text-muted-foreground">
              {t("tierName", { tier: receipt.tier_name })}
            </p>
          )}
        </div>

        {/* Payment Details */}
        <div className="space-y-2 mb-4">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">{t("quantity")}</span>
            <span>{t("quantityValue", { count: receipt?.quantity ?? 0 })}</span>
          </div>
          {receipt?.unit_price && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{t("unitPrice")}</span>
              <span className="font-tabular">
                {formatKRW(receipt.unit_price)}
              </span>
            </div>
          )}
          <div className="flex justify-between font-semibold text-base border-t pt-2">
            <span>{t("totalAmount")}</span>
            <span className="text-primary font-tabular">
              {receipt ? formatKRW(receipt.total_amount) : "-"}
            </span>
          </div>
        </div>

        {/* Buyer Info */}
        <div className="border-t pt-4 space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("buyer")}</span>
            <span>{receipt?.buyer_name}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("email")}</span>
            <span>{receipt?.buyer_email}</span>
          </div>
          {receipt?.payment_method && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("paymentMethod")}</span>
              <span>{receipt.payment_method}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("paidAt")}</span>
            <span>
              {receipt?.paid_at ? formatDateShort(receipt.paid_at) : "-"}
            </span>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t mt-4 pt-4 text-center text-xs text-muted-foreground">
          <p>{receipt?.company_name}</p>
          <p>{t("businessRegistration", { number: receipt?.company_registration ?? "" })}</p>
          <div className="flex items-center justify-center gap-1 mt-2">
            <CheckCircle2 className="h-3 w-3 text-emerald-500" />
            <span>{t("issuedOk")}</span>
          </div>
        </div>
      </motion.div>
    </>
  );
}
