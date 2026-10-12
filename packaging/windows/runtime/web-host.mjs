import { pathToFileURL } from 'node:url';
import { Server } from 'node:net';

// Next's standalone server is an IPC-owned child, so a crashed manager cannot
// leave an unaudited web process behind. Install this listener before loading Next.
let stopPromise;
function stop(reason) {
  if (stopPromise) return stopPromise;
  stopPromise = (async () => {
    const quant = globalThis[Symbol.for('zhiyu.quant.embeddedTransport')];
    try {
      if (quant?.closeAndWait) await quant.closeAndWait('web_stop');
      else if (quant?.close) throw new Error('quant_stop_confirmation_missing');
      if (process.connected) await new Promise(resolve => process.send({ event: 'web_components_stopped', hostPid: process.pid, confirmed: true }, () => resolve()));
    } catch {
      if (process.connected) await new Promise(resolve => process.send({ event: 'web_components_stopped', hostPid: process.pid, confirmed: false }, () => resolve()));
      console.error(JSON.stringify({ event: 'web_components_stop_unconfirmed', reason: 'quant_stop_unconfirmed' }));
      process.exitCode = 1;
    }
    if (reason === 'parent_disconnect') process.exitCode = 1;
    process.kill(process.pid, 'SIGTERM');
  })();
  return stopPromise;
}
process.once('disconnect', () => { void stop('parent_disconnect'); });
process.on('message', message => { if (message === 'stop') void stop('parent_stop'); });
// Report a listening socket from this child itself. An HTTP response alone can
// come from a different program that won a race for the selected local port.
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  this.once('listening', () => {
    const address = this.address();
    if (address && typeof address === 'object' && address.port === Number(process.env.PORT) && address.address === '127.0.0.1' && process.connected) {
      process.send({ event: 'web_listening', pid: process.pid, port: address.port }, () => {});
    }
  });
  return Reflect.apply(listen, this, args);
};
const entry = process.argv[2];
if (!entry || !process.connected) throw new Error('managed_web_entry_required');
await import(pathToFileURL(entry).href);
