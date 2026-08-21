"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Camera, RefreshCw, Smartphone } from "lucide-react";

import { Button } from "./button";

interface CameraDevice {
  id: string;
  label: string;
}

export interface QrScannerProps {
  onScan: (data: string) => void;
  onError: (error: string) => void;
}

export function QrScanner({ onScan, onError }: QrScannerProps) {
  const elementId = useId().replace(/:/g, "");
  const scannerRef = useRef<any>(null);
  const restartTimerRef = useRef<number | null>(null);
  const [cameras, setCameras] = useState<CameraDevice[]>([]);
  const [activeCameraId, setActiveCameraId] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    async function loadCameras() {
      try {
        const { Html5Qrcode } = await import("html5-qrcode");
        const devices = await Html5Qrcode.getCameras();
        if (!mounted) return;

        const normalized = devices.map(
          (device: { id: string; label: string }) => ({
            id: device.id,
            label: device.label || "카메라",
          }),
        );
        setCameras(normalized);
        if (normalized.length > 0) {
          const preferred =
            normalized.find((device) =>
              /back|rear|후면|environment/i.test(device.label),
            ) ?? normalized[0];
          setActiveCameraId(preferred.id);
        }
      } catch (error) {
        onError(
          error instanceof Error
            ? error.message
            : "카메라를 초기화할 수 없습니다.",
        );
      } finally {
        if (mounted) setLoading(false);
      }
    }

    void loadCameras();
    return () => {
      mounted = false;
    };
  }, [onError]);

  useEffect(() => {
    if (!activeCameraId) return undefined;
    let mounted = true;

    async function startScanner() {
      try {
        const { Html5Qrcode } = await import("html5-qrcode");
        const scanner = new Html5Qrcode(elementId);
        scannerRef.current = scanner;
        await scanner.start(
          activeCameraId,
          { fps: 10, qrbox: { width: 240, height: 240 } },
          async (decodedText: string) => {
            if (!mounted || !scannerRef.current) return;
            await scanner.pause(true);
            onScan(decodedText);
            restartTimerRef.current = window.setTimeout(() => {
              if (!mounted) return;
              void scanner.resume();
            }, 3000);
          },
          () => {
            // Frame-level decode errors are expected while scanning.
          },
        );
      } catch (error) {
        onError(
          error instanceof Error
            ? error.message
            : "QR 스캐너를 시작할 수 없습니다.",
        );
      }
    }

    void startScanner();

    return () => {
      mounted = false;
      if (restartTimerRef.current) {
        window.clearTimeout(restartTimerRef.current);
      }
      const scanner = scannerRef.current;
      scannerRef.current = null;
      if (scanner) {
        void scanner.stop().catch(() => undefined);
      }
    };
  }, [activeCameraId, elementId, onError, onScan]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Camera className="h-4 w-4" />
          실시간 QR 스캔
        </div>
        <div className="flex flex-wrap gap-2">
          {cameras.map((camera) => (
            <Button
              key={camera.id}
              type="button"
              size="sm"
              variant={camera.id === activeCameraId ? "default" : "outline"}
              className="rounded-full"
              onClick={() => setActiveCameraId(camera.id)}
              aria-label={`${camera.label} 사용`}
            >
              <Smartphone className="h-3.5 w-3.5" />
              {camera.label}
            </Button>
          ))}
          {!loading && cameras.length === 0 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="rounded-full"
              disabled
            >
              <RefreshCw className="h-3.5 w-3.5" />
              카메라 없음
            </Button>
          )}
        </div>
      </div>
      <div className="overflow-hidden rounded-3xl border border-border bg-muted/30">
        <div id={elementId} className="min-h-[320px]" />
      </div>
      <p className="text-xs text-muted-foreground">
        성공 시 3초 뒤 자동으로 다음 스캔을 다시 시작합니다.
      </p>
    </div>
  );
}

export default QrScanner;
