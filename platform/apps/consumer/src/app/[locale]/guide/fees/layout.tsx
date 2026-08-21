import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "수수료 안내 | Pickket",
  description:
    "Pickket 수수료 정책 - 올인 가격(표시가=결제가), 주최자 수수료 5%, 리세일 수수료 안내",
};

export default function FeesGuideLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
