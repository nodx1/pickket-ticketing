import Link from "next/link";
import { Smartphone, Building2, Mail, Wifi } from "lucide-react";
import { getTranslations } from "next-intl/server";

export default async function DeliveryGuidePage() {
  const t = await getTranslations("guide.delivery");

  return (
    <div className="bg-white min-h-screen pt-20">
      {/* ─── Hero ───────────────────────────────────────── */}
      <section className="border-b border-gray-100">
        <div className="max-w-[1440px] mx-auto px-10 py-14">
          <Link
            href="/guide"
            className="inline-flex items-center gap-1 text-[11px] font-bold text-gray-500 hover:text-gray-900 transition-colors mb-4"
          >
            {t("back_to_guide")}
          </Link>
          <p className="text-[11px] font-bold tracking-[0.16em] uppercase text-gray-500 mb-3">
            {t("eyebrow")}
          </p>
          <h1 className="text-[2.6rem] font-black tracking-tight text-gray-900 leading-[1.05] mb-3">
            {t("hero_title")}
          </h1>
          <p className="text-[14px] text-gray-500">
            {t("hero_subtitle")}
          </p>
        </div>
      </section>

      {/* ─── Content ────────────────────────────────────── */}
      <section className="py-12">
        <div className="max-w-3xl mx-auto px-6">
          {/* 수령 방식 */}
          <Section title={t("section_methods")}>
            <div className="grid sm:grid-cols-2 gap-3 mt-3">
              {[
                {
                  icon: Smartphone,
                  title: t("method_mobile_qr"),
                  badge: t("badge_recommended"),
                  items: [
                    t("mobile_qr_item1"),
                    t("mobile_qr_item2"),
                    t("mobile_qr_item3"),
                  ],
                },
                {
                  icon: Building2,
                  title: t("method_onsite"),
                  badge: null,
                  items: [
                    t("onsite_item1"),
                    t("onsite_item2"),
                    t("onsite_item3"),
                  ],
                },
                {
                  icon: Mail,
                  title: t("method_email_qr"),
                  badge: null,
                  items: [
                    t("email_qr_item1"),
                    t("email_qr_item2"),
                    t("email_qr_item3"),
                  ],
                },
                {
                  icon: Wifi,
                  title: t("method_nfc"),
                  badge: null,
                  items: [t("nfc_item1"), t("nfc_item2")],
                },
              ].map((card) => (
                <div
                  key={card.title}
                  className="rounded-xl border border-gray-100 bg-gray-50 p-5"
                >
                  <div className="flex items-center gap-2.5 mb-3">
                    <div className="w-8 h-8 rounded-lg bg-gray-200 flex items-center justify-center shrink-0">
                      <card.icon className="h-4 w-4 text-gray-600 dark:text-gray-400" />
                    </div>
                    <p className="font-bold text-gray-900 text-[14px]">
                      {card.title}
                    </p>
                    {card.badge && (
                      <span className="text-[10px] font-bold bg-gray-900 text-white px-2 py-0.5 rounded-full">
                        {card.badge}
                      </span>
                    )}
                  </div>
                  <ul className="space-y-1.5">
                    {card.items.map((item) => (
                      <li
                        key={item}
                        className="flex items-start gap-2 text-[12px] text-gray-500"
                      >
                        <span className="mt-1.5 w-1 h-1 rounded-full bg-gray-400 shrink-0" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Section>

          {/* 모바일 티켓 이용 안내 */}
          <Section title={t("section_mobile_guide")}>
            <div className="grid gap-2.5 mt-3">
              {[
                { num: "1", text: t("step1") },
                { num: "2", text: t("step2") },
                { num: "3", text: t("step3") },
                { num: "4", text: t("step4") },
              ].map((step) => (
                <div
                  key={step.num}
                  className="flex items-center gap-4 rounded-xl border border-gray-100 bg-gray-50 p-4"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-900 text-white text-[13px] font-black">
                    {step.num}
                  </div>
                  <p className="text-[13px] text-gray-700 dark:text-gray-300 font-medium">
                    {step.text}
                  </p>
                </div>
              ))}
            </div>
          </Section>

          {/* 주의사항 */}
          <Section title={t("section_caution")}>
            <div className="mt-2 rounded-xl border border-amber-100 bg-amber-50 p-5">
              <ul className="space-y-2">
                {[
                  t("caution1"),
                  t("caution2"),
                  t("caution3"),
                ].map((item) => (
                  <li
                    key={item}
                    className="flex items-start gap-2 text-[12px] text-amber-800"
                  >
                    <span className="mt-1.5 w-1 h-1 rounded-full bg-amber-400 shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </Section>

          <div className="mt-10 pt-6 border-t border-gray-100">
            <p className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-3">
              {t("related_pages")}
            </p>
            <div className="flex flex-wrap gap-2">
              {[
                { href: "/guide/booking", label: t("link_booking_guide") },
                { href: "/guide/identity", label: t("link_identity_guide") },
                { href: "/guide", label: t("back_to_guide") },
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
