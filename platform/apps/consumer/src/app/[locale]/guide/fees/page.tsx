import Link from "next/link";
import { getTranslations } from "next-intl/server";

export default async function FeesGuidePage() {
  const t = await getTranslations("guide.fees");
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
          {/* 올인 가격 */}
          <Section title={t("allInTitle")}>
            <div className="rounded-xl border-l-4 border-gray-900 bg-gray-50 p-5 mb-4 text-sm leading-relaxed">
              <p className="font-bold text-gray-900 mb-1">
                {t("allInHighlight")}
              </p>
              <p className="text-[13px] text-gray-500">
                {t("allInDesc")}
              </p>
              <p className="mt-2 text-[13px] font-semibold text-gray-700 dark:text-gray-300">
                {t("allInApDiscount")}
              </p>
            </div>
            <p className="text-[13px] text-gray-500 mb-3">
              {t("comparisonCaption")}
            </p>
            <div className="overflow-x-auto rounded-xl border border-gray-100">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-100">
                    <th className="px-4 py-3 text-left text-[12px] font-bold text-gray-500">
                      {t("colPlatform")}
                    </th>
                    <th className="px-4 py-3 text-left text-[12px] font-bold text-gray-500">
                      {t("colBookingFee")}
                    </th>
                    <th className="px-4 py-3 text-left text-[12px] font-bold text-gray-500">
                      {t("colExtraAtPayment")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="bg-gray-900 text-white">
                    <td className="px-4 py-3 font-bold text-[13px]">Pickket</td>
                    <td className="px-4 py-3 font-bold text-[13px]">
                      {t("pickketFee")}
                    </td>
                    <td className="px-4 py-3 font-bold text-[13px]">{t("pickketExtra")}</td>
                  </tr>
                  {[
                    [t("interpark"), t("interparkFee"), t("addedAtPayment")],
                    ["YES24", t("yes24Fee"), t("addedAtPayment")],
                    [t("melonTicket"), t("melonFee"), t("addedAtPayment")],
                  ].map(([name, fee, extra]) => (
                    <tr key={name} className="border-t border-gray-100">
                      <td className="px-4 py-3 text-[13px] text-gray-700 dark:text-gray-300">
                        {name}
                      </td>
                      <td className="px-4 py-3 text-[13px] text-gray-500">
                        {fee}
                      </td>
                      <td className="px-4 py-3 text-[13px] text-gray-500">
                        {extra}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          {/* 주최자 수수료 */}
          <Section title={t("organizerTitle")}>
            <ul className="space-y-2 mt-2">
              {[
                { label: t("platformFeeLabel"), value: t("platformFeeValue") },
                {
                  label: t("pgFeeLabel"),
                  value: t("pgFeeValue"),
                },
                { label: t("initialCostLabel"), value: t("initialCostValue") },
              ].map((row) => (
                <li
                  key={row.label}
                  className="flex items-center justify-between rounded-xl bg-gray-50 border border-gray-100 px-4 py-3"
                >
                  <span className="text-[13px] font-semibold text-gray-700 dark:text-gray-300">
                    {row.label}
                  </span>
                  <span className="text-[13px] text-gray-500">{row.value}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[12px] text-gray-500">
              {t("organizerSettlementNote")}
            </p>
          </Section>

          {/* 리세일 수수료 */}
          <Section title={t("resaleTitle")}>
            <p className="text-[13px] text-gray-500 mb-3">
              {t("resaleDesc")}
            </p>
            <ul className="space-y-2">
              {[
                { label: t("resale50Label"), value: t("resale50Value") },
                { label: t("resale10Label"), value: t("resale10Value") },
                { label: t("resaleBuyerFeeLabel"), value: t("resaleBuyerFeeValue") },
              ].map((row) => (
                <li
                  key={row.label}
                  className="flex items-center justify-between rounded-xl bg-gray-50 border border-gray-100 px-4 py-3"
                >
                  <span className="text-[13px] font-semibold text-gray-700 dark:text-gray-300">
                    {row.label}
                  </span>
                  <span className="text-[13px] text-gray-500">{row.value}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[12px] text-gray-500">
              {t("resaleNote")}
            </p>
          </Section>

          {/* 공공기관 특별요율 */}
          <Section title={t("publicTitle")}>
            <p className="text-[13px] text-gray-500 mb-3">
              {t("publicDesc")}
            </p>
            <div className="rounded-xl bg-gray-50 border border-gray-100 p-5">
              <Link
                href="/government"
                className="inline-flex items-center gap-1 text-[13px] font-bold text-gray-900 hover:text-gray-600 dark:text-gray-400 transition-colors"
              >
                {t("publicLink")}
              </Link>
            </div>
          </Section>

          <div className="mt-10 pt-6 border-t border-gray-100">
            <p className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-3">
              {t("relatedPages")}
            </p>
            <div className="flex flex-wrap gap-2">
              {[
                { href: "/refund-policy", label: t("linkRefundPolicy") },
                { href: "/guide/seller", label: t("linkSellerGuide") },
                { href: "/guide", label: t("linkBackToGuide") },
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
