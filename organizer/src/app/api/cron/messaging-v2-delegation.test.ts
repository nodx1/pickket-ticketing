/**
 * 레벨2 컷오버 W5-MSG — go 메시징 cron **무조건 위임** 회귀(이중발송 0).
 *
 * 배경(왜 flag 조건부에서 무조건으로 바뀌었나):
 *   W3-MSG/3.4a 시절엔 `ORGANIZER_MESSAGING_V2_ENABLED` 가 go 발송경로와 v2 발송경로의
 *   배타 스위치였다. W5-MSG 가 발송 원장 자체(event_messages / message_deliveries /
 *   email_campaigns / reminder_sends)를 v2 로 옮기고 go 원본을 마이그 250 으로 DROP 하면서
 *   flag 는 소유권 판단에 **무의미**해졌다:
 *     · flag OFF 에서 옛 go 경로가 되살아나면 존재하지 않는 테이블을 조회해 크래시하고,
 *     · flag 값이 어긋난 순간이 곧 이중발송 창이 된다.
 *   그래서 flag 를 보지 않고 **항상** v2 로 위임한다.
 *
 * 이 테스트가 고정하는 것:
 *   ① flag ON/OFF/미설정 **어느 값에서도** delegatedToV2 를 반환한다.
 *   ② 위임 경로에서 go DB 커넥션을 잡지 않는다(잡으면 이중처리 여지가 남는다).
 *   ③ 위임이라도 cron 인증은 그대로 강제한다.
 *   ④ 소유자를 응답에 명시해 운영자가 "누가 보내는지"를 즉시 확인할 수 있다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getPool, startCronRun } = vi.hoisted(() => ({
  getPool: vi.fn(),
  startCronRun: vi.fn(),
}));
vi.mock("@/lib/db/pool", () => ({ getPool }));
vi.mock("@/lib/ops/cron-run", () => ({ startCronRun, finishCronRun: vi.fn() }));
vi.mock("@/lib/notification/transactional", () => ({
  notifyReminder: vi.fn(),
  notifyCheckinQr: vi.fn(),
}));
vi.mock("@/lib/notification/dlr", () => ({
  reconcileDeliveries: vi.fn(),
  reconcileUnknownDeliveries: vi.fn(),
}));

import { GET as dispatchMessages } from "@/app/api/cron/dispatch-messages/route";
import { GET as dispatchCampaigns } from "@/app/api/cron/dispatch-campaigns/route";
import { GET as reminders } from "@/app/api/cron/reminders/route";
import { GET as consentReconfirm } from "@/app/api/cron/consent-reconfirm/route";

const authed = (path: string) =>
  new Request(`http://localhost${path}`, { headers: { authorization: "Bearer cron-secret" } });

const ROUTES: Array<{
  name: string;
  path: string;
  owner: string | null;
  handler: (r: Request) => Promise<Response>;
}> = [
  {
    name: "dispatch-messages",
    path: "/api/cron/dispatch-messages",
    owner: "v2:app.tasks.messaging_dispatch.dispatch_messages",
    handler: dispatchMessages,
  },
  {
    name: "dispatch-campaigns",
    path: "/api/cron/dispatch-campaigns",
    owner: "v2:app.tasks.messaging_dispatch.dispatch_campaigns",
    handler: dispatchCampaigns,
  },
  {
    name: "reminders",
    path: "/api/cron/reminders",
    owner: "v2:app.tasks.messaging_dispatch.reminders",
    handler: reminders,
  },
  // W3-MSG 선행분 — 같은 계약(무조건 위임)을 공유하므로 함께 고정한다.
  { name: "consent-reconfirm", path: "/api/cron/consent-reconfirm", owner: null, handler: consentReconfirm },
];

const FLAG_VALUES: Array<[string, string | undefined]> = [
  ["flag ON", "true"],
  ["flag OFF", "false"],
  ["flag 미설정", undefined],
];

describe("메시징 cron — flag 값과 무관하게 v2 위임(이중발송 0)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "cron-secret";
    getPool.mockReturnValue({ query: vi.fn(async () => ({ rows: [] })) });
    startCronRun.mockResolvedValue({ id: "run-1" });
  });
  afterEach(() => {
    delete process.env.ORGANIZER_MESSAGING_V2_ENABLED;
  });

  for (const route of ROUTES) {
    for (const [label, value] of FLAG_VALUES) {
      it(`${route.name} — ${label}: go DB 접근 없이 delegatedToV2`, async () => {
        if (value === undefined) delete process.env.ORGANIZER_MESSAGING_V2_ENABLED;
        else process.env.ORGANIZER_MESSAGING_V2_ENABLED = value;

        const res = await route.handler(authed(route.path));
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.data.delegatedToV2).toBe(true);
        // ② 위임인데 go 원장을 건드리면 이중처리 위험이 남는다 → pool 자체를 잡지 않아야 한다.
        expect(getPool).not.toHaveBeenCalled();
        expect(startCronRun).not.toHaveBeenCalled();
        // ④ 소유자 명시(consent-reconfirm 은 note 로 표기 — W3-MSG 선행 포맷 유지)
        if (route.owner) expect(body.data.owner).toBe(route.owner);
      });
    }

    it(`${route.name} — 위임 전에도 cron 인증은 강제`, async () => {
      const res = await route.handler(new Request(`http://localhost${route.path}`));
      expect(res.status).toBe(401);
      expect(getPool).not.toHaveBeenCalled();
    });
  }
});

/**
 * reconcile-deliveries 는 위임 스텁이 **아니다** — provider 상태조회(DLR) 클라이언트가 go 에만
 * 있어 살아 있다. 대신 원장 read/write 는 전부 v2 를 경유하고, 원장에 못 닿은 tick 을
 * "성공"으로 기록하지 않는다(크론 감시가 정상으로 오독하면 미확정 발송이 조용히 쌓인다).
 */
describe("reconcile-deliveries — DLR arm 은 유지, 원장 장애는 침묵하지 않는다", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "cron-secret";
    getPool.mockReturnValue({ query: vi.fn(async () => ({ rows: [] })) });
    startCronRun.mockResolvedValue({ id: "run-1" });
  });

  it("원장 장애 시 200 이 아니라 502 — 크론 실행도 failed 로 기록", async () => {
    const { finishCronRun } = await import("@/lib/ops/cron-run");
    const { reconcileDeliveries, reconcileUnknownDeliveries } = await import(
      "@/lib/notification/dlr"
    );
    vi.mocked(reconcileDeliveries).mockRejectedValue(new Error("ledger unreachable"));
    vi.mocked(reconcileUnknownDeliveries).mockRejectedValue(new Error("ledger unreachable"));

    const { GET } = await import("@/app/api/cron/reconcile-deliveries/route");
    const res = await GET(authed("/api/cron/reconcile-deliveries"));
    expect(res.status).toBe(502);
    expect(vi.mocked(finishCronRun).mock.calls.at(-1)?.[2]).toBe("failed");
  });

  it("정상 tick 은 succeeded + sweep 위임 표기", async () => {
    const { finishCronRun } = await import("@/lib/ops/cron-run");
    const { reconcileDeliveries, reconcileUnknownDeliveries } = await import(
      "@/lib/notification/dlr"
    );
    vi.mocked(reconcileDeliveries).mockResolvedValue({ checked: 1, delivered: 1, failed: 0 });
    vi.mocked(reconcileUnknownDeliveries).mockResolvedValue({
      checked: 0,
      resolved: 0,
      manualReview: 0,
      remaining: 0,
    });

    const { GET } = await import("@/app/api/cron/reconcile-deliveries/route");
    const res = await GET(authed("/api/cron/reconcile-deliveries"));
    const body = await res.json();
    expect(res.status).toBe(200);
    // stale sending 스윕은 v2 celery 단독 소유(go 가 같이 스윕하면 이중 정정).
    expect(body.data.sweepDelegatedToV2).toBe(true);
    expect(vi.mocked(finishCronRun).mock.calls.at(-1)?.[2]).toBe("succeeded");
  });
});
