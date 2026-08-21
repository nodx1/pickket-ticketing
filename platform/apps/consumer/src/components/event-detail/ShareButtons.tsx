"use client";

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Link2, Share2, Twitter, Facebook, Check } from "lucide-react";
import { Button } from "@pickket/ui";

interface ShareButtonsProps {
  title: string;
  description?: string;
  imageUrl?: string;
  url?: string;
}

type KakaoShare = {
  isInitialized: () => boolean;
  Share?: {
    sendDefault: (payload: Record<string, unknown>) => void;
  };
};

type KakaoWindow = Window & {
  Kakao?: KakaoShare;
};

export default function ShareButtons({
  title,
  description,
  imageUrl,
  url,
}: ShareButtonsProps) {
  const t = useTranslations("event.shareButtons");
  const [copied, setCopied] = useState(false);

  const getUrl = useCallback(() => {
    return url || (typeof window !== "undefined" ? window.location.href : "");
  }, [url]);

  /* ── URL 복사 ──────────────────────────────────────── */
  // ⚠️ useCallback 을 뺐다 — 이건 onClick 핸들러라 참조 안정성이 필요 없는데,
  //    t 를 가두는 바람에 React Compiler 가 **컴포넌트 전체** 최적화를 포기했다.
  //    수동 memo 를 걷어내면 컴파일러가 알아서 한다.
  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(getUrl());
      setCopied(true);
      toast.success(t("copySuccess"));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("copyError"));
    }
  };

  /* ── 네이티브 공유 (모바일) ────────────────────────── */
  const handleNativeShare = useCallback(async () => {
    if (!navigator.share) return;
    try {
      await navigator.share({
        title,
        text: description || title,
        url: getUrl(),
      });
    } catch {
      // 사용자 취소 — 무시
    }
  }, [title, description, getUrl]);

  /* ── 카카오톡 공유 ─────────────────────────────────── */
  const handleKakaoShare = useCallback(() => {
    const w = window as KakaoWindow;
    if (w.Kakao && w.Kakao.isInitialized() && w.Kakao.Share) {
      w.Kakao.Share.sendDefault({
        objectType: "feed",
        content: {
          title,
          description: description || "",
          imageUrl: imageUrl || "",
          link: {
            mobileWebUrl: getUrl(),
            webUrl: getUrl(),
          },
        },
        buttons: [
          {
            title: "자세히 보기",
            link: {
              mobileWebUrl: getUrl(),
              webUrl: getUrl(),
            },
          },
        ],
      });
    } else {
      // Kakao SDK가 없으면 모바일 공유 스킴 시도
      const shareUrl = `https://sharer.kakao.com/talk/friends/picker/link?url=${encodeURIComponent(getUrl())}`;
      window.open(
        shareUrl,
        "_blank",
        "noopener,noreferrer,width=600,height=400",
      );
    }
  }, [title, description, imageUrl, getUrl]);

  /* ── 트위터/X 공유 ─────────────────────────────────── */
  const handleTwitterShare = useCallback(() => {
    const text = encodeURIComponent(title);
    const shareUrl = encodeURIComponent(getUrl());
    window.open(
      `https://twitter.com/intent/tweet?text=${text}&url=${shareUrl}`,
      "_blank",
      "noopener,noreferrer,width=600,height=400",
    );
  }, [title, getUrl]);

  /* ── 페이스북 공유 ─────────────────────────────────── */
  const handleFacebookShare = useCallback(() => {
    const shareUrl = encodeURIComponent(getUrl());
    window.open(
      `https://www.facebook.com/sharer/sharer.php?u=${shareUrl}`,
      "_blank",
      "noopener,noreferrer,width=600,height=400",
    );
  }, [getUrl]);

  /* ── 네이티브 Web Share API 지원 여부 ──────────────── */
  const supportsNativeShare =
    typeof navigator !== "undefined" && !!navigator.share;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* 네이티브 공유 (모바일) */}
      {supportsNativeShare && (
        <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
          <Button
            variant="outline"
            size="sm"
            onClick={handleNativeShare}
            className="rounded-full h-9 px-3 gap-1.5 border-border/60 hover:bg-primary/5 hover:border-primary/30 transition-colors"
          >
            <Share2 className="h-4 w-4" />
            <span className="text-xs">{t("share")}</span>
          </Button>
        </motion.div>
      )}

      {/* URL 복사 */}
      <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
        <Button
          variant="outline"
          size="sm"
          onClick={handleCopyLink}
          className="rounded-full h-9 px-3 gap-1.5 border-border/60 hover:bg-primary/5 hover:border-primary/30 transition-colors"
        >
          {copied ? (
            <Check className="h-4 w-4 text-emerald-500" />
          ) : (
            <Link2 className="h-4 w-4" />
          )}
          <span className="text-xs">{copied ? t("copied") : t("copyLink")}</span>
        </Button>
      </motion.div>

      {/* 카카오톡 */}
      <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
        <Button
          variant="outline"
          size="sm"
          onClick={handleKakaoShare}
          className="rounded-full h-9 px-3 gap-1.5 border-border/60 hover:bg-[#FEE500]/10 hover:border-[#FEE500]/40 transition-colors"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="currentColor"
            className="text-[#3C1E1E]"
          >
            <path d="M12 3C6.48 3 2 6.58 2 10.94c0 2.8 1.86 5.27 4.66 6.67-.15.56-.96 3.6-.99 3.83 0 0-.02.17.09.24.11.06.24.01.24.01.32-.05 3.7-2.44 4.28-2.86.55.08 1.13.12 1.72.12 5.52 0 10-3.58 10-7.94S17.52 3 12 3z" />
          </svg>
          <span className="text-xs">{t("kakaoTalk")}</span>
        </Button>
      </motion.div>

      {/* 트위터/X */}
      <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
        <Button
          variant="outline"
          size="sm"
          onClick={handleTwitterShare}
          className="rounded-full h-9 px-3 gap-1.5 border-border/60 hover:bg-sky-50 hover:border-sky-200 transition-colors"
        >
          <Twitter className="h-4 w-4" />
          <span className="text-xs sr-only sm:not-sr-only">X</span>
        </Button>
      </motion.div>

      {/* 페이스북 */}
      <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
        <Button
          variant="outline"
          size="sm"
          onClick={handleFacebookShare}
          className="rounded-full h-9 px-3 gap-1.5 border-border/60 hover:bg-blue-50 hover:border-blue-200 transition-colors"
        >
          <Facebook className="h-4 w-4" />
          <span className="text-xs sr-only sm:not-sr-only">Facebook</span>
        </Button>
      </motion.div>
    </div>
  );
}
