import {createHash,randomUUID} from 'node:crypto';

/** Called only by the random, loopback database runner. Each source is independent. */
export async function seedMemoryDependencyFixture(client,userId,{workId,memoryContent='原始合成记忆：周一整理资料。'}={}){
  if(workId){
    const rows=await client`SELECT id FROM workshops WHERE id=${workId} AND user_id=${userId}`;
    if(rows.length!==1)throw Error('Dependency fixture Work is not owned by the test user');
  }else{
    workId=randomUUID();
    await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workId},${userId},'Memory dependency fixture','Synthetic explicit dependency evaluation')`;
  }
  const memoryId=randomUUID(),observationId=randomUUID(),eventId=randomUUID(),noteId=randomUUID(),taskId=randomUUID(),loopId=randomUUID();
  const title=`Memory dependency ${memoryId}`,body='原始合成知识正文，保留历史内容供主人核实。',taskTitle=`Memory dependency task ${taskId}`;
  await client`INSERT INTO brain_observations(id,user_id,source_type,source_id,observed_at,content,content_hash)
    VALUES (${observationId},${userId},'memory_dependency_fixture',${randomUUID()},now(),${memoryContent},${createHash('sha256').update(memoryContent).digest('hex')})`;
  await client`INSERT INTO brain_memories(id,user_id,scope_type,scope_id,owner_type,owner_id,memory_type,subject,content,status,confidence,evidence_refs,metadata)
    VALUES (${memoryId},${userId},'work',${workId},'work',${workId},'insight',${title},${memoryContent},'active',80,
      ${JSON.stringify([`brain-observation:${observationId}`])}::jsonb,
      ${JSON.stringify({canonicalKind:'state',canonicalGroupId:`dependency-fixture:${memoryId}`})}::jsonb)`;
  await client`INSERT INTO interaction_events(id,user_id,platform,source,conversation_id,conversation_name,content,message_time,dedupe_key)
    VALUES (${eventId},${userId},'fixture','synthetic-memory-dependency',${randomUUID()},'Synthetic original conversation',${body},now(),${randomUUID()})`;
  await client`INSERT INTO interaction_notes(id,user_id,event_id,note_type,title,body,source_event_ids,metadata)
    VALUES (${noteId},${userId},${eventId},'summary',${title},${body},${JSON.stringify([eventId])}::jsonb,${JSON.stringify({workshopId:workId})}::jsonb)`;
  await client`INSERT INTO interaction_tasks(id,user_id,event_id,title,description,status,source_event_ids,metadata)
    VALUES (${taskId},${userId},${eventId},${taskTitle},'原始合成待办说明。','candidate',${JSON.stringify([eventId])}::jsonb,${JSON.stringify({workshopId:workId})}::jsonb)`;
  await client`INSERT INTO loops(id,user_id,workshop_id,name,goal,status,trigger_config)
    VALUES (${loopId},${userId},${workId},${`Memory dependency loop ${loopId}`},'仅检查合成依赖，不执行外部动作。','active',
      ${JSON.stringify({type:'manual'})}::jsonb)`;
  await client`INSERT INTO loop_states(loop_id,current_phase,memory_summary,next_action,state_json)
    VALUES (${loopId},'idle','原始合成历史摘要。','核对来源后再继续。','{}'::jsonb)`;
  return {userId,workId,memoryId,observationId,eventId,title,memoryContent,body,taskTitle,
    entities:{wiki_note:noteId,interaction_task:taskId,loop:loopId}};
}

export async function dependencyFixtureState(client,fixture){
  const note=(await client`SELECT title,body,source_event_ids,metadata FROM interaction_notes WHERE id=${fixture.entities.wiki_note}`)[0];
  const task=(await client`SELECT title,description,status,due_at,source_event_ids FROM interaction_tasks WHERE id=${fixture.entities.interaction_task}`)[0];
  const loop=(await client`SELECT name,goal,status,trigger_config,context_config,action_policy,approval_policy FROM loops WHERE id=${fixture.entities.loop}`)[0];
  const state=(await client`SELECT current_phase,memory_summary,next_action,blocked_reason,state_json FROM loop_states WHERE loop_id=${fixture.entities.loop}`)[0];
  return {note,task,loop,state};
}
