// Reuses isolated DB, configuration ownership, source freeze and owned server
// safeguards. It selects only the T3 checks and applies every migration.
if (process.argv.slice(2).some(value => value.startsWith('--fixture='))) throw Error('The T3 launcher owns fixture selection');
process.argv.push('--fixture=t3');
await import('./memory-module-t1-isolated.mjs');
