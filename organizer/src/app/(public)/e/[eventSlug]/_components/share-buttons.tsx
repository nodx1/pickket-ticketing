"use client";

import { Copy, MessageCircle, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { showSuccess } from "@/lib/hooks/useToast";

interface ShareButtonsProps {
  title: string;
  url: string;
}

export function ShareButtons({ title, url }: ShareButtonsProps) {
  const encodedUrl = encodeURIComponent(url);
  const encodedTitle = encodeURIComponent(title);

  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        variant="outline"
        onClick={async () => {
          const kakaoWindow = window as Window & {
            Kakao?: {
              Share?: {
                sendDefault: (payload: {
                  objectType: "feed";
                  content: {
                    title: string;
                    description: string;
                    imageUrl?: string;
                    link: { mobileWebUrl: string; webUrl: string };
                  };
                  buttons: Array<{ title: string; link: { mobileWebUrl: string; webUrl: string } }>;
                }) => void;
              };
            };
          };

          if (kakaoWindow.Kakao?.Share?.sendDefault) {
            kakaoWindow.Kakao.Share.sendDefault({
              objectType: "feed",
              content: {
                title,
                description: "PICKKET.GO 이벤트를 확인해보세요",
                link: {
                  mobileWebUrl: url,
                  webUrl: url,
                },
              },
              buttons: [
                {
                  title: "이벤트 보기",
                  link: {
                    mobileWebUrl: url,
                    webUrl: url,
                  },
                },
              ],
            });
            return;
          }

          await navigator.clipboard.writeText(url);
          showSuccess("카카오 공유 SDK가 없어 링크를 복사했습니다");
        }}
      >
        <MessageCircle className="size-4" />
        카카오톡 공유
      </Button>
      <Button type="button" variant="outline" asChild>
        <a href={`https://twitter.com/intent/tweet?text=${encodedTitle}&url=${encodedUrl}`} target="_blank" rel="noreferrer">
          <Share2 className="size-4" />
          X 공유
        </a>
      </Button>
      <Button type="button" variant="outline" asChild>
        <a href={`https://share.naver.com/web/shareView?url=${encodedUrl}&title=${encodedTitle}`} target="_blank" rel="noreferrer">
          <MessageCircle className="size-4" />
          네이버 블로그
        </a>
      </Button>
      <Button
        type="button"
        variant="outline"
        onClick={async () => {
          await navigator.clipboard.writeText(url);
          showSuccess("링크가 복사되었습니다");
        }}
      >
        <Copy className="size-4" />
        링크 복사
      </Button>
    </div>
  );
}
