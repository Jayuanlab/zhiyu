import { localFontClasses, localFontPreloads } from "./local-fonts";
import { ThemeProvider } from "@/components/theme-provider";
import { I18nProvider } from "@/components/i18n-provider";
import { TooltipProvider } from "@openzhiyu/ui";

import "./globals.css";
import "./local-fonts.css";
import "remixicon/fonts/remixicon.css";
import { Suspense } from "react";
import { SonnerToaster } from "@/components/sonner-toaster";
import { MotionConfigProvider } from "@/components/motion-config-provider";
import { GeddleScript } from "@/components/geddle-script";
import { AppProviders } from "@/components/app-providers";

export const metadata = {
  title: "Zhiyu",
  description: "Local-first personal agent workbench",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      data-scroll-behavior="smooth"
      className={localFontClasses}
      // `next-themes` injects an extra classname to the body element to avoid
      // visual flicker before hydration. Hence the `suppressHydrationWarning`
      // prop is necessary to avoid the React hydration mismatch warning.
      // https://github.com/pacocoursey/next-themes?tab=readme-ov-file#with-app
      suppressHydrationWarning
    >
      <head>
        {localFontPreloads.map((href) => (
          <link key={href} rel="preload" href={href} as="font" type="font/woff2" crossOrigin="anonymous" />
        ))}
        <Suspense fallback={null}>
          <GeddleScript />
        </Suspense>
      </head>
      <body className="antialiased" suppressHydrationWarning>
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem
          disableTransitionOnChange
        >
          <MotionConfigProvider>
            <I18nProvider>
              <TooltipProvider>
                <SonnerToaster />
                <AppProviders>{children}</AppProviders>
              </TooltipProvider>
            </I18nProvider>
          </MotionConfigProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
