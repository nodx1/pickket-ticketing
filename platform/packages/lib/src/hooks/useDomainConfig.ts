"use client";

import { useMemo } from "react";

import { getDomainLabels, type DomainLabels } from "../domain-config";

export function useDomainConfig(category?: string | null): DomainLabels {
  return useMemo(() => getDomainLabels(category), [category]);
}
