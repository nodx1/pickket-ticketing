import Link from "next/link";
import { getTranslations } from "next-intl/server";

export default async function EventNotFound() {
  const t = await getTranslations("event.notFound");

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4">
      <div className="text-center">
        <h2 className="mb-4 text-2xl font-bold text-foreground">
          {t("title")}
        </h2>
        <p className="mb-8 text-muted-foreground">
          {t("description")}
        </p>
        <Link
          href="/events"
          className="rounded-lg bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          {t("backToList")}
        </Link>
      </div>
    </div>
  );
}
