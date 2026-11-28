"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { canSeeSection, firstAllowedPath, sectionForPath } from "@/lib/auth/sections";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { AccountAccessAlert } from "@/components/layout/account-access-alert";
import { PlanModuleNotice } from "@/components/plans/plan-gates";
import { ReadOnlyArea } from "@/lib/plans/read-only-context";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";
import { BrowserNotificationsListener } from "@/components/notifications/browser-notifications-listener";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { user, loading, profileLoading, accountRole, allowedSections, planLocked } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  // A member limited to some sections (migration 076) cannot open the
  // others by typing the address: they are sent to their first allowed
  // page. The database enforces the same list, so this is about not
  // showing an empty screen, not about security.
  const section = sectionForPath(pathname ?? "");
  const blocked =
    !!user && !profileLoading && !!accountRole && !!section && !canSeeSection(accountRole, allowedSections, section);
  useEffect(() => {
    if (blocked) router.replace(firstAllowedPath(accountRole, allowedSections));
  }, [blocked, router, accountRole, allowedSections]);
  const t = useTranslations("DashboardShell");

  // Sidebar drawer state — only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        </div>
      </div>
    );
  }

  if (!user) return null;
  // Do not flash a page the member may not see while the redirect runs.
  const hideContent = blocked || (!!section && profileLoading);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Reports this tab's online/away presence once we know a user is
          signed in. Headless — renders nothing. */}
      <PresenceHeartbeat />
      {/* Desktop alerts for new customer messages (opt-in via Settings →
          Your profile). Headless — renders nothing. */}
      <BrowserNotificationsListener />
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onOpenSidebar={() => setSidebarOpen(true)} />
        {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          {/* Above every page: writes are being rejected and here's why.
              Renders nothing unless the account/role failed to resolve. */}
          <AccountAccessAlert />
          {hideContent ? null : <PlanModuleNotice />}
          {hideContent ? null : planLocked ? (
            // Every button, box and file picker on the page is switched
            // off by the browser itself, whatever the page is made of.
            // Links still work, and the server refuses changes too.
            <fieldset disabled aria-readonly="true" className="plan-read-only m-0 min-w-0 border-0 p-0">
              {/* Switches and tick boxes drawn with spans ask this. */}
              <ReadOnlyArea>{children}</ReadOnlyArea>
            </fieldset>
          ) : (
            children
          )}
        </main>
      </div>
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
