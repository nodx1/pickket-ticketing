"use client";

/** 방금 만든 직원 입장 링크를 보여 준다 — 휴대폰 카메라로 찍을 QR, 복사·보내기, 주의 사항. */
import { useEffect, useState } from "react";
import { Copy, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatDateTimeKst } from "@/lib/format";
import { useToast } from "@/lib/hooks/useToast";
import { generateQRDataURL } from "@/lib/qrCode";

export function TerminalLinkView({ link, label, closesAt }: { link: string; label: string; closesAt: string | null }) {
  const { addToast } = useToast();
  const [qr, setQr] = useState<string | null>(null);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  useEffect(() => {
    let alive = true;
    void generateQRDataURL(link).then((url) => {
      if (alive) setQr(url);
    });
    return () => {
      alive = false;
    };
  }, [link]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      addToast({ message: "입장 링크를 복사했어요", variant: "success" });
    } catch {
      addToast({ message: "복사하지 못했어요. 링크를 길게 눌러 복사해 주세요", variant: "error" });
    }
  };

  const share = async () => {
    try {
      await navigator.share({ title: `${label} 입장 링크`, text: `${label} 입장 화면`, url: link });
    } catch {
      /* 보내기 창을 닫은 경우 — 그대로 둔다 */
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4 sm:flex-row sm:items-start">
        {qr ? (
          // eslint-disable-next-line @next/next/no-img-element -- 브라우저에서 만든 data: 그림이라 next/image 최적화 대상이 아니다
          <img src={qr} alt={`${label} 입장 링크 QR`} width={176} height={176} className="size-44 shrink-0 rounded-md bg-white p-1" />
        ) : (
          <div className="size-44 shrink-0 animate-pulse rounded-md bg-bg-muted" aria-hidden />
        )}
        <div className="min-w-0 space-y-2 text-sm">
          <p className="font-semibold text-foreground">직원 휴대폰 카메라로 이 QR을 찍으면 입장 화면이 바로 열려요.</p>
          <p className="text-content-subtle">로그인이나 키 입력은 필요 없어요. 링크를 카톡 등으로 보내도 돼요.</p>
          <p className="break-all rounded-md bg-card px-2 py-1.5 font-mono text-xs text-content-subtle" data-testid="terminal-link">
            {link}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void copy()}>
              <Copy className="size-4" /> 링크 복사
            </Button>
            {canShare ? (
              <Button size="sm" variant="secondary" onClick={() => void share()}>
                <Send className="size-4" /> 보내기
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-xs text-content-subtle">
        <li>이 링크는 지금만 보여요. 다시 보려면 「새 링크」를 만들어야 하고, 그때 이 링크는 끊겨요.</li>
        <li>링크를 가진 사람은 누구나 입장 처리를 할 수 있어요. 현장 직원에게만 보내 주세요. 잃어버리면 「중지」나 「새 링크」로 바로 막을 수 있어요.</li>
        {closesAt ? <li>행사가 끝나면 자동으로 닫혀요({formatDateTimeKst(closesAt)}).</li> : null}
      </ul>
    </div>
  );
}
