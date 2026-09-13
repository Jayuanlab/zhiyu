import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({auth:vi.fn(),query:vi.fn(),files:vi.fn(),page:vi.fn()}));
vi.mock('@/lib/files/workspace/bounded-listing-service',()=>({workspaceListing:{page:mocks.page}}));
vi.mock('@/app/(auth)/auth',()=>({auth:mocks.auth}));
vi.mock('@/lib/db/client',()=>({db:{select:mocks.query}}));
vi.mock('@/lib/files/workspace/sessions',()=>({getAllWorkspaceFilesRecursive:mocks.files}));
import {GET} from '@/app/api/workspace/files/route';
import {WorkspaceListingBoundaryError} from '@/lib/files/workspace/listing-boundary';
import {ListingCursorError} from '@/lib/files/workspace/bounded-listing';
const request=(query='')=>GET(new Request(`http://localhost/api/workspace/files${query}`) as never);
describe('workspace file listing authorization',()=>{
  beforeEach(()=>{
    vi.resetAllMocks();mocks.auth.mockResolvedValue({user:{id:'owner'}});
    mocks.page.mockResolvedValue({files:[],hasMore:true,nextCursor:'scan:1',total:null,scannedEntries:500});
  });
  it.each(['','?pagination=bounded'])('bounds every listing including the default %s',async query=>{
    const response=await request(query);
    expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.page).toHaveBeenCalledWith('owner',null,50,undefined);
    expect(await response.json()).toMatchObject({hasMore:true,total:null});
    expect(mocks.files).not.toHaveBeenCalled();expect(mocks.query).not.toHaveBeenCalled();
  });
  it('passes exact task scope and cursor to the authorized service',async()=>{
    const taskId='11111111-1111-4111-8111-111111111111';
    await request(`?taskId=${taskId}&path=docs&cursor=scan%3A1&pageSize=20`);
    expect(mocks.page).toHaveBeenCalledWith('owner','scan:1',20,{taskId,path:'docs'});
  });
  it.each(['?page=0','?page=2','?pagination=offset','?taskId=../outside','?path=docs'])('rejects retired or unsafe input %s before scanning',async query=>{
    expect((await request(query)).status).toBe(400);expect(mocks.page).not.toHaveBeenCalled();
  });
  it('does not scan without authentication',async()=>{
    mocks.auth.mockResolvedValue(null);expect((await request()).status).toBe(401);
    expect(mocks.page).not.toHaveBeenCalled();
  });
  it('returns a safe boundary error',async()=>{
    mocks.page.mockRejectedValue(new WorkspaceListingBoundaryError());
    const response=await request();expect(response.status).toBe(403);
    expect(await response.json()).toEqual({error:'Workspace path unavailable'});
  });
  it('reports expired scans and hides unexpected internal details',async()=>{
    mocks.page.mockRejectedValueOnce(new ListingCursorError(410,'cursor_expired'));
    expect(await (await request()).json()).toEqual({error:'cursor_expired',resetRequired:true});
    mocks.page.mockRejectedValueOnce(new Error('private path'));
    const response=await request();expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('private path');
  });
});
