/**
 * App Providers component
 * Unified management of all Providers, reduces nesting depth
 * Uses lazy initialization to defer loading of non-critical Providers
 */

"use client";

import { CloudSyncInit } from "@/components/cloud-sync-init";
import { InsightOptimisticProvider } from "@/components/insight-optimistic-context";
import { InsightRefreshInit } from "@/components/insight-refresh-init";
import { MobileBackButton } from "@/components/mobile-back-button";
import { MobileLayoutWrapper } from "@/components/mobile-layout-wrapper";
import { SessionProvider } from "next-auth/react";
import { Suspense, memo, useEffect, useState } from "react";

function useDeferredMount(delayMs = 1500) {
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}

		let cancelled = false;
		let idleId: number | undefined;

		const mount = () => {
			if (!cancelled) {
				setMounted(true);
			}
		};

		const timeoutId = setTimeout(() => {
			const requestIdleCallback = window.requestIdleCallback;
			if (typeof requestIdleCallback === "function") {
				idleId = requestIdleCallback(mount, { timeout: 4000 });
			} else {
				mount();
			}
		}, delayMs);

		return () => {
			cancelled = true;
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
			if (
				idleId !== undefined &&
				typeof window.cancelIdleCallback === "function"
			) {
				window.cancelIdleCallback(idleId);
			}
		};
	}, [delayMs]);

	return mounted;
}

// Lazy load initialization components - use Suspense boundaries to avoid blocking initial render
const IntegrationInitComponents = memo(() => {
	const shouldMount = useDeferredMount();

	if (!shouldMount) {
		return null;
	}

	return (
		<Suspense fallback={null}>
			<CloudSyncInit />
			<InsightRefreshInit />
		</Suspense>
	);
});

IntegrationInitComponents.displayName = "IntegrationInitComponents";

// Lazy load mobile components
const MobileComponents = memo(() => (
	<Suspense fallback={null}>
		<MobileBackButton />
	</Suspense>
));

MobileComponents.displayName = "MobileComponents";

/**
 * Core app content - only includes necessary initialization
 */
export function AppContent({ children }: { children: React.ReactNode }) {
	return <InsightOptimisticProvider>{children}</InsightOptimisticProvider>;
}

/**
 * Complete app Provider tree
 */
export function AppProviders({ children }: { children: React.ReactNode }) {
	return (
		<SessionProvider>
			{/* Lazy load integration initialization components */}
			<IntegrationInitComponents />
			<MobileLayoutWrapper>
				<MobileComponents />
				<AppContent>{children}</AppContent>
			</MobileLayoutWrapper>
		</SessionProvider>
	);
}
