import {beforeEach,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({provider:{} as any}));
vi.mock('@openzhiyu/ai/agent/sandbox',()=>({createSandboxProvider:()=>state.provider}));
import {openPiSandboxTools} from '@/lib/ai/tools/pi-sandbox-tools';
const options:any={sandbox:{enabled:true,provider:'fixture'},allowedTools:['sandbox_run_command'],onPermissionRequest:async()=>({behavior:'allow'})};
beforeEach(()=>{state.provider={type:'fixture',getCapabilities:()=>({isolation:'container'}),isAvailable:async()=>true,init:vi.fn(),stop:vi.fn(),shutdown:vi.fn(),exec:vi.fn(async()=>({stdout:'receipt',stderr:'',exitCode:0,duration:1}))};});
describe('Pi isolated sandbox adapter',()=>{
 it('requires explicit provider, allowlist and host approval rather than widening tools',async()=>{await expect(openPiSandboxTools({...options,onPermissionRequest:undefined})).rejects.toThrow('approval_required');await expect(openPiSandboxTools({...options,allowedTools:[]})).rejects.toThrow('tools_not_allowed');expect(state.provider.init).not.toHaveBeenCalled();});
 it('rejects a host-process fallback and closes the selected provider',async()=>{state.provider.getCapabilities=()=>({isolation:'none'});await expect(openPiSandboxTools(options)).rejects.toThrow('isolation_required');expect(state.provider.stop).toHaveBeenCalled();expect(state.provider.shutdown).toHaveBeenCalled();expect(state.provider.exec).not.toHaveBeenCalled();});
 it('uses the selected isolated provider and does not treat nonzero exit as success',async()=>{const opened=await openPiSandboxTools(options);try{expect(opened.tools.map(t=>t.name)).toEqual(['sandbox_run_command']);const result=await opened.tools[0].execute('id',{command:'fixture'});expect(result.details).toMatchObject({isolation:'container',businessCompletion:false});state.provider.exec.mockResolvedValue({exitCode:2});await expect(opened.tools[0].execute('id',{command:'fixture'})).rejects.toThrow('execution_failed');}finally{await opened.close();}expect(state.provider.shutdown).toHaveBeenCalledOnce();});
});
