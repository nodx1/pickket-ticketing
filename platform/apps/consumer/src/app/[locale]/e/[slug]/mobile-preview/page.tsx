/**
 * /e/[slug]/mobile-preview — 모바일 앱(pickket.v2.app) UI의 웹 미리보기
 *
 * Expo 웹 번들이 home 탭의 react-native-pager-view(네이티브 전용)에 걸려서
 * 모바일 앱을 브라우저로 직접 띄울 수 없기 때문에,
 * Consumer 웹에 iPhone 프레임 mockup을 만들어 동일한 컨텐츠를 렌더한다.
 *
 * 실제 모바일 파일: pickket.v2.app/app/e/[slug].tsx
 * 본 페이지는 그 파일의 레이아웃을 HTML/CSS로 1:1 재현.
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { getEventOpenBySlug } from "../_data";
import { MobilePreviewFrame } from "./_components/MobilePreviewFrame";

type Props = {
  params: Promise<{ locale: string; slug: string }>;
};

export default async function MobilePreviewPage({ params }: Props) {
  const { locale, slug } = await params;
  const t = await getTranslations("event.mobilePreview");
  const event = await getEventOpenBySlug(slug);
  if (!event) notFound();

  return (
    <main className="min-h-[100svh] w-full bg-neutral-900 text-white">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 px-6 py-12">
        <header className="w-full text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/50">
            pickket.v2.app — mobile app preview
          </p>
          <h1 className="mt-2 text-3xl font-black">{event.title}</h1>
          <p className="mt-1 text-sm text-white/60">
            {t("description")}
          </p>
          <Link
            href={`/${locale}/e/${slug}`}
            className="mt-4 inline-block text-xs text-white/60 underline hover:text-white"
          >
            {t("backToWeb")}
          </Link>
        </header>

        <MobilePreviewFrame event={event} />

        <footer className="mt-6 max-w-md text-center text-xs leading-relaxed text-white/40">
          {t("footerNote")}
          <br />
          {t("footerFile")}{" "}
          <code className="text-white/60">pickket.v2.app/app/e/[slug].tsx</code>
        </footer>
      </div>
    </main>
  );
}
