import { AsyncLocalStorage } from 'node:async_hooks';
const modelScopes = new AsyncLocalStorage<true>();
/** Presence survives detached descendants so their closed dispatch scope can
 * still fail closed. This flag grants no permission or source proof. */
export function hasMemoryModelScope(): boolean { return modelScopes.getStore() === true; }
export function withMemoryModelSourceScope<T>(work: () => Promise<T>): Promise<T> { return modelScopes.run(true, work); }
