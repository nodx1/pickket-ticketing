"use client";

/**
 * 트랙 7.18 — 좌석 즐겨찾기/가격 알림 등록 시 개인정보 동의
 *
 * watch / companion 등 알림 채널 활성화 시 1회 동의 모달.
 * localStorage 로 동의 여부 저장. 언제든 철회 가능.
 */

import React, { useEffect, useState } from "react";
import { Shield } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "pickket:seat-privacy-consent-v1";

export interface PrivacyConsent {
  push: boolean;
  email: boolean;
  sms: boolean;
  consentedAt: string;
}

export function loadConsent(): PrivacyConsent | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PrivacyConsent;
  } catch {
    return null;
  }
}

export function saveConsent(consent: PrivacyConsent): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(consent));
  } catch {
    /* localStorage disabled */
  }
}

export function clearConsent(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAgreed: (consent: PrivacyConsent) => void;
}

export function PrivacyConsentDialog({ open, onOpenChange, onAgreed }: Props) {
  const [push, setPush] = useState(true);
  const [email, setEmail] = useState(true);
  const [sms, setSms] = useState(false);

  useEffect(() => {
    if (open) {
      const existing = loadConsent();
      if (existing) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setPush(existing.push);
        setEmail(existing.email);
        setSms(existing.sms);
      }
    }
  }, [open]);

  function handleAgree() {
    const consent: PrivacyConsent = {
      push,
      email,
      sms,
      consentedAt: new Date().toISOString(),
    };
    saveConsent(consent);
    onAgreed(consent);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="size-5 text-primary" aria-hidden />
            알림 수신 동의
          </DialogTitle>
          <DialogDescription>
            좌석 즐겨찾기/가격 알림을 받으려면 알림 채널 동의가 필요합니다. 동의는
            언제든 철회할 수 있고, 철회 즉시 모든 알림 등록이 해제됩니다.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={push}
              onChange={(e) => setPush(e.target.checked)}
              className="mt-1"
            />
            <div>
              <p className="font-medium text-foreground">앱 푸시 알림</p>
              <p className="text-xs text-muted-foreground">
                매진 좌석이 풀리면 즉시 알림 (모바일 앱 설치 시)
              </p>
            </div>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={email}
              onChange={(e) => setEmail(e.target.checked)}
              className="mt-1"
            />
            <div>
              <p className="font-medium text-foreground">이메일</p>
              <p className="text-xs text-muted-foreground">
                좌석 풀림 + 가격 도달 알림 (가입 이메일로 발송)
              </p>
            </div>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={sms}
              onChange={(e) => setSms(e.target.checked)}
              className="mt-1"
            />
            <div>
              <p className="font-medium text-foreground">SMS</p>
              <p className="text-xs text-muted-foreground">
                긴급 알림만 발송 (요금 발생 가능)
              </p>
            </div>
          </label>
          <p className="rounded-lg border border-border bg-muted p-3 text-xs text-muted-foreground">
            본 동의 정보는 사용자의 브라우저(localStorage)에 저장되며, 알림 서버는
            동의된 채널로만 발송합니다. 동의 철회는 마이페이지 → 알림 설정에서 가능합니다.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button onClick={handleAgree}>동의하고 계속</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
