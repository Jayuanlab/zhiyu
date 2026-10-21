import {describe,expect,it} from 'vitest';
import {directedWebSearchQuery} from '@/lib/ai/web-search-query';
describe('actual directed provider queries',()=>{
 it('applies domain and date filters without inventing returned evidence',()=>{
  expect(directedWebSearchQuery('agent checkpoints',['arxiv.org'],'2026-10-01')).toBe('agent checkpoints (site:arxiv.org) after:2026-10-01');
  expect(directedWebSearchQuery('original query',undefined,undefined)).toBe('original query');
 });
 it('rejects malformed filters rather than silently searching without scope',()=>{
  expect(()=>directedWebSearchQuery('q',['arxiv.org OR anything'],undefined)).toThrow('domain');
  expect(()=>directedWebSearchQuery('q',[], '2026-02-31')).toThrow('date');
 });
});
