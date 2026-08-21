"use client";

import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Cookie, Settings, Check } from "lucide-react";
import { Button } from "@pickket/ui";
import { useTranslations } from "next-intl";
import { useAuthStore } from "@pickket/store";
import { updateConsent } from "@pickket/lib/api";

const CONSENT_STORAGE_KEY = "pickket_cookie_consent";
const TRACKING_CONSENT_KEY = "pickket_tracking_consent";

interface CookieConsent {
  essential: boolean; // 항상 true
  analytics: boolean;
  marketing: boolean;
  timestamp: string;
}

function getStoredConsent(): CookieConsent | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CONSENT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function storeConsent(consent: CookieConsent) {
  localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(consent));
  // P1-5: Sync tracking consent for behavior tracking client
  localStorage.setItem(
    TRACKING_CONSENT_KEY,
    consent.analytics ? "true" : "false",
  );
}

export default function CookieBanner() {
  const _t = useTranslations();
  const { user } = useAuthStore();
  const [visible, setVisible] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);

  useEffect(() => {
    const stored = getStoredConsent();
    if (!stored) {
      setVisible(true);
    }
  }, []);

  /** 로그인 사용자의 동의 상태를 서버에도 기록 */
  const syncConsentToServer = useCallback(
    async (consentData: CookieConsent) => {
      if (!user) return;
      try {
        await Promise.all([
          updateConsent("analytics", consentData.analytics),
          updateConsent("marketing", consentData.marketing),
        ]);
      } catch {
        // 서버 동기화 실패해도 로컬 동의는 유지 (다음 접속 시 재시도)
        console.warn("서버 동의 동기화 실패");
      }
    },
    [user],
  );

  const handleAcceptAll = useCallback(() => {
    const consent: CookieConsent = {
      essential: true,
      analytics: true,
      marketing: true,
      timestamp: new Date().toISOString(),
    };
    storeConsent(consent);
    syncConsentToServer(consent);
    setVisible(false);
  }, [syncConsentToServer]);

  const handleEssentialOnly = useCallback(() => {
    const consent: CookieConsent = {
      essential: true,
      analytics: false,
      marketing: false,
      timestamp: new Date().toISOString(),
    };
    storeConsent(consent);
    syncConsentToServer(consent);
    setVisible(false);
  }, [syncConsentToServer]);

  const handleSaveSettings = useCallback(() => {
    const consent: CookieConsent = {
      essential: true,
      analytics,
      marketing,
      timestamp: new Date().toISOString(),
    };
    storeConsent(consent);
    syncConsentToServer(consent);
    setVisible(false);
    setShowSettings(false);
  }, [analytics, marketing, syncConsentToServer]);

  if (!visible) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ y: 100, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 100, opacity: 0 }}
        transition={{ type: "spring", damping: 25, stiffness: 300 }}
        className="fixed bottom-0 left-0 right-0 z-50 p-4 md:p-6"
      >
        <div className="mx-auto max-w-4xl rounded-2xl border border-border bg-background/95 backdrop-blur-md shadow-2xl">
          <div className="p-4 md:p-6">
            {/* 헤더 */}
            <div className="flex items-start gap-3 mb-4">
              <Cookie className="h-6 w-6 text-primary mt-0.5 shrink-0" />
              <div className="flex-1">
                <h3 className="text-lg font-semibold">쿠키 사용 안내</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Pickket은 서비스 개선과 맞춤형 경험을 위해 쿠키를 사용합니다.
                  필수 쿠키는 서비스 운영에 필요하며 항상 활성화됩니다.
                </p>
              </div>
            </div>

            {/* 설정 패널 */}
            <AnimatePresence>
              {showSettings && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  <div className="space-y-3 mb-4 pl-9">
                    {/* 필수 쿠키 */}
                    <div className="flex items-center justify-between rounded-lg border p-3">
                      <div>
                        <p className="text-sm font-medium">필수 쿠키</p>
                        <p className="text-xs text-muted-foreground">
                          로그인, 장바구니 등 기본 기능에 필수적입니다.
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          항상 활성
                        </span>
                        <Check className="h-4 w-4 text-green-500" />
                      </div>
                    </div>

                    {/* 분석 쿠키 */}
                    <label className="flex items-center justify-between rounded-lg border p-3 cursor-pointer hover:bg-accent/50 transition-colors">
                      <div>
                        <p className="text-sm font-medium">분석 쿠키</p>
                        <p className="text-xs text-muted-foreground">
                          사이트 이용 패턴을 분석하여 서비스를 개선합니다.
                        </p>
                      </div>
                      <input
                        type="checkbox"
                        checked={analytics}
                        onChange={(e) => setAnalytics(e.target.checked)}
                        className="h-5 w-5 rounded border-gray-300 text-primary focus:ring-primary"
                      />
                    </label>

                    {/* 마케팅 쿠키 */}
                    <label className="flex items-center justify-between rounded-lg border p-3 cursor-pointer hover:bg-accent/50 transition-colors">
                      <div>
                        <p className="text-sm font-medium">마케팅 쿠키</p>
                        <p className="text-xs text-muted-foreground">
                          맞춤형 광고와 프로모션 정보를 제공합니다.
                        </p>
                      </div>
                      <input
                        type="checkbox"
                        checked={marketing}
                        onChange={(e) => setMarketing(e.target.checked)}
                        className="h-5 w-5 rounded border-gray-300 text-primary focus:ring-primary"
                      />
                    </label>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* 버튼 */}
            <div className="flex flex-col sm:flex-row gap-2 pl-9">
              <Button onClick={handleAcceptAll} className="flex-1">
                모두 수락
              </Button>
              <Button
                variant="outline"
                onClick={handleEssentialOnly}
                className="flex-1"
              >
                필수만
              </Button>
              {showSettings ? (
                <Button
                  variant="secondary"
                  onClick={handleSaveSettings}
                  className="flex-1"
                >
                  설정 저장
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  onClick={() => setShowSettings(true)}
                  className="flex-1"
                >
                  <Settings className="h-4 w-4 mr-1" />
                  설정
                </Button>
              )}
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
