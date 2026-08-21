import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PICKKET.GO",
    short_name: "PICKKET.GO",
    description: "AI 네이티브 이벤트 티켓팅 플랫폼",
    start_url: "/",
    display: "standalone",
    background_color: "#FAFBFF",
    theme_color: "#6C5CE7",
    lang: "ko-KR",
    icons: [
      {
        src: "/icon",
        sizes: "64x64",
        type: "image/png",
      },
      {
        src: "/apple-icon",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  };
}
