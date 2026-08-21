import Link from "next/link";
import { ShieldCheck, Ban, UserCheck } from "lucide-react";
import { getTranslations } from "next-intl/server";

export default async function IdentityGuidePage() {
  const t = await getTranslations("guide.identity");

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
            {t("badge")}
          </p>
          <h1 className="text-[2.6rem] font-black tracking-tight text-gray-900 leading-[1.05] mb-3">
            {t("heroTitle")}
          </h1>
          <p className="text-[14px] text-gray-500">
            {t("heroDesc")}
          </p>
        </div>
      </section>

      {/* ─── Content ────────────────────────────────────── */}
      <section className="py-12">
        <div className="max-w-3xl mx-auto px-6">
          {/* 왜 본인인증이 필요한가요? */}
          <Section title={t("whyTitle")}>
            <div className="grid gap-3 mt-3">
              {[
                {
                  icon: ShieldCheck,
                  title: t("reason1Title"),
                  desc: t("reason1Desc"),
                },
                {
                  icon: Ban,
                  title: t("reason2Title"),
                  desc: t("reason2Desc"),
                },
                {
                  icon: UserCheck,
                  title: t("reason3Title"),
                  desc: t("reason3Desc"),
                },
              ].map((item) => (
                <div
                  key={item.title}
                  className="flex items-start gap-4 rounded-xl border border-gray-100 bg-gray-50 p-5"
                >
                  <div className="w-9 h-9 rounded-xl bg-gray-200 flex items-center justify-center shrink-0">
                    <item.icon className="h-4 w-4 text-gray-600 dark:text-gray-400" />
                  </div>
                  <div>
                    <p className="font-bold text-gray-900 text-[14px]">
                      {item.title}
                    </p>
                    <p className="text-[12px] text-gray-500 mt-0.5">
                      {item.desc}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </Section>

          {/* 인증 방법 */}
          <Section title={t("methodsTitle")}>
            <div className="overflow-x-auto rounded-xl border border-gray-100 mt-3">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-100">
                    <th className="px-4 py-3 text-left text-[12px] font-bold text-gray-500">
                      {t("tableColMethod")}
                    </th>
                    <th className="px-4 py-3 text-left text-[12px] font-bold text-gray-500">
                      {t("tableColDesc")}
                    </th>
                    <th className="px-4 py-3 text-left text-[12px] font-bold text-gray-500">
                      {t("tableColTime")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    [
                      t("method1Name"),
                      t("method1Desc"),
                      t("method1Time"),
                    ],
                    [t("method2Name"), t("method2Desc"), t("method2Time")],
                    [t("method3Name"), t("method3Desc"), t("method3Time")],
                  ].map(([method, desc, time]) => (
                    <tr key={method} className="border-t border-gray-100">
                      <td className="px-4 py-3 text-[13px] font-semibold text-gray-700 dark:text-gray-300">
                        {method}
                      </td>
                      <td className="px-4 py-3 text-[13px] text-gray-500">
                        {desc}
                      </td>
                      <td className="px-4 py-3 text-[13px] text-gray-500">
                        {time}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          {/* 인증 유효기간 및 갱신 */}
          <Section title={t("validityTitle")}>
            <ul className="space-y-2 mt-2">
              {[
                t("validity1"),
                t("validity2"),
                t("validity3"),
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

          {/* 자주 묻는 질문 */}
          <Section title={t("faqTitle")}>
            <div className="space-y-3 mt-3">
              {[
                {
                  q: t("faq1Q"),
                  a: t("faq1A"),
                },
                {
                  q: t("faq2Q"),
                  a: t("faq2A"),
                },
              ].map((faq) => (
                <div
                  key={faq.q}
                  className="rounded-xl border border-gray-100 bg-gray-50 p-5"
                >
                  <p className="font-bold text-gray-900 text-[13px] mb-1">
                    Q. {faq.q}
                  </p>
                  <p className="text-[12px] text-gray-500">A. {faq.a}</p>
                </div>
              ))}
            </div>
          </Section>

          <div className="mt-10 pt-6 border-t border-gray-100">
            <p className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-3">
              {t("relatedPages")}
            </p>
            <div className="flex flex-wrap gap-2">
              {[
                { href: "/privacy", label: t("linkPrivacy") },
                { href: "/guide/fair-booking", label: t("linkFairBooking") },
                { href: "/guide/booking", label: t("linkBookingGuide") },
                { href: "/guide", label: t("backToGuide") },
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
