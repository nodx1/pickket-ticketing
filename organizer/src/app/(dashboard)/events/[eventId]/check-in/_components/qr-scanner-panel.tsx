"use client";

import { useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface QrScannerPanelProps {
  // 스캐너가 디코드한 원문(PKT:id:ts:hmac). 서버가 PKT 만 수락(캡처방지) — 검증은 서버에서.
  onScan: (scanPayload: string) => void;
}

export function QrScannerPanel({ onScan }: QrScannerPanelProps) {
  const containerId = useRef(`qr-reader-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    let mounted = true;
    let scannerInstance: { render: (onSuccess: (decodedText: string) => void, onError: (errorMessage: string) => void) => void; clear: () => Promise<void> } | null = null;

    async function setup() {
      const qrModule = await import("html5-qrcode");
      if (!mounted) {
        return;
      }

      const Scanner = qrModule.Html5QrcodeScanner;
      scannerInstance = new Scanner(containerId.current, { fps: 10, qrbox: 250 }, false);
      scannerInstance.render(
        (decodedText: string) => {
          onScan(decodedText);
        },
        () => undefined,
      );
    }

    void setup();

    return () => {
      mounted = false;
      if (scannerInstance) {
        void scannerInstance.clear().catch(() => undefined);
      }
    };
  }, [onScan]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">QR 스캐너</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          회전 QR(30초 갱신)만 인식됩니다. 스크린샷·정적 QR은 사용할 수 없습니다.
        </p>
        <div id={containerId.current} className="overflow-hidden rounded-lg border border-border bg-black/30 p-4" />
      </CardContent>
    </Card>
  );
}
