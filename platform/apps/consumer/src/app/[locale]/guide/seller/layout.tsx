import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "판매자 가이드 | Pickket",
  description:
    "Pickket 주최사 가이드 - 회원가입부터 정산까지 5단계 프로세스 안내",
};

export default function SellerGuideLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
