// T4 owns only its new suite; T1/T2/T3 acceptance paths remain separate.
// Defaults: owned dev35/3635 and fresh production36/3636 (root runs production).
if (process.argv.slice(2).some(value => value.startsWith('--fixture='))) throw Error('The T4 launcher owns fixture selection');
process.argv.push('--fixture=t4');
await import('./memory-module-t1-isolated.mjs');
