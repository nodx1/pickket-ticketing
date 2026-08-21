import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "이용 가이드 | Pickket",
  description:
    "Pickket 이용 가이드 - 예매 방법, 수수료 안내, 티켓 수령, 공정예매 정책, 판매자 가이드, 본인인증 안내",
};

export default function GuideLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
