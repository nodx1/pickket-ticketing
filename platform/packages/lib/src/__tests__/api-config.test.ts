import { describe, it, expect, beforeEach, vi } from "vitest";

describe("ApiConfig", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("getApiConfig returns fallback config when configureApi not called", async () => {
    const mod = await import("../api-config");
    const config = mod.getApiConfig();
    expect(config.baseURL).toContain("localhost:8021");
    expect(config.getToken()).toBeNull();
  });

  it("configureApi sets custom config", async () => {
    const mod = await import("../api-config");
    const customConfig = {
      baseURL: "https://api.pickket.kr",
      getToken: () => "custom-token",
      onTokenExpired: vi.fn(),
    };

    mod.configureApi(customConfig);
    const result = mod.getApiConfig();
    expect(result.baseURL).toBe("https://api.pickket.kr");
    expect(result.getToken()).toBe("custom-token");
    expect(result.onTokenExpired).toBeDefined();
  });

  it("configureApi overrides previous config", async () => {
    const mod = await import("../api-config");
    mod.configureApi({
      baseURL: "http://first.com",
      getToken: () => "first-token",
    });
    mod.configureApi({
      baseURL: "http://second.com",
      getToken: () => "second-token",
    });

    const result = mod.getApiConfig();
    expect(result.baseURL).toBe("http://second.com");
    expect(result.getToken()).toBe("second-token");
  });

  it("fallback config reads NEXT_PUBLIC_API_URL from process.env", async () => {
    const originalEnv = process.env.NEXT_PUBLIC_API_URL;
    process.env.NEXT_PUBLIC_API_URL = "https://env-api.example.com";

    const mod = await import("../api-config");
    const config = mod.getApiConfig();
    expect(config.baseURL).toBe("https://env-api.example.com");

    process.env.NEXT_PUBLIC_API_URL = originalEnv;
  });
});
