"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { Toaster } from "@pickket/ui";
import { CONSUMER_URL, api } from "@pickket/lib";
import { useAuthStore } from "@pickket/store";
import { usePagePermission } from "../hooks/usePermission";

import AdminSidebar from "./AdminSidebar";
import MobileSidebar from "./MobileSidebar";
import PortalHeader from "./PortalHeader";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, setAuth, logout, hydrate } = useAuthStore();
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [ready, setReady] = useState(false);

  const handleLogout = useCallback(() => {
    logout();
    router.replace("/auth");
  }, [logout, router]);

  // On mount: clear any stale persisted auth and then bootstrap from cookie.
  useEffect(() => {
    hydrate();

    // After hydrate, check if we already have a user in store
    const stored = useAuthStore.getState();
    if (stored.user) {
      setReady(true);
      return;
    }

    const hasSession = document.cookie.includes("pickket_logged_in=1");
    if (!hasSession) {
      setReady(true);
      return;
    }
    // axios api 인스턴스 사용 — 401 시 인터셉터가 자동 refresh, 실패 시 /auth 리다이렉트.
    // plain fetch 를 쓰면 인터셉터가 안 끼어 access 만료 시 logged-out 상태가 되고
    // stale store 와 결합해 일반유저페이지로 튕기는 버그 발생.
    api
      .get("/users/me")
      .then((res) => {
        if (res.data) setAuth(res.data, "cookie");
      })
      .catch(() => {
        // 인터셉터가 401 처리 후에도 실패하면 store 비우기 — stale user 로 admin 판정 X
        useAuthStore.getState().logout();
      })
      .finally(() => setReady(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Redirect if not admin / 만료 — 무조건 /auth (consumer 로 튕기지 않음)
  useEffect(() => {
    if (pathname === "/auth") return;
    if (!ready) return;

    const state = useAuthStore.getState();
    if (!state.user || !state.user.is_admin) {
      // 미로그인 또는 admin 권한 없음 → admin 자체 로그인 페이지로
      // (이전엔 일반유저면 CONSUMER_URL 로 보냈으나 로그인 만료 시 stale store 로
      // 의도치 않게 consumer 로 튕기는 문제 있어 admin/auth 통일)
      if (state.user && !state.user.is_admin) {
        useAuthStore.getState().logout();
      }
      router.replace(`/auth?callbackUrl=${encodeURIComponent(pathname)}`);
    }
  }, [pathname, router, ready, user]);

  const hasAccess = usePagePermission(pathname);

  useEffect(() => {
    if (!ready) return;
    if (pathname === "/auth") return;
    if (!hasAccess && pathname !== "/") {
      router.push("/");
    }
  }, [pathname, hasAccess, ready, router]);

  const closeMobile = useCallback(() => setMobileOpen(false), []);

  if (pathname === "/auth") {
    return (
      <>
        {children}
        <Toaster position="bottom-right" richColors />
      </>
    );
  }

  return (
    <>
      <PortalHeader
        consumerUrl={CONSUMER_URL}
        onMenuToggle={() => setMobileOpen((prev) => !prev)}
      />
      <AdminSidebar onLogout={handleLogout} />
      <MobileSidebar
        open={mobileOpen}
        onClose={closeMobile}
        onLogout={handleLogout}
      />
      <main
        id="main-content"
        className="pt-14 md:ml-[220px] min-h-screen bg-background"
      >
        {ready ? (
          children
        ) : (
          <div className="flex items-center justify-center min-h-[50vh]">
            <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
          </div>
        )}
      </main>
      <Toaster position="bottom-right" richColors />
    </>
  );
}
