"use client";

import { useEffect, useState } from "react";

import { osmEmbedUrl } from "@/lib/map/osm";

/**
 * 좌표 주변 오픈스트리트맵(가운데 핀). 지도 라이브러리·키 없이 임베드 페이지로 그린다.
 *
 * 🔴 src 는 화면 배치가 끝난 뒤(첫 프레임 다음)에 넣는다. 서버 렌더 HTML 에 iframe 이 바로 있으면
 *    스타일이 붙기 전 기본 크기(300×150)로 지도를 그리기 시작해, 넓어진 뒤에도 절반만 그려졌다
 *    (설정 화면에서 확인, 2026-11-20).
 */
export function VenueMapPreview({
  lat,
  lng,
  title,
  className = "h-48",
}: {
  lat: number;
  lng: number;
  title: string;
  className?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => setSrc(osmEmbedUrl(lat, lng)));
    return () => cancelAnimationFrame(id);
  }, [lat, lng]);

  return (
    <div className={`overflow-hidden rounded-lg border border-border bg-muted/30 ${className}`}>
      {src ? (
        <iframe
          key={src}
          title={`${title} 위치 지도`}
          src={src}
          className="size-full border-0"
          referrerPolicy="no-referrer-when-downgrade"
        />
      ) : null}
    </div>
  );
}
