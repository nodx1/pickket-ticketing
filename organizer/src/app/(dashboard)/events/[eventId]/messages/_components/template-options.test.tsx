// @vitest-environment jsdom
/**
 * 🔴 수동 발송 템플릿 드롭다운 — **고를 수 있는 것이 실제로 나가는가** (2026-08-04).
 *
 * ## 배경
 * 드롭다운 5개와 레지스트리를 대조한 결과 **나갈 수 있는 것이 0개**였다.
 *   · 2개는 코드가 달랐고(`PICKKET_PURCHASE_001` vs `PICKKETPURCHASE001`)
 *   · 3개는 언더바라 NCP 등록 자체가 불가능했다 — 승인된 템플릿이 없다
 *
 * 주최자가 무엇을 고르든 실패했고, 실패는 조용하다(접수 A000 · 전달만 거부 3027).
 *
 * ⚠️ 이 테스트는 **화면의 option 값**을 레지스트리와 대조한다. 옛 하드코딩으로 되돌리면
 *    여기서 죽어야 한다 — 소스에 문자열이 있는지 보는 검사로는 안 잡힌다.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/fetchWithAuth", () => ({
  fetchWithAuth: vi.fn(async () => ({ success: true, data: {} })),
  fetchWithRefresh: vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: {} }) })),
}));
vi.mock("@/lib/hooks/useToast", () => ({
  useToast: () => ({ addToast: vi.fn() }),
  showSuccess: vi.fn(),
  showError: vi.fn(),
}));

import { MessageComposer } from "./message-composer";
import { manualSendTemplateOptions } from "@/lib/notification/alimtalk-templates";

/** 알림톡 채널을 골라 템플릿 드롭다운을 띄운다. */
async function openTemplateSelect(): Promise<HTMLSelectElement> {
  render(<MessageComposer eventId="ev-1" open onOpenChange={() => {}} onSent={() => {}} />);
  await userEvent.click(screen.getByRole("radio", { name: /카카오 알림톡/ }));
  return (await screen.findByLabelText(/알림톡 승인 템플릿/)) as HTMLSelectElement;
}

/** 실제 선택 가능한 코드들(빈 값 = 안내 문구 제외). */
function optionCodes(select: HTMLSelectElement): string[] {
  return Array.from(select.options)
    .map((o) => o.value)
    .filter((v) => v !== "");
}

describe("🔴 U4 — 드롭다운이 레지스트리에서 오는가", () => {
  it("🔴 선택지가 레지스트리 코드와 정확히 일치한다", async () => {
    const select = await openTemplateSelect();
    expect(optionCodes(select)).toEqual(manualSendTemplateOptions().map((o) => o.code));
  });

  it("🔴 옛 하드코딩 코드는 하나도 남아 있지 않다", async () => {
    const select = await openTemplateSelect();
    const codes = optionCodes(select);
    for (const dead of [
      "PICKKET_PURCHASE_001",
      "PICKKET_CANCEL_001",
      "PICKKET_REMIND_D7",
      "PICKKET_REMIND_D1",
      "PICKKET_CHECKIN_001",
    ]) {
      expect(codes, `${dead} 이 아직 화면에 있다 — 고르면 실패한다`).not.toContain(dead);
    }
  });

  it("🔴 모든 선택지가 NCP 등록 가능한 형식이다 — 언더바가 있으면 등록된 적이 없는 것", async () => {
    const select = await openTemplateSelect();
    for (const code of optionCodes(select)) {
      expect(code, `${code} 는 NCP 에 등록될 수 없는 형식이다`).toMatch(/^[A-Za-z0-9]+$/);
    }
  });

  it("승인된 3종이 실제로 보인다", async () => {
    const select = await openTemplateSelect();
    expect(optionCodes(select)).toEqual([
      "PICKKETPURCHASE001",
      "PICKKETCANCEL001",
      "PICKKETINVITE001",
    ]);
  });

  it("미선택 안내는 남긴다 — 고르지 않으면 배치 발송이 안 된다", async () => {
    const select = await openTemplateSelect();
    expect(Array.from(select.options).some((o) => o.value === "")).toBe(true);
  });
});
