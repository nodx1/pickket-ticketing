/**
 * 대표 이미지를 새로 올렸을 때 **직접 올린 세로 이미지를 지킨다**.
 *
 * ## 🔴 왜 필요한가 (2026-08-04, 대표 실사용 지적)
 * 대표 이미지만 바꾸려 했는데 **세로(모바일)까지 같이 바뀌었다.**
 *
 * 업로드 라우트는 렌디션 4종을 만들어 돌려준다(`{base}-wide.webp` 등). 그 맵을
 * `imageVariants` 에 **통째로 대입**하고 있어서, 손으로 올려둔 `portrait` 이
 * 자동 중앙크롭본으로 밀려났다.
 *
 * 세로를 따로 올리게 만든 이유가 바로 그 자동 크롭 때문이었다 — 포스터처럼 글자·인물이
 * 좌우로 퍼진 그림은 중앙크롭에서 한쪽이 잘린다(KLPGA 포스터는 제목이 왼쪽, 선수가
 * 오른쪽이라 세로본에서 한쪽이 사라졌다). 그런데 대표를 한 번 갈아끼우면 원상복구됐다.
 *
 * ## 어떻게 구분하나
 * ```
 * 자동 렌디션    {base}-portrait.webp     ← 접미사가 있다
 * 직접 올린 세로  {base}.webp              ← 그 업로드의 마스터 URL. 접미사가 없다
 * ```
 * `ImageUpload` 는 직접 업로드 시 `payload.data.url`(마스터)을 넘긴다(`image-upload.tsx:63`).
 * 그래서 **접미사 유무**로 갈린다.
 *
 * ⚠️ 확장자를 고정하지 않는다 — `og` 는 jpg 다(`RENDITION_FORMAT`). 앞으로 다른 렌디션의
 *    포맷이 바뀌어도 판정이 깨지지 않게 `-portrait.<ext>` 로만 본다.
 */

type Variants = Record<string, string> | null | undefined;

/** 자동 생성된 세로 렌디션인가(= 어떤 업로드의 `-portrait.<ext>`). */
export function isAutoPortrait(url: string | null | undefined): boolean {
  if (!url) return false;
  // 쿼리·해시를 떼고 파일명만 본다(CDN 이 `?v=` 를 붙일 수 있다).
  const path = url.split(/[?#]/)[0] ?? "";
  const file = path.split("/").pop() ?? "";
  return /-portrait\.[a-z0-9]+$/i.test(file);
}

/**
 * 새 렌디션 맵을 받되, **직접 올린 세로가 있으면 그것을 유지**한다.
 *
 * @param prev  화면이 들고 있던 기존 맵
 * @param next  방금 올린 대표 이미지의 렌디션 맵(`null` = 대표 삭제)
 */
export function mergeKeepingManualPortrait(prev: Variants, next: Variants): Record<string, string> | null {
  const manual = prev?.portrait;
  const keepManual = Boolean(manual) && !isAutoPortrait(manual);

  // 🔴 대표를 **지운** 경우(next=null): 렌디션은 전부 무효다(stale 전파 방지).
  //    그래도 직접 올린 세로는 그 대표에서 나온 것이 아니므로 남긴다.
  if (!next) return keepManual ? { portrait: manual as string } : null;

  return keepManual ? { ...next, portrait: manual as string } : { ...next };
}
