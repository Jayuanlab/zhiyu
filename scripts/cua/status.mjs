for (const [backend, port, consolePort] of [
  ["javascript", 4001, 3000],
  ["python", 4041, 3001],
]) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/capabilities`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const capability = await response.json();
    if (capability.backendId !== backend) throw new Error(`expected ${backend}, got ${capability.backendId}`);
    console.log(`${backend}: running; model ${capability.defaults?.model ?? "unknown"}; code tool ${capability.codeTool}; Responses key ${capability.apiKeyConfigured ? "configured" : "missing"}; console http://127.0.0.1:${consolePort}`);
  } catch (error) {
    console.log(`${backend}: unavailable (${error instanceof Error ? error.message : String(error)})`);
    process.exitCode = 1;
  }
}
