import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchBizVerification,
  submitBizVerification,
  reviewBizVerification,
  listBizVerifications,
  V2BizVerifError,
} from "./business-verification-client";

const OLD_ENV = { ...process.env };

beforeEach(() => {
  process.env.V2_INTERNAL_BASE_URL = "https://v2.test";
  process.env.GO_WEBHOOK_SECRET = "test-secret";
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...OLD_ENV };
});

describe("business-verification-client 프록시", () => {
  it("미설정이면 500 에러(V2BizVerifError)", async () => {
    delete process.env.V2_INTERNAL_BASE_URL;
    delete process.env.GO_WEBHOOK_SECRET;
    delete process.env.V2_EVENT_SYNC_SECRET;
    await expect(fetchBizVerification("acc-1")).rejects.toBeInstanceOf(V2BizVerifError);
  });

  it("fetchBizVerification: snake_case → camelCase 매핑 + HMAC 헤더", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          verification_status: "pending",
          has_approved: false,
          verified_at: null,
          rejected_reason: null,
          current: {
            id: "v1",
            account_id: "acc-1",
            biz_number: "123",
            company_name: "회사",
            rep_name: "대표",
            biz_type: null,
            biz_item: null,
            address: null,
            opened_on: null,
            bank_name: "국민",
            bank_account: "111",
            bank_holder: "대표",
            authorized_confirmed: true,
            masking_confirmed: true,
            status: "pending",
            rejected_reason: null,
            created_at: "2026-07-24T00:00:00Z",
            documents: [{ doc_type: "biz_cert", file_url: "u", storage_key: null }],
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchBizVerification("acc-1");
    expect(result.verificationStatus).toBe("pending");
    expect(result.current?.companyName).toBe("회사");
    expect(result.current?.documents[0]?.docType).toBe("biz_cert");

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["X-Pickket-Service-Token"]).toBe("test-secret");
    expect(headers["X-Pickket-Signature"]).toMatch(/^[a-f0-9]{64}$/);
    expect(headers["X-Pickket-Timestamp"]).toBeTruthy();
  });

  it("submitBizVerification: camelCase → snake_case body + PUT", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "pending", id: "v1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await submitBizVerification({
      accountId: "acc-1",
      action: "submit",
      companyName: "회사",
      documents: [{ docType: "biz_cert", fileUrl: "u" }],
    });
    expect(res.status).toBe("pending");

    const call = fetchMock.mock.calls[0];
    expect(call?.[1]?.method).toBe("PUT");
    const sentBody = JSON.parse(call?.[1]?.body as string);
    expect(sentBody.account_id).toBe("acc-1");
    expect(sentBody.company_name).toBe("회사");
    expect(sentBody.documents[0].doc_type).toBe("biz_cert");
    expect(sentBody.documents[0].file_url).toBe("u");
  });

  it("v2 409(편집 잠금)은 detail 메시지로 전파", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "현재 상태에서는 인증 정보를 수정할 수 없습니다" }), {
        status: 409,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      submitBizVerification({ accountId: "acc-1", action: "save" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("listBizVerifications: status_filter 쿼리 + 매핑", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "v1",
              account_id: "acc-1",
              biz_number: "123",
              company_name: "회사",
              rep_name: "대표",
              bank_name: "국민",
              bank_holder: "대표",
              status: "pending",
              created_at: "2026-07-24T00:00:00Z",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const rows = await listBizVerifications("pending");
    expect(rows[0]?.accountId).toBe("acc-1");
    expect(rows[0]?.companyName).toBe("회사");
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain("status_filter=pending");
  });

  it("reviewBizVerification: reviewerId 포함 PATCH body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ data: { id: "v1", account_id: "acc-1", status: "approved" } }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await reviewBizVerification("v1", "approve", null, "admin-1");
    expect(res.status).toBe("approved");
    const sentBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(sentBody.action).toBe("approve");
    expect(sentBody.reviewer_id).toBe("admin-1");
  });
});
