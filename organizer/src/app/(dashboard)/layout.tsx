import { redirect } from "next/navigation";
import { NOT_ORGANIZER_LOGIN_PATH } from "@/lib/auth/not-organizer";
import { getServerSessionResult } from "@/lib/auth/server-session";
import { Header } from "@/components/layout/header";
import { DashboardSidebar } from "@/components/layout/dashboard-sidebar";
import { TutorialProvider } from "@/components/tutorial/tutorial-provider";
import { CommandPaletteProvider } from "./command-palette-provider";
import { MobileSidebar } from "./mobile-sidebar";
import { MobileBottomNav } from "@/components/layout/mobile-bottom-nav";
import { MfaReminderBanner } from "@/components/shared/mfa-reminder-banner";

export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { session, failure } = await getServerSessionResult();
  if (!session) {
    // 피켓 팬 계정으로 로그인된 채 들어오면 로그인 화면에서 「주최사 계정으로」 안내한다.
    redirect(failure === "not_organizer" ? NOT_ORGANIZER_LOGIN_PATH : "/login");
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <MfaReminderBanner />
      <div className="flex min-h-0 flex-1">
      <div className="hidden lg:block">
        <DashboardSidebar />
      </div>
      <div className="flex min-h-screen min-w-0 flex-1 flex-col overflow-x-hidden px-4 py-4 pb-20 lg:px-8 lg:py-6 lg:pb-6">
        <div className="flex items-center gap-3">
          <MobileSidebar />
          <div className="flex-1">
            <Header />
          </div>
        </div>
        <div className="mt-6 flex-1">{children}</div>
      </div>
      <MobileBottomNav />
      <CommandPaletteProvider />
      <TutorialProvider />
      </div>
    </div>
  );
}
