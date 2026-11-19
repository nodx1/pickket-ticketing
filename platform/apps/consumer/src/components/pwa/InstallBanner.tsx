"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";
import { usePwaInstall } from "./usePwaInstall";
import { InstallGuideSheet } from "./InstallGuideSheet";

const DISMISS_KEY = "pickket:pwa-banner-dismissed-at";
const DISMISS_DAYS = 14;
const SHOW_DELAY_MS = 2500;

function dismissedRecently(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
    return at > 0 && Date.now() - at < DISMISS_DAYS * 86_400_000;
  } catch {
    return false;
  }
}

function rememberDismiss() {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {
    /* 저장 불가(사파리 개인정보 보호 모드 등) — 이번 화면에서만 닫힘 */
  }
}

/**
 * 모바일 하단 「홈 화면에 추가」 안내. 하단 고정 버튼이 있는 화면(상세·예매·결제)에서는
 * 호출부(ClientLayout)가 렌더하지 않는다. 닫으면 14일 동안 다시 보이지 않는다.
 */
export function InstallBanner() {
  const t = useTranslations("pwa");
  const { platform, visible, run, guideOpen, setGuideOpen } = usePwaInstall();
  const [ready, setReady] = useState(false);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    if (dismissedRecently()) {
      setClosed(true);
      return;
    }
    const id = window.setTimeout(() => setReady(true), SHOW_DELAY_MS);
    return () => window.clearTimeout(id);
  }, []);

  const close = () => {
    rememberDismiss();
    setClosed(true);
  };

  const show = visible && ready && !closed;

  return (
    <>
      {show && (
        <div
          role="region"
          aria-label={t("bannerTitle")}
          className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+12px)] z-40 md:hidden animate-in slide-in-from-bottom-4 fade-in duration-300"
        >
          <div className="flex items-center gap-3 rounded-2xl bg-neutral-950 p-3 pr-2 text-white shadow-2xl ring-1 ring-white/10">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icons/icon-192.png" alt="" width={44} height={44} className="h-11 w-11 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold leading-snug">{t("bannerTitle")}</p>
              <p className="mt-0.5 text-xs leading-snug text-white/65">{t("bannerBody")}</p>
            </div>
            <button
              type="button"
              onClick={async () => {
                const outcome = await run();
                if (outcome !== null) close();
              }}
              className="h-9 shrink-0 rounded-full bg-white px-3.5 text-xs font-bold text-black active:scale-95"
            >
              {t("bannerAction")}
            </button>
            <button
              type="button"
              onClick={close}
              aria-label={t("dismiss")}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white/60 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
      <InstallGuideSheet platform={platform} open={guideOpen} onOpenChange={setGuideOpen} />
    </>
  );
}
