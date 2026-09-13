import assert from 'node:assert/strict';
import {checkWorkspaceSecondaryBrowser} from './workspace-secondary-browser.mjs';
export async function checkWorkspaceDefaultBrowser(context) {
  const response=await fetch(`${context.origin}/api/workspace/files`);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  const data=await response.json();
  assert.equal(data.total,null);assert.equal(data.sortOrder,'directory_traversal');
  assert.ok(Array.isArray(data.files));assert.equal(typeof data.hasMore,'boolean');
  assert.ok(data.scannedEntries<=500);
  for(const query of ['page=0','pagination=offset','taskId=invalid','path=outside']){
    assert.equal((await fetch(`${context.origin}/api/workspace/files?${query}`)).status,400);
  }
  assert.equal((await fetch(`${context.origin}/api/workspace/files?cursor=legacy%7C123%7Cfile`)).status,400);
  return {defaultHttpBounded:true,legacyInputsRejected:true,defaultScannedEntries:data.scannedEntries,...await checkWorkspaceSecondaryBrowser(context)};
}
