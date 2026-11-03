const { spawn } = require('node:child_process');

// The direct Next entry uses 77 to request a fresh process, just like next dev's
// CLI worker. Keep the managed application's worker alive during that restart.
function superviseDevServer(args, options, hooks = {}) {
  const start = hooks.spawn || spawn;
  const finish = hooks.exit || ((code) => process.exit(code));
  const now = hooks.now || Date.now;
  const warn = hooks.warn || console.warn;
  let child;
  let stopping = false;
  const restarts = [];
  const launch = () => {
    child = start(process.execPath, args, options);
    child.once('error', () => finish(1));
    child.once('exit', (code, signal) => {
      if (!stopping && !signal && code === 77) {
        const at = now();
        while (restarts.length && restarts[0] < at - 300000) restarts.shift();
        if (restarts.length < 3) {
          restarts.push(at);
          warn(
            '[dev] Next requested a restart; starting a fresh development server',
          );
          launch();
          return;
        }
        warn(
          '[dev] Restart limit reached (3 in 5 minutes); stopping for inspection',
        );
      }
      finish(stopping ? 0 : signal ? 1 : (code ?? 0));
    });
  };
  launch();
  return {
    stop(signal) {
      stopping = true;
      child.kill(signal);
    },
  };
}

module.exports = { superviseDevServer };
