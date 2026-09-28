import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const folder=path.join(root,'docs/evals/memory-system-100');
const read=name=>{
  const text=fs.readFileSync(path.join(folder,name),'utf8');
  assert.ok(!text.includes('\uFFFD')&&!text.includes('???'),`Encoding: ${name}`);
  return text;
};
const data=JSON.parse(read('cases.json'));
assert.equal(data.schemaVersion,'zhiyu-memory-eval.v1');
assert.equal(data.total,100);assert.equal(data.cases.length,100);
assert.equal(data.categories.length,10);
assert.equal(new Set(data.cases.map(c=>c.id)).size,100);
assert.equal(new Set(data.cases.map(c=>c.request.question)).size,100);
for(const [index,c] of data.cases.entries()){
  assert.equal(c.id,`MEM-${String(index+1).padStart(3,'0')}`);
  assert.ok(data.categories.some(g=>g.id===c.category));
  assert.ok(['service_contract','end_to_end_acceptance'].includes(c.level));
  assert.equal(c.readiness,'not_run');assert.equal(c.fixture.synthetic,true);
  assert.equal(c.fixture.isolation,'reset_per_case');
  assert.ok(c.fixture.setupInstructions.length>0&&c.request.question.length>0);
  assert.ok(c.expected.referenceAnswer.length>0);
  assert.ok(c.expected.mustSatisfy.length&&c.expected.mustNot.length);
  assert.equal(new Set(c.fixture.observations.map(e=>e.id)).size,c.fixture.observations.length);
  assert.ok(c.fixture.observations.every(e=>e.id.startsWith(c.id+'-')&&e.text.length));
  assert.ok(c.evaluation.hardFailOn.includes('unauthorized_read'));
}
for(const g of data.categories){assert.equal(g.count,10);assert.equal(data.cases.filter(c=>c.category===g.id).length,10);}
const markdown=read('cases.md');
assert.equal((markdown.match(/^### MEM-\d{3}/gm)||[]).length,100);
for(const c of data.cases)assert.ok(markdown.includes(`### ${c.id}　${c.request.question}`));
const results=read('results-template.jsonl').trim().split('\n').map(line=>JSON.parse(line));
assert.deepEqual(results.map(r=>r.id),data.cases.map(c=>c.id));
assert.ok(results.every(r=>r.status==='not_run'&&r.systemAnswer===null&&r.fixtureReady===false));
read('README.md');
console.log(JSON.stringify({validated:true,cases:100,categories:10,uniqueQuestions:100,resultRows:100,utf8:true,executionPerformed:false},null,2));
