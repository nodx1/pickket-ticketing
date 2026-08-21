/**
 * Wallet Pass 유틸 (Phase D.4)
 *
 * Apple Wallet (.pkpass) / Google Pay 패스를 외부 브라우저로 열어 추가.
 *
 * 전략:
 * - 백엔드 `/tickets/{id}/wallet-pass` 가 플랫폼별 URL 반환 (iOS: .pkpass, Android: Google Pay save link)
 * - 프론트는 URL 만 받아서 WebBrowser.openBrowserAsync → OS 가 자동으로 Wallet 추가 흐름 시작
 * - 백엔드 미구현(404/501) 또는 네트워크 오류 → 사용자에게 "지원 예정" 안내
 */
import { Platform } from "react-native";
import * as WebBrowser from "expo-web-browser";
import axios from "axios";
import { api } from "@/config/api";

export interface WalletPassUrlResponse {
  url: string;
  platform: "apple" | "google";
  expires_at?: string;
}

export type WalletPassResult =
  | { status: "added" }
  | { status: "cancelled" }
  | { status: "unsupported" }
  | { status: "error"; message: string };

function isNotImplemented(err: unknown): boolean {
  if (axios.isAxiosError(err)) {
    const s = err.response?.status;
    return s === 404 || s === 501;
  }
  return false;
}

/** 티켓 wallet pass URL 요청 */
export async function fetchWalletPassUrl(ticketId: string): Promise<WalletPassUrlResponse | null> {
  try {
    const platform = Platform.OS === "ios" ? "apple" : "google";
    const { data } = await api.get<WalletPassUrlResponse>(`/tickets/${ticketId}/wallet-pass`, {
      params: { platform },
    });
    return data;
  } catch (err: unknown) {
    if (isNotImplemented(err)) return null;
    throw err;
  }
}

/** 티켓을 Wallet에 추가 — URL 열기 (iOS: .pkpass, Android: Google Pay save link) */
export async function addTicketToWallet(ticketId: string): Promise<WalletPassResult> {
  try {
    const data = await fetchWalletPassUrl(ticketId);
    if (!data) return { status: "unsupported" };
    const result = await WebBrowser.openBrowserAsync(data.url, {
      dismissButtonStyle: "done",
      readerMode: false,
      enableBarCollapsing: true,
    });
    if (result.type === "cancel" || result.type === "dismiss") {
      return { status: "cancelled" };
    }
    return { status: "added" };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "unknown";
    return { status: "error", message };
  }
}
