import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "티켓 수령 안내 | Pickket",
  description:
    "Pickket 티켓 수령 방법 - 모바일 QR, 현장수령, 이메일, NFC 입장 안내",
};

export default function DeliveryGuideLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
