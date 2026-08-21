import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "예매 가이드 | Pickket",
  description:
    "Pickket 예매 방법 안내 - 응모 신청부터 결제, 발권까지의 과정을 안내합니다",
};

export default function BookingGuideLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
