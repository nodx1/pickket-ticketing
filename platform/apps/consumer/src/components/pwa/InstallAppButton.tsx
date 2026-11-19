"use client";

import { useTranslations } from "next-intl";
import { PlusSquare } from "lucide-react";
import { usePwaInstall } from "./usePwaInstall";
import { InstallGuideSheet } from "./InstallGuideSheet";

/**
 * 「홈 화면에 추가」 버튼. 옛 「앱 다운로드」 자리를 대신한다.
 * 설치할 수 없는 환경(이미 홈 화면 앱, 지원하지 않는 브라우저)에서는 렌더하지 않는다.
 */
export function InstallAppButton({
  variant,
  onDone,
}: {
  variant: "header" | "menu";
  onDone?: () => void;
}) {
  const t = useTranslations("pwa");
  const { platform, visible, run, guideOpen, setGuideOpen } = usePwaInstall();
  if (!visible) return null;

  const onClick = async () => {
    const outcome = await run();
    if (outcome !== null) onDone?.();
  };

  return (
    <>
      {variant === "header" ? (
        <button
          type="button"
          onClick={onClick}
          className="hidden sm:inline-flex items-center gap-1.5 h-10 px-[18px] rounded-full bg-white text-black text-xs font-bold tracking-[0.02em] hover:opacity-80 transition-opacity active:scale-95 whitespace-nowrap"
        >
          <PlusSquare className="h-3.5 w-3.5" aria-hidden />
          {t("install")}
        </button>
      ) : (
        <button
          type="button"
          onClick={onClick}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-3 text-left text-sm font-medium transition-colors hover:bg-muted"
        >
          <PlusSquare className="h-4 w-4" aria-hidden />
          {t("install")}
        </button>
      )}
      <InstallGuideSheet platform={platform} open={guideOpen} onOpenChange={setGuideOpen} />
    </>
  );
}
