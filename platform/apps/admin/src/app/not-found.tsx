import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { Button } from "@pickket/ui";
import { getTranslations } from "next-intl/server";

export default async function AdminNotFound() {
  const t = await getTranslations("errors.notFound");
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 px-4 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
        <FileQuestion className="h-8 w-8 text-muted-foreground" />
      </div>
      <div className="space-y-2">
        <h2 className="text-lg font-bold text-foreground">
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground max-w-md">
          {t("description")}
        </p>
      </div>
      <Button asChild variant="outline" className="rounded-full">
        <Link href="/">{t("backHome")}</Link>
      </Button>
    </div>
  );
}
