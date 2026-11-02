import type { Observation, Snapshot } from './contracts';
/** Corrections are projections over immutable events, never edits of raw facts. */
export function effectiveObservations(observations: Observation[]) {
  const result = new Map(
    observations.filter((o) => !o.corrects).map((o) => [o.id, { ...o }]),
  );
  for (const correction of [...observations]
    .filter((o) => o.corrects)
    .sort((a, b) => a.at.localeCompare(b.at))) {
    const prior = result.get(correction.corrects!);
    if (!prior) continue;
    result.set(prior.id, {
      ...prior,
      value: correction.value ?? prior.value,
      note: [prior.note, `更正：${correction.note}`].filter(Boolean).join('；'),
    });
  }
  return [...result.values()].sort((a, b) => b.at.localeCompare(a.at));
}
export function healthAssessment(snapshot: Snapshot) {
  const observations = effectiveObservations(snapshot.observations),
    latestWeight = observations.find((o) => o.kind === 'weight'),
    latestSleep = observations.find((o) => o.kind === 'sleep');
  return {
    latestWeight: latestWeight ?? null,
    latestSleep: latestSleep ?? null,
    observationCount: observations.length,
    weightSource: latestWeight ? '用户测量记录' : '身体档案录入基线',
    effectiveWeightKg:
      latestWeight?.value ?? snapshot.account.profile?.weightKg ?? null,
  };
}
