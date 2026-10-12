import { seedMemoryDependencyFixture, dependencyFixtureState } from './brain-memory-dependency-fixture.mjs';

/** Synthetic, independently sourced memory plus three existing exact-dependency targets.
 * @param {import('postgres').Sql} client
 * @param {string} userId
 * @param {{workId?:string,memoryContent?:string,memoryType?:'fact'|'preference'|'insight'|'plan'|'boundary'|'relationship'|'task'|'system'}} [options]
 */
export async function seedMemoryCorrectionFixture(client,userId,options={}){
  const fixture=await seedMemoryDependencyFixture(client,userId,{
    ...options,
    memoryContent:options.memoryContent??'原始合成记忆：周一整理资料。',
  });
  if(options.memoryType)await client`UPDATE brain_memories SET memory_type=${options.memoryType} WHERE id=${fixture.memoryId} AND user_id=${userId}`;
  return {...fixture,originalState:await dependencyFixtureState(client,fixture)};
}

export async function memoryCorrectionCounts(client,userId){
  return (await client`SELECT
    (SELECT count(*) FROM brain_memories WHERE user_id=${userId})::int memories,
    (SELECT count(*) FROM brain_observations WHERE user_id=${userId})::int observations,
    (SELECT count(*) FROM brain_memory_reviews WHERE user_id=${userId})::int reviews,
    (SELECT count(*) FROM brain_state_snapshots WHERE user_id=${userId})::int snapshots,
    (SELECT count(*) FROM brain_state_snapshots WHERE user_id=${userId} AND snapshot_type='memory_dependency_change')::int changes,
    (SELECT count(*) FROM brain_memories WHERE user_id=${userId} AND metadata->'updateProposal'->>'status'='pending')::int pendingProposals`)[0];
}

export async function memoryCorrectionOriginalRecords(client,fixture){
  const memory=(await client`SELECT * FROM brain_memories WHERE id=${fixture.memoryId} AND user_id=${fixture.userId}`)[0];
  const observation=(await client`SELECT * FROM brain_observations WHERE id=${fixture.observationId} AND user_id=${fixture.userId}`)[0];
  const entities=await dependencyFixtureState(client,fixture);
  return {memory,observation,entities};
}
