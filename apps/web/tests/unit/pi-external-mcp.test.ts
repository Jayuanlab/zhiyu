import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {z} from 'zod';
const state=vi.hoisted(()=>({transport:undefined as any,servers:{} as any}));
vi.mock('@/lib/ai/mcp/loader',()=>({loadMcpServers:async()=>state.servers}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js',()=>({StdioClientTransport:class {constructor(){return state.transport;}}}));
import {openPiMcpTools} from '@/lib/ai/tools/external-mcp';
let server:McpServer,handler:ReturnType<typeof vi.fn<(args:{value:string})=>Promise<{content:Array<{type:"text";text:string}>}>>>;
beforeEach(async()=>{const [client,host]=InMemoryTransport.createLinkedPair();state.transport=client;state.servers={fixture:{command:'fixture'}};server=new McpServer({name:'fixture',version:'1'});handler=vi.fn(async({value}:{value:string})=>({content:[{type:'text' as const,text:value}]}));server.registerTool('read',{inputSchema:{value:z.string()},annotations:{readOnlyHint:true}},handler);server.registerTool('write',{inputSchema:{}},async()=>({content:[]}));await server.connect(host);});
afterEach(async()=>{await server.close();});
describe('Pi host MCP protocol',()=>{
 it('uses the actual MCP protocol client and exposes only explicitly selected qualified tools',async()=>{const opened=await openPiMcpTools({mcpConfig:{enabled:true,userDirEnabled:false,appDirEnabled:false},allowedTools:['mcp__fixture__read']});expect(opened.tools.map(t=>t.name)).toEqual(['mcp__fixture__read']);const result=await opened.tools[0].execute('call',{value:'real protocol receipt'});expect(result.content).toContainEqual({type:'text',text:'real protocol receipt'});expect(handler).toHaveBeenCalledOnce();await opened.close();});
 it('does not infer approval for an externally configured write',async()=>{const opened=await openPiMcpTools({mcpConfig:{enabled:true,userDirEnabled:false,appDirEnabled:false},allowedTools:['mcp__fixture__write']});try{await expect(opened.tools[0].execute('call',{})).rejects.toThrow('mcp_write_requires_host_approval');}finally{await opened.close();}});
 it('does not connect servers when no tool from that server is allowed',async()=>{const opened=await openPiMcpTools({mcpConfig:{enabled:true,userDirEnabled:false,appDirEnabled:false},allowedTools:[]});expect(opened.tools).toEqual([]);await opened.close();expect(handler).not.toHaveBeenCalled();});
});
