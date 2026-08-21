import Link from "next/link";
import { getTranslations } from "next-intl/server";

export default async function FairBookingGuidePage() {
  const t = await getTranslations("guide.fairBooking");

  return (
    <div className="bg-white min-h-screen pt-20">
      {/* ─── Hero ───────────────────────────────────────── */}
      <section className="border-b border-gray-100">
        <div className="max-w-[1440px] mx-auto px-10 py-14">
          <Link
            href="/guide"
            className="inline-flex items-center gap-1 text-[11px] font-bold text-gray-500 hover:text-gray-900 transition-colors mb-4"
          >
            {t("backToGuide")}
          </Link>
          <p className="text-[11px] font-bold tracking-[0.16em] uppercase text-gray-500 mb-3">
            {t("categoryLabel")}
          </p>
          <h1 className="text-[2.6rem] font-black tracking-tight text-gray-900 leading-[1.05] mb-3">
            {t("heroTitle")}
          </h1>
          <p className="text-[14px] text-gray-500">
            {t("heroDescription")}
          </p>
        </div>
      </section>

      {/* ─── Content ────────────────────────────────────── */}
      <section className="py-12">
        <div className="max-w-3xl mx-auto px-6">
          {/* 5계층 봇 탐지 시스템 */}
          <Section title={t("botDetectionTitle")}>
            <p className="text-[13px] text-gray-500 mb-4">
              {t("botDetectionDesc")}
            </p>
            <div className="space-y-2.5">
              {[
                {
                  step: "1",
                  label: t("botStep1Label"),
                  desc: t("botStep1Desc"),
                },
                {
                  step: "2",
                  label: t("botStep2Label"),
                  desc: t("botStep2Desc"),
                },
                {
                  step: "3",
                  label: t("botStep3Label"),
                  desc: t("botStep3Desc"),
                },
                {
                  step: "4",
                  label: t("botStep4Label"),
                  desc: t("botStep4Desc"),
                },
                {
                  step: "5",
                  label: t("botStep5Label"),
                  desc: t("botStep5Desc"),
                },
              ].map((item) => (
                <div
                  key={item.step}
                  className="flex items-start gap-4 rounded-xl border border-gray-100 bg-gray-50 p-4"
                >
                  <div className="w-8 h-8 rounded-full bg-gray-900 flex items-center justify-center shrink-0">
                    <span className="text-[12px] font-black text-white">
                      {item.step}
                    </span>
                  </div>
                  <div>
                    <p className="font-bold text-gray-900 text-[14px]">
                      {item.label}
                    </p>
                    <p className="text-[12px] text-gray-500 mt-0.5">
                      {item.desc}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </Section>

          {/* 제재 기준 */}
          <Section title={t("sanctionTitle")}>
            <p className="text-[13px] text-gray-500 mb-3">
              {t("sanctionDesc")}
            </p>
            <div className="overflow-x-auto rounded-xl border border-gray-100">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-100">
                    <th className="px-4 py-3 text-left text-[12px] font-bold text-gray-500">
                      {t("sanctionColType")}
                    </th>
                    <th className="px-4 py-3 text-left text-[12px] font-bold text-gray-500">
                      {t("sanctionColAction")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    [t("sanctionRow1Type"), t("sanctionRow1Action")],
                    [t("sanctionRow2Type"), t("sanctionRow2Action")],
                    [t("sanctionRow3Type"), t("sanctionRow3Action")],
                  ].map(([type, sanction]) => (
                    <tr key={type} className="border-t border-gray-100">
                      <td className="px-4 py-3 text-[13px] font-semibold text-gray-700 dark:text-gray-300">
                        {type}
                      </td>
                      <td className="px-4 py-3 text-[13px] text-gray-500">
                        {sanction}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          {/* 1인당 예매 제한 */}
          <Section title={t("perPersonLimitTitle")}>
            <ul className="space-y-2 mt-2">
              {[
                t("perPersonLimit1"),
                t("perPersonLimit2"),
                t("perPersonLimit3"),
              ].map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-2 text-[13px] text-gray-600 bg-gray-50 border border-gray-100 rounded-xl px-4 py-3"
                >
                  <span className="mt-1.5 w-1 h-1 rounded-full bg-gray-400 shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
          </Section>

          {/* 소명 절차 */}
          <Section title={t("appealTitle")}>
            <p className="text-[13px] text-gray-500 mb-3">
              {t("appealDesc")}
            </p>
            <div className="rounded-xl bg-gray-50 border border-gray-100 p-5">
              <ul className="space-y-2.5">
                {[
                  { label: t("appealRow1Label"), value: t("appealRow1Value") },
                  { label: t("appealRow2Label"), value: t("appealRow2Value") },
                  { label: t("appealRow3Label"), value: t("appealRow3Value") },
                ].map((row) => (
                  <li
                    key={row.label}
                    className="flex items-start gap-3 text-[13px]"
                  >
                    <span className="font-bold text-gray-900 w-20 shrink-0">
                      {row.label}
                    </span>
                    <span className="text-gray-500">{row.value}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Section>

          <div className="mt-10 pt-6 border-t border-gray-100">
            <p className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-3">
              {t("relatedPages")}
            </p>
            <div className="flex flex-wrap gap-2">
              {[
                { href: "/fairness", label: t("relatedFairness") },
                { href: "/guide/identity", label: t("relatedIdentity") },
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
