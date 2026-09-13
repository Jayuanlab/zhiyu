import Module from 'node:module';
import { config } from 'dotenv';

type ModuleLoad = (
  this: unknown,
  request: string,
  parent: unknown,
  isMain: boolean,
) => unknown;

const moduleWithLoad = Module as unknown as { _load: ModuleLoad };
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request, parent, isMain) {
  if (request === 'server-only' || request.includes('server-only')) {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

config({ path: '.env' });
config({ path: '.env.local', override: false });
const { runtimeMode } = await import('../lib/runtime/mode');
if (runtimeMode() !== 'embedded') {
  console.log(JSON.stringify({ event: 'legacy_heartbeat_not_started', mode: runtimeMode() }));
  process.exit(0);
}
process.env.IS_TAURI ??= 'true';

const {
  getTauriDataDir,
  getTauriDbPath,
  getTauriStoragePath,
  getTauriLogsPath,
} = await import('../lib/utils/path');

process.env.TAURI_DATA_DIR ??= getTauriDataDir();
process.env.TAURI_DB_PATH ??= getTauriDbPath();
process.env.TAURI_STORAGE_PATH ??= getTauriStoragePath();
process.env.TAURI_LOGS_PATH ??= getTauriLogsPath();

function cliValue(name: string) {
  const prefix = `--${name}=`;
  return process.argv
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

const userId = cliValue('userId');
if (!userId) {
  throw new Error('Missing required --userId=<id>');
}

const intervalMs = Math.max(
  5_000,
  Number.parseInt(cliValue('intervalMs') ?? '60000', 10),
);
const { runDueWorkshopHeartbeats, getWorkshopHeartbeatSchedulerStatus } =
  await import('../lib/workshops/heartbeat-scheduler');

let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const result = await runDueWorkshopHeartbeats({ userId });
    if (result.queued > 0 || result.skipped > 0 || result.errors.length > 0) {
      console.log(
        `[WorkshopHeartbeatScheduler] tick ${new Date().toISOString()} ${JSON.stringify(
          result,
        )}`,
      );
    }
  } catch (error) {
    console.error(
      `[WorkshopHeartbeatScheduler] tick failed ${new Date().toISOString()}`,
      error,
    );
  } finally {
    ticking = false;
  }
}

console.log(
  `[WorkshopHeartbeatScheduler] started for user ${userId}; intervalMs=${intervalMs}; status=${JSON.stringify(
    getWorkshopHeartbeatSchedulerStatus(),
  )}; db=${process.env.TAURI_DB_PATH}`,
);

await tick();
setInterval(tick, intervalMs);

setInterval(() => undefined, 2_147_483_647);
