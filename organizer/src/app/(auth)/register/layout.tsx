/**
 * `register/page.tsx` 는 `"use client"` 라 `metadata` 를 export 할 수 없다
 * (Next 제약 — 클라이언트 컴포넌트는 metadata 를 내보내지 못한다).
 * 그래서 같은 세그먼트에 **서버 layout** 을 두고 여기서 title 을 준다.
 *
 * 루트 layout 의 `title.template`("%s — PICKKET.GO")이 브랜드명을 붙인다.
 * 🔴 여기에 브랜드명을 다시 쓰면 "… — PICKKET.GO — PICKKET.GO" 가 된다.
 */
import type { Metadata } from "next";

export const metadata: Metadata = { title: "회원가입" };

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return children;
}
