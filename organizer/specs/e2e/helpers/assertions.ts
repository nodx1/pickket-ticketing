import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

const ignoredConsolePatterns = [
  /Refused to display .*X-Frame-Options.*deny/i,
  /Minified React error #418/i,
  /Minified React error #423/i,
  /Failed to load resource.*404/i,
  /Failed to load resource.*the server responded/i,
];

export function trackCriticalConsoleErrors(page: Page) {
  const errors: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") {
      const text = message.text();
      if (!ignoredConsolePatterns.some((pattern) => pattern.test(text))) {
        errors.push(text);
      }
    }
  });

  page.on("pageerror", (error) => {
    if (!ignoredConsolePatterns.some((pattern) => pattern.test(error.message))) {
      errors.push(error.message);
    }
  });

  return errors;
}

export async function expectNoCriticalConsoleErrors(errors: string[]) {
  await expect.poll(() => errors, { timeout: 500 }).toEqual([]);
}
