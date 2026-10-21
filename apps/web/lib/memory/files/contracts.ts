import { z } from 'zod';
import { MemoryModuleError } from '../kernel/errors';
const commandId = z.string().trim().min(1).max(200), id = z.string().uuid();
export const importWorkspaceFileInput = z.object({ commandId, taskId: id, path: z.string().min(1).max(1000), expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export const bindWorkFileInput = z.object({ commandId, workshopId: id, sourceId: id, artifactId: id,
  expectedArtifactRevision: z.string().min(1).max(200), expectedBindingRevision: z.number().int().nonnegative().safe(),
  permissions: z.array(z.enum(['read', 'convert'])).min(1).max(2).transform(value => [...new Set(value)].sort()),
  expiresAt: z.string().datetime({ offset: true }) }).strict();
export const revokeWorkFileInput = z.object({ commandId, bindingId: id, expectedBindingRevision: z.number().int().positive().safe() }).strict();
export const readWorkFileInput = z.object({ sourceId: id, offset: z.number().int().nonnegative().safe().optional(),
  expectedRevision: z.string().regex(/^wfile1:[a-f0-9]{64}$/).optional() }).strict();
export function parseFileInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new MemoryModuleError('invalid_memory_request', 400, 'Invalid file source request');
  return result.data;
}
export type FilePermission = 'read' | 'convert';
export type FileBindingRef = { kind: 'file-binding'; id: string; revision: string; artifactId: string; artifactRevision: string;
  evidenceReceiptId: string; start: number; end: number; permission: FilePermission; tool: 'Read' | 'workshopConvertDocument' | 'getMemoryArtifact' };
