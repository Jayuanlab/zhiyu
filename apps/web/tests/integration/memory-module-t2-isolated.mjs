// Reuse the accepted isolated database/runtime safeguards; never run the T1 suite.
// Defaults: development stage 73 / port 3573; production stage 74 / port 3574.
// Run from apps/web using node --import tsx --conditions=react-server.
if (process.argv.slice(2).some(value => value.startsWith('--fixture='))) {
  throw Error('The T2 launcher owns its fixture selection');
}
process.argv.push('--fixture=t2');
await import('./memory-module-t1-isolated.mjs');
