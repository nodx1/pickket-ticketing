import { describe, expect, it } from "vitest";

import { sanitizeRichHtml } from "../sanitize-rich-html";

describe("sanitizeRichHtml", () => {
  it("removes inline event handlers and scripts", () => {
    const sanitized = sanitizeRichHtml(
      `<img src="/safe.jpg" onerror="alert(1)"><script>alert(1)</script>`,
    );

    expect(sanitized).toContain(`<img src="/safe.jpg">`);
    expect(sanitized).not.toContain("onerror");
    expect(sanitized).not.toContain("<script>");
  });

  it("strips javascript URLs", () => {
    const sanitized = sanitizeRichHtml(
      `<a href="javascript:alert(1)">bad</a><a href="https://pickket.kr">good</a>`,
    );

    expect(sanitized).not.toContain("javascript:");
    expect(sanitized).toContain(`href="https://pickket.kr"`);
  });
});
