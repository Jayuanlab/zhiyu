import {expect,it} from 'vitest';
import {resolve} from 'node:path';
import {serializedTypeWriter} from '../../scripts/serialize-dev-type-writes.mjs';
it('serializes the same generated path while preserving unrelated I/O',async()=>{
  let active=0,max=0;const observed:string[]=[];
  const writer=serializedTypeWriter(async(_path:string,value:string)=>{
    active++;max=Math.max(max,active);await new Promise(done=>setTimeout(done,5));observed.push(value);active--;
  },resolve('fixture-types'));
  await Promise.all(['long','short','final'].map(value=>writer(resolve('fixture-types/routes.d.ts'),value)));
  expect(max).toBe(1);expect(observed).toEqual(['long','short','final']);
  max=0;await Promise.all(['a','b'].map(value=>writer(resolve(`elsewhere/${value}.ts`),value)));expect(max).toBe(2);
});
it('reports a failed write and permits the next one',async()=>{
  const writer=serializedTypeWriter(async(_path:string,value:string)=>{if(value==='bad')throw Error('injected');return value;},resolve('fixture-types'));
  const outcomes=await Promise.allSettled([writer(resolve('fixture-types/routes.d.ts'),'bad'),writer(resolve('fixture-types/routes.d.ts'),'good')]);
  expect(outcomes[0].status).toBe('rejected');expect(outcomes[1]).toMatchObject({status:'fulfilled',value:'good'});
});
