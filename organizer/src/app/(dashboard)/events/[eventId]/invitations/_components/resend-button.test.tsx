// @vitest-environment jsdom
/**
 * 🔴 초대권 **재발송 버튼** — 화면에서 실제로 눌러 본다 (2026-08-04).
 *
 * ## 배경
 * 발주처가 보낸 초대권 5건이 23시간째 안 나갔다. 재발송 API 는 종전부터 있었는데
 * **화면에 버튼이 없어** 도달할 경로가 0 이었다.
 *
 * ## 🔴 왜 소스 문자열 검사로 안 하나
 * 같은 폴더의 `revoke-action.guard.test.ts` 는 소스를 문자열로 읽는다(당시 jsdom 미도입).
 * 그 방식으로는 이번 요구가 **하나도 안 잡힌다**:
 *   · `"재발송"` 이 DOM 에 있는지 → **어느 행에** 붙었는지를 못 본다
 *   · `action: "resend"` 가 파일에 있는지 → **버튼이 그걸 보내는지**를 못 본다
 *
 * 잘못 만들면 결과가 **중복 발송**이고 알림톡은 회수할 수 없다. 그래서 행 단위로
 * 렌더하고, 실제로 클릭하고, **나간 요청의 본문을 단언**한다.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const fetchWithAuth = vi.fn();
const addToast = vi.fn();

vi.mock("@/lib/fetchWithAuth", () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));
vi.mock("@/lib/hooks/useToast", () => ({
  useToast: () => ({ addToast }),
  showSuccess: vi.fn(),
  showError: vi.fn(),
}));

import { BulkInvitationsClient } from "./bulk-invitations-client";

const EVENT_ID = "ev-1";

type Row = {
  id: string;
  recipientName: string;
  phone: string | null;
  ticketNumber: string | null;
  admissionDay: string | null;
  status: string;
  failureReason: string | null;
  createdAt: string;
  sentAt: string | null;
  dispatchStatus?: string | null;
};

function row(over: Partial<Row> & { id: string; recipientName: string; status: string }): Row {
  return {
    phone: "010-1111-2222",
    ticketNumber: "T-1",
    admissionDay: null,
    failureReason: null,
    // 🔴 30분 전 — STALL_MINUTES(10) 를 넘겨야 배너가 뜬다.
    createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    sentAt: null,
    ...over,
  };
}

/** 목록·행사 정보 응답을 세우고, 재발송 POST 는 성공으로 돌려준다. */
function mockApi(rows: Row[], opts: { resendOk?: boolean; resendError?: string } = {}) {
  fetchWithAuth.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (init?.method === "POST") {
      return opts.resendOk === false
        ? { success: false, error: opts.resendError ?? "재발송 실패" }
        : { success: true };
    }
    if (url === `/api/events/${EVENT_ID}/invitations`) {
      return {
        success: true,
        data: {
          invitations: rows,
          summary: {},
          messaging: {
            channelId: "@pickket",
            channelIdOk: true,
            templateCode: "PICKKETINVITE001",
            alimtalkReady: true,
            smsFallbackReady: true,
          },
        },
      };
    }
    return { success: true, data: { admissionMode: "single", startsAt: null, endsAt: null, title: "KLPGA", venue: "포천힐스" } };
  });
}

async function renderList(rows: Row[], opts?: { resendOk?: boolean; resendError?: string }) {
  mockApi(rows, opts);
  render(<BulkInvitationsClient eventId={EVENT_ID} />);
  await waitFor(() => expect(screen.getByText(rows[0].recipientName)).toBeInTheDocument());
}

/** 🔴 표 **안**에서만 찾는다 — 「발송 대기」 같은 문구는 표 밖 요약에도 있다. */
function inTable() {
  return within(screen.getByRole("table"));
}

/** 재발송 요청으로 나간 것들만. */
function resendCalls() {
  return fetchWithAuth.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === "POST");
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  addToast.mockReset();
});

describe("🔴 U1 — 어느 행에 버튼이 붙는가", () => {
  it("미발송(발권됨)인 행에는 버튼이 있다 — 이번 5건이 이 상태다", async () => {
    await renderList([row({ id: "a", recipientName: "김대기", status: "issued" })]);
    expect(screen.getByRole("button", { name: "김대기 초대권 재발송" })).toBeInTheDocument();
  });

  it("실패한 행에도 버튼이 있다", async () => {
    await renderList([row({ id: "b", recipientName: "박실패", status: "failed", failureReason: "3019" })]);
    expect(screen.getByRole("button", { name: "박실패 초대권 재발송" })).toBeInTheDocument();
  });

  it("🔴 이미 받은 행에는 버튼이 없다 — 누르면 한 장 더 간다", async () => {
    await renderList([
      row({ id: "c", recipientName: "이수신", status: "sent", sentAt: "2026-08-04T01:00:00Z" }),
    ]);
    expect(screen.queryByRole("button", { name: "이수신 초대권 재발송" })).toBeNull();
  });

  it("🔴 발송·열람 상태면 sentAt 이 비어 있어도 버튼이 없다", async () => {
    // 🔴 상태가 나갔다고 말하는데 sentAt 만 비어 있는 행(전파 지연)이다. 종전엔 이 조합을
    //    화면에서 확인하지 않아 허용 목록에 "sent" 를 끼워 넣어도 아무도 안 잡았다.
    await renderList([
      row({ id: "s", recipientName: "이발송", status: "sent", sentAt: null }),
      row({ id: "v", recipientName: "한열람", status: "viewed", sentAt: null }),
    ]);
    expect(screen.queryByRole("button", { name: "이발송 초대권 재발송" })).toBeNull();
    expect(screen.queryByRole("button", { name: "한열람 초대권 재발송" })).toBeNull();
  });

  it("🔴 회수·입장완료 행에는 버튼이 없다", async () => {
    await renderList([
      row({ id: "d", recipientName: "정회수", status: "revoked" }),
      row({ id: "e", recipientName: "최입장", status: "checked_in" }),
    ]);
    expect(screen.queryByRole("button", { name: "정회수 초대권 재발송" })).toBeNull();
    expect(screen.queryByRole("button", { name: "최입장 초대권 재발송" })).toBeNull();
  });

  it("🔴 섞여 있으면 보낼 수 있는 행에만 붙는다", async () => {
    await renderList([
      row({ id: "a", recipientName: "김대기", status: "issued" }),
      row({ id: "c", recipientName: "이수신", status: "sent", sentAt: "2026-08-04T01:00:00Z" }),
      row({ id: "b", recipientName: "박실패", status: "failed" }),
    ]);
    const names = screen
      .getAllByRole("button", { name: /초대권 재발송$/ })
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["김대기 초대권 재발송", "박실패 초대권 재발송"]);
  });
});

describe("🔴 U2 — 버튼이 무엇을 보내는가", () => {
  it("🔴 action:\"resend\" 를 그 행의 id 로 보낸다 — revoke 를 보내면 초대권이 죽는다", async () => {
    await renderList([row({ id: "inv-77", recipientName: "김대기", status: "issued" })]);
    await userEvent.click(screen.getByRole("button", { name: "김대기 초대권 재발송" }));

    await waitFor(() => expect(resendCalls()).toHaveLength(1));
    const [url, init] = resendCalls()[0] as [string, { method: string; body: string }];
    expect(url).toBe(`/api/events/${EVENT_ID}/invitations/inv-77`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ action: "resend" });
  });

  it("실패 사유를 삼키지 않는다 — 조치가 달라진다", async () => {
    await renderList([row({ id: "a", recipientName: "김대기", status: "issued" })], {
      resendOk: false,
      resendError: "알림톡 채널이 설정되지 않았습니다",
    });
    await userEvent.click(screen.getByRole("button", { name: "김대기 초대권 재발송" }));
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(
        expect.objectContaining({ message: "알림톡 채널이 설정되지 않았습니다", variant: "error" }),
      ),
    );
  });
});

describe("🔴 U3 — 연타해도 한 번만 나가는가", () => {
  it("🔴 배너 일괄 버튼을 두 번 눌러도 대상당 한 번만 호출된다", async () => {
    // 응답을 붙잡아 두고 그 사이에 다시 누른다 — 실제 연타와 같은 상황.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const rows = [
      row({ id: "a", recipientName: "김대기", status: "issued" }),
      row({ id: "b", recipientName: "박대기", status: "issued" }),
    ];
    mockApi(rows);
    const base = fetchWithAuth.getMockImplementation()!;
    fetchWithAuth.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === "POST") { await gate; return { success: true }; }
      return base(url, init);
    });

    render(<BulkInvitationsClient eventId={EVENT_ID} />);
    await waitFor(() => expect(screen.getByText("김대기")).toBeInTheDocument());

    const banner = await screen.findByRole("button", { name: /막힌 2건 다시 보내기/ });
    await userEvent.click(banner);

    // 진행 중에는 눌러도 아무 일이 없어야 한다.
    await waitFor(() => expect(screen.getByRole("button", { name: /다시 보내는 중/ })).toBeDisabled());
    await userEvent.click(screen.getByRole("button", { name: /다시 보내는 중/ }));

    release!();
    await waitFor(() => expect(resendCalls().length).toBeGreaterThanOrEqual(2));
    // 🔴 2건 × 1회 = 2회. 연타가 먹혔으면 4회가 된다.
    await waitFor(() => expect(resendCalls()).toHaveLength(2));
    expect(resendCalls().map((c) => JSON.parse((c[1] as { body: string }).body).action)).toEqual([
      "resend",
      "resend",
    ]);
  });

  it("🔴 행 버튼도 진행 중에는 비활성이다", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const rows = [row({ id: "a", recipientName: "김대기", status: "issued" })];
    mockApi(rows);
    const base = fetchWithAuth.getMockImplementation()!;
    fetchWithAuth.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === "POST") { await gate; return { success: true }; }
      return base(url, init);
    });

    render(<BulkInvitationsClient eventId={EVENT_ID} />);
    await waitFor(() => expect(screen.getByText("김대기")).toBeInTheDocument());

    const btn = screen.getByRole("button", { name: "김대기 초대권 재발송" });
    await userEvent.click(btn);
    await waitFor(() => expect(screen.getByRole("button", { name: "김대기 초대권 재발송" })).toBeDisabled());

    release!();
    await waitFor(() => expect(resendCalls()).toHaveLength(1));
  });
});

describe("배너 — 발주처가 읽고 행동할 수 있는가", () => {
  it("🔴 내부 크론 이름을 보여주지 않는다", async () => {
    await renderList([row({ id: "a", recipientName: "김대기", status: "issued" })]);
    expect(document.body.textContent).not.toContain("dispatch-invitations");
  });

  it("할 수 있는 행동을 말한다", async () => {
    await renderList([row({ id: "a", recipientName: "김대기", status: "issued" })]);
    expect(document.body.textContent).toContain("다시 보내기");
  });

  it("🔴 보낼 수 있는 건이 없으면 일괄 버튼을 그리지 않는다", async () => {
    // 전부 이미 받은 상태 — 버튼이 있으면 그게 곧 중복 발송 경로다.
    await renderList([
      row({ id: "c", recipientName: "이수신", status: "sent", sentAt: "2026-08-04T01:00:00Z" }),
    ]);
    expect(screen.queryByRole("button", { name: /다시 보내기/ })).toBeNull();
  });
});

/**
 * 🔴 B — 「발권됨」 하나에 섞여 있던 둘을 화면에서 갈랐는가 (2026-08-04).
 *
 * 순수 판정(`dispatch-state.test.ts`)이 통과해도 **화면이 그 함수를 안 부르면** 옛날
 * 라벨이 그대로 뜬다. 그래서 여기서 실제 뱃지 문자열을 읽는다.
 */
describe("🔴 발송 상태 3분화 — 화면", () => {
  it("🔴 큐에 없는 행은 「발송 누락」으로 뜬다 — 「발권됨」이 아니다", async () => {
    await renderList([
      row({ id: "m", recipientName: "정유상", status: "issued", dispatchStatus: null }),
    ]);
    expect(screen.getByText("발송 누락")).toBeInTheDocument();
    expect(screen.queryByText("발권됨")).toBeNull();
    // 원인을 말한다 — 주최자가 무엇이 일어났는지 알아야 한다.
    expect(screen.getByText(/대기열에 등록되지 않았습니다/)).toBeInTheDocument();
  });

  it("🔴 큐에서 정상 대기 중인 행은 「발송 대기」다 — 빨강이 아니다", async () => {
    await renderList([
      row({ id: "w", recipientName: "김대기", status: "issued", dispatchStatus: "queued" }),
    ]);
    expect(inTable().getByText("발송 대기")).toBeInTheDocument();
    expect(inTable().queryByText("발송 누락")).toBeNull();
  });

  it("🔴 큐는 끝났는데 발송 기록이 없으면 누락이다", async () => {
    await renderList([
      row({ id: "q", recipientName: "정유상", status: "issued", dispatchStatus: "sent", sentAt: null }),
    ]);
    expect(screen.getByText("발송 누락")).toBeInTheDocument();
    expect(screen.getByText(/발송 기록이 없습니다/)).toBeInTheDocument();
  });

  it("🔴 발송 중인 행에는 재발송 버튼이 없다 — 걸면 두 장 나간다", async () => {
    await renderList([
      row({ id: "s", recipientName: "이발송", status: "issued", dispatchStatus: "sending" }),
    ]);
    expect(screen.getByText("발송 중")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "이발송 초대권 재발송" })).toBeNull();
  });

  it("🔴 실패 사유를 그대로 보여준다 — 「실패」로 뭉개면 대체 발송을 못 정한다", async () => {
    await renderList([
      row({
        id: "f",
        recipientName: "박실패",
        status: "failed",
        failureReason: "알림톡 미도달(3019): 톡유저가 아님",
      }),
    ]);
    expect(screen.getByText("발송 실패")).toBeInTheDocument();
    expect(screen.getByText("알림톡 미도달(3019): 톡유저가 아님")).toBeInTheDocument();
  });

  it("⚠️ 큐 정보가 없으면(구버전 v2) 옛 화면처럼 「발송 대기」다 — 전 행이 빨개지면 안 된다", async () => {
    await renderList([row({ id: "o", recipientName: "김구형", status: "issued" })]);
    expect(inTable().getByText("발송 대기")).toBeInTheDocument();
    expect(inTable().queryByText("발송 누락")).toBeNull();
  });

  it("배너가 누락과 대기를 다르게 말한다", async () => {
    await renderList([
      row({ id: "m", recipientName: "정유상", status: "issued", dispatchStatus: null }),
    ]);
    expect(screen.getByRole("alert").textContent).toContain("대기열에 없습니다");
  });
});
