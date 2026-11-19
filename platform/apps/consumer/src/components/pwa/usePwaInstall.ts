"use client";

import { useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import {
  canOfferInstall,
  getPwaState,
  getServerPwaState,
  promptInstall,
  subscribePwa,
} from "@/lib/pwa";

/**
 * 「홈 화면에 추가」 버튼·배너 공용 훅.
 * - 설치 창을 띄울 수 있으면 띄우고, 아니면(iOS·인앱 브라우저) 안내 시트를 연다.
 */
export function usePwaInstall() {
  const t = useTranslations("pwa");
  const { platform, installed } = useSyncExternalStore(subscribePwa, getPwaState, getServerPwaState);
  const [guideOpen, setGuideOpen] = useState(false);

  const visible = !installed && canOfferInstall(platform);

  const run = async () => {
    if (platform === "promptable") {
      const outcome = await promptInstall();
      if (outcome === "accepted") toast.success(t("installed"));
      if (outcome !== null) return outcome;
    }
    setGuideOpen(true);
    return null;
  };

  return { platform, visible, run, guideOpen, setGuideOpen };
}
