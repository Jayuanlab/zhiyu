import { cookies } from "next/headers";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@openzhiyu/ui";
import CookieConfirm from "@/components/cookie-confirm";
import "../../i18n";
import { isTauriMode } from "@/lib/env/constants";
import { Suspense } from "react";
import { GlobalInsightDrawerProvider } from "@/components/global-insight-drawer";
import { SidePanelShell } from "@/components/agent/side-panel-shell";
import { SidePanelProvider } from "@/components/agent/side-panel-context";
import { ChatContextProvider } from "@/components/chat-context";
import { SessionAuthChecker } from "@/components/session-auth-checker";
import { ConversationApiOnboardingGuard } from "@/components/conversation-api-onboarding-guard";
import { UxPageMetricsProbe } from "@/components/ux-page-metrics-probe";
import { NavigationProgress } from "@/components/workbench/navigation-progress";
import { PageScrollRestoration } from "@/components/workbench/page-scroll-restoration";

export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const userCookieConfirm = cookieStore.get("user-cookie:confirm")?.value;

  return (
    <>
      <SessionAuthChecker />
      <UxPageMetricsProbe />
      <NavigationProgress />
      <PageScrollRestoration />
      <ConversationApiOnboardingGuard>
        <SidebarProvider defaultOpen={true}>
          <AppSidebar />
          <SidebarInset className="relative z-10 bg-[var(--product-canvas)] p-2 pl-0 sm:p-2 sm:pl-0 md:m-0 md:h-svh md:max-h-svh md:overflow-hidden">
            <Suspense fallback={null}>
              {/* SidePanelShell renders main content + temporary sidebar (flex-row) */}
              <SidePanelProvider>
                <ChatContextProvider>
                  <GlobalInsightDrawerProvider>
                    <SidePanelShell>{children}</SidePanelShell>
                  </GlobalInsightDrawerProvider>
                </ChatContextProvider>
              </SidePanelProvider>
            </Suspense>
          </SidebarInset>
        </SidebarProvider>
      </ConversationApiOnboardingGuard>
      {!isTauriMode() && (
        <CookieConfirm userCookieConfirm={userCookieConfirm} />
      )}
    </>
  );
}
