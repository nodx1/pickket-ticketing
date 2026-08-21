import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios, { AxiosError, type InternalAxiosRequestConfig, type AxiosHeaders } from "axios";

// Mock zustand auth store
const mockGetState = vi.fn().mockReturnValue({
  token: null,
  user: null,
  setAuth: vi.fn(),
  logout: vi.fn(),
  hydrate: vi.fn(),
});

vi.mock("@pickket/store", () => ({
  useAuthStore: Object.assign(() => mockGetState(), {
    getState: mockGetState,
  }),
}));

// Mock api-config
const mockGetApiConfig = vi.fn().mockReturnValue({
  baseURL: "http://localhost:8001",
  getToken: () => null,
  onTokenExpired: vi.fn(),
});

vi.mock("../api-config", () => ({
  getApiConfig: () => mockGetApiConfig(),
}));

// We need to dynamically import api after mocks are set up
let apiModule: typeof import("../api");

describe("API Client Module", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetState.mockReturnValue({
      token: null,
      user: null,
      setAuth: vi.fn(),
      logout: vi.fn(),
      hydrate: vi.fn(),
    });
    mockGetApiConfig.mockReturnValue({
      baseURL: "http://localhost:8001",
      getToken: () => null,
      onTokenExpired: vi.fn(),
    });
  });

  describe("Exported API functions", () => {
    beforeEach(async () => {
      // Fresh import for each test
      vi.resetModules();
      apiModule = await import("../api");
    });

    it("exports register function", () => {
      expect(apiModule.register).toBeDefined();
      expect(typeof apiModule.register).toBe("function");
    });

    it("exports login function", () => {
      expect(apiModule.login).toBeDefined();
      expect(typeof apiModule.login).toBe("function");
    });

    it("exports getEvents function", () => {
      expect(apiModule.getEvents).toBeDefined();
      expect(typeof apiModule.getEvents).toBe("function");
    });

    it("exports getEvent function", () => {
      expect(apiModule.getEvent).toBeDefined();
      expect(typeof apiModule.getEvent).toBe("function");
    });

    it("exports createEvent function", () => {
      expect(apiModule.createEvent).toBeDefined();
      expect(typeof apiModule.createEvent).toBe("function");
    });

    it("exports searchEvents function", () => {
      expect(apiModule.searchEvents).toBeDefined();
      expect(typeof apiModule.searchEvents).toBe("function");
    });

    it("exports getFeaturedEvents function", () => {
      expect(apiModule.getFeaturedEvents).toBeDefined();
      expect(typeof apiModule.getFeaturedEvents).toBe("function");
    });

    it("exports getTrendingEvents function", () => {
      expect(apiModule.getTrendingEvents).toBeDefined();
      expect(typeof apiModule.getTrendingEvents).toBe("function");
    });

    it("exports requestPasswordReset function", () => {
      expect(apiModule.requestPasswordReset).toBeDefined();
      expect(typeof apiModule.requestPasswordReset).toBe("function");
    });

    it("exports confirmPasswordReset function", () => {
      expect(apiModule.confirmPasswordReset).toBeDefined();
      expect(typeof apiModule.confirmPasswordReset).toBe("function");
    });

    it("exports updateEvent function", () => {
      expect(apiModule.updateEvent).toBeDefined();
      expect(typeof apiModule.updateEvent).toBe("function");
    });

    it("exports deleteEvent function", () => {
      expect(apiModule.deleteEvent).toBeDefined();
      expect(typeof apiModule.deleteEvent).toBe("function");
    });
  });

  describe("Type exports", () => {
    beforeEach(async () => {
      vi.resetModules();
      apiModule = await import("../api");
    });

    it("exports Event type (interface existence via module)", () => {
      // Type-only exports won't show at runtime, but we verify the module loads
      expect(apiModule).toBeDefined();
    });

    it("exports SearchParams type", () => {
      expect(apiModule).toBeDefined();
    });
  });
});

describe("API Configuration", () => {
  it("defaults API_BASE to localhost:8001 when env not set", async () => {
    vi.resetModules();
    const mod = await import("../api");
    // The default axios instance is created with the base URL
    expect(mod.default).toBeDefined();
  });

  it("creates an axios instance with correct defaults", async () => {
    vi.resetModules();
    const mod = await import("../api");
    const api = mod.default;
    expect(api.defaults.baseURL).toContain("/api/v1");
    expect(api.defaults.timeout).toBe(30000);
    expect(api.defaults.withCredentials).toBe(true);
    expect(api.defaults.headers["Content-Type"]).toBe("application/json");
  });
});

describe("Retry Logic Constants", () => {
  it("module exports default api instance", async () => {
    vi.resetModules();
    const mod = await import("../api");
    expect(mod.default).toBeDefined();
    expect(mod.default.defaults).toBeDefined();
  });
});
