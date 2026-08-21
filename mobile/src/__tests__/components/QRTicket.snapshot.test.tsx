/**
 * QRTicket 시각 회귀 스냅샷 (T5 visual guard)
 *
 * 목적: status 분기별 렌더 트리 동결 — 디자인 토큰/레이아웃 변경 시 의도적 업데이트만 통과
 */
import React from "react";
import { render } from "@testing-library/react-native";

jest.mock("expo-screen-capture", () => ({
  preventScreenCaptureAsync: jest.fn(),
  allowScreenCaptureAsync: jest.fn(),
}));

jest.mock("react-native-qrcode-svg", () => {
  const { View } = require("react-native");
  return function MockQRCode() {
    return <View testID="qr-mock" />;
  };
});

jest.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    colors: {
      primary: "#1E2A78",
      background: "#FFFFFF",
      foreground: "#1A1D2E",
      mutedForeground: "#6B7280",
      muted: "#F3F4F6",
      border: "#E5E7EB",
      card: "#FFFFFF",
      success: "#22C55E",
      destructive: "#EF4444",
      warning: "#F59E0B",
    },
  }),
}));

jest.mock("@/hooks/useRotatingQR", () => ({
  useRotatingQR: () => ({
    qrPayload: "TEST-QR-PAYLOAD-12345",
    secondsRemaining: 12,
    isTotp: true,
    loading: false,
  }),
}));

jest.mock("@/config/api", () => ({
  getTicketQr: jest.fn(),
}));

import { QRTicket } from "@/components/ticket/QRTicket";
import type { TicketQrResponse } from "@/config/api";

describe("QRTicket snapshot", () => {
  const baseProps = {
    ticketId: "ticket-1",
    initialQr: { code: "INIT", expires_in_seconds: 15 } as unknown as TicketQrResponse,
  };

  it("active status — QR + countdown 표시", () => {
    const tree = render(<QRTicket {...baseProps} ticketStatus="active" />).toJSON();
    expect(tree).toMatchSnapshot();
  });

  it("used status — completion view", () => {
    const tree = render(<QRTicket {...baseProps} ticketStatus="used" />).toJSON();
    expect(tree).toMatchSnapshot();
  });

  it("cancelled status — cancelled view", () => {
    const tree = render(<QRTicket {...baseProps} ticketStatus="cancelled" />).toJSON();
    expect(tree).toMatchSnapshot();
  });
});
