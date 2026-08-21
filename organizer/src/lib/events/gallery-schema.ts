import { z } from "zod";

import { GALLERY_CAPTION_MAX, GALLERY_MAX_IMAGES } from "@/lib/public/gallery-item";

// 상한 정본은 `lib/public/gallery-item.ts` 다(클라이언트가 zod 없이 쓸 수 있도록).
// 기존 import 경로를 깨지 않기 위해 여기서 재수출한다.
export { GALLERY_MAX_IMAGES };

/**
 * 갤러리 입력 스키마 — 이벤트 **생성·수정 라우트가 공유**한다.
 *
 * 🔴 왜 한 곳에 모았나
 * 종전에는 같은 스키마가 `api/events/route.ts`(생성)와 `api/events/[eventId]/route.ts`(수정)에
 * **복붙**돼 있었다. 실제로 캡션 필드를 추가하다 수정 라우트만 고칠 뻔했고, 그랬다면
 * **기존 행사는 저장되고 신규 행사만 조용히 값이 사라지는** 상태가 됐다.
 * zod 는 기본 strip 이라 모르는 필드를 버리면서 **에러를 내지 않는다** — 발견까지 오래 걸린다.
 *
 * 한 곳에서만 정의하면 그 어긋남이 원천적으로 불가능해진다.
 *
 * ⚠️ 서버 전용 모듈이다(zod 의존). 클라이언트에서 길이 상수만 필요하면
 *    `@/lib/public/gallery-item` 의 `GALLERY_CAPTION_MAX` 를 쓴다.
 */
export const galleryImagesSchema = z
  .array(
    z.object({
      url: z.string(),
      variants: z.record(z.string(), z.string()).nullable().optional(),
      caption: z.string().max(GALLERY_CAPTION_MAX).optional(),
    }),
  )
  .max(GALLERY_MAX_IMAGES, `갤러리는 최대 ${GALLERY_MAX_IMAGES}장까지 등록할 수 있습니다`)
  .optional();
