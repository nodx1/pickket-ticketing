"use client";

import dynamic from "next/dynamic";
import { puckConfig } from "@/app/s/[subdomain]/_lib/puck-render-config";

const Render = dynamic(
  () => import("@measured/puck").then((mod) => mod.Render),
  { ssr: false },
);

interface PuckRendererProps {
  data: Record<string, unknown>;
}

export function PuckRenderer({ data }: PuckRendererProps) {
  if (!data || !data.content) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <Render config={puckConfig} data={data as any} />;
}
