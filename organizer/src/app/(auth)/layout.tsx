import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth/server-session";

/**
 * 인증 페이지 (login / register / forgot-password / reset-password / accept-invitation) layout.
 * 이미 로그인된 사용자가 들어오면 메인으로 자동 이동.
 */
export default async function AuthLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getServerSession();
  if (session) {
    redirect("/events");
  }
  return children;
}
