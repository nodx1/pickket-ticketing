/**
 * P2-6: Accessibility audit configuration
 *
 * WCAG 2.1 AA compliance scan targets for consumer app.
 * Used by:
 *   - scripts/ci/accessibility-audit.sh (CI pipeline)
 *   - pa11y-ci / @axe-core/cli
 */

export interface A11yPageConfig {
  /** Page path (appended to base URL) */
  path: string;
  /** Human-readable label */
  label: string;
  /** Additional actions before scan (e.g., wait for hydration) */
  actions?: string[];
  /** Page-specific rule overrides */
  ignore?: string[];
}

export interface A11yConfig {
  /** Base URL of the consumer app */
  baseUrl: string;
  /** WCAG standard to enforce */
  standard: "WCAG2A" | "WCAG2AA" | "WCAG2AAA";
  /** Max allowed critical/serious violations before CI fails */
  threshold: number;
  /** Timeout per page scan (ms) */
  timeout: number;
  /** Pages to scan */
  pages: A11yPageConfig[];
  /** Global rules to ignore (false positives, known exceptions) */
  globalIgnore: string[];
  /** axe-core rule tags to include */
  axeTags: string[];
}

const config: A11yConfig = {
  baseUrl: process.env.A11Y_BASE_URL || "http://localhost:3020",
  standard: "WCAG2AA",
  threshold: 0,
  timeout: 30_000,

  pages: [
    {
      path: "/",
      label: "홈페이지",
      actions: ["wait for element .hero-gradient to be visible"],
    },
    {
      path: "/events",
      label: "이벤트 목록",
      actions: ["wait for element [data-testid='event-list'] to be visible"],
    },
    {
      path: "/events/00000000-0000-0000-0000-000000000001",
      label: "이벤트 상세",
      actions: ["wait for element [data-testid='event-detail'] to be visible"],
    },
    {
      path: "/login",
      label: "로그인",
    },
    {
      path: "/register",
      label: "회원가입",
    },
  ],

  globalIgnore: [
    // Known false positive: contrast ratio on brand gradient overlays
    "WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail",
  ],

  axeTags: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"],
};

/**
 * Generate pa11y-ci compatible config object.
 */
export function toPa11yCIConfig(cfg: A11yConfig = config) {
  return {
    defaults: {
      standard: cfg.standard,
      timeout: cfg.timeout,
      ignore: cfg.globalIgnore,
      runners: ["axe"],
    },
    urls: cfg.pages.map((page) => ({
      url: `${cfg.baseUrl}${page.path}`,
      label: page.label,
      ...(page.actions ? { actions: page.actions } : {}),
      ...(page.ignore ? { ignore: [...cfg.globalIgnore, ...page.ignore] } : {}),
    })),
  };
}

export default config;
