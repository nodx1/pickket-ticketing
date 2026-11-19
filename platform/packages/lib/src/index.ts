export { default as api, setBehaviorTokenProvider, setLoginRedirectPolicy } from "./api";
export * from "./constants";
export * from "./domain-config";
export * from "./env";
export * from "./utils";
export * from "./format";
export * from "./all-in-pricing";

// Adapter patterns for platform-agnostic reuse (web + mobile)
export * from "./api-config";
export * from "./storage-adapter";
export * from "./market-stream-adapter";

// Promoted business logic (previously consumer-only)
export * from "./pickket-score";
export * from "./dna-test";
export * from "./bot-detection";
export { blurhashToDataURL, isValidBlurhash } from "./blurhash";
export { pickImage } from "./image";

// P1-5: Behavior tracking
export {
  trackEvent,
  trackPageView,
  flushTracking,
  useTracking,
} from "./tracking";
export type { TrackingEventType, TrackingTargetType } from "./tracking";

// P1-10: A/B Testing experiments
export { useExperiment } from "./experiments";

// Monitoring: Web Vitals reporter (shared across consumer/admin)
export { WebVitalsReporter } from "./components/WebVitalsReporter";

// Cross-codebase contracts (v2/go/app 공유 계약)
export * from "./contracts";
