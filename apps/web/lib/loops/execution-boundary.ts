import {WorkCommandConflict} from '@/lib/work-runtime/command-ledger';
export const LOOP_MIGRATION_REQUIRED_MESSAGE='请先在自动任务页面将任务迁入车间，再从车间执行。';
export class LoopMigrationRequiredError extends WorkCommandConflict{
  constructor(){super('loop_migration_required');this.message=LOOP_MIGRATION_REQUIRED_MESSAGE;}
}
