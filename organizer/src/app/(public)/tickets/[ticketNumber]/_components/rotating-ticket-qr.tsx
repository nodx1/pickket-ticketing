"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { generateQRDataURL } from "@/lib/qrCode";

import { pruneAndCountUsable, shouldRefill, WINDOW_SECONDS, windowOf } from "./qr-cache";

/**
 * 회전 동적 QR — 정적 평문 ticket_number QR 은 스크린샷/전달로 영구 재사용이 가능했다(P2-C15).
 * 서버가 발급한 초기 동적 페이로드(PKT:id:ts:hmac)로 시작하고, 30초마다 /qr 엔드포인트에서
 * 새 페이로드를 받아 갱신한다. HMAC·시간창 검증은 체크인 서버가 수행하므로 만료된 스크린샷은 입장 거부된다.
 * 클라이언트는 비밀키가 없어 페이로드를 직접 생성하지 못한다(반드시 서버에서 fetch).
 */
export function RotatingTicketQR({
  ticketNumber,
  initialImage,
  accessToken,
}: {
  ticketNumber: string;
  initialImage: string;
  /**
   * 딥링크 토큰(`?t=`). 있으면 마운트 시 **한 번** 접근 쿠키로 교환한다.
   *
   * 🔴 이게 없으면 초대권·구매 딥링크로 들어온 손님은 QR 갱신이 403 이 되고,
   *    허용창(5분)을 넘기는 순간 **게이트에서 스캔이 거부**된다(2026-07-29 실사고).
   */
  accessToken?: string | null;
}) {
  const [qrImage, setQrImage] = useState(initialImage);
  const [seconds, setSeconds] = useState(WINDOW_SECONDS);
  const [stale, setStale] = useState(false);
  const aliveRef = useRef(true);
  // 선발급받은 창별 코드 캐시 — 네트워크가 끊겨도 이 범위 안에서는 QR 이 살아 있다.
  const cacheRef = useRef<Map<number, string>>(new Map());

  // 🔴 딥링크로 들어왔으면 접근 쿠키를 **한 번** 교환한다. 실패해도 화면은 그대로다
  //    (초기 QR 은 서버가 이미 심어줬다) — 아티팩트 접근만 못 열릴 뿐이다.
  useEffect(() => {
    if (!accessToken) return;
    void fetch(`/api/tickets/${encodeURIComponent(ticketNumber)}/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: accessToken }),
    }).catch(() => {
      /* 교환 실패는 조용히 넘긴다 — 페이지는 이미 열려 있다. */
    });
  }, [ticketNumber, accessToken]);

  useEffect(() => {
    aliveRef.current = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const nowWindow = () => windowOf(Date.now());

    /** 캐시에서 현재 창 코드를 꺼내 그린다. 없으면 false. */
    async function drawFromCache(): Promise<boolean> {
      const payload = cacheRef.current.get(nowWindow());
      if (!payload) return false;
      const img = await generateQRDataURL(payload);
      if (!aliveRef.current) return true;
      setQrImage(img);
      setStale(false);
      setSeconds(WINDOW_SECONDS);
      return true;
    }

    /** 서버에서 앞으로 쓸 창들을 받아 캐시에 채운다. */
    async function fetchWindows(): Promise<boolean> {
      const res = await fetch(`/api/tickets/${encodeURIComponent(ticketNumber)}/qr`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as {
        data?: { payload?: string; payloads?: Array<{ window: number; payload: string }> };
      };
      const list = json.data?.payloads;
      if (list?.length) {
        pruneAndCountUsable(cacheRef.current, nowWindow()); // 지난 창 정리(무한 증식 방지)
        for (const it of list) cacheRef.current.set(it.window, it.payload);
        return true;
      }
      // 구버전 서버(payloads 없음) — 단건으로 현재 창만 채운다.
      const single = json.data?.payload;
      if (!single) throw new Error("no payload");
      cacheRef.current.set(nowWindow(), single);
      return true;
    }

    async function refresh() {
      // 1) 캐시에 현재 창이 있으면 네트워크 없이 그린다 — 골프장 LTE 끊김 대비.
      if (await drawFromCache()) {
        // 🔴 **앞으로 쓸 창 수**로 판단한다. 캐시 크기를 쓰면 지난 창이 쌓여 항상
        //    가득 차 보이고, 미리 채우기가 영영 발동하지 않는다(실결함).
        if (shouldRefill(pruneAndCountUsable(cacheRef.current, nowWindow()))) {
          try {
            await fetchWindows();
          } catch {
            /* 다음 주기에 다시 시도 — 지금은 캐시로 버틴다. */
          }
        }
        return;
      }
      // 2) 캐시가 비었다 — 받아와서 그린다.
      try {
        await fetchWindows();
        if (!(await drawFromCache())) throw new Error("no window");
      } catch {
        // 갱신 실패 시 정적 평문으로 폴백하지 않는다(보안). 만료 표시 후 다음 주기 재시도.
        if (aliveRef.current) setStale(true);
      }
    }

    timer = setInterval(() => {
      setSeconds((s) => {
        if (s <= 1) {
          void refresh();
          return WINDOW_SECONDS;
        }
        return s - 1;
      });
    }, 1000);

    return () => {
      aliveRef.current = false;
      if (timer) clearInterval(timer);
    };
  }, [ticketNumber]);

  return (
    <div className="flex flex-col items-center gap-2">
      <Image
        src={qrImage}
        alt="입장 QR"
        width={240}
        height={240}
        unoptimized
        className="rounded-lg"
      />
      <p className="text-xs text-muted-foreground">
        {stale
          ? "QR 갱신 중… 네트워크를 확인해주세요"
          : `${seconds}초 후 자동 갱신 · 스크린샷은 입장에 사용할 수 없습니다`}
      </p>
    </div>
  );
}
