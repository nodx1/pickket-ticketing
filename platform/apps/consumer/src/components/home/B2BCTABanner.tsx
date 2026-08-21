import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { GO_URL } from "@pickket/lib";

export default function B2BCTABanner() {
  const t = useTranslations("home.b2b");

  const bodyLines = t("body").split("\n");

  return (
    <section className="max-w-[1440px] mx-auto px-4 sm:px-10 pt-14 pb-16">
      <div className="rounded-2xl bg-[#0a0a0a] p-8 lg:p-10 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
        <div>
          <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-white/70 mb-2">
            <Sparkles className="h-3.5 w-3.5" />
            {t("eyebrow")}
          </p>
          <h2 className="text-2xl lg:text-3xl font-black tracking-tight text-white leading-tight">
            {t("heading")}
          </h2>
          <p className="text-sm text-white/60 mt-2 leading-relaxed">
            {bodyLines[0]}
            <br />
            {bodyLines[1] ?? ""}
          </p>
          <div className="flex items-center gap-2 mt-3 text-xs font-semibold text-white/60">
            <span>{t("social_proof")}</span>
            <span>·</span>
            <span>{t("no_card")}</span>
          </div>
        </div>

        <div className="shrink-0 flex flex-col gap-2">
          <Link
            href={`${GO_URL}`}
            className="inline-flex items-center gap-2 px-6 h-12 rounded-full bg-white text-gray-900 font-bold text-sm shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all"
          >
            {t("cta")}
            <ArrowRight className="h-4 w-4" />
          </Link>
          <span className="text-xs text-white/60 text-center">
            {t("plan_note")}
          </span>
        </div>
      </div>
    </section>
  );
}
