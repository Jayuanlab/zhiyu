const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const path = require("node:path");

const port = process.env.PORT || "3515";
const baseUrl = `http://127.0.0.1:${port}`;
const developmentEntry = path.join(__dirname, "start-local-development.mjs");

const defaultRoutes = [
	"/",
	"/connectors",
	"/loops",
	"/workspace",
	"/api/auth/session",
	"/api/page-state/connectors",
	"/api/page-state/loops",
	"/api/runtime/status",
	"/api/integrations/catalog",
	"/api/preferences/ai",
	"/api/history",
	"/api/categories",
	"/api/insights",
];

const warmupRoutes = (process.env.DEV_WARMUP_ROUTES || "")
	.split(",")
	.map((route) => route.trim())
	.filter(Boolean);

const routes = warmupRoutes.length > 0 ? warmupRoutes : defaultRoutes;
const warmupEnabled = process.env.DEV_WARMUP === "1";
const bundler = process.env.DEV_BUNDLER || "webpack";
if (!["webpack", "turbo"].includes(bundler)) throw new Error("Unsupported DEV_BUNDLER");

function withDefaultNodeOptions(env) {
	const requiredOptions =
		"--max-old-space-size=8192 --require ./scripts/patch-http-timeout.cjs";
	return {
		...env,
		PORT: port,
		TURBOPACK: bundler === "turbo" ? "1" : "",
		NODE_OPTIONS: env.NODE_OPTIONS || requiredOptions,
	};
}

async function fetchWithTimeout(url, timeoutMs = 60000) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, {
			signal: controller.signal,
			headers: {
				Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
				"x-openzhiyu-dev-warmup": "1",
			},
		});
	} finally {
		clearTimeout(timeout);
	}
}

async function waitForServer() {
	const startedAt = performance.now();
	let lastError = "";

	while (performance.now() - startedAt < 120000) {
		try {
			await fetchWithTimeout(baseUrl, 5000);
			return;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	}

	throw new Error(`Next dev server did not become reachable: ${lastError}`);
}

async function warmRoute(route) {
	const url = `${baseUrl}${route}`;
	const startedAt = performance.now();
	try {
		const response = await fetchWithTimeout(url);
		const elapsedMs = Math.round(performance.now() - startedAt);
		console.log(`[warmup] ${route} -> ${response.status} (${elapsedMs}ms)`);
	} catch (error) {
		const elapsedMs = Math.round(performance.now() - startedAt);
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[warmup] ${route} failed after ${elapsedMs}ms: ${message}`);
	}
}

async function runWarmup() {
	if (!warmupEnabled) {
		console.log("[warmup] disabled; set DEV_WARMUP=1 to precompile routes");
		return;
	}

	try {
		console.log(`[warmup] waiting for ${baseUrl}`);
		await waitForServer();
		const concurrency = Number(process.env.DEV_WARMUP_CONCURRENCY || "1");
		console.log(
			`[warmup] precompiling ${routes.length} routes (concurrency=${concurrency})`,
		);
		for (let index = 0; index < routes.length; index += concurrency) {
			await Promise.all(
				routes.slice(index, index + concurrency).map(warmRoute),
			);
		}
		console.log("[warmup] done");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[warmup] skipped: ${message}`);
	}
}

const child = spawn(process.execPath, [developmentEntry, "--hostname", "127.0.0.1", "--port", port], {
	cwd: process.cwd(),
	env: withDefaultNodeOptions(process.env),
	stdio: "inherit",
	windowsHide: true,
});

child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
	}
	process.exit(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		child.kill(signal);
	});
}

setTimeout(() => {
	void runWarmup();
}, 1000);
