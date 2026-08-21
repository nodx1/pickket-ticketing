/**
 * 사업자 인증 심사 + 유료발행 게이트 — API 레벨 E2E.
 * 실 서버·실 DB·실 인증을 통과해 제출→반려→차단→재제출→승인→허용 루프를 검증.
 * 게이트는 정상 경로(draft→pending_review 심사요청)에서 유료 이벤트 + 미승인 계정을 차단.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";

const SERVICE_TOKEN = process.env.V2_EVENT_SYNC_SECRET ?? "e2e_test_service_secret";

test.describe("사업자 인증 심사 + 유료발행 게이트", () => {
  let request: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({
      baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011",
    });
    await loginAsDemoApi(request);
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  async function getStatus(): Promise<{ status: string; id: string | undefined }> {
    const r = await request.get("/api/account/business-verification");
    const body = (await r.json()) as {
      data: { verificationStatus: string; current: { id: string } | null };
    };
    return { status: body.data.verificationStatus, id: body.data.current?.id };
  }

  async function submit() {
    return request.put("/api/account/business-verification", {
      data: {
        action: "submit",
        bizNumber: "247-86-02538",
        companyName: "E2E테스트상호",
        repName: "홍길동",
        bankName: "국민은행",
        bankAccount: "12345678",
        bankHolder: "E2E테스트상호",
        authorizedConfirmed: true,
        maskingConfirmed: true,
        documents: [
          { docType: "biz_cert", fileUrl: "http://e2e/cert.jpg" },
          { docType: "bankbook", fileUrl: "http://e2e/bank.jpg" },
        ],
      },
    });
  }

  async function review(id: string, action: "approve" | "reject", reason?: string) {
    return request.patch(`/api/internal/business-verifications/${id}`, {
      headers: { "X-Pickket-Service-Token": SERVICE_TOKEN },
      data: { action, reason },
    });
  }

  // 드래프트 유료 이벤트 생성 → eventId (게이트는 draft→pending_review 에서 동작)
  async function createDraftPaidEvent(): Promise<string> {
    const sfx = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const orgRes = await request.get("/api/organizers?limit=1");
    let organizerId: string | undefined = (await orgRes.json()).data?.[0]?.id;
    if (!organizerId) {
      const oc = await request.post("/api/organizers", { data: { name: `bv주최${sfx}` } });
      organizerId = (await oc.json()).data?.id;
    }
    const base = Date.now() + 30 * 24 * 3600 * 1000;
    const evRes = await request.post("/api/events", {
      data: {
        organizers: [{ organizerId, role: "host", displayOrder: 0 }],
        title: "BV 게이트 테스트 이벤트",
        slug: `bv-gate-${sfx}`,
        startsAt: new Date(base).toISOString(),
        endsAt: new Date(base + 3 * 3600 * 1000).toISOString(),
        venueName: "테스트홀",
        eventType: "concert",
        ageRating: "all",
        isOnline: false,
        // status 생략 → draft
      },
    });
    const eventId: string | undefined = (await evRes.json()).data?.id;
    expect(eventId, `draft 이벤트 생성 실패`).toBeTruthy();
    const pRes = await request.post(`/api/events/${eventId}/products`, {
      data: {
        name: "일반석",
        type: "ticket",
        price: "30000",
        isFree: false,
        unlimitedStock: true,
        minPerOrder: "1",
        maxPerOrder: "4",
        taxIncluded: true,
      },
    });
    expect((await pRes.json()).data?.id, `유료상품 생성 실패`).toBeTruthy();
    return eventId as string;
  }

  async function requestReview(eventId: string) {
    return request.patch(`/api/events/${eventId}`, {
      data: { status: "pending_review" },
    });
  }

  test("제출→반려→유료발행 차단(403), 재제출→승인→허용", async () => {
    // ── 1) 반려 상태 확보(시작 상태 무관하게 결정적) ──
    let s = await getStatus();
    if (!s.id) {
      const r = await submit();
      expect(r.ok(), `초기 제출 실패: ${await r.text()}`).toBeTruthy();
      s = await getStatus();
    }
    const rej = await review(s.id as string, "reject", "E2E 리셋용 반려");
    expect(rej.ok(), `반려 실패: ${await rej.text()}`).toBeTruthy();
    expect((await getStatus()).status).toBe("rejected");

    // ── 2) 미승인(rejected) 유료 이벤트 발행 → 403 차단 ──
    const paidBlocked = await createDraftPaidEvent();
    const block = await requestReview(paidBlocked);
    expect(block.status(), "미승인 계정의 유료 이벤트 발행은 403 이어야 함").toBe(403);

    // ── 3) 재제출 → 승인 ──
    const re = await submit();
    expect(re.ok(), `재제출 실패: ${await re.text()}`).toBeTruthy();
    s = await getStatus();
    expect(s.status).toBe("pending");
    const appr = await review(s.id as string, "approve");
    expect(appr.ok(), `승인 실패: ${await appr.text()}`).toBeTruthy();
    expect((await getStatus()).status).toBe("approved");

    // ── 4) 승인 후 유료 이벤트 발행 → 허용(403 아님) ──
    const paidAllowed = await createDraftPaidEvent();
    const allow = await requestReview(paidAllowed);
    expect(
      allow.status(),
      `승인 계정의 유료 이벤트 발행은 게이트 통과해야 함(403 아님): ${await allow.text()}`,
    ).not.toBe(403);
  });
});
