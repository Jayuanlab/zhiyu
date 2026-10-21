// Trusted domain handlers supply an already authorized transaction for writes.
// No standalone owner capability or model-supplied write port is created here.
export { readCurrentScenario, readCurrentScenarioInTransaction, lockScenarioLineage, scenarioBatchExists,
  readScenarioSourceTimes, readOwnedScenarioMemoryIds, appendScenarioSnapshot } from "../adapters/postgres/scenarios";
export type { ScenarioIdentity, ScenarioSnapshotRecord } from "./scenario-record";
