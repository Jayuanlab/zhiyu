import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export class WorkspaceListingBoundaryError extends Error {
  constructor() { super('Workspace path is unavailable or outside the authorized task.'); }
}

/** Listing never follows symlinks/junctions, including a replaced task root. */
export function resolveSessionListingPath(root: string, requested = ''): string {
  const base = resolve(root);
  const target = resolve(base, requested);
  const rel = relative(base, target);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new WorkspaceListingBoundaryError();
  if (lstatSync(base).isSymbolicLink()) throw new WorkspaceListingBoundaryError();
  const realBase = realpathSync(base);
  let current = base;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    if (lstatSync(current).isSymbolicLink()) throw new WorkspaceListingBoundaryError();
  }
  const realTarget = realpathSync(target);
  const realRel = relative(realBase, realTarget);
  if (isAbsolute(realRel) || realRel === '..' || realRel.startsWith(`..${sep}`)) throw new WorkspaceListingBoundaryError();
  return target;
}
