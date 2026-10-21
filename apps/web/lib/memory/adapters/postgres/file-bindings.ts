import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { user, workshops, workshopSources } from '@/lib/db/schema';
import { memoryFileBindings } from '@/lib/db/schema.pg';
import type { DrizzleDB } from '@/lib/db/types';
import { resolveExecutionLease } from '@/lib/work-runtime/execution-context';
import { toolLeafName } from '@/lib/agent-tools/tool-name';
import { artifactRef, lockArtifact } from './artifacts';
import { stableJson } from '../../records/observations';
import { sourceValue } from '../../sources/records';
import { MemoryModuleError } from '../../kernel/errors';
import type { FileBindingRef, FilePermission } from '../../files/contracts';

export type FileBindingRow = typeof memoryFileBindings.$inferSelect;
export type FileReadAuthority = { userId: string; workId: string; sourceId?: string; bindingId?: string;
  permission: FilePermission; tool: FileBindingRef['tool'] };
const unavailable = () => new MemoryModuleError('work_file_unavailable', 403,
  'This exact file version, current Work binding, tool permission or active lease is unavailable');
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const names = (value: unknown): string[] => Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string').map(toolLeafName) : [];
export async function readFileBindingForShare(store: DrizzleDB, input: FileReadAuthority) {
  const lease = resolveExecutionLease();
  if (!lease || lease.userId !== input.userId || lease.workshopId !== input.workId || !input.bindingId && !input.sourceId) throw unavailable();
  const [principal] = await store.select({ id: user.id }).from(user).where(eq(user.id, input.userId)).for('share');
  const [work] = await store.select().from(workshops).where(and(eq(workshops.id, input.workId), eq(workshops.userId, input.userId))).for('share');
  if (!principal || !work) throw unavailable();
  const config = record(work.modelConfig), boundary = record(work.boundaryPolicy), tool = toolLeafName(input.tool);
  const denied = new Set([...names(config.deniedTools), ...names(config.disallowedTools), ...names(boundary.hardDeniedActions)]);
  if (!names(config.allowedTools).includes(tool) || denied.has(tool)
    || input.permission === 'convert' && (input.tool !== 'workshopConvertDocument' || config.role !== 'document_markdown_cleaner')) throw unavailable();
  const [binding]: FileBindingRow[] = await store.select().from(memoryFileBindings).where(and(eq(memoryFileBindings.userId, input.userId),
    eq(memoryFileBindings.workshopId, input.workId), input.bindingId ? eq(memoryFileBindings.id, input.bindingId) : eq(memoryFileBindings.sourceId, input.sourceId!))).for('share');
  if (!binding || binding.state !== 'active' || !binding.permissions.includes(input.permission)) throw unavailable();
  const [source] = await store.select().from(workshopSources).where(and(eq(workshopSources.id, binding.sourceId), eq(workshopSources.workshopId, input.workId))).for('share');
  const manifest = await lockArtifact(store, input.userId, binding.artifactId, 'share');
  if (!source || !source.enabled || source.type !== 'file' || source.uri !== `artifact:${binding.artifactId}`
    || !manifest || manifest.state !== 'active' || artifactRef(manifest).revision !== binding.artifactRevision
    || binding.expiresAt.getTime() <= Date.now()) throw unavailable();
  const revision = `wfile1:${createHash('sha256').update(stableJson(sourceValue({ binding,
    authority: { workId: work.id, userId: work.userId, modelConfig: work.modelConfig, boundaryPolicy: work.boundaryPolicy },
    source, artifactRevision: binding.artifactRevision }))).digest('hex')}`;
  return { binding, source, manifest, revision };
}
