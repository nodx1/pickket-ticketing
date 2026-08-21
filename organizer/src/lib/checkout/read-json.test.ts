import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NonJsonResponseError, readCheckoutJson } from "./read-json";

/**
 * 🔴 구매자가 이 문구를 봤다 (2026-07-30):
 *      `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`
 *
 * `await res.json()` 을 무조건 부른 결과다. 이 테스트는 그 문구가 **다시는 화면에
 * 도달하지 못하게** 고정하고, 대신 상태코드가 실린 조치 가능한 문구가 나오게 한다.
 *
 * ⚠️ 원인(무엇이 HTML 을 냈는지)은 특정하지 못했다 — 이 테스트는 **증상의 재발**을
 *    막고 다음 발생을 진단 가능하게 만드는 것까지만 한다. 원인 규명과는 별개다.
 */

function res(body: string, init: { status?: number; contentType?: string }) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.contentType ? { "content-type": init.contentType } : {},
  });
}

const HTML = '<!DOCTYPE html><html><head><title>Error</title></head><body>blocked</body></html>';

describe("readCheckoutJson", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it("정상 JSON 은 그대로 파싱한다", async () => {
    const out = await readCheckoutJson<{ a: number }>(
      res('{"a":1}', { contentType: "application/json" }),
      "t",
    );
    expect(out).toEqual({ a: 1 });
  });

  it("🔴 HTML 응답이면 파서 오류 문구가 아니라 조치 가능한 문구를 던진다", async () => {
    await expect(
      readCheckoutJson(res(HTML, { status: 503, contentType: "text/html" }), "checkout/initiate"),
    ).rejects.toThrow(/차단되었습니다|오류 503/);
  });

  it("🔴 던지는 문구에 'Unexpected token' 이 절대 들어가지 않는다", async () => {
    // 이 단언이 이 파일의 존재 이유다.
    for (const status of [403, 429, 500, 502, 503, 400]) {
      const err: Error = await readCheckoutJson(
        res(HTML, { status, contentType: "text/html" }),
        "t",
      ).then(() => new Error("던지지 않았다"), (e: unknown) => e as Error);
      expect(err.message).not.toContain("Unexpected token");
      expect(err.message).not.toContain("DOCTYPE");
      expect(err.message).toContain(String(status));
    }
  });

  it("진단 정보(상태·content-type·본문 앞부분)를 보존한다", async () => {
    const err = (await readCheckoutJson(
      res(HTML, { status: 403, contentType: "text/html; charset=utf-8" }),
      "t",
    ).catch((e: unknown) => e)) as NonJsonResponseError;
    expect(err).toBeInstanceOf(NonJsonResponseError);
    expect(err.status).toBe(403);
    expect(err.contentType).toContain("text/html");
    expect(err.bodyHead).toContain("DOCTYPE");
    // 본문 전체를 싣지 않는다 — HTML 한 장이 로그로 쏟아지면 안 된다.
    expect(err.bodyHead.length).toBeLessThanOrEqual(200);
  });

  it("콘솔에 진단 로그를 남긴다 — 다음 발생 때 원인을 좁힐 유일한 단서", async () => {
    await readCheckoutJson(res(HTML, { status: 502, contentType: "text/html" }), "checkout/initiate").catch(
      () => {},
    );
    expect(errSpy).toHaveBeenCalled();
    const [msg, meta] = errSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toContain("checkout/initiate");
    expect(meta.status).toBe(502);
  });

  it("429 는 재시도 안내로 구분한다", async () => {
    await expect(
      readCheckoutJson(res(HTML, { status: 429, contentType: "text/html" }), "t"),
    ).rejects.toThrow(/30초/);
  });

  it("content-type 이 json 인데 본문이 손상돼도 같은 형태로 다룬다", async () => {
    // 잘린 응답(프록시 타임아웃 등). 여기도 파서 오류가 새어나가면 안 된다.
    const err: Error = await readCheckoutJson(
      res('{"a":1', { status: 200, contentType: "application/json" }),
      "t",
    ).then(() => new Error("던지지 않았다"), (e: unknown) => e as Error);
    expect(err.message).not.toContain("Unexpected");
    expect(err.message).toContain("결제 응답을 읽지 못했습니다");
  });

  it("content-type 이 없으면 JSON 으로 취급하지 않는다", async () => {
    // 헤더를 안 붙이는 프록시가 있다. 본문이 HTML 이면 여기서 걸러야 한다.
    await expect(readCheckoutJson(res(HTML, { status: 200 }), "t")).rejects.toBeInstanceOf(
      NonJsonResponseError,
    );
  });

  it("application/problem+json 처럼 json 이 포함된 타입은 파싱한다", async () => {
    const out = await readCheckoutJson<{ ok: boolean }>(
      res('{"ok":true}', { contentType: "application/problem+json" }),
      "t",
    );
    expect(out.ok).toBe(true);
  });
});
