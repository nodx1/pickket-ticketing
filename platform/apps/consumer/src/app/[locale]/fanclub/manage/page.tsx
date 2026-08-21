"use client";

import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { GO_URL } from "@pickket/lib";
import { useTranslations } from "next-intl";

export default function FanclubManageRedirect() {
  const t = useTranslations("fanclub.manage");
  useEffect(() => {
    window.location.href = `${GO_URL}/fanclub/manage`;
  }, []);

  return (
    <div className="flex flex-col items-center justify-center py-20 gap-4">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
      <p className="text-muted-foreground text-sm">{t("redirecting")}</p>
    </div>
  );
}
