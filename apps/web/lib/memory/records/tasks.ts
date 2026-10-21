/** Persistence only. The Interaction domain owns transitions and authorization;
 * its host transaction also commits the scenario projection. */
export { assertTaskSources, insertTaskRecord, lockTaskCommand, readTaskInTransaction,
  replaceTaskRecord, replayTaskCommand, taskRevision, TaskRecordConflict, TaskRecordInputError,
  type TaskCommand, type TaskCommit, type TaskWriteReceipt } from "../adapters/postgres/tasks";
