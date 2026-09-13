"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useIsMobile } from "@openzhiyu/hooks/use-is-mobile";
import { RemixIcon } from "@/components/remix-icon";
import { Button } from "@openzhiyu/ui";
import { getHomePath } from "@/lib/utils";

/**
 * Mobile back button component
 * Displays on non-chat pages, click to return to chat page
 */
export function MobileBackButton() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const isMobile = useIsMobile();

  // Get query parameter
  const page = searchParams?.get("page");

  // Determine if currently on a chat-related page (excluding cases with page query param)
  // When page query param exists, it's other feature pages (e.g., subscription, integrations), not chat pages
  const isChatPage =
    (pathname === "/" || pathname.startsWith("/chat/")) && !page;

  // Exclude auth pages like login, register
  const isAuthPage =
    pathname.startsWith("/login") ||
    pathname.startsWith("/register") ||
    pathname.startsWith("/forgot-password") ||
    pathname.startsWith("/reset-password");

  /**
   * Handle back button click
   */
  const handleBack = () => {
    const fromUserMenu = searchParams?.get("fromUserMenu");

    // If entered from user menu, back should go to menu (remove page param but keep fromUserMenu)
    // This keeps the menu open
    if (fromUserMenu === "true") {
      router.push(`${getHomePath()}?fromUserMenu=true`);
    } else {
      router.push(getHomePath());
    }
  };

  // Only show on mobile, non-chat pages, non-auth pages
  if (!isMobile || isChatPage || isAuthPage) {
    return null;
  }

  return (
    <nav aria-label="移动页面导航" className="flex shrink-0 items-center border-b bg-background px-4 py-2 pt-[calc(env(safe-area-inset-top,0px)+0.5rem)] md:hidden">
    <Button
      variant="ghost"
      size="icon"
      onClick={handleBack}
      className="h-10 w-auto gap-2 px-2"
      aria-label="返回主页"
    >
      <RemixIcon name="arrow_left" size="size-5" />
      <span>返回主页</span>
    </Button>
    </nav>
  );
}
