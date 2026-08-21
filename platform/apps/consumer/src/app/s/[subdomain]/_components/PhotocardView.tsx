"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { Copy, Check, Download, Share2 } from "lucide-react";

interface Photocard {
  id: string;
  event_title: string;
  event_date: string;
  user_name: string;
  tier_name: string | null;
  template_url: string | null;
  share_code: string;
}

export function PhotocardView({ photocard }: { photocard: Photocard }) {
  const t = useTranslations("photocard");
  const [copied, setCopied] = useState(false);

  const shareUrl =
    typeof window !== "undefined"
      ? window.location.href
      : `https://pickket.kr/photocard/${photocard.share_code}`;

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  }, [shareUrl]);

  // ⚠️ 아래 둘은 useCallback 을 뺐다 — onClick 핸들러라 참조 안정성이 불필요한데
  //    t 를 가둬 React Compiler 가 컴포넌트 전체 최적화를 포기했다.
  const handleShareTwitter = () => {
    const text = encodeURIComponent(
      t("shareText", { title: photocard.event_title ?? "", name: photocard.user_name ?? "" }),
    );
    const url = encodeURIComponent(shareUrl);
    window.open(
      `https://twitter.com/intent/tweet?text=${text}&url=${url}`,
      "_blank",
      "noopener,noreferrer",
    );
  };

  const handleShareKakao = useCallback(() => {
    const url = encodeURIComponent(shareUrl);
    window.open(
      `https://story.kakao.com/share?url=${url}`,
      "_blank",
      "noopener,noreferrer",
    );
  }, [shareUrl]);

  const handleDownload = () => {
    // Placeholder: In production, use html2canvas or similar to render + download
    alert(t("downloadComingSoon"));
  };

  // Format event date for display
  const formattedDate = (() => {
    try {
      const d = new Date(photocard.event_date);
      if (isNaN(d.getTime())) return photocard.event_date;
      return d.toLocaleDateString("ko-KR", {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "short",
      });
    } catch {
      return photocard.event_date;
    }
  })();

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-12 bg-background">
      {/* Photocard */}
      <div className="relative w-full max-w-sm mx-auto">
        {/* Card */}
        <div className="relative overflow-hidden rounded-3xl shadow-2xl">
          {/* Gradient background */}
          <div className="absolute inset-0 bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-500 opacity-90" />

          {/* Template image overlay */}
          {photocard.template_url && (
            <div
              className="absolute inset-0 bg-cover bg-center mix-blend-overlay opacity-40"
              style={{ backgroundImage: `url(${photocard.template_url})` }}
            />
          )}

          {/* Content */}
          <div className="relative z-10 px-8 py-12 flex flex-col items-center text-center">
            {/* Pickket logo badge */}
            <div className="mb-8">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/10 backdrop-blur-sm text-xs-plus font-bold tracking-widest text-white/70 uppercase">
                Pickket
              </span>
            </div>

            {/* Event title */}
            <h1 className="text-2xl md:text-3xl font-extrabold text-white leading-tight mb-3 drop-shadow-lg">
              {photocard.event_title}
            </h1>

            {/* Divider */}
            <div className="w-12 h-0.5 bg-white/30 rounded-full mb-4" />

            {/* Date */}
            <p className="text-sm text-white/70 mb-6">{formattedDate}</p>

            {/* User info */}
            <div className="bg-white/10 backdrop-blur-sm rounded-2xl px-6 py-4 w-full">
              <p className="text-xs text-white/50 mb-1 uppercase tracking-wider">
                Ticket Holder
              </p>
              <p className="text-lg font-bold text-white">
                {photocard.user_name}
              </p>
              {photocard.tier_name && (
                <span className="inline-block mt-2 px-3 py-0.5 rounded-full bg-white/10 text-xs font-medium text-white/80">
                  {photocard.tier_name}
                </span>
              )}
            </div>

            {/* Decorative dots */}
            <div className="flex gap-1.5 mt-6">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="w-1.5 h-1.5 rounded-full bg-white/20" />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Share & Action buttons */}
      <div className="mt-8 w-full max-w-sm mx-auto space-y-3">
        {/* Copy link */}
        <button
          onClick={handleCopyLink}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-sm font-medium text-foreground transition-colors"
        >
          {copied ? (
            <>
              <Check className="w-4 h-4 text-emerald-400" />
              <span className="text-emerald-400">{t("linkCopied")}</span>
            </>
          ) : (
            <>
              <Copy className="w-4 h-4" />
              <span>{t("copyLink")}</span>
            </>
          )}
        </button>

        {/* Share row */}
        <div className="grid grid-cols-3 gap-3">
          <button
            onClick={handleShareTwitter}
            className="flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-medium text-foreground transition-colors"
          >
            <Share2 className="w-4 h-4" />
            <span>X (Twitter)</span>
          </button>
          <button
            onClick={handleShareKakao}
            className="flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-medium text-foreground transition-colors"
          >
            <Share2 className="w-4 h-4" />
            <span>{t("shareKakao")}</span>
          </button>
          <button
            onClick={handleDownload}
            className="flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-medium text-foreground transition-colors"
          >
            <Download className="w-4 h-4" />
            <span>{t("download")}</span>
          </button>
        </div>
      </div>

      {/* Footer */}
      <p className="mt-10 text-xs text-white/30">
        Powered by Pickket — {t("footerTagline")}
      </p>
    </div>
  );
}
