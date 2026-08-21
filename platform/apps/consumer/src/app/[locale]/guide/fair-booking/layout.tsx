import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "공정예매 정책 | Pickket",
  description:
    "Pickket 부정예매 방지 및 공정 배분 정책 - 5계층 봇 탐지, 제재 기준, 1인 예매 제한",
};

export default function FairBookingGuideLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
