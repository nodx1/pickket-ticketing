import { describe, expect, it } from "vitest";

import { resolveAuthReturnUrl, sanitizeReturnUrl } from "../auth-redirect";

describe("sanitizeReturnUrl", () => {
  it("allows internal paths", () => {
    expect(sanitizeReturnUrl("/events/abc?tab=info#hero")).toBe(
      "/events/abc?tab=info#hero",
    );
  });

  it("rejects protocol-relative redirects", () => {
    expect(sanitizeReturnUrl("//evil.com")).toBeNull();
  });

  it("rejects absolute external URLs", () => {
    expect(sanitizeReturnUrl("https://evil.com")).toBeNull();
  });

  it("rejects non-path values", () => {
    expect(sanitizeReturnUrl("javascript:alert(1)")).toBeNull();
  });

  it("resolves the first safe auth redirect candidate", () => {
    expect(
      resolveAuthReturnUrl(null, "//evil.com", "/mypage?tab=tickets"),
    ).toBe("/mypage?tab=tickets");
  });
});
