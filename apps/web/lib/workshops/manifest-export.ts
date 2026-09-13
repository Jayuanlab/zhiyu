import YAML from 'yaml';
import {sql} from 'drizzle-orm';
import {db} from '@/lib/db/client';
import type {DrizzleDB} from '@/lib/db/types';
import type {WorkshopSource} from '@/lib/db/schema';
import {listLoopsForWorkshop, listLoopStatesByLoopId} from '@/lib/loops/service';
import {getWorkshop, listWorkshopSources} from './service';

/** The editor reads configuration and its command version from one MVCC
 * snapshot. Dashboard summaries deliberately omit editable policy fields. */
export async function exportWorkshopManifest(userId: string, workshopId: string) {
  if (process.env.TAURI_MODE === 'true' || process.env.IS_TAURI === 'true') throw new Error('Manifest editing requires PostgreSQL');
  return db.transaction(async (tx: DrizzleDB) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    const workshop = await getWorkshop(userId, workshopId, tx);
    if (!workshop) return null;
    const versions = await tx.execute(sql`SELECT version FROM work_command_targets WHERE workshop_id=${workshopId}::uuid`);
    const loops = await listLoopsForWorkshop({userId, workshopId, limit: 10001}, tx);
    const sources = await listWorkshopSources(workshopId, 10001, tx);
    if (loops.length > 10000 || sources.length > 10000) throw new Error('Configuration too large to edit as one manifest');
    const states = await listLoopStatesByLoopId(loops.map(loop => loop.id), tx);
    const modelConfig = workshop.modelConfig ?? {};
    const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const {manifestSpec: storedSpec, manifestMetadata: storedMetadata, ...editableModelConfig} = modelConfig;
    const spec = record(storedSpec);
    const control = record(spec.control);
    const warnings = !control.object || !control.objective ? ['历史配置未保存 control；以下对象和目标由车间名称及 mission 生成，请在审核前核对。'] : [];
    const manifest = {
      apiVersion: 'openzhiyu.ai/v1alpha1', kind: 'Workshop',
      metadata: {...record(storedMetadata), name: typeof modelConfig.manifestName === 'string' && modelConfig.manifestName ? modelConfig.manifestName : `workshop-${workshop.id}`, title: workshop.name},
      spec: {
        ...spec,
        mission: workshop.mission,
        role: typeof spec.role === 'string' ? spec.role : typeof modelConfig.role === 'string' ? modelConfig.role : 'general',
        control: {...control, object: control.object || workshop.name, objective: control.objective || workshop.mission},
        autonomyLevel: workshop.autonomyLevel,
        modelConfig: editableModelConfig,
        boundaryPolicy: workshop.boundaryPolicy,
        loops: loops.filter(loop => loop.status !== 'archived').map(loop => {
          const state = states.get(loop.id)?.stateJson ?? {};
          return {
            name: typeof state.manifestLoopName === 'string' && state.manifestLoopName ? state.manifestLoopName : loop.name,
            title: loop.name, description: loop.description ?? '', goal: loop.goal, status: loop.status,
            ...(typeof state.skill === 'string' && state.skill ? {skill: state.skill} : {}),
            trigger: loop.triggerConfig, context: loop.contextConfig,
            actionPolicy: loop.actionPolicy, verification: loop.verificationConfig,
            approvalPolicy: loop.approvalPolicy, retryPolicy: loop.retryPolicy,
            escalationPolicy: loop.escalationPolicy,
          };
        }),
        sources: sources.map((source: WorkshopSource) => ({...source.config, name: source.name, type: source.type, uri: source.uri ?? '', purpose: source.content ?? ''})),
      },
    };
    return {workshopId, commandVersion: Number(versions[0]?.version ?? 0), warnings,
      manifestYaml: warnings.map(warning => `# ${warning}\n`).join('') + YAML.stringify(manifest)};
  });
}
