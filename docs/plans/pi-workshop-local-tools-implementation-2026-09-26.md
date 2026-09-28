# Pi Workshop local file and command tools

Implemented 2026-09-26 for desktop Web and its server runtime. This extends the existing Pi Harness adapter with local tools; it does not replace the Work/Loop controller.

## Control loop

- Controlled object: files produced by one Work run. Original file sources remain outside the run directory.
- Observation: enabled `file` sources with absolute local paths are copied to `inputs/` under the run directory. The run records source ID, canonical path, copy path, size, SHA-256, and explicit staging warnings.
- State: the run directory holds input copies, generated scripts, outputs, and `inputs/index.json`; Workshop events record staging and tool calls/results. Write/Edit tool results include the resulting file hash.
- Actions: Pi may use `Read`, `Edit`, `Write`, `Bash`, and (on Windows) `PowerShell` only when the Work explicitly lists each name in `modelConfig.allowedTools`. The Work must select the Pi runtime to use these tools.
- Boundary: `disallowedTools` and `hardDeniedActions` override grants. Local tool calls re-read current Work permissions before execution, so revocation takes effect during a run. File tools resolve real paths and reject paths outside the run directory; Write/Edit reject `inputs/`. Shell execution has a 60-second maximum per call and a reduced environment. Shell tools retain the host process's filesystem and OS access; the run directory is **not** an OS sandbox. Only grant shell execution to a Work trusted to run code with that access.
- Feedback: command output and failures are captured in Workshop events. Staging failures are visible as degraded source events and in the Pi prompt. Run cancellation is forwarded to the tool; an already completed side effect is not rolled back.
- Human control: the owner can grant or revoke the tools through Work configuration and pause the Work. Newly generated data stays in the run directory; it is not automatically written back to the original source.

For a Windows data-cleaning Work, configure `agentRuntimeEngine: pi` and explicitly allow `Read`, `Write`, `Edit`, and `PowerShell`. Add the dataset as an enabled `file` source with an absolute local `uri`. `Bash` can be granted instead where a Bash executable is available. The agent receives the staged copy paths in its run prompt and should inspect the output before reporting completion.

## Verification

- `pnpm --filter web tsc --noEmit --pretty false`: passed.
- Four targeted unit suites, 52 tests: passed, covering path bounds, staged source copies, writes, permission revocation, and tool matrix display.
- `node --import tsx scripts/smoke-pi-local-tools.mts` in `apps/web`: passed on Windows. A faux Pi Harness run called Write, PowerShell, and Read in sequence; Python reduced three source rows to two output rows.
- `ZHIYU_REVIEW_BUILD=01 pnpm --filter web build`: passed with an isolated Next build directory.

This verification does not establish an OS sandbox for generated code or prove model-written cleaning rules on a user dataset. Those require a dedicated execution boundary and a real data-quality acceptance run before granting autonomous processing of sensitive sources.
