import Link from "next/link";
import {
  UserPlus,
  CalendarPlus,
  BarChart3,
  QrCode,
  Wallet,
  ArrowRight,
} from "lucide-react";
import { GO_URL } from "@pickket/lib";
import { getTranslations } from "next-intl/server";

export default async function SellerGuidePage() {
  const t = await getTranslations("guide.seller");

  const steps = [
    {
      num: "1",
      icon: UserPlus,
      title: t("step1Title"),
      desc: t("step1Desc"),
    },
    {
      num: "2",
      icon: CalendarPlus,
      title: t("step2Title"),
      desc: t("step2Desc"),
    },
    {
      num: "3",
      icon: BarChart3,
      title: t("step3Title"),
      desc: t("step3Desc"),
    },
    {
      num: "4",
      icon: QrCode,
      title: t("step4Title"),
      desc: t("step4Desc"),
    },
    {
      num: "5",
      icon: Wallet,
      title: t("step5Title"),
      desc: t("step5Desc"),
    },
  ];

  const features = [
    t("feature1"),
    t("feature2"),
    t("feature3"),
    t("feature4"),
    t("feature5"),
    t("feature6"),
    t("feature7"),
    t("feature8"),
  ];

  return (
    <div className="bg-white min-h-screen pt-20">
      {/* ─── Hero ───────────────────────────────────────── */}
      <section className="border-b border-gray-100">
        <div className="max-w-[1440px] mx-auto px-10 py-14">
          <Link
            href="/guide"
            className="inline-flex items-center gap-1 text-[11px] font-bold text-gray-500 hover:text-gray-900 transition-colors mb-4"
          >
            {t("backLink")}
          </Link>
          <p className="text-[11px] font-bold tracking-[0.16em] uppercase text-gray-500 mb-3">
            {t("eyebrow")}
          </p>
          <h1 className="text-[2.6rem] font-black tracking-tight text-gray-900 leading-[1.05] mb-3">
            {t("heroTitle")}
          </h1>
          <p className="text-[14px] text-gray-500">
            {t("heroSubtitle")}
          </p>
        </div>
      </section>

      {/* ─── Content ────────────────────────────────────── */}
      <section className="py-12">
        <div className="max-w-3xl mx-auto px-6">
          {/* 5단계 프로세스 */}
          <Section title={t("sectionSteps")}>
            <div className="space-y-2.5 mt-3">
              {steps.map((step) => {
                const Icon = step.icon;
                return (
                  <div
                    key={step.num}
                    className="flex items-start gap-4 rounded-xl border border-gray-100 bg-gray-50 p-4"
                  >
                    <div className="w-9 h-9 rounded-full bg-gray-900 flex items-center justify-center shrink-0">
                      <Icon className="w-4 h-4 text-white" />
                    </div>
                    <div>
                      <p className="font-bold text-gray-900 text-[14px]">
                        <span className="text-gray-500 mr-1.5">
                          {step.num}.
                        </span>
                        {step.title}
                      </p>
                      <p className="text-[12px] text-gray-500 mt-0.5">
                        {step.desc}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>

          {/* 수수료 구조 */}
          <Section title={t("sectionFees")}>
            <div className="overflow-x-auto rounded-xl border border-gray-100 mt-2">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-100">
                    <th className="px-4 py-3 text-left text-[12px] font-bold text-gray-500">
                      {t("feeColItem")}
                    </th>
                    <th className="px-4 py-3 text-left text-[12px] font-bold text-gray-500">
                      {t("feeColDetail")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    [t("feeRow1Item"), t("feeRow1Value")],
                    [t("feeRow2Item"), t("feeRow2Value")],
                    [t("feeRow3Item"), t("feeRow3Value")],
                    [t("feeRow4Item"), t("feeRow4Value")],
                  ].map(([item, value]) => (
                    <tr key={item} className="border-t border-gray-100">
                      <td className="px-4 py-3 text-[13px] font-semibold text-gray-700 dark:text-gray-300">
                        {item}
                      </td>
                      <td className="px-4 py-3 text-[13px] text-gray-500">
                        {value}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          {/* Pickket Go 주요 기능 */}
          <Section title={t("sectionFeatures")}>
            <p className="text-[13px] text-gray-500 mb-3">
              {t("featuresDesc")}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {features.map((feature) => (
                <div
                  key={feature}
                  className="flex items-center gap-2.5 rounded-xl bg-gray-50 border border-gray-100 px-4 py-3"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-400 shrink-0" />
                  <span className="text-[13px] text-gray-700 dark:text-gray-300">{feature}</span>
                </div>
              ))}
            </div>
          </Section>

          {/* CTA Box */}
          <div className="rounded-2xl bg-gray-900 p-8 text-center mt-8">
            <h3 className="text-lg font-black text-white mb-2">
              {t("ctaTitle")}
            </h3>
            <p className="text-[13px] text-white/50 mb-5">
              {t("ctaDesc")}
            </p>
            <a
              href={GO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-white text-gray-900 text-[13px] font-bold hover:bg-gray-100 transition-colors"
            >
              {t("ctaButton")}
              <ArrowRight className="h-3.5 w-3.5" />
            </a>
          </div>

          <div className="mt-10 pt-6 border-t border-gray-100">
            <p className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-3">
              {t("relatedLabel")}
            </p>
            <div className="flex flex-wrap gap-2">
              {[
                { href: "/guide/fees", label: t("relatedFees") },
                { href: "/for-organizers", label: t("relatedOrganizers") },
                { href: "/guide", label: t("relatedGuide") },
              ].map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="px-3 py-1.5 rounded-full border border-gray-200 text-[12px] font-semibold text-gray-600 dark:text-gray-400 hover:border-gray-900 hover:text-gray-900 transition-colors"
                >
                  {link.label}
                </Link>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-8">
      <h2 className="text-[15px] font-black text-gray-900 mb-3 pb-2 border-b border-gray-100">
        {title}
      </h2>
      <div className="space-y-2">{children}</div>
    </div>
  );
}
