// @vitest-environment jsdom
/**
 * 🔴 일정에 **안내 이미지를 올리는 자리** (2026-08-19 대표 지시)
 *
 * ## 배경
 * 1라운드 조편성표를 랜딩에 올려야 하는데, 상세 이미지 섹션(`detail-image.ts`)에는
 * 행사 소개·교통·주차·문의만 있고 **프로그램·일정 자리가 없다.** 대표가 일정 화면을
 * 찍어 「여기에서 올리게 해줘야지」 라고 지정했다.
 *
 * ## 🔴 왜 실제로 클릭·업로드까지 하나
 * 이 기능의 실패 방식은 **조용하다**:
 *   · 폼이 `""`(빈 문자열)를 그대로 보내면 서버 `.url()` 이 400 → "일정 추가에 실패" 만 뜬다
 *   · 수정에서 이미지를 지웠는데 키를 안 보내면 **화면에서만 사라지고** 공개 페이지엔 남는다
 * 둘 다 소스 문자열 검사로는 안 잡힌다 — 나가는 **요청 본문**을 단언한다.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const fetchWithAuth = vi.fn();
const fetchWithRefresh = vi.fn();

vi.mock("@/lib/fetchWithAuth", () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
  fetchWithRefresh: (...args: unknown[]) => fetchWithRefresh(...args),
}));
vi.mock("@/lib/hooks/useToast", () => ({
  useToast: () => ({ addToast: vi.fn() }),
  showSuccess: vi.fn(),
  showError: vi.fn(),
}));

import { EventSchedulesClient } from "./event-schedules-client";

const UPLOADED = "https://cdn.pickket.kr/uploads/general/round1.png";

function scheduleRow(over: Record<string, unknown> = {}) {
  return {
    id: "s1",
    title: "1라운드",
    description: "조편성",
    startsAt: "2026-08-20T01:00:00.000Z",
    endsAt: "2026-08-20T09:00:00.000Z",
    venueName: "포천힐스CC",
    sortOrder: 0,
    imageUrl: null,
    ...over,
  };
}

/** 목록 GET 은 rows 를, 그 밖(POST/PATCH)은 성공을 준다. */
function serve(rows: Array<Record<string, unknown>>) {
  fetchWithAuth.mockImplementation((_url: string, init?: { method?: string }) =>
    init?.method ? Promise.resolve({ success: true }) : Promise.resolve({ data: rows }),
  );
}

/** 마지막으로 나간 쓰기 요청의 본문. */
function lastWriteBody() {
  const calls = fetchWithAuth.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method);
  const init = calls.at(-1)?.[1] as { body?: string } | undefined;
  return JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  fetchWithRefresh.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ data: { url: UPLOADED, variants: null } }),
  });
  serve([]);
});

async function uploadInto(scope: HTMLElement) {
  const input = scope.querySelector('input[type="file"]') as HTMLInputElement | null;
  expect(input, "이미지 업로드 칸이 없다").not.toBeNull();
  await userEvent.upload(input!, new File(["x"], "round1.png", { type: "image/png" }));
  await waitFor(() => expect(fetchWithRefresh).toHaveBeenCalled());
}

describe("일정 화면 — 안내 이미지 업로드", () => {
  it("추가 폼에 이미지 업로드 칸이 있다", async () => {
    render(<EventSchedulesClient eventId="ev-1" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(screen.getAllByText("안내 이미지 (선택)").length).toBeGreaterThan(0);
  });

  it("🔴 이미지 없이 추가하면 imageUrl 은 null — 빈 문자열을 보내면 서버가 400 을 낸다", async () => {
    render(<EventSchedulesClient eventId="ev-1" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());

    await userEvent.type(screen.getByPlaceholderText("일정 제목"), "1라운드");
    await userEvent.click(screen.getByRole("button", { name: "일정 추가" }));

    await waitFor(() => expect(lastWriteBody().title).toBe("1라운드"));
    expect(lastWriteBody().imageUrl).toBeNull();
  });

  it("올린 이미지가 추가 요청 본문에 실린다", async () => {
    const { container } = render(<EventSchedulesClient eventId="ev-1" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());

    await userEvent.type(screen.getByPlaceholderText("일정 제목"), "1라운드");
    await uploadInto(container);
    await userEvent.click(screen.getByRole("button", { name: "일정 추가" }));

    await waitFor(() => expect(lastWriteBody().imageUrl).toBe(UPLOADED));
  });

  it("🔴 수정에서 이미지를 지우면 imageUrl: null 이 나간다 — 키를 빼면 공개 화면에 그대로 남는다", async () => {
    serve([scheduleRow({ imageUrl: UPLOADED })]);
    const { container } = render(<EventSchedulesClient eventId="ev-1" />);
    await screen.findByText("1라운드");

    await userEvent.click(screen.getByRole("button", { name: "일정 수정" }));
    // ⚠️ 「일정 제목」 칸은 추가 폼에도 있다 — 수정 카드(border-primary)로 범위를 좁힌다.
    const card = container.querySelector(".border-primary") as HTMLElement;
    expect(card, "수정 카드가 열리지 않았다").not.toBeNull();
    // 수정 폼이 기존 이미지를 들고 들어와야 「삭제」 버튼이 있다.
    await userEvent.click(within(card).getByRole("button", { name: /삭제/ }));
    await userEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => {
      const body = lastWriteBody();
      expect(body).toHaveProperty("imageUrl");
      expect(body.imageUrl).toBeNull();
    });
  });

  it("🔴 이미지를 안 건드리고 제목만 고치면 이미지가 그대로 나간다", async () => {
    serve([scheduleRow({ imageUrl: UPLOADED })]);
    render(<EventSchedulesClient eventId="ev-1" />);
    await screen.findByText("1라운드");

    await userEvent.click(screen.getByRole("button", { name: "일정 수정" }));
    await userEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(lastWriteBody().imageUrl).toBe(UPLOADED));
  });

  it("목록 카드가 올린 이미지를 보여준다 — 붙었는지 눈으로 확인할 자리", async () => {
    serve([scheduleRow({ imageUrl: UPLOADED })]);
    render(<EventSchedulesClient eventId="ev-1" />);
    const img = (await screen.findByAltText("1라운드 안내 이미지")) as HTMLImageElement;
    expect(img.getAttribute("src")).toContain("round1.png");
  });
});
