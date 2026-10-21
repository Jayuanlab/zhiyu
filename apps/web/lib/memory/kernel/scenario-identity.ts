export type ScenarioType = "person" | "group" | "project" | "topic" | "transaction" | "family" | "work";
export const normalizeScenarioKey = (value: string) => value.trim().normalize("NFKC").toLowerCase();

export class ScenarioStateError extends Error {
  constructor(readonly code: "scenario_state_invalid" | "scenario_state_capacity_exceeded", message: string) { super(message); }
}
