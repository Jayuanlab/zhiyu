// T5 reuses only fixture safety; it cannot attach to any daily runtime.
if (process.argv.slice(2).some(value => value.startsWith('--fixture='))) throw Error('The T5 launcher owns fixture selection');
process.argv.push('--fixture=t5');
await import('./memory-module-t1-isolated.mjs');
