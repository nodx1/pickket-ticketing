import { getTranslations } from "next-intl/server";
import { Ticket } from "lucide-react";

export default async function Loading() {
  const t = await getTranslations("ranking.loading");
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center">
      <div className="relative">
        <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-primary to-brand-lighter flex items-center justify-center animate-pulse">
          <Ticket className="h-7 w-7 text-white" />
        </div>
      </div>
      <p className="mt-4 text-sm text-muted-foreground animate-pulse">
        {t("pleaseWait")}
      </p>
    </div>
  );
}
