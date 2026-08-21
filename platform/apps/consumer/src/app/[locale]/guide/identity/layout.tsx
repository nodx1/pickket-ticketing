import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "본인인증 안내 | Pickket",
  description: "Pickket 본인인증 안내 - 인증 방법, 유효기간, 개인정보 보호",
};

export default function IdentityGuideLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
