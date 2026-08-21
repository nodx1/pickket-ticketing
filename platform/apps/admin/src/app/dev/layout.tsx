import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Dev Hub — Pickket Admin",
  description: "팀 Claude Code 세션 협업 대시보드",
};

export default function DevLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
