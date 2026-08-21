import { afterEach, describe, expect, it, vi } from "vitest";
import { NcpAmbiguousError, ncpJsonRequest, type NcpCreds } from "@/lib/ncp/client";

const creds: NcpCreds = { accessKey: "access", secretKey: "secret" };

afterEach(() => vi.unstubAllGlobals());

describe("NCP POST ambiguity and idempotency", () => {
  it("does not blindly replay a POST after the connection result is lost", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("socket closed"));
    vi.stubGlobal("fetch", fetchMock);

    const promise = ncpJsonRequest("https://provider.test", "POST", "/messages", { to: "0101", body: "hi" }, creds);
    await expect(promise).rejects.toBeInstanceOf(NcpAmbiguousError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["X-Idempotency-Key"]).toMatch(/^ncp:[a-f0-9]{64}$/);
  });

  it("retries GET transport failures, which have no send side effect", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(ncpJsonRequest("https://provider.test", "GET", "/status", undefined, creds)).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a 429 with the same idempotency key", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response('{"requestId":"r1"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      ncpJsonRequest("https://provider.test", "POST", "/messages", { to: "0101" }, creds, { idempotencyKey: "logical-1" }),
    ).resolves.toEqual({ requestId: "r1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>)["X-Idempotency-Key"]).toBe("logical-1");
    expect((fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>)["X-Idempotency-Key"]).toBe("logical-1");
  });

  it("treats a POST 5xx as ambiguous instead of silently duplicating it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("upstream error", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      ncpJsonRequest("https://provider.test", "POST", "/messages", { to: "0101" }, creds),
    ).rejects.toMatchObject({ ambiguous: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
