if (process.argv.some(arg => arg.startsWith('--fixture='))) throw Error('T7 fixture selector is fixed');
process.argv.push('--fixture=t7');
await import('./memory-module-t1-isolated.mjs');
