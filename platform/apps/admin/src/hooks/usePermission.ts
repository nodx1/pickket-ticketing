"use client";

import { useAuthStore } from "@pickket/store";

export const ROLE_SCOPES: Record<string, Set<string>> = {
  super_admin: new Set(["*"]),
  viewer: new Set(["dashboard.view"]),
  moderator: new Set([
    "users.manage",
    "events.manage",
    "communities.manage",
    "audit.view",
  ]),
  finance_admin: new Set([
    "finance.view",
    "orders.manage",
    "organizers.manage",
    "refunds.approve",
    "settlements.review",
    "settlements.approve",
  ]),
  cs_agent: new Set([
    "users.manage",
    "orders.manage",
    "notifications.send",
    "cs.manage",
  ]),
};

export function useUserRole(): string {
  const { user } = useAuthStore();
  return user?.admin_role || "viewer";
}

export function usePermission(scope: string): boolean {
  const role = useUserRole();
  const allowed = ROLE_SCOPES[role];
  if (!allowed) return false;
  return allowed.has("*") || allowed.has(scope);
}

export function usePermissions(scopes: string[]): boolean {
  const role = useUserRole();
  const allowed = ROLE_SCOPES[role];
  if (!allowed) return false;
  if (allowed.has("*")) return true;
  return scopes.some((s) => allowed.has(s));
}

// Path -> required scope mapping
const PATH_SCOPE_MAP: Record<string, string> = {
  "/": "dashboard.view", // all roles can access dashboard
  "/users": "users.manage",
  "/events": "events.manage",
  "/onboarding": "organizers.manage",
  "/finance": "finance.view",
  "/orders": "orders.manage",
  "/notifications": "notifications.send",
  "/communities": "communities.manage",
  "/template-requests": "communities.manage",
  "/roles": "*", // super_admin only
  "/settings": "*", // super_admin only
  "/reports": "finance.view",
  "/audit": "audit.view",
  "/system": "*", // super_admin only
  "/refunds": "refunds.approve",
  "/settlements": "settlements.approve",
  "/resale": "events.manage",
  "/queue": "events.manage",
  "/moderation": "communities.manage",
  "/cs": "cs.manage",
  "/partners": "organizers.manage",
  "/feature-flags": "*",
  "/dev": "audit.view", // MCP dev dashboard — all admins
  "/benchmarking": "finance.view",
  "/cohort": "finance.view",
  "/experiments": "*",
  "/fan-requests": "events.manage",
  "/funnel": "finance.view",
  "/slo": "*",
  "/traffic": "finance.view",
};

export function usePagePermission(pathname: string): boolean {
  const role = useUserRole();
  const allowed = ROLE_SCOPES[role];
  if (!allowed) return false;
  if (allowed.has("*")) return true;
  if (pathname === "/") return allowed.has(PATH_SCOPE_MAP["/"]);

  // Find matching path
  const matchedPath = Object.keys(PATH_SCOPE_MAP)
    .filter((p) => p !== "/")
    .find((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (!matchedPath) return false; // default-deny unknown paths
  const requiredScope = PATH_SCOPE_MAP[matchedPath];
  if (requiredScope === "*") return allowed.has("*"); // super_admin only
  return allowed.has(requiredScope);
}
