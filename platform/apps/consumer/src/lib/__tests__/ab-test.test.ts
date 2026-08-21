import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getVisitorId,
  setABCookie,
} from "../../app/s/[subdomain]/_lib/ab-test";

describe("ab-test cookies", () => {
  beforeEach(() => {
    document.cookie = "pk_ab_hero=;path=/;max-age=0";
    document.cookie = "pk_visitor_id=;path=/;max-age=0";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes the variant cookie", () => {
    setABCookie("hero", "variant-a");
    expect(document.cookie).toContain("pk_ab_hero=variant-a");
  });

  it("reuses an existing visitor id", () => {
    document.cookie = "pk_visitor_id=visitor-123;path=/";
    expect(getVisitorId()).toBe("visitor-123");
  });

  it("creates a visitor id when absent", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "visitor-new" });
    expect(getVisitorId()).toBe("visitor-new");
    expect(document.cookie).toContain("pk_visitor_id=visitor-new");
  });
});
