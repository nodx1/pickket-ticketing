import Link from "next/link";
import {
  ClipboardList,
  Cpu,
  CreditCard,
  Ticket,
  AlertTriangle,
} from "lucide-react";
import { useTranslations } from "next-intl";

export default function BookingGuidePage() {
  const t = useTranslations("guide.booking");

  const steps = [
    { num: "1", icon: ClipboardList, titleKey: "step1_title", descKey: "step1_desc" },
    { num: "2", icon: Cpu, titleKey: "step2_title", descKey: "step2_desc" },
    { num: "3", icon: CreditCard, titleKey: "step3_title", descKey: "step3_desc" },
    { num: "4", icon: Ticket, titleKey: "step4_title", descKey: "step4_desc" },
  ];

  const cautions = ["caution1", "caution2", "caution3", "caution4"] as const;

  const paymentMethodKeys = [
    "pm_card",
    "pm_kakaopay",
    "pm_naverpay",
    "pm_toss",
    "pm_transfer",
    "pm_virtual_account",
  ] as const;

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
            {t("booking_category")}
          </p>
          <h1 className="text-[2.6rem] font-black tracking-tight text-gray-900 leading-[1.05] mb-3">
            {t("booking_title")}
          </h1>
          <p className="text-[14px] text-gray-500">
            {t("booking_subtitle")}
          </p>
        </div>
      </section>

      {/* ─── Content ────────────────────────────────────── */}
      <section className="py-12">
        <div className="max-w-3xl mx-auto px-6">
          {/* 예매 프로세스 */}
          <Section title={t("process_title")}>
            <div className="grid gap-3 mt-3">
              {steps.map((item) => (
                <div
                  key={item.num}
                  className="flex items-start gap-4 rounded-xl border border-gray-100 bg-gray-50 p-5"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-900 text-white text-[13px] font-black">
                    {item.num}
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <item.icon className="h-4 w-4 text-gray-500" />
                      <p className="font-bold text-gray-900 text-[14px]">
                        {t(item.titleKey as Parameters<typeof t>[0])}
                      </p>
                    </div>
                    <p className="text-[12px] text-gray-500 leading-relaxed">
                      {t(item.descKey as Parameters<typeof t>[0])}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </Section>

          {/* 좌석 선택 방식 */}
          <Section title={t("seating_title")}>
            <div className="grid sm:grid-cols-2 gap-3 mt-3">
              <div className="rounded-xl border border-gray-100 bg-gray-50 p-5">
                <p className="font-bold text-gray-900 text-[14px] mb-1">
                  {t("assigned_seat_title")}
                </p>
                <p className="text-[12px] text-gray-500">
                  {t("assigned_seat_desc")}
                </p>
              </div>
              <div className="rounded-xl border border-gray-100 bg-gray-50 p-5">
                <p className="font-bold text-gray-900 text-[14px] mb-1">
                  {t("free_seat_title")}
                </p>
                <p className="text-[12px] text-gray-500">
                  {t("free_seat_desc")}
                </p>
              </div>
            </div>
          </Section>

          {/* 결제 수단 */}
          <Section title={t("payment_title")}>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3">
              {paymentMethodKeys.map((key) => (
                <div
                  key={key}
                  className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 text-[12px] font-semibold text-gray-700 text-center"
                >
                  {t(key)}
                </div>
              ))}
            </div>
          </Section>

          {/* 유의사항 */}
          <Section title={t("caution_title")}>
            <div className="mt-3 rounded-xl border border-amber-100 bg-amber-50 p-5">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
                <p className="text-[13px] font-bold text-amber-900">
                  {t("caution_header")}
                </p>
              </div>
              <ul className="space-y-2">
                {cautions.map((key) => (
                  <li
                    key={key}
                    className="flex items-start gap-2 text-[12px] text-amber-800"
                  >
                    <span className="mt-1.5 w-1 h-1 rounded-full bg-amber-400 shrink-0" />
                    {t(key)}
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
                { href: "/guide/fees", labelKey: "nav.guide" },
                { href: "/guide/delivery", labelKey: "nav.guide" },
                { href: "/refund-policy", labelKey: "nav.refundPolicy" },
                { href: "/guide", labelKey: "nav.guide" },
              ].map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="px-3 py-1.5 rounded-full border border-gray-200 text-[12px] font-semibold text-gray-600 dark:text-gray-400 hover:border-gray-900 hover:text-gray-900 transition-colors"
                >
                  {link.href}
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
